/**
 * The closed-field validators the host-facing modules share, mirroring the `_fields`,
 * `_text`, `_count`, `_hex64` and `_identifier` helpers that `browser/hostmodels.py`,
 * `browser/hostresources.py` and `browser/hosttools.py` each define.
 *
 * A closed field set is the contract: a host may send only what is listed, so no endpoint,
 * header, credential, value or request parameter has a place to travel in. Refusals carry the
 * reference's codes (`invalid_request`, `unknown_field`) and message texts.
 */
import { CoreError } from "./errors.js";
import { pyRepr } from "./repr.js";

export const MAX_STRING = 512;
export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;

export function invalid(message: string, code = "invalid_request"): CoreError {
  return new CoreError(code, message, { status: 400 });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `_fields`: an object with only `allowed` keys and every `required` one, or a refusal. */
export function closedRecord(value: unknown, field: string, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${field} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) throw invalid(`Unknown fields in ${field}: ${pyRepr(unknown)}`, "unknown_field");
  const missing = required.filter((key) => !Object.hasOwn(value, key)).sort();
  if (missing.length > 0) throw invalid(`Missing fields in ${field}: ${pyRepr(missing)}`);
  return value;
}

export interface TextOptions {
  limit?: number;
  allowNull?: boolean;
  /** `hostresources._text`: the empty string is refused and U+007F counts as a control character. */
  nonEmpty?: boolean;
}

/** `_text`: a bounded string without control characters. */
export function text(value: unknown, field: string, options: TextOptions = {}): string | null {
  const limit = options.limit ?? MAX_STRING;
  if (value === null || value === undefined) {
    if (options.allowNull) return null;
    throw invalid(options.nonEmpty ? `${field} must be a non-empty string` : `${field} must be a string`);
  }
  if (typeof value !== "string" || (options.nonEmpty && value.length === 0)) {
    throw invalid(options.nonEmpty ? `${field} must be a non-empty string` : `${field} must be a string`);
  }
  if ([...value].length > limit) throw invalid(`${field} exceeds ${limit} characters`);
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (options.nonEmpty && code === 0x7f)) throw invalid(`${field} must not contain control characters`);
  }
  return value;
}

export function requiredText(value: unknown, field: string, options: Omit<TextOptions, "allowNull"> = {}): string {
  return text(value, field, options)!;
}

export function identifier(value: unknown, field: string): string {
  const id = requiredText(value, field, { limit: 128, nonEmpty: true });
  if (!IDENTIFIER.test(id)) throw invalid(`${field} is not a valid identifier`);
  return id;
}

export function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${field} must be true or false`);
  return value;
}

/** `_tristate`: true, false or null. */
export function tristate(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  throw invalid(`${field} must be true, false or null`);
}

/** `hostmodels._count`: a nonnegative integer or null. */
export function nonnegativeCount(value: unknown, field: string, allowNull = true): number | null {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw invalid(`${field} must be a nonnegative integer`);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(`${field} must be a nonnegative integer`);
  return value;
}

/** `hosttools._count`: a positive integer, bounded, or null. */
export function positiveCount(value: unknown, field: string, options: { allowNull?: boolean; maximum?: number } = {}): number | null {
  if (value === null || value === undefined) {
    if (options.allowNull ?? true) return null;
    throw invalid(`${field} must be a positive integer`);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw invalid(`${field} must be a positive integer`);
  if (options.maximum !== undefined && value > options.maximum) throw invalid(`${field} exceeds ${options.maximum}`);
  return value;
}

export function hex64(value: unknown, field: string, allowNull = false): string | null {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw invalid(`${field} must be a non-empty string`);
  }
  const digest = requiredText(value, field, { limit: 64, nonEmpty: true });
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw invalid(`${field} must be 64 lowercase hex characters`);
  return digest;
}

/** `sorted(set(values))` of strings, in Python's code-point order (UTF-16 order agrees for BMP text). */
export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}
