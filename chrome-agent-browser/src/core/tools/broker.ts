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
 *   identity and, for a resource, the grant it came from, never the value;
 * - a remote call that both the binding and the package declare a read, and that failed
 *   transiently, is sent again up to twice (D-152), each retry a remote call the runtime checks
 *   against its budgets; a `citation.resolve` binding whose descriptor names the built-in Crossref
 *   lookup may have a DOI answered by it when the resolver stays unavailable (D-153).
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
import { CROSSREF_IMPLEMENTATION } from "./adapters/crossref.js";
import { CROSSREF_DOI_IMPLEMENTATION, CROSSREF_DOI_LIMITS, CROSSREF_ORIGIN, crossrefDoiLookup, doiQuery } from "./adapters/crossref-doi.js";
import { cancellationOf, jsonHttpCall, toolError } from "./adapters/json-http.js";
import { selectedFileCall, type SelectedFiles } from "./adapters/selected-file.js";
import { normalizeToolBindings, type ToolBindingRecord } from "./bindings.js";
import { bindingDigest, describeDefinition, findDefinition, type CredentialSource, type DescribeOptions, type ToolImplementationDefinition } from "./definitions.js";
import { egressRefusal } from "./egress.js";
import { HOST_PACER, type Pacer } from "./pacer.js";
import type { ToolCallBounds, ToolContext, ToolHandler } from "./handler.js";
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
  /** Requests the binding itself sent (one, or up to three with transient retries, D-152). */
  attempts: number;
  /** Requests the citation fallback sent (D-153); 0 when it was not used. */
  fallback_attempts: number;
  /** The implementation that answered: the binding's, or the fallback's. */
  answered_by: string;
  /** Whether the citation fallback answered instead of the binding (D-153). */
  answered_by_fallback: boolean;
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
  /** The wait between attempts (D-152); injected by tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A per-request deadline signal; injected by tests. */
  timeout?: (ms: number) => AbortSignal;
  describe?: DescribeOptions;
  /** A privacy observer for outbound tool requests (D-028). */
  observe?: (request: { tool_id: string; binding_id: string; url: string; body: string | null }) => void;
}

