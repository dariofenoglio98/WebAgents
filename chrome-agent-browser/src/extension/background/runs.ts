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
import type { OpenAIReasoningEffort } from "../../core/models/adapters/openai.js";
import { stillAvailable, type HostCatalog } from "../../core/compatibility.js";
import { CoreError } from "../../core/errors.js";
import { ExecutionError } from "../../core/execution/errors.js";
import { LeaseRegistry, type ExecutionLease } from "../../core/execution/lease.js";
import { DEFAULT_HOST_LIMITS, normalizeHostLimits, type HostExecutionLimits } from "../../core/execution/limits.js";
import { cappedLimits } from "../../core/policies/apply.js";
import { authorizationFromRunPlan, executionPlanFromRunPlan, type ExecutionPlan } from "../../core/execution/plan.js";
import { failRunRecord, HOST_RUNTIME, isTerminalStatus, RUN_RECORD_SCHEMA, type RunRecord } from "../../core/execution/record.js";
import { sha256HexSync } from "../../core/hash.js";
import { bindsHostResource, type ToolRegistry } from "../../core/hosttools.js";
import type { JsonValue } from "../../core/json.js";
import type { Package } from "../../core/package.js";
import { validateTaskInput } from "../../core/presentation.js";
import { FILE_ID_PATTERN, type SelectedFileAttachment } from "../../core/tools/adapters/selected-file.js";
import { definitionsFromRegistry } from "../../core/tools/definitions.js";
import type { Reason, RunPlan, RunPlanPreflight } from "../../core/types.js";
import { emptyMemorySnapshot, MemoryStore } from "../../core/memory/store.js";
import { generateVaultKey } from "../../core/vault.js";
import { SerialQueue } from "../../core/serial.js";
import { memoryDeclarations } from "../../core/memory/declarations.js";
import type { MemoryType } from "../../core/memory/types.js";
import type { MemoryController } from "./memory-controller.js";
import type { PresetId } from "../../core/types.js";
import type { PlanOrigin } from "../../core/origins.js";
import type { SecretStoreState } from "../../core/secrets.js";
import { HOST_UNLOADED } from "../execution/execute.js";
import type { HostStartMessage, HostStatusReply } from "../execution/protocol.js";
import type { TurnStart } from "../../core/execution/runner.js";
import type { ArtifactChunk, ArtifactContent, Event, ExportBundle, ObservationsView, RunListView, RunReadiness, RunSummary, RunView } from "../messages.js";
import { connectionsFor, type Settings, type SettingsStorage } from "../storage/settings.js";
import type { StoredSession } from "../storage/snapshots.js";
import type { RunStore, StoredRun } from "../storage/runs.js";
import { attachmentOf, type FileView } from "../storage/files.js";

/** The reference plugin's `RECEIPT_MARGIN_SECONDS`: an authorization must outlast the run deadline by this much. */
export const RECEIPT_MARGIN_SECONDS = 60;
/** The largest artifact a view reads whole (the reference plugin's `MAX_ARTIFACT_BYTES`). */
export const MAX_ARTIFACT_VIEW_BYTES = 48 * 1024;
export const ARTIFACT_CHUNK_BYTES = 48 * 1024;
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
export const MAX_ECHOED_INPUT_BYTES = 16 * 1024;
/**
 * The host limits a browser run is bounded by when the person changed nothing: the reference
 * plugin's `DEFAULT_POLICY`. Settings → Run limits replaces them (B-118, T6 D-084); the package's
 * own declarations apply beneath whichever is in force.
 */
export const BROWSER_EXECUTION_LIMITS: Readonly<HostExecutionLimits> = DEFAULT_HOST_LIMITS;
/** At most this many picked files in one task (the invocation's `MAX_ATTACHMENTS`). */
export const MAX_RUN_FILES = 16;
/** The host reported a run as finished without settling its record: its Worker died (T5 review 1, finding 2). */
export const HOST_FAILED = "host_failed";
/** The person cancelled, and no execution host could be reached to take the cancel (T5 review 2, nit 2). */
export const HOST_UNREACHABLE = "host_unreachable";
/** Artifacts the host writes beside the package's exports, as the reference plugin names them. */
export const HOST_ARTIFACTS = new Set(["result.json", "audit.json", "usage.json", "provenance.json", "run.json"]);

