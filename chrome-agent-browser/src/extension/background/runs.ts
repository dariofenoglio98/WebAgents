/**
 * Runs from the browser (T5, D-070…D-073): the service worker's half of execution. It is the
 * reference plugin's `execution.ts` and `run-manager.ts` over the Chrome core: readiness and
 * task validation before Run is offered, the one-time lease (`LeaseRegistry`, with `once` spent
 * at the first lease and the spent receipts persisted), the run's invocation written to IndexedDB
 * for the execution host, cancel, the record and artifact reads a view needs, the export bundle,
 * and the rule that a run whose host is gone is `interrupted` and never resumed. The manager
 * decides *whether* a run starts; the host (`execution/execute.ts`) re-verifies and executes.
 *
 * Nothing here is package-specific (D-009): every fact comes from the plan, the receipt, the
 * registry and the stores.
 */
import { stillAvailable, type HostCatalog } from "../../core/compatibility.js";
import { CoreError } from "../../core/errors.js";
import { ExecutionError } from "../../core/execution/errors.js";
import { LeaseRegistry, type ExecutionLease } from "../../core/execution/lease.js";
import { DEFAULT_HOST_LIMITS, normalizeHostLimits, type HostExecutionLimits } from "../../core/execution/limits.js";
import { authorizationFromRunPlan, executionPlanFromRunPlan, type ExecutionPlan } from "../../core/execution/plan.js";
import { failRunRecord, HOST_RUNTIME, isTerminalStatus, RUN_RECORD_SCHEMA, type RunRecord } from "../../core/execution/record.js";
import { sha256HexSync } from "../../core/hash.js";
import type { ToolRegistry } from "../../core/hosttools.js";
import type { JsonValue } from "../../core/json.js";
import type { Package } from "../../core/package.js";
import { validateTaskInput } from "../../core/presentation.js";
import { definitionsFromRegistry } from "../../core/tools/definitions.js";
import type { Reason, RunPlan, RunPlanPreflight } from "../../core/types.js";
import type { Vault } from "../../core/vault.js";
import { HOST_UNLOADED } from "../execution/execute.js";
import type { HostStartMessage, HostStatusReply } from "../execution/protocol.js";
import type { ArtifactChunk, ArtifactContent, Event, ExportBundle, ObservationsView, RunListView, RunReadiness, RunSummary, RunView } from "../messages.js";
import { connectionsFor, type SettingsStorage } from "../storage/settings.js";
import type { StoredSession } from "../storage/snapshots.js";
import type { RunStore, StoredRun } from "../storage/runs.js";

/** The reference plugin's `RECEIPT_MARGIN_SECONDS`: an authorization must outlast the run deadline by this much. */
export const RECEIPT_MARGIN_SECONDS = 60;
/** The largest artifact a view reads whole (the reference plugin's `MAX_ARTIFACT_BYTES`). */
export const MAX_ARTIFACT_VIEW_BYTES = 48 * 1024;
export const ARTIFACT_CHUNK_BYTES = 48 * 1024;
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
export const MAX_ECHOED_INPUT_BYTES = 16 * 1024;
/** The host limits every browser run is bounded by (the reference plugin's `DEFAULT_POLICY`); the package's own declarations apply beneath them. */
export const BROWSER_EXECUTION_LIMITS: Readonly<HostExecutionLimits> = DEFAULT_HOST_LIMITS;
/** The host reported a run as finished without settling its record: its Worker died (T5 review 1, finding 2). */
export const HOST_FAILED = "host_failed";
/** The person cancelled, and no execution host could be reached to take the cancel (T5 review 2, nit 2). */
export const HOST_UNREACHABLE = "host_unreachable";
/** Artifacts the host writes beside the package's exports, as the reference plugin names them. */
export const HOST_ARTIFACTS = new Set(["result.json", "audit.json", "usage.json", "provenance.json", "run.json"]);

export function isTerminal(status: RunRecord["status"]): boolean {
  return isTerminalStatus(status);
}

