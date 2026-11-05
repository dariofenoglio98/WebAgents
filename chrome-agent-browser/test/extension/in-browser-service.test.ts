/**
 * T41's in-browser route in the service worker (`background/in-browser.ts`): the shipped signed
 * list and its source (kept equal to `examples/`), a held or refreshed list (unknown key, newer,
 * rollback, reused version, expired), a pasted Hugging Face repository (`repositoryOf`, the API
 * answer's GGUF files and splits, gated and missing repositories, the uncurated entry), the
 * person's download, the run's start and the catalog's probe input. Curated facts are read from
 * `examples/model-catalog.content.json`; test lists are signed here with a fresh Ed25519 key.
 */
import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { publicKeyFromPem } from "../../src/core/keys.js";
import { probeInBrowser, type ProviderConnection } from "../../src/core/models/catalog.js";
import { checkModelFileUrl, gpuBudget, MAX_CONTEXT, normalizeInBrowserEntry, readModelCatalog, type InBrowserEntry } from "../../src/core/models/in-browser-catalog.js";
import { buildSignedDocument, MODEL_CATALOG_TYPE, serializeSignedDocument } from "../../src/core/signed-document.js";
import { CATALOG_KEY, CATALOG_SOURCE, InBrowserService, MACHINE_KEY, PASTED_NOTE, repositoryOf, type MachineRecord } from "../../src/extension/background/in-browser.js";
import type { EngineProbe } from "../../src/extension/execution/engine-protocol.js";
import type { HostEngineMessage, HostModelsMessage } from "../../src/extension/execution/protocol.js";
import { MemoryModelStore, newModelRecord, type ModelRecord } from "../../src/extension/storage/models.js";
import { MemoryStorageArea, normalizeSettings, type Settings } from "../../src/extension/storage/settings.js";
import { PROJECT } from "../helpers/paths.js";

const ROOT = join(PROJECT, "..");
const CONTENT = JSON.parse(readFileSync(join(ROOT, "examples", "model-catalog.content.json"), "utf8")) as Record<string, unknown>;
const CATALOG = readModelCatalog(CONTENT);
const curatedEntry = (id: string): InBrowserEntry => CATALOG.entries.find((entry) => entry.id === id)!;
const NOW = new Date("2026-11-05T18:00:00Z");

