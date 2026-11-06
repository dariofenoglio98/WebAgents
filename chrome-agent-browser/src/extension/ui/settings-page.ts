/**
 * Settings: Models (the routes of D-023, a connection test per provider, keys that are typed
 * here and never shown again, per-model limits, the default model), Policies (the host preset of
 * D-050 and the run limits, B-118), Files (the PDFs runs may read, T6) and Services (the Crossref
 * contact address, T6). A thin view over the worker's `SettingsView` and `FilesView`.
 */
import { isRecord } from "../../core/fields.js";
import type { PresetId } from "../../core/types.js";
import { PRESETS } from "../../core/authorization.js";
import { DEFAULT_BASE_URLS, hasEndpoint, type ProbeResult, type ProviderId } from "../../core/models/catalog.js";
import { DEFAULT_OPENAI_REASONING_EFFORT, OPENAI_REASONING_EFFORTS } from "../../core/models/adapters/openai.js";
import { DEFAULT_HOST_LIMITS, type HostExecutionLimits } from "../../core/execution/limits.js";
import type { FilesView, IndexesView, IndexView, KeychainView, PermissionsView, PolicyView, ProbeView, Request, SecretsView, SettingsView, StatusInfo } from "../messages.js";
import { IDLE_LOCK_MINUTES, MIN_PASSPHRASE_LENGTH } from "../../core/secrets.js";
import type { GrantPurpose } from "../storage/permissions.js";
import { idleWords } from "./unlock.js";
import demoDocuments from "../data/demo-documents.json" with { type: "json" };
import type { Settings, StoredConnection } from "../storage/settings.js";
import { downloadBuiltinModel, languageModelApi } from "../execution/builtin-port.js";
import { button, bytes, card, chip, definition, details, el, list, row } from "./dom.js";

export type SettingsSection = "models" | "policies" | "security" | "memory" | "permissions" | "search" | "files" | "services" | "about";
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["models", "policies", "security", "memory", "permissions", "search", "files", "services", "about"];
const SECTION_TITLES: Record<SettingsSection, string> = { models: "Models", policies: "Policies", security: "Security", memory: "Memory", permissions: "Permissions", search: "Search", files: "Files", services: "Services", about: "About" };

/**
 * The limits the reference host was configured with for Literature Review (STATE.md §4: 180,000
 * tokens, 45 remote calls, 4,500 s per run, 1,200 s per model call); one button sets them, so a
 * long local run is not stopped by the 600 s default (B-118, D-084).
 */
export const LONG_RUN_LIMITS: Readonly<HostExecutionLimits> = Object.freeze({
  total_tokens: 180_000,
  max_remote_calls: 45,
  max_parallel_workers: 3,
  max_output_tokens_per_call: 16_000,
  run_timeout_seconds: 4_500,
  max_calls_per_tool: 32,
  model_call_timeout_seconds: 1_200,
  compute_memory_pages: DEFAULT_HOST_LIMITS.compute_memory_pages,
  compute_wall_seconds: DEFAULT_HOST_LIMITS.compute_wall_seconds,
  compute_fuel: DEFAULT_HOST_LIMITS.compute_fuel,
});

const LIMIT_FIELDS: ReadonlyArray<{ key: keyof HostExecutionLimits; label: string; unit: string }> = [
  { key: "total_tokens", label: "Tokens per run", unit: "tokens" },
  { key: "max_remote_calls", label: "Remote calls per run", unit: "calls" },
  { key: "max_parallel_workers", label: "Parallel workers", unit: "workers" },
  { key: "max_output_tokens_per_call", label: "Output tokens per model call", unit: "tokens" },
  { key: "run_timeout_seconds", label: "Time per run", unit: "seconds" },
  { key: "max_calls_per_tool", label: "Calls per tool", unit: "calls" },
  { key: "model_call_timeout_seconds", label: "Time per model call", unit: "seconds" },
  // compute.v0 (C-35, D-250): the bounds of one WebAssembly call. Fuel is not metered in Chrome, so
  // it has no field: the time per call is the CPU bound here, and the figure stays at its default.
  { key: "compute_memory_pages", label: "Memory per compute call", unit: "64 KiB pages" },
  { key: "compute_wall_seconds", label: "Time per compute call", unit: "seconds" },
];

export interface SettingsPageState {
  section: SettingsSection;
  probes: Partial<Record<ProviderId, ProbeView | ProbeResult | "running">>;
  /** When each shown result was probed (ISO time), so a chip never passes off an old answer as current. */
  checkedAt: Partial<Record<ProviderId, string>>;
  notice: string | null;
  /** The built-in model's download, when one was started from this page: a fraction, or a message. */
  builtinDownload: { fraction: number; done: boolean; error: string | null } | null;
  /** The last command copied, for the confirmation beside it. */
  copied: string | null;
  /** What the person typed into the add-an-index and subscribe forms (T8), kept across re-renders. */
  forms: { indexUrl: string; indexPem: string; policyUrl: string; policyPem: string };
  /** Settings → Security (T16): the typed confirmation of "Forget everything", kept across re-renders; passphrases are never kept. */
  forgetConfirmation: string;
  /** Settings → Memory (T19): the typed confirmation of "Forget memory". */
  forgetMemory?: string;
}

export function newSettingsPageState(section: SettingsSection = "models"): SettingsPageState {
  return { section, probes: {}, checkedAt: {}, notice: null, builtinDownload: null, copied: null, forms: { indexUrl: "", indexPem: "", policyUrl: "", policyPem: "" }, forgetConfirmation: "" };
}

/** `14:02:31` in the person's locale, 24-hour: when a connection was last tested. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/**
 * What a test found, in a few words: a provider that answered but stopped part way (some models
 * not answering) says how many models are usable, so the chip never reads "reachable" over a list
 * that is mostly unavailable (review 1, nit 4).
 */
export function probeSummary(probe: ProbeView | ProbeResult): { text: string; tone: "good" | "warn" | "bad" } {
  if (!probe.ok) return { text: `failed: ${probe.error ?? "unknown"}`, tone: "bad" };
  const total = probe.models.length;
  const usable = probe.models.filter((model) => !(isRecord(model) && model.available === false)).length;
  if (usable < total) return { text: `reachable · ${usable} of ${total} models usable`, tone: "warn" };
  return { text: `reachable · ${total} model${total === 1 ? "" : "s"}`, tone: "good" };
}

/**
 * The Models section opened (again): earlier results go, and every enabled connection is tested
 * afresh, so the chips describe the providers as they are now (D-077). A test already running is
 * left to finish and not started twice; `probe` is the page's single entry point per provider.
 */
export function refreshProbes(view: SettingsView, state: SettingsPageState, probe: (provider: ProviderId) => void): void {
  for (const provider of Object.keys(state.probes) as ProviderId[]) {
    if (state.probes[provider] !== "running") {
      delete state.probes[provider];
      delete state.checkedAt[provider];
    }
  }
  for (const connection of view.settings.models.connections) {
    if (connection.enabled && state.probes[connection.provider] !== "running") probe(connection.provider);
  }
}

