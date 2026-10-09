/**
 * The Run surface (T5): task in, one bounded run, result out. Ported from
 * `openclaw-agent-browser/src/ui/run.ts` (the frozen reference plugin, D-029) onto the
 * extension's message contract; never imported across the two projects.
 *
 * This is the page's only way to execute anything, and it adds no authority of its own. Run is
 * offered only when the worker's readiness (`run.readiness`: the preflight, the receipt's
 * remaining time, no active run, an execution host) and the package's own input schema
 * (`run.validateInput`) both say yes for exactly the plan and the task on screen, and
 * `run.start` re-verifies all of it before the host re-verifies the bytes. What the page sends
 * is the task and nothing else: the model, the tool bindings, the permissions and the package all
 * come from the run plan. Progress is read, never inferred: stages, workers and counters are the
 * runner's checkpointed snapshot. Package-provided labels are cosmetic text, rendered with
 * `textContent` like everything else a package wrote. A closed panel reconnects by reading the
 * stored record again (`run.list`'s `active`, `run.get`), since the run lives on the host (D-070).
 */
import { decisiveCallFailure } from "../../core/execution/report.js";
import type { JsonObject } from "../../core/json.js";
import type { PresentationHints } from "../../core/presentation.js";
import type { ArtifactChunk, ArtifactContent, AuthorizationView, InputValidationView, Request, RunListView, RunReadiness, RunSummary, RunView, SessionView } from "../messages.js";
import { button, bytes, chip, clear, definition, el, shortHash, whenText } from "./dom.js";
import { buildFormModel, hintsFrom, humanize, TaskForm, type FormFile } from "./form.js";
import { renderMarkdown } from "./markdown.js";
import { writeZip } from "./zip.js";

export interface RunPanelLoaded {
  session: SessionView;
  authorization: AuthorizationView | null;
}

export interface RunPanelHost {
  send: <T>(request: Request) => Promise<T>;
  /** The open session and its authorization view, or null when no session is shown. */
  loaded: () => RunPanelLoaded | null;
  compact?: boolean;
  /** Send the person to the control that fixes a checklist item. */
  reveal?: (section: "trust" | "authorization" | "model" | "plan") => void;
  /** Something changed that other cards should re-read (a run started or settled). */
  changed?: () => void;
  /** The panel now shows another run (a click in "Earlier runs", an active run adopted), or none (T5 review 2, nit 4). */
  runChanged?: (runId: string | null) => void;
  /** Open Settings → Files, where the PDFs a task may name are picked (T6). */
  openFiles?: () => void;
}

export const HOST_ARTIFACTS = new Set(["result.json", "audit.json", "usage.json", "provenance.json", "run.json"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
/** A fallback poll while a run is active, should an `event.run` be missed. */
const POLL_MS = 5000;
const READINESS_MS = 30_000;
const VALIDATE_DEBOUNCE_MS = 350;
const MAX_CHUNKS = 1366;

/** Stable, human wording for the codes a run can end with. Codes are shown too. */
export const RUN_ERRORS: Record<string, { title: string; detail: string }> = {
  timeout: { title: "The run reached its deadline", detail: "A declared node, step or whole-run deadline elapsed before the run finished." },
  schema_validation: { title: "A package check refused the result", detail: "One of the package's own validations did not hold, so no result was accepted." },
  tool_error: { title: "A tool failed", detail: "A host tool reported an operational error." },
  model_error: { title: "The model call failed", detail: "The bound model did not return a usable answer." },
  permission_denied: { title: "A permission was denied during the run", detail: "The package asked for something this authorization does not allow, and was refused." },
  budget_exhausted: { title: "A budget limit was reached", detail: "A token, call or tool limit stopped the run before it could continue." },
  worker_error: { title: "A worker failed unexpectedly", detail: "The interpreter reported a worker error." },
  cancelled: { title: "Run cancelled", detail: "The run was stopped on request." },
  host_unloaded: { title: "The execution host was unloaded during the run", detail: "Run state is checkpointed but never resumed: an interrupted run ends rather than continuing." },
  execution_unavailable: { title: "The run could not be started", detail: "The execution host was not available." },
  interrupted: { title: "The run was interrupted", detail: "The browser or the extension restarted while this run was in flight." },
};

/**
 * A model call the runtime refused before sending it (`model.refused`, a `budget_exhausted` run),
 * in words a person can act on: which bound refused it and what to change. The numbers come from
 * the run's own audit event when it can be read (T9, the Literature Review report of 2026-10-09).
 */
export const REFUSAL_WORDS: Record<string, { title: string; detail: string }> = {
  context_window: {
    title: "The request was larger than the model's context window",
    detail: "Before each model call the runtime reserves the request's size, counted as one token per byte (a safe upper bound, since no tokenizer runs in the browser), plus the step's output allowance. That did not fit the context this browser states for the model. If the model supports more, raise its context in Settings → Models (local Ollama models are capped at 32,768 tokens until you raise them), or choose a model with a larger window.",
  },
  global_token_budget: {
    title: "The run's token budget was used up",
    detail: "The next model call would have passed the run's token limit (the package's hard limit, or a lower one in Settings → Policies → Run limits).",
  },
  worker_token_budget: {
    title: "A step's token budget was used up",
    detail: "The next model call would have passed the token budget the package gives this worker.",
  },
};

/** A model answer the router did not accept, by reason (`model.failed`), in words a person can act on (T9). */
export const MODEL_FAILURE_WORDS: Record<string, { title: string; detail: string }> = {
  model_output_not_conforming: {
    title: "The model's answer did not match the package's format",
    detail: "The model answered, but not in the shape the package requires, so the runtime refused the answer rather than accept or repair it. Where the provider can enforce the format (OpenAI's strict mode) the runtime asks it to; otherwise the format is requested and checked, and an answer that misses it is asked for once more when the step's budget allows. Running again usually works; in Settings → Models a higher reasoning effort, or a model that follows formats more reliably, also helps.",
  },
  model_output_truncated: {
    title: "The model ran out of output tokens",
    detail: "The model stopped at the step's output limit before its answer was complete. The limit is the package's per-step cap, or a lower one in Settings → Policies → Run limits (\"Output tokens per model call\").",
  },
};

/** A schema location as a person reads it: `$defs/s27/properties/search/properties/date/pattern` → `search.date`. */
function fieldOf(location: unknown): string | null {
  if (typeof location !== "string") return null;
  const parts = location.split("/").filter((part) => part !== "" && part !== "#");
  const names: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === "properties" && index + 1 < parts.length) names.push(parts[(index += 1)]!);
    else if (parts[index] === "items") names.push("[]");
  }
  return names.length > 0 ? names.join(".").replace(/\.\[\]/gu, "[]") : null;
}

/** The run's audit events (the record's `audit.events`, or a bare list), objects only. */
function auditEvents(audit: unknown): JsonObject[] {
  const events = Array.isArray(audit) ? audit : audit && typeof audit === "object" && Array.isArray((audit as { events?: unknown }).events) ? (audit as { events: unknown[] }).events : [];
  return events.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

/** The call failure that decided the run (`decisiveCallFailure`, as the record's `failure.call`), when it is the kind asked for. */
function decisiveEvent(audit: unknown, action: string): Record<string, unknown> | null {
  const decisive = decisiveCallFailure(auditEvents(audit));
  return decisive !== null && decisive.action === action ? decisive : null;
}

/** The failed model call's facts, from the run's audit: how it ended and where the answer broke the schema. */
export function modelFailureFigures(audit: unknown): string | null {
  const event = decisiveEvent(audit, "model.failed");
  const facts = event && typeof event.failure_facts === "object" && event.failure_facts !== null ? (event.failure_facts as Record<string, unknown>) : null;
  if (!event || !facts) return null;
  const out = typeof facts.reported_output_tokens === "number" ? facts.reported_output_tokens.toLocaleString("en-US") : null;
  if (event.reason === "model_output_truncated") return `It stopped at its output limit${out !== null ? ` after ${out} output tokens` : ""}.`;
  const ended = facts.stop_reason === "stop" ? `The answer was complete (it stopped normally${out !== null ? ` after ${out} output tokens` : ""}): this is not a token limit.` : null;
  let where: string | null = null;
  if (facts.output_failure === "schema") {
    const field = fieldOf(facts.schema_location);
    const count = typeof facts.schema_violations === "number" ? facts.schema_violations : null;
    where = `It broke the schema's “${String(facts.schema_keyword ?? "?")}” rule${field ? ` at ${field}` : ""}${count !== null && count > 1 ? ` (${count} violations in all)` : ""}.`;
  } else if (facts.output_failure === "not_json") where = "It was not a single JSON document.";
  else if (facts.output_failure === "no_text") where = "It contained no text.";
  return [ended, where, attemptsOf(audit, event)].filter(Boolean).join(" ") || null;
}

/**
 * The limit a skipped retry would have passed (`model.retry_skipped`'s `bound`, D-124), as a person
 * names it; the token budgets read as `REFUSAL_WORDS` titles them (T10 review 1, finding 2).
 */
export const RETRY_BOUND_WORDS: Record<string, string> = {
  global_token_budget: "the run's token budget",
  worker_token_budget: "the step's token budget",
  approval_threshold: "the token amount above which the run would need your approval",
  global_remote_calls: "the run's limit on remote model calls",
  worker_remote_calls: "the step's limit on remote model calls",
};

/** How many times the failed call was asked (D-115), or why it was not asked again (D-124), from the audit. */
function attemptsOf(audit: unknown, failed: Record<string, unknown>): string | null {
  const events = auditEvents(audit);
  const same = (event: JsonObject) => event.worker === failed.worker && event.node_id === failed.node_id;
  if (events.some((event) => same(event) && event.action === "model.called" && event.attempt === 2)) return "The runtime asked once more with the same request, and the second answer did not match either.";
  const skipped = events.find((event) => same(event) && event.action === "model.retry_skipped");
  if (skipped) {
    const limit = typeof skipped.bound === "string" && Object.hasOwn(RETRY_BOUND_WORDS, skipped.bound) ? RETRY_BOUND_WORDS[skipped.bound] : "one of the run's limits";
    return `It was not asked again: a second request would have passed ${limit}.`;
  }
  return null;
}

/** The refused call's numbers, from the run's audit: what was reserved against which bound. */
export function refusalFigures(audit: unknown): string | null {
  const event = decisiveEvent(audit, "model.refused");
  if (!event) return null;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : null);
  const reserved = n(event.reserved_tokens);
  const input = n(event.input_bound);
  const output = n(event.max_output_tokens);
  if (reserved === null) return null;
  const parts = `Reserved ${reserved} tokens${input !== null && output !== null ? ` (the request counted as ${input}, plus ${output} for the answer)` : ""}`;
  if (event.reason === "context_window" && n(event.context_window) !== null) return `${parts}; the model's context is ${n(event.context_window)}.`;
  if (n(event.limit) !== null) return `${parts}; ${n(event.used_tokens) ?? "0"} already used of ${n(event.limit)}.`;
  return `${parts}.`;
}