/**
 * Whether a run under this plan needs the vault (D-195, amended by review 1 finding 1): it grants
 * a record, or it binds an approved host-resource tool, whose binding exists only in a registry
 * built from the vault's types. Both live in the secret store, so both need an unlock before Run.
 */
export function planNeedsMemory(plan: Pick<RunPlan, "resource_grants" | "tool_bindings">): boolean {
  return plan.resource_grants.length > 0 || bindsHostResource(plan.tool_bindings);
}

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
  /** `options.ignoreOnceSpent`: a conversation's later turn, under the receipt its first turn spent (V-13, D-270). */
  preflight(sessionId: string, options?: { ignoreOnceSpent?: boolean }): Promise<RunPlanPreflight>;
  toolRegistry(sessionId: string): Promise<ToolRegistry>;
  /** The memory (T19, memory.v0): the store a run is opened with, the commit of an agent document, the usage log. */
  memory(): MemoryController;
  /** The subscribed policy's memory rules (M-54) and the preset: what the run does with proposals and the agent document (M-50, M-52). */
  memoryRules?(): Promise<{ preset: PresetId; agent: "allow" | "refuse"; proposals: "ask" | "refuse" }>;
  /** The catalog readiness was checked against; a missing one is read again, never taken as "unknown" (D-077). */
  catalog(): Promise<HostCatalog>;
  snapshotBytes(archiveSha256: string): Promise<Uint8Array | null>;
  /** A run under this session's receipt began: its `once` grants are spent (D-065). */
  markOnceSpent(sessionId: string): Promise<void>;
  /** A run settled (by the host, or interrupted here): the snapshot it read may be dropped if nothing else refers to it (review 1, nit 7). */
  runSettled?(archiveSha256: string): Promise<void>;
  /** One picked file's view (Settings → Files, T6), or null when this browser holds no such file. */
  file?(fileId: string): Promise<FileView | null>;
  /** The subscribed policy's budget caps (T8, D-102), which lower the person's run limits; null when none. */
  limitCaps?(): Promise<Partial<HostExecutionLimits> | null>;
  /** The origins this session's plan needs (T16, D-193), from the plan, the registry and the provider settings. */
  planOrigins(sessionId: string): Promise<PlanOrigin[]>;
  /** Which of these origins Chrome does not grant now (empty when all are granted). */
  missingOrigins(origins: readonly string[]): Promise<string[]>;
  /** The secret store's state (T16): a plan that needs a key or a record cannot run while it is locked (D-195). */
  secretsState(): Promise<SecretStoreState>;
}

/** The execution host as the worker sees it: an offscreen document in the extension, an in-process host in tests. */
export interface ExecutionHostBridge {
  available(): boolean;
  start(message: HostStartMessage): Promise<void>;
  /**
   * Ask the host to cancel a run (T5 review 3, nit 3). Resolves `taken` when a Worker received it,
   * or the document is being created for this very run (it reads the stored flag when it starts);
   * `not_held` when a document answered but no Worker holds the run; `no_host` when there is no
   * document and none is being created for it. Rejects when a document exists but did not answer
   * (T5 review 2, nit 2).
   */
  cancel(runId: string): Promise<HostCancelAnswer>;
  /** The runs the host is executing right now, or null when there is no host at all. */
  status(): Promise<HostStatusReply | null>;
  /** conversation.v0 (D-270): the person's answer to the card a turn waits on; false when no Worker holds the run. */
  decide(runId: string, step: string, accepted: boolean): Promise<boolean>;
}

export type HostCancelAnswer = "taken" | "not_held" | "no_host";

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
/**
 * The picked-file ids a task names (`execution.ts::referencedFileIds`): every string, value or key,
 * that is exactly an opaque file id. A run is given exactly these files and nothing else.
 */
