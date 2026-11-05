/**
 * The engine's owner in the offscreen page (T41, D-441, D-450): at most one engine Worker, at most
 * one model loaded in it, one completion at a time. A run reaches it through a `MessagePort` the
 * page transfers inside `host.start`; Settings reaches it through `host.engine` commands.
 *
 * Its rules (design §3), each a refusal before the run rather than a surprise during it:
 * - **Single slot.** A run that needs another entry while a run uses the loaded one is refused
 *   `model_unavailable` ("another in-browser model is in use by run …"); otherwise the loaded model
 *   is unloaded and the needed one loaded. Never another route or entry (principle 6).
 * - **Memory check before load.** The GPU estimate at the run's context against the machine's
 *   budget, with both numbers in the refusal; a load measured at that context or more outranks it;
 *   an unknown estimate (no header) is not a fit.
 * - **Serial calls.** Completions queue in arrival order; a map step's parallel workers wait.
 * - **Idle unload.** No run using the model for the idle time (a setting, default 10 minutes):
 *   unloaded. A person's Unload and Delete unload at once.
 * - **A dead Worker** (out of memory: Chrome kills it) fails the call in flight and every queued one
 *   `model_unavailable` (`engine_worker_died`), records "failed to run at <context>" on the entry,
 *   and is never restarted by itself.
 */
import { gpuMemoryEstimate, gb } from "../../core/models/in-browser-catalog.js";
import type { InBrowserCompletionRequest } from "../../core/models/adapters/in-browser.js";
import { cacheState, effectiveEntry, type ModelStore } from "../storage/models.js";
import type { EngineBenchmark, EngineCommand, EngineCompletionResult, EngineEvent, EngineLoadResult, EngineProbe, PortReply, PortRequest, WithoutId } from "./engine-protocol.js";

/** A Worker as the host uses it (the page's `Worker`, a fake in tests). */
export interface EngineWorkerLike {
  postMessage(message: EngineCommand): void;
  terminate(): void;
  onmessage: ((event: { data: EngineEvent }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** A `MessagePort` as the host uses it. */
export interface PortLike {
  postMessage(message: PortReply): void;
  onmessage: ((event: { data: PortRequest }) => void) | null;
  close(): void;
  start?(): void;
}

export const DEFAULT_IDLE_UNLOAD_MINUTES = 10;

export class EngineRefusal extends Error {
  constructor(
    readonly code: "model_unavailable" | "model_request_invalid",
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EngineRefusal";
  }
}

export interface LoadRequest {
  entry: string;
  n_ctx: number;
  think: boolean;
  /** The machine's budget the service worker computed (D-443), with its basis for the words. */
  budget: { bytes: number; basis: string };
  /** A CPU-only control (the e2e harness's GPU-versus-CPU fact); never set by a run. */
  n_gpu_layers?: number;
}

export interface EngineHostDeps {
  spawn: () => EngineWorkerLike;
  models: ModelStore;
  now?: () => Date;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Told when the loaded model or the queue changes, so Settings can say "loaded now". */
  onChange?: () => void;
}

interface Pending {
  id: number;
  port: PortLike;
  request: InBrowserCompletionRequest;
  run: string;
}

interface Loaded {
  entry: string;
  n_ctx: number;
  think: boolean;
  n_gpu_layers: number | null;
  load: EngineLoadResult;
  measured: boolean;
}

export interface EngineStatus {
  loaded: { entry: string; n_ctx: number; think: boolean; load_ms: number; n_gpu_layers: number | null; offload_log: string[] } | null;
  loading: string | null;
  busy: boolean;
  queued: number;
  runs: Array<{ run_id: string; entry: string }>;
  idle_unload_at: string | null;
  last_failure: { entry: string; n_ctx: number; reason: string; at: string } | null;
}

export class EngineHost {
  private worker: EngineWorkerLike | null = null;
  private nextId = 1;
  private readonly answers = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private loaded: Loaded | null = null;
  private loading: { entry: string; n_ctx: number; done: Promise<void> } | null = null;
  private readonly users = new Map<string, string>();
  private readonly ports = new Map<string, PortLike>();
  private readonly queue: Pending[] = [];
  private current: { pending: Pending; engineId: number } | null = null;
  private idleTimer: unknown = null;
  private idleAt: Date | null = null;
  private idleMinutes = DEFAULT_IDLE_UNLOAD_MINUTES;
  private lastFailure: EngineStatus["last_failure"] = null;
  private readonly now: () => Date;

  constructor(private readonly deps: EngineHostDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // -- the Worker ------------------------------------------------------------------------------
  private engine(): EngineWorkerLike {
    if (this.worker !== null) return this.worker;
    const worker = this.deps.spawn();
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.kind !== "answer") return;
      const waiter = this.answers.get(data.id);
      if (!waiter) return;
      this.answers.delete(data.id);
      if (data.ok) waiter.resolve(data.result);
      else waiter.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
    };
    worker.onerror = () => void this.died("engine_worker_died");
    this.worker = worker;
    return worker;
  }

  private ask<T>(command: WithoutId<Extract<EngineCommand, { id: number }>>, onId?: (id: number) => void): Promise<T> {
    const id = this.nextId++;
    onId?.(id);
    const worker = this.engine();
    return new Promise<T>((resolve, reject) => {
      this.answers.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...command, id } as EngineCommand);
    });
  }

