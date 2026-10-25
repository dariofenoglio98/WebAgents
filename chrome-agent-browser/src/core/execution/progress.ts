/**
 * Live progress: the audit, read while it is being written (`execution/progress.py`). A snapshot
 * is counts and identifiers derived from events that already exist, so progress and the final
 * report cannot disagree; it carries no prompt, input, output, payload or error text. Observation
 * never steers execution: snapshots are coalesced to at most one per interval (plus one on each
 * node transition) and a listener that throws is ignored.
 */
import type { JsonObject } from "../json.js";
import type { AuditEvent } from "../types.js";

export const MIN_INTERVAL_SECONDS = 1.0;
export const MAX_COMPLETED = 128;
export const MAX_LISTED = 64;
/** Per-worker rows a run surface can render; totals keep counting past it. */
export const MAX_PROGRESS_WORKERS = 64;
const URGENT = new Set(["node.started", "node.completed", "node.failed", "node.skipped", "network.activated", "route.decided", "network.completed", "network.failed", "network.refused"]);
/** Route decisions a snapshot keeps (a network makes at most 64 handoffs; a host re-ask adds a decision each). */
export const MAX_DECISIONS = 192;

export interface WorkerProgress {
  id: string;
  role: string | null;
  node: string | null;
  state: "queued" | "active" | "completed" | "failed" | "cancelled";
  model_calls: number;
  tool_calls: number;
  duration_ms: number | null;
}

/** One route decision as the audit recorded it (network.v0 R-18): identifiers and codes only. */
export interface NetworkDecision {
  hop: number;
  role: string;
  activation: number;
  chosen_by: "model" | "package";
  next: string | null;
  allowed: boolean;
  reason: string | null;
}

/**
 * network.v0 (D-291): where a delegation network is, read from its audit events: the envelope the run
 * reserved (`network.started`), the role running now, the handoffs so far, every route decision with
 * the reason it was allowed or refused, and how the network ended. Present only once a network
 * started (or was refused), so every other run's snapshot keeps its shape.
 */
export interface NetworkProgress {
  node: string;
  state: "running" | "completed" | "failed" | "refused";
  entry: string | null;
  bound: { max_hops: number; activations: Record<string, number>; model_calls: number; tool_calls: Record<string, number>; remote_calls: number; tokens: number; seconds: number } | null;
  current: { role: string; hop: number; activation: number } | null;
  hops: number;
  activations: Record<string, number>;
  decisions: NetworkDecision[];
  error_code: string | null;
  refused_reason: string | null;
}

export interface ProgressSnapshot {
  events: number;
  last_action: string | null;
  active_nodes: string[];
  completed_nodes: string[];
  failed_nodes: string[];
  skipped_nodes: string[];
  nodes_completed: number;
  steps_completed: number;
  workers_spawned: number;
  workers_active: number;
  peak_parallel_workers: number;
  active_workers: string[];
  model_calls_started: number;
  model_calls_completed: number;
  tool_calls_started: number;
  tool_calls_completed: number;
  tokens: number;
  remote_calls: number;
  workers: WorkerProgress[];
  /** network.v0: the delegation network's progress; absent for a run that runs none. */
  network?: NetworkProgress;
}

const cleanText = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, 128) : null);
const whole = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);
const counted = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value).slice(0, 64)) out[key.slice(0, 128)] = whole(item);
  return out;
};

export type ProgressListener = (snapshot: ProgressSnapshot) => void;

interface Row extends WorkerProgress {
  started: number | null;
}

export class ProgressTracker {
  private readonly listener: ProgressListener | null;
  private readonly interval: number;
  private readonly clock: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private urgent = false;
  private closed = false;
  private lastSent = Number.NEGATIVE_INFINITY;
  sent = 0;
  events = 0;
  lastAction: string | null = null;
  readonly activeNodes = new Set<string>();
  readonly completedNodes: string[] = [];
  readonly failedNodes: string[] = [];
  readonly skippedNodes: string[] = [];
  readonly workers = new Map<string, Row>();
  nodesCompleted = 0;
  stepsCompleted = 0;
  workersSpawned = 0;
  readonly activeWorkers = new Set<string>();
  peak = 0;
  modelStarted = 0;
  modelCompleted = 0;
  toolStarted = 0;
  toolCompleted = 0;
  tokens = 0;
  remoteCalls = 0;
  network: NetworkProgress | null = null;