export function referencedFileIds(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32) return found;
  if (typeof value === "string") {
    if (FILE_ID_PATTERN.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) referencedFileIds(item, found, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (FILE_ID_PATTERN.test(key)) found.add(key);
      referencedFileIds(item, found, depth + 1);
    }
  }
  return found;
}

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
export function preparingRunRecord(input: { runId: string; sessionId: string; plan: ExecutionPlan; runPlan: RunPlan; createdAt: Date; limits: HostExecutionLimits; revalidated: string[]; inputBytes: number; runtimeVersion: string; attachments?: SelectedFileAttachment[]; conversation?: { conversationId: string; turn: number } | null }): RunRecord {
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
    task: { inputBytes: input.inputBytes, attachments: (input.attachments ?? []).map((file) => ({ fileId: file.file_id, sha256: file.sha256, bytes: file.bytes, mediaType: file.media_type })) },
    progress: null,
    tools: plan.tool_bindings.map((binding) => ({ toolId: binding.tool_id, bindingId: binding.binding_id, bindingSha256: binding.binding_sha256, remote: binding.remote, calls: 0, displayName: binding.display_name, retries: 0, fallbackAnswers: 0 })),
    failure: null,
    origin: "live",
    ...(input.conversation ? { conversation: input.conversation } : {}),
  };
}

export class RunManager {
  /** conversation.v0 (D-270): told when a turn's run settled (completed, failed, cancelled, interrupted), by the conversation manager. */
  onTurnSettled: ((run: StoredRun) => Promise<void>) | null = null;
  private readonly clock: () => Date;
  private readonly randomId: () => string;
  /** Limits fixed by the embedder (tests); otherwise each run reads Settings → Run limits. */
  private readonly fixedLimits: HostExecutionLimits | null;
  private registry: LeaseRegistry | null = null;
  /** Leases consumed for runs in flight, released when the host reports the run settled. */
  private readonly leases = new Map<string, ExecutionLease>();
  /** The run-memory applications, one at a time: a `host.finished` and the unlock sweep never apply the same run twice (review 1, finding 5). */
  private readonly memoryWork = new SerialQueue();
  private restored: Promise<void> | null = null;
  /** Sessions whose start is in progress: a second press while the lease is being issued is refused. */
  private readonly starting = new Set<string>();

  constructor(private readonly deps: RunManagerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.randomId = deps.randomId ?? (() => `run_${crypto.randomUUID().replace(/-/gu, "")}`);
    this.fixedLimits = deps.limits ? normalizeHostLimits(deps.limits) : null;
  }

  /**
   * The limits a run started now is bounded by: Settings → Run limits (or the embedder's), each
   * lowered to the subscribed policy's cap where it states one (T8, D-102). A cap never raises a limit.
   */
  async hostLimits(): Promise<HostExecutionLimits> {
    let limits: HostExecutionLimits;
    if (this.fixedLimits !== null) limits = { ...this.fixedLimits };
    else {
      try {
        limits = normalizeHostLimits((await this.deps.settings.settings()).limits ?? BROWSER_EXECUTION_LIMITS);
      } catch {
        limits = { ...BROWSER_EXECUTION_LIMITS };
      }
    }
    return cappedLimits(limits, (await this.deps.hooks.limitCaps?.()) ?? null);
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
    // The conversation first: its end rule may read the snapshot that runSettled can drop.
    if (updated.invocation.turn) await this.onTurnSettled?.(updated).catch(() => undefined);
    await this.deps.hooks.runSettled?.(run.invocation.archive_sha256);
    return true;
  }

  // -- readiness and validation --------------------------------------------------------------
  private async activeRun(sessionId: string | null, runPlanId: string | null = null): Promise<StoredRun | null> {
    const runs = await this.deps.runs.listRuns();
    return runs.find((run) => !isTerminal(run.record.status) && ((sessionId !== null && run.session_id === sessionId) || (runPlanId !== null && run.record.runPlanId === runPlanId))) ?? null;
  }

  private requiredSeconds(limits: HostExecutionLimits): number {
    return limits.run_timeout_seconds + RECEIPT_MARGIN_SECONDS;
  }

