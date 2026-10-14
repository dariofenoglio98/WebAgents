/**
 * Settings, provider keys, the vault and the install identity, all in `chrome.storage.local`
 * (D-032, D-051, D-055). Nothing ever goes to `storage.sync`: a key or a personal record must
 * never leave this browser profile through account sync.
 *
 *   settings      the host preset, the model connections (no key), the default model, the idle lock
 *   secretStore   the encrypted envelope (T16, D-191) that holds what 0.1.0 kept in clear:
 *                 `provider_key:<provider>` (one API key per hosted provider, read only by the
 *                 service worker's transport and a run's start message), `vault_key` (the HMAC
 *                 key, 32 bytes) and `vault` (the vault document: types and records)
 *   instanceId    the control plane's instance id, generated once per install
 *   spentReceipts receipt ids whose `once` grants a run already used (T5, D-065)
 *
 * The three clear keys of 0.1.0 (`providerKeys`, `vault`, `vaultKey`) are read exactly once, by
 * the migration that runs when the first passphrase is set, and removed then. Until a passphrase
 * exists no secret is saved or used: every read refuses `store_no_passphrase` (strict, the
 * user's choice at the T16 gate), so nothing encrypted is ever written in clear again.
 */
import { OPENAI_REASONING_EFFORTS, type OpenAIReasoningEffort } from "../../core/models/adapters/openai.js";
import { DEFAULT_PRESET, isPresetId } from "../../core/authorization.js";
import { isRecord } from "../../core/fields.js";
import type { ModelOverride, ProviderConnection, ProviderId } from "../../core/models/catalog.js";
import { isLoopbackBase, OLLAMA_LOOPBACK_HOSTS, PROVIDER_IDS } from "../../core/models/catalog.js";
import { DEFAULT_HOST_LIMITS, normalizeHostLimits, type HostExecutionLimits } from "../../core/execution/limits.js";
import { validContact } from "../../core/tools/adapters/crossref.js";
import type { PresetId } from "../../core/types.js";
import { DEFAULT_IDLE_LOCK_MINUTES, IDLE_LOCK_MINUTES, type SecretStore, utf8 } from "../../core/secrets.js";
import { emptyVaultDocument, generateVaultKey, KEY_BYTES, type VaultDocument } from "../../core/vault.js";

export const SETTINGS_KEY = "settings";
/** The 0.1.0 clear keys: read by the migration only (T16). */
export const PROVIDER_KEYS_KEY = "providerKeys";
export const VAULT_KEY = "vault";
export const VAULT_HMAC_KEY = "vaultKey";
/** The secret store's entry names (D-191). */
export const PROVIDER_KEY_ENTRY = (provider: ProviderId): string => `provider_key:${provider}`;
export const VAULT_ENTRY = "vault";
export const VAULT_KEY_ENTRY = "vault_key";
export const INSTANCE_ID_KEY = "instanceId";
/** Receipt ids whose `once` grants a run already used (D-065): the lease registry's persisted half. */
export const SPENT_RECEIPTS_KEY = "spentReceipts";
const MAX_SPENT_RECEIPTS = 1024;

/** A connection as stored and shown: the key itself is elsewhere, only its presence is reported. */
export interface StoredConnection {
  provider: ProviderId;
  enabled: boolean;
  base_url: string | null;
  overrides: Record<string, ModelOverride>;
  /**
   * Ollama only (T6): send `think: true`, as the reference host's Ollama route did for the
   * accepted local Literature Review runs. Off by default (D-062): with `format` plus thinking,
   * Ollama can exceed a node's output cap, which halts the run.
   */
  think?: boolean;
  /**
   * OpenAI only (T10, D-123): the `reasoning.effort` sent to models that reason. Absent means the
   * default, `medium`; `low` shortcut Literature Review's copy-heavy steps in the T10 diagnosis.
   */
  reasoning_effort?: OpenAIReasoningEffort;
}

