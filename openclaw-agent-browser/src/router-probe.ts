/**
 * Everything that has to be true again before a single token is spent.
 *
 * A run plan is a record of a decision, not a capability. Between the moment a
 * person prepared one and the moment anything runs, the package bytes, the
 * signer, the operator's trust pins, the authorization receipt and the host's
 * model catalog can all move. This module re-checks each of them against the
 * plan, names the ones it checked in the result, and refuses on any difference.
 *
 * It is written as the preflight a real runner will use, not as a probe-shaped
 * shortcut, because the next milestone needs exactly this sequence before it
 * dispatches a workflow.
 */
import { AgentBrowserError } from "./errors.js";
import type { ControlPlaneClient } from "./control-plane.js";
import { stillAvailable, type HostCatalog } from "./host-models.js";
import type { RouterProbeViewType } from "./contract.js";

export type PreflightOutcome = {
  /** The bounded run-plan facts the bridge child is allowed to see. */
  binding: Record<string, unknown>;
  /** The exact host model id this probe may invoke. */
  modelId: string;
  /** Names of the checks that passed, in the order they ran. */
  revalidated: string[];
  plan: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function refuse(detail: string, code: "run_plan_stale" | "probe_refused" = "run_plan_stale"): never {
  throw new AgentBrowserError(
    code,
    code === "run_plan_stale" ? "This run plan is no longer current" : "The probe was refused",
    detail,
  );
}

/**
 * Re-verify one prepared plan against the live world, or refuse.
 *
 * The control plane's own `preflight` already re-computes digest, receipt,
 * signature, trust and expiry; it is trusted for those. Each fact is *also*
 * compared field by field here so a refusal names the exact thing that moved,
 * and so this layer does not depend on a remote verdict it cannot see inside.
 */
export async function revalidate(options: {
  client: ControlPlaneClient;
  catalog: HostCatalog;
  sessionId: string;
  runPlanId: string;
  runPlanSha256: string;
}): Promise<PreflightOutcome> {
  const { client, catalog, sessionId } = options;
  const revalidated: string[] = [];
  const state = record(await client.getRunPlan(sessionId));
  const plan = record(state.run_plan);
  const preflight = record(state.preflight);

  if (str(plan.run_plan_id) !== options.runPlanId) {
    refuse("This session's run plan is not the one the probe was asked to use.", "probe_refused");
  }
  if (str(plan.run_plan_sha256) !== options.runPlanSha256) {
    refuse("The run plan changed after the caller read it.", "probe_refused");
  }
  revalidated.push("run_plan_identity");

  const readiness = record(plan.readiness);
  if (readiness.ready !== true) refuse("The run plan was never ready to run.");
  if (preflight.stale === true || preflight.ready !== true) {
    const reasons = Array.isArray(preflight.stale_reasons) ? preflight.stale_reasons : [];
    const first = record(reasons[0]);
    refuse(str(first.message) || "The control plane reports this run plan as stale.");
  }
  revalidated.push("run_plan_readiness", "run_plan_preflight");

  const execution = record(plan.execution);
  if (str(execution.mode) !== "model") refuse("Only a model-backed run plan can be probed.");
  if (execution.performed !== false) refuse("This run plan is not in a preflight state.");
  revalidated.push("execution_mode");

  // -- the package the plan named is still the package this session holds ---
  const summary = record(await client.getPackage(sessionId));
  const planned = record(plan.package);
  const current = record(summary.package);
  if (str(current.digest) !== str(planned.digest)) refuse("The package bytes are not the planned bytes.");
  revalidated.push("package_digest");
  const snapshot = record(summary.snapshot);
  if (str(snapshot.archive_sha256) !== str(planned.archive_sha256)) {
    refuse("The package archive hash is not the planned hash.");
  }
  revalidated.push("archive_sha256");

  const publisher = record(summary.publisher);
  const plannedPublisher = record(plan.publisher);
  for (const [field, label] of [
    ["signature_status", "signature_status"],
    ["trust_status", "publisher_trust"],
    ["signer_fingerprint", "signer_fingerprint"],
  ] as const) {
    if (str(publisher[field]) !== str(plannedPublisher[field])) {
      refuse(`The publisher ${field.replace(/_/gu, " ")} changed after this plan was prepared.`);
    }
    revalidated.push(label);
  }

  // -- the consent that authorized it is still the same consent ------------
  const receipt = record(await client.getAuthorization(sessionId));
  const plannedAuth = record(plan.authorization);
  if (str(receipt.receipt_id) !== str(plannedAuth.receipt_id)) {
    refuse("A newer authorization replaced the one this plan was prepared under.");
  }
  if (str(receipt.receipt_sha256) !== str(plannedAuth.receipt_sha256)) {
    refuse("The authorization receipt changed after this plan was prepared.");
  }
  revalidated.push("authorization_receipt");
  const expiry = Date.parse(str(receipt.expires_at));
  if (Number.isFinite(expiry) && expiry <= Date.now()) refuse("The authorization receipt expired.");
  revalidated.push("receipt_not_expired");
  if (receipt.runnable !== true) refuse("The authorization receipt is not runnable.");

  const granted = new Set(
    (Array.isArray(receipt.granted_permission_ids) ? receipt.granted_permission_ids : []).map(str),
  );
  const required = Array.isArray(execution.required_permission_ids)
    ? execution.required_permission_ids.map(str)
    : [];
  if (required.length === 0) refuse("This run mode declares no model permission.");
  for (const permission of required) {
    if (!granted.has(permission)) {
      refuse(`A model-backed run needs permission ${permission}, which is not granted.`);
    }
  }
  revalidated.push("model_permission_granted");

  // -- the model is still the model the person chose, and still usable -----
  const binding = record(plan.model_binding);
  const modelId = str(binding.host_model_id);
  if (!modelId) refuse("The run plan binds no host model.");
  if (!stillAvailable(catalog, modelId)) {
    throw new AgentBrowserError(
      "selected_model_unavailable",
      "The selected model is not available",
      `This OpenClaw host no longer offers ${modelId} as a usable choice, so the run plan's ` +
        "model cannot be invoked. Prepare a new plan with a model this host offers.",
      true,
    );
  }
  revalidated.push("model_available");
  const live = catalog.models.find((model) => model.id === modelId);
  const descriptor = record(binding.descriptor);
  if (!live || live.provider_id !== str(descriptor.provider_id) || live.model_id !== str(descriptor.model_id)) {
    refuse("The host's identity for the selected model changed after this plan was prepared.");
  }
  revalidated.push("model_identity");
  const compatibility = record(binding.compatibility);
  if (str(compatibility.status) === "incompatible") refuse("The selected model is incompatible.");
  revalidated.push("model_compatibility");

  return {
    modelId,
    revalidated,
    plan,
    binding: {
      run_plan_id: str(plan.run_plan_id),
      run_plan_sha256: str(plan.run_plan_sha256),
      session_id: str(plan.session_id),
      package: {
        package_id: str(planned.package_id),
        name: str(planned.name),
        version: str(planned.version),
        digest: str(planned.digest),
        archive_sha256: str(planned.archive_sha256),
        execution_profile: str(planned.execution_profile),
      },
      execution: {
        mode: "model",
        profile: str(execution.profile),
        required_permission_ids: required,
      },
      // Exactly the descriptor fields the router needs to bind itself. No
      // endpoint, credential, receipt body or catalog travels to the child.
      model_binding: {
        host_model_id: modelId,
        provider_id: str(binding.provider_id),
        model_id: str(binding.model_id),
        display_name: str(binding.display_name),
        compatibility_status: str(compatibility.status),
        evidence_strength: str(compatibility.evidence_strength),
        capabilities: Object.fromEntries(
          Object.entries(record(descriptor.capabilities)).map(([name, answer]) => {
            const value = record(answer);
            return [name, { value: value.value ?? null, basis: str(value.basis) || null }];
          }),
        ),
        limits: record(descriptor.limits),
        properties: { local: record(descriptor.properties).local ?? null },
      },
    },
  };
}

/** Project the child's probe report into the bounded view the page receives. */
export function projectProbe(
  report: Record<string, unknown>,
  revalidated: string[],
): RouterProbeViewType {
  const router = record(report.router);
  const model = record(report.model);
  const probe = record(report.probe);
  const structured = record(report.structured_output);
  const tokens = record(report.tokens);
  const usage = record(report.usage);
  const accounting = record(report.accounting);
  const pkg = record(report.package);
  const timing = record(report.timing);
  const status = str(report.status) === "ok" ? "ok" : "contract_violation";
  return {
    status,
    runPlanId: str(report.run_plan_id),
    runPlanSha256: str(report.run_plan_sha256),
    sessionId: str(report.session_id),
    package: {
      packageId: str(pkg.package_id),
      name: str(pkg.name),
      version: str(pkg.version),
      digest: str(pkg.digest),
      executionProfile: str(pkg.execution_profile),
    },
    router: {
      routerId: str(router.router_id),
      modelId: str(router.model_id),
      remote: router.remote === true,
      contextWindow: num(router.context_window),
      capabilities: (Array.isArray(router.capabilities) ? router.capabilities : []).map(str),
      notDeclared: (Array.isArray(router.not_declared) ? router.not_declared : []).map(str),
    },
    model: {
      planned: str(model.planned),
      invoked: str(model.invoked),
      providerId: str(model.provider_id) || null,
      responseModel: str(model.response_model) || null,
      stopReason: str(model.stop_reason) || null,
      executionMode: str(record(model.execution).mode) || null,
    },
    probe: { status: str(probe.status), echo: str(probe.echo) },
    structuredOutput: {
      validated: structured.validated === true,
      constrainedByHost: structured.constrained_by_host === true,
      constraintDetail: str(structured.constraint_detail) || null,
      parse: str(structured.parse) || null,
    },
    tokens: {
      countTokensBound: num(tokens.count_tokens_bound),
      basis: str(tokens.basis),
      hostTokenizer: tokens.host_tokenizer === true,
      hostTokenizerDetail: str(tokens.host_tokenizer_detail) || null,
      framingAllowance:
        typeof tokens.framing_allowance === "number" ? tokens.framing_allowance : null,
    },
    usage: {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      costUsd: typeof usage.cost_usd === "number" ? usage.cost_usd : null,
    },
    accounting: {
      maxOutputTokens: num(accounting.max_output_tokens),
      inputWithinBound: accounting.input_within_bound === true,
      outputWithinCap: accounting.output_within_cap === true,
    },
    durationMs: num(timing.duration_ms),
    workflowExecuted: false,
    packageExecution: {
      workflowInstantiated: false,
      workersStarted: 0,
      toolsCalled: 0,
      packageInstructionsLoaded: false,
      exportsWritten: 0,
    },
    revalidated,
  };
}
