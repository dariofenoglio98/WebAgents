/**
 * The in-browser model cache (T41, D-444, D-451, D-452): the weights a person chose to download,
 * kept as a visible, deletable browser cache, never an installation.
 *
 *   IndexedDB `models` (database version 7)  one row per entry the person listed or downloaded:
 *                the entry as it stood at the download (curated or pasted), its files' state,
 *                `downloaded_at`, `last_used`, `verified_at`, the header facts read from the
 *                cached bytes, the speed measured on this machine, a context at which a load died
 *   OPFS `models/<sha256>`                   each file under its own SHA-256 (a partial download is
 *                `models/<sha256>.part`); keyed by digest, which is what provenance (T42) and
 *                Cross-Origin Storage (D-448) both want
 *
 * The downloader (`downloadFile`) runs in a dedicated Worker of the offscreen document
 * (`models-worker.ts`) over OPFS sync access handles, so a partial file survives a crash and a
 * resume never copies it; here it is written against `ModelBlobStore`, which tests implement in
 * memory. Every file's SHA-256 is computed while streaming (`@noble/hashes`, incremental) and
 * compared with the entry's before the file is kept; a mismatch deletes the file and reports "the
 * bytes did not match the digest the catalog states", never "try anyway". A person's cancel leaves
 * no file; an interrupted transfer leaves its partial file for an HTTP `Range` resume.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { readGgufHeader, type GgufHeaderFacts } from "../../core/models/gguf-header.js";
import { checkModelFileUrl, type InBrowserEntry, type InBrowserFile, type InBrowserHeader } from "../../core/models/in-browser-catalog.js";
import { completion, request, type Database } from "./database.js";

export const MODELS_DIRECTORY = "models";
export const PART_SUFFIX = ".part";
/** How much of a file is read or hashed per step. */
export const CHUNK_BYTES = 8 * 1024 * 1024;

export type FileState = "missing" | "partial" | "complete";

export interface ModelFileRecord {
  name: string;
  sha256: string;
  bytes: number;
  state: FileState;
}

export interface ModelRecord {
  entry_id: string;
  /** The entry as listed (curated: from the verified list; pasted: built from the repository's API). */
  entry: InBrowserEntry;
  files: ModelFileRecord[];
  /** Every file complete and its digest matched when it was kept or last verified. */
  verified: boolean;
  /** Set when a verification found a file whose bytes no longer match: delete and download again. */
  mismatch: boolean;
  downloaded_at: string | null;
  verified_at: string | null;
  last_used: string | null;
  listed_at: string;
  /** The GGUF header facts read from the cached first file, with the basis of the head width. */
  header: (InBrowserHeader & { context_length: number | null; architecture: string; general_name: string | null }) | null;
  /** Measured on this machine after a load: the first completion's speeds and the context it ran at. */
  measured: { prefill_tok_per_s: number; decode_tok_per_s: number; context: number; at: string } | null;
  /** A load whose engine Worker died at this context (D-441); never retried by itself. */
  failed_context: number | null;
  /** The last download or verification that did not succeed, in words a person can act on. */
  last_error: { code: string; message: string; at: string } | null;
}

export interface ModelStore {
  get(entryId: string): Promise<ModelRecord | null>;
  list(): Promise<ModelRecord[]>;
  put(record: ModelRecord): Promise<void>;
  delete(entryId: string): Promise<void>;
  /** Read, change and write one row atomically; `change` returning null leaves it alone. */
  update(entryId: string, change: (current: ModelRecord | null) => ModelRecord | null): Promise<ModelRecord | null>;
}

export class IndexedDbModelStore implements ModelStore {
  constructor(private readonly database: Database) {}

  async get(entryId: string): Promise<ModelRecord | null> {
    const store = await this.database.store("models", "readonly");
    return ((await request(store.get(entryId))) as ModelRecord | undefined) ?? null;
  }

  async list(): Promise<ModelRecord[]> {
    const store = await this.database.store("models", "readonly");
    return (await request(store.getAll())) as ModelRecord[];
  }

  async put(record: ModelRecord): Promise<void> {
    const transaction = await this.database.transaction(["models"], "readwrite");
    transaction.objectStore("models").put(record);
    await completion(transaction);
  }

  async delete(entryId: string): Promise<void> {
    const transaction = await this.database.transaction(["models"], "readwrite");
    transaction.objectStore("models").delete(entryId);
    await completion(transaction);
  }

