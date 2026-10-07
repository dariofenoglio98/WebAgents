/**
 * Finite data constructors, keyed selection and bounded allocation
 * (`agentpkg/workflow_values.py`); no executable expressions. `select` and `tokens` live in
 * `references.ts`, shared with the static checks.
 *
 * Equality is Python's `==` over JSON values (`pyEqual`): structural, numbers by value, and a
 * boolean equal to the number it is in Python (`True == 1`), so a `when` condition, an `equal`
 * assertion or a fixture match gives the same verdict in both runtimes. Identity for keyed
 * matching (`lookup`, `relation`, `join.unique_by`) is the canonical JSON text, the same text
 * the reference hashes.
 */
import { canonicalString } from "../canonical.js";
import { ValidationError } from "../errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import { deepCopy, select } from "../references.js";
import { pyRepr } from "../repr.js";

export type Environment = Record<string, JsonValue>;

/** Python `==` over JSON values. */
export function pyEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  const numeric = (value: JsonValue): number | null => (typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : null);
  const left = numeric(a);
  const right = numeric(b);
  if (left !== null && right !== null) return left === right;
  if (left !== null || right !== null) return false;
  if (a === null || b === null) return false;
  if (typeof a === "string" || typeof b === "string") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => pyEqual(item, b[index]!));
  }
  const objectA = a as JsonObject;
  const objectB = b as JsonObject;
  const keysA = Object.keys(objectA);
  const keysB = Object.keys(objectB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.hasOwn(objectB, key) && pyEqual(objectA[key]!, objectB[key]!));
}

/** The canonical JSON form the reference's `runtime.digest` hashes: exact key equality for lookups. */
export function identity(value: JsonValue): string {
  return canonicalString(value);
}

/**
 * A declared keyed selection that did not find exactly one member. Like an assertion
 * failure, `failed_check` names only the package's own pointers, never a value from the data.
 */
export class LookupFailure extends ValidationError {
  override readonly name: string = "LookupFailure";
  readonly failed_check: Record<string, unknown>;

  constructor(failure: string, message: string, spec: JsonObject) {
    super(`lookup: ${message}`);
    this.failed_check = { check: "lookup", failure, key: spec.key, path: spec.path };
  }
}

export function evaluate(expression: JsonValue, environment: Environment): JsonValue {
  const spec = expression as JsonObject;
  if ("literal" in spec) return deepCopy(spec.literal!);
  if ("from" in spec) {
    const source = String(spec.from);
    if (!Object.hasOwn(environment, source)) throw new ValidationError(`Unavailable projection source ${pyRepr(source)}`);
    return select(environment[source]!, String(spec.path), source);
  }
  if ("coalesce" in spec) {
    for (const child of spec.coalesce as JsonValue[]) {
      const value = evaluate(child, environment);
      if (value !== null) return value;
    }
    return null;
  }
  if ("object" in spec) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(spec.object as JsonObject)) out[key] = evaluate(value, environment);
    return out;
  }
  if ("lookup" in spec) return lookup(spec.lookup as JsonObject, environment);
  if ("allocate" in spec) return allocate(spec.allocate as JsonObject, environment);
  return (spec.array as JsonValue[]).map((value) => evaluate(value, environment));
}

const MAX_WEIGHT = 2147483647;

function positiveInteger(value: unknown): value is number {
  // JSON Schema treats 1.0 as an integer too; booleans are not numbers here.
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_WEIGHT;
}

/**
 * Apportion a bounded integer total across positive weighted records: reserve one unit per
 * record, distribute the rest in proportion with integer division, then largest remainders,
 * ties in input order. Exact allocations are returned unchanged. Integer arithmetic only
 * (BigInt for the products, which exceed 2^53).
 */
export function allocate(spec: JsonObject, environment: Environment): JsonValue {
  const rows = evaluate(spec.rows!, environment);
  const total = evaluate(spec.total!, environment);
  const field = String(spec.field);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 256) throw new ValidationError("allocate: requires 1 to 256 records");
  if (!positiveInteger(total) || total < rows.length) throw new ValidationError("allocate: total must be a feasible bounded integer");
  if (rows.some((row) => !isJsonObject(row) || !positiveInteger(Object.hasOwn(row, field) ? row[field] : undefined))) {
    throw new ValidationError("allocate: weights must be positive bounded integers");
  }
  const records = rows as JsonObject[];
  const weights = records.map((row) => row[field] as number);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum === total) return records;
  const remaining = BigInt(total - records.length);
  const sum = BigInt(weightSum);
  const quotients = weights.map((weight) => {
    const product = remaining * BigInt(weight);
    return [product / sum, product % sum] as const;
  });
  const amounts = quotients.map(([quotient]) => 1 + Number(quotient));
  const order = records.map((_, index) => index).sort((a, b) => {
    const left = quotients[a]![1];
    const right = quotients[b]![1];
    if (left !== right) return left > right ? -1 : 1;
    return a - b;
  });
  const leftover = total - amounts.reduce((sum, amount) => sum + amount, 0);
  for (const index of order.slice(0, leftover)) amounts[index] += 1;
  records.forEach((row, index) => {
    row[field] = amounts[index]!;
  });
  return records;
}

/**
 * Select `path` from the one member of `in` whose `key` equals `equals`: identical key
 * equality to a relation assertion, exactly one match required, nothing defaulted.
 */
export function lookup(spec: JsonObject, environment: Environment): JsonValue {
  const members = evaluate(spec.in!, environment);
  if (!Array.isArray(members)) throw new LookupFailure("not_array", "lookup `in` must be an array", spec);
  const wanted = identity(evaluate(spec.equals!, environment));
  const matches = members.filter((member) => identity(select(member, String(spec.key), "lookup")) === wanted);
  if (matches.length === 0) throw new LookupFailure("no_match", "no member has the requested key", spec);
  if (matches.length > 1) throw new LookupFailure("duplicate_key", "several members have the requested key", spec);
  return select(matches[0]!, String(spec.path), "lookup");
}
