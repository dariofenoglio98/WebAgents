/**
 * The host model catalog without calling a model (D-023, D-055): which models this browser
 * can route to, projected into the provider-neutral descriptors `compatibility.ts` evaluates.
 *
 * Five routes: a model the extension runs itself in the browser (T41, D-440), local Ollama,
 * OpenAI and Anthropic with the person's own keys, and Chrome's built-in model through the
 * Prompt API. The core never performs a request itself: every
 * probe goes through an injected `Http`, which the shell implements with `fetch` and to which
 * the shell alone adds the credential header for a provider. Keys never enter this module.
 *
 * An Ollama connection is loopback only (`isLoopbackBase`): its models are described as local,
 * private and free, which a remote endpoint would make false.
 *
 * What the catalog says about limits, and how strongly (`compatibility.ts` bases):
 * - **Ollama** reports each model's native context window (`/api/show`, `model_info`). The
 *   context this host will actually request is the person's cap for the model (Settings → Models
 *   → per-model override, `declared`) or the default cap of 32,768 tokens, the same cap the
 *   reference host applies to discovered local models (STATE.md §5), so the recorded fact that
 *   a 65,536-token Literature Review run needs an explicit entry reproduces here.
 * - **OpenAI and Anthropic** list models but not their windows. A person's override is
 *   `declared`; a documented figure from `KNOWN_LIMITS` is `host_default` and names its source;
 *   otherwise the limit is absent and the model evaluates as `unverified`, which is the honest
 *   answer rather than a guess.
 * - **Structured output** is `derived` for every route: the adapter (T4) requests a constrained
 *   response and validates the answer against the schema, failing closed, so the capability
 *   is the adapter's guarantee rather than a provider declaration.
 */
import { CATALOG_SCHEMA, normalizeCatalog, type CapabilityAnswer, type CatalogNote, type HostCatalog } from "../compatibility.js";
import { thrownName } from "../errors.js";
import { isRecord } from "../fields.js";
import { inBrowserDescriptor, type InBrowserEntry, type InBrowserEntryState } from "./in-browser-catalog.js";

export type ProviderId = "in-browser" | "ollama" | "openai" | "anthropic" | "chrome-builtin";
/** The routes in the order the picker shows them when each is available (D-446). */
export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze(["in-browser", "ollama", "openai", "anthropic", "chrome-builtin"]);
/** The routes that run inside this browser: no endpoint, no key, no origin to grant. */
export type BrowserProviderId = "in-browser" | "chrome-builtin";
export type EndpointProviderId = Exclude<ProviderId, BrowserProviderId>;
export function hasEndpoint(provider: ProviderId | string): provider is EndpointProviderId {
  return provider === "ollama" || provider === "openai" || provider === "anthropic";
}

export const DEFAULT_BASE_URLS: Readonly<Record<EndpointProviderId, string>> = Object.freeze({
  ollama: "http://127.0.0.1:11434",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
});

/** The hosts an Ollama connection may name: this machine only, so "local" and "free" stay true. */
export const OLLAMA_LOOPBACK_HOSTS: readonly string[] = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a base URL reaches Ollama on this machine (HTTP or HTTPS on a loopback host). Every
 * Ollama model is described as local, private and free, which is only true on loopback, so a
 * remote endpoint is refused rather than reclassified (review 1 of T3, finding 2).
 */
export function isLoopbackBase(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && OLLAMA_LOOPBACK_HOSTS.includes(parsed.hostname);
}

/** The reference host's cap on discovered local models (STATE.md §5), applied unless the person raises it. */
export const DEFAULT_OLLAMA_CONTEXT_CAP = 32_768;
export const MAX_PROBED_MODELS = 64;
export const MAX_OLLAMA_SHOW = 32;

export interface ModelOverride {
  context_tokens?: number | null;
  max_output_tokens?: number | null;
  reasoning?: boolean | null;
}

export interface ProviderConnection {
  provider: ProviderId;
  enabled: boolean;
  /** Null means the provider's default. */
  base_url: string | null;
  /** Whether the shell holds a key for this provider; the key itself never enters the core. */
  key_configured: boolean;
  /** Per-model facts the person stated in Settings → Models, recorded as `declared`. */
  overrides: Record<string, ModelOverride>;
}

