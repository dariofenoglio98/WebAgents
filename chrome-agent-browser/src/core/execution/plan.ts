/**
 * The bounded run-plan facts a runner is allowed to see (`execution/session.py::
 * normalize_execution_plan` / `normalize_authorization`), and the projection of T3's full Run Plan
 * onto them. Stricter than the control plane's own view on purpose: a runner that will verify the
 * artifact it received needs the complete identity to verify it against, so every field here is
 * required rather than nullable. The projection is the reference plugin's (`preflight.ts`): the
 * model binding lifts the descriptor's capabilities, limits and local flag beside the
 * compatibility verdict; tool bindings and resource grants pass through unchanged.
 */
import { canonicalJson } from "../canonical.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import { normalizeModelBinding, type ModelBindingDescriptor } from "../models/binding.js";
import type { Package } from "../package.js";
import { pyIsoTimestamp } from "../pyjson.js";
import { conversationPlan } from "../runplan.js";
import { normalizeToolBindings, type ToolBindingRecord } from "../tools/bindings.js";
import { MODE_MODEL, MODE_TOOL_PROBE, type ConversationPlan, type ExecutionMode, type ModelBinding, type ResourceGrant, type RunPlan } from "../types.js";
import { ExecutionError, invalid, TOOL_NOT_BOUND } from "./errors.js";
import { normalizeResourceGrants } from "./policy.js";

export const MAX_PLAN_TEXT = 512;
export const MAX_PLAN_IDS = 64;

export interface ExecutionPlan {
  run_plan_id: string;
  run_plan_sha256: string;
  session_id: string | null;
  package: { package_id: string; name: string | null; version: string; digest: string; archive_sha256: string; execution_profile: string | null };
  publisher: { signer_fingerprint: string; signature_status: string | null; trust_status: string | null };
  execution: {
    mode: ExecutionMode;
    profile: string | null;
    probe_tool_id: string | null;
    required_permission_ids: string[];
    required_tool_ids: string[];
    /** Chrome addition: the package's own fixture supplies the model and every tool; no binding is frozen. */
    fixture: boolean;
    /** Chrome addition (D-022): declared tools the receipt did not approve; the runtime refuses calls to them. */
    denied_tool_ids: string[];
    /** conversation.v0 (D-270): the conversation's budget, persistent keys and consent steps with their pre-decisions; null for a one-shot package. */
    conversation: ConversationPlan | null;
  };
  model_binding: ModelBindingDescriptor | null;
  tool_bindings: ToolBindingRecord[];
  resource_grants: ResourceGrant[];
}

export interface ExecutionAuthorization {
  receipt_id: string;
  receipt_sha256: string;
  issued_at: string | null;
  expires_at: string | null;
  decisions: Record<string, string>;
  tool_approvals: Record<string, boolean>;
}

function fields(value: unknown, field: string, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) throw invalid(`Unknown fields in ${field}: [${unknown.map((key) => `'${key}'`).join(", ")}]`);
  const missing = required.filter((key) => !Object.hasOwn(record, key)).sort();
  if (missing.length > 0) throw invalid(`Missing fields in ${field}: [${missing.map((key) => `'${key}'`).join(", ")}]`);
  return record;
}

function text(value: unknown, field: string, options: { limit?: number; allowNull?: boolean } = {}): string | null {
  if ((value === null || value === undefined) && options.allowNull) return null;
  const limit = options.limit ?? MAX_PLAN_TEXT;
  if (typeof value !== "string" || value.length === 0 || value.length > limit) throw invalid(`${field} must be a string of 1 to ${limit} characters`);
  return value;
}

function idList(value: unknown, field: string): string[] {
  const list = (value ?? []) as unknown;
  if (!Array.isArray(list) || list.length > MAX_PLAN_IDS) throw invalid(`${field} must be a bounded list`);
  return list.map((item) => text(item, `${field}[]`, { limit: 200 })!);
}