  async readiness(sessionId: string, options: { ignoreOnceSpent?: boolean } = {}): Promise<RunReadiness> {
    await this.restore();
    const facts = await this.deps.hooks.session(sessionId);
    const now = this.clock();
    const limits = await this.hostLimits();
    const required = this.requiredSeconds(limits);
    const checks: string[] = [];
    const base: RunReadiness = { session_id: sessionId, checked_at: now.toISOString(), ready: false, run_plan_id: null, run_plan_sha256: null, blocker: null, checks, receipt: null, active_run_id: null, preflight: null, missing_origins: [] };
    const blocked = (code: string, message: string, subject: string | null = null): RunReadiness => ({ ...base, blocker: { code, message, subject } });
    if (!this.deps.host.available()) return blocked("execution_unavailable", "This browser cannot run packages: the extension has no execution host (chrome.offscreen is unavailable).");
    checks.push("execution_host_available");
    const plan = facts.plan;
    if (plan === null) return blocked("run_plan_absent", "Authorize this package and prepare a run plan first.");
    base.run_plan_id = plan.run_plan_id;
    base.run_plan_sha256 = plan.run_plan_sha256;
    const expiresAt = Date.parse(plan.authorization.expires_at);
    const remaining = Number.isFinite(expiresAt) ? Math.floor((expiresAt - now.getTime()) / 1000) : 0;
    base.receipt = { expires_at: plan.authorization.expires_at, remaining_seconds: Math.max(0, remaining), required_seconds: required };
    if (plan.execution.mode !== "model") return blocked("run_plan_mode", "This plan is authority for one tool probe, not for running the package.");
    checks.push("plan_mode_model");
    // What the run would be handed (D-195): the bound provider's key, the granted records, or the
    // vault's types for a bound host-resource tool (review 1, finding 1). A locked store cannot hand
    // them over, and the person unlocks before Run, never during (D-192); checked before the
    // preflight, which cannot evaluate a plan's resource bindings while the store is locked.
    if (plan.model_binding !== null && this.needsSecrets(plan)) {
      const state = await this.deps.hooks.secretsState();
      if (state !== "unlocked") {
        if (state === "invalid") return blocked("store_invalid", "The protected store cannot be read by this build (Settings → Security says why). This run needs your provider key, your records or your record types from it.");
        return blocked(state === "no_passphrase" ? "store_no_passphrase" : "store_locked", state === "no_passphrase" ? "Set a passphrase first (Settings → Security): this run needs your provider key or your records, which are kept only in the protected store." : "Unlock your keys and records to run: this run needs your provider key, a record you granted, or your record types for a tool it binds.");
      }
    }
    checks.push("secrets_available");
    const preflight = await this.deps.hooks.preflight(sessionId, { ignoreOnceSpent: options.ignoreOnceSpent === true });
    base.preflight = preflight;
    if (!preflight.ready || preflight.stale) {
      const reason: Reason | undefined = (preflight.stale ? preflight.stale_reasons : preflight.blocking_reasons)[0];
      return blocked(preflight.stale ? "run_plan_stale" : "run_plan_blocked", reason?.message ?? (preflight.stale ? "The run plan is stale; prepare a new one." : "The run plan is not ready."), reason?.subject ?? null);
    }
    checks.push("preflight_ready");
    // Every origin the plan recorded must be granted now (D-193): a grant revoked after the plan blocks Run by name.
    const missing = await this.deps.hooks.missingOrigins((await this.deps.hooks.planOrigins(sessionId)).map((item) => item.origin));
    if (missing.length > 0) {
      base.missing_origins = missing;
      return blocked("origins_not_granted", `This browser is not allowed to reach ${missing.join(", ")}. Allow ${missing.length === 1 ? "it" : "them"} to run.`);
    }
    checks.push("origins_granted");
    if (remaining < required) {
      return blocked("authorization_expiring", `A run may take up to ${required}s and this authorization has ${Math.max(0, remaining)}s left. Authorize again and prepare a new run plan before starting, so consent does not lapse in the middle of a run.`);
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
    // conversation.v0 (V-28): a conversational package runs turn by turn under a conversation, never as one task.
    if ((plan.execution.conversation ?? null) !== null) throw reject("conversation_profile", "This package is a conversation: start one and send it a message, rather than running it as a task.", 409);
    const validation = await validateTaskInput(facts.pkg, input.input);
    if (!validation.valid) {
      const detail = validation.errors.slice(0, 4).map((error) => `${error.pointer || "(task)"} ${error.message}`).join("; ");
      throw reject("input_invalid", `The task does not match this package's input: ${detail}`, 422, { errors: validation.errors });
    }
    return this.launch(sessionId, facts, plan, input.input, { turn: null, spentByConversation: false });
  }

  /**
   * conversation.v0 (D-270): one turn of a conversation as a run, with the turn's context handed to
   * the host; the conversation manager validated the message and reserved the turn (V-10). A
   * receipt the conversation's first turn spent still leases its later turns (V-13). A turn runs
   * under the run limits the conversation froze at its start, which its reservation counted (V-10).
   */
  async startTurn(sessionId: string, input: { plan: RunPlan; message: JsonValue; turn: TurnStart; spentByConversation: boolean; runId: string; limits: HostExecutionLimits }): Promise<RunView> {
    await this.restore();
    const facts = await this.deps.hooks.session(sessionId);
    if (facts.plan === null || facts.plan.run_plan_id !== input.plan.run_plan_id || facts.plan.run_plan_sha256 !== input.plan.run_plan_sha256) {
      throw reject("run_plan_mismatch", "The conversation's plan is no longer this session's current plan.", 409);
    }
    return this.launch(sessionId, facts, input.plan, input.message, { turn: input.turn, spentByConversation: input.spentByConversation, runId: input.runId, limits: input.limits });
  }

  /** A new run id, for a caller that records the run it is about to start before starting it (a conversation's turn). */
  newRunId(): string {
    return this.randomId();
  }

  /** The plan and the receipt as the execution host sees them, for the conversation's record. */
  executionPlanOf(plan: RunPlan): ExecutionPlan {
    return executionPlanFromRunPlan(plan);
  }

  authorizationOf(plan: RunPlan): ReturnType<typeof authorizationFromRunPlan> {
    return authorizationFromRunPlan(plan);
  }

  private async launch(sessionId: string, facts: RunSessionFacts, plan: RunPlan, inputValue: unknown, options: { turn: TurnStart | null; spentByConversation: boolean; runId?: string; limits?: HostExecutionLimits }): Promise<RunView> {
    const readiness = await this.readiness(sessionId, { ignoreOnceSpent: options.spentByConversation });
    if (!readiness.ready || readiness.preflight === null) {
      const blocker = readiness.blocker!;
      throw reject(blocker.code, blocker.message, 409, { readiness: readiness as unknown as Record<string, unknown> });
    }
    const input = { input: inputValue };
    // The picked files the task names are the files this run is given, and nothing else (T6, D-083).
    const attachments = await this.attachmentsFor(input.input, plan);
    if (this.starting.has(sessionId)) throw reject("execution_active", "A run is already being started for this package.", 409);
    this.starting.add(sessionId);
    try {
      const limits = options.limits ?? (await this.hostLimits());
      const archive = await this.deps.hooks.snapshotBytes(facts.stored.archive_sha256);
      if (archive === null) throw reject("execution_artifact_mismatch", "The session snapshot is no longer stored", 500);
      const registry = await this.deps.hooks.toolRegistry(sessionId);
      // The memory is opened only for a plan that needs it (D-195): a locked store never blocks a run that needs nothing from it.
      const resolver = planNeedsMemory(plan) ? (await this.deps.hooks.memory().unlocked()).store : await MemoryStore.open({ key: generateVaultKey(), snapshot: emptyMemorySnapshot(), now: this.clock });
      const catalog = await this.deps.hooks.catalog();
      const leases = await this.leaseRegistry();
      let lease: ExecutionLease;
      try {
        lease = await leases.issue({
          plan,
          preflight: readiness.preflight,
          archive,
          definitions: definitionsFromRegistry(registry),
          resolver,
          modelAvailable: (hostModelId) => stillAvailable(catalog, hostModelId),
          minimumReceiptRemainingSeconds: this.requiredSeconds(limits),
          sessionExpiresAt: facts.stored.expires_at,
          spentByConversation: options.spentByConversation,
          now: this.clock(),
        });
      } catch (error) {
        if (error instanceof ExecutionError) throw reject(error.code, error.message, 409, error.detail);
        throw error;
      }
      // Handing the bytes to a runner starts a run, and a run is what a one-time grant was for.
      await this.deps.settings.saveSpentReceipts(leases.spentReceipts());
      if (!options.spentByConversation) await this.deps.hooks.markOnceSpent(sessionId);
      const runId = options.runId ?? this.randomId();
      const created = this.clock();
      const executionPlan = executionPlanFromRunPlan(plan);
      const authorization = authorizationFromRunPlan(plan);
      const inputBytes = new TextEncoder().encode(JSON.stringify(input.input)).length;
      const stored: StoredRun = {
        run_id: runId,
        session_id: sessionId,
        created_at: created.toISOString(),
        updated_at: created.toISOString(),
        record: preparingRunRecord({ runId, sessionId, plan: executionPlan, runPlan: plan, createdAt: created, limits, revalidated: [...lease.revalidated], inputBytes, runtimeVersion: this.deps.runtimeVersion, attachments, conversation: options.turn ? { conversationId: options.turn.conversation_id, turn: options.turn.turn } : null }),
        invocation: { plan: executionPlan, authorization, run_plan: plan, input: input.input as JsonValue, attachments, limits, archive_sha256: lease.archive_sha256, profile_id: plan.authorization.provenance?.profile_id ?? null, turn: options.turn },
        task_text: taskText(input.input),
        checkpoints: 0,
        progress: null,
        audit: [],
        usage: null,
        result: null,
        memory_types: declaredCustomTypes(facts.pkg),
      };
      if (inputBytes <= MAX_ECHOED_INPUT_BYTES) stored.record.task = { ...stored.record.task, input: input.input as JsonValue } as RunRecord["task"] & { input: JsonValue };
      await this.deps.runs.putRun(stored);
      leases.consume(lease.lease_id, plan, this.clock());
      this.leases.set(runId, lease);
      this.deps.broadcast({ type: "event.run", runId, sessionId, status: "preparing" });
      try {
        await this.deps.host.start({ ...(await this.startMessage(runId, sessionId, plan)), turn: options.turn });
      } catch (error) {
        const now = this.clock();
        const detail = `The execution host could not be started: ${error instanceof Error ? error.message : "error"}`;
        // Atomic, and never over a record the host may already have settled (finding 1).
        const failed = await this.deps.runs.updateRun(runId, (current) => (isTerminal(current.record.status) ? null : { ...current, record: failRunRecord(current.record, { code: "execution_unavailable", message: detail }, now), updated_at: now.toISOString() }));
        leases.release(lease.lease_id);
        this.leases.delete(runId);
        this.deps.broadcast({ type: "event.run", runId, sessionId, status: failed?.record.status ?? "failed" });
        // The conversation first: its end rule may read the snapshot that runSettled can drop.
        if (failed) await this.onTurnSettled?.(failed).catch(() => undefined);
        await this.deps.hooks.runSettled?.(stored.invocation.archive_sha256);
        throw reject("execution_unavailable", detail, 503);
      }
      return this.view(stored);
    } finally {
      this.starting.delete(sessionId);
    }
  }

  /**
   * The files a task names, resolved against this browser's picked files, or a refusal before
   * anything is leased (`execution.ts::attach`, `checkReferencedFiles`, `checkFilePermission`):
   * every named id must be a file this browser holds; naming any means the plan must bind a tool
   * that reads selected files, approved, with its permissions granted. A task that names none is
   * given none.
   */
  private async attachmentsFor(input: unknown, plan: RunPlan): Promise<SelectedFileAttachment[]> {
    const ids = [...referencedFileIds(input)].sort();
    if (ids.length === 0) return [];
    if (ids.length > MAX_RUN_FILES) throw reject("input_invalid", `A run may be given at most ${MAX_RUN_FILES} picked files.`, 422);
    const attachments: SelectedFileAttachment[] = [];
    for (const fileId of ids) {
      const file = (await this.deps.hooks.file?.(fileId)) ?? null;
      if (file === null) {
        throw reject("file_unknown", "The task names a document this browser does not hold (it was removed in Settings → Files, or never picked here). Pick it again and choose it in the task.", 422, { file_id: fileId });
      }
      attachments.push(attachmentOf(file));
    }
    const readers = (plan.tool_bindings as unknown as Array<{ implementation_kind?: unknown; required_permission_ids?: unknown; approved?: unknown }>).filter((binding) => binding.implementation_kind === "selected_file");
    if (readers.length === 0) throw reject("execution_refused", "This package reads no picked files: the run plan binds no tool that reads them, so the task cannot name one.", 409);
    const decisions = plan.authorization.decisions;
    const permissionIds = (binding: { required_permission_ids?: unknown }): string[] => (Array.isArray(binding.required_permission_ids) ? binding.required_permission_ids.filter((id): id is string => typeof id === "string") : []);
    const denied = [...new Set(readers.flatMap((binding) => permissionIds(binding).filter((id) => (decisions[id] ?? "deny") === "deny")))].sort();
    if (denied.length > 0 || readers.some((binding) => binding.approved !== true)) {
      throw reject(
        "execution_refused",
        `Reading the picked documents requires ${denied.length > 0 ? denied.join(", ") : "the approved file reader"}, which this authorization denies. Allow it under "Customize your settings", authorize again and prepare a new run plan, or run without documents.`,
        409,
        { denied_permission_ids: denied },
      );
    }
    return attachments;
  }

  /** Whether a run under this plan is handed anything from the secret store: a hosted provider's key, a granted record, or the memory for a bound memory tool. */
  private needsSecrets(plan: RunPlan): boolean {
    const provider = plan.model_binding?.provider_id ?? null;
    return planNeedsMemory(plan) || provider === "openai" || provider === "anthropic";
  }

  /**
   * What the host needs and nothing it does not (D-195): the key of the bound provider only, the
   * vault only when the plan needs it (its records when the plan grants one; its types alone,
   * under a throwaway key, when the plan binds a host-resource tool without a grant, review 1
   * finding 1), the providers' endpoints the plan's origins were computed from, and the origins
   * the plan recorded (D-193), in memory.
   */
  private async startMessage(runId: string, sessionId: string, plan: RunPlan): Promise<HostStartMessage> {
    const settings = await this.deps.settings.settings();
    const connections = connectionsFor(settings, await this.deps.settings.keyPresence());
    const connection = (provider: string) => connections.find((item) => item.provider === provider);
    const provider = plan.model_binding?.provider_id ?? null;
    // memory.v0 M-36: a run that grants a record or binds a memory tool is opened with the whole
    // store (its scan set is every sealed value; the resolver answers only the plan's grants).
    let memory: HostStartMessage["memory"] = null;
    if (planNeedsMemory(plan)) {
      const rules = (await this.deps.hooks.memoryRules?.()) ?? { preset: settings.preset, agent: "allow" as const, proposals: "ask" as const };
      const { key, snapshot } = await this.deps.hooks.memory().runSnapshot();
      memory = {
        key: encodeBase64(key),
        snapshot,
        agent_discard: rules.preset === "privacy-first" ? "preset" : rules.agent === "refuse" ? "policy" : null,
        policy_refuses_proposals: rules.proposals === "refuse",
        memory_full: await this.deps.hooks.memory().full(),
      };
    } else {
      // A run without memory still carries the rules: its proposals (if any) are checked over an empty scan set and offered by the same rules.
      const rules = (await this.deps.hooks.memoryRules?.()) ?? { preset: settings.preset, agent: "allow" as const, proposals: "ask" as const };
      memory = { key: null, snapshot: null, agent_discard: rules.preset === "privacy-first" ? "preset" : rules.agent === "refuse" ? "policy" : null, policy_refuses_proposals: rules.proposals === "refuse", memory_full: false };
    }
    return {
      type: "host.start",
      runId,
      credentials: { openai: provider === "openai" ? await this.deps.settings.key("openai") : null, anthropic: provider === "anthropic" ? await this.deps.settings.key("anthropic") : null },
      memory,
      settings: {
        ollamaBaseUrl: connection("ollama")?.base_url ?? null,
        openaiBaseUrl: connection("openai")?.base_url ?? null,
        anthropicBaseUrl: connection("anthropic")?.base_url ?? null,
        think: settings.models.connections.find((item) => item.provider === "ollama")?.think === true,
        ...openaiEffortOf(settings),
        recordRequests: settings.developer.record_requests,
        runtimeVersion: this.deps.runtimeVersion,
        verifiedVersion: this.deps.runtimeVersion,
        crossrefContact: settings.services.crossref_contact,
      },
      allowedOrigins: (await this.deps.hooks.planOrigins(sessionId)).map((item) => item.origin),
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
    // memory.v0 M-29, M-50: the run's usage entries and its staged agent document reach the memory
    // now, or wait for the next unlock when the store locked meanwhile; never a run failure.
    await this.applyRunMemory(runId).catch(() => undefined);
    // conversation.v0 (D-270): a turn's run settled; the conversation charges it, before the
    // snapshot may be dropped (its end rule may read it when the session has closed).
    if (run.invocation.turn) await this.onTurnSettled?.(run).catch(() => undefined);
    await this.deps.hooks.runSettled?.(run.invocation.archive_sha256);
    return { received: true };
  }

  /**
   * What a settled run left for the memory (its usage entries, its agent commit), applied
   * **once**: the facts are re-read inside one queue shared with the unlock sweep, written to the
   * memory in a single write, and cleared from the run only after that write (review 1, finding
   * 5). A locked store, or a store that refuses the commit (`memory_full`), keeps them on the run
   * for a later pass; nothing is applied twice, and nothing partly.
   */
  private applyRunMemory(runId: string): Promise<boolean> {
    return this.memoryWork.run(async () => {
      const run = await this.deps.runs.getRun(runId);
      if (run === null) return false;
      const usage = run.memory_usage ?? [];
      const commit = run.memory_commit ?? null;
      if (usage.length === 0 && commit === null) return false;
      if ((await this.deps.hooks.secretsState()) !== "unlocked") return false;
      await this.deps.hooks.memory().applyRun({ usage, commit: commit === null ? null : { package_id: commit.package_id, package_version: commit.package_version, run_id: run.run_id, name: commit.name, body: commit.body, at: commit.at } });
      await this.deps.runs.updateRun(run.run_id, (current) => ({ ...current, memory_usage: null, memory_commit: null }));
      return true;
    });
  }

  /**
   * After an unlock: every settled run whose memory facts are still waiting is applied (M-50: a
   * commit is never lost to a lock). Each run on its own: one the store refuses stays pending
   * without blocking the others (finding 5).
   */
  async applyPendingMemory(): Promise<number> {
    if ((await this.deps.hooks.secretsState()) !== "unlocked") return 0;
    let applied = 0;
    for (const run of await this.deps.runs.listRuns()) {
      if (!isTerminalStatus(run.record.status)) continue;
      if ((run.memory_usage ?? []).length === 0 && !run.memory_commit) continue;
      try {
        if (await this.applyRunMemory(run.run_id)) applied += 1;
      } catch {
        // Kept on the run (a full memory, a store that changed under the write); the next pass tries again.
      }
    }
    return applied;
  }

  // -- reads -----------------------------------------------------------------------------------
  private view(run: StoredRun): RunView {
    return { ...run.record, taskText: run.task_text, sessionOpen: this.deps.hooks.isSessionOpen(run.session_id), profileId: run.invocation.profile_id, consentPending: run.consent_pending ?? null };
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
      conversation: run.record.conversation ?? null,
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
      // progress hands the host a record that already carries the flag; whether one is in
      // progress is read before the host is asked, so a start that completes meanwhile is not
      // taken for an unreachable host (T5 review 3, nit 2).
      const startingBefore = this.starting.has(updated.session_id);
      let reached: boolean;
      try {
        const answer = await this.deps.host.cancel(runId);
        // A document that holds no Worker for a `preparing` run will read the flag when the run
        // starts; for a `running` run nothing holds it, so nobody can take the cancel (nit 3).
        reached = answer === "taken" || startingBefore || (answer === "not_held" && updated.record.status === "preparing");
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
        // The host settled the run between the flag and the interrupt: report what it wrote, not
        // the stale status the flag write returned (T5 review 3, nit 1).
        const latest = (await this.deps.runs.getRun(runId)) ?? updated;
        this.deps.broadcast({ type: "event.run", runId, sessionId: latest.session_id, status: latest.record.status });
        return this.view(latest);
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

/** The OpenAI connection's stated reasoning effort for a run's settings, when one is stated (D-123). */
function openaiEffortOf(settings: Settings): { openaiReasoningEffort?: OpenAIReasoningEffort } {
  const effort = settings.models.connections.find((connection) => connection.provider === "openai")?.reasoning_effort;
  return effort !== undefined ? { openaiReasoningEffort: effort } : {};
}

/** The custom types a package declares (memory.v0 M-18), kept with its run so a proposal of such a type can be reviewed once the snapshot is gone; null when it declares none. */
function declaredCustomTypes(pkg: Package): MemoryType[] | null {
  try {
    const custom = memoryDeclarations(pkg.manifest, pkg.policy, pkg.tools, pkg.files).custom_types;
    return custom.length === 0 ? null : custom;
  } catch {
    return null; // refused at validation already; a run of such a package never starts
  }
}
