/**
 * Immutable run plans, mirroring `agentpkg/browser/runplan.py`: the last artifact before
 * execution, and still not it.
 *
 * A plan binds five things that must not drift apart between the moment a person decided and
 * the moment something runs: these bytes · this signer and trust state · this authorization
 * receipt · this host model · this catalog state. The plan is frozen and hashed; readiness is
 * **recomputed on every read** (`preflight`), so a plan that was ready can become stale, and
 * saying so is the point of separating the two.
 *
 * Chrome differences, each recorded in D-022 / D-053: a tool the receipt did not approve is a
 * *denied* tool (the runtime refuses calls to it) rather than a blocker, so a profile that
 * leaves tools out yields a ready plan; `required_tool_ids` lists the approved tools and
 * `denied_tool_ids` the rest; the preflight also reports `model_still_available` against a
 * current catalog, with the stale code `model_no_longer_available` the reference plugin uses.
 */
import { DEFAULT_PRESET } from "./authorization.js";
import { canonicalJson } from "./canonical.js";
import { conversationRecords } from "./conversation/declarations.js";
import { consentPlan, type ConsentPolicy } from "./policies/consent.js";
import { CoreError } from "./errors.js";
import type { EvaluationLayers, PublisherReport } from "./evaluation.js";
import { sha256Hex } from "./hash.js";
import { grantStaleness, grantsReport, resourceRegistryReference, resourceToolBlockers, type ResourceRegistry } from "./hostresources.js";
import {
  AMBIGUOUS as TOOL_AMBIGUOUS,
  BOUND as TOOL_BOUND,
  INCOMPATIBLE as TOOL_INCOMPATIBLE,
  UNAVAILABLE as TOOL_UNAVAILABLE,
  UNBOUND as TOOL_UNBOUND,
  UNVERIFIED as TOOL_UNVERIFIED,
  planToolBindings,
  toolRegistryReference,
  type RegistryEvaluation,
  type ToolRegistry,
} from "./hosttools.js";
import { catalogReference, INCOMPATIBLE, stillAvailable, UNVERIFIED, type CatalogEvaluation, type HostCatalog, type ModelCompatibility, type ModelDescriptor } from "./compatibility.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { Package } from "./package.js";
import { pyRepr } from "./repr.js";
import type { TrustState } from "./trust.js";
import { modelPolicyReasons, type ActivePolicy } from "./policies/apply.js";
import { policyLabel, samePolicy } from "./policies/bundle.js";
import {
  BINDING_SINGLE_MODEL,
  DENY,
  MODE_MODEL,
  MODE_TOOL_PROBE,
  RUN_PLAN_SCHEMA,
  RUN_PLAN_VERSION,
  type AuthorizationReceipt,
  type BrowserPolicy,
  type ConversationPlan,
  type ExecutionMode,
  type PresetId,
  type Provenance,
  type Reason,
  type RunPlan,
  type RunPlanPreflight,
  type SourceRef,
} from "./types.js";

export { BINDING_SINGLE_MODEL, MODE_MODEL, MODE_TOOL_PROBE, RUN_PLAN_SCHEMA, RUN_PLAN_VERSION };
export const EXECUTION_MODES: readonly ExecutionMode[] = Object.freeze([MODE_MODEL, MODE_TOOL_PROBE]);
export const BINDING_STRATEGIES: readonly string[] = Object.freeze([BINDING_SINGLE_MODEL]);

/** Permission kinds a run mode needs on top of whatever the package marked required. */
export const MODE_REQUIRED_PERMISSION_KINDS: Readonly<Record<ExecutionMode, readonly string[]>> = Object.freeze({ [MODE_MODEL]: ["model"], [MODE_TOOL_PROBE]: [] });

const str = (value: JsonValue | undefined): string => String(value);
const reason = (code: string, message: string, subject: string | null = null): Reason => ({ code, message, subject });
const sortedKeys = <T,>(record: Record<string, T>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
};

export function modePermissionIds(pkg: Package, mode: ExecutionMode): string[] {
  const kinds = MODE_REQUIRED_PERMISSION_KINDS[mode] ?? [];
  return (pkg.policy.permissions as JsonObject[])
    .filter((permission) => kinds.includes(str(permission.kind)))
    .map((permission) => str(permission.id))
    .sort();
}

