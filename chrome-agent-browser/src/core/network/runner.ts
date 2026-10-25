/**
 * The network loop (network.v0 §4): activations as worker instances over the interpreter, the
 * state views and patches, the route, the transition checks and the reservation
 * (`agentpkg/delegation/runner.py`).
 *
 * Nothing here is package-specific: the roles, the edges, the caps and the schemas come from the
 * signed declaration; the model chooses within them and the mediator refuses the rest.
 */
import { ValidationError } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import { deepCopy, tokens } from "../references.js";
import { CancelToken, withDeadline, yieldPoint } from "../workflow/cancel.js";
import { BudgetError, CancelledError, failedCheck, failureCode, PolicyError, TimeoutError, WorkflowError } from "../workflow/errors.js";
import type { Context } from "../workflow/runtime.js";
import { digest } from "../workflow/runtime.js";
import { evaluate, type Environment } from "../workflow/values.js";
import type { Workflow } from "../workflow/interpreter.js";
import { DONE, edgeKey, routeData, rolesOf, worstCase, type Counts } from "./analysis.js";
import { RouteRefusal } from "./errors.js";

/** Where the network is: the hop count, the uses of each edge and the activations of each role, as the transition check reads them (R-14). */
export class Walk {
  hop = 0;
  readonly uses: Counts = new Map();
  readonly activations: Counts = new Map();

  count(counts: Counts, key: string): number {
    return counts.get(key) ?? 0;
  }

  bump(counts: Counts, key: string): void {
    counts.set(key, this.count(counts, key) + 1);
  }
}

/** A failure event an inner loop leaves for its node to record: the node can name the cause of a cancellation, the loop cannot (R-15, R-18). */
export interface DeferredFailure {
  action: string;
  facts: Record<string, JsonValue>;
}

/** The deferred failure on the error the node caught, or on its cause (the node's own timeout wraps the cancellation the loop saw). */
export function deferredFailure(error: unknown): DeferredFailure | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const deferred = (candidate as { deferred_failure?: unknown } | null | undefined)?.deferred_failure;
    if (deferred !== null && typeof deferred === "object" && typeof (deferred as DeferredFailure).action === "string") return deferred as DeferredFailure;
  }
  return null;
}

interface Decision extends JsonObject {
  next: string;
  message: JsonValue;
}

/**
 * Run the graph's network inside the network node, on the coordinator's context; returns the
 * network's result (validated by the node's `output_schema` as every node's is).
 */
