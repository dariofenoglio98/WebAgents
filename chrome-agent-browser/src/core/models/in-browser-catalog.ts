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
import { closedRecord, flag, hex64, invalid, positiveCount, requiredText, text, tristate } from "../fields.js";
import { sha256HexSync } from "../hash.js";
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
 * The GPU memory an entry needs at a context (D-441): the weights, the f16 KV cache
 * (`n_layer × context × n_kv_heads × (key_length + value_length) × 2 bytes`, every layer at the
 * full context, which overstates sliding-window models: the safe side), 15 % of the weights and
 * 512 MiB. Null when the header has not been read: an unknown need is never a fit.
 */
export const KV_BYTES_PER_VALUE = 2;
export const WEIGHTS_OVERHEAD_FRACTION = 0.15;
export const FIXED_OVERHEAD_BYTES = 512 * 1024 * 1024;

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
    const facts = closedRecord(record.header, "entry.header", [...fields], [...fields]);
    header = {
      n_layer: positiveCount(facts.n_layer, "entry.header.n_layer", { allowNull: false })!,
      n_kv_heads: positiveCount(facts.n_kv_heads, "entry.header.n_kv_heads", { allowNull: false })!,
      key_length: positiveCount(facts.key_length, "entry.header.key_length", { allowNull: false })!,
      value_length: positiveCount(facts.value_length, "entry.header.value_length", { allowNull: false })!,
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
}

export interface InBrowserOverride {
  context_tokens?: number | null;
  max_output_tokens?: number | null;
  reasoning?: boolean | null;
}

function gb(bytes: number): string {
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
  const chosen = positiveCount(override.context_tokens, "override.context_tokens") ?? state.chosen_context ?? entry.context.default;
  const context = Math.min(chosen, entry.context.max);
  const reasons: string[] = [];
  if (!state.cached) reasons.push(`not downloaded (${gb(entry.bytes_total)})`);
  else if (!state.verified) reasons.push("a cached file does not match the digest the catalog states: delete it and download again");
  const at = `a ${context.toLocaleString("en-US")}-token context`;
  const ran = state.measured !== null && state.measured.context >= context;
  const estimate = gpuMemoryEstimate(entry, context);
  if (!ran) {
    if (estimate === null) {
      // Before a download the header cannot be read; "not downloaded" already says what to do.
      if (state.cached) reasons.push("GPU memory unknown: the model's header has not been read");
    } else if (estimate > state.budget.bytes) {
      reasons.push(`needs about ${gb(estimate)} of GPU memory at ${at}; this machine's budget is ${gb(state.budget.bytes)} (${state.budget.basis})`);
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
  if (positiveCount(override.context_tokens, "override.context_tokens")) tags.push("limits:settings");
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
