/**
 * The in-browser engine's messages (T41, D-450). Three parties, two channels:
 *
 *   EngineHost (offscreen page) ⇄ engine Worker   `EngineCommand` / `EngineEvent`: probe, benchmark,
 *                                                 load, complete, abort, unload; one answer per id
 *   run Worker ⇄ EngineHost                        `PortRequest` / `PortReply` over a `MessagePort`
 *                                                 the host transfers inside `host.start` (one port
 *                                                 per run, for the entry the run's plan bound)
 *
 * The run Worker never spawns an engine and never loads a model: it asks for the status and for
 * completions on the port, and the host queues the completions (one at a time, D-441).
 */
import type { JsonObject } from "../../core/json.js";
import type { InBrowserCompletion, InBrowserCompletionRequest } from "../../core/models/adapters/in-browser.js";

export interface EngineProbe {
  has_webgpu: boolean;
  device_memory_gb: number | null;
  hardware_concurrency: number | null;
  storage: { quota: number | null; usage: number | null } | null;
  cross_origin_isolated: boolean | null;
  /** Whether this browser exposes Cross-Origin Storage (`navigator.crossOriginStorage`, D-448): a feature detect only; v1 never uses it. */
  cross_origin_storage?: boolean;
  adapter: { vendor: string | null; architecture: string | null; description: string | null; is_fallback: boolean | null; features: string[]; max_buffer_size: number | null; max_storage_buffer_binding_size: number | null } | null;
  device: boolean | string;
}

export interface EngineBenchmark {
  ms: number;
  gflops: number;
  f16: boolean;
  kernel_class: "fast" | "medium" | "slow";
  n: number;
  repeats: number;
}

export interface EngineLoadResult {
  entry: string;
  load_ms: number;
  n_ctx: number;
  n_ctx_train: number;
  n_layer: number;
  multithread: boolean;
  think: boolean;
  /** Null when every layer was offloaded (the engine's default); 0 for a CPU-only control. */
  n_gpu_layers: number | null;
  /** llama.cpp's own lines about where the layers went, as wllama's logger passed them. */
  offload_log: string[];
}

export type EngineCompletionResult = InBrowserCompletion & { ms: number };

export type EngineCommand =
  | { id: number; kind: "probe" }
  | { id: number; kind: "benchmark" }
  | { id: number; kind: "load"; entry: string; files: string[]; n_ctx: number; think: boolean; n_gpu_layers?: number }
  | { id: number; kind: "complete"; request: Omit<InBrowserCompletionRequest, "schema"> & { schema: JsonObject | null } }
  | { id: number; kind: "unload" }
  | { kind: "abort"; target: number };

export type EngineEvent = { kind: "answer"; id: number; ok: true; result: unknown } | { kind: "answer"; id: number; ok: false; error: { code: string; message: string } };

/** What a run's port asks the host. */
export type PortRequest = { id: number; kind: "status" } | { id: number; kind: "complete"; request: InBrowserCompletionRequest } | { id: number; kind: "abort"; target: number };

/** The host's answer; an error keeps the core's `AdapterError` code and detail. */
export type PortReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { code: string; message: string; detail?: Record<string, unknown> | null; audit_facts?: Record<string, unknown> | null } };

/** D-455: the benchmark's size, repetitions and class thresholds in GFLOP/s (a class, not a tok/s promise). */
export const BENCHMARK_N = 512;
export const BENCHMARK_REPEATS = 2;
export const KERNEL_CLASS_FAST_GFLOPS = 400;
export const KERNEL_CLASS_MEDIUM_GFLOPS = 100;

export function kernelClass(gflops: number): "fast" | "medium" | "slow" {
  return gflops >= KERNEL_CLASS_FAST_GFLOPS ? "fast" : gflops >= KERNEL_CLASS_MEDIUM_GFLOPS ? "medium" : "slow";
}

/** The script names beside `execution-page.js` (the build emits them; `check-pack` expects them). */
export const ENGINE_WORKER_SCRIPT = "engine-worker.js";
export const MODELS_WORKER_SCRIPT = "models-worker.js";
export const ENGINE_WASM = "wllama.wasm";

/** `Omit` over each member of a union (TypeScript's own `Omit` collapses a union first). */
export type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