export async function runNetwork(workflow: Workflow, node: JsonObject, input: JsonValue, ctx: Context, token: CancelToken): Promise<JsonValue> {
  const graph = workflow.graph;
  const network = graph.network as JsonObject;
  const roles = rolesOf(network);
  const rt = workflow.runtime;
  const nodeId = String(node.id);
  const messageSchema = String(network.message_schema);
  try {
    await workflow.validate(messageSchema, input, `node ${nodeId} network input`);
  } catch (error) {
    if (error instanceof ValidationError) Object.assign(error, { failed_check: { check: "message_schema", schema: messageSchema } });
    throw error;
  }
  // The run's "at most" (R-21): the bound under the effective budget, the node's timeout and the
  // deadline as the host lowered it, the same figures the execution host recorded.
  const bound = worstCase(graph, workflow.package.policy, { budget: rt.budget, nodeTimeout: Math.min(node.timeout_seconds as number, workflow.deadlineSeconds) });
  rt.reserveNetwork(ctx, nodeId, bound, String(network.entry));
  let state = deepCopy(evaluate(network.initial!, {})) as JsonObject;
  let message = input;
  const walk = new Walk();
  let current = String(network.entry);
  walk.activations.set(current, 1);
  // The shared state after the current activation's patch, once validated; the loop commits it.
  let next: JsonObject | null = null;

  /**
   * The shared state after a role's patch (R-9): only keys of its `state_write`, and the whole
   * validated against `state_schema`, before the activation routes anything; a failure fails the
   * activation and nothing is committed or routed.
   */
  const patched = async (roleId: string, patch: JsonObject): Promise<void> => {
    const stateWrite = (rt.roles[roleId]!.state_write as JsonValue[]).map(String);
    if (Object.keys(patch).some((key) => !stateWrite.includes(key))) throw new PolicyError(`role ${roleId} state write exceeds its state_write view`);
    const candidate = { ...deepCopy(state), ...deepCopy(patch) };
    try {
      await workflow.validate(String(network.state_schema), candidate, `node ${nodeId} network state`);
    } catch (error) {
      if (error instanceof ValidationError) Object.assign(error, { failed_check: { check: "network_state", schema: network.state_schema } });
      throw error;
    }
    next = candidate;
  };

  try {
    for (;;) {
      const role = roles[current]!;
      const worker = rt.roles[current]!;
      // Every key of the view is set by `initial` (R-6, checked at validation), so a missing one is
      // a runtime fault, never a silent narrower view.
      const view: JsonObject = {};
      for (const key of (worker.state_read as JsonValue[]).map(String)) {
        if (!Object.hasOwn(state, key)) throw new Error(`role ${current}: state key ${key} is not set`);
        view[key] = deepCopy(state[key]!);
      }
      rt.record("network.activated", { context: ctx, node_id: nodeId, role: current, hop: walk.hop, activation: walk.count(walk.activations, current), message_hash: digest(message) });
      next = null;
      const outcome = await rt.runWorker(current, view, activation(workflow, nodeId, network, current, role, message, walk, patched), { returnValue: true, nodeId, token });
      const patch = outcome.patch as JsonObject;
      const decision = outcome.decision as Decision;
      state = next!;
      rt.record("network.state.committed", { context: ctx, node_id: nodeId, role: current, hop: walk.hop, state_keys: Object.keys(patch).sort(), state_hash: digest(state) });
      message = decision.message;
      if (decision.next === DONE) break;
      walk.bump(walk.uses, edgeKey(current, decision.next));
      walk.hop += 1;
      walk.bump(walk.activations, decision.next);
      current = decision.next;
    }
    const result = evaluate(network.result!, { state, message });
    const activations: JsonObject = {};
    for (const [roleId, count] of walk.activations) activations[roleId] = count;
    rt.record("network.completed", { context: ctx, node_id: nodeId, hops: walk.hop, activations, result_hash: digest(result) });
    return result;
  } catch (error) {
    const facts: Record<string, JsonValue> = { node_id: nodeId, hop: walk.hop, role: current };
    if (error instanceof CancelledError) {
      // Cancelled from outside: by the node's own timeout (`timeout`), the graph's deadline or the
      // host (`cancelled`). The network cannot tell which from inside; the node can, once the
      // cancellation has passed its timeout, and records `network.failed` with its own code before
      // `node.failed`, so the two events name one cause (R-15, R-18).
      Object.assign(error, { deferred_failure: { action: "network.failed", facts } satisfies DeferredFailure });
      throw error;
    }
    rt.record("network.failed", { context: ctx, error_code: failureCode(error), ...facts });
    throw error;
  }
}

/**
 * One activation (R-15): the role's steps in order over its view, the message and its earlier
 * steps; then the patch it writes, validated over the shared state before anything is routed; then
 * its route. All inside the role's timeout, in the worker instance the runtime gave it. It returns
 * the patch and the decision; the loop keeps the next state.
 */
function activation(
  workflow: Workflow,
  nodeId: string,
  network: JsonObject,
  roleId: string,
  role: JsonObject,
  message: JsonValue,
  walk: Walk,
  patched: (roleId: string, patch: JsonObject) => Promise<void>,
) {
  return async (ctx: Context, view: JsonObject, token: CancelToken): Promise<JsonObject> => {
    ctx.node_id = `${nodeId}/${roleId}`;
    const local: Environment = { state: view, message: deepCopy(message), steps: {} };
    return withDeadline(role.timeout_seconds as number, token, async (bounded) => {
      for (const step of role.steps as JsonObject[]) {
        await yieldPoint(bounded);
        (local.steps as JsonObject)[String(step.id)] = await workflow.step(step, local, ctx, bounded);
      }
      const patch: JsonObject = {};
      for (const [pointer, value] of Object.entries(role.writes as JsonObject)) patch[tokens(pointer)[0]!] = evaluate(value, local);
      await patched(roleId, patch);
      const decision = await route(workflow, nodeId, network, roleId, role, local, walk, ctx, bounded);
      return { patch, decision };
    });
  };
}

/**
 * The transition check (R-14): the target is a declared edge of this role (or `done` where the
 * role may end), the edge has uses left, the hops are not exhausted, the target's activations are
 * below its cap. Every decision is recorded with its reason.
 */