export function validateMode(mode: unknown): ExecutionMode {
  if (mode !== MODE_MODEL && mode !== MODE_TOOL_PROBE) {
    throw new CoreError("unsupported_execution_mode", `execution_mode must be one of ${pyRepr([...EXECUTION_MODES])}; got ${pyRepr(mode)}`);
  }
  return mode;
}

export function validateBinding(strategy: unknown): typeof BINDING_SINGLE_MODEL {
  if (strategy !== BINDING_SINGLE_MODEL) {
    throw new CoreError("unsupported_binding_strategy", `binding_strategy must be one of ${pyRepr([...BINDING_STRATEGIES])}; got ${pyRepr(strategy)}`);
  }
  return strategy;
}

const TOOL_BLOCKERS: Record<string, [code: string, message: string]> = {
  [TOOL_UNBOUND]: ["tool_not_bound", "This host registers no implementation for tool {tool}. The package declares what it needs; a host that cannot supply it cannot run the package."],
  [TOOL_INCOMPATIBLE]: ["tool_contract_mismatch", "The host implementation of tool {tool} does not satisfy the contract the package declares."],
  [TOOL_AMBIGUOUS]: ["tool_binding_ambiguous", "This host registers more than one implementation for tool {tool}; exactly one must satisfy a declaration."],
  [TOOL_UNAVAILABLE]: ["tool_unavailable", "The host implementation of tool {tool} is registered but not currently usable."],
};

/** A denied tool (D-022): declared, not approved; the runtime refuses any call to it. */
export function deniedToolIds(pkg: Package, approvals: Record<string, boolean>): string[] {
  return Object.keys(pkg.tools)
    .filter((toolId) => approvals[toolId] !== true)
    .sort();
}

/**
 * `tool_blockers`: every reason an *approved* declared tool is not ready to be bound into a
 * plan. Three facts kept separate: is there an implementation, did the person approve that
 * implementation (a denied tool is skipped here, D-022), and are its permissions granted.
 */
export function toolBlockers(
  evaluation: RegistryEvaluation | null,
  options: { receipt: AuthorizationReceipt; policy: BrowserPolicy; only?: string | null },
): Reason[] {
  if (evaluation === null) {
    return [reason("tool_registry_missing", "This package declares tools, and no host tool registry was supplied, so no implementation can be bound.")];
  }
  const reasons: Reason[] = [];
  for (const tool of evaluation.tools) {
    const subject = tool.tool_id;
    if (options.only !== undefined && options.only !== null && subject !== options.only) continue;
    if (options.receipt.tool_approvals[subject] !== true) continue; // denied (D-022): never runs, blocks nothing
    const blocker = TOOL_BLOCKERS[tool.status];
    if (blocker) {
      const [code, message] = blocker;
      reasons.push(reason(code, message.replace("{tool}", subject) + (tool.reason ? ` ${tool.reason}` : ""), subject));
      continue;
    }
    if (tool.status === TOOL_UNVERIFIED && options.policy.require_confirmed_tool_contract) {
      const unknown = (tool.binding?.unknown ?? []).join(", ") || "its contract";
      reasons.push(reason("tool_contract_unverified", `This host does not state enough about its implementation of ${subject} to confirm ${unknown}.`, subject));
      continue;
    }
    for (const permissionId of tool.required_permission_ids) {
      if ((options.receipt.decisions[permissionId] ?? DENY) === DENY) {
        reasons.push(reason("tool_permission_denied", `Tool ${subject} needs required permission ${pyRepr(permissionId)}, which is denied.`, subject));
      }
    }
    if (tool.permission_ids.length === 0) {
      reasons.push(reason("tool_permission_undeclared", `Tool ${subject} links to no declared permission, so no authority can be checked before it runs.`, subject));
    }
  }
  return reasons;
}

export interface PreparationInputs {
  mode: ExecutionMode;
  evaluation: CatalogEvaluation;
  receipt: AuthorizationReceipt | null;
  publisher: PublisherReport;
  compatibility: ModelCompatibility | null;
  policy: BrowserPolicy;
  toolEvaluation?: RegistryEvaluation | null;
  probeToolId?: string | null;
  resourceRegistry?: ResourceRegistry | null;
}