/** The facts about one open session the manager reads (the controller lends them). */
export interface RunSessionFacts {
  stored: StoredSession;
  pkg: Package;
  plan: RunPlan | null;
  onceSpent: boolean;
}

/** What the controller lends the manager: sessions, their preflight, the registries, the vault and the catalog. */
export interface RunHooks {
  session(sessionId: string): Promise<RunSessionFacts>;
  isSessionOpen(sessionId: string): boolean;
  preflight(sessionId: string): Promise<RunPlanPreflight>;
  toolRegistry(sessionId: string): Promise<ToolRegistry>;
  vault(): Promise<Vault>;
  /** The catalog readiness was checked against; a missing one is read again, never taken as "unknown" (D-077). */
  catalog(): Promise<HostCatalog>;
  snapshotBytes(archiveSha256: string): Promise<Uint8Array | null>;
  /** A run under this session's receipt began: its `once` grants are spent (D-065). */
  markOnceSpent(sessionId: string): Promise<void>;
  /** A run settled (by the host, or interrupted here): the snapshot it read may be dropped if nothing else refers to it (review 1, nit 7). */
  runSettled?(archiveSha256: string): Promise<void>;
}

/** The execution host as the worker sees it: an offscreen document in the extension, an in-process host in tests. */
export interface ExecutionHostBridge {
  available(): boolean;
  start(message: HostStartMessage): Promise<void>;
  /**
   * Ask the host to cancel a run. Resolves true when the host took the request (it answered, or
   * it is being created and will read the stored flag when it starts), false when there is no
   * host to take it; rejects when a host exists but did not answer (T5 review 2, nit 2).
   */
  cancel(runId: string): Promise<boolean>;
  /** The runs the host is executing right now, or null when there is no host at all. */
  status(): Promise<HostStatusReply | null>;
}

export interface RunManagerDeps {
  runs: RunStore;
  host: ExecutionHostBridge;
  settings: SettingsStorage;
  hooks: RunHooks;
  broadcast: (event: Event) => void;
  clock?: () => Date;
  randomId?: () => string;
  runtimeVersion: string;
  limits?: HostExecutionLimits;
}

function reject(code: string, message: string, status = 400, details: Record<string, unknown> | null = null): CoreError {
  return new CoreError(code, message, { status, details });
}

/** `contract.ts::taskText`: a string input itself, else the longest top-level string of an object. */
export function taskText(input: unknown): string | null {
  if (typeof input === "string") return input.trim() || null;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  let best: string | null = null;
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim() && (best === null || value.length > best.length)) best = value.trim();
  }
  if (best === null) return null;
  return best.length > 400 ? `${best.slice(0, 399)}…` : best;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** The record of a run that was leased but has not begun: identifiers and the plan's facts, nothing counted yet. */
