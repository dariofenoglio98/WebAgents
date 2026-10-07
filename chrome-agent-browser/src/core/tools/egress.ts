/**
 * Host-owned values travel only where they were granted to go (`host-resources.ts::
 * egressRefusal`, D-011). Before any tool call except a host-resource read, the arguments are
 * searched for the sealed values of every resource the host holds (case-insensitive, anywhere,
 * keys included): a value of a resource this run was not granted may go nowhere, and a granted
 * one only to a tool that links the permission it was granted under. It is an exact-value check
 * over values the host holds, not a general data-loss filter.
 *
 * "Anywhere" is unconditional: the scan is an iterative walk with no depth limit, so the work it
 * does is bounded by the size of the arguments (the broker caps them at `MAX_ARGS_BYTES`) and
 * never by a cut-off inside the document. A document that still holds more strings than the
 * ceiling is refused unread rather than passed as clean (review 1, blocker 2: the reference
 * plugin's recursive walk stops at depth 32 or 4,096 strings and treats the rest as clean,
 * BACKLOG B-114).
 */
import { isRecord } from "../fields.js";
import type { JsonValue } from "../json.js";
import type { ResourceGrant } from "../types.js";

/**
 * The sealed strings of every host resource, by opaque resource id: the shape `Vault.sealedValues()`
 * returns (D-051). Values never leave the host; this is the host's own view of what must not.
 */
export type SealedValues = ReadonlyMap<string, readonly string[]>;

/** More strings than this in one argument document and the scan refuses rather than guesses. The broker's 64 KiB cap keeps every real call far below it. */
export const MAX_SCANNED_STRINGS = 1 << 20;

/**
 * Every string in a JSON value, keys included, lower-cased, or null when the value holds more
 * strings than `limit`. Iterative, so nesting depth is not a limit either.
 */
export function scanStrings(value: JsonValue, limit: number = MAX_SCANNED_STRINGS): string[] | null {
  const found: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (found.length >= limit) return null;
      found.push(current.toLowerCase());
    } else if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (isRecord(current)) {
      for (const [key, item] of Object.entries(current)) {
        if (found.length >= limit) return null;
        found.push(key.toLowerCase());
        stack.push(item);
      }
    }
  }
  return found;
}

/**
 * Which sealed value, if any, a tool call's arguments may not carry: a refusal reason, or
 * null when the arguments carry no sealed value they should not. A scan that could not finish
 * is a refusal too.
 */
export function egressRefusal(args: JsonValue, grants: readonly ResourceGrant[], linked: readonly string[], sealed: SealedValues): string | null {
  if (sealed.size === 0) return null;
  const carried = scanStrings(args);
  if (carried === null) return "the arguments hold more strings than the egress check scans, so they are refused unread";
  if (carried.length === 0) return null;
  for (const [resourceId, values] of sealed) {
    for (const value of values) {
      const needle = value.toLowerCase();
      if (!carried.some((item) => item.includes(needle))) continue;
      const grant = grants.find((item) => item.resource_id === resourceId);
      if (!grant) return "the arguments carry a value of a host resource this run was not granted";
      if (!linked.includes(grant.permission_id)) {
        return "the arguments carry a granted host value to a tool that does not link the permission it was granted under";
      }
    }
  }
  return null;
}
