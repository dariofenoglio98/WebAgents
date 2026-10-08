/**
 * The conformance suite's driver for the Chrome core's control plane: the same scenarios as
 * `control_plane.py`, through the functions the extension's service worker calls
 * (`controller.ts`: `evaluateSnapshot`, `publisherReport`, `buildReceipt`, `preparationBlockers`,
 * `buildRunPlan`, `preflight`, `LeaseRegistry.issue`), with the worker's own refusal codes. It
 * prints one JSON document in the Python driver's vocabulary. Nothing is executed.
 *
 * The runner bundles this file with esbuild (from `chrome-agent-browser/node_modules`) and runs
 * it with Node: `node <bundle> <scenario>`.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildReceipt, normalizeProvenance } from "../../chrome-agent-browser/src/core/authorization.js";
import { evaluateCatalog, normalizeCatalog } from "../../chrome-agent-browser/src/core/compatibility.js";
import { CoreError } from "../../chrome-agent-browser/src/core/errors.js";
import { evaluateSnapshot, evaluationLayers, publisherReport } from "../../chrome-agent-browser/src/core/evaluation.js";
import { ExecutionError } from "../../chrome-agent-browser/src/core/execution/errors.js";
import { LeaseRegistry } from "../../chrome-agent-browser/src/core/execution/lease.js";
import { normalizeResourceRegistry, normalizeResourceSelections } from "../../chrome-agent-browser/src/core/hostresources.js";
import { evaluateRegistry, normalizeRegistry } from "../../chrome-agent-browser/src/core/hosttools.js";
import type { JsonObject } from "../../chrome-agent-browser/src/core/json.js";
import { publicKeyFromPem } from "../../chrome-agent-browser/src/core/keys.js";
import { buildRunPlan, MODE_MODEL, preflight, preparationBlockers } from "../../chrome-agent-browser/src/core/runplan.js";
import { MemoryTrustStorage, TrustStore } from "../../chrome-agent-browser/src/core/trust.js";
import type { BrowserPolicy, Decision, Reason } from "../../chrome-agent-browser/src/core/types.js";

const ROOT = resolve(process.env.CONFORMANCE_ROOT ?? process.cwd());
const WORLD = JSON.parse(readFileSync(join(ROOT, "chrome-agent-browser/test/fixtures/authorization/inputs.json"), "utf8"));
const SCENARIOS = JSON.parse(readFileSync(join(ROOT, "conformance/drivers/scenarios.json"), "utf8"));

const codes = (reasons: readonly Reason[] | undefined): string[] => (reasons ?? []).map((reason) => reason.code);

function changedRegistry(registry: JsonObject, toolId: string): JsonObject {
  const copy = JSON.parse(JSON.stringify(registry));
  for (const binding of copy.bindings) if (binding.tool_id === toolId) binding.implementation_version = "0.1.1";
  return copy;
}

async function main(name: string): Promise<JsonObject> {
  const scenario = SCENARIOS[name];
  const steps: JsonObject[] = [];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 900_000).toISOString();
  const trust = new TrustStore(new MemoryTrustStorage("trust.json"));
  const key = publicKeyFromPem(readFileSync(join(ROOT, "examples/keys/webair-publisher.pub.pem"), "utf8"));
  const entry = await trust.add(key, { displayName: "WebAir demo publisher", publisherId: "webair-demo" });
  const bytes = new Uint8Array(readFileSync(join(ROOT, WORLD.package)));
  const evaluated = await evaluateSnapshot(bytes);
  const pkg = evaluated.package!;
  const layers = evaluationLayers(evaluated);
  const policy = WORLD.session.browser_policy as BrowserPolicy;
  const session = { sessionId: "session-conformance", source: { kind: "file", display: "pkg" }, archiveSha256: WORLD.session.archive_sha256, instanceId: "conformance" };
  let publisher = await publisherReport(pkg, trust);
  const decisions: Record<string, Decision> = { ...WORLD.decisions, ...(scenario.decisions ?? {}) };
  const approvals: Record<string, boolean> = { ...WORLD.tool_approvals, ...(scenario.tool_approvals ?? {}) };
  const resourceRegistry = await normalizeResourceRegistry(WORLD.resource_registry);
  const selections = Object.fromEntries(Object.entries(WORLD.resource_selections as Record<string, string>).filter(([permissionId]) => (decisions[permissionId] ?? "deny") !== "deny"));
  const grants = normalizeResourceSelections(pkg, resourceRegistry, decisions, selections);
  // The worker records who decided each item; a profile is named the way `authorize` takes it.
  const provenance = scenario.profile_id ? normalizeProvenance(pkg, { preset: "balanced", profile_id: scenario.profile_id }, decisions, approvals, grants) : null;
  const receipt = await buildReceipt(pkg, { ...session, evaluation: layers, publisher, trustState: await trust.state(), decisions, toolApprovals: approvals, policy, expiresAt, resourceGrants: grants, resourceRegistry, provenance, now });
  steps.push({ step: "authorize", runnable: receipt.runnable, blocking_reasons: codes(receipt.blocking_reasons), granted_permission_ids: receipt.granted_permission_ids });

  let registryRaw: JsonObject = WORLD.tool_registry;
  if (scenario.registry_only) registryRaw = { ...registryRaw, bindings: (registryRaw.bindings as JsonObject[]).filter((binding) => scenario.registry_only.includes(binding.tool_id)) };
  let toolRegistry = await normalizeRegistry(registryRaw);
  const toolEvaluationFor = async () => evaluateRegistry(pkg, toolRegistry, { decisions: receipt.decisions, toolApprovals: receipt.tool_approvals, now });
  const catalog = await normalizeCatalog(WORLD.catalog);
  const evaluation = evaluateCatalog(pkg, catalog, now);
  const descriptor = catalog.models[0]!;
  const compatibility = evaluation.models.find((model) => model.model_id === descriptor.id) ?? null;
  const toolEvaluation = await toolEvaluationFor();
  const blockers = preparationBlockers(pkg, { mode: MODE_MODEL, evaluation, receipt, publisher, compatibility, policy, toolEvaluation, resourceRegistry });
  if (blockers.length > 0) {
    // `controller.ts::prepareRunPlan`: a run plan exists only when it is ready.
    steps.push({ step: "prepare", outcome: "refused", code: "run_plan_refused", reasons: codes(blockers).sort() });
    return { runtime: "chrome-agent-browser", scenario: name, steps };
  }
  const plan = await buildRunPlan(pkg, {
    ...session,
    evaluation,
    catalog,
    descriptor,
    compatibility,
    receipt,
    publisher,
    trustState: await trust.state(),
    evaluationLayers: layers,
    policy,
    mode: MODE_MODEL,
    bindingStrategy: "single_model",
    expiresAt,
    blockingReasons: blockers,
    toolEvaluation,
    toolRegistry,
    resourceRegistry,
    now,
  });
  const first = preflight(plan, { pkg, publisher, receipt, trustState: await trust.state(), policy, toolEvaluation, resourceRegistry, catalog, now });
  steps.push({
    step: "prepare",
    outcome: first.ready ? "ready" : "not_ready",
    required_tool_ids: plan.execution.required_tool_ids,
    denied_tool_ids: plan.execution.denied_tool_ids,
    bound_tool_ids: plan.tool_bindings.map((binding) => binding.tool_id).sort(),
  });
  const registry = new LeaseRegistry();
  for (const action of scenario.then as string[]) {
    if (action === "lease") {
      const state = preflight(plan, { pkg, publisher, receipt, trustState: await trust.state(), policy, toolEvaluation: await toolEvaluationFor(), resourceRegistry, catalog, onceSpent: registry.onceSpent(plan), now });
      const step: JsonObject = { step: "lease", preflight_ready: state.ready, stale_reasons: codes(state.stale_reasons) };
      try {
        const lease = await registry.issue({ plan, preflight: state, archive: bytes, now, sessionExpiresAt: expiresAt });
        step.outcome = "issued";
        registry.release(lease.lease_id);
      } catch (error) {
        if (!(error instanceof ExecutionError) && !(error instanceof CoreError)) throw error;
        step.outcome = "refused";
        step.code = error.code;
      }
      steps.push(step);
    } else if (action === "revoke_trust") {
      await trust.remove(entry.fingerprint);
      publisher = await publisherReport(pkg, trust);
      steps.push({ step: "revoke_trust" });
    } else if (action.startsWith("change_tool:")) {
      toolRegistry = await normalizeRegistry(changedRegistry(registryRaw, action.slice("change_tool:".length)));
      steps.push({ step: action });
    } else {
      throw new Error(`unknown action ${action}`);
    }
  }
  return { runtime: "chrome-agent-browser", scenario: name, steps };
}

const name = process.argv[2];
if (name === undefined || !(name in SCENARIOS)) {
  process.stderr.write(`usage: control-plane <${Object.keys(SCENARIOS).join("|")}>\n`);
  process.exit(2);
}
main(name).then(
  (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
