/**
 * The host resource store and the egress guard: the definitions document is validated as a
 * whole, digests are keyed and stable, sealed values are known to the guard, a grant resolves
 * only while id, type and digest all hold, and a sealed value travels only where its grant says.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { egressRefusal } from "../../../src/core/tools/egress.js";
import { MemoryResourceStore, type ResourceResolver } from "../../../src/core/tools/resources.js";
import { strings, Vault } from "../../../src/core/vault.js";
import { ROOT } from "../../helpers/paths.js";

const DOCUMENT = JSON.parse(readFileSync(join(ROOT, "demo", "webair", "host-resources.json"), "utf8")) as JsonObject;
const KEY = new Uint8Array(32).fill(3);

function clone(): JsonObject {
  return JSON.parse(JSON.stringify(DOCUMENT)) as JsonObject;
}

function passengerRecord(document: JsonObject = DOCUMENT): JsonObject {
  return (document.resources as JsonObject[]).find((resource) => resource.type === "personal.passenger_identity")!;
}

describe("MemoryResourceStore", () => {
  it("loads the WebAir demo definitions, exposes a value-free registry and keyed digests", async () => {
    const store = await MemoryResourceStore.load(DOCUMENT, { key: KEY });
    expect(store.size).toBeGreaterThan(0);
    const registry = store.registry();
    expect(registry.schema).toBe("agentpkg-host-resource-registry-v0");
    // Labels are display-safe by construction; no sealed value anywhere in the registry.
    for (const values of store.sealedValues().values()) for (const value of values) expect(JSON.stringify(registry)).not.toContain(value);
    const types = store.typeViews().map((type) => type.id);
    expect(types).toEqual(["personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"]);
    const again = await MemoryResourceStore.load(DOCUMENT, { key: KEY });
    const other = await MemoryResourceStore.load(DOCUMENT, { key: new Uint8Array(32).fill(4) });
    for (const resource of registry.resources as JsonObject[]) {
      expect(again.describe(String(resource.id))!.digest).toBe(resource.digest);
      expect(other.describe(String(resource.id))!.digest).not.toBe(resource.digest);
    }
  });

  it("resolves exactly the granted resource and refuses a changed or mistyped grant", async () => {
    const store = await MemoryResourceStore.load(DOCUMENT, { key: KEY });
    const view = store.describe(passengerRecord().id as string)!;
    const grant = { permission_id: "identity.passenger", resource_type: view.type, resource_id: view.id, resource_digest: view.digest };
    const value = store.resolve(grant);
    expect(typeof value.contact_email).toBe("string");
    value.contact_email = "mutated";
    expect(store.resolve(grant).contact_email).not.toBe("mutated");
    expect(() => store.resolve({ ...grant, resource_digest: "0".repeat(64) })).toThrow(/no longer the one/u);
    expect(() => store.resolve({ ...grant, resource_type: "wallet.payment_method" })).toThrow(/no longer the one/u);
    expect(() => store.resolve({ ...grant, resource_id: "missing" })).toThrow(/no longer the one/u);
  });

  const edits: Array<[string, (document: JsonObject) => void, RegExp]> = [
    ["an unknown schema", (d) => (d.schema = "other"), /schema must be/u],
    ["a resource of an undeclared type", (d) => ((d.resources as JsonObject[])[0]!.type = "unknown.type"), /names no declared type/u],
    ["a duplicate resource id", (d) => ((d.resources as JsonObject[])[1]!.id = (d.resources as JsonObject[])[0]!.id!), /duplicated/u],
    ["a sealed field that is too short", (d) => ((passengerRecord(d).value as JsonObject).contact_email = "a@b"), /at least 6 characters/u],
    ["a label that contains a sealed value", (d) => (passengerRecord(d).label = `Me ${(passengerRecord(d).value as JsonObject).contact_email}`), /must not contain a sealed value/u],
    ["an unknown resource field", (d) => ((d.resources as JsonObject[])[0]!.secret = "x"), /unknown field/u],
    ["a permission kind that is not a resource kind", (d) => ((d.types as JsonObject[])[0]!.permission_kind = "network"), /permission_kind must be one of/u],
  ];
  for (const [label, edit, pattern] of edits) {
    it(`refuses the whole document for ${label}`, async () => {
      const document = clone();
      edit(document);
      await expect(MemoryResourceStore.load(document, { key: KEY })).rejects.toThrow(pattern);
    });
  }
});

describe("the egress guard", () => {
  it("collects every string and key, lower-cased", () => {
    expect(strings({ A: ["X", { b: "Y" }], n: 1 })).toEqual(["a", "x", "b", "y", "n"]);
  });

  it("refuses a sealed value of an ungranted resource anywhere, and a granted one outside its permission", async () => {
    const store = await MemoryResourceStore.load(DOCUMENT, { key: KEY });
    const sealed = store.sealedValues();
    expect(sealed.size).toBeGreaterThan(0);
    const passenger = (DOCUMENT.resources as JsonObject[]).find((resource) => resource.type === "personal.passenger_identity")!;
    const email = (passenger.value as JsonObject).contact_email as string;
    const payment = (DOCUMENT.resources as JsonObject[]).find((resource) => resource.type === "wallet.payment_method")!;
    const paymentId = (payment.value as JsonObject).payment_method_id as string;
    const grants = [{ permission_id: "identity.passenger", resource_type: "personal.passenger_identity", resource_id: String(passenger.id), resource_digest: store.describe(String(passenger.id))!.digest }];
    // Not granted: nowhere.
    expect(egressRefusal({ note: `pay with ${paymentId.toUpperCase()}` }, grants, ["network.webair", "wallet.payment"], sealed)).toMatch(/not granted/u);
    // Granted, but the tool does not link the permission it was granted under.
    expect(egressRefusal({ contact: email }, grants, ["network.webair"], sealed)).toMatch(/does not link the permission/u);
    // Granted and linked: allowed.
    expect(egressRefusal({ contact: email }, grants, ["network.webair", "identity.passenger"], sealed)).toBeNull();
    // A key carrying the value is caught too; unsealed fields are ordinary data.
    expect(egressRefusal({ [email]: 1 }, grants, [], sealed)).toMatch(/does not link/u);
    expect(egressRefusal({ home_airport: "BOS", given_name: "Demo" }, [], [], sealed)).toBeNull();
    expect(egressRefusal({ contact: email }, [], [], new Map())).toBeNull();
  });

  it("the personal vault (T3) satisfies the resolver contract the broker depends on", async () => {
    const vault = await Vault.open(KEY, { types: [], records: [] });
    // Structural: `resolve`, `sealedValues` and `describe` have the shapes the broker calls (D-051).
    const resolver: ResourceResolver = vault;
    expect(resolver.sealedValues().size).toBe(0);
    expect(resolver.describe("missing")).toBeUndefined();
    expect(() => resolver.resolve({ permission_id: "p", resource_type: "t", resource_id: "missing", resource_digest: "0".repeat(64) })).toThrow();
  });
});
