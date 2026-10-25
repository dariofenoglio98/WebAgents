/**
 * network.v0's one failure class beyond workflow.v0's (`agentpkg/delegation/runner.py::RouteRefusal`).
 * Its own module so that the runtime, which re-asks a non-conforming answer, can name it without
 * importing the runner.
 */
import { AgentPkgError } from "../errors.js";
import type { JsonObject } from "../json.js";

/**
 * A chosen route that the transition check refused: a non-conforming answer (R-14), as a refused
 * answer check is. `failed_check` names the reason and the declared target; never a value the
 * model wrote outside the enum.
 */
export class RouteRefusal extends AgentPkgError {
  override readonly name: string = "RouteRefusal";
  readonly code = "model_output_not_conforming";
  readonly failed_check: JsonObject;
  readonly audit_facts: Record<string, unknown> = { output_failure: "check" };

  constructor(
    readonly reason: string,
    target: string | null,
  ) {
    super(`route: ${reason}`);
    this.failed_check = { check: "route", failure: reason, next: target };
  }
}
