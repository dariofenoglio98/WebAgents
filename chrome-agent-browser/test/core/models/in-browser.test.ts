/**
 * The in-browser route's contract (T40, D-440…D-447): the adapter over a fixture port (the
 * grammar constraint, the usage mapping, truncation, refusals, cancellation, the observer), the
 * provider case, the weights digest against Python-made vectors, the entry's validation and the
 * descriptor's facts. No engine, no WebGPU: the core sees the port only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { FixtureInBrowserPort, InBrowserAdapter, IN_BROWSER_PROVIDER, UnavailableInBrowserPort, type InBrowserCompletion } from "../../../src/core/models/adapters/in-browser.js";
import { normalizeModelBinding } from "../../../src/core/models/binding.js";
import { gpuMemoryEstimate, inBrowserDescriptor, normalizeInBrowserEntry, weightsDigest, type InBrowserEntryState } from "../../../src/core/models/in-browser-catalog.js";
import { adapterFor } from "../../../src/core/models/providers.js";
import { render } from "../../../src/core/models/render.js";
import { BoundModelRouter } from "../../../src/core/models/router.js";
import { constraintSchema, GGUF_GRAMMAR_RULES } from "../../../src/core/models/schema-format.js";
import type { OutboundModelRequest } from "../../../src/core/models/transport.js";
import { AdapterError, CancelledError } from "../../../src/core/workflow/errors.js";
import { PROJECT } from "../../helpers/paths.js";

const SCHEMA: JsonObject = {
  $ref: "#/$defs/s0",
  $defs: {
    s0: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "count"],
      properties: { intent: { enum: ["search", "quote", null] }, count: { type: "integer", minimum: 1, maximum: 6 }, note: { type: ["string", "null"], minLength: 1, maxLength: 60 } },
    },
  },
};

const RENDERED = render({
  task: "interpret",
  instructions: ["Read the message."],
  data: { message: "two to Zurich" },
  output_schema: SCHEMA,
  requirements: { id: "interpret", capabilities: ["structured_output", "reasoning"], context_window: 16000, preferred_tier: "reasoning" },
  budget_context: { max_output_tokens: 200 },
  audit_context: { worker: "Interpreter", node_id: "interpret" },
});

const ENTRY_ID = "qwen3-0.6b-q4_0";
const answer = (overrides: Partial<InBrowserCompletion> = {}): InBrowserCompletion => ({
  text: '{"intent":"search","count":2,"note":null}',
  finish_reason: "stop",
  usage: { prompt_tokens: 2917, completion_tokens: 179, total_tokens: 3096 },
  timings: { prompt_per_second: 482.9, predicted_per_second: 87.4 },
  constrained: true,
  ...overrides,
});
const adapter = (port: FixtureInBrowserPort, observer: ((request: OutboundModelRequest) => void) | null = null) => new InBrowserAdapter(port, { entry: ENTRY_ID, contextWindow: 8192, reasoning: true, think: false, observer });

describe("the GGUF grammar rules", () => {
  it("keep the schema as given: bounds, enums with null, type lists and closed objects survive, the root reference is inlined", () => {
    const constraint = constraintSchema(SCHEMA, GGUF_GRAMMAR_RULES)!;
    expect(constraint.$ref).toBeUndefined();
    expect(constraint.type).toBe("object");
    const properties = constraint.properties as Record<string, JsonObject>;
    expect(properties.count).toEqual({ type: "integer", minimum: 1, maximum: 6 });
    expect(properties.intent).toEqual({ enum: ["search", "quote", null] });
    expect(properties.note).toEqual({ type: ["string", "null"], minLength: 1, maxLength: 60 });
    expect(constraint.additionalProperties).toBe(false);
  });

  it("accept an array root", () => {
    expect(constraintSchema({ type: "array", items: { type: "string" } }, GGUF_GRAMMAR_RULES)).toEqual({ type: "array", items: { type: "string" } });
  });
});

describe("InBrowserAdapter", () => {
  it("sends the rendered request with the grammar constraint and the node's cap, and maps the engine's counts", async () => {
    const port = new FixtureInBrowserPort(ENTRY_ID, () => answer());
    const observed: OutboundModelRequest[] = [];
    const completion = await adapter(port, (request) => observed.push(request)).complete(RENDERED, 200, new AbortController().signal);
    expect(port.requests).toHaveLength(1);
    const request = port.requests[0]!;
    expect(request.entry).toBe(ENTRY_ID);
    expect(request.system).toBe(RENDERED.system);
    expect(request.user).toBe(RENDERED.user);
    expect(request.max_tokens).toBe(200);
    expect(request.think).toBe(false);
    expect(request.schema).toEqual(constraintSchema(SCHEMA, GGUF_GRAMMAR_RULES));
    expect(completion.text).toBe('{"intent":"search","count":2,"note":null}');
    expect(completion.model_id).toBe(`${IN_BROWSER_PROVIDER}/${ENTRY_ID}`);
    expect(completion.stop_reason).toBe("stop");
    expect(completion.constrained).toBe(true);
    expect(completion.usage).toEqual({ input_tokens: 2917, output_tokens: 179, cache_read_tokens: null, cache_write_tokens: null, total_tokens: 3096, cost_usd: null });
    // The request never leaves the browser; the observer sees it under the in-browser scheme (D-028).
    expect(observed).toHaveLength(1);
    expect(observed[0]!.provider_id).toBe(IN_BROWSER_PROVIDER);
    expect(observed[0]!.url).toBe(`in-browser:${ENTRY_ID}`);
    expect(JSON.parse(observed[0]!.body).user).toBe(RENDERED.user);
  });

  it("states its facts: local, no domains, no price, the binding's context and reasoning", () => {
    const made = adapter(new FixtureInBrowserPort(ENTRY_ID, () => answer()));
    expect(made.remote).toBe(false);
    expect(made.domains).toEqual([]);
    expect(made.pricing).toBeNull();
    expect(made.context_window).toBe(8192);
    expect(made.reasoning).toBe(true);
    expect(made.thinking).toBe(false);
    expect(made.host_model_id).toBe("in-browser/qwen3-0.6b-q4_0");
  });

  it("reports a length finish as a length stop, so the router fails the node as truncated", async () => {
    const port = new FixtureInBrowserPort(ENTRY_ID, () => answer({ finish_reason: "length", text: '{"intent":"search","count":' }));
    const completion = await adapter(port).complete(RENDERED, 200, new AbortController().signal);
    expect(completion.stop_reason).toBe("length");
  });

  it("refuses model_unavailable when the engine holds no model or another one, before asking it anything", async () => {
    const empty = new FixtureInBrowserPort(null, () => answer());
    await expect(adapter(empty).complete(RENDERED, 200, new AbortController().signal)).rejects.toMatchObject({ code: "model_unavailable", detail: { entry: ENTRY_ID, loaded: null } });
    const other = new FixtureInBrowserPort("qwen3-4b-q4_k_m", () => answer());
    await expect(adapter(other).complete(RENDERED, 200, new AbortController().signal)).rejects.toMatchObject({ code: "model_unavailable", detail: { loaded: "qwen3-4b-q4_k_m" } });
    expect(empty.requests).toHaveLength(0);
    expect(other.requests).toHaveLength(0);
    await expect(adapter(new UnavailableInBrowserPort() as unknown as FixtureInBrowserPort).complete(RENDERED, 200, new AbortController().signal)).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("turns an engine failure into model_unavailable with the stage, never another model", async () => {
    const port = new FixtureInBrowserPort(ENTRY_ID, () => {
      throw new Error("worker died");
    });
    await expect(adapter(port).complete(RENDERED, 200, new AbortController().signal)).rejects.toMatchObject({ code: "model_unavailable", audit_facts: { stage: "engine" } });
  });

  it("rejects with the signal's reason when cancelled, before or during the call", async () => {
    const controller = new AbortController();
    controller.abort(new CancelledError());
    const port = new FixtureInBrowserPort(ENTRY_ID, () => answer());
    await expect(adapter(port).complete(RENDERED, 200, controller.signal)).rejects.toBeInstanceOf(CancelledError);
    expect(port.requests).toHaveLength(0);
    const during = new AbortController();
    const slow = new FixtureInBrowserPort(ENTRY_ID, (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
    const pending = adapter(slow).complete(RENDERED, 200, during.signal);
    during.abort(new CancelledError());
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    // An abort finish after the run's own signal fired is the person's cancellation.
    const late = new AbortController();
    const cancelled = new FixtureInBrowserPort(ENTRY_ID, () => {
      late.abort(new CancelledError());
      return answer({ finish_reason: "abort", text: "{" });
    });
    await expect(adapter(cancelled).complete(RENDERED, 200, late.signal)).rejects.toBeInstanceOf(CancelledError);
  });

  it("an abort finish while the run's signal is live is the engine stopping by itself: model_unavailable, not a cancellation", async () => {
    const aborted = new FixtureInBrowserPort(ENTRY_ID, () => answer({ finish_reason: "abort", text: "{" }));
    const outcome = adapter(aborted).complete(RENDERED, 200, new AbortController().signal);
    await expect(outcome).rejects.toBeInstanceOf(AdapterError);
    await expect(outcome).rejects.toMatchObject({ code: "model_unavailable", audit_facts: { stage: "engine", reason: "engine_aborted" } });
  });

  it("keeps the port's own AdapterError codes (model_request_invalid over n_ctx, engine_worker_died)", async () => {
    const over = new FixtureInBrowserPort(ENTRY_ID, () => {
      throw new AdapterError("model_request_invalid", "the request does not fit n_ctx");
    });
    await expect(adapter(over).complete(RENDERED, 200, new AbortController().signal)).rejects.toMatchObject({ code: "model_request_invalid" });
    const died = new FixtureInBrowserPort(ENTRY_ID, () => {
      throw new AdapterError("model_unavailable", "the engine Worker died", { detail: { reason: "engine_worker_died" } });
    });
    await expect(adapter(died).complete(RENDERED, 200, new AbortController().signal)).rejects.toMatchObject({ code: "model_unavailable", detail: { reason: "engine_worker_died" } });
  });

  it("through the bound router: a missing count is model_usage_unavailable, a valid answer is accepted with the engine's counts", async () => {
    const binding = normalizeModelBinding({ host_model_id: `in-browser/${ENTRY_ID}`, provider_id: "in-browser", model_id: ENTRY_ID, display_name: "Qwen3 0.6B", capabilities: { reasoning: { value: true, basis: "declared" } }, limits: { context_tokens: 8192, native_context_window: 40960, max_output_tokens: null }, properties: { local: true } });
    const good = new FixtureInBrowserPort(ENTRY_ID, () => answer());
    const router = new BoundModelRouter(adapterFor(binding, { transport: async () => { throw new Error("no network on this route"); }, inBrowser: good, inBrowserThink: false }), { requestTimeoutSeconds: 5 });
    const result = await router.complete({ task: "interpret", instructions: ["Read the message."], data: { message: "two to Zurich" }, output_schema: SCHEMA, requirements: { id: "interpret", capabilities: ["structured_output", "reasoning"], context_window: 16000, preferred_tier: "reasoning" }, budget_context: { max_output_tokens: 200 }, audit_context: { worker: "Interpreter", node_id: "interpret" } }, 200, new AbortController().signal);
    expect(result.output).toEqual({ intent: "search", count: 2, note: null });
    expect(result.input_tokens).toBe(2917);
    expect(result.output_tokens).toBe(179);
    expect(router.remote).toBe(false);
    expect(router.capabilities.has("structured_output")).toBe(true);
    expect(router.capabilities.has("reasoning")).toBe(true);
    const silent = new FixtureInBrowserPort(ENTRY_ID, () => answer({ usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } }));
    const mute = new BoundModelRouter(adapterFor(binding, { transport: async () => { throw new Error("no network"); }, inBrowser: silent, inBrowserThink: false }), { requestTimeoutSeconds: 5 });
    await expect(mute.complete({ task: "interpret", instructions: [], data: {}, output_schema: SCHEMA, requirements: { id: "interpret", capabilities: [], context_window: 16000, preferred_tier: null }, budget_context: { max_output_tokens: 200 }, audit_context: { worker: "W", node_id: "n" } }, 200, new AbortController().signal)).rejects.toMatchObject({ code: "model_usage_unavailable" });
  });

  it("providers.ts refuses the route on a host without a port", () => {
    const binding = normalizeModelBinding({ host_model_id: `in-browser/${ENTRY_ID}`, provider_id: "in-browser", model_id: ENTRY_ID, limits: { context_tokens: 8192 } });
    expect(() => adapterFor(binding, { transport: async () => { throw new Error("no"); } })).toThrow(AdapterError);
    expect(() => adapterFor(binding, { transport: async () => { throw new Error("no"); } })).toThrow(/no in-browser engine/u);
  });
});

describe("weightsDigest (D-447)", () => {
  const vectors = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "weights-digest-vectors.json"), "utf8")) as { vectors: Array<{ name: string; files: string[]; digest: string }> };

  it("matches the Python-made vectors, in any file order", () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(4);
    for (const vector of vectors.vectors) {
      expect(weightsDigest(vector.files), vector.name).toBe(vector.digest);
      expect(weightsDigest([...vector.files].reverse()), `${vector.name} reversed`).toBe(vector.digest);
    }
  });

  it("refuses an empty list and a malformed digest", () => {
    expect(() => weightsDigest([])).toThrow(/at least one/u);
    expect(() => weightsDigest(["abc"])).toThrow();
    expect(() => weightsDigest(["DA2572F16C061335DA2572F16C061335DA2572F16C061335DA2572F16C061335"])).toThrow();
  });
});

describe("the in-browser catalog entry", () => {
  // The spike's file and header facts, read from the committed evidence rather than typed.
  const SPIKE = JSON.parse(readFileSync(join(PROJECT, "..", "examples", "verification", "chrome-inbrowser-spike-t40.json"), "utf8")) as { model: { sha256: string } };
  const SPIKE_SHA256 = SPIKE.model.sha256;
  const HEADERS = JSON.parse(readFileSync(join(PROJECT, "..", "examples", "verification", "chrome-inbrowser-gguf-headers-t40.json"), "utf8")) as { files: Array<{ file: string; facts: { n_layer: number; n_kv_heads: number; key_length: number; value_length: number; embedding_length: number; head_count: number } }> };
  const HEADER = HEADERS.files.find((item) => item.file === "Qwen3-0.6B-Q4_0.gguf")!.facts;
  const FILE = { name: "Qwen3-0.6B-Q4_0.gguf", url: "https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_0.gguf", bytes: 428_970_080, sha256: SPIKE_SHA256 };
  const entry = (changes: Record<string, unknown> = {}) => ({
    schema: "agentpkg-in-browser-model-v0",
    id: "qwen3-0.6b-q4_0",
    display_name: "Qwen3 0.6B (Q4_0)",
    family: "qwen3",
    parameters: 600_000_000,
    format: "gguf",
    engine: "wllama",
    quantization: "Q4_0",
    files: [FILE],
    weights_digest: weightsDigest([FILE.sha256]),
    bytes_total: FILE.bytes,
    context: { train: 40_960, default: 8192, max: 32_768 },
    capabilities: { structured_output: true, reasoning: true, tool_use: null },
    license: { id: "apache-2.0", name: "Apache License 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    source: { repository: "ggml-org/Qwen3-0.6B-GGUF", revision: "main", api: "https://huggingface.co/api/models/ggml-org/Qwen3-0.6B-GGUF?blobs=true" },
    curated: true,
    header: { n_layer: HEADER.n_layer, n_kv_heads: HEADER.n_kv_heads, key_length: HEADER.key_length, value_length: HEADER.value_length },
    notes: "The smoke tier.",
    ...changes,
  });

  it("normalizes a curated entry", () => {
    const made = normalizeInBrowserEntry(entry());
    expect(made.id).toBe("qwen3-0.6b-q4_0");
    expect(made.bytes_total).toBe(428_970_080);
    expect(made.weights_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(made.context).toEqual({ train: 40_960, default: 8192, max: 32_768 });
    expect(made.header).toEqual({ n_layer: 28, n_kv_heads: 8, key_length: 128, value_length: 128 });
  });

  it.each([
    ["an unknown field", { extra: 1 }, /Unknown fields/u],
    ["a wrong schema", { schema: "x" }, /entry.schema/u],
    ["an id with capitals", { id: "Qwen3" }, /entry.id/u],
    ["an unknown engine", { engine: "webllm" }, /entry.engine/u],
    ["a plain-HTTP file", { files: [{ ...FILE, url: "http://huggingface.co/x.gguf" }] }, /https/u],
    ["a digest that is not the files'", { weights_digest: "sha256:" + "0".repeat(64) }, /weights_digest/u],
    ["a total that is not the sum", { bytes_total: 1 }, /bytes_total/u],
    ["a max context above the training context", { context: { train: 4096, default: 4096, max: 8192 } }, /context.max/u],
    ["a max context above 65,536", { context: { train: 262_144, default: 8192, max: 131_072 } }, /context.max/u],
    ["a default above the max", { context: { train: 40_960, default: 40_000, max: 32_768 } }, /context.default/u],
    ["no files", { files: [] }, /entry.files/u],
    ["a header with the old head_dim field", { header: { n_layer: 28, n_kv_heads: 8, head_dim: 128 } }, /Unknown fields|entry.header/u],
    ["a repeated file name", { files: [FILE, { ...FILE, sha256: "0".repeat(64) }], weights_digest: weightsDigest([FILE.sha256, "0".repeat(64)]), bytes_total: 2 * FILE.bytes }, /repeat/u],
  ])("refuses %s", (_name, changes, message) => {
    expect(() => normalizeInBrowserEntry(entry(changes))).toThrow(message);
  });

  it("estimates GPU memory from the header: weights, the f16 KV cache from the K and V widths, 15 % and 512 MB", () => {
    const made = normalizeInBrowserEntry(entry());
    // 28 layers × 8192 × 8 KV heads × (128 + 128) × 2 bytes = 939,524,096 bytes of KV cache.
    const kv = 28 * 8192 * 8 * (128 + 128) * 2;
    expect(kv).toBe(939_524_096);
    expect(gpuMemoryEstimate(made, 8192)).toBe(Math.ceil(428_970_080 * 1.15 + kv + 512e6));
    expect(gpuMemoryEstimate(normalizeInBrowserEntry(entry({ header: null })), 8192)).toBeNull();
  });

  it("reads the head width from key_length, not embedding_length / head_count, which halves Qwen3's KV cache", () => {
    for (const item of HEADERS.files) {
      expect(item.facts.key_length, item.file).toBe(128);
      expect(item.facts.embedding_length / item.facts.head_count, item.file).toBeLessThan(item.facts.key_length);
    }
    const made = normalizeInBrowserEntry(entry());
    const wrong = normalizeInBrowserEntry(entry({ header: { n_layer: 28, n_kv_heads: 8, key_length: 64, value_length: 64 } }));
    expect(gpuMemoryEstimate(made, 32_768)! - gpuMemoryEstimate(wrong, 32_768)!).toBe(28 * 32_768 * 8 * 128 * 2);
  });

  const state = (changes: Partial<InBrowserEntryState> = {}): InBrowserEntryState => ({ cached: true, verified: true, loaded: false, chosen_context: null, budget: { bytes: 6_000_000_000, basis: "assumed" }, measured: null, ...changes });

  it("describes a cached, verified, fitting entry as available with the facts and their bases", () => {
    const descriptor = inBrowserDescriptor(normalizeInBrowserEntry(entry()), state()) as Record<string, unknown>;
    expect(descriptor.id).toBe("in-browser/qwen3-0.6b-q4_0");
    expect(descriptor.available).toBe(true);
    expect(descriptor.selectable).toBe(true);
    const capabilities = descriptor.capabilities as Record<string, { value: unknown; basis: string }>;
    expect(capabilities.structured_output).toMatchObject({ value: true, basis: "derived" });
    expect(capabilities.reasoning).toMatchObject({ value: true, basis: "declared" });
    expect(capabilities.tool_use).toBeUndefined();
    expect(descriptor.limits).toEqual({ context_tokens: 8192, native_context_window: 40_960, max_output_tokens: null });
    expect(descriptor.properties).toMatchObject({ local: true, privacy_class: "local", cost_class: "free", status: "cached" });
    expect((descriptor.properties as { tags: string[] }).tags).toEqual(["local", "in-browser", "gguf", "curated", "context:capped"]);
  });

  it("says why an entry is not available: not downloaded, unverified, or too large, and never selects it", () => {
    const made = normalizeInBrowserEntry(entry());
    const missing = inBrowserDescriptor(made, state({ cached: false, verified: false })) as Record<string, unknown>;
    expect(missing.available).toBe(false);
    expect(missing.selectable).toBe(false);
    expect(missing.availability_reason).toBe("not downloaded (0.4 GB)");
    expect((missing.properties as { status: string }).status).toBe("not_downloaded");
    const corrupt = inBrowserDescriptor(made, state({ verified: false })) as Record<string, unknown>;
    expect(corrupt.availability_reason).toMatch(/does not match the digest/u);
    // The estimate at 8,192 is about 1.99 GB; a 1.5 GB budget refuses with both numbers.
    const large = inBrowserDescriptor(made, state({ budget: { bytes: 1_500_000_000, basis: "platform" } })) as Record<string, unknown>;
    expect(large.available).toBe(false);
    expect(large.availability_reason).toBe(`needs about ${(gpuMemoryEstimate(made, 8192)! / 1e9).toFixed(1)} GB of GPU memory at a 8,192-token context; this machine's budget is 1.5 GB (platform)`);
  });

  it("an unknown GPU need is not a fit: a cached entry whose header has not been read is not available", () => {
    const pasted = normalizeInBrowserEntry(entry({ header: null, curated: false }));
    const descriptor = inBrowserDescriptor(pasted, state()) as Record<string, unknown>;
    expect(descriptor.available).toBe(false);
    expect(descriptor.selectable).toBe(false);
    expect(descriptor.availability_reason).toBe("GPU memory unknown: the model's header has not been read");
    // Not yet downloaded: the header cannot be read, and the reason says only what to do.
    const missing = inBrowserDescriptor(pasted, state({ cached: false, verified: false })) as Record<string, unknown>;
    expect(missing.availability_reason).toBe("not downloaded (0.4 GB)");
    // A load measured on this machine at that context or more outranks the unknown estimate.
    const ran = inBrowserDescriptor(pasted, state({ measured: { prefill_tok_per_s: 489.6, decode_tok_per_s: 89.5, context: 8192 } })) as Record<string, unknown>;
    expect(ran.available).toBe(true);
  });

  it("judges the fit at the context it reports: an override's larger context is estimated at that context", () => {
    const made = normalizeInBrowserEntry(entry());
    const budget = gpuMemoryEstimate(made, 8192)! + 1;
    const fits = inBrowserDescriptor(made, state({ budget: { bytes: budget, basis: "declared" } })) as Record<string, unknown>;
    expect(fits.available).toBe(true);
    const larger = inBrowserDescriptor(made, state({ budget: { bytes: budget, basis: "declared" } }), { context_tokens: 32_768 }) as Record<string, unknown>;
    expect((larger.limits as { context_tokens: number }).context_tokens).toBe(32_768);
    expect(larger.available).toBe(false);
    expect(larger.availability_reason).toMatch(/at a 32,768-token context/u);
    // A load measured at 8,192 does not vouch for 32,768.
    const measured = inBrowserDescriptor(made, state({ budget: { bytes: budget, basis: "declared" }, measured: { prefill_tok_per_s: 1, decode_tok_per_s: 1, context: 8192 } }), { context_tokens: 32_768 }) as Record<string, unknown>;
    expect(measured.available).toBe(false);
  });

  it("takes the person's context, reasoning and output cap as declared, capped at the entry's max", () => {
    const made = normalizeInBrowserEntry(entry({ capabilities: { structured_output: true, reasoning: null } }));
    const descriptor = inBrowserDescriptor(made, state({ loaded: true }), { context_tokens: 65_536, reasoning: false, max_output_tokens: 4000 }) as Record<string, unknown>;
    expect(descriptor.limits).toEqual({ context_tokens: 32_768, native_context_window: 40_960, max_output_tokens: 4000 });
    expect((descriptor.capabilities as Record<string, { value: unknown; basis: string }>).reasoning).toMatchObject({ value: false, basis: "declared" });
    expect((descriptor.properties as { tags: string[]; status: string }).tags).toContain("limits:settings");
    expect((descriptor.properties as { status: string }).status).toBe("loaded");
    const absent = inBrowserDescriptor(made, state()) as Record<string, unknown>;
    expect((absent.capabilities as Record<string, { value: unknown; basis: string }>).reasoning).toMatchObject({ value: null, basis: "absent" });
  });
});
