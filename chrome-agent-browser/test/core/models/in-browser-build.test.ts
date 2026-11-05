/**
 * T41's core: the adapter's carried findings (a rejected status, the cached prompt count), the
 * GGUF header reader against the spike's header facts, the signed model catalog, the GPU budget,
 * the four recommendation bins over machine classes × the five curated entries, and the
 * in-browser probe. Every curated fact is read from the committed `examples/model-catalog.content.json`
 * (written by `scripts/make-model-catalog.mjs` from Hugging Face), never typed here.
 */
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateModel, normalizeDescriptor, type RequirementSet } from "../../../src/core/compatibility.js";
import { publicKeyFromPem } from "../../../src/core/keys.js";
import { FixtureInBrowserPort, InBrowserAdapter, inBrowserUsage, type InBrowserCompletion, type InBrowserEnginePort } from "../../../src/core/models/adapters/in-browser.js";
import { probeInBrowser, probeProvider, PROVIDER_IDS, hasEndpoint } from "../../../src/core/models/catalog.js";
import { bytesReader, GgufHeaderError, readGgufHeader } from "../../../src/core/models/gguf-header.js";
import {
  budgetWords,
  defaultSuggestion,
  gpuBudget,
  gpuMemoryEstimate,
  inBrowserDescriptor,
  isInBrowserHostModelId,
  normalizeInBrowserEntry,
  readModelCatalog,
  recommendInBrowser,
  type InBrowserEntry,
  type InBrowserEntryState,
  type MachineFacts,
  type PackageEvaluation,
} from "../../../src/core/models/in-browser-catalog.js";
import { render } from "../../../src/core/models/render.js";
import { BoundModelRouter } from "../../../src/core/models/router.js";
import { normalizeModelBinding } from "../../../src/core/models/binding.js";
import { adapterFor } from "../../../src/core/models/providers.js";
import { extensionSchemaFailure } from "../../../src/core/schema.js";
import { buildSignedDocument, MODEL_CATALOG_TYPE, AGENT_INDEX_TYPE, serializeSignedDocument, verifySignedDocument } from "../../../src/core/signed-document.js";
import { AdapterError, CancelledError } from "../../../src/core/workflow/errors.js";
import { ggufBytes, qwen3Header } from "../../helpers/gguf.js";
import { PROJECT } from "../../helpers/paths.js";

const ROOT = join(PROJECT, "..");
const CONTENT = JSON.parse(readFileSync(join(ROOT, "examples", "model-catalog.content.json"), "utf8")) as Record<string, unknown>;
const CATALOG = readModelCatalog(CONTENT);
const ENTRIES = new Map(CATALOG.entries.map((entry) => [entry.id, entry]));
const entry = (id: string): InBrowserEntry => ENTRIES.get(id)!;
const HEADERS = JSON.parse(readFileSync(join(ROOT, "examples", "verification", "chrome-inbrowser-gguf-headers-t40.json"), "utf8")) as { files: Array<{ file: string; header_bytes: number; facts: { architecture: string; n_layer: number; head_count: number; n_kv_heads: number; key_length: number; value_length: number; embedding_length: number; context_length: number } }> };

