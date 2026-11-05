/**
 * The engine Worker (T41, D-440, D-441, D-450): wllama 3.8.1 (llama.cpp on WebGPU) in a dedicated
 * Worker the offscreen page's `EngineHost` creates and owns, so a loaded model outlives the runs
 * that use it. It holds at most one model and answers one command at a time from its one sender,
 * the host:
 *
 *   probe      WebGPU and the platform facts as this Worker sees them (the recommendation's inputs)
 *   benchmark  a fixed WebGPU matmul (D-455): the bandwidth class, not a tok/s promise
 *   load       the cached files (OPFS `models/<sha256>`, handed to wllama as Blobs: no copy) at a
 *              context and with thinking on or off (D-085 → wllama's `reasoning`)
 *   complete   one non-streamed chat completion under the JSON-schema grammar, the prompt cache on,
 *              the counts as the core's contract wants them (`prompt_n + cache_n`, D-445)
 *   abort      stop the completion in flight
 *   unload     `exit()`: the engine's memory goes with it
 *
 * The weights are data a fixed program reads; the wasm is bundled beside this script
 * (`wllama.wasm`) and compiled under the extension's `'wasm-unsafe-eval'` CSP; nothing is fetched.
 * Design: `docs/design/in-browser-inference.md` §3, §4. The spike's calls
 * (`scripts/spike/inbrowser-spike-worker.ts`) hardened.
 */
// The published ESM build; the package names no entry point of its own, and its `.d.ts` files
// re-export without extensions, which NodeNext resolution cannot follow, so the surface this
// Worker uses is typed here (wllama 3.8.1, `esm/wllama.d.ts`).
import * as wllamaModule from "@wllama/wllama/esm/index.js";

interface WllamaLike {
  loadModel(blobs: Blob[], params?: Record<string, unknown>): Promise<void>;
  getLoadedContextInfo(): { n_ctx: number; n_ctx_train: number; n_layer: number };
  isMultithread(): boolean;
  createChatCompletion(params: Record<string, unknown>): Promise<unknown>;
  exit(): Promise<void>;
}
type Wllama = WllamaLike;
const Wllama = (wllamaModule as unknown as { Wllama: new (paths: { default: string }, config: Record<string, unknown>) => WllamaLike }).Wllama;

import { cachedBlobs } from "../storage/opfs-models.js";
import { BENCHMARK_N, BENCHMARK_REPEATS, ENGINE_WASM, kernelClass, type EngineBenchmark, type EngineCommand, type EngineCompletionResult, type EngineEvent, type EngineLoadResult, type EngineProbe } from "./engine-protocol.js";

const scope = self as unknown as { onmessage: ((event: MessageEvent<EngineCommand>) => void) | null; postMessage(message: EngineEvent): void; location: { href: string } };

let engine: Wllama | null = null;
let loaded: { entry: string; n_ctx: number; think: boolean } | null = null;
const inFlight = new Map<number, AbortController>();
/** The native log lines that say where the layers went (llama.cpp's offload lines), kept from the last load. */
let offloadLines: string[] = [];

const OFFLOAD = /offload|ggml_webgpu|WebGPU|backend|CPU_Mapped|buffer size/iu;
function captureLog(...parts: unknown[]): void {
  const line = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  if (OFFLOAD.test(line) && offloadLines.length < 40) offloadLines.push(line.slice(0, 300));
}
const logger = { debug: () => undefined, log: captureLog, warn: captureLog, error: captureLog };

interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string; isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
  features: Iterable<string>;
  limits: Record<string, number>;
  requestDevice(descriptor?: { requiredFeatures?: string[] }): Promise<GpuDeviceLike>;
}
interface GpuDeviceLike {
  createShaderModule(descriptor: { code: string }): unknown;
  createComputePipeline(descriptor: unknown): { getBindGroupLayout(index: number): unknown };
  createBuffer(descriptor: { size: number; usage: number }): { destroy(): void };
  createBindGroup(descriptor: unknown): unknown;
  createCommandEncoder(): { beginComputePass(): { setPipeline(p: unknown): void; setBindGroup(i: number, g: unknown): void; dispatchWorkgroups(x: number, y: number): void; end(): void }; finish(): unknown };
  queue: { submit(buffers: unknown[]): void; onSubmittedWorkDone(): Promise<void> };
  destroy(): void;
}
type Gpu = { requestAdapter(options?: Record<string, unknown>): Promise<GpuAdapterLike | null> };

function gpu(): Gpu | null {
  return ((navigator as Navigator & { gpu?: Gpu }).gpu ?? null) as Gpu | null;
}

