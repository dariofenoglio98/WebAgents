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
import { computeOperations, moduleFacts } from "../compute/declarations.js";
import { EngineUnavailable, ENGINE_UNAVAILABLE, type ComputeEngine, type ComputeOutcome } from "../compute/engine.js";
import { ComputeError } from "../compute/errors.js";
import { HOST_KEYS as COMPUTE_HOST_KEYS, hostComputeLimits, limitsJson, loweredBy, type ComputeLimits } from "../compute/limits.js";
import { ModuleError, type ModuleFacts } from "../compute/module.js";
import { AgentPkgError, ValidationError } from "../errors.js";
import { sha256HexSync } from "../hash.js";
import { decodeUtf8, isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json.js";
import type { ModelRequest, ModelRouter } from "../models/contract.js";
import type { Package } from "../package.js";
import { pyIsoTimestamp } from "../pyjson.js";
import { findAllSealed, findSealed } from "../memory/scan.js";
import type { MemoryRun } from "../memory/run.js";
import { deepCopy } from "../references.js";
import { pyRepr } from "../repr.js";
import { failuresForSchema, validateDocument, type PackageSchemas } from "../schema.js";
import type { RemoteCallBound, ToolContext, ToolHandler } from "../tools/handler.js";
import { schemaFacts } from "../tools/facts.js";
import type { AuditEvent } from "../types.js";
import { urlsplit } from "../urls.js";
import { AnswerCheckFailure } from "./assertions.js";
import { CancelToken, withDeadline } from "./cancel.js";
import { AdapterError, BudgetError, CancelledError, errorName, failedCheck, PolicyError, TimeoutError } from "./errors.js";
import { disclosedScalars, feedbackLine, type Refusal } from "./feedback.js";
import { Semaphore } from "./sync.js";

export type GrantDecision = "once" | "session" | "always" | "deny";
export type Grants = Record<string, GrantDecision>;

export interface HostLimits {
  hard_tokens?: number;
  max_remote_calls?: number;
  max_parallel_workers?: number;
  max_calls_per_tool?: number;
  /** compute.v0 (C-36): the host's ceilings for one compute call; a node may only lower them. */
  compute_memory_pages?: number;
  compute_wall_seconds?: number;
  compute_fuel?: number;
}

/**
 * Seconds a compute call's engine deadline trails its node's `timeout_seconds` (C-32), so the
 * node's own timeout, not the engine's deadline, is what ends a node that runs too long.
 */
export const TIMEOUT_GRACE = 1;

/** One declared module as the preflight prepared it: compiled by the engine, its facts decoded. */
export interface PreparedModule {
  path: string;
  sha256: string;
  facts: ModuleFacts;
}

function refusal(code: string, message: string): PolicyError {
  return Object.assign(new PolicyError(`${code}: ${message}`), { code });
}

/** The host's ceilings for one compute call, from the host limits; a value out of range is a policy refusal. */
export function computeHostLimits(limits: HostLimits | null | undefined): ComputeLimits {
  try {
    return hostComputeLimits(Object.fromEntries(Object.entries(limits ?? {}).filter(([key]) => COMPUTE_HOST_KEYS.includes(key))));
  } catch (error) {
    throw new PolicyError((error as Error).message);
  }
}

/**
 * compute.v0 preflight (`runtime.py::_prepare_compute`): the engine is present, every module's
 * declared memory maximum fits under the host's bound as its nodes lower it (`compute_limit_exceeded`:
 * refused, never lowered), and every module compiles. Before anything runs, so that a run never spends
 * a model call and then meets a module it cannot run. Asynchronous because compiling is; `Workflow.create`
 * awaits it before the runtime exists, which is where the reference's constructor does the same work.
 * Returns null for a package without compute operations.
 */
export async function prepareCompute(pkg: Package, engine: ComputeEngine | null, limits: ComputeLimits): Promise<Map<string, PreparedModule> | null> {
  const operations = computeOperations(pkg.graph);
  if (operations.length === 0) return null;
  if (engine === null) throw refusal(ENGINE_UNAVAILABLE, new EngineUnavailable("this host has no WebAssembly engine for the package's modules").message);
  const facts = moduleFacts(pkg);
  const modules = new Map<string, PreparedModule>();
  for (const module of (pkg.graph.modules as JsonObject[] | undefined) ?? []) {
    modules.set(String(module.id), { path: String(module.path), sha256: String(module.sha256), facts: facts[String(module.id)]! });
  }
  for (const [name, operation] of operations) {
    const effective = loweredBy(limits, operation.limits);
    const maximum = facts[String(operation.module)]!.memory_max_pages;
    if (maximum > effective.memory_pages) {
      throw refusal("compute_limit_exceeded", `node ${name} runs module ${pyRepr(String(operation.module))}, whose declared memory maximum of ${maximum} pages is above this host's ceiling of ${effective.memory_pages}`);
    }
  }
  for (const [moduleId, module] of modules) {
    try {
      await engine.compile(module.sha256, pkg.files.get(module.path)!);
    } catch (error) {
      if (error instanceof ModuleError) throw refusal(error.code, `module ${pyRepr(moduleId)}: ${error.reason}`);
      throw error;
    }
  }
  return modules;
}

export type Observer = (event: AuditEvent) => void;

/** At most this many re-asks of one model call, whatever a router declares (D-151; one under D-115). */
export const MAX_REASKS = 2;

/** What a model call needs beyond the request itself. */
export interface ModelCallOptions {
  /**
   * The node's answer checks (D-150): called with a copy of the schema-valid answer; throws an
   * `AnswerCheckFailure` to refuse it, which the call treats as a non-conforming answer.
   */
  check?: (answer: JsonValue) => void;
}

export interface RuntimeOptions {
  grants?: Grants | null;
  /**
   * What the run holds about memory (memory.v0 §7): the scan set for the egress guards M-36 and
   * M-37, the grants, the proposals check and the agent document. Null: no memory at all, an
   * empty scan set, nothing refused on that account.
   */
  memory?: MemoryRun | null;
  handlers?: Record<string, ToolHandler> | null;
  router?: ModelRouter | null;
  limits?: HostLimits | null;
  approvedTools?: readonly string[] | null;
  observer?: Observer | null;
  /** compute.v0: the host's engine; null when the host has none (a package with compute nodes is then refused before it starts). */
  compute?: ComputeEngine | null;
  /** The modules `prepareCompute` compiled for this package; `Workflow.create` supplies them. */
  computePrepared?: Map<string, PreparedModule> | null;
  /** The host's compute ceilings `Workflow.create` already read from `limits` (else read here). */
  computeLimits?: ComputeLimits | null;
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
  /** compute.v0: counted for the run only (`usage.compute_calls`), never per worker. */
  compute_calls = 0;
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

  model(task: string, payload: JsonValue, outputSchema: JsonValue, maxOutputTokens: number, token: CancelToken, options: ModelCallOptions = {}): Promise<JsonValue> {
    return this.runtime.callModel(this, task, payload, outputSchema, maxOutputTokens, token, options);
  }

  /** compute.v0: one call of a module's function on the constructed input (C-20…C-26). */
  compute(operation: JsonObject, payload: JsonValue, token: CancelToken): Promise<JsonValue> {
    return this.runtime.callCompute(this, operation, payload, token);
  }

  event(action: string, metadata: Record<string, JsonValue | undefined> = {}): void {
    this.runtime.checkContext(this);
    this.runtime.record(action, { context: this, ...metadata });
  }

  remoteCall(charge: boolean): RemoteCallBound | null {
    return this.runtime.extraRemoteCall(this, charge);
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
  readonly memory: MemoryRun | null;
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
  /** compute.v0: the host's engine and the modules the preflight prepared (empty for a package without compute nodes). */
  readonly compute: ComputeEngine | null;
  readonly computeLimits: ComputeLimits;
  private readonly modules: Map<string, PreparedModule>;

  constructor(pkg: Package, schemas: PackageSchemas, options: RuntimeOptions = {}) {
    this.package = pkg;
    this.schemas = schemas;
    this.observer = options.observer ?? null;
    this.memory = options.memory ?? null;
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
    // compute.v0: the host's ceilings for one compute call; a node may only lower them.
    this.computeLimits = options.computeLimits ?? computeHostLimits(options.limits);
    for (const [key, value] of Object.entries(options.limits ?? {})) {
      if (COMPUTE_HOST_KEYS.includes(key)) continue;
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
    // `agent-scoped` (memory.v0 M-48) keeps the run's state semantics of `session`; the package's
    // own document is a pair of tools, never state. The other scopes stay refused (M-1).
    if (memory.scope !== "session" && memory.scope !== "ephemeral" && memory.scope !== "agent-scoped") {
      throw new PolicyError("This runtime only implements session/ephemeral/agent-scoped memory");
    }
    if (memory.scope === "agent-scoped" && memory.retention !== "user-managed") throw new PolicyError("agent-scoped memory requires user-managed retention");
    if (memory.raw_documents || memory.sharing !== "explicit_views") {
      throw new PolicyError("Raw document retention/shared mutable state is unsupported");
    }
    if ((this.policy.delegation as JsonObject).allow_remote) throw new PolicyError("Remote-agent delegation is not implemented");
    if (Object.values(this.roles).some((role) => role.kind !== "packaged")) {
      throw new PolicyError("Only declared packaged worker roles can execute");
    }
    const dependencies = pkg.manifest.dependencies;
    if (Array.isArray(dependencies) && dependencies.length > 0) throw new PolicyError("Dependency execution/loading is not implemented");
    // compute.v0 preflight: `prepareCompute` ran before this constructor (it compiles, which is
    // asynchronous); a package with compute nodes and nothing prepared is refused here as the
    // reference refuses it in its constructor, before `runtime.started`.
    this.compute = options.compute ?? null;
    this.modules = options.computePrepared ?? new Map();
    if (this.modules.size === 0 && computeOperations(pkg.graph).length > 0) {
      if (this.compute === null) throw refusal(ENGINE_UNAVAILABLE, "this host has no WebAssembly engine for the package's modules");
      throw new PolicyError("compute modules were not prepared before the runtime was constructed");
    }
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

  private authorize(permissionIds: readonly string[], options: { consume?: boolean; context?: Context | null; nodeId?: string | null } = {}): void {
    for (const pid of permissionIds) {
      const grant: GrantDecision = this.grants[pid] ?? "deny";
      const spent = grant === "once" && this.onceUsed.has(pid);
      // C-44: a compute call names the operation it serves, which the coordinator's shared context cannot.
      this.record("permission.checked", { context: options.context ?? null, ...(options.nodeId !== undefined ? { node_id: options.nodeId } : {}), permission: pid, grant, allowed: grant !== "deny" && !spent });
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

  /**
   * The `memory` permissions that cover the run's own state: every one except the agent
   * document's (`resources: ["agent"]`, memory.v0 M-48), which authorizes the two agent tools and
   * nothing else, so denying it never stops the workflow's state access.
   */
  statePermissions(): string[] {
    return this.permissionKind("memory").filter((pid) => {
      const resources = (this.permissions[pid]!.resources as JsonValue[]).map(String);
      return !(resources.length === 1 && resources[0] === "agent");
    });
  }

  /** `_authorize(mem)` for the workflow's own state access, as `Workflow.run` performs it. */
  authorizeMemory(): void {
    const memory = this.statePermissions();
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
      const memory = this.statePermissions();
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

  /** The first remote-call bound `count` more calls would pass, with its figures; null when they fit. */
  private remoteBound(ctx: Context, count = 1): { bound: "global_remote_calls" | "worker_remote_calls"; remote_calls: number; limit: number } | null {
    const own = this.usageByWorker.get(ctx.worker_id)!;
    const limit = this.budget.max_remote_calls as number;
    if (this.global.remote_calls + count > limit) return { bound: "global_remote_calls", remote_calls: this.global.remote_calls, limit };
    const roleLimit = (this.roles[ctx.role]!.budget as JsonObject).remote_calls as number;
    if (own.remote_calls + count > roleLimit) return { bound: "worker_remote_calls", remote_calls: own.remote_calls, limit: roleLimit };
    return null;
  }

  /**
   * The first token bound a model reservation would pass, in the order a call is checked (the run's
   * budget, the worker's, the approval threshold), with its figures; null when it fits. One reading
   * for the first attempt and the retry (D-124; T10 review 1, nit 4).
   */
  private tokenBound(ctx: Context, reservation: number): { bound: "global_token_budget" | "worker_token_budget" | "approval_threshold"; used_tokens: number; held_tokens: number; limit: number } | null {
    const own = this.usageByWorker.get(ctx.worker_id)!;
    const hardTokens = this.budget.hard_tokens as number;
    if (this.global.tokens + this.global.reserved_tokens + reservation > hardTokens) return { bound: "global_token_budget", used_tokens: this.global.tokens, held_tokens: this.global.reserved_tokens, limit: hardTokens };
    const roleTokens = (this.roles[ctx.role]!.budget as JsonObject).tokens as number;
    if (own.tokens + own.reserved_tokens + reservation > roleTokens) return { bound: "worker_token_budget", used_tokens: own.tokens, held_tokens: own.reserved_tokens, limit: roleTokens };
    const threshold = this.budget.approval_threshold_tokens;
    if (typeof threshold === "number" && this.global.tokens + this.global.reserved_tokens + reservation > threshold) return { bound: "approval_threshold", used_tokens: this.global.tokens, held_tokens: this.global.reserved_tokens, limit: threshold };
    return null;
  }

  /**
   * One more remote request inside a tool call the runtime already charged (a host retry of a
   * read-only call, or a host fallback; D-152, D-153): the bound it would pass, or null, and
   * with `charge` the call is counted when it fits. It is checked exactly as every remote call is;
   * it is not another tool call.
   */
  extraRemoteCall(ctx: Context, charge: boolean): RemoteCallBound | null {
    this.checkContext(ctx);
    const exceeded = this.remoteBound(ctx);
    if (exceeded !== null || !charge) return exceeded;
    this.remote(ctx);
    return null;
  }

  private remote(ctx: Context, count = 1): void {
    const own = this.usageByWorker.get(ctx.worker_id)!;
    const exceeded = this.remoteBound(ctx, count);
    if (exceeded !== null) throw new BudgetError(exceeded.bound === "global_remote_calls" ? "Global remote-call budget exhausted" : `Remote-call budget exhausted for ${ctx.worker_id}`);
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
      this.scanToolArguments(ctx, toolId, String(tool.binding), permissionIds, payload);
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
      const result = await withDeadline(tool.timeout_seconds as number, token, (bounded) => handler(ctx, deepCopy(payload), bounded.signal, { deadline: bounded.deadline, side_effects: tool.side_effects === "read" ? "read" : "write" }));
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

  /**
   * One compute call (compute.v0 §4, `runtime.py::call_compute`): authorize the permission, check
   * the input against the node's `input_schema`, hand the canonical JSON bytes to the engine under
   * the effective limits, read back one strict JSON text, check it against `output_schema`. Three
   * audit events; nothing a module wrote is ever recorded.
   */
  async callCompute(ctx: Context, operation: JsonObject, payload: JsonValue, token: CancelToken): Promise<JsonValue> {
    this.checkContext(ctx);
    const moduleId = String(operation.module);
    const fn = String(operation.function);
    // The operation names itself (C-44): a worker's context carries its node (or map step), while
    // the coordinator's one context is shared by every coordinator node of a wave.
    const nodeId = ctx.operation_id ?? ctx.node_id ?? String(operation.id);
    const identity: Record<string, JsonValue> = { node_id: nodeId, module: moduleId, function: fn };
    let outcome: ComputeOutcome | null = null;
    try {
      const module = this.modules.get(moduleId);
      if (this.compute === null || module === undefined || !module.facts.functions.includes(fn)) {
        throw new PolicyError(`Undeclared compute module or function: ${moduleId}.${fn}`);
      }
      identity.module_sha256 = module.sha256;
      const permissions = this.permissionKind("compute");
      if (permissions.length !== 1 || !((this.permissions[permissions[0]!]!.resources as JsonValue[]).map(String).includes(moduleId))) {
        throw new PolicyError("Compute use requires the compute permission naming the module");
      }
      try {
        await this.schemas.validateInstance(String(operation.input_schema), payload, "compute input");
      } catch (error) {
        if (error instanceof ValidationError) attach(error, "compute_input_invalid", schemaFacts(error, "input_schema"));
        throw error;
      }
      const data = canonicalJson(payload);
      const limits = loweredBy(this.computeLimits, operation.limits);
      this.authorize(permissions, { context: ctx, nodeId });
      this.authorize(permissions, { consume: true, context: ctx, nodeId });
      this.global.compute_calls += 1;
      this.record("compute.called", { context: ctx, ...identity, input_hash: digest(payload), input_bytes: data.length, limits: limitsJson(limits), permissions });
      // The node's own timeout ends the node first (`timeout`); the engine's deadline follows it
      // shortly, so the abandoned call does not run on to the wall bound (C-32). The audit keeps
      // the effective limits of C-34. A cancel ends the call at once through the token.
      const deadline = Math.min(limits.wall_seconds, (operation.timeout_seconds as number) + TIMEOUT_GRACE);
      outcome = await this.compute.call(module.sha256, fn, data, { ...limits, wall_seconds: deadline }, token.signal);
      if (outcome.reason !== null) throw new ComputeError(outcome.reason, { trapCode: outcome.trap_code, detail: outcome.detail });
      let result: JsonValue;
      try {
        result = parseJson(outcome.output!, "compute output");
      } catch (error) {
        if (error instanceof ValidationError) throw new ComputeError("output_not_json", {});
        throw error;
      }
      try {
        await this.schemas.validateInstance(String(operation.output_schema), result, "compute output");
      } catch (error) {
        if (error instanceof ValidationError) attach(error, "compute_output_invalid", schemaFacts(error, "output_schema"));
        throw error;
      }
      this.record("compute.completed", { context: ctx, ...identity, output_hash: digest(result), output_bytes: outcome.output!.length, memory_pages: outcome.memory_pages, engine: this.engineFacts(outcome), status: "ok" });
      return result;
    } catch (error) {
      // A module's own failure is named by the specification's words (reason, trap code, detail);
      // any other failure by its adapter code, as a tool's is.
      const facts: Record<string, JsonValue> = error instanceof ComputeError ? error.facts() : failureReason(error);
      if (outcome !== null) {
        facts.memory_pages = outcome.memory_pages;
        facts.engine = this.engineFacts(outcome);
        facts.output_bytes = outcome.output !== null ? outcome.output.length : 0;
      }
      this.record("compute.failed", { context: ctx, ...identity, error: errorName(error), status: "error", ...facts });
      throw error;
    }
  }

  /** Which engine ran the call and what it measured; the figures are the engine's own (C-45: dropped when two runtimes' audits are compared). */
  private engineFacts(outcome: ComputeOutcome): JsonObject {
    return { id: this.compute!.id, elapsed_ms: outcome.elapsed_ms, fuel_consumed: outcome.fuel_consumed };
  }

  /**
   * memory.v0 M-36: before every tool call except a memory read, the arguments are scanned for
   * the run's scan set. A sealed value of a record this run was not granted goes nowhere; a
   * granted one goes only to a tool that links the permission it was granted under. The refusal
   * is recorded as a denied permission check naming the record and the pointer, never the value.
   */
  private scanToolArguments(ctx: Context, toolId: string, binding: string, permissionIds: readonly string[], payload: JsonValue): void {
    const memory = this.memory;
    if (memory === null || memory.scan.length === 0) return;
    if ((binding.startsWith("host.memory.") && !binding.startsWith("host.memory.agent.")) || binding.startsWith("host.resource.")) return;
    const hits = findAllSealed(payload, memory.scan);
    if (hits === "incomplete") {
      this.record("permission.checked", { context: ctx, permission: null, grant: "deny", allowed: false, reason: "sealed_value_not_granted", tool: toolId, incomplete: true });
      throw new PolicyError(`Tool ${toolId}: the arguments hold more strings than the sealed-value scan reads, so they are refused unread`);
    }
    // Every hit, in scan-set order: a value granted to this tool never lets another through (D-234).
    for (const hit of hits) {
      // A record may be granted under more than one permission (two tools, two reads of one type):
      // the value may go to any tool that links one of them (review 1, nit 9).
      const grants = memory.grants.filter((item) => item.resource_id === hit.record_id);
      if (grants.length === 0) {
        this.record("permission.checked", { context: ctx, permission: null, grant: "deny", allowed: false, reason: "sealed_value_not_granted", tool: toolId, record_id: hit.record_id, pointer: hit.pointer });
        throw new PolicyError(`Tool ${toolId}: the arguments carry a sealed value of a record this run was not granted (${hit.record_id} ${hit.pointer})`);
      }
      if (!grants.some((grant) => permissionIds.includes(grant.permission_id))) {
        const grant = grants[0]!;
        this.record("permission.checked", { context: ctx, permission: grant.permission_id, grant: this.grants[grant.permission_id] ?? "deny", allowed: false, reason: "sealed_value_egress", tool: toolId, record_id: hit.record_id, pointer: hit.pointer });
        throw new PolicyError(`Tool ${toolId}: the arguments carry a sealed value of ${hit.record_id} (${hit.pointer}) to a tool that does not link ${grants.map((item) => item.permission_id).join(" or ")}`);
      }
    }
  }

  /**
   * memory.v0 M-37: before every model request, the token count included, the complete request as
   * it will be sent is scanned for the scan set; a hit refuses the call before anything leaves,
   * naming the record id and the pointer, never the value. Fixture mode included (M-62).
   */
  private scanModelRequest(ctx: Context, task: string, request: JsonValue, attempt: number): void {
    const memory = this.memory;
    if (memory === null || memory.scan.length === 0) return;
    const hit = findSealed(request, memory.scan);
    if (hit === null) return;
    const facts: Record<string, JsonValue> = hit === "incomplete" ? { incomplete: true } : { record_id: hit.record_id, pointer: hit.pointer };
    this.record("model.refused", { context: ctx, task, reason: "sealed_value_in_model_request", ...facts, ...(attempt > 1 ? { attempt } : {}) });
    throw new PolicyError(hit === "incomplete" ? "The model request holds more strings than the sealed-value scan reads, so it is refused unread" : `The model request carries a sealed value of ${hit.record_id} (${hit.pointer}), which may not reach a model`);
  }

  async callModel(ctx: Context, task: string, payload: JsonValue, outputSchema: JsonValue, maxOutputTokens: number, token: CancelToken, options: ModelCallOptions = {}): Promise<JsonValue> {
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
    this.scanModelRequest(ctx, task, request as unknown as JsonValue, 1);
    const permissions = this.permissionKind("model");
    if (permissions.length === 0) throw new PolicyError("Model use requires an explicit model permission");
    this.authorize(permissions, { context: ctx });
    // Token-count preflight is a separately budgeted call when it reaches the network (D-115).
    if (router.remote && router.remoteCount !== false) this.remote(ctx);
    // One logical model authorization covers both count and completion. Consume it before
    // sending any private context to a remote tokenizer.
    this.authorize(permissions, { consume: true, context: ctx });
    const domains = [...(router.domains ?? [])];
    // The count preflight of one request (the first, or a re-ask with its feedback line): what the
    // model will see is bounded before anything is reserved or sent.
    const count = async (asked: ModelRequest, attempt: number): Promise<number> => {
      this.record("model.count.called", {
        context: ctx,
        task,
        model: router.model_id,
        router: router.router_id,
        domains,
        input_hash: digest(asked),
        permissions,
        ...(attempt > 1 ? { attempt } : {}),
      });
      let bound: number;
      try {
        bound = await router.countTokens(asked, token.signal);
      } catch (error) {
        this.record("model.count.failed", { context: ctx, task, error: errorName(error), ...failureReason(error), ...(attempt > 1 ? { attempt } : {}) });
        throw error;
      }
      if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 0) {
        throw new PolicyError("Router returned an invalid input token count");
      }
      return bound;
    };
    const inputBound = await count(request, 1);
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
    // One attempt: reserve against every bound, send, account. An answer that is not accepted (a
    // schema miss, no JSON, a refused answer check) may be asked for again (D-115, D-151): the
    // request plus one feedback line, recounted, with a fresh reservation, remote call and audit
    // pair, under the same one logical authorization. Nothing is repaired; every answer is
    // validated and checked exactly as the first.
    let refusedAnswer: JsonValue = null;
    const attemptOnce = async (attempt: number, asked: ModelRequest, askedBound: number, reserved: number, after: JsonObject | null): Promise<JsonValue> => {
      const own = this.usageByWorker.get(ctx.worker_id)!;
      this.checkContext(ctx);
      const exceeded = this.tokenBound(ctx, reserved);
      if (exceeded !== null) {
        const { bound, ...figures } = exceeded;
        if (bound === "global_token_budget") refuse(bound, "Global token budget exhausted before model dispatch", figures);
        if (bound === "worker_token_budget") refuse(bound, `Token budget exhausted for ${ctx.worker_id}`, figures);
        throw new BudgetError("Token approval threshold exceeded; a new host grant is required");
      }
      if (router.remote) this.remote(ctx);
      own.reserved_tokens += reserved;
      this.global.reserved_tokens += reserved;
      this.record("budget.updated", { context: ctx, tokens: this.global.tokens, reserved_tokens: this.global.reserved_tokens });
      this.record("model.called", {
        context: ctx,
        task,
        model: router.model_id,
        router: router.router_id,
        domains,
        input_hash: digest(asked),
        reserved_tokens: reserved,
        permissions,
        // A re-ask names the refusal that triggered it, by the package's pointers or the schema's (D-151).
        ...(attempt > 1 ? { attempt, after: after! } : {}),
      });
      let used = reserved; // Unknown usage/errors consume reservation conservatively.
      try {
        const result = await router.complete(asked, maxOutputTokens, token.signal);
        const inp = (result as { input_tokens?: unknown }).input_tokens;
        const out = (result as { output_tokens?: unknown }).output_tokens;
        const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
        const validCounts = whole(inp) && whole(out);
        if (validCounts) used = inp + out; // Report known overruns honestly, even above the cap.
        if (!validCounts || inp > askedBound || out > maxOutputTokens) {
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
        if (options.check) {
          // The node's answer checks (D-150) on the schema-valid answer; a refusal is a
          // non-conforming answer, charged what the router reported.
          refusedAnswer = deepCopy(result.output);
          options.check(deepCopy(result.output));
          refusedAnswer = null;
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
        // A non-conforming answer the provider reported in full is charged what it reported, so a
        // re-ask (D-115, D-151) is not paid for twice at the conservative reservation; any other
        // failure keeps the reservation. The counts are bounded exactly as a successful call's are.
        if (error instanceof AdapterError && error.code === "model_output_not_conforming") {
          const reportedIn = error.audit_facts.reported_input_tokens;
          const reportedOut = error.audit_facts.reported_output_tokens;
          const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
          if (whole(reportedIn) && whole(reportedOut) && reportedIn <= askedBound && reportedOut <= maxOutputTokens) used = reportedIn + reportedOut;
        }
        this.record("model.failed", { context: ctx, task, error: errorName(error), tokens_charged: used, ...failureReason(error), ...failedCheck(error) });
        throw error;
      } finally {
        own.reserved_tokens -= reserved;
        this.global.reserved_tokens -= reserved;
        own.tokens += used;
        this.global.tokens += used;
        this.record("budget.updated", { context: ctx, tokens: this.global.tokens, reserved_tokens: this.global.reserved_tokens });
      }
    };
    // A re-ask is sent only when it fits (D-124, D-151): its fresh reservation within the context
    // window and every bound the first attempt was checked against, and enough time before the
    // earliest deadline for an attempt as long as the one that failed. Otherwise the node fails
    // with the answer that was not accepted, never with the bound a re-ask would have passed.
    const reaskBlockedBy = (reserved: number, elapsedMs: number): Record<string, JsonValue> | null => {
      if (reserved > router.context_window) return { reason: "context_window", reserved_tokens: reserved, context_window: router.context_window };
      const tokens = this.tokenBound(ctx, reserved);
      if (tokens !== null) {
        const { bound, ...figures } = tokens;
        return { reason: "budget", bound, reserved_tokens: reserved, ...figures };
      }
      const remote = router.remote ? this.remoteBound(ctx) : null;
      if (remote !== null) return { reason: "budget", ...remote };
      const remaining = token.deadline - Date.now();
      if (remaining < elapsedMs) return { reason: "deadline", remaining_ms: Math.max(0, Math.floor(remaining)), last_attempt_ms: Math.floor(elapsedMs) };
      return null;
    };
    const retries = Math.max(0, Math.min(MAX_REASKS, router.nonconformingRetries ?? 0));
    let asked = request;
    let askedBound = inputBound;
    let reserved = reservation;
    let after: JsonObject | null = null;
    for (let attempt = 1; ; attempt += 1) {
      const started = Date.now();
      refusedAnswer = null;
      try {
        return await attemptOnce(attempt, asked, askedBound, reserved, after);
      } catch (error) {
        const notAccepted = (error instanceof AdapterError || error instanceof AnswerCheckFailure) && error.code === "model_output_not_conforming";
        if (!(attempt <= retries && notAccepted && !token.signal.aborted && this.halted === null)) throw error;
        const elapsed = Date.now() - started;
        const next: ModelRequest = { ...request, feedback: feedbackLine(refusalOf(error), disclosedScalars(request.data, refusedAnswer)) };
        this.scanModelRequest(ctx, task, next as unknown as JsonValue, attempt + 1);
        // A router whose count reaches the network pays for it as a remote call (D-115, D-125).
        if (router.remote && router.remoteCount !== false) {
          const remote = this.remoteBound(ctx);
          if (remote !== null) {
            this.record("model.retry_skipped", { context: ctx, task, attempt: attempt + 1, reason: "budget", ...remote });
            throw error;
          }
          this.remote(ctx);
        }
        const nextBound = await count(next, attempt + 1);
        const blocked = reaskBlockedBy(nextBound + maxOutputTokens, elapsed);
        if (blocked !== null) {
          this.record("model.retry_skipped", { context: ctx, task, attempt: attempt + 1, ...blocked });
          throw error;
        }
        asked = next;
        askedBound = nextBound;
        reserved = nextBound + maxOutputTokens;
        after = afterOf(error);
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
      // compute.v0: present exactly when the graph declares modules, so every earlier package's usage is unchanged.
      ...(this.modules.size > 0 ? { compute_calls: this.global.compute_calls } : {}),
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

/** Why an answer was not accepted, as a re-ask's feedback line names it (D-151). */
function refusalOf(error: unknown): Refusal {
  if (error instanceof AnswerCheckFailure) return { kind: "check", failed_check: error.failed_check, offending: error.offending };
  const refusal = error instanceof AdapterError ? (error.detail.refusal as Record<string, unknown> | undefined) : undefined;
  if (refusal?.kind === "not_json" || refusal?.kind === "no_text") return { kind: refusal.kind };
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
  if (refusal?.kind === "schema" && typeof refusal.keyword === "string" && strings(refusal.instance_path) && strings(refusal.missing)) {
    return { kind: "schema", keyword: refusal.keyword, instance_path: refusal.instance_path, missing: refusal.missing };
  }
  return { kind: "unknown" };
}

/** What a re-ask's `model.called` records about the refusal that triggered it: structure only, never data. */
function afterOf(error: unknown): JsonObject {
  if (error instanceof AnswerCheckFailure) return { output_failure: "check", failed_check: error.failed_check };
  const facts = error instanceof AdapterError ? safeFacts(error.audit_facts) : {};
  const after: JsonObject = { output_failure: typeof facts.output_failure === "string" ? facts.output_failure : "unknown" };
  for (const key of ["schema_keyword", "schema_location"]) if (typeof facts[key] === "string") after[key] = facts[key]!;
  return after;
}

/** `exc.code = …; exc.audit_facts = …` on a validation error, so `failureReason` reads them. */
function attach(error: AgentPkgError, code: string, facts: Record<string, JsonValue>): void {
  Object.assign(error, { code, audit_facts: facts });
}