const RENDERED = render({ task: "t", instructions: ["Answer."], data: {}, output_schema: { type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, requirements: { id: "t", capabilities: [], context_window: 1000, preferred_tier: null }, budget_context: { max_output_tokens: 50 }, audit_context: { worker: "W", node_id: "n" } });
const ANSWER: InBrowserCompletion = { text: '{"a":1}', finish_reason: "stop", usage: { prompt_tokens: 2917, completion_tokens: 12, total_tokens: 2929 }, timings: null, constrained: true };

describe("the adapter's T40 review-2 findings", () => {
  it("(a) maps a rejected status() like a rejected completion: model_unavailable, stage engine", async () => {
    const port: InBrowserEnginePort = { status: async () => { throw new Error("the channel closed"); }, complete: async () => ANSWER };
    const adapter = new InBrowserAdapter(port, { entry: "x1", contextWindow: 4096, reasoning: false, think: false });
    await expect(adapter.complete(RENDERED, 50, new AbortController().signal)).rejects.toMatchObject({ code: "model_unavailable", audit_facts: { stage: "engine" } });
    // An AdapterError from status() keeps its code; a cancellation wins over the failure.
    const refusing: InBrowserEnginePort = { status: async () => { throw new AdapterError("model_unavailable", "died", { detail: { reason: "engine_worker_died" } }); }, complete: async () => ANSWER };
    await expect(new InBrowserAdapter(refusing, { entry: "x1", contextWindow: 4096, reasoning: false, think: false }).complete(RENDERED, 50, new AbortController().signal)).rejects.toMatchObject({ detail: { reason: "engine_worker_died" } });
    const cancelled = new AbortController();
    cancelled.abort(new CancelledError());
    await expect(adapter.complete(RENDERED, 50, cancelled.signal)).rejects.toBeInstanceOf(CancelledError);
  });

  it("(b) charges the whole prompt once when the port reports a cached part, and refuses a cached count above the prompt", async () => {
    expect(inBrowserUsage({ prompt_tokens: 2917, completion_tokens: 12, total_tokens: 2929, cached_prompt_tokens: 2916 })).toEqual({ input_tokens: 1, output_tokens: 12, cache_read_tokens: 2916, cache_write_tokens: null, total_tokens: 2929, cost_usd: null });
    expect(inBrowserUsage({ prompt_tokens: 2917, completion_tokens: 12, total_tokens: 2929 })).toMatchObject({ input_tokens: 2917, cache_read_tokens: null });
    expect(() => inBrowserUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cached_prompt_tokens: 11 })).toThrow(/more cached prompt tokens/u);
    // Through the router: a re-ask whose prompt the cache held is charged 2,917 input tokens, not 1.
    const binding = normalizeModelBinding({ host_model_id: "in-browser/x1", provider_id: "in-browser", model_id: "x1", limits: { context_tokens: 8192 } });
    const port = new FixtureInBrowserPort("x1", () => ({ ...ANSWER, usage: { prompt_tokens: 2917, completion_tokens: 12, total_tokens: 2929, cached_prompt_tokens: 2916 } }));
    const router = new BoundModelRouter(adapterFor(binding, { transport: async () => { throw new Error("no network"); }, inBrowser: port }), { requestTimeoutSeconds: 5 });
    const result = await router.complete({ task: "t", instructions: [], data: {}, output_schema: { type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, requirements: { id: "t", capabilities: [], context_window: 1000, preferred_tier: null }, budget_context: { max_output_tokens: 50 }, audit_context: { worker: "W", node_id: "n" } }, 50, new AbortController().signal);
    expect(result.input_tokens).toBe(2917);
    expect(result.output_tokens).toBe(12);
  });

  it("(c) passes the engine's finish word through, and names the in-browser route by its host model id", async () => {
    const port = new FixtureInBrowserPort("x1", () => ({ ...ANSWER, finish_reason: null }));
    const completion = await new InBrowserAdapter(port, { entry: "x1", contextWindow: 4096, reasoning: false, think: false }).complete(RENDERED, 50, new AbortController().signal);
    expect(completion.stop_reason).toBeNull();
    expect(isInBrowserHostModelId("in-browser/qwen3-4b-q4_k_m")).toBe(true);
    expect(isInBrowserHostModelId("ollama/qwen3:30b")).toBe(false);
    expect(isInBrowserHostModelId("in-browser")).toBe(false);
    expect(isInBrowserHostModelId(null)).toBe(false);
  });
});

