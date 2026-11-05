/**
 * The in-browser route in the service worker (T41, D-442…D-446, D-453): the state owner's half of
 * the models the extension runs itself. It holds no weights and runs no engine (the offscreen page
 * does both, `engine-host.ts`, `models-manager.ts`); it knows:
 *
 *   the entries     the verified curated list (the newest valid one held, else the one shipped in
 *                   the extension, D-453) and the person's pasted repositories (rows in the cache)
 *   the machine     the engine Worker's probe and kernel benchmark when measured, else this
 *                   worker's own `navigator.gpu` and `deviceMemory`; the person's GPU-memory
 *                   statement; the budget from them (D-443)
 *   the catalog     one descriptor per entry for `buildHostCatalog` (no network request)
 *   the start       what `host.start` carries for a plan bound to `in-browser/<entry>`
 *
 * Network: the Hugging Face API for a pasted repository and the project's origin for a newer list,
 * each only on the person's action and only after Chrome grants the origin (`requireOrigin`).
 * Downloads go from the offscreen page, again only on the person's click.
 */
import { isRecord } from "../../core/fields.js";
import { publicKeyFromPem } from "../../core/keys.js";
import type { InBrowserProbeInput } from "../../core/models/catalog.js";
import type { CatalogNote } from "../../core/compatibility.js";
import {
  budgetWords,
  checkModelFileUrl,
  defaultSuggestion,
  gpuBudget,
  IN_BROWSER_ENTRY_SCHEMA,
  inBrowserDescriptor,
  MAX_CONTEXT,
  normalizeInBrowserEntry,
  readModelCatalog,
  recommendInBrowser,
  weightsDigest,
  type InBrowserEntry,
  type InBrowserEntryState,
  type MachineFacts,
  type ModelCatalog,
  type PackageEvaluation,
  type Recommendation,
} from "../../core/models/in-browser-catalog.js";
import { compareRelease } from "../../core/version.js";
import { MODEL_CATALOG_TYPE, verifySignedDocument } from "../../core/signed-document.js";
import shippedCatalog from "../data/model-catalog.json" with { type: "json" };
import catalogSource from "../data/model-catalog-source.json" with { type: "json" };
import type { DownloadView } from "../execution/models-manager.js";
import type { EngineBenchmark, EngineProbe } from "../execution/engine-protocol.js";
import type { EngineStatus } from "../execution/engine-host.js";
import type { HostEngineMessage, HostModelsMessage, InBrowserStart } from "../execution/protocol.js";
import { cacheState, effectiveEntry, type ModelRecord, type ModelStore } from "../storage/models.js";
import type { Settings, StorageArea } from "../storage/settings.js";

/** `chrome.storage.local`: the newest verified list fetched (its text, re-verified on read) and the measured machine. */
export const CATALOG_KEY = "modelCatalog";
export const MACHINE_KEY = "inBrowserMachine";
/** The default chosen context when an entry states none that fits (design §3). */
export const DEFAULT_ENTRY_CONTEXT = 16_384;
export const HUGGING_FACE = "https://huggingface.co";
/** Families whose models reason (design §5): a pasted entry of one states `reasoning: true`. */
export const REASONING_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/qwen3/iu, "qwen3"],
  [/deepseek-r1/iu, "deepseek-r1"],
  [/gpt-oss/iu, "gpt-oss"],
];
export const PASTED_NOTE = "Not reviewed by WebAgents: check the licence and the model's quality yourself.";

export interface MachineRecord {
  probe: EngineProbe | null;
  benchmark: (EngineBenchmark & { at: string }) | null;
  probed_at: string | null;
}

export interface InBrowserView {
  catalog: { id: string; version: string; title: string; source: "shipped" | "refreshed"; issued_at: string; notes: CatalogNote[]; refresh_url: string };
  machine: MachineFacts & { budget: InBrowserEntryState["budget"]; budget_words: string; probed_at: string | null; benchmark: MachineRecord["benchmark"]; webgpu: boolean | null; adapter: string | null };
  entries: Array<{
    entry: InBrowserEntry;
    recommendation: Recommendation;
    descriptor: Record<string, unknown>;
    cached: boolean;
    verified: boolean;
    row: Pick<ModelRecord, "downloaded_at" | "verified_at" | "last_used" | "measured" | "failed_context" | "last_error" | "header" | "mismatch"> | null;
    download: DownloadView | null;
  }>;
  suggestion: Recommendation | null;
  engine: EngineStatus | null;
  totals: { cached_bytes: number; entries_cached: number };
  settings: Settings["models"]["in_browser"] & { think: boolean };
}