export interface Settings {
  schema: "chrome-agent-browser-settings-v0";
  preset: PresetId;
  models: {
    connections: StoredConnection[];
    /** The host model id (`provider/model`) the two-click path binds; null until the person picks one. */
    default_model: string | null;
  };
  /**
   * Services a tool implementation reaches on the person's behalf (T6, D-081). `crossref_contact`
   * is the address Crossref's polite pool asks for (`mailto`); none is sent unless the person
   * enters one here. Whether one is set is part of the scholarly-search binding's digest.
   */
  services: { crossref_contact: string | null };
  /**
   * The host limits every run is bounded by (B-118, T6 D-084): the reference plugin's
   * `DEFAULT_POLICY` unless the person raises or lowers them in Settings → Run limits, each
   * within `limits.ts`'s maxima. The package's own budget and deadline still apply beneath them.
   */
  limits: HostExecutionLimits;
  /** Test-mode switches (D-028): off by default, shown in Settings → About. */
  developer: {
    /** Record every outbound model and tool request body of a run to the observation store, for the privacy checks. */
    record_requests: boolean;
  };
  /** Settings → Security (T16, D-192): after this many idle minutes the secret store locks; null means until the browser closes. */
  security: { idle_lock_minutes: number | null };
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  schema: "chrome-agent-browser-settings-v0",
  preset: DEFAULT_PRESET,
  models: {
    connections: [
      { provider: "ollama", enabled: true, base_url: null, overrides: {} },
      { provider: "openai", enabled: false, base_url: null, overrides: {} },
      { provider: "anthropic", enabled: false, base_url: null, overrides: {} },
      { provider: "chrome-builtin", enabled: true, base_url: null, overrides: {} },
    ],
    default_model: null,
  },
  services: { crossref_contact: null },
  limits: { ...DEFAULT_HOST_LIMITS },
  developer: { record_requests: false },
  security: { idle_lock_minutes: DEFAULT_IDLE_LOCK_MINUTES },
}) as Settings;

/** The minimal `chrome.storage.StorageArea` surface these adapters use. */
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryStorageArea implements StorageArea {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<Record<string, unknown>> {
    return this.data.has(key) ? { [key]: JSON.parse(JSON.stringify(this.data.get(key))) } : {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeOverrides(raw: unknown): Record<string, ModelOverride> {
  const out: Record<string, ModelOverride> = {};
  if (!isRecord(raw)) return out;
  for (const [modelId, value] of Object.entries(raw).slice(0, 64)) {
    if (!isRecord(value) || modelId.length === 0 || modelId.length > 256 || modelId === "__proto__") continue;
    const override: ModelOverride = {};
    if ("context_tokens" in value) override.context_tokens = positiveInt(value.context_tokens);
    if ("max_output_tokens" in value) override.max_output_tokens = positiveInt(value.max_output_tokens);
    if (typeof value.reasoning === "boolean") override.reasoning = value.reasoning;
    out[modelId] = override;
  }
  return out;
}

/**
 * Why an endpoint cannot be used for this provider, or null when it can. Ollama is reached on
 * this machine only (its models are described as local and free); a hosted provider over HTTPS
 * only. No credentials, query or fragment in either.
 */
export function endpointProblem(provider: ProviderId, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "is not a URL";
  }
  if (provider === "ollama") {
    if (!isLoopbackBase(url.href)) return `must be on this machine (${OLLAMA_LOOPBACK_HOSTS.join(", ")}), over HTTP or HTTPS: a remote Ollama's models would not be local`;
  } else if (url.protocol !== "https:") return "must use HTTPS";
  if (url.username || url.password || url.search || url.hash) return "must not carry credentials, a query or a fragment";
  return null;
}

/**
 * A pasted endpoint may end in the `/v1` the provider documents (`https://api.openai.com/v1`);
 * the catalog and the adapters append `/v1/...` themselves, so that suffix is dropped once
 * rather than doubled into `/v1/v1/models` (user feedback 2026-10-07, U4).
 */
export function normalizeBaseUrl(provider: ProviderId, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  if (endpointProblem(provider, raw) !== null) return null;
  const url = new URL(raw.trim());
  let path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  if (provider !== "ollama" && path.endsWith("/v1")) path = path.slice(0, -3);
  return url.origin + path;
}

/** Validate a stored or submitted settings object; unknown and malformed fields fall back to the defaults. */
export function normalizeSettings(raw: unknown): Settings {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
  if (!isRecord(raw)) return defaults;
  const models = isRecord(raw.models) ? raw.models : {};
  const connections = new Map(defaults.models.connections.map((connection) => [connection.provider, connection]));
  if (Array.isArray(models.connections)) {
    for (const item of models.connections) {
      if (!isRecord(item) || !(PROVIDER_IDS as readonly unknown[]).includes(item.provider)) continue;
      const provider = item.provider as ProviderId;
      connections.set(provider, {
        provider,
        enabled: item.enabled === true,
        base_url: provider === "chrome-builtin" ? null : normalizeBaseUrl(provider, item.base_url),
        overrides: normalizeOverrides(item.overrides),
        ...(provider === "ollama" && item.think === true ? { think: true } : {}),
        ...(provider === "openai" && (OPENAI_REASONING_EFFORTS as readonly unknown[]).includes(item.reasoning_effort) ? { reasoning_effort: item.reasoning_effort as OpenAIReasoningEffort } : {}),
      });
    }
  }
  const defaultModel = typeof models.default_model === "string" && models.default_model.length > 0 && models.default_model.length <= 300 ? models.default_model : null;
  const developer = isRecord(raw.developer) ? raw.developer : {};
  const services = isRecord(raw.services) ? raw.services : {};
  const security = isRecord(raw.security) ? raw.security : {};
  // The idle lock takes one of the offered values only; anything else is the default (never "no lock" by accident).
  const idle = security.idle_lock_minutes;
  const idleMinutes = (IDLE_LOCK_MINUTES as readonly unknown[]).includes(idle === undefined ? DEFAULT_IDLE_LOCK_MINUTES : idle) ? (idle as number | null) : DEFAULT_IDLE_LOCK_MINUTES;
  return {
    schema: "chrome-agent-browser-settings-v0",
    preset: isPresetId(raw.preset) ? raw.preset : DEFAULT_PRESET,
    models: { connections: [...connections.values()], default_model: defaultModel },
    services: { crossref_contact: validContact(services.crossref_contact) },
    limits: limitsOrDefaults(raw.limits),
    developer: { record_requests: developer.record_requests === true },
    security: { idle_lock_minutes: idle === undefined ? DEFAULT_IDLE_LOCK_MINUTES : idleMinutes },
  };
}

/** Stored limits, or the defaults when absent or not valid (a submitted value is checked by `settingsProblem` first). */
function limitsOrDefaults(raw: unknown): HostExecutionLimits {
  if (raw === undefined || raw === null) return { ...DEFAULT_HOST_LIMITS };
  try {
    return normalizeHostLimits(raw);
  } catch {
    return { ...DEFAULT_HOST_LIMITS };
  }
}

/**
 * What in a submitted settings object would be silently dropped by `normalizeSettings`, named so
 * the person learns why a value was not kept: a contact that is not one address, limits outside
 * `limits.ts`'s bounds. Null when nothing would be dropped.
 */
export function settingsProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.services)) {
    const contact = raw.services.crossref_contact;
    if (contact !== null && contact !== undefined && !(typeof contact === "string" && contact.trim() === "") && validContact(contact) === null) {
      return "The Crossref contact must be one e-mail address (or empty).";
    }
  }
  if (raw.limits !== undefined && raw.limits !== null) {
    try {
      normalizeHostLimits(raw.limits);
    } catch (error) {
      return `Run limits: ${error instanceof Error ? error.message : "invalid"}.`;
    }
  }
  return null;
}

