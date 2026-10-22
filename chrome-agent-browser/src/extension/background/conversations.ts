/**
 * Conversations from the browser (conversation.v0, D-270): the service worker's half. A
 * conversation is a stored record between turns (`storage/conversations.ts`); each turn is a run
 * on the execution host, started by the run manager with the turn's context and settled by it;
 * this manager reserves each turn against the conversation's budget (V-10), records the
 * conversation-level events on the one chain (V-17), charges a settled turn (its usage, its `once`
 * grants, the new state), keeps the transcript (V-16), evaluates the end rule (V-8), carries the
 * person's answer to a card to the host (D-270), and reads what the views show.
 *
 * Nothing here is package-specific (D-009): every fact comes from the plan, the receipt, the
 * stores and the turn's own report.
 */
import { AuditChain, type ChainTail } from "../../core/conversation/chain.js";
import { conversationStatus, endsByPackage, limitsJson, remainingToolCaps, reserveTurn, type ConversationLimits, type Ended, type EndReason, type TranscriptTurn, type TurnUsage } from "../../core/conversation/runner.js";
import { CoreError } from "../../core/errors.js";
import { runtimeLimits } from "../../core/execution/limits.js";
import { isTerminalStatus, type RunRecord } from "../../core/execution/record.js";
import type { TurnStart } from "../../core/execution/runner.js";
import { sha256HexSync } from "../../core/hash.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../../core/json.js";
import { loadPackageBytes, type Package } from "../../core/package.js";
import { validateTaskInput } from "../../core/presentation.js";
import { pyIsoTimestamp } from "../../core/pyjson.js";
import { deepCopy } from "../../core/references.js";
import type { AuditEvent, ConversationPlan, RunPlan } from "../../core/types.js";
import { evaluate } from "../../core/workflow/values.js";
import { digest, type ConsentRecord } from "../../core/workflow/runtime.js";
import type { ConversationExportBundle, ConversationListView, ConversationSummary, ConversationView, Event, RunView } from "../messages.js";
import type { ConversationStore, StoredConversation } from "../storage/conversations.js";
import type { RunStore, StoredRun } from "../storage/runs.js";
import { taskText, type RunManager } from "./runs.js";

/** The conversation host as the manager reaches it (the offscreen bridge, or the in-process host in tests). */
export interface ConversationHostBridge {
  /** The person's answer to the card the turn waits on; false when no Worker holds the run (the record still carries it). */
  decide(runId: string, step: string, accepted: boolean): Promise<boolean>;
}

export interface ConversationHooks {
  /** The open session's package and plan (the run manager's `session`). */
  session(sessionId: string): Promise<{ pkg: Package; plan: RunPlan | null; archiveSha256: string }>;
  isSessionOpen(sessionId: string): boolean;
  snapshotBytes(archiveSha256: string): Promise<Uint8Array | null>;
}

export interface ConversationManagerDeps {
  conversations: ConversationStore;
  runs: RunStore;
  runner: RunManager;
  host: ConversationHostBridge;
  hooks: ConversationHooks;
  broadcast: (event: Event) => void;
  clock?: () => Date;
  randomId?: () => string;
}