  async update(entryId: string, change: (current: ModelRecord | null) => ModelRecord | null): Promise<ModelRecord | null> {
    const transaction = await this.database.transaction(["models"], "readwrite");
    const store = transaction.objectStore("models");
    const current = ((await request(store.get(entryId))) as ModelRecord | undefined) ?? null;
    const next = change(current);
    if (next !== null) store.put(next);
    await completion(transaction);
    return next ?? current;
  }
}

export class MemoryModelStore implements ModelStore {
  readonly rows = new Map<string, ModelRecord>();
  async get(entryId: string): Promise<ModelRecord | null> {
    const row = this.rows.get(entryId);
    return row ? structuredClone(row) : null;
  }
  async list(): Promise<ModelRecord[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
  async put(record: ModelRecord): Promise<void> {
    this.rows.set(record.entry_id, structuredClone(record));
  }
  async delete(entryId: string): Promise<void> {
    this.rows.delete(entryId);
  }
  async update(entryId: string, change: (current: ModelRecord | null) => ModelRecord | null): Promise<ModelRecord | null> {
    const current = await this.get(entryId);
    const next = change(current);
    if (next !== null) await this.put(next);
    return next ?? current;
  }
}

/** A new row for an entry the person listed (a curated entry at its first download, a pasted one at once). */
export function newModelRecord(entry: InBrowserEntry, now: Date): ModelRecord {
  return {
    entry_id: entry.id,
    entry,
    files: entry.files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes, state: "missing" })),
    verified: false,
    mismatch: false,
    downloaded_at: null,
    verified_at: null,
    last_used: null,
    listed_at: now.toISOString(),
    header: null,
    measured: null,
    failed_context: null,
    last_error: null,
  };
}

/** Whether every file of a row is complete and verified (the descriptor's `cached` and `verified`). */
export function cacheState(record: ModelRecord | null): { cached: boolean; verified: boolean } {
  if (record === null) return { cached: false, verified: false };
  const cached = record.files.length > 0 && record.files.every((file) => file.state === "complete");
  return { cached, verified: cached && record.verified && !record.mismatch };
}

/** The header facts an entry carries for the estimate: the ones read from the cached bytes outrank the list's (the digest binds the bytes). */
export function headerFromFacts(facts: GgufHeaderFacts): NonNullable<ModelRecord["header"]> {
  return {
    n_layer: facts.n_layer,
    n_kv_heads: facts.n_kv_heads,
    key_length: facts.key_length,
    value_length: facts.value_length,
    ...(facts.key_length_basis === "attention.key_length" ? {} : { width_basis: "embedding" as const }),
    context_length: facts.context_length,
    architecture: facts.architecture,
    general_name: facts.general_name,
  };
}

/** The entry the descriptor and the engine host see: the cached header when one was read. */
export function effectiveEntry(entry: InBrowserEntry, record: ModelRecord | null): InBrowserEntry {
  const header = record?.header ?? null;
  if (header === null) return entry;
  return { ...entry, header: { n_layer: header.n_layer, n_kv_heads: header.n_kv_heads, key_length: header.key_length, value_length: header.value_length, ...(header.width_basis ? { width_basis: header.width_basis } : {}) } };
}

// -- the files ---------------------------------------------------------------------------------

/** One open file: positional writes, as an OPFS sync access handle gives them. */
export interface BlobWriter {
  size(): Promise<number>;
  write(data: Uint8Array, at: number): Promise<void>;
  truncate(size: number): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** The cache's files by name (`<sha256>` or `<sha256>.part`); OPFS in the Worker, memory in tests. */
export interface ModelBlobStore {
  size(name: string): Promise<number | null>;
  /** Read `length` bytes at `offset` (fewer only at the end). */
  read(name: string, offset: number, length: number): Promise<Uint8Array>;
  open(name: string): Promise<BlobWriter>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<Array<{ name: string; size: number }>>;
}

export class MemoryBlobStore implements ModelBlobStore {
  readonly files = new Map<string, Uint8Array>();
  async size(name: string): Promise<number | null> {
    return this.files.get(name)?.length ?? null;
  }
  async read(name: string, offset: number, length: number): Promise<Uint8Array> {
    const data = this.files.get(name);
    if (!data) throw new Error(`${name} is not in the cache`);
    return data.slice(offset, offset + length);
  }
  async open(name: string): Promise<BlobWriter> {
    const files = this.files;
    if (!files.has(name)) files.set(name, new Uint8Array(0));
    return {
      size: async () => files.get(name)!.length,
      write: async (data, at) => {
        const current = files.get(name)!;
        const next = new Uint8Array(Math.max(current.length, at + data.length));
        next.set(current);
        next.set(data, at);
        files.set(name, next);
      },
      truncate: async (size) => {
        files.set(name, files.get(name)!.slice(0, size));
      },
      flush: async () => undefined,
      close: async () => undefined,
    };
  }
  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (!data) throw new Error(`${from} is not in the cache`);
    this.files.set(to, data);
    this.files.delete(from);
  }
  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }
  async list(): Promise<Array<{ name: string; size: number }>> {
    return [...this.files.entries()].map(([name, data]) => ({ name, size: data.length }));
  }
}