export interface SettingsPageActions {
  onSave: (settings: Settings) => void;
  onSetKey: (provider: ProviderId, key: string | null) => void;
  onProbe: (provider: ProviderId) => void;
  /** The Models tab was chosen: clear the results and test the enabled connections again (`refreshProbes`). */
  onOpenModels?: () => void;
  rerender: () => void;
  /** Write text to the clipboard; the page's own `navigator.clipboard` by default. */
  copy?: (text: string) => Promise<void>;
  /** Settings → Files: pick PDFs (the File System Access picker, or a file input), and remove one. */
  onPickFiles?: () => void;
  onRemoveFile?: (fileId: string) => void;
  /** Settings → Search (T8): add, refresh, enable or remove an index. */
  onIndex?: (request: Extract<Request, { type: "indexes.add" | "indexes.refresh" | "indexes.remove" | "indexes.enable" }>) => void;
  /** Settings → Policies (T8): subscribe, refresh or unsubscribe. */
  onPolicy?: (request: Extract<Request, { type: "policy.subscribe" | "policy.refresh" | "policy.unsubscribe" }>) => void;
  /** Settings → Security (T16): the secret store's requests; the passphrase travels once, to the worker. */
  onSecrets?: (request: Extract<Request, { type: "secrets.setup" | "secrets.unlock" | "secrets.lock" | "secrets.changePassphrase" | "secrets.forget" }>) => void;
  /** Settings → Security (T17): turn keychain unlock on (the page asks Chrome for `nativeMessaging` in the click) or off; ask the helper again. */
  onKeychain?: (action: "enable" | "disable" | "refresh") => void;
  /** Settings → Permissions (T16): ask Chrome for every site (the click is the gesture) and tell the worker; revoke origins. */
  onDetectEverywhere?: (enabled: boolean) => void;
  onRevoke?: (origins: string[]) => void;
}

/** What Settings → Search, → Policies, → Security and → Permissions show besides the settings (T8, T16). */
export interface SettingsExtras {
  indexes: IndexesView | null;
  policy: PolicyView | null;
  secrets?: SecretsView | null;
  /** Settings → Security's keychain card (T17); null until the helper was asked. */
  keychain?: KeychainView | null;
  permissions?: PermissionsView | null;
  /** Settings → Memory (T19, design §6), rendered by the page that holds the memory view. */
  memory?: HTMLElement[] | null;
  /** Settings → Models → In this browser (T41), rendered by the page that holds the in-browser view (`in-browser-models.ts`). */
  inBrowser?: HTMLElement[] | null;
}

/** The one-time Ollama setup (B-117): the commands a person copies, per way of running Ollama. */
export const OLLAMA_ORIGIN_COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: "macOS app (Ollama in the menu bar)", command: 'launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"' },
  { label: "Started from a terminal", command: 'OLLAMA_ORIGINS="chrome-extension://*" ollama serve' },
  { label: "Linux service (systemd)", command: 'sudo systemctl edit ollama   # add: Environment="OLLAMA_ORIGINS=chrome-extension://*"' },
];

const PROVIDER_TITLES: Record<ProviderId, string> = {
  "in-browser": "In this browser",
  ollama: "Ollama on this computer",
  openai: "OpenAI (your key)",
  anthropic: "Anthropic (your key)",
  "chrome-builtin": "Chrome built-in (Gemini Nano)",
};

const PROVIDER_HINTS: Record<ProviderId, string> = {
  "in-browser": "Runs inside this extension on your GPU. No network: nothing leaves this browser.",
  ollama: "A separate application: it runs outside the browser's protection, and this browser cannot bound what it does with your data. Runs on this computer; free. Ollama must allow this extension's origin: set OLLAMA_ORIGINS to include chrome-extension://* before starting Ollama. Discovered models are capped at 32,768 tokens of context unless you state a higher limit below.",
  openai: "Direct calls to OpenAI with your own key, through the Responses API with the package's schema and output cap. Metered by OpenAI.",
  anthropic: "Direct calls to Anthropic with your own key, through the Messages API. Metered by Anthropic.",
  "chrome-builtin": "Chrome's own small model through the Prompt API, no setup and no cost; needs free disk space and a capable device. Zero-setup tier.",
};

function connectionCard(view: SettingsView, connection: StoredConnection, state: SettingsPageState, actions: SettingsPageActions, extras: SettingsExtras = { indexes: null, policy: null }): HTMLElement {
  const provider = connection.provider;
  if (provider === "in-browser") {
    // The in-browser route's own card (T41): its list in bins, the download card, the cache (`in-browser-models.ts`).
    const on = el("input", { attrs: { type: "checkbox", name: "enabled-in-browser", "aria-label": `Enable ${PROVIDER_TITLES[provider]}` } });
    on.checked = connection.enabled;
    on.addEventListener("change", () => actions.onSave(withConnection(view.settings, provider, (item) => ({ ...item, enabled: on.checked }))));
    return card(PROVIDER_TITLES[provider], el("label", { className: "ab-field ab-inline" }, on, " ", el("span", { text: "Enabled" })), ...(connection.enabled ? (extras.inBrowser ?? [el("p", { className: "ab-busy", text: "Loading…" })]) : [el("p", { className: "ab-hint", text: PROVIDER_HINTS[provider] })]));
  }
  const probe = state.probes[provider];
  const enabled = el("input", { attrs: { type: "checkbox", name: `enabled-${provider}`, "aria-label": `Enable ${PROVIDER_TITLES[provider]}` } });
  enabled.checked = connection.enabled;
  enabled.addEventListener("change", () => actions.onSave(withConnection(view.settings, provider, (item) => ({ ...item, enabled: enabled.checked }))));
  const children: Array<HTMLElement | null> = [
    el("label", { className: "ab-field ab-inline" }, enabled, " ", el("span", { text: "Enabled" })),
    el("p", { className: "ab-hint", text: PROVIDER_HINTS[provider] }),
  ];
  if (provider === "openai") {
    const effort = el("select", { className: "ab-select", attrs: { name: "openai-reasoning-effort", "aria-label": "Reasoning effort" } });
    for (const choice of OPENAI_REASONING_EFFORTS) effort.append(el("option", { text: `Reasoning effort: ${choice}${choice === DEFAULT_OPENAI_REASONING_EFFORT ? " (default)" : ""}`, attrs: { value: choice } }));
    effort.value = connection.reasoning_effort ?? DEFAULT_OPENAI_REASONING_EFFORT;
    effort.addEventListener("change", () =>
      actions.onSave(
        withConnection(view.settings, provider, (item) => {
          const { reasoning_effort: _previous, ...rest } = item;
          return effort.value === DEFAULT_OPENAI_REASONING_EFFORT ? rest : { ...rest, reasoning_effort: effort.value as StoredConnection["reasoning_effort"] };
        }),
      ),
    );
    children.push(
      el("label", { className: "ab-field" }, effort),
      el("p", { className: "ab-hint", text: "How much a reasoning model thinks before it answers. Medium is the default: on low, models skipped work in multi-step research agents. A run records the effort it used." }),
    );
  }
  if (provider === "ollama") {
    const think = el("input", { attrs: { type: "checkbox", name: "ollama-think", "aria-label": "Let local models think" } });
    think.checked = connection.think === true;
    think.addEventListener("change", () => actions.onSave(withConnection(view.settings, provider, (item) => ({ ...item, think: think.checked }))));
    children.push(
      el("label", { className: "ab-field ab-inline" }, think, " ", el("span", { text: "Let local models think" })),
      el("p", { className: "ab-hint", text: "Sends Ollama's think option, as the reference host did for its accepted local research runs: slower, and needed by reasoning-heavy agents on models such as qwen3:30b. Off by default because Ollama can then write more than a step's output cap, and a run that does is stopped." }),
    );
    // The one-time setup, as copyable commands (B-117): after the command, restart Ollama, then Test connection.
    children.push(
      el("h4", { text: "Allow this extension in Ollama (once)" }),
      list(
        OLLAMA_ORIGIN_COMMANDS.map((entry) =>
          el(
            "div",
            { className: "ab-command" },
            el("span", { className: "ab-hint", text: entry.label }),
            el("code", { className: "ab-command-text", text: entry.command }),
            button(state.copied === entry.command ? "Copied" : "Copy", () => {
              const copy = actions.copy ?? ((text: string) => navigator.clipboard.writeText(text));
              void copy(entry.command).then(() => {
                state.copied = entry.command;
                actions.rerender();
              });
            }),
          ),
        ),
      ),
      el("p", { className: "ab-hint", text: "Then restart Ollama and press Test connection. Ollama must allow this extension's origin because the browser, not a server, calls it." }),
    );
  }
  if (provider === "chrome-builtin") children.push(builtinControls(state, actions));
  if (hasEndpoint(provider)) {
    // The placeholder is the endpoint actually used when the field is empty (user feedback,
    // 2026-10-07): a person who pastes the documented `/v1` form sees it normalized on save.
    const url = el("input", { className: "ab-input", attrs: { name: `base-url-${provider}`, placeholder: `${DEFAULT_BASE_URLS[provider]} (default)`, autocomplete: "off" } });
    url.value = connection.base_url ?? "";
    children.push(el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: "Endpoint " }), url, button("Save", () => actions.onSave(withConnection(view.settings, provider, (item) => ({ ...item, base_url: url.value.trim() || null }))))));
  }
  if (provider === "openai" || provider === "anthropic") {
    const key = el("input", { className: "ab-input", attrs: { name: `key-${provider}`, type: "password", placeholder: view.keys[provider] ? "a key is stored; enter a new one to replace it" : "API key (stored in this browser only, never shown again)", autocomplete: "off" } });
    children.push(
      el(
        "div",
        { className: "ab-field" },
        el("span", { className: "ab-row-label", text: "API key " }),
        chip(view.keys[provider] ? "key stored" : "no key", view.keys[provider] ? "good" : "warn"),
        key,
        button("Save key", () => {
          const value = key.value;
          key.value = "";
          if (value.trim()) actions.onSetKey(provider, value);
        }),
        view.keys[provider] ? button("Remove key", () => actions.onSetKey(provider, null), { variant: "danger" }) : null,
      ),
      el("p", { className: "ab-hint", text: "Keys are encrypted at rest under your passphrase (Settings → Security), never in sync storage, and leave this browser only as the provider's own header, to the provider's origin you allowed. This page shows whether a key is stored, never the key." }),
    );
  }
  const diagnosis = probe && probe !== "running" && "diagnosis" in probe ? probe.diagnosis : null;
  children.push(
    el(
      "div",
      { className: "ab-inline" },
      button(probe === "running" ? "Testing…" : "Test connection", () => actions.onProbe(provider), { disabled: probe === "running" || !connection.enabled }),
      probe && probe !== "running" ? chip(`${probeSummary(probe).text}${state.checkedAt[provider] ? ` · checked ${clockTime(state.checkedAt[provider]!)}` : ""}`, probeSummary(probe).tone) : null,
    ),
    diagnosis ? el("p", { className: `ab-banner ab-banner-${diagnosis.state === "unknown" ? "neutral" : "warn"} ab-diagnosis`, text: diagnosis.hint, attrs: { "data-diagnosis": diagnosis.state, role: "status" } }) : null,
  );
  // A row for every model the provider described, usable or not: an unavailable one says so and offers no "Make default" (D-113).
  if (probe && probe !== "running" && probe.models.length > 0) {
    children.push(el("h4", { text: "Models" }), list(probe.models.map((model) => modelRow(view, connection, model as ProbedModel, actions))));
  }
  for (const [modelId, override] of Object.entries(connection.overrides)) {
    children.push(el("p", { className: "ab-hint", text: `Stated for ${modelId}: ${[override.context_tokens ? `context ${override.context_tokens.toLocaleString()}` : null, override.max_output_tokens ? `output ${override.max_output_tokens.toLocaleString()}` : null, typeof override.reasoning === "boolean" ? `reasoning ${override.reasoning}` : null].filter(Boolean).join(", ") || "nothing"}` }));
  }
  return card(PROVIDER_TITLES[provider], ...children);
}

