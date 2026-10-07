/**
 * The model catalog without calling a model (D-023, D-055): each provider probe reads only
 * its listing endpoints through the injected transport, limits carry their provenance, the
 * Ollama default cap reproduces the reference host's 32,768 and a Settings override raises
 * it, missing keys and unreachable providers become notes, and the Chrome built-in model is
 * described by its availability.
 */
import { describe, expect, it } from "vitest";

import { evaluateCatalog } from "../../src/core/compatibility.js";
import {
  buildHostCatalog,
  builtinDescriptor,
  DEFAULT_OLLAMA_CONTEXT_CAP,
  probeProvider,
  type Http,
  type HttpRequest,
  type ProviderConnection,
} from "../../src/core/models/catalog.js";
import { literatureReview } from "../helpers/fixtures.js";

const connection = (provider: ProviderConnection["provider"], extra: Partial<ProviderConnection> = {}): ProviderConnection => ({
  provider,
  enabled: true,
  base_url: null,
  key_configured: provider !== "ollama" && provider !== "chrome-builtin",
  overrides: {},
  ...extra,
});

/** A transport over declared answers that records every request; unknown URLs answer 404. */
function fakeHttp(answers: Record<string, unknown>, log: HttpRequest[] = []): Http {
  return async (request) => {
    log.push(request);
    const key = `${request.method} ${request.url}`;
    if (key in answers) return { status: 200, body: answers[key] };
    if (request.url.endsWith("/api/show") && request.method === "POST") {
      const model = (request.body as { model: string }).model;
      const shown = answers[`SHOW ${model}`];
      if (shown !== undefined) return { status: 200, body: shown };
    }
    return { status: 404, body: null };
  };
}

const OLLAMA = {
  "GET http://127.0.0.1:11434/api/tags": { models: [{ name: "qwen3:30b", model: "qwen3:30b", details: { family: "qwen3moe" } }, { name: "tiny:1b", model: "tiny:1b" }] },
  "SHOW qwen3:30b": { capabilities: ["completion", "tools", "thinking"], model_info: { "general.architecture": "qwen3moe", "qwen3moe.context_length": 262144 } },
  "SHOW tiny:1b": { capabilities: ["completion"], model_info: { "llama.context_length": 8192 } },
};

describe("Ollama", () => {
  it("lists models from /api/tags, reads the native window and capabilities from /api/show, and caps the context at the reference host's default", async () => {
    const log: HttpRequest[] = [];
    const result = await probeProvider(connection("ollama"), fakeHttp(OLLAMA, log));
    expect(result.ok).toBe(true);
    expect(log.map((request) => `${request.method} ${request.url}`)).toEqual(["GET http://127.0.0.1:11434/api/tags", "POST http://127.0.0.1:11434/api/show", "POST http://127.0.0.1:11434/api/show"]);
    const qwen = result.models[0] as { limits: Record<string, number | null>; capabilities: Record<string, { value: boolean | null; basis: string }>; properties: { tags: string[] } };
    expect(qwen.limits).toEqual({ context_tokens: DEFAULT_OLLAMA_CONTEXT_CAP, native_context_window: 262144, max_output_tokens: null });
    expect(qwen.capabilities.reasoning).toMatchObject({ value: true, basis: "declared" });
    expect(qwen.capabilities.structured_output).toMatchObject({ value: true, basis: "derived" });
    expect(qwen.capabilities.tool_use).toMatchObject({ value: true, basis: "declared" });
    expect(qwen.properties.tags).toEqual(["local", "context:capped"]);
    const tiny = result.models[1] as { limits: Record<string, number | null>; properties: { tags: string[] } };
    expect(tiny.limits.context_tokens).toBe(8192); // a native window below the cap is the window
    expect(tiny.properties.tags).toEqual(["local"]);
  });

  it("a Settings override raises the window and the output cap and is recorded as declared (STATE.md §5: qwen3:30b at 65,536 / 16,384)", async () => {
    const result = await probeProvider(connection("ollama", { overrides: { "qwen3:30b": { context_tokens: 65536, max_output_tokens: 16384 } } }), fakeHttp(OLLAMA));
    const qwen = result.models[0] as { limits: Record<string, number | null>; properties: { tags: string[] } };
    expect(qwen.limits).toEqual({ context_tokens: 65536, native_context_window: 262144, max_output_tokens: 16384 });
    expect(qwen.properties.tags).toContain("limits:settings");
    // Both the default cap and the override satisfy Literature Review's declared minimum (see compatibility.test.ts).
    const { catalog } = await buildHostCatalog([connection("ollama", { overrides: { "qwen3:30b": { context_tokens: 65536 } } })], fakeHttp(OLLAMA), { builtin: null, runtimeVersion: "0.1.0", now: new Date("2026-10-06T12:00:00Z") });
    const evaluation = evaluateCatalog(await literatureReview(), catalog);
    expect(evaluation.models.find((model) => model.model_id === "ollama/qwen3:30b")).toMatchObject({ status: "compatible", limits: { context_tokens: 65536 } });
  });

  it("an unreachable Ollama is a probe error and a catalog note, never a guessed model", async () => {
    const result = await probeProvider(connection("ollama"), fakeHttp({}));
    expect(result).toMatchObject({ ok: false, models: [], error: expect.stringContaining("HTTP 404") });
    const failing: Http = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await probeProvider(connection("ollama"), failing)).toMatchObject({ ok: false, error: "ollama: TypeError" });
    const { catalog } = await buildHostCatalog([connection("ollama")], fakeHttp({}), { builtin: null, runtimeVersion: null });
    expect(catalog.models).toEqual([]);
    expect(catalog.notes.map((note) => note.code)).toEqual(["ollama_unreachable", "no_models_available"]);
  });
});

