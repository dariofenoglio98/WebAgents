/**
 * The trusted host tool broker: the only place a package's data leaves here.
 *
 * ```text
 *   agentpkg Runtime.call_tool        (role, permission, approval, budget, schema)
 *        │  ToolHandler
 *        ▼
 *   agentpkg.toolbridge               {tool_id, binding_id, binding_sha256, args}
 *        │  private JSONL, no URL, no method, no header
 *        ▼
 *   ToolBroker                        <- this file: resolve, then dispatch
 *        │
 *        ├── local_builtin            no I/O at all
 *        ├── json_http                one request, one origin, one path;
 *        │                            its shape is an adapter (tool-adapters.ts)
 *        └── selected_file            one PDF the person selected for this run,
 *                                     by opaque id, parsed out of process
 * ```
 *
 * ## Resolution, not routing
 *
 * The child names a `tool_id` and echoes the binding identity its run plan
 * froze. The broker looks that triple up in the bindings *this run* was
 * constructed with — not in the whole registry, and never in anything the
 * child said — and refuses anything else. There is no path by which a
 * `tool.call` frame can express a destination, which is why none of the
 * parameters below is a URL.
 *
 * ## The HTTP adapter's policy, in order, with no exception path
 *
 * 1. **syntax**: HTTPS on port 443, no credentials in the URL, no query, no
 *    fragment, exactly the origin, path and method the binding holds;
 * 2. **resolution**: every address the hostname resolves to must be publicly
 *    routable. Loopback, private, link-local, multicast, reserved,
 *    unspecified, cloud-metadata, IPv4-mapped, 6to4, Teredo and NAT64
 *    destinations are refused by class, before a socket exists;
 * 3. **connection**: the socket is pinned to a validated address while TLS
 *    still verifies the original hostname, so a second DNS answer cannot
 *    rebind it;
 * 4. **request**: a fixed header set the package cannot influence, a bounded
 *    JSON body, no cookies, no proxy, no ambient credential;
 * 5. **transfer**: no redirects, a declared-length check, a byte cap enforced
 *    while streaming, a whole-operation deadline, and an `AbortSignal` that
 *    reaches the socket when a workflow is cancelled;
 * 6. **response**: a JSON content type, bounded parse, and a status contract.
 *
 * Redirects are refused rather than followed because each hop would need every
 * one of those checks re-applied to a destination nobody authorized.
 *
 * ## Credentials
 *
 * A credential belongs to the binding, is read here at call time from the
 * host's own environment, and is attached as a header the package never sees
 * and never names. It appears in no frame, no report, no audit record, no
 * error message and no log line.
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { isIP } from "node:net";
import { contentTypeCategory, safeToolFacts, type ToolFailureFacts } from "./tool-facts.js";
import { AgentBrowserError, clip } from "./errors.js";
import type { FileCapabilityView } from "./file-capabilities.js";
import type { PdfReader } from "./pdf-reader.js";
import type { Logger } from "./service.js";
import { AdapterRefusal, HTTP_ADAPTERS, encodeQuery } from "./tool-adapters.js";
import { HOST_PACER, type Pacer } from "./tool-pacer.js";
import {
  credentialConfigured,
  findDefinition,
  type ToolBindingDefinition,
} from "./tool-registry.js";

/** Stable codes, shared verbatim with `agentpkg.toolbridge.errors`. */
export const TOOL_ERRORS = {
  notBound: "tool_not_bound",
  notApproved: "tool_not_approved",
  stale: "tool_binding_stale",
  unavailable: "tool_unavailable",
  timeout: "tool_timeout",
  cancelled: "tool_cancelled",
  requestInvalid: "tool_request_invalid",
  responseInvalid: "tool_response_invalid",
  transport: "tool_transport_error",
} as const;

export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_ADDRESSES = 8;

/** One binding this run may call, exactly as the run plan froze it. */
export type BoundTool = {
  toolId: string;
  bindingId: string;
  bindingSha256: string;
  remote: boolean;
  timeoutSeconds: number;
};

export type ToolCallRequest = {
  tool_id: string;
  binding_id: string;
  binding_sha256: string;
  args: unknown;
};

export type ToolCallResult = {
  status: "ok";
  output: unknown;
  tool_id: string;
  binding_id: string;
  binding_sha256: string;
  remote: boolean;
  duration_ms: number;
  transport_status: number | null;
};