export interface PastedCandidate {
  file: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  bytes_total: number;
}

export interface PasteView {
  repository: string;
  revision: string;
  license: string | null;
  gated: boolean;
  candidates: PastedCandidate[];
}

export interface InBrowserDeps {
  models: ModelStore;
  area: StorageArea;
  /** Send a command to the offscreen page (creating it when needed); null when this host has none. */
  host: ((message: HostModelsMessage | HostEngineMessage) => Promise<unknown>) | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** This worker's own view of the GPU and memory, used until the engine Worker measured. */
  localProbe?: () => Promise<Partial<EngineProbe> | null>;
  now?: () => Date;
  /** The pinned key(s) of the curated list; the shipped `webagents-catalog` key by default. */
  catalogKeys?: Uint8Array[];
}

export class InBrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "InBrowserError";
  }
}

/** The shipped list's source facts (`data/model-catalog-source.json`): the pinned public key and the refresh address. */
export const CATALOG_SOURCE = catalogSource as { public_key_pem: string; refresh_url: string; note: string };

const utf8 = (text: string) => new TextEncoder().encode(text);

export class InBrowserService {
  private readonly now: () => Date;
  private readonly keys: Uint8Array[];
  private catalogCache: { catalog: ModelCatalog; source: "shipped" | "refreshed"; notes: CatalogNote[] } | null = null;

  constructor(private readonly deps: InBrowserDeps) {
    this.now = deps.now ?? (() => new Date());
    this.keys = deps.catalogKeys ?? [publicKeyFromPem(CATALOG_SOURCE.public_key_pem)];
  }

  // -- the curated list (D-453) --------------------------------------------------------------
  /** The newest valid list: a refreshed one when it verifies, is not older than the shipped one and has not expired; else the shipped one. */
  async curated(): Promise<{ catalog: ModelCatalog; source: "shipped" | "refreshed"; notes: CatalogNote[] }> {
    if (this.catalogCache) return this.catalogCache;
    const shipped = await this.verifyList(utf8(JSON.stringify(shippedCatalog)));
    const notes: CatalogNote[] = [];
    let chosen: { catalog: ModelCatalog; source: "shipped" | "refreshed" } = { catalog: shipped, source: "shipped" };
    const held = (await this.deps.area.get(CATALOG_KEY))[CATALOG_KEY];
    if (isRecord(held) && typeof held.text === "string") {
      try {
        const refreshed = await this.verifyList(utf8(held.text));
        if (refreshed.expires_at !== null && Date.parse(refreshed.expires_at) < this.now().getTime()) notes.push({ code: "model_catalog_stale", detail: `The model list ${refreshed.version} expired on ${refreshed.expires_at}; the list shipped with this extension is used.` });
        else if (compareRelease(refreshed.version, shipped.version) < 0) notes.push({ code: "model_catalog_older", detail: `The model list held (${refreshed.version}) is older than the shipped one (${shipped.version}); the shipped one is used.` });
        else chosen = { catalog: refreshed, source: "refreshed" };
      } catch (error) {
        notes.push({ code: "model_catalog_refused", detail: `The model list held here did not verify (${error instanceof Error ? error.message : "invalid"}); the list shipped with this extension is used.` });
      }
    }
    this.catalogCache = { ...chosen, notes };
    return this.catalogCache;
  }

  private async verifyList(bytes: Uint8Array): Promise<ModelCatalog> {
    const verified = await verifySignedDocument(bytes, MODEL_CATALOG_TYPE, this.keys);
    return readModelCatalog(verified.content);
  }

