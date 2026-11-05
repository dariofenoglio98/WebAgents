/**
 * The in-browser model catalog (D-442, D-445, D-447): what an entry states about a model the
 * extension can run itself, the weights digest that identifies a set of weight files independent
 * of names, hosts and order (shared with model provenance, T42), the GPU-memory estimate the host
 * checks before a load (D-441), and the projection of an entry plus the cache's and the machine's
 * state into the provider-neutral descriptor `compatibility.ts` evaluates.
 *
 * Nothing here touches a file, the network or the GPU: the shell reads the cache, the adapter and
 * the header, and hands the facts in. Design: `docs/design/in-browser-inference.md` §3, §5.
 */
import type { CapabilityAnswer } from "../compatibility.js";
import { CoreError } from "../errors.js";
import { closedRecord, flag, hex64, invalid, positiveCount, requiredText, text, tristate } from "../fields.js";
import { sha256HexSync } from "../hash.js";
import { validatePackageUrl } from "../policy.js";
import { IN_BROWSER_PROVIDER, inBrowserHostModelId } from "./adapters/in-browser.js";

export const IN_BROWSER_ENTRY_SCHEMA = "agentpkg-in-browser-model-v0";
export const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
export const MAX_ENTRY_FILES = 64;
/** The largest context an entry may offer (Literature Review's heaviest calls, STATE.md §5). */
export const MAX_CONTEXT = 65_536;
export const FORMATS = Object.freeze(["gguf"] as const);
export const ENGINES = Object.freeze(["wllama"] as const);

