/**
 * The chat surface (T24, conversation.v0, D-270): a person talks to a conversational package in
 * the side panel or the full page. Messages go out as the package's input-schema instance (V-22);
 * each reply is a turn's output; a consent card pauses the turn until the person decides (V-29);
 * every decision keeps its provenance line (who decided: the person, the plan, a preset, a policy);
 * the budget is shown as it is spent; End closes the conversation between turns, Stop cancels the
 * turn in flight. Everything is read from the worker's `conversation.*` views and never inferred;
 * a closed panel reconnects by reading the stored conversation again (the card is in the record).
 * This surface adds no authority: the plan, the grants and the pre-decisions were frozen before.
 */
import type { JsonObject, JsonValue } from "../../core/json.js";
import type { TranscriptTurn } from "../../core/conversation/runner.js";
import type { PresentationHints } from "../../core/presentation.js";
import type { ConsentStepPlan } from "../../core/types.js";
import type { ConversationExportBundle, ConversationListView, ConversationSummary, ConversationView, Request, RunReadiness, RunView } from "../messages.js";
import { button, bytes, chip, clear, definition, el, whenText } from "./dom.js";
import { buildFormModel, hintsFrom, humanize, TaskForm, type FormFile } from "./form.js";
import { formatElapsed, graphNodes, mimeFor, nodeState, presentationOf, RUN_ERRORS, saveBlob, stagesFor, type RunPanelLoaded } from "./run.js";
import { writeZip } from "./zip.js";

export interface ConversationPanelHost {
  send: <T>(request: Request) => Promise<T>;
  /** The open session and its authorization view, or null when no session is shown. */
  loaded: () => RunPanelLoaded | null;
  compact?: boolean;
  /** Send the person to the control that fixes a blocker. */
  reveal?: (section: "trust" | "authorization" | "model" | "plan") => void;
  /** Something changed that other cards should re-read (a conversation started or ended). */
  changed?: () => void;
  /** The panel now shows another conversation, or none. */
  conversationChanged?: (conversationId: string | null) => void;
  /** Open one turn's run record (the Run page). */
  openRun?: (runId: string) => void;
  openFiles?: () => void;
  unlock?: (retry: () => void) => void;
  requestOrigins?: (origins: string[]) => Promise<boolean>;
}

/** A fallback poll while a turn is in flight, should an `event.conversation` be missed. */
const POLL_MS = 4000;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

type ErrorBox = { code: string; message: string };

function describe(error: unknown): ErrorBox {
  const value = error as { code?: unknown; message?: unknown };
  return { code: typeof value?.code === "string" ? value.code : "error", message: typeof value?.message === "string" ? value.message : "The extension's background service did not answer." };
}

/** The sentence a person reads in a message or a reply: the longest top-level string, else the JSON. */
export function spokenText(value: JsonValue | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const preferred = ["reply", "text", "answer", "message"].find((key) => typeof (value as JsonObject)[key] === "string" && ((value as JsonObject)[key] as string).trim());
    if (preferred) return (value as JsonObject)[preferred] as string;
    let best: string | null = null;
    for (const item of Object.values(value)) if (typeof item === "string" && item.trim() && (best === null || item.length > best.length)) best = item;
    if (best !== null) return best;
  }
  return value === null || value === undefined ? "" : JSON.stringify(value, null, 2);
}

/** One decision's provenance line (D-270): who decided, and why a card was not shown when it was not. */
export function decisionWords(decision: TranscriptTurn["decisions"][number], preset: string | null): string {
  const verdict = decision.accepted ? "accepted" : "declined";
  switch (decision.decided_by) {
    case "person":
      return `You ${verdict} · decided by you at ${whenText(decision.decided_at)}`;
    case "plan":
      return decision.reason === "permission_consumed" ? `Not asked: ${decision.permissions.join(", ")} was already used once in this conversation · decided by the plan` : `Not asked: the plan denies ${decision.permissions.join(", ")} · decided by the plan`;
    case "preset":
      return `${decision.accepted ? "Accepted" : "Declined"} by your ${preset ? humanize(preset) : ""} preset (no card shown) · decided by preset`;
    case "policy":
      return `${decision.accepted ? "Accepted" : "Declined"} by your organisation's policy${decision.reason === "policy_forbids" ? " (this step is forbidden)" : ""} · decided by policy`;
    case "host":
      return "Not decided: nobody could answer · decided by the host";
    case "transcript":
      return `${decision.accepted ? "Accepted" : "Declined"} from a transcript · decided by transcript`;
    default:
      return `${verdict} · decided by ${decision.decided_by}`;
  }
}

