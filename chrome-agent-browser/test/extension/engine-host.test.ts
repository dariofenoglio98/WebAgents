/**
 * T41's engine owner (`execution/engine-host.ts`) over a fake engine Worker: the load from the
 * cache and its reuse, the refusals before a load (not downloaded, unverified, over budget, unknown
 * estimate, a context that failed before; a measured load outranking the estimate), the single
 * slot, the serial queue and its aborts, the idle unload, a dead Worker, the first completion's
 * measured speeds; then the run Worker's `MessagePortEnginePort` over a real `MessageChannel`, and
 * the core's `InBrowserAdapter` end to end through both. Curated facts are read from
 * `examples/model-catalog.content.json`; estimates are computed with the core's own function.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InBrowserAdapter, type InBrowserCompletionRequest } from "../../src/core/models/adapters/in-browser.js";
import { gb, gpuMemoryEstimate, readModelCatalog, type InBrowserEntry } from "../../src/core/models/in-browser-catalog.js";
import { render } from "../../src/core/models/render.js";
import { AdapterError } from "../../src/core/workflow/errors.js";
import { DEFAULT_LOAD_TIMEOUT_MS, DEFAULT_UNLOAD_TIMEOUT_MS, EngineHost, EngineRefusal, type EngineWorkerLike, type LoadRequest, type PortLike } from "../../src/extension/execution/engine-host.js";
import type { EngineCommand, EngineCompletionResult, EngineEvent, EngineLoadResult, PortReply, PortRequest } from "../../src/extension/execution/engine-protocol.js";
import { MessagePortEnginePort, type RunPortLike } from "../../src/extension/execution/in-browser-port.js";
import { MemoryModelStore, newModelRecord, type ModelRecord } from "../../src/extension/storage/models.js";
import { PROJECT } from "../helpers/paths.js";

const ROOT = join(PROJECT, "..");
const CATALOG = readModelCatalog(JSON.parse(readFileSync(join(ROOT, "examples", "model-catalog.content.json"), "utf8")));
const SMALL: InBrowserEntry = CATALOG.entries.find((entry) => entry.id === "qwen3-0.6b-q4_0")!;
const OTHER: InBrowserEntry = CATALOG.entries.find((entry) => entry.id === "qwen3-4b-q4_k_m")!;
const NOW = new Date("2026-11-05T12:00:00Z");
const CONTEXT = 8192;

const COMPLETION: EngineCompletionResult = {
  text: '{"a":1}',
  finish_reason: "stop",
  usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, cached_prompt_tokens: 100 },
  timings: { prompt_per_second: 512.34, predicted_per_second: 41.26 },
  constrained: true,
  ms: 50,
};

/** A fake engine Worker: answers asynchronously, records every command, can hold completions open and die. */
class FakeEngine implements EngineWorkerLike {
  onmessage: ((event: { data: EngineEvent }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly received: EngineCommand[] = [];
  terminated = false;
  hold = false;
  readonly held: number[] = [];
  completion: EngineCompletionResult = COMPLETION;
  nextCompletionError: { code: string; message: string } | null = null;
  /** Answer nothing at all (a Worker that will die mid-command). */
  silent = false;
  /** Answer nothing to these commands only (an unload that never returns). */
  readonly silentKinds = new Set<EngineCommand["kind"]>();

  postMessage(command: EngineCommand): void {
    this.received.push(structuredClone(command));
    if (command.kind === "abort" || this.silent || this.silentKinds.has(command.kind)) return;
    if (command.kind === "complete") {
      if (this.hold) {
        this.held.push(command.id);
        return;
      }
      const error = this.nextCompletionError;
      this.nextCompletionError = null;
      if (error !== null) {
        setTimeout(() => this.send({ kind: "answer", id: command.id, ok: false, error }), 0);
        return;
      }
      setTimeout(() => this.finish(command.id), 0);
      return;
    }
    const result: unknown =
      command.kind === "load"
        ? ({ entry: command.entry, load_ms: 5, n_ctx: command.n_ctx, n_ctx_train: 40960, n_layer: 28, multithread: true, think: command.think, n_gpu_layers: command.n_gpu_layers ?? null, offload_log: [] } satisfies EngineLoadResult)
        : null;
    setTimeout(() => this.send({ kind: "answer", id: command.id, ok: true, result }), 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  send(event: EngineEvent): void {
    if (!this.terminated) this.onmessage?.({ data: event });
  }

  finish(id: number, result: EngineCompletionResult = this.completion): void {
    this.send({ kind: "answer", id, ok: true, result });
  }

  commands(kind: EngineCommand["kind"]): EngineCommand[] {
    return this.received.filter((command) => command.kind === kind);
  }

  die(): void {
    this.onerror?.({ type: "error" });
  }
}

/** A run's port as the host sees it, recording every reply. */
class RecordingPort implements PortLike {
  onmessage: ((event: { data: PortRequest }) => void) | null = null;
  readonly sent: PortReply[] = [];
  closed = false;
  postMessage(message: PortReply): void {
    this.sent.push(structuredClone(message));
  }
  close(): void {
    this.closed = true;
  }
  ask(message: PortRequest): void {
    this.onmessage!({ data: message });
  }
  reply(id: number): PortReply | undefined {
    return this.sent.find((item) => item.id === id);
  }
}

function cachedRow(entry: InBrowserEntry, changes: Partial<ModelRecord> = {}): ModelRecord {
  const row = newModelRecord(entry, NOW);
  return {
    ...row,
    files: row.files.map((file) => ({ ...file, state: "complete" as const })),
    verified: true,
    downloaded_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
    header: entry.header === null ? null : { ...entry.header, context_length: entry.context.train, architecture: entry.family, general_name: null },
    ...changes,
  };
}

const fitting = (entry: InBrowserEntry, context = CONTEXT): LoadRequest["budget"] => ({ bytes: gpuMemoryEstimate(entry, context)! + 1, basis: "declared" });
const load = (entry: InBrowserEntry, changes: Partial<LoadRequest> = {}): LoadRequest => ({ entry: entry.id, n_ctx: CONTEXT, think: false, budget: fitting(entry, changes.n_ctx ?? CONTEXT), ...changes });
const request = (entry: InBrowserEntry): InBrowserCompletionRequest => ({ entry: entry.id, system: "Answer.", user: "Question?", schema: null, max_tokens: 50, think: false });
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

interface Timer {
  handle: number;
  ms: number;
  callback: () => void;
}

function makeHost(rows: ModelRecord[] = [cachedRow(SMALL), cachedRow(OTHER)], onSpawn: (worker: FakeEngine) => void = () => undefined) {
  const models = new MemoryModelStore();
  for (const row of rows) void models.put(row);
  const workers: FakeEngine[] = [];
  const timers: Timer[] = [];
  const cleared: unknown[] = [];
  let next = 1;
  const host = new EngineHost({
    spawn: () => {
      const worker = new FakeEngine();
      onSpawn(worker);
      workers.push(worker);
      return worker;
    },
    models,
    now: () => NOW,
    setTimer: (callback, ms) => {
      const timer = { handle: next++, ms, callback };
      timers.push(timer);
      return timer.handle;
    },
    clearTimer: (handle) => cleared.push(handle),
  });
  return { host, models, workers, timers, cleared, worker: () => workers.at(-1)! };
}

/**
 * Run `body` with this test's own `unhandledRejection` listener in place of Vitest's, so a rejection
 * the code under test leaves unhandled is observed here instead of failing the whole file.
 */
async function withUnhandledRejections<T>(body: () => Promise<T>): Promise<{ value: T; unhandled: unknown[] }> {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const value = await body();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { value, unhandled };
  } finally {
    process.off("unhandledRejection", listener);
    for (const saved_listener of saved) process.on("unhandledRejection", saved_listener);
  }
}

async function refusal(promise: Promise<unknown>): Promise<EngineRefusal> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EngineRefusal);
    return error as EngineRefusal;
  }
  throw new Error("expected a refusal");
}

