/**
 * The one line a re-ask carries (D-151, spec section 7): why the previous answer was not
 * accepted, named by the package's own check or by the output schema, so a model can correct it.
 *
 * The line is built from structure, never from prose a model or a service wrote:
 * - a refused answer check: its index, kind, failure code and the package's pointers, plus at
 *   most three of the key values the failure is about, and only values that already occur in
 *   the request's data or in the refused answer. The model wrote or was given every value it is
 *   shown again, so nothing it has not seen (a host value, a record it was not sent) can reach
 *   it through this line;
 * - a schema miss: the failing keyword, the location in the answer as a JSON Pointer, and for
 *   `required` the missing property names the schema declares;
 * - an answer that was not one JSON document, or no text at all.
 *
 * The line goes to the model only, in the request's `feedback` field, which the router renders
 * as the last system section (`## Correction`) and counts. It is never audited: the audit names
 * the check by its pointers alone (`model.called`'s `after`).
 */
import type { JsonObject, JsonValue } from "../json.js";
import { pyJsonDumps } from "../pyjson.js";
import { identity } from "./values.js";

export const FEEDBACK_PREFIX = "The previous answer was not accepted: ";
export const FEEDBACK_SUFFIX = " Return the complete JSON document again, corrected.";
/** The request schema's bound on `feedback` (`model-request.schema.json`). */
export const MAX_FEEDBACK_CHARS = 1000;
export const MAX_FEEDBACK_VALUES = 3;
/** A value is repeated only when it is a string of at most this many characters, a number or a boolean. */
export const MAX_FEEDBACK_VALUE_CHARS = 80;
export const MAX_MISSING_NAMES = 8;
const LISTABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

/** Why an answer was not accepted, in the structural terms a feedback line may use. */
export type Refusal =
  | { kind: "check"; failed_check: JsonObject; offending: readonly JsonValue[] }
  | { kind: "route"; failure: string; next: string | null }
  | { kind: "schema"; keyword: string; instance_path: readonly string[]; missing: readonly string[] }
  | { kind: "not_json" }
  | { kind: "no_text" }
  | { kind: "unknown" };

/** A JSON Pointer from reference tokens (RFC 6901: `~` as `~0`, `/` as `~1`). */
export function pointer(tokens: readonly string[]): string {
  return tokens.map((token) => `/${token.replace(/~/gu, "~0").replace(/\//gu, "~1")}`).join("");
}

/** Every scalar a JSON value holds (strings, numbers, booleans), by identity: what a model was given or wrote. */
export function disclosedScalars(...values: readonly JsonValue[]): Set<string> {
  const seen = new Set<string>();
  const stack: JsonValue[] = [...values];
  while (stack.length > 0) {
    const value = stack.pop()!;
    if (Array.isArray(value)) stack.push(...value);
    else if (value !== null && typeof value === "object") stack.push(...Object.values(value));
    else if (value !== null) seen.add(identity(value));
  }
  return seen;
}

function showable(value: JsonValue, disclosed: ReadonlySet<string>): boolean {
  if (typeof value === "string") {
    const length = [...value].length;
    if (length === 0 || length > MAX_FEEDBACK_VALUE_CHARS) return false;
  } else if (typeof value !== "number" && typeof value !== "boolean") {
    return false;
  }
  return disclosed.has(identity(value));
}

/** Where a failed check is, by the pointer its failure names (` at /owner`); empty when the failure names none or the pointer is the whole value. */
export function checkLocation(check: JsonObject): string {
  const at = (path: JsonValue | undefined) => (typeof path === "string" && path !== "" ? ` at ${path}` : "");
  switch (check.failure) {
    case "duplicate_target_key":
      return at(check.target_key);
    case "missing_target_key":
    case "no_key":
      return at(check.row_key);
    case "target_value_mismatch":
    case "summand_not_number":
    case "sum_differs":
      return at(check.path);
    case "fields_do_not_match": {
      const compare = check.compare as JsonObject | undefined;
      return compare ? ` at ${String(compare.left)} ${String(compare.op)} ${String(compare.right)}` : "";
    }
    default:
      return "";
  }
}

function checkReason(refusal: Extract<Refusal, { kind: "check" }>, disclosed: ReadonlySet<string>, detail: { location: boolean; values: boolean }): string {
  const check = refusal.failed_check;
  let reason = `answer check ${String(check.index)} (${String(check.kind)}) failed: ${String(check.failure)}`;
  if (detail.location) reason += checkLocation(check);
  if (detail.values) {
    const shown = refusal.offending.filter((value) => showable(value, disclosed));
    if (shown.length > 0) {
      reason += ` for ${shown.slice(0, MAX_FEEDBACK_VALUES).map((value) => pyJsonDumps(value, { sortKeys: true, compact: true })).join(", ")}`;
      if (shown.length > MAX_FEEDBACK_VALUES) reason += ` (and ${shown.length - MAX_FEEDBACK_VALUES} more)`;
    }
  }
  return `${reason}.`;
}

/**
 * A refused route (network.v0 R-28): the transition check's failure code and the declared target the
 * answer named, which the model wrote and the request's own enum lists; the request's `targets`
 * already say how often each target can still be taken.
 */
function routeReason(refusal: Extract<Refusal, { kind: "route" }>, detail: { location: boolean; values: boolean }): string {
  let reason = `the route check refused it: ${refusal.failure}`;
  if (detail.values && refusal.next !== null) reason += ` for ${pyJsonDumps(refusal.next, { sortKeys: true, compact: true })}`;
  return `${reason}. Choose among the targets whose uses_left is above zero, or done where may_end is true.`;
}

function schemaReason(refusal: Extract<Refusal, { kind: "schema" }>, detail: { location: boolean; values: boolean }): string {
  let reason = `it does not match the output schema: ${refusal.keyword}`;
  if (detail.location) reason += ` at ${refusal.instance_path.length > 0 ? pointer(refusal.instance_path) : "the document root"}`;
  const names = refusal.missing.filter((name) => LISTABLE_NAME.test(name)).slice(0, MAX_MISSING_NAMES);
  if (detail.values && refusal.keyword === "required" && names.length > 0) reason += ` (missing: ${names.join(", ")})`;
  return `${reason}.`;
}

/**
 * The exact feedback line for one refusal. `disclosed` is what the model was given or wrote
 * (`disclosedScalars(request.data, answer)`). A line over `MAX_FEEDBACK_CHARS` first loses its
 * values, then its location; the prefix, the reason's kind and code and the suffix always remain.
 */
export function feedbackLine(refusal: Refusal, disclosed: ReadonlySet<string> = new Set()): string {
  const build = (detail: { location: boolean; values: boolean }): string => {
    let reason: string;
    if (refusal.kind === "check") reason = checkReason(refusal, disclosed, detail);
    else if (refusal.kind === "route") reason = routeReason(refusal, detail);
    else if (refusal.kind === "schema") reason = schemaReason(refusal, detail);
    else if (refusal.kind === "not_json") reason = "it is not one JSON document.";
    else if (refusal.kind === "no_text") reason = "it contained no text.";
    else reason = "it does not satisfy the output contract.";
    return `${FEEDBACK_PREFIX}${reason}${FEEDBACK_SUFFIX}`;
  };
  for (const detail of [{ location: true, values: true }, { location: true, values: false }, { location: false, values: false }]) {
    const line = build(detail);
    if ([...line].length <= MAX_FEEDBACK_CHARS) return line;
  }
  return build({ location: false, values: false }).slice(0, MAX_FEEDBACK_CHARS);
}
