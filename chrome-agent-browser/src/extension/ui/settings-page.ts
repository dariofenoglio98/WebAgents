/**
 * Settings: Models (the routes of D-023, a connection test per provider, keys that are typed
 * here and never shown again, per-model limits, the default model), Policies (the host preset of
 * D-050 and the run limits, B-118), Files (the PDFs runs may read, T6) and Services (the Crossref
 * contact address, T6). A thin view over the worker's `SettingsView` and `FilesView`.
 */
import { isRecord } from "../../core/fields.js";
import type { PresetId } from "../../core/types.js";
import { PRESETS } from "../../core/authorization.js";
import { DEFAULT_BASE_URLS, type ProbeResult, type ProviderId } from "../../core/models/catalog.js";
import { DEFAULT_HOST_LIMITS, type HostExecutionLimits } from "../../core/execution/limits.js";
import type { FilesView, ProbeView, SettingsView, StatusInfo } from "../messages.js";
import type { Settings, StoredConnection } from "../storage/settings.js";
import { downloadBuiltinModel, languageModelApi } from "../execution/builtin-port.js";
import { button, card, chip, definition, el, list, row } from "./dom.js";

export type SettingsSection = "models" | "policies" | "files" | "services" | "about";
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["models", "policies", "files", "services", "about"];
const SECTION_TITLES: Record<SettingsSection, string> = { models: "Models", policies: "Policies", files: "Files", services: "Services", about: "About" };

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
});

const LIMIT_FIELDS: ReadonlyArray<{ key: keyof HostExecutionLimits; label: string; unit: string }> = [
  { key: "total_tokens", label: "Tokens per run", unit: "tokens" },
  { key: "max_remote_calls", label: "Remote calls per run", unit: "calls" },
  { key: "max_parallel_workers", label: "Parallel workers", unit: "workers" },
  { key: "max_output_tokens_per_call", label: "Output tokens per model call", unit: "tokens" },
  { key: "run_timeout_seconds", label: "Time per run", unit: "seconds" },
  { key: "max_calls_per_tool", label: "Calls per tool", unit: "calls" },
  { key: "model_call_timeout_seconds", label: "Time per model call", unit: "seconds" },
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
}

export function newSettingsPageState(section: SettingsSection = "models"): SettingsPageState {
  return { section, probes: {}, checkedAt: {}, notice: null, builtinDownload: null, copied: null };
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
}

/** The one-time Ollama setup (B-117): the commands a person copies, per way of running Ollama. */
export const OLLAMA_ORIGIN_COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: "macOS app (Ollama in the menu bar)", command: 'launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"' },
  { label: "Started from a terminal", command: 'OLLAMA_ORIGINS="chrome-extension://*" ollama serve' },
  { label: "Linux service (systemd)", command: 'sudo systemctl edit ollama   # add: Environment="OLLAMA_ORIGINS=chrome-extension://*"' },
];

const PROVIDER_TITLES: Record<ProviderId, string> = {
  ollama: "Ollama (local)",
  openai: "OpenAI (your key)",
  anthropic: "Anthropic (your key)",
  "chrome-builtin": "Chrome built-in (Gemini Nano)",
};

const PROVIDER_HINTS: Record<ProviderId, string> = {
  ollama: "Runs on this computer; free. Ollama must allow this extension's origin: set OLLAMA_ORIGINS to include chrome-extension://* before starting Ollama. Discovered models are capped at 32,768 tokens of context unless you state a higher limit below.",
  openai: "Direct calls to OpenAI with your own key, through the Responses API with the package's schema and output cap. Metered by OpenAI.",
  anthropic: "Direct calls to Anthropic with your own key, through the Messages API. Metered by Anthropic.",
  "chrome-builtin": "Chrome's own small model through the Prompt API, no setup and no cost; needs free disk space and a capable device. Zero-setup tier.",
};

