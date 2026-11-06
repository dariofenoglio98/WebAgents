// @vitest-environment happy-dom
/**
 * T41's views: Settings → Models → In this browser (the four bins with their reasons, the download
 * card with everything the person consents to, the actions of a cached model, the paste field) and
 * the picker's route cards in design §8's words and order (D-446). Rendered from a view built by the
 * real recommendation over the committed curated list, never typed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gpuBudget, budgetWords, inBrowserDescriptor, readModelCatalog, recommendInBrowser, type MachineFacts } from "../../src/core/models/in-browser-catalog.js";
import type { InBrowserView } from "../../src/extension/background/in-browser.js";
import { normalizeSettings } from "../../src/extension/storage/settings.js";
import { inRouteOrder, routeWords } from "../../src/extension/ui/authorize.js";
import { BIN_TITLES, busyKey, failureWords, inBrowserSection, newInBrowserPageState, NOTHING_LEFT_BEHIND, outcomeOf, ROUTE_LINE } from "../../src/extension/ui/in-browser-models.js";
import { ROOT } from "../helpers/paths.js";

const CATALOG = readModelCatalog(JSON.parse(readFileSync(join(ROOT, "examples", "model-catalog.content.json"), "utf8")));
const MACHINE: MachineFacts = { gpu: { vendor: "apple", architecture: "metal-3", is_fallback: false, features: ["shader-f16"], max_buffer_size: 2 ** 32 }, device_memory_gb: 16, storage: { quota: 50e9, usage: 5e9 }, kernel_class: "fast", declared_gpu_bytes: null };

function view(cached: string[] = [], loaded: string | null = null, extra: { failed?: Record<string, number>; unlisted?: InBrowserView["unlisted"]; orphan_files?: InBrowserView["orphan_files"] } = {}): InBrowserView {
  const failed = extra.failed ?? {};
  const states = new Map(CATALOG.entries.map((entry) => [entry.id, { cached: cached.includes(entry.id), verified: cached.includes(entry.id), measured: null, failed_context: failed[entry.id] ?? null }]));
  const recommendations = recommendInBrowser({ entries: CATALOG.entries, states, machine: MACHINE, evaluate: null });
  const budget = gpuBudget(MACHINE);
  return {
    catalog: { id: CATALOG.catalog_id, version: CATALOG.version, title: CATALOG.title, source: "shipped", issued_at: CATALOG.issued_at, notes: [], refresh_url: "https://webagents-webair-production.up.railway.app/model-catalog.json" },
    machine: { ...MACHINE, budget, budget_words: budgetWords(budget), probed_at: "2026-11-05T10:00:00Z", benchmark: { ms: 2.1, gflops: 512, f16: true, kernel_class: "fast", n: 512, repeats: 2, at: "2026-11-05T10:00:00Z" }, webgpu: true, adapter: "apple / metal-3", cross_origin_storage: false },
    entries: recommendations.map((recommendation) => {
      const entry = CATALOG.entries.find((item) => item.id === recommendation.entry)!;
      const isCached = cached.includes(entry.id);
      return {
        entry,
        recommendation,
        descriptor: inBrowserDescriptor(entry, { cached: isCached, verified: isCached, loaded: loaded === entry.id, chosen_context: recommendation.context, budget, measured: null, failed_context: failed[entry.id] ?? null }),
        cached: isCached,
        verified: isCached,
        row: isCached ? { downloaded_at: "2026-11-05T10:00:00Z", verified_at: "2026-11-05T10:00:00Z", last_used: null, measured: null, failed_context: failed[entry.id] ?? null, last_error: null, header: null, mismatch: false } : null,
        download: null,
      };
    }),
    suggestion: null,
    engine: loaded === null ? null : { loaded: { entry: loaded, n_ctx: 16384, think: false, load_ms: 3000, n_gpu_layers: null, offload_log: [] }, loading: null, busy: false, queued: 0, runs: [], idle_unload_at: null, last_failure: null },
    totals: { cached_bytes: 0, entries_cached: cached.length },
    unlisted: extra.unlisted ?? [],
    orphan_files: extra.orphan_files ?? null,
    settings: { gpu_memory_gb: null, idle_unload_minutes: 10, cross_origin_storage: false, think: false },
  };
}

function render(current: InBrowserView, state = newInBrowserPageState()) {
  const requests: Array<{ request: { type: string; [key: string]: unknown }; origins: string[] }> = [];
  const saved: unknown[] = [];
  const root = document.createElement("div");
  const draw = () => {
    root.replaceChildren(...inBrowserSection(current, normalizeSettings({}), state, { request: (request, origins = []) => requests.push({ request, origins }), save: (settings) => saved.push(settings), rerender: draw }));
  };
  draw();
  return { root, requests, saved, state };
}

describe("Settings → Models → In this browser", () => {
  it("says what the route is and what is left behind, in the design's words", () => {
    const { root } = render(view());
    expect(root.textContent).toContain(ROUTE_LINE);
    expect(root.textContent).toContain(NOTHING_LEFT_BEHIND);
    expect(root.textContent).toContain("budget");
  });

  it("lists every curated entry in its bin with its reasons, the recommended bin first", () => {
    const { root } = render(view());
    const headings = [...root.querySelectorAll("h4")].map((node) => node.textContent);
    expect(headings.filter((text) => Object.values(BIN_TITLES).includes(text!))).toEqual([BIN_TITLES.recommended, BIN_TITLES.too_large]);
    const rows = [...root.querySelectorAll<HTMLElement>("[data-bin]")];
    expect(rows.map((node) => node.dataset.model)).toHaveLength(CATALOG.entries.length);
    const four = root.querySelector<HTMLElement>('[data-model="in-browser/qwen3-4b-q4_k_m"]')!;
    expect(four.dataset.bin).toBe("recommended");
    expect(four.textContent).toMatch(/fits at a 32,768-token context/u);
  });

  it("opens the download card on Download… and starts nothing until its own Download button, asking Chrome for huggingface.co", () => {
    const { root, requests } = render(view());
    const four = () => root.querySelector<HTMLElement>('[data-model="in-browser/qwen3-4b-q4_k_m"]')!;
    [...four().querySelectorAll("button")].find((node) => node.textContent === "Download…")!.click();
    expect(requests).toEqual([]);
    const card = root.querySelector<HTMLElement>('[data-download-card="qwen3-4b-q4_k_m"]')!;
    const entry = CATALOG.entries.find((item) => item.id === "qwen3-4b-q4_k_m")!;
    expect(card.textContent).toContain(`${entry.bytes_total.toLocaleString("en-US")} bytes`);
    expect(card.querySelector<HTMLAnchorElement>("a")!.href).toBe(entry.license.url);
    expect(card.textContent).toContain(entry.source.repository);
    expect(card.textContent).toContain("1 from huggingface.co");
    expect(card.textContent).toContain(entry.files[0]!.sha256);
    expect(card.textContent).toMatch(/GB free now, .* GB after/u);
    expect(card.textContent).toMatch(/fits at a 32,768-token context/u);
    [...card.querySelectorAll("button")].find((node) => node.textContent!.startsWith("Download ("))!.click();
    expect(requests).toEqual([{ request: { type: "inbrowser.download", entryId: "qwen3-4b-q4_k_m" }, origins: ["https://huggingface.co"] }]);
  });

  it("offers Load, Verify, Delete and Make default for a cached model, and Unload for the loaded one", () => {
    const { root, requests, saved } = render(view(["qwen3-0.6b-q4_0", "qwen3-4b-q4_k_m"], "qwen3-4b-q4_k_m"));
    const small = root.querySelector<HTMLElement>('[data-model="in-browser/qwen3-0.6b-q4_0"]')!;
    const labels = [...small.querySelectorAll("button")].map((node) => node.textContent);
    expect(labels).toEqual(["Load", "Verify", "Delete", "Make default"]);
    const loaded = root.querySelector<HTMLElement>('[data-model="in-browser/qwen3-4b-q4_k_m"]')!;
    expect(loaded.textContent).toContain("loaded now · 16,384 tokens");
    [...loaded.querySelectorAll("button")].find((node) => node.textContent === "Unload")!.click();
    [...small.querySelectorAll("button")].find((node) => node.textContent === "Delete")!.click();
    [...small.querySelectorAll("button")].find((node) => node.textContent === "Make default")!.click();
    expect(requests.map((item) => item.request)).toEqual([{ type: "inbrowser.unload" }, { type: "inbrowser.delete", entryId: "qwen3-0.6b-q4_0" }]);
    expect((saved[0] as { models: { default_model: string } }).models.default_model).toBe("in-browser/qwen3-0.6b-q4_0");
  });

  it("says Verify is running, then what it found, under the row it was pressed on (the T41 walk-through saw nothing)", () => {
    const state = newInBrowserPageState();
    const request = { type: "inbrowser.verify", entryId: "qwen3-4b-q4_k_m" };
    state.busy = busyKey(request);
    const busy = render(view(["qwen3-4b-q4_k_m"]), state).root.querySelector<HTMLElement>('[data-model="in-browser/qwen3-4b-q4_k_m"]')!;
    const labels = [...busy.querySelectorAll("button")].map((node) => [node.textContent, node.disabled]);
    expect(labels).toContainEqual(["Verifying…", true]);
    expect(labels).toContainEqual(["Delete", true]);
    const entry = CATALOG.entries.find((item) => item.id === "qwen3-4b-q4_k_m")!;
    state.busy = null;
    state.outcome = outcomeOf(request, { verified: true, files: entry.files.map((file) => ({ bytes: file.bytes })) });
    const done = render(view(["qwen3-4b-q4_k_m"]), state).root.querySelector<HTMLElement>('[data-model="in-browser/qwen3-4b-q4_k_m"]')!;
    expect(done.querySelector('[role="status"]')!.textContent).toBe(`Verified just now: all ${(entry.bytes_total / 1e9).toFixed(1)} GB re-read, and every file still matches its SHA-256.`);
    expect([...done.querySelectorAll("button")].map((node) => node.textContent)).toContain("Verify");
    // Another row is not touched; a mismatch says what to do.
    expect(render(view(["qwen3-4b-q4_k_m", "qwen3-0.6b-q4_0"]), state).root.querySelector('[data-model="in-browser/qwen3-0.6b-q4_0"] [role="status"]')).toBeNull();
    expect(outcomeOf(request, { verified: false, files: [] })).toMatchObject({ tone: "bad", text: expect.stringMatching(/did not match the digest the catalog states\. Delete the model and download it again\.$/u) });
    expect(outcomeOf({ type: "inbrowser.load", entryId: "x" }, { n_ctx: 32768, load_ms: 3305 })).toEqual({ entry: "x", text: "Loaded at 32,768 tokens in 3.3 s.", tone: "good" });
    expect(outcomeOf({ type: "inbrowser.unload" }, {})).toBeNull();
  });

  // T41 review 1, finding 2: after a dead load the person had no field and no way out but Delete.
  // T41 review 2, nit 6: a resumed download re-hashes the complete file first; the row says so with the bytes read.
  it("says a download is checking the cached file while it re-hashes it", () => {
    const current = view();
    const item = current.entries[0]!;
    const base = { entry_id: item.entry.id, state: "downloading" as const, file_index: 0, files: 1, bytes_done: 1e9, bytes_total: item.entry.bytes_total, resumed_from: 0, started_at: "2026-11-05T10:00:00Z", ended_at: null, error: null };
    item.download = { ...base, verifying: true };
    expect(render(current).root.textContent).toContain("checking the cached file · 1.0 GB of");
    item.download = { ...base, verifying: false };
    expect(render(current).root.textContent).not.toContain("checking the cached file");
  });

  it("shows a context that failed with Clear, and still offers Load at the smaller context the recommendation chose", () => {
    const { root, requests } = render(view(["qwen3-4b-q4_k_m"], null, { failed: { "qwen3-4b-q4_k_m": 32_768 } }));
    const four = root.querySelector<HTMLElement>('[data-model="in-browser/qwen3-4b-q4_k_m"]')!;
    expect(four.querySelector("[data-failed-context]")!.textContent).toContain("Failed to run at a 32,768-token context on this machine (its engine stopped, most likely out of memory); the next load uses 16,384 tokens. Clear it to try 32,768 again.");
    const load = [...four.querySelectorAll("button")].find((node) => node.textContent === "Load")!;
    expect(load.disabled).toBe(false);
    [...four.querySelectorAll("button")].find((node) => node.textContent === "Clear")!.click();
    expect(requests.map((item) => item.request)).toEqual([{ type: "inbrowser.clearFailure", entryId: "qwen3-4b-q4_k_m" }]);
    expect(failureWords(4096, 4096)).toBe("Failed to run at a 4,096-token context on this machine (its engine stopped, most likely out of memory). Clear it to try 4,096 again.");
  });

  // T41 review 1, finding 4: cached bytes no listed entry showed were counted and unreachable.
  it("lists models no longer in the list with Delete, and files no model names with Remove them", () => {
    const unlisted = [{ entry_id: "qwen3-1.7b-q4_k_m", display_name: "Qwen3 1.7B (Q4_K_M)", bytes: 1.1e9, cached: true, downloaded_at: "2026-11-01T10:00:00Z" }];
    const { root, requests } = render(view([], null, { unlisted, orphan_files: { count: 2, bytes: 2.5e9 } }));
    const row = root.querySelector<HTMLElement>('[data-unlisted="qwen3-1.7b-q4_k_m"]')!;
    expect(row.textContent).toContain("Qwen3 1.7B (Q4_K_M)");
    expect(row.textContent).toContain("1.1 GB");
    [...row.querySelectorAll("button")].find((node) => node.textContent === "Delete")!.click();
    const orphans = root.querySelector<HTMLElement>(".ab-orphans")!;
    expect(orphans.textContent).toContain("2 cached files no model names (2.5 GB)");
    [...orphans.querySelectorAll("button")].find((node) => node.textContent === "Remove them")!.click();
    expect(requests.map((item) => item.request)).toEqual([{ type: "inbrowser.delete", entryId: "qwen3-1.7b-q4_k_m" }, { type: "inbrowser.prune" }]);
    // Nothing unlisted and no orphan: neither line is drawn.
    const clean = render(view([], null, { orphan_files: { count: 0, bytes: 0 } })).root;
    expect(clean.querySelector("[data-unlisted]")).toBeNull();
    expect(clean.querySelector(".ab-orphans")).toBeNull();
  });

  it("looks a pasted repository up with huggingface.co asked first", () => {
    const state = newInBrowserPageState();
    const { root, requests } = render(view(), state);
    const input = root.querySelector<HTMLInputElement>('input[name="in-browser-paste"]')!;
    input.value = "Qwen/Qwen3-4B-GGUF";
    input.dispatchEvent(new Event("input"));
    [...root.querySelectorAll("button")].find((node) => node.textContent === "Look up")!.click();
    expect(requests).toEqual([{ request: { type: "inbrowser.paste", repository: "Qwen/Qwen3-4B-GGUF" }, origins: ["https://huggingface.co"] }]);
  });
});

describe("the picker's route cards (D-446)", () => {
  it("speaks each route in the design's words", () => {
    expect(routeWords({ provider_id: "in-browser", display_name: "Qwen3 4B (Q4_K_M)", model_id: "in-browser/qwen3-4b-q4_k_m" })).toEqual({ line: "In this browser · Qwen3 4B (Q4_K_M) · free", subline: "Runs inside this extension on your GPU. No network: nothing leaves this browser." });
    expect(routeWords({ provider_id: "chrome-builtin", display_name: "x", model_id: "chrome-builtin/gemini-nano" }).line).toBe("Chrome's built-in model (Gemini Nano) · free");
    expect(routeWords({ provider_id: "ollama", display_name: "qwen3:30b", model_id: "ollama/qwen3:30b" })).toEqual({ line: "Ollama on this computer · qwen3:30b · free", subline: "A separate application: it runs outside the browser's protection, and this browser cannot bound what it does with your data." });
    expect(routeWords({ provider_id: "openai", display_name: "x", model_id: "openai/gpt-5.6-luna" })).toEqual({ line: "Hosted by OpenAI · gpt-5.6-luna · metered", subline: "Your key; the request leaves this device to the provider." });
  });

  it("orders the routes in this browser, Chrome's built-in, Ollama, hosted", () => {
    const models = [{ provider_id: "openai", id: 1 }, { provider_id: "ollama", id: 2 }, { provider_id: "in-browser", id: 3 }, { provider_id: "chrome-builtin", id: 4 }, { provider_id: "in-browser", id: 5 }];
    expect(inRouteOrder(models).map((item) => item.id)).toEqual([3, 5, 4, 2, 1]);
  });
});