/** The connections as the catalog builder needs them: the key's presence beside each stored connection. */
export function connectionsFor(settings: Settings, keys: Record<string, boolean>): ProviderConnection[] {
  return settings.models.connections.map((connection) => ({ ...connection, key_configured: keys[connection.provider] === true }));
}

const base64 = {
  encode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  },
  decode(text: string): Uint8Array {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  },
};

/** The 0.1.0 clear values the migration moves into the store (T16): present until the first passphrase is set. */
export interface LegacySecrets {
  provider_keys: Record<string, string>;
  vault: VaultDocument | null;
  vault_key: Uint8Array | null;
}

/**
 * The persistence the controller talks to; `chrome.storage.local` in the extension, memory in
 * tests. Keys and the vault go through the secret store (T16, D-191): `key`, `vaultDocument`,
 * `saveVaultDocument` and `vaultKey` refuse `store_no_passphrase` / `store_locked` as the store
 * does; `keyPresence` reads entry names, which a locked store still tells.
 */
export class SettingsStorage {
  constructor(
    private readonly area: StorageArea,
    private readonly secrets: SecretStore,
  ) {}

  async settings(): Promise<Settings> {
    return normalizeSettings((await this.area.get(SETTINGS_KEY))[SETTINGS_KEY]);
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    const normalized = normalizeSettings(settings);
    await this.area.set({ [SETTINGS_KEY]: normalized });
    return normalized;
  }

  /** The secret store itself, for the controller's lock, unlock and status requests. */
  get store(): SecretStore {
    return this.secrets;
  }

  /** Which hosted providers have a key; the key values never leave this class except to `key()`. Readable while locked. */
  async keyPresence(): Promise<Record<string, boolean>> {
    const presence: Record<string, boolean> = {};
    const names = new Set(await this.secrets.names()); // one envelope read for every provider (B-192)
    for (const provider of PROVIDER_IDS) if (provider !== "ollama" && provider !== "chrome-builtin" && names.has(PROVIDER_KEY_ENTRY(provider))) presence[provider] = true;
    return presence;
  }

  /** The key for one provider, for the service worker's transport and a run's start message only. */
  async key(provider: ProviderId): Promise<string | null> {
    if (provider === "ollama" || provider === "chrome-builtin") return null;
    if (!(await this.secrets.has(PROVIDER_KEY_ENTRY(provider)))) return null;
    const value = await this.secrets.getText(PROVIDER_KEY_ENTRY(provider));
    return value !== null && value.length > 0 ? value : null;
  }

