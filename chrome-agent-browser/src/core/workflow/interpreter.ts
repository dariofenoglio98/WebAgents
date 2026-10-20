/**
 * The domain-independent `workflow.v0` interpreter (`agentpkg/workflow.py`).
 *
 * One execution per instance; all authority remains in the host mediator (`Runtime`). Ready
 * nodes use one snapshot per wave and run concurrently; unordered state conflicts were refused
 * statically; a whole wave commits only after every result and state patch validated; maps
 * create at most `max_parallel` consumers, never one task per item. The first failure cancels
 * its siblings, which are drained before the failure is reported, so no patch of a failed wave
 * is applied and no accounting changes after the report (D-060).
 */
import { integrityStatement } from "../archive.js";
import { canonicalString } from "../canonical.js";
import { ComputeError } from "../compute/errors.js";
import { ValidationError } from "../errors.js";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json.js";
import { PROPOSALS_EXPORT_FORMAT, ProposalRefusal } from "../memory/proposals.js";
import { MemoryRun, type MemoryRunReport } from "../memory/run.js";
import type { Package } from "../package.js";
import { deepCopy, schemaReference, select, tokens } from "../references.js";
import { PackageSchemas } from "../schema.js";
import type { AuditEvent } from "../types.js";
import { validatePayload } from "../validation.js";
import { checkAnswer, checkAssertions } from "./assertions.js";
import { CancelToken, withDeadline, yieldPoint } from "./cancel.js";
import { BudgetError, CancelledError, failedCheck, failureCode, PolicyError, TimeoutError, WorkflowError } from "./errors.js";
import { computeHostLimits, Context, digest, prepareCompute, Runtime, type RuntimeOptions } from "./runtime.js";
import { evaluate, pyEqual, type Environment } from "./values.js";

export const PROFILE = "workflow.v0";
/** `provenance.interpreter`: which interpreter ran (the reference says `agentpkg.workflow.Workflow`). */
export const INTERPRETER = "chrome-agent-browser.workflow.Workflow";

export interface WorkflowOptions extends RuntimeOptions {
  /**
   * The host's own deadline for the whole run, as a `Date.now()` instant, when it is earlier than the
   * graph's (the runner's watchdog, `effectiveDeadlineSeconds`). Nothing fires from it here; it lets
   * a re-ask or a retry tell that the run would end before it could (D-151, D-152).
   */
  deadlineAt?: number;
}

export interface ExecutionReport {
  status: "completed" | "failed" | "cancelled";
  audit: AuditEvent[];
  usage: JsonObject;
  provenance: { profile: string; interpreter: string; package_id: string; package_digest: string; synthetic: boolean };
  error_code?: string;
  output?: JsonValue;
  state?: JsonObject;
  /** What the run did with memory (memory.v0 §7, §9): the proposals it offers and the agent document's fate. */
  memory?: MemoryRunReport | null;
}

export interface WorkflowResult extends ExecutionReport {
  status: "completed";
  output: JsonValue;
  state: JsonObject;
}

type Node = JsonObject;

export class Workflow {
  readonly package: Package;
  readonly graph: JsonObject;
  readonly runtime: Runtime;
  private memoryReport: MemoryRunReport | null = null;
  private readonly schemas: PackageSchemas;
  private used = false;
  private cancelRequested = false;
  private readonly root: CancelToken;
  private output: JsonValue = null;
  /** Bundled model schemas by path: the package is immutable for the run, so one bundle per schema (review 1, nit 13). */
  private readonly modelSchemas = new Map<string, JsonValue>();

  private constructor(pkg: Package, schemas: PackageSchemas, options: WorkflowOptions) {
    this.package = pkg;
    this.graph = pkg.graph;
    this.schemas = schemas;
    const { deadlineAt, ...runtimeOptions } = options;
    this.root = new CancelToken(null, deadlineAt ?? Number.POSITIVE_INFINITY);
    this.runtime = new Runtime(pkg, schemas, runtimeOptions);
  }