  /** The Worker died (Chrome killed it, out of memory): fail everything waiting, record the context, never restart by itself. */
  private async died(reason: string): Promise<void> {
    // A Worker that dies while loading is the classic "does not fit" (design §3): that context is recorded too.
    const failed = this.loaded ?? (this.loading ? { entry: this.loading.entry, n_ctx: this.loading.n_ctx } : null);
    const error = Object.assign(new Error("The in-browser engine stopped (its Worker died, most likely out of GPU or main memory)"), { code: "model_unavailable", detail: { reason } });
    for (const waiter of this.answers.values()) waiter.reject(error);
    this.answers.clear();
    const victims = [...(this.current ? [this.current.pending] : []), ...this.queue.splice(0)];
    this.current = null;
    for (const pending of victims) pending.port.postMessage({ id: pending.id, ok: false, error: { code: "model_unavailable", message: error.message, detail: { reason, entry: pending.request.entry } } });
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    // No run holds a model that is gone; each run's call already failed above.
    this.users.clear();
    if (failed && failed.n_ctx > 0) {
      this.lastFailure = { entry: failed.entry, n_ctx: failed.n_ctx, reason, at: this.now().toISOString() };
      await this.deps.models.update(failed.entry, (row) => (row === null ? null : { ...row, failed_context: Math.min(row.failed_context ?? Number.POSITIVE_INFINITY, failed.n_ctx) })).catch(() => undefined);
    }
    this.deps.onChange?.();
  }

