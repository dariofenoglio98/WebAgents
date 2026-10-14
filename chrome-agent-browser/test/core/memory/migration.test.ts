/**
 * The vault migration (§11.3, M-66, D-221): the demo vault's six records become memory records of
 * the three mapped types with the legacy projections, the vault's timestamps and `demo` kept, a
 * report per record; an unknown vault type becomes a person-declared custom type.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { migrateVault } from "../../../src/core/memory/migration.js";
import { VAULT_SCHEMA, type VaultDocument } from "../../../src/core/vault.js";
import { demoHostResources } from "../../helpers/fixtures.js";
import { emptyStore, NOW, testIds } from "../../helpers/memory.js";

function demoVault(): VaultDocument {
  const demo = demoHostResources();
  return {
    schema: VAULT_SCHEMA,
    types: demo.types.map((type) => ({ id: type.id, display_name: type.display_name, description: type.description ?? null, permission_kind: type.permission_kind, schema: type.schema as unknown as JsonObject, sealed_fields: type.sealed_fields ?? [] })),
    records: demo.resources.map((resource) => ({ id: resource.id, type: resource.type, label: resource.label, value: resource.value as unknown as JsonObject, demo: true, created_at: "2026-10-07T10:00:00Z", updated_at: "2026-10-08T10:00:00Z" })),
  };
}

describe("migrateVault", () => {
  it("maps the three vault types through the legacy projections and keeps every fact", async () => {
    const store = await emptyStore({ newId: testIds(8) });
    const report = await migrateVault(store, demoVault(), { now: NOW });
    expect(report.failed).toBe(0);
    expect(report.total).toBe(6);
    expect(report.mappings).toEqual([
      { from_type: "personal.travel_profile", to_type: "travel.profile", kind: "legacy" },
      { from_type: "personal.passenger_identity", to_type: "person.identity", kind: "legacy" },
      { from_type: "wallet.payment_method", to_type: "payment.card", kind: "legacy" },
    ]);
    expect(report.counts).toEqual({ "travel.profile": 2, "person.identity": 2, "payment.card": 2 });
    const identity = store.all().find((record) => record.type === "person.identity" && record.title.startsWith("Alex Traveler"))!;
    expect(identity).toMatchObject({ scope: "user", demo: true, created: "2026-10-07T10:00:00Z", updated: "2026-10-08T10:00:00Z", source: { kind: "migration", from_type: "personal.passenger_identity", migrated: "2026-10-14T14:00:00Z" }, sealed: ["/email", "/phone", "/date_of_birth"], links: [{ to: "self", rel: "about" }] });
    expect(identity.fields).toEqual({ given_name: "Alex", family_name: "Traveler", email: "alex.traveler@example.com" });
    const card = store.all().find((record) => record.type === "payment.card" && record.title.includes("4242"))!;
    expect(card.fields).toEqual({ payment_method_id: "demo-visa-4242", display: "Demo Visa •••• 4242" });
    // The migrated records answer the legacy ids through the alias (M-17): the projection is the vault's value again.
    const grant = { permission_id: "identity.passenger", resource_type: "personal.passenger_identity", resource_id: identity.id, resource_digest: store.digestOf(identity.id)! };
    expect(store.resolve(grant)).toEqual({ given_name: "Alex", family_name: "Traveler", contact_email: "alex.traveler@example.com" });
    expect(store.tidy().demo.length).toBe(6);
  });

  it("an unknown vault type becomes a person-declared custom type and its records migrate unchanged; a record that fails is reported", async () => {
    const store = await emptyStore({ newId: testIds(8) });
    const vault = demoVault();
    vault.types.push({ id: "loyalty.card", display_name: "Loyalty card", description: null, permission_kind: "personal.read", schema: { type: "object", properties: { number: { type: "string", minLength: 6 }, airline: { type: "string" } }, required: ["number"], additionalProperties: false }, sealed_fields: ["/number"] });
    vault.records.push({ id: "loyalty_1", type: "loyalty.card", label: "Star miles", value: { number: "SM-123456", airline: "WebAir" }, demo: false, created_at: "2026-10-07T10:00:00Z", updated_at: "2026-10-07T10:00:00Z" });
    vault.records.push({ id: "loyalty_2", type: "loyalty.card", label: "Broken SM-654321", value: { number: "SM-654321" }, demo: false, created_at: "2026-10-07T10:00:00Z", updated_at: "2026-10-07T10:00:00Z" });
    const report = await migrateVault(store, vault, { now: NOW });
    expect(report.mappings.at(-1)).toEqual({ from_type: "loyalty.card", to_type: "loyalty.card", kind: "custom" });
    expect(store.types.get("loyalty.card")).toMatchObject({ declared_by: { kind: "person" }, sealed_fields: ["/number"] });
    const loyalty = store.all().find((record) => record.type === "loyalty.card")!;
    expect(loyalty.fields).toEqual({ number: "SM-123456", airline: "WebAir" });
    expect(report.items.find((item) => item.vault_id === "loyalty_2")!.outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("sealed value") });
    expect(report.failed).toBe(1);
  });
});