describe("hosted providers", () => {
  it("OpenAI: chat-capable ids only, documented limits as host_default, overrides as declared, no key means no probe", async () => {
    const answers = { "GET https://api.openai.com/v1/models": { data: [{ id: "gpt-5.6-luna" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }, { id: "gpt-4o-mini" }] } };
    const log: HttpRequest[] = [];
    const result = await probeProvider(connection("openai", { overrides: { "gpt-4o-mini": { context_tokens: 128000 } } }), fakeHttp(answers, log));
    expect(log[0]!.headers).toEqual({}); // the shell adds the credential header, never the core
    expect(result.models.map((model) => (model as { model_id: string }).model_id)).toEqual(["gpt-4o-mini", "gpt-5.6-luna"]);
    const luna = result.models[1] as { limits: Record<string, number | null>; properties: { tags: string[]; local: boolean }; capabilities: Record<string, { basis: string; value: boolean | null }> };
    expect(luna.limits.context_tokens).toBe(272000);
    expect(luna.properties.tags).toEqual(["hosted", "limits:documented"]);
    expect(luna.properties.local).toBe(false);
    expect(luna.capabilities.reasoning).toMatchObject({ value: true, basis: "host_default" });
    const mini = result.models[0] as { limits: Record<string, number | null>; properties: { tags: string[] }; capabilities: Record<string, { basis: string; value: boolean | null }> };
    expect(mini.limits.context_tokens).toBe(128000);
    expect(mini.properties.tags).toEqual(["hosted", "limits:settings"]);
    expect(mini.capabilities.reasoning).toMatchObject({ value: null, basis: "absent" });
    expect(await probeProvider(connection("openai", { key_configured: false }), fakeHttp(answers))).toMatchObject({ ok: false, error: expect.stringContaining("No OpenAI API key") });
  });

  it("Anthropic: the version and browser-access headers are the core's, limits are documented per family, reasoning is a family default", async () => {
    const answers = { "GET https://api.anthropic.com/v1/models?limit=100": { data: [{ id: "claude-fable-5-1", display_name: "Claude Fable 5.1" }, { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" }] } };
    const log: HttpRequest[] = [];
    const result = await probeProvider(connection("anthropic"), fakeHttp(answers, log));
    expect(log[0]!.headers).toEqual({ "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
    expect(result.models.map((model) => (model as { id: string; display_name: string }).display_name)).toEqual(["Claude Fable 5.1", "Claude Haiku 4.5"]);
    const fable = result.models[0] as { limits: Record<string, number | null>; capabilities: Record<string, { basis: string; value: boolean | null }> };
    expect(fable.limits.context_tokens).toBe(200000);
    expect(fable.capabilities.reasoning).toMatchObject({ value: true, basis: "host_default" });
  });

  it("an unknown hosted model without an override has no limits and evaluates as unverified, never as compatible", async () => {
    const answers = { "GET https://api.openai.com/v1/models": { data: [{ id: "gpt-9-nova" }] } };
    const { catalog } = await buildHostCatalog([connection("openai")], fakeHttp(answers), { builtin: null, runtimeVersion: null });
    const evaluation = evaluateCatalog(await literatureReview(), catalog);
    expect(evaluation.models[0]).toMatchObject({ status: "unverified", unknown: ["capability:reasoning", "context_tokens:minimum"] });
  });
});

describe("Chrome built-in", () => {
  it("is described by Chrome's availability and never probed over the network", async () => {
    const log: HttpRequest[] = [];
    const { catalog, probes } = await buildHostCatalog([connection("chrome-builtin")], fakeHttp({}, log), { builtin: { availability: "downloadable", input_quota: null }, runtimeVersion: null });
    expect(log).toEqual([]);
    expect(catalog.models[0]).toMatchObject({ id: "chrome-builtin/gemini-nano", available: false, selectable: false, availability_reason: expect.stringContaining("download"), properties: { local: true, status: "downloadable" } });
    expect(probes[0]).toMatchObject({ provider: "chrome-builtin", ok: true });
    const ready = builtinDescriptor(connection("chrome-builtin"), { availability: "available", input_quota: 6144 }) as { available: boolean; limits: Record<string, number | null> };
    expect(ready.available).toBe(true);
    expect(ready.limits).toEqual({ context_tokens: 6144, native_context_window: 6144, max_output_tokens: null });
    const absent = builtinDescriptor(connection("chrome-builtin"), null) as { availability_reason: string };
    expect(absent.availability_reason).toMatch(/no Prompt API/u);
  });

  it("disabled connections are skipped and the catalog is bound to its hash", async () => {
    const { catalog } = await buildHostCatalog([connection("ollama", { enabled: false }), connection("chrome-builtin")], fakeHttp(OLLAMA), { builtin: { availability: "available", input_quota: null }, runtimeVersion: "0.1.0", now: new Date("2026-10-06T12:00:00Z") });
    expect(catalog.models.map((model) => model.id)).toEqual(["chrome-builtin/gemini-nano"]);
    expect(catalog.catalog_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(catalog.host.runtime).toBe("chrome-agent-browser");
  });
});
