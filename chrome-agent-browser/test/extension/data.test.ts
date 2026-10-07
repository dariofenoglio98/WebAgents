/**
 * The demo host's resource definitions the extension ships are a byte-for-byte copy of
 * `demo/webair/host-resources.json` (D-051): the same fictional types and records the
 * reference demo host holds, never a hand-maintained variant.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PROJECT, ROOT } from "../helpers/paths.js";

describe("the shipped demo host resources", () => {
  it("equal demo/webair/host-resources.json byte for byte", () => {
    const original = readFileSync(join(ROOT, "demo", "webair", "host-resources.json"));
    const copy = readFileSync(join(PROJECT, "src", "extension", "data", "demo-host-resources.json"));
    expect(copy.equals(original), "src/extension/data/demo-host-resources.json differs from demo/webair/host-resources.json").toBe(true);
    const parsed = JSON.parse(copy.toString("utf8")) as { schema: string; types: unknown[]; resources: Array<{ id: string }> };
    expect(parsed.schema).toBe("openclaw-host-resources-v0");
    expect(parsed.types).toHaveLength(3);
    expect(parsed.resources.map((resource) => resource.id)).toEqual(["profile_demo_traveler", "profile_demo_explorer", "passenger_demo_alex", "passenger_demo_sam", "payment_demo_visa", "payment_demo_travel"]);
  });
});