export function preparingRunRecord(input: { runId: string; sessionId: string; plan: ExecutionPlan; runPlan: RunPlan; createdAt: Date; limits: HostExecutionLimits; revalidated: string[]; inputBytes: number; runtimeVersion: string }): RunRecord {
  const { plan, runPlan } = input;
  return {
    schema: RUN_RECORD_SCHEMA,
    runId: input.runId,
    sessionId: input.sessionId,
    runPlanId: plan.run_plan_id,
    runPlanSha256: plan.run_plan_sha256,
    runInvocationSha256: null,
    inputSha256: null,
    status: "preparing",
    createdAt: input.createdAt.toISOString(),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    package: { packageId: plan.package.package_id, name: plan.package.name, version: plan.package.version, digest: plan.package.digest, archiveSha256: plan.package.archive_sha256, executionProfile: plan.package.execution_profile ?? plan.execution.profile ?? "workflow.v0" },
    selectedModel: plan.model_binding ? { hostModelId: plan.model_binding.host_model_id, providerId: plan.model_binding.provider_id, modelId: plan.model_binding.model_id, displayName: plan.model_binding.display_name, local: plan.model_binding.properties.local } : null,
    model: null,
    grants: { decisions: Object.entries(runPlan.authorization.decisions).map(([permissionId, decision]) => ({ permissionId, decision })), grantedPermissionIds: [...runPlan.authorization.granted_permission_ids] },
    resources: plan.resource_grants.map((grant) => ({ permissionId: grant.permission_id, resourceType: grant.resource_type, resourceId: grant.resource_id, resourceDigest: grant.resource_digest })),
    limits: {
      host: { totalTokens: input.limits.total_tokens, maxRemoteCalls: input.limits.max_remote_calls, maxParallelWorkers: input.limits.max_parallel_workers, maxOutputTokensPerCall: input.limits.max_output_tokens_per_call, runTimeoutSeconds: input.limits.run_timeout_seconds, modelCallTimeoutSeconds: input.limits.model_call_timeout_seconds },
      effectiveDeadlineSeconds: null,
    },
    usage: null,
    cost: null,
    audit: null,
    outputSha256: null,
    artifacts: [],
    host: { runtime: HOST_RUNTIME, runtimeVersion: input.runtimeVersion, verifiedVersion: input.runtimeVersion, versionVerified: true },
    deadlineExceeded: false,
    cancelRequested: false,
    errorCode: null,
    errorDetail: null,
    revalidated: [...input.revalidated, `input_bytes:${input.inputBytes}`],
    packageExecution: { workflowInstantiated: false, packageInstructionsLoaded: false, toolHandlersInstalled: plan.tool_bindings.length, toolCalls: 0 },
    task: { inputBytes: input.inputBytes, attachments: [] },
    progress: null,
    tools: plan.tool_bindings.map((binding) => ({ toolId: binding.tool_id, bindingId: binding.binding_id, bindingSha256: binding.binding_sha256, remote: binding.remote, calls: 0, displayName: binding.display_name })),
    failure: null,
    origin: "live",
  };
}

export class RunManager {
  private readonly clock: () => Date;
  private readonly randomId: () => string;
  private readonly limits: HostExecutionLimits;
  private registry: LeaseRegistry | null = null;
  /** Leases consumed for runs in flight, released when the host reports the run settled. */
  private readonly leases = new Map<string, ExecutionLease>();
  private restored: Promise<void> | null = null;
  /** Sessions whose start is in progress: a second press while the lease is being issued is refused. */
  private readonly starting = new Set<string>();

  constructor(private readonly deps: RunManagerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.randomId = deps.randomId ?? (() => `run_${crypto.randomUUID().replace(/-/gu, "")}`);
    this.limits = normalizeHostLimits(deps.limits ?? BROWSER_EXECUTION_LIMITS);
  }

  hostLimits(): HostExecutionLimits {
    return { ...this.limits };
  }

  private async leaseRegistry(): Promise<LeaseRegistry> {
    if (this.registry === null) this.registry = new LeaseRegistry({ spentReceipts: await this.deps.settings.spentReceipts() });
    return this.registry;
  }

  // -- restore: an unloaded host interrupts, never resumes (D-027, D-071) ----------------------
  /**
   * On the worker's first use after a start: every run the store says is in flight is checked
   * against the host. A run the host does not report (no offscreen document, or a document that
   * never heard of it) is marked `interrupted` with its last checkpoint kept; nothing resumes.
   * A host that exists but did not answer (its listener still loading, a transient failure)
   * decides nothing: the runs stay as they are and the next call asks again (review 1, nit 6).
   */
  restore(): Promise<void> {
    if (this.restored) return this.restored;
    let askAgain = false;
    const attempt = (async () => {
      const inFlight = (await this.deps.runs.listRuns()).filter((run) => !isTerminal(run.record.status));
      if (inFlight.length === 0) return;
      let reported: Set<string>;
      try {
        const status = await this.deps.host.status();
        reported = status === null ? new Set() : new Set(status.runs.map((run) => run.run_id));
      } catch {
        askAgain = true;
        return;
      }
      for (const run of inFlight) {
        if (reported.has(run.run_id)) continue;
        await this.interrupt(run, {
          code: HOST_UNLOADED,
          message: "The execution host was unloaded while this run was in flight (the browser or the extension restarted). Run state is checkpointed but never resumed: an interrupted run ends here, with the audit it had written.",
        });
      }
    })();
    this.restored = attempt.then(
      () => {
        if (askAgain) this.restored = null;
      },
      (error: unknown) => {
        this.restored = null;
        throw error;
      },
    );
    return this.restored;
  }

