/** Closed structural diagnostics. No response text, header values, URLs or identities. */
export type ToolFailureFacts = {
  stage?: "transport" | "status" | "content_type" | "body_size" | "json_parse" |
    "input_schema" | "output_schema" | "adapter_response" | "timeout" | "tls" |
    "address_policy" | "cancelled" | "binding" | "bridge";
  http_status?: number;
  content_type?: "json" | "json_suffix" | "html" | "text" | "missing" | "other";
  response_bytes?: number;
  body_exceeded?: boolean;
  json_parsed?: boolean;
  timeout?: boolean;
  cancelled?: boolean;
};
const STAGES = new Set(["transport", "status", "content_type", "body_size", "json_parse",
  "input_schema", "output_schema", "adapter_response", "timeout", "tls", "address_policy",
  "cancelled", "binding", "bridge"]);
const CONTENT_TYPES = new Set(["json", "json_suffix", "html", "text", "missing", "other"]);
export function safeToolFacts(value: unknown): ToolFailureFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "stage" && typeof entry === "string" && STAGES.has(entry)) result[key] = entry;
    if (key === "content_type" && typeof entry === "string" && CONTENT_TYPES.has(entry)) result[key] = entry;
    if (key === "http_status" && Number.isInteger(entry) && Number(entry) >= 100 && Number(entry) <= 599) result[key] = entry;
    if (key === "response_bytes" && Number.isSafeInteger(entry) && Number(entry) >= 0) result[key] = entry;
    if (["body_exceeded", "json_parsed", "timeout", "cancelled"].includes(key) && typeof entry === "boolean") result[key] = entry;
  }
  return result as ToolFailureFacts;
}
export function contentTypeCategory(value: string | null): NonNullable<ToolFailureFacts["content_type"]> {
  const type = (value ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type) return "missing";
  if (type === "application/json") return "json";
  if (/^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(type)) return "json_suffix";
  if (type === "text/html") return "html";
  return type.startsWith("text/") ? "text" : "other";
}
