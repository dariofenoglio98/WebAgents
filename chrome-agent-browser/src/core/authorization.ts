/**
 * Authorization drafting and receipts, mirroring `agentpkg/browser/authorization.py`, plus
 * the two Chrome additions of D-022 and D-050: a selected publisher profile expands into
 * ordinary decisions, and a host preset supplies the defaults. Every decision records who made
 * it (D-053).
 *
 * The package REQUESTS authority; the browser GRANTS it. Nothing inside an artifact can raise
 * its own decision above `deny`, and a receipt is bound to the exact bytes it was issued for,
 * so it can never be replayed against a different package that happens to share an ID and
 * version. A profile presents authority and never grants it: choosing one yields exactly the
 * decisions a person could make item by item, with everything outside it denied.
 */
import { canonicalJson } from "./canonical.js";
import { CoreError } from "./errors.js";
import type { EvaluationLayers, PublisherReport } from "./evaluation.js";
import { isRecord } from "./fields.js";
import { sha256Hex } from "./hash.js";
import { resourceRegistryReference, type ResourceRegistry } from "./hostresources.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { Package } from "./package.js";
import { readProfiles, type Profile } from "./profiles.js";
import { pyRepr } from "./repr.js";
import type { TrustState } from "./trust.js";
import {
  DENY,
  PROVENANCE_SCHEMA,
  RECEIPT_SCHEMA,
  REQUEST_SCHEMA,
  SUPPORTED_DECISIONS,
  UNSUPPORTED_DECISIONS,
  type AuthorizationReceipt,
  type BrowserPolicy,
  type DecidedBy,
  type Decision,
  type PolicyReference,
  type PresetId,
  type Provenance,
  type Reason,
  type ResourceGrant,
  type SourceRef,
} from "./types.js";

const str = (value: JsonValue | undefined): string => String(value);
const permissionsOf = (pkg: Package): JsonObject[] => pkg.policy.permissions as JsonObject[];
const sorted = (values: Iterable<string>): string[] => [...values].sort();
function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

// -- the reference semantics ----------------------------------------------------------
/** `initial_decisions`: every declared permission starts denied, required or not. */
export function initialDecisions(pkg: Package): Record<string, Decision> {
  const decisions: Record<string, Decision> = {};
  for (const permission of permissionsOf(pkg)) decisions[str(permission.id)] = DENY;
  return decisions;
}

/**
 * `approval_candidates`: **every declared tool**, not only the side-effecting ones. A
 * permission grant and a tool approval answer different questions: a grant says a class of
 * destination is allowed; an approval says *this exact host implementation of this exact
 * declared tool* may be used.
 */
export function approvalCandidates(pkg: Package): string[] {
  return sorted(Object.values(pkg.tools).map((tool) => str(tool.id)));
}

export function initialToolApprovals(pkg: Package): Record<string, boolean> {
  const approvals: Record<string, boolean> = {};
  for (const toolId of approvalCandidates(pkg)) approvals[toolId] = false;
  return approvals;
}

function linked(pkg: Package, permissionId: string): [tools: string[], domains: string[]] {
  const tools = Object.values(pkg.tools).filter((tool) => (tool.permissions as JsonValue[]).includes(permissionId));
  return [sorted(tools.map((tool) => str(tool.id))), sorted(new Set(tools.flatMap((tool) => (tool.domains as JsonValue[]).map(str))))];
}

export interface AuthorizationRequest {
  schema: typeof REQUEST_SCHEMA;
  session_id: string;
  package_id: string;
  package_version: string;
  package_digest: string;
  decision_model: { supported: Decision[]; default: typeof DENY; unsupported: Record<string, string>; note: string };
  permissions: Array<{ id: string; kind: string; description: string; required: boolean; resources: string[]; decision: Decision; linked_tools: string[]; linked_domains: string[] }>;
  required_permission_ids: string[];
  optional_permission_ids: string[];
  tool_approvals: Array<{ tool_id: string; approval_required: boolean; side_effects: string; execution: string; binding: string; domains: string[]; permissions: string[]; decision: boolean }>;
  tool_approval_note: string;
  network: JsonValue;
  memory: JsonValue;
  budget: JsonValue;
  delegation: JsonValue;
}

