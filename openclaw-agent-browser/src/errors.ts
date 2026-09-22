/**
 * Control-plane failures become stable, bounded, UI-branchable categories here.
 *
 * The page must never see a Python traceback, an internal path, or a message it
 * has to parse. Everything it needs to decide what to render is in `code`.
 */
import { ERROR_CODES, type FeatureErrorView } from "./contract.js";

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A failure raised by, or while reaching, the control plane. */
export class AgentBrowserError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly title: string,
    readonly detail: string,
    readonly retryable = false,
    readonly validation: unknown = null,
  ) {
    super(`${code}: ${detail}`);
    this.name = "AgentBrowserError";
  }

  view(): FeatureErrorView {
    const error: FeatureErrorView = {
      code: this.code,
      title: clip(this.title, 200),
      detail: clip(this.detail, 4096),
      retryable: this.retryable,
    };
    if (this.validation !== null && this.validation !== undefined) {
      error.validation = this.validation;
    }
    return error;
  }
}

export function clip(text: string, max: number): string {
  const value = typeof text === "string" ? text : String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Control-plane code -> (browser code, title, retryable). */
const MAPPING: Record<string, { code: ErrorCode; title: string; retryable?: boolean }> = {
  invalid_request: { code: "invalid_request", title: "Request rejected" },
  unknown_field: { code: "invalid_request", title: "Request rejected" },
  method_not_allowed: { code: "invalid_request", title: "Request rejected" },
  not_found: { code: "invalid_request", title: "Unknown control-plane route" },
  request_too_large: { code: "invalid_request", title: "Request too large" },
  unauthorized: { code: "service_unavailable", title: "Service rejected this host", retryable: true },
  host_header_rejected: { code: "service_unavailable", title: "Service rejected this host" },
  browser_request_refused: { code: "service_unavailable", title: "Service rejected this host" },
  busy: { code: "service_unavailable", title: "Service busy", retryable: true },

  url_rejected: { code: "url_rejected", title: "This URL cannot be opened" },
  url_unresolvable: { code: "download_failed", title: "Package host not reachable", retryable: true },
  url_destination_denied: { code: "url_rejected", title: "This destination is not allowed" },
  download_redirect_denied: { code: "download_failed", title: "Download refused" },
  download_too_large: { code: "download_failed", title: "Package too large" },
  download_timeout: { code: "download_failed", title: "Download timed out", retryable: true },
  download_failed: { code: "download_failed", title: "Download failed", retryable: true },

  source_rejected: { code: "source_rejected", title: "This file cannot be opened" },
  package_too_large: { code: "source_rejected", title: "Package too large" },
  package_rejected: { code: "package_rejected", title: "Package rejected" },
  snapshot_unstable: { code: "package_rejected", title: "Package rejected", retryable: true },

  session_unknown: { code: "session_expired", title: "Package session ended" },
  authorization_absent: { code: "session_expired", title: "No authorization yet" },
  digest_mismatch: { code: "digest_mismatch", title: "Package changed" },

  session_limit_reached: { code: "limit_reached", title: "Too many open packages" },
  cache_limit_reached: { code: "limit_reached", title: "Snapshot cache full" },

  fingerprint_mismatch: { code: "trust_conflict", title: "Publisher key mismatch" },
  signature_not_valid: { code: "signature_not_valid", title: "Signature is not valid" },
  trust_entry_exists: { code: "trust_conflict", title: "Key already pinned" },
  trust_entry_unknown: { code: "trust_conflict", title: "No such pinned key" },
  trust_private_key_refused: { code: "trust_conflict", title: "Private keys are refused" },
  trust_invalid: { code: "trust_conflict", title: "Trust store rejected this change" },
  unknown_permission: { code: "invalid_request", title: "Unknown permission" },
  invalid_decision: { code: "invalid_request", title: "Unsupported decision" },
  unsupported_decision: { code: "invalid_request", title: "Unsupported decision" },
  unknown_tool_approval: { code: "invalid_request", title: "Unknown tool approval" },
};

/** Translate one control-plane error body into the browser's typed category. */
export function fromControlPlane(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AgentBrowserError {
  const mapped = MAPPING[code] ?? { code: "control_plane_error" as ErrorCode, title: "Request failed" };
  const validation = details && "validation" in details ? details.validation : null;
  return new AgentBrowserError(
    mapped.code,
    mapped.title,
    message,
    mapped.retryable ?? false,
    validation ?? null,
  );
}

export function serviceUnavailable(detail: string): AgentBrowserError {
  return new AgentBrowserError(
    "service_unavailable",
    "Agent Browser service unavailable",
    detail,
    true,
  );
}

/** Never let an unexpected throw reach the page as a raw message. */
export function asFeatureError(error: unknown): FeatureErrorView {
  if (error instanceof AgentBrowserError) return error.view();
  return new AgentBrowserError(
    "control_plane_error",
    "Unexpected error",
    "The Agent Browser backend failed while handling this request.",
    true,
  ).view();
}