function reject(code: string, message: string, status = 400, details: Record<string, unknown> | null = null): CoreError {
  return new CoreError(code, message, { status, details });
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/** `max_turns` from the plan's conversation section and the host's limits (none today: the package's). */
function limitsOf(plan: RunPlan): ConversationLimits {
  const conversation = plan.execution.conversation!;
  return { max_turns: conversation.max_turns, hard_tokens: conversation.hard_tokens, max_remote_calls: conversation.max_remote_calls, max_calls_per_tool: { ...conversation.max_calls_per_tool } };
}

/** How long a read (`get`, `list`) reuses the last reconcile: the chat polls about once a second. */
const RECONCILE_INTERVAL_MS = 5_000;

/**
 * Whether the record still stands where `read` left it: open, no turn in flight, the same turn
 * count and the same chain tail. Every conversation-level write is conditional on it, so two
 * writers that read the same tail never both extend it (V-17).
 */
function unchanged(current: StoredConversation, read: StoredConversation): boolean {
  return current.status === "open" && current.active_run_id === null && current.turns_started === read.turns_started && current.chain_tail.sequence === read.chain_tail.sequence && current.chain_tail.previous_hash === read.chain_tail.previous_hash;
}

/** The refusal for a write that lost to another writer: the conversation ended, or a turn started meanwhile. */
function raced(current: StoredConversation | null): CoreError {
  if (current === null) return reject("conversation_unknown", "This browser holds no conversation with that id.", 404);
  if (current.status !== "open") return reject("conversation_ended", "This conversation has ended; start a new one.", 409);
  return reject("turn_active", `Turn ${current.turns_started} is already running; wait for the reply, or stop the turn.`, 409, { run_id: current.active_run_id });
}

/**
 * The `once` permissions a turn without an outcome (interrupted, its Worker gone) may have spent,
 * read conservatively from what it left (V-13): every `once` check its checkpointed slice shows
 * allowed, and every `once` permission of a step accepted in it (by the person on the record, or
 * in the slice). A gated call made after the last checkpoint is covered by the accepted step.
 */
export function onceSpentWithoutOutcome(run: Pick<StoredRun, "audit" | "consent_decisions">, section: ConversationPlan, grants: Readonly<Record<string, string>>): string[] {
  const once = (pid: unknown): pid is string => typeof pid === "string" && grants[pid] === "once";
  const spent = new Set<string>();
  for (const event of run.audit) {
    if (event.action === "permission.checked" && event.allowed === true && once(event.permission)) spent.add(event.permission);
    if (event.action === "consent.decided" && event.accepted === true && Array.isArray(event.permissions)) for (const pid of event.permissions) if (once(pid)) spent.add(pid);
  }
  for (const [step, answer] of Object.entries(run.consent_decisions ?? {})) {
    if (!answer.accepted) continue;
    for (const pid of section.consent_steps.find((item) => item.id === step)?.permissions ?? []) if (once(pid)) spent.add(pid);
  }
  return [...spent].sort();
}

export class ConversationManager {
  private readonly clock: () => Date;
  private readonly randomId: () => string;
  /** One charge per settled turn, serialized: `host.finished` and a reconcile never charge a turn twice. */
  private charging: Promise<unknown> = Promise.resolve();
  /** The turns this worker is starting: recorded on the conversation, not yet stored as runs; a reconcile leaves them alone. */
  private readonly starting = new Set<string>();
  private reconciling: Promise<void> | null = null;
  private reconciledAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: ConversationManagerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.randomId = deps.randomId ?? (() => crypto.randomUUID());
  }

  // -- start ---------------------------------------------------------------------------------
  async start(sessionId: string, input: { runPlanId: string; runPlanSha256: string }): Promise<ConversationView> {
    const facts = await this.deps.hooks.session(sessionId);
    const plan = facts.plan;
    if (plan === null) throw reject("run_plan_absent", "Authorize this package and prepare a run plan first.", 409);
    if (plan.run_plan_id !== input.runPlanId || plan.run_plan_sha256 !== input.runPlanSha256) {
      throw reject("run_plan_mismatch", "The run plan on screen is not this session's current plan; reload the view.", 409, { run_plan_id: plan.run_plan_id });
    }
    const section = plan.execution.conversation;
    if (section === null || section === undefined) throw reject("conversation_profile_required", "This package declares no conversation; run it as a task.", 409);
    const open = (await this.deps.conversations.listConversations()).find((item) => item.status === "open" && item.run_plan.run_plan_id === plan.run_plan_id);
    if (open !== undefined) throw reject("conversation_active", `Conversation ${open.conversation_id} is open under this plan; end it first.`, 409, { conversation_id: open.conversation_id });
    // The same readiness a run needs (the plan, the origins, the secrets, no active run): a
    // conversation that could not start a turn is not started.
    const readiness = await this.deps.runner.readiness(sessionId);
    if (!readiness.ready) {
      const blocker = readiness.blocker!;
      throw reject(blocker.code, blocker.message, 409, { readiness: readiness as unknown as Record<string, unknown> });
    }
    const pkg = facts.pkg;
    const conversation = pkg.graph.conversation as JsonObject;
    const now = this.clock();
    const conversationId = this.randomId();
    const chain = new AuditChain(conversationId, { now: this.clock });
    const limits = limitsOf(plan);
    const state = deepCopy(evaluate(conversation.initial as JsonObject, {})) as JsonObject;
    const turnLimits = await this.deps.runner.hostLimits();
    chain.record("conversation.started", {
      package_id: String(pkg.manifest.package_id),
      package_version: String(pkg.manifest.version),
      package_digest: pkg.digest,
      limits: limitsJson(limits),
      grant_scopes: { ...plan.authorization.decisions },
      turns_supplied: 0,
      state_hash: digest(state),
    });
    const stored: StoredConversation = {
      conversation_id: conversationId,
      session_id: sessionId,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      started_at: pyIsoTimestamp(now),
      plan: this.deps.runner.executionPlanOf(plan),
      authorization: this.deps.runner.authorizationOf(plan),
      run_plan: plan,
      limits,
      turn_limits: turnLimits,
      archive_sha256: facts.archiveSha256,
      package: { package_id: String(pkg.manifest.package_id), name: (pkg.manifest.name as string | undefined) ?? null, version: String(pkg.manifest.version), digest: pkg.digest },
      state,
      chain_tail: chain.tail(),
      events: [...chain.events],
      spent: { tokens: 0, remote_calls: 0, tool_calls: {}, permissions: [] },
      spent_receipt: false,
      turns: [],
      active_run_id: null,
      turns_started: 0,
      status: "open",
      ended: null,
      title: null,
    };
    await this.deps.conversations.putConversation(stored);
    this.deps.broadcast({ type: "event.conversation", conversationId, sessionId, status: "open" });
    return this.view(stored);
  }

  // -- a turn --------------------------------------------------------------------------------
  async send(conversationId: string, message: unknown): Promise<ConversationView> {
    await this.reconcile(true);
    const stored = await this.require(conversationId);
    if (stored.status !== "open") throw reject("conversation_ended", "This conversation has ended; start a new one.", 409);
    if (stored.active_run_id !== null) throw reject("turn_active", `Turn ${stored.turns_started} is still running; wait for the reply, or stop the turn.`, 409, { run_id: stored.active_run_id });
    if (!this.deps.hooks.isSessionOpen(stored.session_id)) throw reject("session_closed", "The package session of this conversation is closed; open the package again and start a new conversation.", 409);
    const facts = await this.deps.hooks.session(stored.session_id);
    if (facts.plan === null || facts.plan.run_plan_id !== stored.run_plan.run_plan_id || facts.plan.run_plan_sha256 !== stored.run_plan.run_plan_sha256) {
      throw reject("run_plan_mismatch", "The session's plan changed since this conversation started (a new authorization); end it and start a new conversation.", 409);
    }
    const validation = await validateTaskInput(facts.pkg, message);
    if (!validation.valid) {
      const detail = validation.errors.slice(0, 4).map((error) => `${error.pointer || "(message)"} ${error.message}`).join("; ");
      throw reject("input_invalid", `The message does not match this package's input: ${detail}`, 422, { errors: validation.errors });
    }
    const index = stored.turns_started + 1;
    const chain = this.chainOf(stored);
    chain.turn = index;
    // The turn's hard budgets under the host's per-run limits, as the runtime will apply them (V-10).
    const refusal = reserveTurn(facts.pkg, stored.limits, runtimeLimits(stored.turn_limits), stored.spent, stored.turns.filter((turn) => turn.status !== "refused").length);
    if (refusal !== null) {
      // V-10: refused before any node runs, and the conversation ends at its bound (V-25), in one write.
      const now = pyIsoTimestamp(this.clock());
      chain.record("turn.refused", { reason: refusal, message_hash: digest(message as JsonValue), spent_tokens: stored.spent.tokens, spent_remote_calls: stored.spent.remote_calls, limits: limitsJson(stored.limits) });
      const entry: TranscriptTurn = { turn: index, status: "refused", error_code: "budget_exhausted", refusal, message: deepCopy(message as JsonValue), consents: {}, decisions: [], unused_consents: [], reply: null, usage: { tokens: 0, remote_calls: 0, tool_calls: {} }, started_at: now, ended_at: now };
      const after: StoredConversation = { ...stored, turns: [...stored.turns, entry], turns_started: index };
      const ended = this.recordEnd(chain, after, refusal === "conversation_turn_limit" ? "max_turns" : "budget");
      let won = false;
      const updated = await this.deps.conversations.updateConversation(conversationId, (current) => {
        if (!unchanged(current, stored)) return null;
        won = true;
        return { ...current, turns: [...current.turns, entry], turns_started: index, status: "ended", ended, events: [...current.events, ...chain.events], chain_tail: chain.tail(), updated_at: this.clock().toISOString() };
      });
      if (!won) throw raced(updated);
      this.deps.broadcast({ type: "event.conversation", conversationId, sessionId: stored.session_id, status: "ended" });
      return this.view(updated!);
    }
    chain.record("turn.started", { message_hash: digest(message as JsonValue), consents_supplied: [], state_hash: digest(stored.state), spent_tokens: stored.spent.tokens, spent_remote_calls: stored.spent.remote_calls });
    const section = stored.run_plan.execution.conversation!;
    const preDecided: TurnStart["pre_decided"] = {};
    for (const step of section.consent_steps) if (step.pre_decided !== null) preDecided[step.id] = { ...step.pre_decided };
    const turn: TurnStart = {
      conversation_id: conversationId,
      turn: index,
      state: deepCopy(stored.state),
      chain_tail: chain.tail(),
      spent_permissions: [...stored.spent.permissions],
      tool_caps: remainingToolCaps(stored.limits, stored.spent.tool_calls),
      pre_decided: preDecided,
    };
    // The record first, with the turn's run id, so a turn the host starts (and settles) finds its
    // conversation waiting for it; conditional, so a second send or an end that read the same
    // record is refused instead of forking the chain (V-17).
    const runId = this.deps.runner.newRunId();
    let won = false;
    const reserved = await this.deps.conversations.updateConversation(conversationId, (current) => {
      if (!unchanged(current, stored)) return null;
      won = true;
      return { ...current, turns_started: index, active_run_id: runId, events: [...current.events, ...chain.events], chain_tail: chain.tail(), title: current.title ?? taskText(message), updated_at: this.clock().toISOString() };
    });
    if (!won) throw raced(reserved);
    this.starting.add(runId);
    try {
      await this.deps.runner.startTurn(stored.session_id, { plan: facts.plan, message: message as JsonValue, turn, spentByConversation: stored.spent_receipt, runId });
    } catch (error) {
      // The turn never ran (the lease, the host). A stored run means the lease spent the receipt
      // (nit 7): the conversation's later turns are leased under it.
      const leased = (await this.deps.runs.getRun(runId).catch(() => null)) !== null;
      const code = error instanceof CoreError ? error.code : "execution_unavailable";
      const detail = error instanceof Error ? error.message : "The turn could not be started";
      const now = pyIsoTimestamp(this.clock());
      chain.record("turn.failed", { turn_run_id: null, status: "failed", error_code: code, tokens: 0, remote_calls: 0, spent_tokens: stored.spent.tokens, spent_remote_calls: stored.spent.remote_calls, state_hash: digest(stored.state), consents_decided: [] });
      const entry: TranscriptTurn = { turn: index, status: "failed", error_code: code, refusal: null, message: deepCopy(message as JsonValue), consents: {}, decisions: [], unused_consents: [], reply: null, usage: { tokens: 0, remote_calls: 0, tool_calls: {} }, started_at: now, ended_at: now };
      // A failed turn in the record, the conversation open (V-25), unless the run manager already
      // settled the stored run (a host that did not start), which charged it with its own `turn.failed`.
      await this.deps.conversations.updateConversation(conversationId, (current) => {
        const spentReceipt = current.spent_receipt || leased;
        if (current.active_run_id !== runId) return spentReceipt === current.spent_receipt ? null : { ...current, spent_receipt: spentReceipt };
        return { ...current, active_run_id: null, spent_receipt: spentReceipt, turns: [...current.turns, entry], events: [...current.events, chain.events[chain.events.length - 1]!], chain_tail: chain.tail(), updated_at: this.clock().toISOString() };
      });
      this.deps.broadcast({ type: "event.conversation", conversationId, sessionId: stored.session_id, status: "open" });
      throw reject(code, detail, error instanceof CoreError ? error.status : 503, { conversation_id: conversationId });
    } finally {
      this.starting.delete(runId);
    }
    const updated = await this.deps.conversations.updateConversation(conversationId, (current) => (current.spent_receipt ? null : { ...current, spent_receipt: true, updated_at: this.clock().toISOString() }));
    this.deps.broadcast({ type: "event.conversation", conversationId, sessionId: stored.session_id, status: "open" });
    return this.view(updated ?? (await this.require(conversationId)));
  }

  /** The chain as it stands for this conversation, to record the next conversation-level event. */
  private chainOf(stored: StoredConversation): AuditChain {
    return new AuditChain(stored.conversation_id, { tail: stored.chain_tail, now: this.clock });
  }

  // -- the host reports: a turn settled ------------------------------------------------------
  /**
   * A turn's run settled (the run manager's `hostFinished`, or an interruption): charge it to the
   * conversation exactly once, continue the chain from the run's audit tail with `turn.completed`
   * or `turn.failed`, keep the transcript entry, the new state, and end the conversation when the
   * package's rule says so (V-8).
   */
  turnSettled(run: StoredRun): Promise<void> {
    const work = async () => {
      const turn = run.invocation.turn;
      if (!turn || !isTerminalStatus(run.record.status)) return;
      const stored = await this.deps.conversations.getConversation(turn.conversation_id);
      if (stored === null || stored.active_run_id !== run.run_id) return; // charged already, or cleared
      const status: TranscriptTurn["status"] = run.record.status === "completed" ? "completed" : run.record.status === "cancelled" ? "cancelled" : "failed";
      const errorCode = status === "completed" ? null : (run.record.errorCode ?? (run.record.status === "interrupted" ? "interrupted" : "worker_error"));
      const usage = (run.usage ?? {}) as JsonObject;
      const toolCalls = isJsonObject(usage.tool_calls) ? (usage.tool_calls as Record<string, number>) : {};
      const turnUsage: TurnUsage = { tokens: typeof usage.tokens === "number" ? usage.tokens : 0, remote_calls: typeof usage.remote_calls === "number" ? usage.remote_calls : 0, tool_calls: { ...toolCalls } };
      const outcome = run.turn_outcome ?? null;
      const spent = { ...stored.spent, tool_calls: { ...stored.spent.tool_calls } };
      spent.tokens += turnUsage.tokens;
      spent.remote_calls += turnUsage.remote_calls;
      for (const [toolId, count] of Object.entries(turnUsage.tool_calls)) spent.tool_calls[toolId] = (spent.tool_calls[toolId] ?? 0) + count;
      // A turn without an outcome (interrupted) left no report of its `once` grants: read them from what it left (V-13).
      const turnSpent = outcome !== null ? outcome.spent_permissions : onceSpentWithoutOutcome(run, stored.run_plan.execution.conversation!, stored.run_plan.authorization.decisions);
      spent.permissions = [...new Set([...spent.permissions, ...turnSpent])].sort();
      const state = status === "completed" && outcome?.conversation_state ? deepCopy(outcome.conversation_state) : stored.state;
      // The chain continues from the run's slice: its last event is where the turn left it (V-17).
      const slice = run.audit;
      const tail: ChainTail = slice.length > 0 ? { previous_hash: slice[slice.length - 1]!.event_hash, sequence: slice[slice.length - 1]!.sequence } : stored.chain_tail;
      const chain = new AuditChain(stored.conversation_id, { tail, now: this.clock });
      chain.turn = turn.turn;
      const consents: ConsentRecord[] = outcome?.consents ?? [];
      chain.record(status === "completed" ? "turn.completed" : "turn.failed", { turn_run_id: run.run_id, status, error_code: errorCode, tokens: turnUsage.tokens, remote_calls: turnUsage.remote_calls, spent_tokens: spent.tokens, spent_remote_calls: spent.remote_calls, state_hash: digest(state), consents_decided: consents.map((decision) => decision.step) });
      const entry: TranscriptTurn = {
        turn: turn.turn,
        run_id: run.run_id,
        status,
        error_code: errorCode,
        refusal: null,
        message: deepCopy(run.invocation.input),
        consents: Object.fromEntries(Object.entries(run.consent_decisions ?? {}).map(([step, answer]) => [step, answer.accepted])),
        decisions: clone(consents),
        unused_consents: [],
        reply: status === "completed" ? deepCopy(outcome?.output ?? null) : null,
        usage: turnUsage,
        started_at: run.record.startedAt ?? run.created_at,
        ended_at: run.record.endedAt ?? pyIsoTimestamp(this.clock()),
      };
      // The end rule (V-8) and the turn bound are evaluated before the write, so the turn's event and
      // `conversation.ended` land in one write: no send can start a turn between them.
      const after: StoredConversation = { ...stored, spent, state, turns: [...stored.turns, entry] };
      let reason: EndReason | null = null;
      if (status === "completed" && entry.reply !== null && (await this.endsByPackage(stored, entry.reply, state))) reason = "package";
      else if (after.turns.filter((item) => item.status !== "refused").length >= after.limits.max_turns) reason = "max_turns";
      const ended = reason === null ? null : this.recordEnd(chain, after, reason);
      let won = false;
      const updated = await this.deps.conversations.updateConversation(stored.conversation_id, (current) => {
        if (current.active_run_id !== run.run_id || current.chain_tail.sequence !== stored.chain_tail.sequence) return null;
        won = true;
        return { ...current, active_run_id: null, spent, state, turns: [...current.turns, entry], events: [...current.events, ...chain.events], chain_tail: chain.tail(), ...(ended !== null ? { status: "ended" as const, ended } : {}), updated_at: this.clock().toISOString() };
      });
      if (!won || updated === null) return;
      // Clear the turn's leftovers from the run: the conversation holds them now.
      await this.deps.runs.updateRun(run.run_id, (current) => ({ ...current, turn_outcome: null }));
      this.deps.broadcast({ type: "event.conversation", conversationId: stored.conversation_id, sessionId: stored.session_id, status: ended !== null ? "ended" : "open" });
    };
    const next = this.charging.then(work, work);
    this.charging = next.catch(() => undefined);
    return next;
  }

  /** V-8: whether the package's end rule holds after a completed turn, over the reply and the new state (the core's rule, on the session's package or the snapshot). */
  private async endsByPackage(stored: StoredConversation, reply: JsonValue, state: JsonObject): Promise<boolean> {
    let pkg: Package | null = null;
    if (this.deps.hooks.isSessionOpen(stored.session_id)) {
      const facts = await this.deps.hooks.session(stored.session_id).catch(() => null);
      if (facts !== null && facts.pkg.digest === stored.package.digest) pkg = facts.pkg;
    }
    if (pkg === null) {
      const bytes = await this.deps.hooks.snapshotBytes(stored.archive_sha256);
      // The package is gone from this browser: the rule cannot be read, and the turn bound still ends the conversation.
      if (bytes === null) return false;
      pkg = await loadPackageBytes(bytes);
    }
    try {
      return endsByPackage(pkg, reply, state);
    } catch {
      return false;
    }
  }

  /**
   * Charge every open conversation whose turn settled while this worker was away (a `host.finished`
   * it never saw). One at a time; a read reuses a reconcile younger than RECONCILE_INTERVAL_MS, a
   * write (`force`) always runs one (nit 10).
   */
  private reconcile(force = false): Promise<void> {
    if (this.reconciling !== null) return this.reconciling;
    if (!force && Date.now() - this.reconciledAt < RECONCILE_INTERVAL_MS) return Promise.resolve();
    this.reconciling = this.reconcileNow().finally(() => {
      this.reconciledAt = Date.now();
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async reconcileNow(): Promise<void> {
    // A run the host no longer reports is interrupted first (D-071), which charges its turn here.
    await this.deps.runner.restore();
    for (const stored of await this.deps.conversations.listConversations()) {
      if (stored.status !== "open" || stored.active_run_id === null || this.starting.has(stored.active_run_id)) continue;
      const run = await this.deps.runs.getRun(stored.active_run_id);
      if (run === null) {
        // The run is gone (cleared): the turn is lost; the conversation goes on without it.
        await this.deps.conversations.updateConversation(stored.conversation_id, (current) => (current.active_run_id === stored.active_run_id ? { ...current, active_run_id: null, updated_at: this.clock().toISOString() } : null));
      } else if (isTerminalStatus(run.record.status)) await this.turnSettled(run);
    }
  }

  // -- the person's decisions ------------------------------------------------------------------
  async decide(conversationId: string, step: string, accepted: boolean): Promise<ConversationView> {
    const stored = await this.require(conversationId);
    if (stored.active_run_id === null) throw reject("no_turn_active", "No turn is waiting for a decision.", 409);
    const runId = stored.active_run_id;
    const now = pyIsoTimestamp(this.clock());
    const run = await this.deps.runs.updateRun(runId, (current) => {
      if (isTerminalStatus(current.record.status)) return null;
      if (!current.consent_pending || current.consent_pending.step !== step) return null;
      return { ...current, consent_decisions: { ...(current.consent_decisions ?? {}), [step]: { accepted, decided_at: now } }, updated_at: this.clock().toISOString() };
    });
    if (run === null || run.consent_decisions?.[step] === undefined) throw reject("consent_not_pending", `Turn ${stored.turns_started} is not waiting on step ${JSON.stringify(step)}.`, 409);
    // The record carries the answer; the message reaches the Worker that waits on it (or it reads the record).
    await this.deps.host.decide(runId, step, accepted).catch(() => false);
    this.deps.broadcast({ type: "event.conversation", conversationId, sessionId: stored.session_id, status: "open" });
    return this.view(await this.require(conversationId));
  }

  async cancelTurn(conversationId: string): Promise<ConversationView> {
    const stored = await this.require(conversationId);
    if (stored.active_run_id === null) throw reject("no_turn_active", "No turn is running.", 409);
    await this.deps.runner.cancel(stored.active_run_id);
    return this.view(await this.require(conversationId));
  }

  /** The person ends the conversation between turns (V-25, reason `person`); a running turn is stopped first. */
  async endByPerson(conversationId: string): Promise<ConversationView> {
    await this.reconcile(true);
    const stored = await this.require(conversationId);
    if (stored.status === "ended") return this.view(stored);
    if (stored.active_run_id !== null) throw reject("turn_active", "A turn is still running; stop it before ending the conversation.", 409, { run_id: stored.active_run_id });
    const chain = this.chainOf(stored);
    const ended = this.recordEnd(chain, stored, "person");
    let won = false;
    const updated = await this.deps.conversations.updateConversation(conversationId, (current) => {
      if (!unchanged(current, stored)) return null;
      won = true;
      return { ...current, status: "ended", ended, events: [...current.events, ...chain.events], chain_tail: chain.tail(), updated_at: this.clock().toISOString() };
    });
    if (!won) {
      // Ended by another writer meanwhile: the person's wish holds already.
      if (updated !== null && updated.status === "ended") return this.view(updated);
      throw raced(updated);
    }
    this.deps.broadcast({ type: "event.conversation", conversationId, sessionId: stored.session_id, status: "ended" });
    return this.view(updated!);
  }

  /** Record `conversation.ended` on the chain for the record as it stands after its last turn; the caller writes both in one step. */
  private recordEnd(chain: AuditChain, after: StoredConversation, reason: EndReason): Ended {
    chain.turn = after.turns_started;
    const last = after.turns.length > 0 ? after.turns[after.turns.length - 1]! : null;
    const ended: Ended = { reason, at: pyIsoTimestamp(this.clock()), turns_not_run: (reason === "max_turns" || reason === "budget") && last !== null && last.status === "refused" ? 1 : 0 };
    chain.record("conversation.ended", { reason, turns: after.turns.filter((turn) => turn.status !== "refused").length, tokens: after.spent.tokens, remote_calls: after.spent.remote_calls, spent_permissions: [...after.spent.permissions].sort(), state_hash: digest(after.state) });
    return ended;
  }

  // -- reads ----------------------------------------------------------------------------------
  private async require(conversationId: string): Promise<StoredConversation> {
    const stored = await this.deps.conversations.getConversation(conversationId);
    if (stored === null) throw reject("conversation_unknown", "This browser holds no conversation with that id.", 404);
    return stored;
  }

  async get(conversationId: string): Promise<ConversationView | null> {
    await this.reconcile();
    const stored = await this.deps.conversations.getConversation(conversationId);
    return stored === null ? null : this.view(stored);
  }

  async list(sessionId: string | null): Promise<ConversationListView> {
    await this.reconcile();
    const all = (await this.deps.conversations.listConversations()).filter((item) => sessionId === null || item.session_id === sessionId).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return { conversations: all.map((item) => this.summary(item)) };
  }

  private summary(stored: StoredConversation): ConversationSummary {
    return {
      conversationId: stored.conversation_id,
      sessionId: stored.session_id,
      runPlanId: stored.run_plan.run_plan_id,
      status: stored.status,
      createdAt: stored.created_at,
      endedAt: stored.ended?.at ?? null,
      endedReason: stored.ended?.reason ?? null,
      package: { packageId: stored.package.package_id, name: stored.package.name, version: stored.package.version },
      selectedModel: stored.run_plan.model_binding?.host_model_id ?? null,
      turns: stored.turns.filter((turn) => turn.status !== "refused").length,
      activeRunId: stored.active_run_id,
      title: stored.title,
    };
  }

  private async view(stored: StoredConversation): Promise<ConversationView> {
    const active = stored.active_run_id === null ? null : await this.deps.runner.get(stored.active_run_id);
    const pending = stored.active_run_id === null ? null : ((await this.deps.runs.getRun(stored.active_run_id))?.consent_pending ?? null);
    const section = stored.run_plan.execution.conversation!;
    const kinds = new Map(section.consent_steps.map((step) => [step.id, step.kinds]));
    return {
      ...this.summary(stored),
      startedAt: stored.started_at,
      ended: stored.ended,
      limits: limitsJson(stored.limits) as unknown as ConversationView["limits"],
      spent: { turns: stored.turns.filter((turn) => turn.status !== "refused").length, tokens: stored.spent.tokens, remote_calls: stored.spent.remote_calls, tool_calls: { ...stored.spent.tool_calls }, permissions: [...stored.spent.permissions] },
      transcript: clone(stored.turns),
      state: clone(stored.state),
      persistentKeys: [...section.persistent_keys],
      consentSteps: section.consent_steps.map((step) => ({ ...step, permissions: [...step.permissions], kinds: [...step.kinds] })),
      activeRun: active,
      pendingConsent: pending === null ? null : { ...pending, kinds: kinds.get(pending.step) ?? [] },
      outcome: stored.status === "ended" ? conversationStatus(stored.turns) : null,
      sessionOpen: this.deps.hooks.isSessionOpen(stored.session_id),
      profileId: stored.run_plan.authorization.provenance?.profile_id ?? null,
      grants: { ...stored.run_plan.authorization.decisions },
      resources: stored.run_plan.resource_grants.map((grant) => ({ permissionId: grant.permission_id, resourceType: grant.resource_type, resourceId: grant.resource_id })),
    };
  }

  // -- the export (D-272) --------------------------------------------------------------------
  /** The whole chain: the conversation-level events and every turn's slice, in sequence order. */
  private async wholeChain(stored: StoredConversation): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [...stored.events];
    for (const turn of stored.turns) {
      if (!turn.run_id) continue;
      const run = await this.deps.runs.getRun(turn.run_id);
      if (run) events.push(...run.audit);
    }
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  private transcript(stored: StoredConversation): JsonObject {
    return {
      schema: "conversation.transcript.v0",
      conversation_id: stored.conversation_id,
      package: { package_id: stored.package.package_id, version: stored.package.version, digest: stored.package.digest },
      started_at: stored.started_at,
      turns: clone(stored.turns) as unknown as JsonValue[],
      state: clone(stored.state),
      budget: { limits: limitsJson(stored.limits), spent: { turns: stored.turns.filter((turn) => turn.status !== "refused").length, tokens: stored.spent.tokens, remote_calls: stored.spent.remote_calls, tool_calls: { ...stored.spent.tool_calls } } },
      spent_permissions: [...stored.spent.permissions].sort(),
      ended: stored.ended ?? { reason: "host", at: pyIsoTimestamp(this.clock()), turns_not_run: 0 },
    };
  }

  async exportBundle(conversationId: string): Promise<ConversationExportBundle> {
    await this.reconcile(true);
    const stored = await this.require(conversationId);
    const entries: ConversationExportBundle["entries"] = [];
    const push = (name: string, bytes: Uint8Array) => entries.push({ name, bytes: bytes.length, sha256: sha256HexSync(bytes), base64: encodeBase64(bytes) });
    const chain = await this.wholeChain(stored);
    const usage = { turns: stored.turns.filter((turn) => turn.status !== "refused").length, tokens: stored.spent.tokens, remote_calls: stored.spent.remote_calls, tool_calls: { ...stored.spent.tool_calls }, limits: limitsJson(stored.limits), per_turn: stored.turns.map((turn) => ({ turn: turn.turn, status: turn.status, ...turn.usage })) };
    const provenance = { profile: "conversation.v0", interpreter: "chrome-agent-browser.conversation.ConversationManager", package_id: stored.package.package_id, package_digest: stored.package.digest, conversation_id: stored.conversation_id, persistent_keys: [...stored.run_plan.execution.conversation!.persistent_keys] };
    const { events: _events, ...record } = stored;
    push("conversation.json", encodeJson({ ...record, status: stored.status, outcome: stored.status === "ended" ? conversationStatus(stored.turns) : null }));
    push("run-plan.json", encodeJson(stored.run_plan));
    push("transcript.json", encodeJson(this.transcript(stored)));
    push("state.json", encodeJson(stored.state));
    push("audit.json", encodeJson(chain));
    push("usage.json", encodeJson(usage));
    push("provenance.json", encodeJson(provenance));
    for (const turn of stored.turns) {
      if (!turn.run_id) continue;
      const prefix = `turn-${String(turn.turn).padStart(3, "0")}/`;
      const bundle = await this.deps.runner.exportBundle(turn.run_id).catch(() => null);
      if (bundle === null) continue;
      for (const entry of bundle.entries) entries.push({ ...entry, name: `${prefix}${entry.name}` });
    }
    return { conversation_id: conversationId, entries };
  }

  async clear(conversationId: string): Promise<{ cleared: boolean; conversation_id: string }> {
    const stored = await this.require(conversationId);
    if (stored.active_run_id !== null) throw reject("turn_active", "A conversation with a turn in flight cannot be cleared; stop the turn first.", 409);
    for (const turn of stored.turns) if (turn.run_id) await this.deps.runner.clear(turn.run_id).catch(() => undefined);
    await this.deps.conversations.deleteConversation(conversationId);
    this.deps.broadcast({ type: "event.conversation", conversationId, sessionId: stored.session_id, status: "cleared" });
    return { cleared: true, conversation_id: conversationId };
  }

  /** How many conversations this browser holds, for the status line. */
  async storedCount(): Promise<number> {
    return (await this.deps.conversations.listConversations()).length;
  }
}

export type { RunRecord };