export interface HttpRequest {
  provider: ProviderId;
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** The shell's transport: adds the provider's credential header, performs the request, parses JSON. */
export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export interface BuiltinAvailability {
  /** `LanguageModel.availability()` as the shell read it, or `unsupported` when the API is absent. */
  availability: "available" | "downloadable" | "downloading" | "unavailable" | "unsupported";
  /** A session's `inputQuota`, when the shell measured one; null otherwise. */
  input_quota: number | null;
}

export interface ProbeResult {
  provider: ProviderId;
  ok: boolean;
  models: unknown[];
  notes: CatalogNote[];
  error: string | null;
}

/** Documented limits for well-known hosted models, each with the source it was read from. */
export interface KnownLimit {
  pattern: RegExp;
  context_tokens: number;
  max_output_tokens: number | null;
  source: string;
}

export const KNOWN_LIMITS: readonly KnownLimit[] = Object.freeze([
  {
    pattern: /^gpt-5\.6-luna$/u,
    context_tokens: 272_000,
    max_output_tokens: null,
    source: "the host catalog row recorded for this model in docs/model-selection-and-run-plan.md §2",
  },
  {
    pattern: /^gpt-6-astra$/u,
    context_tokens: 272_000,
    max_output_tokens: null,
    source: "the host catalog listing recorded for this model in docs/model-selection-report.md (OpenClaw 2026.9.5, ctx 272,000)",
  },
  { pattern: /^claude-/u, context_tokens: 200_000, max_output_tokens: null, source: "Anthropic's model documentation: a 200,000-token context window for current Claude models" },
]);

const absent = (detail: string): CapabilityAnswer => ({ name: "", value: null, basis: "absent", detail });
const derivedStructuredOutput = (): Omit<CapabilityAnswer, "name"> => ({
  value: true,
  basis: "derived",
  detail: "The adapter requests a constrained response and validates every answer against the schema, failing closed. This is the adapter's guarantee, not a provider declaration.",
});

function capability(answer: Omit<CapabilityAnswer, "name">): Omit<CapabilityAnswer, "name"> {
  return { value: answer.value, basis: answer.basis, detail: answer.detail };
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function base(connection: ProviderConnection): string {
  const configured = connection.base_url?.replace(/\/+$/u, "");
  return configured && configured.length > 0 ? configured : DEFAULT_BASE_URLS[connection.provider as EndpointProviderId];
}

function overrideFor(connection: ProviderConnection, modelId: string): ModelOverride {
  return Object.hasOwn(connection.overrides, modelId) ? connection.overrides[modelId]! : {};
}

function knownLimit(modelId: string): KnownLimit | null {
  return KNOWN_LIMITS.find((entry) => entry.pattern.test(modelId)) ?? null;
}

/** Hosted limits: the person's override (`declared`) first, a documented figure next, else absent. */
function hostedLimits(connection: ProviderConnection, modelId: string): { limits: { context_tokens: number | null; native_context_window: number | null; max_output_tokens: number | null }; tags: string[] } {
  const override = overrideFor(connection, modelId);
  const known = knownLimit(modelId);
  const tags: string[] = [];
  let context: number | null = null;
  if (positiveInt(override.context_tokens)) {
    context = override.context_tokens!;
    tags.push("limits:settings");
  } else if (known) {
    context = known.context_tokens;
    tags.push("limits:documented");
  }
  const maxOutput = positiveInt(override.max_output_tokens) ?? known?.max_output_tokens ?? null;
  return { limits: { context_tokens: context, native_context_window: context, max_output_tokens: maxOutput }, tags };
}

function reasoningAnswer(override: ModelOverride, fallback: Omit<CapabilityAnswer, "name">): Omit<CapabilityAnswer, "name"> {
  if (typeof override.reasoning === "boolean") return { value: override.reasoning, basis: "declared", detail: "Stated in Settings → Models for this model." };
  return fallback;
}

// -- Ollama --------------------------------------------------------------------------------
async function probeOllama(connection: ProviderConnection, http: Http): Promise<ProbeResult> {
  const root = base(connection);
  const notes: CatalogNote[] = [];
  if (!isLoopbackBase(root)) {
    return { provider: "ollama", ok: false, models: [], notes, error: `Ollama is reached on this machine only (${OLLAMA_LOOPBACK_HOSTS.join(", ")}); ${root} is not, so its models would not be local.` };
  }
  let tags: HttpResponse;
  try {
    tags = await http({ provider: "ollama", method: "GET", url: `${root}/api/tags`, headers: {} });
  } catch (error) {
    // Nothing answered, or Chrome refused the answer (an origin Ollama does not allow): either
    // way no model can be reached, and the error names where it was looked for (D-077).
    return { provider: "ollama", ok: false, models: [], notes, error: `Ollama did not answer at ${root} (/api/tags failed: ${thrownName(error)})` };
  }
  if (tags.status !== 200 || !isRecord(tags.body) || !Array.isArray(tags.body.models)) {
    return { provider: "ollama", ok: false, models: [], notes, error: `Ollama answered HTTP ${tags.status} to /api/tags` };
  }
  const names = tags.body.models
    .map((item) => (isRecord(item) && typeof item.name === "string" ? item.name : null))
    .filter((name): name is string => name !== null)
    .slice(0, MAX_PROBED_MODELS);
  const models: unknown[] = [];
  const shown = new Map<string, HttpResponse>();
  // A show that throws or times out is Ollama not answering (stopping, stopped, or refusing this
  // origin), not a model that states nothing: the model is unavailable, never "unverified" (D-077).
  // The probe stops asking at the first such failure, since every later show would wait out the
  // same timeout, and the models it did not ask about are unavailable too. A show that answers,
  // with or without a capability list, is an answer: absent capabilities stay absent, as before.
  let failure: string | null = null;
  for (const name of names.slice(0, MAX_OLLAMA_SHOW)) {
    try {
      shown.set(name, await http({ provider: "ollama", method: "POST", url: `${root}/api/show`, headers: { "content-type": "application/json" }, body: { model: name } }));
    } catch (error) {
      failure = thrownName(error);
      notes.push({ code: "ollama_show_failed", detail: `${name}: /api/show did not answer at ${root} (${failure}); Ollama's models are unavailable until it answers again.` });
      break;
    }
  }
  for (const name of names) {
    let native: number | null = null;
    let capabilities: string[] | null = null;
    const show = shown.get(name);
    if (show && show.status === 200 && isRecord(show.body)) {
      const info = isRecord(show.body.model_info) ? show.body.model_info : {};
      for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && positiveInt(value)) native = value as number;
      }
      if (Array.isArray(show.body.capabilities)) capabilities = show.body.capabilities.filter((item): item is string => typeof item === "string");
    }
    const unavailable = failure !== null && !shown.has(name);
    const override = overrideFor(connection, name);
    const cap = positiveInt(override.context_tokens) ?? DEFAULT_OLLAMA_CONTEXT_CAP;
    const context = native === null ? cap : Math.min(cap, native);
    const modelTags: string[] = ["local"];
    if (positiveInt(override.context_tokens)) modelTags.push("limits:settings");
    if (native !== null && context < native) modelTags.push("context:capped");
    const reasoning: Omit<CapabilityAnswer, "name"> =
      capabilities === null
        ? absent("Ollama reported no capability list for this model; raise or state it in Settings → Models.")
        : { value: capabilities.includes("thinking"), basis: "declared", detail: `Ollama /api/show capabilities: ${capabilities.join(", ") || "none"}.` };
    const toolUse: Omit<CapabilityAnswer, "name"> =
      capabilities === null ? absent("Ollama reported no capability list for this model.") : { value: capabilities.includes("tools"), basis: "declared", detail: `Ollama /api/show capabilities: ${capabilities.join(", ") || "none"}.` };
    models.push({
      id: `ollama/${name}`,
      provider_id: "ollama",
      model_id: name,
      display_name: name,
      available: !unavailable,
      availability_reason: unavailable ? `Ollama stopped answering at ${root} (/api/show failed).` : null,
      selectable: true,
      capabilities: {
        structured_output: capability(derivedStructuredOutput()),
        reasoning: capability(reasoningAnswer(override, reasoning)),
        tool_use: capability(toolUse),
      },
      limits: { context_tokens: context, native_context_window: native, max_output_tokens: positiveInt(override.max_output_tokens) },
      properties: { local: true, privacy_class: "local", cost_class: "free", status: null, tags: modelTags },
    });
  }
  if (models.length === 0) notes.push({ code: "ollama_no_models", detail: "Ollama is reachable but lists no model; pull one (for example `ollama pull qwen3:30b`)." });
  // Not one show answered: Ollama listed its models and then stopped answering.
  if (failure !== null && shown.size === 0) return { provider: "ollama", ok: false, models, notes, error: `Ollama stopped answering at ${root} (/api/show failed: ${failure})` };
  return { provider: "ollama", ok: true, models, notes, error: null };
}