  async setKey(provider: ProviderId, key: string | null): Promise<void> {
    if (key === null || key.trim().length === 0) {
      if (await this.secrets.has(PROVIDER_KEY_ENTRY(provider))) await this.secrets.delete(PROVIDER_KEY_ENTRY(provider));
      return;
    }
    const trimmed = key.trim();
    if (trimmed.length > 512 || /[\u0000-\u001f\u007f\s]/u.test(trimmed)) throw new TypeError("an API key must be one line of at most 512 printable characters");
    await this.secrets.putText(PROVIDER_KEY_ENTRY(provider), trimmed);
  }

  async vaultDocument(): Promise<VaultDocument> {
    const text = await this.secrets.getText(VAULT_ENTRY);
    if (text === null) return emptyVaultDocument();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return isRecord(parsed) ? (parsed as unknown as VaultDocument) : emptyVaultDocument();
  }

  async saveVaultDocument(document: VaultDocument): Promise<void> {
    await this.secrets.putText(VAULT_ENTRY, JSON.stringify(document));
  }

  /** The HMAC key, generated on first use and kept for the life of the store (D-051). */
  vaultKey(): Promise<Uint8Array> {
    return this.secrets.ensure(VAULT_KEY_ENTRY, (stored) => stored.length === KEY_BYTES, generateVaultKey);
  }

  // -- the migration from 0.1.0's clear storage (T16) ----------------------------------------
  /** The clear values 0.1.0 left, if any; read by the migration and by the "waiting" banner. */
  async legacySecrets(): Promise<LegacySecrets | null> {
    const keys = (await this.area.get(PROVIDER_KEYS_KEY))[PROVIDER_KEYS_KEY];
    const vault = (await this.area.get(VAULT_KEY))[VAULT_KEY];
    const vaultKey = (await this.area.get(VAULT_HMAC_KEY))[VAULT_HMAC_KEY];
    if (keys === undefined && vault === undefined && vaultKey === undefined) return null;
    const providerKeys: Record<string, string> = {};
    if (isRecord(keys)) for (const [name, value] of Object.entries(keys)) if ((PROVIDER_IDS as readonly string[]).includes(name) && typeof value === "string" && value.length > 0) providerKeys[name] = value;
    let hmac: Uint8Array | null = null;
    if (typeof vaultKey === "string") {
      try {
        const bytes = base64.decode(vaultKey);
        if (bytes.length === KEY_BYTES) hmac = bytes;
      } catch {
        hmac = null;
      }
    }
    return { provider_keys: providerKeys, vault: isRecord(vault) ? (vault as unknown as VaultDocument) : null, vault_key: hmac };
  }

  /**
   * Set the first passphrase: the envelope is created holding every clear value 0.1.0 left, and
   * those values are removed from `chrome.storage.local` in the same step. Refuses when a
   * passphrase already exists (`store_exists`).
   */
  async setPassphrase(passphrase: string): Promise<void> {
    const legacy = await this.legacySecrets();
    const entries: Record<string, Uint8Array> = {};
    if (legacy) {
      for (const [provider, value] of Object.entries(legacy.provider_keys)) if ((PROVIDER_IDS as readonly string[]).includes(provider)) entries[PROVIDER_KEY_ENTRY(provider as ProviderId)] = utf8.encode(value);
      if (legacy.vault) entries[VAULT_ENTRY] = utf8.encode(JSON.stringify(legacy.vault));
      if (legacy.vault_key) entries[VAULT_KEY_ENTRY] = legacy.vault_key;
    }
    await this.secrets.setup(passphrase, entries);
    await this.area.remove(PROVIDER_KEYS_KEY);
    await this.area.remove(VAULT_KEY);
    await this.area.remove(VAULT_HMAC_KEY);
  }

  async spentReceipts(): Promise<string[]> {
    const stored = (await this.area.get(SPENT_RECEIPTS_KEY))[SPENT_RECEIPTS_KEY];
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string").slice(-MAX_SPENT_RECEIPTS) : [];
  }

  async saveSpentReceipts(receiptIds: readonly string[]): Promise<void> {
    await this.area.set({ [SPENT_RECEIPTS_KEY]: [...new Set(receiptIds)].slice(-MAX_SPENT_RECEIPTS) });
  }

  async instanceId(): Promise<string> {
    const stored = (await this.area.get(INSTANCE_ID_KEY))[INSTANCE_ID_KEY];
    if (typeof stored === "string" && /^[A-Za-z0-9_-]{8,64}$/u.test(stored)) return stored;
    const fresh = crypto.randomUUID().replace(/-/gu, "");
    await this.area.set({ [INSTANCE_ID_KEY]: fresh });
    return fresh;
  }
}