  /** Fetch a newer list from the project's origin (the person's click): kept only if it verifies and is not a rollback or a reused version. */
  async refreshCatalog(): Promise<{ version: string; source: "refreshed" | "shipped"; changed: boolean }> {
    let response: Response;
    try {
      response = await this.deps.fetch(CATALOG_SOURCE.refresh_url, { method: "GET", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", headers: { accept: "application/json" } });
    } catch (error) {
      throw new InBrowserError("model_catalog_unreachable", `The model list could not be fetched (${error instanceof Error ? error.name : "error"}).`, 502);
    }
    if (!response.ok) throw new InBrowserError("model_catalog_unreachable", `The model list's address answered HTTP ${response.status}.`, 502);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new InBrowserError("document_too_large", "The model list exceeds 1 MiB.", 422);
    const next = await this.verifyList(utf8(text));
    const current = await this.curated();
    const order = compareRelease(next.version, current.catalog.version);
    if (order < 0) throw new InBrowserError("document_rollback", `The model list at this address is version ${next.version}, older than the version ${current.catalog.version} held here; the newer copy is kept.`);
    if (order === 0) {
      if (JSON.stringify(next) !== JSON.stringify(current.catalog)) throw new InBrowserError("document_version_reused", `The model list states version ${next.version} again with different content; the copy held here is kept.`);
      return { version: next.version, source: current.source, changed: false };
    }
    await this.deps.area.set({ [CATALOG_KEY]: { text, fetched_at: this.now().toISOString() } });
    this.catalogCache = null;
    return { version: next.version, source: "refreshed", changed: true };
  }

  // -- the entries ---------------------------------------------------------------------------
  /** Curated entries first (the list's order), then the person's pasted ones; a cached row's header and context complete its entry. */
  async entries(): Promise<{ entries: InBrowserEntry[]; rows: Map<string, ModelRecord> }> {
    const { catalog } = await this.curated();
    const rows = new Map((await this.deps.models.list()).map((row) => [row.entry_id, row]));
    const curated = catalog.entries.map((entry) => effectiveEntry(entry, rows.get(entry.id) ?? null));
    const ids = new Set(curated.map((entry) => entry.id));
    const pasted = [...rows.values()].filter((row) => !ids.has(row.entry_id) && !row.entry.curated).map((row) => pastedWithHeader(row));
    return { entries: [...curated, ...pasted], rows };
  }

  async entry(entryId: string): Promise<InBrowserEntry> {
    const found = (await this.entries()).entries.find((entry) => entry.id === entryId);
    if (!found) throw new InBrowserError("model_unknown", `No in-browser model ${JSON.stringify(entryId)} is listed here.`, 404);
    return found;
  }

  // -- the machine (D-443) -------------------------------------------------------------------
  async machineRecord(): Promise<MachineRecord> {
    const stored = (await this.deps.area.get(MACHINE_KEY))[MACHINE_KEY];
    if (isRecord(stored)) return stored as unknown as MachineRecord;
    return { probe: null, benchmark: null, probed_at: null };
  }

  async machine(settings: Settings): Promise<MachineFacts & { webgpu: boolean | null; record: MachineRecord }> {
    const record = await this.machineRecord();
    const probe = record.probe ?? ((await this.deps.localProbe?.().catch(() => null)) as EngineProbe | null) ?? null;
    const adapter = probe?.adapter ?? null;
    const declared = settings.models.in_browser.gpu_memory_gb;
    return {
      gpu: adapter === null ? null : { vendor: adapter.vendor, architecture: adapter.architecture, is_fallback: adapter.is_fallback, features: adapter.features ?? [], max_buffer_size: adapter.max_buffer_size },
      device_memory_gb: probe?.device_memory_gb ?? null,
      storage: probe?.storage ?? null,
      kernel_class: record.benchmark?.kernel_class ?? null,
      declared_gpu_bytes: declared === null ? null : declared * 1e9,
      webgpu: probe === null ? null : probe.has_webgpu === true && adapter !== null && adapter.is_fallback !== true,
      record,
    };
  }

  /** Ask the engine Worker for the machine's facts and the kernel benchmark (D-455), and keep them. */
  async measure(): Promise<MachineRecord> {
    if (this.deps.host === null) throw new InBrowserError("execution_unavailable", "This browser has no execution host to measure the GPU in.", 503);
    const probe = (await this.deps.host({ type: "host.engine", action: "probe" })) as EngineProbe;
    let benchmark: MachineRecord["benchmark"] = null;
    if (probe.has_webgpu && probe.adapter !== null) {
      try {
        benchmark = { ...((await this.deps.host({ type: "host.engine", action: "benchmark" })) as EngineBenchmark), at: this.now().toISOString() };
      } catch {
        benchmark = null;
      }
    }
    const record: MachineRecord = { probe, benchmark, probed_at: this.now().toISOString() };
    await this.deps.area.set({ [MACHINE_KEY]: record });
    return record;
  }

  // -- the catalog's input and the run's start -----------------------------------------------
  private state(entry: InBrowserEntry, row: ModelRecord | null, loaded: string | null, machine: Awaited<ReturnType<InBrowserService["machine"]>>, chosen: number | null): InBrowserEntryState {
    const { cached, verified } = cacheState(row);
    const budget = gpuBudget(machine);
    return {
      cached,
      verified,
      loaded: loaded === entry.id,
      chosen_context: chosen,
      budget,
      measured: row?.measured ? { prefill_tok_per_s: row.measured.prefill_tok_per_s, decode_tok_per_s: row.measured.decode_tok_per_s, context: row.measured.context } : null,
      failed_context: row?.failed_context ?? null,
      engine: machine.webgpu === false ? { available: false, reason: "WebGPU is not available to this extension (no adapter, or a software fallback)" } : null,
    };
  }

  /**
   * The context an entry runs at when the person chose none (design §3): the recommendation's
   * largest that fits `0.8 × budget`, halving from the entry's default; the default when none fits
   * (the descriptor then says why it cannot run).
   */
  private chosenContexts(entries: readonly InBrowserEntry[], rows: Map<string, ModelRecord>, machine: MachineFacts): Map<string, Recommendation> {
    const states = new Map(entries.map((entry) => [entry.id, cacheStateWithMeasure(rows.get(entry.id) ?? null)]));
    return new Map(recommendInBrowser({ entries, states, machine, evaluate: null }).map((item) => [item.entry, item]));
  }

  async probeInput(settings: Settings, loaded: string | null = null): Promise<InBrowserProbeInput> {
    const { entries, rows } = await this.entries();
    const machine = await this.machine(settings);
    const fits = this.chosenContexts(entries, rows, machine);
    const states = new Map(entries.map((entry) => [entry.id, this.state(entry, rows.get(entry.id) ?? null, loaded, machine, fits.get(entry.id)?.context ?? null)]));
    return { entries, states, budget: gpuBudget(machine), notes: (await this.curated()).notes };
  }

  /** What `host.start` carries for a plan bound to the in-browser route (D-441), or null for another route. */
  async startFor(binding: { provider_id: string; model_id: string; descriptor: Record<string, unknown> } | null, settings: Settings): Promise<InBrowserStart | null> {
    if (binding === null || binding.provider_id !== "in-browser") return null;
    const machine = await this.machine(settings);
    // The context the plan froze (the descriptor's `context_tokens`, D-130): the page loads exactly that.
    const limits = isRecord(binding.descriptor.limits) ? binding.descriptor.limits : {};
    const context = [limits.context_tokens, limits.native_context_window].find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    if (context === undefined) throw new InBrowserError("model_context_window_unknown", "The plan's in-browser binding states no context.", 409);
    return {
      entry: binding.model_id,
      n_ctx: Math.min(context, MAX_CONTEXT),
      think: inBrowserThink(settings),
      budget: gpuBudget(machine),
      idle_unload_minutes: settings.models.in_browser.idle_unload_minutes,
    };
  }

  // -- the view (Settings → Models → In this browser; the picker's suggestion) ----------------
  async view(settings: Settings, evaluate: PackageEvaluation | null = null): Promise<InBrowserView> {
    const { entries, rows } = await this.entries();
    const curated = await this.curated();
    const machine = await this.machine(settings);
    let status: { downloads: DownloadView[]; engine: EngineStatus } | null = null;
    if (this.deps.host !== null) {
      try {
        status = (await this.deps.host({ type: "host.models", action: "status" })) as { downloads: DownloadView[]; engine: EngineStatus };
      } catch {
        status = null;
      }
    }
    const loaded = status?.engine.loaded?.entry ?? null;
    const states = new Map(entries.map((entry) => [entry.id, cacheStateWithMeasure(rows.get(entry.id) ?? null)]));
    const recommendations = recommendInBrowser({ entries, states, machine, evaluate });
    const byEntry = new Map(recommendations.map((item) => [item.entry, item]));
    const fits = this.chosenContexts(entries, rows, machine);
    const overrides = settings.models.connections.find((item) => item.provider === "in-browser")?.overrides ?? {};
    const budget = gpuBudget(machine);
    const cachedRows = [...rows.values()].filter((row) => cacheState(row).cached);
    return {
      catalog: { id: curated.catalog.catalog_id, version: curated.catalog.version, title: curated.catalog.title, source: curated.source, issued_at: curated.catalog.issued_at, notes: curated.notes, refresh_url: CATALOG_SOURCE.refresh_url },
      machine: { ...machine, budget, budget_words: budgetWords(budget), probed_at: machine.record.probed_at, benchmark: machine.record.benchmark, adapter: machine.gpu ? [machine.gpu.vendor, machine.gpu.architecture].filter(Boolean).join(" / ") || null : null },
      entries: recommendations.map((recommendation) => {
        const entry = entries.find((item) => item.id === recommendation.entry)!;
        const row = rows.get(entry.id) ?? null;
        const { cached, verified } = cacheState(row);
        return {
          entry,
          recommendation,
          descriptor: inBrowserDescriptor(entry, this.state(entry, row, loaded, machine, fits.get(entry.id)?.context ?? null), overrides[entry.id] ?? {}),
          cached,
          verified,
          row: row === null ? null : { downloaded_at: row.downloaded_at, verified_at: row.verified_at, last_used: row.last_used, measured: row.measured, failed_context: row.failed_context, last_error: row.last_error, header: row.header, mismatch: row.mismatch },
          download: status?.downloads.find((item) => item.entry_id === entry.id) ?? null,
        };
      }),
      suggestion: defaultSuggestion(recommendations.filter((item) => byEntry.get(item.entry)!.bin === "recommended"), entries),
      engine: status?.engine ?? null,
      totals: { cached_bytes: cachedRows.reduce((sum, row) => sum + row.files.reduce((total, file) => total + file.bytes, 0), 0), entries_cached: cachedRows.length },
      settings: { ...settings.models.in_browser, think: inBrowserThink(settings) },
    };
  }

  // -- the person's actions -------------------------------------------------------------------
  private host(): NonNullable<InBrowserDeps["host"]> {
    if (this.deps.host === null) throw new InBrowserError("execution_unavailable", "This browser has no execution host for in-browser models.", 503);
    return this.deps.host;
  }

  async download(entryId: string): Promise<DownloadView> {
    const entry = await this.entry(entryId);
    for (const file of entry.files) checkModelFileUrl(file.url);
    return (await this.host()({ type: "host.models", action: "download", entry })) as DownloadView;
  }

  async command(action: "cancel" | "verify" | "delete", entryId: string): Promise<unknown> {
    return this.host()({ type: "host.models", action, entryId });
  }

  async load(entryId: string, settings: Settings): Promise<unknown> {
    const { entries, rows } = await this.entries();
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) throw new InBrowserError("model_unknown", `No in-browser model ${JSON.stringify(entryId)} is listed here.`, 404);
    const machine = await this.machine(settings);
    const stated = settings.models.connections.find((item) => item.provider === "in-browser")?.overrides[entryId]?.context_tokens ?? null;
    const context = Math.min(stated ?? this.chosenContexts(entries, rows, machine).get(entryId)?.context ?? entry.context.default, entry.context.max);
    return this.host()({ type: "host.engine", action: "load", load: { entry: entryId, n_ctx: context, think: inBrowserThink(settings), budget: gpuBudget(machine), idle_unload_minutes: settings.models.in_browser.idle_unload_minutes } });
  }

  async unload(): Promise<unknown> {
    return this.host()({ type: "host.engine", action: "unload" });
  }

  /** "Paste a Hugging Face repository" (design §5): the `.gguf` files with sizes and digests, the card's licence, gated refused. */
  async paste(raw: string): Promise<PasteView> {
    const repository = repositoryOf(raw);
    const meta = await this.repositoryMeta(repository);
    const siblings = Array.isArray(meta.siblings) ? meta.siblings.filter(isRecord) : [];
    const ggufs = siblings
      .map((item) => ({ name: typeof item.rfilename === "string" ? item.rfilename : "", bytes: typeof item.size === "number" ? item.size : NaN, sha256: isRecord(item.lfs) && typeof item.lfs.sha256 === "string" ? item.lfs.sha256 : "" }))
      .filter((item) => item.name.toLowerCase().endsWith(".gguf") && Number.isSafeInteger(item.bytes) && item.bytes > 0 && /^[0-9a-f]{64}$/u.test(item.sha256) && !/mmproj/iu.test(item.name));
    const candidates = groupSplits(ggufs);
    return { repository, revision: String(meta.sha), license: typeof (meta.cardData as Record<string, unknown> | undefined)?.license === "string" ? ((meta.cardData as Record<string, unknown>).license as string) : null, gated: meta.gated !== undefined && meta.gated !== false, candidates };
  }

  /** List one file of a pasted repository as an uncurated entry (no download yet). */
  async addPasted(raw: string, file: string): Promise<InBrowserEntry> {
    const view = await this.paste(raw);
    if (view.gated) throw new InBrowserError("model_gated", "This repository is gated: its files need a token, which this browser does not support (v1).", 422);
    const candidate = view.candidates.find((item) => item.file === file);
    if (!candidate) throw new InBrowserError("model_unknown", `${view.repository} lists no GGUF file ${JSON.stringify(file)} with a size and an LFS SHA-256.`, 404);
    const entry = pastedEntry(view, candidate);
    const { entries } = await this.entries();
    if (entries.some((item) => item.id === entry.id && item.curated)) throw new InBrowserError("model_listed", "This file is already in the curated list.", 409);
    await this.host()({ type: "host.models", action: "list", entry });
    return entry;
  }

  private async repositoryMeta(repository: string): Promise<Record<string, unknown>> {
    const url = `${HUGGING_FACE}/api/models/${repository}?blobs=true`;
    let response: Response;
    try {
      response = await this.deps.fetch(url, { method: "GET", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", headers: { accept: "application/json" } });
    } catch (error) {
      throw new InBrowserError("model_repository_unreachable", `Hugging Face did not answer (${error instanceof Error ? error.name : "error"}).`, 502);
    }
    if (response.status === 401 || response.status === 403) throw new InBrowserError("model_gated", `${repository} needs a token (it is gated or private); this browser does not support that (v1).`, 422);
    if (response.status === 404) throw new InBrowserError("model_repository_unknown", `Hugging Face has no repository ${repository}.`, 404);
    if (!response.ok) throw new InBrowserError("model_repository_unreachable", `Hugging Face answered HTTP ${response.status}.`, 502);
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new InBrowserError("model_repository_invalid", "Hugging Face's answer is larger than 4 MiB.", 502);
    let meta: unknown;
    try {
      meta = JSON.parse(text);
    } catch {
      throw new InBrowserError("model_repository_invalid", "Hugging Face's answer is not JSON.", 502);
    }
    if (!isRecord(meta) || typeof meta.sha !== "string" || !/^[0-9a-f]{40}$/u.test(meta.sha)) throw new InBrowserError("model_repository_invalid", "Hugging Face's answer names no commit.", 502);
    return meta;
  }

  invalidate(): void {
    this.catalogCache = null;
  }
}

/** The thinking switch for this route (D-085 → wllama's `reasoning`, D-456): the in-browser connection's own. */
export function inBrowserThink(settings: Settings): boolean {
  return settings.models.connections.find((item) => item.provider === "in-browser")?.think === true;
}

function cacheStateWithMeasure(row: ModelRecord | null): Pick<InBrowserEntryState, "cached" | "verified" | "measured"> {
  const { cached, verified } = cacheState(row);
  return { cached, verified, measured: row?.measured ? { prefill_tok_per_s: row.measured.prefill_tok_per_s, decode_tok_per_s: row.measured.decode_tok_per_s, context: row.measured.context } : null };
}

/** `owner/repo` from what the person pasted: the id itself or the repository page's URL. */
export function repositoryOf(raw: string): string {
  const text = raw.trim();
  let path = text;
  if (/^https?:\/\//iu.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new InBrowserError("model_repository_invalid", "That is not a URL.", 422);
    }
    if (url.hostname !== "huggingface.co") throw new InBrowserError("model_repository_invalid", "Only Hugging Face repositories (huggingface.co) can be pasted in this version.", 422);
    path = url.pathname.replace(/^\/+/u, "");
  }
  const [owner, repo] = path.split("/");
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
  if (!owner || !repo || !valid.test(owner) || !valid.test(repo) || repo.endsWith(".git")) throw new InBrowserError("model_repository_invalid", "Paste a Hugging Face repository as owner/name, or its page's address.", 422);
  return `${owner}/${repo}`;
}

/** Split GGUF files (`-00001-of-00003.gguf`) become one candidate with every part in order. */
export function groupSplits(files: Array<{ name: string; bytes: number; sha256: string }>): PastedCandidate[] {
  const split = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/iu;
  const groups = new Map<string, Array<{ name: string; bytes: number; sha256: string; part: number; of: number }>>();
  const out: PastedCandidate[] = [];
  for (const file of files) {
    const match = split.exec(file.name);
    if (!match) {
      out.push({ file: file.name, files: [file], bytes_total: file.bytes });
      continue;
    }
    const key = `${match[1]}|${match[3]}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...file, part: Number(match[2]), of: Number(match[3]) }]);
  }
  for (const parts of groups.values()) {
    const sorted = parts.sort((a, b) => a.part - b.part);
    if (sorted.length !== sorted[0]!.of || sorted.some((item, index) => item.part !== index + 1)) continue; // an incomplete split is not offered
    out.push({ file: sorted[0]!.name, files: sorted.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })), bytes_total: sorted.reduce((sum, item) => sum + item.bytes, 0) });
  }
  return out.sort((a, b) => a.bytes_total - b.bytes_total || (a.file < b.file ? -1 : 1));
}

/** The entry of a pasted file: uncurated, its header unknown until the download (design §5). */
export function pastedEntry(view: PasteView, candidate: PastedCandidate): InBrowserEntry {
  const stem = candidate.file.replace(/(-\d{5}-of-\d{5})?\.gguf$/iu, "");
  const id = `${view.repository}/${stem}`.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+/u, "").slice(0, 64).replace(/[-._]+$/u, "");
  const family = REASONING_FAMILIES.find(([pattern]) => pattern.test(`${view.repository} ${candidate.file}`))?.[1] ?? null;
  const quantization = /(?:^|[-_.])((?:I?Q\d[A-Z0-9_]*)|(?:F16|BF16|F32|MXFP4))(?:[-_.]|$)/iu.exec(stem)?.[1]?.toUpperCase() ?? "unknown";
  const files = candidate.files.map((file) => ({ name: file.name, url: `${HUGGING_FACE}/${view.repository}/resolve/${view.revision}/${encodeURIComponent(file.name).replace(/%2F/gu, "/")}`, bytes: file.bytes, sha256: file.sha256 }));
  return normalizeInBrowserEntry({
    schema: IN_BROWSER_ENTRY_SCHEMA,
    id,
    display_name: stem.slice(0, 128),
    family: family ?? (view.repository.split("/")[1]!.toLowerCase().slice(0, 64) || "unknown"),
    parameters: null,
    format: "gguf",
    engine: "wllama",
    quantization: quantization.slice(0, 32),
    files,
    weights_digest: weightsDigest(files.map((file) => file.sha256)),
    bytes_total: candidate.bytes_total,
    // Until the header is read after the download: the largest the route offers (design §5).
    context: { train: MAX_CONTEXT, default: DEFAULT_ENTRY_CONTEXT, max: MAX_CONTEXT },
    capabilities: { structured_output: true, reasoning: family === null ? null : true, tool_use: null },
    license: { id: (view.license ?? "unknown").slice(0, 64), name: (view.license ?? "not stated by the model card").slice(0, 128), url: `${HUGGING_FACE}/${view.repository}` },
    source: { repository: view.repository, revision: view.revision, api: `${HUGGING_FACE}/api/models/${view.repository}?blobs=true` },
    curated: false,
    header: null,
    notes: PASTED_NOTE,
  });
}

/** A pasted entry once its header was read: the training context it states bounds the entry's (design §5). */
function pastedWithHeader(row: ModelRecord): InBrowserEntry {
  const entry = effectiveEntry(row.entry, row);
  const train = row.header?.context_length ?? null;
  if (train === null) return entry;
  const max = Math.min(train, MAX_CONTEXT);
  return { ...entry, context: { train, max, default: Math.min(DEFAULT_ENTRY_CONTEXT, max) } };
}
