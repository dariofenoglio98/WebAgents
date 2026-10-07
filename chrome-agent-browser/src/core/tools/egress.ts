/**
 * Host-owned values travel only where they were granted to go (`host-resources.ts::
 * egressRefusal`, D-011). Before any tool call except a host-resource read, the arguments are
 * searched for the sealed values of every resource the host holds (case-insensitive, anywhere,
 * keys included): a value of a resource this run was not granted may go nowhere, and a granted
 * one only to a tool that links the permission it was granted under. It is an exact-value check
 * over values the host holds, not a general data-loss filter.
 */
import type { JsonValue } from "../json.js";
import type { ResourceGrant } from "../types.js";

/** The sealed strings of one host resource, by its opaque id. Values never leave the host; this is the host's own view. */
export interface SealedValues {
  resource_id: string;
  values: readonly string[];
}

/** Every string in a JSON value, lower-cased, bounded. */
export function strings(value: JsonValue, found: string[] = [], depth = 0): string[] {
  if (depth > 32 || found.length > 4096) return found;
  if (typeof value === "string") found.push(value.toLowerCase());
  else if (Array.isArray(value)) for (const item of value) strings(item, found, depth + 1);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      found.push(key.toLowerCase());
      strings(item, found, depth + 1);
    }
  }
  return found;
}

/**
 * Which sealed value, if any, a tool call's arguments may not carry: a refusal reason, or
 * null when the arguments carry no sealed value they should not.
 */
export function egressRefusal(args: JsonValue, grants: readonly ResourceGrant[], linked: readonly string[], sealed: readonly SealedValues[]): string | null {
  if (sealed.length === 0) return null;
  const carried = strings(args);
  if (carried.length === 0) return null;
  for (const resource of sealed) {
    for (const value of resource.values) {
      const needle = value.toLowerCase();
      if (!carried.some((item) => item.includes(needle))) continue;
      const grant = grants.find((item) => item.resource_id === resource.resource_id);
      if (!grant) return "the arguments carry a value of a host resource this run was not granted";
      if (!linked.includes(grant.permission_id)) {
        return "the arguments carry a granted host value to a tool that does not link the permission it was granted under";
      }
    }
  }
  return null;
}