  // -- loading -------------------------------------------------------------------------------
  /**
   * Make `request.entry` the loaded model at its context and thinking, or refuse with the reason.
   * `runId` is the run that needs it (null for Settings' Load); a run that holds another entry
   * keeps it.
   */
  async ensure(request: LoadRequest, runId: string | null): Promise<EngineLoadResult> {
    while (this.loading) await this.loading.done.catch(() => undefined);
    const held = this.loaded;
    const same = held !== null && held.entry === request.entry && held.n_ctx === request.n_ctx && held.think === request.think && held.n_gpu_layers === (request.n_gpu_layers ?? null);
    if (same) {
      if (runId !== null) this.users.set(runId, request.entry);
      this.touch();
      return held.load;
    }
    const others = [...this.users.entries()].filter(([run]) => run !== runId);
    if (held !== null && others.length > 0) {
      const [run, entry] = others[0]!;
      throw new EngineRefusal("model_unavailable", entry === request.entry ? `The in-browser model is loaded with another context or thinking setting for run ${run}; wait for it to finish` : `Another in-browser model (${entry}) is in use by run ${run}`, { reason: "engine_in_use", run_id: run, loaded: entry });
    }
    const row = await this.deps.models.get(request.entry);
    const state = cacheState(row);
    if (row === null || !state.cached) throw new EngineRefusal("model_unavailable", `The in-browser model ${request.entry} is not downloaded`, { reason: "not_downloaded", entry: request.entry });
    if (!state.verified) throw new EngineRefusal("model_unavailable", "A cached file does not match the digest the catalog states: delete it and download again", { reason: "unverified", entry: request.entry });
    if (row.failed_context !== null && row.failed_context <= request.n_ctx) throw new EngineRefusal("model_unavailable", `This model failed to run at a ${row.failed_context.toLocaleString("en-US")}-token context on this machine; try a smaller context or model`, { reason: "failed_before", entry: request.entry, failed_context: row.failed_context });
    const ran = row.measured !== null && row.measured.context >= request.n_ctx;
    if (!ran && request.n_gpu_layers === undefined) {
      const estimate = gpuMemoryEstimate(effectiveEntry(row.entry, row), request.n_ctx);
      if (estimate === null) throw new EngineRefusal("model_unavailable", "GPU memory unknown: the model's header has not been read", { reason: "estimate_unknown", entry: request.entry });
      if (estimate > request.budget.bytes) throw new EngineRefusal("model_unavailable", `needs about ${gb(estimate)} of GPU memory at a ${request.n_ctx.toLocaleString("en-US")}-token context; this machine's budget is ${gb(request.budget.bytes)} (${request.budget.basis})`, { reason: "over_budget", entry: request.entry, estimate_bytes: estimate, budget_bytes: request.budget.bytes });
    }
    const loading = (async () => {
      if (held !== null) await this.unload();
      const result = await this.ask<EngineLoadResult>({ kind: "load", entry: request.entry, files: row.files.map((file) => file.sha256), n_ctx: request.n_ctx, think: request.think, ...(request.n_gpu_layers === undefined ? {} : { n_gpu_layers: request.n_gpu_layers }) });
      this.loaded = { entry: request.entry, n_ctx: result.n_ctx, think: request.think, n_gpu_layers: request.n_gpu_layers ?? null, load: result, measured: false };
      await this.deps.models.update(request.entry, (current) => (current === null ? null : { ...current, last_used: this.now().toISOString() }));
      return result;
    })();
    // `done` only orders later loads after this one; its failure is the caller's (below), never an unhandled rejection.
    this.loading = { entry: request.entry, n_ctx: request.n_ctx, done: loading.then(() => undefined, () => undefined) };
    try {
      const result = await loading;
      if (runId !== null) this.users.set(runId, request.entry);
      this.touch();
      this.deps.onChange?.();
      return result;
    } catch (error) {
      if (error instanceof EngineRefusal) throw error;
      const code = (error as { code?: string }).code;
      throw new EngineRefusal("model_unavailable", `The in-browser engine could not load ${request.entry} (${error instanceof Error ? error.message.slice(0, 200) : "error"})`, { reason: code === "model_unavailable" ? "engine_worker_died" : "load_failed", entry: request.entry });
    } finally {
      this.loading = null;
    }
  }

  async unload(): Promise<void> {
    if (this.loaded === null) return;
    const entry = this.loaded.entry;
    for (const pending of this.queue.splice(0)) pending.port.postMessage({ id: pending.id, ok: true, result: abortAnswer() });
    if (this.current) this.worker?.postMessage({ kind: "abort", target: this.current.engineId });
    this.loaded = null;
    this.clearIdle();
    for (const [run, held] of [...this.users.entries()]) if (held === entry) this.users.delete(run);
    if (this.worker) await this.ask({ kind: "unload" }).catch(() => undefined);
    this.deps.onChange?.();
  }

