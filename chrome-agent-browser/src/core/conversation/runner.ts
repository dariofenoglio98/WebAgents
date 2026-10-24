/**
 * The conversation runner (conversation.v0 §4–§6, `agentpkg/conversation/runner.py`): turn by
 * turn over the interpreter, under one Run Plan's grants, with the persisted state, the
 * whole-turn reservation against the conversation's budget, `once` spent once per conversation,
 * the consent host and one audit chain.
 *
 * Nothing here is package-specific. The host supplies, per turn, the model router, the tool
 * handlers, the run's memory and the engine; the runner supplies the turn context (`TurnContext`)
 * the interpreter and the mediator read. A host that runs each turn in another process (the
 * extension) uses the same pieces one turn at a time: `reserve`, `turnContext`, `charge`, and the
 * conversation-level events on its own `AuditChain`.
 */
import type { ComputeEngine } from "../compute/engine.js";
import { AgentPkgError } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { MemoryRun } from "../memory/run.js";
import type { ModelRouter } from "../models/contract.js";
import { packageJson, type Package } from "../package.js";
import { pyIsoTimestamp } from "../pyjson.js";
import { deepCopy } from "../references.js";
import type { ToolHandler } from "../tools/handler.js";
import type { AuditEvent } from "../types.js";
import { CancelledError, failureCode, PolicyError } from "../workflow/errors.js";
import { Workflow, type ExecutionReport } from "../workflow/interpreter.js";
import { checkApprovedTools, checkGrants, checkHostLimits, digest, type ConsentRecord, type Grants, type HostLimits, type Observer, type TurnContext } from "../workflow/runtime.js";
import { evaluate, pyEqual } from "../workflow/values.js";
import { AuditChain, type ChainTail } from "./chain.js";
import { conversationOf, persistentKeys } from "./declarations.js";
import { ConversationError } from "./errors.js";
import { TranscriptConsent, type ConsentHost } from "./host.js";
import { turnDecisions, type TranscriptInput, type TranscriptTurnInput } from "./transcript.js";

export const PROFILE = "conversation.v0";
export const INTERPRETER = "chrome-agent-browser.conversation.Conversation";
/** Host limits of a conversation; like every host limit they only lower the package's (V-11). */
export const HOST_KEYS: Readonly<Record<string, keyof ConversationLimits>> = Object.freeze({
  conversation_max_turns: "max_turns",
  conversation_total_tokens: "hard_tokens",
  conversation_max_remote_calls: "max_remote_calls",
});

export interface ConversationLimits {
  max_turns: number;
  hard_tokens: number;
  max_remote_calls: number;
  max_calls_per_tool: Record<string, number>;
}

export type EndReason = "person" | "package" | "max_turns" | "budget" | "host";

export interface Ended extends JsonObject {
  reason: EndReason;
  at: string;
  turns_not_run: number;
}

export interface TurnUsage extends JsonObject {
  tokens: number;
  remote_calls: number;
  tool_calls: Record<string, number>;
}

/** One entry of the output transcript (V-16). */
export interface TranscriptTurn {
  turn: number;
  run_id?: string;
  status: "completed" | "failed" | "cancelled" | "refused";
  error_code: string | null;
  refusal: string | null;
  message: JsonValue;
  consents: Record<string, boolean>;
  decisions: ConsentRecord[];
  unused_consents: string[];
  reply: JsonValue | null;
  usage: TurnUsage;
  started_at: string;
  ended_at: string;
}

/** The spent counters of a conversation, carried between turns. */
export interface Spent {
  tokens: number;
  remote_calls: number;
  tool_calls: Record<string, number>;
  permissions: string[];
}

export interface TurnAdapters {
  router?: ModelRouter | null;
  handlers?: Record<string, ToolHandler> | null;
  memory?: MemoryRun | null;
  compute?: ComputeEngine | null;
}

export interface ConversationOptions {
  grants: Grants;
  approvedTools: readonly string[];
  /** The host's per-turn factory: the router, the handlers, the memory and the engine for this turn. */
  adapters: (turn: number) => TurnAdapters;
  /** The host's limits: the conversation's keys (`conversation_*`) beside the turn's. */
  limits?: (HostLimits & Partial<Record<keyof typeof HOST_KEYS, number>>) | null;
  /** The consent host for a turn, given the transcript's decisions for it; the transcript host by default. */
  consent?: ((turn: number, decisions: Record<string, boolean>) => ConsentHost) | null;
  observer?: Observer | null;
  /** A host writes a turn's artifacts as soon as the turn ends. */
  onTurn?: ((turn: number, report: ExecutionReport, status: TranscriptTurn["status"]) => void) | null;
  /** The host's own deadline for one turn, as a `Date.now()` instant (the runner's watchdog), when it has one. */
  turnDeadlineAt?: (() => number) | null;
  conversationId?: string;
  now?: () => Date;
}

