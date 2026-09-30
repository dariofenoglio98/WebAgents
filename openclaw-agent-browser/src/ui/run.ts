/**
 * The Run surface: task in, one bounded run, result out.
 *
 * This is the page's only way to execute anything, and it adds no authority
 * of its own. The Run action is offered only when the backend's own preflight
 * (`execution.readiness`) and the package's own input schema
 * (`execution.validate-input`) both say yes for exactly the plan and the task
 * on screen, and `execution.start` re-verifies all of it again before a token
 * is spent. What the page sends is the task and nothing else: the model, the
 * tool bindings, the permissions and the package all come from the run plan.
 *
 * Every Run is a new Run Invocation. Nothing from an earlier run's output is
 * carried into the next one: the form keeps the person's own words, and a
 * follow-up question is simply another run.
 *
 * Progress is read, never inferred: stages, workers and counters are the
 * runner's snapshot of its own audit. Package-provided labels are cosmetic
 * text, rendered with `textContent` like everything else a package wrote.
 */
import type {
  FeatureErrorView,
  FileCapabilityViewType,
  InputValidationViewType,
  ModelCatalogViewType,
  PackageViewType,
  PermissionsViewType,
  PresentationViewType,
  ReceiptViewType,
  RunArtifactChunkViewType,
  RunArtifactContentViewType,
  RunPlanStateViewType,
  RunProgressViewType,
  RunReadinessViewType,
  RunRecordViewType,
  RunSummaryViewType,
  ServiceStatusView,
  ToolRegistryViewType,
} from "../contract.js";
import { runSummary, taskText } from "../contract.js";
import { bytes, button, chip, clear, definition, el, shortHash, whenText } from "./dom.js";
import { TaskForm, buildFormModel } from "./form.js";
import { renderMarkdown } from "./markdown.js";

type Result<T> = { ok: true; value: T } | { ok: false; error: FeatureErrorView };

export type LoadedSession = {
  pkg: PackageViewType;
  permissions: PermissionsViewType;
  receipt: ReceiptViewType | null;
  models: ModelCatalogViewType | null;
  tools: ToolRegistryViewType | null;
  runPlan: RunPlanStateViewType | null;
};

export type RunPanelHost = {
  call: <T>(operation: string, input: unknown) => Promise<T>;
  alive: () => boolean;
  canWrite: boolean;
  service: () => ServiceStatusView | null;
  loaded: () => LoadedSession | null;
  /** The page's own sections, so a checklist item can send the person there. */
  reveal?: (section: "trust" | "permissions" | "authorization" | "model" | "run-plan") => void;
  /** Something changed that the session tabs or other cards should re-read. */
  changed?: () => void;
};