  /**
   * Mark a run in flight `interrupted` (D-071) with its last checkpoint kept. One atomic step on
   * the store that leaves a run the host settled in the meantime untouched (finding 1): the
   * host's final write and this one can never produce a settled run shown as in flight.
   */
  private async interrupt(run: StoredRun, failure: { code: string; message: string }): Promise<boolean> {
    const now = this.clock();
    const updated = await this.deps.runs.updateRun(run.run_id, (current) => {
      if (isTerminal(current.record.status)) return null;
      return { ...current, record: failRunRecord(current.record, failure, now, "interrupted"), updated_at: now.toISOString() };
    });
    await this.releaseLease(run.run_id);
    if (updated === null || updated.record.status !== "interrupted") return false;
    this.deps.broadcast({ type: "event.run", runId: run.run_id, sessionId: run.session_id, status: "interrupted" });
    await this.deps.hooks.runSettled?.(run.invocation.archive_sha256);
    return true;
  }

  // -- readiness and validation --------------------------------------------------------------
  private async activeRun(sessionId: string | null, runPlanId: string | null = null): Promise<StoredRun | null> {
    const runs = await this.deps.runs.listRuns();
    return runs.find((run) => !isTerminal(run.record.status) && ((sessionId !== null && run.session_id === sessionId) || (runPlanId !== null && run.record.runPlanId === runPlanId))) ?? null;
  }

  private requiredSeconds(): number {
    return this.limits.run_timeout_seconds + RECEIPT_MARGIN_SECONDS;
  }

  async readiness(sessionId: string): Promise<RunReadiness> {
    await this.restore();
    const facts = await this.deps.hooks.session(sessionId);
    const now = this.clock();
    const checks: string[] = [];
    const base: RunReadiness = { session_id: sessionId, checked_at: now.toISOString(), ready: false, run_plan_id: null, run_plan_sha256: null, blocker: null, checks, receipt: null, active_run_id: null, preflight: null };
    const blocked = (code: string, message: string, subject: string | null = null): RunReadiness => ({ ...base, blocker: { code, message, subject } });
    if (!this.deps.host.available()) return blocked("execution_unavailable", "This browser cannot run packages: the extension has no execution host (chrome.offscreen is unavailable).");
    checks.push("execution_host_available");
    const plan = facts.plan;
    if (plan === null) return blocked("run_plan_absent", "Authorize this package and prepare a run plan first.");
    base.run_plan_id = plan.run_plan_id;
    base.run_plan_sha256 = plan.run_plan_sha256;
    const expiresAt = Date.parse(plan.authorization.expires_at);
    const remaining = Number.isFinite(expiresAt) ? Math.floor((expiresAt - now.getTime()) / 1000) : 0;
    base.receipt = { expires_at: plan.authorization.expires_at, remaining_seconds: Math.max(0, remaining), required_seconds: this.requiredSeconds() };
    if (plan.execution.mode !== "model") return blocked("run_plan_mode", "This plan is authority for one tool probe, not for running the package.");
    checks.push("plan_mode_model");
    const preflight = await this.deps.hooks.preflight(sessionId);
    base.preflight = preflight;
    if (!preflight.ready || preflight.stale) {
      const reason: Reason | undefined = (preflight.stale ? preflight.stale_reasons : preflight.blocking_reasons)[0];
      return blocked(preflight.stale ? "run_plan_stale" : "run_plan_blocked", reason?.message ?? (preflight.stale ? "The run plan is stale; prepare a new one." : "The run plan is not ready."), reason?.subject ?? null);
    }
    checks.push("preflight_ready");
    if (remaining < this.requiredSeconds()) {
      return blocked("authorization_expiring", `A run may take up to ${this.requiredSeconds()}s and this authorization has ${Math.max(0, remaining)}s left. Authorize again and prepare a new run plan before starting, so consent does not lapse in the middle of a run.`);
    }
    checks.push("receipt_outlasts_run_deadline");
    const active = await this.activeRun(sessionId, plan.run_plan_id);
    if (active !== null) {
      base.active_run_id = active.run_id;
      return blocked("execution_active", `Run ${active.run_id} is ${active.record.status} for this package. Wait for it to finish, or cancel it.`);
    }
    checks.push("no_active_run");
    return { ...base, ready: true };
  }

