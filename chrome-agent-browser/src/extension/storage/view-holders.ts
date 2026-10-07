/**
 * Which views hold each session (D-056 as amended): kept in `chrome.storage.session`, beside the
 * per-tab candidates (D-032), so a service-worker restart (Chrome stops an idle worker after
 * about 30 s) does not forget that a full page still shows the session a side panel releases.
 * Cleared when the browser closes, like the candidates.
 *
 * Each holder names the view (`view_id`, chosen by the page) and, when Chrome reported one, the
 * document it lives in (`document_id`, from the message sender), so the worker can drop holders
 * whose page closed without releasing (`chrome.runtime.getContexts`).
 */

export interface ViewHolder {
  view_id: string;
  document_id: string | null;
}

export interface ViewHolderStore {
  get(sessionId: string): Promise<ViewHolder[]>;
  set(sessionId: string, holders: readonly ViewHolder[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

const PREFIX = "holders:";

function holdersFrom(value: unknown): ViewHolder[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { view_id: string; document_id?: unknown } => typeof item === "object" && item !== null && typeof (item as { view_id?: unknown }).view_id === "string")
    .map((item) => ({ view_id: item.view_id, document_id: typeof item.document_id === "string" ? item.document_id : null }));
}

export class ChromeViewHolderStore implements ViewHolderStore {
  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.session) {}

  async get(sessionId: string): Promise<ViewHolder[]> {
    const stored = await this.area.get(`${PREFIX}${sessionId}`);
    return holdersFrom(stored[`${PREFIX}${sessionId}`]);
  }

  async set(sessionId: string, holders: readonly ViewHolder[]): Promise<void> {
    await this.area.set({ [`${PREFIX}${sessionId}`]: holders.map((holder) => ({ ...holder })) });
  }

  async clear(sessionId: string): Promise<void> {
    await this.area.remove(`${PREFIX}${sessionId}`);
  }
}

export class MemoryViewHolderStore implements ViewHolderStore {
  readonly holders = new Map<string, ViewHolder[]>();

  async get(sessionId: string): Promise<ViewHolder[]> {
    return (this.holders.get(sessionId) ?? []).map((holder) => ({ ...holder }));
  }

  async set(sessionId: string, holders: readonly ViewHolder[]): Promise<void> {
    this.holders.set(
      sessionId,
      holders.map((holder) => ({ ...holder })),
    );
  }

  async clear(sessionId: string): Promise<void> {
    this.holders.delete(sessionId);
  }
}