  /**
   * Re-check the exact payload against its integrity statement and re-validate it (the
   * reference refuses mutable manifest or graph aliases a caller may have changed), then
   * build the runtime over the package's declared schemas.
   */
  static async create(pkg: Package, options: WorkflowOptions = {}): Promise<Workflow> {
    const integrity = await integrityStatement(pkg.files);
    if (canonicalString(integrity) !== canonicalString(pkg.integrity)) {
      throw new ValidationError("Package payload changed after integrity verification");
    }
    const payload = await validatePayload(pkg.files);
    const verified: Package = { ...pkg, manifest: payload.manifest, graph: payload.graph, policy: payload.policy, tools: payload.tools };
    if (verified.manifest.entrypoint !== PROFILE) throw new ValidationError("Generic execution requires entrypoint workflow.v0");
    const paths = (verified.manifest.schemas as JsonObject[]).map((entry) => String(entry.path));
    const schemas = await PackageSchemas.open(verified.files, paths);
    try {
      // memory.v0 M-40 holds in every mode: a host that supplies no memory context still gets the
      // proposals check, over an empty scan set and no grant.
      const memory = options.memory === undefined ? new MemoryRun(verified, [], options.grants ?? {}, {}) : options.memory;
      // compute.v0 preflight (D-245): the engine, the memory ceilings and the compiled modules,
      // before the runtime exists and before `runtime.started`, as the reference's constructor does.
      const computeLimits = computeHostLimits(options.limits);
      const computePrepared = await prepareCompute(verified, options.compute ?? null, computeLimits);
      return new Workflow(verified, schemas, { ...options, memory, computePrepared, computeLimits });
    } catch (error) {
      schemas.close();
      throw error;
    }
  }

  /** Host-side cancellation; cleanup completes before `run()` returns or throws. */
  cancel(): void {
    this.cancelRequested = true;
    this.root.cancel(new CancelledError());
  }

  /** Release the schema registrations; `run` does this itself when it ends. */
  close(): void {
    this.schemas.close();
  }

  private event(action: string, node: Node, ctx: Context | null = null, metadata: Record<string, JsonValue | undefined> = {}): void {
    const nodeId = ctx !== null && ctx.node_id !== null && ctx.node_id !== node.id ? `${ctx.node_id}/${node.id}` : String(node.id);
    this.runtime.record(action, { context: ctx, node_id: nodeId, node_type: node.type!, profile: PROFILE, ...metadata });
  }

  private async validate(path: string, instance: JsonValue, label: string): Promise<void> {
    await this.schemas.validateInstance(path, instance, label);
  }