export const HOST_ARTIFACTS = new Set(["result.json", "audit.json", "usage.json", "provenance.json", "run.json"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 2000;
const READINESS_MS = 30_000;
const VALIDATE_DEBOUNCE_MS = 350;
/** Enough 48 KiB slices for the largest artifact the backend serves (64 MiB). */
const MAX_CHUNKS = 1366;

/** Stable, human wording for the codes a run can end with. Codes are shown too. */
const RUN_ERRORS: Record<string, { title: string; detail: string }> = {
  timeout: {
    title: "The run reached its deadline",
    detail: "A declared node, step or whole-run deadline elapsed before the run finished.",
  },
  schema_validation: {
    title: "A package check refused the result",
    detail: "One of the package's own validations did not hold, so no result was accepted.",
  },
  tool_error: { title: "A tool failed", detail: "A host tool reported an operational error." },
  model_error: { title: "The model call failed", detail: "The bound model did not return a usable answer." },
  permission_denied: {
    title: "A permission was denied during the run",
    detail: "The package asked for something this authorization does not allow, and was refused.",
  },
  budget_exhausted: {
    title: "A budget limit was reached",
    detail: "A token, call or tool limit stopped the run before it could continue.",
  },
  worker_error: { title: "A worker failed unexpectedly", detail: "The interpreter reported a worker error." },
  cancelled: { title: "Run cancelled", detail: "The run was stopped on request." },
  gateway_stopped: {
    title: "The Gateway stopped during the run",
    detail: "Run state is not resumable; an interrupted run ends rather than continuing.",
  },
};

const STATUS_ICON: Record<string, string> = {
  completed: "✓",
  active: "●",
  pending: "○",
  failed: "✗",
  skipped: "–",
  cancelled: "⊘",
  queued: "○",
};

function humanize(value: string): string {
  const words = value.replace(/[._-]+/gu, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
}

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

function isTerminal(record: RunRecordViewType | null): boolean {
  return Boolean(record && TERMINAL.has(record.status));
}

type Stage = { label: string; nodes: string[] };

/** The package's stage grouping, or one derived generically from its graph. */
export function stagesFor(pkg: PackageViewType | null, presentation: PresentationViewType | null): Stage[] {
  const nodes = pkg?.workflow.nodes ?? [];
  if (presentation && presentation.stages.length > 0) {
    const known = new Set(nodes.map((node) => node.id));
    const stages = presentation.stages
      .map((stage) => ({ label: stage.label, nodes: stage.nodes.filter((id) => known.size === 0 || known.has(id)) }))
      .filter((stage) => stage.nodes.length > 0);
    const staged = new Set(stages.flatMap((stage) => stage.nodes));
    const rest = nodes.filter((node) => !staged.has(node.id)).map((node) => node.id);
    if (rest.length > 0) stages.push({ label: "Other steps", nodes: rest });
    return stages;
  }
  // Generic: each model, tool or map node starts a stage; the structural
  // nodes that follow it (joins, checks, output) belong to it.
  const labels = new Map((presentation?.nodes ?? []).map((item) => [item.nodeId, item.label]));
  const stages: Stage[] = [];
  for (const node of nodes) {
    const effectful = node.type === "llm" || node.type === "tool" || node.type === "map";
    if (effectful || stages.length === 0) {
      stages.push({ label: labels.get(node.id) ?? humanize(node.id), nodes: [node.id] });
    } else {
      stages[stages.length - 1]!.nodes.push(node.id);
    }
  }
  return stages;
}

type NodeState = "completed" | "active" | "pending" | "failed" | "skipped";

function nodeState(progress: RunProgressViewType | null | undefined, node: string, finished: boolean): NodeState {
  if (!progress) return "pending";
  if (progress.failedNodes.includes(node)) return "failed";
  if ((progress.skippedNodes ?? []).includes(node)) return "skipped";
  if (progress.activeNodes.includes(node)) return "active";
  if (progress.completedNodes.includes(node)) return "completed";
  return finished ? "pending" : "pending";
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

function mimeFor(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".bib")) return "application/x-bibtex";
  return "text/plain";
}

async function sha256Hex(data: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", await data.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * A JSON artifact's value: parsed by the host when it was small enough to
 * send parsed, or parsed here from complete text when its shape was too
 * large for the host's limits. A truncated view has no value.
 */
function artifactJson(content: RunArtifactContentViewType): unknown {
  if (content.json !== undefined) return content.json;
  if (content.truncated || !content.name.endsWith(".json") || typeof content.text !== "string") return undefined;
  try {
    return JSON.parse(content.text) as unknown;
  } catch {
    return undefined;
  }
}

/** An artifact as plain text for a <pre>: JSON pretty-printed when it is whole. */
function displayText(content: RunArtifactContentViewType): string {
  const value = artifactJson(content);
  return value !== undefined ? JSON.stringify(value, null, 2) : content.text ?? "";
}

function truncatedNote(content: RunArtifactContentViewType): HTMLElement {
  return el("p", {
    className: "ab-hint",
    text: `Showing the first ${bytes(content.shownBytes ?? new TextEncoder().encode(content.text ?? "").byteLength)} of ${bytes(content.bytes)}. Download has the whole file, verified.`,
  });
}

function fileIdsIn(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32) return found;
  if (typeof value === "string") {
    if (/^file_[0-9a-f]{32}$/u.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) fileIdsIn(item, found, depth + 1);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) fileIdsIn(item, found, depth + 1);
  }
  return found;
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
  /** The session whose latest run was already adopted once after attaching. */
  private adoptedFor: string | null = null;
  private form: TaskForm | null = null;
  private formKey = "";
  private taskValue: unknown = undefined;
  private localErrors: ReadonlyMap<string, string> = new Map();
  private validation: {
    key: string;
    state: "idle" | "checking" | "valid" | "invalid" | "error";
    report: InputValidationViewType | null;
  } = { key: "", state: "idle", report: null };
  private readiness: RunReadinessViewType | null = null;
  private readinessFor = "";
  private files: FileCapabilityViewType[] = [];
  private run: RunRecordViewType | null = null;
  private history: RunSummaryViewType[] = [];
  private starting = false;
  private cancelling = false;
  private startError: FeatureErrorView | null = null;
  private artifacts = new Map<string, RunArtifactContentViewType | { error: FeatureErrorView }>();
  private viewing: string | null = null;
  private downloadNote: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readinessTimer: ReturnType<typeof setInterval> | null = null;
  private validateTimer: ReturnType<typeof setTimeout> | null = null;
  private elapsedEl: HTMLElement | null = null;
  private disposed = false;

  constructor(private readonly host: RunPanelHost) {
    this.root = el(
      "section",
      { className: "ab-card ab-run", attrs: { "aria-label": "Run" } },
      this.headEl,
      this.checklistEl,
      this.formHost,
      this.summaryEl,
      this.actionsEl,
      this.runEl,
      this.historyEl,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
  }

  private alive(): boolean {
    return !this.disposed && this.host.alive();
  }

  private stopTimers(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.readinessTimer) clearInterval(this.readinessTimer);
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.pollTimer = this.tickTimer = this.readinessTimer = this.validateTimer = null;
  }

  // -- lifecycle ---------------------------------------------------------------
  /** A package session was opened or re-read. */
  async attachSession(sessionId: string): Promise<void> {
    if (this.sessionId !== sessionId) {
      this.stopTimers();
      this.sessionId = sessionId;
      this.form = null;
      this.formKey = "";
      this.taskValue = undefined;
      this.validation = { key: "", state: "idle", report: null };
      this.readiness = null;
      this.readinessFor = "";
      this.run = null;
      this.history = [];
      this.artifacts = new Map();
      this.viewing = null;
      this.startError = null;
      this.files = [];
      this.adoptedFor = null;
    }
    this.render();
    await Promise.all([this.loadFiles(), this.loadHistory(true)]);
    if (!this.alive() || this.sessionId !== sessionId) return;
    this.render();
    void this.refreshReadiness();
    if (!this.readinessTimer) {
      this.readinessTimer = setInterval(() => {
        if (!isTerminal(this.run) && this.run) return;
        void this.refreshReadiness();
      }, READINESS_MS);
    }
  }

  /** Show one run by id, with or without its package session still open. */
  async openRun(runId: string): Promise<void> {
    const result = await this.host.call<Result<RunRecordViewType | null>>("execution.get", { runId }).catch(() => null);
    if (!this.alive()) return;
    if (!result || !result.ok || !result.value) {
      this.startError = result && !result.ok ? result.error : {
        code: "execution_unknown",
        title: "No such run",
        detail: "This backend holds no run with that id.",
        retryable: false,
      };
      this.render();
      return;
    }
    if (result.value.sessionId !== this.sessionId) {
      this.stopTimers();
      this.sessionId = null;
      this.form = null;
      this.formKey = "";
    }
    this.show(result.value);
  }

  /** Detach from any session: the page closed it or opened another view. */
  detach(): void {
    this.stopTimers();
    this.sessionId = null;
    this.form = null;
    this.formKey = "";
    this.run = null;
    this.history = [];
    this.readiness = null;
    this.render();
  }

  /** The page's loaded state changed (authorization, model, plan, tools). */
  sync(): void {
    const plan = this.host.loaded()?.runPlan?.plan ?? null;
    const key = plan ? `${plan.runPlanId}:${plan.runPlanSha256}` : "";
    this.render();
    if (key !== this.readinessFor) void this.refreshReadiness();
  }

  hasSession(): boolean {
    return this.sessionId !== null;
  }

  currentRun(): RunRecordViewType | null {
    return this.run;
  }

  // -- data ----------------------------------------------------------------------
  private async loadFiles(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const result = await this.host
      .call<Result<{ files: FileCapabilityViewType[] }>>("files.list", { sessionId })
      .catch(() => null);
    if (!this.alive() || sessionId !== this.sessionId) return;
    this.files = result && result.ok ? result.value.files : [];
    this.form?.refreshFiles();
  }

  private async loadHistory(adopt: boolean): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const result = await this.host
      .call<Result<{ runs: RunSummaryViewType[]; active: RunRecordViewType | null }>>("execution.status", {
        sessionId,
      })
      .catch(() => null);
    if (!this.alive() || sessionId !== this.sessionId || !result || !result.ok) return;
    this.history = [...result.value.runs].reverse();
    if (adopt && !this.run && this.adoptedFor !== sessionId) {
      // Reconnect once per attach: an active run first, otherwise the most
      // recent one. Afterwards "New run" is the person's choice to keep.
      this.adoptedFor = sessionId;
      if (result.value.active) this.show(result.value.active);
      // A list carries summaries; the record itself is one read away.
      else if (this.history[0]) await this.openRun(this.history[0].runId);
    } else if (
      result.value.active &&
      result.value.active.runId !== this.run?.runId &&
      (!this.run || isTerminal(this.run))
    ) {
      // A different run started elsewhere for this session is always shown.
      this.show(result.value.active);
    }
    this.renderHistory();
  }

  private async refreshReadiness(): Promise<void> {
    const sessionId = this.sessionId;
    const plan = this.host.loaded()?.runPlan?.plan ?? null;
    if (!sessionId || !plan || plan.execution.mode !== "model") {
      this.readiness = null;
      this.readinessFor = "";
      this.renderActions();
      return;
    }
    const key = `${plan.runPlanId}:${plan.runPlanSha256}`;
    const result = await this.host
      .call<Result<RunReadinessViewType>>("execution.readiness", { sessionId })
      .catch(() => null);
    if (!this.alive() || sessionId !== this.sessionId) return;
    this.readinessFor = key;
    this.readiness = result && result.ok ? result.value : null;
    if (result && !result.ok) {
      this.readiness = {
        sessionId,
        checkedAt: new Date().toISOString(),
        ready: false,
        executionAvailable: false,
        runPlanId: null,
        runPlanSha256: null,
        blocker: { code: result.error.code, title: result.error.title, detail: result.error.detail },
        checks: [],
        receipt: null,
        activeRunId: null,
      };
    }
    this.renderChecklist();
    this.renderActions();
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
    const result = await this.host
      .call<Result<InputValidationViewType>>("execution.validate-input", { sessionId, input: this.taskValue })
      .catch(() => null);
    if (!this.alive() || sessionId !== this.sessionId) return;
    if (key !== JSON.stringify(this.taskValue ?? null)) return; // A newer edit is pending.
    if (!result || !result.ok) {
      this.validation = { key, state: "error", report: null };
    } else {
      this.validation = { key, state: result.value.valid ? "valid" : "invalid", report: result.value };
      this.form?.showErrors(result.value.errors);
    }
    this.renderChecklist();
    this.renderActions();
  }

  // -- the run -------------------------------------------------------------------
  private show(record: RunRecordViewType): void {
    this.run = record;
    this.artifacts = new Map();
    this.viewing = null;
    this.downloadNote = null;
    this.render();
    if (isTerminal(record)) {
      void this.loadResult(record);
    } else {
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), 1000);
    }
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private tick(): void {
    if (!this.elapsedEl || !this.run || isTerminal(this.run)) return;
    this.elapsedEl.textContent = formatElapsed(this.elapsedMs(this.run));
  }

  private elapsedMs(record: RunRecordViewType): number {
    if (record.durationMs !== null && isTerminal(record)) return record.durationMs;
    const started = Date.parse(record.startedAt ?? record.createdAt);
    return Number.isFinite(started) ? Date.now() - started : record.progress?.elapsedMs ?? 0;
  }

  private async poll(): Promise<void> {
    const current = this.run;
    if (!current || !this.alive()) return;
    const result = await this.host
      .call<Result<RunRecordViewType | null>>("execution.get", { runId: current.runId })
      .catch(() => null);
    if (!this.alive() || this.run?.runId !== current.runId) return;
    if (result && result.ok && result.value) {
      this.run = result.value;
      if (isTerminal(result.value)) {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = null;
        this.cancelling = false;
        this.render();
        void this.loadResult(result.value);
        void this.loadHistory(false);
        void this.refreshReadiness();
        this.host.changed?.();
        return;
      }
      this.renderRun();
      this.renderActions();
    }
    // A failed poll says nothing about a detached run; keep watching.
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private async startRun(): Promise<void> {
    const loaded = this.host.loaded();
    const plan = loaded?.runPlan?.plan;
    const sessionId = this.sessionId;
    if (!loaded || !plan || !sessionId || !this.canRun().enabled) return;
    this.starting = true;
    this.startError = null;
    this.renderActions();
    const input = structuredClone(this.taskValue);
    const files = [...fileIdsIn(input)].filter((id) => this.files.some((file) => file.fileId === id));
    const result = await this.host
      .call<Result<RunRecordViewType>>("execution.start", {
        sessionId,
        runPlanId: plan.runPlanId,
        runPlanSha256: plan.runPlanSha256,
        input,
        ...(files.length > 0 ? { files } : {}),
        detach: true,
      })
      .catch(() => null);
    if (!this.alive()) return;
    this.starting = false;
    if (!result || !result.ok) {
      this.startError = result
        ? result.error
        : {
            code: "control_plane_error",
            title: "The run could not be started",
            detail: "The Agent Browser backend did not answer.",
            retryable: true,
          };
      this.render();
      void this.refreshReadiness();
      return;
    }
    this.history = [runSummary(result.value), ...this.history.filter((item) => item.runId !== result.value.runId)];
    this.show(result.value);
    this.host.changed?.();
  }

  private async cancelRun(): Promise<void> {
    const current = this.run;
    if (!current || isTerminal(current) || !this.host.canWrite) return;
    this.cancelling = true;
    this.renderActions();
    const result = await this.host
      .call<Result<RunRecordViewType>>("execution.cancel", { runId: current.runId })
      .catch(() => null);
    if (!this.alive()) return;
    if (result && result.ok && this.run?.runId === result.value.runId) this.run = result.value;
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

  private async loadResult(record: RunRecordViewType): Promise<void> {
    const names = this.resultArtifactNames(record);
    await Promise.all(names.map((name) => this.loadArtifact(record.runId, name)));
    if (!this.alive() || this.run?.runId !== record.runId) return;
    this.renderRun();
  }

  private async loadArtifact(runId: string, name: string): Promise<void> {
    if (this.artifacts.has(name)) return;
    const result = await this.host
      .call<Result<RunArtifactContentViewType>>("execution.artifact", { runId, name })
      .catch(() => null);
    if (this.run?.runId !== runId) return;
    this.artifacts.set(
      name,
      result && result.ok
        ? result.value
        : {
            error: result && !result.ok
              ? result.error
              : { code: "control_plane_error", title: "Artifact unavailable", detail: "No answer.", retryable: true },
          },
    );
  }

  private async download(name: string): Promise<void> {
    const record = this.run;
    if (!record) return;
    this.downloadNote = `Downloading ${name}…`;
    this.renderRun();
    try {
      const parts: Uint8Array[] = [];
      let offset = 0;
      let expected = "";
      let complete = false;
      for (let index = 0; index < MAX_CHUNKS; index += 1) {
        const result = await this.host.call<Result<RunArtifactChunkViewType>>("execution.artifact-chunk", {
          runId: record.runId,
          name,
          offset,
        });
        if (!result.ok) throw new Error(`${result.error.title}: ${result.error.detail}`);
        const chunk = base64Bytes(result.value.base64);
        parts.push(chunk);
        offset += chunk.length;
        expected = result.value.sha256;
        if (result.value.eof || chunk.length === 0) {
          complete = result.value.eof;
          break;
        }
      }
      if (!complete) throw new Error("The artifact is larger than this page downloads.");
      const blob = new Blob(parts as BlobPart[], { type: mimeFor(name) });
      const actual = await sha256Hex(blob).catch(() => null);
      if (actual && actual !== expected) throw new Error("The downloaded bytes do not match the artifact's SHA-256.");
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
      this.downloadNote = actual
        ? `Saved ${name} (${bytes(blob.size)}, SHA-256 verified).`
        : `Saved ${name} (${bytes(blob.size)}).`;
    } catch (error) {
      this.downloadNote = `Download failed: ${(error as Error).message}`;
    }
    if (this.alive()) this.renderRun();
  }

  // -- readiness -----------------------------------------------------------------
  private filePermissionIds(loaded: LoadedSession): string[] {
    return loaded.permissions.permissions.filter((item) => item.kind === "files.read").map((item) => item.id);
  }

  /** Whether Run may be pressed, and the precise reason when it may not. */
  canRun(): { enabled: boolean; reason: string | null } {
    const loaded = this.host.loaded();
    const service = this.host.service();
    const refuse = (reason: string) => ({ enabled: false, reason });
    if (!this.host.canWrite) return refuse("Operator write access is required to run a package.");
    if (!loaded || !this.sessionId) return refuse("Open a package first.");
    if (this.run && !isTerminal(this.run)) return refuse("A run is in progress.");
    if (this.starting) return refuse("Starting the run…");
    if (!service?.executionSupported) {
      return refuse(
        "This host cannot run packages: the Agent Browser has no access to the OpenClaw completion runtime.",
      );
    }
    const first = this.checklist(loaded).find((item) => !item.ok);
    if (first) return refuse(first.reason ?? first.label);
    const plan = loaded.runPlan?.plan;
    if (!this.readiness || this.readinessFor !== `${plan?.runPlanId}:${plan?.runPlanSha256}`) {
      return refuse("Checking that the run plan is still current…");
    }
    if (!this.readiness.ready) {
      const blocker = this.readiness.blocker;
      return refuse(blocker ? `${blocker.title}. ${blocker.detail}` : "The preflight refused this plan.");
    }
    if (this.readiness.runPlanSha256 !== plan?.runPlanSha256) return refuse("The run plan changed; re-checking…");
    const localError = [...this.localErrors.values()][0];
    if (localError) return refuse(localError);
    const key = JSON.stringify(this.taskValue ?? null);
    if (this.validation.key !== key || this.validation.state === "checking" || this.validation.state === "idle") {
      return refuse("Checking the task against the package's input schema…");
    }
    if (this.validation.state === "error") return refuse("The task could not be checked. Try again.");
    if (this.validation.state === "invalid") {
      const error = this.validation.report?.errors[0];
      return refuse(
        error ? `The task is not valid: ${error.pointer || "task"} ${error.message}.` : "The task is not valid.",
      );
    }
    const referenced = fileIdsIn(this.taskValue);
    if (referenced.size > 0) {
      const granted = new Set(loaded.receipt?.grantedPermissionIds ?? []);
      const needed = this.filePermissionIds(loaded).filter((id) => !granted.has(id));
      if (needed.length > 0) {
        return refuse(
          `Documents need the ${needed.join(", ")} permission, which this authorization denies. ` +
            "Allow it under Permissions, authorize again and prepare a new run plan — or remove the documents.",
        );
      }
    }
    return { enabled: true, reason: null };
  }

  private checklist(loaded: LoadedSession) {
    const { pkg, receipt, runPlan, tools } = loaded;
    const layers = [pkg.validation.container, pkg.validation.integrity, pkg.validation.schema];
    const plan = runPlan?.plan ?? null;
    const preflight = runPlan?.preflight ?? null;
    const items: Array<{ id: string; label: string; ok: boolean; reason: string | null; section?: string }> = [
      {
        id: "verified",
        label: "Package verified",
        ok:
          layers.every((layer) => layer === "valid") &&
          pkg.validation.runtime === "compatible" &&
          pkg.publisher.signatureStatus === "valid",
        reason: "The package did not pass verification, so it cannot run.",
        section: "trust",
      },
      {
        id: "trusted",
        label: "Publisher trusted",
        ok: pkg.publisher.trustStatus === "trusted",
        reason:
          pkg.publisher.trustStatus === "mismatch"
            ? "The claimed publisher is pinned to a different key. Treat this package as an impersonation risk."
            : "The signing key is not pinned on this host. Review it under Verification and trust.",
        section: "trust",
      },
      {
        id: "authorized",
        label: "Permissions authorized",
        ok: Boolean(receipt?.runnable),
        reason: receipt
          ? "The current decisions do not make this package runnable. Adjust them and authorize again."
          : "Set each permission and approve each tool, then Authorize.",
        section: "authorization",
      },
      {
        id: "tools",
        label:
          pkg.tools.length > 0
            ? `Tools bound (${plan?.toolBindings.length ?? tools?.counts.bound ?? 0} of ${pkg.tools.length})`
            : "No tools declared",
        ok:
          pkg.tools.length === 0 ||
          (Boolean(plan) && preflight?.toolBindingsCurrent !== false && plan!.toolBindings.length === pkg.tools.length),
        reason: plan
          ? "A tool implementation changed or disappeared after the plan was prepared. Prepare a new run plan."
          : "Every declared tool needs a host implementation and your approval before a plan can bind it.",
        section: "model",
      },
      {
        id: "model",
        label: plan?.modelBinding ? `Model: ${plan.modelBinding.displayName}` : "Model selected",
        ok: Boolean(plan?.modelBinding) && preflight?.modelStillAvailable !== false,
        reason: plan?.modelBinding
          ? "The selected model is no longer offered by this host. Choose another and prepare a new plan."
          : "Choose one of this host's compatible models and prepare a run plan.",
        section: "model",
      },
      {
        id: "plan",
        label: "Run plan ready",
        ok: Boolean(plan) && preflight?.ready === true && preflight?.stale !== true && plan!.execution.mode === "model",
        reason: !plan
          ? "Prepare a run plan in the Model section."
          : preflight?.stale
            ? `The run plan is stale: ${preflight.staleReasons[0]?.message ?? "prepare a new one."}`
            : plan.execution.mode !== "model"
              ? "This plan is authority for one tool probe, not for a run."
              : "The run plan is not ready.",
        section: "run-plan",
      },
    ];
    const key = JSON.stringify(this.taskValue ?? null);
    const local = [...this.localErrors.values()][0];
    items.push({
      id: "task",
      label: "Task valid",
      ok: !local && this.validation.key === key && this.validation.state === "valid",
      reason: local
        ? local
        : this.validation.state === "invalid"
          ? this.invalidReason()
          : "Checking the task against the package's input schema…",
    });
    return items;
  }

  /** The first of the schema's verdicts, naming the field by its label. */
  private invalidReason(): string {
    const report = this.validation.report;
    const first = report?.errors[0];
    if (!first) return "The task does not satisfy the package's input schema.";
    const subject = this.form ? this.form.labelFor(first.pointer) : first.pointer || "The task";
    const more = report.errorCount > 1 ? ` (${report.errorCount - 1} more)` : "";
    return `${subject} ${first.message}${more}.`;
  }

  // -- rendering -----------------------------------------------------------------
  render(): void {
    this.renderHead();
    this.renderChecklist();
    this.renderForm();
    this.renderSummary();
    this.renderActions();
    this.renderRun();
    this.renderHistory();
  }

  private presentation(): PresentationViewType | null {
    return this.host.loaded()?.pkg.workflow.presentation ?? null;
  }

  /**
   * A node as the package's validated hints name it, with its id kept for
   * precision: "Deduplicate candidates (normalize), in Screening".
   */
  private nodeWhere(record: RunRecordViewType, nodeId: string): string {
    const loaded = this.host.loaded();
    const pkg = loaded && loaded.pkg.sessionId === record.sessionId ? loaded.pkg : null;
    const presentation = pkg?.workflow.presentation ?? null;
    const label = presentation?.nodes.find((item) => item.nodeId === nodeId)?.label ?? null;
    const stage = stagesFor(pkg, presentation).find((item) => item.nodes.includes(nodeId))?.label ?? null;
    const named = label && label !== nodeId ? `${label} (${nodeId})` : nodeId;
    return stage && stage !== label ? `${named}, in ${stage}` : named;
  }

  private renderHead(): void {
    clear(this.headEl);
    const loaded = this.host.loaded();
    const record = this.run;
    const pkg = loaded?.pkg ?? null;
    const name = pkg?.identity.name ?? record?.package.name ?? "Run";
    const version = pkg?.identity.version ?? record?.package.version ?? "";
    this.headEl.append(
      el(
        "div",
        { className: "ab-run-title" },
        el("h2", { className: "ab-card-title", text: `${name}${version ? ` ${version}` : ""}` }),
        record ? chip(record.status === "running" ? "Running" : humanize(record.status), this.statusTone(record.status)) : null,
        record?.origin === "recovered" ? chip("From a previous Gateway session") : null,
      ),
    );
    const task = record ? taskText(record.task?.input) : null;
    if (task) {
      this.headEl.append(
        el("p", { className: "ab-run-task", text: `“${task.slice(0, 400)}${task.length > 400 ? "…" : ""}”` }),
      );
    }
    if (!loaded && record) {
      this.headEl.append(
        el("p", {
          className: "ab-hint",
          text: "This run's package session is no longer open. Its record and artifacts remain available here.",
        }),
      );
    }
  }

  private statusTone(status: string): "good" | "warn" | "bad" | "neutral" {
    if (status === "completed") return "good";
    if (status === "failed") return "bad";
    if (status === "cancelled") return "warn";
    return "neutral";
  }

  private showingForm(): boolean {
    const loaded = this.host.loaded();
    return Boolean(loaded && this.sessionId && loaded.pkg.sessionId === this.sessionId && !this.run);
  }

  private renderChecklist(): void {
    clear(this.checklistEl);
    const loaded = this.host.loaded();
    if (!loaded || !this.showingForm()) return;
    const items = this.checklist(loaded);
    const listNode = el("ul", { className: "ab-checklist" });
    for (const item of items) {
      const line = el(
        "li",
        { className: `ab-check-${item.ok ? "ok" : "no"}` },
        el("span", { className: "ab-check-icon", text: item.ok ? "✓" : "○" }),
        el("span", { text: item.label }),
      );
      if (!item.ok && item.reason) line.append(el("span", { className: "ab-muted", text: ` — ${item.reason}` }));
      if (!item.ok && item.section && this.host.reveal) {
        const section = item.section as Parameters<NonNullable<RunPanelHost["reveal"]>>[0];
        const go = button("Go", () => this.host.reveal?.(section));
        go.classList.add("ab-button-small");
        line.append(go);
      }
      listNode.append(line);
    }
    const readiness = this.readiness;
    if (readiness?.receipt && readiness.receipt.remainingSeconds !== null) {
      const minutes = Math.floor(readiness.receipt.remainingSeconds / 60);
      const needed = Math.ceil(readiness.receipt.requiredSeconds / 60);
      listNode.append(
        el(
          "li",
          { className: `ab-check-${readiness.receipt.remainingSeconds >= readiness.receipt.requiredSeconds ? "ok" : "no"}` },
          el("span", {
            className: "ab-check-icon",
            text: readiness.receipt.remainingSeconds >= readiness.receipt.requiredSeconds ? "✓" : "○",
          }),
          el("span", {
            text: `Authorization valid for ${minutes} more min (a run may take up to ${needed} min)`,
          }),
        ),
      );
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
    const input = loaded.pkg.workflow.input;
    const presentation = loaded.pkg.workflow.presentation ?? null;
    const key = `${loaded.pkg.sessionId}:${input?.schemaSha256 ?? "none"}`;
    if (this.form && this.formKey === key) {
      if (!this.formHost.contains(this.form.root)) {
        clear(this.formHost);
        this.formHost.append(this.promptHeading(presentation), this.form.root);
      }
      return;
    }
    clear(this.formHost);
    const model = buildFormModel(input?.document ?? null, presentation?.input ?? []);
    const previous = this.taskValue && typeof this.taskValue === "object" && !Array.isArray(this.taskValue)
      ? (this.taskValue as Record<string, unknown>)
      : null;
    this.form = new TaskForm(
      model,
      previous,
      {
        files: () => this.files,
        fileSelection: () => Boolean(this.host.service()?.fileSelection),
        fileRoots: () => this.host.service()?.execution?.fileRoots ?? [],
        canWrite: this.host.canWrite,
        selectFile: (path) => this.selectFile(path),
      },
      (value, errors) => {
        this.taskValue = value;
        this.localErrors = new Map(errors);
        this.scheduleValidation();
        this.renderChecklist();
      },
    );
    this.formKey = key;
    this.taskValue = this.form.current();
    this.localErrors = new Map(this.form.errors());
    this.formHost.append(this.promptHeading(presentation), this.form.root);
    if (input?.note && !input.document) this.formHost.append(el("p", { className: "ab-hint", text: input.note }));
    this.scheduleValidation();
  }

  private promptHeading(presentation: PresentationViewType | null): HTMLElement {
    return el("h3", { className: "ab-run-prompt", text: presentation?.task.prompt ?? "Task" });
  }

  private async selectFile(path: string): Promise<FileCapabilityViewType | null> {
    const sessionId = this.sessionId;
    if (!sessionId) return null;
    const result = await this.host
      .call<Result<FileCapabilityViewType>>("files.select-local", { sessionId, path })
      .catch(() => null);
    if (!this.alive()) return null;
    if (!result || !result.ok) {
      this.startError = result && !result.ok ? result.error : null;
      this.renderActions();
      return null;
    }
    await this.loadFiles();
    return result.value;
  }

  private renderSummary(): void {
    clear(this.summaryEl);
    const loaded = this.host.loaded();
    if (!loaded || !this.showingForm()) return;
    const plan = loaded.runPlan?.plan ?? null;
    const binding = plan?.modelBinding ?? null;
    const model = binding
      ? loaded.models?.models.find((item) => item.modelId === binding.hostModelId) ?? null
      : null;
    const granted = new Set(loaded.receipt?.grantedPermissionIds ?? []);
    const toolRows = loaded.pkg.tools.map((tool) => {
      const bound = plan?.toolBindings.find((item) => item.toolId === tool.id) ?? null;
      const denied = tool.permissions.filter((id) => !granted.has(id));
      const notes: string[] = [];
      if (bound) notes.push(`via ${bound.displayName ?? bound.bindingId}`);
      if (!loaded.receipt) {
        notes.push(tool.permissions.length > 0 ? `needs ${tool.permissions.join(", ")}` : "needs no permission");
      } else if (denied.length > 0) {
        // Bound or not, a call that needs a denied permission is refused.
        notes.push(`${denied.join(", ")} denied — calls that need it are refused`);
      }
      if (!bound && loaded.receipt) notes.push("not bound yet");
      return el(
        "li",
        {},
        el("span", { className: "ab-check-icon", text: bound ? "✓" : "○" }),
        el("span", { text: titleCase(tool.id) }),
        el("span", { className: "ab-muted ab-row-note", text: notes.join(" · ") }),
      );
    });
    const permissionRows = loaded.permissions.permissions.map((permission) =>
      el(
        "li",
        {},
        el("span", { className: "ab-check-icon", text: granted.has(permission.id) ? "✓" : "✗" }),
        el("code", { text: permission.id }),
        el("span", {
          className: "ab-muted",
          text: granted.has(permission.id) ? "" : permission.required ? " · required, denied" : " · denied",
        }),
      ),
    );
    this.summaryEl.append(
      el(
        "div",
        { className: "ab-grid" },
        el(
          "div",
          {},
          el("h4", { text: "Model" }),
          binding
            ? el(
                "p",
                {},
                el("strong", { text: binding.displayName }),
                el("span", {
                  className: "ab-muted",
                  text: ` · ${model?.local === true ? "Local" : model?.local === false ? "Remote" : "locality not reported"} · ${binding.hostModelId}`,
                }),
              )
            : el("p", { className: "ab-muted", text: "No model bound yet." }),
        ),
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
      if (this.host.canWrite) {
        const cancel = button(
          this.cancelling || record.cancelRequested ? "Cancelling…" : "Cancel",
          () => void this.cancelRun(),
          { variant: "danger", disabled: this.cancelling || record.cancelRequested },
        );
        this.actionsEl.append(cancel);
      }
      return;
    }
    if (record && isTerminal(record)) {
      if (this.host.loaded() && this.sessionId === record.sessionId && this.host.canWrite) {
        this.actionsEl.append(button("New run", () => this.newRun(), { variant: "primary" }));
      }
      return;
    }
    if (!this.showingForm()) return;
    const verdict = this.canRun();
    const label = presentation?.task.runLabel ?? "Run";
    const run = button(this.starting ? "Starting…" : label, () => void this.startRun(), {
      variant: "primary",
      disabled: !verdict.enabled,
      title: verdict.reason ?? "Start one bounded run of this package with this task",
    });
    run.classList.add("ab-run-button");
    run.dataset.run = "start";
    this.actionsEl.append(run);
    if (verdict.reason) {
      this.actionsEl.append(el("p", { className: "ab-run-reason", text: verdict.reason, attrs: { role: "status" } }));
    } else {
      this.actionsEl.append(
        el("p", {
          className: "ab-hint",
          text:
            "Run starts one bounded run of the signed package on the model this plan bound. " +
            "It spends real tokens, and it is re-verified before anything executes.",
        }),
      );
    }
    if (this.startError) this.actionsEl.append(this.errorBanner(this.startError));
  }

  private errorBanner(error: FeatureErrorView): HTMLElement {
    return el(
      "div",
      { className: "ab-banner ab-banner-error", attrs: { role: "alert" } },
      el("strong", { text: error.title }),
      el("span", { className: "ab-error-code", text: error.code }),
      el("p", { text: error.detail }),
    );
  }

  private renderRun(): void {
    clear(this.runEl);
    this.elapsedEl = null;
    const record = this.run;
    // The panel's frame follows the run: accent while one runs, the outcome's
    // tone once it is over, neutral before any run.
    this.root.dataset.state = record ? record.status : "idle";
    if (!record) return;
    if (!isTerminal(record)) {
      this.runEl.append(this.renderProgress(record));
      return;
    }
    this.runEl.append(this.renderOutcome(record));
  }

  private renderProgress(record: RunRecordViewType): HTMLElement {
    const presentation = this.presentation();
    const node = el("div", { className: "ab-progress" });
    const elapsed = el("span", { className: "ab-elapsed", text: formatElapsed(this.elapsedMs(record)) });
    this.elapsedEl = elapsed;
    node.append(
      el(
        "div",
        { className: "ab-progress-head" },
        el("strong", {
          text:
            record.status === "preparing"
              ? "Preparing the run…"
              : record.cancelRequested
                ? "Cancelling — stopping workers and pending calls…"
                : presentation?.task.runningLabel ?? "Running…",
        }),
        el("span", { className: "ab-muted", text: " elapsed " }),
        elapsed,
      ),
    );
    node.append(this.renderStages(record, false));
    node.append(this.renderCounters(record));
    return node;
  }

  private renderStages(record: RunRecordViewType, finished: boolean): HTMLElement {
    const loaded = this.host.loaded();
    const pkg = loaded && loaded.pkg.sessionId === record.sessionId ? loaded.pkg : null;
    const presentation = pkg?.workflow.presentation ?? null;
    const progress = record.progress ?? null;
    let stages = stagesFor(pkg, presentation);
    if (stages.length === 0 && progress) {
      // No package view (a recovered run): the nodes the run reported.
      const seen = [...progress.completedNodes, ...progress.activeNodes, ...progress.failedNodes];
      stages = [...new Set(seen)].map((id) => ({ label: humanize(id), nodes: [id] }));
    }
    const labels = new Map((presentation?.nodes ?? []).map((item) => [item.nodeId, item.label]));
    const workers = progress?.workers ?? [];
    const mapNodes = new Set((pkg?.workflow.nodes ?? []).filter((node) => node.type === "map").map((node) => node.id));
    const listNode = el("ol", { className: "ab-stages" });
    for (const stage of stages) {
      const states = stage.nodes.map((id) => nodeState(progress, id, finished));
      let state: NodeState | "cancelled" = stageState(states);
      if (record.status === "cancelled" && state === "active") state = "cancelled";
      const line = el(
        "li",
        { className: `ab-stage ab-stage-${state}` },
        el("span", { className: "ab-stage-icon", text: STATUS_ICON[state] ?? "○" }),
        el("span", { className: "ab-stage-label", text: stage.label }),
      );
      const skipped = stage.nodes.filter((id, index) => states[index] === "skipped");
      if (skipped.length > 0) {
        line.append(
          el("span", {
            className: "ab-muted",
            text: ` · skipped: ${skipped.map((id) => labels.get(id) ?? humanize(id)).join(", ")} (nothing to work on)`,
          }),
        );
      }
      // Fan-out workers only: a map's per-item workers are what run in
      // parallel; a single model step's one worker would only be noise.
      const stageWorkers = workers.filter(
        (worker) =>
          worker.node &&
          stage.nodes.includes(worker.node) &&
          (mapNodes.size === 0 || mapNodes.has(worker.node)),
      );
      if (stageWorkers.length > 0) {
        const chips = el("div", { className: "ab-workers" });
        stageWorkers.forEach((worker, index) => {
          const workerState = worker.state === "queued" ? "pending" : worker.state;
          chips.append(
            el("span", {
              className: `ab-worker ab-worker-${worker.state}`,
              text: `Worker ${index + 1} ${STATUS_ICON[workerState] ?? "○"}`,
              title: `${worker.id}${worker.role ? ` · ${worker.role}` : ""} · ${worker.state} · ${worker.modelCalls} model call${worker.modelCalls === 1 ? "" : "s"} · ${worker.toolCalls} tool call${worker.toolCalls === 1 ? "" : "s"}`,
            }),
          );
        });
        line.append(chips);
      }
      listNode.append(line);
    }
    return listNode;
  }

  private renderCounters(record: RunRecordViewType): HTMLElement {
    const progress = record.progress ?? null;
    const usage = record.usage;
    const model = record.selectedModel;
    const localText = model.local === true ? "Local" : model.local === false ? "Remote" : null;
    const modelCalls = progress ? progress.modelCallsCompleted : record.audit?.modelCalls ?? 0;
    const toolCalls = progress ? progress.toolCallsStarted : usage?.toolCalls ?? 0;
    const tokens = usage?.tokens ?? progress?.tokens ?? 0;
    return definition([
      ["Model", `${model.displayName || model.hostModelId}${localText ? ` · ${localText}` : ""} · ${model.hostModelId}`],
      ["Model calls", String(modelCalls)],
      ["Tool calls", String(toolCalls)],
      ["Remote calls", String(usage?.remoteCalls ?? progress?.remoteCalls ?? 0)],
      ["Tokens", tokens.toLocaleString()],
      [
        "Workers",
        progress
          ? `${progress.workersActive} active · ${progress.workersSpawned} spawned · peak ${progress.peakParallelWorkers}`
          : "—",
      ],
    ]);
  }

  private renderOutcome(record: RunRecordViewType): HTMLElement {
    const presentation = this.presentation();
    const node = el("div", { className: "ab-outcome" });
    if (record.status === "completed") {
      node.append(
        el(
          "div",
          { className: "ab-receipt-banner ab-receipt-ok" },
          el("strong", { text: `✓ ${presentation?.task.completedLabel ?? "Run completed"}` }),
          el("p", {
            text: `Finished in ${formatElapsed(this.elapsedMs(record))}. Every result below was checked by the package's own validations before it was accepted.`,
          }),
        ),
      );
    } else {
      const known = RUN_ERRORS[record.errorCode ?? ""] ?? RUN_ERRORS[record.status] ?? null;
      const failure = record.failure ?? null;
      const where = failure?.nodeId ? `Stopped at ${this.nodeWhere(record, failure.nodeId)}${failure.stepId ? ` / ${failure.stepId}` : ""}.` : null;
      const check = failure?.failedCheck && typeof failure.failedCheck === "object"
        ? Object.entries(failure.failedCheck as Record<string, unknown>)
            .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
            .join(" · ")
        : null;
      node.append(
        el(
          "div",
          { className: `ab-banner ${record.status === "cancelled" ? "ab-banner-warn" : "ab-banner-error"}`, attrs: { role: "status" } },
          el("strong", {
            text: record.status === "cancelled" ? "Run cancelled" : known?.title ?? "The run did not complete",
          }),
          record.errorCode ? el("span", { className: "ab-error-code", text: record.errorCode }) : null,
          el("p", { text: record.errorDetail ?? known?.detail ?? "" }),
          where ? el("p", { className: "ab-muted", text: where }) : null,
          check ? el("p", { className: "ab-muted", text: `Declared check: ${check}` }) : null,
          failure?.call?.reason
            ? el("p", {
                className: "ab-muted",
                text: `First failed call: ${failure.call.action}${failure.call.tool ? ` ${failure.call.tool}` : ""} — ${failure.call.reason}`,
              })
            : null,
        ),
      );
    }
    const primary = this.primaryExport(record);
    if (primary) {
      const content = this.artifacts.get(primary);
      const section = el("section", { className: "ab-result" }, el("h3", { text: humanize(primary.replace(/\.[^.]+$/u, "")) }));
      if (!content) section.append(el("p", { className: "ab-hint", text: "Loading…" }));
      else if ("error" in content) section.append(el("p", { className: "ab-hint", text: content.error.detail }));
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
      if (first && content && !("error" in content)) {
        node.append(
          el("section", { className: "ab-result" }, el("h3", { text: "Result" }), el("pre", { className: "ab-pre", text: displayText(content) })),
        );
      }
    }
    node.append(this.renderStagesSection(record));
    node.append(this.renderArtifacts(record));
    node.append(this.renderTechnical(record));
    return node;
  }

  private renderStagesSection(record: RunRecordViewType): HTMLElement {
    const details = el("details", { className: "ab-receipt" });
    details.append(el("summary", { text: "Stages and workers" }), this.renderStages(record, true), this.renderCounters(record));
    return details;
  }

  private exportNames(record: RunRecordViewType): string[] {
    return record.artifacts.map((item) => item.name).filter((name) => !HOST_ARTIFACTS.has(name));
  }

  private primaryExport(record: RunRecordViewType): string | null {
    const exports = this.exportNames(record);
    const hinted = this.presentation()?.result.primaryExport ?? null;
    if (hinted && exports.includes(hinted)) return hinted;
    return exports.find((name) => name.endsWith(".md")) ?? null;
  }

  private summaryEntries(record: RunRecordViewType): Array<{ label: string; export: string }> {
    const exports = this.exportNames(record);
    const hinted = (this.presentation()?.result.summary ?? []).filter((entry) => exports.includes(entry.export));
    if (hinted.length > 0) return hinted;
    return exports.filter((name) => name.endsWith(".json")).map((name) => ({ label: humanize(name.replace(/\.json$/u, "")), export: name }));
  }

  private resultArtifactNames(record: RunRecordViewType): string[] {
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

  private renderResultSummary(record: RunRecordViewType): HTMLElement | null {
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
          const line =
            item && typeof item === "object"
              ? Object.entries(item as Record<string, unknown>)
                  .filter(([, value]) => typeof value === "string" || typeof value === "number")
                  .slice(0, 4)
                  .map(([key, value]) => `${key}: ${String(value).slice(0, 160)}`)
                  .join(" · ")
              : String(item).slice(0, 300);
          listNode.append(el("li", { text: line || "(record)" }));
        }
        details.append(listNode);
        rows.append(el("dd", { className: "ab-summary-detail" }, details));
      }
    }
    box.append(rows);
    return box;
  }

  private renderArtifacts(record: RunRecordViewType): HTMLElement {
    const box = el("section", { className: "ab-artifacts" }, el("h3", { text: "Artifacts" }));
    const exports = record.artifacts.filter((item) => !HOST_ARTIFACTS.has(item.name));
    const technical = record.artifacts.filter((item) => HOST_ARTIFACTS.has(item.name));
    const withRunRecord = [...technical];
    if (!withRunRecord.some((item) => item.name === "run.json")) {
      withRunRecord.push({ name: "run.json", bytes: 0, sha256: "" });
    }
    const row = (item: { name: string; bytes: number; sha256: string }) =>
      el(
        "li",
        { className: "ab-artifact" },
        el("code", { text: item.name }),
        item.bytes > 0 ? el("span", { className: "ab-muted", text: ` ${bytes(item.bytes)}` }) : null,
        button("View", () => void this.view(item.name)),
        button("Download", () => void this.download(item.name)),
      );
    if (exports.length > 0) {
      box.append(el("h4", { text: "Package exports" }), el("ul", { className: "ab-plain-list" }, ...exports.map(row)));
    } else if (record.status === "completed") {
      box.append(el("p", { className: "ab-hint", text: "This package declares no exports." }));
    } else {
      box.append(
        el("p", { className: "ab-hint", text: "A run that did not complete writes no package exports; its evidence is below." }),
      );
    }
    box.append(el("h4", { text: "Run evidence" }), el("ul", { className: "ab-plain-list" }, ...withRunRecord.map(row)));
    if (this.downloadNote) box.append(el("p", { className: "ab-hint", text: this.downloadNote, attrs: { role: "status" } }));
    if (this.viewing) {
      const content = this.artifacts.get(this.viewing);
      const viewer = el(
        "div",
        { className: "ab-viewer" },
        el("div", { className: "ab-inline" }, el("strong", { text: this.viewing }), button("Close", () => { this.viewing = null; this.renderRun(); })),
      );
      if (!content) viewer.append(el("p", { className: "ab-hint", text: "Loading…" }));
      else if ("error" in content) viewer.append(el("p", { className: "ab-hint", text: `${content.error.title}: ${content.error.detail}` }));
      else {
        if (content.truncated) viewer.append(truncatedNote(content));
        if (this.viewing.endsWith(".md") && !content.truncated) viewer.append(renderMarkdown(content.text ?? ""));
        else
          viewer.append(
            el("pre", {
              className: "ab-pre",
              text: displayText(content),
            }),
          );
        viewer.append(el("p", { className: "ab-muted", text: `sha256:${content.sha256}` }));
      }
      box.append(viewer);
    }
    return box;
  }

  private async view(name: string): Promise<void> {
    const record = this.run;
    if (!record) return;
    this.viewing = name;
    this.renderRun();
    await this.loadArtifact(record.runId, name);
    if (this.alive() && this.viewing === name) this.renderRun();
  }

  private renderTechnical(record: RunRecordViewType): HTMLElement {
    const details = el("details", { className: "ab-receipt ab-technical" });
    details.append(el("summary", { text: "Technical details" }));
    const pairs: Array<[string, HTMLElement | string]> = [
      ["Run", el("code", { text: record.runId })],
      ["Origin", record.origin === "recovered" ? "recovered from this plugin's run directory" : "this Gateway session"],
      ["Package", `${record.package.packageId} ${record.package.version}`],
      ["Package digest", el("code", { text: record.package.digest })],
      ["Archive SHA-256", el("code", { text: record.package.archiveSha256 })],
      ["Execution profile", record.package.executionProfile],
      ["Run plan", el("code", { text: record.runPlanId })],
      ["Run plan hash", el("code", { text: `sha256:${record.runPlanSha256}` })],
      ["Run invocation", el("code", { text: record.runInvocationSha256 ? `sha256:${record.runInvocationSha256}` : "—" })],
      ["Task input", el("code", { text: record.inputSha256 ? `sha256:${record.inputSha256}` : "—" })],
      [
        "Model",
        `${record.selectedModel.hostModelId} (${record.selectedModel.providerId})` +
          (record.model
            ? ` · ${record.model.calls} calls · ${record.model.allCallsUsedPlannedModel ? "every call used the planned model" : `invoked: ${record.model.invoked.join(", ") || "none"}`}`
            : ""),
      ],
      [
        "Tools",
        record.tools.length > 0
          ? record.tools
              .map((tool) => `${tool.toolId} → ${tool.displayName ?? tool.bindingId} (${tool.remote ? "remote" : "local"}, ${tool.calls} calls, binding sha256:${shortHash(tool.bindingSha256)})`)
              .join(" · ")
          : "none",
      ],
      [
        "Permissions",
        record.grants.decisions.map((item) => `${item.permissionId}=${item.decision}`).join(" · ") || "—",
      ],
      [
        "Usage",
        record.usage
          ? `${record.usage.tokens.toLocaleString()} tokens of ${record.usage.limits.hardTokens.toLocaleString()} · ${record.usage.remoteCalls} remote calls · ${record.usage.toolCalls} tool calls · peak ${record.usage.peakParallelWorkers} workers`
          : "—",
      ],
      [
        "Cost",
        record.cost
          ? record.cost.totalUsd === null
            ? `not reported (${record.cost.status})`
            : `$${record.cost.totalUsd} (${record.cost.status}; ${record.cost.callsWithReportedCost} of ${record.cost.calls} calls reported a cost)`
          : "—",
      ],
      [
        "Audit",
        record.audit
          ? `${record.audit.events} events · chain ${record.audit.chainValid ? "valid" : "INVALID"} · final sha256:${shortHash(record.audit.finalHash ?? "")}`
          : "—",
      ],
      ["Workers", record.audit ? `${record.audit.workersSpawned} spawned · ${record.audit.nodesCompleted} nodes completed` : "—"],
      ["Started", whenText(record.startedAt ?? record.createdAt)],
      ["Ended", whenText(record.endedAt ?? "")],
      ["Duration", record.durationMs === null ? "—" : formatElapsed(record.durationMs)],
      [
        "Deadline",
        record.limits.effectiveDeadlineSeconds === null ? "—" : `${record.limits.effectiveDeadlineSeconds}s effective`,
      ],
      ["Host", `${record.host.runtime} ${record.host.runtimeVersion ?? "?"}${record.host.versionVerified ? " (verified)" : ""}`],
      ["Re-verified before start", record.revalidated.join(", ") || "—"],
    ];
    details.append(definition(pairs));
    const workers = record.progress?.workers ?? [];
    if (workers.length > 0) {
      const table = el("table", { className: "ab-table" });
      table.append(
        el(
          "tr",
          {},
          ...["Worker", "Role", "Node", "State", "Duration", "Model calls", "Tool calls"].map((head) => el("th", { text: head })),
        ),
      );
      for (const worker of workers) {
        table.append(
          el(
            "tr",
            {},
            el("td", {}, el("code", { text: worker.id })),
            el("td", { text: worker.role ?? "—" }),
            el("td", { text: worker.node ?? "—" }),
            el("td", { text: worker.state }),
            el("td", { text: worker.durationMs === null ? "—" : formatElapsed(worker.durationMs) }),
            el("td", { text: String(worker.modelCalls) }),
            el("td", { text: String(worker.toolCalls) }),
          ),
        );
      }
      details.append(el("h4", { text: "Workers" }), table);
    }
    return details;
  }

  private renderHistory(): void {
    clear(this.historyEl);
    const others = this.history.filter((item) => item.runId !== this.run?.runId);
    if (others.length === 0) return;
    const details = el("details", { className: "ab-receipt" });
    details.append(el("summary", { text: `Earlier runs in this session (${others.length})` }));
    details.append(renderRunList(others.slice(0, 16), (runId) => void this.openRun(runId)));
    this.historyEl.append(details);
  }
}

/** A compact list of run records with an Open action each. */
export function renderRunList(runs: readonly RunSummaryViewType[], open: (runId: string) => void): HTMLElement {
  const listNode = el("ul", { className: "ab-plain-list ab-run-list" });
  for (const record of runs) {
    const task = record.taskText;
    const meta = [whenText(record.createdAt), record.durationMs !== null ? formatElapsed(record.durationMs) : null]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    const item = el("li", { className: "ab-run-row" });
    item.append(
      el(
        "div",
        { className: "ab-run-row-main" },
        chip(humanize(record.status), record.status === "completed" ? "good" : record.status === "failed" ? "bad" : record.status === "cancelled" ? "warn" : "neutral"),
        el("strong", { text: `${record.package.name || record.package.packageId} ${record.package.version}` }),
        el("span", { className: "ab-muted", text: meta }),
        button("Open", () => open(record.runId)),
      ),
    );
    if (task) {
      item.append(el("div", { className: "ab-run-row-task ab-muted", text: `“${task.slice(0, 140)}${task.length > 140 ? "…" : ""}”` }));
    }
    listNode.append(item);
  }
  return listNode;
}