// -- OpenAI --------------------------------------------------------------------------------
const OPENAI_CHAT = /^(?:gpt-|o[0-9]|chatgpt-)/u;
/**
 * The OpenAI families this host states reasoning for by default (D-078): the o-series, GPT-5 and
 * GPT-6 (`gpt-5`, `gpt-5.6-luna`, `gpt-6-astra`; not `gpt-4.1` or `gpt-50`). A family rule is the
 * Chrome host's own `host_default` (D-055); a statement in Settings → Models overrides it either way.
 */
export const OPENAI_REASONING_FAMILIES = /^(?:o[0-9]|gpt-[56](?:[.-]|$))/u;
const OPENAI_NOT_CHAT = /(?:embedding|tts|whisper|dall-e|realtime|audio|transcribe|moderation|image|search-preview|instruct)/u;

async function probeOpenAi(connection: ProviderConnection, http: Http): Promise<ProbeResult> {
  if (!connection.key_configured) return { provider: "openai", ok: false, models: [], notes: [], error: "No OpenAI API key is configured in Settings → Models." };
  const response = await http({ provider: "openai", method: "GET", url: `${base(connection)}/v1/models`, headers: {} });
  if (response.status !== 200 || !isRecord(response.body) || !Array.isArray(response.body.data)) {
    return { provider: "openai", ok: false, models: [], notes: [], error: `OpenAI answered HTTP ${response.status} to /v1/models` };
  }
  const ids = response.body.data
    .map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : null))
    .filter((id): id is string => id !== null && OPENAI_CHAT.test(id) && !OPENAI_NOT_CHAT.test(id))
    .sort()
    .slice(0, MAX_PROBED_MODELS);
  const models = ids.map((id) => {
    const override = overrideFor(connection, id);
    const { limits, tags } = hostedLimits(connection, id);
    const reasoning = reasoningAnswer(
      override,
      OPENAI_REASONING_FAMILIES.test(id)
        ? { value: true, basis: "host_default", detail: "OpenAI documents reasoning for the o-series, GPT-5 and GPT-6 families; stated per family, not per model." }
        : absent("OpenAI's model list states no reasoning capability; state it in Settings → Models if known."),
    );
    return {
      id: `openai/${id}`,
      provider_id: "openai",
      model_id: id,
      display_name: id,
      available: true,
      availability_reason: null,
      selectable: true,
      capabilities: { structured_output: capability(derivedStructuredOutput()), reasoning: capability(reasoning) },
      limits,
      properties: { local: false, privacy_class: "hosted", cost_class: "metered", status: null, tags: ["hosted", ...tags] },
    };
  });
  return { provider: "openai", ok: true, models, notes: [], error: null };
}

