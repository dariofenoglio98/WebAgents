/**
 * T41's model cache (`storage/models.ts`): the downloader over a fake fetch and the in-memory blob
 * store (URL refusals before any fetch, a full download, a `Range` resume, a restart when the server
 * ignores the range, a digest mismatch, a cancel, an interrupted transfer, a file already cached),
 * Verify, the cached GGUF header, and the row helpers. Every test file's digest is computed here
 * with `node:crypto`; curated facts are read from the committed `examples/` files.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readModelCatalog, type InBrowserEntry, type InBrowserFile } from "../../src/core/models/in-browser-catalog.js";
import {
  cacheState,
  DigestMismatchError,
  DownloadError,
  downloadFile,
  effectiveEntry,
  headerFromFacts,
  MemoryBlobStore,
  newModelRecord,
  PART_SUFFIX,
  readCachedHeader,
  verifyFile,
  type DownloadProgress,
  type FetchLike,
  type ModelRecord,
} from "../../src/extension/storage/models.js";
import { qwen3Header } from "../helpers/gguf.js";
import { PROJECT } from "../helpers/paths.js";

const ROOT = join(PROJECT, "..");
const CATALOG = readModelCatalog(JSON.parse(readFileSync(join(ROOT, "examples", "model-catalog.content.json"), "utf8")));
const HEADERS = JSON.parse(readFileSync(join(ROOT, "examples", "verification", "chrome-inbrowser-gguf-headers-t40.json"), "utf8")) as { files: Array<{ file: string; facts: { architecture: string; n_layer: number; head_count: number; n_kv_heads: number; key_length: number; value_length: number; embedding_length: number; context_length: number } }> };

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const testBytes = (length: number, seed = 7): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff);
const fileFor = (bytes: Uint8Array, name = "file.gguf"): InBrowserFile => ({ name, url: `https://huggingface.co/owner/repo/resolve/${REVISION}/${name}`, bytes: bytes.length, sha256: sha256Hex(bytes) });

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const rangeOf = (init: RequestInit): string | undefined => (init.headers as Record<string, string> | undefined)?.range;
const live = () => new AbortController().signal;

describe("downloadFile: URL refusals before any fetch", () => {
  const bytes = testBytes(64);
  const refused = [
    ["plain http", `http://huggingface.co/owner/repo/resolve/${REVISION}/file.gguf`],
    ["embedded credentials", `https://user:pw@huggingface.co/owner/repo/resolve/${REVISION}/file.gguf`],
    ["an IPv4 literal", "https://127.0.0.1/x.gguf"],
    ["an IPv6 literal", "https://[::1]/x.gguf"],
    ["another host", "https://evil.example/x.gguf"],
    ["a non-443 port", `https://huggingface.co:8443/owner/repo/resolve/${REVISION}/file.gguf`],
  ] as const;
  for (const [what, url] of refused) {
    it(`refuses ${what} with url_rejected and never fetches`, async () => {
      // The URL gate runs first: the fetch must not be called at all.
      const { fetch, calls } = fakeFetch(() => new Response(streamOf([bytes]), { status: 200 }));
      const store = new MemoryBlobStore();
      const attempt = downloadFile({ ...fileFor(bytes), url }, { store, fetch, signal: live() });
      await expect(attempt).rejects.toBeInstanceOf(DownloadError);
      await expect(attempt).rejects.toMatchObject({ code: "url_rejected" });
      expect(calls).toHaveLength(0);
      expect(store.files.size).toBe(0);
    });
  }
});

describe("downloadFile: transfers", () => {
  it("keeps a full download under its SHA-256, leaves no partial file, and reports progress", async () => {
    // Several chunks, one GET without a range, the digest computed while streaming.
    const bytes = testBytes(3000);
    const file = fileFor(bytes);
    const { fetch, calls } = fakeFetch(() => new Response(streamOf([bytes.slice(0, 1000), bytes.slice(1000, 2000), bytes.slice(2000)]), { status: 200 }));
    const store = new MemoryBlobStore();
    const progress: DownloadProgress[] = [];
    const result = await downloadFile(file, { store, fetch, signal: live(), onProgress: (item) => progress.push(item) });
    expect(result).toEqual({ sha256: file.sha256, bytes: bytes.length, resumed_from: 0, fetched: true });
    expect(store.files.get(file.sha256)).toEqual(bytes);
    expect(store.files.has(`${file.sha256}${PART_SUFFIX}`)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(file.url);
    expect(rangeOf(calls[0]!.init)).toBeUndefined();
    expect(calls[0]!.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(progress[0]).toMatchObject({ file: file.name, sha256: file.sha256, bytes_done: 0, bytes_total: bytes.length, resumed_from: 0 });
    expect(progress.at(-1)).toMatchObject({ bytes_done: bytes.length, bytes_total: bytes.length });
  });

  it("resumes a partial file with Range at its byte offset and still checks the whole file's digest", async () => {
    // The .part holds the first N bytes; the server answers 206 for exactly that offset.
    const bytes = testBytes(2048);
    const file = fileFor(bytes);
    const have = 700;
    const store = new MemoryBlobStore();
    store.files.set(`${file.sha256}${PART_SUFFIX}`, bytes.slice(0, have));
    const { fetch, calls } = fakeFetch(() => new Response(streamOf([bytes.slice(have)]), { status: 206, headers: { "content-range": `bytes ${have}-${bytes.length - 1}/${bytes.length}` } }));
    const progress: DownloadProgress[] = [];
    const result = await downloadFile(file, { store, fetch, signal: live(), onProgress: (item) => progress.push(item) });
    expect(rangeOf(calls[0]!.init)).toBe(`bytes=${have}-`);
    expect(result).toEqual({ sha256: file.sha256, bytes: bytes.length, resumed_from: have, fetched: true });
    expect(store.files.get(file.sha256)).toEqual(bytes);
    expect(store.files.has(`${file.sha256}${PART_SUFFIX}`)).toBe(false);
    expect(progress[0]).toMatchObject({ bytes_done: have, resumed_from: have });
  });

  it("restarts from zero when the server ignores the range and answers 200 with the whole file", async () => {
    // A 200 to a ranged request is the whole file: the partial bytes are not reused.
    const bytes = testBytes(1500);
    const file = fileFor(bytes);
    const store = new MemoryBlobStore();
    store.files.set(`${file.sha256}${PART_SUFFIX}`, bytes.slice(0, 400));
    const { fetch, calls } = fakeFetch(() => new Response(streamOf([bytes]), { status: 200 }));
    const result = await downloadFile(file, { store, fetch, signal: live() });
    expect(rangeOf(calls[0]!.init)).toBe("bytes=400-");
    expect(result).toMatchObject({ sha256: file.sha256, resumed_from: 0, fetched: true });
    expect(store.files.get(file.sha256)).toEqual(bytes);
  });

  it("refuses a 206 for another offset (not a resume, not a 200) and drops the partial file", async () => {
    // Only a 206 that starts exactly at the partial size is a resume; anything else that is not a 200 fails.
    const bytes = testBytes(1500);
    const file = fileFor(bytes);
    const store = new MemoryBlobStore();
    store.files.set(`${file.sha256}${PART_SUFFIX}`, bytes.slice(0, 400));
    const { fetch } = fakeFetch(() => new Response(streamOf([bytes.slice(300)]), { status: 206, headers: { "content-range": `bytes 300-${bytes.length - 1}/${bytes.length}` } }));
    await expect(downloadFile(file, { store, fetch, signal: live() })).rejects.toMatchObject({ code: "model_download_failed" });
    expect(store.files.size).toBe(0);
  });

  it("deletes everything when the bytes do not give the stated digest", async () => {
    // The stated length, other bytes: a mismatch keeps no byte and never says "try anyway".
    const bytes = testBytes(1024);
    const file = fileFor(bytes);
    const { fetch } = fakeFetch(() => new Response(streamOf([testBytes(1024, 99)]), { status: 200 }));
    const store = new MemoryBlobStore();
    const attempt = downloadFile(file, { store, fetch, signal: live() });
    await expect(attempt).rejects.toBeInstanceOf(DigestMismatchError);
    await expect(attempt).rejects.toMatchObject({ code: "model_digest_mismatch", file: file.name });
    expect(store.files.size).toBe(0);
  });

  it("treats more bytes than the entry states as a mismatch and keeps nothing", async () => {
    // The server streams past the stated size: stopped at once, nothing kept.
    const bytes = testBytes(1024);
    const file = fileFor(bytes);
    const { fetch } = fakeFetch(() => new Response(streamOf([bytes, testBytes(10)]), { status: 200 }));
    const store = new MemoryBlobStore();
    await expect(downloadFile(file, { store, fetch, signal: live() })).rejects.toBeInstanceOf(DigestMismatchError);
    expect(store.files.size).toBe(0);
  });

  it("leaves no file at all when the person cancels mid-stream", async () => {
    // One chunk arrives, then the transfer waits; the abort errors the body as a real fetch would.
    const bytes = testBytes(2000);
    const file = fileFor(bytes);
    const controller = new AbortController();
    const { fetch } = fakeFetch((_url, init) => {
      const signal = init.signal!;
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          pulls += 1;
          if (pulls === 1) {
            stream.enqueue(bytes.slice(0, 500));
            return;
          }
          setTimeout(() => controller.abort(new Error("the person cancelled")), 0);
          return new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                stream.error(signal.reason);
                resolve();
              },
              { once: true },
            );
          });
        },
      });
      return new Response(body, { status: 200 });
    });
    const store = new MemoryBlobStore();
    const attempt = downloadFile(file, { store, fetch, signal: controller.signal });
    await expect(attempt).rejects.toBeInstanceOf(DownloadError);
    await expect(attempt).rejects.toMatchObject({ code: "model_download_cancelled" });
    expect(store.files.size).toBe(0);
  });

  it("keeps the partial file for a resume when the transfer breaks without a cancel", async () => {
    // The body errors after the first chunk and the signal is not aborted: an interruption, resume material kept.
    const bytes = testBytes(2000);
    const file = fileFor(bytes);
    const { fetch } = fakeFetch(() => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          pulls += 1;
          if (pulls === 1) stream.enqueue(bytes.slice(0, 600));
          else stream.error(new TypeError("network error"));
        },
      });
      return new Response(body, { status: 200 });
    });
    const store = new MemoryBlobStore();
    await expect(downloadFile(file, { store, fetch, signal: live() })).rejects.toMatchObject({ name: "DownloadError", code: "model_download_interrupted" });
    expect(store.files.has(file.sha256)).toBe(false);
    expect(store.files.get(`${file.sha256}${PART_SUFFIX}`)).toEqual(bytes.slice(0, 600));
  });

  it("keeps the partial file when the body ends early", async () => {
    // A clean end of stream short of the stated size is also an interruption, not a mismatch.
    const bytes = testBytes(2000);
    const file = fileFor(bytes);
    const { fetch } = fakeFetch(() => new Response(streamOf([bytes.slice(0, 1200)]), { status: 200 }));
    const store = new MemoryBlobStore();
    await expect(downloadFile(file, { store, fetch, signal: live() })).rejects.toMatchObject({ code: "model_download_interrupted" });
    expect(store.files.get(`${file.sha256}${PART_SUFFIX}`)).toEqual(bytes.slice(0, 1200));
  });

  it("does not fetch a file already complete in the cache", async () => {
    // A complete file under its digest is not fetched again, once its bytes were read and matched.
    const bytes = testBytes(512);
    const file = fileFor(bytes);
    const store = new MemoryBlobStore();
    store.files.set(file.sha256, bytes);
    const reads: number[] = [];
    const read = store.read.bind(store);
    store.read = async (name, offset, length) => {
      reads.push(length);
      return read(name, offset, length);
    };
    const { fetch, calls } = fakeFetch(() => new Response(streamOf([bytes]), { status: 200 }));
    expect(await downloadFile(file, { store, fetch, signal: live() })).toEqual({ sha256: file.sha256, bytes: bytes.length, resumed_from: bytes.length, fetched: false });
    expect(calls).toHaveLength(0);
    expect(reads.reduce((sum, length) => sum + length, 0)).toBe(bytes.length);
  });

  // T41 review 2, nit 6: the re-hash of a 2.5 GB cached file takes seconds and showed "0 bytes".
  it("reports the re-hash of a complete cached file as progress, marked as a check", async () => {
    const bytes = testBytes(512);
    const file = fileFor(bytes);
    const store = new MemoryBlobStore();
    store.files.set(file.sha256, bytes);
    const progress: Array<{ bytes_done: number; verifying?: boolean }> = [];
    const { fetch } = fakeFetch(() => new Response(streamOf([bytes]), { status: 200 }));
    await downloadFile(file, { store, fetch, signal: live(), onProgress: (event) => progress.push({ bytes_done: event.bytes_done, verifying: event.verifying }) });
    expect(progress[0]).toEqual({ bytes_done: 0, verifying: true });
    expect(progress.at(-1)).toEqual({ bytes_done: bytes.length, verifying: true });
  });

  // T41 review 1, finding 3: a complete file was trusted by its size alone.
  it("re-hashes a complete cached file and fetches it again when one byte differs", async () => {
    const bytes = testBytes(512);
    const file = fileFor(bytes);
    const store = new MemoryBlobStore();
    const damaged = bytes.slice();
    damaged[100] = damaged[100]! ^ 0xff;
    store.files.set(file.sha256, damaged);
    const { fetch, calls } = fakeFetch(() => new Response(streamOf([bytes]), { status: 200 }));
    expect(await downloadFile(file, { store, fetch, signal: live() })).toMatchObject({ sha256: file.sha256, bytes: bytes.length, resumed_from: 0, fetched: true });
    expect(calls).toHaveLength(1);
    expect(store.files.get(file.sha256)).toEqual(bytes);
  });

  it("drops a final file of the wrong size before downloading", async () => {
    const bytes = testBytes(512);
    const file = fileFor(bytes);
    const store = new MemoryBlobStore();
    store.files.set(file.sha256, bytes.slice(0, 100));
    const { fetch, calls } = fakeFetch(() => new Response(streamOf([bytes]), { status: 200 }));
    expect(await downloadFile(file, { store, fetch, signal: live() })).toMatchObject({ fetched: true });
    expect(calls).toHaveLength(1);
    expect(store.files.get(file.sha256)).toEqual(bytes);
  });

  it("drops a partial file larger than the stated size and downloads from zero", async () => {
    // A .part longer than the file cannot be a prefix of it.
    const bytes = testBytes(800);
    const file = fileFor(bytes);
    const store = new MemoryBlobStore();
    store.files.set(`${file.sha256}${PART_SUFFIX}`, testBytes(900));
    const { fetch, calls } = fakeFetch(() => new Response(streamOf([bytes]), { status: 200 }));
    expect(await downloadFile(file, { store, fetch, signal: live() })).toMatchObject({ resumed_from: 0, fetched: true });
    expect(rangeOf(calls[0]!.init)).toBeUndefined();
    expect(store.files.get(file.sha256)).toEqual(bytes);
  });
});

describe("verifyFile and readCachedHeader", () => {
  it("is true for intact bytes, false after one flipped byte, false for a missing file", async () => {
    // Verify re-hashes the cached bytes against the digest they are named by.
    const bytes = testBytes(4096);
    const file = fileFor(bytes);
    const store = new MemoryBlobStore();
    store.files.set(file.sha256, bytes.slice());
    expect(await verifyFile(store, file, live())).toBe(true);
    store.files.get(file.sha256)![1234]! ^= 0x01;
    expect(await verifyFile(store, file, live())).toBe(false);
    expect(await verifyFile(new MemoryBlobStore(), file, live())).toBe(false);
  });

  for (const recorded of HEADERS.files) {
    it(`reads ${recorded.file}'s header facts from the cached bytes`, async () => {
      // The header reader over the cache's file reads the facts the synthetic header states.
      const bytes = qwen3Header({ n_layer: recorded.facts.n_layer, head_count: recorded.facts.head_count, n_kv_heads: recorded.facts.n_kv_heads, key_length: recorded.facts.key_length, value_length: recorded.facts.value_length, embedding_length: recorded.facts.embedding_length, context_length: recorded.facts.context_length });
      const digest = sha256Hex(bytes);
      const store = new MemoryBlobStore();
      store.files.set(digest, bytes);
      const facts = await readCachedHeader(store, digest, bytes.length);
      expect(facts).toMatchObject({ architecture: recorded.facts.architecture, n_layer: recorded.facts.n_layer, n_kv_heads: recorded.facts.n_kv_heads, key_length: recorded.facts.key_length, value_length: recorded.facts.value_length, context_length: recorded.facts.context_length, key_length_basis: "attention.key_length" });
      expect(headerFromFacts(facts)).toEqual({ n_layer: recorded.facts.n_layer, n_kv_heads: recorded.facts.n_kv_heads, key_length: recorded.facts.key_length, value_length: recorded.facts.value_length, context_length: recorded.facts.context_length, architecture: recorded.facts.architecture, general_name: "Qwen3 test" });
    });
  }
});

describe("cacheState and effectiveEntry", () => {
  const curated: InBrowserEntry = CATALOG.entries[0]!;
  const now = new Date("2026-11-05T12:00:00Z");
  const complete = (row: ModelRecord): ModelRecord => ({ ...row, files: row.files.map((file) => ({ ...file, state: "complete" as const })) });

  it("is cached only with every file complete, and verified only when also verified without a mismatch", () => {
    // The descriptor's cached and verified flags from one row.
    expect(cacheState(null)).toEqual({ cached: false, verified: false });
    const fresh = newModelRecord(curated, now);
    expect(fresh.files.every((file) => file.state === "missing")).toBe(true);
    expect(cacheState(fresh)).toEqual({ cached: false, verified: false });
    expect(cacheState({ ...fresh, files: fresh.files.map((file) => ({ ...file, state: "partial" as const })) })).toEqual({ cached: false, verified: false });
    expect(cacheState(complete(fresh))).toEqual({ cached: true, verified: false });
    expect(cacheState({ ...complete(fresh), verified: true })).toEqual({ cached: true, verified: true });
    expect(cacheState({ ...complete(fresh), verified: true, mismatch: true })).toEqual({ cached: true, verified: false });
    expect(cacheState({ ...fresh, files: [], verified: true })).toEqual({ cached: false, verified: false });
  });

  it("replaces the entry's header with the one read from the cache, and leaves it alone otherwise", () => {
    // The cached header outranks the list's; no row or no header keeps the entry as listed.
    const unread: InBrowserEntry = { ...curated, header: null };
    expect(effectiveEntry(curated, null)).toBe(curated);
    expect(effectiveEntry(unread, newModelRecord(unread, now))).toBe(unread);
    const row: ModelRecord = { ...newModelRecord(unread, now), header: { n_layer: 3, n_kv_heads: 2, key_length: 16, value_length: 16, width_basis: "embedding", context_length: 4096, architecture: "qwen3", general_name: null } };
    expect(effectiveEntry(unread, row).header).toEqual({ n_layer: 3, n_kv_heads: 2, key_length: 16, value_length: 16, width_basis: "embedding" });
    const plain: ModelRecord = { ...row, header: { n_layer: 3, n_kv_heads: 2, key_length: 16, value_length: 16, context_length: 4096, architecture: "qwen3", general_name: null } };
    expect(effectiveEntry(curated, plain).header).toEqual({ n_layer: 3, n_kv_heads: 2, key_length: 16, value_length: 16 });
    expect(effectiveEntry(curated, plain).files).toBe(curated.files);
  });
});
