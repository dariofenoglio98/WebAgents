/**
 * One generic `ToolHandler` per binding a Run Plan froze (`toolbridge/handler.py` and
 * `tool-broker.ts` in one process). The runtime remains the authority: `Runtime.callTool` has
 * already checked the role allowlist, the permission grants, the explicit approval, the
 * per-tool and remote-call budgets and the package's own input schema before a handler is
 * reached, and validates the result against the package's own output schema afterwards. The
 * handler adds defence in depth on the way out and the way back:
 *
 * - it dispatches only the implementation whose id and digest the plan froze, and resolves it
 *   among the definitions *this run* was constructed with;
 * - before a slot, a socket or a resolver, it refuses arguments that carry a sealed host value
 *   bound for a tool it was not granted to reach (`egress.ts`);
 * - it serves at most the binding's concurrency and spacing (`pacer.ts`), and the binding's own
 *   deadline bounds the wait for a slot and the dispatch (the package's timeout runs in the
 *   runtime above, so a call ends at whichever is earlier, as the reference's `min` does);
 * - it bounds the arguments and the output to the limits the plan approved (the described
 *   binding's, which the digest froze), and a `host_resource` answer must be attributed to
 *   exactly one grant of this plan;
 * - it records `tool.dispatched` and `tool.settled` in the runtime's own audit: the binding
 *   identity and, for a resource, the grant it came from, never the value.
 *
 * Codes are shared verbatim with `agentpkg.toolbridge.errors` (`tool_not_bound`,
 * `tool_binding_stale`, `tool_request_invalid`, `tool_response_invalid`, `tool_unavailable`,
 * `tool_timeout`, `tool_cancelled`, `tool_transport_error`, ...).
 */
import { canonicalString } from "../canonical.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { HttpTransport } from "../models/transport.js";
import type { ResourceGrant } from "../types.js";
import { AdapterError } from "../workflow/errors.js";
import { hostResourceCall } from "./adapters/host-resource.js";
import { cancellationOf, jsonHttpCall, toolError } from "./adapters/json-http.js";
import { selectedFileCall, type SelectedFiles } from "./adapters/selected-file.js";
import { normalizeToolBindings, type ToolBindingRecord } from "./bindings.js";
import { bindingDigest, describeDefinition, findDefinition, type CredentialSource, type DescribeOptions, type ToolImplementationDefinition } from "./definitions.js";
import { egressRefusal } from "./egress.js";
import { HOST_PACER, type Pacer } from "./pacer.js";
import type { ToolContext, ToolHandler } from "./handler.js";
import type { ResourceResolver } from "./resources.js";

/** One tool call's arguments are a request, not a data transfer; the package's own input schema is the real bound. */
export const MAX_ARGS_BYTES = 64 * 1024;
/** The frame-side ceiling on what a host answer may carry back. */
export const MAX_OUTPUT_BYTES = 512 * 1024;

export interface ToolCallRecord {
  tool_id: string;
  binding_id: string;
  binding_sha256: string;
  remote: boolean;
  duration_ms: number;
  transport_status: number | null;
  outcome: "ok" | "failed";
}

export interface BrokerDeps {
  /** The implementations this host holds. Nothing else is callable. */
  definitions: readonly ToolImplementationDefinition[];
  /** Required for any `json_http` definition. */
  transport?: HttpTransport | null;
  /** The credential value behind a definition's `credential`, read at call time. */
  credentials?: (credential: CredentialSource) => string | null;
  /** The host resources this run was granted and the store that holds them. Present whenever the host holds any resource. */
  resources?: { grants: readonly ResourceGrant[]; resolver: ResourceResolver } | null;
  /**
   * The selected files this run was given, by opaque id, and the host code that reads them
   * (T6, D-082). A `selected_file` binding can read exactly these; nothing else.
   */
  files?: SelectedFiles | null;
  /** Local built-ins by implementation id (`chrome.tool.echo` is the conformance one). */
  builtins?: Record<string, (args: JsonValue) => Promise<JsonValue> | JsonValue>;
  pacer?: Pacer;
  now?: () => number;
  describe?: DescribeOptions;
  /** A privacy observer for outbound tool requests (D-028). */
  observe?: (request: { tool_id: string; binding_id: string; url: string; body: string | null }) => void;
}

/** The one built-in: it returns its input and reaches nothing. */
export const ECHO_IMPLEMENTATION = "chrome.tool.echo";

/**
 * Settle with the dispatch or, as soon as the signal aborts, refuse as `tool_cancelled`: an
 * implementation that ignores its signal cannot keep a cancelled run waiting.
 */
