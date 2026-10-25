/**
 * The execution runner: verify, construct the generic runtime, run the graph
 * (`execution/session.py`). This is the composition layer and composing trusted components is all
 * it does: verified Package → Runtime (authority, budgets, audit) → Workflow (the generic
 * interpreter) → the bound router (the exact planned model) and one generic tool handler per
 * frozen binding. There is no runner for a particular package and no orchestration a graph could
 * not express. What it *adds* is refusal: before a package instruction can reach a model it
 * re-verifies the bytes against the plan, refuses declarations beyond this host's capabilities,
 * carries the person's decisions through unchanged, validates the input, and binds the exact model.
 *
 * Same process as the host here (no descriptor, no peer): the host hands in bytes, a router, the
 * tool dependencies and a resource resolver; the session hands back the result record and the
 * artifacts as named bytes. The host writes them.
 */
import type { ComputeEngine } from "../compute/engine.js";
import { canonicalString } from "../canonical.js";
import { AgentPkgError } from "../errors.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import { fixtureMemory, MemoryRun } from "../memory/run.js";
import type { ModelRouter } from "../models/contract.js";
import { packageJson, type Package } from "../package.js";
import { declaredSchemaPaths } from "../presentation.js";
import { pyIsoTimestamp } from "../pyjson.js";
import { networkPlan } from "../runplan.js";
import { deepCopy } from "../references.js";
import { PackageSchemas } from "../schema.js";
import { toolHandlers, type BoundToolHandler, type BrokerDeps } from "../tools/broker.js";
import type { ToolHandler } from "../tools/handler.js";
import type { ResourceResolver } from "../tools/resources.js";
import { MODE_MODEL } from "../types.js";
import { AuditChain, type ChainTail } from "../conversation/chain.js";
import type { ConsentDecision, ConsentHost, ConsentRequest } from "../conversation/host.js";
import { CancelledError } from "../workflow/errors.js";
import { INTERPRETER, PROFILE, Workflow, type ExecutionReport } from "../workflow/interpreter.js";
import { digest, type Grants, type TurnContext } from "../workflow/runtime.js";
import type { AuditEvent } from "../types.js";
import type { ArtifactEvidence } from "./artifact.js";
import { artifactRecords, type ArtifactRecord } from "./artifacts.js";
import { ALREADY_STARTED, ARTIFACTS_FAILED, ExecutionError, INPUT_INVALID, invalid, NOT_BOUND, PERMISSION_DENIED, PLAN_INVALID, RUNTIME_REFUSED } from "./errors.js";
import { buildInvocation, type RunInvocationRecord } from "./invocation.js";
import { effectiveBudget, effectiveDeadlineSeconds, normalizeHostLimits, runtimeLimits, type HostExecutionLimits } from "./limits.js";
import { normalizeAuthorization, normalizeExecutionPlan, type ExecutionAuthorization, type ExecutionPlan } from "./plan.js";
import { checkCapabilities, checkModel, checkResourceGrants, checkTools, grantReport, normalizeGrants } from "./policy.js";
import { ProgressTracker, type ProgressListener, type ProgressSnapshot } from "./progress.js";
import { auditSummary, costSummary, failureSummary, modelEvidence } from "./report.js";
import { verifyExecutionArtifact } from "./artifact.js";

export const EXECUTION_RESULT_SCHEMA = "agentpkg-execution-result-v0";
export const EXECUTION_PROTOCOL_VERSION = "chrome-agent-browser-execution-v0";
export const TOOL_HANDLER_KIND = "chrome-agent-browser.tools.BoundToolHandler";
export const FIXTURE_HANDLER_KIND = "chrome-agent-browser.tools.fixtureToolHandler";
export const MAX_ARTIFACTS = 64;

export interface HostFacts {
  runtime?: string | null;
  runtime_version?: string | null;
  verified_version?: string | null;
}

/**
 * conversation.v0 (D-270): what one turn of a conversation starts from, handed in by the host that
 * holds the conversation between turns: the persisted state, where the chain stood, the `once`
 * grants earlier turns spent, the per-tool calls the conversation has left, and the consent steps a
 * preset or a policy decided before the conversation (D-271). Serializable: it travels to a Worker.
 */