  constructor(listener: ProgressListener | null = null, options: { intervalSeconds?: number; clock?: () => number } = {}) {
    this.listener = listener;
    this.interval = options.intervalSeconds ?? MIN_INTERVAL_SECONDS;
    this.clock = options.clock ?? (() => Date.now() / 1000);
  }

  /** The runtime observer; never throws. */
  readonly observe = (event: AuditEvent | JsonObject): void => {
    const action = event.action;
    if (typeof action !== "string") return;
    this.events += 1;
    this.lastAction = action;
    const node = event.node_id;
    const topLevel = typeof node === "string" && !node.includes("/");
    const worker = typeof event.worker === "string" ? event.worker : null;
    if (action === "node.started" && topLevel) this.activeNodes.add(node);
    else if ((action === "node.completed" || action === "node.skipped") && typeof node === "string") {
      if (topLevel) {
        this.activeNodes.delete(node);
        if (action === "node.completed") {
          this.nodesCompleted += 1;
          if (this.completedNodes.length < MAX_COMPLETED) this.completedNodes.push(node);
        } else if (!this.skippedNodes.includes(node) && this.skippedNodes.length < MAX_COMPLETED) this.skippedNodes.push(node);
      } else if (action === "node.completed") this.stepsCompleted += 1;
    } else if (action === "node.failed" && topLevel) {
      this.activeNodes.delete(node);
      if (this.failedNodes.length < MAX_LISTED) this.failedNodes.push(node);
    } else if (action === "worker.spawned") {
      this.workersSpawned += 1;
      if (worker !== null && this.workers.size < MAX_PROGRESS_WORKERS) {
        this.workers.set(worker, {
          id: worker,
          role: typeof event.role === "string" ? event.role : null,
          node: typeof node === "string" ? node.split("/")[0]! : null,
          state: "queued",
          model_calls: 0,
          tool_calls: 0,
          duration_ms: null,
          started: null,
        });
      }
    } else if (action === "worker.started" && worker !== null) {
      this.activeWorkers.add(worker);
      this.peak = Math.max(this.peak, this.activeWorkers.size);
      const row = this.workers.get(worker);
      if (row) {
        row.state = "active";
        row.started = this.clock();
      }
    } else if ((action === "worker.completed" || action === "worker.failed") && worker !== null) {
      this.activeWorkers.delete(worker);
      const row = this.workers.get(worker);
      if (row) {
        row.state = action === "worker.completed" ? "completed" : event.error === "CancelledError" ? "cancelled" : "failed";
        if (row.started !== null) row.duration_ms = Math.round((this.clock() - row.started) * 10000) / 10;
      }
    } else if (action === "model.called") {
      // A second attempt of the same logical call (D-115) is not another started call (T9 review 1, finding 2).
      if (!(typeof event.attempt === "number" && event.attempt > 1)) this.modelStarted += 1;
    }
    else if (action === "model.completed") {
      this.modelCompleted += 1;
      const row = this.workers.get(worker ?? "");
      if (row) row.model_calls += 1;
    } else if (action === "tool.called") {
      this.toolStarted += 1;
      const row = this.workers.get(worker ?? "");
      if (row) row.tool_calls += 1;
    } else if (action === "tool.completed") this.toolCompleted += 1;
    if (action.startsWith("network.") || action === "route.decided") this.observeNetwork(action, event as JsonObject);
    if (action === "budget.updated") {
      if (typeof event.tokens === "number" && Number.isInteger(event.tokens)) this.tokens = event.tokens;
      if (typeof event.remote_calls === "number" && Number.isInteger(event.remote_calls)) this.remoteCalls = event.remote_calls;
    }
    this.dirty = true;
    if (URGENT.has(action)) this.urgent = true;
    this.schedule();
  };