export interface InBrowserFile {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface InBrowserHeader {
  n_layer: number;
  n_kv_heads: number;
  key_length: number;
  value_length: number;
  /** Present (`embedding`) only when the header lacked the two widths and `embedding_length / head_count` stood in: the verdict says so (design §3). */
  width_basis?: "embedding";
}

export interface InBrowserEntry {
  schema: typeof IN_BROWSER_ENTRY_SCHEMA;
  id: string;
  display_name: string;
  family: string;
  parameters: number | null;
  format: (typeof FORMATS)[number];
  engine: (typeof ENGINES)[number];
  quantization: string;
  files: InBrowserFile[];
  weights_digest: string;
  bytes_total: number;
  context: { train: number; default: number; max: number };
  capabilities: { structured_output: boolean; reasoning: boolean | null; tool_use: boolean | null };
  license: { id: string; name: string; url: string };
  source: { repository: string; revision: string; api: string | null };
  curated: boolean;
  /**
   * The GGUF header facts the GPU estimate needs (D-441): `<arch>.block_count`,
   * `<arch>.attention.head_count_kv`, `<arch>.attention.key_length` and `value_length` (the per-head
   * K and V widths; only when a header lacks them, `embedding_length / attention.head_count`, which
   * is wrong for Qwen3: 64 or 80 against a real 128). Null until the header was read.
   */
  header: InBrowserHeader | null;
  notes: string | null;
}

/**
 * The weights digest (D-447): `sha256:` + the hex SHA-256 of every file's lowercase hex SHA-256,
 * sorted bytewise, each followed by a newline. An identity of the set of files' bytes, independent
 * of their names, order and hosts: the same files fetched from two repositories compare equal. It
 * is **not** an identity of the tensors: a split copy and a single-file copy of the same model are
 * different bytes, so their digests differ (T42 pins the digest of the files the person runs).
 */
export function weightsDigest(fileDigests: readonly string[]): string {
  if (fileDigests.length === 0) throw invalid("weights_digest needs at least one file digest");
  const sorted = fileDigests.map((digest) => hex64(digest, "file sha256")!).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `sha256:${sha256HexSync(new TextEncoder().encode(`${sorted.join("\n")}\n`))}`;
}

/**
 * The GPU memory an entry needs at a context (D-441, D-454): the weights, the f16 KV cache
 * (`n_layer × context × n_kv_heads × (key_length + value_length) × 2 bytes`, every layer at the
 * full context, which overstates sliding-window models: the safe side), 15 % of the weights and
 * 512 MB (decimal, as every size this route shows: `gb()` divides by 1e9; T40 review 2). Null when
 * the header has not been read: an unknown need is never a fit.
 */
export const KV_BYTES_PER_VALUE = 2;
export const WEIGHTS_OVERHEAD_FRACTION = 0.15;
export const FIXED_OVERHEAD_BYTES = 512e6;

export function gpuMemoryEstimate(entry: Pick<InBrowserEntry, "bytes_total" | "header">, context: number): number | null {
  if (entry.header === null) return null;
  const { n_layer, n_kv_heads, key_length, value_length } = entry.header;
  const kv = n_layer * context * n_kv_heads * (key_length + value_length) * KV_BYTES_PER_VALUE;
  return Math.ceil(entry.bytes_total * (1 + WEIGHTS_OVERHEAD_FRACTION) + kv + FIXED_OVERHEAD_BYTES);
}

function httpsUrl(value: unknown, field: string): string {
  const raw = requiredText(value, field, { limit: 2048 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`${field} must be a URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw invalid(`${field} must be an https URL without credentials or fragment`);
  return raw;
}

/** Validate one entry into its exact shape; the digest must be the one its files give. */
export function normalizeInBrowserEntry(raw: unknown): InBrowserEntry {
  const record = closedRecord(
    raw,
    "entry",
    ["schema", "id", "display_name", "family", "parameters", "format", "engine", "quantization", "files", "weights_digest", "bytes_total", "context", "capabilities", "license", "source", "curated", "header", "notes"],
    ["schema", "id", "display_name", "family", "format", "engine", "quantization", "files", "weights_digest", "bytes_total", "context", "capabilities", "license", "source", "curated"],
  );
  if (record.schema !== IN_BROWSER_ENTRY_SCHEMA) throw invalid(`entry.schema must be ${IN_BROWSER_ENTRY_SCHEMA}`);
  const id = requiredText(record.id, "entry.id", { limit: 64 });
  if (!ENTRY_ID.test(id)) throw invalid("entry.id must be lowercase letters, digits, dots, underscores and dashes, 2 to 64 characters");
  const format = requiredText(record.format, "entry.format", { limit: 16 });
  if (!(FORMATS as readonly string[]).includes(format)) throw invalid(`entry.format must be one of ${FORMATS.join(", ")}`);
  const engine = requiredText(record.engine, "entry.engine", { limit: 16 });
  if (!(ENGINES as readonly string[]).includes(engine)) throw invalid(`entry.engine must be one of ${ENGINES.join(", ")}`);
  if (!Array.isArray(record.files) || record.files.length === 0 || record.files.length > MAX_ENTRY_FILES) throw invalid(`entry.files must list 1 to ${MAX_ENTRY_FILES} files`);
  const files: InBrowserFile[] = record.files.map((item, index) => {
    const file = closedRecord(item, `entry.files[${index}]`, ["name", "url", "bytes", "sha256"], ["name", "url", "bytes", "sha256"]);
    return {
      name: requiredText(file.name, `entry.files[${index}].name`, { limit: 256 }),
      url: httpsUrl(file.url, `entry.files[${index}].url`),
      bytes: positiveCount(file.bytes, `entry.files[${index}].bytes`, { allowNull: false })!,
      sha256: hex64(file.sha256, `entry.files[${index}].sha256`)!,
    };
  });
  const names = new Set(files.map((file) => file.name));
  if (names.size !== files.length) throw invalid("entry.files must not repeat a name");
  const digest = weightsDigest(files.map((file) => file.sha256));
  if (record.weights_digest !== digest) throw invalid("entry.weights_digest does not match the digest its files give");
  const bytesTotal = files.reduce((sum, file) => sum + file.bytes, 0);
  if (record.bytes_total !== bytesTotal) throw invalid("entry.bytes_total does not equal the sum of its files");
  const context = closedRecord(record.context, "entry.context", ["train", "default", "max"], ["train", "default", "max"]);
  const train = positiveCount(context.train, "entry.context.train", { allowNull: false })!;
  const max = positiveCount(context.max, "entry.context.max", { allowNull: false })!;
  const fallback = positiveCount(context.default, "entry.context.default", { allowNull: false })!;
  if (max > train || max > MAX_CONTEXT) throw invalid(`entry.context.max must not exceed the training context or ${MAX_CONTEXT}`);
  if (fallback > max) throw invalid("entry.context.default must not exceed entry.context.max");
  const capabilities = closedRecord(record.capabilities, "entry.capabilities", ["structured_output", "reasoning", "tool_use"], ["structured_output", "reasoning"]);
  const license = closedRecord(record.license, "entry.license", ["id", "name", "url"], ["id", "name", "url"]);
  const source = closedRecord(record.source, "entry.source", ["repository", "revision", "api"], ["repository", "revision"]);
  let header: InBrowserEntry["header"] = null;
  if (record.header !== undefined && record.header !== null) {
    const fields = ["n_layer", "n_kv_heads", "key_length", "value_length"] as const;
    const facts = closedRecord(record.header, "entry.header", [...fields, "width_basis"], [...fields]);
    if (facts.width_basis !== undefined && facts.width_basis !== "embedding") throw invalid("entry.header.width_basis must be \"embedding\" when present");
    header = {
      n_layer: positiveCount(facts.n_layer, "entry.header.n_layer", { allowNull: false })!,
      n_kv_heads: positiveCount(facts.n_kv_heads, "entry.header.n_kv_heads", { allowNull: false })!,
      key_length: positiveCount(facts.key_length, "entry.header.key_length", { allowNull: false })!,
      value_length: positiveCount(facts.value_length, "entry.header.value_length", { allowNull: false })!,
      ...(facts.width_basis === "embedding" ? { width_basis: "embedding" as const } : {}),
    };
  }
  return {
    schema: IN_BROWSER_ENTRY_SCHEMA,
    id,
    display_name: requiredText(record.display_name, "entry.display_name", { limit: 128 }),
    family: requiredText(record.family, "entry.family", { limit: 64 }),
    parameters: positiveCount(record.parameters, "entry.parameters"),
    format: format as InBrowserEntry["format"],
    engine: engine as InBrowserEntry["engine"],
    quantization: requiredText(record.quantization, "entry.quantization", { limit: 32 }),
    files,
    weights_digest: digest,
    bytes_total: bytesTotal,
    context: { train, default: fallback, max },
    capabilities: { structured_output: flag(capabilities.structured_output, "entry.capabilities.structured_output"), reasoning: tristate(capabilities.reasoning, "entry.capabilities.reasoning"), tool_use: tristate(capabilities.tool_use, "entry.capabilities.tool_use") },
    license: { id: requiredText(license.id, "entry.license.id", { limit: 64 }), name: requiredText(license.name, "entry.license.name", { limit: 128 }), url: httpsUrl(license.url, "entry.license.url") },
    source: { repository: requiredText(source.repository, "entry.source.repository", { limit: 256 }), revision: requiredText(source.revision, "entry.source.revision", { limit: 128 }), api: source.api === undefined || source.api === null ? null : httpsUrl(source.api, "entry.source.api") },
    curated: flag(record.curated, "entry.curated"),
    header,
    notes: text(record.notes, "entry.notes", { allowNull: true }),
  };
}

/** What the shell knows about an entry on this machine, each fact read before the descriptor is built. */
export interface InBrowserEntryState {
  /** Every file present in the cache. */
  cached: boolean;
  /** Every cached file's digest matched when last verified (false after a mismatch or a size change). */
  verified: boolean;
  /** Loaded in the engine now. */
  loaded: boolean;
  /** The context the person chose for this entry, or null for the entry's default. */
  chosen_context: number | null;
  /** The machine's GPU memory budget (D-443) with its basis; the descriptor estimates the need itself, at the context it reports. */
  budget: { bytes: number; basis: "declared" | "platform" | "assumed" };
  /** Measured on this machine after a load, or null; a load that ran at `context` or more outranks the estimate (D-441). */
  measured: { prefill_tok_per_s: number; decode_tok_per_s: number; context: number } | null;
  /** The context of a load whose engine Worker died (D-441), or null; that context and larger are refused until the person clears it. */
  failed_context?: number | null;
  /** Whether this browser can run the engine at all (WebGPU in the execution host), with the reason when not; absent means not known to be missing. */
  engine?: { available: boolean; reason: string } | null;
}

export interface InBrowserOverride {
  context_tokens?: number | null;
  max_output_tokens?: number | null;
  reasoning?: boolean | null;
}

export function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * The descriptor of one entry for the host catalog (D-445): available and selectable when the
 * weights are cached, verified and fit; otherwise the reason. "Fit" is computed here, at the very
 * context the descriptor reports: a load measured on this machine at that context or more, else the
 * estimate within the budget. An unknown estimate (no header read yet) is not a fit (D-441). `structured_output` is derived (the
 * grammar plus the router's validation), `reasoning` is declared by the entry or the person,
 * `context_tokens` is the chosen context (declared), and the route is local, private and free.
 */
export function inBrowserDescriptor(entry: InBrowserEntry, state: InBrowserEntryState, override: InBrowserOverride = {}): Record<string, unknown> {
  const stated = positiveCount(override.context_tokens, "override.context_tokens");
  const chosen = stated ?? state.chosen_context ?? entry.context.default;
  const context = Math.min(chosen, entry.context.max);
  const reasons: string[] = [];
  if (!state.cached) reasons.push(`not downloaded (${gb(entry.bytes_total)})`);
  else if (!state.verified) reasons.push("a cached file does not match the digest the catalog states: delete it and download again");
  const at = `a ${context.toLocaleString("en-US")}-token context`;
  // A load that died at this context or less (the engine Worker killed, D-441) is never retried by itself.
  const failed = state.failed_context ?? null;
  if (failed !== null && failed <= context) reasons.push(`failed to run at a ${failed.toLocaleString("en-US")}-token context on this machine; try a smaller context or model`);
  if (state.engine !== undefined && state.engine !== null && !state.engine.available) reasons.push(state.engine.reason);
  const ran = state.measured !== null && state.measured.context >= context;
  const estimate = gpuMemoryEstimate(entry, context);
  if (!ran) {
    if (estimate === null) {
      // Before a download the header cannot be read; "not downloaded" already says what to do.
      if (state.cached) reasons.push("GPU memory unknown: the model's header has not been read");
    } else if (estimate > state.budget.bytes) {
      reasons.push(`needs about ${gb(estimate)} of GPU memory at ${at}${entry.header?.width_basis === "embedding" ? " (estimated from the embedding width)" : ""}; this machine's budget is ${gb(state.budget.bytes)} (${state.budget.basis})`);
    }
  }
  const available = reasons.length === 0;
  const reasoning: Omit<CapabilityAnswer, "name"> =
    typeof override.reasoning === "boolean"
      ? { value: override.reasoning, basis: "declared", detail: "Stated in Settings → Models for this model." }
      : entry.capabilities.reasoning === null
        ? { value: null, basis: "absent", detail: "The catalog entry states no reasoning capability; state it in Settings → Models if known." }
        : { value: entry.capabilities.reasoning, basis: "declared", detail: `The ${entry.curated ? "curated" : "pasted"} catalog entry states it for the ${entry.family} family.` };
  const tags = ["local", IN_BROWSER_PROVIDER, entry.format, entry.curated ? "curated" : "uncurated"];
  if (stated !== null) tags.push("limits:settings");
  if (context < entry.context.train) tags.push("context:capped");
  if (state.loaded) tags.push("loaded");
  return {
    id: inBrowserHostModelId(entry.id),
    provider_id: IN_BROWSER_PROVIDER,
    model_id: entry.id,
    display_name: entry.display_name,
    available,
    availability_reason: available ? null : reasons.join("; "),
    selectable: available,
    capabilities: {
      structured_output: {
        value: entry.capabilities.structured_output,
        basis: "derived",
        detail: "The engine constrains the answer with a grammar derived from the schema and the router validates it against the schema, failing closed. This is the runtime's guarantee, not a provider declaration.",
      },
      reasoning,
      ...(entry.capabilities.tool_use === null ? {} : { tool_use: { value: entry.capabilities.tool_use, basis: "declared", detail: "Stated by the catalog entry." } }),
    },
    limits: { context_tokens: context, native_context_window: entry.context.train, max_output_tokens: positiveCount(override.max_output_tokens, "override.max_output_tokens") },
    properties: { local: true, privacy_class: "local", cost_class: "free", status: state.loaded ? "loaded" : state.cached ? (state.verified ? "cached" : "unverified") : "not_downloaded", tags },
  };
}

/** Whether a host model id names the in-browser route. */
export function isInBrowserHostModelId(hostModelId: unknown): boolean {
  return typeof hostModelId === "string" && hostModelId.startsWith(`${IN_BROWSER_PROVIDER}/`);
}

// -- the machine and its budget (D-443, D-454) -------------------------------------------------

/** What the shell measured or was told about this machine; every fact carries its basis by construction. */
export interface MachineFacts {
  /** The WebGPU adapter as the engine Worker saw it (measured), or null when there is none. */
  gpu: { vendor: string | null; architecture: string | null; is_fallback: boolean | null; features: string[]; max_buffer_size: number | null } | null;
  /** `navigator.deviceMemory` in GiB (a hint: web pages are capped at 8; the extension reported 32 on a 36 GB machine). */
  device_memory_gb: number | null;
  /** `navigator.storage.estimate()` (measured). */
  storage: { quota: number | null; usage: number | null } | null;
  /** The kernel benchmark's class (D-455), or null before it ran. */
  kernel_class: KernelClass | null;
  /** The person's statement of GPU memory in Settings, in bytes (declared), or null. */
  declared_gpu_bytes: number | null;
}

export type KernelClass = "fast" | "medium" | "slow";
export type BudgetBasis = InBrowserEntryState["budget"]["basis"];

/** The budget off Apple Silicon until the person states more (an 8 GB discrete card, an integrated GPU; design §6). */
export const ASSUMED_BUDGET_BYTES = 6e9;
/** Apple Silicon: the Metal working set is about two thirds to three quarters of RAM [S]; at least 8 GiB is assumed. */
export const APPLE_BUDGET_FRACTION = 0.65;
export const APPLE_MIN_MEMORY_GB = 8;
const GIB = 1024 ** 3;

/** The machine's GPU-memory budget with its basis (D-443): the person's statement, else by platform, else 6 GB assumed. */
export function gpuBudget(machine: Pick<MachineFacts, "gpu" | "device_memory_gb" | "declared_gpu_bytes">): InBrowserEntryState["budget"] {
  if (machine.declared_gpu_bytes !== null && Number.isFinite(machine.declared_gpu_bytes) && machine.declared_gpu_bytes > 0) return { bytes: Math.floor(machine.declared_gpu_bytes), basis: "declared" };
  const vendor = (machine.gpu?.vendor ?? "").toLowerCase();
  if (vendor === "apple") {
    const hint = machine.device_memory_gb !== null && Number.isFinite(machine.device_memory_gb) && machine.device_memory_gb > 0 ? machine.device_memory_gb : 0;
    return { bytes: Math.floor(APPLE_BUDGET_FRACTION * Math.max(hint, APPLE_MIN_MEMORY_GB) * GIB), basis: "platform" };
  }
  return { bytes: ASSUMED_BUDGET_BYTES, basis: "assumed" };
}

/** The words beside every verdict: "budget 6.0 GB, assumed; state your GPU memory in Settings to change it". */
export function budgetWords(budget: InBrowserEntryState["budget"]): string {
  const how = budget.basis === "declared" ? "stated by you" : budget.basis === "platform" ? "from this platform's memory" : "assumed";
  return `budget ${gb(budget.bytes)}, ${how}${budget.basis === "declared" ? "" : "; state your GPU memory in Settings → Models to change it"}`;
}

// -- recommendations (D-443) --------------------------------------------------------------------

export const RECOMMEND_FRACTION = 0.8;
export const MIN_RECOMMENDED_CONTEXT = 4096;
/** Storage left free after a download, at least. */
export const STORAGE_MARGIN_BYTES = 1e9;
/** Below this measured decode speed an entry is only "possible". */
export const MIN_DECODE_TOK_PER_S = 8;

export type RecommendationBin = "too_large" | "not_suitable" | "possible" | "recommended";
export const BIN_ORDER: readonly RecommendationBin[] = Object.freeze(["recommended", "possible", "not_suitable", "too_large"]);

export interface Recommendation {
  entry: string;
  bin: RecommendationBin;
  /** The largest context from `context.default`, halving down to 4,096, at which the estimate fits `0.8 × budget`; null when none does. */
  context: number | null;
  /** The estimate at `context` (or at 4,096 when none fits), or null when the header is unknown. */
  estimate_bytes: number | null;
  /** True for an entry with no header yet: binned on `bytes_total × 1.15 + 512 MB` alone ("estimate after download"). */
  estimate_after_download: boolean;
  /** Every reason that applies, the bin's first. */
  reasons: string[];
  cached: boolean;
}

/** The package's evaluation of a descriptor, when a package is open (`compatibility.ts::evaluateModel` through the shell). */
export type PackageEvaluation = (descriptor: Record<string, unknown>) => { status: "compatible" | "unverified" | "incompatible"; violated: Array<{ id: string; host_value: unknown; value: unknown; kind: string; subject: string }> };

export interface RecommendInput {
  entries: readonly InBrowserEntry[];
  /** The cache's and the machine's facts per entry id (absent: not downloaded, never measured). */
  states: ReadonlyMap<string, Pick<InBrowserEntryState, "cached" | "verified" | "measured">>;
  machine: MachineFacts;
  /** Null with no package open: the "not suitable" step is skipped. */
  evaluate: PackageEvaluation | null;
}

function fitAt(entry: InBrowserEntry, limit: number): { context: number | null; estimate: number | null; afterDownload: boolean } {
  if (entry.header === null) {
    const estimate = Math.ceil(entry.bytes_total * (1 + WEIGHTS_OVERHEAD_FRACTION) + FIXED_OVERHEAD_BYTES);
    return { context: estimate <= limit ? entry.context.default : null, estimate, afterDownload: true };
  }
  let context = entry.context.default;
  for (;;) {
    const estimate = gpuMemoryEstimate(entry, context)!;
    if (estimate <= limit) return { context, estimate, afterDownload: false };
    if (context <= MIN_RECOMMENDED_CONTEXT) return { context: null, estimate, afterDownload: false };
    context = Math.max(MIN_RECOMMENDED_CONTEXT, Math.floor(context / 2));
  }
}

/** One violated check in its own words (design §6): what the package needs against what this entry gives here. */
function violatedWords(check: { id: string; host_value: unknown; value: unknown; kind: string; subject: string }, context: number): string {
  if (check.kind === "context_tokens") return `the package needs a ${Number(check.value).toLocaleString("en-US")}-token context; on this machine the model fits only at ${context.toLocaleString("en-US")}`;
  if (check.kind === "capability") return `the package requires \`${check.subject}\`; this entry states ${check.host_value === null ? "nothing" : String(check.host_value)}`;
  return `the package requires ${check.subject}; this entry states ${check.host_value === null ? "nothing" : String(check.host_value)}`;
}

/**
 * Rank every entry into four bins with reasons (D-443, design §6). Tried in order, the first that
 * applies wins, every applicable reason kept: **too large** (no context fits `0.8 × budget`, or the
 * files do not fit the free storage less 1 GB), **not suitable** (fits, but the open package's
 * requirements evaluate `incompatible` at that context), **possible** (fits; and `unverified`, or no
 * measured speed with a slow or unknown kernel class, or a measured decode under 8 tok/s),
 * **recommended** (fits, `compatible`, and fast enough by measurement or by kernel class).
 * Cached entries rank first within a bin, then smaller ones. Nothing downloads by itself.
 */
export function recommendInBrowser(input: RecommendInput): Recommendation[] {
  const budget = gpuBudget(input.machine);
  const limit = RECOMMEND_FRACTION * budget.bytes;
  const quota = input.machine.storage?.quota ?? null;
  const free = quota === null ? null : quota - (input.machine.storage?.usage ?? 0);
  const out: Recommendation[] = [];
  for (const entry of input.entries) {
    const state = input.states.get(entry.id) ?? { cached: false, verified: false, measured: null };
    const fit = fitAt(entry, limit);
    const reasons: string[] = [];
    let bin: RecommendationBin | null = null;
    const where = budgetWords(budget);
    if (fit.context === null) {
      bin = "too_large";
      reasons.push(fit.afterDownload ? `needs about ${gb(fit.estimate!)} of GPU memory (estimate after download); ${Math.round(RECOMMEND_FRACTION * 100)} % of the ${where}` : `needs about ${gb(fit.estimate!)} of GPU memory even at a ${MIN_RECOMMENDED_CONTEXT.toLocaleString("en-US")}-token context; ${Math.round(RECOMMEND_FRACTION * 100)} % of the ${where}`);
    }
    if (!state.cached && free !== null && entry.bytes_total > free - STORAGE_MARGIN_BYTES) {
      bin ??= "too_large";
      reasons.push(`the files take ${gb(entry.bytes_total)}; this browser has about ${gb(Math.max(0, free))} of storage free and keeps 1 GB spare`);
    }
    let status: "compatible" | "unverified" | "incompatible" = "compatible";
    if (fit.context !== null && input.evaluate !== null) {
      const descriptor = inBrowserDescriptor(entry, { cached: true, verified: true, loaded: false, chosen_context: fit.context, budget, measured: null });
      const evaluation = input.evaluate(descriptor);
      status = evaluation.status;
      if (status === "incompatible") {
        bin ??= "not_suitable";
        reasons.push(...evaluation.violated.map((check) => violatedWords(check, fit.context!)));
      } else if (status === "unverified") reasons.push("the package's requirements cannot all be confirmed for this entry");
    }
    const decode = state.measured?.decode_tok_per_s ?? null;
    const fastEnough = decode !== null ? decode >= MIN_DECODE_TOK_PER_S : input.machine.kernel_class === "fast" || input.machine.kernel_class === "medium";
    if (decode !== null) reasons.push(`measured ${decode.toFixed(1)} tok/s decode on this machine`);
    else reasons.push(input.machine.kernel_class === null ? "speed unknown until the GPU benchmark runs or the model is loaded once" : `this GPU's benchmark class is ${input.machine.kernel_class}`);
    if (bin === null) bin = status === "unverified" || !fastEnough ? "possible" : "recommended";
    if (fit.context !== null) reasons.unshift(`fits at a ${fit.context.toLocaleString("en-US")}-token context: about ${gb(fit.estimate!)} of the ${where}${fit.afterDownload ? " (estimate after download)" : ""}`);
    out.push({ entry: entry.id, bin, context: fit.context, estimate_bytes: fit.estimate, estimate_after_download: fit.afterDownload, reasons, cached: state.cached });
  }
  const sizes = new Map(input.entries.map((entry) => [entry.id, entry.bytes_total]));
  return out.sort((a, b) => BIN_ORDER.indexOf(a.bin) - BIN_ORDER.indexOf(b.bin) || Number(b.cached) - Number(a.cached) || sizes.get(a.entry)! - sizes.get(b.entry)! || (a.entry < b.entry ? -1 : 1));
}

/** The default suggestion (design §6, §8): the smallest recommended curated entry, cached ones first. */
export function defaultSuggestion(recommendations: readonly Recommendation[], entries: readonly InBrowserEntry[]): Recommendation | null {
  const curated = new Set(entries.filter((entry) => entry.curated).map((entry) => entry.id));
  return recommendations.find((item) => item.bin === "recommended" && curated.has(item.entry)) ?? null;
}

// -- the signed curated list (D-442, D-453) ------------------------------------------------------

export const MODEL_CATALOG_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
export const MAX_CATALOG_ENTRIES = 64;

export interface ModelCatalog {
  catalog_id: string;
  version: string;
  title: string;
  issued_at: string;
  expires_at: string | null;
  entries: InBrowserEntry[];
}

/**
 * The content of a verified `model-catalog` document (the envelope's signature and shape are
 * `signed-document.ts`'s): every entry validated whole, curated, with a unique id. A list widens
 * nothing: an entry names weights by hash and a licence, and the person still clicks the download.
 */
export function readModelCatalog(content: unknown): ModelCatalog {
  const record = closedRecord(content, "catalog", ["catalog_id", "version", "title", "issued_at", "expires_at", "entries"], ["catalog_id", "version", "title", "issued_at", "entries"]);
  const catalogId = requiredText(record.catalog_id, "catalog.catalog_id", { limit: 128 });
  if (!MODEL_CATALOG_ID.test(catalogId)) throw invalid("catalog.catalog_id is not an identifier");
  const version = requiredText(record.version, "catalog.version", { limit: 32 });
  if (!/^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,2}$/u.test(version)) throw invalid("catalog.version must be a release number such as 1.0.0");
  const issued = requiredText(record.issued_at, "catalog.issued_at", { limit: 40 });
  const expires = record.expires_at === undefined || record.expires_at === null ? null : requiredText(record.expires_at, "catalog.expires_at", { limit: 40 });
  for (const [field, value] of [["issued_at", issued], ["expires_at", expires]] as const) if (value !== null && Number.isNaN(Date.parse(value))) throw invalid(`catalog.${field} is not a timestamp`);
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > MAX_CATALOG_ENTRIES) throw invalid(`catalog.entries must list 1 to ${MAX_CATALOG_ENTRIES} entries`);
  const entries = record.entries.map((raw, index) => {
    let entry: InBrowserEntry;
    try {
      entry = normalizeInBrowserEntry(raw);
    } catch (error) {
      throw invalid(`catalog.entries[${index}]: ${error instanceof Error ? error.message : "invalid"}`);
    }
    if (!entry.curated) throw invalid(`catalog.entries[${index}] is not marked curated`);
    return entry;
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw invalid("catalog.entries must not repeat an id");
  return { catalog_id: catalogId, version, title: requiredText(record.title, "catalog.title", { limit: 120 }), issued_at: issued, expires_at: expires, entries };
}

// -- where weights may come from (D-442, D-452) ---------------------------------------------------

/**
 * The hosts an entry's files may name in v1: the Hugging Face repository host only (D-442; a
 * second host is a new declared destination, B-272). A redirect to the repository's content host
 * is followed by `fetch` and needs no check of its own: the digest binds the bytes.
 */
export const MODEL_FILE_HOSTS: readonly string[] = Object.freeze(["huggingface.co"]);

/**
 * Check one file URL before any fetch (T40 review 1, nit 11), through the package URL gate the
 * extension applies to every HTTPS destination it names (`policy.ts::validatePackageUrl`: https,
 * port 443, no credentials, no fragment, no IP literal, no local name, both parsers agreeing),
 * then the host: it must be one this route declares. Throws `url_rejected` with the reason.
 */
export function checkModelFileUrl(url: string): string {
  const { hostname } = validatePackageUrl(url, "Model file");
  const host = hostname.replace(/\.$/u, "").toLowerCase();
  if (!MODEL_FILE_HOSTS.includes(host)) throw new CoreError("url_rejected", `Model file URLs must be on ${MODEL_FILE_HOSTS.join(", ")}; this one names ${host}`, { status: 403 });
  return new URL(url).href;
}