function connectionCard(view: SettingsView, connection: StoredConnection, state: SettingsPageState, actions: SettingsPageActions): HTMLElement {
  const provider = connection.provider;
  const probe = state.probes[provider];
  const enabled = el("input", { attrs: { type: "checkbox", name: `enabled-${provider}`, "aria-label": `Enable ${PROVIDER_TITLES[provider]}` } });
  enabled.checked = connection.enabled;
  enabled.addEventListener("change", () => actions.onSave(withConnection(view.settings, provider, (item) => ({ ...item, enabled: enabled.checked }))));
  const children: Array<HTMLElement | null> = [
    el("label", { className: "ab-field ab-inline" }, enabled, " ", el("span", { text: "Enabled" })),
    el("p", { className: "ab-hint", text: PROVIDER_HINTS[provider] }),
  ];
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
  if (provider !== "chrome-builtin") {
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
      el("p", { className: "ab-hint", text: "Keys live in chrome.storage.local, never in sync storage, and leave this browser only as the provider's own header. This page shows whether a key is stored, never the key." }),
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
  if (probe && probe !== "running" && probe.ok && probe.models.length > 0) {
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

/** One probed model: make it the default, or state its limits (recorded as `declared`). */
function modelRow(view: SettingsView, connection: StoredConnection, model: ProbedModel, actions: SettingsPageActions): HTMLElement {
  const isDefault = view.settings.models.default_model === model.id;
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
      isDefault ? null : button("Make default", () => actions.onSave({ ...view.settings, models: { ...view.settings.models, default_model: model.id } }), { variant: "primary", disabled: !model.available }),
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
    el("p", { className: "ab-hint", text: "Limits you state here are recorded as declared by you in every run plan that binds this model." }),
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

function policiesView(view: SettingsView, actions: SettingsPageActions): HTMLElement[] {
  return [
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
    el("p", { className: "ab-hint", text: `Every run in this browser is bounded by these limits; a package's own budget and deadline apply beneath them, so raising a limit never gives a package more than it declares. The defaults are the reference host's (${DEFAULT_HOST_LIMITS.run_timeout_seconds} s per run, ${DEFAULT_HOST_LIMITS.total_tokens.toLocaleString()} tokens, ${DEFAULT_HOST_LIMITS.max_remote_calls} remote calls). A long research run on a local model needs more: the long-run limits are what the reference host was configured with for Literature Review. An authorization must outlast the time per run by a minute.` }),
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

function bytesText(count: number): string {
  return count >= 1024 * 1024 ? `${(count / (1024 * 1024)).toFixed(1)} MiB` : count >= 1024 ? `${Math.round(count / 1024)} KiB` : `${count} bytes`;
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
        el("span", { className: "ab-hint", text: `${files.files.length} of ${files.max_files} files · ${bytesText(total)} of ${bytesText(files.max_total_bytes)} · at most ${bytesText(files.max_file_bytes)} each` }),
      ),
      files.files.length === 0
        ? el("p", { className: "ab-hint", text: "No PDFs picked yet." })
        : list(
            files.files.map((file) =>
              el(
                "div",
                { className: "ab-file-row", attrs: { "data-file-id": file.file_id } },
                el("strong", { text: file.display_name }),
                el("span", { className: "ab-muted", text: ` · ${bytesText(file.bytes)} · sha256:${file.sha256.slice(0, 12)}… · picked ${new Date(file.selected_at).toLocaleString()}` }),
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
      el("p", { className: "ab-hint", text: "Crossref asks clients to name a contact address to use its \u201cpolite pool\u201d. Leave this empty to send none. When set, the address is sent to Crossref, as mailto, with each search an agent makes through this browser, and nowhere else. Searches stay at one at a time, one per second, either way. Whether an address is sent is part of what you approve: changing it makes prepared run plans stale." }),
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

export function renderSettingsPage(view: SettingsView, status: StatusInfo | null, state: SettingsPageState, actions: SettingsPageActions, files: FilesView | null = null): HTMLElement {
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
      ? view.settings.models.connections.map((connection) => connectionCard(view, connection, state, actions))
      : state.section === "policies"
        ? policiesView(view, actions)
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