export interface TurnStart {
  conversation_id: string;
  turn: number;
  state: JsonObject;
  chain_tail: ChainTail;
  spent_permissions: string[];
  tool_caps: Record<string, number>;
  pre_decided: Record<string, { accepted: boolean; decided_by: "preset" | "policy"; reason: string | null }>;
}

export interface BeginRequest {
  run_id: string;
  /** An `ExecutionPlan`, or the raw facts `normalizeExecutionPlan` accepts. */
  run_plan: ExecutionPlan | unknown;
  authorization: ExecutionAuthorization | unknown;
  limits?: unknown;
  input: JsonValue;
  attachments?: unknown;
  host?: HostFacts | null;
  /** conversation.v0: the turn this run is; absent for a one-shot run (a conversational package is then refused, V-28). */
  turn?: TurnStart | null;
}

/** The package's own fixture (`fixtureAdapters`), when the plan says so. */
export interface FixtureSource {
  router: ModelRouter;
  handlers: Record<string, ToolHandler>;
}

export interface SessionDeps {
  /** The bytes to run; verified here against the plan whatever the caller already checked. */
  archive: Uint8Array;
  /** The router over the exact planned model (a model-backed plan), built by the host from the plan's binding. */
  router?: ModelRouter | null;
  /** What the host holds for tools: definitions, transport, credentials, built-ins, pacer, observer. */
  tools?: BrokerDeps | null;
  /** The store that resolves the plan's resource grants. */
  resolver?: ResourceResolver | null;
  /**
   * What the run holds about memory (memory.v0 §7): the host builds it from its store when the
   * run is opened with the store. Absent: a context with an empty scan set, or in fixture mode
   * the fixture's own sealed values (M-62).
   */
  memory?: MemoryRun | null;
  /** The package fixture, for a fixture plan. */
  fixture?: FixtureSource | null;
  /** compute.v0: the host's WebAssembly engine (one nested Worker per call, D-251); null refuses a package with compute nodes before it starts. */
  compute?: ComputeEngine | null;
  /** conversation.v0: the host that asks the person a consent step (the chat surface); required for a turn, unused otherwise. */
  consent?: ConsentHost | null;
  onProgress?: ProgressListener | null;
  progressIntervalSeconds?: number;
  /**
   * Every audit event as it is recorded (a copy; D-060's observer), for a host that checkpoints
   * the run after each wave (`state.committed`, D-071). A listener that throws is ignored and
   * never steers the run.
   */
  onAudit?: ((event: AuditEvent) => void) | null;
  now?: () => Date;
}

export interface BeginReport extends JsonObject {
  protocol: string;
  run_id: string;
  run_plan_id: string;
  run_plan_sha256: string;
  invocation: JsonObject;
  package: ArtifactEvidence;
  authorization: JsonObject;
  capabilities: JsonObject;
  model: JsonObject | null;
  tools: JsonObject;
  resources: JsonObject;
  router: JsonObject | null;
  limits: JsonObject;
  execution: JsonObject;
}

export interface ExecutionResult extends JsonObject {
  schema: typeof EXECUTION_RESULT_SCHEMA;
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  error_code: string | null;
  deadline_exceeded: boolean;
  cancel_requested: boolean;
}

export interface ExecutionOutcome {
  result: ExecutionResult;
  /** The run's files as named bytes, in write order: result, audit, usage, provenance, exports. */
  files: ArtifactRecord[];
  /** The report the interpreter produced (completed result or classified failure), for the host's record. */
  report: ExecutionReport;
  /** conversation.v0 (V-13): the `once` grants spent so far in the conversation, this turn's included; empty for a one-shot run. */
  spentPermissions: string[];
}

function isPlan(value: unknown): value is ExecutionPlan {
  return typeof value === "object" && value !== null && Array.isArray((value as ExecutionPlan).tool_bindings) && typeof (value as ExecutionPlan).execution === "object" && typeof (value as ExecutionPlan).execution.fixture === "boolean";
}

function isAuthorization(value: unknown): value is ExecutionAuthorization {
  return typeof value === "object" && value !== null && typeof (value as ExecutionAuthorization).decisions === "object" && typeof (value as ExecutionAuthorization).tool_approvals === "object" && Object.hasOwn(value as object, "issued_at");
}

