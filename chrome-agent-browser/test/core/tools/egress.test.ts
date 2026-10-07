/**
 * The sealed-value egress guard scans the whole argument document (review 1, blocker 2):
 * depth and string count are not cut-offs that let a value through, and a document the scan
 * cannot finish is refused rather than passed.
 */
import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../../src/core/json.js";
import { egressRefusal, MAX_SCANNED_STRINGS, scanStrings } from "../../../src/core/tools/egress.js";
import type { ResourceGrant } from "../../../src/core/types.js";

const SEALED = new Map<string, readonly string[]>([["res-1", ["Alice.Example@Mail.Test"]]]);
const GRANT: ResourceGrant = { permission_id: "identity.passenger", resource_type: "personal.passenger_identity", resource_id: "res-1", resource_digest: "0".repeat(64) };
const UNGRANTED = "the arguments carry a value of a host resource this run was not granted";
const UNLINKED = "the arguments carry a granted host value to a tool that does not link the permission it was granted under";

function nested(depth: number, leaf: JsonValue): JsonValue {
  let value: JsonValue = leaf;
  for (let level = 0; level < depth; level += 1) value = level % 2 === 0 ? { inner: value } : [value];
  return value;
}

describe("scanStrings", () => {
  it("collects every string and key, lower-cased, whatever the shape", () => {
    expect(scanStrings({ A: ["B", { C: "D" }], e: 1, f: null, g: true })).toEqual(expect.arrayContaining(["a", "b", "c", "d", "e", "f", "g"]));
    expect(scanStrings("X")).toEqual(["x"]);
    expect(scanStrings(7)).toEqual([]);
  });

  it("walks 10,000 levels without a depth limit or a stack overflow, and refuses only above the string ceiling", () => {
    expect(scanStrings(nested(10_000, "deep"))).toContain("deep");
    expect(scanStrings(Array.from({ length: 5 }, () => "x"), 5)).toHaveLength(5);
    expect(scanStrings(Array.from({ length: 6 }, () => "x"), 5)).toBeNull();
    expect(scanStrings({ a: 1, b: 2, c: 3 }, 2)).toBeNull();
    expect(MAX_SCANNED_STRINGS).toBeGreaterThan(64 * 1024);
  });
});

describe("egressRefusal", () => {
  it("refuses a sealed value flat, 41 levels deep, after 5,000 padding strings, and as a key", () => {
    const email = "alice.example@mail.test";
    expect(egressRefusal({ note: `write to ${email}` }, [], [], SEALED)).toBe(UNGRANTED);
    expect(egressRefusal(nested(41, `contact: ${email}`), [], [], SEALED)).toBe(UNGRANTED);
    const padded = { pad: Array.from({ length: 5000 }, () => "x"), last: email };
    expect(JSON.stringify(padded).length).toBeLessThan(64 * 1024);
    expect(egressRefusal(padded, [], [], SEALED)).toBe(UNGRANTED);
    expect(egressRefusal({ [email]: 1 }, [], [], SEALED)).toBe(UNGRANTED);
    expect(egressRefusal(nested(200, { [email.toUpperCase()]: "x" }), [], [], SEALED)).toBe(UNGRANTED);
  });

  it("lets a granted value reach a tool that links the grant's permission, and nothing else", () => {
    const args = { message: "alice.example@mail.test" };
    expect(egressRefusal(args, [GRANT], ["identity.passenger"], SEALED)).toBeNull();
    expect(egressRefusal(args, [GRANT], ["network.webair"], SEALED)).toBe(UNLINKED);
    expect(egressRefusal({ message: "nobody here" }, [], [], SEALED)).toBeNull();
    expect(egressRefusal(args, [], [], new Map())).toBeNull();
  });

  it("a document the scan cannot finish is refused unread, never passed as clean", () => {
    const huge = { pad: Array.from({ length: MAX_SCANNED_STRINGS + 1 }, () => "x") };
    expect(egressRefusal(huge, [GRANT], ["identity.passenger"], SEALED)).toMatch(/refused unread/u);
  });
});