describe("the GGUF header reader", () => {
  for (const file of HEADERS.files) {
    it(`reads ${file.file}'s facts as T40's reference walk recorded them`, async () => {
      const bytes = qwen3Header({ n_layer: file.facts.n_layer, head_count: file.facts.head_count, n_kv_heads: file.facts.n_kv_heads, key_length: file.facts.key_length, value_length: file.facts.value_length, embedding_length: file.facts.embedding_length, context_length: file.facts.context_length });
      const reads: Array<[number, number]> = [];
      const facts = await readGgufHeader(async (offset, length) => {
        reads.push([offset, length]);
        return bytes.subarray(offset, offset + length);
      }, bytes.length);
      expect(facts).toMatchObject({ architecture: file.facts.architecture, n_layer: file.facts.n_layer, n_kv_heads: file.facts.n_kv_heads, key_length: file.facts.key_length, value_length: file.facts.value_length, key_length_basis: "attention.key_length", context_length: file.facts.context_length, embedding_length: file.facts.embedding_length, head_count: file.facts.head_count });
      // The tokenizer tables are walked, not decoded into memory, and nothing past the header is read.
      expect(facts.header_bytes).toBeLessThan(bytes.length);
      expect(Math.max(...reads.map(([offset]) => offset))).toBeLessThan(facts.header_bytes);
    });
  }

  it("marks the embedding_length / head_count fallback, which Qwen3's real widths contradict", async () => {
    const facts = await readGgufHeader(bytesReader(qwen3Header({ n_layer: 36, head_count: 32, n_kv_heads: 8, key_length: null, value_length: null, embedding_length: 2560, context_length: 40960 })));
    expect(facts.key_length).toBe(80);
    expect(facts.key_length_basis).toBe("embedding_length / head_count");
  });

  it("counts a per-layer KV-head array at its largest, and no head_count_kv as head_count", async () => {
    const perLayer = ggufBytes([
      ["general.architecture", { type: "string", value: "gemma3" }],
      ["gemma3.block_count", { type: "u32", value: 4 }],
      ["gemma3.attention.head_count", { type: "u32", value: 8 }],
      ["gemma3.attention.head_count_kv", { type: "u32[]", value: [2, 4, 2, 4] }],
      ["gemma3.attention.key_length", { type: "u32", value: 256 }],
      ["gemma3.attention.value_length", { type: "u32", value: 256 }],
      ["gemma3.attention.sliding_window", { type: "u32", value: 1024 }],
    ]);
    expect(await readGgufHeader(bytesReader(perLayer))).toMatchObject({ n_kv_heads: 4, sliding_window: 1024 });
    const noGqa = ggufBytes([
      ["general.architecture", { type: "string", value: "llama" }],
      ["llama.block_count", { type: "u32", value: 2 }],
      ["llama.attention.head_count", { type: "u32", value: 16 }],
      ["llama.embedding_length", { type: "u32", value: 2048 }],
    ]);
    expect(await readGgufHeader(bytesReader(noGqa))).toMatchObject({ n_kv_heads: 16, key_length: 128, key_length_basis: "embedding_length / head_count" });
  });

  it.each([
    ["not GGUF", new TextEncoder().encode("PK\u0003\u0004 not a model at all"), /not a GGUF file/u],
    ["GGUF version 1", ggufBytes([], { version: 1 }), /version 1/u],
    ["no architecture", ggufBytes([["general.name", { type: "string", value: "x" }]]), /general.architecture/u],
    ["no block count", ggufBytes([["general.architecture", { type: "string", value: "qwen3" }], ["qwen3.attention.head_count", { type: "u32", value: 2 }]]), /block_count/u],
    ["a truncated header", qwen3Header({ n_layer: 2, head_count: 2, n_kv_heads: 2, key_length: 64, value_length: 64, embedding_length: 128, context_length: 4096 }).subarray(0, 300), /past the end/u],
  ])("refuses %s", async (_name, bytes, message) => {
    await expect(readGgufHeader(bytesReader(bytes), bytes.length)).rejects.toThrow(message);
    await expect(readGgufHeader(bytesReader(bytes), bytes.length)).rejects.toBeInstanceOf(GgufHeaderError);
  });
});

