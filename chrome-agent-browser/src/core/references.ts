/**
 * Helpers shared by payload validation and the workflow static checks: unique ids, offline
 * package-relative schema references, and JSON Pointer tokens and selection
 * (`validation.py::_unique`, `_schema_reference`; `workflow_values.py::tokens`, `select`).
 */
import { ValidationError } from "./errors.js";
import type { JsonObject, JsonValue } from "./json.js";
import { pyRepr } from "./repr.js";
import { unquote, urlsplit } from "./urls.js";

export function unique(items: readonly JsonValue[], label: string): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const item of items) {
    const record = item as JsonObject;
    const key = String(record.id);
    if (result.has(key)) throw new ValidationError(`${label}: duplicate id ${pyRepr(key)}`);
    result.set(key, record);
  }
  return result;
}

/** `PurePosixPath(base).parent / decoded`, with `.` and empty segments collapsed. */
function joinRelative(base: string, decoded: string): string {
  const parent = base.split("/").slice(0, -1);
  const segments = decoded.split("/").filter((segment) => segment !== "" && segment !== ".");
  return [...parent, ...segments].join("/");
}

/** `validation.py::_schema_reference`: (target document path, fragment). */
export function schemaReference(base: string, ref: string): [string, string] {
  let parsed;
  try {
    parsed = urlsplit(ref);
  } catch {
    throw new ValidationError(`${base}: only offline package-relative JSON Schema references allowed: ${pyRepr(ref)}`);
  }
  if (parsed.scheme || parsed.netloc || parsed.query || parsed.path.startsWith("/") || ref.includes("\\")) {
    throw new ValidationError(`${base}: only offline package-relative JSON Schema references allowed: ${pyRepr(ref)}`);
  }
  const decoded = unquote(parsed.path);
  if (decoded.split("/").some((part) => part === "..")) {
    throw new ValidationError(`${base}: schema reference traversal is forbidden: ${pyRepr(ref)}`);
  }
  const target = decoded ? joinRelative(base, decoded) : base;
  return [target, unquote(parsed.fragment)];
}

/** `workflow_values.py::tokens`: JSON Pointer tokens, `~1` and `~0` unescaped. */
export function tokens(path: string): string[] {
  if (!path) return [];
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

export function deepCopy<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as T;
  if (typeof value === "object" && value !== null) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepCopy(item);
    return out as T;
  }
  return value;
}

/** `workflow_values.py::select`: follow a JSON Pointer, copying the result. */
export function select(value: JsonValue, path: string, label = "value"): JsonValue {
  let current: JsonValue = value;
  for (const key of tokens(path)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) throw new ValidationError(`${label}: missing data at ${pyRepr(path)}`);
      const index = Number(key);
      if (index >= current.length) throw new ValidationError(`${label}: missing data at ${pyRepr(path)}`);
      current = current[index]!;
    } else if (typeof current === "object" && current !== null) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        throw new ValidationError(`${label}: missing data at ${pyRepr(path)}`);
      }
      current = current[key]!;
    } else {
      throw new ValidationError(`${label}: missing data at ${pyRepr(path)}`);
    }
  }
  return deepCopy(current);
}

/** `workflow_values.py::references`: every `(source, pointer)` a constructor reads. */
export function* references(expression: JsonValue): Generator<[string, string]> {
  if (typeof expression !== "object" || expression === null || Array.isArray(expression)) return;
  if ("from" in expression) {
    yield [String(expression.from), String(expression.path)];
  } else if ("lookup" in expression) {
    const lookup = expression.lookup as JsonObject;
    yield* references(lookup.in!);
    yield* references(lookup.equals!);
  } else if ("allocate" in expression) {
    const allocate = expression.allocate as JsonObject;
    yield* references(allocate.rows!);
    yield* references(allocate.total!);
  } else if ("object" in expression) {
    for (const value of Object.values(expression.object as JsonObject)) yield* references(value);
  } else if ("coalesce" in expression) {
    for (const value of expression.coalesce as JsonValue[]) yield* references(value);
  } else if ("array" in expression) {
    for (const value of expression.array as JsonValue[]) yield* references(value);
  }
}
