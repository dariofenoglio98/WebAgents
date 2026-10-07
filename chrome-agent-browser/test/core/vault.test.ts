/**
 * The personal vault (D-051): the demo host's types and records load, digests are keyed
 * HMACs that move with a value or a type schema, sealed values are enforced, the registry
 * carries no value, and `resolve` returns only the exact granted record.
 */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/core/canonical.js";
import { sha256Hex } from "../../src/core/hash.js";
import type { JsonObject } from "../../src/core/json.js";
import { emptyVaultDocument, generateVaultKey, KEY_BYTES, Vault, VAULT_SCHEMA, validateVaultType } from "../../src/core/vault.js";
import { demoHostResources } from "../helpers/fixtures.js";

const KEY = new Uint8Array(KEY_BYTES).map((_, index) => index);
const NOW = new Date("2026-10-06T12:00:00.000Z");

function demoDocument() {
  const demo = demoHostResources();
  return {
    schema: VAULT_SCHEMA,
    types: demo.types.map((type) => ({ id: type.id, display_name: type.display_name, description: type.description ?? null, permission_kind: type.permission_kind, schema: type.schema, sealed_fields: type.sealed_fields ?? [] })),
    records: demo.resources.map((resource) => ({ id: resource.id, type: resource.type, label: resource.label, value: resource.value, demo: true })),
  };
}

describe("opening a vault", () => {
  it("loads the demo host's three types and six fictional records, all or nothing", async () => {
    const vault = await Vault.open(KEY, demoDocument());
    expect(vault.size).toBe(6);
    expect(vault.typeViews().map((type) => type.id)).toEqual(["personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"]);
    for (const type of vault.typeViews()) expect(type.schema_sha256).toBe(await sha256Hex(canonicalJson(type.schema)));
    expect(vault.recordViews().every((record) => record.demo)).toBe(true);
    const broken = demoDocument();
    (broken.records[0]!.value as JsonObject).home_airport = "boston";
    await expect(Vault.open(KEY, broken)).rejects.toMatchObject({ code: "vault_invalid" });
    await expect(Vault.open(new Uint8Array(8), demoDocument())).rejects.toThrow(/32 bytes/u);
    const empty = await Vault.open(KEY, emptyVaultDocument());
    expect(empty.size).toBe(0);
    expect((await empty.registry({ now: NOW })).types).toEqual([]);
  });

  it("refuses an unknown type, a label carrying a sealed value, a short sealed value and a duplicate id", async () => {
    const vault = await Vault.open(KEY, demoDocument());
    await expect(vault.putRecord({ id: "x", type: "personal.calendar", label: "Calendar", value: {} })).rejects.toThrow(/names no vault type/u);
    await expect(
      vault.putRecord({ id: "leak", type: "personal.passenger_identity", label: "Alex alex.traveler@example.com", value: { given_name: "Alex", family_name: "Traveler", contact_email: "alex.traveler@example.com" } }),
    ).rejects.toThrow(/must not contain a sealed value/u);
    await expect(vault.putRecord({ id: "short", type: "wallet.payment_method", label: "Short", value: { payment_method_id: "abc12", display: "x" } })).rejects.toThrow(/schema|sealed/u);
    // A type whose sealed field allows a short string: the vault's own minimum applies.
    await vault.putType({ id: "personal.pin", display_name: "PIN", permission_kind: "personal.read", schema: { type: "object", properties: { pin: { type: "string" } }, required: ["pin"], additionalProperties: false }, sealed_fields: ["/pin"] });
    await expect(vault.putRecord({ id: "pin1", type: "personal.pin", label: "PIN", value: { pin: "1234" } })).rejects.toThrow(/at least 6 characters/u);
    const doc = demoDocument();
    doc.records.push({ ...doc.records[0]! });
    await expect(Vault.open(KEY, doc)).rejects.toThrow(/duplicate id/u);
    expect(() => validateVaultType({ id: "t", display_name: "T", permission_kind: "network", schema: { type: "object" } })).toThrow(/permission_kind/u);
    expect(() => validateVaultType({ id: "t", display_name: "T", permission_kind: "personal.read", schema: { type: "object" }, sealed_fields: ["no-slash"] })).toThrow(/JSON Pointer/u);
  });
});