const STATUS_ICON: Record<string, string> = { completed: "✓", active: "●", pending: "○", failed: "✗", skipped: "–", cancelled: "⊘", queued: "○" };

function titleCase(value: string): string {
  return value
    .replace(/[._-]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function isTerminal(record: RunView | null): boolean {
  return Boolean(record && TERMINAL.has(record.status));
}

type Stage = { label: string; nodes: string[] };
type GraphNode = { id: string; type: string };

function graphNodes(session: SessionView | null): GraphNode[] {
  const nodes = session?.summary.workflow.nodes;
  return Array.isArray(nodes) ? (nodes as Array<{ id?: unknown; type?: unknown }>).map((node) => ({ id: String(node.id), type: String(node.type) })) : [];
}

function presentationOf(session: SessionView | null): PresentationHints | null {
  return session?.summary.workflow.presentation ?? null;
}

/** The package's stage grouping, or one derived generically from its graph. */
export function stagesFor(nodes: GraphNode[], presentation: PresentationHints | null): Stage[] {
  if (presentation && presentation.stages.length > 0) {
    const known = new Set(nodes.map((node) => node.id));
    const stages = presentation.stages.map((stage) => ({ label: stage.label, nodes: stage.nodes.filter((id) => known.size === 0 || known.has(id)) })).filter((stage) => stage.nodes.length > 0);
    const staged = new Set(stages.flatMap((stage) => stage.nodes));
    const rest = nodes.filter((node) => !staged.has(node.id)).map((node) => node.id);
    if (rest.length > 0) stages.push({ label: "Other steps", nodes: rest });
    return stages;
  }
  // Generic: each model, tool or map node starts a stage; the structural nodes that follow it belong to it.
  const labels = presentation?.nodes ?? {};
  const stages: Stage[] = [];
  for (const node of nodes) {
    const effectful = node.type === "llm" || node.type === "tool" || node.type === "map";
    if (effectful || stages.length === 0) stages.push({ label: labels[node.id] ?? humanize(node.id), nodes: [node.id] });
    else stages[stages.length - 1]!.nodes.push(node.id);
  }
  return stages;
}

type NodeState = "completed" | "active" | "pending" | "failed" | "skipped";
type Progress = NonNullable<RunView["progress"]>;

function nodeState(progress: Progress | null, node: string): NodeState {
  if (!progress) return "pending";
  if (progress.failed_nodes.includes(node)) return "failed";
  if (progress.skipped_nodes.includes(node)) return "skipped";
  if (progress.active_nodes.includes(node)) return "active";
  if (progress.completed_nodes.includes(node)) return "completed";
  return "pending";
}

function stageState(states: NodeState[]): NodeState {
  if (states.includes("failed")) return "failed";
  if (states.includes("active")) return "active";
  if (states.every((state) => state === "skipped")) return "skipped";
  if (states.every((state) => state === "completed" || state === "skipped")) return "completed";
  if (states.some((state) => state === "completed" || state === "skipped")) return "active";
  return "pending";
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export function mimeFor(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".bib")) return "application/x-bibtex";
  if (name.endsWith(".zip")) return "application/zip";
  return "text/plain";
}

export async function sha256HexOf(data: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", await data.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Save bytes through the browser's download, after hashing them; returns the hash or null when the browser cannot hash. */
export async function saveBlob(name: string, blob: Blob): Promise<string | null> {
  const actual = await sha256HexOf(blob).catch(() => null);
  if (typeof URL.createObjectURL !== "function") throw new Error("This browser cannot save files.");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return actual;
}

/** The run's files as the Artifacts section lists them: the package exports, then the host's evidence with `run.json` last. */
export function artifactGroups(record: Pick<RunView, "artifacts">): { exports: RunView["artifacts"]; evidence: RunView["artifacts"] } {
  const exports = record.artifacts.filter((item) => !HOST_ARTIFACTS.has(item.name));
  const evidence = record.artifacts.filter((item) => HOST_ARTIFACTS.has(item.name) && item.name !== "run.json");
  evidence.push(record.artifacts.find((item) => item.name === "run.json") ?? { name: "run.json", bytes: 0, sha256: "" });
  return { exports, evidence };
}

/** The run archive's layout (D-112): `run.json` at the top, exports under `exports/`, the other evidence under `evidence/`. */
export function archiveMembers(exports: readonly string[], evidence: readonly string[]): Array<{ path: string; artifact: string }> {
  return [
    { path: "run.json", artifact: "run.json" },
    ...exports.map((name) => ({ path: `exports/${name}`, artifact: name })),
    ...evidence.filter((name) => name !== "run.json").map((name) => ({ path: `evidence/${name}`, artifact: name })),
  ];
}

/** The most the run archive gathers in the page, as the Runs export (D-073). */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

function artifactJson(content: ArtifactContent): unknown {
  if (content.json !== undefined) return content.json;
  if (content.truncated || !content.name.endsWith(".json") || typeof content.text !== "string") return undefined;
  try {
    return JSON.parse(content.text) as unknown;
  } catch {
    return undefined;
  }
}

function displayText(content: ArtifactContent): string {
  const value = artifactJson(content);
  return value !== undefined ? JSON.stringify(value, null, 2) : (content.text ?? "");
}

function truncatedNote(content: ArtifactContent): HTMLElement {
  return el("p", { className: "ab-hint", text: `Showing the first ${bytes(content.shown_bytes)} of ${bytes(content.bytes)}. Download has the whole file, verified.` });
}

type ErrorBox = { code: string; message: string };

function describe(error: unknown): ErrorBox {
  const value = error as { code?: unknown; message?: unknown };
  return { code: typeof value?.code === "string" ? value.code : "error", message: typeof value?.message === "string" ? value.message : "The extension's background service did not answer." };
}

export class RunPanel {
  readonly root: HTMLElement;
  private readonly headEl = el("div", { className: "ab-run-head" });
  private readonly checklistEl = el("div", { className: "ab-run-checklist" });
  private readonly formHost = el("div", { className: "ab-run-form" });
  private readonly summaryEl = el("div", { className: "ab-run-summary" });
  private readonly actionsEl = el("div", { className: "ab-run-actions" });
  private readonly runEl = el("div", { className: "ab-run-view", attrs: { "aria-live": "polite" } });
  private readonly historyEl = el("div", { className: "ab-run-history" });

  private sessionId: string | null = null;
  private adoptedFor: string | null = null;
  private form: TaskForm | null = null;
  private formKey = "";
  private taskValue: unknown = undefined;
  private localErrors: ReadonlyMap<string, string> = new Map();
  private validation: { key: string; state: "idle" | "checking" | "valid" | "invalid" | "error"; report: InputValidationView | null } = { key: "", state: "idle", report: null };
  private readiness: RunReadiness | null = null;
  private readinessFor = "";
  private run: RunView | null = null;
  private history: RunSummary[] = [];
  private starting = false;
  private cancelling = false;
  private startError: ErrorBox | null = null;
  private artifacts = new Map<string, ArtifactContent | { error: ErrorBox }>();
  private viewing: string | null = null;
  /** The figures of a refused model call, for the run shown (`loadRefusal`). */
  private refusal: { runId: string; figures: string | null } | null = null;
  /** Whether Inspect has opened the per-file list (closed by default, F-13). */
  private inspecting = false;
  private downloadNote: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readinessTimer: ReturnType<typeof setInterval> | null = null;
  private validateTimer: ReturnType<typeof setTimeout> | null = null;
  private elapsedEl: HTMLElement | null = null;
  private disposed = false;
  /** The PDFs this browser holds for runs (Settings → Files), for the task form's document picker (T6). */
  private files: FormFile[] = [];
  /** Bumped by every `openRun`: a reply to an earlier request never replaces a later one (T5 review 3, nit 5). */
  private openSequence = 0;
  /** The person named the run shown (the Runs page, "Earlier runs"): an active run does not replace it (nit 5). */
  private named = false;

  constructor(private readonly host: RunPanelHost) {
    this.root = el("section", { className: `ab-card ab-run${host.compact ? " ab-run-compact" : ""}`, attrs: { "aria-label": "Run" } }, this.headEl, this.checklistEl, this.formHost, this.summaryEl, this.actionsEl, this.runEl, this.historyEl);
    this.root.dataset.state = "idle";
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.readinessTimer) clearInterval(this.readinessTimer);
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.pollTimer = this.tickTimer = this.readinessTimer = this.validateTimer = null;
  }

  // -- lifecycle -------------------------------------------------------------------------
  /** A package session was opened or re-read. */
  async attachSession(sessionId: string): Promise<void> {
    if (this.sessionId !== sessionId) {
      this.resetSession(sessionId);
      this.taskValue = undefined;
      this.validation = { key: "", state: "idle", report: null };
      this.run = null;
      this.artifacts = new Map();
      this.viewing = null;
      this.startError = null;
      this.adoptedFor = null;
      this.named = false;
    }
    this.render();
    void this.loadFiles();
    await this.loadHistory(true);
    if (this.disposed || this.sessionId !== sessionId) return;
    this.render();
    void this.refreshReadiness();
    if (!this.readinessTimer) {
      this.readinessTimer = setInterval(() => {
        if (this.run && !isTerminal(this.run)) return;
        void this.refreshReadiness();
      }, READINESS_MS);
    }
  }

  /**
   * Show one run by id, with or without its package session still open (the Runs page). The
   * person named it: a later reply to an earlier request does not replace it, and a run that
   * becomes active elsewhere does not either (T5 review 3, nit 5).
   */
  async openRun(runId: string, options: { named?: boolean } = {}): Promise<void> {
    const sequence = (this.openSequence += 1);
    let record: RunView | null = null;
    try {
      record = await this.host.send<RunView | null>({ type: "run.get", runId });
    } catch (error) {
      if (sequence !== this.openSequence) return;
      this.startError = describe(error);
      this.render();
      return;
    }
    if (this.disposed || sequence !== this.openSequence) return;
    if (!record) {
      this.startError = { code: "run_unknown", message: "This browser holds no run with that id." };
      this.render();
      return;
    }
    // Another package's run: nothing of the session that was attached applies to it, neither
    // its earlier runs nor its readiness (T5 review 2, nit 5).
    if (record.sessionId !== this.sessionId) this.resetSession(null);
    this.named = options.named !== false;
    this.show(record);
  }

  /** Forget everything of the attached session (T5 review 3, nit 7): one reset for `detach` and a foreign run. */
  private resetSession(sessionId: string | null): void {
    this.stopTimers();
    this.sessionId = sessionId;
    this.form = null;
    this.formKey = "";
    this.history = [];
    this.readiness = null;
    this.readinessFor = "";
  }

  detach(): void {
    this.resetSession(null);
    this.run = null;
    this.named = false;
    this.render();
    this.host.runChanged?.(null);
  }

  /** The picked files changed (an `event.files` broadcast): re-read them for the document picker. */
  onFilesEvent(): void {
    void this.loadFiles();
  }

  private async loadFiles(): Promise<void> {
    let files: FormFile[];
    try {
      files = (await this.host.send<{ files: FormFile[] }>({ type: "files.list" })).files;
    } catch {
      return;
    }
    if (this.disposed) return;
    const changed = JSON.stringify(files.map((file) => file.file_id)) !== JSON.stringify(this.files.map((file) => file.file_id));
    this.files = files;
    if (changed) this.form?.refresh();
  }

  /** The page's loaded state changed (authorization, model, plan). */
  sync(): void {
    const plan = this.host.loaded()?.authorization?.run_plan?.run_plan ?? null;
    const key = plan ? `${plan.run_plan_id}:${plan.run_plan_sha256}` : "";
    this.render();
    if (key !== this.readinessFor) void this.refreshReadiness();
  }

  /** An `event.run` broadcast reached the page: re-read the run it names when it is ours, or the session's. */
  onRunEvent(event: { runId: string; sessionId: string; status: string }): void {
    if (this.run && this.run.runId === event.runId) {
      void this.poll();
      return;
    }
    if (this.sessionId && event.sessionId === this.sessionId) void this.loadHistory(false);
  }

  hasSession(): boolean {
    return this.sessionId !== null;
  }

  currentRun(): RunView | null {
    return this.run;
  }

  // -- data ------------------------------------------------------------------------------
  private async loadHistory(adopt: boolean): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    let result: RunListView | null = null;
    try {
      result = await this.host.send<RunListView>({ type: "run.list", sessionId });
    } catch {
      result = null;
    }
    if (this.disposed || sessionId !== this.sessionId || !result) return;
    this.history = result.runs;
    if (adopt && !this.run && this.adoptedFor !== sessionId) {
      // Reconnect once per attach: an active run first, otherwise the most recent one.
      this.adoptedFor = sessionId;
      if (result.active) this.show(result.active);
      else if (this.history[0]) await this.openRun(this.history[0].runId, { named: false });
    } else if (result.active && result.active.runId !== this.run?.runId && (!this.run || (isTerminal(this.run) && !this.named))) {
      this.show(result.active);
    }
    this.renderHistory();
  }

  private async refreshReadiness(): Promise<void> {
    const sessionId = this.sessionId;
    const plan = this.host.loaded()?.authorization?.run_plan?.run_plan ?? null;
    if (!sessionId || !plan) {
      this.readiness = null;
      this.readinessFor = "";
      this.renderChecklist();
      this.renderActions();
      return;
    }
    const key = `${plan.run_plan_id}:${plan.run_plan_sha256}`;
    let readiness: RunReadiness | null = null;
    try {
      readiness = await this.host.send<RunReadiness>({ type: "run.readiness", sessionId });
    } catch (error) {
      const described = describe(error);
      readiness = { session_id: sessionId, checked_at: new Date().toISOString(), ready: false, run_plan_id: null, run_plan_sha256: null, blocker: { code: described.code, message: described.message, subject: null }, checks: [], receipt: null, active_run_id: null, preflight: null };
    }
    if (this.disposed || sessionId !== this.sessionId) return;
    this.readinessFor = key;
    this.readiness = readiness;
    this.renderChecklist();
    this.renderActions();
    // A run in flight this surface does not show (its history could not be read when it attached,
    // the worker restarting): read the history again, which shows it (T5a review 1, finding 2).
    // Only when nothing is shown, so a run the person named stays on screen (T5a review 2, nit 4).
    if (readiness.active_run_id !== null && this.run === null) void this.loadHistory(false);
  }

  private scheduleValidation(): void {
    const key = JSON.stringify(this.taskValue ?? null);
    if (key === this.validation.key && this.validation.state !== "idle") return;
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.validation = { key, state: "checking", report: null };
    this.renderActions();
    this.validateTimer = setTimeout(() => void this.validate(key), VALIDATE_DEBOUNCE_MS);
  }

  private async validate(key: string): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || this.taskValue === undefined) {
      this.validation = { key, state: "invalid", report: null };
      this.renderActions();
      return;
    }
    let report: InputValidationView | null = null;
    let failed = false;
    try {
      report = await this.host.send<InputValidationView>({ type: "run.validateInput", sessionId, input: this.taskValue });
    } catch {
      failed = true;
    }
    if (this.disposed || sessionId !== this.sessionId) return;
    if (key !== JSON.stringify(this.taskValue ?? null)) return; // A newer edit is pending.
    if (failed || !report) this.validation = { key, state: "error", report: null };
    else {
      this.validation = { key, state: report.valid ? "valid" : "invalid", report };
      this.form?.showErrors(report.errors);
    }
    this.renderChecklist();
    this.renderActions();
  }

  // -- the run -------------------------------------------------------------------------------
  private show(record: RunView): void {
    const changed = this.run?.runId !== record.runId;
    this.run = record;
    this.artifacts = new Map();
    this.viewing = null;
    if (changed) this.inspecting = false;
    this.downloadNote = null;
    this.render();
    if (isTerminal(record)) void this.loadResult(record);
    else this.startPolling();
    if (changed) this.host.runChanged?.(record.runId);
  }

  private startPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), 1000);
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private tick(): void {
    if (!this.elapsedEl || !this.run || isTerminal(this.run)) return;
    this.elapsedEl.textContent = formatElapsed(this.elapsedMs(this.run));
  }

  private elapsedMs(record: RunView): number {
    if (record.durationMs !== null && isTerminal(record)) return record.durationMs;
    const started = Date.parse(record.startedAt ?? record.createdAt);
    return Number.isFinite(started) ? Date.now() - started : 0;
  }

  private async poll(): Promise<void> {
    const current = this.run;
    if (!current || this.disposed) return;
    let record: RunView | null = null;
    try {
      record = await this.host.send<RunView | null>({ type: "run.get", runId: current.runId });
    } catch {
      record = null;
    }
    if (this.disposed || this.run?.runId !== current.runId) return;
    if (record) {
      this.run = record;
      if (isTerminal(record)) {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.pollTimer = this.tickTimer = null;
        this.cancelling = false;
        this.render();
        void this.loadResult(record);
        void this.loadHistory(false);
        void this.refreshReadiness();
        this.host.changed?.();
        return;
      }
      this.renderHead();
      this.renderRun();
      this.renderActions();
    }
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private async startRun(): Promise<void> {
    const loaded = this.host.loaded();
    const plan = loaded?.authorization?.run_plan?.run_plan ?? null;
    const sessionId = this.sessionId;
    if (!loaded || !plan || !sessionId || !this.canRun().enabled) return;
    this.starting = true;
    this.startError = null;
    this.renderActions();
    let record: RunView | null = null;
    try {
      record = await this.host.send<RunView>({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: structuredClone(this.taskValue) });
    } catch (error) {
      this.startError = describe(error);
    }
    if (this.disposed) return;
    this.starting = false;
    if (!record) {
      this.render();
      void this.refreshReadiness();
      return;
    }
    // The run just started is the one to show: a pending `openRun` reply does not replace it.
    this.openSequence += 1;
    this.named = false;
    this.show(record);
    void this.loadHistory(false);
    this.host.changed?.();
  }

  private async cancelRun(): Promise<void> {
    const current = this.run;
    if (!current || isTerminal(current)) return;
    this.cancelling = true;
    this.renderActions();
    try {
      const record = await this.host.send<RunView>({ type: "run.cancel", runId: current.runId });
      if (this.run?.runId === record.runId) this.run = record;
    } catch {
      // The poll will show the state.
    }
    if (this.disposed) return;
    this.renderRun();
    this.renderActions();
  }

  private newRun(): void {
    this.run = null;
    this.artifacts = new Map();
    this.viewing = null;
    this.startError = null;
    this.render();
    void this.refreshReadiness();
  }

  private async loadResult(record: RunView): Promise<void> {
    await Promise.all([...this.resultArtifactNames(record).map((name) => this.loadArtifact(record.runId, name)), this.loadRefusal(record)]);
    if (this.disposed || this.run?.runId !== record.runId) return;
    this.renderRun();
  }

  /** A refused or failed model call's figures, read from the run's verified audit (it is often larger than the inline view). */
  private async loadRefusal(record: RunView): Promise<void> {
    const action = record.failure?.call?.action;
    if ((action !== "model.refused" && action !== "model.failed") || !record.artifacts.some((item) => item.name === "audit.json")) return;
    try {
      const audit = JSON.parse(await (await this.artifactBytes(record, "audit.json")).text()) as unknown;
      if (this.run?.runId === record.runId) this.refusal = { runId: record.runId, figures: action === "model.refused" ? refusalFigures(audit) : modelFailureFigures(audit) };
    } catch {
      // The wording stands without the numbers.
    }
  }

  private async loadArtifact(runId: string, name: string): Promise<void> {
    if (this.artifacts.has(name)) return;
    try {
      const content = await this.host.send<ArtifactContent>({ type: "run.artifact", runId, name });
      if (this.run?.runId !== runId) return;
      this.artifacts.set(name, content);
    } catch (error) {
      if (this.run?.runId !== runId) return;
      this.artifacts.set(name, { error: describe(error) });
    }
  }

  /**
   * One artifact's bytes, read in chunks and checked against the hash the host recorded when it
   * wrote the artifact: the bytes must match *that*, not merely the hash the worker recomputed from
   * the same stored bytes (review 1, nit 9).
   */
  private async artifactBytes(record: RunView, name: string): Promise<Blob> {
    const parts: Uint8Array[] = [];
    let offset = 0;
    const recorded = record.artifacts.find((item) => item.name === name)?.sha256 ?? null;
    let expected = "";
    let complete = false;
    for (let index = 0; index < MAX_CHUNKS; index += 1) {
      const chunk = await this.host.send<ArtifactChunk>({ type: "run.artifactChunk", runId: record.runId, name, offset });
      const data = base64Bytes(chunk.base64);
      parts.push(data);
      offset += data.length;
      expected = chunk.sha256;
      if (chunk.eof || data.length === 0) {
        complete = chunk.eof;
        break;
      }
    }
    if (!complete) throw new Error(`${name} is larger than this page downloads.`);
    if (recorded !== null && expected !== recorded) throw new Error(`The stored bytes of ${name} do not match the SHA-256 the run recorded for this artifact.`);
    const blob = new Blob(parts as BlobPart[], { type: mimeFor(name) });
    const actual = await sha256HexOf(blob).catch(() => null);
    if (actual && actual !== (recorded ?? expected)) throw new Error(`The downloaded bytes of ${name} do not match the artifact's SHA-256.`);
    return blob;
  }

  private async download(name: string): Promise<void> {
    const record = this.run;
    if (!record) return;
    this.downloadNote = `Downloading ${name}…`;
    this.renderRun();
    try {
      const recorded = record.artifacts.find((item) => item.name === name)?.sha256 ?? null;
      const blob = await this.artifactBytes(record, name);
      const actual = await saveBlob(name, blob);
      this.downloadNote = actual ? `Saved ${name} (${bytes(blob.size)}, SHA-256 verified${recorded !== null ? " against the run record" : ""}).` : `Saved ${name} (${bytes(blob.size)}).`;
    } catch (error) {
      this.downloadNote = `Download failed: ${(error as Error).message}`;
    }
    if (!this.disposed) this.renderRun();
  }

  /**
   * Every file the Artifacts section lists, in one zip named `<run_id>.zip` (F-13, D-112): the
   * package exports under `exports/`, the run evidence under `evidence/`, and `run.json` at the top.
   * Each file is read and verified as a single Download is; one that fails stops the zip.
   */
  private async downloadAll(): Promise<void> {
    const record = this.run;
    if (!record) return;
    const { exports, evidence } = artifactGroups(record);
    const members = archiveMembers(exports.map((item) => item.name), evidence.map((item) => item.name));
    const name = `${record.runId}.zip`;
    this.downloadNote = `Preparing ${name} (${members.length} files)…`;
    this.renderRun();
    try {
      const entries: Array<{ name: string; bytes: Uint8Array }> = [];
      let total = 0;
      for (const member of members) {
        const blob = await this.artifactBytes(record, member.artifact);
        total += blob.size;
        if (total > MAX_ARCHIVE_BYTES) throw new Error(`The run's files exceed ${bytes(MAX_ARCHIVE_BYTES)}; download them one by one under Inspect.`);
        entries.push({ name: member.path, bytes: new Uint8Array(await blob.arrayBuffer()) });
      }
      const zip = new Blob([writeZip(entries) as BlobPart], { type: mimeFor(name) });
      const hash = await saveBlob(name, zip);
      this.downloadNote = `Saved ${name} (${members.length} files, ${bytes(zip.size)}, each verified against the run record${hash ? `; zip sha256:${hash.slice(0, 16)}…` : ""}).`;
    } catch (error) {
      this.downloadNote = `Download failed: ${(error as Error).message}`;
    }
    if (!this.disposed) this.renderRun();
  }

  // -- readiness -----------------------------------------------------------------------
  /** Whether Run may be pressed, and the precise reason when it may not. */
  canRun(): { enabled: boolean; reason: string | null } {
    const loaded = this.host.loaded();
    const refuse = (reason: string) => ({ enabled: false, reason });
    if (!loaded || !this.sessionId) return refuse("Open a package first.");
    if (this.run && !isTerminal(this.run)) return refuse("A run is in progress.");
    if (this.starting) return refuse("Starting the run…");
    const first = this.checklist(loaded).find((item) => !item.ok);
    if (first) return refuse(first.reason ?? first.label);
    const plan = loaded.authorization?.run_plan?.run_plan ?? null;
    if (!this.readiness || this.readinessFor !== `${plan?.run_plan_id}:${plan?.run_plan_sha256}`) return refuse("Checking that the run plan is still current…");
    if (!this.readiness.ready) return refuse(this.readiness.blocker?.message ?? "The preflight refused this plan.");
    if (this.readiness.run_plan_sha256 !== plan?.run_plan_sha256) return refuse("The run plan changed; re-checking…");
    const localError = [...this.localErrors.values()][0];
    if (localError) return refuse(localError);
    const key = JSON.stringify(this.taskValue ?? null);
    if (this.validation.key !== key || this.validation.state === "checking" || this.validation.state === "idle") return refuse("Checking the task against the package's input schema…");
    if (this.validation.state === "error") return refuse("The task could not be checked. Try again.");
    if (this.validation.state === "invalid") {
      const error = this.validation.report?.errors[0];
      return refuse(error ? `The task is not valid: ${error.pointer || "task"} ${error.message}.` : "The task is not valid.");
    }
    return { enabled: true, reason: null };
  }

  private checklist(loaded: RunPanelLoaded) {
    const page = loaded.session.page;
    const authorization = loaded.authorization;
    const receipt = authorization?.receipt ?? null;
    const planState = authorization?.run_plan ?? null;
    const plan = planState?.run_plan ?? null;
    const preflight = planState?.preflight ?? null;
    const validation = page.technical.validation;
    const items: Array<{ id: string; label: string; ok: boolean; reason: string | null; section?: "trust" | "authorization" | "model" | "plan" }> = [
      {
        id: "verified",
        label: "Package verified",
        ok: validation.container_status === "valid" && validation.integrity_status === "valid" && validation.schema_status === "valid" && validation.runtime_status === "compatible" && page.trust.signature_status === "valid",
        reason: "The package did not pass verification, so it cannot run.",
        section: "trust",
      },
      {
        id: "trusted",
        label: "Publisher trusted",
        ok: page.trust.trust_status === "trusted",
        reason: page.trust.trust_status === "mismatch" ? "The claimed publisher is pinned to a different key. Treat this package as an impersonation risk." : "The signing key is not trusted in this browser. Review it under Publisher.",
        section: "trust",
      },
      {
        id: "authorized",
        label: "Permissions authorized",
        ok: Boolean(receipt?.runnable),
        reason: receipt ? "The current decisions do not make this package runnable. Adjust them and authorize again." : "Choose a way to use the agent (or customize your settings) and press Use this agent.",
        section: "authorization",
      },
    ];
    const declared = authorization?.request.tool_approvals.length ?? 0;
    const approved = plan ? plan.execution.required_tool_ids.length : null;
    items.push({
      id: "tools",
      label: declared > 0 ? (plan ? `Tools bound (${plan.tool_bindings.length} of ${approved} approved; ${plan.execution.denied_tool_ids.length} denied)` : "Tools bound") : "No tools declared",
      ok: declared === 0 || (Boolean(plan) && preflight?.tool_bindings.current !== false && plan!.tool_bindings.length === approved),
      // No plan is the usual case here, and its fix is the button, not a host implementation (Demo 3 rehearsal, F-09).
      reason: !plan ? "No run plan yet: press Use this agent." : plan.tool_bindings.length !== approved ? "Every approved tool needs a host implementation before a plan can bind it." : "A tool implementation changed or disappeared after the plan was prepared. Prepare a new run plan.",
      section: "model",
    });
    items.push({
      id: "model",
      label: plan?.model_binding ? `Model: ${plan.model_binding.display_name}` : "Model selected",
      ok: Boolean(plan?.model_binding) && preflight?.model_still_available !== false,
      reason: plan?.model_binding ? "The selected model is no longer offered by this browser. Choose another and prepare a new plan." : "Choose a default model in Settings → Models, or pick one under Customize your settings.",
      section: "model",
    });
    // Every granted personal permission must have a chosen record (D-053 resource grants).
    const personal = authorization?.resources.requests.filter((request) => (receipt?.decisions[request.permission_id] ?? "deny") !== "deny") ?? [];
    const granted = new Set(plan?.resource_grants.map((grant) => grant.permission_id) ?? []);
    const unselected = personal.filter((request) => !granted.has(request.permission_id)).map((request) => request.type_display_name ?? request.permission_id);
    if (personal.length > 0) {
      items.push({ id: "resources", label: `Your data selected (${personal.length})`, ok: unselected.length === 0, reason: `Choose which record to use for: ${unselected.join(", ")}.`, section: "authorization" });
    }
    items.push({
      id: "plan",
      label: "Run plan ready",
      ok: Boolean(plan) && preflight?.ready === true && preflight?.stale !== true && plan!.execution.mode === "model",
      reason: !plan ? "Authorize the agent to prepare a run plan." : preflight?.stale ? `The run plan is stale: ${preflight.stale_reasons[0]?.message ?? "prepare a new one."}` : plan.execution.mode !== "model" ? "This plan is authority for one tool probe, not for a run." : `The run plan is not ready: ${preflight?.blocking_reasons[0]?.message ?? ""}`,
      section: "plan",
    });
    const readiness = this.readiness;
    if (readiness?.receipt) {
      const ok = readiness.receipt.remaining_seconds >= readiness.receipt.required_seconds;
      items.push({ id: "receipt", label: `Authorization valid for ${Math.floor(readiness.receipt.remaining_seconds / 60)} more min (a run may take up to ${Math.ceil(readiness.receipt.required_seconds / 60)} min)`, ok, reason: "Authorize again and prepare a new run plan, so consent does not lapse in the middle of a run.", section: "authorization" });
    }
    if (readiness?.blocker?.code === "execution_active") items.push({ id: "active", label: "No other run in progress", ok: false, reason: readiness.blocker.message });
    if (readiness?.blocker?.code === "execution_unavailable") items.push({ id: "host", label: "Execution host available", ok: false, reason: readiness.blocker.message });
    const key = JSON.stringify(this.taskValue ?? null);
    const local = [...this.localErrors.values()][0];
    items.push({
      id: "task",
      label: "Task valid",
      ok: !local && this.validation.key === key && this.validation.state === "valid",
      reason: local ? local : this.validation.state === "invalid" ? this.invalidReason() : "Checking the task against the package's input schema…",
    });
    return items;
  }

  private invalidReason(): string {
    const report = this.validation.report;
    const first = report?.errors[0];
    if (!first) return "The task does not satisfy the package's input schema.";
    const subject = this.form ? this.form.labelFor(first.pointer) : first.pointer || "The task";
    const more = report.error_count > 1 ? ` (${report.error_count - 1} more)` : "";
    return `${subject} ${first.message}${more}.`;
  }

  // -- rendering -----------------------------------------------------------------------
  render(): void {
    this.renderHead();
    this.renderChecklist();
    this.renderForm();
    this.renderSummary();
    this.renderActions();
    this.renderRun();
    this.renderHistory();
  }

  private presentation(): PresentationHints | null {
    return presentationOf(this.host.loaded()?.session ?? null);
  }

  private nodeWhere(record: RunView, nodeId: string): string {
    const loaded = this.host.loaded();
    const session = loaded && loaded.session.session.id === record.sessionId ? loaded.session : null;
    const presentation = presentationOf(session);
    const label = presentation?.nodes[nodeId] ?? null;
    const stage = stagesFor(graphNodes(session), presentation).find((item) => item.nodes.includes(nodeId))?.label ?? null;
    const named = label && label !== nodeId ? `${label} (${nodeId})` : nodeId;
    return stage && stage !== label ? `${named}, in ${stage}` : named;
  }

  private statusTone(status: string): "good" | "warn" | "bad" | "neutral" {
    if (status === "completed") return "good";
    if (status === "failed" || status === "interrupted") return "bad";
    if (status === "cancelled") return "warn";
    return "neutral";
  }

  private showingForm(): boolean {
    const loaded = this.host.loaded();
    return Boolean(loaded && this.sessionId && loaded.session.session.id === this.sessionId && !this.run);
  }

  private renderHead(): void {
    clear(this.headEl);
    const loaded = this.host.loaded();
    const record = this.run;
    const name = loaded?.session.page.identity.name ?? record?.package.name ?? "Run";
    const version = loaded?.session.page.identity.version ?? record?.package.version ?? "";
    this.headEl.append(
      el(
        "div",
        { className: "ab-run-title" },
        el("h2", { className: "ab-card-title", text: `Run · ${name}${version ? ` ${version}` : ""}` }),
        record ? chip(record.status === "running" ? "Running" : humanize(record.status), this.statusTone(record.status)) : null,
      ),
    );
    if (record?.taskText) this.headEl.append(el("p", { className: "ab-run-task", text: `“${record.taskText}”` }));
    if (record && !record.sessionOpen) this.headEl.append(el("p", { className: "ab-hint", text: "This run's package session is no longer open. Its record and artifacts remain available here." }));
  }

  private renderChecklist(): void {
    clear(this.checklistEl);
    const loaded = this.host.loaded();
    if (!loaded || !this.showingForm()) return;
    const listNode = el("ul", { className: "ab-checklist" });
    for (const item of this.checklist(loaded)) {
      const line = el("li", { className: `ab-check-${item.ok ? "ok" : "no"}`, attrs: { "data-check": item.id } }, el("span", { className: "ab-check-icon", text: item.ok ? "✓" : "○" }), el("span", { text: item.label }));
      if (!item.ok && item.reason) line.append(el("span", { className: "ab-muted", text: ` — ${item.reason}` }));
      if (!item.ok && item.section && this.host.reveal) {
        const section = item.section;
        const go = button("Go", () => this.host.reveal?.(section));
        go.classList.add("ab-button-small");
        line.append(go);
      }
      listNode.append(line);
    }
    this.checklistEl.append(listNode);
  }

  private renderForm(): void {
    const loaded = this.host.loaded();
    if (!loaded || !this.showingForm()) {
      clear(this.formHost);
      this.form = null;
      this.formKey = "";
      return;
    }
    const input = loaded.session.summary.workflow.input ?? null;
    const presentation = presentationOf(loaded.session);
    const key = `${loaded.session.session.id}:${input?.schema_sha256 ?? "none"}`;
    if (this.form && this.formKey === key) {
      if (!this.formHost.contains(this.form.root)) {
        clear(this.formHost);
        this.formHost.append(this.promptHeading(presentation), this.form.root);
      }
      return;
    }
    clear(this.formHost);
    const model = buildFormModel(input?.document ?? null, hintsFrom(presentation));
    const previous = this.taskValue && typeof this.taskValue === "object" && !Array.isArray(this.taskValue) ? (this.taskValue as Record<string, unknown>) : null;
    this.form = new TaskForm(model, previous, { canWrite: true, files: () => this.files, openFiles: this.host.openFiles }, (value, errors) => {
      this.taskValue = value;
      this.localErrors = new Map(errors);
      this.scheduleValidation();
      this.renderChecklist();
    });
    this.formKey = key;
    this.taskValue = this.form.current();
    this.localErrors = new Map(this.form.errors());
    this.formHost.append(this.promptHeading(presentation), this.form.root);
    if (input?.note && !input.document) this.formHost.append(el("p", { className: "ab-hint", text: input.note }));
    this.scheduleValidation();
  }

  private promptHeading(presentation: PresentationHints | null): HTMLElement {
    return el("h3", { className: "ab-run-prompt", text: presentation?.task.prompt ?? "Task" });
  }

  private renderSummary(): void {
    clear(this.summaryEl);
    const loaded = this.host.loaded();
    if (!loaded || !this.showingForm() || !loaded.authorization) return;
    const view = loaded.authorization;
    const plan = view.run_plan?.run_plan ?? null;
    const binding = plan?.model_binding ?? null;
    const granted = new Set(view.receipt?.granted_permission_ids ?? []);
    const toolRows = view.request.tool_approvals.map((tool) => {
      const bound = plan?.tool_bindings.find((item) => item.tool_id === tool.tool_id) ?? null;
      const denied = tool.permissions.filter((id) => !granted.has(id));
      const notes: string[] = [];
      if (bound) notes.push(`via ${typeof bound.display_name === "string" ? bound.display_name : bound.binding_id}`);
      if (!view.receipt) notes.push(tool.permissions.length > 0 ? `needs ${tool.permissions.join(", ")}` : "needs no permission");
      else if (plan?.execution.denied_tool_ids.includes(tool.tool_id)) notes.push("denied — calls to it are refused");
      else if (denied.length > 0) notes.push(`${denied.join(", ")} denied — calls that need it are refused`);
      if (!bound && view.receipt && !plan?.execution.denied_tool_ids.includes(tool.tool_id)) notes.push("not bound yet");
      return el("li", {}, el("span", { className: "ab-check-icon", text: bound ? "✓" : "○" }), el("span", { text: titleCase(tool.tool_id) }), el("span", { className: "ab-muted ab-row-note", text: notes.join(" · ") }));
    });
    const permissionRows = view.request.permissions.map((permission) =>
      el("li", {}, el("span", { className: "ab-check-icon", text: granted.has(permission.id) ? "✓" : "✗" }), el("code", { text: permission.id }), el("span", { className: "ab-muted", text: granted.has(permission.id) ? (view.receipt?.decisions[permission.id] === "once" ? " · once" : "") : permission.required ? " · required, denied" : " · denied" })),
    );
    this.summaryEl.append(
      el(
        "div",
        { className: "ab-grid" },
        el("div", {}, el("h4", { text: "Model" }), binding ? el("p", {}, el("strong", { text: binding.display_name }), el("span", { className: "ab-muted", text: ` · ${(binding.descriptor.properties as { local?: boolean } | undefined)?.local === true ? "Local" : (binding.descriptor.properties as { local?: boolean } | undefined)?.local === false ? "Hosted" : "locality not reported"} · ${binding.host_model_id}` })) : el("p", { className: "ab-muted", text: "No model bound yet." })),
        el("div", {}, el("h4", { text: "Tools" }), toolRows.length > 0 ? el("ul", { className: "ab-plain-list" }, ...toolRows) : el("p", { className: "ab-muted", text: "None declared." })),
        el("div", {}, el("h4", { text: "Permissions" }), el("ul", { className: "ab-plain-list" }, ...permissionRows)),
      ),
    );
  }

  private renderActions(): void {
    clear(this.actionsEl);
    const presentation = this.presentation();
    const record = this.run;
    if (record && !isTerminal(record)) {
      this.actionsEl.append(button(this.cancelling || record.cancelRequested ? "Cancelling…" : "Cancel", () => void this.cancelRun(), { variant: "danger", disabled: this.cancelling || record.cancelRequested }));
      return;
    }
    if (record && isTerminal(record)) {
      if (this.host.loaded() && this.sessionId === record.sessionId) this.actionsEl.append(button("New run", () => this.newRun(), { variant: "primary" }));
      return;
    }
    if (!this.showingForm()) return;
    const verdict = this.canRun();
    const label = presentation?.task.run_label ?? "Run";
    const run = button(this.starting ? "Starting…" : label, () => void this.startRun(), { variant: "primary", disabled: !verdict.enabled, title: verdict.reason ?? "Start one bounded run of this package with this task" });
    run.classList.add("ab-run-button");
    run.dataset.run = "start";
    this.actionsEl.append(run);
    if (verdict.reason) this.actionsEl.append(el("p", { className: "ab-run-reason", text: verdict.reason, attrs: { role: "status" } }));
    else this.actionsEl.append(el("p", { className: "ab-hint", text: "Run starts one bounded run of the signed package on the model this plan bound, in this browser. It spends real tokens, and it is re-verified before anything executes." }));
    if (this.startError) this.actionsEl.append(this.errorBanner(this.startError));
  }

  private errorBanner(error: ErrorBox): HTMLElement {
    return el("div", { className: "ab-banner ab-banner-bad", attrs: { role: "alert" } }, el("strong", { text: error.code }), " ", el("span", { text: error.message }));
  }

  private renderRun(): void {
    clear(this.runEl);
    this.elapsedEl = null;
    const record = this.run;
    this.root.dataset.state = record ? record.status : "idle";
    // Which run is shown, for a view's tests and the live harness (T5a): the state alone cannot tell two runs apart.
    if (record) this.root.dataset.runId = record.runId;
    else delete this.root.dataset.runId;
    if (!record) return;
    this.runEl.append(isTerminal(record) ? this.renderOutcome(record) : this.renderProgress(record));
  }

  private renderProgress(record: RunView): HTMLElement {
    const presentation = this.presentation();
    const node = el("div", { className: "ab-progress" });
    const elapsed = el("span", { className: "ab-elapsed", text: formatElapsed(this.elapsedMs(record)) });
    this.elapsedEl = elapsed;
    node.append(
      el(
        "div",
        { className: "ab-progress-head" },
        el("strong", { text: record.status === "preparing" ? "Preparing the run…" : record.cancelRequested ? "Cancelling — stopping workers and pending calls…" : (presentation?.task.running_label ?? "Running…") }),
        el("span", { className: "ab-muted", text: " elapsed " }),
        elapsed,
      ),
    );
    node.append(this.renderStages(record));
    node.append(this.renderCounters(record));
    return node;
  }

  private renderStages(record: RunView): HTMLElement {
    const loaded = this.host.loaded();
    const session = loaded && loaded.session.session.id === record.sessionId ? loaded.session : null;
    const presentation = presentationOf(session);
    const progress = record.progress ?? null;
    const nodes = graphNodes(session);
    let stages = stagesFor(nodes, presentation);
    if (stages.length === 0 && progress) {
      const seen = [...progress.completed_nodes, ...progress.active_nodes, ...progress.failed_nodes];
      stages = [...new Set(seen)].map((id) => ({ label: humanize(id), nodes: [id] }));
    }
    const labels = presentation?.nodes ?? {};
    const workers = progress?.workers ?? [];
    const mapNodes = new Set(nodes.filter((node) => node.type === "map").map((node) => node.id));
    const listNode = el("ol", { className: "ab-stages" });
    for (const stage of stages) {
      const states = stage.nodes.map((id) => nodeState(progress, id));
      let state: NodeState | "cancelled" = stageState(states);
      if (record.status === "cancelled" && state === "active") state = "cancelled";
      const line = el("li", { className: `ab-stage ab-stage-${state}` }, el("span", { className: "ab-stage-icon", text: STATUS_ICON[state] ?? "○" }), el("span", { className: "ab-stage-label", text: stage.label }));
      const skipped = stage.nodes.filter((id, index) => states[index] === "skipped");
      if (skipped.length > 0) line.append(el("span", { className: "ab-muted", text: ` · skipped: ${skipped.map((id) => labels[id] ?? humanize(id)).join(", ")} (nothing to work on)` }));
      const stageWorkers = workers.filter((worker) => worker.node && stage.nodes.includes(worker.node) && (mapNodes.size === 0 || mapNodes.has(worker.node)));
      if (stageWorkers.length > 0) {
        const chips = el("div", { className: "ab-workers" });
        stageWorkers.forEach((worker, index) => {
          const workerState = worker.state === "queued" ? "pending" : worker.state;
          chips.append(el("span", { className: `ab-worker ab-worker-${worker.state}`, text: `Worker ${index + 1} ${STATUS_ICON[workerState] ?? "○"}`, title: `${worker.id}${worker.role ? ` · ${worker.role}` : ""} · ${worker.state} · ${worker.model_calls} model call${worker.model_calls === 1 ? "" : "s"} · ${worker.tool_calls} tool call${worker.tool_calls === 1 ? "" : "s"}` }));
        });
        line.append(chips);
      }
      listNode.append(line);
    }
    return listNode;
  }

  private renderCounters(record: RunView): HTMLElement {
    const progress = record.progress ?? null;
    const usage = record.usage;
    const model = record.selectedModel;
    const localText = model?.local === true ? "Local" : model?.local === false ? "Hosted" : null;
    const modelCalls = progress ? progress.model_calls_completed : (record.audit?.modelCalls ?? 0);
    const toolCalls = progress ? progress.tool_calls_started : (usage?.toolCalls ?? 0);
    const tokens = usage?.tokens ?? progress?.tokens ?? 0;
    return definition([
      ["Model", model ? `${model.displayName || model.hostModelId}${localText ? ` · ${localText}` : ""} · ${model.hostModelId}` : "—"],
      ["Model calls", String(modelCalls)],
      ["Tool calls", String(toolCalls)],
      ["Remote calls", String(usage?.remoteCalls ?? progress?.remote_calls ?? 0)],
      ["Tokens", tokens.toLocaleString()],
      ["Workers", progress ? `${progress.workers_active} active · ${progress.workers_spawned} spawned · peak ${progress.peak_parallel_workers}` : "—"],
    ]);
  }

  private renderOutcome(record: RunView): HTMLElement {
    const presentation = this.presentation();
    const node = el("div", { className: "ab-outcome" });
    if (record.status === "completed") {
      node.append(el("div", { className: "ab-banner ab-banner-good ab-receipt-ok" }, el("strong", { text: `✓ ${presentation?.task.completed_label ?? "Run completed"}` }), el("p", { text: `Finished in ${formatElapsed(this.elapsedMs(record))}. Every result below was checked by the package's own validations before it was accepted.` })));
    } else {
      const failure = record.failure ?? null;
      const refusal = failure?.call?.action === "model.refused" ? (REFUSAL_WORDS[failure.call.reason ?? ""] ?? null) : failure?.call?.action === "model.failed" ? (MODEL_FAILURE_WORDS[failure.call.reason ?? ""] ?? null) : null;
      const known = refusal ?? RUN_ERRORS[record.errorCode ?? ""] ?? RUN_ERRORS[record.status] ?? null;
      const where = failure?.nodeId ? `Stopped at ${this.nodeWhere(record, failure.nodeId)}${failure.stepId ? ` / ${failure.stepId}` : ""}.` : null;
      const check = failure?.failedCheck && typeof failure.failedCheck === "object" ? Object.entries(failure.failedCheck as Record<string, unknown>).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ") : null;
      node.append(
        el(
          "div",
          { className: `ab-banner ${record.status === "cancelled" ? "ab-banner-warn" : "ab-banner-bad"}`, attrs: { role: "status" } },
          el("strong", { text: record.status === "cancelled" ? "Run cancelled" : (known?.title ?? "The run did not complete") }),
          record.errorCode ? el("span", { className: "ab-error-code", text: ` ${record.errorCode}` }) : null,
          el("p", { text: refusal?.detail ?? record.errorDetail ?? known?.detail ?? "" }),
          refusal && this.refusal?.runId === record.runId && this.refusal.figures ? el("p", { className: "ab-refusal-figures", text: this.refusal.figures }) : null,
          where ? el("p", { className: "ab-muted", text: where }) : null,
          check ? el("p", { className: "ab-muted", text: `Declared check: ${check}` }) : null,
          failure?.call ? el("p", { className: "ab-muted", text: `First failed call: ${failure.call.action}${failure.call.tool ? ` ${failure.call.tool}` : ""}${failure.call.reason ? ` — ${failure.call.reason}` : ""}` }) : null,
        ),
      );
    }
    const primary = this.primaryExport(record);
    if (primary) {
      const content = this.artifacts.get(primary);
      const section = el("section", { className: "ab-result" }, el("h3", { text: humanize(primary.replace(/\.[^.]+$/u, "")) }));
      if (!content) section.append(el("p", { className: "ab-hint", text: "Loading…" }));
      else if ("error" in content) section.append(el("p", { className: "ab-hint", text: content.error.message }));
      else {
        if (content.truncated) section.append(truncatedNote(content));
        if (primary.endsWith(".md")) section.append(renderMarkdown(content.text ?? ""));
        else section.append(el("pre", { className: "ab-pre", text: displayText(content) }));
      }
      node.append(section);
    }
    const summary = this.renderResultSummary(record);
    if (summary) node.append(summary);
    if (!primary && record.status === "completed") {
      const first = this.exportNames(record).find((name) => name.endsWith(".json"));
      const content = first ? this.artifacts.get(first) : undefined;
      if (first && content && !("error" in content)) node.append(el("section", { className: "ab-result" }, el("h3", { text: "Result" }), el("pre", { className: "ab-pre", text: displayText(content) })));
    }
    const stages = el("details", { className: "ab-details" });
    stages.append(el("summary", { text: "Stages and workers" }), this.renderStages(record), this.renderCounters(record));
    node.append(stages);
    node.append(this.renderArtifacts(record));
    node.append(this.renderTechnical(record));
    return node;
  }

  private exportNames(record: RunView): string[] {
    return record.artifacts.map((item) => item.name).filter((name) => !HOST_ARTIFACTS.has(name));
  }

  private primaryExport(record: RunView): string | null {
    const exports = this.exportNames(record);
    const hinted = this.presentation()?.result.primary_export ?? null;
    if (hinted && exports.includes(hinted)) return hinted;
    return exports.find((name) => name.endsWith(".md")) ?? null;
  }

  private summaryEntries(record: RunView): Array<{ label: string; export: string }> {
    const exports = this.exportNames(record);
    const hinted = (this.presentation()?.result.summary ?? []).filter((entry) => exports.includes(entry.export));
    if (hinted.length > 0) return hinted;
    return exports.filter((name) => name.endsWith(".json")).map((name) => ({ label: humanize(name.replace(/\.json$/u, "")), export: name }));
  }

  private resultArtifactNames(record: RunView): string[] {
    if (record.status !== "completed") return [];
    const names = new Set<string>();
    const primary = this.primaryExport(record);
    if (primary) names.add(primary);
    for (const entry of this.summaryEntries(record)) names.add(entry.export);
    if (!primary) {
      const first = this.exportNames(record).find((name) => name.endsWith(".json"));
      if (first) names.add(first);
    }
    return [...names];
  }

  private renderResultSummary(record: RunView): HTMLElement | null {
    if (record.status !== "completed") return null;
    const entries = this.summaryEntries(record);
    if (entries.length === 0) return null;
    const box = el("section", { className: "ab-result-summary" }, el("h3", { text: "Summary" }));
    const rows = el("dl", { className: "ab-defs" });
    for (const entry of entries) {
      const content = this.artifacts.get(entry.export);
      const value = content && !("error" in content) ? artifactJson(content) : undefined;
      const items = Array.isArray(value) ? (value as unknown[]) : null;
      rows.append(el("dt", { text: entry.label }), el("dd", { text: items ? String(items.length) : content ? "—" : "…" }));
      if (items && items.length > 0 && items.length <= 50) {
        const details = el("details", { className: "ab-summary-items" });
        details.append(el("summary", { text: `Show ${entry.label.toLowerCase()}` }));
        const listNode = el("ul", { className: "ab-list" });
        for (const item of items.slice(0, 25)) {
          const line = item && typeof item === "object" ? Object.entries(item as Record<string, unknown>).filter(([, v]) => typeof v === "string" || typeof v === "number").slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`).join(" · ") : String(item).slice(0, 300);
          listNode.append(el("li", { text: line || "(record)" }));
        }
        details.append(listNode);
        rows.append(el("dd", { className: "ab-summary-detail" }, details));
      }
    }
    box.append(rows);
    return box;
  }

  /**
   * The run's files, collapsed (F-13, D-112): a count of package exports and evidence files, then
   * Inspect (the per-file list with View and Download, closed by default) and Download (one zip of
   * every listed file). The result summary above is unaffected.
   */
  private renderArtifacts(record: RunView): HTMLElement {
    const { exports, evidence } = artifactGroups(record);
    const box = el("section", { className: "ab-artifacts" }, el("h3", { text: "Artifacts" }));
    const counts = [`${exports.length} package export${exports.length === 1 ? "" : "s"}`, `${evidence.length} evidence file${evidence.length === 1 ? "" : "s"}`].join(" · ");
    const inspect = button(this.inspecting ? "Hide files" : "Inspect", () => {
      this.inspecting = !this.inspecting;
      if (!this.inspecting) this.viewing = null;
      this.renderRun();
    });
    inspect.setAttribute("aria-expanded", this.inspecting ? "true" : "false");
    inspect.classList.add("ab-artifacts-inspect");
    const download = button("Download", () => void this.downloadAll());
    download.classList.add("ab-artifacts-download");
    box.append(el("div", { className: "ab-inline ab-artifacts-bar" }, el("span", { className: "ab-muted ab-artifacts-counts", text: counts }), inspect, download));
    if (this.downloadNote) box.append(el("p", { className: "ab-hint", text: this.downloadNote, attrs: { role: "status" } }));
    if (!this.inspecting) return box;
    const files = el("div", { className: "ab-artifact-files" });
    const row = (item: { name: string; bytes: number; sha256: string }) =>
      el("li", { className: "ab-artifact" }, el("code", { text: item.name }), item.bytes > 0 ? el("span", { className: "ab-muted", text: ` ${bytes(item.bytes)}` }) : null, button("View", () => void this.view(item.name)), button("Download", () => void this.download(item.name)));
    if (exports.length > 0) files.append(el("h4", { text: "Package exports" }), el("ul", { className: "ab-plain-list" }, ...exports.map(row)));
    else if (record.status === "completed") files.append(el("p", { className: "ab-hint", text: "This package declares no exports." }));
    else files.append(el("p", { className: "ab-hint", text: "A run that did not complete writes no package exports; its evidence is below." }));
    files.append(el("h4", { text: "Run evidence" }), el("ul", { className: "ab-plain-list" }, ...evidence.map(row)));
    if (this.viewing) {
      const content = this.artifacts.get(this.viewing);
      const viewer = el("div", { className: "ab-viewer" }, el("div", { className: "ab-inline" }, el("strong", { text: this.viewing }), button("Close", () => {
        this.viewing = null;
        this.renderRun();
      })));
      if (!content) viewer.append(el("p", { className: "ab-hint", text: "Loading…" }));
      else if ("error" in content) viewer.append(el("p", { className: "ab-hint", text: `${content.error.code}: ${content.error.message}` }));
      else {
        if (content.truncated) viewer.append(truncatedNote(content));
        if (this.viewing.endsWith(".md") && !content.truncated) viewer.append(renderMarkdown(content.text ?? ""));
        else viewer.append(el("pre", { className: "ab-pre", text: displayText(content) }));
        viewer.append(el("p", { className: "ab-muted", text: `sha256:${content.sha256}` }));
      }
      files.append(viewer);
    }
    box.append(files);
    return box;
  }

  private async view(name: string): Promise<void> {
    const record = this.run;
    if (!record) return;
    this.viewing = name;
    this.renderRun();
    await this.loadArtifact(record.runId, name);
    if (!this.disposed && this.viewing === name) this.renderRun();
  }

  private renderTechnical(record: RunView): HTMLElement {
    const details = el("details", { className: "ab-details ab-technical ab-run-technical" });
    details.append(el("summary", { text: "Technical details" }));
    const loaded = this.host.loaded();
    const provenance = loaded && loaded.session.session.id === record.sessionId ? (loaded.authorization?.receipt?.provenance ?? null) : null;
    const decidedBy = provenance ? `${provenance.profile_title ? `profile “${provenance.profile_title}”` : "your own settings"}, ${provenance.preset} preset` : record.profileId ? `profile ${record.profileId}` : "your own settings";
    const pairs: Array<[string, HTMLElement | string]> = [
      ["Run", el("code", { text: record.runId })],
      ["Package", `${record.package.packageId} ${record.package.version}`],
      ["Package digest", el("code", { text: record.package.digest })],
      ["Archive SHA-256", el("code", { text: record.package.archiveSha256 })],
      ["Execution profile", record.package.executionProfile],
      ["Run plan", el("code", { text: record.runPlanId })],
      ["Run plan hash", el("code", { text: `sha256:${record.runPlanSha256}` })],
      ["Run invocation", el("code", { text: record.runInvocationSha256 ? `sha256:${record.runInvocationSha256}` : "—" })],
      ["Task input", el("code", { text: record.inputSha256 ? `sha256:${record.inputSha256}` : "—" })],
      ["Model", record.selectedModel ? `${record.selectedModel.hostModelId} (${record.selectedModel.providerId})${record.model ? ` · ${record.model.calls} calls · ${record.model.allCallsUsedPlannedModel ? "every call used the planned model" : `invoked: ${record.model.invoked.join(", ") || "none"}`}` : ""}` : "—"],
      ["Tools", record.tools.length > 0 ? record.tools.map((tool) => `${tool.toolId} → ${tool.displayName ?? tool.bindingId} (${tool.remote ? "remote" : "local"}, ${tool.calls} calls, binding sha256:${shortHash(tool.bindingSha256)})`).join(" · ") : "none"],
      ["Permissions", record.grants.decisions.map((item) => `${item.permissionId}=${item.decision}`).join(" · ") || "—"],
      ["Decided by", decidedBy],
      ["Your data", record.resources.length > 0 ? record.resources.map((grant) => `${grant.permissionId} → ${grant.resourceId} (${shortHash(grant.resourceDigest)})`).join(" · ") : "none"],
      ["Usage", record.usage ? `${record.usage.tokens.toLocaleString()} tokens of ${record.usage.limits.hardTokens.toLocaleString()} · ${record.usage.remoteCalls} remote calls · ${record.usage.toolCalls} tool calls · peak ${record.usage.peakParallelWorkers} workers` : "—"],
      ["Cost", record.cost ? (record.cost.totalUsd === null ? `not reported (${record.cost.status})` : `$${record.cost.totalUsd} (${record.cost.status}; ${record.cost.callsWithReportedCost} of ${record.cost.calls} calls reported a cost)`) : "—"],
      ["Audit", record.audit ? `${record.audit.events} events · chain ${record.audit.chainValid ? "valid" : "INVALID"} · final sha256:${shortHash(record.audit.finalHash ?? "")}` : "—"],
      ["Workers", record.audit ? `${record.audit.workersSpawned} spawned · ${record.audit.nodesCompleted} nodes completed` : "—"],
      ["Started", whenText(record.startedAt ?? record.createdAt)],
      ["Ended", record.endedAt ? whenText(record.endedAt) : "—"],
      ["Duration", record.durationMs === null ? "—" : formatElapsed(record.durationMs)],
      ["Deadline", record.limits.effectiveDeadlineSeconds === null ? "—" : `${record.limits.effectiveDeadlineSeconds}s effective`],
      ["Host", `${record.host.runtime} ${record.host.runtimeVersion ?? "?"}${record.host.versionVerified ? " (verified)" : ""}`],
      ["Re-verified before start", record.revalidated.join(", ") || "—"],
    ];
    details.append(definition(pairs));
    const workers = record.progress?.workers ?? [];
    if (workers.length > 0) {
      const table = el("table", { className: "ab-table" });
      table.append(el("tr", {}, ...["Worker", "Role", "Node", "State", "Duration", "Model calls", "Tool calls"].map((head) => el("th", { text: head }))));
      for (const worker of workers) {
        table.append(el("tr", {}, el("td", {}, el("code", { text: worker.id })), el("td", { text: worker.role ?? "—" }), el("td", { text: worker.node ?? "—" }), el("td", { text: worker.state }), el("td", { text: worker.duration_ms === null ? "—" : formatElapsed(worker.duration_ms) }), el("td", { text: String(worker.model_calls) }), el("td", { text: String(worker.tool_calls) })));
      }
      details.append(el("h4", { text: "Workers" }), table);
    }
    return details;
  }

  private renderHistory(): void {
    clear(this.historyEl);
    const others = this.history.filter((item) => item.runId !== this.run?.runId);
    if (others.length === 0) return;
    const details = el("details", { className: "ab-details" });
    details.append(el("summary", { text: `Earlier runs of this agent (${others.length})` }));
    details.append(renderRunList(others.slice(0, 16), { open: (runId) => void this.openRun(runId) }));
    this.historyEl.append(details);
  }
}

/** A compact list of run records with an Open action each, and optional Export and Clear. */
export function renderRunList(runs: readonly RunSummary[], actions: { open: (runId: string) => void; export?: (runId: string) => void; clear?: (runId: string) => void }): HTMLElement {
  const listNode = el("ul", { className: "ab-plain-list ab-run-list" });
  for (const record of runs) {
    const meta = [whenText(record.createdAt), record.durationMs !== null ? formatElapsed(record.durationMs) : null, record.selectedModel].filter((part): part is string => Boolean(part)).join(" · ");
    const item = el("li", { className: "ab-run-row", attrs: { "data-run": record.runId } });
    item.append(
      el(
        "div",
        { className: "ab-run-row-main" },
        chip(humanize(record.status), record.status === "completed" ? "good" : record.status === "failed" || record.status === "interrupted" ? "bad" : record.status === "cancelled" ? "warn" : "neutral"),
        el("strong", { text: `${record.package.name || record.package.packageId} ${record.package.version}` }),
        el("span", { className: "ab-muted", text: meta }),
        button("Open", () => actions.open(record.runId)),
        actions.export && TERMINAL.has(record.status) ? button("Export", () => actions.export!(record.runId)) : null,
        actions.clear && TERMINAL.has(record.status) ? button("Clear", () => actions.clear!(record.runId), { variant: "danger" }) : null,
      ),
    );
    if (record.taskText) item.append(el("div", { className: "ab-run-row-task ab-muted", text: `“${record.taskText.slice(0, 140)}${record.taskText.length > 140 ? "…" : ""}”` }));
    listNode.append(item);
  }
  return listNode;
}