  async validateInput(sessionId: string, input: unknown): Promise<ReturnType<typeof validateTaskInput>> {
    const facts = await this.deps.hooks.session(sessionId);
    return validateTaskInput(facts.pkg, input);
  }

  // -- start ---------------------------------------------------------------------------------
  async start(sessionId: string, input: { runPlanId: string; runPlanSha256: string; input: unknown }): Promise<RunView> {
    await this.restore();
    const facts = await this.deps.hooks.session(sessionId);
    const plan = facts.plan;
    if (plan === null) throw reject("run_plan_absent", "Authorize this package and prepare a run plan first.", 409);
    if (plan.run_plan_id !== input.runPlanId || plan.run_plan_sha256 !== input.runPlanSha256) {
      throw reject("run_plan_mismatch", "The run plan on screen is not this session's current plan; reload the view.", 409, { run_plan_id: plan.run_plan_id });
    }
    const validation = await validateTaskInput(facts.pkg, input.input);
    if (!validation.valid) {
      const detail = validation.errors.slice(0, 4).map((error) => `${error.pointer || "(task)"} ${error.message}`).join("; ");
      throw reject("input_invalid", `The task does not match this package's input: ${detail}`, 422, { errors: validation.errors });
    }
    const readiness = await this.readiness(sessionId);
    if (!readiness.ready || readiness.preflight === null) {
      const blocker = readiness.blocker!;
      throw reject(blocker.code, blocker.message, 409, { readiness: readiness as unknown as Record<string, unknown> });
    }
    if (this.starting.has(sessionId)) throw reject("execution_active", "A run is already being started for this package.", 409);
    this.starting.add(sessionId);
    try {
      const archive = await this.deps.hooks.snapshotBytes(facts.stored.archive_sha256);
      if (archive === null) throw reject("execution_artifact_mismatch", "The session snapshot is no longer stored", 500);
      const registry = await this.deps.hooks.toolRegistry(sessionId);
      const vault = await this.deps.hooks.vault();
      const catalog = await this.deps.hooks.catalog();
      const leases = await this.leaseRegistry();
      let lease: ExecutionLease;
      try {
        lease = await leases.issue({
          plan,
          preflight: readiness.preflight,
          archive,
          definitions: definitionsFromRegistry(registry),
          resolver: vault,
          modelAvailable: (hostModelId) => stillAvailable(catalog, hostModelId),
          minimumReceiptRemainingSeconds: this.requiredSeconds(),
          sessionExpiresAt: facts.stored.expires_at,
          now: this.clock(),
        });
      } catch (error) {
        if (error instanceof ExecutionError) throw reject(error.code, error.message, 409, error.detail);
        throw error;
      }
      // Handing the bytes to a runner starts a run, and a run is what a one-time grant was for.
      await this.deps.settings.saveSpentReceipts(leases.spentReceipts());
      await this.deps.hooks.markOnceSpent(sessionId);
      const runId = this.randomId();
      const created = this.clock();
      const executionPlan = executionPlanFromRunPlan(plan);
      const authorization = authorizationFromRunPlan(plan);
      const inputBytes = new TextEncoder().encode(JSON.stringify(input.input)).length;
      const stored: StoredRun = {
        run_id: runId,
        session_id: sessionId,
        created_at: created.toISOString(),
        updated_at: created.toISOString(),
        record: preparingRunRecord({ runId, sessionId, plan: executionPlan, runPlan: plan, createdAt: created, limits: this.limits, revalidated: [...lease.revalidated], inputBytes, runtimeVersion: this.deps.runtimeVersion }),
        invocation: { plan: executionPlan, authorization, run_plan: plan, input: input.input as JsonValue, limits: this.limits, archive_sha256: lease.archive_sha256, profile_id: plan.authorization.provenance?.profile_id ?? null },
        task_text: taskText(input.input),
        checkpoints: 0,
        progress: null,
        audit: [],
        usage: null,
        result: null,
      };
      if (inputBytes <= MAX_ECHOED_INPUT_BYTES) stored.record.task = { ...stored.record.task, input: input.input as JsonValue } as RunRecord["task"] & { input: JsonValue };
      await this.deps.runs.putRun(stored);
      leases.consume(lease.lease_id, plan, this.clock());
      this.leases.set(runId, lease);
      this.deps.broadcast({ type: "event.run", runId, sessionId, status: "preparing" });
      try {
        await this.deps.host.start(await this.startMessage(runId));
      } catch (error) {
        const now = this.clock();
        const detail = `The execution host could not be started: ${error instanceof Error ? error.message : "error"}`;
        // Atomic, and never over a record the host may already have settled (finding 1).
        const failed = await this.deps.runs.updateRun(runId, (current) => (isTerminal(current.record.status) ? null : { ...current, record: failRunRecord(current.record, { code: "execution_unavailable", message: detail }, now), updated_at: now.toISOString() }));
        leases.release(lease.lease_id);
        this.leases.delete(runId);
        this.deps.broadcast({ type: "event.run", runId, sessionId, status: failed?.record.status ?? "failed" });
        await this.deps.hooks.runSettled?.(stored.invocation.archive_sha256);
        throw reject("execution_unavailable", detail, 503);
      }
      return this.view(stored);
    } finally {
      this.starting.delete(sessionId);
    }
  }