function nonnegative(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new PolicyError(`Host limit ${key} must be a nonnegative integer`);
  return value;
}

/** The host's limits: the conversation's keys apart from the turn's (which `Runtime` checks as it always did). */
export function splitLimits(limits: Record<string, unknown> | null | undefined): { conversation: Partial<ConversationLimits>; turn: HostLimits } {
  const rest: Record<string, unknown> = { ...(limits ?? {}) };
  const conversation: Partial<ConversationLimits> = {};
  for (const [key, name] of Object.entries(HOST_KEYS)) {
    if (Object.hasOwn(rest, key)) {
      const value = nonnegative(key, rest[key]);
      delete rest[key];
      if (name !== "max_calls_per_tool") conversation[name] = value;
    }
  }
  return { conversation, turn: rest as HostLimits };
}

export function effectiveLimits(pkg: Package, host: Partial<ConversationLimits>): ConversationLimits {
  const declared = conversationOf(pkg.graph)!.budget as JsonObject;
  const caps = { ...((declared.max_calls_per_tool as Record<string, number> | undefined) ?? {}) };
  const min = (key: "max_turns" | "hard_tokens" | "max_remote_calls"): number => Math.min(declared[key] as number, host[key] ?? (declared[key] as number));
  return { max_turns: min("max_turns"), hard_tokens: min("hard_tokens"), max_remote_calls: min("max_remote_calls"), max_calls_per_tool: caps };
}

export function limitsJson(limits: ConversationLimits): JsonObject {
  return { max_turns: limits.max_turns, hard_tokens: limits.hard_tokens, max_remote_calls: limits.max_remote_calls, max_calls_per_tool: { ...limits.max_calls_per_tool } };
}

/**
 * Whole-turn reservation (V-10): the turn's own hard budgets must fit in what the conversation has
 * left, else the turn is refused before any node runs. Pure, so a host that holds the counters in
 * a record can ask the same question.
 */
export function reserveTurn(pkg: Package, limits: ConversationLimits, turnLimits: HostLimits, spent: Pick<Spent, "tokens" | "remote_calls">, turnsRun: number): "conversation_turn_limit" | "conversation_budget_exhausted" | null {
  const turn = pkg.policy.budget as JsonObject;
  if (turnsRun >= limits.max_turns) return "conversation_turn_limit";
  const hardTokens = Math.min(turn.hard_tokens as number, turnLimits.hard_tokens ?? (turn.hard_tokens as number));
  const remote = Math.min(turn.max_remote_calls as number, turnLimits.max_remote_calls ?? (turn.max_remote_calls as number));
  if (spent.tokens + hardTokens > limits.hard_tokens) return "conversation_budget_exhausted";
  if (spent.remote_calls + remote > limits.max_remote_calls) return "conversation_budget_exhausted";
  return null;
}

/** The per-tool calls a turn may still make under the conversation's caps (V-10). */
export function remainingToolCaps(limits: ConversationLimits, toolCalls: Readonly<Record<string, number>>): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const [toolId, cap] of Object.entries(limits.max_calls_per_tool)) caps[toolId] = Math.max(0, cap - (toolCalls[toolId] ?? 0));
  return caps;
}

/** Whether `end.when` holds after a completed turn (V-8). */
export function endsByPackage(pkg: Package, reply: JsonValue, state: JsonObject): boolean {
  const conversation = conversationOf(pkg.graph)!;
  const end = conversation.end;
  if (end === undefined || end === null) return false;
  const when = (end as JsonObject).when as JsonObject;
  const env = { result: reply, state };
  const equal = pyEqual(evaluate(when.left!, env), evaluate(when.right!, env));
  return equal === (when.op === "eq");
}

