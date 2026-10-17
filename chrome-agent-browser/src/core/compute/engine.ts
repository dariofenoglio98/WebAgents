/**
 * Running one compute call in a nested Worker per call (compute.v0 §4, §5; D-250, D-251): the
 * port of `agentpkg/compute/engine.py` onto the engine every host has, V8.
 *
 * A call is one fresh Worker, one fresh instance, and the Worker is terminated when it answers,
 * when the deadline passes and when the run is cancelled: `terminate()` is the CPU bound here,
 * since V8 meters no fuel (`fuel_consumed` is null, D-244) and a thread cannot interrupt itself.
 * Modules compile once per run (`compile`, the preflight of D-245: a module V8 refuses is
 * `module_invalid`) and the compiled `WebAssembly.Module` travels to the call's Worker by
 * structured clone, so no call pays for compilation. Memory is bounded by the module's own
 * declared maximum, which V8 enforces; the preflight (C-31) has refused every module whose maximum
 * is above the host's page bound, so nothing is ever lowered.
 *
 * The engine never throws for a module's own failure: a trap, a passed deadline or an ABI
 * violation come back as a `ComputeOutcome` with a reason, and the runtime records it. It throws
 * only when the host is at fault (`EngineFault`, C-40's `worker_error`: a Worker that died without
 * answering, a module not compiled before the call) and when the run is cancelled (the signal's
 * reason, a `CancelledError`). Where the Worker comes from is the host's: `spawn()` is
 * `new Worker("compute-worker.js", {type: "module"})` in the extension and a `worker_threads`
 * adapter in the CLI; the host also names the engine (`chrome/155.0.8059.41`, `node/v26.9.0`).
 */
import type { ComputeLimits } from "./limits.js";
import { ModuleError } from "./module.js";
import { type CallAnswer, ENGINE_ERROR } from "./worker-body.js";

export const ENGINE_UNAVAILABLE = "compute_engine_unavailable";
export { ENGINE_ERROR, REASONS, TRAP_CODES } from "./worker-body.js";
export const COMPUTE_REQUEST_KIND = "chrome-agent-browser.compute-call";
export const COMPUTE_ANSWER_KIND = "chrome-agent-browser.compute-answer";

/** This host has no WebAssembly engine, or none was given to the runtime. */
export class EngineUnavailable extends Error {
  override readonly name = "EngineUnavailable";
  readonly code = ENGINE_UNAVAILABLE;
}

/**
 * The engine failed during a call for a reason that is not the module's (C-40): the host's fault,
 * recorded as `engine_error`, never as the module's `compute_error`.
 */
export class EngineFault extends Error {
  override readonly name = "EngineFault";
  readonly code = ENGINE_ERROR;
  readonly audit_facts: Record<string, never> = {};
}

/** What one call came to; `output` is set exactly when `reason` is null. */
export interface ComputeOutcome {
  output: Uint8Array | null;
  reason: string | null;
  trap_code: string | null;
  detail: string | null;
  memory_pages: number | null;
  elapsed_ms: number;
  fuel_consumed: number | null;
}

export interface ComputeEngine {
  /** The engine and its version, as `compute.completed` records it (`engine.id`). */
  readonly id: string;
  readonly metersFuel: boolean;
  /** Compile once per module; a module the engine refuses is `module_invalid`. */
  compile(sha256: string, data: Uint8Array): Promise<void>;
  /** One call under `limits` (its `wall_seconds` already the engine deadline the runtime chose, C-32), ended early by `signal`. */
  call(sha256: string, fn: string, data: Uint8Array, limits: ComputeLimits, signal: AbortSignal): Promise<ComputeOutcome>;
}

/** What the host's Worker looks like from here (the extension's `Worker`, a `worker_threads` adapter, a fake in tests). */
export interface ComputeWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
}

export type ComputeWorkerRequest = { kind: typeof COMPUTE_REQUEST_KIND; module: WebAssembly.Module; function: string; input: ArrayBuffer };
export type ComputeWorkerAnswer = { kind: typeof COMPUTE_ANSWER_KIND } & CallAnswer;

/** Compile a module with the host's engine; what V8 refuses after the reader accepted is `module_invalid`. */
export async function compileModule(data: Uint8Array): Promise<WebAssembly.Module> {
  try {
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return await WebAssembly.compile(copy);
  } catch {
    // The engine's own words are never recorded; the code is what both runtimes agree on.
    throw new ModuleError("module_invalid", "the engine refused the module");
  }
}