/** `preparation_blockers`: every reason this run plan may not be prepared or is not ready. */
export function preparationBlockers(pkg: Package, input: PreparationInputs): Reason[] {
  const reasons: Reason[] = [];
  const receipt = input.receipt;
  if (receipt === null) return [reason("authorization_missing", "Authorize the package before preparing a run.")];
  if (receipt.package.digest !== pkg.digest) reasons.push(reason("authorization_package_mismatch", "The authorization receipt was issued for different package bytes."));
  if (!receipt.runnable) {
    for (const blocked of receipt.blocking_reasons) reasons.push(reason("authorization_not_runnable", `Authorization is blocked: ${blocked.message}`, blocked.subject ?? null));
  }
  const requiredIds = modePermissionIds(pkg, input.mode);
  if (requiredIds.length === 0 && MODE_REQUIRED_PERMISSION_KINDS[input.mode].length > 0) {
    reasons.push(reason("execution_mode_permission_undeclared", "This package declares no model permission, so it cannot request a model-backed run."));
  }
  for (const permissionId of requiredIds) {
    if ((receipt.decisions[permissionId] ?? DENY) === DENY) {
      reasons.push(reason("execution_mode_permission_denied", `A model-backed run requires permission ${pyRepr(permissionId)}. Update the permission and authorize again.`, permissionId));
    }
  }
  if (input.policy.require_valid_signature && input.publisher.signature_status !== "valid") {
    reasons.push(reason("signature_not_valid", `Browser policy requires a valid publisher signature (status: ${input.publisher.signature_status}).`));
  }
  if (input.policy.require_trusted_publisher && input.publisher.trust_status !== "trusted") {
    reasons.push(reason("publisher_not_trusted", `Browser policy requires an operator-pinned publisher key (status: ${input.publisher.trust_status}).`));
  }
  const probe = input.probeToolId ?? null;
  if (Object.keys(pkg.tools).length > 0) reasons.push(...toolBlockers(input.toolEvaluation ?? null, { receipt, policy: input.policy, only: probe }));
  reasons.push(...grantStaleness(receipt.resource_grants, input.resourceRegistry ?? null));
  reasons.push(
    ...resourceToolBlockers(input.toolEvaluation?.tools ?? null, receipt, { approvedOnly: true }).filter((item) => probe === null || item.subject === probe),
  );
  if (input.mode === MODE_TOOL_PROBE) {
    if (probe === null) reasons.push(reason("tool_probe_tool_missing", "A tool probe must name the tool it is for."));
    else if (!Object.hasOwn(pkg.tools, probe)) reasons.push(reason("tool_not_declared", `This package declares no tool named ${pyRepr(probe)}.`, probe));
    return reasons;
  }
  const compatibility = input.compatibility;
  if (compatibility === null) {
    reasons.push(reason("model_not_selected", "Select a model for this run."));
    return reasons;
  }
  if (!compatibility.available) reasons.push(reason("model_unavailable", "The selected model is not currently usable on this host.", compatibility.model_id));
  if (!compatibility.selectable) reasons.push(reason("model_not_selectable", "This host does not allow this model to be chosen manually.", compatibility.model_id));
  if (compatibility.status === INCOMPATIBLE) {
    reasons.push(reason("model_incompatible", "The selected model does not satisfy this package's model requirements.", compatibility.model_id));
  } else if (compatibility.status === UNVERIFIED && input.policy.require_confirmed_model_compatibility) {
    const unknown = compatibility.unknown.join(", ") || "one or more requirements";
    reasons.push(reason("model_compatibility_unverified", `This host does not report enough about the selected model to confirm ${unknown}.`, compatibility.model_id));
  }
  if (input.evaluation.package_digest !== pkg.digest) reasons.push(reason("evaluation_package_mismatch", "The compatibility evaluation was computed for different package bytes."));
  return reasons;
}