describe("EngineHost: loading", () => {
  it("loads a cached, verified entry once and reuses it for the same entry and context", async () => {
    // A second run with the same entry, context and thinking gets the loaded model: one load command only.
    const { host, models, workers } = makeHost();
    const first = await host.ensure(load(SMALL), "A");
    expect(first).toMatchObject({ entry: SMALL.id, n_ctx: CONTEXT });
    const second = await host.ensure(load(SMALL), "B");
    expect(second).toEqual(first);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.commands("load")).toEqual([{ kind: "load", id: expect.any(Number), entry: SMALL.id, files: SMALL.files.map((file) => file.sha256), n_ctx: CONTEXT, think: false }]);
    expect(host.status()).toMatchObject({ loaded: { entry: SMALL.id, n_ctx: CONTEXT }, runs: [{ run_id: "A", entry: SMALL.id }, { run_id: "B", entry: SMALL.id }] });
    expect((await models.get(SMALL.id))!.last_used).toBe(NOW.toISOString());
  });

  it("refuses an entry that is not downloaded, without spawning a Worker", async () => {
    // No row, or a row whose files are missing: not downloaded.
    const { host, workers } = makeHost([newModelRecord(OTHER, NOW)]);
    expect((await refusal(host.ensure(load(SMALL), "A"))).detail).toMatchObject({ reason: "not_downloaded", entry: SMALL.id });
    const missing = await refusal(host.ensure(load(OTHER), "A"));
    expect(missing).toMatchObject({ code: "model_unavailable", detail: { reason: "not_downloaded" } });
    expect(workers).toHaveLength(0);
  });

  it("refuses a cached entry whose digest no longer matches", async () => {
    // A mismatch found by Verify: delete and download again.
    const { host, workers } = makeHost([cachedRow(SMALL, { mismatch: true })]);
    expect(await refusal(host.ensure(load(SMALL), "A"))).toMatchObject({ code: "model_unavailable", detail: { reason: "unverified" } });
    expect(workers).toHaveLength(0);
  });

  it("refuses over the budget with both numbers in the message", async () => {
    // The estimate at the run's context against the machine's budget, both stated.
    const { host, workers } = makeHost();
    const estimate = gpuMemoryEstimate(SMALL, CONTEXT)!;
    const budget = { bytes: estimate - 1, basis: "assumed" };
    const refused = await refusal(host.ensure(load(SMALL, { budget }), "A"));
    expect(refused.code).toBe("model_unavailable");
    expect(refused.message).toContain("needs about");
    expect(refused.message).toContain("budget");
    expect(refused.message).toContain(gb(estimate));
    expect(refused.message).toContain(gb(budget.bytes));
    expect(refused.detail).toMatchObject({ reason: "over_budget", estimate_bytes: estimate, budget_bytes: budget.bytes });
    expect(workers).toHaveLength(0);
  });

  it("refuses an unknown estimate: no header read and none listed", async () => {
    // An unknown need is never a fit.
    const unread: InBrowserEntry = { ...SMALL, header: null };
    const { host } = makeHost([cachedRow(unread, { header: null })]);
    expect(await refusal(host.ensure({ ...load(SMALL), budget: { bytes: Number.MAX_SAFE_INTEGER, basis: "declared" } }, "A"))).toMatchObject({ code: "model_unavailable", detail: { reason: "estimate_unknown" } });
  });

  it("refuses a context at or above one whose load died, and loads below it", async () => {
    // failed_context <= n_ctx is refused; a smaller context is tried.
    const { host, workers } = makeHost([cachedRow(SMALL, { failed_context: CONTEXT })]);
    expect(await refusal(host.ensure(load(SMALL), "A"))).toMatchObject({ detail: { reason: "failed_before", failed_context: CONTEXT } });
    expect(await refusal(host.ensure(load(SMALL, { n_ctx: CONTEXT * 2 }), "A"))).toMatchObject({ detail: { reason: "failed_before" } });
    expect(workers).toHaveLength(0);
    await expect(host.ensure(load(SMALL, { n_ctx: CONTEXT / 2 }), "A")).resolves.toMatchObject({ n_ctx: CONTEXT / 2 });
  });

  it("lets a load measured at that context or more outrank an estimate over the budget", async () => {
    // What ran on this machine outranks the estimate at that context or below.
    const measured = { prefill_tok_per_s: 100, decode_tok_per_s: 10, context: CONTEXT * 2, at: NOW.toISOString() };
    const { host } = makeHost([cachedRow(SMALL, { measured })]);
    const tiny = { bytes: 1, basis: "assumed" };
    await expect(host.ensure(load(SMALL, { budget: tiny }), "A")).resolves.toMatchObject({ entry: SMALL.id });
    // Above the measured context the estimate applies again.
    const other = makeHost([cachedRow(SMALL, { measured: { ...measured, context: CONTEXT / 2 } })]);
    expect(await refusal(other.host.ensure(load(SMALL, { budget: tiny }), "A"))).toMatchObject({ detail: { reason: "over_budget" } });
  });
});

