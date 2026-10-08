/**
 * The HTTP tool call (`tool-broker.ts::http`): one exact request to the origin, path and method the
 * binding holds, under a destination policy with no exception path. What the request carries and
 * how the answer is read is an *adapter* chosen by the binding's implementation id (host code,
 * never the package; the reference's `HTTP_ADAPTERS`):
 *
 * - `chrome.tool.json_http` / `openclaw.tool.json_http` (the plain JSON adapter): the arguments are
 *   the one POST body, and the status contract the Citation Resolver and WebAir share holds:
 *   200/400/404/422/502 bodies are data for the package's own output schema to accept or reject,
 *   5xx (except 502) and 401/403 are `tool_unavailable`, anything else `tool_transport_error`;
 * - `chrome.tool.crossref_works_search` (`crossref.ts`, T6): one GET with host-named parameters,
 *   the answer reduced to the declared search result.
 *
 * The policy every adapter inherits:
 * 1. syntax: HTTPS on port 443, no credentials in the URL; only an adapter-built query may follow
 *    the binding's path, and no fragment;
 * 2. request: a fixed header set the package cannot influence, a bounded body and URL, no cookie
 *    jar, no ambient credential; a credential the binding requires is read from the host's
 *    settings at call time and attached as a header the package never sees;
 * 3. transfer: the transport performs one request, follows no redirect (each hop would need the
 *    whole policy re-applied to a destination nobody authorized), caps the bytes and stops when
 *    the signal aborts;
 * 4. response: a JSON content type and a bounded parse before the adapter reads the answer.
 *
 * Address classification (loopback, private, metadata ranges) is not possible from an
 * extension and is Chrome's network stack's job (D-026). The Node CLI's transport
 * (`src/cli-net.ts`, D-067) resolves the host, refuses any non-public address and pins the
 * connection before this adapter's request leaves; its refusals arrive here as a
 * `TransportError` and keep their stage.
 */
import type { JsonValue } from "../../json.js";
import { TransportError, type HttpTransport } from "../../models/transport.js";
import { AdapterError, CancelledError } from "../../workflow/errors.js";
import { DEFAULT_MAX_REQUEST_BYTES, DEFAULT_MAX_RESPONSE_BYTES, type ToolImplementationDefinition } from "../definitions.js";
import { contentTypeCategory, type ToolFailureFacts } from "../facts.js";
import { AdapterRefusal, CROSSREF_WORKS_ADAPTER, encodeQuery, type HttpAdapter } from "./crossref.js";

export const USER_AGENT = "ChromeAgentBrowser/0.1";
const DATA_STATUSES = new Set([200, 400, 404, 422, 502]);
export const CHROME_JSON_HTTP_ID = "chrome.tool.json_http";
export const OPERATOR_JSON_HTTP_ID = "openclaw.tool.json_http";

function statusRefusal(code: AdapterRefusal["code"], message: string): AdapterRefusal {
  return new AdapterRefusal(code, message);
}

/** The plain JSON adapter: the arguments are the one POST body; the shared status contract decides what is data. */
export const JSON_HTTP_ADAPTER: HttpAdapter = {
  id: CHROME_JSON_HTTP_ID,
  request(args, method) {
    return { query: null, body: method === "POST" ? JSON.stringify(args ?? null) : null };
  },
  response({ status, json }) {
    if (status >= 500 && status !== 502) throw statusRefusal("tool_unavailable", `the tool host answered HTTP ${status}`);
    if (status === 401 || status === 403) throw statusRefusal("tool_unavailable", "the tool host refused this call");
    if (!DATA_STATUSES.has(status)) throw statusRefusal("tool_transport_error", `the tool host answered HTTP ${status}`);
    // 4xx/502 bodies reach the package only because its own declared output schema then has to
    // accept them; an unresolved lookup is data, not an exception.
    return json;
  },
};

/** Host code by implementation id; a binding naming any other id has nothing to run. */
export const HTTP_ADAPTERS: ReadonlyMap<string, HttpAdapter> = new Map([
  [CHROME_JSON_HTTP_ID, JSON_HTTP_ADAPTER],
  [OPERATOR_JSON_HTTP_ID, JSON_HTTP_ADAPTER],
  [CROSSREF_WORKS_ADAPTER.id, CROSSREF_WORKS_ADAPTER],
]);

export function toolError(code: string, detail: string, facts: ToolFailureFacts = {}): AdapterError {
  const stage = code === "tool_timeout" ? "timeout" : code === "tool_cancelled" ? "cancelled" : code === "tool_request_invalid" ? "input_schema" : code === "tool_transport_error" ? "transport" : "binding";
  return new AdapterError(code, detail, {
    audit_facts: { stage, ...(code === "tool_timeout" ? { timeout: true } : {}), ...(code === "tool_cancelled" ? { cancelled: true } : {}), ...facts },
  });
}

/**
 * What a cancelled call throws: the signal's own reason when the runtime cancelled it (its
 * `CancelledError`, which the runtime classifies as `cancelled`, as an interrupted asyncio
 * await would), else a `tool_cancelled` refusal.
 */
export function cancellationOf(signal: AbortSignal): Error {
  return signal.reason instanceof CancelledError ? signal.reason : toolError("tool_cancelled", "the tool call was cancelled");
}

