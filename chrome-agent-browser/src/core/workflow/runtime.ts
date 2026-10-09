/**
 * Host-controlled execution: the capability mediator of `agentpkg/runtime.py`, line for line.
 *
 * Trusted interpreter code asks this object for everything that has authority: a worker slot,
 * a tool call, a model call. It checks the role allowlist, the person's grants, the explicit
 * tool approval, the budgets (with reservation before dispatch and conservative settlement),
 * the package's own schemas, and writes every decision into a hash-chained audit. Package data
 * never supplies a handler, and no generated text is executed as code.
 *
 * Differences from the reference that are properties of the host, not of the semantics: the
 * audit is hashed with a synchronous SHA-256 so `record` stays synchronous; the asyncio lock
 * around the budget sections is unnecessary because those sections contain no `await`; schema
 * validation is asynchronous (hyperjump) and is awaited where Python validates in place.
 */
import { canonicalJson } from "../canonical.js";
import { AgentPkgError, ValidationError } from "../errors.js";
import { sha256HexSync } from "../hash.js";
import { decodeUtf8, isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import type { ModelRequest, ModelRouter } from "../models/contract.js";
import type { Package } from "../package.js";
import { pyIsoTimestamp } from "../pyjson.js";
import { deepCopy } from "../references.js";
import { pyRepr } from "../repr.js";
import { failuresForSchema, validateDocument, type PackageSchemas } from "../schema.js";
import type { ToolContext, ToolHandler } from "../tools/handler.js";
import { schemaFacts } from "../tools/facts.js";
import type { AuditEvent } from "../types.js";
import { urlsplit } from "../urls.js";
import { CancelToken, withDeadline } from "./cancel.js";
import { AdapterError, BudgetError, CancelledError, errorName, PolicyError, TimeoutError } from "./errors.js";
import { Semaphore } from "./sync.js";

export type GrantDecision = "once" | "session" | "always" | "deny";
export type Grants = Record<string, GrantDecision>;

export interface HostLimits {
  hard_tokens?: number;
  max_remote_calls?: number;
  max_parallel_workers?: number;
  max_calls_per_tool?: number;
}

export type Observer = (event: AuditEvent) => void;

export interface RuntimeOptions {
  grants?: Grants | null;
  handlers?: Record<string, ToolHandler> | null;
  router?: ModelRouter | null;
  limits?: HostLimits | null;
  approvedTools?: readonly string[] | null;
  observer?: Observer | null;
}

const REASON = /^[a-z][a-z0-9_]{0,63}$/u;
// A fact value is a count, a flag, or a structural token such as a stop reason, a JSON Schema
// keyword or a schema location. No spaces and no quotes, so prose cannot pass.
const FACT_TEXT = /^[A-Za-z0-9_$.:/#-]{1,200}$/u;
export const MAX_FAILURE_FACTS = 12;
const LIMIT_KEYS = new Set(["hard_tokens", "max_remote_calls", "max_parallel_workers", "max_calls_per_tool"]);

export function safeFacts(facts: unknown): Record<string, JsonValue> {
  const safe: Record<string, JsonValue> = {};
  if (!isJsonObject(facts as JsonValue) && !(typeof facts === "object" && facts !== null && !Array.isArray(facts))) return safe;
  for (const [key, value] of Object.entries(facts as Record<string, unknown>)) {
    if (Object.keys(safe).length >= MAX_FAILURE_FACTS) break;
    if (!REASON.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 2 ** 53)) safe[key] = value;
    else if (typeof value === "string" && FACT_TEXT.test(value)) safe[key] = value;
  }
  return safe;
}

/**
 * `runtime.py::failure_reason`: a failed call's stable code and the structural facts its
 * adapter certified. Only an identifier-shaped code is recorded, never a message.
 */
export function failureReason(error: unknown): Record<string, JsonValue> {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !REASON.test(code)) return {};
  const facts = safeFacts((error as { audit_facts?: unknown }).audit_facts);
  return Object.keys(facts).length > 0 ? { reason: code, failure_facts: facts } : { reason: code };
}

/** `runtime.py::digest`: SHA-256 of the canonical JSON of a value. */
export function digest(value: unknown): string {
  return sha256HexSync(canonicalJson(value));
}

class WorkerUsage {
  tokens = 0;
  reserved_tokens = 0;
  remote_calls = 0;
  tool_calls: Record<string, number> = {};
}