describe("EngineHost: the single slot", () => {
  it("refuses another entry while a run holds the loaded one, and switches after the release", async () => {
    // Run A holds X; run B needing Y is refused; after A's release, B's ensure unloads X and loads Y.
    const { host, worker } = makeHost();
    await host.ensure(load(SMALL), "A");
    const refused = await refusal(host.ensure(load(OTHER), "B"));
    expect(refused.code).toBe("model_unavailable");
    expect(refused.message).toContain("in use by run A");
    expect(refused.detail).toMatchObject({ reason: "engine_in_use", run_id: "A", loaded: SMALL.id });
    host.release("A");
    await expect(host.ensure(load(OTHER), "B")).resolves.toMatchObject({ entry: OTHER.id });
    expect(worker().received.filter((command) => command.kind !== "abort").map((command) => command.kind === "load" ? `load ${command.entry}` : command.kind)).toEqual([`load ${SMALL.id}`, "unload", `load ${OTHER.id}`]);
    expect(host.status()).toMatchObject({ loaded: { entry: OTHER.id }, runs: [{ run_id: "B", entry: OTHER.id }] });
  });
  // T41 review 1, finding 1: the gate was checked, then an IndexedDB read awaited, then set; two
  // callers could both pass it and build two engines at once.
  it("serialises overlapping ensure calls: a double Load sends one load command", async () => {
    const { host, workers } = makeHost();
    const [first, second] = await Promise.all([host.ensure(load(SMALL), null), host.ensure(load(SMALL), null)]);
    expect(second).toEqual(first);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.commands("load")).toHaveLength(1);
  });

  it("never has two loads in flight: a run's start during a Settings load of another entry waits, then unloads and loads", async () => {
    // Count the loads the Worker holds unanswered at any moment, from its first command.
    let inFlight = 0;
    let most = 0;
    const { host, workers } = makeHost(undefined, (worker) => {
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (command) => {
        if (command.kind === "load") most = Math.max(most, ++inFlight);
        post(command);
      };
      const send = worker.send.bind(worker);
      worker.send = (event) => {
        if (event.kind === "answer" && worker.commands("load").some((command) => "id" in command && command.id === event.id)) inFlight -= 1;
        send(event);
      };
    });
    const settings = host.ensure(load(SMALL), null);
    const run = host.ensure(load(OTHER), "R");
    await expect(settings).resolves.toMatchObject({ entry: SMALL.id });
    await expect(run).resolves.toMatchObject({ entry: OTHER.id });
    expect(most).toBe(1);
    const worker = workers[0]!;
    expect(workers).toHaveLength(1);
    expect(worker.received.filter((command) => command.kind !== "abort").map((command) => (command.kind === "load" ? `load ${command.entry}` : command.kind))).toEqual([`load ${SMALL.id}`, "unload", `load ${OTHER.id}`]);
    expect(host.status()).toMatchObject({ loaded: { entry: OTHER.id }, runs: [{ run_id: "R", entry: OTHER.id }] });
  });

  it("lets an Unload pressed during a load wait for it, then unload", async () => {
    const { host, workers } = makeHost();
    const loading = host.ensure(load(SMALL), null);
    const unloading = host.unload();
    await loading;
    await unloading;
    expect(host.status().loaded).toBeNull();
    expect(workers[0]!.received.map((command) => command.kind)).toEqual(["load", "unload"]);
  });

  // T41 review 1, nit 12: a load that never answers (wllama's nested Worker dying silently).
  it("treats a load that outlives its deadline as a dead Worker: terminated, refused, context recorded", async () => {
    const { host, workers, timers, models } = makeHost(undefined, (worker) => (worker.silent = true));
    const { value: refused } = await withUnhandledRejections(async () => {
      const pending = host.ensure(load(SMALL), "A");
      await vi.waitFor(() => expect(timers.filter((timer) => timer.ms === DEFAULT_LOAD_TIMEOUT_MS)).toHaveLength(1));
      timers.find((timer) => timer.ms === DEFAULT_LOAD_TIMEOUT_MS)!.callback();
      return refusal(pending);
    });
    expect(refused).toMatchObject({ code: "model_unavailable", detail: { reason: "engine_load_timeout", entry: SMALL.id } });
    expect(workers[0]!.terminated).toBe(true);
    await vi.waitFor(async () => expect((await models.get(SMALL.id))!.failed_context).toBe(CONTEXT));
    expect(host.status()).toMatchObject({ loaded: null, loading: null, last_failure: { reason: "engine_load_timeout" } });
  });
});