/** The bounded facts, all required, with the plan's tool bindings normalized and every required tool bound. */
export function normalizeExecutionPlan(raw: unknown): ExecutionPlan {
  const record = fields(raw, "run_plan", ["run_plan_id", "run_plan_sha256", "session_id", "package", "publisher", "execution", "model_binding", "tool_bindings", "resource_grants"], ["run_plan_id", "run_plan_sha256", "package", "publisher", "execution"]);
  const pkg = fields(record.package, "run_plan.package", ["package_id", "name", "version", "digest", "archive_sha256", "execution_profile"], ["package_id", "version", "digest", "archive_sha256"]);
  const publisher = fields(record.publisher, "run_plan.publisher", ["signer_fingerprint", "signature_status", "trust_status"], ["signer_fingerprint"]);
  const execution = fields(record.execution, "run_plan.execution", ["mode", "profile", "required_permission_ids", "required_tool_ids", "probe_tool_id", "tool_binding_count", "fixture", "denied_tool_ids", "conversation"], ["mode"]);
  const mode = execution.mode;
  if (mode !== MODE_MODEL && mode !== MODE_TOOL_PROBE) throw invalid("A run plan must be model-backed or a tool probe");
  const fixture = execution.fixture === true;
  if (mode === MODE_MODEL && !fixture && !Object.hasOwn(record, "model_binding")) throw invalid("Missing fields in run_plan: ['model_binding']");
  if (mode === MODE_TOOL_PROBE && (record.model_binding ?? null) !== null) {
    // A probe that carried a model binding could construct a router; "no model was called" must be a property.
    throw invalid("A tool_probe run plan binds no model");
  }
  if (fixture) {
    if ((record.model_binding ?? null) !== null) throw invalid("A fixture run plan binds no host model; the package's own fixture answers");
    if (Array.isArray(record.tool_bindings) && record.tool_bindings.length > 0) throw invalid("A fixture run plan binds no host tool; the package's own fixture answers");
  }
  const bindings = normalizeToolBindings(record.tool_bindings);
  const requiredTools = [...new Set(idList(execution.required_tool_ids, "run_plan.execution.required_tool_ids"))].sort();
  const bound = new Set(bindings.map((binding) => binding.tool_id));
  const missing = requiredTools.filter((toolId) => !bound.has(toolId));
  if (missing.length > 0 && !fixture) throw new ExecutionError(TOOL_NOT_BOUND, "The run plan names tools it binds no implementation for", { detail: { tool_ids: missing } });
  return {
    run_plan_id: text(record.run_plan_id, "run_plan_id", { limit: 128 })!,
    run_plan_sha256: text(record.run_plan_sha256, "run_plan_sha256", { limit: 128 })!,
    session_id: text(record.session_id, "session_id", { limit: 128, allowNull: true }),
    package: {
      package_id: text(pkg.package_id, "package.package_id", { limit: 200 })!,
      name: text(pkg.name, "package.name", { allowNull: true }),
      version: text(pkg.version, "package.version", { limit: 64 })!,
      digest: text(pkg.digest, "package.digest", { limit: 128 })!,
      archive_sha256: text(pkg.archive_sha256, "package.archive_sha256", { limit: 128 })!,
      execution_profile: text(pkg.execution_profile, "package.execution_profile", { limit: 64, allowNull: true }),
    },
    publisher: {
      signer_fingerprint: text(publisher.signer_fingerprint, "publisher.signer_fingerprint", { limit: 128 })!,
      signature_status: text(publisher.signature_status, "publisher.signature_status", { limit: 64, allowNull: true }),
      trust_status: text(publisher.trust_status, "publisher.trust_status", { limit: 64, allowNull: true }),
    },
    execution: {
      mode,
      profile: text(execution.profile, "execution.profile", { limit: 64, allowNull: true }),
      probe_tool_id: text(execution.probe_tool_id, "execution.probe_tool_id", { limit: 200, allowNull: true }),
      required_permission_ids: idList(execution.required_permission_ids, "run_plan.execution.required_permission_ids"),
      required_tool_ids: requiredTools,
      fixture,
      denied_tool_ids: [...new Set(idList(execution.denied_tool_ids, "run_plan.execution.denied_tool_ids"))].sort(),
      conversation: normalizeConversationPlan(execution.conversation),
    },
    model_binding: mode === MODE_MODEL && !fixture ? normalizeModelBinding(record.model_binding) : null,
    tool_bindings: bindings,
    resource_grants: normalizeResourceGrants(record.resource_grants),
  };
}