  /** network.v0 (D-291): the network's events, read into its progress. */
  private observeNetwork(action: string, event: JsonObject): void {
    if (action === "network.started" || action === "network.refused") {
      const bound = typeof event.bound === "object" && event.bound !== null && !Array.isArray(event.bound) ? (event.bound as JsonObject) : null;
      this.network = {
        node: cleanText(event.node_id) ?? "network",
        state: action === "network.started" ? "running" : "refused",
        entry: cleanText(event.entry),
        bound: bound === null ? null : { max_hops: whole(bound.max_hops), activations: counted(bound.activations), model_calls: whole(bound.model_calls), tool_calls: counted(bound.tool_calls), remote_calls: whole(bound.remote_calls), tokens: whole(bound.tokens), seconds: whole(bound.seconds) },
        current: null,
        hops: 0,
        activations: {},
        decisions: [],
        error_code: null,
        refused_reason: action === "network.refused" ? cleanText(event.reason) : null,
      };
      return;
    }
    const network = this.network;
    if (network === null) return;
    if (action === "network.activated") {
      const role = cleanText(event.role) ?? "?";
      network.current = { role, hop: whole(event.hop), activation: whole(event.activation) };
      network.hops = whole(event.hop);
      network.activations[role] = whole(event.activation);
    } else if (action === "route.decided" && network.decisions.length < MAX_DECISIONS) {
      network.decisions.push({ hop: whole(event.hop), role: cleanText(event.role) ?? "?", activation: whole(event.activation), chosen_by: event.chosen_by === "model" ? "model" : "package", next: cleanText(event.next), allowed: event.allowed === true, reason: cleanText(event.reason) });
    } else if (action === "network.completed") {
      network.state = "completed";
      network.current = null;
      network.hops = whole(event.hops);
    } else if (action === "network.failed") {
      network.state = "failed";
      network.error_code = cleanText(event.error_code);
    }
  }

  snapshot(): ProgressSnapshot {
    return {
      events: this.events,
      last_action: this.lastAction,
      active_nodes: [...this.activeNodes].slice(0, MAX_LISTED),
      completed_nodes: [...this.completedNodes],
      failed_nodes: [...this.failedNodes],
      skipped_nodes: [...this.skippedNodes],
      nodes_completed: this.nodesCompleted,
      steps_completed: this.stepsCompleted,
      workers_spawned: this.workersSpawned,
      workers_active: this.activeWorkers.size,
      peak_parallel_workers: this.peak,
      active_workers: [...this.activeWorkers].sort().slice(0, MAX_LISTED),
      model_calls_started: this.modelStarted,
      model_calls_completed: this.modelCompleted,
      tool_calls_started: this.toolStarted,
      tool_calls_completed: this.toolCompleted,
      tokens: this.tokens,
      remote_calls: this.remoteCalls,
      workers: [...this.workers.values()].map(({ started: _started, ...row }) => ({ ...row })),
      ...(this.network !== null ? { network: JSON.parse(JSON.stringify(this.network)) as NetworkProgress } : {}),
    };
  }

  private schedule(): void {
    if (this.closed || this.listener === null) return;
    if (this.timer !== null) {
      // A node transition preempts a pending throttled send; anything else waits for it.
      if (!this.urgent) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    const wait = this.urgent ? 0 : Math.max(0, this.interval - (this.clock() - this.lastSent));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      this.flush();
      if (this.dirty) this.schedule();
    }, wait * 1000);
  }

  private flush(): void {
    this.dirty = false;
    this.urgent = false;
    this.lastSent = this.clock();
    try {
      this.listener?.(this.snapshot());
      this.sent += 1;
    } catch {
      // Progress is best effort: a listener that fails never steers the run.
    }
  }

  /** Stop sending; one last snapshot goes out if anything is pending. Called before the result is returned. */
  close(): void {
    if (this.closed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty && this.listener !== null) this.flush();
    this.closed = true;
  }
}
