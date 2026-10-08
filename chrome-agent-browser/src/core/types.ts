/**
 * The authority and execution records, as data shapes (D-036).
 *
 * These mirror the dictionaries the Python control plane and runner produce: the
 * authorization receipt (`browser/authorization.py`), the Run Plan and its preflight
 * (`browser/runplan.py`), the Run Invocation (`execution/invocation.py`), the audit event
 * (`schemas/audit-event.schema.json`) and the run record the Agent Browser writes as
 * `run.json`. Field names are kept verbatim so a record produced by either runtime reads
 * the same. Only the hash helpers live here; constructing a receipt or a plan is T3's, and
 * running anything is T4's.
 */
import { canonicalJson } from "./canonical.js";
import type { EvaluationLayers } from "./evaluation.js";
import { sha256Hex } from "./hash.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { TrustState } from "./trust.js";

// -- decisions and policy -----------------------------------------------------------
export const DENY = "deny";
export type Decision = "deny" | "once" | "session";
export const SUPPORTED_DECISIONS: readonly Decision[] = Object.freeze(["deny", "once", "session"]);
/**
 * `always` is deliberately absent: no host authorization store persists consent, so offering
 * it would tell the person something false (`authorization.py`, D-005).
 */
export const UNSUPPORTED_DECISIONS: Readonly<Record<string, string>> = Object.freeze({
  always:
    "Not offered: this host has no persistent authorization store. The runtime accepts 'always', but that grant lasts only for a single Runtime instance, so presenting it as durable consent would misinform the user. Use 'session'.",
});

/** `BrowserPolicy`: what this host requires before it calls a package runnable. */
export interface BrowserPolicy {
  require_valid_signature: boolean;
  require_trusted_publisher: boolean;
  require_supported_profile: boolean;
  require_confirmed_model_compatibility: boolean;
  require_confirmed_tool_contract: boolean;
}

export const DEFAULT_BROWSER_POLICY: Readonly<BrowserPolicy> = Object.freeze({
  require_valid_signature: true,
  require_trusted_publisher: true,
  require_supported_profile: true,
  require_confirmed_model_compatibility: true,
  require_confirmed_tool_contract: true,
});

// -- shared record parts ------------------------------------------------------------
export interface ControlPlaneRef {
  service: string;
  api_version: "v0";
  instance_id: string;
}

export interface PackageRef {
  package_id: string;
  name: string;
  version: string;
  digest: string;
  archive_sha256: string;
  entrypoint: string;
  execution_profile: string;
}

export interface PublisherRef {
  claimed_id: string;
  claimed_name: string;
  signer_fingerprint: string | null;
  signature_status: "valid" | "invalid" | "absent";
  trust_status: "trusted" | "unknown" | "mismatch";
  trust_reason: string;
}

/** A stable, machine-readable reason a UI can route a person back to the control that fixes it. */
export interface Reason {
  code: string;
  message: string;
  subject: string | null;
}

export interface SourceRef {
  kind: string;
  display?: string;
  opened_at?: string;
  [key: string]: JsonValue | undefined;
}

export interface ResourceGrant {
  permission_id: string;
  resource_type: string;
  resource_id: string;
  resource_digest: string;
}

export interface RegistryRef {
  registry_sha256: string;
  type_count?: number;
  resource_count?: number;
  binding_count?: number;
  [key: string]: JsonValue | undefined;
}

// -- decision provenance (Chrome addition, D-053) -------------------------------------
/**
 * Who made a decision: the person, a selected publisher profile, the host preset, or the policy
 * the person subscribed to (T8, D-102; the policy is named by `Provenance.policy`).
 */
export type DecidedBy = "user" | "profile" | "preset" | "policy";
export type PresetId = "privacy-first" | "balanced" | "convenience";
export const PROVENANCE_SCHEMA = "org.webagents:decision-provenance-v0";

/**
 * Recorded beside the decisions in a receipt and copied into the plan's `authorization`. It
 * changes the meaning of no reference field: the decisions themselves are ordinary
 * `deny | once | session` and `true | false` values, enforced exactly as before (D-022).
 */
