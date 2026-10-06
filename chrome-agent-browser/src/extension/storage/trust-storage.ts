/**
 * The trust store's persistence in `chrome.storage.local` (D-032), under one key, in the
 * Python `agentpkg-trust-store-v0` document format. Nothing goes to `storage.sync`.
 */
import type { TrustDocument, TrustStorage } from "../../core/trust.js";

export const TRUST_STORE_KEY = "trustStore";

export class ChromeTrustStorage implements TrustStorage {
  readonly location = `chrome.storage.local:${TRUST_STORE_KEY}`;

  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.local) {}

  async read(): Promise<unknown> {
    const stored = await this.area.get(TRUST_STORE_KEY);
    return stored[TRUST_STORE_KEY] ?? null;
  }

  async write(document: TrustDocument): Promise<void> {
    await this.area.set({ [TRUST_STORE_KEY]: document });
  }
}