export interface RunPlanInputs {
  sessionId: string;
  source: SourceRef;
  archiveSha256: string;
  evaluation: CatalogEvaluation;
  catalog: HostCatalog;
  descriptor: ModelDescriptor | null;
  compatibility: ModelCompatibility | null;
  receipt: AuthorizationReceipt;
  publisher: PublisherReport;
  trustState: TrustState;
  evaluationLayers: EvaluationLayers;
  policy: BrowserPolicy;
  instanceId: string;
  mode: ExecutionMode;
  bindingStrategy: typeof BINDING_SINGLE_MODEL;
  expiresAt: string;
  blockingReasons: Reason[];
  toolEvaluation?: RegistryEvaluation | null;
  toolRegistry?: ToolRegistry | null;
  probeToolId?: string | null;
  resourceRegistry?: ResourceRegistry | null;
  /** conversation.v0 (D-271): the subscribed policy's consent section, when one is in force, and the preset in force (the receipt's provenance names it when a preset decided; the host's setting otherwise). */
  consentPolicy?: ConsentPolicy | null;
  consentPreset?: PresetId | null;
  now?: Date;
  runPlanId?: string;
}

/** `build_run_plan`: freeze one decision into a hashed, self-describing artifact. */
export async function buildRunPlan(pkg: Package, input: RunPlanInputs): Promise<RunPlan> {
  const created = input.now ?? new Date();
  const probe = input.probeToolId ?? null;
  const approvals = input.receipt.tool_approvals;
  let bindings = input.toolEvaluation ? planToolBindings(input.toolEvaluation) : [];
  // Only approved tools are bound into the plan (D-022): a denied tool's binding would be
  // authority the plan is not. A probe binds the one tool it is for.
  bindings = bindings.filter((item) => approvals[item.tool_id] === true);
  if (probe !== null) bindings = bindings.filter((item) => item.tool_id === probe);
  const manifest = pkg.manifest;
  const publisherClaim = manifest.publisher as JsonObject;
  const profile = str(pkg.graph.profile ?? manifest.entrypoint);
  const approvedTools = Object.keys(pkg.tools).filter((toolId) => approvals[toolId] === true).sort();
  const plan: Omit<RunPlan, "run_plan_sha256"> = {
    schema: RUN_PLAN_SCHEMA,
    run_plan_version: RUN_PLAN_VERSION,
    run_plan_id: input.runPlanId ?? `rp_${crypto.randomUUID().replace(/-/gu, "")}`,
    created_at: created.toISOString(),
    expires_at: input.expiresAt,
    session_id: input.sessionId,
    control_plane: { service: "chrome-agent-browser-control-plane", api_version: "v0", instance_id: input.instanceId },
    source: { ...input.source },
    package: {
      package_id: str(manifest.package_id),
      name: str(manifest.name),
      version: str(manifest.version),
      digest: pkg.digest,
      archive_sha256: input.archiveSha256,
      entrypoint: str(manifest.entrypoint),
      execution_profile: profile,
    },
    publisher: {
      claimed_id: str(publisherClaim.id),
      claimed_name: str(publisherClaim.name),
      signer_fingerprint: input.publisher.signer_fingerprint,
      signature_status: input.publisher.signature_status,
      trust_status: input.publisher.trust_status,
      trust_reason: input.publisher.trust_reason,
    },
    trust_store: { ...input.trustState },
    validation: { ...input.evaluationLayers, supported_execution_profiles: [...input.evaluationLayers.supported_execution_profiles], errors: input.evaluationLayers.errors.map((error) => ({ ...error })) },
    authorization: {
      receipt_id: input.receipt.receipt_id,
      receipt_sha256: input.receipt.receipt_sha256,
      issued_at: input.receipt.issued_at,
      expires_at: input.receipt.expires_at,
      runnable: input.receipt.runnable,
      decisions: sortedKeys(input.receipt.decisions),
      tool_approvals: sortedKeys(input.receipt.tool_approvals),
      granted_permission_ids: [...input.receipt.granted_permission_ids],
      provenance: input.receipt.provenance ?? null,
    },
    execution: {
      profile,
      mode: input.mode,
      binding_strategy: input.bindingStrategy,
      required_permission_ids: modePermissionIds(pkg, input.mode),
      required_tool_ids: probe !== null ? [probe] : approvedTools,
      denied_tool_ids: deniedToolIds(pkg, approvals),
      probe_tool_id: probe,
      tool_binding_count: bindings.length,
      performed: false,
      note:
        "A run plan is a preflight artifact. This control plane never executes a package; a later runner must re-verify the digest, archive hash, signature, trust, receipt, model availability and every tool binding digest before dispatching anything." +
        (probe !== null ? " This plan is authority for ONE mediated call to one declared tool. It binds no model and is not authority to run this package's graph." : "") +
        " Declared tools the authorization did not approve are listed in denied_tool_ids; the runtime refuses any call to them (D-022).",
      conversation: conversationPlan(pkg, input.consentPreset ?? input.receipt.provenance?.preset ?? DEFAULT_PRESET, input.consentPolicy ?? null),
    },
    tool_bindings: bindings as unknown as RunPlan["tool_bindings"],
    tool_registry: input.toolRegistry ? toolRegistryReference(input.toolRegistry) : null,
    resource_grants: input.receipt.resource_grants.map((grant) => ({ ...grant })),
    resource_registry: resourceRegistryReference(input.resourceRegistry ?? null),
    model_binding:
      input.descriptor === null || input.compatibility === null
        ? null
        : {
            strategy: input.bindingStrategy,
            selected_at: created.toISOString(),
            host_model_id: input.descriptor.id,
            provider_id: input.descriptor.provider_id,
            model_id: input.descriptor.model_id,
            display_name: input.descriptor.display_name,
            descriptor: input.descriptor as unknown as JsonObject,
            compatibility: input.compatibility as unknown as JsonObject,
            catalog: catalogReference(input.catalog) as unknown as JsonObject,
          },
    model_requirements: input.evaluation.requirements as unknown as JsonObject,
    browser_policy: { ...input.policy },
    readiness: {
      state: input.blockingReasons.length === 0 ? "ready" : "blocked",
      ready: input.blockingReasons.length === 0,
      compatibility_status: input.compatibility ? input.compatibility.status : null,
      blocking_reasons: input.blockingReasons,
    },
  };
  return { ...plan, run_plan_sha256: await sha256Hex(canonicalJson(plan)) };
}