/** The conversation's status (V-30): completed when at least one turn completed and none failed or was cancelled. */
export function conversationStatus(turns: ReadonlyArray<Pick<TranscriptTurn, "status">>): "completed" | "failed" {
  const ran = turns.filter((turn) => turn.status !== "refused");
  const failed = turns.some((turn) => turn.status === "failed" || turn.status === "cancelled");
  return ran.length > 0 && !failed ? "completed" : "failed";
}

export interface ConversationReport {
  status: "completed" | "failed";
  profile: typeof PROFILE;
  transcript: JsonObject;
  state: JsonObject;
  audit: AuditEvent[];
  usage: JsonObject;
  provenance: JsonObject;
  ended: Ended;
}

/**
 * One conversation of one package under one set of grants, in process: the CLI's `converse` and
 * the test suites. The extension runs the same steps with each turn on its execution host.
 */
export class Conversation {
  readonly package: Package;
  readonly grants: Grants;
  readonly approvedTools: string[];
  readonly limits: ConversationLimits;
  readonly turnLimits: HostLimits;
  readonly conversationId: string;
  readonly chain: AuditChain;
  readonly startedAt: string;
  state: JsonObject;
  spent: Spent = { tokens: 0, remote_calls: 0, tool_calls: {}, permissions: [] };
  readonly turns: TranscriptTurn[] = [];
  ended: Ended | null = null;
  private readonly options: ConversationOptions;
  private readonly now: () => Date;
  private current: Workflow | null = null;
  private cancelRequested = false;

  constructor(pkg: Package, options: ConversationOptions) {
    if (conversationOf(pkg.graph) === null) throw new ConversationError("conversation_profile_required", "this package declares no conversation");
    this.package = pkg;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.grants = { ...options.grants };
    this.approvedTools = [...options.approvedTools];
    // The host's inputs are checked here, as `Runtime` checks them for a run, so that a grant
    // value or a limit key the mediator would refuse is refused before the chain starts and
    // before a host creates anything for the conversation (D-265).
    checkGrants(new Set((pkg.policy.permissions as JsonObject[]).map((permission) => String(permission.id))), this.grants);
    checkApprovedTools(pkg.tools, this.approvedTools);
    const { conversation, turn } = splitLimits(options.limits as Record<string, unknown> | null | undefined);
    checkHostLimits(turn);
    this.limits = effectiveLimits(pkg, conversation);
    this.turnLimits = turn;
    this.conversationId = options.conversationId ?? crypto.randomUUID();
    this.chain = new AuditChain(this.conversationId, { observer: options.observer ?? null, now: this.now });
    this.state = deepCopy(evaluate((conversationOf(pkg.graph)!.initial as JsonObject), {})) as JsonObject;
    this.startedAt = pyIsoTimestamp(this.now());
  }

  /** Host-side cancellation of the turn in flight; the conversation then ends with the person's reason. */
  cancel(): void {
    this.cancelRequested = true;
    this.current?.cancel();
  }

  // -- the loop -------------------------------------------------------------------------
  async run(transcript: TranscriptInput): Promise<ConversationReport> {
    const pkg = this.package;
    const turns = transcript.turns;
    this.chain.record("conversation.started", {
      package_id: String(pkg.manifest.package_id),
      package_version: String(pkg.manifest.version),
      package_digest: pkg.digest,
      limits: limitsJson(this.limits),
      grant_scopes: { ...this.grants },
      turns_supplied: turns.length,
      state_hash: digest(this.state),
    });
    for (const [offset, turnIn] of turns.entries()) {
      const index = offset + 1;
      this.chain.turn = index;
      const refusal = reserveTurn(pkg, this.limits, this.turnLimits, this.spent, this.turnsRun());
      if (refusal !== null) {
        this.refuseTurn(index, turnIn, refusal);
        this.ended = { reason: refusal === "conversation_turn_limit" ? "max_turns" : "budget", at: pyIsoTimestamp(this.now()), turns_not_run: turns.length - index + 1 };
        break;
      }
      const status = await this.turn(index, turnIn);
      if (status === "completed" && endsByPackage(pkg, this.turns[this.turns.length - 1]!.reply, this.state)) {
        this.ended = { reason: "package", at: pyIsoTimestamp(this.now()), turns_not_run: turns.length - index };
        break;
      }
    }
    if (this.ended === null) {
      // The input is exhausted: at the cap the conversation is over by the package's own bound;
      // else the person closed it (`end`) or the host simply sent nothing more.
      const reason: EndReason = this.turnsRun() >= this.limits.max_turns ? "max_turns" : transcript.end ? "person" : "host";
      this.ended = { reason, at: pyIsoTimestamp(this.now()), turns_not_run: 0 };
    }
    this.chain.record("conversation.ended", {
      reason: this.ended.reason,
      turns: this.turnsRun(),
      tokens: this.spent.tokens,
      remote_calls: this.spent.remote_calls,
      spent_permissions: [...this.spent.permissions].sort(),
      state_hash: digest(this.state),
    });
    return this.report();
  }