  /** What the host needs and nothing it does not: the keys and the vault for this run, in memory. */
  private async startMessage(runId: string): Promise<HostStartMessage> {
    const settings = await this.deps.settings.settings();
    const connections = connectionsFor(settings, await this.deps.settings.keyPresence());
    const ollama = connections.find((connection) => connection.provider === "ollama");
    const key = await this.deps.settings.vaultKey();
    return {
      type: "host.start",
      runId,
      credentials: { openai: await this.deps.settings.key("openai"), anthropic: await this.deps.settings.key("anthropic") },
      vault: { key: encodeBase64(key), document: await this.deps.settings.vaultDocument() },
      settings: { ollamaBaseUrl: ollama?.base_url ?? null, think: false, recordRequests: settings.developer.record_requests, runtimeVersion: this.deps.runtimeVersion, verifiedVersion: this.deps.runtimeVersion },
    };
  }

  // -- the host reports ----------------------------------------------------------------------
  async hostProgress(runId: string): Promise<{ received: true }> {
    const run = await this.deps.runs.getRun(runId);
    if (run !== null) this.deps.broadcast({ type: "event.run", runId, sessionId: run.session_id, status: run.record.status });
    return { received: true };
  }

  /** The lease a run in flight holds, if this worker issued it: released once, idempotent. */
  private async releaseLease(runId: string): Promise<void> {
    const lease = this.leases.get(runId);
    if (!lease) return;
    this.leases.delete(runId);
    (await this.leaseRegistry()).release(lease.lease_id);
  }

  async hostFinished(runId: string): Promise<{ received: true }> {
    let run = await this.deps.runs.getRun(runId);
    await this.releaseLease(runId);
    if (run === null) return { received: true };
    if (!isTerminal(run.record.status)) {
      // The host says the run ended, but its record was never settled: the Worker died (a load
      // failure, an uncaught exception, out of memory) before writing. D-071: interrupted, with
      // the last checkpoint kept, never resumed (review 1, finding 2).
      const interrupted = await this.interrupt(run, {
        code: HOST_FAILED,
        message: "The execution Worker ended without settling this run (it failed to load, threw, or ran out of memory). Run state is checkpointed up to its last wave but never resumed: an interrupted run ends here, with the audit it had written.",
      });
      if (interrupted) return { received: true };
      // The host settled the record between the read and the interrupt: broadcast what it wrote, not the stale status (review 2, nit 3).
      run = (await this.deps.runs.getRun(runId)) ?? run;
    }
    this.deps.broadcast({ type: "event.run", runId, sessionId: run.session_id, status: run.record.status });
    await this.deps.hooks.runSettled?.(run.invocation.archive_sha256);
    return { received: true };
  }