/** Any router's self-description for the reports: the contract's fields plus `describe()` when it has one. */
export function describeRouter(router: ModelRouter): JsonObject {
  const base: JsonObject = {
    router_id: router.router_id,
    model_id: router.model_id,
    remote: router.remote,
    capabilities: [...router.capabilities].sort(),
    context_window: router.context_window,
    synthetic: router.synthetic === true,
  };
  const describe = (router as { describe?: () => JsonObject }).describe;
  return typeof describe === "function" ? { ...base, ...describe.call(router) } : base;
}

/** One run, from bound plan to result and artifacts, and then nothing more. */
export class ExecutionSession {
  plan: ExecutionPlan | null = null;
  package: Package | null = null;
  router: ModelRouter | null = null;
  invocation: RunInvocationRecord | null = null;
  begun: BeginReport | null = null;
  private grants: Grants = {};
  private limits: HostExecutionLimits = normalizeHostLimits(null);
  private input: JsonValue = null;
  private evidence: ArtifactEvidence | null = null;
  private host: HostFacts = {};
  private handlers: Record<string, ToolHandler> = {};
  private handlerKind = TOOL_HANDLER_KIND;
  private boundTools: BoundToolHandler[] = [];
  private approvedTools: string[] = [];
  private tools: JsonObject = {};
  private deps: SessionDeps | null = null;
  private memory: MemoryRun | null = null;
  private workflow: Workflow | null = null;
  private started = false;
  private finished = false;
  private cancelRequested = false;
  private timedOut = false;
  private outcome: ExecutionReport | null = null;
  private tracker: ProgressTracker | null = null;
  /** conversation.v0: the turn this session runs, or null. */
  private turnStart: TurnStart | null = null;

