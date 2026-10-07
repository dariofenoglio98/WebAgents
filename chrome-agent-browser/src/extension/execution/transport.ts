/**
 * The browser transport (D-070): the core's `HttpTransport` over `fetch`, as a Chrome extension
 * context can perform it. One request; a redirect is returned as its status with an empty body
 * and never followed (`redirect: "manual"` gives an opaque redirect: status 0, so it is reported
 * as 300 with no location); no credentials, no referrer, no cache; the body streamed and the
 * request aborted at `maxResponseBytes`; the signal honoured from the first byte to the last.
 * Address classification of DNS names remains Chrome's network stack's job (D-026, D-067).
 *
 * The model transport may reach Ollama on the loopback host over plain HTTP (D-055); the tool
 * transport refuses any non-HTTPS destination before connecting.
 */
import { TransportError, type HttpRequest, type HttpResponse, type HttpTransport } from "../../core/models/transport.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function cancelled(signal: AbortSignal): Error {
  return (signal.reason as Error | undefined) ?? new TransportError("the request was cancelled", { stage: "transport" });
}

export function browserTransport(options: { allowLoopbackHttp: boolean; fetch?: FetchLike }): HttpTransport {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return async (request: HttpRequest): Promise<HttpResponse> => {
    if (request.signal.aborted) throw cancelled(request.signal);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new TransportError("the destination is not a URL", { stage: "address_policy" });
    }
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && options.allowLoopbackHttp)) {
      throw new TransportError("the destination must be https (or http on this machine for the model transport)", { stage: "address_policy", reason: "scheme_refused" });
    }
    if (url.username || url.password) throw new TransportError("the destination must not carry credentials", { stage: "address_policy", reason: "userinfo" });
    let response: Response;
    try {
      response = await doFetch(url.href, {
        method: request.method,
        headers: request.headers,
        body: request.body === null ? undefined : request.body,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw cancelled(request.signal);
      throw new TransportError(`the connection to the destination failed (${error instanceof Error ? error.name : "error"})`, { stage: "transport" });
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      // Each hop would need the whole destination policy re-applied to a destination nobody authorized.
      try {
        await response.body?.cancel();
      } catch {
        // nothing to release
      }
      return { status: response.status === 0 ? 300 : response.status, headers, body: "" };
    }
    const declared = Number.parseInt(headers["content-length"] ?? "", 10);
    if (Number.isFinite(declared) && declared > request.maxResponseBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // nothing to release
      }
      throw new TransportError("the response exceeds the byte cap", { stage: "body_size", http_status: response.status, response_bytes: declared });
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          size += value.length;
          if (size > request.maxResponseBytes) {
            await reader.cancel();
            throw new TransportError("the response exceeds the byte cap", { stage: "body_size", http_status: response.status, response_bytes: size });
          }
          chunks.push(value);
        }
      } catch (error) {
        if (request.signal.aborted) throw cancelled(request.signal);
        if (error instanceof TransportError) throw error;
        throw new TransportError("the response failed mid-transfer", { stage: "transport" });
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length > request.maxResponseBytes) throw new TransportError("the response exceeds the byte cap", { stage: "body_size", http_status: response.status, response_bytes: buffer.length });
      chunks.push(buffer);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return { status: response.status, headers, body: new TextDecoder().decode(joined) };
  };
}
