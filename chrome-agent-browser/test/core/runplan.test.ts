/**
 * Run plans (`runplan.py`): the plan equals the reference's for the fixture inputs except the
 * documented Chrome fields, the plan hash is computed as the reference computes it, every
 * blocker has its code, every staleness code is reported, `once` is spent by a run, and the
 * D-022 rule holds: a denied tool blocks nothing while an approved unbound tool blocks.
 */
import { describe, expect, it } from "vitest";

import { evaluateCatalog, normalizeCatalog, type HostCatalog } from "../../src/core/compatibility.js";
import type { EvaluationLayers, PublisherReport } from "../../src/core/evaluation.js";
import { normalizeResourceRegistry, normalizeResourceSelections, type ResourceRegistry } from "../../src/core/hostresources.js";
import { buildHostToolRegistry, evaluateRegistry, normalizeRegistry, type RegistryEvaluation, type ToolRegistry } from "../../src/core/hosttools.js";
import type { JsonObject } from "../../src/core/json.js";
import { buildReceipt } from "../../src/core/authorization.js";
import {
  buildRunPlan,
  deniedToolIds,
  grantsOnce,
  MODE_MODEL,
  MODE_TOOL_PROBE,
  modePermissionIds,
  preflight,
  preparationBlockers,
  toolBlockers,
  validateBinding,
  validateMode,
  type RunPlanInputs,
} from "../../src/core/runplan.js";
import { DEFAULT_BROWSER_POLICY, hashRunPlan, recordHashValid, type AuthorizationReceipt, type BrowserPolicy, type RunPlan } from "../../src/core/types.js";
import { fixture, inputs, webair040, without } from "../helpers/fixtures.js";
import { NOW, world, type World } from "../helpers/world.js";

/** Fields the Chrome plan adds or names differently (D-053), or that carry a timestamp the reference formats differently. */
// `execution.conversation` is conversation.v0's section (D-270); the reference plan has none (D-264).
const CHROME_ONLY = ["control_plane.service", "authorization.provenance", "authorization.receipt_sha256", "authorization.issued_at", "execution.denied_tool_ids", "execution.note", "execution.conversation", "run_plan_sha256", "created_at", "model_binding.selected_at", "model_requirements"];

describe("the plan", () => {
  it("equals the reference's for the same inputs, except the documented Chrome fields, and hashes as the reference hashes", async () => {
    const { plan, receipt } = await world();
    const reference = fixture<RunPlan>("run_plan");
    expect(without(plan, CHROME_ONLY)).toEqual(without(reference, CHROME_ONLY));
    // The receipt hash differs only because the Chrome receipt carries the service name and provenance (checked in authorization.test.ts).
    expect(plan.authorization.receipt_sha256).toBe(receipt.receipt_sha256);
    expect(plan.model_requirements).toEqual(reference.model_requirements);
    expect(new Date(plan.created_at).getTime()).toBe(new Date(reference.created_at).getTime());
    expect(await hashRunPlan(reference)).toBe(reference.run_plan_sha256);
    expect(await recordHashValid(plan, "run_plan_sha256")).toBe(true);
    expect(plan.readiness).toEqual({ state: "ready", ready: true, compatibility_status: "compatible", blocking_reasons: [] });
    expect(plan.execution.denied_tool_ids).toEqual([]);
    expect(plan.tool_bindings).toHaveLength(7);
    expect(plan.model_binding?.host_model_id).toBe("ollama/qwen3:30b");
  });

  it("is deterministic over canonical contents and contains no secret or host-internal field (test_the_plan_hash_is_deterministic_over_canonical_contents)", async () => {
    const { plan, planInputs } = await world();
    const again = await buildRunPlan(await webair040(), planInputs);
    expect(again.run_plan_sha256).toBe(plan.run_plan_sha256);
    const text = JSON.stringify(plan).toLowerCase();
    for (const forbidden of ["api_key", "apikey", "authorization:", "bearer", "credential_value", "password", "secret"]) expect(text).not.toContain(forbidden);
    expect(text).not.toContain("alex.traveler@example.com"); // no resource value, only ids and digests
  });

  it("validates the mode and the binding strategy as the reference does", async () => {
    const pkg = await webair040();
    expect(validateMode("model")).toBe("model");
    expect(() => validateMode("fixture")).toThrow(/execution_mode must be one of \['model', 'tool_probe'\]; got 'fixture'/u);
    expect(() => validateBinding("per_node")).toThrow(/binding_strategy must be one of \['single_model'\]/u);
    expect(modePermissionIds(pkg, MODE_MODEL)).toEqual(["model.reasoning"]);
    expect(modePermissionIds(pkg, MODE_TOOL_PROBE)).toEqual([]);
  });
});

