/**
 * The runner's policy, re-derived from the signed package (`test_execution_session.py`'s policy
 * cases, `test_execution_boundary.py`): host limits only lower, grants pass through unchanged or
 * refuse the run, every tool fact is compared with the plan, the model must satisfy the package,
 * and no module here knows a package word.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { FixtureRouter } from "../../../src/core/models/fixture.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import { ExecutionError } from "../../../src/core/execution/errors.js";
import { effectiveBudget, effectiveDeadlineSeconds, normalizeHostLimits, runtimeLimits } from "../../../src/core/execution/limits.js";
import { checkCapabilities, checkModel, checkResourceGrants, checkTools, consumptionCounts, grantReport, normalizeGrants, normalizeResourceGrants } from "../../../src/core/execution/policy.js";
import { executionPlanFromRunPlan, normalizeExecutionPlan, normalizeAuthorization, localExecutionPlan } from "../../../src/core/execution/plan.js";
import { buildInvocation, canonicalInput, MAX_INPUT_BYTES, normalizeAttachments } from "../../../src/core/execution/invocation.js";
import type { ToolBindingRecord } from "../../../src/core/tools/bindings.js";
import { PROJECT, readBytes, SHIPPED } from "../../helpers/paths.js";
import { inputs, webair040, literatureReview } from "../../helpers/fixtures.js";
import { world } from "../../helpers/world.js";
import { ECHO_TOOL, echoPackage } from "../../helpers/echo-package.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as ExecutionError).code;
  }
  throw new Error("expected a refusal");
};

describe("host execution limits", () => {
  it("default, lower, never raise: the runtime receives min() inputs and the budget report shows all three", async () => {
    const pkg = await webair040();
    const limits = normalizeHostLimits(null);
    expect(limits.total_tokens).toBe(120_000);
    expect(limits.model_call_timeout_seconds).toBe(300);
    const lowered = normalizeHostLimits({ max_parallel_workers: 1, total_tokens: 5000 });
    // compute.v0 (C-36): the three compute ceilings travel with the runtime limits, at their defaults here.
    expect(runtimeLimits(lowered)).toEqual({ hard_tokens: 5000, max_remote_calls: 32, max_parallel_workers: 1, max_calls_per_tool: 32, compute_memory_pages: 1024, compute_wall_seconds: 10, compute_fuel: 50_000_000_000 });
    const budget = effectiveBudget(pkg, lowered);
    const declared = pkg.policy.budget as JsonObject;
    expect((budget.effective as JsonObject).hard_tokens).toBe(Math.min(5000, declared.hard_tokens as number));
    expect((budget.effective as JsonObject).max_parallel_workers).toBe(1);
    expect(budget.declared).toMatchObject({ hard_tokens: declared.hard_tokens, max_calls_per_tool: declared.max_calls_per_tool });
    expect(effectiveDeadlineSeconds(pkg, normalizeHostLimits({ run_timeout_seconds: 1 }))).toBe(1);
    expect(effectiveDeadlineSeconds(pkg, limits)).toBe(Math.min(pkg.graph.deadline_seconds as number, 600));
  });

  it("refuses unknown fields, non-integers, zero and values above the supported maxima", () => {
    for (const bad of [0, -1, 1.5, "7", true, 3601]) expect(code(() => normalizeHostLimits({ model_call_timeout_seconds: bad }))).toBe("execution_plan_invalid");
    expect(() => normalizeHostLimits({ tokens: 1 })).toThrow(/Unknown fields in limits: \['tokens'\]/u);
    expect(() => normalizeHostLimits([])).toThrow(/must be an object/u);
    expect(normalizeHostLimits({ model_call_timeout_seconds: 1800 }).model_call_timeout_seconds).toBe(1800);
  });
});

describe("grants", () => {
  it("pass through unchanged; a denied required permission, an 'always', an unknown or a missing permission refuse the run", async () => {
    const pkg = await webair040();
    const decisions = inputs().decisions;
    const grants = normalizeGrants(pkg, decisions);
    expect(grants).toEqual(decisions);
    expect(code(() => normalizeGrants(pkg, { ...decisions, "model.reasoning": "deny" }))).toBe("execution_permission_denied");
    expect(code(() => normalizeGrants(pkg, { ...decisions, "model.reasoning": "always" }))).toBe("execution_grant_unsupported");
    expect(() => normalizeGrants(pkg, { ...decisions, extra: "session" })).toThrow(/undeclared permissions: \['extra'\]/u);
    const { "model.reasoning": _dropped, ...partial } = decisions;
    expect(() => normalizeGrants(pkg, partial)).toThrow(/omit declared permissions: \['model.reasoning'\]/u);
    expect(() => normalizeGrants(pkg, { ...decisions, "model.reasoning": "maybe" })).toThrow(/must be one of/u);
    const report = grantReport(pkg, grants);
    expect(report.granted_permission_ids).toEqual(Object.keys(decisions).filter((pid) => decisions[pid] !== "deny").sort());
    expect(report.source).toBe("authorization_receipt");
  });

  it("a 'once' grant is refused rather than widened when the graph would consume it more than once", async () => {
    const lr = await literatureReview();
    const counts = consumptionCounts(lr);
    expect(counts.model).toBeGreaterThan(1);
    const memory = (lr.policy.permissions as JsonObject[]).find((permission) => permission.kind === "memory")!;
    const model = (lr.policy.permissions as JsonObject[]).find((permission) => permission.kind === "model")!;
    const all = Object.fromEntries((lr.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), "session"]));
    expect(code(() => normalizeGrants(lr, { ...all, [String(model.id)]: "once" }))).toBe("execution_grant_unsupported");
    expect(code(() => normalizeGrants(lr, { ...all, [String(memory.id)]: "once" }))).toBe("execution_grant_unsupported");
    // WebAir's purchase permission is consumed at most once, so `once` stands (the recorded receipt grants it so).
    const webair = await webair040();
    expect(normalizeGrants(webair, inputs().decisions)["booking.simulate_purchase"]).toBe("once");
  });
});

describe("capabilities and tools, re-derived from the package", () => {
  it("accepts the recorded WebAir plan's seven bindings and reports each fact it verified", async () => {
    const { plan } = await world();
    const pkg = await webair040();
    const facts = executionPlanFromRunPlan(plan);
    const limits = normalizeHostLimits(null);
    const capabilities = checkCapabilities(pkg, limits, { toolBindings: facts.tool_bindings });
    expect(capabilities).toMatchObject({ tools_declared: 7, tool_bindings: 7, denied_tools: [] });
    const tools = checkTools(pkg, facts.tool_bindings, normalizeGrants(pkg, plan.authorization.decisions), plan.authorization.tool_approvals);
    expect(tools.bound).toEqual(Object.keys(pkg.tools).sort());
    for (const record of tools.bindings as JsonObject[]) {
      expect(record.verified).toEqual(["binding_name", "input_schema_sha256", "output_schema_sha256", "remote", "required_permission_ids"]);
      expect(record.approved).toBe(true);
    }
    const model = checkModel(pkg, fixtureAdapters(pkg).router);
    expect(model.required_capabilities).toEqual(["reasoning", "structured_output"]);
  });

  it("refuses a plan that misdescribes a tool, an unapproved tool, a tool with a denied required permission, and a foreign destination", async () => {
    const { plan } = await world();
    const pkg = await webair040();
    const facts = executionPlanFromRunPlan(plan);
    const grants = normalizeGrants(pkg, plan.authorization.decisions);
    const approvals = plan.authorization.tool_approvals;
    const search = facts.tool_bindings.find((binding) => binding.tool_id === "search-flights")!;
    const edit = (changes: Partial<ToolBindingRecord>): ToolBindingRecord[] => facts.tool_bindings.map((binding) => (binding.tool_id === "search-flights" ? { ...binding, ...changes } : binding));
    expect(code(() => checkTools(pkg, edit({ input_schema_sha256: "0".repeat(64) }), grants, approvals))).toBe("tool_contract_mismatch");
    expect(code(() => checkTools(pkg, edit({ remote: false }), grants, approvals))).toBe("tool_contract_mismatch");
    expect(code(() => checkTools(pkg, edit({ required_permission_ids: [] }), grants, approvals))).toBe("tool_contract_mismatch");
    expect(code(() => checkTools(pkg, edit({ endpoint_origin: "https://evil.example" }), grants, approvals))).toBe("tool_contract_mismatch");
    expect(code(() => checkTools(pkg, edit({ endpoint_origin: `http://${new URL(search.endpoint_origin!).hostname}` }), grants, approvals))).toBe("tool_contract_mismatch");
    expect(code(() => checkTools(pkg, facts.tool_bindings, grants, { ...approvals, "search-flights": false }))).toBe("tool_not_approved");
    expect(code(() => checkTools(pkg, [{ ...search, tool_id: "ghost" }], grants, approvals))).toBe("tool_not_declared");
    // A denied *optional* permission keeps the binding (unusable); a denied required one refuses.
    const linked = search.required_permission_ids[0]!;
    const required = (pkg.policy.permissions as JsonObject[]).find((permission) => permission.id === linked)!.required === true;
    const denied = { ...grants, [linked]: "deny" as const };
    if (required) expect(code(() => checkTools(pkg, [search], denied, approvals))).toBe("tool_permission_denied");
    else expect((checkTools(pkg, [search], denied, approvals).bindings as JsonObject[])[0]!.usable).toBe(false);
  });

  it("D-022: a denied tool blocks nothing, an approved unbound tool blocks, and a package with tools but no binding is a host limit", async () => {
    const pkg = await webair040();
    const limits = normalizeHostLimits(null);
    const { plan } = await world();
    const facts = executionPlanFromRunPlan(plan);
    const withoutSearch = facts.tool_bindings.filter((binding) => binding.tool_id !== "search-flights");
    expect(code(() => checkCapabilities(pkg, limits, { toolBindings: withoutSearch }))).toBe("tool_not_bound");
    expect(checkCapabilities(pkg, limits, { toolBindings: withoutSearch, deniedTools: ["search-flights"] }).denied_tools).toEqual(["search-flights"]);
    expect(code(() => checkCapabilities(pkg, limits, { toolBindings: [] }))).toBe("tools_not_supported");
    expect(checkCapabilities(pkg, limits, { toolBindings: [], deniedTools: Object.keys(pkg.tools) }).tool_bindings).toBe(0);
    expect(checkCapabilities(pkg, limits, { fixture: true }).tools_declared).toBe(7);
  });

  it("refuses an output cap above the host ceiling rather than lowering it, and an export on a host-written name", async () => {
    const pkg = await webair040();
    expect(code(() => checkCapabilities(pkg, normalizeHostLimits({ max_output_tokens_per_call: 10 }), { fixture: true }))).toBe("execution_output_cap_too_large");
    const graph = JSON.parse(JSON.stringify(pkg.graph)) as JsonObject;
    (graph.exports as JsonObject[]).push({ path: "Run.JSON", format: "json", value: { from: "result", path: "" } });
    expect(code(() => checkCapabilities({ ...pkg, graph }, normalizeHostLimits(null), { fixture: true }))).toBe("execution_export_path_reserved");
  });

  it("refuses a model that lacks a capability, a context window, or locality the package requires", async () => {
    const pkg = await webair040();
    const router = fixtureAdapters(pkg).router;
    const noReasoning = Object.create(router, { capabilities: { value: new Set(["structured_output"]) } }) as FixtureRouter;
    expect(code(() => checkModel(pkg, noReasoning))).toBe("execution_model_incompatible");
    const small = Object.create(router, { context_window: { value: 10 } }) as FixtureRouter;
    expect(code(() => checkModel(pkg, small))).toBe("execution_model_incompatible");
    const manifest = { ...pkg.manifest, model_requirements: { ...(pkg.manifest.model_requirements as JsonObject), privacy: "local-only" } };
    const remote = Object.create(router, { remote: { value: true } }) as FixtureRouter;
    expect(code(() => checkModel({ ...pkg, manifest }, remote))).toBe("execution_model_incompatible");
  });

  it("resource grants are closed references, declared for that type, and never denied", async () => {
    const pkg = await webair040();
    const { plan } = await world();
    const grants = normalizeGrants(pkg, plan.authorization.decisions);
    const checked = checkResourceGrants(pkg, normalizeResourceGrants(plan.resource_grants), grants);
    expect((checked.grants as JsonObject[]).length).toBe(plan.resource_grants.length);
    const first = plan.resource_grants[0]!;
    expect(() => normalizeResourceGrants([{ ...first, extra: 1 }])).toThrow(/must carry exactly/u);
    expect(() => normalizeResourceGrants([first, first])).toThrow(/names one permission twice/u);
    expect(() => checkResourceGrants(pkg, [{ ...first, resource_type: "other.type" }], grants)).toThrow(/does not declare for that resource type/u);
    expect(code(() => checkResourceGrants(pkg, [first], { ...grants, [first.permission_id]: "deny" }))).toBe("execution_permission_denied");
  });
});

describe("plan facts and authorization", () => {
  it("projects T3's run plan onto the runner's facts and refuses unknown fields, a probe with a model, and required tools without a binding", async () => {
    const { plan } = await world();
    const facts = executionPlanFromRunPlan(plan);
    expect(facts.model_binding?.host_model_id).toBe("ollama/qwen3:30b");
    expect(facts.model_binding?.limits.context_tokens).toBe(65536);
    expect(facts.model_binding?.properties.local).toBe(true);
    expect(facts.model_binding?.compatibility_status).toBe("compatible");
    expect(facts.tool_bindings.map((binding) => binding.tool_id)).toEqual(plan.execution.required_tool_ids);
    expect(facts.execution.denied_tool_ids).toEqual([]);
    const raw = { run_plan_id: plan.run_plan_id, run_plan_sha256: plan.run_plan_sha256, package: { package_id: "a", version: "1", digest: "d", archive_sha256: "s" }, publisher: { signer_fingerprint: "f" }, execution: { mode: "model" }, model_binding: { host_model_id: "x/y", provider_id: "x", model_id: "y", limits: { context_tokens: 100 } } };
    expect(normalizeExecutionPlan(raw).execution.fixture).toBe(false);
    expect(() => normalizeExecutionPlan({ ...raw, surprise: 1 })).toThrow(/Unknown fields in run_plan: \['surprise'\]/u);
    expect(() => normalizeExecutionPlan({ ...raw, execution: { mode: "tool_probe" } })).toThrow(/binds no model/u);
    const { model_binding: _binding, ...withoutBinding } = raw;
    expect(() => normalizeExecutionPlan(withoutBinding)).toThrow(/Missing fields in run_plan: \['model_binding'\]/u);
    expect(code(() => normalizeExecutionPlan({ ...raw, execution: { mode: "model", required_tool_ids: ["search-flights"] } }))).toBe("tool_not_bound");
    expect(() => normalizeAuthorization({ receipt_id: "r", receipt_sha256: "s", decisions: {}, tool_approvals: { a: "yes" } })).toThrow(/must be true or false/u);
    expect(() => normalizeAuthorization({ receipt_id: "r", receipt_sha256: "s", decisions: {}, nope: 1 })).toThrow(/Unknown fields in authorization/u);
  });

  it("a local plan (the CLI's) names the package, hashes its facts, and denies every tool not approved", async () => {
    const pkg = await webair040();
    const bytes = readBytes(SHIPPED.webair040.archive);
    const { plan, authorization } = localExecutionPlan({ pkg, archiveSha256: SHIPPED.webair040.archiveSha256, signerFingerprint: SHIPPED.webair040.fingerprint, decisions: inputs().decisions, approvedTools: ["search-flights", "get-fare-rules"], fixture: true, now: new Date("2026-10-07T00:00:00Z") });
    expect(plan.execution.fixture).toBe(true);
    expect(plan.execution.required_tool_ids).toEqual(["get-fare-rules", "search-flights"]);
    expect(plan.execution.denied_tool_ids).toEqual(Object.keys(pkg.tools).filter((toolId) => !["search-flights", "get-fare-rules"].includes(toolId)).sort());
    expect(plan.execution.required_permission_ids).toEqual(["model.reasoning"]);
    expect(authorization.tool_approvals["search-flights"]).toBe(true);
    expect(authorization.tool_approvals["prepare-booking"]).toBe(false);
    expect(plan.run_plan_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(bytes.length).toBeGreaterThan(0);
    expect(() => localExecutionPlan({ pkg, archiveSha256: "x", signerFingerprint: "y", decisions: {}, approvedTools: ["ghost"], fixture: true })).toThrow(/does not declare: \['ghost'\]/u);
    const echo = await echoPackage();
    const live = localExecutionPlan({ pkg: echo.pkg, archiveSha256: echo.archiveSha256, signerFingerprint: echo.key.fingerprint, decisions: {}, approvedTools: [ECHO_TOOL], fixture: false, modelBinding: { host_model_id: "t/m", provider_id: "t", model_id: "m", display_name: null, compatibility_status: null, evidence_strength: null, capabilities: {}, limits: { context_tokens: 1000, native_context_window: null, max_output_tokens: null }, properties: { local: true }, pricing: null } });
    expect(live.plan.execution.fixture).toBe(false);
    expect(live.plan.model_binding?.host_model_id).toBe("t/m");
  });
});

describe("the run invocation", () => {
  it("binds the plan and the input by hash, bounds the input, and keeps attachments closed", async () => {
    const { plan } = await world();
    const facts = executionPlanFromRunPlan(plan);
    const invocation = buildInvocation({ run_id: "run-1", plan: facts, input: { b: 1, a: [1, 2] }, created_at: new Date("2026-10-07T00:00:00Z") });
    expect(invocation.schema).toBe("agentpkg-run-invocation-v0");
    expect(invocation.input_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(invocation.input_bytes).toBe(canonicalInput({ a: [1, 2], b: 1 }).length);
    expect(invocation.run_invocation_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(invocation.created_at).toBe("2026-10-07T00:00:00+00:00");
    expect(code(() => canonicalInput({ big: "x".repeat(MAX_INPUT_BYTES) }))).toBe("execution_input_invalid");
    expect(code(() => canonicalInput({ nan: Number.NaN }))).toBe("execution_input_invalid");
    const file = { file_id: `file_${"a".repeat(32)}`, sha256: "b".repeat(64), bytes: 10, media_type: "application/pdf" };
    expect(normalizeAttachments([file])).toEqual([file]);
    expect(() => normalizeAttachments([{ ...file, media_type: "text/plain" }])).toThrow(/not a supported/u);
    expect(() => normalizeAttachments([file, file])).toThrow(/duplicated/u);
    expect(() => normalizeAttachments([{ ...file, path: "/tmp/x" }])).toThrow(/exactly/u);
  });
});

describe("no package knowledge", () => {
  it("the execution modules mention no package, task, skill or application word", () => {
    const modules = ["artifact", "artifacts", "errors", "invocation", "lease", "limits", "plan", "policy", "progress", "record", "report", "runner"];
    for (const module of modules) {
      const text = readFileSync(join(PROJECT, "src", "core", "execution", `${module}.ts`), "utf8").toLowerCase();
      for (const forbidden of ["literature", "citation", "related_work", "meeting", "agenda", "webair", "airline", "search-flights", "passenger", "crossref", "perspective"]) {
        expect(text.includes(forbidden), `${module}.ts mentions ${forbidden}`).toBe(false);
      }
    }
  });
});