// -- Anthropic -----------------------------------------------------------------------------
export const ANTHROPIC_VERSION = "2023-06-01";

async function probeAnthropic(connection: ProviderConnection, http: Http): Promise<ProbeResult> {
  if (!connection.key_configured) return { provider: "anthropic", ok: false, models: [], notes: [], error: "No Anthropic API key is configured in Settings → Models." };
  const response = await http({
    provider: "anthropic",
    method: "GET",
    url: `${base(connection)}/v1/models?limit=100`,
    headers: { "anthropic-version": ANTHROPIC_VERSION, "anthropic-dangerous-direct-browser-access": "true" },
  });
  if (response.status !== 200 || !isRecord(response.body) || !Array.isArray(response.body.data)) {
    return { provider: "anthropic", ok: false, models: [], notes: [], error: `Anthropic answered HTTP ${response.status} to /v1/models` };
  }
  const rows = response.body.data
    .map((item) => (isRecord(item) && typeof item.id === "string" ? { id: item.id, display_name: typeof item.display_name === "string" ? item.display_name : item.id } : null))
    .filter((row): row is { id: string; display_name: string } => row !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_PROBED_MODELS);
  const models = rows.map((row) => {
    const override = overrideFor(connection, row.id);
    const { limits, tags } = hostedLimits(connection, row.id);
    const reasoning = reasoningAnswer(
      override,
      /^claude-(?:3-7|[4-9]|opus-4|sonnet-4|haiku-4|fable|mythos)/u.test(row.id)
        ? { value: true, basis: "host_default", detail: "Anthropic documents extended thinking for Claude 3.7 and later families; stated per family, not per model." }
        : absent("Anthropic's model list states no reasoning capability; state it in Settings → Models if known."),
    );
    return {
      id: `anthropic/${row.id}`,
      provider_id: "anthropic",
      model_id: row.id,
      display_name: row.display_name,
      available: true,
      availability_reason: null,
      selectable: true,
      capabilities: { structured_output: capability(derivedStructuredOutput()), reasoning: capability(reasoning) },
      limits,
      properties: { local: false, privacy_class: "hosted", cost_class: "metered", status: null, tags: ["hosted", ...tags] },
    };
  });
  return { provider: "anthropic", ok: true, models, notes: [], error: null };
}