describe("EngineHost: the serial queue", () => {
  it("sends the second completion to the Worker only after the first answered", async () => {
    // Completions queue in arrival order; one in flight at a time.
    const { host, worker } = makeHost();
    await host.ensure(load(SMALL), "A");
    const port = new RecordingPort();
    host.attach("A", port);
    worker().hold = true;
    port.ask({ id: 1, kind: "complete", request: request(SMALL) });
    port.ask({ id: 2, kind: "complete", request: request(SMALL) });
    await settle();
    expect(worker().commands("complete")).toHaveLength(1);
    expect(host.status()).toMatchObject({ busy: true, queued: 1 });
    worker().finish(worker().held[0]!);
    await vi.waitFor(() => expect(worker().commands("complete")).toHaveLength(2));
    expect(port.reply(1)).toMatchObject({ ok: true, result: { text: COMPLETION.text } });
    expect(port.reply(2)).toBeUndefined();
    worker().finish(worker().held[1]!);
    await vi.waitFor(() => expect(port.reply(2)).toMatchObject({ ok: true }));
    expect(host.status()).toMatchObject({ busy: false, queued: 0 });
  });

  it("answers an aborted queued completion with an abort finish, and passes an in-flight abort to the Worker", async () => {
    // A queued abort never reaches the Worker; the in-flight one is stopped there.
    const { host, worker } = makeHost();
    await host.ensure(load(SMALL), "A");
    const port = new RecordingPort();
    host.attach("A", port);
    worker().hold = true;
    port.ask({ id: 1, kind: "complete", request: request(SMALL) });
    port.ask({ id: 2, kind: "complete", request: request(SMALL) });
    await settle();
    port.ask({ id: 3, kind: "abort", target: 2 });
    expect(port.reply(2)).toMatchObject({ ok: true, result: { finish_reason: "abort", text: null } });
    const inFlight = worker().commands("complete")[0] as Extract<EngineCommand, { kind: "complete" }>;
    port.ask({ id: 4, kind: "abort", target: 1 });
    expect(worker().commands("abort")).toEqual([{ kind: "abort", target: inFlight.id }]);
    worker().finish(inFlight.id, { ...COMPLETION, finish_reason: "abort" });
    await vi.waitFor(() => expect(port.reply(1)).toMatchObject({ ok: true, result: { finish_reason: "abort" } }));
    await settle();
    expect(worker().commands("complete")).toHaveLength(1);
  });
});