export function toolError(code: string, detail: string, facts: ToolFailureFacts = {}): AgentBrowserError {
  const stage: ToolFailureFacts["stage"] = code === TOOL_ERRORS.timeout ? "timeout"
    : code === TOOL_ERRORS.cancelled ? "cancelled" : code === TOOL_ERRORS.requestInvalid ? "input_schema"
    : code === TOOL_ERRORS.transport ? "transport" : "binding";
  return new AgentBrowserError("tool_call_failed", "The tool call failed", `${code}: ${detail}`,
    false, null, safeToolFacts({ stage, ...(code === TOOL_ERRORS.timeout ? {timeout: true} : {}),
      ...(code === TOOL_ERRORS.cancelled ? {cancelled: true} : {}), ...facts }));
}

/**
 * Destination policy, by class rather than by list.
 *
 * Mirrors `agentpkg.netaddr.public_address_reason`, because a second transport
 * with a weaker rule would be the hole the first one closed.
 */
export function addressRejection(address: string): string | null {
  const version = isIP(address);
  if (version === 0) return "unparsable_address";
  if (version === 4) return rejectIPv4(address);
  return rejectIPv6(address.toLowerCase());
}

const METADATA_V4 = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "192.0.0.192"]);

function rejectIPv4(address: string): string | null {
  if (METADATA_V4.has(address)) return "cloud_metadata_address";
  const [a, b] = address.split(".").map((part) => Number.parseInt(part, 10));
  if (a === 0) return "unspecified_address";
  if (a === 127) return "loopback_address";
  if (a === 10) return "private_address";
  if (a === 172 && b >= 16 && b <= 31) return "private_address";
  if (a === 192 && b === 168) return "private_address";
  if (a === 169 && b === 254) return "link_local_address";
  if (a === 100 && b >= 64 && b <= 127) return "private_address"; // CGNAT
  if (a >= 224 && a <= 239) return "multicast_address";
  if (a >= 240) return "reserved_address";
  if (a === 192 && b === 0) return "reserved_address"; // 192.0.0.0/24 and test-net-1
  if (a === 192 && b === 88) return "reserved_address";
  if (a === 198 && (b === 18 || b === 19)) return "reserved_address";
  if (a === 198 && b === 51) return "reserved_address";
  if (a === 203 && b === 0) return "reserved_address";
  return null;
}

function rejectIPv6(address: string): string | null {
  if (address === "::" || address === "::0") return "unspecified_address";
  if (address === "::1") return "loopback_address";
  if (address === "fd00:ec2::254") return "cloud_metadata_address";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address);
  if (mapped) return "ipv4_mapped_address";
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/u.test(address)) return "ipv4_mapped_address";
  if (address.startsWith("2002:")) return "sixtofour_address";
  if (address.startsWith("2001:0:") || address.startsWith("2001::")) return "teredo_address";
  if (address.startsWith("64:ff9b:") || address.startsWith("64:ff9b::")) return "nat64_address";
  if (address.startsWith("fe80:") || address.startsWith("fe8") || address.startsWith("fe9")) {
    return "link_local_address";
  }
  if (address.startsWith("fea") || address.startsWith("feb")) return "link_local_address";
  if (address.startsWith("fc") || address.startsWith("fd")) return "private_address";
  if (address.startsWith("ff")) return "multicast_address";
  if (address.startsWith("2001:db8")) return "reserved_address";
  if (address.startsWith("100::")) return "reserved_address";
  return null;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(toolError(TOOL_ERRORS.transport, `the tool host could not be resolved`));
        return;
      }
      resolve(addresses.map((entry) => entry.address).slice(0, MAX_ADDRESSES));
    });
  });

export type HttpTransport = (options: {
  hostname: string;
  address: string;
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
  signal: AbortSignal;
}) => Promise<{ status: number; contentType: string | null; body: string }>;