  private turnsRun(): number {
    return this.turns.filter((turn) => turn.status !== "refused").length;
  }

  private refuseTurn(index: number, turnIn: TranscriptTurnInput, reason: string): void {
    const now = pyIsoTimestamp(this.now());
    this.chain.record("turn.refused", { reason, message_hash: digest(turnIn.message), spent_tokens: this.spent.tokens, spent_remote_calls: this.spent.remote_calls, limits: limitsJson(this.limits) });
    const decisions = turnDecisions(turnIn);
    this.turns.push({
      turn: index,
      status: "refused",
      error_code: "budget_exhausted",
      refusal: reason,
      message: deepCopy(turnIn.message),
      consents: decisions,
      decisions: [],
      unused_consents: Object.keys(decisions).sort(),
      reply: null,
      usage: { tokens: 0, remote_calls: 0, tool_calls: {} },
      started_at: now,
      ended_at: now,
    });
  }

  /** The context one turn runs under; a host that runs the turn elsewhere builds the same (`turnContext`). */
  private async turn(index: number, turnIn: TranscriptTurnInput): Promise<TranscriptTurn["status"]> {
    const pkg = this.package;
    const message = turnIn.message;
    const decisions = turnDecisions(turnIn);
    const started = pyIsoTimestamp(this.now());
    this.chain.record("turn.started", { message_hash: digest(message), consents_supplied: Object.keys(decisions).sort(), state_hash: digest(this.state), spent_tokens: this.spent.tokens, spent_remote_calls: this.spent.remote_calls });
    const host = this.options.consent ? this.options.consent(index, decisions) : new TranscriptConsent(decisions);
    const context: TurnContext = { conversation_id: this.conversationId, turn: index, state: deepCopy(this.state), chain: this.chain, consent: host, spent: new Set(this.spent.permissions), tool_caps: remainingToolCaps(this.limits, this.spent.tool_calls) };
    const parts = this.options.adapters(index);
    // A refusal before the runtime exists (a compute preflight, a host limit) is the host's,
    // raised as the reference raises it; the conversation records nothing for the turn.
    const workflow = await Workflow.create(pkg, {
        grants: this.grants,
        handlers: parts.handlers ?? null,
        router: parts.router ?? null,
        limits: Object.keys(this.turnLimits).length > 0 ? this.turnLimits : null,
        approvedTools: this.approvedTools,
        observer: this.options.observer ?? null,
        memory: parts.memory === undefined ? undefined : parts.memory,
        compute: parts.compute ?? null,
        turn: context,
        ...(this.options.turnDeadlineAt ? { deadlineAt: this.options.turnDeadlineAt() } : {}),
    });
    this.current = workflow;
    if (this.cancelRequested) workflow.cancel();
    let report: ExecutionReport;
    let status: TranscriptTurn["status"];
    let errorCode: string | null = null;
    try {
      report = await workflow.run(message);
      status = "completed";
    } catch (error) {
      // A classified failure carries its report; anything else is the host's and is raised.
      const carried = (error as { execution_report?: ExecutionReport }).execution_report;
      if (carried === undefined) throw error;
      report = carried;
      status = error instanceof CancelledError ? "cancelled" : "failed";
      errorCode = failureCode(error);
    } finally {
      this.current = null;
    }
    const entry = this.charge(index, workflow.runtime.run_id, message, decisions, report, status, errorCode, workflow.runtime.spentPermissions, host.used ?? new Set(), started);
    this.turns.push(entry);
    this.options.onTurn?.(index, report, status);
    return status;
  }