describe("EngineHost: the idle unload", () => {
  it("starts the idle timer at the release, clears it for a new completion, and unloads when it fires", async () => {
    // idle minutes × 60,000 ms after the last run; a completion clears it; firing unloads.
    const { host, worker, timers: all, cleared } = makeHost();
    // The load deadline uses the same timer dependency; this test follows the idle timer only.
    const timers = (): Timer[] => all.filter((timer) => timer.ms !== DEFAULT_LOAD_TIMEOUT_MS && timer.ms !== DEFAULT_UNLOAD_TIMEOUT_MS);
    const idle = (index: number): Timer => timers()[index]!;
    const minutes = 5;
    host.setIdleMinutes(minutes);
    await host.ensure(load(SMALL), "A");
    expect(timers()).toHaveLength(0);
    host.release("A");
    expect(timers()).toHaveLength(1);
    expect(idle(0).ms).toBe(minutes * 60_000);
    expect(host.status().idle_unload_at).toBe(new Date(NOW.getTime() + minutes * 60_000).toISOString());
    const port = new RecordingPort();
    host.attach("C", port);
    port.ask({ id: 1, kind: "complete", request: request(SMALL) });
    expect(cleared).toContain(idle(0).handle);
    await vi.waitFor(() => expect(port.reply(1)).toMatchObject({ ok: true }));
    await vi.waitFor(() => expect(timers()).toHaveLength(2));
    idle(1).callback();
    await vi.waitFor(() => expect(worker().commands("unload")).toHaveLength(1));
    expect(host.status().loaded).toBeNull();
    expect(host.loadedEntry()).toBeNull();
  });
});

describe("EngineHost: the idle unload, a stale timer", () => {
  // T41 review 2, finding 1: A's idle timer fires while a Settings Load of B holds the gate; its
  // callback queues behind the load and, once B is in (no run holds it), must not unload B.
  it("never lets an idle callback that fired during a Settings load unload the model that load brought in", async () => {
    const { host, worker, timers } = makeHost();
    const idle = (): Timer[] => timers.filter((timer) => timer.ms === 10 * 60_000);
    await host.ensure(load(SMALL), null);
    expect(idle()).toHaveLength(1);
    const loadingOther = host.ensure(load(OTHER), null);
    idle()[0]!.callback(); // fires at 9:59, after the Load was pressed
    await expect(loadingOther).resolves.toMatchObject({ entry: OTHER.id });
    await settle();
    expect(host.status().loaded).toMatchObject({ entry: OTHER.id });
    expect(worker().commands("unload")).toHaveLength(1); // A's, during the switch; none for B
    expect(idle()).toHaveLength(2); // B's own timer, armed by its load
    idle()[1]!.callback();
    await vi.waitFor(() => expect(worker().commands("unload")).toHaveLength(2));
    expect(host.status().loaded).toBeNull();
  });
});