  // -- reads -----------------------------------------------------------------------------------
  private view(run: StoredRun): RunView {
    return { ...run.record, taskText: run.task_text, sessionOpen: this.deps.hooks.isSessionOpen(run.session_id), profileId: run.invocation.profile_id };
  }

  private summary(run: StoredRun): RunSummary {
    return {
      runId: run.run_id,
      sessionId: run.session_id,
      runPlanId: run.record.runPlanId,
      status: run.record.status,
      createdAt: run.created_at,
      endedAt: run.record.endedAt,
      durationMs: run.record.durationMs,
      package: { packageId: run.record.package.packageId, name: run.record.package.name, version: run.record.package.version },
      selectedModel: run.record.selectedModel?.hostModelId ?? null,
      cancelRequested: run.record.cancelRequested,
      errorCode: run.record.errorCode,
      taskText: run.task_text,
    };
  }

  private async require(runId: string): Promise<StoredRun> {
    const run = await this.deps.runs.getRun(runId);
    if (run === null) throw reject("run_unknown", "This browser holds no run with that id.", 404);
    return run;
  }

  async get(runId: string): Promise<RunView | null> {
    await this.restore();
    const run = await this.deps.runs.getRun(runId);
    return run === null ? null : this.view(run);
  }

  async list(sessionId: string | null): Promise<RunListView> {
    await this.restore();
    const runs = (await this.deps.runs.listRuns()).filter((run) => sessionId === null || run.session_id === sessionId).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const active = runs.find((run) => !isTerminal(run.record.status)) ?? null;
    return { runs: runs.map((run) => this.summary(run)), active: active === null ? null : this.view(active) };
  }

  async activeCount(): Promise<number> {
    return (await this.deps.runs.listRuns()).filter((run) => !isTerminal(run.record.status)).length;
  }

  async storedCount(): Promise<number> {
    return (await this.deps.runs.listRuns()).length;
  }

  async cancel(runId: string): Promise<RunView> {
    await this.restore();
    const run = await this.require(runId);
    if (isTerminal(run.record.status)) return this.view(run);
    // The host owns this record while the run is in flight and may settle it at any moment. The
    // flag is written in one atomic step that leaves a settled record alone, so a Cancel racing
    // the host's final write can never put a completed run back in flight (review 1, finding 1).
    const now = this.clock().toISOString();
    const updated = await this.deps.runs.updateRun(runId, (current) => (isTerminal(current.record.status) ? null : { ...current, record: { ...current.record, cancelRequested: true }, updated_at: now }));
    if (updated === null) throw reject("run_unknown", "This browser holds no run with that id.", 404);
    if (!isTerminal(updated.record.status)) {
      // The flag is stored before the host is asked, and the host reads it when it starts and
      // merges it on every write (review 2, finding 1), so a Cancel accepted while the run is
      // still preparing, when no Worker exists to receive `host.cancel`, is not lost. A start in
      // progress hands the host a record that already carries the flag.
      let reached: boolean;
      try {
        reached = (await this.deps.host.cancel(runId)) || this.starting.has(updated.session_id);
      } catch {
        reached = false;
      }
      if (!reached) {
        // No host could take the cancel: none exists, or one exists and does not answer. The
        // person asked for a way out, and D-074 gives it: the run is interrupted now, and an
        // execution that is somehow still alive abandons itself at its next write (review 2, nit 2).
        const interrupted = await this.interrupt(updated, {
          code: HOST_UNREACHABLE,
          message: "Cancel was requested, but no execution host could be reached to take it (the host is gone or does not answer). The run is interrupted here, with the audit it had written; it is never resumed, and a host that is still alive stops at its next checkpoint.",
        });
        if (interrupted) return this.view((await this.deps.runs.getRun(runId)) ?? updated);
      }
    }
    this.deps.broadcast({ type: "event.run", runId, sessionId: updated.session_id, status: updated.record.status });
    return this.view(updated);
  }