/** The real transport: pinned address, verified hostname, no redirects. */
export const nodeToolTransport: HttpTransport = (options) =>
  new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: options.address,
      port: 443,
      servername: options.hostname,
      // The connection is pinned to an address this process validated, and TLS
      // still authenticates the name the binding holds.
      ALPNProtocols: ["http/1.1"],
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      reject(toolError(TOOL_ERRORS.transport, "the tool host connection failed", {
        stage: /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|UNABLE_TO_VERIFY_|SELF_SIGNED_)/u.test(error.code ?? "") ? "tls" : "transport",
      })),
    );
    const requestOptions: RequestOptions = {
      host: options.hostname,
      servername: options.hostname,
      path: options.path,
      method: options.method,
      headers: options.headers,
      createConnection: () => socket as never,
      agent: false,
      setHost: true,
      timeout: options.timeoutMs,
      signal: options.signal,
    };
    const request = httpsRequest(requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        socket.destroy();
        reject(
          toolError(
            TOOL_ERRORS.transport,
            "the tool host returned a redirect; each hop would need the whole destination " +
              "policy re-applied, so redirects are refused",
            { stage: "status", http_status: status },
          ),
        );
        return;
      }
      const declared = Number.parseInt(response.headers["content-length"] ?? "", 10);
      if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
        response.destroy();
        socket.destroy();
        reject(toolError(TOOL_ERRORS.responseInvalid, "the tool response is too large",
          { stage: "body_size", http_status: status, body_exceeded: true, response_bytes: declared }));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxResponseBytes) {
          response.destroy();
          socket.destroy();
          reject(toolError(TOOL_ERRORS.responseInvalid, "the tool response is too large",
            { stage: "body_size", http_status: status, body_exceeded: true, response_bytes: size }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        socket.destroy();
        resolve({
          status,
          contentType: (response.headers["content-type"] as string | undefined) ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", () => {
        socket.destroy();
        reject(toolError(TOOL_ERRORS.transport, "the tool response failed mid-transfer"));
      });
    });
    request.on("timeout", () => {
      request.destroy();
      socket.destroy();
      reject(toolError(TOOL_ERRORS.timeout, "the tool host did not answer in time"));
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      reject(
        toolError(
          error.name === "AbortError" ? TOOL_ERRORS.cancelled : TOOL_ERRORS.transport,
          error.name === "AbortError"
            ? "the tool call was cancelled"
            : "the tool request failed",
        ),
      );
    });
    if (options.body !== null) request.write(options.body);
    request.end();
  });

export type ToolBrokerOptions = {
  /** Exactly the bindings this run's plan froze. Nothing else is callable. */
  bound: readonly BoundTool[];
  /** The implementations this host holds, keyed by binding id. */
  definitions: readonly ToolBindingDefinition[];
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  /**
   * The selected files this run was given, by opaque id, and nothing else.
   *
   * A `selected_file` binding can read exactly these. An id the package names
   * that is not here — a path, another session's id, anything — is refused.
   */
  files?: ReadonlyMap<string, FileCapabilityView>;
  /** Where those capabilities' verified bytes come from. Host code. */
  fileStore?: { readVerified(capability: FileCapabilityView): Promise<Buffer> };
  /** The trusted PDF parser, handed bytes and never a path. */
  pdfReader?: PdfReader;
  /** Test seams. None can widen the policy above; each replaces mechanics. */
  resolver?: Resolver;
  transport?: HttpTransport;
  now?: () => number;
  /** Where concurrency and spacing are enforced; one per process by default. */
  pacer?: Pacer;
};

/** One run's tool authority. Constructed per run, discarded with it. */
export class ToolBroker {
  readonly calls: Array<{
    toolId: string;
    bindingId: string;
    remote: boolean;
    status: number | null;
    durationMs: number;
    outcome: "ok" | "failed";
  }> = [];

  constructor(private readonly options: ToolBrokerOptions) {}

  /** Whether this run may call anything at all. */
  get size(): number {
    return this.options.bound.length;
  }