export interface WorkerEngineOptions {
  /** The engine's identity for the audit: `<engine>/<version>`. */
  id: string;
}

/** The engine over a host's Workers: one per call, terminated on answer, deadline and cancel. */
export function workerComputeEngine(spawn: () => ComputeWorkerLike, options: WorkerEngineOptions): ComputeEngine {
  const compiled = new Map<string, WebAssembly.Module>();
  return {
    id: options.id,
    metersFuel: false,
    async compile(sha256, data) {
      if (compiled.has(sha256)) return;
      const module = await compileModule(data);
      // Two concurrent compiles of one module keep the first; both are the same bytes.
      if (!compiled.has(sha256)) compiled.set(sha256, module);
    },
    call(sha256, fn, data, limits, signal) {
      return new Promise<ComputeOutcome>((resolve, reject) => {
        const module = compiled.get(sha256);
        if (module === undefined) {
          reject(new EngineFault("the module was not compiled before the call"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        let worker: ComputeWorkerLike;
        try {
          worker = spawn();
        } catch {
          reject(new EngineFault("the engine could not start a Worker for the call"));
          return;
        }
        const started = Date.now();
        let settled = false;
        const finish = (outcome: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          worker.terminate();
          outcome();
        };
        const onAbort = (): void => finish(() => reject(signal.reason));
        // The wall bound is the CPU bound (D-250): the Worker is terminated and the call is `deadline`.
        const timer = setTimeout(() => finish(() => resolve({ output: null, reason: "deadline", trap_code: null, detail: null, memory_pages: null, elapsed_ms: Date.now() - started, fuel_consumed: null })), Math.max(0, limits.wall_seconds * 1000));
        signal.addEventListener("abort", onAbort, { once: true });
        worker.onmessage = (event) => {
          const answer = event.data as ComputeWorkerAnswer | { kind?: unknown } | null;
          if (typeof answer !== "object" || answer === null || answer.kind !== COMPUTE_ANSWER_KIND) return;
          const call = answer as ComputeWorkerAnswer;
          if (call.ok === true) {
            finish(() => resolve({ output: new Uint8Array(call.output), reason: null, trap_code: null, detail: null, memory_pages: call.memory_pages, elapsed_ms: call.elapsed_ms, fuel_consumed: null }));
          } else if (call.reason === ENGINE_ERROR) {
            finish(() => reject(new EngineFault("the engine failed during the call")));
          } else {
            finish(() => resolve({ output: null, reason: call.reason, trap_code: call.trap_code ?? null, detail: call.detail ?? null, memory_pages: call.memory_pages, elapsed_ms: call.elapsed_ms, fuel_consumed: null }));
          }
        };
        // A Worker that dies without answering is the host's fault, not the module's (C-40).
        worker.onerror = () => finish(() => reject(new EngineFault("the engine failed during the call")));
        worker.onmessageerror = () => finish(() => reject(new EngineFault("the engine failed during the call")));
        const input = new ArrayBuffer(data.length);
        new Uint8Array(input).set(data);
        const request: ComputeWorkerRequest = { kind: COMPUTE_REQUEST_KIND, module, function: fn, input };
        try {
          worker.postMessage(request, [input]);
        } catch {
          finish(() => reject(new EngineFault("the engine could not hand the call to its Worker")));
        }
      });
    },
  };
}

/** What a Worker entry does with one request: the body, then the answer, exactly once (the entries call this). */
export function answerComputeRequest(request: unknown, run: (module: WebAssembly.Module, fn: string, input: Uint8Array) => CallAnswer): ComputeWorkerAnswer | null {
  if (typeof request !== "object" || request === null || (request as { kind?: unknown }).kind !== COMPUTE_REQUEST_KIND) return null;
  const message = request as Partial<ComputeWorkerRequest>;
  if (!(message.module instanceof WebAssembly.Module) || typeof message.function !== "string" || !(message.input instanceof ArrayBuffer)) {
    return { kind: COMPUTE_ANSWER_KIND, ok: false, reason: ENGINE_ERROR, memory_pages: null, elapsed_ms: 0 };
  }
  try {
    return { kind: COMPUTE_ANSWER_KIND, ...run(message.module, message.function, new Uint8Array(message.input)) };
  } catch {
    return { kind: COMPUTE_ANSWER_KIND, ok: false, reason: ENGINE_ERROR, memory_pages: null, elapsed_ms: 0 };
  }
}