  /** The host-written files plus the record itself, the plan and the input as the export names them (D-073). */
  private async bytesOf(run: StoredRun, name: string): Promise<Uint8Array | null> {
    const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
    if (name === "run.json") return encode(run.record);
    if (name === "run-plan.json") return encode(run.invocation.run_plan);
    if (name === "input.json") return encode(run.invocation.input);
    const artifact = await this.deps.runs.getArtifact(run.run_id, name);
    return artifact?.bytes ?? null;
  }

  async artifact(runId: string, name: string): Promise<ArtifactContent> {
    const run = await this.require(runId);
    const bytes = await this.bytesOf(run, name);
    if (bytes === null) throw reject("artifact_unknown", `This run has no artifact ${JSON.stringify(name)}`, 404);
    const truncated = bytes.length > MAX_ARTIFACT_VIEW_BYTES;
    const shown = truncated ? bytes.subarray(0, MAX_ARTIFACT_VIEW_BYTES) : bytes;
    const text = new TextDecoder().decode(shown);
    const content: ArtifactContent = { run_id: runId, name, bytes: bytes.length, sha256: sha256HexSync(bytes), truncated, shown_bytes: shown.length, text };
    if (!truncated && name.endsWith(".json")) {
      try {
        content.json = JSON.parse(text) as JsonValue;
      } catch {
        // shown as text
      }
    }
    return content;
  }

  async artifactChunk(runId: string, name: string, offset: number): Promise<ArtifactChunk> {
    const run = await this.require(runId);
    const bytes = await this.bytesOf(run, name);
    if (bytes === null) throw reject("artifact_unknown", `This run has no artifact ${JSON.stringify(name)}`, 404);
    if (offset > bytes.length) throw reject("invalid_request", "Offset outside the artifact");
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + ARTIFACT_CHUNK_BYTES));
    return { run_id: runId, name, bytes: bytes.length, sha256: sha256HexSync(bytes), offset, length: slice.length, base64: encodeBase64(slice), eof: offset + slice.length >= bytes.length };
  }

  async exportBundle(runId: string): Promise<ExportBundle> {
    const run = await this.require(runId);
    const names = ["run.json", "run-plan.json", "input.json", ...(await this.deps.runs.listArtifacts(runId)).map((artifact) => artifact.name).sort()];
    const entries: ExportBundle["entries"] = [];
    let total = 0;
    for (const name of names) {
      const bytes = await this.bytesOf(run, name);
      if (bytes === null) continue;
      total += bytes.length;
      if (total > MAX_EXPORT_BYTES) throw reject("export_too_large", `The run's files exceed the ${MAX_EXPORT_BYTES}-byte export limit`, 413);
      entries.push({ name, bytes: bytes.length, sha256: sha256HexSync(bytes), base64: encodeBase64(bytes) });
    }
    return { run_id: runId, entries };
  }

  async clear(runId: string): Promise<{ cleared: boolean; run_id: string }> {
    const run = await this.require(runId);
    if (!isTerminal(run.record.status)) throw reject("execution_active", "A run in flight cannot be cleared; cancel it first.", 409);
    await this.deps.runs.deleteRun(runId);
    this.deps.broadcast({ type: "event.run", runId, sessionId: run.session_id, status: "cleared" });
    return { cleared: true, run_id: runId };
  }

  async observations(runId: string): Promise<ObservationsView> {
    await this.require(runId);
    const settings = await this.deps.settings.settings();
    return { run_id: runId, recording: settings.developer.record_requests, observations: await this.deps.runs.listObservations(runId) };
  }
}