interface ProbedModel {
  id: string;
  model_id: string;
  display_name: string;
  available: boolean;
  limits: { context_tokens: number | null; native_context_window: number | null; max_output_tokens: number | null };
  properties: { local: boolean | null; tags: string[] };
}

const REASONING_CHOICES: ReadonlyArray<{ value: "" | "yes" | "no"; text: string }> = [
  { value: "", text: "Reasons: as the provider states" },
  { value: "yes", text: "Reasons: yes (stated by you)" },
  { value: "no", text: "Reasons: no (stated by you)" },
];

/**
 * One probed model: make it the default (only when it is available now), or state its limits and
 * whether it reasons, recorded as `declared` (D-055, D-113). Stating reasoning is how a model whose
 * provider says nothing about it (Chrome's built-in model) meets a package that requires it.
 */
function modelRow(view: SettingsView, connection: StoredConnection, model: ProbedModel, actions: SettingsPageActions): HTMLElement {
  const isDefault = view.settings.models.default_model === model.id;
  const stated = connection.overrides[model.model_id]?.reasoning;
  const reasoning = el("select", { className: "ab-select", attrs: { name: `reasoning-${model.id}`, "aria-label": `Whether ${model.display_name} reasons` } });
  for (const choice of REASONING_CHOICES) reasoning.append(el("option", { text: choice.text, attrs: { value: choice.value } }));
  reasoning.value = stated === true ? "yes" : stated === false ? "no" : "";
  reasoning.addEventListener("change", () => {
    const value = reasoning.value === "yes" ? true : reasoning.value === "no" ? false : null;
    actions.onSave(withConnection(view.settings, connection.provider, (item) => ({ ...item, overrides: { ...item.overrides, [model.model_id]: { ...item.overrides[model.model_id], reasoning: value } } })));
  });
  const context = el("input", { className: "ab-input ab-input-short", attrs: { type: "number", min: "1", name: `context-${model.id}`, placeholder: model.limits.native_context_window ? `native ${model.limits.native_context_window}` : "context tokens" } });
  context.value = connection.overrides[model.model_id]?.context_tokens ? String(connection.overrides[model.model_id]!.context_tokens) : "";
  const output = el("input", { className: "ab-input ab-input-short", attrs: { type: "number", min: "1", name: `output-${model.id}`, placeholder: "max output tokens" } });
  output.value = connection.overrides[model.model_id]?.max_output_tokens ? String(connection.overrides[model.model_id]!.max_output_tokens) : "";
  return el(
    "div",
    { className: "ab-model-row", attrs: { "data-model": model.id } },
    el("div", { className: "ab-model-head" }, el("strong", { text: model.display_name }), el("code", { className: "ab-model-id", text: model.id }), isDefault ? chip("default", "good") : null, model.available ? null : chip("not available", "bad"), model.properties.local === true ? chip("local") : chip("hosted", "warn")),
    el("p", { className: "ab-hint", text: `Context ${model.limits.context_tokens?.toLocaleString() ?? "not reported"}${model.limits.native_context_window && model.limits.native_context_window !== model.limits.context_tokens ? ` (native ${model.limits.native_context_window.toLocaleString()})` : ""} · output ${model.limits.max_output_tokens?.toLocaleString() ?? "not reported"}` }),
    el(
      "div",
      { className: "ab-inline" },
      isDefault || !model.available ? null : button("Make default", () => actions.onSave({ ...view.settings, models: { ...view.settings.models, default_model: model.id } }), { variant: "primary" }),
      context,
      output,
      button("State limits", () => {
        const contextTokens = Number.parseInt(context.value, 10);
        const maxOutput = Number.parseInt(output.value, 10);
        actions.onSave(
          withConnection(view.settings, connection.provider, (item) => ({
            ...item,
            overrides: {
              ...item.overrides,
              [model.model_id]: { ...item.overrides[model.model_id], context_tokens: Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : null, max_output_tokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : null },
            },
          })),
        );
      }),
    ),
    el("div", { className: "ab-inline" }, reasoning),
    el("p", { className: "ab-hint", text: "What you state here (limits, and whether the model reasons) is recorded as declared by you in every run plan that binds this model." }),
  );
}

