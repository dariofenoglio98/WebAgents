/**
 * Settings, provider keys, the vault and the install identity, all in `chrome.storage.local`
 * (D-032, D-051, D-055). Nothing ever goes to `storage.sync`: a key or a personal record must
 * never leave this browser profile through account sync.
 *
 *   settings      the host preset, the model connections (no key), the default model
 *   providerKeys  one API key per hosted provider; read only by the service worker's transport
 *   vault         the vault document (types and records); digests are recomputed on open
 *   vaultKey      the HMAC key (base64, 32 bytes), generated once per profile
 *   instanceId    the control plane's instance id, generated once per install
 */
import { DEFAULT_PRESET, isPresetId } from "../../core/authorization.js";
import { isRecord } from "../../core/fields.js";
import type { ModelOverride, ProviderConnection, ProviderId } from "../../core/models/catalog.js";
import { isLoopbackBase, OLLAMA_LOOPBACK_HOSTS, PROVIDER_IDS } from "../../core/models/catalog.js";
import type { PresetId } from "../../core/types.js";
import { emptyVaultDocument, generateVaultKey, KEY_BYTES, type VaultDocument } from "../../core/vault.js";

export const SETTINGS_KEY = "settings";
export const PROVIDER_KEYS_KEY = "providerKeys";
export const VAULT_KEY = "vault";
export const VAULT_HMAC_KEY = "vaultKey";
export const INSTANCE_ID_KEY = "instanceId";

/** A connection as stored and shown: the key itself is elsewhere, only its presence is reported. */
export interface StoredConnection {
  provider: ProviderId;
  enabled: boolean;
  base_url: string | null;
  overrides: Record<string, ModelOverride>;
}

export interface Settings {
  schema: "chrome-agent-browser-settings-v0";
  preset: PresetId;
  models: {
    connections: StoredConnection[];
    /** The host model id (`provider/model`) the two-click path binds; null until the person picks one. */
    default_model: string | null;
  };
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

function normalizeBaseUrl(provider: ProviderId, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  if (endpointProblem(provider, raw) !== null) return null;
  const url = new URL(raw.trim());
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, ""));
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
      });
    }
  }
  const defaultModel = typeof models.default_model === "string" && models.default_model.length > 0 && models.default_model.length <= 300 ? models.default_model : null;
  return {
    schema: "chrome-agent-browser-settings-v0",
    preset: isPresetId(raw.preset) ? raw.preset : DEFAULT_PRESET,
    models: { connections: [...connections.values()], default_model: defaultModel },
  };
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

/** The persistence the controller talks to; `chrome.storage.local` in the extension, memory in tests. */
export class SettingsStorage {
  constructor(private readonly area: StorageArea) {}

  async settings(): Promise<Settings> {
    return normalizeSettings((await this.area.get(SETTINGS_KEY))[SETTINGS_KEY]);
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    const normalized = normalizeSettings(settings);
    await this.area.set({ [SETTINGS_KEY]: normalized });
    return normalized;
  }

  /** Which hosted providers have a key; the key values never leave this class except to `key()`. */
  async keyPresence(): Promise<Record<string, boolean>> {
    const stored = (await this.area.get(PROVIDER_KEYS_KEY))[PROVIDER_KEYS_KEY];
    const presence: Record<string, boolean> = {};
    if (isRecord(stored)) for (const [provider, value] of Object.entries(stored)) presence[provider] = typeof value === "string" && value.length > 0;
    return presence;
  }

  /** The key for one provider, for the service worker's transport only. */
  async key(provider: ProviderId): Promise<string | null> {
    const stored = (await this.area.get(PROVIDER_KEYS_KEY))[PROVIDER_KEYS_KEY];
    const value = isRecord(stored) ? stored[provider] : undefined;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  async setKey(provider: ProviderId, key: string | null): Promise<void> {
    const stored = (await this.area.get(PROVIDER_KEYS_KEY))[PROVIDER_KEYS_KEY];
    const keys: Record<string, string> = {};
    if (isRecord(stored)) for (const [name, value] of Object.entries(stored)) if (typeof value === "string" && value.length > 0) keys[name] = value;
    if (key === null || key.trim().length === 0) delete keys[provider];
    else {
      const trimmed = key.trim();
      if (trimmed.length > 512 || /[\u0000-\u001f\u007f\s]/u.test(trimmed)) throw new TypeError("an API key must be one line of at most 512 printable characters");
      keys[provider] = trimmed;
    }
    await this.area.set({ [PROVIDER_KEYS_KEY]: keys });
  }

  async vaultDocument(): Promise<VaultDocument> {
    const stored = (await this.area.get(VAULT_KEY))[VAULT_KEY];
    return isRecord(stored) ? (stored as unknown as VaultDocument) : emptyVaultDocument();
  }

  async saveVaultDocument(document: VaultDocument): Promise<void> {
    await this.area.set({ [VAULT_KEY]: document });
  }

  /** The HMAC key, generated on first use and kept for the life of the profile (D-051). */
  async vaultKey(): Promise<Uint8Array> {
    const stored = (await this.area.get(VAULT_HMAC_KEY))[VAULT_HMAC_KEY];
    if (typeof stored === "string") {
      const bytes = base64.decode(stored);
      if (bytes.length === KEY_BYTES) return bytes;
    }
    const fresh = generateVaultKey();
    await this.area.set({ [VAULT_HMAC_KEY]: base64.encode(fresh) });
    return fresh;
  }

  async instanceId(): Promise<string> {
    const stored = (await this.area.get(INSTANCE_ID_KEY))[INSTANCE_ID_KEY];
    if (typeof stored === "string" && /^[A-Za-z0-9_-]{8,64}$/u.test(stored)) return stored;
    const fresh = crypto.randomUUID().replace(/-/gu, "");
    await this.area.set({ [INSTANCE_ID_KEY]: fresh });
    return fresh;
  }
}