const SHIPPED_KEY = publicKeyFromPem(readFileSync(join(ROOT, "examples", "keys", "webagents-catalog.pub.pem"), "utf8"));
const TEST_PAIR = generateKeyPairSync("ed25519");
const TEST_KEY = new Uint8Array(TEST_PAIR.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const signer = { publicKey: TEST_KEY, sign: (message: Uint8Array) => new Uint8Array(nodeSign(null, message, TEST_PAIR.privateKey)) };
const signedText = async (content: Record<string, unknown>): Promise<string> => serializeSignedDocument(await buildSignedDocument(MODEL_CATALOG_TYPE, content as never, signer));

type HostMessage = HostModelsMessage | HostEngineMessage;

interface Setup {
  service: InBrowserService;
  models: MemoryModelStore;
  area: MemoryStorageArea;
  sent: HostMessage[];
  fetched: string[];
}

function makeService(options: { fetch?: (url: string) => Response | Promise<Response>; keys?: Uint8Array[]; area?: MemoryStorageArea; models?: MemoryModelStore } = {}): Setup {
  const models = options.models ?? new MemoryModelStore();
  const area = options.area ?? new MemoryStorageArea();
  const sent: HostMessage[] = [];
  const fetched: string[] = [];
  const service = new InBrowserService({
    models,
    area,
    host: async (message) => {
      sent.push(structuredClone(message));
      return {};
    },
    fetch: async (url) => {
      fetched.push(url);
      if (!options.fetch) throw new Error("no network in this test");
      return options.fetch(url);
    },
    now: () => NOW,
    ...(options.keys ? { catalogKeys: options.keys } : {}),
  });
  return { service, models, area, sent, fetched };
}

const BOTH_KEYS = [TEST_KEY, SHIPPED_KEY];

describe("the curated list", () => {
  it("ships the examples' signed list and key, and lists the five curated entries", async () => {
    // The extension's copy is examples/model-catalog.json, verified under the pinned webagents-catalog key.
    const shipped = JSON.parse(readFileSync(join(PROJECT, "src", "extension", "data", "model-catalog.json"), "utf8")) as unknown;
    expect(shipped).toEqual(JSON.parse(readFileSync(join(ROOT, "examples", "model-catalog.json"), "utf8")));
    const source = JSON.parse(readFileSync(join(PROJECT, "src", "extension", "data", "model-catalog-source.json"), "utf8")) as { public_key_pem: string };
    expect(source.public_key_pem).toBe(readFileSync(join(ROOT, "examples", "keys", "webagents-catalog.pub.pem"), "utf8"));
    const { service } = makeService();
    const curated = await service.curated();
    expect(curated.source).toBe("shipped");
    expect(curated.notes).toEqual([]);
    expect(curated.catalog.entries.map((entry) => entry.id)).toEqual((CONTENT.entries as Array<{ id: string }>).map((entry) => entry.id));
    expect(curated.catalog.entries).toHaveLength(5);
    expect(curated.catalog.entries).toEqual(CATALOG.entries);
  });

  it("falls back to the shipped list when the held one is signed by an unknown key", async () => {
    // A held list must verify under the pinned key; otherwise a note and the shipped one.
    const area = new MemoryStorageArea();
    await area.set({ [CATALOG_KEY]: { text: await signedText({ ...CONTENT, version: "1.2.0" }) } });
    const curated = await makeService({ area }).service.curated();
    expect(curated.source).toBe("shipped");
    expect(curated.catalog.version).toBe(CATALOG.version);
    expect(curated.notes.map((note) => note.code)).toEqual(["model_catalog_refused"]);
  });

  it("keeps a newer list from the refresh address and uses it from then on", async () => {
    // A newer version that verifies is kept and chosen over the shipped one.
    const text = await signedText({ ...CONTENT, version: "1.2.0" });
    const { service, area, fetched } = makeService({ keys: BOTH_KEYS, fetch: () => new Response(text, { status: 200 }) });
    expect((await service.curated()).source).toBe("shipped");
    expect(await service.refreshCatalog()).toEqual({ version: "1.2.0", source: "refreshed", changed: true });
    expect(fetched).toEqual([CATALOG_SOURCE.refresh_url]);
    expect(((await area.get(CATALOG_KEY))[CATALOG_KEY] as { text: string }).text).toBe(text);
    const curated = await service.curated();
    expect(curated).toMatchObject({ source: "refreshed", catalog: { version: "1.2.0" }, notes: [] });
    // A second service over the same storage reads the held list.
    expect((await makeService({ keys: BOTH_KEYS, area }).service.curated()).catalog.version).toBe("1.2.0");
  });

  it("refuses an older list as a rollback and keeps nothing", async () => {
    // A version below the one held is a rollback.
    const text = await signedText({ ...CONTENT, version: "0.9.0" });
    const { service, area } = makeService({ keys: BOTH_KEYS, fetch: () => new Response(text, { status: 200 }) });
    await expect(service.refreshCatalog()).rejects.toMatchObject({ code: "document_rollback" });
    expect(await area.get(CATALOG_KEY)).toEqual({});
  });

  it("refuses the same version with other content, and reports the same list as unchanged", async () => {
    // A version number is never reused for different content.
    const reused = await signedText({ ...CONTENT, title: `${String(CONTENT.title)} (changed)` });
    const first = makeService({ keys: BOTH_KEYS, fetch: () => new Response(reused, { status: 200 }) });
    await expect(first.service.refreshCatalog()).rejects.toMatchObject({ code: "document_version_reused" });
    expect(await first.area.get(CATALOG_KEY)).toEqual({});
    const same = await signedText(CONTENT);
    const second = makeService({ keys: BOTH_KEYS, fetch: () => new Response(same, { status: 200 }) });
    expect(await second.service.refreshCatalog()).toEqual({ version: CATALOG.version, source: "shipped", changed: false });
  });

  it("refuses to fetch a list that has already expired, and keeps nothing", async () => {
    const text = await signedText({ ...CONTENT, version: "1.2.0", expires_at: "2026-01-01T00:00:00Z" });
    const { service, area } = makeService({ keys: BOTH_KEYS, fetch: () => new Response(text, { status: 200 }) });
    await expect(service.refreshCatalog()).rejects.toMatchObject({ code: "model_catalog_stale" });
    expect(await area.get(CATALOG_KEY)).toEqual({});
  });

  it("falls back to the shipped list when the held one expired, or is older", async () => {
    // An expired held list is stale; an older one is not chosen either.
    const expired = new MemoryStorageArea();
    await expired.set({ [CATALOG_KEY]: { text: await signedText({ ...CONTENT, version: "1.2.0", expires_at: "2026-01-01T00:00:00Z" }) } });
    expect(await makeService({ keys: BOTH_KEYS, area: expired }).service.curated()).toMatchObject({ source: "shipped", catalog: { version: CATALOG.version }, notes: [{ code: "model_catalog_stale" }] });
    const older = new MemoryStorageArea();
    await older.set({ [CATALOG_KEY]: { text: await signedText({ ...CONTENT, version: "0.9.0" }) } });
    expect(await makeService({ keys: BOTH_KEYS, area: older }).service.curated()).toMatchObject({ source: "shipped", notes: [{ code: "model_catalog_older" }] });
  });
});

describe("repositoryOf", () => {
  it("reads owner/name from the id or the repository page's address", () => {
    // Both forms the person may paste.
    expect(repositoryOf("Qwen/Qwen3-4B-GGUF")).toBe("Qwen/Qwen3-4B-GGUF");
    expect(repositoryOf("  Qwen/Qwen3-4B-GGUF  ")).toBe("Qwen/Qwen3-4B-GGUF");
    expect(repositoryOf("https://huggingface.co/Qwen/Qwen3-4B-GGUF/tree/main")).toBe("Qwen/Qwen3-4B-GGUF");
    expect(repositoryOf("https://huggingface.co/Qwen/Qwen3-4B-GGUF")).toBe("Qwen/Qwen3-4B-GGUF");
  });

  for (const raw of ["https://github.com/Qwen/Qwen3-4B-GGUF", "https://huggingface.co.evil.example/Qwen/Qwen3-4B-GGUF", "Qwen", "https://huggingface.co/Qwen", "", "not a repository", "../../etc/passwd", "Qwen/Qwen3.git", "https://exa mple"]) {
    it(`refuses ${JSON.stringify(raw)}`, () => {
      // Another host, a single segment, or anything that is not owner/name.
      expect(() => repositoryOf(raw)).toThrow(expect.objectContaining({ code: "model_repository_invalid" }));
    });
  }
});

const REVISION = "1234567890abcdef1234567890abcdef12345678";
const digest = (seed: string): string => createHash("sha256").update(seed).digest("hex");

function hfAnswer(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: REVISION,
    cardData: { license: "apache-2.0" },
    siblings: [
      { rfilename: "README.md", size: 1000 },
      { rfilename: "Qwen3-1.7B-Q8_0.gguf", size: 2000, lfs: { sha256: digest("q8") } },
      { rfilename: "Qwen3-1.7B-Q4_K_M.gguf", size: 1100, lfs: { sha256: digest("q4") } },
      { rfilename: "mmproj-Qwen3-1.7B-F16.gguf", size: 500, lfs: { sha256: digest("mmproj") } },
      { rfilename: "Qwen3-1.7B-F16-00002-of-00003.gguf", size: 3000, lfs: { sha256: digest("f16-2") } },
      { rfilename: "Qwen3-1.7B-F16-00003-of-00003.gguf", size: 1000, lfs: { sha256: digest("f16-3") } },
      { rfilename: "Qwen3-1.7B-F16-00001-of-00003.gguf", size: 3000, lfs: { sha256: digest("f16-1") } },
      { rfilename: "Qwen3-1.7B-BF16-00001-of-00002.gguf", size: 3000, lfs: { sha256: digest("bf16-1") } },
      { rfilename: "Qwen3-1.7B-no-lfs.gguf", size: 10 },
    ],
    ...changes,
  };
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("a pasted Hugging Face repository", () => {
  it("lists the GGUF files with sizes and digests: mmproj and non-GGUF excluded, a split grouped in order, an incomplete split dropped", async () => {
    // One API call; candidates ordered by size.
    const { service, fetched } = makeService({ fetch: () => json(hfAnswer()) });
    const view = await service.paste("https://huggingface.co/unsloth/Qwen3-1.7B-GGUF");
    expect(fetched).toEqual(["https://huggingface.co/api/models/unsloth/Qwen3-1.7B-GGUF?blobs=true"]);
    expect(view).toMatchObject({ repository: "unsloth/Qwen3-1.7B-GGUF", revision: REVISION, license: "apache-2.0", gated: false });
    expect(view.candidates.map((candidate) => candidate.file)).toEqual(["Qwen3-1.7B-Q4_K_M.gguf", "Qwen3-1.7B-Q8_0.gguf", "Qwen3-1.7B-F16-00001-of-00003.gguf"]);
    const split = view.candidates[2]!;
    expect(split.files.map((file) => file.name)).toEqual(["Qwen3-1.7B-F16-00001-of-00003.gguf", "Qwen3-1.7B-F16-00002-of-00003.gguf", "Qwen3-1.7B-F16-00003-of-00003.gguf"]);
    expect(split.files.map((file) => file.sha256)).toEqual([digest("f16-1"), digest("f16-2"), digest("f16-3")]);
    expect(split.bytes_total).toBe(3000 + 3000 + 1000);
    expect(view.candidates[0]).toEqual({ file: "Qwen3-1.7B-Q4_K_M.gguf", files: [{ name: "Qwen3-1.7B-Q4_K_M.gguf", bytes: 1100, sha256: digest("q4") }], bytes_total: 1100 });
  });

  it("refuses a gated repository at addPasted, without telling the host", async () => {
    // A gated repository needs a token, which v1 does not support.
    const { service, sent } = makeService({ fetch: () => json(hfAnswer({ gated: "manual" })) });
    expect((await service.paste("unsloth/Qwen3-1.7B-GGUF")).gated).toBe(true);
    await expect(service.addPasted("unsloth/Qwen3-1.7B-GGUF", "Qwen3-1.7B-Q4_K_M.gguf")).rejects.toMatchObject({ code: "model_gated" });
    expect(sent).toEqual([]);
  });

  it("names a 401 as gated and a 404 as an unknown repository", async () => {
    // Hugging Face's answers in the person's words.
    await expect(makeService({ fetch: () => json({ error: "unauthorized" }, 401) }).service.paste("org/private-GGUF")).rejects.toMatchObject({ code: "model_gated" });
    await expect(makeService({ fetch: () => json({ error: "not found" }, 404) }).service.paste("org/missing-GGUF")).rejects.toMatchObject({ code: "model_repository_unknown" });
  });

  it("lists one file as an uncurated entry pinned to the commit, and tells the host", async () => {
    // A qwen3 repository's entry reasons; the URL names the commit the API stated.
    const { service, sent } = makeService({ fetch: () => json(hfAnswer()) });
    const entry = await service.addPasted("unsloth/Qwen3-1.7B-GGUF", "Qwen3-1.7B-Q4_K_M.gguf");
    expect(entry).toMatchObject({ curated: false, header: null, notes: PASTED_NOTE, family: "qwen3", quantization: "Q4_K_M", parameters: null, capabilities: { structured_output: true, reasoning: true, tool_use: null }, license: { id: "apache-2.0" }, source: { repository: "unsloth/Qwen3-1.7B-GGUF", revision: REVISION } });
    expect(entry.files).toEqual([{ name: "Qwen3-1.7B-Q4_K_M.gguf", url: `https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/${REVISION}/Qwen3-1.7B-Q4_K_M.gguf`, bytes: 1100, sha256: digest("q4") }]);
    expect(normalizeInBrowserEntry(entry)).toEqual(entry);
    expect(() => checkModelFileUrl(entry.files[0]!.url)).not.toThrow();
    expect(sent).toEqual([{ type: "host.models", action: "list", entry }]);
  });

  it("lists a split as one entry with every part in order", async () => {
    // The parts' URLs and digests in part order; the quantization read from the stem.
    const { service } = makeService({ fetch: () => json(hfAnswer()) });
    const entry = await service.addPasted("unsloth/Qwen3-1.7B-GGUF", "Qwen3-1.7B-F16-00001-of-00003.gguf");
    expect(entry.files.map((file) => file.sha256)).toEqual([digest("f16-1"), digest("f16-2"), digest("f16-3")]);
    expect(entry.bytes_total).toBe(7000);
    expect(entry.quantization).toBe("F16");
    expect(normalizeInBrowserEntry(entry)).toEqual(entry);
  });

  it("states no reasoning for a family it does not know", async () => {
    // Unknown family: reasoning null (absent), family from the repository name.
    const answer = hfAnswer({ cardData: {}, siblings: [{ rfilename: "Mistral-7B-Instruct-Q4_K_M.gguf", size: 4000, lfs: { sha256: digest("mistral") } }] });
    const { service } = makeService({ fetch: () => json(answer) });
    const entry = await service.addPasted("someone/Mistral-7B-Instruct-GGUF", "Mistral-7B-Instruct-Q4_K_M.gguf");
    expect(entry.capabilities.reasoning).toBeNull();
    expect(entry.family).toBe("mistral-7b-instruct-gguf");
    expect(entry.license.id).toBe("unknown");
    expect(normalizeInBrowserEntry(entry)).toEqual(entry);
  });

  it("refuses a file the repository does not list", async () => {
    // Only a listed GGUF with a size and a digest can become an entry.
    const { service, sent } = makeService({ fetch: () => json(hfAnswer()) });
    await expect(service.addPasted("unsloth/Qwen3-1.7B-GGUF", "Qwen3-1.7B-BF16-00001-of-00002.gguf")).rejects.toMatchObject({ code: "model_unknown" });
    expect(sent).toEqual([]);
  });
});

describe("the person's download", () => {
  it("sends a curated entry to the host, and refuses an unknown id", async () => {
    // The host downloads exactly the listed entry.
    const { service, sent } = makeService();
    await service.download("qwen3-4b-q4_k_m");
    expect(sent).toEqual([{ type: "host.models", action: "download", entry: curatedEntry("qwen3-4b-q4_k_m") }]);
    await expect(service.download("no-such-model")).rejects.toMatchObject({ code: "model_unknown" });
    expect(sent).toHaveLength(1);
  });
});

const settingsWith = (changes: { think?: boolean; idle?: number; gpu?: number | null }): Settings => {
  const base = normalizeSettings({}) as unknown as Record<string, unknown>;
  const models = base.models as Record<string, unknown>;
  return normalizeSettings({
    ...base,
    models: {
      ...models,
      connections: [{ provider: "in-browser", enabled: true, base_url: null, overrides: {}, ...(changes.think ? { think: true } : {}) }],
      in_browser: { ...(models.in_browser as Record<string, unknown>), ...(changes.idle === undefined ? {} : { idle_unload_minutes: changes.idle }), ...(changes.gpu === undefined ? {} : { gpu_memory_gb: changes.gpu }) },
    },
  });
};

describe("startFor", () => {
  it("is null for another route", async () => {
    // Only a plan bound to in-browser carries a start.
    const { service } = makeService();
    expect(await service.startFor({ provider_id: "ollama", model_id: "qwen3:30b", descriptor: {} }, normalizeSettings({}))).toBeNull();
    expect(await service.startFor(null, normalizeSettings({}))).toBeNull();
  });

  it("carries the plan's context, the connection's thinking, the budget and the idle minutes", async () => {
    // The page loads exactly what the plan froze.
    const { service } = makeService();
    const binding = { provider_id: "in-browser", model_id: "qwen3-4b-q4_k_m", descriptor: { limits: { context_tokens: 16384 } } };
    const assumed = settingsWith({ think: true, idle: 30 });
    expect(await service.startFor(binding, assumed)).toEqual({ entry: "qwen3-4b-q4_k_m", n_ctx: 16384, think: true, budget: gpuBudget({ gpu: null, device_memory_gb: null, declared_gpu_bytes: null }), idle_unload_minutes: 30 });
    const declared = settingsWith({ gpu: 24 });
    expect(await service.startFor(binding, declared)).toMatchObject({ think: false, budget: gpuBudget({ gpu: null, device_memory_gb: null, declared_gpu_bytes: 24 * 1e9 }), idle_unload_minutes: normalizeSettings({}).models.in_browser.idle_unload_minutes });
    expect((await service.startFor(binding, declared))!.budget.basis).toBe("declared");
  });

  it("caps the context at the route's largest and refuses a binding with none", async () => {
    // A context above MAX_CONTEXT is capped; no context at all is an error before the run.
    const { service } = makeService();
    expect((await service.startFor({ provider_id: "in-browser", model_id: "gpt-oss-20b-mxfp4", descriptor: { limits: { context_tokens: MAX_CONTEXT * 2 } } }, normalizeSettings({})))!.n_ctx).toBe(MAX_CONTEXT);
    await expect(service.startFor({ provider_id: "in-browser", model_id: "x", descriptor: {} }, normalizeSettings({}))).rejects.toMatchObject({ code: "model_context_window_unknown" });
  });
});

describe("probeInput", () => {
  it("makes the cached, verified 0.6B available on an Apple machine and says 'not downloaded' for the others", async () => {
    // The catalog's input from the cache rows and the measured machine record.
    const small = curatedEntry("qwen3-0.6b-q4_0");
    const models = new MemoryModelStore();
    const row: ModelRecord = { ...newModelRecord(small, NOW), verified: true, verified_at: NOW.toISOString(), downloaded_at: NOW.toISOString() };
    row.files = row.files.map((file) => ({ ...file, state: "complete" }));
    await models.put(row);
    const probe: EngineProbe = {
      has_webgpu: true,
      device_memory_gb: 16,
      hardware_concurrency: 10,
      storage: { quota: 500e9, usage: 0 },
      cross_origin_isolated: false,
      adapter: { vendor: "apple", architecture: "metal-3", description: null, is_fallback: false, features: ["shader-f16"], max_buffer_size: 4294967296, max_storage_buffer_binding_size: 4294967296 },
      device: true,
    };
    const machine: MachineRecord = { probe, benchmark: null, probed_at: NOW.toISOString() };
    const area = new MemoryStorageArea();
    await area.set({ [MACHINE_KEY]: machine });
    const { service } = makeService({ models, area });
    const settings = normalizeSettings({});
    const input = await service.probeInput(settings);
    expect(input.budget).toEqual(gpuBudget({ gpu: { vendor: "apple", architecture: "metal-3", is_fallback: false, features: ["shader-f16"], max_buffer_size: 4294967296 }, device_memory_gb: 16, declared_gpu_bytes: null }));
    expect(input.budget.basis).toBe("platform");
    expect(input.states.get(small.id)).toMatchObject({ cached: true, verified: true, loaded: false });
    const connection: ProviderConnection = { ...settings.models.connections.find((item) => item.provider === "in-browser")!, enabled: true, key_configured: false };
    const result = probeInBrowser(connection, input);
    expect(result.ok).toBe(true);
    const descriptors = result.models as Array<{ model_id: string; available: boolean; availability_reason: string | null }>;
    expect(descriptors.map((item) => item.model_id)).toEqual(CATALOG.entries.map((entry) => entry.id));
    for (const descriptor of descriptors) {
      if (descriptor.model_id === small.id) expect(descriptor).toMatchObject({ available: true, availability_reason: null });
      else {
        expect(descriptor.available).toBe(false);
        expect(descriptor.availability_reason).toContain("not downloaded");
      }
    }
  });
});