describe("preparation blockers", () => {
  it("a denied model permission blocks a model-backed run even though the package itself may not require it (test_model_execution_requires_the_model_permission_even_when_optional)", async () => {
    const pkg = await webair040();
    const w = await world({ decisions: { ...inputs().decisions, "model.reasoning": "deny" } });
    const blockers = preparationBlockers(pkg, { mode: MODE_MODEL, evaluation: w.planInputs.evaluation, receipt: w.receipt, publisher: w.publisher, compatibility: w.planInputs.compatibility, policy: w.policy, toolEvaluation: w.toolEvaluation, resourceRegistry: w.resourceRegistry });
    expect(blockers.map((reason) => reason.code)).toContain("execution_mode_permission_denied");
    expect(blockers.map((reason) => reason.code)).toContain("authorization_not_runnable"); // model.reasoning is also required by WebAir
  });

  it("an incompatible, unavailable, unverified or unselected model blocks, each with its code", async () => {
    const pkg = await webair040();
    const w = await world();
    const base = { mode: MODE_MODEL as typeof MODE_MODEL, evaluation: w.planInputs.evaluation, receipt: w.receipt, publisher: w.publisher, policy: w.policy, toolEvaluation: w.toolEvaluation, resourceRegistry: w.resourceRegistry };
    const compat = w.planInputs.compatibility!;
    expect(preparationBlockers(pkg, { ...base, compatibility: null }).map((reason) => reason.code)).toEqual(["model_not_selected"]);
    expect(preparationBlockers(pkg, { ...base, compatibility: { ...compat, status: "incompatible" } }).map((reason) => reason.code)).toEqual(["model_incompatible"]);
    expect(preparationBlockers(pkg, { ...base, compatibility: { ...compat, available: false } }).map((reason) => reason.code)).toEqual(["model_unavailable"]);
    expect(preparationBlockers(pkg, { ...base, compatibility: { ...compat, selectable: false } }).map((reason) => reason.code)).toEqual(["model_not_selectable"]);
    const unverified = { ...compat, status: "unverified" as const, unknown: ["context_tokens:minimum"] };
    expect(preparationBlockers(pkg, { ...base, compatibility: unverified }).map((reason) => reason.code)).toEqual(["model_compatibility_unverified"]);
    expect(preparationBlockers(pkg, { ...base, compatibility: unverified, policy: { ...w.policy, require_confirmed_model_compatibility: false } })).toEqual([]);
  });

  it("an untrusted publisher, a missing receipt and a receipt for other bytes block", async () => {
    const pkg = await webair040();
    const w = await world();
    const base = { mode: MODE_MODEL as typeof MODE_MODEL, evaluation: w.planInputs.evaluation, receipt: w.receipt, publisher: w.publisher, compatibility: w.planInputs.compatibility, policy: w.policy, toolEvaluation: w.toolEvaluation, resourceRegistry: w.resourceRegistry };
    expect(preparationBlockers(pkg, { ...base, receipt: null }).map((reason) => reason.code)).toEqual(["authorization_missing"]);
    expect(preparationBlockers(pkg, { ...base, publisher: { ...w.publisher, trust_status: "unknown" } }).map((reason) => reason.code)).toEqual(["publisher_not_trusted"]);
    expect(preparationBlockers(pkg, { ...base, receipt: { ...w.receipt, package: { ...w.receipt.package, digest: "0".repeat(64) } } }).map((reason) => reason.code)).toContain("authorization_package_mismatch");
  });

  it("D-022: a denied tool blocks nothing and is listed as denied; an approved tool without an implementation blocks", async () => {
    const pkg = await webair040();
    // The search profile: booking tools denied.
    const approvals = { ...inputs().tool_approvals, "prepare-booking": false, "simulate-purchase": false, "personal.travel_profile": false, "personal.passenger_identity": false, "wallet.payment_method": false };
    const w = await world({ approvals });
    expect(toolBlockers(w.toolEvaluation, { receipt: w.receipt, policy: w.policy })).toEqual([]);
    expect(w.plan.readiness.ready).toBe(true);
    expect(w.plan.execution.required_tool_ids).toEqual(["get-fare-rules", "search-flights"]);
    expect(w.plan.execution.denied_tool_ids).toEqual(["personal.passenger_identity", "personal.travel_profile", "prepare-booking", "simulate-purchase", "wallet.payment_method"]);
    expect(w.plan.tool_bindings.map((binding) => binding.tool_id)).toEqual(["get-fare-rules", "search-flights"]);
    expect(deniedToolIds(pkg, approvals)).toEqual(w.plan.execution.denied_tool_ids);

    // An approved tool this host does not implement blocks, as in the reference.
    const registry = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: null, now: NOW });
    const evaluation = await evaluateRegistry(pkg, registry, { decisions: inputs().decisions, toolApprovals: inputs().tool_approvals });
    const full = await world();
    const blockers = toolBlockers(evaluation, { receipt: full.receipt, policy: full.policy });
    expect(blockers.map((reason) => [reason.code, reason.subject])).toEqual([
      ["tool_not_bound", "personal.passenger_identity"],
      ["tool_not_bound", "personal.travel_profile"],
      ["tool_not_bound", "wallet.payment_method"],
    ]);
    expect(toolBlockers(null, { receipt: full.receipt, policy: full.policy }).map((reason) => reason.code)).toEqual(["tool_registry_missing"]);
    // An approved tool whose required permission is denied blocks; an unverified contract blocks under the default policy.
    const deniedNetwork = await world({ decisions: { ...inputs().decisions, "network.webair": "deny" } });
    expect(toolBlockers(deniedNetwork.toolEvaluation, { receipt: deniedNetwork.receipt, policy: deniedNetwork.policy }).map((reason) => reason.code)).toContain("tool_permission_denied");
  });

  it("a granted host-resource permission without a pick blocks (resource_not_selected), a changed resource blocks at preparation", async () => {
    const pkg = await webair040();
    const w = await world();
    const noPick = { ...w.receipt, resource_grants: w.receipt.resource_grants.filter((grant) => grant.permission_id !== "profile.travel") };
    const blockers = preparationBlockers(pkg, { mode: MODE_MODEL, evaluation: w.planInputs.evaluation, receipt: noPick, publisher: w.publisher, compatibility: w.planInputs.compatibility, policy: w.policy, toolEvaluation: w.toolEvaluation, resourceRegistry: w.resourceRegistry });
    expect(blockers.map((reason) => [reason.code, reason.subject])).toEqual([["resource_not_selected", "personal.travel_profile"]]);
    const changed: ResourceRegistry = JSON.parse(JSON.stringify(w.resourceRegistry));
    changed.resources.find((item) => item.id === "payment_demo_visa")!.digest = "1".repeat(64);
    const stale = preparationBlockers(pkg, { mode: MODE_MODEL, evaluation: w.planInputs.evaluation, receipt: w.receipt, publisher: w.publisher, compatibility: w.planInputs.compatibility, policy: w.policy, toolEvaluation: w.toolEvaluation, resourceRegistry: changed });
    expect(stale.map((reason) => reason.code)).toEqual(["resource_changed"]);
  });

  it("a tool probe binds one tool and no model, and asks nothing about the other tools", async () => {
    const pkg = await webair040();
    const w = await world();
    const registry = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: null, now: NOW });
    const evaluation = await evaluateRegistry(pkg, registry, { decisions: inputs().decisions, toolApprovals: inputs().tool_approvals });
    const blockers = preparationBlockers(pkg, { mode: MODE_TOOL_PROBE, evaluation: w.planInputs.evaluation, receipt: w.receipt, publisher: w.publisher, compatibility: null, policy: w.policy, toolEvaluation: evaluation, probeToolId: "search-flights", resourceRegistry: w.resourceRegistry });
    expect(blockers).toEqual([]);
    const plan = await buildRunPlan(pkg, { ...w.planInputs, mode: MODE_TOOL_PROBE, descriptor: null, compatibility: null, toolEvaluation: evaluation, toolRegistry: registry, probeToolId: "search-flights", blockingReasons: blockers });
    expect(plan.model_binding).toBeNull();
    expect(plan.execution).toMatchObject({ mode: "tool_probe", probe_tool_id: "search-flights", required_tool_ids: ["search-flights"], tool_binding_count: 1, required_permission_ids: [] });
    expect(plan.execution.note).toMatch(/ONE mediated call/u);
    expect(preparationBlockers(pkg, { mode: MODE_TOOL_PROBE, evaluation: w.planInputs.evaluation, receipt: w.receipt, publisher: w.publisher, compatibility: null, policy: w.policy, toolEvaluation: evaluation, probeToolId: "ghost", resourceRegistry: w.resourceRegistry }).map((reason) => reason.code)).toEqual(["tool_not_declared"]);
  });
});

