/**
 * The T40 spike's engine Worker (D-440): bundled by `scripts/spike-inbrowser.mjs` into a scratch copy
 * of the built extension, never into the shipped build. It is started by the harness inside the real
 * offscreen document (`execution.html`), where runs execute, and answers four commands: `probe`
 * (WebGPU and the platform facts as this Worker sees them), `load` (wllama over WebGPU on one GGUF
 * file served by the harness), `complete` (one chat completion under a JSON-schema grammar, streamed
 * so that the engine's timings are reported) and `unload`. Nothing here is product code: the
 * adapter contract T41 builds is `src/core/models/adapters/in-browser.ts`.
 */
import { Wllama } from "@wllama/wllama";

interface Command {
  id: number;
  kind: "probe" | "load" | "complete" | "unload";
  url?: string;
  nCtx?: number;
  reasoning?: boolean;
  nGpuLayers?: number;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  schema?: Record<string, unknown> | null;
  maxTokens?: number;
  abortAfterMs?: number | null;
  /** Non-streamed: the engine's `usage` object instead of per-chunk timings. */
  stream?: boolean;
  cachePrompt?: boolean;
}

const scope = self as unknown as { onmessage: ((event: MessageEvent<Command>) => void) | null; postMessage(message: unknown): void; location: { href: string } };
let engine: Wllama | null = null;
const silent = { debug: () => undefined, log: () => undefined, warn: () => undefined, error: () => undefined };

async function probe(): Promise<Record<string, unknown>> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> }; deviceMemory?: number };
  const out: Record<string, unknown> = {
    context: "dedicated Worker of the offscreen document",
    secure_context: self.isSecureContext,
    origin: self.origin,
    has_webgpu: !!nav.gpu,
    hardware_concurrency: navigator.hardwareConcurrency,
    device_memory_hint_gb: nav.deviceMemory ?? null,
    cross_origin_isolated: (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? null,
    memory64: (() => {
      try {
        new WebAssembly.Memory({ address: "i64", initial: 1n } as unknown as WebAssembly.MemoryDescriptor);
        return true;
      } catch {
        return false;
      }
    })(),
    jspi: !!(WebAssembly as unknown as { Suspending?: unknown }).Suspending,
    storage: await navigator.storage.estimate().then((e) => ({ quota: e.quota ?? null, usage: e.usage ?? null })).catch(() => null),
  };
  if (!nav.gpu) return out;
  const adapter = await nav.gpu.requestAdapter();
  if (!adapter) return { ...out, adapter: null };
  const info = adapter.info ?? {};
  out.adapter = {
    vendor: info.vendor ?? null,
    architecture: info.architecture ?? null,
    device: info.device ?? null,
    description: info.description ?? null,
    is_fallback: adapter.isFallbackAdapter ?? null,
    features: [...adapter.features].sort(),
    limits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
    },
  };
  try {
    const device = await adapter.requestDevice();
    out.device = true;
    device.destroy?.();
  } catch (error) {
    out.device = `${(error as Error).name}: ${(error as Error).message}`;
  }
  return out;
}

interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  isFallbackAdapter?: boolean;
  features: Iterable<string>;
  limits: Record<string, number>;
  requestDevice(): Promise<{ destroy?: () => void }>;
}

async function load(command: Command): Promise<Record<string, unknown>> {
  if (engine) await engine.exit();
  engine = new Wllama({ default: new URL("wllama.wasm", scope.location.href).href }, { suppressNativeLog: true, logger: silent, parallelDownloads: 1 });
  const started = performance.now();
  let lastProgress = 0;
  await engine.loadModelFromUrl(command.url!, {
    n_ctx: command.nCtx ?? 8192,
    n_gpu_layers: command.nGpuLayers,
    reasoning: command.reasoning ?? false,
    useCache: false,
    progressCallback: ({ loaded, total }) => {
      const now = performance.now();
      if (now - lastProgress > 500 || loaded === total) {
        lastProgress = now;
        scope.postMessage({ kind: "progress", loaded, total });
      }
    },
  });
  const loadMs = Math.round(performance.now() - started);
  const info = engine.getLoadedContextInfo();
  return {
    load_ms: loadMs,
    multithread: engine.isMultithread(),
    n_ctx: info.n_ctx,
    n_batch: info.n_batch,
    n_ctx_train: info.n_ctx_train,
    n_vocab: info.n_vocab,
    n_layer: info.n_layer,
    n_embd: info.n_embd,
    general_architecture: info.metadata?.["general.architecture"] ?? null,
    general_name: info.metadata?.["general.name"] ?? null,
    file_type: info.metadata?.["general.file_type"] ?? null,
  };
}

async function complete(command: Command): Promise<Record<string, unknown>> {
  if (!engine) throw new Error("no model loaded");
  const controller = new AbortController();
  if (command.abortAfterMs) setTimeout(() => controller.abort(), command.abortAfterMs);
  const started = performance.now();
  let firstToken: number | null = null;
  let text = "";
  let usage: unknown = null;
  let timings: unknown = null;
  let finish: unknown = null;
  let aborted = false;
  try {
    const request = {
      messages: command.messages!,
      max_tokens: command.maxTokens ?? 512,
      temperature: 0,
      stream: command.stream !== false,
      cache_prompt: command.cachePrompt ?? true,
      abortSignal: controller.signal,
      ...(command.schema ? { response_format: { type: "json_schema" as const, json_schema: { name: "agentpkg_node_output", schema: command.schema, strict: true } } } : {}),
    } as Parameters<Wllama["createChatCompletion"]>[0];
    const answer = await engine.createChatCompletion(request);
    if (command.stream === false) {
      const response = answer as unknown as Record<string, unknown>;
      const choice = (response.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const message = choice?.message as Record<string, unknown> | undefined;
      text = typeof message?.content === "string" ? message.content : "";
      finish = choice?.finish_reason ?? null;
      usage = response.usage ?? null;
      timings = response.timings ?? null;
      firstToken = performance.now();
      return { text, usage, timings, finish_reason: finish, aborted: false, total_ms: Math.round(performance.now() - started), first_token_ms: null, chars: text.length, reasoning_content: typeof message?.reasoning_content === "string" ? message.reasoning_content.slice(0, 2000) : null };
    }
    for await (const chunk of answer as AsyncIterable<Record<string, unknown>>) {
      const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = (choice?.delta as Record<string, unknown> | undefined)?.content;
      if (typeof delta === "string" && delta.length > 0) {
        if (firstToken === null) firstToken = performance.now();
        text += delta;
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.timings) timings = chunk.timings;
    }
  } catch (error) {
    if (controller.signal.aborted) aborted = true;
    else throw error;
  }
  const totalMs = Math.round(performance.now() - started);
  return { text, usage, timings, finish_reason: finish, aborted, total_ms: totalMs, first_token_ms: firstToken === null ? null : Math.round(firstToken - started), chars: text.length };
}

scope.onmessage = async (event) => {
  const command = event.data;
  try {
    let result: unknown;
    if (command.kind === "probe") result = await probe();
    else if (command.kind === "load") result = await load(command);
    else if (command.kind === "complete") result = await complete(command);
    else if (command.kind === "unload") {
      await engine?.exit();
      engine = null;
      result = { unloaded: true };
    } else throw new Error(`unknown command ${String((command as { kind: unknown }).kind)}`);
    scope.postMessage({ kind: "answer", id: command.id, ok: true, result });
  } catch (error) {
    scope.postMessage({ kind: "answer", id: command.id, ok: false, error: `${(error as Error).name ?? "Error"}: ${String((error as Error).message ?? error).slice(0, 500)}` });
  }
};
