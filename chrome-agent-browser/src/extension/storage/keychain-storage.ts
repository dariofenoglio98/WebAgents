/**
 * Where keychain unlock's record lives (T17, D-204): `chrome.storage.local` under
 * `secretKeychain`, beside the envelope and outside it, so the envelope's format and its committed
 * vectors are unchanged and an older build never reads it as invalid. It holds the helper's blob
 * (the master key wrapped under a key only the helper's keychain item has) and a check box sealed
 * under the master key: neither opens anything without the other half.
 */
import { readKeychainRecord, type KeychainRecord } from "../../core/keychain.js";
import type { StorageArea } from "./settings.js";

export const SECRET_KEYCHAIN_KEY = "secretKeychain";

export class KeychainStorage {
  constructor(private readonly area: StorageArea) {}

  /** The stored record, or null when there is none or it is not one this build reads. */
  async load(): Promise<KeychainRecord | null> {
    return readKeychainRecord((await this.area.get(SECRET_KEYCHAIN_KEY))[SECRET_KEYCHAIN_KEY]);
  }

  async save(record: KeychainRecord): Promise<void> {
    await this.area.set({ [SECRET_KEYCHAIN_KEY]: record });
  }

  async clear(): Promise<void> {
    await this.area.remove(SECRET_KEYCHAIN_KEY);
  }
}