  private async operation(node: Node, env: Environment, ctx: Context, token: CancelToken): Promise<JsonValue> {
    const value = evaluate(node.input!, env);
    if (Object.hasOwn(node, "when")) {
      const condition = node.when as JsonObject;
      const equal = pyEqual(evaluate(condition.left!, env), evaluate(condition.right!, env));
      if (equal !== (condition.op === "eq")) {
        this.event("node.skipped", node, ctx, { reason: "condition_false" });
        const result = evaluate(node.otherwise!, env);
        await this.validate(String(node.output_schema), result, `node ${node.id} skipped output`);
        return result;
      }
    }
    const kind = node.type;
    let result: JsonValue;
    if (kind === "llm") {
      // The router receives a bundled, offline schema. The host is authoritative.
      const schema = this.modelSchema(String(node.output_schema));
      const checks = (node.checks as JsonValue[] | undefined) ?? [];
      // Evaluated by the runtime on the schema-valid answer, before it is accepted (D-150).
      const options = checks.length > 0 ? { check: (answer: JsonValue) => checkAnswer(checks, env, answer) } : {};
      try {
        result = await ctx.model(String(node.task), value, schema, node.max_output_tokens as number, token, options);
      } catch (error) {
        if (error instanceof PolicyError || error instanceof TimeoutError || error instanceof CancelledError) throw error;
        // A refused answer check names itself on node.failed too.
        throw Object.assign(new WorkflowError(error instanceof ValidationError ? "schema_validation" : "model_error", String(node.id), { cause: error }), failedCheck(error));
      }
      // Also use the closed package validator, including formats and local refs.
      if ((await this.schemas.failures(String(node.output_schema), result)).length > 0) {
        throw new WorkflowError("schema_validation", String(node.id));
      }
    } else if (kind === "tool") {
      try {
        result = await ctx.tool(String(node.tool), value, token);
      } catch (error) {
        if (error instanceof BudgetError || error instanceof ValidationError || error instanceof TimeoutError || error instanceof CancelledError) throw error;
        // Provider adapters may subclass PolicyError; transport failures stay distinct.
        if (error instanceof PolicyError && Object.getPrototypeOf(error) === PolicyError.prototype) throw error;
        throw new WorkflowError("tool_error", String(node.id), { cause: error });
      }
    } else if (kind === "compute") {
      // compute.v0: a pure function of the constructed input, run by the host's engine under the
      // effective limits; its own failures are `compute_error`, an input or output outside the
      // node's schemas `schema_validation`, as for a tool. A failure of the engine itself is the
      // host's, not the module's: `worker_error` (C-40).
      try {
        result = await ctx.compute(node, value, token);
      } catch (error) {
        if (error instanceof BudgetError || error instanceof ValidationError || error instanceof TimeoutError || error instanceof CancelledError || error instanceof PolicyError) throw error;
        if (error instanceof ComputeError) throw Object.assign(new WorkflowError("compute_error", String(node.id), { cause: error }), { compute: error.facts() });
        throw new WorkflowError("worker_error", String(node.id), { cause: error });
      }
    } else if (kind === "join") {
      if (!Array.isArray(value)) throw new ValidationError(`node ${node.id}: join input must be an array`);
      const joined: JsonValue[] = [];
      for (const part of value) {
        const selected = select(part, String(node.select ?? ""));
        if (!Array.isArray(selected)) throw new ValidationError(`node ${node.id}: join members must select arrays`);
        joined.push(...selected);
      }
      result = joined;
      if (Object.hasOwn(node, "unique_by")) {
        const seen = new Map<string, string>();
        const unique: JsonValue[] = [];
        let identical = 0;
        let conflicting = 0;
        for (const item of joined) {
          let identityValue: JsonValue | null = null;
          for (const path of node.unique_by as JsonValue[]) {
            const key = select(item, String(path));
            if (key !== null && key !== "") {
              identityValue = [String(path), key];
              break;
            }
          }
          const key = digest(identityValue !== null ? identityValue : item);
          const itemDigest = digest(item);
          if (!seen.has(key)) {
            seen.set(key, itemDigest);
            unique.push(item);
          } else if (seen.get(key) === itemDigest) {
            identical += 1;
          } else {
            // A different record claiming the same identity: the first still wins, but the
            // loss is never silent.
            conflicting += 1;
          }
        }
        if (identical > 0 || conflicting > 0) {
          this.event("node.deduplicated", node, ctx, {
            original_count: joined.length,
            retained_count: unique.length,
            identical_duplicates: identical,
            conflicting_duplicates: conflicting,
            unique_by: [...(node.unique_by as JsonValue[])],
          });
        }
        result = unique;
      }
      if (Object.hasOwn(node, "limit")) {
        const limit = node.limit as number;
        if ((result as JsonValue[]).length > limit) {
          this.event("node.truncated", node, ctx, { original_count: (result as JsonValue[]).length, retained_count: limit });
        }
        result = (result as JsonValue[]).slice(0, limit);
      }
    } else {
      // validate and output are checked projections.
      checkAssertions((node.assertions as JsonValue[] | undefined) ?? [], env);
      result = value;
    }
    try {
      await this.validate(String(node.output_schema), result, `node ${node.id} output`);
    } catch (error) {
      if (error instanceof ValidationError) {
        Object.assign(error, { failed_check: { check: "output_schema", schema: node.output_schema } });
      }
      throw error;
    }
    return result;
  }

