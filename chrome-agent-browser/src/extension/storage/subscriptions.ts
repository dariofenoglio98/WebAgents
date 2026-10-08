/**
 * What the person added for finding and deciding (T8), in `chrome.storage.local` beside the
 * settings (D-032; never `storage.sync`):
 *
 *   indexes             the agent indexes the person added: URL, the key they pinned for it, whether
 *                       it is enabled, and the last signed document fetched (re-verified on every read)
 *   policySubscription  the one policy bundle the person subscribed to (D-103): URL, pinned key,
 *                       the signed document as fetched (re-verified on every read)
 *   library             agents the person pinned to the Library, and the ones they opened recently
 *
 * Signed documents are stored as the text that was verified, not as parsed content, so every
 * later answer is derived from bytes that are verified again when read.
 */
import { isRecord } from "../../core/fields.js";
import type { StorageArea } from "./settings.js";

export const INDEXES_KEY = "indexes";
export const POLICY_KEY = "policySubscription";
export const LIBRARY_KEY = "library";
export const MAX_INDEXES = 8;
export const MAX_PINNED = 64;
export const MAX_RECENT = 24;

/** A signed document as fetched: its text and when. */
export interface FetchedDocument {
  text: string;
  fetched_at: string;
}

export interface StoredIndex {
  url: string;
  /** The raw Ed25519 key (base64) the person pinned for this index, and its fingerprint. */
  key: string;
  key_fingerprint: string;
  added_at: string;
  enabled: boolean;
  document: FetchedDocument | null;
  last_error: { code: string; message: string; at: string } | null;
}

export interface StoredPolicy {
  url: string;
  key: string;
  key_fingerprint: string;
  subscribed_at: string;
  document: FetchedDocument;
  last_error: { code: string; message: string; at: string } | null;
}

/** One agent in the Library: where to open it again and what it was when last opened here. */
export interface LibraryEntry {
  package_url: string;
  /** The website the package was advertised on, when it was found there. */
  advertised_on: string | null;
  package_id: string;
  name: string;
  version: string;
  publisher: { id: string; name: string };
  digest: string;
  archive_sha256: string;
  signer_fingerprint: string | null;
  /** When it was pinned (pinned list) or last opened (recent list). */
  at: string;
}

export interface Library {
  pinned: LibraryEntry[];
  recent: LibraryEntry[];
}

const text = (value: unknown): value is string => typeof value === "string";

function errorOf(value: unknown): StoredIndex["last_error"] {
  return isRecord(value) && text(value.code) && text(value.message) && text(value.at) ? { code: value.code, message: value.message, at: value.at } : null;
}

function documentOf(value: unknown): FetchedDocument | null {
  return isRecord(value) && text(value.text) && text(value.fetched_at) ? { text: value.text, fetched_at: value.fetched_at } : null;
}

function indexOf(value: unknown): StoredIndex | null {
  if (!isRecord(value) || !text(value.url) || !text(value.key) || !text(value.key_fingerprint) || !text(value.added_at)) return null;
  return { url: value.url, key: value.key, key_fingerprint: value.key_fingerprint, added_at: value.added_at, enabled: value.enabled !== false, document: documentOf(value.document), last_error: errorOf(value.last_error) };
}

function entryOf(value: unknown): LibraryEntry | null {
  if (!isRecord(value) || !isRecord(value.publisher)) return null;
  const fields = ["package_url", "package_id", "name", "version", "digest", "archive_sha256", "at"] as const;
  if (!fields.every((field) => text(value[field])) || !text(value.publisher.id) || !text(value.publisher.name)) return null;
  return {
    package_url: value.package_url as string,
    advertised_on: text(value.advertised_on) ? value.advertised_on : null,
    package_id: value.package_id as string,
    name: value.name as string,
    version: value.version as string,
    publisher: { id: value.publisher.id, name: value.publisher.name },
    digest: value.digest as string,
    archive_sha256: value.archive_sha256 as string,
    signer_fingerprint: text(value.signer_fingerprint) ? value.signer_fingerprint : null,
    at: value.at as string,
  };
}

/** The persistence the controller talks to: `chrome.storage.local` in the extension, memory in tests. */
export class SubscriptionStorage {
  /** Read-modify-write steps run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

  private serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async indexes(): Promise<StoredIndex[]> {
    const stored = (await this.area.get(INDEXES_KEY))[INDEXES_KEY];
    return Array.isArray(stored) ? stored.map(indexOf).filter((item): item is StoredIndex => item !== null).slice(0, MAX_INDEXES) : [];
  }

  /** Change the index list in one step; `change` returns the new list. */
  updateIndexes(change: (indexes: StoredIndex[]) => StoredIndex[]): Promise<StoredIndex[]> {
    return this.serialized(async () => {
      const next = change(await this.indexes());
      await this.area.set({ [INDEXES_KEY]: next });
      return next;
    });
  }

  async policy(): Promise<StoredPolicy | null> {
    const value = (await this.area.get(POLICY_KEY))[POLICY_KEY];
    if (!isRecord(value) || !text(value.url) || !text(value.key) || !text(value.key_fingerprint) || !text(value.subscribed_at)) return null;
    const document = documentOf(value.document);
    if (document === null) return null;
    return { url: value.url, key: value.key, key_fingerprint: value.key_fingerprint, subscribed_at: value.subscribed_at, document, last_error: errorOf(value.last_error) };
  }

  savePolicy(policy: StoredPolicy | null): Promise<void> {
    return this.serialized(async () => {
      if (policy === null) await this.area.remove(POLICY_KEY);
      else await this.area.set({ [POLICY_KEY]: policy });
    });
  }

  async library(): Promise<Library> {
    const value = (await this.area.get(LIBRARY_KEY))[LIBRARY_KEY];
    const list = (raw: unknown, max: number) => (Array.isArray(raw) ? raw.map(entryOf).filter((item): item is LibraryEntry => item !== null).slice(0, max) : []);
    return isRecord(value) ? { pinned: list(value.pinned, MAX_PINNED), recent: list(value.recent, MAX_RECENT) } : { pinned: [], recent: [] };
  }

  /** Change the Library in one step. */
  updateLibrary(change: (library: Library) => Library): Promise<Library> {
    return this.serialized(async () => {
      const next = change(await this.library());
      const bounded = { pinned: next.pinned.slice(0, MAX_PINNED), recent: next.recent.slice(0, MAX_RECENT) };
      await this.area.set({ [LIBRARY_KEY]: bounded });
      return bounded;
    });
  }
}