  setIdleMinutes(minutes: number | null | undefined): void {
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) this.idleMinutes = minutes;
  }

  /** A run's Worker is done: it no longer holds the model; the idle timer starts when nobody does. */
  release(runId: string): void {
    this.users.delete(runId);
    const port = this.ports.get(runId);
    this.ports.delete(runId);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) if (this.queue[index]!.run === runId) this.queue.splice(index, 1);
    port?.close();
    this.touch();
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) (this.deps.clearTimer ?? clearTimeout)(this.idleTimer as ReturnType<typeof setTimeout>);
    this.idleTimer = null;
    this.idleAt = null;
  }

  private touch(): void {
    this.clearIdle();
    if (this.loaded === null || this.users.size > 0 || this.current !== null || this.queue.length > 0) return;
    const ms = this.idleMinutes * 60_000;
    this.idleAt = new Date(this.now().getTime() + ms);
    this.idleTimer = (this.deps.setTimer ?? setTimeout)(() => {
      this.idleTimer = null;
      if (this.users.size === 0 && this.current === null) void this.unload();
    }, ms);
  }

  // -- a run's port ------------------------------------------------------------------------------
  /** Serve one run's port: status, completions (queued), aborts. */
  attach(runId: string, port: PortLike): void {
    this.ports.set(runId, port);
    port.onmessage = (event) => {
      const message = event.data;
      if (message.kind === "status") {
        port.postMessage({ id: message.id, ok: true, result: { loaded: this.loaded?.entry ?? null, busy: this.current !== null } });
      } else if (message.kind === "complete") {
        this.queue.push({ id: message.id, port, request: message.request, run: runId });
        this.clearIdle();
        this.pump();
      } else if (message.kind === "abort") {
        const queued = this.queue.findIndex((item) => item.port === port && item.id === message.target);
        if (queued >= 0) {
          const [pending] = this.queue.splice(queued, 1);
          pending!.port.postMessage({ id: pending!.id, ok: true, result: abortAnswer() });
        } else if (this.current && this.current.pending.port === port && this.current.pending.id === message.target) {
          this.worker?.postMessage({ kind: "abort", target: this.current.engineId });
        }
      }
    };
    port.start?.();
  }

  private pump(): void {
    if (this.current !== null) return;
    const pending = this.queue.shift();
    if (!pending) {
      this.touch();
      return;
    }
    if (this.loaded === null || this.loaded.entry !== pending.request.entry) {
      pending.port.postMessage({ id: pending.id, ok: false, error: { code: "model_unavailable", message: this.loaded === null ? "No in-browser model is loaded" : `The in-browser engine holds ${this.loaded.entry}`, detail: { entry: pending.request.entry, loaded: this.loaded?.entry ?? null } } });
      this.pump();
      return;
    }
    const loaded = this.loaded;
    const { schema, ...rest } = pending.request;
    const slot: { pending: Pending; engineId: number } = { pending, engineId: -1 };
    this.current = slot;
    this.deps.onChange?.();
    void this.ask<EngineCompletionResult>({ kind: "complete", request: { ...rest, schema } }, (id) => (slot.engineId = id))
      .then(
        async (result) => {
          pending.port.postMessage({ id: pending.id, ok: true, result });
          // The first completion after a load measures the speeds at that context (D-441, D-443); a
          // CPU-only control load (the harness's GPU-versus-CPU fact) never stands for this machine.
          if (!loaded.measured && loaded.n_gpu_layers === null && result.timings && result.timings.prompt_per_second !== null && result.timings.predicted_per_second !== null && result.finish_reason !== "abort") {
            loaded.measured = true;
            const at = this.now().toISOString();
            const timings = result.timings;
            await this.deps.models.update(loaded.entry, (row) => (row === null ? null : { ...row, last_used: at, measured: { prefill_tok_per_s: Math.round(timings.prompt_per_second! * 10) / 10, decode_tok_per_s: Math.round(timings.predicted_per_second! * 10) / 10, context: Math.max(loaded.n_ctx, row.measured?.context ?? 0), at } })).catch(() => undefined);
          }
        },
        (error: Error & { code?: string; detail?: Record<string, unknown> }) => {
          // A dead Worker already answered every call it held (`died`): one reply per call.
          if (this.current !== slot) return;
          const code = error.code === "model_unavailable" ? "model_unavailable" : /context|n_ctx|too long|exceed/iu.test(error.message) ? "model_request_invalid" : "engine_error";
          pending.port.postMessage({ id: pending.id, ok: false, error: { code, message: error.message.slice(0, 500), detail: error.detail ?? { entry: pending.request.entry }, audit_facts: { stage: "engine" } } });
        },
      )
      .finally(() => {
        if (this.current === slot) this.current = null;
        this.deps.onChange?.();
        this.pump();
      });
  }

  // -- Settings ------------------------------------------------------------------------------
  probe(): Promise<EngineProbe> {
    return this.ask<EngineProbe>({ kind: "probe" });
  }

  benchmark(): Promise<EngineBenchmark> {
    return this.ask<EngineBenchmark>({ kind: "benchmark" });
  }

  /** The entry loaded now, or null; never loads. */
  loadedEntry(): string | null {
    return this.loaded?.entry ?? null;
  }

  status(): EngineStatus {
    const loaded = this.loaded;
    return {
      loaded: loaded === null ? null : { entry: loaded.entry, n_ctx: loaded.n_ctx, think: loaded.think, load_ms: loaded.load.load_ms, n_gpu_layers: loaded.n_gpu_layers, offload_log: loaded.load.offload_log },
      loading: this.loading?.entry ?? null,
      busy: this.current !== null,
      queued: this.queue.length,
      runs: [...this.users.entries()].map(([run_id, entry]) => ({ run_id, entry })),
      idle_unload_at: this.idleAt?.toISOString() ?? null,
      last_failure: this.lastFailure,
    };
  }
}

/** The answer a queued or stopped completion gets when the engine stops it (an unload): an `abort` finish, which the adapter reads as `engine_aborted` unless the run cancelled. */
function abortAnswer(): EngineCompletionResult {
  return { text: null, finish_reason: "abort", usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }, timings: null, constrained: false, ms: 0 };
}