  // -- bind --------------------------------------------------------------------------------
  async begin(request: BeginRequest, deps: SessionDeps): Promise<BeginReport> {
    if (this.plan !== null) throw new ExecutionError(ALREADY_STARTED, "This execution session is already bound");
    if (typeof request.run_id !== "string" || request.run_id.length === 0 || request.run_id.length > 128) throw invalid("run_id must be a string of 1 to 128 characters");
    const plan = isPlan(request.run_plan) ? request.run_plan : normalizeExecutionPlan(request.run_plan);
    const authorization = isAuthorization(request.authorization) ? request.authorization : normalizeAuthorization(request.authorization);
    const limits = normalizeHostLimits(request.limits);
    const host = request.host ?? {};

    // 1. The bytes. Verified here, independently, against the plan's identity.
    const { package: pkg, evidence } = await verifyExecutionArtifact(deps.archive, {
      archive_sha256: plan.package.archive_sha256,
      digest: plan.package.digest,
      package_id: plan.package.package_id,
      version: plan.package.version,
      signer_fingerprint: plan.publisher.signer_fingerprint,
    });

    // 2. What this host can and cannot run, from the graph's declarations.
    const fixture = plan.execution.fixture;
    if (fixture && !deps.fixture) throw new ExecutionError(PLAN_INVALID, "A fixture plan needs the package's fixture adapters");
    if (!fixture && deps.fixture) throw new ExecutionError(PLAN_INVALID, "A model-backed plan runs no fixture");
    const turn = request.turn ?? null;
    const conversational = pkg.graph.conversation !== undefined && pkg.graph.conversation !== null;
    if (turn !== null && !conversational) throw new ExecutionError(PLAN_INVALID, "A turn was given for a package that declares no conversation");
    if (turn !== null && !deps.consent) throw new ExecutionError(PLAN_INVALID, "A turn needs the host's consent host");
    if (turn !== null && (plan.execution.conversation ?? null) === null) throw new ExecutionError(PLAN_INVALID, "A turn needs a plan that records the conversation");
    // network.v0 (R-24): the envelope the person agreed to is the one the signed declaration gives,
    // re-derived here; a plan that describes it differently, or omits it, is refused, not believed.
    if (plan.execution.mode === MODE_MODEL && canonicalString(plan.execution.network ?? null) !== canonicalString(networkPlan(pkg))) {
      throw new ExecutionError(PLAN_INVALID, "The run plan's delegation envelope does not match the package's own declaration");
    }
    const capabilities =
      plan.execution.mode === MODE_MODEL
        ? checkCapabilities(pkg, limits, { toolBindings: plan.tool_bindings, deniedTools: plan.execution.denied_tool_ids, fixture, computeAvailable: (deps.compute ?? null) !== null, turn: turn !== null })
        : { tools_declared: Object.keys(pkg.tools).length, tool_bindings: plan.tool_bindings.length, mode: "tool_probe", note: "A tool probe binds one declared tool. Whether this host could run the whole package is a different question, and a model-backed plan asks it." };

    // 3. The person's decisions, unchanged or refused.
    const grants = normalizeGrants(pkg, authorization.decisions);
    for (const permissionId of plan.execution.required_permission_ids) {
      if ((grants[permissionId] ?? "deny") === "deny") {
        throw new ExecutionError(PERMISSION_DENIED, `A model-backed run requires permission '${permissionId}', which is denied.`, { detail: { permission: permissionId } });
      }
    }
    // 3b. Every tool binding, re-derived from the verified package and compared with the plan,
    //     then matched against the approvals the person actually gave.
    const tools = fixture
      ? { declared: Object.keys(pkg.tools).sort(), bound: Object.keys(pkg.tools).sort(), bindings: [], source: "package_fixture", note: "Fixture mode: the package's own recorded tool answers stand in for every declared tool. No host implementation is bound and nothing is reached." }
      : checkTools(pkg, plan.tool_bindings, grants, authorization.tool_approvals);
    // 3c. The host resources the person picked, by reference only.
    const resources = checkResourceGrants(pkg, plan.resource_grants, grants);
    // 3d. Memory (memory.v0 §7): the scan set, the grants, the agent document.
    let memory = deps.memory ?? null;
    if (memory === null) {
      const fixturePath = pkg.graph.fixture;
      const fixtureDocument = fixture && typeof fixturePath === "string" ? (packageJson(pkg, fixturePath) as JsonObject) : null;
      if (fixtureDocument !== null) {
        // D-230: without a store, the fixture's replayed answers give the scan set, the grants
        // (unless the plan names its own) and the update targets, as `agentpkg run` derives them.
        const derived = fixtureMemory(pkg, fixtureDocument, grants);
        const memoryGrants = plan.resource_grants.length > 0 ? plan.resource_grants : derived.grants;
        memory = new MemoryRun(pkg, memoryGrants, grants, { scan: derived.scan, targets: derived.targets });
      } else memory = new MemoryRun(pkg, plan.resource_grants, grants, {});
    }
    let handlers: Record<string, ToolHandler>;
    let bound: BoundToolHandler[] = [];
    if (fixture) {
      handlers = { ...deps.fixture!.handlers };
      this.handlerKind = FIXTURE_HANDLER_KIND;
    } else {
      const brokerDeps: BrokerDeps = { ...(deps.tools ?? { definitions: [] }) };
      if (plan.resource_grants.length > 0) {
        if (!deps.resolver) throw new ExecutionError(PLAN_INVALID, "This plan grants host resources and the host supplied no store to resolve them");
        brokerDeps.resources = { grants: plan.resource_grants, resolver: deps.resolver };
      } else if (deps.resolver) brokerDeps.resources = { grants: [], resolver: deps.resolver };
      brokerDeps.memory = { agent: memory.agent };
      ({ handlers, bound } = toolHandlers(plan.tool_bindings, brokerDeps));
    }

    // 4. The exact model, and whether it can satisfy the package at all. A tool probe binds
    //    none, so none is constructed.
    let router: ModelRouter | null = null;
    let model: JsonObject | null = null;
    if (plan.execution.mode === MODE_MODEL) {
      router = fixture ? deps.fixture!.router : (deps.router ?? null);
      if (router === null) throw new ExecutionError(PLAN_INVALID, "A model-backed plan needs the router over its bound model");
      if (!fixture && plan.model_binding !== null && router.model_id !== plan.model_binding.host_model_id) {
        throw new ExecutionError("selected_model_unavailable", "The router the host supplied is not bound to the model the run plan names", { detail: { planned: plan.model_binding.host_model_id, router: router.model_id } });
      }
      model = checkModel(pkg, router);
    }

    // 5. The task, checked against the package's own input schema before an instruction is rendered.
    const invocation = buildInvocation({ run_id: request.run_id, plan, input: request.input, attachments: request.attachments, created_at: (deps.now ?? (() => new Date()))() });
    try {
      const schemas = await PackageSchemas.open(pkg.files, declaredSchemaPaths(pkg));
      try {
        await schemas.validateInstance(String(pkg.graph.input_schema), request.input, "workflow input");
      } finally {
        schemas.close();
      }
    } catch (error) {
      if (!(error instanceof AgentPkgError)) throw error;
      throw new ExecutionError(INPUT_INVALID, `The workflow input does not satisfy the package input schema: ${error.message}`);
    }

    this.plan = plan;
    this.package = pkg;
    this.router = router;
    this.invocation = invocation;
    this.grants = grants;
    this.limits = limits;
    this.input = request.input;
    this.evidence = evidence;
    this.handlers = handlers;
    this.boundTools = bound;
    this.memory = memory;
    this.turnStart = turn;
    // Approval travels with the plan: every bound tool is an approved tool (checked above); in
    // fixture mode the approvals are the operator's list, as `agentpkg run` requires.
    this.approvedTools = fixture
      ? Object.keys(authorization.tool_approvals).filter((toolId) => authorization.tool_approvals[toolId] === true && Object.hasOwn(pkg.tools, toolId)).sort()
      : plan.tool_bindings.map((binding) => binding.tool_id);
    this.tools = tools as JsonObject;
    this.host = { runtime: host.runtime ?? null, runtime_version: host.runtime_version ?? null, verified_version: host.verified_version ?? null };
    this.deps = deps;
    this.begun = {
      protocol: EXECUTION_PROTOCOL_VERSION,
      run_id: request.run_id,
      run_plan_id: plan.run_plan_id,
      run_plan_sha256: plan.run_plan_sha256,
      invocation: invocation as unknown as JsonObject,
      package: evidence,
      authorization: { receipt_id: authorization.receipt_id, receipt_sha256: authorization.receipt_sha256, ...grantReport(pkg, grants) },
      capabilities,
      model,
      tools: tools as JsonObject,
      resources,
      router: router !== null ? describeRouter(router) : null,
      limits: {
        host: { ...limits },
        budget: effectiveBudget(pkg, limits),
        graph_deadline_seconds: pkg.graph.deadline_seconds!,
        effective_deadline_seconds: effectiveDeadlineSeconds(pkg, limits),
      },
      execution: {
        profile: String(pkg.graph.profile ?? pkg.manifest.entrypoint),
        interpreter: INTERPRETER,
        tool_handlers: Object.keys(handlers).length,
        tool_handler_kind: this.handlerKind,
        fixture,
        note: "The generic interpreter runs the package's own graph. This runner contains no package-specific orchestration; every tool handler it installs is the same generic handler, parameterized by one binding the run plan froze.",
      },
    };
    return this.begun;
  }