/**
 * `tool_staleness`: whether every tool this plan bound is still exactly that implementation.
 * A binding whose digest moved is a different implementation, even under the same name.
 */
export function toolStaleness(plan: RunPlan, evaluation: RegistryEvaluation | null): Reason[] {
  const bound = plan.tool_bindings;
  if (bound.length === 0) return [];
  if (evaluation === null) {
    return [reason("tool_registry_unknown", "This plan bound host tool implementations, and no current host tool registry has been supplied to compare them against.")];
  }
  const current = new Map(evaluation.tools.map((tool) => [tool.tool_id, tool]));
  const reasons: Reason[] = [];
  for (const binding of bound) {
    const toolId = binding.tool_id;
    const tool = current.get(toolId);
    if (!tool || tool.binding === null) {
      reasons.push(reason("tool_binding_removed", `This host no longer registers an implementation for ${toolId}.`, toolId));
      continue;
    }
    const live = tool.binding;
    if (live.binding_id !== binding.binding_id) reasons.push(reason("tool_binding_replaced", `A different implementation now satisfies ${toolId}.`, toolId));
    else if (live.binding_sha256 !== binding.binding_sha256) {
      reasons.push(reason("tool_binding_changed", `The host implementation of ${toolId} changed after this plan was prepared, so it is no longer the one that was approved.`, toolId));
    }
    if (tool.contract_sha256 !== binding.contract_sha256) reasons.push(reason("tool_contract_changed", `The contract ${toolId} was matched against is no longer the current one.`, toolId));
    if (tool.status === TOOL_UNAVAILABLE) reasons.push(reason("tool_unavailable", `The host implementation of ${toolId} is no longer usable.`, toolId));
    else if (tool.status !== TOOL_BOUND) reasons.push(reason("tool_binding_stale", `The host implementation of ${toolId} is now ${tool.status}.`, toolId));
  }
  return reasons;
}

