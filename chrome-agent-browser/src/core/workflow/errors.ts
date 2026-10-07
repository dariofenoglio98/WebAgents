/**
 * The interpreter's failure classes, mirroring `agentpkg/errors.py`, `runtime.py`,
 * `workflow.py` and the stable codes of `spec/workflow-v0.md` §9.
 *
 * `name` is set to the Python class name on every class here, because the audit records
 * `error: type(exc).__name__` on `worker.failed`, `tool.failed` and `model.failed`, and the two
 * runtimes should name the same failure the same way. `CancelledError` and `TimeoutError` stand
 * for `asyncio.CancelledError` and the built-in `TimeoutError`; nothing here is thrown by the
 * platform.
 */
import { AgentPkgError, ValidationError } from "../errors.js";
import type { JsonObject } from "../json.js";
import type { AuditErrorCode } from "../types.js";

/** A package request exceeds user authority or supported runtime behavior. */
export class PolicyError extends AgentPkgError {
  override readonly name: string = "PolicyError";
}

/** A hard bound was reached before dispatch. */
export class BudgetError extends PolicyError {
  override readonly name: string = "BudgetError";
}

/** A deadline elapsed (`asyncio.timeout`). */
export class TimeoutError extends AgentPkgError {
  override readonly name: string = "TimeoutError";
}

/** Host cancellation (`asyncio.CancelledError`); carries `execution_report` out of `run`. */
export class CancelledError extends AgentPkgError {
  override readonly name: string = "CancelledError";
  execution_report?: Record<string, unknown>;

  constructor(message = "cancelled") {
    super(message);
  }
}

/**
 * One refused or failed adapter operation with a stable code (`hostbridge.errors.BridgeError`
 * and `toolbridge.errors.ToolBridgeError`). `audit_facts` are structural facts about *how* a
 * call failed that the runtime copies into its audit after filtering them again; they must
 * never hold anything a model, a provider or a document wrote.
 */
export class AdapterError extends AgentPkgError {
  override readonly name: string = "AdapterError";
  readonly code: string;
  readonly detail: Record<string, unknown>;
  audit_facts: Record<string, unknown>;

  constructor(code: string, message: string, options: { detail?: Record<string, unknown> | null; audit_facts?: Record<string, unknown> | null } = {}) {
    super(message);
    this.code = code;
    this.detail = options.detail ?? {};
    this.audit_facts = { ...(options.audit_facts ?? {}) };
  }
}

export type FailureCode = AuditErrorCode;

/** Stable classified failure; raw provider data is excluded from diagnostics. */
export class WorkflowError extends AgentPkgError {
  override readonly name: string = "WorkflowError";
  readonly code: FailureCode;
  readonly node_id: string | null;
  execution_report?: Record<string, unknown>;

  constructor(code: FailureCode, nodeId: string | null = null, options: { cause?: unknown } = {}) {
    super(`workflow.v0 ${code}${nodeId ? ` at node ${nodeId}` : ""}`, options);
    this.code = code;
    this.node_id = nodeId;
  }
}

/** `workflow.py::failure_code`. */
export function failureCode(error: unknown): FailureCode {
  if (error instanceof WorkflowError) return error.code;
  if (error instanceof CancelledError) return "cancelled";
  if (error instanceof TimeoutError) return "timeout";
  if (error instanceof BudgetError) return "budget_exhausted";
  if (error instanceof ValidationError) return "schema_validation";
  if (error instanceof PolicyError) return "permission_denied";
  return "worker_error";
}

/** `workflow.py::_failed_check`: which declared check failed, when a validation says so; never data. */
export function failedCheck(error: unknown): { failed_check?: JsonObject } {
  const facts = (error as { failed_check?: unknown } | null)?.failed_check;
  return facts !== null && typeof facts === "object" && !Array.isArray(facts) ? { failed_check: facts as JsonObject } : {};
}

/** `type(exc).__name__`. */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor.name;
  return typeof error;
}