/** The card's heading from the kinds the step decides (D-270). */
export function cardTitle(name: string, kinds: readonly string[]): string {
  if (kinds.includes("payment")) return `Before ${name} pays`;
  if (kinds.includes("personal.read")) return `Before ${name} uses your record`;
  if (kinds.includes("files.write")) return `Before ${name} writes a file`;
  return `Before ${name} continues`;
}

export class ConversationPanel {
  readonly root: HTMLElement;
  private readonly headEl = el("div", { className: "ab-chat-head" });
  private readonly transcriptEl = el("div", { className: "ab-chat-transcript", attrs: { "aria-live": "polite" } });
  private readonly cardEl = el("div", { className: "ab-chat-card" });
  private readonly composerEl = el("div", { className: "ab-chat-composer" });
  private readonly footerEl = el("div", { className: "ab-chat-footer" });
  private readonly historyEl = el("div", { className: "ab-chat-history" });

  private sessionId: string | null = null;
  private conversation: ConversationView | null = null;
  private history: ConversationSummary[] = [];
  private readiness: RunReadiness | null = null;
  private form: TaskForm | null = null;
  private formKey = "";
  private messageValue: unknown = undefined;
  private localErrors: ReadonlyMap<string, string> = new Map();
  private busy: string | null = null;
  private error: ErrorBox | null = null;
  private downloadNote: string | null = null;
  private files: FormFile[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private adoptedFor: string | null = null;
  private openSequence = 0;
  /** The person named the conversation shown (the Runs page): the session's open one does not replace it. */
  private named = false;

  constructor(private readonly host: ConversationPanelHost) {
    this.root = el("section", { className: `ab-card ab-chat${host.compact ? " ab-chat-compact" : ""}`, attrs: { "aria-label": "Conversation" } }, this.headEl, this.transcriptEl, this.cardEl, this.composerEl, this.footerEl, this.historyEl);
    this.root.dataset.state = "idle";
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pollTimer = this.tickTimer = null;
  }

  // -- lifecycle -------------------------------------------------------------------------
  async attachSession(sessionId: string): Promise<void> {
    if (this.sessionId !== sessionId) {
      this.reset(sessionId);
      this.conversation = null;
      this.adoptedFor = null;
      this.named = false;
    }
    this.render();
    void this.loadFiles();
    await this.loadHistory(true);
    if (this.disposed || this.sessionId !== sessionId) return;
    this.render();
    void this.refreshReadiness();
  }

  private reset(sessionId: string | null): void {
    this.stopTimers();
    this.sessionId = sessionId;
    this.history = [];
    this.readiness = null;
    this.form = null;
    this.formKey = "";
    this.messageValue = undefined;
    this.error = null;
    this.downloadNote = null;
  }

  detach(): void {
    this.reset(null);
    this.conversation = null;
    this.named = false;
    this.render();
    this.host.conversationChanged?.(null);
  }

  hasSession(): boolean {
    return this.sessionId !== null;
  }

  current(): ConversationView | null {
    return this.conversation;
  }

  /** Show one conversation by id, with or without its session (the Runs page). */
  async openConversation(conversationId: string, options: { named?: boolean } = {}): Promise<ErrorBox | null> {
    const sequence = (this.openSequence += 1);
    let view: ConversationView | null = null;
    try {
      view = await this.host.send<ConversationView | null>({ type: "conversation.get", conversationId });
    } catch (error) {
      if (sequence !== this.openSequence) return null;
      this.error = describe(error);
      this.render();
      return this.error;
    }
    if (this.disposed || sequence !== this.openSequence) return null;
    if (!view) {
      this.error = { code: "conversation_unknown", message: "This browser holds no conversation with that id." };
      this.render();
      return this.error;
    }
    if (view.sessionId !== this.sessionId) this.reset(null);
    this.named = options.named !== false;
    this.error = null;
    this.show(view);
    return null;
  }

  sync(): void {
    this.render();
    void this.refreshReadiness();
  }

  onConversationEvent(event: { conversationId: string; sessionId: string; status: string }): void {
    if (this.conversation && this.conversation.conversationId === event.conversationId) {
      if (event.status === "cleared") {
        this.conversation = null;
        this.render();
        return;
      }
      void this.poll();
      return;
    }
    if (this.sessionId && event.sessionId === this.sessionId) void this.loadHistory(false);
  }

  onRunEvent(event: { runId: string; sessionId: string; status: string }): void {
    if (this.conversation && this.conversation.activeRunId === event.runId) void this.poll();
  }

  onFilesEvent(): void {
    void this.loadFiles();
  }

  private async loadFiles(): Promise<void> {
    try {
      const files = (await this.host.send<{ files: FormFile[] }>({ type: "files.list" })).files;
      if (this.disposed) return;
      const changed = JSON.stringify(files.map((file) => file.file_id)) !== JSON.stringify(this.files.map((file) => file.file_id));
      this.files = files;
      if (changed) this.form?.refresh();
    } catch {
      // The picker stays as it was.
    }
  }

  private async loadHistory(adopt: boolean): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    let result: ConversationListView | null = null;
    try {
      result = await this.host.send<ConversationListView>({ type: "conversation.list", sessionId });
    } catch {
      result = null;
    }
    if (this.disposed || sessionId !== this.sessionId || !result) return;
    this.history = result.conversations;
    const open = result.conversations.find((item) => item.status === "open") ?? null;
    if (adopt && !this.conversation && this.adoptedFor !== sessionId) {
      this.adoptedFor = sessionId;
      const chosen = open ?? this.history[0] ?? null;
      if (chosen) await this.openConversation(chosen.conversationId, { named: false });
    } else if (open && open.conversationId !== this.conversation?.conversationId && (!this.conversation || (this.conversation.status === "ended" && !this.named))) {
      await this.openConversation(open.conversationId, { named: false });
    }
    this.renderHistory();
  }