describe("the curated catalog", () => {
  it("lists the design's five entries with header facts read from the files, the 0.6B and 4B equal to the spike's", () => {
    expect(CATALOG.entries.map((item) => item.id)).toEqual(["qwen3-0.6b-q4_0", "qwen3-4b-q4_k_m", "qwen3-8b-q4_k_m", "gpt-oss-20b-mxfp4", "qwen3-30b-a3b-q4_k_m"]);
    for (const item of CATALOG.entries) {
      expect(item.curated).toBe(true);
      expect(item.header, item.id).not.toBeNull();
      expect(item.files.every((file) => file.url.startsWith(`https://huggingface.co/${item.source.repository}/resolve/${item.source.revision}/`)), item.id).toBe(true);
      expect(item.license.id).toBe("apache-2.0");
    }
    for (const file of HEADERS.files) {
      const match = CATALOG.entries.find((item) => item.files[0]!.name === file.file)!;
      expect(match.header).toEqual({ n_layer: file.facts.n_layer, n_kv_heads: file.facts.n_kv_heads, key_length: file.facts.key_length, value_length: file.facts.value_length });
      expect(match.context.train).toBe(file.facts.context_length);
    }
    const spike = JSON.parse(readFileSync(join(ROOT, "examples", "verification", "chrome-inbrowser-spike-t40-qwen3-4b.json"), "utf8")) as { model: { sha256: string; bytes: number } };
    expect(entry("qwen3-4b-q4_k_m").files[0]).toMatchObject({ sha256: spike.model.sha256, bytes: spike.model.bytes });
  });

  it("the shipped signed list verifies under the pinned webagents-catalog key and carries exactly the content file", async () => {
    const key = publicKeyFromPem(readFileSync(join(ROOT, "examples", "keys", "webagents-catalog.pub.pem"), "utf8"));
    const verified = await verifySignedDocument(new Uint8Array(readFileSync(join(ROOT, "examples", "model-catalog.json"))), MODEL_CATALOG_TYPE, [key]);
    expect(verified.content).toEqual(CONTENT);
    // Signed as a model catalog, it is not an index: the content type is in the transcript.
    await expect(verifySignedDocument(new Uint8Array(readFileSync(join(ROOT, "examples", "model-catalog.json"))), AGENT_INDEX_TYPE, [key])).rejects.toMatchObject({ code: "document_type_mismatch" });
  });

  it("a list signed by another key, or carrying an uncurated or repeated entry, is refused", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const signer = { publicKey: raw, sign: (message: Uint8Array) => new Uint8Array(nodeSign(null, message, privateKey)) };
    const signed = new TextEncoder().encode(serializeSignedDocument(await buildSignedDocument(MODEL_CATALOG_TYPE, CONTENT as never, signer)));
    const pinned = publicKeyFromPem(readFileSync(join(ROOT, "examples", "keys", "webagents-catalog.pub.pem"), "utf8"));
    await expect(verifySignedDocument(signed, MODEL_CATALOG_TYPE, [pinned])).rejects.toMatchObject({ code: "document_key_unknown" });
    expect((await verifySignedDocument(signed, MODEL_CATALOG_TYPE, [raw])).content_type).toBe(MODEL_CATALOG_TYPE);
    const entries = (CONTENT.entries as Array<Record<string, unknown>>).map((item) => ({ ...item }));
    expect(() => readModelCatalog({ ...CONTENT, entries: [{ ...entries[0], curated: false }] })).toThrow(/not marked curated/u);
    expect(() => readModelCatalog({ ...CONTENT, entries: [entries[0], entries[0]] })).toThrow(/repeat an id/u);
    expect(() => readModelCatalog({ ...CONTENT, version: "v1" })).toThrow(/release number/u);
    expect(() => readModelCatalog({ ...CONTENT, extra: true })).toThrow(/Unknown fields/u);
  });

  it("the entry schema accepts every curated entry and the catalog schema's entry is the entry schema", async () => {
    for (const item of CONTENT.entries as unknown[]) expect(await extensionSchemaFailure(item, "in-browser-model-v0")).toBeNull();
    expect(await extensionSchemaFailure({ ...(CONTENT.entries as Array<Record<string, unknown>>)[0], extra: 1 }, "in-browser-model-v0")).not.toBeNull();
    expect(await extensionSchemaFailure({ ...(CONTENT.entries as Array<Record<string, unknown>>)[0], files: [{ name: "a", url: "http://x.test/a", bytes: 1, sha256: "0".repeat(64) }] }, "in-browser-model-v0")).not.toBeNull();
    expect(await extensionSchemaFailure(CONTENT, "model-catalog-v0")).toBeNull();
    const entrySchema = JSON.parse(readFileSync(join(ROOT, "spec", "extensions", "in-browser-model-v0.schema.json"), "utf8")) as Record<string, unknown>;
    const catalogSchema = JSON.parse(readFileSync(join(ROOT, "spec", "extensions", "model-catalog-v0.schema.json"), "utf8")) as { $defs: Record<string, unknown> };
    const { $schema: _s, $id: _i, title: _t, description: _d, $defs: _defs, ...inner } = entrySchema;
    expect(catalogSchema.$defs.entry).toEqual(inner);
  });
});