  /**
   * Resolve one `tool.call` against this run's bindings and dispatch it.
   *
   * Every refusal below happens before a socket exists, and each one is a
   * different mistake with its own code.
   */
  async call(params: Record<string, unknown>, signal: AbortSignal): Promise<ToolCallResult> {
    const request = readToolCallParams(params);
    const bound = this.options.bound.find((item) => item.toolId === request.tool_id);
    if (!bound) {
      throw toolError(
        TOOL_ERRORS.notBound,
        "this run binds no implementation for that tool, so there is nothing to call",
      );
    }
    if (
      bound.bindingId !== request.binding_id ||
      bound.bindingSha256 !== request.binding_sha256
    ) {
      throw toolError(
        TOOL_ERRORS.stale,
        "the binding identity does not match the one this run plan froze",
      );
    }
    const definition = findDefinition(this.options.definitions, bound.bindingId);
    if (!definition || definition.enabled === false) {
      throw toolError(
        TOOL_ERRORS.unavailable,
        "this host no longer registers that implementation",
      );
    }
    const clock = this.options.now ?? Date.now;
    const started = clock();
    let status: number | null = null;
    let outcome: "ok" | "failed" = "failed";
    // A binding serves at most its own number of calls at once and spaces
    // their starts as its service requires. A call that cannot start yet
    // waits its turn — bounded by cancellation and by the binding's own
    // deadline — rather than being refused for arriving third.
    const waitMs = Math.max(1, Math.min(bound.timeoutSeconds, definition.timeoutSeconds)) * 1000;
    const waitDeadline = AbortSignal.timeout(waitMs);
    let release: () => void = () => undefined;
    try {
      release = await (this.options.pacer ?? HOST_PACER).acquire(
        bound.bindingId,
        { maxConcurrent: definition.maxConcurrent ?? 4, minIntervalMs: definition.minIntervalMs ?? 0 },
        AbortSignal.any([signal, waitDeadline]),
      );
    } catch {
      if (signal.aborted) throw toolError(TOOL_ERRORS.cancelled, "the tool call was cancelled");
      throw toolError(TOOL_ERRORS.timeout, "the call waited for its turn longer than the binding allows");
    }
    try {
      const answer =
        definition.kind === "local_builtin"
          ? { output: await this.local(definition, request.args), status: null }
          : definition.kind === "selected_file"
            ? { output: await this.selectedFile(definition, bound, request.args, signal), status: null }
            : await this.http(definition, bound, request.args, signal);
      status = answer.status;
      outcome = "ok";
      return {
        status: "ok",
        output: answer.output,
        tool_id: bound.toolId,
        binding_id: bound.bindingId,
        binding_sha256: bound.bindingSha256,
        remote: bound.remote,
        duration_ms: clock() - started,
        transport_status: answer.status,
      };
    } finally {
      release();
      // Recorded exactly once, on every path, so a report counts attempts
      // rather than successes.
      if (this.calls.length < 256) {
        this.calls.push({
          toolId: bound.toolId,
          bindingId: bound.bindingId,
          remote: bound.remote,
          status,
          durationMs: clock() - started,
          outcome,
        });
      }
    }
  }

  /** The one built-in: it returns its input and reaches nothing. */
  private async local(definition: ToolBindingDefinition, args: unknown): Promise<unknown> {
    if (definition.implementationId !== "openclaw.tool.echo") {
      throw toolError(
        TOOL_ERRORS.unavailable,
        "this host has no code for that local implementation",
      );
    }
    return args;
  }