/** `build_request`: the machine-readable authorization request a UI renders and answers. */
export function buildRequest(pkg: Package, options: { sessionId: string; decisions: Record<string, Decision>; toolApprovals: Record<string, boolean> }): AuthorizationRequest {
  const permissions = permissionsOf(pkg).map((permission) => {
    const id = str(permission.id);
    const [tools, domains] = linked(pkg, id);
    return {
      id,
      kind: str(permission.kind),
      description: str(permission.description),
      required: permission.required === true,
      resources: (permission.resources as JsonValue[]).map(str),
      decision: options.decisions[id] ?? DENY,
      linked_tools: tools,
      linked_domains: domains,
    };
  });
  const copy = (value: JsonValue | undefined): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  return {
    schema: REQUEST_SCHEMA,
    session_id: options.sessionId,
    package_id: str(pkg.manifest.package_id),
    package_version: str(pkg.manifest.version),
    package_digest: pkg.digest,
    decision_model: {
      supported: [...SUPPORTED_DECISIONS],
      default: DENY,
      unsupported: { ...UNSUPPORTED_DECISIONS },
      note: "Authority is granted per permission ID and expires with this session.",
    },
    permissions,
    required_permission_ids: sorted(permissions.filter((item) => item.required).map((item) => item.id)),
    optional_permission_ids: sorted(permissions.filter((item) => !item.required).map((item) => item.id)),
    tool_approvals: approvalCandidates(pkg).map((toolId) => {
      const tool = pkg.tools[toolId]!;
      return {
        tool_id: toolId,
        approval_required: tool.approval_required === true,
        side_effects: str(tool.side_effects),
        execution: str(tool.execution),
        binding: str(tool.binding),
        domains: (tool.domains as JsonValue[]).map(str),
        permissions: (tool.permissions as JsonValue[]).map(str),
        decision: options.toolApprovals[toolId] === true,
      };
    }),
    tool_approval_note: "Every declared tool needs its own approval. A granted permission describes a class of authority; an approval names one host implementation of one tool.",
    network: copy(pkg.policy.network),
    memory: copy(pkg.policy.memory),
    budget: copy(pkg.policy.budget),
    delegation: copy(pkg.policy.delegation),
  };
}

/** `normalize_decisions`: apply submitted decisions onto the deny-by-default baseline, strictly. */
export function normalizeDecisions(pkg: Package, submitted: unknown): Record<string, Decision> {
  const decisions = initialDecisions(pkg);
  if (submitted === null || submitted === undefined) return decisions;
  if (!isRecord(submitted)) throw new CoreError("invalid_request", "decisions must be an object of permission ID to decision");
  for (const [permissionId, decision] of Object.entries(submitted)) {
    // Own keys only: `in` would admit inherited names (`constructor`, `toString`) as declared.
    if (!Object.hasOwn(decisions, permissionId)) throw new CoreError("unknown_permission", `${pyRepr(permissionId)} is not declared by this package`);
    if (typeof decision === "string" && Object.hasOwn(UNSUPPORTED_DECISIONS, decision)) throw new CoreError("unsupported_decision", UNSUPPORTED_DECISIONS[decision]!, { status: 400 });
    if (typeof decision !== "string" || !(SUPPORTED_DECISIONS as readonly string[]).includes(decision)) {
      throw new CoreError("invalid_decision", `Decision must be one of ${pyRepr([...SUPPORTED_DECISIONS])}; got ${pyRepr(decision)}`);
    }
    decisions[permissionId] = decision as Decision;
  }
  return decisions;
}

export function normalizeToolApprovals(pkg: Package, submitted: unknown): Record<string, boolean> {
  const approvals = initialToolApprovals(pkg);
  if (submitted === null || submitted === undefined) return approvals;
  if (!isRecord(submitted)) throw new CoreError("invalid_request", "tool_approvals must be an object");
  for (const [toolId, approved] of Object.entries(submitted)) {
    if (!Object.hasOwn(approvals, toolId)) throw new CoreError("unknown_tool_approval", `${pyRepr(toolId)} does not require a separate host approval in this package`);
    if (typeof approved !== "boolean") throw new CoreError("invalid_request", "tool approvals must be booleans");
    approvals[toolId] = approved;
  }
  return approvals;
}

