import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { loadPackageBytes, type Package } from "../../src/core/package.js";
import { PROFILES_EXTENSION_KEY, readProfiles } from "../../src/core/profiles.js";
import { extensionSchemaFailure } from "../../src/core/schema.js";
import { readBytes, SHIPPED } from "../helpers/paths.js";

/**
 * WebAir 0.4.0's declared profiles (D-042), as signed in T2. WebAir 0.3.0 declares the same
 * permissions and tools, so the value is grafted onto its manifest here until 0.4.0 is on main.
 */
const WEBAIR_PROFILES: JsonObject = {
  profiles: [
    {
      id: "search",
      title: "Search flights",
      description: "Search WebAir flights and read their fare rules. Nothing personal is read or sent, so say where you fly from in the request.",
      permissions: ["network.webair", "model.reasoning", "memory.session"],
      tools: ["search-flights", "get-fare-rules"],
      resources: [],
      estimate: { model_calls: 3, tool_calls: 4, tokens: 12000, notes: "From the publisher's recorded runs of the same graph; tokens vary with the model." },
    },
    {
      id: "quote",
      title: "Search and quote",
      description: "Also fills an unstated home airport or cabin from your travel profile, and sends your passenger identity to WebAir only to quote one fare.",
      permissions: ["network.webair", "profile.travel", "identity.passenger", "model.reasoning", "memory.session"],
      tools: ["search-flights", "get-fare-rules", "prepare-booking", "personal.travel_profile", "personal.passenger_identity"],
      resources: ["personal.travel_profile", "personal.passenger_identity"],
      estimate: { model_calls: 3, tool_calls: 9, tokens: 12000 },
    },
    {
      id: "book",
      title: "Book (simulated)",
      description: "Also simulates purchasing one exact quote with the demo payment method you choose, in a separate run. Fictional: nothing is ever charged or booked.",
      permissions: ["network.webair", "profile.travel", "identity.passenger", "wallet.payment", "booking.simulate_purchase", "model.reasoning", "memory.session"],
      tools: ["search-flights", "get-fare-rules", "prepare-booking", "simulate-purchase", "personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"],
      resources: ["personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"],
      estimate: { model_calls: 3, tool_calls: 9, tokens: 12000 },
    },
  ],
};

async function webair(): Promise<Package> {
  return loadPackageBytes(readBytes(SHIPPED.webair.archive));
}

function withProfiles(pkg: Package, value: JsonValue): Package {
  return { ...pkg, manifest: { ...pkg.manifest, extensions: { ...(pkg.manifest.extensions as JsonObject), [PROFILES_EXTENSION_KEY]: value } } };
}

function mutated(mutate: (value: JsonObject) => void): JsonValue {
  const copy = JSON.parse(JSON.stringify(WEBAIR_PROFILES)) as JsonObject;
  mutate(copy);
  return copy;
}