/** `work`, or the signal's own reason the moment it aborts (the deadline's reason, or the runtime's cancellation), so the caller can tell which one it was. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () => (signal.reason as Error | undefined) ?? cancellationOf(signal);
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class BoundToolHandler {
  readonly tool_id: string;
  readonly remote: boolean;
  readonly calls: ToolCallRecord[] = [];

  /** The bounds the plan approved: the described binding's limits, computed once (T4 review 2, nit 8). */
  private readonly limits: { timeout_seconds: number; max_concurrent: number; min_interval_ms: number | null; max_request_bytes: number; max_response_bytes: number };

  constructor(
    readonly binding: ToolBindingRecord,
    private readonly definition: ToolImplementationDefinition,
    private readonly deps: BrokerDeps,
  ) {
    this.tool_id = binding.tool_id;
    this.remote = binding.remote;
    // The described binding's limits are what the digest froze (`describe.maxResponseBytes` is
    // the host's own ceiling, applied as a minimum); they cannot change for the life of the handler.
    const described = describeDefinition(definition, deps.describe);
    this.limits = { ...described.limits };
  }

  /** The `ToolHandler` the runtime installs under the binding name. */
  get handler(): ToolHandler {
    return (context, payload, signal) => this.call(context, payload, signal);
  }

  async call(context: ToolContext, payload: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    let encoded: string;
    try {
      encoded = canonicalString(payload);
    } catch {
      throw toolError("tool_request_invalid", "Tool arguments are not finite JSON");
    }
    if (new TextEncoder().encode(encoded).length > MAX_ARGS_BYTES) {
      throw toolError("tool_request_invalid", `Tool arguments exceed ${MAX_ARGS_BYTES} canonical bytes`);
    }
    const started = (this.deps.now ?? Date.now)();
    // Operational provenance, in the runtime's own hash-chained audit: which of the host's
    // implementations this call was attributed to.
    context.event("tool.dispatched", {
      tool: this.tool_id,
      binding_id: this.binding.binding_id,
      binding_sha256: this.binding.binding_sha256,
      implementation_kind: this.binding.implementation_kind,
      implementation_version: this.binding.implementation_version,
      remote: this.remote,
      endpoint_origin: this.binding.endpoint_origin,
      method: this.binding.method,
    });
    let status: number | null = null;
    let outcome: "ok" | "failed" = "failed";
    try {
      const definition = this.definition;
      if (definition.enabled === false) throw toolError("tool_unavailable", "this host no longer registers that implementation");
      if (definition.kind !== "host_resource" && this.deps.resources) {
        // Before a slot, a socket or a resolver: a sealed host value bound for a tool it was
        // not granted to reach is refused here, whatever the tool.
        const refusal = egressRefusal(payload, this.deps.resources.grants, this.binding.required_permission_ids, this.deps.resources.resolver.sealedValues());
        if (refusal) throw toolError("tool_request_invalid", refusal);
      }
      const deadline = AbortSignal.timeout(Math.max(1, this.limits.timeout_seconds) * 1000);
      const bounded = AbortSignal.any([signal, deadline]);
      // The deadline's own reason is what the pacer and `abortable` reject with when it fires;
      // another error that settles at the same moment keeps its own name (T4 review 2, nit 7).
      const byDeadline = (error: unknown): boolean => deadline.aborted && error === deadline.reason;
      const limits = { maxConcurrent: this.limits.max_concurrent, minIntervalMs: this.limits.min_interval_ms ?? 0 };
      let release: () => void;
      try {
        release = await (this.deps.pacer ?? HOST_PACER).acquire(definition.id, limits, bounded);
      } catch (error) {
        if (signal.aborted) throw cancellationOf(signal);
        if (byDeadline(error)) throw toolError("tool_timeout", "the call waited for its turn longer than the binding allows");
        throw error;
      }
      let answer: { output: JsonValue; status: number | null; resource?: ResourceGrant; file?: { file_id: string; sha256: string } };
      try {
        if (definition.kind === "local_builtin") {
          const builtin = this.deps.builtins?.[definition.implementationId];
          if (builtin === undefined) throw toolError("tool_unavailable", "this host has no code for that local implementation");
          answer = { output: await abortable(Promise.resolve().then(() => builtin(payload)), bounded), status: null };
        } else if (definition.kind === "host_resource") {
          const resolved = hostResourceCall(definition, this.binding, payload, this.deps.resources ?? null);
          answer = { output: resolved.output, status: null, resource: resolved.resource };
        } else if (definition.kind === "selected_file") {
          const output = await abortable(selectedFileCall(definition, this.binding, payload, this.deps.files ?? null, bounded, this.limits.max_request_bytes), bounded);
          const fileId = (payload as { file_id: string }).file_id;
          answer = { output, status: null, file: { file_id: fileId, sha256: this.deps.files!.attached.get(fileId)!.sha256 } };
        } else if (definition.kind === "json_http") {
          if (!this.deps.transport) throw toolError("tool_unavailable", "this host has no network transport for tool calls");
          const credential = definition.credential ? (this.deps.credentials?.(definition.credential) ?? null) : null;
          const contact = definition.optionalCredential ? (this.deps.credentials?.(definition.optionalCredential) ?? null) : null;
          const bytes = { maxRequestBytes: this.limits.max_request_bytes, maxResponseBytes: this.limits.max_response_bytes };
          answer = await abortable(jsonHttpCall({ definition, args: payload, transport: this.deps.transport, signal: bounded, credential, contact, observe: this.deps.observe, limits: bytes, now: this.deps.now }), bounded);
        } else {
          throw toolError("tool_unavailable", "this host has no implementation for that category yet");
        }
      } catch (error) {
        if (signal.aborted) throw cancellationOf(signal);
        if (byDeadline(error)) throw toolError("tool_timeout", "the tool host did not answer in time");
        throw error;
      } finally {
        release();
      }
      const output = this.settle(answer);
      status = answer.status;
      outcome = "ok";
      const duration = Math.round(((this.deps.now ?? Date.now)() - started) * 1000) / 1000;
      const resource = answer.resource;
      context.event("tool.settled", {
        tool: this.tool_id,
        binding_id: this.binding.binding_id,
        remote: this.remote,
        status: "ok",
        duration_ms: duration,
        transport_status: answer.status,
        // Which granted host resource answered, by opaque id and digest: the authority is
        // auditable, the value is not recorded.
        ...(resource ? { resource_permission: resource.permission_id, resource_type: resource.resource_type, resource_id: resource.resource_id, resource_digest: resource.resource_digest } : {}),
        // Which of the person's selected files was read, by opaque id and hash: never a name or a path.
        ...(answer.file ? { file_id: answer.file.file_id, file_sha256: answer.file.sha256 } : {}),
      });
      return output;
    } finally {
      if (this.calls.length < 512) {
        this.calls.push({
          tool_id: this.tool_id,
          binding_id: this.binding.binding_id,
          binding_sha256: this.binding.binding_sha256,
          remote: this.remote,
          duration_ms: Math.round(((this.deps.now ?? Date.now)() - started) * 1000) / 1000,
          transport_status: status,
          outcome,
        });
      }
    }
  }

  /** Check the host's answer before anything downstream believes it. */
  private settle(answer: { output: JsonValue; status: number | null; resource?: ResourceGrant }): JsonValue {
    if (this.binding.implementation_kind !== "host_resource") {
      if (answer.resource !== undefined) throw new AdapterError("tool_response_invalid", "The host attributed a host resource to a binding that returns none");
    } else {
      const resource = answer.resource;
      if (!resource) throw new AdapterError("tool_response_invalid", "The host resource answer does not say which granted resource it came from");
      const granted = (this.deps.resources?.grants ?? []).some(
        (grant) => grant.permission_id === resource.permission_id && grant.resource_type === resource.resource_type && grant.resource_id === resource.resource_id && grant.resource_digest === resource.resource_digest && this.binding.required_permission_ids.includes(grant.permission_id) && resource.resource_type === this.binding.resource_type,
      );
      // A value attributed to a resource nobody granted for this run is not a degraded
      // answer; it is a different decision.
      if (!granted) throw new AdapterError("tool_binding_stale", "The host answered with a resource this run plan did not grant", { detail: { tool_id: this.tool_id } });
    }
    let encoded: string;
    try {
      encoded = canonicalString(answer.output);
    } catch {
      throw new AdapterError("tool_response_invalid", "The host tool result is not finite JSON");
    }
    if (new TextEncoder().encode(encoded).length > MAX_OUTPUT_BYTES) throw new AdapterError("tool_response_invalid", `The host tool result exceeds ${MAX_OUTPUT_BYTES} bytes`);
    return answer.output;
  }
}