/** conversation.v0 (D-270): the plan's conversation section, every field bounded; null when the package is one-shot. */
export function normalizeConversationPlan(raw: unknown): ConversationPlan | null {
  if (raw === undefined || raw === null) return null;
  const record = fields(raw, "run_plan.execution.conversation", ["max_turns", "hard_tokens", "max_remote_calls", "max_calls_per_tool", "persistent_keys", "consent_steps", "gated_permissions"], ["max_turns", "hard_tokens", "max_remote_calls", "persistent_keys", "consent_steps", "gated_permissions"]);
  const count = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(`${field} must be a nonnegative integer`);
    return value;
  };
  const caps: Record<string, number> = {};
  const rawCaps = (record.max_calls_per_tool ?? {}) as Record<string, unknown>;
  if (typeof rawCaps !== "object" || rawCaps === null || Array.isArray(rawCaps) || Object.keys(rawCaps).length > MAX_PLAN_IDS) throw invalid("run_plan.execution.conversation.max_calls_per_tool must be a bounded object");
  for (const key of Object.keys(rawCaps).sort()) caps[text(key, "conversation.max_calls_per_tool key", { limit: 200 })!] = count(rawCaps[key], `conversation.max_calls_per_tool[${key}]`);
  const steps = record.consent_steps;
  if (!Array.isArray(steps) || steps.length > MAX_PLAN_IDS) throw invalid("run_plan.execution.conversation.consent_steps must be a bounded list");
  const consentSteps = steps.map((item, index) => {
    const step = fields(item, `conversation.consent_steps[${index}]`, ["id", "permissions", "kinds", "pre_decided"], ["id", "permissions", "kinds", "pre_decided"]);
    const preDecided = step.pre_decided;
    let decided: ConversationPlan["consent_steps"][number]["pre_decided"] = null;
    if (preDecided !== null) {
      const decision = fields(preDecided, `conversation.consent_steps[${index}].pre_decided`, ["accepted", "decided_by", "reason"], ["accepted", "decided_by"]);
      if (typeof decision.accepted !== "boolean" || (decision.decided_by !== "preset" && decision.decided_by !== "policy")) throw invalid(`conversation.consent_steps[${index}].pre_decided must name a boolean and preset or policy`);
      decided = { accepted: decision.accepted, decided_by: decision.decided_by, reason: text(decision.reason, "pre_decided.reason", { limit: 64, allowNull: true }) };
    }
    return { id: text(step.id, "consent_steps[].id", { limit: 200 })!, permissions: idList(step.permissions, "consent_steps[].permissions"), kinds: idList(step.kinds, "consent_steps[].kinds"), pre_decided: decided };
  });
  const gatedRaw = record.gated_permissions as Record<string, unknown>;
  if (typeof gatedRaw !== "object" || gatedRaw === null || Array.isArray(gatedRaw) || Object.keys(gatedRaw).length > MAX_PLAN_IDS) throw invalid("run_plan.execution.conversation.gated_permissions must be a bounded object");
  const gated: Record<string, string[]> = {};
  for (const key of Object.keys(gatedRaw).sort()) gated[text(key, "gated_permissions key", { limit: 200 })!] = idList(gatedRaw[key], `gated_permissions[${key}]`);
  return {
    max_turns: count(record.max_turns, "conversation.max_turns"),
    hard_tokens: count(record.hard_tokens, "conversation.hard_tokens"),
    max_remote_calls: count(record.max_remote_calls, "conversation.max_remote_calls"),
    max_calls_per_tool: caps,
    persistent_keys: idList(record.persistent_keys, "conversation.persistent_keys"),
    consent_steps: consentSteps,
    gated_permissions: gated,
  };
}

/** The consent record this run is carried out under, as the person left it. */
export function normalizeAuthorization(raw: unknown): ExecutionAuthorization {
  const record = fields(raw, "authorization", ["receipt_id", "receipt_sha256", "issued_at", "expires_at", "decisions", "tool_approvals"], ["receipt_id", "receipt_sha256", "decisions"]);
  const decisions = record.decisions;
  if (typeof decisions !== "object" || decisions === null || Array.isArray(decisions) || Object.keys(decisions).length > MAX_PLAN_IDS) throw invalid("authorization.decisions must be a bounded object");
  const approvals = (record.tool_approvals ?? {}) as unknown;
  if (typeof approvals !== "object" || approvals === null || Array.isArray(approvals) || Object.keys(approvals).length > MAX_PLAN_IDS) throw invalid("authorization.tool_approvals must be a bounded object");
  if (Object.values(approvals as Record<string, unknown>).some((value) => typeof value !== "boolean")) {
    // A missing or non-boolean approval is not a quiet `false`: consent was assembled from somewhere other than a receipt.
    throw invalid("authorization.tool_approvals values must be true or false");
  }
  const outDecisions: Record<string, string> = {};
  for (const key of Object.keys(decisions as Record<string, unknown>).sort()) {
    outDecisions[text(key, "authorization.decisions key", { limit: 200 })!] = text((decisions as Record<string, unknown>)[key], `authorization.decisions[${key}]`, { limit: 32 })!;
  }
  const outApprovals: Record<string, boolean> = {};
  for (const key of Object.keys(approvals as Record<string, unknown>).sort()) outApprovals[text(key, "authorization.tool_approvals key", { limit: 200 })!] = (approvals as Record<string, boolean>)[key]!;
  return {
    receipt_id: text(record.receipt_id, "authorization.receipt_id", { limit: 128 })!,
    receipt_sha256: text(record.receipt_sha256, "authorization.receipt_sha256", { limit: 128 })!,
    issued_at: text(record.issued_at, "authorization.issued_at", { limit: 64, allowNull: true }),
    expires_at: text(record.expires_at, "authorization.expires_at", { limit: 64, allowNull: true }),
    decisions: outDecisions,
    tool_approvals: outApprovals,
  };
}