  // -- run ---------------------------------------------------------------------------------
  async run(): Promise<ExecutionOutcome> {
    if (this.plan === null || this.package === null || this.deps === null) throw new ExecutionError(NOT_BOUND, "Begin an execution session before running it");
    if (this.plan.execution.mode !== MODE_MODEL) throw new ExecutionError(PLAN_INVALID, "This plan is authority for one tool call, not for running this package.");
    if (this.started) throw new ExecutionError(ALREADY_STARTED, "One execution session runs one workflow; prepare another");
    this.started = true;
    const now = this.deps.now ?? (() => new Date());
    const started = now();
    const tracker = new ProgressTracker(this.deps.onProgress ?? null, { intervalSeconds: this.deps.progressIntervalSeconds });
    this.tracker = tracker;
    const onAudit = this.deps.onAudit ?? null;
    const observer = (event: AuditEvent): void => {
      tracker.observe(event);
      if (onAudit === null) return;
      try {
        onAudit(event);
      } catch {
        // A checkpoint listener that fails never steers the run.
      }
    };
    // Everything from here to the run's end is one guarded region: whatever stops it (a refusal,
    // the compute preflight among them, or the run itself ending), the session is `finished`, so
    // `cancel()` never reports a run that is not there (as `session.py` does since T21 review 2).
    try {
      let workflow: Workflow;
      // One figure, computed once (T25 review 2, nit 5): the deadline the watchdog enforces is the
      // one a re-ask is measured against and the one network.v0's "at most" in seconds is under.
      const deadline = effectiveDeadlineSeconds(this.package, this.limits);
      try {
        workflow = await Workflow.create(this.package, {
          // The watchdog's deadline, so a re-ask or a retry the run would not outlive is not sent.
          deadlineAt: Date.now() + deadline * 1000,
          deadlineSeconds: deadline,
          grants: this.grants,
          memory: this.memory,
          handlers: this.handlers,
          router: this.router,
          limits: runtimeLimits(this.limits),
          approvedTools: this.approvedTools,
          observer,
          compute: this.deps.compute ?? null,
          turn: this.turnContext(now),
        });
      } catch (error) {
        if (!(error instanceof AgentPkgError)) throw error;
        throw new ExecutionError(RUNTIME_REFUSED, `The runtime refused this package: ${error.message}`);
      }
      this.workflow = workflow;
      // A cancellation that arrived between `begin` and `run` is honoured, not merely recorded.
      if (this.cancelRequested) workflow.cancel();
      const watchdog = setTimeout(() => {
        this.timedOut = true;
        workflow.cancel();
      }, deadline * 1000);
      try {
        this.outcome = await workflow.run(this.input);
      } catch (error) {
        const report = (error as { execution_report?: ExecutionReport }).execution_report;
        if (report !== undefined) this.outcome = report;
        else if (error instanceof CancelledError) {
          this.outcome = { status: "cancelled", error_code: "cancelled", audit: [...workflow.runtime.audit], usage: workflow.runtime.usage, provenance: this.provenance() };
        } else throw error;
      } finally {
        clearTimeout(watchdog);
      }
    } finally {
      tracker.close();
      this.finished = true;
    }
    return this.finish(started, now());
  }

