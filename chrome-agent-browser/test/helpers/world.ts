/**
 * The fixture world of `test/fixtures/authorization/`, rebuilt in TypeScript: receipt, registries,
 * evaluations and a ready WebAir 0.4.0 run plan, exactly as T3's run-plan tests build it. Shared
 * by the run-plan tests and T4's lease and runner tests, which need a real plan to run against.
 */
import { evaluateCatalog, normalizeCatalog, type HostCatalog } from "../../src/core/compatibility.js";
import type { EvaluationLayers, PublisherReport } from "../../src/core/evaluation.js";
import { normalizeResourceRegistry, normalizeResourceSelections, type ResourceRegistry } from "../../src/core/hostresources.js";
import { evaluateRegistry, normalizeRegistry, type RegistryEvaluation, type ToolRegistry } from "../../src/core/hosttools.js";
import { buildReceipt } from "../../src/core/authorization.js";
import { buildRunPlan, MODE_MODEL, preparationBlockers, type RunPlanInputs } from "../../src/core/runplan.js";
import type { AuthorizationReceipt, BrowserPolicy, RunPlan } from "../../src/core/types.js";
import { fixture, inputs, webair040 } from "./fixtures.js";

export interface World {
  receipt: AuthorizationReceipt;
  catalog: HostCatalog;
  toolRegistry: ToolRegistry;
  toolEvaluation: RegistryEvaluation;
  resourceRegistry: ResourceRegistry;
  publisher: PublisherReport;
  layers: EvaluationLayers;
  policy: BrowserPolicy;
  plan: RunPlan;
  planInputs: RunPlanInputs;
}

export const NOW = new Date("2026-10-06T12:00:00.000Z");

/** The fixture world, rebuilt in TypeScript: receipt, registries, evaluations and a ready plan. */
export async function world(overrides: { decisions?: Record<string, "deny" | "once" | "session">; approvals?: Record<string, boolean> } = {}): Promise<World> {
  const pkg = await webair040();
  const input = inputs();
  const decisions = overrides.decisions ?? input.decisions;
  const approvals = overrides.approvals ?? input.tool_approvals;
  const resourceRegistry = await normalizeResourceRegistry(input.resource_registry);
  const publisher = input.session.publisher as unknown as PublisherReport;
  const layers = input.session.evaluation as unknown as EvaluationLayers;
  const policy = input.session.browser_policy as unknown as BrowserPolicy;
  const reference = fixture<AuthorizationReceipt>("receipt");
  const grants = Object.fromEntries(Object.entries(input.resource_selections).filter(([permissionId]) => decisions[permissionId] !== "deny"));
  const receipt = await buildReceipt(pkg, {
    sessionId: input.session.session_id,
    source: input.session.source,
    archiveSha256: input.session.archive_sha256,
    evaluation: layers,
    publisher,
    trustState: input.session.trust_state,
    decisions,
    toolApprovals: approvals,
    policy,
    instanceId: input.session.instance_id,
    expiresAt: input.session.expires_at,
    resourceGrants: normalizeResourceSelections(pkg, resourceRegistry, decisions, grants),
    resourceRegistry,
    receiptId: reference.receipt_id,
    now: new Date(reference.issued_at),
  });
  const catalog = await normalizeCatalog(input.catalog);
  const toolRegistry = await normalizeRegistry(input.tool_registry);
  const toolEvaluation = await evaluateRegistry(pkg, toolRegistry, { decisions, toolApprovals: approvals, now: NOW });
  const evaluation = evaluateCatalog(pkg, catalog, NOW);
  const descriptor = catalog.models[0]!;
  const compatibility = evaluation.models.find((model) => model.model_id === descriptor.id)!;
  const blockers = preparationBlockers(pkg, { mode: MODE_MODEL, evaluation, receipt, publisher, compatibility, policy, toolEvaluation, resourceRegistry });
  const referencePlan = fixture<RunPlan>("run_plan");
  const planInputs: RunPlanInputs = {
    sessionId: input.session.session_id,
    source: input.session.source,
    archiveSha256: input.session.archive_sha256,
    evaluation,
    catalog,
    descriptor,
    compatibility,
    receipt,
    publisher,
    trustState: input.session.trust_state,
    evaluationLayers: layers,
    policy,
    instanceId: input.session.instance_id,
    mode: MODE_MODEL,
    bindingStrategy: "single_model",
    expiresAt: input.session.expires_at,
    blockingReasons: blockers,
    toolEvaluation,
    toolRegistry,
    resourceRegistry,
    now: new Date(referencePlan.created_at),
    runPlanId: referencePlan.run_plan_id,
  };
  const plan = await buildRunPlan(pkg, planInputs);
  return { receipt, catalog, toolRegistry, toolEvaluation, resourceRegistry, publisher, layers, policy, plan, planInputs };
}
