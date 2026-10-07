/**
 * Host-owned resources (`hostresources.py`): the registry normalizes and hashes as the
 * reference does, a permission requests a type only when the host offers it, every bad pick
 * is refused with its own code, and staleness is conservative.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import {
  AMBIGUOUS,
  EMPTY,
  evaluateResources,
  grantStaleness,
  grantsReport,
  KIND_MISMATCH,
  normalizeResourceRegistry,
  normalizeResourceSelections,
  OFFERED,
  resourceRegistryReference,
  resourceRequests,
  resourceToolBlockers,
  type ResourceRegistry,
} from "../../src/core/hostresources.js";
import type { JsonObject } from "../../src/core/json.js";
import type { Decision, ResourceGrant } from "../../src/core/types.js";
import { fixture, inputs, webair040, without } from "../helpers/fixtures.js";

function code(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof CoreError) return error.code;
    throw error;
  }
  return "accepted";
}

const DENIED_ALL: Record<string, Decision> = {};

describe("the host resource registry", () => {
  it("normalizes and hashes exactly as the reference (registry_sha256 of the fixture receipt)", async () => {
    const registry = await normalizeResourceRegistry(inputs().resource_registry);
    const receipt = fixture("receipt");
    expect(resourceRegistryReference(registry)).toEqual(receipt.resource_registry);
    expect(registry.type_count).toBe(3);
    expect(registry.resource_count).toBe(6);
  });

  it("carries ids, labels and digests and refuses anything else (test_a_registry_carries_ids_labels_and_digests_and_refuses_anything_else)", async () => {
    const raw = inputs().resource_registry;
    const bad = (mutate: (copy: JsonObject) => void) => {
      const copy = JSON.parse(JSON.stringify(raw)) as JsonObject;
      mutate(copy);
      return normalizeResourceRegistry(copy);
    };
    await expect(bad((copy) => ((copy.resources as JsonObject[])[0]!.value = { home_airport: "BOS" }))).rejects.toMatchObject({ code: "unknown_field" });
    await expect(bad((copy) => ((copy.resources as JsonObject[])[0]!.digest = "abc"))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(bad((copy) => ((copy.resources as JsonObject[])[0]!.type = "unknown.type"))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(bad((copy) => ((copy.types as JsonObject[])[0]!.permission_kind = "network"))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(bad((copy) => (copy.schema = "something-else"))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(bad((copy) => (copy.resources as JsonObject[]).push({ ...(copy.resources as JsonObject[])[0]! }))).rejects.toThrow(/duplicate ids/u);
  });

  it("a permission requests a type only when the host offers it, with the reference's statuses", async () => {
    const pkg = await webair040();
    const registry = await normalizeResourceRegistry(inputs().resource_registry);
    const requests = resourceRequests(pkg, registry);
    expect(requests.map((request) => [request.permission_id, request.status, request.options.length])).toEqual([
      ["profile.travel", OFFERED, 2],
      ["identity.passenger", OFFERED, 2],
      ["wallet.payment", OFFERED, 2],
    ]);
    expect(resourceRequests(pkg, null)).toEqual([]);
    // The reference's evaluation, field by field: the fixture was taken before authorization,
    // when every decision was still deny and nothing was picked.
    const before = evaluateResources(pkg, registry, { decisions: {}, grants: [] });
    // The control plane's route adds the session id to the module's evaluation.
    expect(before).toEqual(without(fixture("resource_evaluation"), ["session_id"]));
    const after = evaluateResources(pkg, registry, { decisions: inputs().decisions, grants: fixture<{ resource_grants: ResourceGrant[] }>("receipt").resource_grants });
    expect(after.requests.map((request) => [request.decision, request.selected_resource_id])).toEqual([
      ["session", "profile_demo_traveler"],
      ["session", "passenger_demo_alex"],
      ["session", "payment_demo_visa"],
    ]);
  });

  it("a host that holds no resource of a type says empty; kind mismatch and two types are refused by status", async () => {
    const pkg = await webair040();
    const raw = JSON.parse(JSON.stringify(inputs().resource_registry)) as JsonObject;
    raw.resources = (raw.resources as JsonObject[]).filter((item) => item.type !== "wallet.payment_method");
    const empty = await normalizeResourceRegistry(raw);
    expect(resourceRequests(pkg, empty).find((request) => request.permission_id === "wallet.payment")?.status).toBe(EMPTY);

    const mismatch = await normalizeResourceRegistry(raw);
    const relabel = { ...pkg, policy: { ...pkg.policy, permissions: (pkg.policy.permissions as JsonObject[]).map((permission) => (permission.id === "profile.travel" ? { ...permission, kind: "network" } : permission)) } };
    expect(resourceRequests(relabel, mismatch).find((request) => request.permission_id === "profile.travel")?.status).toBe(KIND_MISMATCH);
    const twoTypes = { ...pkg, policy: { ...pkg.policy, permissions: (pkg.policy.permissions as JsonObject[]).map((permission) => (permission.id === "profile.travel" ? { ...permission, resources: ["personal.travel_profile", "personal.passenger_identity"] } : permission)) } };
    expect(resourceRequests(twoTypes, mismatch).find((request) => request.permission_id === "profile.travel")?.status).toBe(AMBIGUOUS);
  });
});

describe("picks become grants", () => {
  it("a pick becomes a grant by id and digest only, sorted by permission (test_a_pick_becomes_a_grant_by_id_and_digest_only)", async () => {
    const pkg = await webair040();
    const registry = await normalizeResourceRegistry(inputs().resource_registry);
    const grants = normalizeResourceSelections(pkg, registry, inputs().decisions, inputs().resource_selections);
    expect(grants).toEqual(fixture<{ resource_grants: ResourceGrant[] }>("receipt").resource_grants);
    for (const grant of grants) expect(Object.keys(grant).sort()).toEqual(["permission_id", "resource_digest", "resource_id", "resource_type"]);
  });

  it("every bad pick is refused with its own code (test_every_bad_pick_is_refused_with_its_own_code)", async () => {
    const pkg = await webair040();
    const registry = await normalizeResourceRegistry(inputs().resource_registry);
    const granted = inputs().decisions;
    expect(code(() => normalizeResourceSelections(pkg, registry, granted, { "no.such": "x" }))).toBe("unknown_permission");
    expect(code(() => normalizeResourceSelections(pkg, registry, granted, { "network.webair": "profile_demo_traveler" }))).toBe("resource_not_requested");
    expect(code(() => normalizeResourceSelections(pkg, registry, { ...granted, "profile.travel": "deny" }, { ...inputs().resource_selections }))).toBe("resource_selection_denied");
    expect(code(() => normalizeResourceSelections(pkg, registry, granted, { ...inputs().resource_selections, "profile.travel": "passenger_demo_alex" }))).toBe("resource_unknown");
    expect(code(() => normalizeResourceSelections(pkg, registry, granted, { ...inputs().resource_selections, "profile.travel": "ghost" }))).toBe("resource_unknown");
    expect(code(() => normalizeResourceSelections(pkg, registry, granted, { "identity.passenger": "passenger_demo_alex", "wallet.payment": "payment_demo_visa" }))).toBe("resource_selection_required");
    expect(code(() => normalizeResourceSelections(pkg, registry, granted, { ...inputs().resource_selections, "profile.travel": 7 }))).toBe("invalid_request");
    expect(code(() => normalizeResourceSelections(pkg, registry, granted, "x"))).toBe("invalid_request");
  });

  it("a pick without a registry is refused; no picks and no registry is fine (test_a_pick_without_a_registry_is_refused)", async () => {
    const pkg = await webair040();
    expect(code(() => normalizeResourceSelections(pkg, null, DENIED_ALL, { "profile.travel": "x" }))).toBe("resource_registry_missing");
    expect(normalizeResourceSelections(pkg, null, DENIED_ALL, null)).toEqual([]);
  });
});

describe("staleness and readiness", () => {
  const grants = (): ResourceGrant[] => fixture<{ resource_grants: ResourceGrant[] }>("receipt").resource_grants;

  it("is conservative without a registry (test_staleness_is_conservative_without_a_registry)", () => {
    expect(grantStaleness(grants(), null).map((reason) => reason.code)).toEqual(["resource_registry_unknown"]);
    expect(grantStaleness([], null)).toEqual([]);
    expect(grantsReport(grants(), null)).toEqual({ granted: 3, current: false, evaluated: false, registry_sha256: null });
  });

  it("reports a removed, retyped and changed resource with its own code", async () => {
    const registry = await normalizeResourceRegistry(inputs().resource_registry);
    expect(grantStaleness(grants(), registry)).toEqual([]);
    const changed: ResourceRegistry = JSON.parse(JSON.stringify(registry));
    changed.resources = changed.resources.filter((item) => item.id !== "profile_demo_traveler");
    const visa = changed.resources.find((item) => item.id === "payment_demo_visa")!;
    visa.digest = "0".repeat(64);
    const alex = changed.resources.find((item) => item.id === "passenger_demo_alex")!;
    alex.type = "personal.travel_profile";
    // Grants are sorted by permission id, so the reasons follow that order.
    expect(grantStaleness(grants(), changed).map((reason) => [reason.code, reason.subject])).toEqual([
      ["resource_type_changed", "identity.passenger"],
      ["resource_removed", "profile.travel"],
      ["resource_changed", "wallet.payment"],
    ]);
    expect(grantsReport(grants(), changed)).toMatchObject({ granted: 3, current: false, evaluated: true, registry_sha256: registry.registry_sha256 });
  });

  it("a granted permission without a pick blocks a host-resource tool, unless the tool is denied (D-022)", () => {
    const tools = [
      { tool_id: "personal.travel_profile", permission_ids: ["profile.travel"], binding: { implementation_kind: "host_resource", resource_type: "personal.travel_profile" } },
      { tool_id: "search-flights", permission_ids: ["network.webair"], binding: { implementation_kind: "json_http" } },
    ];
    const receipt = { decisions: { "profile.travel": "session" as Decision, "network.webair": "session" as Decision }, resource_grants: [], tool_approvals: { "personal.travel_profile": true } };
    expect(resourceToolBlockers(tools, receipt).map((reason) => reason.code)).toEqual(["resource_not_selected"]);
    expect(resourceToolBlockers(tools, { ...receipt, tool_approvals: { "personal.travel_profile": false } }, { approvedOnly: true })).toEqual([]);
    expect(resourceToolBlockers(tools, { ...receipt, decisions: { "profile.travel": "deny" } })).toEqual([]);
    expect(resourceToolBlockers(null, receipt)).toEqual([]);
    expect(resourceToolBlockers(tools, { ...receipt, resource_grants: grants() })).toEqual([]);
  });

  it("the evaluation note and kinds match the reference", async () => {
    const evaluation = fixture("resource_evaluation");
    expect(without(evaluation, ["requests"])).toMatchObject({ schema: "agentpkg-host-resource-requests-v0", resource_permission_kinds: ["personal.read"] });
  });
});
