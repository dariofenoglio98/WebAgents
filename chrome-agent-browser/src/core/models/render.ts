/**
 * The exact wire content a model request becomes, as a pure function (`hostbridge/router.py`:
 * `render`, `token_upper_bound`, `closed_root_properties`). Purity is the point: the token
 * count and the completion render independently and agree, so nothing the model sees escapes
 * the count. The text is byte-identical to the reference's, checked against its vectors.
 */
import type { JsonObject, JsonValue } from "../json.js";
import { isJsonObject } from "../json.js";
import { pyJsonDumps, utf8Length } from "../pyjson.js";
import { AdapterError } from "../workflow/errors.js";
import type { ModelRequest } from "./contract.js";

export const PREAMBLE =
  "You are a bounded execution step inside a host agent runtime. You are given " +
  "instructions and one JSON input document, and you return one JSON output " +
  "document. You have no tools, no network access and no memory between calls.";
export const OUTPUT_CONTRACT =
  "Return exactly one JSON document that validates against the JSON Schema " +
  "below. Emit the JSON document alone: no prose before or after it, no " +
  "explanation, no markdown code fence.";
/**
 * Said in words when the answer is a closed object, because a provider may drop the
 * constrained response format without saying so and the model then sees the schema only as
 * text. Measured on the reference: naming the closed top-level set removed the one recurring
 * failure (an input field copied into the answer). Validation is unchanged by this sentence.
 */
export const CLOSED_ROOT_CONTRACT = "It is one JSON object with exactly these top-level properties and no others: {names}.";
/**
 * Tokens allowed for everything a provider adds around the two messages: role markers,
 * delimiters, BOS/EOS, the response-format envelope. Real chat templates spend single-digit
 * tokens per message; this is orders of magnitude above that, because over-reserving refuses a
 * request while under-reserving would corrupt the runtime's accounting invariant.
 */
export const FRAMING_TOKEN_ALLOWANCE = 512;
export const MAX_LISTED_PROPERTIES = 64;
const LISTABLE_PROPERTY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const LOCAL_DEFS_REF = /^#\/\$defs\/([^/]+)$/u;

export interface RenderedRequest {
  system: string;
  user: string;
  output_schema: JsonValue;
  schema_text: string;
}

/** `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. */
export function canonicalText(value: unknown): string {
  return pyJsonDumps(value, { sortKeys: true, compact: true });
}

/**
 * The exact top-level property names of a closed object root, or null. Follows one local
 * `#/$defs/<name>` root reference, the shape `Workflow.modelSchema` bundles every node schema
 * into.
 */
export function closedRootProperties(schema: JsonValue): string[] | null {
  let root: JsonValue = schema;
  if (isJsonObject(schema) && typeof schema.$ref === "string") {
    const match = LOCAL_DEFS_REF.exec(schema.$ref);
    const defs = schema.$defs;
    if (!match || !isJsonObject(defs)) return null;
    root = Object.hasOwn(defs, match[1]!) ? defs[match[1]!]! : null;
  }
  if (!isJsonObject(root) || root.type !== "object") return null;
  if (root.additionalProperties !== false) return null;
  const properties = root.properties;
  if (!isJsonObject(properties)) return null;
  const names = Object.keys(properties);
  if (names.length === 0 || names.length > MAX_LISTED_PROPERTIES) return null;
  if (!names.every((name) => LISTABLE_PROPERTY.test(name))) return null;
  return names;
}

export function render(request: ModelRequest): RenderedRequest {
  const instructions = request.instructions ?? [];
  if (!Array.isArray(instructions) || instructions.some((item) => typeof item !== "string")) {
    throw new AdapterError("model_request_invalid", "Request instructions must be strings");
  }
  const schema = request.output_schema;
  if (!(isJsonObject(schema) || typeof schema === "boolean")) {
    throw new AdapterError("model_request_invalid", "Request output_schema must be a schema");
  }
  const schemaText = canonicalText(schema);
  const sections = [PREAMBLE, `## Task\n${request.task ?? ""}`];
  if (instructions.length > 0) sections.push(`## Instructions\n${instructions.join("\n\n---\n\n")}`);
  let contract = OUTPUT_CONTRACT;
  const names = closedRootProperties(schema);
  if (names) contract += ` ${CLOSED_ROOT_CONTRACT.replace("{names}", names.join(", "))}`;
  sections.push(`## Output contract\n${contract}\n\n${schemaText}`);
  const feedback = request.feedback;
  if (feedback !== undefined) {
    // A re-ask (D-151): one line naming why the previous answer was not accepted. It is part of
    // the system text, so the count includes it.
    if (typeof feedback !== "string" || feedback.length === 0) throw new AdapterError("model_request_invalid", "Request feedback must be a nonempty string");
    sections.push(`## Correction\n${feedback}`);
  }
  return {
    system: sections.join("\n\n"),
    user: canonicalText(request.data),
    output_schema: schema,
    schema_text: schemaText,
  };
}

/**
 * A provable ceiling on the prompt tokens this request can cost. Every production subword
 * tokenizer decodes each vocabulary entry to at least one byte, so a text of B UTF-8 bytes
 * cannot exceed B tokens. The schema is counted twice: once in the system text and once for the
 * provider's own copy of it in the constrained-output request.
 */
export function tokenUpperBound(rendered: RenderedRequest): number {
  return utf8Length(rendered.system) + utf8Length(rendered.user) + utf8Length(rendered.schema_text) + FRAMING_TOKEN_ALLOWANCE;
}

export type { JsonObject };