/** An unforgeable-by-package capability given only to trusted host handlers. */
export class Context implements ToolContext {
  closed = false;
  node_id: string | null = null;
  operation_id: string | undefined = undefined;

  constructor(
    private readonly runtime: Runtime,
    readonly role: string,
    readonly worker_id: string,
    readonly depth: number,
    readonly parent: string | null,
  ) {}

  /** The runtime this context belongs to (identity check, never a capability). */
  get owner(): Runtime {
    return this.runtime;
  }

  tool(toolId: string, payload: JsonValue, token: CancelToken): Promise<JsonValue> {
    return this.runtime.callTool(this, toolId, payload, token);
  }

  model(task: string, payload: JsonValue, outputSchema: JsonValue, maxOutputTokens: number, token: CancelToken): Promise<JsonValue> {
    return this.runtime.callModel(this, task, payload, outputSchema, maxOutputTokens, token);
  }

  event(action: string, metadata: Record<string, JsonValue | undefined> = {}): void {
    this.runtime.checkContext(this);
    this.runtime.record(action, { context: this, ...metadata });
  }
}

export type WorkerOperation<T> = (context: Context, inputs: JsonObject, token: CancelToken) => Promise<T>;

export interface RunWorkerOptions {
  parent?: Context | null;
  depth?: number;
  returnValue?: boolean;
  nodeId?: string | null;
  token?: CancelToken;
}

/**
 * Capability mediator for trusted workflow code interpreting an untrusted graph. This is not a
 * sandbox: only host-installed operations run. No package module is imported and no generated
 * text is executed as code.
 */
export class Runtime {
  readonly package: Package;
  readonly policy: JsonObject;
  readonly roles: Record<string, JsonObject>;
  readonly coordinator: string;
  readonly grants: Grants;
  readonly handlers: Record<string, ToolHandler>;
  readonly router: ModelRouter | null;
  readonly approvedTools: Set<string>;
  readonly permissions: Record<string, JsonObject>;
  readonly budget: JsonObject;
  readonly run_id: string;
  state: JsonObject = {};
  readonly audit: AuditEvent[] = [];
  private readonly observer: Observer | null;
  private readonly schemas: PackageSchemas;
  private readonly usageByWorker = new Map<string, WorkerUsage>();
  private readonly contexts = new Map<string, Context>();
  private sequence = 0;
  private workerSequence = 0;
  private readonly global = new WorkerUsage();
  private readonly parallel: Semaphore;
  private readonly roleSlots: Record<string, Semaphore> = {};
  private active = 0;
  private peak = 0;
  private readonly onceUsed = new Set<string>();
  private halted: string | null = null;
  private readonly root: Context;

