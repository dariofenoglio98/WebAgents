/**
 * Per-tab candidate state (D-032): what the content script of each tab reported, judged by
 * the core, kept in `chrome.storage.session` so it survives a service-worker restart and is
 * cleared when the browser closes.
 */
import type { CandidateState } from "../messages.js";

export interface TabStateStore {
  get(tabId: number): Promise<CandidateState | null>;
  set(state: CandidateState): Promise<void>;
  clear(tabId: number): Promise<void>;
}

const PREFIX = "tab:";

export class ChromeTabStateStore implements TabStateStore {
  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.session) {}

  async get(tabId: number): Promise<CandidateState | null> {
    const stored = await this.area.get(`${PREFIX}${tabId}`);
    return (stored[`${PREFIX}${tabId}`] as CandidateState | undefined) ?? null;
  }

  async set(state: CandidateState): Promise<void> {
    await this.area.set({ [`${PREFIX}${state.tabId}`]: state });
  }

  async clear(tabId: number): Promise<void> {
    await this.area.remove(`${PREFIX}${tabId}`);
  }
}

export class MemoryTabStateStore implements TabStateStore {
  readonly states = new Map<number, CandidateState>();

  async get(tabId: number): Promise<CandidateState | null> {
    return this.states.get(tabId) ?? null;
  }

  async set(state: CandidateState): Promise<void> {
    this.states.set(state.tabId, state);
  }

  async clear(tabId: number): Promise<void> {
    this.states.delete(tabId);
  }
}