/** The built-in model's state and, when Chrome can download it, the download (D-023, D-072). */
function builtinControls(state: SettingsPageState, actions: SettingsPageActions): HTMLElement {
  const api = languageModelApi();
  const probe = state.probes["chrome-builtin"];
  const availability = probe && probe !== "running" ? (probe.ok ? "available" : (probe.error ?? "unknown")) : null;
  const download = state.builtinDownload;
  return el(
    "div",
    { className: "ab-builtin" },
    row("Prompt API", api ? chip("exposed to this page", "good") : chip("not exposed in this Chrome", "warn")),
    availability ? row("Model", chip(availability, availability === "available" ? "good" : availability === "downloadable" || availability === "downloading" ? "warn" : "bad")) : null,
    api && (availability === "downloadable" || availability === "downloading" || download)
      ? el(
          "div",
          { className: "ab-inline" },
          button(download && !download.done && !download.error ? `Downloading… ${Math.round(download.fraction * 100)}%` : "Download the built-in model", () => {
            state.builtinDownload = { fraction: 0, done: false, error: null };
            actions.rerender();
            void downloadBuiltinModel(api, (fraction) => {
              state.builtinDownload = { fraction, done: false, error: null };
              actions.rerender();
            }).then(
              () => {
                state.builtinDownload = { fraction: 1, done: true, error: null };
                actions.rerender();
                actions.onProbe("chrome-builtin");
              },
              (error: unknown) => {
                state.builtinDownload = { fraction: 0, done: false, error: error instanceof Error ? error.message : "download failed" };
                actions.rerender();
              },
            );
          }, { disabled: Boolean(download && !download.done && !download.error) }),
          download?.done ? chip("downloaded", "good") : null,
          download?.error ? chip(`failed: ${download.error}`, "bad") : null,
        )
      : null,
    el("p", { className: "ab-hint", text: "Gemini Nano runs on this device through Chrome's Prompt API; nothing leaves the computer. Token counts come from the API's own tokenizer, and the bundled output schema is passed as the response constraint (D-072)." }),
  );
}

function withConnection(settings: Settings, provider: ProviderId, change: (connection: StoredConnection) => StoredConnection): Settings {
  return { ...settings, models: { ...settings.models, connections: settings.models.connections.map((connection) => (connection.provider === provider ? change(connection) : connection)) } };
}

/** A URL field and a key field bound to the page state, so a re-render keeps what was typed. */
function keyedForm(state: SettingsPageState, fields: { url: "indexUrl" | "policyUrl"; pem: "indexPem" | "policyPem" }, labels: { url: string; pem: string }): HTMLElement {
  const url = el("input", { className: "ab-input", attrs: { type: "url", name: fields.url, placeholder: "https://…", autocomplete: "off", "aria-label": labels.url } });
  url.value = state.forms[fields.url];
  url.addEventListener("input", () => (state.forms[fields.url] = url.value));
  const pem = el("textarea", { className: "ab-input ab-pem", attrs: { name: fields.pem, rows: "3", placeholder: "-----BEGIN PUBLIC KEY-----", "aria-label": labels.pem } });
  pem.value = state.forms[fields.pem];
  pem.addEventListener("input", () => (state.forms[fields.pem] = pem.value));
  return el("div", { className: "ab-keyed-form" }, el("label", { className: "ab-field" }, el("span", { text: labels.url }), url), el("label", { className: "ab-field" }, el("span", { text: labels.pem }), pem));
}

function demoLink(text: string, apply: () => void): HTMLButtonElement {
  const node = el("button", { className: "ab-link", text });
  node.type = "button";
  node.addEventListener("click", apply);
  return node;
}

const STATE_TONE: Record<string, "good" | "warn" | "bad" | "neutral"> = { current: "good", expired: "bad", not_yet_valid: "warn", unverified: "bad", never_fetched: "warn" };
const STATE_WORDS: Record<string, string> = { current: "verified, current", expired: "expired: not used", not_yet_valid: "not valid yet: not used", unverified: "does not verify: not used", never_fetched: "not fetched" };

function indexRow(item: IndexView, actions: SettingsPageActions): HTMLElement {
  const index = item.index;
  return el(
    "div",
    { className: "ab-index-row", attrs: { "data-index-url": item.url } },
    el("div", { className: "ab-result-head" }, el("strong", { text: index ? `${index.title} ${index.version}` : item.url }), chip(STATE_WORDS[item.state] ?? item.state, STATE_TONE[item.state] ?? "neutral"), item.enabled ? chip("searched", "good") : chip("disabled")),
    index?.description ? el("p", { className: "ab-hint", text: index.description }) : null,
    el("p", { className: "ab-hint", text: `${item.url} · ${index ? `${index.entries} agent${index.entries === 1 ? "" : "s"} · published by ${index.publisher} · valid until ${index.expires_at} · ` : ""}key you pinned ${item.key_fingerprint} · fetched ${item.fetched_at ? whenTextSafe(item.fetched_at) : "never"}` }),
    ...(index?.notes ?? []).map((note) => el("p", { className: "ab-hint" }, el("code", { text: note.code }), " ", el("span", { text: note.detail ?? "" }))),
    item.unverified_reason ? el("p", { className: "ab-banner ab-banner-bad ab-index-unverified", text: `The copy held here does not verify: ${item.unverified_reason}` }) : null,
    item.last_error ? el("p", { className: "ab-banner ab-banner-warn", text: `Last check (${whenTextSafe(item.last_error.at)}): ${item.last_error.code}: ${item.last_error.message}` }) : null,
    el(
      "div",
      { className: "ab-actions" },
      button("Check for updates", () => actions.onIndex?.({ type: "indexes.refresh", url: item.url })),
      button(item.enabled ? "Disable" : "Enable", () => actions.onIndex?.({ type: "indexes.enable", url: item.url, enabled: !item.enabled }), { variant: "ghost" }),
      button("Remove", () => actions.onIndex?.({ type: "indexes.remove", url: item.url }), { variant: "danger" }),
    ),
  );
}