/** `blocking_reasons`: every reason this package is not runnable, in stable code form. */
export function blockingReasons(
  pkg: Package,
  options: { evaluation: EvaluationLayers; publisher: PublisherReport; decisions: Record<string, Decision>; policy: BrowserPolicy },
): Reason[] {
  const reasons: Reason[] = [];
  const block = (code: string, message: string, subject: string | null = null) => reasons.push({ code, message, subject });
  for (const layer of ["container", "integrity", "schema"] as const) {
    if (options.evaluation[`${layer}_status`] !== "valid") block(`${layer}_invalid`, `Package ${layer} validation did not pass.`);
  }
  if (options.policy.require_supported_profile && options.evaluation.runtime_status !== "compatible") {
    block("execution_profile_unsupported", "No installed execution profile can run this package.");
  }
  if (options.policy.require_valid_signature && options.publisher.signature_status !== "valid") {
    block("signature_not_valid", `Browser policy requires a valid publisher signature (status: ${options.publisher.signature_status}).`);
  }
  if (options.policy.require_trusted_publisher && options.publisher.trust_status !== "trusted") {
    block("publisher_not_trusted", `Browser policy requires an operator-pinned publisher key (status: ${options.publisher.trust_status}).`);
  }
  for (const permission of permissionsOf(pkg)) {
    const id = str(permission.id);
    if (permission.required === true && (options.decisions[id] ?? DENY) === DENY) block("required_permission_denied", `Required permission ${pyRepr(id)} is denied.`, id);
  }
  return reasons;
}

export interface ReceiptInputs {
  sessionId: string;
  source: SourceRef;
  archiveSha256: string;
  evaluation: EvaluationLayers;
  publisher: PublisherReport;
  trustState: TrustState;
  decisions: Record<string, Decision>;
  toolApprovals: Record<string, boolean>;
  policy: BrowserPolicy;
  instanceId: string;
  expiresAt: string;
  resourceGrants?: readonly ResourceGrant[];
  resourceRegistry?: ResourceRegistry | null;
  /** Chrome addition (D-053). */
  provenance?: Provenance | null;
  now?: Date;
  receiptId?: string;
}

/**
 * `build_receipt`: bind decisions to these exact bytes, this signer, and this trust state.
 * `resource_grants` are part of the receipt hash, so a plan that names this receipt names
 * exactly these resources.
 */
export async function buildReceipt(pkg: Package, input: ReceiptInputs): Promise<AuthorizationReceipt> {
  const reasons = blockingReasons(pkg, { evaluation: input.evaluation, publisher: input.publisher, decisions: input.decisions, policy: input.policy });
  const manifest = pkg.manifest;
  const publisherClaim = manifest.publisher as JsonObject;
  const receipt: Omit<AuthorizationReceipt, "receipt_sha256"> = {
    schema: RECEIPT_SCHEMA,
    receipt_id: input.receiptId ?? crypto.randomUUID(),
    issued_at: (input.now ?? new Date()).toISOString(),
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
      execution_profile: str(pkg.graph.profile ?? manifest.entrypoint),
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
    validation: { ...input.evaluation, supported_execution_profiles: [...input.evaluation.supported_execution_profiles], errors: input.evaluation.errors.map((error) => ({ ...error })) },
    browser_policy: { ...input.policy },
    decisions: sortedRecord(input.decisions),
    tool_approvals: sortedRecord(input.toolApprovals),
    granted_permission_ids: sorted(Object.entries(input.decisions).filter(([, decision]) => decision !== DENY).map(([id]) => id)),
    resource_grants: (input.resourceGrants ?? []).map((grant) => ({ ...grant })),
    resource_registry: resourceRegistryReference(input.resourceRegistry ?? null),
    runnable: reasons.length === 0,
    blocking_reasons: reasons,
    execution: {
      performed: false,
      note: "This control plane never executes packages. A later run milestone consumes this receipt and must re-verify the digest and archive hash first.",
    },
    provenance: input.provenance ?? null,
  };
  return { ...receipt, receipt_sha256: await sha256Hex(canonicalJson(receipt)) };
}

// -- Chrome additions: presets and profile expansion (D-022, D-050, D-053) -------------------
export interface PresetDefinition {
  id: PresetId;
  title: string;
  /** One line for the Settings → Policies selector. */
  summary: string;
  /** The model picker offers local models only. */
  local_models_only: boolean;
  /** The decision a granted permission gets, by permission kind; `default` for the rest. */
  durations: Record<string, Decision> & { default: Decision };
  /** Without a profile: which optional permissions the preset grants by default. */
  grant_optional: "none" | "non_personal" | "all";
  /** Without a profile: which declared tools the preset approves by default. */
  approve_tools: "granted_only" | "all";
}

/**
 * The host presets (D-050). A `payment` permission is `once` under every preset (spec
 * `profiles-v0.md` §5: consequential authority stays single-use); a preset never selects a
 * personal resource, and `always` is never offered.
 */