const GIB = 1024 ** 3;
const machine = (changes: Partial<MachineFacts>): MachineFacts => ({ gpu: null, device_memory_gb: null, storage: { quota: 500e9, usage: 0 }, kernel_class: "fast", declared_gpu_bytes: null, ...changes });
const MACHINES: Record<string, MachineFacts> = {
  "an 8 GB laptop with an integrated GPU": machine({ gpu: { vendor: "intel", architecture: "gen-12lp", is_fallback: false, features: [], max_buffer_size: 2 ** 31 }, device_memory_gb: 8, kernel_class: "medium" }),
  "a 16 GB Mac": machine({ gpu: { vendor: "apple", architecture: "metal-3", is_fallback: false, features: ["shader-f16"], max_buffer_size: 2 ** 32 }, device_memory_gb: 16 }),
  "this 36 GB Mac (deviceMemory 32)": machine({ gpu: { vendor: "apple", architecture: "metal-3", is_fallback: false, features: ["shader-f16"], max_buffer_size: 2 ** 32 }, device_memory_gb: 32 }),
  "a 24 GB card the person stated": machine({ gpu: { vendor: "nvidia", architecture: "ada", is_fallback: false, features: [], max_buffer_size: 2 ** 32 }, device_memory_gb: 8, declared_gpu_bytes: 24e9 }),
};

describe("the GPU budget (D-443, D-454)", () => {
  it("is the person's statement, else 0.65 × max(hint, 8 GiB) on Apple Silicon, else 6 GB assumed, each with its basis", () => {
    expect(gpuBudget(MACHINES["a 24 GB card the person stated"]!)).toEqual({ bytes: 24e9, basis: "declared" });
    expect(gpuBudget(MACHINES["this 36 GB Mac (deviceMemory 32)"]!)).toEqual({ bytes: Math.floor(0.65 * 32 * GIB), basis: "platform" });
    expect(gpuBudget({ gpu: { vendor: "apple", architecture: null, is_fallback: null, features: [], max_buffer_size: null }, device_memory_gb: null, declared_gpu_bytes: null })).toEqual({ bytes: Math.floor(0.65 * 8 * GIB), basis: "platform" });
    expect(gpuBudget(MACHINES["an 8 GB laptop with an integrated GPU"]!)).toEqual({ bytes: 6e9, basis: "assumed" });
    expect(budgetWords({ bytes: 6e9, basis: "assumed" })).toBe("budget 6.0 GB, assumed; state your GPU memory in Settings → Models to change it");
  });
});

const states = (cached: string[] = [], measured: Record<string, number> = {}): Map<string, Pick<InBrowserEntryState, "cached" | "verified" | "measured">> =>
  new Map(CATALOG.entries.map((item) => [item.id, { cached: cached.includes(item.id), verified: cached.includes(item.id), measured: measured[item.id] === undefined ? null : { prefill_tok_per_s: 100, decode_tok_per_s: measured[item.id]!, context: 16384 } }]));