describe("digests", () => {
  it("are keyed: the same record under another key is another digest, and a digest never equals a plain SHA-256 of the value", async () => {
    const a = await Vault.open(KEY, demoDocument());
    const b = await Vault.open(generateVaultKey(), demoDocument());
    const [first] = a.recordViews();
    expect(first!.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(b.recordViews()[0]!.digest).not.toBe(first!.digest);
    expect(first!.digest).not.toBe(await sha256Hex(canonicalJson(first!.value)));
    // Stable for the same key and value.
    const again = await Vault.open(KEY, demoDocument());
    expect(again.recordViews()[0]!.digest).toBe(first!.digest);
  });

  it("move when the value changes or when the type's schema changes, so a plan that named the old one goes stale", async () => {
    const vault = await Vault.open(KEY, demoDocument());
    const before = vault.describe("profile_demo_traveler")!;
    await vault.putRecord({ id: "profile_demo_traveler", type: "personal.travel_profile", label: "Demo Traveler — JFK", value: { home_airport: "JFK", preferred_cabin: "economy", prefer_nonstop: true, preferred_currency: "USD" }, demo: true }, { now: NOW });
    const after = vault.describe("profile_demo_traveler")!;
    expect(after.digest).not.toBe(before.digest);
    expect(vault.recordViews().find((record) => record.id === "profile_demo_traveler")?.updated_at).toBe(NOW.toISOString());
    const type = vault.typeViews().find((item) => item.id === "personal.travel_profile")!;
    const widened = { ...type, schema: { ...type.schema, description: "widened" } };
    await vault.putType(widened);
    expect(vault.describe("profile_demo_traveler")!.digest).not.toBe(after.digest);
    expect(vault.describe("passenger_demo_alex")!.digest).toBe((await Vault.open(KEY, demoDocument())).describe("passenger_demo_alex")!.digest);
  });

  it("a type replacement that one of its records fails changes nothing, not even the records it re-digested first (review 1, nit 13)", async () => {
    const vault = await Vault.open(KEY, demoDocument());
    const type = vault.typeViews().find((item) => item.id === "personal.travel_profile")!;
    const before = { traveler: vault.describe("profile_demo_traveler")!.digest, explorer: vault.describe("profile_demo_explorer")!.digest, type: type.schema_sha256 };
    // BOS only: the traveler (BOS, first) re-validates, the explorer (JFK) does not.
    const narrowed = { ...type, schema: { ...type.schema, properties: { ...(type.schema.properties as JsonObject), home_airport: { type: "string", enum: ["BOS"] } } } };
    await expect(vault.putType(narrowed)).rejects.toThrow(/does not match the Travel profile schema/u);
    expect({ traveler: vault.describe("profile_demo_traveler")!.digest, explorer: vault.describe("profile_demo_explorer")!.digest, type: vault.typeViews().find((item) => item.id === "personal.travel_profile")!.schema_sha256 }).toEqual(before);
  });
});

describe("the registry and resolution", () => {
  it("the registry carries ids, labels and digests and never a value, and normalizes as a host resource registry", async () => {
    const vault = await Vault.open(KEY, demoDocument());
    const registry = await vault.registry({ runtimeVersion: "0.1.0", now: NOW });
    expect(registry.schema).toBe("agentpkg-host-resource-registry-v0");
    expect(registry.host).toMatchObject({ runtime: "chrome-agent-browser", runtime_version: "0.1.0", captured_at: NOW.toISOString() });
    expect(registry.type_count).toBe(3);
    expect(registry.resource_count).toBe(6);
    const text = JSON.stringify(registry);
    expect(text).not.toContain("alex.traveler@example.com");
    expect(text).not.toContain("demo-visa-4242");
    expect(text).not.toContain("\"value\"");
    expect(registry.resources.find((item) => item.id === "payment_demo_visa")).toEqual({ id: "payment_demo_visa", type: "wallet.payment_method", label: "Demo Visa •••• 4242", digest: vault.describe("payment_demo_visa")!.digest });
  });

  it("resolve returns exactly the granted record and refuses a removed, retyped or changed one", async () => {
    const vault = await Vault.open(KEY, demoDocument());
    const visa = vault.describe("payment_demo_visa")!;
    const grant = { permission_id: "wallet.payment", resource_type: "wallet.payment_method", resource_id: "payment_demo_visa", resource_digest: visa.digest };
    expect(vault.resolve(grant)).toEqual({ payment_method_id: "demo-visa-4242", display: "Demo Visa •••• 4242" });
    expect(() => vault.resolve({ ...grant, resource_type: "personal.travel_profile" })).toThrow(/no longer the one that was granted/u);
    expect(() => vault.resolve({ ...grant, resource_digest: "0".repeat(64) })).toThrow(/no longer the one that was granted/u);
    await vault.putRecord({ id: "payment_demo_visa", type: "wallet.payment_method", label: "Demo Visa •••• 4242", value: { payment_method_id: "demo-visa-9999", display: "Demo Visa •••• 4242" }, demo: true });
    expect(() => vault.resolve(grant)).toThrow(/no longer the one that was granted/u);
    expect(vault.deleteRecord("payment_demo_visa")).toBe(true);
    expect(vault.describe("payment_demo_visa")).toBeUndefined();
    expect(vault.sealedValues().get("passenger_demo_alex")).toEqual(["alex.traveler@example.com"]);
    expect(() => vault.deleteType("personal.passenger_identity")).toThrow(/still has records/u);
  });

  it("round-trips through its document without the key or the digests", async () => {
    const vault = await Vault.open(KEY, demoDocument());
    const document = vault.toDocument();
    expect(JSON.stringify(document)).not.toContain("digest");
    expect(document.records).toHaveLength(6);
    const reopened = await Vault.open(KEY, document);
    expect(reopened.recordViews().map((record) => record.digest)).toEqual(vault.recordViews().map((record) => record.digest));
  });
});