export const PRESETS: Readonly<Record<PresetId, PresetDefinition>> = Object.freeze({
  "privacy-first": {
    id: "privacy-first",
    title: "Privacy first",
    summary: "Local models only. Personal data and payments are granted for one run at a time, and nothing optional is granted unless you choose it.",
    local_models_only: true,
    durations: { payment: "once", "personal.read": "once", default: "session" },
    grant_optional: "none",
    approve_tools: "granted_only",
  },
  balanced: {
    id: "balanced",
    title: "Balanced",
    summary: "Local or hosted models. Optional network, model and memory permissions are granted for the session; personal data and payments still need your explicit choice.",
    local_models_only: false,
    durations: { payment: "once", default: "session" },
    grant_optional: "non_personal",
    approve_tools: "granted_only",
  },
  convenience: {
    id: "convenience",
    title: "Convenience",
    summary: "Everything the agent declares is granted for the session and every tool approved, except that payments stay single-use and personal records are still yours to pick.",
    local_models_only: false,
    durations: { payment: "once", default: "session" },
    grant_optional: "all",
    approve_tools: "all",
  },
});

export const DEFAULT_PRESET: PresetId = "balanced";
export const PRESET_IDS: readonly PresetId[] = Object.freeze(["privacy-first", "balanced", "convenience"]);

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

/** The decision a preset grants to a permission of this kind. */
export function presetDuration(preset: PresetId, kind: string): Decision {
  const durations = PRESETS[preset].durations;
  return durations[kind] ?? durations.default;
}

export interface Decided {
  decisions: Record<string, Decision>;
  tool_approvals: Record<string, boolean>;
  provenance: Provenance;
}

function provenance(preset: PresetId, profile: Profile | null, by: DecidedBy, decisions: Record<string, Decision>, approvals: Record<string, boolean>): Provenance {
  const decisionBy: Record<string, DecidedBy> = {};
  for (const id of Object.keys(decisions).sort()) decisionBy[id] = by;
  const approvalBy: Record<string, DecidedBy> = {};
  for (const id of Object.keys(approvals).sort()) approvalBy[id] = by;
  return {
    schema: PROVENANCE_SCHEMA,
    profile_id: profile ? profile.id : null,
    profile_title: profile ? profile.title : null,
    preset,
    decisions: decisionBy,
    tool_approvals: approvalBy,
    resource_selections: {},
  };
}

/**
 * A selected profile becomes ordinary decisions (D-022, spec §5): every member permission is
 * granted with the preset's duration for its kind, every member tool approved, and everything
 * declared outside the profile is denied, all recorded as decided by the profile. Resource
 * picks are never made here: they stay the person's.
 */
export function profileDecisions(pkg: Package, profile: Profile, preset: PresetId): Decided {
  const decisions = initialDecisions(pkg);
  for (const permission of permissionsOf(pkg)) {
    const id = str(permission.id);
    if (profile.permissions.includes(id)) decisions[id] = presetDuration(preset, str(permission.kind));
  }
  const approvals = initialToolApprovals(pkg);
  for (const toolId of Object.keys(approvals)) approvals[toolId] = profile.tools.includes(toolId);
  return { decisions, tool_approvals: approvals, provenance: provenance(preset, profile, "profile", decisions, approvals) };
}

/**
 * The customize view's starting point when no profile is selected (D-050): the preset's
 * defaults, recorded as decided by the preset. A tool is approved only when every permission it
 * links to is granted (`granted_only`), or always (`all`); a tool that links no permission is
 * never approved by default.
 */
export function defaultDecisions(pkg: Package, preset: PresetId): Decided {
  const definition = PRESETS[preset];
  const decisions = initialDecisions(pkg);
  for (const permission of permissionsOf(pkg)) {
    const id = str(permission.id);
    const kind = str(permission.kind);
    const grant =
      permission.required === true ||
      definition.grant_optional === "all" ||
      (definition.grant_optional === "non_personal" && kind !== "personal.read" && kind !== "payment");
    if (grant) decisions[id] = presetDuration(preset, kind);
  }
  const approvals = initialToolApprovals(pkg);
  for (const toolId of Object.keys(approvals)) {
    const linkedIds = (pkg.tools[toolId]!.permissions as JsonValue[]).map(str);
    approvals[toolId] = definition.approve_tools === "all" ? true : linkedIds.length > 0 && linkedIds.every((id) => (decisions[id] ?? DENY) !== DENY);
  }
  return { decisions, tool_approvals: approvals, provenance: provenance(preset, null, "preset", decisions, approvals) };
}

/**
 * Validate a submitted provenance object against the decisions it accompanies, or refuse. A
 * view states who decided each item, but the worker believes only what it can recompute: a
 * `profile` claim stands only when that declared profile, expanded under the stated preset,
 * yields the same decision; a `preset` claim only when the preset's defaults do; anything else
 * is recorded as the person's own. Resource picks are always the person's (D-050, D-053), and
 * the profile title comes from the package, never from the view.
 */