function whenTextSafe(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Settings → Search (T8): the agent indexes the address bar searches, each with the key pinned for it. */
function searchView(indexes: IndexesView | null, state: SettingsPageState, actions: SettingsPageActions): HTMLElement[] {
  if (indexes === null) return [el("p", { className: "ab-busy", text: "Loading…" })];
  return [
    card(
      "Agent indexes",
      el("p", { className: "ab-hint", text: "The address bar searches these when you type words or an agent name. An index is a signed list of where agents are and what their publishers say they do: it is fetched only when you add it, check it, or search it after an hour, and only with the key you pinned for it. Results are metadata: opening one verifies the package itself, and the index's claims are compared with what the package proves." }),
      indexes.indexes.length === 0 ? el("p", { className: "ab-empty", text: "No index added yet." }) : list(indexes.indexes.map((item) => indexRow(item, actions))),
    ),
    card(
      "Add an index",
      keyedForm(state, { url: "indexUrl", pem: "indexPem" }, { url: "Index address", pem: "Its publisher's key (PEM)" }),
      el(
        "div",
        { className: "ab-actions" },
        button("Add and verify", () => actions.onIndex?.({ type: "indexes.add", url: state.forms.indexUrl.trim(), publicKeyPem: state.forms.indexPem.trim() }), { variant: "primary", disabled: indexes.indexes.length >= indexes.max_indexes }),
        demoLink("Fill in the WebAgents demo index", () => {
          state.forms.indexUrl = demoDocuments.index.url;
          state.forms.indexPem = demoDocuments.index.public_key_pem;
          actions.rerender();
        }),
      ),
      el("p", { className: "ab-hint", text: `The demo index is signed with a development key (${demoDocuments.index.key_fingerprint}); filling it in still leaves the decision to add it to you.` }),
    ),
    card("NANDA index", chip("not available in this build", "warn"), el("p", { className: "ab-hint", text: indexes.nanda.note })),
  ];
}

/** The policy subscription card (T8, D-103): one policy at a time, what it decides, and how to leave it. */
function policyCard(policy: PolicyView | null, state: SettingsPageState, actions: SettingsPageActions): HTMLElement {
  if (policy === null) return card("Policy subscription", el("p", { className: "ab-busy", text: "Loading…" }));
  const form = (replace: boolean) => [
    keyedForm(state, { url: "policyUrl", pem: "policyPem" }, { url: "Policy address", pem: "Its issuer's key (PEM)" }),
    el(
      "div",
      { className: "ab-actions" },
      button(replace ? "Replace the current policy with this one" : "Subscribe", () => actions.onPolicy?.({ type: "policy.subscribe", url: state.forms.policyUrl.trim(), publicKeyPem: state.forms.policyPem.trim(), replace }), { variant: replace ? "danger" : "primary" }),
      demoLink("Fill in the example WebAgents research policy", () => {
        state.forms.policyUrl = demoDocuments.policy.url;
        state.forms.policyPem = demoDocuments.policy.public_key_pem;
        actions.rerender();
      }),
    ),
  ];
  if (!policy.subscribed) {
    return card(
      "Policy subscription",
      el("p", { className: "ab-hint", text: "Follow one signed policy, from your lab, school or employer, and it decides for you: which publishers to trust, what to allow by default, run limits and which models and services to use. Every decision it makes is shown as the policy's, and you can change any of them for one agent. The policy never grants more than an agent asks for or than your preset allows." }),
      ...form(false),
    );
  }
  const bundle = policy.bundle;
  const decisions = bundle ? Object.entries(bundle.decisions).map(([kind, decision]) => `${kind}: ${decision}`) : [];
  const anchors = bundle?.trust_anchors ?? [];
  return card(
    "Policy subscription",
    el("div", { className: "ab-result-head" }, el("strong", { text: policy.reference ? `${policy.reference.title}` : policy.url }), chip(STATE_WORDS[policy.state] ?? policy.state, STATE_TONE[policy.state] ?? "neutral"), policy.reference ? el("code", { text: `${policy.reference.policy_id}@${policy.reference.version}` }) : null),
    bundle?.description ? el("p", { className: "ab-hint", text: bundle.description }) : null,
    el("p", { className: "ab-hint", text: `${policy.url} · issued by ${bundle?.issuer.name ?? "unknown"} · signed by the key you pinned, ${policy.key_fingerprint} · valid until ${bundle?.expires_at ?? "unknown"} · checked ${whenTextSafe(policy.fetched_at)}` }),
    policy.last_error ? el("p", { className: "ab-banner ab-banner-warn", text: `Last check (${whenTextSafe(policy.last_error.at)}): ${policy.last_error.code}: ${policy.last_error.message}` }) : null,
    bundle
      ? definition([
          ["Trusts", anchors.length === 0 ? "no publisher" : list(anchors.map((anchor) => (anchor.kind === "publisher_key" ? `${anchor.display_name} (${anchor.publisher_id}), for ${anchor.package_id_prefix}…, key ${anchor.fingerprint}` : `${anchor.display_name}: a credential issuer for ${anchor.scope.package_id_prefix}…; declared, not applied in this version`)))],
          ["Decides by default", decisions.join(" · ") || "nothing"],
          ["Run limits", Object.entries(bundle.budget_caps).map(([field, value]) => `${field} ≤ ${value}`).join(" · ") || "no cap"],
          ["Models", `${bundle.models.local_only ? "local only" : "local or hosted"}${bundle.models.max_cost_usd_per_run !== null ? ` · at most $${bundle.models.max_cost_usd_per_run} per run (a model whose price this browser does not know is excluded)` : ""}`],
          ["Services", bundle.bindings === null ? "any" : bundle.bindings.allow.map((item) => `${item.kind}${item.origins ? ` (${item.origins.join(", ")})` : ""}`).join(" · ")],
        ])
      : null,
    el(
      "div",
      { className: "ab-actions" },
      button("Check for updates", () => actions.onPolicy?.({ type: "policy.refresh" })),
      button("Unsubscribe", () => actions.onPolicy?.({ type: "policy.unsubscribe" }), { variant: "danger" }),
    ),
    details("Follow another policy instead", false, ...form(true)),
  );
}

function policiesView(view: SettingsView, actions: SettingsPageActions, state: SettingsPageState, extras: SettingsExtras): HTMLElement[] {
  return [
    policyCard(extras.policy, state, actions),
    card(
      "Host preset",
      el("p", { className: "ab-hint", text: "The preset supplies the defaults a profile or the customize view starts from, and records them as decided by the preset. Payments stay single-use under every preset; no preset ever picks one of your records or offers “always”." }),
      el(
        "div",
        { className: "ab-presets", attrs: { role: "radiogroup" } },
        ...(Object.keys(PRESETS) as PresetId[]).map((id) => {
          const preset = PRESETS[id];
          const input = el("input", { attrs: { type: "radio", name: "agent-browser-preset", value: id } });
          input.checked = view.settings.preset === id;
          input.addEventListener("change", () => actions.onSave({ ...view.settings, preset: id }));
          return el(
            "label",
            { className: `ab-preset${view.settings.preset === id ? " ab-preset-selected" : ""}`, attrs: { "data-preset": id } },
            input,
            el("span", { className: "ab-preset-body" }, el("strong", { text: preset.title }), el("span", { className: "ab-hint", text: preset.summary }), preset.local_models_only ? chip("local models only", "good") : null),
          );
        }),
      ),
      definition([
        ["Personal data", `${PRESETS[view.settings.preset].durations["personal.read"] ?? PRESETS[view.settings.preset].durations.default} (when granted)`],
        ["Payments", PRESETS[view.settings.preset].durations.payment ?? "once"],
        ["Optional permissions without a profile", PRESETS[view.settings.preset].grant_optional === "none" ? "denied" : PRESETS[view.settings.preset].grant_optional === "non_personal" ? "granted, except personal data and payments" : "granted"],
        ["Tools without a profile", PRESETS[view.settings.preset].approve_tools === "all" ? "all approved" : "approved when every permission they need is granted"],
      ]),
    ),
    limitsCard(view, actions),
  ];
}

/** Run limits (B-118, D-084): the host bounds every run is held to; the package's own budget applies beneath them. */
function limitsCard(view: SettingsView, actions: SettingsPageActions): HTMLElement {
  const current = view.settings.limits;
  const inputs = new Map<keyof HostExecutionLimits, HTMLInputElement>();
  const fields = LIMIT_FIELDS.map((field) => {
    const input = el("input", { className: "ab-input", attrs: { type: "number", min: "1", step: "1", name: `limit-${field.key}`, "aria-label": field.label } });
    input.value = String(current[field.key]);
    inputs.set(field.key, input);
    return el("label", { className: "ab-field" }, el("span", { text: `${field.label} (${field.unit})` }), input);
  });
  const save = (limits: HostExecutionLimits) => actions.onSave({ ...view.settings, limits });
  const read = (): HostExecutionLimits => {
    const limits = { ...current };
    for (const [key, input] of inputs) limits[key] = Number(input.value);
    return limits;
  };
  const isDefault = LIMIT_FIELDS.every((field) => current[field.key] === DEFAULT_HOST_LIMITS[field.key]);
  return card(
    "Run limits",
    el("p", { className: "ab-hint", text: `Every run in this browser is bounded by these limits; a package's own budget and deadline apply beneath them, so raising a limit never gives a package more than it declares. The defaults are the reference host's (${DEFAULT_HOST_LIMITS.run_timeout_seconds} s per run, ${DEFAULT_HOST_LIMITS.total_tokens.toLocaleString()} tokens, ${DEFAULT_HOST_LIMITS.max_remote_calls} remote calls). A long research run on a local model needs more: the long-run limits are what the reference host was configured with for Literature Review. An authorization must outlast the time per run by a minute. A package's WebAssembly modules (code that can only compute) run one call at a time under the memory and time per compute call; a module that declares more memory than the bound is refused before the run, never squeezed, and the time bound is enforced by stopping the call (this browser meters no fuel).` }),
    isDefault ? chip("defaults", "neutral") : chip("changed", "warn"),
    el("div", { className: "ab-limits" }, ...fields),
    el(
      "div",
      { className: "ab-actions" },
      button("Save limits", () => save(read()), { variant: "primary" }),
      button("Use the long-run limits", () => save({ ...LONG_RUN_LIMITS }), { variant: "ghost" }),
      button("Restore the defaults", () => save({ ...DEFAULT_HOST_LIMITS }), { variant: "ghost", disabled: isDefault }),
    ),
  );
}

/** Settings → Files (T6, D-083): the PDFs runs may read, copied into this browser at the pick. */
function filesView(files: FilesView | null, actions: SettingsPageActions): HTMLElement[] {
  if (files === null) return [el("p", { className: "ab-busy", text: "Loading…" })];
  const total = files.files.reduce((sum, file) => sum + file.bytes, 0);
  return [
    card(
      "Files your runs may read",
      el("p", { className: "ab-hint", text: "Pick the PDFs an agent may read for you, such as papers for a literature review. Each one is copied into this browser once, with its SHA-256, so a run reads exactly what you picked even if the file changes on disk. A run is given only the documents its task names, by an opaque id; the names and your folders never reach a package, a model or a run record. Nothing is uploaded." }),
      el(
        "div",
        { className: "ab-actions" },
        button("Pick PDFs…", () => actions.onPickFiles?.(), { variant: "primary", disabled: !actions.onPickFiles || files.files.length >= files.max_files }),
        el("span", { className: "ab-hint", text: `${files.files.length} of ${files.max_files} files · ${bytes(total)} of ${bytes(files.max_total_bytes)} · at most ${bytes(files.max_file_bytes)} each` }),
      ),
      files.files.length === 0
        ? el("p", { className: "ab-hint", text: "No PDFs picked yet." })
        : list(
            files.files.map((file) =>
              el(
                "div",
                { className: "ab-file-row", attrs: { "data-file-id": file.file_id } },
                el("strong", { text: file.display_name }),
                el("span", { className: "ab-muted", text: ` · ${bytes(file.bytes)} · sha256:${file.sha256.slice(0, 12)}… · picked ${new Date(file.selected_at).toLocaleString()}` }),
                button("Remove", () => actions.onRemoveFile?.(file.file_id), { variant: "ghost", disabled: !actions.onRemoveFile }),
              ),
            ),
          ),
    ),
  ];
}

/** Settings → Services (T6, D-081): what a tool implementation sends on the person's behalf. */
function servicesView(view: SettingsView, actions: SettingsPageActions): HTMLElement[] {
  const contact = el("input", { className: "ab-input", attrs: { type: "email", name: "crossref-contact", autocomplete: "email", placeholder: "you@example.org", "aria-label": "Crossref contact e-mail" } });
  contact.value = view.settings.services.crossref_contact ?? "";
  return [
    card(
      "Crossref (scholarly search)",
      el("p", { className: "ab-hint", text: "Crossref asks clients to name a contact address to use its \u201cpolite pool\u201d. Leave this empty to send none. When set, the address is sent to Crossref, as mailto, with each search an agent makes through this browser and with each DOI this browser looks up at Crossref when a citation service is unavailable, and nowhere else. Requests to Crossref stay at one at a time, one per second, either way. Whether an address is sent is part of what you approve: changing it makes prepared run plans stale." }),
      el("label", { className: "ab-field" }, el("span", { text: "Contact e-mail (optional)" }), contact),
      el(
        "div",
        { className: "ab-actions" },
        button("Save", () => actions.onSave({ ...view.settings, services: { ...view.settings.services, crossref_contact: contact.value.trim() === "" ? null : contact.value.trim() } }), { variant: "primary" }),
        view.settings.services.crossref_contact ? button("Clear", () => actions.onSave({ ...view.settings, services: { ...view.settings.services, crossref_contact: null } }), { variant: "ghost" }) : null,
      ),
      row("Sent now", view.settings.services.crossref_contact ? "a contact address (mailto)" : "no contact address"),
    ),
  ];
}

function aboutView(view: SettingsView, status: StatusInfo | null, actions: SettingsPageActions): HTMLElement[] {
  const limits = status?.execution_limits ?? null;
  const record = el("input", { attrs: { type: "checkbox", name: "developer-record-requests", "aria-label": "Record outbound request bodies (test mode)" } });
  record.checked = view.settings.developer.record_requests;
  record.addEventListener("change", () => actions.onSave({ ...view.settings, developer: { ...view.settings.developer, record_requests: record.checked } }));
  return [
    card(
      "This browser",
      status
        ? el(
            "div",
            {},
            row("Extension", status.version),
            row("Core", `${status.core_version} (agentpkg-runtime-v0 ${status.runtime_version})`),
            row("Open packages", `${status.sessions} of ${status.max_sessions}`),
            row("Snapshot cache", `${(status.cached_bytes / (1024 * 1024)).toFixed(1)} of ${(status.max_cache_bytes / (1024 * 1024)).toFixed(0)} MiB`),
            row("Session lifetime", `${status.session_ttl_seconds / 60} minutes`),
            row("Execution", status.execution === "enabled" ? "enabled: runs execute in this browser, in an offscreen document's Worker" : "disabled: this Chrome exposes no offscreen documents"),
            row("Runs", `${status.runs.active} active · ${status.runs.stored} stored`),
            limits ? row("Run limits", `${limits.total_tokens.toLocaleString()} tokens · ${limits.max_remote_calls} remote calls · ${limits.max_parallel_workers} parallel workers · ${limits.max_output_tokens_per_call.toLocaleString()} output tokens per call · ${limits.run_timeout_seconds} s per run · ${limits.model_call_timeout_seconds} s per model call (the package's own budget applies beneath them)`) : null,
          )
        : el("p", { className: "ab-busy", text: "Loading…" }),
    ),
    card(
      "Test mode",
      el("label", { className: "ab-field ab-inline" }, record, " ", el("span", { text: "Record every outbound model and tool request body of a run (for the privacy checks of the live harness)" })),
      el("p", { className: "ab-hint", text: "Off by default. When on, the execution host stores the bodies it sends, including any personal value a granted tool call carries, in this browser's IndexedDB beside the run, so a verifier can assert that no sealed value reached a model and that a granted value reached only the tool that links its permission (D-028). Nothing leaves the browser." }),
    ),
  ];
}

/** Settings → Security (T16, D-191, D-192): the passphrase, the idle lock, Lock now, Forget everything. */
function securityView(view: SettingsView, actions: SettingsPageActions, state: SettingsPageState, secrets: SecretsView | null, keychain: KeychainView | null): HTMLElement[] {
  if (secrets === null) return [el("p", { className: "ab-busy", text: "Loading…" })];
  const cards: HTMLElement[] = [];
  const passphraseField = (name: string, label: string, autocomplete: string) => el("input", { className: "ab-input", attrs: { type: "password", name, autocomplete, "aria-label": label, placeholder: label } });
  if (secrets.state === "no_passphrase") {
    const first = passphraseField("passphrase-new", "New passphrase", "new-password");
    const again = passphraseField("passphrase-again", "Repeat the passphrase", "new-password");
    const setup = () => {
      if (first.value !== again.value) {
        state.notice = "The two passphrases differ.";
        actions.rerender();
        return;
      }
      const passphrase = first.value;
      first.value = again.value = "";
      actions.onSecrets?.({ type: "secrets.setup", passphrase });
    };
    cards.push(
      card(
        "Set a passphrase",
        el("p", { className: "ab-hint", text: `Your provider keys and your records are kept encrypted (AES-256-GCM) under a key derived from this passphrase (scrypt, about half a second). Nothing secret is saved until one exists. At least ${MIN_PASSPHRASE_LENGTH} characters; there is no recovery: a forgotten passphrase means forgetting the keys and records, not the agents, runs or settings.` }),
        secrets.migration_pending
          ? el("div", { className: "ab-banner ab-banner-warn ab-legacy", attrs: { role: "status" } }, el("strong", { text: "Waiting to be protected: " }), el("span", { text: `${secrets.legacy?.providers.length ? `${secrets.legacy.providers.join(", ")} key${secrets.legacy.providers.length === 1 ? "" : "s"}` : "no key"} and ${secrets.legacy?.records ?? 0} record${secrets.legacy?.records === 1 ? "" : "s"} from the previous version. They are moved into the encrypted store the moment you set a passphrase, and cannot be used before.` }))
          : null,
        el("label", { className: "ab-field" }, el("span", { text: "Passphrase" }), first),
        el("label", { className: "ab-field" }, el("span", { text: "Repeat it" }), again),
        el("div", { className: "ab-actions" }, button("Set passphrase", setup, { variant: "primary" })),
      ),
    );
    return cards;
  }
  if (secrets.state === "invalid") {
    // An envelope this build cannot read (review 1, finding 6): say why, and offer the one way out.
    cards.push(
      card(
        "Your keys and records",
        el("div", { className: "ab-row" }, chip("Unreadable", "bad")),
        el("div", { className: "ab-banner ab-banner-warn", attrs: { role: "alert" } }, el("strong", { text: "The protected store cannot be read by this build. " }), el("span", { text: secrets.problem ?? "The stored envelope is not one this version reads." })),
        el("p", { className: "ab-hint", text: "This happens when the stored data was truncated or altered, or was written by a newer version of this extension. No key or record can be used until the store is forgotten; the agents, runs, trust pins and settings are not affected. If a newer version wrote it, updating the extension reads it again." }),
      ),
      forgetCard(actions, state),
    );
    return cards;
  }
  const unlocked = secrets.state === "unlocked";
  const idle = el("select", { className: "ab-select", attrs: { name: "idle-lock-minutes", "aria-label": "Lock after" } });
  for (const minutes of IDLE_LOCK_MINUTES) idle.append(el("option", { text: minutes === null ? "Until the browser closes" : `${minutes} minutes idle`, attrs: { value: minutes === null ? "never" : String(minutes) } }));
  idle.value = view.settings.security.idle_lock_minutes === null ? "never" : String(view.settings.security.idle_lock_minutes);
  idle.addEventListener("change", () => actions.onSave({ ...view.settings, security: { idle_lock_minutes: idle.value === "never" ? null : Number(idle.value) } }));
  cards.push(
    card(
      "Your keys and records",
      el("div", { className: "ab-row" }, chip(unlocked ? "Unlocked" : "Locked", unlocked ? "good" : "neutral"), el("span", { className: "ab-hint", text: unlocked ? ` · ${idleWords(secrets.idle_minutes)}${secrets.last_used_at ? ` · last used ${clockTime(secrets.last_used_at)}` : ""}` : " · enter your passphrase where it is asked for, or here" })),
      el("p", { className: "ab-hint", text: `Encrypted at rest since ${secrets.created_at ? new Date(secrets.created_at).toLocaleDateString() : "unknown"}: ${secrets.entries.length === 0 ? "nothing stored yet" : secrets.entries.map((name) => (name.startsWith("provider_key:") ? `${name.slice("provider_key:".length)} key` : name === "vault" ? "your records" : name === "vault_key" ? "the records' digest key" : name)).join(", ")}. While unlocked, the key that opens them is held in this browser session's memory only; it is wiped after the idle time, when you press Lock now, and when the browser closes. A run in progress keeps what it was given until it ends.` }),
      el("label", { className: "ab-field" }, el("span", { text: "Lock after" }), idle),
      el("div", { className: "ab-actions" }, unlocked ? button("Lock now", () => actions.onSecrets?.({ type: "secrets.lock" }), { variant: "ghost" }) : null),
    ),
  );
  cards.push(keychainCard(keychain, unlocked, actions));
  const current = passphraseField("passphrase-current", "Current passphrase", "current-password");
  const next = passphraseField("passphrase-next", "New passphrase", "new-password");
  const nextAgain = passphraseField("passphrase-next-again", "Repeat the new passphrase", "new-password");
  const change = () => {
    if (next.value !== nextAgain.value) {
      state.notice = "The two new passphrases differ.";
      actions.rerender();
      return;
    }
    const request = { type: "secrets.changePassphrase" as const, current: current.value, next: next.value };
    current.value = next.value = nextAgain.value = "";
    actions.onSecrets?.(request);
  };
  cards.push(
    card(
      "Change the passphrase",
      el("p", { className: "ab-hint", text: "The new passphrase wraps the same store key under a fresh salt; nothing stored is re-encrypted and nothing is lost. It works whether the store is locked or not." }),
      el("label", { className: "ab-field" }, el("span", { text: "Current passphrase" }), current),
      el("label", { className: "ab-field" }, el("span", { text: "New passphrase" }), next),
      el("label", { className: "ab-field" }, el("span", { text: "Repeat it" }), nextAgain),
      el("div", { className: "ab-actions" }, button("Change passphrase", change, { variant: "primary" })),
    ),
  );
  cards.push(forgetCard(actions, state));
  return cards;
}

/** What the helper says about Ollama, in one line (T17): installed, running, and whether it admits this extension. */
export function ollamaWords(ollama: NonNullable<KeychainView["ollama"]>): { text: string; tone: "good" | "warn" | "bad" } {
  if (!ollama.installed && !ollama.running) return { text: "Ollama is not installed (the macOS installer can add it).", tone: "warn" };
  const version = ollama.server_version ?? ollama.version;
  const name = version ? `Ollama ${version}` : "Ollama";
  if (!ollama.running) return { text: `${name} is installed but not running.`, tone: "warn" };
  // The server's own answer (T17 review 1, nit 6): the login value may be right while Ollama still runs with an older one.
  if (!ollama.extension_allowed) return { text: `${name} is running but does not admit this extension (OLLAMA_ORIGINS at login: ${ollama.origins ?? "not set"}); restart Ollama after the installer sets it, or see Settings → Models.`, tone: "bad" };
  return { text: `${name} is running and admits this extension.`, tone: "good" };
}

/**
 * Settings → Security's keychain card (T17, D-181, D-204): optional; the passphrase stays the
 * way in. The card names what the helper said just now, never more than that.
 */
function keychainCard(keychain: KeychainView | null, unlocked: boolean, actions: SettingsPageActions): HTMLElement {
  const intro = el("p", { className: "ab-hint", text: "With the WebAgents helper (installed by the macOS installer), the key that opens your store can also be kept in your login keychain, so unlocking is one click. The helper sees that key only while wrapping or unwrapping it, never a provider key, a record or a package. Your passphrase keeps working, and removing the helper loses nothing." });
  if (keychain === null) return card("Unlock with the macOS keychain", intro, el("p", { className: "ab-busy", text: "Asking the helper…" }));
  const refresh = button("Check again", () => actions.onKeychain?.("refresh"), { variant: "ghost" });
  const status: HTMLElement[] = [];
  if (!keychain.permission) {
    status.push(el("div", { className: "ab-row" }, chip(keychain.enabled ? "Permission removed" : "Off", keychain.enabled ? "warn" : "neutral")));
    status.push(el("p", { className: "ab-hint", text: "Turning it on asks Chrome for permission to talk to a native application (the helper), then asks the helper to keep the key." }));
  } else if (keychain.helper === "available") {
    status.push(el("div", { className: "ab-row" }, chip("keychain available", "good"), el("span", { className: "ab-hint", text: ` · helper ${keychain.helper_version ?? "unknown version"}${keychain.enabled ? ` · on since ${keychain.enabled_at ? new Date(keychain.enabled_at).toLocaleDateString() : "unknown"}` : " · off"}` })));
  } else if (keychain.helper === "not_installed") {
    status.push(el("div", { className: "ab-row" }, chip("Helper not installed", "warn")));
    status.push(el("p", { className: "ab-hint", text: "The macOS installer (installer/README.md) adds the helper and can set up Ollama. Until then, unlock with your passphrase; nothing is lost." }));
  } else if (keychain.helper === "forbidden") {
    // A helper installed for another extension id (T17 review 2, nit 1): the words say what to do, not "not installed".
    status.push(el("div", { className: "ab-row" }, chip("Helper not for this extension", "warn")));
    status.push(el("p", { className: "ab-hint", text: "The installed helper does not list this extension: reinstall it with the current installer. Until then, unlock with your passphrase; nothing is lost." }));
  } else {
    status.push(el("div", { className: "ab-row" }, chip(keychain.helper === "refused" ? "Helper refused" : "Helper failed", "bad")));
  }
  if (keychain.problem && keychain.helper !== "not_installed" && keychain.helper !== "forbidden") status.push(el("p", { className: "ab-banner ab-banner-warn", attrs: { role: "status" }, text: `${keychain.problem.code}: ${keychain.problem.message}` }));
  if (keychain.ollama) {
    const words = ollamaWords(keychain.ollama);
    status.push(el("div", { className: "ab-row ab-ollama-status" }, chip("Ollama", words.tone), el("span", { className: "ab-hint", text: ` ${words.text}` })));
  }
  const toggle = keychain.enabled
    ? button("Turn off", () => actions.onKeychain?.("disable"), { variant: "ghost" })
    : button("Turn on", () => actions.onKeychain?.("enable"), { variant: "primary", disabled: !unlocked || (keychain.permission && keychain.helper !== "available") });
  return card(
    "Unlock with the macOS keychain",
    intro,
    ...status,
    !keychain.enabled && !unlocked ? el("p", { className: "ab-hint", text: "Unlock with your passphrase first: the key is handed to the helper only while the store is open." }) : null,
    el("div", { className: "ab-actions" }, toggle, refresh),
  );
}

/** "Forget everything", with its typed confirmation: the way out of a lost passphrase and of an unreadable store. */
function forgetCard(actions: SettingsPageActions, state: SettingsPageState): HTMLElement {
  const confirmation = el("input", { className: "ab-input", attrs: { type: "text", name: "forget-confirmation", autocomplete: "off", placeholder: "type forget", "aria-label": "Type forget to confirm" } });
  confirmation.value = state.forgetConfirmation;
  confirmation.addEventListener("input", () => {
    state.forgetConfirmation = confirmation.value;
  });
  return card(
    "Forget everything",
    el("p", { className: "ab-hint", text: "Deletes the encrypted store: every provider key and every record, for good. Agents, runs, trust pins and settings stay. Use it when a passphrase is lost or the store cannot be read. Type forget to confirm." }),
    el("div", { className: "ab-actions" }, confirmation, button("Forget everything", () => {
      const typed = state.forgetConfirmation;
      state.forgetConfirmation = "";
      actions.onSecrets?.({ type: "secrets.forget", confirmation: typed });
    }, { variant: "danger" })),
  );
}

function purposeWords(purpose: GrantPurpose): string {
  switch (purpose.kind) {
    case "package":
      return `for the agent ${purpose.label ?? purpose.subject}`;
    case "provider":
      return `for your ${purpose.subject} models`;
    case "site":
      return "to detect agents on this site";
    case "document":
      return `for the signed document at ${purpose.subject}`;
    default:
      return "to detect agents on every site";
  }
}

/** Settings → Permissions (T16, D-190, D-193): every origin Chrome grants this extension, why, and Revoke; the every-site opt-in. */
function permissionsView(permissions: PermissionsView | null, actions: SettingsPageActions): HTMLElement[] {
  if (permissions === null) return [el("p", { className: "ab-busy", text: "Loading…" })];
  const everywhere = el("input", { attrs: { type: "checkbox", name: "detect-everywhere", "aria-label": "Detect agents on every site" } });
  everywhere.checked = permissions.detect_everywhere;
  everywhere.addEventListener("change", () => actions.onDetectEverywhere?.(everywhere.checked));
  const sites = permissions.origins.filter((item) => item.origin !== "*");
  return [
    card(
      "What this browser may reach",
      el("p", { className: "ab-hint", text: "By default this extension holds no access to any website. Chrome grants an origin only when you allow it: a package's origin, its tools' services and your model provider when you use an agent (listed under the plan's Technical details), a site you chose to detect agents on, a signed index or policy you added. This browser checks every grant before it fetches and a run may reach only the origins its plan recorded; Chrome keeps the grants and decides which pages this extension may read. Revoking one here makes Chrome forget it, and a prepared plan that needs it then names it before Run. While every site is granted, single origins cannot be revoked: turn that off first." }),
      el("p", { className: "ab-hint", text: `Always held, from the manifest: ${permissions.manifest_hosts.join(" and ")} (Ollama on this machine).` }),
      sites.length === 0
        ? el("p", { className: "ab-empty", text: "No website origin is granted yet." })
        : el(
            "div",
            { className: "ab-permission-list" },
            ...sites.map((item) =>
              el(
                "div",
                { className: "ab-permission-row", attrs: { "data-origin": item.origin } },
                el("code", { text: item.origin }),
                chip(item.granted ? "granted" : "not granted by Chrome", item.granted ? "good" : "warn"),
                el("p", { className: "ab-hint ab-permission-why", text: item.purposes.length === 0 ? "granted outside this extension (an earlier version, or chrome://extensions)" : item.purposes.map(purposeWords).join("; ") }),
                // Under every-site, a single Revoke can only end in the 409 banner: disabled, and the hint above says why (T16 review 2, nit 4).
                button("Revoke", () => actions.onRevoke?.([item.origin]), { variant: "danger", disabled: !actions.onRevoke || permissions.detect_everywhere }),
              ),
            ),
          ),
    ),
    card(
      "Detect agents on every site",
      el("label", { className: "ab-field ab-inline" }, everywhere, " ", el("span", { text: "Read every HTTPS page for agent links and show the badge" })),
      el("p", { className: "ab-hint", text: "Off by default. On, Chrome asks you once to allow every website, and this extension's discovery script then runs on every HTTPS page: it reads only the page head's agent-package links and reports them to the badge; it reads, changes and sends nothing else. Off, the badge appears only on sites you allowed one by one, and any page can still be read with one click on the WebAgents button." }),
    ),
  ];
}

export function renderSettingsPage(view: SettingsView, status: StatusInfo | null, state: SettingsPageState, actions: SettingsPageActions, files: FilesView | null = null, extras: SettingsExtras = { indexes: null, policy: null }): HTMLElement {
  const tabs = el(
    "div",
    { className: "ab-tabs", attrs: { role: "tablist" } },
    ...SETTINGS_SECTIONS.map((section) => {
      const tab = button(SECTION_TITLES[section], () => {
        // Only a change of section re-tests: a click on the Models tab already shown does not (review 1, nit 6).
        const opening = section === "models" && state.section !== "models";
        state.section = section;
        if (opening) actions.onOpenModels?.();
        actions.rerender();
      }, { variant: state.section === section ? "primary" : "ghost" });
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", state.section === section ? "true" : "false");
      return tab;
    }),
  );
  const body =
    state.section === "models"
      ? view.settings.models.connections.map((connection) => connectionCard(view, connection, state, actions, extras))
      : state.section === "policies"
        ? policiesView(view, actions, state, extras)
        : state.section === "security"
          ? securityView(view, actions, state, extras.secrets ?? null, extras.keychain ?? null)
          : state.section === "memory"
            ? (extras.memory ?? [el("p", { className: "ab-busy", text: "Loading…" })])
          : state.section === "permissions"
            ? permissionsView(extras.permissions ?? null, actions)
            : state.section === "search"
              ? searchView(extras.indexes, state, actions)
              : state.section === "files"
                ? filesView(files, actions)
                : state.section === "services"
                  ? servicesView(view, actions)
                  : aboutView(view, status, actions);
  return el(
    "div",
    { className: "ab-settings" },
    tabs,
    state.notice ? el("div", { className: "ab-banner ab-banner-neutral", attrs: { role: "status" } }, el("span", { text: state.notice })) : null,
    state.section === "models" ? row("Default model", view.settings.models.default_model ? el("code", { text: view.settings.models.default_model }) : "none: test a connection and press “Make default” on a model") : null,
    ...body,
  );
}