export interface Provenance {
  schema: typeof PROVENANCE_SCHEMA;
  profile_id: string | null;
  profile_title: string | null;
  preset: PresetId;
  decisions: Record<string, DecidedBy>;
  tool_approvals: Record<string, DecidedBy>;
  resource_selections: Record<string, DecidedBy>;
  /**
   * The subscribed policy this authorization was made under (T8, D-102). Present only when one
   * was in force, so a receipt made without a policy keeps exactly its earlier shape and hash.
   */
  policy?: PolicyReference;
}

/** How a receipt, a plan and a decision name the policy bundle they came from (T8). */
export interface PolicyReference {
  policy_id: string;
  version: string;
  title: string;
  /** SHA-256 of the bundle's canonical content: the exact bundle, whatever its transport bytes. */
  content_sha256: string;
  signer_fingerprint: string;
}

// -- the authorization receipt ------------------------------------------------------
export const RECEIPT_SCHEMA = "agentpkg-authorization-receipt-v0";
export const REQUEST_SCHEMA = "agentpkg-authorization-request-v0";

export interface AuthorizationReceipt {
  schema: typeof RECEIPT_SCHEMA;
  receipt_id: string;
  issued_at: string;
  expires_at: string;
  session_id: string;
  control_plane: ControlPlaneRef;
  source: SourceRef;
  package: PackageRef;
  publisher: PublisherRef;
  trust_store: TrustState;
  validation: EvaluationLayers;
  browser_policy: BrowserPolicy;
  decisions: Record<string, Decision>;
  tool_approvals: Record<string, boolean>;
  granted_permission_ids: string[];
  resource_grants: ResourceGrant[];
  resource_registry: RegistryRef | null;
  runnable: boolean;
  blocking_reasons: Reason[];
  execution: { performed: false; note: string };
  /** Chrome addition (D-053): who made each decision; null when the receipt came from elsewhere. */
  provenance: Provenance | null;
  /** SHA-256 of the canonical receipt without this field. */
  receipt_sha256: string;
}

// -- the run plan -------------------------------------------------------------------
export const RUN_PLAN_SCHEMA = "agentpkg-run-plan-v0";
export const RUN_PLAN_VERSION = "0.1";
export const MODE_MODEL = "model";
export const MODE_TOOL_PROBE = "tool_probe";
export type ExecutionMode = typeof MODE_MODEL | typeof MODE_TOOL_PROBE;
export const BINDING_SINGLE_MODEL = "single_model";

export interface ToolBinding {
  tool_id: string;
  binding_id: string;
  binding_sha256: string;
  contract_sha256: string;
  [key: string]: JsonValue | undefined;
}

export interface ModelBinding {
  strategy: typeof BINDING_SINGLE_MODEL;
  selected_at: string;
  host_model_id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  descriptor: JsonObject;
  compatibility: JsonObject;
  catalog: JsonObject;
}

export interface RunPlan {
  schema: typeof RUN_PLAN_SCHEMA;
  run_plan_version: typeof RUN_PLAN_VERSION;
  run_plan_id: string;
  created_at: string;
  expires_at: string;
  session_id: string;
  control_plane: ControlPlaneRef;
  source: SourceRef;
  package: PackageRef;
  publisher: PublisherRef;
  trust_store: TrustState;
  validation: EvaluationLayers;
  authorization: {
    receipt_id: string;
    receipt_sha256: string;
    issued_at: string;
    expires_at: string;
    runnable: boolean;
    decisions: Record<string, Decision>;
    tool_approvals: Record<string, boolean>;
    granted_permission_ids: string[];
    /** Chrome addition (D-053), copied from the receipt. */
    provenance: Provenance | null;
  };
  execution: {
    profile: string;
    mode: ExecutionMode;
    binding_strategy: typeof BINDING_SINGLE_MODEL;
    required_permission_ids: string[];
    /** The approved tools (Chrome, D-022); the reference lists every declared tool here. */
    required_tool_ids: string[];
    /** Chrome addition (D-022, D-053): declared tools the receipt did not approve; the runtime refuses calls to them. */
    denied_tool_ids: string[];
    probe_tool_id: string | null;
    tool_binding_count: number;
    performed: false;
    note: string;
  };
  tool_bindings: ToolBinding[];
  tool_registry: {
    registry_sha256: string;
    binding_count: number;
    available_binding_count: number;
    host: { runtime: string; runtime_version: string | null; source: string; captured_at: string; agent_id: string | null };
  } | null;
  resource_grants: ResourceGrant[];
  resource_registry: RegistryRef | null;
  model_binding: ModelBinding | null;
  model_requirements: JsonObject;
  browser_policy: BrowserPolicy;
  readiness: {
    state: "ready" | "blocked";
    ready: boolean;
    compatibility_status: string | null;
    blocking_reasons: Reason[];
  };
  /** SHA-256 of the canonical plan without this field. */
  run_plan_sha256: string;
}

