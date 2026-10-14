/**
 * Where the secret store lives in Chrome (T16, D-191): the envelope in `chrome.storage.local`
 * under `secretStore` (one JSON document, encrypted entries), the unlocked state (the master key
 * and the clock facts of the idle lock) in `chrome.storage.session` under `secretKey`, which
 * exists only in memory for the browser session and only for the extension's trusted contexts
 * (`setAccessLevel`, set by the service worker). Nothing here ever touches `storage.sync`.
 */
import type { EnvelopeStorage, SecretEnvelope, UnlockedState, UnlockedStateStorage } from "../../core/secrets.js";
import type { StorageArea } from "./settings.js";

export const SECRET_STORE_KEY = "secretStore";
export const SECRET_SESSION_KEY = "secretKey";

export class AreaEnvelopeStorage implements EnvelopeStorage {
  constructor(private readonly area: StorageArea) {}
  async load(): Promise<unknown> {
    return (await this.area.get(SECRET_STORE_KEY))[SECRET_STORE_KEY];
  }
  async save(envelope: SecretEnvelope): Promise<void> {
    await this.area.set({ [SECRET_STORE_KEY]: envelope });
  }
  async clear(): Promise<void> {
    await this.area.remove(SECRET_STORE_KEY);
  }
}

export class AreaUnlockedStateStorage implements UnlockedStateStorage {
  constructor(private readonly area: StorageArea) {}
  async load(): Promise<unknown> {
    return (await this.area.get(SECRET_SESSION_KEY))[SECRET_SESSION_KEY];
  }
  async save(state: UnlockedState): Promise<void> {
    await this.area.set({ [SECRET_SESSION_KEY]: state });
  }
  async clear(): Promise<void> {
    await this.area.remove(SECRET_SESSION_KEY);
  }
}