  /**
   * Read one file this run was given, by opaque id, and nothing else.
   *
   * The argument set is closed to `file_id`. The id is resolved against the
   * capabilities attached to *this run*, so a path, a traversal, a `file://`
   * URL or another session's id all fail the same way, before any file is
   * opened. The bytes are re-verified against the size and hash recorded at
   * selection, and the parser receives bytes on stdin — never a path.
   */
  private async selectedFile(
    definition: ToolBindingDefinition,
    bound: BoundTool,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (definition.implementationId !== "openclaw.tool.selected_pdf_text") {
      throw toolError(TOOL_ERRORS.unavailable, "this host has no code for that file implementation");
    }
    const record =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null;
    if (!record || Object.keys(record).join(",") !== "file_id" || typeof record.file_id !== "string") {
      throw toolError(TOOL_ERRORS.requestInvalid, "a selected-file read takes exactly one file_id");
    }
    const maxRequest = definition.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (Buffer.byteLength(record.file_id) > maxRequest) {
      throw toolError(TOOL_ERRORS.requestInvalid, "the file id exceeds this binding's limit");
    }
    const capability = this.options.files?.get(record.file_id);
    if (!capability) {
      // The same answer for every string that is not one of this run's
      // capabilities; it never says whether a path exists.
      throw toolError(
        TOOL_ERRORS.requestInvalid,
        "this run was given no selected file with that id",
      );
    }
    if (!this.options.fileStore || !this.options.pdfReader) {
      throw toolError(TOOL_ERRORS.unavailable, "this host has no file reader configured for runs");
    }
    let data: Buffer;
    try {
      data = await this.options.fileStore.readVerified(capability);
    } catch {
      throw toolError(
        TOOL_ERRORS.unavailable,
        "the selected file no longer matches what was selected, so it is not read",
      );
    }
    if (signal.aborted) throw toolError(TOOL_ERRORS.cancelled, "the tool call was cancelled");
    const timeoutMs = Math.max(1, Math.min(bound.timeoutSeconds, definition.timeoutSeconds)) * 1000;
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      return await this.options.pdfReader(data, AbortSignal.any([signal, deadline]));
    } catch (error) {
      if (signal.aborted) throw toolError(TOOL_ERRORS.cancelled, "the tool call was cancelled");
      if (deadline.aborted) throw toolError(TOOL_ERRORS.timeout, "the PDF parser did not finish in time");
      throw error instanceof AgentBrowserError
        ? error
        : toolError(TOOL_ERRORS.responseInvalid, "the PDF could not be read");
    }
  }

  private async http(
    definition: ToolBindingDefinition,
    bound: BoundTool,
    args: unknown,
    signal: AbortSignal,
  ): Promise<{ output: unknown; status: number }> {
    const origin = definition.origin ?? "";
    const path = definition.path ?? "";
    const method = definition.method ?? "POST";
    const hostname = safeHostname(origin);
    if (!hostname || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
      throw toolError(TOOL_ERRORS.unavailable, "this binding has no usable configured endpoint");
    }
    // What the request carries is the implementation's adapter, chosen by the
    // binding's implementation id — host code, never the package.
    const adapter = HTTP_ADAPTERS.get(definition.implementationId);
    if (!adapter) {
      throw toolError(TOOL_ERRORS.unavailable, "this host has no code for that HTTP implementation");
    }
    let shaped;
    try {
      shaped = adapter.request(args, method);
    } catch (error) {
      if (error instanceof AdapterRefusal) throw toolError(error.code, error.message);
      throw toolError(TOOL_ERRORS.requestInvalid, "the tool arguments could not be encoded");
    }
    const body = shaped.body;
    // The path is the binding's; only an adapter-built query may follow it.
    const target = shaped.query && shaped.query.length > 0 ? `${path}?${encodeQuery(shaped.query)}` : path;
    const maxRequest = definition.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (
      (body !== null && Buffer.byteLength(body) > maxRequest) ||
      Buffer.byteLength(target) > Math.max(maxRequest, path.length)
    ) {
      // Refused here, so a pathological document fails locally rather than at
      // someone else's server.
      throw toolError(TOOL_ERRORS.requestInvalid, "the tool arguments exceed this binding's limit");
    }

    const addresses = await (this.options.resolver ?? defaultResolver)(hostname);
    if (addresses.length === 0) {
      throw toolError(TOOL_ERRORS.transport, "the tool host has no addresses");
    }
    for (const address of addresses) {
      const rejection = addressRejection(address);
      if (rejection) {
        // The literal address is withheld; the class of destination is enough.
        throw toolError(
          TOOL_ERRORS.unavailable,
          `the tool host resolves to a non-public destination (${rejection})`,
          { stage: "address_policy" },
        );
      }
    }

    // A fixed header set. Nothing in `args` reaches it, and the credential —
    // if this binding has one — is read here and never named anywhere else.
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "OpenClawAgentBrowser/0.1",
      connection: "close",
    };
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    if (definition.credential) {
      const value = (this.options.env ?? process.env)[definition.credential.name];
      if (!value) {
        throw toolError(
          TOOL_ERRORS.unavailable,
          "this binding needs a credential that is not configured on this host",
        );
      }
      headers.authorization = `Bearer ${value}`;
    }

    // Resolution is asynchronous; a run cancelled meanwhile must not still
    // send its request, whatever a transport would do with a dead signal.
    if (signal.aborted) throw toolError(TOOL_ERRORS.cancelled, "the tool call was cancelled");
    const timeoutMs = Math.max(1, Math.min(bound.timeoutSeconds, definition.timeoutSeconds)) * 1000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const transport = this.options.transport ?? nodeToolTransport;
    let answer: Awaited<ReturnType<HttpTransport>>;
    try {
      answer = await transport({
        hostname,
        address: addresses[0]!,
        path: target,
        method,
        headers,
        body,
        timeoutMs,
        maxResponseBytes: definition.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        signal: AbortSignal.any([signal, deadline]),
      });
    } catch (error) {
      if (signal.aborted) throw toolError(TOOL_ERRORS.cancelled, "the tool call was cancelled");
      if (deadline.aborted) {
        throw toolError(TOOL_ERRORS.timeout, "the tool host did not answer in time");
      }
      throw error instanceof AgentBrowserError
        ? error
        : toolError(TOOL_ERRORS.transport, "the tool request failed");
    }

    const facts: ToolFailureFacts = {
      http_status: answer.status, content_type: contentTypeCategory(answer.contentType),
      response_bytes: Buffer.byteLength(answer.body), body_exceeded: false,
    };
    if (facts.response_bytes! > (definition.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {
      throw toolError(TOOL_ERRORS.responseInvalid, "the tool response is too large",
        { ...facts, stage: "body_size", body_exceeded: true });
    }
    const contentType = (answer.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "application/json") {
      throw toolError(
        TOOL_ERRORS.responseInvalid,
        "the tool host did not answer with the required JSON content type",
        { ...facts, stage: "content_type" },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(answer.body);
    } catch {
      throw toolError(TOOL_ERRORS.responseInvalid, "the tool host answered with invalid JSON",
        { ...facts, stage: "json_parse", json_parsed: false });
    }
    facts.json_parsed = true;
    // The status contract and the shape of what the package receives are the
    // adapter's. Whatever it returns is still checked against the package's
    // own declared output schema by the runtime, after this.
    let output: unknown;
    try {
      output = adapter.response(
        { status: answer.status, json },
        args,
        new Date((this.options.now ?? Date.now)()).toISOString(),
      );
    } catch (error) {
      if (error instanceof AdapterRefusal) throw toolError(error.code, error.message,
        { ...facts, stage: error.code === TOOL_ERRORS.responseInvalid ? "adapter_response" : "status" });
      throw toolError(TOOL_ERRORS.responseInvalid, "the tool response could not be read",
        { ...facts, stage: "adapter_response" });
    }
    return { output, status: answer.status };
  }
}

export function safeHostname(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.hostname && !url.port ? url.hostname : null;
  } catch {
    return null;
  }
}

