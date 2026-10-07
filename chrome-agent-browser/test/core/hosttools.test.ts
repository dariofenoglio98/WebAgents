/**
 * Host tool bindings (`hosttools.py`) and the Chrome host's own registry (D-054): binding
 * digests and the registry hash equal the reference's for the same descriptors, every
 * declared WebAir tool binds, the evaluation and the plan's binding records equal the
 * reference's, and a local tool this host does not implement stays unbound with a note.
 */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/core/canonical.js";
import { sha256Hex } from "../../src/core/hash.js";
import {
  bindingDigest,
  BOUND,
  buildHostToolRegistry,
  CHROME_TOOL_REGISTRY_SOURCE,
  evaluateRegistry,
  HOST_RESOURCE_INPUT_SCHEMA,
  normalizeBinding,
  normalizeRegistry,
  planToolBindings,
  toolContract,
  toolRegistryReference,
  toolRequirementSet,
  UNBOUND,
} from "../../src/core/hosttools.js";
import type { JsonObject } from "../../src/core/json.js";
import { demoHostResources, fixture, inputs, literatureReview, webair040, without } from "../helpers/fixtures.js";

async function vaultTypes() {
  const out = [];
  for (const type of demoHostResources().types) {
    out.push({ id: type.id, display_name: type.display_name, permission_kind: type.permission_kind, schema_sha256: await sha256Hex(canonicalJson(type.schema)) });
  }
  return out;
}

describe("binding descriptors", () => {
  it("normalize and digest exactly as the reference (every binding_sha256 of the fixture evaluation)", async () => {
    const reference = fixture("tool_evaluation");
    const digests = new Map((reference.tools as JsonObject[]).map((tool) => [tool.tool_id, (tool.binding as JsonObject).binding_sha256]));
    for (const [index, raw] of (inputs().tool_registry.bindings as JsonObject[]).entries()) {
      const binding = await normalizeBinding(raw, index);
      expect(binding.binding_sha256).toBe(digests.get(binding.tool_id));
      expect(await bindingDigest(binding)).toBe(binding.binding_sha256);
    }
  });

  it("the registry hash equals the reference's", async () => {
    const registry = await normalizeRegistry(inputs().tool_registry);
    expect(toolRegistryReference(registry)).toEqual(fixture("tool_evaluation").registry);
    expect(registry.binding_count).toBe(7);
    expect(registry.available_binding_count).toBe(7);
  });

  it("refuse what the reference refuses: unknown fields, a local binding with an endpoint, a bad origin, a resource type on the wrong kind", async () => {
    const [remote, , local] = inputs().tool_registry.bindings as JsonObject[];
    const resource = (inputs().tool_registry.bindings as JsonObject[]).find((item) => item.implementation_kind === "host_resource")!;
    await expect(normalizeBinding({ ...remote, headers: { authorization: "x" } }, 0)).rejects.toMatchObject({ code: "unknown_field" });
    await expect(normalizeBinding({ ...remote, remote: false }, 0)).rejects.toThrow(/the two must agree/u);
    await expect(normalizeBinding({ ...remote, endpoint: { ...(remote.endpoint as JsonObject), origin: "http://webagents-webair-production.up.railway.app" } }, 0)).rejects.toThrow(/https origin on port 443/u);
    await expect(normalizeBinding({ ...remote, endpoint: { ...(remote.endpoint as JsonObject), path: "/api/../x" } }, 0)).rejects.toThrow(/absolute path/u);
    await expect(normalizeBinding({ ...remote, endpoint: { ...(remote.endpoint as JsonObject), method: "PUT" } }, 0)).rejects.toThrow(/GET or POST/u);
    await expect(normalizeBinding({ ...remote, resource_type: "personal.travel_profile" }, 0)).rejects.toThrow(/belongs to a host_resource binding only/u);
    await expect(normalizeBinding({ ...resource, endpoint: { origin: "https://a.example", path: "/", method: "GET" } }, 0)).rejects.toThrow(/absent for a local binding/u);
    await expect(normalizeBinding({ ...resource, resource_type: undefined }, 0)).rejects.toThrow(/resource_type must be a string/u);
    void local;
    // Liveness and presentation are not part of the digest; credentials.configured is.
    const base = await normalizeBinding(remote, 0);
    const renamed = await normalizeBinding({ ...remote, display_name: "renamed", available: false }, 0);
    expect(renamed.binding_sha256).toBe(base.binding_sha256);
    const credentialed = await normalizeBinding({ ...remote, credentials: { required: true, configured: true, source: "env" } }, 0);
    expect(credentialed.binding_sha256).not.toBe(base.binding_sha256);
  });
});