/** WebAir 0.8.0's requirement shape: 16,000 tokens per task, structured output; plus reasoning when asked. */
function packageEvaluation(options: { context: number; reasoning?: boolean }): PackageEvaluation {
  const requirements = {
    schema: "agentpkg-model-requirements-v0",
    hard_requirements: [
      { id: "context_tokens", kind: "context_tokens", subject: "context_tokens", operator: "at_least", value: options.context, tasks: ["interpret"] },
      { id: "capability:structured_output", kind: "capability", subject: "structured_output", operator: "is_true", value: true, tasks: ["interpret"] },
      ...(options.reasoning ? [{ id: "capability:reasoning", kind: "capability", subject: "reasoning", operator: "is_true", value: true, tasks: ["interpret"] }] : []),
    ],
    preferences: [],
  } as unknown as RequirementSet;
  return (descriptor) => {
    const evaluation = evaluateModel(requirements, normalizeDescriptor(descriptor, 0));
    return { status: evaluation.status, violated: evaluation.checks.filter((check) => check.status === "violated") };
  };
}

describe("the recommendation bins (D-443): machine classes × the five curated entries", () => {
  const bins = (facts: MachineFacts, evaluate: PackageEvaluation | null = null, cached: string[] = [], measured: Record<string, number> = {}) => Object.fromEntries(recommendInBrowser({ entries: CATALOG.entries, states: states(cached, measured), machine: facts, evaluate }).map((item) => [item.entry, item.bin]));

  it("with no package open, bins speak of the machine only", () => {
    expect(bins(MACHINES["an 8 GB laptop with an integrated GPU"]!)).toEqual({ "qwen3-0.6b-q4_0": "recommended", "qwen3-4b-q4_k_m": "recommended", "qwen3-8b-q4_k_m": "too_large", "gpt-oss-20b-mxfp4": "too_large", "qwen3-30b-a3b-q4_k_m": "too_large" });
    expect(bins(MACHINES["a 16 GB Mac"]!)).toEqual({ "qwen3-0.6b-q4_0": "recommended", "qwen3-4b-q4_k_m": "recommended", "qwen3-8b-q4_k_m": "recommended", "gpt-oss-20b-mxfp4": "too_large", "qwen3-30b-a3b-q4_k_m": "too_large" });
    expect(bins(MACHINES["this 36 GB Mac (deviceMemory 32)"]!)).toEqual({ "qwen3-0.6b-q4_0": "recommended", "qwen3-4b-q4_k_m": "recommended", "qwen3-8b-q4_k_m": "recommended", "gpt-oss-20b-mxfp4": "recommended", "qwen3-30b-a3b-q4_k_m": "too_large" });
    expect(bins(MACHINES["a 24 GB card the person stated"]!)).toEqual({ "qwen3-0.6b-q4_0": "recommended", "qwen3-4b-q4_k_m": "recommended", "qwen3-8b-q4_k_m": "recommended", "gpt-oss-20b-mxfp4": "recommended", "qwen3-30b-a3b-q4_k_m": "too_large" });
  });

  it("the largest fitting context halves from the default; the reasons carry the numbers and the budget's basis", () => {
    const laptop = recommendInBrowser({ entries: CATALOG.entries, states: states(), machine: MACHINES["an 8 GB laptop with an integrated GPU"]!, evaluate: null });
    const four = laptop.find((item) => item.entry === "qwen3-4b-q4_k_m")!;
    expect(four.context).toBe(8192);
    expect(four.estimate_bytes).toBe(gpuMemoryEstimate(entry("qwen3-4b-q4_k_m"), 8192));
    expect(four.reasons[0]).toBe(`fits at a 8,192-token context: about ${(four.estimate_bytes! / 1e9).toFixed(1)} GB of the budget 6.0 GB, assumed; state your GPU memory in Settings → Models to change it`);
    const eight = laptop.find((item) => item.entry === "qwen3-8b-q4_k_m")!;
    expect(eight.context).toBeNull();
    expect(eight.reasons[0]).toMatch(/even at a 4,096-token context; 80 % of the budget 6.0 GB, assumed/u);
  });

  it("not suitable: WebAir's 16,000-token context on a machine where the 4B fits only at 8,192; never on a larger machine", () => {
    const webair = packageEvaluation({ context: 16_000 });
    const laptop = recommendInBrowser({ entries: CATALOG.entries, states: states(), machine: MACHINES["an 8 GB laptop with an integrated GPU"]!, evaluate: webair });
    const four = laptop.find((item) => item.entry === "qwen3-4b-q4_k_m")!;
    expect(four.bin).toBe("not_suitable");
    expect(four.reasons).toContain("the package needs a 16,000-token context; on this machine the model fits only at 8,192");
    expect(laptop.find((item) => item.entry === "qwen3-0.6b-q4_0")!.bin).toBe("recommended");
    expect(bins(MACHINES["a 16 GB Mac"]!, webair)["qwen3-4b-q4_k_m"]).toBe("recommended");
  });

  it("not suitable: a package that requires reasoning against an entry that states false (a larger machine never fixes it)", () => {
    const noReasoning = normalizeInBrowserEntry({ ...(CONTENT.entries as Array<Record<string, unknown>>)[0], id: "plain-0.6b", curated: false, capabilities: { structured_output: true, reasoning: false, tool_use: null } });
    for (const facts of Object.values(MACHINES)) {
      const [made] = recommendInBrowser({ entries: [noReasoning], states: new Map(), machine: facts, evaluate: packageEvaluation({ context: 4096, reasoning: true }) });
      expect(made!.bin).toBe("not_suitable");
      expect(made!.reasons).toContain("the package requires `reasoning`; this entry states false");
    }
  });

  it("possible: an unverified package fact, an unknown or slow kernel class, or a measured decode under 8 tok/s", () => {
    const mac = MACHINES["a 16 GB Mac"]!;
    expect(bins({ ...mac, kernel_class: null })["qwen3-4b-q4_k_m"]).toBe("possible");
    expect(bins({ ...mac, kernel_class: "slow" })["qwen3-4b-q4_k_m"]).toBe("possible");
    expect(bins(mac, null, ["qwen3-4b-q4_k_m"], { "qwen3-4b-q4_k_m": 6.5 })["qwen3-4b-q4_k_m"]).toBe("possible");
    // A measured speed outranks the kernel class either way.
    expect(bins({ ...mac, kernel_class: "slow" }, null, ["qwen3-4b-q4_k_m"], { "qwen3-4b-q4_k_m": 37 })["qwen3-4b-q4_k_m"]).toBe("recommended");
    const unverified: PackageEvaluation = () => ({ status: "unverified", violated: [] });
    expect(bins(mac, unverified)["qwen3-0.6b-q4_0"]).toBe("possible");
  });

  it("too large for the storage: the files do not fit the free space less 1 GB (a cached entry needs no space)", () => {
    const tight = { ...MACHINES["this 36 GB Mac (deviceMemory 32)"]!, storage: { quota: 3e9, usage: 0 } };
    const made = recommendInBrowser({ entries: CATALOG.entries, states: states(["qwen3-8b-q4_k_m"]), machine: tight, evaluate: null });
    expect(made.find((item) => item.entry === "qwen3-4b-q4_k_m")!.bin).toBe("too_large");
    expect(made.find((item) => item.entry === "qwen3-4b-q4_k_m")!.reasons.join(" ")).toMatch(/storage free and keeps 1 GB spare/u);
    expect(made.find((item) => item.entry === "qwen3-8b-q4_k_m")!.bin).toBe("recommended");
  });

  it("an entry with no header yet is binned on its size alone and marked estimate after download", () => {
    const pasted = normalizeInBrowserEntry({ ...(CONTENT.entries as Array<Record<string, unknown>>)[1], id: "pasted-4b", curated: false, header: null });
    const [made] = recommendInBrowser({ entries: [pasted], states: new Map(), machine: MACHINES["a 16 GB Mac"]!, evaluate: null });
    expect(made!.estimate_after_download).toBe(true);
    expect(made!.estimate_bytes).toBe(Math.ceil(pasted.bytes_total * 1.15 + 512e6));
    expect(made!.reasons[0]).toMatch(/\(estimate after download\)$/u);
  });

  it("orders bins recommended first, cached entries first within a bin, then smaller; the default suggestion is the smallest recommended curated entry", () => {
    const made = recommendInBrowser({ entries: CATALOG.entries, states: states(["qwen3-8b-q4_k_m"]), machine: MACHINES["a 16 GB Mac"]!, evaluate: null });
    expect(made.map((item) => item.entry)).toEqual(["qwen3-8b-q4_k_m", "qwen3-0.6b-q4_0", "qwen3-4b-q4_k_m", "gpt-oss-20b-mxfp4", "qwen3-30b-a3b-q4_k_m"]);
    expect(defaultSuggestion(made, CATALOG.entries)!.entry).toBe("qwen3-8b-q4_k_m");
    const fresh = recommendInBrowser({ entries: CATALOG.entries, states: states(), machine: MACHINES["a 16 GB Mac"]!, evaluate: packageEvaluation({ context: 16_000 }) });
    expect(defaultSuggestion(fresh, CATALOG.entries)!.entry).toBe("qwen3-0.6b-q4_0");
  });
});

