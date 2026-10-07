/**
 * The plain JSON HTTP adapter (`tool-broker.ts::http` with `openclaw.tool.json_http`): one
 * exact request to the origin, path and method the binding holds, under a destination policy
 * with no exception path.
 *
 * 1. syntax: HTTPS on port 443, no credentials in the URL, no query, no fragment;
 * 2. request: a fixed header set the package cannot influence, a bounded JSON body (the
 *    arguments, as the one POST body), no cookie jar, no ambient credential; a credential the
 *    binding names is read from the host's settings at call time and attached as a header the
 *    package never sees;
 * 3. transfer: the transport performs one request, follows no redirect (each hop would need
 *    the whole policy re-applied to a destination nobody authorized), caps the bytes and stops
 *    when the signal aborts;
 * 4. response: a JSON content type, a bounded parse, and the status contract the Citation
 *    Resolver and WebAir share: 200/400/404/422/502 bodies are data for the package's own
 *    output schema to accept or reject, 5xx (except 502) and 401/403 are `tool_unavailable`,
 *    anything else `tool_transport_error`.
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

export const USER_AGENT = "ChromeAgentBrowser/0.1";
const DATA_STATUSES = new Set([200, 400, 404, 422, 502]);

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
  /** The credential value the host holds for this binding, when the definition names one. */
  credential?: string | null;
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
  const body = method === "POST" ? JSON.stringify(args ?? null) : null;
  const maxRequest = options.limits?.maxRequestBytes ?? definition.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (body !== null && new TextEncoder().encode(body).length > maxRequest) {
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
  const target = `https://${url.hostname}${path}`;
  options.observe?.({ tool_id: definition.toolId, binding_id: definition.id, url: target, body });
  if (signal.aborted) throw cancellationOf(signal);
  const maxResponse = options.limits?.maxResponseBytes ?? definition.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let answer;
  try {
    answer = await options.transport({ url: target, method, headers, body, signal, maxResponseBytes: maxResponse });
  } catch (error) {
    if (signal.aborted) throw cancellationOf(signal);
    if (error instanceof AdapterError || error instanceof CancelledError) throw error;
    if (error instanceof TransportError) {
      const { stage, http_status, response_bytes } = error.facts;
      if (stage === "body_size") {
        throw toolError("tool_response_invalid", "the tool response is too large", { stage, body_exceeded: true, ...(http_status !== undefined ? { http_status } : {}), ...(response_bytes !== undefined ? { response_bytes } : {}) });
      }
      throw toolError(stage === "timeout" ? "tool_timeout" : "tool_transport_error", error.message, { stage });
    }
    throw toolError("tool_transport_error", "the tool request failed");
  }
  if (answer.status >= 300 && answer.status < 400) {
    throw toolError("tool_transport_error", "the tool host returned a redirect; each hop would need the whole destination policy re-applied, so redirects are refused", { stage: "status", http_status: answer.status });
  }
  const responseBytes = new TextEncoder().encode(answer.body).length;
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
  if (status >= 500 && status !== 502) throw toolError("tool_unavailable", `the tool host answered HTTP ${status}`, { ...facts, stage: "status" });
  if (status === 401 || status === 403) throw toolError("tool_unavailable", "the tool host refused this call", { ...facts, stage: "status" });
  if (!DATA_STATUSES.has(status)) throw toolError("tool_transport_error", `the tool host answered HTTP ${status}`, { ...facts, stage: "status" });
  // 4xx/502 bodies reach the package only because its own declared output schema then has to
  // accept them; an unresolved lookup is data, not an exception.
  return { output: json, status };
}
