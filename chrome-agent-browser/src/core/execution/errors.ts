/**
 * Stable, machine-readable execution failures (`execution/errors.py`). Codes are the contract:
 * a caller branches on `code`, never on prose, and a message never carries package payload
 * content, model output, provider detail, a credential or a filesystem path. The tool codes are
 * shared verbatim with `tools/`, so the word the runner uses when it refuses to ask is the word
 * the host uses when it refuses to answer.
 */
import { AdapterError } from "../workflow/errors.js";

/** One refused or failed execution operation with a stable code. */
export class ExecutionError extends AdapterError {
  override readonly name: string = "ExecutionError";
}

// Authority and handoff
export const ARTIFACT_INVALID = "execution_artifact_invalid";
export const ARTIFACT_MISMATCH = "execution_artifact_mismatch";
export const SIGNATURE_INVALID = "execution_signature_invalid";
export const PLAN_INVALID = "execution_plan_invalid";
export const INPUT_INVALID = "execution_input_invalid";
// Consent
export const PERMISSION_DENIED = "execution_permission_denied";
export const GRANT_UNSUPPORTED = "execution_grant_unsupported";
// The bound model cannot satisfy what the package declares
export const MODEL_INCOMPATIBLE = "execution_model_incompatible";
// Host capability limits of this host, not limits of the package format
export const TOOLS_NOT_SUPPORTED = "tools_not_supported";
export const OUTPUT_CAP_TOO_LARGE = "execution_output_cap_too_large";
export const EXPORT_PATH_RESERVED = "execution_export_path_reserved";
// Tool authority, shared with the tool layer
export const TOOL_NOT_DECLARED = "tool_not_declared";
export const TOOL_NOT_BOUND = "tool_not_bound";
export const TOOL_NOT_APPROVED = "tool_not_approved";
export const TOOL_PERMISSION_DENIED = "tool_permission_denied";
export const TOOL_CONTRACT_MISMATCH = "tool_contract_mismatch";
export const TOOL_BINDING_STALE = "tool_binding_stale";
export const TOOL_BINDING_AMBIGUOUS = "tool_binding_ambiguous";
// Lifecycle
export const NOT_BOUND = "execution_not_bound";
export const ALREADY_STARTED = "execution_already_started";
export const ARTIFACTS_FAILED = "execution_artifacts_failed";
export const RUNTIME_REFUSED = "execution_runtime_refused";
// Leases (control-plane vocabulary, `browser/lease.py` and the plugin's preflight)
export const RUN_PLAN_STALE = "run_plan_stale";
export const RUN_PLAN_BLOCKED = "run_plan_blocked";
export const AUTHORIZATION_EXPIRING = "authorization_expiring";
export const AUTHORIZATION_ONCE_SPENT = "authorization_once_spent";
export const LEASE_ACTIVE = "execution_lease_active";
export const LEASE_UNKNOWN = "execution_lease_unknown";
export const SELECTED_MODEL_UNAVAILABLE = "selected_model_unavailable";

export function invalid(message: string, detail: Record<string, unknown> | null = null): ExecutionError {
  return new ExecutionError(PLAN_INVALID, message, { detail: detail ?? undefined });
}