describe("EngineHost: an unload that never answers", () => {
  // T41 review 2, finding 2: wllama's nested Worker can die silently during `exit()` as during a
  // load; the gate must move on rather than hold every later load, unload and run start.
  it("treats an Unload that outlives its deadline as a dead Worker, records no context, and lets the next load through", async () => {
    const { host, workers, timers, models } = makeHost();
    await host.ensure(load(SMALL), null);
    workers[0]!.silentKinds.add("unload");
    const unloading = host.unload();
    const next = host.ensure(load(OTHER), "R");
    await vi.waitFor(() => expect(timers.filter((timer) => timer.ms === DEFAULT_UNLOAD_TIMEOUT_MS)).toHaveLength(1));
    timers.find((timer) => timer.ms === DEFAULT_UNLOAD_TIMEOUT_MS)!.callback();
    await unloading;
    await expect(next).resolves.toMatchObject({ entry: OTHER.id });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2); // spawned because the run asked for a load, not by itself
    expect((await models.get(SMALL.id))!.failed_context).toBeNull();
    expect(host.status()).toMatchObject({ loaded: { entry: OTHER.id }, last_failure: null });
  });

  it("records nothing against the entry being loaded when the unload before it hangs", async () => {
    const { host, workers, timers, models } = makeHost();
    await host.ensure(load(SMALL), null);
    workers[0]!.silentKinds.add("unload");
    const switching = host.ensure(load(OTHER), "R");
    await vi.waitFor(() => expect(timers.filter((timer) => timer.ms === DEFAULT_UNLOAD_TIMEOUT_MS)).toHaveLength(1));
    timers.find((timer) => timer.ms === DEFAULT_UNLOAD_TIMEOUT_MS)!.callback();
    await expect(switching).resolves.toMatchObject({ entry: OTHER.id });
    expect((await models.get(OTHER.id))!.failed_context).toBeNull();
    expect((await models.get(SMALL.id))!.failed_context).toBeNull();
  });

  // T41 review 3, finding 1: the same window, but the Worker dies (`onerror`) during the switch's
  // unload instead of staying silent. The entry being loaded was never sent to it: nothing is recorded.
  it("records nothing against either entry when the Worker dies during a switch's unload", async () => {
    const { host, workers, models } = makeHost();
    await host.ensure(load(SMALL), null);
    workers[0]!.silentKinds.add("unload");
    const switching = host.ensure(load(OTHER), "R");
    await vi.waitFor(() => expect(workers[0]!.commands("unload")).toHaveLength(1));
    expect(workers[0]!.commands("load")).toHaveLength(1);
    workers[0]!.die();
    await expect(switching).resolves.toMatchObject({ entry: OTHER.id });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.commands("load")).toHaveLength(1);
    await settle();
    expect((await models.get(OTHER.id))!.failed_context).toBeNull();
    expect((await models.get(SMALL.id))!.failed_context).toBeNull();
    expect(host.status()).toMatchObject({ loaded: { entry: OTHER.id }, last_failure: null });
    // The entry loads again at that context: no failed_before.
    await host.unload();
    await expect(host.ensure(load(OTHER), "R")).resolves.toMatchObject({ entry: OTHER.id });
  });
});