/** `preflight.ts`'s projection of a plan's model binding onto the runner's descriptor. */
export function modelBindingFromPlan(binding: ModelBinding): ModelBindingDescriptor {
  const descriptor = binding.descriptor;
  const compatibility = binding.compatibility;
  const capabilities: Record<string, JsonValue> = {};
  for (const [name, answer] of Object.entries((descriptor.capabilities as JsonObject | undefined) ?? {})) {
    const record = answer as JsonObject;
    capabilities[name] = { value: record.value ?? null, basis: record.basis ?? null };
  }
  const limits = (descriptor.limits as JsonObject | undefined) ?? {};
  const properties = (descriptor.properties as JsonObject | undefined) ?? {};
  return normalizeModelBinding({
    host_model_id: binding.host_model_id,
    provider_id: binding.provider_id,
    model_id: binding.model_id,
    display_name: binding.display_name,
    compatibility_status: compatibility.status ?? null,
    evidence_strength: compatibility.evidence_strength ?? null,
    capabilities,
    limits: { context_tokens: limits.context_tokens ?? null, native_context_window: limits.native_context_window ?? null, max_output_tokens: limits.max_output_tokens ?? null },
    properties: { local: properties.local ?? null },
    pricing: descriptor.pricing ?? null,
  });
}

/** T3's full Run Plan, projected onto the facts the runner may see. */
export function executionPlanFromRunPlan(plan: RunPlan): ExecutionPlan {
  const denied = (plan.execution as { denied_tool_ids?: string[] }).denied_tool_ids ?? [];
  return normalizeExecutionPlan({
    run_plan_id: plan.run_plan_id,
    run_plan_sha256: plan.run_plan_sha256,
    session_id: plan.session_id,
    package: {
      package_id: plan.package.package_id,
      name: plan.package.name ?? null,
      version: plan.package.version,
      digest: plan.package.digest,
      archive_sha256: plan.package.archive_sha256,
      execution_profile: plan.package.execution_profile ?? null,
    },
    publisher: { signer_fingerprint: plan.publisher.signer_fingerprint, signature_status: plan.publisher.signature_status ?? null, trust_status: plan.publisher.trust_status ?? null },
    execution: {
      mode: plan.execution.mode,
      profile: plan.execution.profile,
      required_permission_ids: plan.execution.required_permission_ids,
      required_tool_ids: plan.execution.required_tool_ids,
      probe_tool_id: plan.execution.probe_tool_id,
      tool_binding_count: plan.execution.tool_binding_count,
      denied_tool_ids: denied,
      conversation: (plan.execution as { conversation?: ConversationPlan | null }).conversation ?? null,
    },
    model_binding: plan.model_binding === null ? null : modelBindingFromPlan(plan.model_binding),
    tool_bindings: plan.tool_bindings,
    resource_grants: plan.resource_grants,
  });
}

/** The receipt facts a plan froze (hash-bound to the receipt), as the runner's authorization. */
export function authorizationFromRunPlan(plan: RunPlan): ExecutionAuthorization {
  return normalizeAuthorization({
    receipt_id: plan.authorization.receipt_id,
    receipt_sha256: plan.authorization.receipt_sha256,
    issued_at: plan.authorization.issued_at,
    expires_at: plan.authorization.expires_at,
    decisions: plan.authorization.decisions,
    tool_approvals: plan.authorization.tool_approvals,
  });
}

export interface LocalPlanInputs {
  pkg: Package;
  archiveSha256: string;
  signerFingerprint: string;
  /** The operator's grants file (`agentpkg run --grants`), one decision per declared permission. */
  decisions: Readonly<Record<string, string>>;
  /** `--approve-tool`, as a set: every other declared tool is denied (D-022). */
  approvedTools: readonly string[];
  fixture: boolean;
  modelBinding?: ModelBindingDescriptor | null;
  toolBindings?: readonly ToolBindingRecord[];
  resourceGrants?: readonly ResourceGrant[];
  now?: Date;
  runPlanId?: string;
  sessionId?: string | null;
}