export interface PreflightInputs {
  pkg: Package;
  publisher: PublisherReport;
  receipt: AuthorizationReceipt | null;
  trustState: TrustState;
  policy: BrowserPolicy;
  toolEvaluation?: RegistryEvaluation | null;
  resourceRegistry?: ResourceRegistry | null;
  /** The host's current model catalog; null when unknown (unknown is not unavailable). */
  catalog?: HostCatalog | null;
  onceSpent?: boolean;
  /** The host preset allows local models only now (D-050); a plan bound to another model is stale. */
  localModelsOnly?: boolean;
  /**
   * The policy subscription in force now (T8, D-102): null for none, absent when the caller does
   * not take part (the reference's semantics). A plan authorized under a policy that is gone or
   * changed is stale, and the policy's model constraints apply to every plan.
   */
  subscription?: ActivePolicy | null;
  now?: Date;
}

function parseIso(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `preflight`: recompute whether a frozen plan still describes the current world. Anything
 * that changed in the consent, the identity or the trust evaluation behind a plan makes it
 * stale rather than quietly ready. A stale plan is never repaired here.
 */
export function preflight(plan: RunPlan, input: PreflightInputs): RunPlanPreflight {
  const moment = input.now ?? new Date();
  const reasons: Reason[] = [];
  const receipt = input.receipt;
  if (input.pkg.digest !== plan.package.digest) reasons.push(reason("package_changed", "The session's package bytes are not the planned bytes."));
  if (receipt === null) reasons.push(reason("authorization_cleared", "The authorization receipt is gone."));
  else if (receipt.receipt_id !== plan.authorization.receipt_id) reasons.push(reason("authorization_superseded", "A newer authorization replaced the one this plan was prepared under."));
  else if (receipt.receipt_sha256 !== plan.authorization.receipt_sha256) reasons.push(reason("authorization_changed", "The authorization receipt changed after preparation."));
  const expiry = parseIso(plan.expires_at);
  if (expiry !== null && expiry <= moment.getTime()) reasons.push(reason("run_plan_expired", "This run plan has expired."));
  if (receipt !== null) {
    const receiptExpiry = parseIso(receipt.expires_at);
    if (receiptExpiry !== null && receiptExpiry <= moment.getTime()) reasons.push(reason("authorization_expired", "The authorization receipt has expired."));
  }
  for (const [field, code] of [
    ["signature_status", "signature_status_changed"],
    ["trust_status", "publisher_trust_changed"],
    ["signer_fingerprint", "signer_changed"],
  ] as const) {
    if (input.publisher[field] !== plan.publisher[field]) {
      reasons.push(reason(code, `Publisher ${field.replace(/_/gu, " ")} changed from ${pyRepr(plan.publisher[field])} to ${pyRepr(input.publisher[field])} after preparation.`));
    }
  }
  if (input.policy.require_valid_signature && input.publisher.signature_status !== "valid") reasons.push(reason("signature_not_valid", "The signature is no longer valid."));
  if (input.policy.require_trusted_publisher && input.publisher.trust_status !== "trusted") reasons.push(reason("publisher_not_trusted", "The publisher is no longer trusted."));
  const toolReasons = toolStaleness(plan, input.toolEvaluation ?? null);
  reasons.push(...toolReasons);
  if (receipt !== null) {
    for (const binding of plan.tool_bindings) {
      if (receipt.tool_approvals[binding.tool_id] !== true) reasons.push(reason("tool_approval_withdrawn", `Tool ${binding.tool_id} is no longer approved.`, binding.tool_id));
    }
  }
  const resourceReasons = grantStaleness(plan.resource_grants, input.resourceRegistry ?? null);
  reasons.push(...resourceReasons);
  // The reference plugin's check: the catalog still offers the planned model as a usable choice.
  let modelStillAvailable: boolean | null = null;
  if (plan.model_binding !== null && input.catalog !== undefined && input.catalog !== null) {
    modelStillAvailable = stillAvailable(input.catalog, plan.model_binding.host_model_id);
    if (!modelStillAvailable) {
      reasons.push(reason("model_no_longer_available", `This host no longer offers ${plan.model_binding.host_model_id} as a usable choice, so the run plan's model cannot be invoked. Prepare a new plan with a model this host offers.`, plan.model_binding.host_model_id));
    }
  }
  // A Chrome addition (D-050, D-053): a preset that allows local models only applies to plans
  // prepared before it was chosen, not only to new ones.
  if (input.localModelsOnly === true && plan.model_binding !== null && (plan.model_binding.descriptor.properties as JsonObject | undefined)?.local !== true) {
    reasons.push(reason("model_not_local", `The current preset allows local models only, and this plan binds ${plan.model_binding.host_model_id}, which is not local. Prepare a new plan with a local model, or change the preset in Settings → Policies.`, plan.model_binding.host_model_id));
  }
  if (input.subscription !== undefined) {
    const planned = (plan.authorization.provenance as Provenance | null | undefined)?.policy ?? null;
    const current = input.subscription?.reference ?? null;
    if (planned !== null && !samePolicy(planned, current)) {
      reasons.push(
        current === null
          ? reason("policy_withdrawn", `This plan was authorized under the policy ${planned.title} (${policyLabel(planned)}), which no longer applies (unsubscribed or expired). Authorize again.`)
          : reason("policy_changed", `This plan was authorized under the policy ${policyLabel(planned)}; the policy in force is now ${policyLabel(current)}. Authorize again.`),
      );
    }
    if (plan.model_binding !== null) {
      reasons.push(...modelPolicyReasons(input.subscription, { id: plan.model_binding.host_model_id, properties: (plan.model_binding.descriptor.properties ?? {}) as { local?: unknown; cost_class?: unknown } }));
    }
  }
  if (input.onceSpent) {
    reasons.push(reason("authorization_once_spent", "This authorization granted something once, and a run has already used it. Authorize again to run again."));
  }
  const stale = reasons.length > 0;
  const toolEvaluation = input.toolEvaluation ?? null;
  return {
    schema: "agentpkg-run-plan-preflight-v0",
    checked_at: moment.toISOString(),
    run_plan_id: plan.run_plan_id,
    run_plan_sha256: plan.run_plan_sha256,
    state: stale ? "stale" : plan.readiness.state,
    ready: !stale && plan.readiness.ready,
    stale,
    stale_reasons: reasons,
    blocking_reasons: [...plan.readiness.blocking_reasons],
    trust_store_changed: input.trustState.state_sha256 !== plan.trust_store.state_sha256,
    tool_bindings: {
      bound: plan.tool_bindings.length,
      current: toolReasons.length === 0,
      evaluated: toolEvaluation !== null,
      registry_sha256: toolEvaluation ? toolEvaluation.registry.registry_sha256 : null,
      // As in the reference plugin, `captured_at` is inside the hashed registry, so this is true
      // whenever the registry was rebuilt, changed or not; staleness compares binding digests
      // instead (BACKLOG B-113, T3 review 1, nit 14).
      registry_changed: Boolean(toolEvaluation && plan.tool_registry && toolEvaluation.registry.registry_sha256 !== plan.tool_registry.registry_sha256),
    },
    resource_grants: grantsReport(plan.resource_grants, input.resourceRegistry ?? null),
    model_still_available: modelStillAvailable,
    execution: { performed: false, note: "Execution is not implemented in this build." },
  };
}

/** Whether a receipt grants anything `once`; the first run under it spends it (control.py). */
export function grantsOnce(receipt: Pick<AuthorizationReceipt, "decisions">): boolean {
  return Object.values(receipt.decisions).includes("once");
}

/** conversation.v0 (D-270): what the plan records about a conversational package, with D-271's pre-decisions; null for a one-shot package. */
export function conversationPlan(pkg: Package, preset: PresetId, policy: ConsentPolicy | null): ConversationPlan | null {
  const records = conversationRecords(pkg);
  if (records === null) return null;
  return {
    max_turns: records.budget.max_turns,
    hard_tokens: records.budget.hard_tokens,
    max_remote_calls: records.budget.max_remote_calls,
    max_calls_per_tool: { ...records.budget.max_calls_per_tool },
    persistent_keys: [...records.persistent_keys],
    consent_steps: consentPlan(pkg, preset, policy),
    gated_permissions: Object.fromEntries(Object.entries(records.gated_permissions).map(([permission, steps]) => [permission, [...steps]])),
  };
}
