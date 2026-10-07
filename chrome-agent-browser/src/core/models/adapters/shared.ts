/**
 * What the three HTTP adapters have in common: one bounded JSON request through the injected
 * transport, a fixed header set the package cannot influence, the outbound observer, and the
 * refusals (`model_provider_error` with the HTTP status as a fact, `model_response_invalid`
 * for a body that is not the JSON the provider promised). No adapter follows a redirect,
 * retries, or reads a credential from anywhere but the host's settings.
 */
import { AdapterError, CancelledError } from "../../workflow/errors.js";
import type { HttpTransport, ModelRequestObserver } from "../transport.js";

export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_PROVIDER_REQUEST_BYTES = 16 * 1024 * 1024;

export interface ProviderHttpOptions {
  transport: HttpTransport;
  observer?: ModelRequestObserver | null;
}

/** Keep only the loopback and HTTPS forms a provider base URL may take; return the origin. */
export function providerBaseUrl(raw: string, options: { allowLoopbackHttp: boolean }): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AdapterError("model_request_invalid", "The provider base URL is not a URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AdapterError("model_request_invalid", "The provider base URL must carry no credentials, query or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "https:") {
    if (loopback && !options.allowLoopbackHttp) throw new AdapterError("model_request_invalid", "The provider base URL must not name a local host");
  } else if (url.protocol === "http:") {
    if (!options.allowLoopbackHttp || !loopback) throw new AdapterError("model_request_invalid", "A plain-HTTP provider base URL is accepted for the loopback host only");
  } else {
    throw new AdapterError("model_request_invalid", "The provider base URL must be https (or http on the loopback host)");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** Non-empty, one line, no control characters; the value never appears in any message. */
export function checkCredential(value: string | null | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AdapterError("model_credential_missing", `No usable ${name} is configured on this host`);
  }
  return value;
}

export async function postJson(
  http: ProviderHttpOptions,
  request: { provider_id: string; model_id: string; url: string; headers: Record<string, string>; body: unknown; signal: AbortSignal },
): Promise<{ status: number; json: unknown }> {
  const body = JSON.stringify(request.body);
  if (new TextEncoder().encode(body).length > MAX_PROVIDER_REQUEST_BYTES) {
    throw new AdapterError("model_request_invalid", "The model request exceeds the provider request limit");
  }
  http.observer?.({ provider_id: request.provider_id, model_id: request.model_id, url: request.url, body });
  if (request.signal.aborted) throw (request.signal.reason as Error | undefined) ?? new CancelledError();
  let response;
  try {
    response = await http.transport({
      url: request.url,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...request.headers },
      body,
      signal: request.signal,
      maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
    });
  } catch (error) {
    if (request.signal.aborted) throw (request.signal.reason as Error | undefined) ?? new CancelledError();
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("model_transport_error", "The provider request failed", { audit_facts: { stage: "transport" } });
  }
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new AdapterError("model_response_invalid", "The provider answered with invalid JSON", { audit_facts: { stage: "json_parse", http_status: response.status, json_parsed: false } });
  }
  return { status: response.status, json };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A provider's error `type` as an audit fact: a spaceless token or nothing. */
export function errorType(json: unknown): Record<string, string> {
  const error = isRecord(json) && isRecord(json.error) ? json.error : null;
  const type = error?.type ?? error?.code;
  return typeof type === "string" && /^[A-Za-z0-9_.:/#-]{1,200}$/u.test(type) ? { provider_error_type: type } : {};
}

export function providerError(status: number, json: unknown): AdapterError {
  return new AdapterError(status === 429 ? "model_rate_limited" : "model_provider_error", `The provider answered HTTP ${status}`, {
    audit_facts: { stage: "status", http_status: status, ...errorType(json) },
  });
}