  /**
   * conversation.v0 (D-270): the turn's context for the interpreter, from what the host handed in:
   * the chain continued from its tail, the consent host wrapped so that a step the plan pre-decided
   * (D-271) is answered without the person, and everything else put to the host.
   */
  private turnContext(now: () => Date): TurnContext | null {
    const start = this.turnStart;
    if (start === null) return null;
    const chain = new AuditChain(start.conversation_id, { tail: start.chain_tail, now });
    chain.turn = start.turn;
    const host = this.deps!.consent!;
    const preDecided = start.pre_decided;
    const consent: ConsentHost = {
      used: host.used,
      decide: async (request: ConsentRequest, signal: AbortSignal): Promise<unknown> => {
        const decided = Object.hasOwn(preDecided, request.step) ? preDecided[request.step]! : null;
        if (decided !== null) return { accepted: decided.accepted, decided_by: decided.decided_by, reason: decided.reason } satisfies ConsentDecision;
        return host.decide(request, signal);
      },
    };
    return { conversation_id: start.conversation_id, turn: start.turn, state: deepCopyState(start.state), chain, consent, spent: new Set(start.spent_permissions), tool_caps: { ...start.tool_caps } };
  }

  private provenance(): ExecutionReport["provenance"] {
    const pkg = this.package!;
    const start = this.turnStart;
    return { profile: PROFILE, interpreter: INTERPRETER, package_id: String(pkg.manifest.package_id), package_digest: pkg.digest, synthetic: this.router?.synthetic === true, ...(start !== null ? { conversation: { conversation_id: start.conversation_id, turn: start.turn } } : {}) };
  }