  constructor(pkg: Package, schemas: PackageSchemas, options: RuntimeOptions = {}) {
    this.package = pkg;
    this.schemas = schemas;
    this.observer = options.observer ?? null;
    this.policy = deepCopy(pkg.policy);
    this.roles = {};
    for (const worker of pkg.graph.workers as JsonObject[]) this.roles[String(worker.id)] = worker;
    this.coordinator = String(pkg.graph.coordinator);
    this.grants = { ...(options.grants ?? {}) };
    this.handlers = { ...(options.handlers ?? {}) };
    this.router = options.router ?? null;
    this.approvedTools = new Set(options.approvedTools ?? []);
    if ([...this.approvedTools].some((toolId) => !Object.hasOwn(pkg.tools, toolId))) {
      // An approval for something the signed package never declared is a host mistake, not a
      // broader permission: refused rather than ignored.
      throw new PolicyError("Tool approval refers to a tool this package does not declare");
    }
    this.permissions = {};
    for (const permission of this.policy.permissions as JsonObject[]) this.permissions[String(permission.id)] = permission;
    if (Object.keys(this.grants).some((pid) => !Object.hasOwn(this.permissions, pid))) {
      throw new PolicyError("Grant refers to an undeclared permission");
    }
    if (Object.values(this.grants).some((value) => !["once", "session", "always", "deny"].includes(value))) {
      throw new PolicyError("Grant must be once, session, always, or deny");
    }
    this.budget = deepCopy(this.policy.budget as JsonObject);
    for (const [key, value] of Object.entries(options.limits ?? {})) {
      if (!LIMIT_KEYS.has(key)) throw new PolicyError(`Unsupported host limit: ${key}`);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new PolicyError(`Host limit ${key} must be a nonnegative integer`);
      }
      if (key === "max_calls_per_tool") {
        // One host ceiling applied to every declared tool; like every other host limit it can
        // only lower a package's own cap.
        const caps = this.budget.max_calls_per_tool as JsonObject;
        for (const [toolId, cap] of Object.entries(caps)) caps[toolId] = Math.min(value, cap as number);
      } else {
        this.budget[key] = Math.min(value, this.budget[key] as number);
      }
    }
    if ((this.budget.max_parallel_workers as number) < 1) throw new PolicyError("At least one worker slot is required");
    const memory = this.policy.memory as JsonObject;
    if (memory.scope !== "session" && memory.scope !== "ephemeral") {
      throw new PolicyError("This runtime only implements session/ephemeral memory");
    }
    if (memory.raw_documents || memory.sharing !== "explicit_views") {
      throw new PolicyError("Raw document retention/shared mutable state is unsupported");
    }
    if ((this.policy.delegation as JsonObject).allow_remote) throw new PolicyError("Remote-agent delegation is not implemented");
    if (Object.values(this.roles).some((role) => role.kind !== "packaged")) {
      throw new PolicyError("Only declared packaged worker roles can execute");
    }
    const dependencies = pkg.manifest.dependencies;
    if (Array.isArray(dependencies) && dependencies.length > 0) throw new PolicyError("Dependency execution/loading is not implemented");
    this.run_id = crypto.randomUUID();
    this.parallel = new Semaphore(this.budget.max_parallel_workers as number);
    for (const [role, worker] of Object.entries(this.roles)) this.roleSlots[role] = new Semaphore(worker.max_instances as number);
    this.root = this.context(this.coordinator, "coordinator", 0, null);
    this.record("runtime.started", {
      context: this.root,
      package_id: pkg.manifest.package_id!,
      package_version: pkg.manifest.version!,
      package_digest: pkg.digest,
      grant_scopes: { ...this.grants },
      note: "always grants apply only to this Runtime; no persistent grant store",
    });
  }

  private context(role: string, workerId: string, depth: number, parent: string | null): Context {
    const ctx = new Context(this, role, workerId, depth, parent);
    this.contexts.set(workerId, ctx);
    this.usageByWorker.set(workerId, new WorkerUsage());
    return ctx;
  }

  coordinatorContext(): Context {
    return this.root;
  }

  checkContext(ctx: Context): void {
    if (this.halted !== null) throw new PolicyError(`Runtime halted: ${this.halted}`);
    if (ctx.owner !== this || this.contexts.get(ctx.worker_id) !== ctx || ctx.closed) {
      throw new PolicyError("Unknown or expired execution context");
    }
  }

  /** Append one hash-chained event; the observer sees a copy and cannot affect the run. */
  record(action: string, metadata: Record<string, JsonValue | Context | undefined | null> & { context?: Context | null } = {}): void {
    const { context, ...rest } = metadata;
    const ctx = context ?? null;
    this.sequence += 1;
    const event: Record<string, JsonValue> = {
      schema_version: "audit.v0",
      run_id: this.run_id,
      sequence: this.sequence,
      timestamp: pyIsoTimestamp(),
      action,
      worker: ctx ? ctx.worker_id : null,
      role: ctx ? ctx.role : null,
      parent: ctx ? ctx.parent : null,
      depth: ctx ? ctx.depth : 0,
      node_id: ctx ? (ctx.operation_id ?? ctx.node_id ?? null) : null,
      previous_hash: this.audit.length > 0 ? this.audit[this.audit.length - 1]!.event_hash : null,
    };
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) event[key] = value as JsonValue;
    event.event_hash = digest(event);
    const finished = event as unknown as AuditEvent;
    this.audit.push(finished);
    if (this.observer !== null) {
      try {
        this.observer(deepCopy(finished as unknown as JsonValue) as unknown as AuditEvent);
      } catch {
        // Observation must never affect a run.
      }
    }
  }

  private authorize(permissionIds: readonly string[], options: { consume?: boolean; context?: Context | null } = {}): void {
    for (const pid of permissionIds) {
      const grant: GrantDecision = this.grants[pid] ?? "deny";
      const spent = grant === "once" && this.onceUsed.has(pid);
      this.record("permission.checked", { context: options.context ?? null, permission: pid, grant, allowed: grant !== "deny" && !spent });
      if (grant === "deny" || spent) throw new PolicyError(`Permission denied or consumed: ${pid}`);
    }
    if (options.consume) {
      for (const pid of permissionIds) if (this.grants[pid] === "once") this.onceUsed.add(pid);
    }
  }

  permissionKind(kind: string): string[] {
    return Object.entries(this.permissions)
      .filter(([, permission]) => permission.kind === kind)
      .map(([pid]) => pid);
  }

  /** `_authorize(mem)` for the workflow's own state access, as `Workflow.run` performs it. */
  authorizeMemory(): void {
    const memory = this.permissionKind("memory");
    if (memory.length === 0) throw new PolicyError("Workflow state requires memory permission");
    this.authorize(memory, { context: this.root });
  }

  async runWorker<T>(role: string, inputs: JsonObject, operation: WorkerOperation<T>, options: RunWorkerOptions = {}): Promise<T> {
    const parent = options.parent ?? this.root;
    const depth = options.depth ?? 1;
    const token = options.token ?? new CancelToken();
    const nodeId = options.nodeId ?? null;
    const delegation = this.policy.delegation as JsonObject;
    try {
      this.checkContext(parent);
      if (role === this.coordinator || !Object.hasOwn(this.roles, role)) throw new PolicyError(`Undeclared or invalid worker role: ${role}`);
      if (!(delegation.approved_roles as JsonValue[]).includes(role)) throw new PolicyError(`Worker is not approved: ${role}`);
      if (parent !== this.root || depth !== parent.depth + 1 || depth > (delegation.max_depth as number)) {
        throw new PolicyError("Delegation depth exceeded; only coordinator may spawn workers");
      }
      this.record("delegation.checked", { context: parent, requested_role: role, allowed: true, requested_depth: depth, node_id: nodeId });
      const stateRead = (this.roles[role]!.state_read as JsonValue[]).map(String);
      if (!isJsonObject(inputs) || Object.keys(inputs).some((key) => !stateRead.includes(key))) {
        throw new PolicyError(`Worker ${role} input exceeds declared state_read fields`);
      }
      const memory = this.permissionKind("memory");
      if (memory.length === 0) throw new PolicyError("Worker state access requires a memory permission");
      this.authorize(memory, { consume: true, context: parent });
    } catch (error) {
      if (error instanceof PolicyError) this.record("worker.denied", { context: parent, requested_role: role, error: error.message });
      throw error;
    }
    // Acquire the global slot after the role slot so queued role instances do not starve others.
    const releaseRole = await this.roleSlots[role]!.acquire(token);
    let releaseGlobal: () => void;
    try {
      releaseGlobal = await this.parallel.acquire(token);
    } catch (error) {
      releaseRole();
      throw error;
    }
    try {
      this.checkContext(parent);
      this.workerSequence += 1;
      const ctx = this.context(role, `${role}:${this.workerSequence}`, depth, parent.worker_id);
      ctx.node_id = nodeId;
      this.record("worker.spawned", { context: ctx });
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      this.record("worker.started", {
        context: ctx,
        skills: this.roles[role]!.skills!,
        state_keys: Object.keys(inputs).sort(),
        input_hash: digest(inputs),
        active: this.active,
      });
      try {
        const patch = await operation(ctx, deepCopy(inputs), token);
        if (!options.returnValue && !isJsonObject(patch as JsonValue)) throw new PolicyError(`Worker ${role} must return a structured state patch`);
        if (!options.returnValue) {
          const stateWrite = (this.roles[role]!.state_write as JsonValue[]).map(String);
          if (Object.keys(patch as JsonObject).some((key) => !stateWrite.includes(key))) {
            throw new PolicyError(`Worker ${role} output exceeds declared state_write fields`);
          }
        }
        // Ensure messages are finite serializable data, never host object capabilities.
        digest(patch);
        this.record("worker.completed", {
          context: ctx,
          output_hash: digest(patch),
          state_keys: isJsonObject(patch as JsonValue) ? Object.keys(patch as JsonObject).sort() : [],
          status: "ok",
        });
        return deepCopy(patch as JsonValue) as T;
      } catch (error) {
        this.record("worker.failed", { context: ctx, status: "error", error: errorName(error) });
        throw error;
      } finally {
        ctx.closed = true;
        this.active -= 1;
      }
    } finally {
      releaseGlobal!();
      releaseRole();
    }
  }

  /** `map_workers`: one worker per input, results in input order, siblings cancelled on failure. */
  async mapWorkers<T>(role: string, inputs: readonly JsonObject[], operation: WorkerOperation<T>, parent: Context | null = null): Promise<T[]> {
    const tokens = inputs.map(() => new CancelToken());
    let firstError: unknown = undefined;
    let failed = false;
    const settled = await Promise.all(
      inputs.map((item, index) =>
        this.runWorker(role, item, operation, { parent, token: tokens[index] }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => {
            if (!failed) {
              failed = true;
              firstError = error;
              for (const token of tokens) token.cancel();
            }
            return { ok: false as const, error };
          },
        ),
      ),
    );
    if (failed) throw firstError;
    return settled.map((entry) => (entry as { ok: true; value: T }).value);
  }

  private remote(ctx: Context, count = 1): void {
    const own = this.usageByWorker.get(ctx.worker_id)!;
    if (this.global.remote_calls + count > (this.budget.max_remote_calls as number)) throw new BudgetError("Global remote-call budget exhausted");
    const roleBudget = this.roles[ctx.role]!.budget as JsonObject;
    if (own.remote_calls + count > (roleBudget.remote_calls as number)) throw new BudgetError(`Remote-call budget exhausted for ${ctx.worker_id}`);
    own.remote_calls += count;
    this.global.remote_calls += count;
    this.record("budget.updated", { context: ctx, remote_calls: this.global.remote_calls });
  }

  async callTool(ctx: Context, toolId: string, payload: JsonValue, token: CancelToken): Promise<JsonValue> {
    this.checkContext(ctx);
    const tool = Object.hasOwn(this.package.tools, toolId) ? this.package.tools[toolId]! : undefined;
    try {
      if (tool === undefined || !(this.roles[ctx.role]!.tools as JsonValue[]).includes(toolId)) {
        throw new PolicyError(`Role ${ctx.role} may not call tool ${toolId}`);
      }
      if (tool.execution !== "local" && tool.execution !== "remote") throw new PolicyError("Agent tool bindings are not implemented");
      if (tool.retries !== 0) throw new PolicyError("Automatic retries are unsupported");
      // A declared tool is a request; an approval is authority. A granted permission is not an
      // approval. Both are required, always, for every tool.
      if (!this.approvedTools.has(toolId)) throw new PolicyError(`Tool ${toolId} is declared but not explicitly approved`);
      const permissionIds = (tool.permissions as JsonValue[]).map(String);
      if (tool.execution === "remote") {
        const endpoint = urlsplit(String(tool.endpoint));
        const allowed = new Set(((this.policy.network as JsonObject).allowed_domains as JsonValue[]).map(String));
        const linked = new Set<string>();
        for (const pid of permissionIds) {
          const permission = this.permissions[pid]!;
          if (permission.kind === "network") for (const domain of permission.resources as JsonValue[]) linked.add(String(domain));
        }
        const domains = (tool.domains as JsonValue[]).map(String);
        if (
          endpoint.scheme !== "https" ||
          endpoint.hostname === null ||
          !domains.includes(endpoint.hostname) ||
          domains.some((domain) => !(allowed.has(domain) && linked.has(domain)))
        ) {
          throw new PolicyError("Tool network contract exceeds declared permission/policy");
        }
      }
      const handler = Object.hasOwn(this.handlers, String(tool.binding)) ? this.handlers[String(tool.binding)] : undefined;
      if (handler === undefined) throw new PolicyError(`No trusted host handler for ${tool.binding}`);
      try {
        await this.schemas.validateInstance(String(tool.input_schema), payload, "tool input");
      } catch (error) {
        if (error instanceof ValidationError) attach(error, "tool_request_invalid", schemaFacts(error, "input_schema"));
        throw error;
      }
      this.authorize(permissionIds, { context: ctx });
      const caps = this.budget.max_calls_per_tool as JsonObject;
      const cap = Object.hasOwn(caps, toolId) ? (caps[toolId] as number) : 0;
      if ((this.global.tool_calls[toolId] ?? 0) >= cap) throw new BudgetError(`Call budget exhausted for tool ${toolId}`);
      if (tool.execution === "remote") this.remote(ctx);
      this.authorize(permissionIds, { consume: true, context: ctx });
      this.global.tool_calls[toolId] = (this.global.tool_calls[toolId] ?? 0) + 1;
      const own = this.usageByWorker.get(ctx.worker_id)!;
      own.tool_calls[toolId] = (own.tool_calls[toolId] ?? 0) + 1;
      this.record("budget.updated", { context: ctx, tool_calls: { ...this.global.tool_calls } });
      this.record("tool.called", {
        context: ctx,
        tool: toolId,
        binding: tool.binding!,
        permissions: permissionIds,
        domains: tool.domains!,
        input_hash: digest(payload),
        remote_calls: this.global.remote_calls,
      });
      const result = await withDeadline(tool.timeout_seconds as number, token, (bounded) => handler(ctx, deepCopy(payload), bounded.signal));
      try {
        await this.schemas.validateInstance(String(tool.output_schema), result, "tool output");
      } catch (error) {
        if (error instanceof ValidationError) attach(error, "tool_response_invalid", schemaFacts(error, "output_schema"));
        throw error;
      }
      this.record("tool.completed", { context: ctx, tool: toolId, result_hash: digest(result), status: "ok" });
      return deepCopy(result);
    } catch (error) {
      if (error instanceof TimeoutError || error instanceof CancelledError) {
        const cancelled = error instanceof CancelledError;
        attach(error, cancelled ? "tool_cancelled" : "tool_timeout", {
          stage: cancelled ? "cancelled" : "timeout",
          [cancelled ? "cancelled" : "timeout"]: true,
        });
      }
      this.record("tool.failed", { context: ctx, tool: toolId, error: errorName(error), status: "error", ...failureReason(error) });
      throw error;
    }
  }

  async callModel(ctx: Context, task: string, payload: JsonValue, outputSchema: JsonValue, maxOutputTokens: number, token: CancelToken): Promise<JsonValue> {
    this.checkContext(ctx);
    const router = this.router;
    if (router === null) throw new PolicyError("No model router configured; select fixture/extractive mode explicitly");
    const requirements = this.package.manifest.model_requirements as JsonObject;
    if (requirements.privacy === "local-only" && router.remote) throw new PolicyError("Package requires a local-only model router");
    const declared = new Map((requirements.tasks as JsonObject[]).map((item) => [String(item.id), item]));
    const req = declared.get(task);
    if (req === undefined) throw new PolicyError(`Undeclared model task ${task}`);
    if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new PolicyError("max_output_tokens must be positive");
    }
    if ((req.capabilities as JsonValue[]).some((capability) => !router.capabilities.has(String(capability)))) {
      throw new PolicyError("Model router lacks package-required capabilities");
    }
    if (router.context_window < (req.context_window as number)) throw new PolicyError("Model router context window is insufficient");
    // Skill instructions are loaded from the verified package, separately from data.
    const skills = new Map((this.package.manifest.skills as JsonObject[]).map((skill) => [String(skill.id), String(skill.path)]));
    const instructions = (this.roles[ctx.role]!.skills as JsonValue[]).map((skillId) => {
      const path = skills.get(String(skillId))!;
      return decodeUtf8(this.package.files.get(path)!, path, "skill");
    });
    const request: ModelRequest = {
      task,
      instructions,
      data: deepCopy(payload),
      output_schema: outputSchema,
      requirements: deepCopy(req),
      budget_context: { max_output_tokens: maxOutputTokens },
      audit_context: { worker: ctx.worker_id, node_id: ctx.operation_id ?? ctx.node_id ?? null },
    };
    await validateDocument(request, "model-request", "model request");
    const permissions = this.permissionKind("model");
    if (permissions.length === 0) throw new PolicyError("Model use requires an explicit model permission");
    this.authorize(permissions, { context: ctx });
    // Token-count preflight is a separately budgeted call when it reaches the network (D-115).
    if (router.remote && router.remoteCount !== false) this.remote(ctx);
    // One logical model authorization covers both count and completion. Consume it before
    // sending any private context to a remote tokenizer.
    this.authorize(permissions, { consume: true, context: ctx });
    const domains = [...(router.domains ?? [])];
    this.record("model.count.called", {
      context: ctx,
      task,
      model: router.model_id,
      router: router.router_id,
      domains,
      input_hash: digest(request),
      permissions,
    });
    let inputBound: number;
    try {
      inputBound = await router.countTokens(request, token.signal);
    } catch (error) {
      this.record("model.count.failed", { context: ctx, task, error: errorName(error), ...failureReason(error) });
      throw error;
    }
    if (typeof inputBound !== "number" || !Number.isInteger(inputBound) || inputBound < 0) {
      throw new PolicyError("Router returned an invalid input token count");
    }
    const reservation = inputBound + maxOutputTokens;
    const refuse = (reason: string, message: string, facts: Record<string, JsonValue>): never => {
      // Which bound refused the call, in numbers, so a failed run can be classified from its audit.
      this.record("model.refused", {
        context: ctx,
        task,
        reason,
        input_bound: inputBound,
        max_output_tokens: maxOutputTokens,
        reserved_tokens: reservation,
        ...facts,
      });
      throw new BudgetError(message);
    };
    if (reservation > router.context_window) {
      refuse("context_window", "Model request exceeds configured context window", { context_window: router.context_window });
    }
    // One attempt: reserve against every bound, send, account. A live router's answer that does
    // not match the output schema is asked for once more with the same request (D-115): a fresh
    // reservation, remote call and audit pair, under the same one logical authorization. Nothing
    // is repaired; the second answer is validated exactly as the first.
    const attemptOnce = async (attempt: number): Promise<JsonValue> => {
      const own = this.usageByWorker.get(ctx.worker_id)!;
      this.checkContext(ctx);
      const hardTokens = this.budget.hard_tokens as number;
      if (this.global.tokens + this.global.reserved_tokens + reservation > hardTokens) {
        refuse("global_token_budget", "Global token budget exhausted before model dispatch", {
          used_tokens: this.global.tokens,
          held_tokens: this.global.reserved_tokens,
          limit: hardTokens,
        });
      }
      const roleTokens = (this.roles[ctx.role]!.budget as JsonObject).tokens as number;
      if (own.tokens + own.reserved_tokens + reservation > roleTokens) {
        refuse("worker_token_budget", `Token budget exhausted for ${ctx.worker_id}`, {
          used_tokens: own.tokens,
          held_tokens: own.reserved_tokens,
          limit: roleTokens,
        });
      }
      const threshold = this.budget.approval_threshold_tokens;
      if (typeof threshold === "number" && this.global.tokens + this.global.reserved_tokens + reservation > threshold) {
        throw new BudgetError("Token approval threshold exceeded; a new host grant is required");
      }
      if (router.remote) this.remote(ctx);
      own.reserved_tokens += reservation;
      this.global.reserved_tokens += reservation;
      this.record("budget.updated", { context: ctx, tokens: this.global.tokens, reserved_tokens: this.global.reserved_tokens });
      this.record("model.called", {
        context: ctx,
        task,
        model: router.model_id,
        router: router.router_id,
        domains,
        input_hash: digest(request),
        reserved_tokens: reservation,
        permissions,
        ...(attempt > 1 ? { attempt } : {}),
      });
      let used = reservation; // Unknown usage/errors consume reservation conservatively.
      try {
        const result = await router.complete(request, maxOutputTokens, token.signal);
        const inp = (result as { input_tokens?: unknown }).input_tokens;
        const out = (result as { output_tokens?: unknown }).output_tokens;
        const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
        const validCounts = count(inp) && count(out);
        if (validCounts) used = inp + out; // Report known overruns honestly, even above the cap.
        if (!validCounts || inp > inputBound || out > maxOutputTokens) {
          this.halted = "router violated token accounting contract";
          throw new PolicyError("Router violated token accounting contract; execution halted");
        }
        this.checkContext(ctx);
        await validateDocument(result, "model-result", "model response");
        const failures = await failuresForSchema(outputSchema, result.output, "model output");
        if (failures.length > 0) {
          const first = failures[0]!;
          throw new ValidationError(`model output does not match schema at ${first.instancePath.join("/") || "<root>"} (rule: ${first.keyword})`);
        }
        this.record("model.completed", {
          context: ctx,
          task,
          model: router.model_id,
          tokens: used,
          cost_usd: (result.cost_usd ?? null) as JsonValue,
          status: "ok",
          result_hash: digest(result.output),
        });
        return deepCopy(result.output);
      } catch (error) {
        // A non-conforming answer the provider reported in full is charged what it reported, so the
        // one retry (D-115) is not paid for twice at the conservative reservation; any other failure
        // keeps the reservation. The counts are bounded exactly as a successful call's are.
        if (error instanceof AdapterError && error.code === "model_output_not_conforming") {
          const reportedIn = error.audit_facts.reported_input_tokens;
          const reportedOut = error.audit_facts.reported_output_tokens;
          const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
          if (whole(reportedIn) && whole(reportedOut) && reportedIn <= inputBound && reportedOut <= maxOutputTokens) used = reportedIn + reportedOut;
        }
        this.record("model.failed", { context: ctx, task, error: errorName(error), tokens_charged: used, ...failureReason(error) });
        throw error;
      } finally {
        own.reserved_tokens -= reservation;
        this.global.reserved_tokens -= reservation;
        own.tokens += used;
        this.global.tokens += used;
        this.record("budget.updated", { context: ctx, tokens: this.global.tokens, reserved_tokens: this.global.reserved_tokens });
      }
    };
    // The one more request (D-115) is sent only when its fresh reservation fits every bound the
    // first attempt was checked against (D-124): otherwise the node fails with the answer that was
    // not conforming, not with the budget that a retry would have exceeded.
    const retryBlockedBy = (): Record<string, JsonValue> | null => {
      const own = this.usageByWorker.get(ctx.worker_id)!;
      const roleBudget = this.roles[ctx.role]!.budget as JsonObject;
      const hardTokens = this.budget.hard_tokens as number;
      const facts = (bound: string, used: number, held: number, limit: number): Record<string, JsonValue> => ({ bound, reserved_tokens: reservation, used_tokens: used, held_tokens: held, limit });
      if (this.global.tokens + this.global.reserved_tokens + reservation > hardTokens) return facts("global_token_budget", this.global.tokens, this.global.reserved_tokens, hardTokens);
      if (own.tokens + own.reserved_tokens + reservation > (roleBudget.tokens as number)) return facts("worker_token_budget", own.tokens, own.reserved_tokens, roleBudget.tokens as number);
      const threshold = this.budget.approval_threshold_tokens;
      if (typeof threshold === "number" && this.global.tokens + this.global.reserved_tokens + reservation > threshold) return facts("approval_threshold", this.global.tokens, this.global.reserved_tokens, threshold);
      if (router.remote && this.global.remote_calls + 1 > (this.budget.max_remote_calls as number)) return { bound: "global_remote_calls", remote_calls: this.global.remote_calls, limit: this.budget.max_remote_calls as number };
      if (router.remote && own.remote_calls + 1 > (roleBudget.remote_calls as number)) return { bound: "worker_remote_calls", remote_calls: own.remote_calls, limit: roleBudget.remote_calls as number };
      return null;
    };
    const retries = Math.max(0, Math.min(1, router.nonconformingRetries ?? 0));
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await attemptOnce(attempt);
      } catch (error) {
        const retry = attempt <= retries && error instanceof AdapterError && error.code === "model_output_not_conforming" && !token.signal.aborted && this.halted === null;
        if (!retry) throw error;
        const blocked = retryBlockedBy();
        if (blocked !== null) {
          this.record("model.retry_skipped", { context: ctx, task, reason: "budget", ...blocked });
          throw error;
        }
      }
    }
  }

  get usage(): JsonObject {
    const workers: JsonObject = {};
    for (const [worker, usage] of this.usageByWorker) {
      workers[worker] = { tokens: usage.tokens, remote_calls: usage.remote_calls, tool_calls: { ...usage.tool_calls } };
    }
    return {
      tokens: this.global.tokens,
      reserved_tokens: this.global.reserved_tokens,
      remote_calls: this.global.remote_calls,
      tool_calls: { ...this.global.tool_calls },
      peak_parallel_workers: this.peak,
      workers,
      limits: deepCopy(this.budget),
    };
  }

  clear(): void {
    for (const key of Object.keys(this.state)) delete this.state[key];
    this.record("memory.cleared", { context: this.root, scope: (this.policy.memory as JsonObject).scope! });
  }
}

/** `exc.code = …; exc.audit_facts = …` on a validation error, so `failureReason` reads them. */
function attach(error: AgentPkgError, code: string, facts: Record<string, JsonValue>): void {
  Object.assign(error, { code, audit_facts: facts });
}
