/** Probe-only observation at fetch dispatch. Never changes a request or reads headers. */
import { channel } from "node:diagnostics_channel";
import { createHash } from "node:crypto";
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function transportFacts(urlValue, bodyValue, expectedSchema) {
  let url, body;
  try { url = new URL(urlValue); body = JSON.parse(bodyValue); } catch { return null; }
  let route;
  if (url.protocol === "https:" && url.hostname === "api.openai.com" && url.pathname === "/v1/responses") route = "openai_api_responses";
  else if (url.protocol === "https:" && url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses") route = "chatgpt_codex_responses";
  else if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/api/chat") route = "local_ollama_chat";
  else return null;
  const format = body.text?.format ?? body.response_format;
  const schema = format?.schema ?? format?.json_schema?.schema ?? (typeof body.format === "object" ? body.format : null);
  const cap = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? body.options?.num_predict;
  return {
    route, schema_present: schema !== null && schema !== undefined,
    schema_matches_requested: schema ? canonical(schema) === canonical(expectedSchema) : false,
    schema_sha256: schema ? createHash("sha256").update(canonical(schema)).digest("hex") : null,
    strict: typeof format?.strict === "boolean" ? format.strict : null,
    max_output_present: Number.isSafeInteger(cap) && cap > 0,
    max_output_value: Number.isSafeInteger(cap) && cap > 0 ? cap : null,
  };
}
export function observeTransport(expectedSchema, emit) {
  const transport = channel("undici:request:create");
  const observer = ({ request }) => {
    const body = typeof request.body === "string" ? request.body
      : Buffer.isBuffer(request.body) || request.body instanceof Uint8Array
        ? Buffer.from(request.body).toString("utf8") : null;
    if (body !== null) {
      const facts = transportFacts(String(request.origin) + request.path, body, expectedSchema);
      if (facts) emit({ ...facts, observation_point: "undici_dispatch" });
    }
  };
  transport.subscribe(observer);
  const original = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    // Only JSON request strings: no stream consumption, no response observation.
    if (typeof init?.body === "string") {
      const value = input instanceof Request ? input.url : String(input);
      const facts = transportFacts(value, init.body, expectedSchema);
      if (facts) emit({ ...facts, observation_point: "fetch_dispatch" });
    }
    return original.apply(this, arguments);
  };
  return () => { globalThis.fetch = original; transport.unsubscribe(observer); };
}