async function probe(): Promise<EngineProbe> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const storage = await navigator.storage.estimate().then((estimate) => ({ quota: estimate.quota ?? null, usage: estimate.usage ?? null })).catch(() => null);
  const base = { has_webgpu: gpu() !== null, device_memory_gb: nav.deviceMemory ?? null, hardware_concurrency: navigator.hardwareConcurrency ?? null, storage, cross_origin_isolated: (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? null, cross_origin_storage: "crossOriginStorage" in navigator };
  const api = gpu();
  if (api === null) return { ...base, adapter: null, device: false };
  const adapter = await api.requestAdapter();
  if (adapter === null) return { ...base, adapter: null, device: false };
  const info = adapter.info ?? {};
  let device: boolean | string = false;
  try {
    (await adapter.requestDevice()).destroy();
    device = true;
  } catch (error) {
    device = `${(error as Error).name}: ${(error as Error).message}`.slice(0, 200);
  }
  return {
    ...base,
    adapter: {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      description: info.description ?? null,
      // Chrome 156 reports the fallback flag on `adapter.info`; `GPUAdapter.isFallbackAdapter` is undefined there (T40 review 2).
      is_fallback: typeof info.isFallbackAdapter === "boolean" ? info.isFallbackAdapter : typeof adapter.isFallbackAdapter === "boolean" ? adapter.isFallbackAdapter : null,
      features: [...adapter.features].sort(),
      max_buffer_size: adapter.limits.maxBufferSize ?? null,
      max_storage_buffer_binding_size: adapter.limits.maxStorageBufferBindingSize ?? null,
    },
    device,
  };
}

/** A tiled matmul in WGSL, f16 storage when the adapter offers `shader-f16`. */
function matmulShader(f16: boolean): string {
  const t = f16 ? "f16" : "f32";
  return `${f16 ? "enable f16;\n" : ""}
@group(0) @binding(0) var<storage, read> a: array<${t}>;
@group(0) @binding(1) var<storage, read> b: array<${t}>;
@group(0) @binding(2) var<storage, read_write> c: array<${t}>;
const N: u32 = ${BENCHMARK_N}u;
const T: u32 = 16u;
var<workgroup> ta: array<${t}, 256>;
var<workgroup> tb: array<${t}, 256>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  var acc: ${t} = ${t}(0.0);
  for (var k: u32 = 0u; k < N; k = k + T) {
    ta[l.y * T + l.x] = a[g.y * N + k + l.x];
    tb[l.y * T + l.x] = b[(k + l.y) * N + g.x];
    workgroupBarrier();
    for (var i: u32 = 0u; i < T; i = i + 1u) { acc = acc + ta[l.y * T + i] * tb[i * T + l.x]; }
    workgroupBarrier();
  }
  c[g.y * N + g.x] = acc;
}`;
}

async function benchmark(): Promise<EngineBenchmark> {
  const api = gpu();
  if (api === null) throw new Error("no WebGPU in this Worker");
  const adapter = await api.requestAdapter();
  if (adapter === null) throw new Error("no WebGPU adapter");
  const f16 = [...adapter.features].includes("shader-f16");
  const device = await adapter.requestDevice(f16 ? { requiredFeatures: ["shader-f16"] } : {});
  try {
    const bytes = BENCHMARK_N * BENCHMARK_N * (f16 ? 2 : 4);
    const STORAGE = 0x80; // GPUBufferUsage.STORAGE
    const buffers = [0, 1, 2].map(() => device.createBuffer({ size: bytes, usage: STORAGE }));
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: matmulShader(f16) }), entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const run = async (times: number): Promise<number> => {
      const started = performance.now();
      const encoder = device.createCommandEncoder();
      for (let index = 0; index < times; index += 1) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(BENCHMARK_N / 16, BENCHMARK_N / 16);
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - started;
    };
    await run(1); // compile and warm
    const ms = await run(BENCHMARK_REPEATS);
    for (const buffer of buffers) buffer.destroy();
    const gflops = (2 * BENCHMARK_N ** 3 * BENCHMARK_REPEATS) / (ms / 1000) / 1e9;
    return { ms: Math.round(ms * 10) / 10, gflops: Math.round(gflops), f16, kernel_class: kernelClass(gflops), n: BENCHMARK_N, repeats: BENCHMARK_REPEATS };
  } finally {
    device.destroy();
  }
}