  private async refreshReadiness(): Promise<void> {
    const sessionId = this.sessionId;
    const plan = this.host.loaded()?.authorization?.run_plan?.run_plan ?? null;
    if (!sessionId || !plan) {
      this.readiness = null;
      this.renderComposer();
      return;
    }
    let readiness: RunReadiness | null = null;
    try {
      readiness = await this.host.send<RunReadiness>({ type: "run.readiness", sessionId });
    } catch (error) {
      const described = describe(error);
      readiness = { session_id: sessionId, checked_at: new Date().toISOString(), ready: false, run_plan_id: null, run_plan_sha256: null, blocker: { code: described.code, message: described.message, subject: null }, checks: [], receipt: null, active_run_id: null, preflight: null, missing_origins: [] };
    }
    if (this.disposed || sessionId !== this.sessionId) return;
    this.readiness = readiness;
    this.renderComposer();
  }

  private show(view: ConversationView): void {
    const changed = this.conversation?.conversationId !== view.conversationId;
    this.conversation = view;
    if (changed) this.downloadNote = null;
    this.render();
    if (view.activeRunId !== null) this.startPolling();
    else this.stopPolling();
    if (changed) this.host.conversationChanged?.(view.conversationId);
  }

  private startPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), 1000);
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pollTimer = this.tickTimer = null;
  }

  private tick(): void {
    for (const node of this.root.querySelectorAll<HTMLElement>("[data-since]")) {
      const since = Date.parse(node.dataset.since ?? "");
      if (Number.isFinite(since)) node.textContent = formatElapsed(Date.now() - since);
    }
    for (const node of this.root.querySelectorAll<HTMLElement>("[data-deadline]")) {
      const deadline = Date.parse(node.dataset.deadline ?? "");
      if (Number.isFinite(deadline)) node.textContent = `${formatElapsed(Math.max(0, deadline - Date.now()))} left to decide`;
    }
  }

  private async poll(): Promise<void> {
    const current = this.conversation;
    if (!current || this.disposed) return;
    let view: ConversationView | null = null;
    try {
      view = await this.host.send<ConversationView | null>({ type: "conversation.get", conversationId: current.conversationId });
    } catch {
      view = null;
    }
    if (this.disposed || this.conversation?.conversationId !== current.conversationId) return;
    if (view) {
      const settled = current.activeRunId !== null && view.activeRunId === null;
      this.conversation = view;
      this.render();
      if (settled) {
        void this.loadHistory(false);
        void this.refreshReadiness();
        this.host.changed?.();
      }
    }
    if (this.conversation?.activeRunId !== null) this.startPolling();
    else this.stopPolling();
  }

  // -- actions ---------------------------------------------------------------------------
  private async start(): Promise<void> {
    const loaded = this.host.loaded();
    const plan = loaded?.authorization?.run_plan?.run_plan ?? null;
    const sessionId = this.sessionId;
    if (!loaded || !plan || !sessionId) return;
    this.busy = "Starting the conversation…";
    this.error = null;
    this.renderComposer();
    try {
      const view = await this.host.send<ConversationView>({ type: "conversation.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256 });
      this.openSequence += 1;
      this.named = false;
      this.show(view);
      void this.loadHistory(false);
      this.host.changed?.();
    } catch (error) {
      this.error = describe(error);
    }
    this.busy = null;
    if (!this.disposed) this.render();
  }

  private async sendMessage(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation || this.messageValue === undefined || this.localErrors.size > 0) return;
    this.busy = "Sending…";
    this.error = null;
    this.renderComposer();
    try {
      const view = await this.host.send<ConversationView>({ type: "conversation.send", conversationId: conversation.conversationId, message: structuredClone(this.messageValue) });
      this.form = null;
      this.formKey = "";
      this.messageValue = undefined;
      this.show(view);
    } catch (error) {
      this.error = describe(error);
    }
    this.busy = null;
    if (!this.disposed) this.render();
  }

  private async decide(step: string, accepted: boolean): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    this.busy = accepted ? "Accepting…" : "Declining…";
    this.renderCard();
    try {
      const view = await this.host.send<ConversationView>({ type: "conversation.decide", conversationId: conversation.conversationId, step, accepted });
      this.show(view);
    } catch (error) {
      this.error = describe(error);
    }
    this.busy = null;
    if (!this.disposed) this.render();
  }

  private async end(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    this.busy = conversation.activeRunId !== null ? "Stopping the turn…" : "Ending…";
    this.renderFooter();
    try {
      const view = await this.host.send<ConversationView>({ type: conversation.activeRunId !== null ? "conversation.cancelTurn" : "conversation.end", conversationId: conversation.conversationId });
      this.show(view);
      void this.loadHistory(false);
      void this.refreshReadiness();
      this.host.changed?.();
    } catch (error) {
      this.error = describe(error);
    }
    this.busy = null;
    if (!this.disposed) this.render();
  }

  private newConversation(): void {
    this.conversation = null;
    this.named = false;
    this.error = null;
    this.render();
    void this.refreshReadiness();
    this.host.conversationChanged?.(null);
  }

  /** One zip of the conversation's files (D-272): the conversation's own, then each turn's under `turn-NNN/`. */
  private async download(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    const name = `conversation_${conversation.conversationId.replace(/-/gu, "")}.zip`;
    this.downloadNote = `Preparing ${name}…`;
    this.renderFooter();
    try {
      const bundle = await this.host.send<ConversationExportBundle>({ type: "conversation.export", conversationId: conversation.conversationId });
      const entries: Array<{ name: string; bytes: Uint8Array }> = [];
      let total = 0;
      for (const entry of bundle.entries) {
        const data = base64Bytes(entry.base64);
        total += data.length;
        if (total > MAX_ARCHIVE_BYTES) throw new Error(`The conversation's files exceed ${bytes(MAX_ARCHIVE_BYTES)}.`);
        entries.push({ name: entry.name, bytes: data });
      }
      const zip = new Blob([writeZip(entries) as BlobPart], { type: mimeFor(name) });
      const hash = await saveBlob(name, zip);
      this.downloadNote = `Saved ${name} (${entries.length} files, ${bytes(zip.size)}${hash ? `; zip sha256:${hash.slice(0, 16)}…` : ""}).`;
    } catch (error) {
      this.downloadNote = `Download failed: ${(error as Error).message}`;
    }
    if (!this.disposed) this.renderFooter();
  }

  // -- rendering -------------------------------------------------------------------------
  render(): void {
    const conversation = this.conversation;
    this.root.dataset.state = conversation === null ? "idle" : conversation.status === "ended" ? "ended" : conversation.activeRunId !== null ? (conversation.pendingConsent ? "waiting" : "running") : "open";
    if (conversation) this.root.dataset.conversationId = conversation.conversationId;
    else delete this.root.dataset.conversationId;
    this.renderHead();
    this.renderTranscript();
    this.renderCard();
    this.renderComposer();
    this.renderFooter();
    this.renderHistory();
  }

  private agentName(): string {
    return this.host.loaded()?.session.page.identity.name ?? this.conversation?.package.name ?? "the agent";
  }

  private presentation(): PresentationHints | null {
    return presentationOf(this.host.loaded()?.session ?? null);
  }

  private renderHead(): void {
    clear(this.headEl);
    const loaded = this.host.loaded();
    const conversation = this.conversation;
    const name = loaded?.session.page.identity.name ?? conversation?.package.name ?? "Conversation";
    const version = loaded?.session.page.identity.version ?? conversation?.package.version ?? "";
    const status = conversation === null ? null : conversation.status === "ended" ? (conversation.outcome === "completed" ? chip("Ended", "good") : chip("Ended (a turn did not complete)", "warn")) : conversation.activeRunId !== null ? chip(conversation.pendingConsent ? "Waiting for you" : "Working", "neutral") : chip("Open", "good");
    this.headEl.append(el("div", { className: "ab-run-title" }, el("h2", { className: "ab-card-title", text: `Conversation · ${name}${version ? ` ${version}` : ""}` }), status));
    if (conversation) {
      const limits = conversation.limits;
      const spent = conversation.spent;
      const facts = [`Turn ${Math.max(spent.turns, conversation.activeRunId !== null ? spent.turns + 1 : 0)} of ${limits.max_turns}`, `${spent.tokens.toLocaleString()} of ${limits.hard_tokens.toLocaleString()} tokens`, `${spent.remote_calls} of ${limits.max_remote_calls} remote calls`];
      this.headEl.append(el("p", { className: "ab-chat-budget ab-muted", text: facts.join(" · ") }));
      const asks = conversation.consentSteps.filter((step) => step.pre_decided === null).map((step) => this.stepWords(step));
      const answered = conversation.consentSteps.filter((step) => step.pre_decided !== null).map((step) => `${this.stepWords(step)} (${step.pre_decided!.decided_by === "preset" ? "your preset answers" : "your policy forbids"})`);
      const reads = conversation.resources.map((grant) => grant.resourceType.replace(/^[a-z]+\./u, "").replace(/_/gu, " "));
      const lines = [reads.length > 0 ? `Reads: ${reads.join(", ")}` : null, asks.length > 0 ? `Asks you before: ${asks.join(", ")}` : null, answered.length > 0 ? `Decided for you: ${answered.join(", ")}` : null].filter((line): line is string => line !== null);
      if (lines.length > 0) this.headEl.append(el("p", { className: "ab-hint", text: lines.join(" · ") }));
      if (!conversation.sessionOpen) this.headEl.append(el("p", { className: "ab-hint", text: "This conversation's package session is no longer open. Its transcript remains available here." }));
    }
  }

  private stepWords(step: ConsentStepPlan): string {
    const labels = this.presentation()?.nodes ?? {};
    return labels[step.id] ?? humanize(step.id);
  }

  private renderTranscript(): void {
    clear(this.transcriptEl);
    const conversation = this.conversation;
    if (!conversation) return;
    const name = this.agentName();
    const preset = this.host.loaded()?.authorization?.preset ?? null;
    for (const turn of conversation.transcript) this.transcriptEl.append(...this.renderTurn(turn, name, preset));
    const active = conversation.activeRun;
    if (active) {
      const message = active.taskText ?? "";
      if (conversation.transcript.every((turn) => turn.turn !== active.conversation?.turn)) {
        this.transcriptEl.append(el("div", { className: "ab-chat-bubble ab-chat-you", attrs: { "data-turn": String(active.conversation?.turn ?? "") } }, el("div", { className: "ab-chat-meta" }, el("strong", { text: "You" }), el("span", { className: "ab-muted", text: ` · ${whenText(active.createdAt)}` })), el("p", { className: "ab-chat-text", text: message })));
      }
      this.transcriptEl.append(this.renderWorking(active));
    }
  }

  private renderTurn(turn: TranscriptTurn, name: string, preset: string | null): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    nodes.push(el("div", { className: "ab-chat-bubble ab-chat-you", attrs: { "data-turn": String(turn.turn) } }, el("div", { className: "ab-chat-meta" }, el("strong", { text: "You" }), el("span", { className: "ab-muted", text: ` · ${whenText(turn.started_at)}` })), el("p", { className: "ab-chat-text", text: spokenText(turn.message) })));
    for (const decision of turn.decisions) {
      nodes.push(
        el(
          "div",
          { className: `ab-chat-decision ab-chat-decision-${decision.accepted ? "yes" : "no"}`, attrs: { "data-step": decision.step } },
          el("span", { className: "ab-check-icon", text: decision.accepted ? "✓" : "✗" }),
          el("span", {}, decision.decided_by === "person" ? el("span", { text: `“${decision.text}” — ` }) : null, el("span", { text: decisionWords(decision, preset) })),
        ),
      );
    }
    const meta = el("div", { className: "ab-chat-meta" }, el("strong", { text: name }), el("span", { className: "ab-muted", text: ` · turn ${turn.turn} · ${turn.status === "refused" ? "refused" : turn.status}${turn.usage.tokens > 0 ? ` · ${turn.usage.tokens.toLocaleString()} tokens` : ""}` }));
    if (turn.run_id && this.host.openRun) {
      const runId = turn.run_id;
      const details = button("Details", () => this.host.openRun?.(runId));
      details.classList.add("ab-button-small");
      meta.append(details);
    }
    const bubble = el("div", { className: `ab-chat-bubble ab-chat-agent ab-chat-${turn.status}`, attrs: { "data-turn": String(turn.turn) } }, meta);
    if (turn.status === "completed") {
      bubble.append(el("p", { className: "ab-chat-text", text: spokenText(turn.reply) }));
      const reply = turn.reply;
      if (reply && typeof reply === "object") {
        const details = el("details", { className: "ab-details ab-chat-reply" });
        details.append(el("summary", { text: "The reply as data" }), el("pre", { className: "ab-pre", text: JSON.stringify(reply, null, 2) }));
        bubble.append(details);
      }
    } else if (turn.status === "refused") {
      bubble.append(el("div", { className: "ab-banner ab-banner-warn" }, el("strong", { text: turn.refusal === "conversation_turn_limit" ? "No more turns: the conversation reached its turn limit" : "The conversation's budget would not cover this turn" }), el("p", { className: "ab-muted", text: "The turn was refused before anything ran (V-10)." })));
    } else {
      const words = RUN_ERRORS[turn.error_code ?? ""] ?? null;
      bubble.append(el("div", { className: `ab-banner ${turn.status === "cancelled" ? "ab-banner-warn" : "ab-banner-bad"}` }, el("strong", { text: turn.status === "cancelled" ? "Turn stopped" : (words?.title ?? "The turn did not complete") }), turn.error_code ? el("span", { className: "ab-error-code", text: ` ${turn.error_code}` }) : null, el("p", { className: "ab-muted", text: words?.detail ?? "Nothing from this turn was kept; the conversation goes on from the last completed turn." })));
    }
    nodes.push(bubble);
    return nodes;
  }

  private renderWorking(active: RunView): HTMLElement {
    const presentation = this.presentation();
    const session = this.host.loaded()?.session ?? null;
    const stages = stagesFor(graphNodes(session), presentation);
    const progress = active.progress ?? null;
    const current = stages.find((stage) => stage.nodes.some((id) => nodeState(progress, id) === "active"))?.label ?? null;
    const since = active.startedAt ?? active.createdAt;
    const elapsed = el("span", { className: "ab-elapsed", text: formatElapsed(Date.now() - Date.parse(since)), attrs: { "data-since": since } });
    const label = active.status === "preparing" ? "Preparing the turn…" : active.cancelRequested ? "Stopping…" : this.conversation?.pendingConsent ? "Waiting for your decision" : (presentation?.task.running_label ?? "Working…");
    return el("div", { className: "ab-chat-bubble ab-chat-agent ab-chat-working", attrs: { "data-run": active.runId } }, el("div", { className: "ab-chat-meta" }, el("strong", { text: this.agentName() }), el("span", { className: "ab-muted", text: ` · ${label}${current ? ` · ${current}` : ""} · ` }), elapsed));
  }

  private renderCard(): void {
    clear(this.cardEl);
    const conversation = this.conversation;
    const pending = conversation?.pendingConsent ?? null;
    if (!conversation || !pending) return;
    const name = this.agentName();
    const deadline = new Date(Date.parse(pending.requested_at) + pending.timeout_seconds * 1000).toISOString();
    // A fact is shown as the package built it: a scalar as is, a flat object as its fields in words
    // ("Given name Alex, Family name Traveler"), anything deeper as JSON.
    const words = (value: JsonValue): string =>
      typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => item === null || typeof item !== "object") ? Object.entries(value).map(([key, item]) => `${humanize(key)} ${item === null ? "—" : String(item)}`).join(", ") : JSON.stringify(value);
    const facts = pending.facts && typeof pending.facts === "object" && !Array.isArray(pending.facts) ? Object.entries(pending.facts as JsonObject).map(([key, value]): [string, string] => [humanize(key), words(value)]) : [];
    const step = conversation.consentSteps.find((item) => item.id === pending.step) ?? null;
    const grants = pending.permissions.map((id) => `${id}${conversation.grants[id] === "once" ? " (granted once)" : ""}`).join(", ");
    const card = el(
      "div",
      { className: "ab-consent-card", attrs: { role: "group", "aria-label": cardTitle(name, pending.kinds), "data-step": pending.step } },
      el("h3", { className: "ab-consent-title", text: cardTitle(name, pending.kinds) }),
      el("p", { className: "ab-consent-text", text: pending.text }),
      facts.length > 0 ? definition(facts) : el("pre", { className: "ab-pre", text: JSON.stringify(pending.facts, null, 2) }),
      el("p", { className: "ab-hint", text: `Uses ${grants} · asked by the package's step ${step ? this.stepWords(step) : pending.step}` }),
      el("p", { className: "ab-hint ab-consent-countdown", text: `${formatElapsed(Math.max(0, Date.parse(deadline) - Date.now()))} left to decide`, attrs: { "data-deadline": deadline } }),
      el(
        "div",
        { className: "ab-inline" },
        button(this.busy === "Accepting…" ? "Accepting…" : pending.kinds.includes("payment") ? "Yes, go ahead and pay" : "Yes", () => void this.decide(pending.step, true), { variant: "primary", disabled: this.busy !== null }),
        button(this.busy === "Declining…" ? "Declining…" : "No", () => void this.decide(pending.step, false), { variant: "danger", disabled: this.busy !== null }),
      ),
    );
    card.querySelector("button")?.setAttribute("data-decide", "accept");
    card.querySelectorAll("button")[1]?.setAttribute("data-decide", "decline");
    this.cardEl.append(card);
  }

  /** Whether the composer shows (a conversation open between turns, or none yet with a plan). */
  private renderComposer(): void {
    clear(this.composerEl);
    const loaded = this.host.loaded();
    const conversation = this.conversation;
    if (this.error) this.composerEl.append(el("div", { className: "ab-banner ab-banner-bad", attrs: { role: "alert" } }, el("strong", { text: this.error.code }), " ", el("span", { text: this.error.message })));
    if (conversation === null) {
      this.form = null;
      this.formKey = "";
      if (!loaded || !this.sessionId) return;
      const plan = loaded.authorization?.run_plan?.run_plan ?? null;
      const readiness = this.readiness;
      const reason = !plan ? "Authorize this agent to start a conversation." : !readiness ? "Checking that the plan is current…" : readiness.ready ? null : (readiness.blocker?.message ?? "The plan is not ready.");
      const start = button(this.busy ?? "Start a conversation", () => void this.start(), { variant: "primary", disabled: reason !== null || this.busy !== null, title: reason ?? "Open a conversation under this plan" });
      start.classList.add("ab-run-button");
      start.dataset.conversation = "start";
      this.composerEl.append(start);
      if (reason) this.composerEl.append(el("p", { className: "ab-run-reason", text: reason, attrs: { role: "status" } }));
      else this.composerEl.append(el("p", { className: "ab-hint", text: `Each message runs one bounded turn of the signed package on the model this plan bound. The package may keep ${(loaded.session.summary.workflow.conversation as { persistent_keys?: string[] } | null)?.persistent_keys?.join(", ") || "nothing"} between turns, and asks you before a consequential step.` }));
      if (readiness?.blocker?.code === "store_locked" && this.host.unlock) this.composerEl.append(button("Unlock", () => this.host.unlock?.(() => void this.refreshReadiness())));
      if (readiness?.blocker?.code === "origins_not_granted" && this.host.requestOrigins) this.composerEl.append(button("Allow", () => void this.host.requestOrigins?.(readiness.missing_origins).then(() => this.refreshReadiness())));
      return;
    }
    if (conversation.status === "ended" || conversation.activeRunId !== null || !conversation.sessionOpen || !loaded) {
      this.form = null;
      this.formKey = "";
      return;
    }
    const input = loaded.session.summary.workflow.input ?? null;
    const presentation = this.presentation();
    const key = `${conversation.conversationId}:${input?.schema_sha256 ?? "none"}`;
    if (!this.form || this.formKey !== key) {
      const model = buildFormModel(input?.document ?? null, hintsFrom(presentation));
      this.form = new TaskForm(model, null, { canWrite: true, files: () => this.files, openFiles: this.host.openFiles }, (value, errors) => {
        this.messageValue = value;
        this.localErrors = new Map(errors);
        this.renderSend();
      });
      this.formKey = key;
      this.messageValue = this.form.current();
      this.localErrors = new Map(this.form.errors());
    }
    this.composerEl.append(el("h3", { className: "ab-run-prompt", text: presentation?.task.prompt ?? "Your message" }), this.form.root, this.sendRow());
  }

  private sendRow(): HTMLElement {
    const row = el("div", { className: "ab-inline ab-chat-send" });
    this.fillSend(row);
    return row;
  }

  private renderSend(): void {
    const row = this.composerEl.querySelector<HTMLElement>(".ab-chat-send");
    if (row) {
      clear(row);
      this.fillSend(row);
    }
  }

  private fillSend(row: HTMLElement): void {
    const error = [...this.localErrors.values()][0] ?? null;
    const send = button(this.busy === "Sending…" ? "Sending…" : "Send", () => void this.sendMessage(), { variant: "primary", disabled: error !== null || this.busy !== null, title: error ?? "Send this message as one turn" });
    send.dataset.conversation = "send";
    row.append(send);
    if (error) row.append(el("span", { className: "ab-run-reason", text: error }));
  }

  private renderFooter(): void {
    clear(this.footerEl);
    const conversation = this.conversation;
    if (!conversation) return;
    const using = conversation.resources.map((grant) => chip(`Using: ${grant.resourceType.replace(/^[a-z]+\./u, "").replace(/_/gu, " ")} (${grant.resourceId.slice(0, 12)}…)`, "neutral"));
    const row = el("div", { className: "ab-inline ab-chat-actions" }, ...using);
    if (conversation.status === "open") {
      if (conversation.sessionOpen) {
        const label = conversation.activeRunId !== null ? "Stop this turn" : "End conversation";
        const end = button(this.busy === "Stopping the turn…" || this.busy === "Ending…" ? this.busy : label, () => void this.end(), { variant: "danger", disabled: this.busy !== null });
        end.dataset.conversation = conversation.activeRunId !== null ? "stop" : "end";
        row.append(end);
      }
    } else {
      row.append(el("span", { className: "ab-muted", text: `Ended: ${this.endWords(conversation)}` }));
      if (this.host.loaded() && this.sessionId === conversation.sessionId) row.append(button("New conversation", () => this.newConversation(), { variant: "primary" }));
    }
    row.append(button("Download", () => void this.download()));
    this.footerEl.append(row);
    if (this.downloadNote) this.footerEl.append(el("p", { className: "ab-hint", text: this.downloadNote, attrs: { role: "status" } }));
    const technical = el("details", { className: "ab-details ab-technical ab-chat-technical" });
    technical.append(
      el("summary", { text: "Technical details" }),
      definition([
        ["Conversation", el("code", { text: conversation.conversationId })],
        ["Run plan", el("code", { text: conversation.runPlanId })],
        ["Kept between turns", conversation.persistentKeys.map((key) => `${key}: ${summarize((conversation.state as JsonObject)[key])}`).join(" · ") || "nothing"],
        ["Consent steps", conversation.consentSteps.map((step) => `${step.id} (${step.permissions.join(", ")}${step.pre_decided ? `; decided by ${step.pre_decided.decided_by}` : ""})`).join(" · ") || "none"],
        ["Spent", `${conversation.spent.turns} turns · ${conversation.spent.tokens.toLocaleString()} tokens · ${conversation.spent.remote_calls} remote calls${conversation.spent.permissions.length > 0 ? ` · used once: ${conversation.spent.permissions.join(", ")}` : ""}`],
        ["Permissions", Object.entries(conversation.grants).map(([id, decision]) => `${id}=${decision}`).join(" · ")],
        ["Started", whenText(conversation.startedAt)],
        ["Ended", conversation.ended ? `${whenText(conversation.ended.at)} (${conversation.ended.reason})` : "—"],
      ]),
    );
    this.footerEl.append(technical);
  }

  private endWords(conversation: ConversationView): string {
    switch (conversation.ended?.reason) {
      case "person":
        return "you ended it";
      case "package":
        return `${this.agentName()} considered it done`;
      case "max_turns":
        return "the turn limit was reached";
      case "budget":
        return "the budget would not cover another turn";
      case "host":
        return "this browser ended it";
      default:
        return "ended";
    }
  }

  private renderHistory(): void {
    clear(this.historyEl);
    const others = this.history.filter((item) => item.conversationId !== this.conversation?.conversationId);
    if (others.length === 0) return;
    const details = el("details", { className: "ab-details" });
    details.append(el("summary", { text: `Earlier conversations with this agent (${others.length})` }));
    details.append(renderConversationList(others.slice(0, 16), { open: (id) => void this.openConversation(id) }));
    this.historyEl.append(details);
  }
}