describe("the Chrome host registry (D-054)", () => {
  it("derives one HTTPS JSON binding per remote WebAir tool and one host-resource binding per vault type, hashing as the fixture registry", async () => {
    const pkg = await webair040();
    const registry = await buildHostToolRegistry(pkg, { resourceTypes: await vaultTypes(), runtimeVersion: "0.1.0", now: new Date("2026-10-06T12:00:00.000Z") });
    expect(registry.host.source).toBe(CHROME_TOOL_REGISTRY_SOURCE);
    expect(registry.notes).toEqual([]);
    expect(registry.bindings.map((binding) => [binding.tool_id, binding.implementation_kind])).toEqual([
      ["get-fare-rules", "json_http"],
      ["personal.passenger_identity", "host_resource"],
      ["personal.travel_profile", "host_resource"],
      ["prepare-booking", "json_http"],
      ["search-flights", "json_http"],
      ["simulate-purchase", "json_http"],
      ["wallet.payment_method", "host_resource"],
    ]);
    // The fixture registry was written by hand in Python to the same derivation rule; equal bytes, equal hash.
    expect(toolRegistryReference(registry)).toEqual(fixture("tool_evaluation").registry);
    const empty = await sha256Hex(canonicalJson(HOST_RESOURCE_INPUT_SCHEMA));
    for (const binding of registry.bindings.filter((item) => item.implementation_kind === "host_resource")) {
      expect(binding.contract.input_schema_sha256).toBe(empty);
      expect(binding.endpoint).toBeNull();
      expect(binding.resource_type).toBe(binding.tool_id);
    }
    for (const binding of registry.bindings.filter((item) => item.implementation_kind === "json_http")) {
      expect(binding.endpoint?.origin).toBe("https://webagents-webair-production.up.railway.app");
      expect(binding.credentials).toEqual({ required: false, configured: false, source: null });
    }
  });

  it("evaluates every WebAir tool as bound, exactly as the reference does, and freezes the same plan records", async () => {
    const pkg = await webair040();
    const registry = await buildHostToolRegistry(pkg, { resourceTypes: await vaultTypes(), runtimeVersion: "0.1.0", now: new Date("2026-10-06T12:00:00.000Z") });
    const evaluation = await evaluateRegistry(pkg, registry, { decisions: inputs().decisions, toolApprovals: inputs().tool_approvals, now: new Date("2026-10-06T12:00:00.000Z") });
    const reference = fixture("tool_evaluation");
    expect(without(evaluation, ["evaluated_at"])).toEqual(without(reference, ["evaluated_at"]));
    expect(evaluation.all_tools_bound).toBe(true);
    expect(evaluation.all_tools_usable).toBe(true);
    expect(planToolBindings(evaluation)).toEqual(fixture("run_plan").tool_bindings);
  });

  it("the requirement set and the contracts read the signed package only", async () => {
    const pkg = await webair040();
    const requirements = await toolRequirementSet(pkg);
    expect(requirements.tool_count).toBe(7);
    const search = await toolContract(pkg, "search-flights");
    expect(search).toMatchObject({
      remote: true,
      method: "POST",
      endpoint_origin: "https://webagents-webair-production.up.railway.app",
      endpoint_path: "/api/v1/search_flights",
      permission_ids: ["network.webair"],
      required_permission_ids: ["network.webair"],
      permission_kinds: ["network"],
      max_calls: 1,
    });
    expect(requirements.tools.find((tool) => tool.tool_id === "search-flights")?.nodes.length).toBeGreaterThan(0);
    await expect(toolContract(pkg, "ghost")).rejects.toThrow(/declares no tool named 'ghost'/u);
  });

  it("a declared tool with no implementation on this host stays unbound with a note (Literature Review's paper-reader)", async () => {
    const pkg = await literatureReview();
    const registry = await buildHostToolRegistry(pkg, { resourceTypes: await vaultTypes(), runtimeVersion: "0.1.0", now: new Date("2026-10-06T12:00:00.000Z") });
    expect(registry.bindings.map((binding) => binding.tool_id)).toEqual(["citation-resolver", "scholarly-search"]);
    expect(registry.bindings.find((binding) => binding.tool_id === "scholarly-search")?.endpoint).toEqual({ origin: "https://api.crossref.org", path: "/works", method: "GET" });
    expect(registry.notes).toEqual([{ code: "local_tool_unimplemented", detail: expect.stringContaining("paper-reader (paper.read)") }]);
    const evaluation = await evaluateRegistry(pkg, registry);
    expect(Object.fromEntries(evaluation.tools.map((tool) => [tool.tool_id, tool.status]))).toEqual({ "citation-resolver": BOUND, "scholarly-search": BOUND, "paper-reader": UNBOUND });
  });

  it("a declared endpoint the URL gate refuses leaves the tool unbound and says why; a vault without the type leaves a host-resource tool unbound", async () => {
    const pkg = await webair040();
    const hostile = { ...pkg, tools: { ...pkg.tools, "search-flights": { ...pkg.tools["search-flights"]!, endpoint: "https://127.0.0.1/api/v1/search_flights" } } };
    const registry = await buildHostToolRegistry(hostile, { resourceTypes: [], runtimeVersion: null });
    expect(registry.bindings.map((binding) => binding.tool_id)).toEqual(["get-fare-rules", "prepare-booking", "simulate-purchase"]);
    expect(registry.notes.map((note) => note.code).sort()).toEqual(["resource_type_unknown", "resource_type_unknown", "resource_type_unknown", "tool_endpoint_refused"]);
    expect(registry.notes.find((note) => note.code === "tool_endpoint_refused")?.detail).toMatch(/search-flights: Tool endpoint URLs must name a DNS host/u);
  });

  it("a binding whose endpoint lands outside the declared domains is incompatible, not bound", async () => {
    const pkg = await webair040();
    const moved = JSON.parse(JSON.stringify((inputs().tool_registry.bindings as JsonObject[]).find((binding) => binding.tool_id === "search-flights")!)) as JsonObject;
    (moved.endpoint as JsonObject).origin = "https://evil.example";
    const altered = await normalizeRegistry({ ...inputs().tool_registry, bindings: [moved] });
    const evaluation = await evaluateRegistry(pkg, altered);
    const search = evaluation.tools.find((tool) => tool.tool_id === "search-flights")!;
    expect(search.status).toBe("incompatible");
    expect(search.binding?.violated).toEqual(["endpoint_domain"]);
    expect(search.reason).toMatch(/endpoint_domain/u);
  });
});