describe("preflight: the plan is frozen, readiness is not", () => {
  function check(w: World, overrides: Partial<Parameters<typeof preflight>[1]> = {}, pkg = w.planInputs as unknown as { digest: string }) {
    void pkg;
    return preflight(w.plan, {
      pkg: { digest: w.plan.package.digest } as never,
      publisher: w.publisher,
      receipt: w.receipt,
      trustState: inputs().session.trust_state,
      policy: w.policy,
      toolEvaluation: w.toolEvaluation,
      resourceRegistry: w.resourceRegistry,
      catalog: w.catalog,
      now: NOW,
      ...overrides,
    });
  }

  it("a fresh plan reports ready and matches the reference's preflight shape", async () => {
    const w = await world();
    const result = check(w);
    expect(result).toMatchObject({ state: "ready", ready: true, stale: false, stale_reasons: [], trust_store_changed: false, model_still_available: true });
    expect(result.tool_bindings).toEqual({ bound: 7, current: true, evaluated: true, registry_sha256: w.toolRegistry.registry_sha256, registry_changed: false });
    expect(result.resource_grants).toEqual({ granted: 3, current: true, evaluated: true, registry_sha256: w.resourceRegistry.registry_sha256 });
    const reference = fixture("preflight");
    expect(Object.keys(result).sort()).toEqual([...Object.keys(reference), "model_still_available"].sort());
  });

  it("reports every staleness code", async () => {
    const w = await world();
    const codes = (result: ReturnType<typeof preflight>) => result.stale_reasons.map((reason) => reason.code);
    expect(codes(check(w, { pkg: { digest: "0".repeat(64) } as never }))).toEqual(["package_changed"]);
    expect(codes(check(w, { receipt: null }))).toEqual(["authorization_cleared"]);
    expect(codes(check(w, { receipt: { ...w.receipt, receipt_id: "other" } }))).toEqual(["authorization_superseded"]);
    expect(codes(check(w, { receipt: { ...w.receipt, receipt_sha256: "0".repeat(64) } }))).toEqual(["authorization_changed"]);
    expect(codes(check(w, { now: new Date("2027-01-01T00:00:00Z") }))).toEqual(["run_plan_expired", "authorization_expired"]);
    expect(codes(check(w, { publisher: { ...w.publisher, trust_status: "unknown" } }))).toEqual(["publisher_trust_changed", "publisher_not_trusted"]);
    expect(codes(check(w, { publisher: { ...w.publisher, signature_status: "invalid" } }))).toEqual(["signature_status_changed", "signature_not_valid"]);
    expect(codes(check(w, { publisher: { ...w.publisher, signer_fingerprint: "sha256:other" } }))).toEqual(["signer_changed"]);
    expect(codes(check(w, { toolEvaluation: null }))).toEqual(["tool_registry_unknown"]);
    expect(codes(check(w, { resourceRegistry: null }))).toEqual(["resource_registry_unknown"]);
    expect(codes(check(w, { onceSpent: true }))).toEqual(["authorization_once_spent"]);
    expect(check(w, { catalog: null }).model_still_available).toBeNull();
    // The contract a binding was matched against moved (review 1, nit 10).
    const moved = JSON.parse(JSON.stringify(w.toolEvaluation)) as typeof w.toolEvaluation;
    moved.tools.find((tool) => tool.tool_id === "search-flights")!.contract_sha256 = "0".repeat(64);
    expect(check(w, { toolEvaluation: moved }).stale_reasons.map((reason) => [reason.code, reason.subject])).toEqual([["tool_contract_changed", "search-flights"]]);
    // A preset that allows local models only, chosen after preparation (review 1, nit 9): the
    // recorded local model passes, a hosted one goes stale.
    expect(codes(check(w, { localModelsOnly: true }))).toEqual([]);
    const hosted = JSON.parse(JSON.stringify(w.plan)) as typeof w.plan;
    (hosted.model_binding!.descriptor.properties as Record<string, unknown>).local = false;
    expect(preflight(hosted, { pkg: { digest: hosted.package.digest } as never, publisher: w.publisher, receipt: w.receipt, trustState: inputs().session.trust_state, policy: w.policy, toolEvaluation: w.toolEvaluation, resourceRegistry: w.resourceRegistry, catalog: w.catalog, now: NOW, localModelsOnly: true }).stale_reasons.map((reason) => reason.code)).toEqual(["model_not_local"]);
    // The same receipt id and hash with an approval withdrawn cannot happen (the hash covers the
    // approvals); the check is still independent, as in the reference.
    const withdrawn = { ...w.receipt, tool_approvals: { ...w.receipt.tool_approvals, "search-flights": false } };
    expect(codes(check(w, { receipt: withdrawn }))).toEqual(["tool_approval_withdrawn"]);
  });

  it("a removed, replaced, changed, unavailable or otherwise stale tool binding is reported per tool", async () => {
    const pkg = await webair040();
    const w = await world();
    const codes = (result: ReturnType<typeof preflight>) => result.stale_reasons.map((reason) => [reason.code, reason.subject]);
    const mutate = async (change: (registry: JsonObject) => void, options: { decisions?: Record<string, "deny" | "once" | "session"> } = {}) => {
      const raw = JSON.parse(JSON.stringify(inputs().tool_registry)) as JsonObject;
      change(raw);
      const registry = await normalizeRegistry(raw);
      return evaluateRegistry(pkg, registry, { decisions: options.decisions ?? inputs().decisions, toolApprovals: inputs().tool_approvals, now: NOW });
    };
    const bindings = (raw: JsonObject) => raw.bindings as JsonObject[];
    const find = (raw: JsonObject, toolId: string) => bindings(raw).find((item) => item.tool_id === toolId)!;
    expect(codes(check(w, { toolEvaluation: await mutate((raw) => (raw.bindings = bindings(raw).filter((item) => item.tool_id !== "search-flights"))) }))).toEqual([["tool_binding_removed", "search-flights"]]);
    expect(codes(check(w, { toolEvaluation: await mutate((raw) => (find(raw, "search-flights").id = "chrome:json_http:search-flights:2")) }))).toEqual([["tool_binding_replaced", "search-flights"]]);
    expect(codes(check(w, { toolEvaluation: await mutate((raw) => ((find(raw, "search-flights").limits as JsonObject).timeout_seconds = 30)) }))).toEqual([["tool_binding_changed", "search-flights"]]);
    expect(codes(check(w, { toolEvaluation: await mutate((raw) => (find(raw, "search-flights").available = false)) }))).toEqual([["tool_unavailable", "search-flights"]]);
    // A changed endpoint path: a different digest and an incompatible verdict.
    const moved = await mutate((raw) => ((find(raw, "search-flights").endpoint as JsonObject).path = "/api/v2/search_flights"));
    expect(codes(check(w, { toolEvaluation: moved }))).toEqual([
      ["tool_binding_changed", "search-flights"],
      ["tool_binding_stale", "search-flights"],
    ]);
    const changedRegistry = check(w, { toolEvaluation: moved });
    expect(changedRegistry.tool_bindings.registry_changed).toBe(true);
    expect(changedRegistry.tool_bindings.current).toBe(false);
  });

  it("a changed, removed or retyped host resource and a model the host no longer offers make the plan stale", async () => {
    const w = await world();
    const codes = (result: ReturnType<typeof preflight>) => result.stale_reasons.map((reason) => reason.code);
    const changed: ResourceRegistry = JSON.parse(JSON.stringify(w.resourceRegistry));
    changed.resources.find((item) => item.id === "payment_demo_visa")!.digest = "2".repeat(64);
    changed.resources = changed.resources.filter((item) => item.id !== "profile_demo_traveler");
    changed.resources.find((item) => item.id === "passenger_demo_alex")!.type = "wallet.payment_method";
    expect(codes(check(w, { resourceRegistry: changed }))).toEqual(["resource_type_changed", "resource_removed", "resource_changed"]);
    const emptyCatalog = await normalizeCatalog({ ...inputs().catalog, models: [] });
    const result = check(w, { catalog: emptyCatalog });
    expect(codes(result)).toEqual(["model_no_longer_available"]);
    expect(result.model_still_available).toBe(false);
    const unavailable = await normalizeCatalog({ ...inputs().catalog, models: [{ ...(inputs().catalog.models as JsonObject[])[0]!, available: false }] });
    expect(check(w, { catalog: unavailable }).model_still_available).toBe(false);
  });

  it("`once` means one run: a receipt that grants anything once is spent by the first run", async () => {
    const w = await world();
    expect(grantsOnce(w.receipt)).toBe(true); // booking.simulate_purchase is once
    expect(grantsOnce({ decisions: { "network.webair": "session" } })).toBe(false);
    expect(check(w, { onceSpent: grantsOnce(w.receipt) }).stale_reasons.map((reason) => reason.code)).toEqual(["authorization_once_spent"]);
    const sessionOnly = await world({ decisions: { ...inputs().decisions, "booking.simulate_purchase": "session" } });
    expect(grantsOnce(sessionOnly.receipt)).toBe(false);
  });
});
