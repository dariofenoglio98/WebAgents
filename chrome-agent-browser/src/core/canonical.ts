/**
 * RFC 8785 JSON Canonicalization Scheme, mirroring `agentpkg/package.py::canonical_json`
 * (which delegates to the `rfc8785` package).
 *
 * The scheme is small: no insignificant whitespace, object members sorted by the UTF-16 code
 * units of their names, numbers in ECMAScript `Number::toString` form (which `JSON.stringify`
 * produces natively, the reference reimplements), strings escaped exactly as JSON.stringify
 * escapes them (`"`, `\` and the C0 controls only; U+007F and U+2028 stay literal), `-0` as
 * `0`. Non-finite numbers and non-JSON values are refused. `test/core/canonical.test.ts`
 * checks this against vectors produced by the reference, including the shipped packages'
 * integrity statements and their digests.
 */
import { ValidationError } from "./errors.js";

export function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalString(value));
}

export function canonicalString(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new ValidationError("value cannot be represented as canonical JCS JSON: non-finite number");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalString(item)).join(",")}]`;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ValidationError("value cannot be represented as canonical JCS JSON: not a plain object");
      }
      const record = value as Record<string, unknown>;
      // Default string sort compares UTF-16 code units, which is the JCS member order.
      const keys = Object.keys(record).sort();
      const members: string[] = [];
      for (const key of keys) {
        const item = record[key];
        if (item === undefined) {
          throw new ValidationError("value cannot be represented as canonical JCS JSON: undefined member");
        }
        members.push(`${JSON.stringify(key)}:${canonicalString(item)}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      throw new ValidationError(`value cannot be represented as canonical JCS JSON: ${typeof value}`);
  }
}
