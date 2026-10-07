/**
 * Errors actionable at the package boundary, mirroring `agentpkg/errors.py` and
 * `agentpkg/browser/errors.py`.
 *
 * The class hierarchy carries the same distinctions the Python control plane reports as
 * separate layers: a `ValidationError` is a container, schema or semantic failure; the
 * narrower `IntegrityError` means the archive parsed but its hashes contradict the
 * integrity statement; a `SignatureError` is about the publisher envelope. `CoreError` adds
 * the stable `code` the shell and the CLI branch on, never on prose.
 */

export class AgentPkgError extends Error {
  override readonly name: string = "AgentPkgError";
}

/** Invalid format, archive, schema, or semantic reference. */
export class ValidationError extends AgentPkgError {
  override readonly name: string = "ValidationError";
}

/** Archive structure parsed, but payload hashes contradict the integrity statement. */
export class IntegrityError extends ValidationError {
  override readonly name: string = "IntegrityError";
}

/** Missing, invalid, or untrusted publisher signature. */
export class SignatureError extends AgentPkgError {
  override readonly name: string = "SignatureError";
}

/**
 * One refused operation with a stable, machine-readable code (`ControlPlaneError` in
 * Python). Messages never carry package payload content.
 */
export class CoreError extends AgentPkgError {
  override readonly name: string = "CoreError";
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { status?: number; details?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.code = code;
    this.status = options.status ?? 400;
    this.details = options.details ?? {};
  }

  payload(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    const error: { code: string; message: string; details?: Record<string, unknown> } = {
      code: this.code,
      message: this.message,
    };
    if (Object.keys(this.details).length > 0) error.details = this.details;
    return { error };
  }
}