export interface JsonHttpCallOptions {
  definition: ToolImplementationDefinition;
  args: JsonValue;
  transport: HttpTransport;
  signal: AbortSignal;
  /** The credential value the host holds for this binding, when the definition requires one. */
  credential?: string | null;
  /** The person's contact address, when the definition names an optional one and it is set (Crossref's `mailto`). */
  contact?: string | null;
  /** The clock a normalized answer is dated with (`retrieved_at`). */
  now?: () => number;
  /** Hook for a privacy observer: the exact body about to leave. */
  observe?: (request: { tool_id: string; binding_id: string; url: string; body: string | null }) => void;
  /** The approved bounds (the described binding's, which the digest froze), when the caller holds them; else the definition's. */
  limits?: { maxRequestBytes: number; maxResponseBytes: number };
}

export async function jsonHttpCall(options: JsonHttpCallOptions): Promise<{ output: JsonValue; status: number }> {
  const { definition, args, signal } = options;
  const origin = definition.origin ?? "";
  const path = definition.path ?? "";
  const method = definition.method ?? "POST";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw toolError("tool_unavailable", "this binding has no usable configured endpoint");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || (url.port && url.port !== "443") || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw toolError("tool_unavailable", "this binding has no usable configured endpoint");
  }
  // What the request carries is the implementation's adapter, chosen by the binding's
  // implementation id: host code, never the package.
  const adapter = HTTP_ADAPTERS.get(definition.implementationId);
  if (adapter === undefined) throw toolError("tool_unavailable", "this host has no code for that HTTP implementation");
  let shaped;
  try {
    shaped = adapter.request(args, method, { contact: options.contact ?? null });
  } catch (error) {
    if (error instanceof AdapterRefusal) throw toolError(error.code, error.message);
    throw toolError("tool_request_invalid", "the tool arguments could not be encoded");
  }
  const body = shaped.body;
  // The path is the binding's; only an adapter-built query may follow it.
  const target = shaped.query && shaped.query.length > 0 ? `${path}?${encodeQuery(shaped.query)}` : path;
  const maxRequest = options.limits?.maxRequestBytes ?? definition.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const encoder = new TextEncoder();
  if ((body !== null && encoder.encode(body).length > maxRequest) || encoder.encode(target).length > Math.max(maxRequest, path.length)) {
    // Refused here, so a pathological document fails locally rather than at someone else's server.
    throw toolError("tool_request_invalid", "the tool arguments exceed this binding's limit");
  }
  // A fixed header set: nothing in `args` reaches it, and the credential, if any, is attached
  // here and named nowhere else.
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
  if (body !== null) headers["content-type"] = "application/json";
  if (definition.credential) {
    const value = options.credential;
    if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw toolError("tool_unavailable", "this binding needs a credential that is not configured on this host");
    }
    headers.authorization = `Bearer ${value}`;
  }
  const destination = `https://${url.hostname}${target}`;
  options.observe?.({ tool_id: definition.toolId, binding_id: definition.id, url: destination, body });
  if (signal.aborted) throw cancellationOf(signal);
  const maxResponse = options.limits?.maxResponseBytes ?? definition.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let answer;
  try {
    answer = await options.transport({ url: destination, method, headers, body, signal, maxResponseBytes: maxResponse });
  } catch (error) {
    if (signal.aborted) throw cancellationOf(signal);
    if (error instanceof AdapterError || error instanceof CancelledError) throw error;
    if (error instanceof TransportError) {
      const { stage, http_status, response_bytes } = error.facts;
      if (stage === "body_size") {
        throw toolError("tool_response_invalid", "the tool response is too large", { stage, body_exceeded: true, ...(http_status !== undefined ? { http_status } : {}), ...(response_bytes !== undefined ? { response_bytes } : {}) });
      }
      throw toolError("tool_transport_error", error.message, { stage });
    }
    throw toolError("tool_transport_error", "the tool request failed");
  }
  if (answer.status >= 300 && answer.status < 400) {
    throw toolError("tool_transport_error", "the tool host returned a redirect; each hop would need the whole destination policy re-applied, so redirects are refused", { stage: "status", http_status: answer.status });
  }
  const responseBytes = encoder.encode(answer.body).length;
  const facts: ToolFailureFacts = { http_status: answer.status, content_type: contentTypeCategory(answer.headers["content-type"] ?? null), response_bytes: responseBytes, body_exceeded: false };
  if (responseBytes > maxResponse) throw toolError("tool_response_invalid", "the tool response is too large", { ...facts, stage: "body_size", body_exceeded: true });
  const contentType = (answer.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw toolError("tool_response_invalid", "the tool host did not answer with the required JSON content type", { ...facts, stage: "content_type" });
  }
  let json: JsonValue;
  try {
    json = JSON.parse(answer.body) as JsonValue;
  } catch {
    throw toolError("tool_response_invalid", "the tool host answered with invalid JSON", { ...facts, stage: "json_parse", json_parsed: false });
  }
  facts.json_parsed = true;
  const status = answer.status;
  const retrievedAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    return { output: adapter.response({ status, json }, args, retrievedAt), status };
  } catch (error) {
    if (error instanceof AdapterRefusal) {
      // A status the adapter will not take as data is a status failure; anything else is the
      // adapter refusing the answer's shape.
      const stage = error.code === "tool_response_invalid" ? "adapter_response" : "status";
      throw toolError(error.code, error.message, { ...facts, stage });
    }
    throw toolError("tool_response_invalid", "the tool answer could not be read", { ...facts, stage: "adapter_response" });
  }
}
