/**
 * Settings: Models (the routes of D-023, a connection test per provider, keys that are typed
 * here and never shown again, per-model limits, the default model) and Policies (the host
 * preset of D-050). A thin view over the worker's `SettingsView`.
 */
import type { PresetId } from "../../core/types.js";
import { PRESETS } from "../../core/authorization.js";
import type { ProbeResult, ProviderId } from "../../core/models/catalog.js";
import type { SettingsView, StatusInfo } from "../messages.js";
import type { Settings, StoredConnection } from "../storage/settings.js";
import { button, card, chip, definition, el, list, row } from "./dom.js";

export type SettingsSection = "models" | "policies" | "about";

export interface SettingsPageState {
  section: SettingsSection;
  probes: Partial<Record<ProviderId, ProbeResult | "running">>;
  notice: string | null;
}

export function newSettingsPageState(section: SettingsSection = "models"): SettingsPageState {
  return { section, probes: {}, notice: null };
}

export interface SettingsPageActions {
  onSave: (settings: Settings) => void;
  onSetKey: (provider: ProviderId, key: string | null) => void;
  onProbe: (provider: ProviderId) => void;
  rerender: () => void;
}

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
  if (provider !== "chrome-builtin") {
    const url = el("input", { className: "ab-input", attrs: { name: `base-url-${provider}`, placeholder: provider === "ollama" ? "http://127.0.0.1:11434 (default)" : "default endpoint", autocomplete: "off" } });
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
  children.push(
    el(
      "div",
      { className: "ab-inline" },
      button(probe === "running" ? "Testing…" : "Test connection", () => actions.onProbe(provider), { disabled: probe === "running" || !connection.enabled }),
      probe && probe !== "running" ? chip(probe.ok ? `reachable · ${probe.models.length} model${probe.models.length === 1 ? "" : "s"}` : `failed: ${probe.error ?? "unknown"}`, probe.ok ? "good" : "bad") : null,
    ),
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
  ];
}

function aboutView(status: StatusInfo | null): HTMLElement[] {
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
            row("Execution", status.execution),
          )
        : el("p", { className: "ab-busy", text: "Loading…" }),
    ),
  ];
}

export function renderSettingsPage(view: SettingsView, status: StatusInfo | null, state: SettingsPageState, actions: SettingsPageActions): HTMLElement {
  const tabs = el(
    "div",
    { className: "ab-tabs", attrs: { role: "tablist" } },
    ...(["models", "policies", "about"] as SettingsSection[]).map((section) => {
      const tab = button(section === "models" ? "Models" : section === "policies" ? "Policies" : "About", () => {
        state.section = section;
        actions.rerender();
      }, { variant: state.section === section ? "primary" : "ghost" });
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", state.section === section ? "true" : "false");
      return tab;
    }),
  );
  const body = state.section === "models" ? view.settings.models.connections.map((connection) => connectionCard(view, connection, state, actions)) : state.section === "policies" ? policiesView(view, actions) : aboutView(status);
  return el(
    "div",
    { className: "ab-settings" },
    tabs,
    state.notice ? el("div", { className: "ab-banner ab-banner-neutral", attrs: { role: "status" } }, el("span", { text: state.notice })) : null,
    state.section === "models" ? row("Default model", view.settings.models.default_model ? el("code", { text: view.settings.models.default_model }) : "none: test a connection and press “Make default” on a model") : null,
    ...body,
  );
}