describe("the in-browser probe", () => {
  const connection = { provider: "in-browser" as const, enabled: true, base_url: null, key_configured: false, overrides: { "qwen3-4b-q4_k_m": { context_tokens: 8192 } } };
  const full = (changes: Partial<InBrowserEntryState> = {}): InBrowserEntryState => ({ cached: false, verified: false, loaded: false, chosen_context: null, budget: { bytes: 20e9, basis: "platform" }, measured: null, ...changes });

  it("is the first route, has no endpoint, and describes every entry with no network request", async () => {
    expect(PROVIDER_IDS[0]).toBe("in-browser");
    expect(hasEndpoint("in-browser")).toBe(false);
    expect(hasEndpoint("chrome-builtin")).toBe(false);
    expect(hasEndpoint("ollama")).toBe(true);
    const result = await probeProvider(connection, async () => { throw new Error("no request"); }, null, { entries: CATALOG.entries, states: new Map([["qwen3-4b-q4_k_m", full({ cached: true, verified: true, loaded: true })]]), budget: { bytes: 20e9, basis: "platform" } });
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(5);
    const four = result.models.find((item) => (item as { id: string }).id === "in-browser/qwen3-4b-q4_k_m") as Record<string, unknown>;
    expect(four.available).toBe(true);
    expect((four.limits as { context_tokens: number }).context_tokens).toBe(8192);
    expect((four.properties as { status: string }).status).toBe("loaded");
    const other = result.models.find((item) => (item as { id: string }).id === "in-browser/qwen3-8b-q4_k_m") as Record<string, unknown>;
    expect(other.availability_reason).toBe(`not downloaded (${(entry("qwen3-8b-q4_k_m").bytes_total / 1e9).toFixed(1)} GB)`);
  });

  it("says why nothing can run: no entries, no WebGPU, a load that died at that context", () => {
    expect(probeInBrowser(connection, null)).toMatchObject({ ok: false, models: [] });
    const noGpu = probeInBrowser(connection, { entries: CATALOG.entries, states: new Map([["qwen3-0.6b-q4_0", full({ cached: true, verified: true, engine: { available: false, reason: "WebGPU is not available to this extension's execution host" } })]]), budget: { bytes: 20e9, basis: "platform" } });
    expect(noGpu.ok).toBe(false);
    expect((noGpu.models[0] as Record<string, unknown>).availability_reason).toBe("WebGPU is not available to this extension's execution host");
    const died = inBrowserDescriptor(entry("qwen3-0.6b-q4_0"), full({ cached: true, verified: true, failed_context: 16384 })) as Record<string, unknown>;
    expect(died.availability_reason).toBe("failed to run at a 16,384-token context on this machine; try a smaller context or model");
    expect((inBrowserDescriptor(entry("qwen3-0.6b-q4_0"), full({ cached: true, verified: true, failed_context: 16384 }), { context_tokens: 8192 }) as Record<string, unknown>).available).toBe(true);
  });
});