describe("publisher-declared profiles (spec/extensions/profiles-v0.md)", () => {
  it("a package without the extension declares no profiles", async () => {
    const report = readProfiles(await webair());
    expect(report).toEqual({ declared: false, profiles: null, notes: [] });
  });

  it("WebAir's three profiles pass the shape and the seven consistency rules", async () => {
    const report = readProfiles(withProfiles(await webair(), WEBAIR_PROFILES));
    expect(report.declared).toBe(true);
    expect(report.notes).toEqual([]);
    expect(report.profiles?.map((profile) => profile.id)).toEqual(["search", "quote", "book"]);
    expect(report.profiles?.[0]?.resources).toEqual([]);
    expect(report.profiles?.[2]?.estimate).toEqual({ model_calls: 3, tool_calls: 9, tokens: 12000 });
    expect(report.profiles?.[0]?.estimate?.notes).toMatch(/recorded runs/u);
  });

  const violations: Array<[string, (value: JsonObject) => void, RegExp]> = [
    ["rule 1: undeclared permission", (v) => ((v.profiles as JsonObject[])[0]!.permissions as string[]).push("network.other"), /undeclared permission/u],
    ["rule 1: undeclared tool", (v) => ((v.profiles as JsonObject[])[0]!.tools as string[]).push("teleport"), /undeclared tool/u],
    ["rule 1: a tool named after an Object.prototype member (review 1, finding 5)", (v) => ((v.profiles as JsonObject[])[0]!.tools as string[]).push("toString"), /undeclared tool "toString"/u],
    ["rule 1: a permission named constructor", (v) => ((v.profiles as JsonObject[])[0]!.permissions as string[]).push("constructor"), /undeclared permission/u],
    ["rule 1: undeclared resource type", (v) => ((v.profiles as JsonObject[])[2]!.resources as string[]).push("personal.other"), /undeclared resource type/u],
    ["rule 2: required permission missing", (v) => ((v.profiles as JsonObject[])[0]!.permissions = ["model.reasoning", "memory.session"]), /required permission/u],
    ["rule 3: tool without its permission", (v) => ((v.profiles as JsonObject[])[0]!.tools as string[]).push("prepare-booking"), /needs permission/u],
    ["rule 4: resource listed without its permission", (v) => ((v.profiles as JsonObject[])[0]!.resources as string[]).push("personal.travel_profile"), /resources must be exactly/u],
    ["rule 4: permission without its resource", (v) => ((v.profiles as JsonObject[])[1]!.resources = ["personal.travel_profile"]), /resources must be exactly/u],
    ["rule 5: first profile not least", (v) => (v.profiles as JsonObject[]).reverse(), /least authority first/u],
    ["rule 6: tokens above hard_tokens", (v) => (((v.profiles as JsonObject[])[0]!.estimate as JsonObject).tokens = 120001), /exceeds hard_tokens/u],
    ["rule 6: tool calls above the tools' budgets", (v) => (((v.profiles as JsonObject[])[0]!.estimate as JsonObject).tool_calls = 8), /exceeds the tools' call budgets/u],
    ["rule 7: duplicate ids", (v) => ((v.profiles as JsonObject[])[1]!.id = "search"), /duplicate id/u],
    ["shape: unknown top-level field", (v) => (v.extra = 1), /unknown field/u],
    ["shape: too many profiles", (v) => (v.profiles = Array.from({ length: 9 }, (_, i) => ({ ...(v.profiles as JsonObject[])[0]!, id: `p${i}` }))), /1 to 8 profiles/u],
    ["shape: no profiles", (v) => (v.profiles = []), /1 to 8 profiles/u],
    ["shape: title too long", (v) => ((v.profiles as JsonObject[])[0]!.title = "x".repeat(61)), /title must be one line of at most 60/u],
    ["shape: newline in description", (v) => ((v.profiles as JsonObject[])[0]!.description = "two\nlines"), /description must be one line/u],
    ["shape: unknown profile field", (v) => ((v.profiles as JsonObject[])[0]!.cost_usd = 1), /unknown field "cost_usd"/u],
    ["shape: missing resources", (v) => delete (v.profiles as JsonObject[])[0]!.resources, /resources is required/u],
    ["shape: repeated identifier", (v) => ((v.profiles as JsonObject[])[0]!.tools as string[]).push("search-flights"), /repeats/u],
    ["shape: empty estimate", (v) => ((v.profiles as JsonObject[])[0]!.estimate = {}), /at least one field/u],
    ["shape: estimate with unknown field", (v) => (((v.profiles as JsonObject[])[0]!.estimate as JsonObject).cost = 1), /estimate has unknown field/u],
    ["shape: negative estimate", (v) => (((v.profiles as JsonObject[])[0]!.estimate as JsonObject).tokens = -1), /must be an integer between/u],
    ["shape: fractional estimate", (v) => (((v.profiles as JsonObject[])[0]!.estimate as JsonObject).model_calls = 1.5), /must be an integer between/u],
    ["shape: invalid id", (v) => ((v.profiles as JsonObject[])[0]!.id = "1bad"), /id must be an identifier/u],
  ];
  it("the copied profiles-v0 schema (D-040) accepts the shipped value and refuses every shape violation the shape check refuses", async () => {
    expect(await extensionSchemaFailure(WEBAIR_PROFILES, "profiles-v0")).toBeNull();
    const shipped = (await loadPackageBytes(readBytes(SHIPPED.webair040.archive))).manifest.extensions as JsonObject;
    expect(await extensionSchemaFailure(shipped[PROFILES_EXTENSION_KEY], "profiles-v0")).toBeNull();
    for (const [label, mutate] of violations.filter(([name]) => name.startsWith("shape:"))) {
      const failure = await extensionSchemaFailure(mutated(mutate), "profiles-v0");
      expect(failure, `${label} should fail the schema`).not.toBeNull();
    }
    // The consistency rules (§4) are beyond the schema: the shape check alone catches them.
    expect(await extensionSchemaFailure(mutated(violations.find(([name]) => name.startsWith("rule 7"))![1]), "profiles-v0")).toBeNull();
  });

  for (const [label, mutate, pattern] of violations) {
    it(`ignores the whole value for ${label}`, async () => {
      const report = readProfiles(withProfiles(await webair(), mutated(mutate)));
      expect(report.declared).toBe(true);
      expect(report.profiles).toBeNull();
      expect(report.notes).toHaveLength(1);
      expect(report.notes[0]).toMatch(/ignored as a whole/u);
      expect(report.notes[0]).toMatch(pattern);
    });
  }

  it("ignores non-object values and never applies part of a value", async () => {
    for (const value of ["profiles", 1, null, [], { profiles: "x" }, { profiles: [1] }] as JsonValue[]) {
      const report = readProfiles(withProfiles(await webair(), value));
      expect(report.profiles).toBeNull();
      expect(report.declared).toBe(true);
    }
  });
});
