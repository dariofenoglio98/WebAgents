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
import { strings } from "../vault.js";

/**
 * The sealed strings of every host resource, by opaque resource id: the shape `Vault.sealedValues()`
 * returns (D-051). Values never leave the host; this is the host's own view of what must not.
 */
export type SealedValues = ReadonlyMap<string, readonly string[]>;

/**
 * Which sealed value, if any, a tool call's arguments may not carry: a refusal reason, or
 * null when the arguments carry no sealed value they should not.
 */
export function egressRefusal(args: JsonValue, grants: readonly ResourceGrant[], linked: readonly string[], sealed: SealedValues): string | null {
  if (sealed.size === 0) return null;
  const carried = strings(args);
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
