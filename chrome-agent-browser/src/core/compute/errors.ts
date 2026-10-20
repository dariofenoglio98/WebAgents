/** The one failure class a compute call adds to workflow.v0 (compute.v0 §6): `agentpkg/compute/errors.py`. */
import { AgentPkgError } from "../errors.js";
import type { JsonObject } from "../json.js";

/**
 * A call that the module itself ended: a trap, exhausted fuel, a passed deadline, an ABI
 * violation, or output that is not one JSON text. The node fails `compute_error`; the audit
 * names the reason and never carries what the module wrote.
 */
export class ComputeError extends AgentPkgError {
  override readonly name: string = "ComputeError";
  readonly code = "compute_error";
  readonly reason: string;
  readonly trap_code: string | null;
  readonly detail: string | null;
  readonly audit_facts: JsonObject;

  constructor(reason: string, options: { trapCode?: string | null; detail?: string | null } = {}) {
    const trapCode = options.trapCode ?? null;
    const detail = options.detail ?? null;
    super(`compute call failed: ${reason}${trapCode ? ` (${trapCode})` : ""}${detail ? `: ${detail}` : ""}`);
    this.reason = reason;
    this.trap_code = trapCode;
    this.detail = detail;
    this.audit_facts = this.facts();
  }

  facts(): JsonObject {
    const facts: JsonObject = { reason: this.reason };
    if (this.trap_code) facts.trap_code = this.trap_code;
    if (this.detail) facts.detail = this.detail;
    return facts;
  }
}