  /** `_model_schema`: bundle package-relative references into one local `$defs` namespace. */
  modelSchema(path: string): JsonValue {
    const cached = this.modelSchemas.get(path);
    if (cached !== undefined) return cached;
    const docs = new Map<string, JsonValue>();
    for (const entry of this.package.manifest.schemas as JsonObject[]) {
      const schemaPath = String(entry.path);
      docs.set(schemaPath, parseJson(this.package.files.get(schemaPath)!, schemaPath));
    }
    const names = new Map([...docs.keys()].sort().map((name, index) => [name, `s${index}`] as const));
    const bundle = (value: JsonValue, base: string): JsonValue => {
      if (Array.isArray(value)) return value.map((item) => bundle(item, base));
      if (!isJsonObject(value)) return value;
      const out: JsonObject = {};
      for (const [key, item] of Object.entries(value)) out[key] = bundle(item, base);
      if ("$ref" in value) {
        const [target, fragment] = schemaReference(base, String(value.$ref));
        out.$ref = `#/$defs/${names.get(target)!}${fragment}`;
      }
      return out;
    };
    const included: JsonObject = {};
    const pending: string[] = [path];
    const discover = (value: JsonValue, base: string): void => {
      if (isJsonObject(value)) {
        if ("$ref" in value) {
          const [target] = schemaReference(base, String(value.$ref));
          if (!(names.get(target)! in included) && !pending.includes(target)) pending.push(target);
        }
        for (const child of Object.values(value)) discover(child, base);
      } else if (Array.isArray(value)) {
        for (const child of value) discover(child, base);
      }
    };
    while (pending.length > 0) {
      const current = pending.pop()!;
      included[names.get(current)!] = bundle(docs.get(current)!, current);
      discover(docs.get(current)!, current);
    }
    const bundled: JsonValue = { $ref: `#/$defs/${names.get(path)!}`, $defs: included };
    this.modelSchemas.set(path, bundled);
    return bundled;
  }

  private async step(node: Node, env: Environment, ctx: Context, token: CancelToken): Promise<JsonValue> {
    this.event("node.started", node, ctx);
    ctx.operation_id = `${ctx.node_id}/${node.id}`;
    try {
      const result = await withDeadline(node.timeout_seconds as number, token, (bounded) => this.operation(node, env, ctx, bounded));
      this.event("node.completed", node, ctx, { output_hash: digest(result) });
      return result;
    } catch (error) {
      this.event("node.failed", node, ctx, { error_code: failureCode(error), ...failedCheck(error) });
      throw error;
    } finally {
      ctx.operation_id = undefined;
    }
  }