/**
 * Build one handler per bound tool, keyed the way the runtime looks them up: by the package
 * tool's own `binding` name, the abstract capability the package asked for. Each plan binding
 * must name a definition this host holds, with the digest the host computes for it now; a
 * binding that names a missing or changed implementation is refused before anything runs.
 */
export function toolHandlers(bindings: unknown, deps: BrokerDeps): { handlers: Record<string, ToolHandler>; bound: BoundToolHandler[] } {
  const normalized = normalizeToolBindings(bindings);
  const handlers: Record<string, ToolHandler> = {};
  const bound: BoundToolHandler[] = [];
  for (const binding of normalized) {
    if (Object.hasOwn(handlers, binding.binding_name)) throw new AdapterError("tool_binding_ambiguous", "Two tools may not share one binding name");
    const definition = findDefinition(deps.definitions, binding.binding_id);
    if (definition === undefined) {
      throw new AdapterError("tool_not_bound", "this run binds no implementation for that tool, so there is nothing to call", { detail: { tool_id: binding.tool_id, binding_id: binding.binding_id } });
    }
    const current = bindingDigest(describeDefinition(definition, deps.describe));
    if (current !== binding.binding_sha256) {
      throw new AdapterError("tool_binding_stale", "the binding identity does not match the one this run plan froze", { detail: { tool_id: binding.tool_id, binding_id: binding.binding_id } });
    }
    if (definition.toolId !== binding.tool_id || definition.binding !== binding.binding_name) {
      throw new AdapterError("tool_binding_stale", "the implementation no longer serves the tool the plan bound it to", { detail: { tool_id: binding.tool_id } });
    }
    const handler = new BoundToolHandler(binding, definition, deps);
    handlers[binding.binding_name] = handler.handler;
    bound.push(handler);
  }
  return { handlers, bound };
}

export type { JsonObject };