describe("EngineHost: a dead Worker", () => {
  // T41 review 2, nit 3: two runs start together on one entry; the first load kills the Worker. The
  // second must read the failed context the death records, not retry the context that just died.
  it("records a dead load's context before the next queued load reads the row", async () => {
    const { host, workers, models } = makeHost(undefined, (worker) => (worker.silent = true));
    const update = models.update.bind(models);
    models.update = async (...args) => {
      for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      return update(...args);
    };
    const { value } = await withUnhandledRejections(async () => {
      const first = host.ensure(load(SMALL), "A");
      const second = host.ensure(load(SMALL), "B");
      await vi.waitFor(() => expect(workers[0]?.commands("load")).toHaveLength(1));
      workers[0]!.die();
      return [await refusal(first), await refusal(second)];
    });
    expect(value[0]).toMatchObject({ detail: { reason: "engine_worker_died" } });
    expect(value[1]).toMatchObject({ detail: { reason: "failed_before", failed_context: CONTEXT } });
    expect(workers).toHaveLength(1);
  });

  it("fails the in-flight and queued completions, records the context, and is not restarted by itself", async () => {
    // onerror: engine_worker_died to every waiting call, failed_context on the row, no automatic spawn.
    const { host, models, workers, worker } = makeHost();
    await host.ensure(load(SMALL), "A");
    const port = new RecordingPort();
    host.attach("A", port);
    worker().hold = true;
    port.ask({ id: 1, kind: "complete", request: request(SMALL) });
    port.ask({ id: 2, kind: "complete", request: request(SMALL) });
    await settle();
    worker().die();
    for (const id of [1, 2]) expect(port.reply(id)).toMatchObject({ ok: false, error: { code: "model_unavailable", detail: { reason: "engine_worker_died" } } });
    await vi.waitFor(async () => expect((await models.get(SMALL.id))!.failed_context).toBe(CONTEXT));
    expect(host.status()).toMatchObject({ loaded: null, busy: false, queued: 0, runs: [], last_failure: { entry: SMALL.id, n_ctx: CONTEXT, reason: "engine_worker_died", at: NOW.toISOString() } });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    await settle();
    expect(workers).toHaveLength(1);
    // The same context is refused; a smaller one spawns a new Worker only because it was asked.
    expect(await refusal(host.ensure(load(SMALL), "A"))).toMatchObject({ detail: { reason: "failed_before" } });
    expect(workers).toHaveLength(1);
    await host.ensure(load(SMALL, { n_ctx: CONTEXT / 2 }), "A");
    expect(workers).toHaveLength(2);
    expect(workers[1]!.commands("load")).toHaveLength(1);
  });

  it("refuses the load with engine_worker_died when the Worker dies while loading", async () => {
    // A Worker killed during the load command fails that ensure as the engine dying.
    const { host, workers, models } = makeHost(undefined, (worker) => (worker.silent = true));
    const { value: refused } = await withUnhandledRejections(async () => {
      const pending = host.ensure(load(SMALL), "A");
      await vi.waitFor(() => expect(workers[0]?.commands("load")).toHaveLength(1));
      expect(host.status().loading).toBe(SMALL.id);
      workers[0]!.die();
      return refusal(pending);
    });
    expect(refused).toMatchObject({ code: "model_unavailable", detail: { reason: "engine_worker_died", entry: SMALL.id } });
    expect(host.status()).toMatchObject({ loaded: null, loading: null });
    // A load that kills the Worker is the "does not fit" case (design §3): that context is recorded and never retried by itself.
    await vi.waitFor(async () => expect((await models.get(SMALL.id))!.failed_context).toBe(load(SMALL).n_ctx));
    expect(host.status().last_failure).toMatchObject({ entry: SMALL.id, n_ctx: load(SMALL).n_ctx });
  });

  // Found while writing these tests: `done` (which orders later loads) once left an unhandled
  // rejection after every failed load; it now swallows the failure, which the caller receives.
  it("leaves no unhandled rejection behind when a load fails", async () => {
    // A failed load is answered to its caller and nowhere else.
    const { host, workers } = makeHost(undefined, (worker) => (worker.silent = true));
    const { unhandled } = await withUnhandledRejections(async () => {
      const pending = host.ensure(load(SMALL), "A");
      await vi.waitFor(() => expect(workers[0]?.commands("load")).toHaveLength(1));
      const command = workers[0]!.commands("load")[0] as Extract<EngineCommand, { kind: "load" }>;
      workers[0]!.silent = false;
      workers[0]!.send({ kind: "answer", id: command.id, ok: false, error: { code: "engine_error", message: "failed to load the model" } });
      return refusal(pending);
    });
    expect(unhandled).toEqual([]);
  });
});

describe("EngineHost: measured speeds", () => {
  it("records the first completion's timings and context on the row, and only the first", async () => {
    // The first completion after a load measures prefill and decode at the loaded context.
    const { host, models, worker } = makeHost();
    await host.ensure(load(SMALL), "A");
    const port = new RecordingPort();
    host.attach("A", port);
    port.ask({ id: 1, kind: "complete", request: request(SMALL) });
    await vi.waitFor(async () => expect((await models.get(SMALL.id))!.measured).not.toBeNull());
    expect((await models.get(SMALL.id))!.measured).toEqual({ prefill_tok_per_s: Math.round(COMPLETION.timings!.prompt_per_second! * 10) / 10, decode_tok_per_s: Math.round(COMPLETION.timings!.predicted_per_second! * 10) / 10, context: CONTEXT, at: NOW.toISOString() });
    worker().completion = { ...COMPLETION, timings: { prompt_per_second: 1, predicted_per_second: 1 } };
    port.ask({ id: 2, kind: "complete", request: request(SMALL) });
    await vi.waitFor(() => expect(port.reply(2)).toMatchObject({ ok: true }));
    await settle();
    expect((await models.get(SMALL.id))!.measured!.decode_tok_per_s).toBe(Math.round(COMPLETION.timings!.predicted_per_second! * 10) / 10);
  });
});

