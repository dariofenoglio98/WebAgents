/**
 * Closed tool failure facts (`toolbridge/facts.py`, `tool-facts.ts`): raw service strings never
 * cross into the audit. A fact identifies the stage, an HTTP status, a content-type category,
 * a byte count, a size overflow, a parse result, a timeout or a cancellation; a schema failure
 * reports only an allow-listed keyword and the schema and instance depth.
 */
import type { JsonValue } from "../json.js";
import type { SchemaFailure } from "../schema.js";

export const STAGES = new Set([
  "transport",
  "status",
  "content_type",
  "body_size",
  "json_parse",
  "input_schema",
  "output_schema",
  "adapter_response",
  "timeout",
  "tls",
  "address_policy",
  "cancelled",
  "binding",
  "bridge",
]);
export const CONTENT_TYPES = new Set(["json", "json_suffix", "html", "text", "missing", "other"]);
export const KEYWORDS = new Set([
  "type",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "contains",
  "false_schema",
]);

export type ToolFailureFacts = Record<string, JsonValue>;

export function safeToolFacts(value: unknown): ToolFailureFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const safe: ToolFailureFacts = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const choices: Record<string, Set<string>> = { stage: STAGES, content_type: CONTENT_TYPES, schema_keyword: KEYWORDS };
    if (key in choices && typeof entry === "string" && choices[key]!.has(entry)) safe[key] = entry;
    else if (["response_bytes", "schema_depth", "instance_depth"].includes(key)) {
      if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < 2 ** 53) safe[key] = entry;
    } else if (key === "http_status" && typeof entry === "number" && Number.isInteger(entry) && entry >= 100 && entry <= 599) safe[key] = entry;
    else if (["body_exceeded", "json_parsed", "timeout", "cancelled"].includes(key) && typeof entry === "boolean") safe[key] = entry;
  }
  return safe;
}

/** `schema_facts(error, stage)`: the keyword and depths of a schema failure, when the error carries one. */
export function schemaFacts(error: unknown, stage: string): ToolFailureFacts {
  const failure = (error as { schema_failure?: SchemaFailure } | null)?.schema_failure;
  return safeToolFacts({
    stage,
    schema_keyword: failure?.keyword,
    schema_depth: failure ? failure.keywordLocation.split("/").filter(Boolean).length : undefined,
    instance_depth: failure ? failure.instancePath.length : undefined,
  });
}

export function contentTypeCategory(value: string | null): string {
  const type = (value ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type) return "missing";
  if (type === "application/json") return "json";
  if (/^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(type)) return "json_suffix";
  if (type === "text/html") return "html";
  return type.startsWith("text/") ? "text" : "other";
}