function summarize(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "nothing";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
  return String(value).slice(0, 60);
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** A compact list of conversations with an Open action each, and optional Export and Clear. */
export function renderConversationList(conversations: readonly ConversationSummary[], actions: { open: (conversationId: string) => void; export?: (conversationId: string) => void; clear?: (conversationId: string) => void }): HTMLElement {
  const listNode = el("ul", { className: "ab-plain-list ab-run-list ab-conversation-list" });
  for (const item of conversations) {
    const meta = [whenText(item.createdAt), `${item.turns} turn${item.turns === 1 ? "" : "s"}`, item.endedReason ? `ended: ${item.endedReason}` : null, item.selectedModel].filter((part): part is string => Boolean(part)).join(" · ");
    const row = el("li", { className: "ab-run-row", attrs: { "data-conversation": item.conversationId } });
    row.append(
      el(
        "div",
        { className: "ab-run-row-main" },
        chip(item.status === "open" ? (item.activeRunId ? "Working" : "Open") : "Ended", item.status === "open" ? "neutral" : "good"),
        el("strong", { text: `${item.package.name || item.package.packageId} ${item.package.version}` }),
        el("span", { className: "ab-muted", text: meta }),
        button("Open", () => actions.open(item.conversationId)),
        actions.export ? button("Export", () => actions.export!(item.conversationId)) : null,
        actions.clear && item.status === "ended" ? button("Clear", () => actions.clear!(item.conversationId), { variant: "danger" }) : null,
      ),
    );
    if (item.title) row.append(el("div", { className: "ab-run-row-task ab-muted", text: `“${item.title.slice(0, 140)}${item.title.length > 140 ? "…" : ""}”` }));
    listNode.append(row);
  }
  return listNode;
}

export { TERMINAL as TERMINAL_RUN_STATUSES };