async function load(command: Extract<EngineCommand, { kind: "load" }>): Promise<EngineLoadResult> {
  await unload();
  offloadLines = [];
  const blobs = await cachedBlobs(command.files);
  engine = new Wllama({ default: new URL(ENGINE_WASM, scope.location.href).href }, { suppressNativeLog: false, logger, parallelDownloads: 1 });
  const started = performance.now();
  try {
    await engine.loadModel(blobs, { n_ctx: command.n_ctx, reasoning: command.think, ...(command.n_gpu_layers === undefined ? {} : { n_gpu_layers: command.n_gpu_layers }) });
  } catch (error) {
    const failed = engine;
    engine = null;
    await failed.exit().catch(() => undefined);
    throw error;
  }
  const info = engine.getLoadedContextInfo();
  loaded = { entry: command.entry, n_ctx: info.n_ctx, think: command.think };
  return { entry: command.entry, load_ms: Math.round(performance.now() - started), n_ctx: info.n_ctx, n_ctx_train: info.n_ctx_train, n_layer: info.n_layer, multithread: engine.isMultithread(), think: command.think, n_gpu_layers: command.n_gpu_layers ?? null, offload_log: [...offloadLines] };
}

async function unload(): Promise<void> {
  const held = engine;
  engine = null;
  loaded = null;
  for (const controller of inFlight.values()) controller.abort();
  if (held) await held.exit().catch(() => undefined);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

async function complete(command: Extract<EngineCommand, { kind: "complete" }>): Promise<EngineCompletionResult> {
  if (engine === null || loaded === null || loaded.entry !== command.request.entry) throw Object.assign(new Error("the engine does not hold this model"), { code: "model_unavailable" });
  const controller = new AbortController();
  inFlight.set(command.id, controller);
  const started = performance.now();
  try {
    const request = {
      messages: [
        { role: "system" as const, content: command.request.system },
        { role: "user" as const, content: command.request.user },
      ],
      max_tokens: command.request.max_tokens,
      temperature: 0,
      stream: false,
      // D-450: the prompt cache on, so a re-ask reuses its prompt; the counts below add `cache_n`
      // back, so the whole prompt is charged (D-445, T40 review 2 finding b).
      cache_prompt: true,
      abortSignal: controller.signal,
      ...(command.request.schema ? { response_format: { type: "json_schema" as const, json_schema: { name: "agentpkg_node_output", schema: command.request.schema, strict: true } } } : {}),
    };
    let response: Record<string, unknown>;
    try {
      response = (await engine.createChatCompletion(request)) as unknown as Record<string, unknown>;
    } catch (error) {
      if (controller.signal.aborted) return { text: null, finish_reason: "abort", usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }, timings: null, constrained: command.request.schema !== null, ms: Math.round(performance.now() - started) };
      throw error;
    }
    const choice = (response.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const usage = (response.usage as Record<string, unknown> | undefined) ?? {};
    const timings = (response.timings as Record<string, unknown> | undefined) ?? null;
    const promptN = count(timings?.prompt_n);
    const cacheN = count(timings?.cache_n);
    // The whole prompt: the engine's uncached and cached tokens (D-445); `usage.prompt_tokens` alone
    // counts only the uncached part when the cache is on.
    const promptTokens = promptN !== null && cacheN !== null ? promptN + cacheN : count(usage.prompt_tokens);
    const completionTokens = count(usage.completion_tokens) ?? count(timings?.predicted_n);
    const cached = cacheN ?? count((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
    return {
      text: typeof message?.content === "string" ? message.content : null,
      finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null, cached_prompt_tokens: promptTokens === null ? null : cached },
      timings: timings === null ? null : { prompt_per_second: typeof timings.prompt_per_second === "number" ? timings.prompt_per_second : null, predicted_per_second: typeof timings.predicted_per_second === "number" ? timings.predicted_per_second : null },
      constrained: command.request.schema !== null,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    inFlight.delete(command.id);
  }
}

function errorOf(error: unknown): { code: string; message: string } {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "engine_error";
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { code, message: message.slice(0, 500) };
}

scope.onmessage = (event) => {
  const command = event.data;
  if (command.kind === "abort") {
    inFlight.get(command.target)?.abort();
    return;
  }
  void (async () => {
    try {
      let result: unknown;
      if (command.kind === "probe") result = await probe();
      else if (command.kind === "benchmark") result = await benchmark();
      else if (command.kind === "load") result = await load(command);
      else if (command.kind === "complete") result = await complete(command);
      else if (command.kind === "unload") result = (await unload(), { unloaded: true });
      else throw new Error(`unknown command ${String((command as { kind: unknown }).kind)}`);
      scope.postMessage({ kind: "answer", id: command.id, ok: true, result });
    } catch (error) {
      scope.postMessage({ kind: "answer", id: command.id, ok: false, error: errorOf(error) });
    }
  })();
};