export interface RunPlanPreflight {
  schema: "agentpkg-run-plan-preflight-v0";
  checked_at: string;
  run_plan_id: string;
  run_plan_sha256: string;
  state: "ready" | "blocked" | "stale";
  ready: boolean;
  stale: boolean;
  stale_reasons: Reason[];
  blocking_reasons: Reason[];
  trust_store_changed: boolean;
  tool_bindings: { bound: number; current: boolean; evaluated: boolean; registry_sha256: string | null; registry_changed: boolean };
  resource_grants: { granted: number; current: boolean; evaluated: boolean; registry_sha256: string | null };
  /** The reference plugin's field: null when no current catalog was supplied (unknown is not unavailable). */
  model_still_available: boolean | null;
  execution: { performed: false; note: string };
}

// -- the run invocation and the run record -------------------------------------------
export const RUN_INVOCATION_SCHEMA = "agentpkg-run-invocation-v0";

export interface RunInvocation {
  schema: typeof RUN_INVOCATION_SCHEMA;
  run_invocation_version: string;
  run_id: string;
  run_plan_id: string;
  run_plan_sha256: string;
  session_id: string | null;
  package: Pick<PackageRef, "package_id" | "version" | "digest" | "archive_sha256">;
  input_sha256: string;
  input_bytes: number;
  attachments: JsonObject[];
  created_at: string;
  note: string;
  /** SHA-256 of the canonical invocation without this field. */
  run_invocation_sha256: string;
}

// -- the audit event ----------------------------------------------------------------
export const AUDIT_SCHEMA_VERSION = "audit.v0";
export type AuditErrorCode =
  | "cancelled"
  | "timeout"
  | "budget_exhausted"
  | "schema_validation"
  | "permission_denied"
  | "model_error"
  | "tool_error"
  | "worker_error";

/** `schemas/audit-event.schema.json`: one event in the hash-linked chain. */
export interface AuditEvent {
  schema_version: typeof AUDIT_SCHEMA_VERSION;
  run_id: string;
  sequence: number;
  timestamp: string;
  action: string;
  worker: string | null;
  role: string | null;
  parent: string | null;
  depth: 0 | 1;
  node_id: string | null;
  previous_hash: string | null;
  event_hash: string;
  profile?: "workflow.v0";
  error_code?: AuditErrorCode;
  [key: string]: JsonValue | undefined;
}

// -- hashing ------------------------------------------------------------------------
/**
 * The hash every record above carries: SHA-256 of the canonical record without its own hash
 * field (`receipt_sha256`, `run_plan_sha256`, `run_invocation_sha256`).
 */
export async function recordHash(record: object, field: string): Promise<string> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (key !== field && value !== undefined) copy[key] = value;
  }
  return sha256Hex(canonicalJson(copy));
}

/** Whether a record's self-hash field matches its content. */
export async function recordHashValid(record: object, field: string): Promise<boolean> {
  return (await recordHash(record, field)) === (record as Record<string, unknown>)[field];
}

export const hashReceipt = (receipt: AuthorizationReceipt) => recordHash(receipt, "receipt_sha256");
export const hashRunPlan = (plan: RunPlan) => recordHash(plan, "run_plan_sha256");
export const hashInvocation = (invocation: RunInvocation) => recordHash(invocation, "run_invocation_sha256");
