/**
 * Everything that has to be true again before a single token is spent.
 *
 * A run plan is a record of a decision, not a capability. Between the moment a
 * person prepared one and the moment anything runs, the package bytes, the
 * signer, the operator's trust pins, the authorization receipt and the host's
 * model catalog can all move. This module re-checks each of them against the
 * plan, names the ones it checked in the result, and refuses on any difference.
 *
 * There is exactly one of these. The router probe and the execution runner ask
 * the same question — *may this plan be acted on right now?* — so they ask it
 * through the same code, and a run cannot end up behind a weaker gate than a
 * probe. Execution adds one requirement of its own: consent must outlast the
 * run it is about to authorize.
 */
import { AgentBrowserError } from "./errors.js";
import type { ControlPlaneClient } from "./control-plane.js";
import { stillAvailable, type HostCatalog } from "./host-models.js";

export type PreflightOutcome = {
  /** The bounded run-plan facts a bridge child is allowed to see. */
  binding: Record<string, unknown>;
  /** The consent this run would be carried out under, exactly as recorded. */
  authorization: {
    receiptId: string;
    receiptSha256: string;
    issuedAt: string | null;
    expiresAt: string | null;
    decisions: Record<string, string>;
    toolApprovals: Record<string, boolean>;
    remainingMs: number | null;
  };
  /** The exact host model id this run may invoke. */
  modelId: string;
  packageDigest: string;
  archiveSha256: string;
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

function refuse(detail: string, code: "run_plan_stale" | "probe_refused" = "run_plan_stale"): never {
  throw new AgentBrowserError(
    code,
    code === "run_plan_stale" ? "This run plan is no longer current" : "The request was refused",
    detail,
  );
}

export type PreflightOptions = {
  client: ControlPlaneClient;
  catalog: HostCatalog;
  sessionId: string;
  runPlanId: string;
  runPlanSha256: string;
  /**
   * How much authorization must be left before this operation may start.
   *
   * A probe is one short call, so a receipt that is valid now is valid for it.
   * A run is not: starting one whose consent expires halfway through would put
   * the run in a state nobody decided about. Execution therefore requires the
   * receipt to outlast the whole run deadline plus a margin, and asks the
   * person to authorize again when it does not.
   */
  minimumReceiptRemainingMs?: number;
};

/**
 * Re-verify one prepared plan against the live world, or refuse.
 *
 * The control plane's own `preflight` already re-computes digest, receipt,
 * signature, trust and expiry; it is trusted for those. Each fact is *also*
 * compared field by field here so a refusal names the exact thing that moved,
 * and so this layer does not depend on a remote verdict it cannot see inside.
 */
export async function revalidate(options: PreflightOptions): Promise<PreflightOutcome> {
  const { client, catalog, sessionId } = options;
  const revalidated: string[] = [];
  const state = record(await client.getRunPlan(sessionId));
  const plan = record(state.run_plan);
  const preflight = record(state.preflight);

  if (str(plan.run_plan_id) !== options.runPlanId) {
    refuse("This session's run plan is not the one the caller asked for.", "probe_refused");
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
  if (str(execution.mode) !== "model") refuse("Only a model-backed run plan can be executed.");
  if (execution.performed !== false) refuse("This run plan is not in a preflight state.");
  revalidated.push("execution_mode");

  // -- the package the plan named is still the package this session holds ---
  const summary = record(await client.getPackage(sessionId));
  const planned = record(plan.package);
  const current = record(summary.package);
  if (str(current.digest) !== str(planned.digest)) {
    refuse("The package bytes are not the planned bytes.");
  }
  revalidated.push("package_digest");
  const snapshot = record(summary.snapshot);
  if (str(snapshot.archive_sha256) !== str(planned.archive_sha256)) {
    refuse("The package archive hash is not the planned hash.");
  }
  revalidated.push("archive_sha256");
  if (str(planned.execution_profile) !== "workflow.v0") {
    refuse("This host executes the workflow.v0 profile only.");
  }
  const validation = record(summary.validation);
  for (const layer of ["container_status", "integrity_status", "schema_status"] as const) {
    if (str(validation[layer]) !== "valid") refuse(`Package ${layer.replace("_status", "")} is not valid.`);
  }
  if (str(validation.runtime_status) !== "compatible") {
    refuse("No installed execution profile can run this package.");
  }
  revalidated.push("execution_profile", "package_validation");

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
  const remainingMs = Number.isFinite(expiry) ? expiry - Date.now() : null;
  if (remainingMs !== null && remainingMs <= 0) refuse("The authorization receipt expired.");
  revalidated.push("receipt_not_expired");
  const required = options.minimumReceiptRemainingMs ?? 0;
  if (required > 0 && remainingMs !== null && remainingMs < required) {
    throw new AgentBrowserError(
      "authorization_expiring",
      "This authorization is about to expire",
      `A run may take up to ${Math.round(required / 1000)}s, and this authorization has ` +
        `${Math.max(0, Math.round(remainingMs / 1000))}s left. Authorize again before starting, ` +
        "so consent cannot lapse in the middle of a run.",
    );
  }
  if (required > 0) revalidated.push("receipt_outlasts_run_deadline");
  if (receipt.runnable !== true) refuse("The authorization receipt is not runnable.");

  const granted = new Set(
    (Array.isArray(receipt.granted_permission_ids) ? receipt.granted_permission_ids : []).map(str),
  );
  const requiredPermissions = Array.isArray(execution.required_permission_ids)
    ? execution.required_permission_ids.map(str)
    : [];
  if (requiredPermissions.length === 0) refuse("This run mode declares no model permission.");
  for (const permission of requiredPermissions) {
    if (!granted.has(permission)) {
      refuse(`A model-backed run needs permission ${permission}, which is not granted.`);
    }
  }
  revalidated.push("model_permission_granted");

  const decisions: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(receipt.decisions))) {
    decisions[key] = str(value);
  }
  const toolApprovals: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record(receipt.tool_approvals))) {
    toolApprovals[key] = value === true;
  }

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
  if (
    !live ||
    live.provider_id !== str(descriptor.provider_id) ||
    live.model_id !== str(descriptor.model_id)
  ) {
    refuse("The host's identity for the selected model changed after this plan was prepared.");
  }
  revalidated.push("model_identity");
  const compatibility = record(binding.compatibility);
  if (str(compatibility.status) === "incompatible") refuse("The selected model is incompatible.");
  revalidated.push("model_compatibility");

  return {
    modelId,
    packageDigest: str(planned.digest),
    archiveSha256: str(planned.archive_sha256),
    revalidated,
    plan,
    authorization: {
      receiptId: str(receipt.receipt_id),
      receiptSha256: str(receipt.receipt_sha256),
      issuedAt: str(receipt.issued_at) || null,
      expiresAt: str(receipt.expires_at) || null,
      decisions,
      toolApprovals,
      remainingMs,
    },
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
      publisher: {
        signer_fingerprint: str(plannedPublisher.signer_fingerprint),
        signature_status: str(plannedPublisher.signature_status),
        trust_status: str(plannedPublisher.trust_status),
      },
      execution: {
        mode: "model",
        profile: str(execution.profile),
        required_permission_ids: requiredPermissions,
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