  private async map(node: Node, view: JsonObject, token: CancelToken): Promise<JsonValue> {
    const env: Environment = { state: view };
    const items = evaluate(node.input!, env);
    if (!Array.isArray(items) || items.length > (node.max_items as number)) {
      throw new ValidationError(`node ${node.id}: map input exceeds max_items or is not array`);
    }
    for (const item of items) await this.validate(String(node.item_schema), item, `node ${node.id} item`);
    const results: JsonValue[] = new Array<JsonValue>(items.length).fill(null);
    let cursor = 0;
    const consume = async (consumerToken: CancelToken): Promise<void> => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1; // No await between allocation and increment.
        const item = deepCopy(items[index]!);
        const work = async (ctx: Context, data: JsonObject, workerToken: CancelToken): Promise<JsonValue> => {
          const local: Environment = { state: data, item, steps: {} };
          for (const step of node.steps as JsonObject[]) {
            await yieldPoint(workerToken);
            (local.steps as JsonObject)[String(step.id)] = await this.step(step, local, ctx, workerToken);
          }
          return evaluate(node.yield!, local);
        };
        results[index] = await this.runtime.runWorker(String(node.worker), view, work, { returnValue: true, nodeId: String(node.id), token: consumerToken });
      }
    };
    const consumers = Math.min(node.max_parallel as number, items.length);
    await this.gather(Array.from({ length: consumers }, () => consume), token);
    await this.validate(String(node.output_schema), results, `node ${node.id} map output`);
    return results;
  }

  /**
   * `asyncio.gather` with the reference's failure rule: the first error cancels every sibling,
   * all of them are drained so no state or usage changes after the failure is reported, and
   * then the first error is raised.
   */
  private async gather<T>(starts: ReadonlyArray<(token: CancelToken) => Promise<T>>, parent: CancelToken): Promise<T[]> {
    const tokens = starts.map(() => parent.child());
    let failed = false;
    let first: unknown = undefined;
    const settled = await Promise.all(
      starts.map((start, index) =>
        start(tokens[index]!).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => {
            if (!failed) {
              failed = true;
              first = error;
              for (const token of tokens) token.cancel(new CancelledError());
            }
            return { ok: false as const, error };
          },
        ),
      ),
    );
    for (const token of tokens) token.dispose();
    if (failed) throw first;
    return settled.map((entry) => (entry as { ok: true; value: T }).value);
  }

  private async node(node: Node, snapshot: JsonObject, token: CancelToken): Promise<[JsonValue, JsonObject]> {
    const role = String(node.worker);
    const view: JsonObject = {};
    for (const key of (this.runtime.roles[role]!.state_read as JsonValue[]).map(String)) {
      if (Object.hasOwn(snapshot, key)) view[key] = deepCopy(snapshot[key]!);
    }
    this.event("node.started", node);
    try {
      const [result, patch] = await withDeadline(node.timeout_seconds as number, token, async (bounded): Promise<[JsonValue, JsonObject]> => {
        let value: JsonValue;
        if (node.type === "map") {
          value = await this.map(node, view, bounded);
        } else if (role === this.graph.coordinator) {
          value = await this.operation(node, { state: view }, this.runtime.coordinatorContext(), bounded);
        } else {
          value = await this.runtime.runWorker(
            role,
            view,
            (ctx, data, workerToken) => this.operation(node, { state: data }, ctx, workerToken),
            { returnValue: true, nodeId: String(node.id), token: bounded },
          );
        }
        const written: JsonObject = {};
        for (const [path, constructor] of Object.entries(node.writes as JsonObject)) {
          written[tokens(path)[0]!] = evaluate(constructor, { result: value });
        }
        const stateWrite = (this.runtime.roles[role]!.state_write as JsonValue[]).map(String);
        if (Object.keys(written).some((key) => !stateWrite.includes(key))) {
          throw new PolicyError("Node state write exceeds worker authorization");
        }
        return [value, written];
      });
      await this.validate(String((this.package.policy.memory as JsonObject).state_schema), { ...snapshot, ...patch }, `node ${node.id} state write`);
      this.event("node.completed", node, null, { output_hash: digest(result), state_keys: Object.keys(patch).sort() });
      return [result, patch];
    } catch (error) {
      this.event("node.failed", node, null, { error_code: failureCode(error), ...failedCheck(error) });
      if (error instanceof CancelledError) throw error;
      throw new WorkflowError(failureCode(error), String(node.id), { cause: error });
    }
  }

  async run(input: JsonValue): Promise<WorkflowResult> {
    if (this.used) throw new PolicyError("Workflow instances are single-use");
    this.used = true;
    const rt = this.runtime;
    rt.record("workflow.started", { profile: PROFILE, package_digest: this.package.digest, synthetic: Boolean(rt.router?.synthetic) });
    try {
      if (this.cancelRequested) throw new CancelledError();
      await this.validate(String(this.graph.input_schema), input, "workflow input");
      let state = evaluate(this.graph.initial_state!, { input }) as JsonObject;
      const statePath = String((this.package.policy.memory as JsonObject).state_schema);
      await this.validate(statePath, state, "initial state");
      // State access, including coordinator-only graphs, requires host authority.
      rt.authorizeMemory();
      rt.state = deepCopy(state);
      const pending = new Map<string, Node>((this.graph.nodes as Node[]).map((node) => [String(node.id), node]));
      const done = new Set<string>();
      await withDeadline(this.graph.deadline_seconds as number, this.root, async (token) => {
        while (pending.size > 0) {
          const ready = [...pending.values()].filter((node) => (node.depends_on as JsonValue[]).every((dependency) => done.has(String(dependency))));
          if (ready.length === 0) throw new ValidationError("Workflow has no runnable node");
          const snapshot = deepCopy(state);
          const results = await this.gather(
            ready.map((node) => (nodeToken: CancelToken) => this.node(node, snapshot, nodeToken)),
            token,
          );
          const next = deepCopy(state);
          ready.forEach((node, index) => {
            const [result, patch] = results[index]!;
            Object.assign(next, patch);
            if (node.type === "output") this.output = result;
          });
          await this.validate(statePath, next, "state commit");
          state = next;
          rt.state = deepCopy(state);
          for (const node of ready) {
            done.add(String(node.id));
            pending.delete(String(node.id));
          }
          rt.record("state.committed", { profile: PROFILE, nodes: ready.map((node) => String(node.id)), state_hash: digest(state) });
        }
      });
      await this.validate(String(this.graph.output_schema), this.output, "workflow output");
      for (const entry of (this.graph.exports as JsonValue[] | undefined) ?? []) {
        const record = entry as JsonObject;
        const value = evaluate(record.value!, { result: this.output });
        if (record.format === "text" && typeof value !== "string") throw new ValidationError("Text exports must select strings");
        // memory.v0 M-40: the proposals document is checked here, after the output, before
        // `workflow.completed`; a refusal fails the run with the check's code, and nothing is
        // written to the store by the run itself, ever (M-38).
        if (record.format === PROPOSALS_EXPORT_FORMAT && rt.memory !== null) {
          let checked;
          try {
            checked = await rt.memory.checkProposals(value);
          } catch (error) {
            if (!(error instanceof ProposalRefusal)) throw error;
            throw new WorkflowError(error.code, null, { cause: error });
          }
          rt.record("memory.proposed", { context: rt.coordinatorContext(), ...checked.facts });
          this.memoryReport = { proposals: checked.facts, refused: null, agent: null };
        }
      }
      rt.record("workflow.completed", { profile: PROFILE, output_hash: digest(this.output) });
      this.recordAgentOutcome("completed");
      const result: WorkflowResult = { ...this.report("completed"), status: "completed", output: deepCopy(this.output), state: deepCopy(state) };
      rt.clear();
      return result;
    } catch (error) {
      const code = failureCode(error);
      const cause = (error as { cause?: unknown }).cause;
      const refusal = error instanceof ProposalRefusal ? error : cause instanceof ProposalRefusal ? cause : null;
      if (refusal !== null) this.memoryReport = { proposals: null, refused: { code: refusal.code, reason: refusal.reason, index: refusal.index }, agent: null };
      rt.record(code === "cancelled" ? "workflow.cancelled" : "workflow.failed", {
        profile: PROFILE,
        error_code: code,
        node_id: (error as { node_id?: string | null } | null)?.node_id ?? null,
        ...(refusal !== null ? { reason: refusal.reason, ...(refusal.index !== null ? { proposal_index: refusal.index } : {}) } : {}),
      });
      this.recordAgentOutcome(code === "cancelled" ? "cancelled" : "failed");
      rt.clear();
      const report: ExecutionReport = { ...this.report(code === "cancelled" ? "cancelled" : "failed"), error_code: code };
      if (error instanceof CancelledError) {
        error.execution_report = report as unknown as Record<string, unknown>;
        throw error;
      }
      const failure = error instanceof WorkflowError ? error : new WorkflowError(code, null, { cause: error });
      failure.execution_report = report as unknown as Record<string, unknown>;
      throw failure;
    } finally {
      rt.coordinatorContext().closed = true;
      this.schemas.close();
    }
  }

  /** memory.v0 M-50: the staged agent body is committed only after `workflow.completed`, else discarded with its reason. */
  private recordAgentOutcome(status: ExecutionReport["status"]): void {
    const memory = this.runtime.memory;
    if (memory === null) return;
    const agent = memory.agentOutcome(status);
    if (agent === null) return;
    const context = this.runtime.coordinatorContext();
    if (agent.committed !== null) this.runtime.record("memory.agent.committed", { context, ...agent.committed });
    else if (agent.discarded !== null) this.runtime.record("memory.agent.discarded", { context, package_id: memory.agent!.package_id, reason: agent.discarded });
    this.memoryReport = { proposals: this.memoryReport?.proposals ?? null, refused: this.memoryReport?.refused ?? null, agent };
  }

  private report(status: ExecutionReport["status"]): ExecutionReport {
    return {
      status,
      ...(this.memoryReport !== null ? { memory: this.memoryReport } : {}),
      audit: this.runtime.audit,
      usage: this.runtime.usage,
      provenance: {
        profile: PROFILE,
        interpreter: INTERPRETER,
        package_id: String(this.package.manifest.package_id),
        package_digest: this.package.digest,
        synthetic: Boolean(this.runtime.router?.synthetic),
      },
    };
  }
}

export async function runWorkflow(pkg: Package, input: JsonValue, options: WorkflowOptions = {}): Promise<WorkflowResult> {
  const workflow = await Workflow.create(pkg, options);
  return workflow.run(input);
}