function checkTransition(workflow: Workflow, ctx: Context, nodeId: string, network: JsonObject, roleId: string, role: JsonObject, walk: Walk, target: JsonValue, chosenBy: "model" | "package"): void {
  const edges = role.edges as JsonObject[];
  const declared = target === DONE || edges.some((edge) => edge.to === target);
  const facts: Record<string, JsonValue> = {
    node_id: nodeId,
    role: roleId,
    hop: walk.hop,
    activation: walk.count(walk.activations, roleId),
    chosen_by: chosenBy,
    hops_left: (network.max_hops as number) - walk.hop,
    next: declared ? (target as string) : null,
  };
  let reason: string | null = null;
  if (target === DONE) {
    if (role.may_end !== true) reason = "end_not_allowed";
  } else if (!declared) {
    reason = "edge_undeclared";
  } else if (walk.hop >= (network.max_hops as number)) {
    reason = "hops_exhausted";
  } else {
    const to = String(target);
    const edge = edges.find((item) => item.to === to)!;
    const cap = rolesOf(network)[to]!.max_activations as number | undefined;
    if (walk.count(walk.uses, edgeKey(roleId, to)) >= (edge.max_uses as number)) reason = "edge_exhausted";
    else if (cap !== undefined && walk.count(walk.activations, to) >= cap) reason = "role_exhausted";
    else {
      facts.uses = walk.count(walk.uses, edgeKey(roleId, to)) + 1;
      facts.max_uses = edge.max_uses as number;
    }
  }
  workflow.runtime.record("route.decided", { context: ctx, allowed: reason === null, ...facts, reason });
  if (reason !== null) {
    if (chosenBy === "model") throw new RouteRefusal(reason, declared ? (target as string) : null);
    if (reason === "edge_undeclared" || reason === "end_not_allowed") throw new PolicyError(`role ${roleId}: route to ${String(target)} is not declared (${reason})`);
    throw new BudgetError(`role ${roleId}: route to ${String(target)} refused (${reason})`);
  }
}

/**
 * The route decision (R-13, R-14): fixed, or one model call under the runtime-built closed schema
 * (the enum of the declared targets plus `done` where allowed, the message under the network's
 * message schema), with the availability in the request data and the transition check applied to
 * the answer before it is accepted.
 */
async function route(workflow: Workflow, nodeId: string, network: JsonObject, roleId: string, role: JsonObject, local: Environment, walk: Walk, ctx: Context, token: CancelToken): Promise<Decision> {
  const spec = role.route as JsonObject;
  const messageSchema = String(network.message_schema);
  if (!("task" in spec)) {
    const message = evaluate(spec.message!, local);
    await workflow.validate(messageSchema, message, `role ${roleId} route message`);
    checkTransition(workflow, ctx, nodeId, network, roleId, role, walk, spec.next!, "package");
    return { next: String(spec.next), message };
  }
  const data = routeData(network, roleId, evaluate(spec.input!, local), walk.uses, walk.activations, walk.hop);
  const targets = [...(role.edges as JsonObject[]).map((edge) => String(edge.to)), ...(role.may_end === true ? [DONE] : [])];
  const bundled = workflow.modelSchema(messageSchema) as JsonObject;
  const schema: JsonObject = {
    type: "object",
    properties: { next: { enum: targets }, message: { $ref: bundled.$ref! } },
    required: ["next", "message"],
    additionalProperties: false,
    $defs: bundled.$defs!,
  };
  // The package's own closed validator for the message (formats, local refs), then the transition:
  // both before the answer is accepted, so a refused one is charged and audited as a non-conforming
  // answer (R-14), and a host that re-asks (R-28) asks again with the check named.
  const check = async (answer: JsonValue): Promise<void> => {
    const record = answer as JsonObject;
    await workflow.validate(messageSchema, record.message!, `role ${roleId} route message`);
    checkTransition(workflow, ctx, nodeId, network, roleId, role, walk, record.next!, "model");
  };
  // The route is the activation's last operation, named `<node>/<role>/route` in the audit as the
  // execution host names it (R-13).
  ctx.operation_id = `${ctx.node_id}/route`;
  try {
    const answer = (await ctx.model(String(spec.task), data, schema, spec.max_output_tokens as number, token, { check })) as JsonObject;
    return { next: String(answer.next), message: answer.message! };
  } catch (error) {
    if (error instanceof PolicyError || error instanceof TimeoutError || error instanceof CancelledError) throw error;
    throw Object.assign(new WorkflowError(error instanceof ValidationError ? "schema_validation" : "model_error", `${nodeId}/${roleId}/route`, { cause: error }), failedCheck(error));
  } finally {
    ctx.operation_id = undefined;
  }
}