// -- Chrome built-in -----------------------------------------------------------------------
export const CHROME_BUILTIN_MODEL_ID = "chrome-builtin/gemini-nano";

export function builtinDescriptor(connection: ProviderConnection, builtin: BuiltinAvailability | null): unknown {
  const availability = builtin?.availability ?? "unsupported";
  const available = availability === "available";
  const reasons: Record<string, string> = {
    downloadable: "Chrome can download the built-in model; start the download from Settings → Models.",
    downloading: "Chrome is downloading the built-in model.",
    unavailable: "Chrome reports the built-in model as unavailable on this device (it needs free disk space and a capable GPU or 16 GB of RAM).",
    unsupported: "This Chrome exposes no Prompt API (LanguageModel) to extensions.",
  };
  const override = overrideFor(connection, "gemini-nano");
  const context = positiveInt(override.context_tokens) ?? positiveInt(builtin?.input_quota) ?? null;
  return {
    id: CHROME_BUILTIN_MODEL_ID,
    provider_id: "chrome-builtin",
    model_id: "gemini-nano",
    display_name: "Chrome built-in (Gemini Nano)",
    available,
    availability_reason: available ? null : reasons[availability] ?? availability,
    selectable: available,
    capabilities: {
      structured_output: capability(derivedStructuredOutput()),
      reasoning: capability(reasoningAnswer(override, absent("Chrome's Prompt API states no reasoning capability for the built-in model."))),
    },
    limits: { context_tokens: context, native_context_window: positiveInt(builtin?.input_quota) ?? null, max_output_tokens: positiveInt(override.max_output_tokens) },
    properties: { local: true, privacy_class: "local", cost_class: "free", status: availability, tags: ["local", "chrome-builtin", ...(context && positiveInt(override.context_tokens) ? ["limits:settings"] : [])] },
  };
}

/**
 * The built-in model's probe (D-113): its one descriptor, whatever the availability, so Settings →
 * Models can show its row (and "Make default" once Chrome says `available`), and the probe is `ok`
 * only when the model can be used now. `builtin` is what the shell read from the Prompt API; null
 * means the API did not answer in that context. Never a network request.
 */
export function probeBuiltin(connection: ProviderConnection, builtin: BuiltinAvailability | null): ProbeResult {
  const descriptor = builtinDescriptor(connection, builtin);
  const availability = builtin?.availability ?? null;
  const error = availability === "available" ? null : availability === null ? "The Prompt API is not available in this context." : availability;
  return { provider: "chrome-builtin", ok: availability === "available", models: [descriptor], notes: [], error };
}

// -- in this browser (T41, D-440, D-445) --------------------------------------------------
/**
 * What the shell knows about its in-browser models, each fact read before the probe (design §4):
 * the entries (the verified curated list and the person's pasted repositories), the cache's and
 * the machine's state per entry, and whether this browser can run the engine at all.
 */
export interface InBrowserProbeInput {
  entries: readonly InBrowserEntry[];
  /** Per entry; an entry without one is not downloaded and never measured. */
  states: ReadonlyMap<string, InBrowserEntryState>;
  /** The machine's budget (D-443), for an entry without a state. */
  budget: InBrowserEntryState["budget"];
  /** Notes for the catalog: a list refused and the shipped one used instead, and the like. */
  notes?: readonly CatalogNote[];
}