export class DigestMismatchError extends Error {
  readonly code = "model_digest_mismatch";
  constructor(readonly file: string) {
    super("the bytes did not match the digest the catalog states");
    this.name = "DigestMismatchError";
  }
}

export class DownloadError extends Error {
  constructor(
    readonly code: "model_download_failed" | "model_download_cancelled" | "model_download_interrupted" | "url_rejected",
    message: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DownloadProgress {
  file: string;
  sha256: string;
  bytes_done: number;
  bytes_total: number;
  /** Bytes taken from an earlier partial file (a `Range` resume), not transferred now. */
  resumed_from: number;
  /** True while a complete cached file is re-hashed before it is kept (T41 review 2, nit 6): `bytes_done` counts the bytes read. */
  verifying?: boolean;
}

export interface DownloadOptions {
  store: ModelBlobStore;
  fetch: FetchLike;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

async function hashExisting(store: ModelBlobStore, name: string, size: number, hasher: ReturnType<typeof sha256.create>, signal: AbortSignal): Promise<void> {
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    if (signal.aborted) throw new DownloadError("model_download_cancelled", "the download was cancelled");
    hasher.update(await store.read(name, offset, Math.min(CHUNK_BYTES, size - offset)));
  }
}

/** Remove a partial file, ignoring a file already gone. */
async function discard(store: ModelBlobStore, name: string): Promise<void> {
  try {
    await store.remove(name);
  } catch {
    // already gone
  }
}

/**
 * Download one file into the cache under its digest (D-452). The URL is checked before any fetch
 * (`checkModelFileUrl`). A complete file already in the cache is not fetched again once its bytes
 * are re-hashed and match; one that does not match is deleted and fetched again. A partial file
 * is resumed with `Range: bytes=<n>-` when the server answers 206 for exactly that offset (its
 * bytes are hashed first, so the digest still covers the whole file), and restarted otherwise.
 * Returns the digest computed while streaming; a mismatch deletes the file and throws
 * `DigestMismatchError`; the person's cancel deletes the partial file; a transfer that ends early
 * keeps it for a resume and throws `model_download_interrupted`.
 */
export async function downloadFile(file: InBrowserFile, options: DownloadOptions): Promise<{ sha256: string; bytes: number; resumed_from: number; fetched: boolean }> {
  const { store, signal } = options;
  let url: string;
  try {
    url = checkModelFileUrl(file.url);
  } catch (error) {
    throw new DownloadError("url_rejected", error instanceof Error ? error.message : "the file URL is refused");
  }
  const final = file.sha256;
  const part = `${final}${PART_SUFFIX}`;
  const kept = await store.size(final);
  if (kept === file.bytes) {
    // A file already in the cache is trusted by its bytes, never by its size (T41 review 1,
    // finding 3): one read, the cost of a Verify; one that no longer matches is dropped and fetched again.
    const reread = (done: number): void => options.onProgress?.({ file: file.name, sha256: final, bytes_done: done, bytes_total: file.bytes, resumed_from: 0, verifying: true });
    reread(0);
    if (await verifyFile(store, file, signal, reread)) return { sha256: final, bytes: file.bytes, resumed_from: file.bytes, fetched: false };
    await discard(store, final);
  } else if (kept !== null) {
    await discard(store, final);
  }
  let have = (await store.size(part)) ?? 0;
  if (have > file.bytes) {
    await discard(store, part);
    have = 0;
  }
  let hasher = sha256.create();
  const cancelled = () => new DownloadError("model_download_cancelled", "the download was cancelled");
  let writer: BlobWriter | null = null;
  try {
    if (have > 0) await hashExisting(store, part, have, hasher, signal);
    let response: Response;
    try {
      response = await options.fetch(url, { method: "GET", headers: have > 0 ? { range: `bytes=${have}-` } : {}, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "follow", signal });
    } catch (error) {
      if (signal.aborted) throw cancelled();
      throw new DownloadError("model_download_interrupted", `the connection failed (${error instanceof Error ? error.name : "error"})`);
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(response.headers.get("content-range") ?? "");
    const resumed = have > 0 && response.status === 206 && range !== null && Number(range[1]) === have;
    if (!resumed) {
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new DownloadError("model_download_failed", `the server answered HTTP ${response.status}`);
      }
      // A restart: the partial bytes are not reused.
      have = 0;
      hasher = sha256.create();
    }
    writer = await store.open(part);
    if (!resumed) await writer.truncate(0);
    const resumedFrom = have;
    let at = have;
    options.onProgress?.({ file: file.name, sha256: final, bytes_done: at, bytes_total: file.bytes, resumed_from: resumedFrom });
    if (!response.body) throw new DownloadError("model_download_failed", "the response has no body");
    const reader = response.body.getReader();
    let lastReport = 0;
    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (error) {
          if (signal.aborted) throw cancelled();
          throw new DownloadError("model_download_interrupted", `the transfer stopped at ${at} of ${file.bytes} bytes (${error instanceof Error ? error.name : "error"})`);
        }
        if (step.done) break;
        const chunk = step.value;
        if (at + chunk.length > file.bytes) {
          await reader.cancel().catch(() => undefined);
          throw new DigestMismatchError(file.name);
        }
        await writer.write(chunk, at);
        hasher.update(chunk);
        at += chunk.length;
        if (at - lastReport >= CHUNK_BYTES || at === file.bytes) {
          lastReport = at;
          options.onProgress?.({ file: file.name, sha256: final, bytes_done: at, bytes_total: file.bytes, resumed_from: resumedFrom });
        }
        if (signal.aborted) throw cancelled();
      }
    } finally {
      reader.releaseLock();
    }
    await writer.flush();
    await writer.close();
    writer = null;
    if (at < file.bytes) throw new DownloadError("model_download_interrupted", `the transfer ended at ${at} of ${file.bytes} bytes`);
    const digest = bytesToHex(hasher.digest());
    if (digest !== final) throw new DigestMismatchError(file.name);
    await store.rename(part, final);
    return { sha256: digest, bytes: at, resumed_from: resumedFrom, fetched: true };
  } catch (error) {
    if (writer !== null) await writer.close().catch(() => undefined);
    // A mismatch keeps no byte; the person's cancel leaves no file; an interruption keeps the partial file for a resume.
    if (error instanceof DigestMismatchError || (error instanceof DownloadError && (error.code === "model_download_cancelled" || error.code === "model_download_failed"))) await discard(store, part);
    if (signal.aborted && !(error instanceof DigestMismatchError)) {
      await discard(store, part);
      throw cancelled();
    }
    throw error;
  }
}

/** Re-hash one cached file (Verify, D-444): true when its bytes still give the digest it is named by. */
export async function verifyFile(store: ModelBlobStore, file: Pick<InBrowserFile, "sha256" | "bytes">, signal: AbortSignal, onProgress?: (done: number) => void): Promise<boolean> {
  const size = await store.size(file.sha256);
  if (size === null || size !== file.bytes) return false;
  const hasher = sha256.create();
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    if (signal.aborted) throw new DownloadError("model_download_cancelled", "the verification was cancelled");
    hasher.update(await store.read(file.sha256, offset, Math.min(CHUNK_BYTES, size - offset)));
    onProgress?.(Math.min(size, offset + CHUNK_BYTES));
  }
  return bytesToHex(hasher.digest()) === file.sha256;
}

/** The GGUF header of a cached file (its first bytes only), for the entry's estimate (design §3). */
export function readCachedHeader(store: ModelBlobStore, sha256Hex: string, size: number): Promise<GgufHeaderFacts> {
  return readGgufHeader((offset, length) => store.read(sha256Hex, offset, length), size);
}