/** A failure's code and closed facts, for an audit event: never a message. */
function failureFacts(error: unknown): Record<string, JsonValue> {
  if (!(error instanceof AdapterError)) return { code: "tool_error" };
  const facts = error.audit_facts;
  return { code: error.code, ...(typeof facts.http_status === "number" ? { http_status: facts.http_status } : {}), ...(typeof facts.stage === "string" ? { stage: facts.stage } : {}) };
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

/** HTTP statuses a read-only call is retried on (D-152): the server did not serve this request. A 502 reaches this only when the adapter did not take it as data. */
export const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
/** At most this many retries of one read-only call, three attempts in all (D-152). */
export const MAX_TOOL_RETRIES = 2;
/** The waits before the second and the third attempt (D-152). */
export const RETRY_BACKOFF_MS: readonly number[] = Object.freeze([1000, 3000]);
/** A server's `Retry-After` up to this long replaces the wait; a longer one is not waited for, and the call is not retried (D-152). */
export const RETRY_AFTER_CAP_MS = 10_000;
/** The citation fallback is not started with less time than this before the call's deadline (D-153). */
export const FALLBACK_MIN_REMAINING_MS = 1000;
/** The fallback's own pacing lane when this run holds no Crossref search binding to share one with. */
export const CROSSREF_DOI_LANE = "chrome:crossref_doi_lookup";

/** Why a failed attempt may be tried again (D-152): the class of failure and, for a status, the status and any `Retry-After`. */
export interface TransientFailure {
  reason: "http_status" | "transport" | "timeout";
  http_status?: number;
  retry_after_ms?: number;
}

/**
 * Whether one failed attempt was transient (D-152), read from the stable code and the closed facts
 * its adapter certified, never from a message: a status in `TRANSIENT_STATUSES` (whether the body
 * was refused for its type or the status for its value), a connection or read failure, or the
 * binding's own deadline while the request was out. Never a TLS or address-policy refusal, another
 * status, a body the adapter will not read on a non-transient status, a local refusal, a
 * cancellation, or a deadline that fired while the call waited for its pacing turn.
 */
export function transientFailure(error: unknown): TransientFailure | null {
  if (!(error instanceof AdapterError)) return null;
  const facts = error.audit_facts;
  const status = facts.http_status;
  if (typeof status === "number") {
    if (!TRANSIENT_STATUSES.has(status)) return null;
    const retryAfter = error.detail.retry_after_ms;
    return { reason: "http_status", http_status: status, ...(typeof retryAfter === "number" ? { retry_after_ms: retryAfter } : {}) };
  }
  if (error.code === "tool_transport_error" && facts.stage === "transport") return { reason: "transport" };
  if (error.code === "tool_timeout" && error.detail.pacer_wait !== true) return { reason: "timeout" };
  return null;
}

/** A pacing lane: whose turn a request waits for, at what pace, and its per-request deadline. */
interface Lane {
  key: string;
  pace: { maxConcurrent: number; minIntervalMs: number };
  timeoutSeconds: number;
}

type Answer = { output: JsonValue; status: number | null; resource?: ResourceGrant; file?: { file_id: string; sha256: string } };

/** Which requests one call made, and which implementation answered it. */
interface Trail {
  attempts: number;
  fallbackAttempts: number;
  answeredBy: string;
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellationOf(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancellationOf(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
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
    return (context, payload, signal, bounds) => this.call(context, payload, signal, bounds);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async call(context: ToolContext, payload: JsonValue, signal: AbortSignal, bounds: ToolCallBounds = {}): Promise<JsonValue> {
    let encoded: string;
    try {
      encoded = canonicalString(payload);
    } catch {
      throw toolError("tool_request_invalid", "Tool arguments are not finite JSON");
    }
    if (new TextEncoder().encode(encoded).length > MAX_ARGS_BYTES) {
      throw toolError("tool_request_invalid", `Tool arguments exceed ${MAX_ARGS_BYTES} canonical bytes`);
    }
    const started = this.now();
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
    const trail: Trail = { attempts: 0, fallbackAttempts: 0, answeredBy: this.definition.implementationId };
    try {
      const definition = this.definition;
      if (definition.enabled === false) throw toolError("tool_unavailable", "this host no longer registers that implementation");
      if (definition.kind !== "host_resource" && this.deps.resources) {
        // Before a slot, a socket or a resolver: a sealed host value bound for a tool it was
        // not granted to reach is refused here, whatever the tool.
        const refusal = egressRefusal(payload, this.deps.resources.grants, this.binding.required_permission_ids, this.deps.resources.resolver.sealedValues());
        if (refusal) throw toolError("tool_request_invalid", refusal);
      }
      const lane: Lane = { key: definition.id, pace: { maxConcurrent: this.limits.max_concurrent, minIntervalMs: this.limits.min_interval_ms ?? 0 }, timeoutSeconds: this.limits.timeout_seconds };
      let answer: Answer;
      if (definition.kind === "json_http") {
        answer = await this.http(context, payload, signal, bounds, lane, trail);
      } else {
        trail.attempts = 1;
        // Local implementations reach no service: their pacing is unchanged and nothing retries them.
        answer = await this.attempt(lane, signal, true, (bounded) => this.local(definition, payload, bounded));
      }
      const output = this.settle(answer);
      status = answer.status;
      outcome = "ok";
      const duration = Math.round((this.now() - started) * 1000) / 1000;
      const resource = answer.resource;
      context.event("tool.settled", {
        tool: this.tool_id,
        binding_id: this.binding.binding_id,
        remote: this.remote,
        status: "ok",
        duration_ms: duration,
        transport_status: answer.status,
        // How many requests the call took and which implementation answered (D-152, D-153).
        attempts: trail.attempts,
        answered_by: trail.answeredBy,
        ...(trail.fallbackAttempts > 0 ? { fallback_attempts: trail.fallbackAttempts } : {}),
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
          duration_ms: Math.round((this.now() - started) * 1000) / 1000,
          transport_status: status,
          outcome,
          attempts: trail.attempts,
          fallback_attempts: trail.fallbackAttempts,
          answered_by: trail.answeredBy,
          answered_by_fallback: trail.answeredBy !== this.definition.implementationId,
        });
      }
    }
  }

  /** One local implementation's answer (no service reached). */
  private async local(definition: ToolImplementationDefinition, payload: JsonValue, bounded: AbortSignal): Promise<Answer> {
    if (definition.kind === "local_builtin") {
      const builtin = this.deps.builtins?.[definition.implementationId];
      if (builtin === undefined) throw toolError("tool_unavailable", "this host has no code for that local implementation");
      return { output: await Promise.resolve().then(() => builtin(payload)), status: null };
    }
    if (definition.kind === "host_resource") {
      const resolved = hostResourceCall(definition, this.binding, payload, this.deps.resources ?? null);
      return { output: resolved.output, status: null, resource: resolved.resource };
    }
    if (definition.kind === "selected_file") {
      const output = await selectedFileCall(definition, this.binding, payload, this.deps.files ?? null, bounded, this.limits.max_request_bytes);
      const fileId = (payload as { file_id: string }).file_id;
      return { output, status: null, file: { file_id: fileId, sha256: this.deps.files!.attached.get(fileId)!.sha256 } };
    }
    throw toolError("tool_unavailable", "this host has no implementation for that category yet");
  }

  /**
   * One request: a pacing turn in its lane, then the dispatch, under the lane's own per-request
   * deadline joined to the call's signal (the package's timeout and every enclosing deadline run
   * above, so a request ends at whichever is earlier). `local` requests always start an interval;
   * a remote one only when a request actually left (D-081; T6 review, nit 4).
   */
  private async attempt<T>(lane: Lane, signal: AbortSignal, local: boolean, send: (bounded: AbortSignal, markSent: () => void) => Promise<T>): Promise<T> {
    const ms = Math.max(1, lane.timeoutSeconds) * 1000;
    const deadline = this.deps.timeout ? this.deps.timeout(ms) : AbortSignal.timeout(ms);
    const bounded = AbortSignal.any([signal, deadline]);
    // The deadline's own reason is what the pacer and `abortable` reject with when it fires;
    // another error that settles at the same moment keeps its own name (T4 review 2, nit 7).
    const byDeadline = (error: unknown): boolean => deadline.aborted && error === deadline.reason;
    let release: (answered?: boolean) => void;
    try {
      release = await (this.deps.pacer ?? HOST_PACER).acquire(lane.key, lane.pace, bounded);
    } catch (error) {
      if (signal.aborted) throw cancellationOf(signal);
      if (byDeadline(error)) throw toolError("tool_timeout", "the call waited for its turn longer than the binding allows", {}, { pacer_wait: true });
      throw error;
    }
    let sent = local;
    try {
      return await abortable(
        send(bounded, () => {
          sent = true;
        }),
        bounded,
      );
    } catch (error) {
      if (signal.aborted) throw cancellationOf(signal);
      if (byDeadline(error)) throw toolError("tool_timeout", "the tool host did not answer in time");
      throw error;
    } finally {
      release(sent);
    }
  }

  /**
   * A read-only call that failed transiently is tried again, up to twice (D-152): after 1 s and
   * then 3 s, or after the server's `Retry-After` when it is at most 10 s. A retry is not sent when
   * a longer `Retry-After` was asked, when the time left before the call's deadline is shorter than
   * the wait plus the attempt that failed, or when the run's or the worker's remote-call budget has
   * no room for one more request; each sent retry is charged as a remote call, checked before the
   * wait and again before it leaves. `retryable` is false for every call with side effects.
   */
  private async withRetries<T>(context: ToolContext, signal: AbortSignal, bounds: ToolCallBounds, implementationId: string, retryable: boolean, onAttempt: () => void, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const began = this.now();
      onAttempt();
      try {
        return await run();
      } catch (error) {
        const transient = retryable && attempt <= MAX_TOOL_RETRIES && !signal.aborted ? transientFailure(error) : null;
        if (transient === null) throw error;
        const facts: Record<string, JsonValue> = { tool: this.tool_id, binding_id: this.binding.binding_id, implementation_id: implementationId, attempt: attempt + 1, failure: transient.reason, ...(transient.http_status !== undefined ? { http_status: transient.http_status } : {}) };
        const skip = (reason: string, figures: Record<string, JsonValue> = {}): never => {
          context.event("tool.retry_skipped", { ...facts, reason, ...figures });
          throw error;
        };
        const delay = transient.retry_after_ms ?? RETRY_BACKOFF_MS[attempt - 1]!;
        if (transient.retry_after_ms !== undefined && transient.retry_after_ms > RETRY_AFTER_CAP_MS) skip("retry_after", { retry_after_ms: transient.retry_after_ms });
        const elapsed = this.now() - began;
        if (bounds.deadline !== undefined && bounds.deadline - this.now() < delay + elapsed) skip("deadline", { remaining_ms: Math.max(0, Math.floor(bounds.deadline - this.now())), needed_ms: Math.floor(delay + elapsed) });
        if (context.remoteCall === undefined) skip("budget");
        const room = context.remoteCall!(false);
        if (room !== null) skip("budget", { ...room });
        await (this.deps.sleep ?? sleepFor)(delay, signal);
        const charged = context.remoteCall!(true);
        if (charged !== null) skip("budget", { ...charged });
        context.event("tool.retried", { ...facts, reason: transient.reason, delay_ms: delay });
      }
    }
  }

  /** The JSON-over-HTTPS call: the binding's own requests, with their retries, then the citation fallback when it applies (D-152, D-153). */
  private async http(context: ToolContext, payload: JsonValue, signal: AbortSignal, bounds: ToolCallBounds, lane: Lane, trail: Trail): Promise<Answer> {
    const definition = this.definition;
    const network = this.deps.transport;
    if (!network) throw toolError("tool_unavailable", "this host has no network transport for tool calls");
    const credential = definition.credential ? (this.deps.credentials?.(definition.credential) ?? null) : null;
    const contact = definition.optionalCredential ? (this.deps.credentials?.(definition.optionalCredential) ?? null) : null;
    const bytes = { maxRequestBytes: this.limits.max_request_bytes, maxResponseBytes: this.limits.max_response_bytes };
    // Only an idempotent read is ever sent twice: the binding's contract and the package's own
    // declaration must both say so.
    const retryable = definition.sideEffects === "read" && bounds.side_effects === "read";
    let answer: Answer | null = null;
    let failure: unknown = null;
    try {
      answer = await this.withRetries(context, signal, bounds, definition.implementationId, retryable, () => (trail.attempts += 1), () =>
        this.attempt(lane, signal, false, (bounded, markSent) =>
          jsonHttpCall({
            definition,
            args: payload,
            transport: (request) => {
              markSent();
              return network(request);
            },
            signal: bounded,
            credential,
            contact,
            observe: this.deps.observe,
            limits: bytes,
            now: this.deps.now,
          }),
        ),
      );
    } catch (error) {
      if (signal.aborted) throw cancellationOf(signal);
      failure = error;
    }
    const doi = definition.fallback && retryable ? doiQuery(payload) : null;
    if (doi !== null) {
      // The resolver could not answer this DOI: it failed transiently after its retries, or it said
      // so itself (its 502 `provider_error`, or a gateway's 502 page taken as data).
      const trigger = failure !== null ? transientFailure(failure) : answer!.status === 502 ? ({ reason: "http_status", http_status: 502 } as TransientFailure) : null;
      if (trigger !== null) {
        const fallen = await this.fallback(context, payload, doi, signal, bounds, trail, failure !== null ? "transient_failure" : "resolver_unavailable", trigger.http_status ?? null, network);
        if (fallen !== null) return fallen;
      }
    }
    if (failure !== null) throw failure;
    return answer!;
  }

  /**
   * The built-in Crossref DOI lookup (D-153), as the binding's descriptor names it. It charges one
   * remote call and is paced in Crossref's lane; its own request is retried by the same rule. When
   * it cannot answer, it returns null and the call ends exactly as it would have without it.
   */
  private async fallback(context: ToolContext, payload: JsonValue, doi: string, signal: AbortSignal, bounds: ToolCallBounds, trail: Trail, reason: string, httpStatus: number | null, network: HttpTransport): Promise<Answer | null> {
    const to = CROSSREF_DOI_IMPLEMENTATION.id;
    const facts: Record<string, JsonValue> = { tool: this.tool_id, binding_id: this.binding.binding_id, from: this.definition.implementationId, to, reason, ...(httpStatus !== null ? { http_status: httpStatus } : {}) };
    if (bounds.deadline !== undefined && bounds.deadline - this.now() < FALLBACK_MIN_REMAINING_MS) {
      context.event("tool.fallback_skipped", { ...facts, skipped: "deadline", remaining_ms: Math.max(0, Math.floor(bounds.deadline - this.now())) });
      return null;
    }
    const charged = context.remoteCall ? context.remoteCall(true) : { bound: "worker_remote_calls" as const, remote_calls: 0, limit: 0 };
    if (charged !== null) {
      context.event("tool.fallback_skipped", { ...facts, skipped: "budget", ...charged });
      return null;
    }
    context.event("tool.fallback", facts);
    // The person's Crossref contact, only through the optional credential this binding's digest names.
    const contact = this.definition.optionalCredential ? (this.deps.credentials?.(this.definition.optionalCredential) ?? null) : null;
    try {
      const answer = await this.withRetries(context, signal, bounds, to, true, () => (trail.fallbackAttempts += 1), () =>
        this.attempt(this.crossrefLane(), signal, false, (bounded, markSent) =>
          crossrefDoiLookup({
            transport: (request) => {
              markSent();
              return network(request);
            },
            args: payload,
            doi,
            signal: bounded,
            contact,
            now: this.deps.now,
            observe: this.deps.observe,
            toolId: this.tool_id,
          }),
        ),
      );
      trail.answeredBy = to;
      return answer;
    } catch (error) {
      if (signal.aborted) throw cancellationOf(signal);
      context.event("tool.fallback_failed", { ...facts, ...failureFacts(error) });
      return null;
    }
  }

  /** Crossref's pacing lane: the one this run's Crossref search binding uses, so the two never overlap; else the lookup's own, at the same pace. */
  private crossrefLane(): Lane {
    const search = this.deps.definitions.find((item) => item.implementationId === CROSSREF_IMPLEMENTATION.id && item.origin === CROSSREF_ORIGIN);
    if (search !== undefined) {
      const limits = describeDefinition(search, this.deps.describe).limits;
      return { key: search.id, pace: { maxConcurrent: limits.max_concurrent, minIntervalMs: limits.min_interval_ms ?? 0 }, timeoutSeconds: limits.timeout_seconds };
    }
    return { key: CROSSREF_DOI_LANE, pace: { maxConcurrent: CROSSREF_DOI_LIMITS.max_concurrent, minIntervalMs: CROSSREF_DOI_LIMITS.min_interval_ms }, timeoutSeconds: CROSSREF_DOI_LIMITS.timeout_seconds };
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