/** Accept only the bounded, destination-free parameter set `tool.call` defines. */
export function readToolCallParams(params: Record<string, unknown>): ToolCallRequest {
  const allowed = new Set(["tool_id", "binding_id", "binding_sha256", "args"]);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw toolError(TOOL_ERRORS.requestInvalid, `tool.call does not accept ${clip(key, 64)}`);
    }
  }
  const toolId = params.tool_id;
  const bindingId = params.binding_id;
  const digest = params.binding_sha256;
  if (typeof toolId !== "string" || !toolId || toolId.length > 200) {
    throw toolError(TOOL_ERRORS.requestInvalid, "tool.call tool_id is missing or malformed");
  }
  if (typeof bindingId !== "string" || !bindingId || bindingId.length > 200) {
    throw toolError(TOOL_ERRORS.requestInvalid, "tool.call binding_id is missing or malformed");
  }
  if (typeof digest !== "string" || !HEX64.test(digest)) {
    throw toolError(TOOL_ERRORS.requestInvalid, "tool.call binding_sha256 is missing or malformed");
  }
  if (!("args" in params)) {
    throw toolError(TOOL_ERRORS.requestInvalid, "tool.call carries no args");
  }
  return { tool_id: toolId, binding_id: bindingId, binding_sha256: digest, args: params.args };
}

/** Whether every binding a plan froze is still callable on this host. */
export function credentialsReady(
  definitions: readonly ToolBindingDefinition[],
  bound: readonly BoundTool[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const missing: string[] = [];
  for (const item of bound) {
    const definition = findDefinition(definitions, item.bindingId);
    if (!definition) {
      missing.push(item.toolId);
      continue;
    }
    if (definition.credential && !credentialConfigured(definition, env)) missing.push(item.toolId);
  }
  return missing;
}
