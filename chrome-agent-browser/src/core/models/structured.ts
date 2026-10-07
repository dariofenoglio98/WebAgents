/**
 * Reading a model's answer as one JSON document, and classifying a turn that did not finish
 * (`hostbridge/router.py`: `parse_structured`, `classify_termination`).
 *
 * Three readings in decreasing order of how well the model followed the contract, then
 * failure. There is deliberately no repair loop: a second call to fix the first would spend
 * tokens the runtime already reserved against a single completion.
 */
import type { JsonValue } from "../json.js";
import { utf8Length } from "../pyjson.js";
import { AdapterError } from "../workflow/errors.js";

export const MAX_COMPLETION_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_EXTRACTION_DEPTH = 256;
export type ParseMode = "direct" | "fenced" | "extracted";

/** Return the first complete JSON value beginning at `start`, or null. */
function balanced(text: string, start: number): string | null {
  const opening = text[start]!;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opening) {
      depth += 1;
      if (depth > MAX_EXTRACTION_DEPTH) return null;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function loads(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Python's `str.strip()` on the whitespace a model answer carries around a document. */
function strip(text: string): string {
  return text.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/gu, "");
}

export function parseStructured(text: string): [JsonValue, ParseMode] {
  if (utf8Length(text) > MAX_COMPLETION_TEXT_BYTES) {
    throw new AdapterError("model_output_too_large", "The model returned an oversized response");
  }
  const stripped = strip(text);
  if (!stripped) throw new AdapterError("model_output_not_conforming", "The model returned no output");
  const direct = loads(stripped);
  if (direct !== undefined) return [direct, "direct"];
  if (stripped.startsWith("```")) {
    let body = stripped.slice(3);
    if (body.slice(0, 4).toLowerCase().startsWith("json")) body = body.slice(4);
    const end = body.lastIndexOf("```");
    if (end > 0) {
      const fenced = loads(strip(body.slice(0, end)));
      if (fenced !== undefined) return [fenced, "fenced"];
    }
  }
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index]!;
    if (char === "{" || char === "[") {
      const candidate = balanced(stripped, index);
      if (candidate !== null) {
        const extracted = loads(candidate);
        if (extracted !== undefined) return [extracted, "extracted"];
      }
      break;
    }
  }
  throw new AdapterError("model_output_not_conforming", "The model did not return a single JSON document");
}

export const STOP_COMPLETE = "stop";
export const STOP_LENGTH = "length";

/**
 * The failure a non-finished turn is, or null for a finished one. `stop` (or no stop reason
 * at all) is a turn the provider finished, and only such a turn's text is parsed. `length` is
 * an answer cut off at the output limit. Anything else (an error, a refusal, a content filter,
 * an abort, a tool call this adapter never offered) is a turn the provider did not complete.
 * None of these is retried here or anywhere else, and none is reported as non-conforming output.
 */
export function classifyTermination(stopReason: string | null | undefined): [string, string] | null {
  if (stopReason === null || stopReason === undefined || stopReason === STOP_COMPLETE) return null;
  if (stopReason === STOP_LENGTH) {
    return ["model_output_truncated", "The model stopped at its output limit before the answer was complete"];
  }
  return ["model_turn_failed", "The provider did not complete this turn (an error, a refusal or a content filter)"];
}