  /**
   * After a turn: its actual usage charged, the `once` grants it consumed kept, the new persisted
   * state when it completed, the `turn.completed | turn.failed` event, and the transcript entry.
   */
  charge(index: number, runId: string, message: JsonValue, decisions: Record<string, boolean>, report: ExecutionReport, status: TranscriptTurn["status"], errorCode: string | null, spentPermissions: ReadonlySet<string>, used: ReadonlySet<string>, startedAt: string): TranscriptTurn {
    const usage = report.usage;
    const tokens = (usage.tokens as number | undefined) ?? 0;
    const remote = (usage.remote_calls as number | undefined) ?? 0;
    const toolCalls = (usage.tool_calls as Record<string, number> | undefined) ?? {};
    this.spent.tokens += tokens;
    this.spent.remote_calls += remote;
    for (const [toolId, count] of Object.entries(toolCalls)) this.spent.tool_calls[toolId] = (this.spent.tool_calls[toolId] ?? 0) + count;
    // The `once` grants the turn consumed are spent for the conversation (V-13): the runtime's
    // own set, which a host running the turn elsewhere reports with the settled run.
    this.spent.permissions = [...new Set([...this.spent.permissions, ...spentPermissions])].sort();
    if (status === "completed" && report.conversation_state !== undefined) this.state = deepCopy(report.conversation_state);
    const consents = report.consents ?? [];
    this.chain.record(status === "completed" ? "turn.completed" : "turn.failed", {
      turn_run_id: runId,
      status,
      error_code: errorCode,
      tokens,
      remote_calls: remote,
      spent_tokens: this.spent.tokens,
      spent_remote_calls: this.spent.remote_calls,
      state_hash: digest(this.state),
      consents_decided: consents.map((decision) => decision.step),
    });
    return {
      turn: index,
      run_id: runId,
      status,
      error_code: errorCode,
      refusal: null,
      message: deepCopy(message),
      consents: decisions,
      decisions: deepCopy(consents as unknown as JsonValue) as unknown as ConsentRecord[],
      unused_consents: Object.keys(decisions)
        .filter((step) => !used.has(step))
        .sort(),
      reply: status === "completed" ? deepCopy(report.output ?? null) : null,
      usage: { tokens, remote_calls: remote, tool_calls: { ...toolCalls } },
      started_at: startedAt,
      ended_at: pyIsoTimestamp(this.now()),
    };
  }

  // -- the record -----------------------------------------------------------------------
  transcript(): JsonObject {
    const pkg = this.package;
    return {
      schema: "conversation.transcript.v0",
      conversation_id: this.conversationId,
      package: { package_id: String(pkg.manifest.package_id), version: String(pkg.manifest.version), digest: pkg.digest },
      started_at: this.startedAt,
      turns: deepCopy(this.turns as unknown as JsonValue) as unknown as JsonValue[],
      state: deepCopy(this.state),
      budget: { limits: limitsJson(this.limits), spent: { turns: this.turnsRun(), tokens: this.spent.tokens, remote_calls: this.spent.remote_calls, tool_calls: { ...this.spent.tool_calls } } },
      spent_permissions: [...this.spent.permissions].sort(),
      ended: { ...this.ended! },
    };
  }

  report(): ConversationReport {
    return {
      status: conversationStatus(this.turns),
      profile: PROFILE,
      transcript: this.transcript(),
      state: deepCopy(this.state),
      audit: [...this.chain.events],
      usage: {
        turns: this.turnsRun(),
        tokens: this.spent.tokens,
        remote_calls: this.spent.remote_calls,
        tool_calls: { ...this.spent.tool_calls },
        limits: limitsJson(this.limits),
        per_turn: this.turns.map((turn) => ({ turn: turn.turn, status: turn.status, ...turn.usage }) as JsonObject),
      },
      provenance: { profile: PROFILE, interpreter: INTERPRETER, package_id: String(this.package.manifest.package_id), package_digest: this.package.digest, conversation_id: this.conversationId, persistent_keys: persistentKeys(this.package) },
      ended: { ...this.ended! },
    };
  }
}

/** The conversation fixture a package declares (V-27), as the input transcript. */
export function fixtureTranscript(pkg: Package): TranscriptInput | null {
  const conversation = conversationOf(pkg.graph);
  const path = conversation?.fixture;
  if (path === undefined || path === null) return null;
  return packageJson(pkg, String(path)) as unknown as TranscriptInput;
}

/** A host-side refusal that stands for the reference's `AgentPkgError` on the CLI. */
export function refusal(code: string, message: string): AgentPkgError {
  return new ConversationError(code, message);
}

/** The chain tail a host persists between turns. */
export function chainTail(chain: AuditChain): ChainTail {
  return chain.tail();
}
