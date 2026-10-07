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
const URGENT = new Set(["node.started", "node.completed", "node.failed", "node.skipped"]);

export interface WorkerProgress {
  id: string;
  role: string | null;
  node: string | null;
  state: "queued" | "active" | "completed" | "failed" | "cancelled";
  model_calls: number;
  tool_calls: number;
  duration_ms: number | null;
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
}

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
    } else if (action === "model.called") this.modelStarted += 1;
    else if (action === "model.completed") {
      this.modelCompleted += 1;
      const row = this.workers.get(worker ?? "");
      if (row) row.model_calls += 1;
    } else if (action === "tool.called") {
      this.toolStarted += 1;
      const row = this.workers.get(worker ?? "");
      if (row) row.tool_calls += 1;
    } else if (action === "tool.completed") this.toolCompleted += 1;
    if (action === "budget.updated") {
      if (typeof event.tokens === "number" && Number.isInteger(event.tokens)) this.tokens = event.tokens;
      if (typeof event.remote_calls === "number" && Number.isInteger(event.remote_calls)) this.remoteCalls = event.remote_calls;
    }
    this.dirty = true;
    if (URGENT.has(action)) this.urgent = true;
    this.schedule();
  };

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