export const LOCAL_PLAN_SCHEMA = "chrome-agent-browser-local-run-plan-v0";

/**
 * A plan for a run with no control plane behind it (the CLI, `agentpkg run`'s shape): the operator
 * is the host, the grants file is the receipt, and `--approve-tool` is the approval. The plan is
 * still hashed over its facts, so the run record names what the run was bound to. A fixture plan
 * binds nothing; a live plan binds the operator's model and the tool definitions it supplied.
 */
export function localExecutionPlan(input: LocalPlanInputs): { plan: ExecutionPlan; authorization: ExecutionAuthorization } {
  const pkg = input.pkg;
  const now = input.now ?? new Date();
  const declared = Object.keys(pkg.tools).sort();
  const approved = [...new Set(input.approvedTools)].sort();
  const unknown = approved.filter((toolId) => !declared.includes(toolId));
  if (unknown.length > 0) throw invalid(`--approve-tool names tools this package does not declare: [${unknown.map((item) => `'${item}'`).join(", ")}]`);
  const bindings = input.fixture ? [] : [...(input.toolBindings ?? [])];
  const bound = new Set(bindings.map((binding) => binding.tool_id));
  const notApproved = bindings.filter((binding) => !approved.includes(binding.tool_id)).map((binding) => binding.tool_id);
  if (notApproved.length > 0) throw new ExecutionError("tool_not_approved", `Bindings were supplied for tools that are not approved: [${notApproved.map((item) => `'${item}'`).join(", ")}]`, { detail: { tool_ids: notApproved } });
  const requiredPermissions = (pkg.policy.permissions as JsonObject[]).filter((permission) => permission.kind === "model").map((permission) => String(permission.id)).sort();
  const approvals: Record<string, boolean> = {};
  for (const toolId of declared) approvals[toolId] = approved.includes(toolId);
  const decisions: Record<string, string> = {};
  for (const key of Object.keys(input.decisions).sort()) decisions[key] = input.decisions[key]!;
  const facts = {
    schema: LOCAL_PLAN_SCHEMA,
    package: { package_id: String(pkg.manifest.package_id), version: String(pkg.manifest.version), digest: pkg.digest, archive_sha256: input.archiveSha256 },
    publisher: { signer_fingerprint: input.signerFingerprint },
    decisions,
    tool_approvals: approvals,
    fixture: input.fixture,
    model_binding: (input.modelBinding ?? null) as unknown as JsonValue,
    tool_bindings: bindings as unknown as JsonValue,
    resource_grants: [...(input.resourceGrants ?? [])] as unknown as JsonValue,
    created_at: pyIsoTimestamp(now),
  };
  const sha = sha256HexSync(canonicalJson(facts));
  const runPlanId = input.runPlanId ?? `local_${sha.slice(0, 32)}`;
  const plan = normalizeExecutionPlan({
    run_plan_id: runPlanId,
    run_plan_sha256: sha,
    session_id: input.sessionId ?? null,
    package: { ...facts.package, name: (pkg.manifest.name as string | undefined) ?? null, execution_profile: String(pkg.graph.profile ?? pkg.manifest.entrypoint) },
    publisher: { signer_fingerprint: input.signerFingerprint, signature_status: "valid", trust_status: null },
    execution: {
      mode: MODE_MODEL,
      profile: String(pkg.graph.profile ?? pkg.manifest.entrypoint),
      required_permission_ids: requiredPermissions,
      required_tool_ids: input.fixture ? approved : approved.filter((toolId) => bound.has(toolId)),
      probe_tool_id: null,
      tool_binding_count: bindings.length,
      fixture: input.fixture,
      denied_tool_ids: declared.filter((toolId) => !approved.includes(toolId)),
      // The operator's grants are the whole conversation's; no preset or policy pre-decides a step here.
      conversation: conversationPlan(pkg, "balanced", null),
    },
    model_binding: input.fixture ? null : (input.modelBinding ?? null),
    tool_bindings: bindings,
    resource_grants: [...(input.resourceGrants ?? [])],
  });
  const authorization = normalizeAuthorization({
    receipt_id: `local:${runPlanId}`,
    receipt_sha256: sha256HexSync(canonicalJson({ schema: LOCAL_PLAN_SCHEMA, decisions, tool_approvals: approvals })),
    issued_at: pyIsoTimestamp(now),
    expires_at: null,
    decisions,
    tool_approvals: approvals,
  });
  return { plan, authorization };
}