export interface ProvenancePolicy {
  reference: PolicyReference;
  /** The subscribed policy applied to a profile's (or, without one, the preset's) decisions (`policies/apply.ts::applyPolicy`). */
  expand: (profile: Profile | null, preset: PresetId) => Decided;
}

export function normalizeProvenance(
  pkg: Package,
  submitted: unknown,
  decisions: Record<string, Decision>,
  approvals: Record<string, boolean>,
  grants: readonly ResourceGrant[],
  options: { policy?: ProvenancePolicy | null } = {},
): Provenance | null {
  if (submitted === null || submitted === undefined) return null;
  if (!isRecord(submitted)) throw new CoreError("invalid_request", "provenance must be an object");
  if (!isPresetId(submitted.preset)) throw new CoreError("invalid_request", `provenance.preset must be one of ${pyRepr([...PRESET_IDS])}`);
  const preset = submitted.preset;
  const claimedProfile = submitted.profile_id === undefined || submitted.profile_id === null ? null : submitted.profile_id;
  if (claimedProfile !== null && typeof claimedProfile !== "string") throw new CoreError("invalid_request", "provenance.profile_id must be a string or null");
  const profile = claimedProfile === null ? null : (readProfiles(pkg).profiles?.find((item) => item.id === claimedProfile) ?? null);
  const fromProfile = profile ? profileDecisions(pkg, profile, preset) : null;
  const fromPreset = defaultDecisions(pkg, preset);
  // A `policy` claim is checked against the policy in force now, applied to the same profile or
  // preset; with no policy in force it cannot stand (T8, D-102).
  const fromPolicy = options.policy ? options.policy.expand(profile, preset) : null;
  const claim = (value: unknown, field: string): DecidedBy => {
    if (value === "user" || value === "profile" || value === "preset" || value === "policy") return value;
    throw new CoreError("invalid_request", `${field} must be user, profile, preset or policy`);
  };
  const map = <T>(raw: unknown, actual: Record<string, T>, field: string, expansion: (decided: Decided) => Record<string, T>, by: (decided: Decided) => Record<string, DecidedBy>): Record<string, DecidedBy> => {
    if (raw === undefined || raw === null) raw = {};
    if (!isRecord(raw)) throw new CoreError("invalid_request", `${field} must be an object`);
    for (const key of Object.keys(raw)) if (!Object.hasOwn(actual, key)) throw new CoreError("invalid_request", `${field} names ${pyRepr(key)}, which has no decision`);
    const out: Record<string, DecidedBy> = {};
    for (const key of Object.keys(actual).sort()) {
      const claimed = claim(Object.hasOwn(raw, key) ? raw[key] : "user", `${field}[${key}]`);
      const source = claimed === "profile" ? fromProfile : claimed === "preset" ? fromPreset : claimed === "policy" ? fromPolicy : null;
      // The policy's claim also needs the policy to have decided that very item, not merely agreed with it.
      const stands = source !== null && expansion(source)[key] === actual[key] && (claimed !== "policy" || by(source)[key] === "policy");
      out[key] = stands ? claimed : "user";
    }
    return out;
  };
  const picks = submitted.resource_selections ?? {};
  if (!isRecord(picks)) throw new CoreError("invalid_request", "provenance.resource_selections must be an object");
  const granted = new Set(grants.map((grant) => grant.permission_id));
  for (const key of Object.keys(picks)) {
    if (!granted.has(key)) throw new CoreError("invalid_request", `provenance.resource_selections names ${pyRepr(key)}, which has no decision`);
  }
  const provenance: Provenance = {
    schema: PROVENANCE_SCHEMA,
    profile_id: profile ? profile.id : null,
    profile_title: profile ? profile.title : null,
    preset,
    decisions: map(submitted.decisions, decisions, "provenance.decisions", (decided) => decided.decisions, (decided) => decided.provenance.decisions),
    tool_approvals: map(submitted.tool_approvals, approvals, "provenance.tool_approvals", (decided) => decided.tool_approvals, (decided) => decided.provenance.tool_approvals),
    resource_selections: Object.fromEntries([...granted].sort().map((id) => [id, "user" as const])),
  };
  // Made while a policy was in force: the receipt names it, whoever decided each item, so that
  // revoking or replacing the policy makes the plan stale (D-102).
  if (options.policy) provenance.policy = { ...options.policy.reference };
  return provenance;
}