/**
 * The in-browser route's probe: one descriptor per entry through `inBrowserDescriptor` (T40),
 * which computes the fit itself at the context it reports. No network request: the cache state,
 * the budget and the measured facts are inputs. `ok` when at least one entry can be used now.
 */
export function probeInBrowser(connection: ProviderConnection, input: InBrowserProbeInput | null): ProbeResult {
  if (input === null || input.entries.length === 0) return { provider: "in-browser", ok: false, models: [], notes: [...(input?.notes ?? [])], error: input === null ? "The in-browser engine's state was not read." : "No in-browser model is listed." };
  const models = input.entries.map((entry) => {
    const state = input.states.get(entry.id) ?? null;
    const facts: InBrowserEntryState = state ?? { cached: false, verified: false, loaded: false, chosen_context: null, budget: input.budget, measured: null };
    return inBrowserDescriptor(entry, facts, overrideFor(connection, entry.id));
  });
  const ok = models.some((model) => (model as { available: boolean }).available);
  return { provider: "in-browser", ok, models, notes: [...(input.notes ?? [])], error: ok ? null : "No in-browser model is downloaded, verified and within this machine's GPU memory budget." };
}

// -- the catalog ---------------------------------------------------------------------------
/** One provider's probe; `builtin` is the shell's Prompt API reading, used for `chrome-builtin` only; `inBrowser` the shell's cache and machine facts, for `in-browser` only. */
export async function probeProvider(connection: ProviderConnection, http: Http, builtin: BuiltinAvailability | null = null, inBrowser: InBrowserProbeInput | null = null): Promise<ProbeResult> {
  try {
    switch (connection.provider) {
      case "in-browser":
        return probeInBrowser(connection, inBrowser);
      case "ollama":
        return await probeOllama(connection, http);
      case "openai":
        return await probeOpenAi(connection, http);
      case "anthropic":
        return await probeAnthropic(connection, http);
      case "chrome-builtin":
        return probeBuiltin(connection, builtin);
    }
  } catch (error) {
    return { provider: connection.provider, ok: false, models: [], notes: [], error: `${connection.provider}: ${thrownName(error, "the request failed")}` };
  }
}

export interface CatalogOptions {
  builtin: BuiltinAvailability | null;
  /** The in-browser route's facts (T41); null on a host without the engine. */
  inBrowser?: InBrowserProbeInput | null;
  runtimeVersion: string | null;
  now?: Date;
  /** Answers already in hand, by provider: those providers are not asked again (a single Test connection merged into the last catalog). */
  probed?: ReadonlyMap<ProviderId, ProbeResult>;
}

/** Probe every enabled connection and assemble the host catalog, bound to its content hash. */
export async function buildHostCatalog(connections: readonly ProviderConnection[], http: Http, options: CatalogOptions): Promise<{ catalog: HostCatalog; probes: ProbeResult[] }> {
  const models: unknown[] = [];
  const notes: CatalogNote[] = [];
  const probes: ProbeResult[] = [];
  for (const connection of connections) {
    if (!connection.enabled) continue;
    const result = options.probed?.get(connection.provider) ?? (await probeProvider(connection, http, options.builtin, options.inBrowser ?? null));
    probes.push(result);
    models.push(...result.models);
    notes.push(...result.notes);
    // A model that runs in this browser is described by its own availability reason, not as an unreachable route.
    if (!result.ok && hasEndpoint(connection.provider)) notes.push({ code: `${connection.provider}_unreachable`, detail: result.error });
  }
  if (models.length === 0) notes.push({ code: "no_models_available", detail: "No model route is configured or reachable. Download a model in Settings → Models → In this browser, start Ollama (with OLLAMA_ORIGINS including chrome-extension://*) or enter an API key." });
  const catalog = await normalizeCatalog({
    schema: CATALOG_SCHEMA,
    host: {
      runtime: "chrome-agent-browser",
      runtime_version: options.runtimeVersion,
      source: "chrome-agent-browser model catalog: the in-browser model cache and catalog, Ollama /api/tags + /api/show, OpenAI /v1/models, Anthropic /v1/models, Chrome LanguageModel.availability(); no model was called",
      captured_at: (options.now ?? new Date()).toISOString(),
      agent_id: null,
    },
    models: models.slice(0, 256),
    notes: notes.slice(0, 32),
  });
  return { catalog, probes };
}