  private finish(started: Date, ended: Date): ExecutionOutcome {
    const outcome: ExecutionReport = this.outcome ?? { status: "failed", error_code: "worker_error", audit: [], usage: {}, provenance: this.provenance() };
    let status: ExecutionResult["status"] = outcome.status;
    let errorCode: string | null = outcome.error_code ?? null;
    if (this.timedOut) {
      // The host deadline stops a run by cancelling it; calling that "cancelled" would hide who stopped it.
      status = "failed";
      errorCode = "timeout";
    }
    const audit = (outcome.audit ?? []) as unknown as JsonObject[];
    // A turn's audit is a slice of its conversation's chain (V-17): verified as continued; the
    // whole chain is the conversation record's to verify.
    const summary = auditSummary(audit, { continued: this.turnStart !== null });
    const files = this.writeArtifacts(outcome);
    const output = outcome.output;
    const planned = this.plan!.model_binding?.host_model_id ?? this.router?.model_id ?? null;
    const result: ExecutionResult = {
      schema: EXECUTION_RESULT_SCHEMA,
      run_id: this.invocation!.run_id,
      run_plan_id: this.plan!.run_plan_id,
      run_plan_sha256: this.plan!.run_plan_sha256,
      run_invocation_sha256: this.invocation!.run_invocation_sha256,
      input_sha256: this.invocation!.input_sha256,
      status,
      error_code: errorCode,
      deadline_exceeded: this.timedOut,
      cancel_requested: this.cancelRequested,
      package: this.evidence!,
      grants: grantReport(this.package!, this.grants),
      limits: { host: { ...this.limits }, budget: effectiveBudget(this.package!, this.limits), effective_deadline_seconds: effectiveDeadlineSeconds(this.package!, this.limits) },
      model: this.router !== null && planned !== null ? modelEvidence(this.router as { invocations?: never[] }, planned) : null,
      router: this.router !== null ? describeRouter(this.router) : null,
      usage: outcome.usage ?? null,
      cost: costSummary(audit),
      audit: summary,
      output: { present: output !== undefined && output !== null, sha256: output !== undefined && output !== null ? digest(output) : null },
      artifacts: files.map(([name, data]) => ({ name, bytes: data.length, sha256: sha256HexSync(data) })),
      provenance: (outcome.provenance as unknown as JsonObject | undefined) ?? null,
      host: { runtime: this.host.runtime ?? null, runtime_version: this.host.runtime_version ?? null, verified_version: this.host.verified_version ?? null },
      timing: { started_at: pyIsoTimestamp(started), ended_at: pyIsoTimestamp(ended), duration_ms: Math.round((ended.getTime() - started.getTime()) * 1000) / 1000 },
      tools: { ...this.tools },
      progress: (this.tracker?.snapshot() as unknown as JsonObject | undefined) ?? null,
      failure: status !== "completed" ? failureSummary(audit) : null,
      // memory.v0 §9: the proposals offered (count, types, hash; never a value) and the agent document's fate.
      memory: (outcome.memory ?? null) as unknown as JsonValue,
      // conversation.v0: which turn of which conversation this run was; null for a one-shot run.
      conversation: this.turnStart !== null ? { conversation_id: this.turnStart.conversation_id, turn: this.turnStart.turn } : null,
      package_execution: {
        workflow_instantiated: true,
        interpreter: INTERPRETER,
        package_instructions_loaded: true,
        tool_handlers_installed: Object.keys(this.handlers).length,
        tool_calls: summary.tool_calls!,
      },
      tool_dispatches: this.boundTools.flatMap((handler) => handler.calls).slice(0, 512) as unknown as JsonValue,
    };
    return { result, files, report: outcome, spentPermissions: this.workflow === null ? [...(this.turnStart?.spent_permissions ?? [])].sort() : [...this.workflow.runtime.spentPermissions].sort() };
  }

  private writeArtifacts(outcome: ExecutionReport): ArtifactRecord[] {
    try {
      const records = artifactRecords(outcome as unknown as JsonObject, this.package);
      if (records.length > MAX_ARTIFACTS) throw new ExecutionError(ARTIFACTS_FAILED, "Too many run artifacts");
      return records;
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      if (error instanceof AgentPkgError) throw new ExecutionError(ARTIFACTS_FAILED, `The run artifacts could not be rendered: ${error.name}`);
      throw error;
    }
  }

  // -- control -----------------------------------------------------------------------------
  cancel(): { cancel_requested: true; running: boolean } {
    this.cancelRequested = true;
    if (this.workflow !== null && !this.finished) this.workflow.cancel();
    return { cancel_requested: true, running: this.started && !this.finished };
  }

  get snapshot(): ProgressSnapshot | null {
    return this.tracker?.snapshot() ?? null;
  }

  /** The hash-chained audit recorded so far (a copy), for a host's checkpoint; empty before the run. */
  auditSoFar(): AuditEvent[] {
    return this.workflow === null ? [] : this.workflow.runtime.audit.map((event) => ({ ...event }));
  }

  /** The usage accounted so far, for a host's checkpoint; null before the run. */
  usageSoFar(): JsonObject | null {
    return this.workflow === null ? null : (JSON.parse(JSON.stringify(this.workflow.runtime.usage)) as JsonObject);
  }

  /** The declared tool's bound handler count, for hosts that report it before the run. */
  get toolHandlerCount(): number {
    return Object.keys(this.handlers).length;
  }

  /** `packageJson` over the bound package, for hosts that render exports before writing. */
  json(path: string): JsonValue {
    if (this.package === null) throw new ExecutionError(NOT_BOUND, "Begin an execution session first");
    return packageJson(this.package, path);
  }
}

const deepCopyState = (state: JsonObject): JsonObject => deepCopy(state);