describe("MessagePortEnginePort over a MessageChannel", () => {
  const channels: MessageChannel[] = [];
  afterEach(() => {
    for (const channel of channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
  });

  async function connected(runId = "A") {
    const setup = makeHost();
    await setup.host.ensure(load(SMALL), runId);
    const channel = new MessageChannel();
    channels.push(channel);
    setup.host.attach(runId, channel.port1 as unknown as PortLike);
    const port = new MessagePortEnginePort(channel.port2 as unknown as RunPortLike);
    return { ...setup, port };
  }

  it("answers status and a completion round trip", async () => {
    // The run Worker's port reaches the host's status and queue.
    const { port } = await connected();
    expect(await port.status()).toEqual({ loaded: SMALL.id, busy: false });
    expect(await port.complete(request(SMALL), new AbortController().signal)).toEqual(COMPLETION);
  });

  it("rethrows the host's model_request_invalid as an AdapterError with that code", async () => {
    // An over-context failure from the engine keeps the contract's code.
    const { port, worker } = await connected();
    worker().nextCompletionError = { code: "engine_error", message: "the prompt exceeds the context window (n_ctx)" };
    const attempt = port.complete(request(SMALL), new AbortController().signal);
    await expect(attempt).rejects.toBeInstanceOf(AdapterError);
    await expect(attempt).rejects.toMatchObject({ code: "model_request_invalid" });
  });

  it("rejects at once with the signal's reason on the run's abort and tells the host", async () => {
    // The abort does not wait for the engine; the host passes it to the Worker.
    const { port, worker } = await connected();
    worker().hold = true;
    const controller = new AbortController();
    const attempt = port.complete(request(SMALL), controller.signal);
    await vi.waitFor(() => expect(worker().held).toHaveLength(1));
    const reason = new Error("the run was cancelled");
    controller.abort(reason);
    await expect(attempt).rejects.toBe(reason);
    await vi.waitFor(() => expect(worker().commands("abort")).toEqual([{ kind: "abort", target: worker().held[0] }]));
    // An already aborted signal never asks.
    await expect(port.complete(request(SMALL), controller.signal)).rejects.toBe(reason);
    expect(worker().commands("complete")).toHaveLength(1);
  });

  it("fails every waiting call model_unavailable on close, and every later one", async () => {
    // The run ended: waiting calls fail as the engine being gone.
    const { port, worker } = await connected();
    worker().hold = true;
    const attempt = port.complete(request(SMALL), new AbortController().signal);
    await vi.waitFor(() => expect(worker().held).toHaveLength(1));
    port.close();
    await expect(attempt).rejects.toBeInstanceOf(AdapterError);
    await expect(attempt).rejects.toMatchObject({ code: "model_unavailable" });
    await expect(port.status()).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("gives the core adapter the engine's counts end to end", async () => {
    // prompt_tokens is the whole prompt; the cached part is reported as cache reads.
    const { port, worker } = await connected();
    const adapter = new InBrowserAdapter(port, { entry: SMALL.id, contextWindow: CONTEXT, reasoning: true, think: false });
    const rendered = render({ task: "t", instructions: ["Answer."], data: {}, output_schema: { type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, requirements: { id: "t", capabilities: [], context_window: 1000, preferred_tier: null }, budget_context: { max_output_tokens: 50 }, audit_context: { worker: "W", node_id: "n" } });
    const completion = await adapter.complete(rendered, 50, new AbortController().signal);
    const usage = COMPLETION.usage;
    expect(completion.usage).toEqual({ input_tokens: usage.prompt_tokens! - usage.cached_prompt_tokens!, output_tokens: usage.completion_tokens, cache_read_tokens: usage.cached_prompt_tokens, cache_write_tokens: null, total_tokens: usage.total_tokens, cost_usd: null });
    expect(completion).toMatchObject({ text: COMPLETION.text, model_id: `in-browser/${SMALL.id}`, stop_reason: "stop", constrained: true });
    const sent = worker().commands("complete")[0] as Extract<EngineCommand, { kind: "complete" }>;
    expect(sent.request).toMatchObject({ entry: SMALL.id, max_tokens: 50, think: false });
    expect(sent.request.schema).not.toBeNull();
  });
});
