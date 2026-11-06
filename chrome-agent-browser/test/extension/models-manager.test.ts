/**
 * T41 review 1: `ModelManager` (the model cache's owner in the offscreen page) over a fake models
 * Worker that runs the real command code (`models-commands.ts`: the downloader, Verify, delete,
 * list) on `MemoryBlobStore` and a fake fetch. The review found three manager bugs the harness
 * could not see; each has a test here that failed before its fix:
 *   finding 3  a row Verify found mismatched became "verified" by a download that hashed nothing
 *   finding 4  a list that changed an entry's files orphaned the old file; files no row names
 *   finding 5  a pasted id held by other weights was silently kept with the first file's digest
 *   nit 6      a Delete during a download tried to remove a partial file the download held open
 * and three review-2 nits: a cancel removed a file an earlier download had completed (nit 6), a
 * download that started during the orphan listing was listed as an orphan (nit 8), and every status
 * read listed the cache again (nit 9);
 * plus the ordinary paths: a download kept by digest, a cancel that leaves nothing, Verify, Delete.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { IN_BROWSER_ENTRY_SCHEMA, normalizeInBrowserEntry, weightsDigest, type InBrowserEntry } from "../../src/core/models/in-browser-catalog.js";
import type { EngineStatus } from "../../src/extension/execution/engine-host.js";
import { runModelsCommand, type ModelsCommand, type ModelsEvent } from "../../src/extension/execution/models-commands.js";
import { ModelError, ModelManager, type ModelsWorkerLike } from "../../src/extension/execution/models-manager.js";
import { DigestMismatchError, DownloadError, MemoryBlobStore, MemoryModelStore, newModelRecord, verifyFile, type BlobWriter, type FetchLike, type ModelRecord } from "../../src/extension/storage/models.js";

const NOW = new Date("2026-11-05T18:00:00Z");
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (length: number, seed: number): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff);

/** A test entry whose files are `blobs` (served by the fake fetch at their URLs). */
function entryOf(id: string, blobs: Array<{ name: string; bytes: Uint8Array }>, curated = false): InBrowserEntry {
  const files = blobs.map((blob) => ({ name: blob.name, url: `https://huggingface.co/owner/repo/resolve/${REVISION}/${blob.name}`, bytes: blob.bytes.length, sha256: sha256Hex(blob.bytes) }));
  return normalizeInBrowserEntry({
    schema: IN_BROWSER_ENTRY_SCHEMA,
    id,
    display_name: id,
    family: "test",
    parameters: null,
    format: "gguf",
    engine: "wllama",
    quantization: "Q4_0",
    files,
    weights_digest: weightsDigest(files.map((file) => file.sha256)),
    bytes_total: files.reduce((sum, file) => sum + file.bytes, 0),
    context: { train: 32768, default: 8192, max: 32768 },
    capabilities: { structured_output: true, reasoning: null, tool_use: null },
    license: { id: "apache-2.0", name: "Apache 2.0", url: "https://huggingface.co/owner/repo" },
    source: { repository: "owner/repo", revision: REVISION, api: "https://huggingface.co/api/models/owner/repo?blobs=true" },
    curated,
    header: null,
    notes: null,
  });
}

/** OPFS's rule the review's nit 6 hit: a file open for writing cannot be removed. */
class LockingBlobStore extends MemoryBlobStore {
  readonly open_ = new Set<string>();
  override async open(name: string): Promise<BlobWriter> {
    const writer = await super.open(name);
    this.open_.add(name);
    // Closing takes a moment, as releasing a sync access handle does: a remove sent at once fails.
    return {
      ...writer,
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        this.open_.delete(name);
      },
    };
  }
  override async remove(name: string): Promise<void> {
    if (this.open_.has(name)) throw Object.assign(new Error(`${name} is open`), { name: "NoModificationAllowedError" });
    await super.remove(name);
  }
}

/** The fake fetch: each URL's bytes; `hold` (every URL, or the URLs named) keeps a body open after its first half until the request's signal aborts. */
function origin(blobs: Map<string, Uint8Array>, options: { hold?: boolean | ReadonlySet<string> } = {}) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    const bytes = blobs.get(url);
    if (!bytes) return new Response(null, { status: 404 });
    const half = Math.floor(bytes.length / 2);
    const signal = init.signal ?? undefined;
    const holding = options.hold instanceof Set ? options.hold.has(url) : options.hold === true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!holding) {
          controller.enqueue(bytes);
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(0, half));
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    });
    return new Response(body, { status: 200 });
  };
  return { fetch, calls };
}

/** The models Worker in this process: the real command code, answered asynchronously like a Worker. */
class FakeModelsWorker implements ModelsWorkerLike {
  onmessage: ((event: { data: ModelsEvent }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly received: ModelsCommand[] = [];
  private readonly running = new Map<number, AbortController>();

  constructor(
    private readonly store: MemoryBlobStore,
    private readonly fetch: FetchLike,
  ) {}

  postMessage(command: ModelsCommand): void {
    this.received.push(structuredClone(command));
    if (command.kind === "cancel") {
      this.running.get(command.target)?.abort();
      return;
    }
    const controller = new AbortController();
    this.running.set(command.id, controller);
    const send = (data: ModelsEvent) => setTimeout(() => this.onmessage?.({ data }), 0);
    void runModelsCommand(command, controller.signal, { store: this.store, fetch: this.fetch, progress: send })
      .then(
        (result) => send({ kind: "answer", id: command.id, ok: true, result }),
        (error: unknown) => send({ kind: "answer", id: command.id, ok: false, error: { code: error instanceof DigestMismatchError || error instanceof DownloadError ? error.code : "model_cache_error", message: error instanceof Error ? error.message : String(error) } }),
      )
      .finally(() => this.running.delete(command.id));
  }

  terminate(): void {}

  kinds(): string[] {
    return this.received.map((command) => command.kind);
  }
}

const IDLE: EngineStatus = { loaded: null, loading: null, busy: false, queued: 0, runs: [], idle_unload_at: null, last_failure: null };

function setup(options: { blobs?: Array<{ entry: InBrowserEntry; data: Uint8Array[] }>; hold?: boolean | ReadonlySet<string>; store?: MemoryBlobStore; engine?: { loaded?: string | null; runs?: EngineStatus["runs"] } } = {}) {
  const store = options.store ?? new MemoryBlobStore();
  const served = new Map<string, Uint8Array>();
  for (const { entry, data } of options.blobs ?? []) entry.files.forEach((file, index) => served.set(file.url, data[index]!));
  const { fetch, calls } = origin(served, { hold: options.hold });
  const models = new MemoryModelStore();
  const workers: FakeModelsWorker[] = [];
  let loaded = options.engine?.loaded ?? null;
  const unloads: string[] = [];
  const manager = new ModelManager({
    spawn: () => {
      const worker = new FakeModelsWorker(store, fetch);
      workers.push(worker);
      return worker;
    },
    models,
    engine: {
      loadedEntry: () => loaded,
      unload: async () => {
        if (loaded !== null) unloads.push(loaded);
        loaded = null;
      },
      status: () => ({ ...IDLE, runs: options.engine?.runs ?? [] }),
    },
    now: () => NOW,
  });
  return { manager, models, store, calls, workers, unloads, worker: () => workers.at(-1)! };
}

/** Wait for the entry's download to leave the running states. */
async function settled(manager: ModelManager, entryId: string) {
  await vi.waitFor(() => expect(manager.status().find((view) => view.entry_id === entryId)?.state).toMatch(/^(done|failed|cancelled)$/u));
  return manager.status().find((view) => view.entry_id === entryId)!;
}

const A = bytesOf(4096, 1);
const B = bytesOf(4096, 2);
const C = bytesOf(2048, 3);

describe("ModelManager: a download", () => {
  it("keeps the files under their digests and marks the row verified, with the header's failure in words", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const { manager, models, store, calls } = setup({ blobs: [{ entry, data: [A] }] });
    const started = await manager.download(entry);
    expect(started).toMatchObject({ entry_id: entry.id, state: "downloading", files: 1, bytes_total: A.length });
    expect(started).not.toHaveProperty("id");
    expect(started).not.toHaveProperty("settled");
    expect((await settled(manager, entry.id)).state).toBe("done");
    expect(calls).toEqual([entry.files[0]!.url]);
    expect(store.files.get(entry.files[0]!.sha256)).toEqual(A);
    const row = (await models.get(entry.id))!;
    expect(row).toMatchObject({ verified: true, mismatch: false, downloaded_at: NOW.toISOString(), files: [{ state: "complete" }] });
    // These test bytes are not GGUF: the header is unknown and the row says so (the estimate stays unknown).
    expect(row.header).toBeNull();
    expect(row.last_error).toMatchObject({ code: "model_header_unreadable" });
  });

  it("leaves no file and no complete state when the person cancels", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const { manager, models, store, worker } = setup({ blobs: [{ entry, data: [A] }], hold: true });
    await manager.download(entry);
    await vi.waitFor(() => expect(store.files.has(`${entry.files[0]!.sha256}.part`)).toBe(true));
    expect(manager.cancel(entry.id)).toBe(true);
    expect((await settled(manager, entry.id)).state).toBe("cancelled");
    expect([...store.files.keys()]).toEqual([]);
    expect((await models.get(entry.id))!).toMatchObject({ verified: false, last_error: null, files: [{ state: "missing" }] });
    expect(worker().kinds()).toContain("cancel");
  });

  // T41 review 2, nit 6: D-452 says a cancel removes what this download fetched, not what an earlier one completed.
  it("keeps a file an earlier download completed when the person cancels this one", async () => {
    const entry = entryOf("test-ab", [
      { name: "ab-00001-of-00002.gguf", bytes: A },
      { name: "ab-00002-of-00002.gguf", bytes: B },
    ]);
    const { manager, models, store } = setup({ blobs: [{ entry, data: [A, B] }], hold: true });
    store.files.set(entry.files[0]!.sha256, A);
    const row = newModelRecord(entry, NOW);
    await models.put({ ...row, files: row.files.map((file, index) => ({ ...file, state: index === 0 ? "complete" : "missing" })) });
    await manager.download(entry);
    await vi.waitFor(() => expect(store.files.has(`${entry.files[1]!.sha256}.part`)).toBe(true));
    manager.cancel(entry.id);
    expect((await settled(manager, entry.id)).state).toBe("cancelled");
    expect([...store.files.keys()]).toEqual([entry.files[0]!.sha256]);
    expect((await models.get(entry.id))!.files.map((file) => file.state)).toEqual(["complete", "missing"]);
  });

  // T41 review 3, nit 3: the row's earlier "complete" is not enough. A cached file whose re-hash
  // failed is discarded and fetched again by this download, so a cancel removes it too.
  it("removes on a cancel an earlier file this download fetched again after its re-hash failed", async () => {
    const entry = entryOf("test-ab", [
      { name: "ab-00001-of-00002.gguf", bytes: A },
      { name: "ab-00002-of-00002.gguf", bytes: B },
    ]);
    const { manager, models, store, calls } = setup({ blobs: [{ entry, data: [A, B] }], hold: new Set([entry.files[1]!.url]) });
    const damaged = A.slice();
    damaged[10] = damaged[10]! ^ 0xff;
    store.files.set(entry.files[0]!.sha256, damaged);
    const row = newModelRecord(entry, NOW);
    await models.put({ ...row, files: row.files.map((file, index) => ({ ...file, state: index === 0 ? "complete" : "missing" })) });
    await manager.download(entry);
    await vi.waitFor(() => expect(store.files.has(`${entry.files[1]!.sha256}.part`)).toBe(true));
    expect(store.files.get(entry.files[0]!.sha256)).toEqual(A);
    expect(calls).toEqual([entry.files[0]!.url, entry.files[1]!.url]);
    manager.cancel(entry.id);
    expect((await settled(manager, entry.id)).state).toBe("cancelled");
    expect([...store.files.keys()]).toEqual([]);
    expect((await models.get(entry.id))!.files.map((file) => file.state)).toEqual(["missing", "missing"]);
  });

  it("refuses a second download of the same entry while one runs, and an entry already verified", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const held = setup({ blobs: [{ entry, data: [A] }], hold: true });
    await held.manager.download(entry);
    await expect(held.manager.download(entry)).rejects.toMatchObject({ code: "model_download_running" });
    held.manager.cancel(entry.id);
    await settled(held.manager, entry.id);
    const done = setup({ blobs: [{ entry, data: [A] }] });
    await done.manager.download(entry);
    await settled(done.manager, entry.id);
    await expect(done.manager.download(entry)).rejects.toMatchObject({ code: "model_cached" });
  });

  // Finding 3: reproduced by the reviewer with a one-byte-different cached file.
  it("never marks a mismatched row verified without hashing: the damaged file is fetched again and then matches", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const { manager, models, store, calls } = setup({ blobs: [{ entry, data: [A] }] });
    const damaged = A.slice();
    damaged[10] = damaged[10]! ^ 0xff;
    store.files.set(entry.files[0]!.sha256, damaged);
    const row = newModelRecord(entry, NOW);
    await models.put({ ...row, files: row.files.map((file) => ({ ...file, state: "complete" })), verified: false, mismatch: true });
    await manager.download(entry);
    expect((await settled(manager, entry.id)).state).toBe("done");
    expect(calls).toHaveLength(1);
    expect(store.files.get(entry.files[0]!.sha256)).toEqual(A);
    expect(await verifyFile(store, entry.files[0]!, new AbortController().signal)).toBe(true);
    expect((await models.get(entry.id))!).toMatchObject({ verified: true, mismatch: false });
    expect((await manager.verify(entry.id)).verified).toBe(true);
  });

  it("does not fetch a complete file again when its bytes still match", async () => {
    const entry = entryOf("test-ab", [
      { name: "ab-00001-of-00002.gguf", bytes: A },
      { name: "ab-00002-of-00002.gguf", bytes: B },
    ]);
    const { manager, store, calls } = setup({ blobs: [{ entry, data: [A, B] }] });
    store.files.set(entry.files[0]!.sha256, A);
    await manager.download(entry);
    expect((await settled(manager, entry.id)).state).toBe("done");
    expect(calls).toEqual([entry.files[1]!.url]);
  });
});

describe("ModelManager: what the cache keeps (finding 4)", () => {
  it("removes the old files when a newer list changes an entry's files under the same id", async () => {
    const before = entryOf("test-x", [{ name: "x.gguf", bytes: A }], true);
    const after = entryOf("test-x", [{ name: "x2.gguf", bytes: B }], true);
    const { manager, models, store } = setup({ blobs: [{ entry: before, data: [A] }, { entry: after, data: [B] }] });
    await manager.download(before);
    await settled(manager, before.id);
    expect(store.files.has(before.files[0]!.sha256)).toBe(true);
    await manager.download(after);
    expect((await settled(manager, after.id)).state).toBe("done");
    expect(store.files.has(before.files[0]!.sha256)).toBe(false);
    expect(store.files.get(after.files[0]!.sha256)).toEqual(B);
    expect((await models.get(after.id))!.entry.weights_digest).toBe(after.weights_digest);
    expect(await manager.orphans()).toEqual([]);
  });

  it("keeps an old file another row still names, and unloads the old weights first", async () => {
    const before = entryOf("test-x", [{ name: "x.gguf", bytes: A }], true);
    const after = entryOf("test-x", [{ name: "x2.gguf", bytes: B }], true);
    const other = entryOf("test-y", [{ name: "x.gguf", bytes: A }]);
    const { manager, store, unloads } = setup({ blobs: [{ entry: before, data: [A] }, { entry: after, data: [B] }, { entry: other, data: [A] }], engine: { loaded: "test-x" } });
    await manager.download(before);
    await settled(manager, before.id);
    await manager.download(other);
    await settled(manager, other.id);
    await manager.download(after);
    await settled(manager, after.id);
    expect(unloads).toEqual(["test-x"]);
    expect(store.files.has(before.files[0]!.sha256)).toBe(true);
  });

  it("refuses to replace an entry's files while a run uses it", async () => {
    const before = entryOf("test-x", [{ name: "x.gguf", bytes: A }], true);
    const after = entryOf("test-x", [{ name: "x2.gguf", bytes: B }], true);
    const { manager, models } = setup({ blobs: [{ entry: before, data: [A] }], engine: { runs: [{ run_id: "R", entry: "test-x" }] } });
    await models.put({ ...newModelRecord(before, NOW), verified: true });
    await expect(manager.download(after)).rejects.toMatchObject({ code: "model_in_use" });
  });

  it("names files no row names (a final file and a partial one) and removes exactly those", async () => {
    const kept = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const { manager, store } = setup({ blobs: [{ entry: kept, data: [A] }] });
    await manager.download(kept);
    await settled(manager, kept.id);
    const stray = sha256Hex(C);
    store.files.set(stray, C);
    store.files.set(`${sha256Hex(B)}.part`, B.slice(0, 100));
    store.files.set("not-a-digest", C);
    expect((await manager.orphans()).map((file) => file.name).sort()).toEqual([stray, `${sha256Hex(B)}.part`].sort());
    expect(await manager.prune()).toEqual({ removed: 2, bytes: C.length + 100 });
    expect([...store.files.keys()].sort()).toEqual([kept.files[0]!.sha256, "not-a-digest"].sort());
  });
});

describe("ModelManager: the orphan listing (review 2, nits 8 and 9)", () => {
  it("never lists the partial file of a download that started while the rows were being read", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const { manager, models, store } = setup({ blobs: [{ entry, data: [A] }], hold: true });
    const list = models.list.bind(models);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    models.list = async () => {
      const rows = await list();
      await gate;
      return rows;
    };
    const listing = manager.orphans();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await manager.download(entry);
    await vi.waitFor(() => expect(store.files.has(`${entry.files[0]!.sha256}.part`)).toBe(true));
    open();
    expect(await listing).toEqual([]);
    expect(await manager.prune()).toEqual({ removed: 0, bytes: 0 });
    expect(store.files.has(`${entry.files[0]!.sha256}.part`)).toBe(true);
    manager.cancel(entry.id);
    await settled(manager, entry.id);
  });

  it("lists the cache once for status reads, and again only after files were added or removed", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const { manager, store, worker } = setup({ blobs: [{ entry, data: [A] }] });
    const lists = () => worker().kinds().filter((kind) => kind === "list").length;
    store.files.set(sha256Hex(C), C);
    expect((await manager.cachedOrphans()).map((file) => file.name)).toEqual([sha256Hex(C)]);
    await manager.cachedOrphans();
    await manager.cachedOrphans();
    expect(lists()).toBe(1);
    await manager.prune();
    expect(await manager.cachedOrphans()).toEqual([]);
    const afterPrune = lists();
    await manager.download(entry);
    await settled(manager, entry.id);
    await manager.cachedOrphans();
    await manager.cachedOrphans();
    expect(lists()).toBe(afterPrune + 1);
  });
});

describe("ModelManager: listing a pasted entry (finding 5)", () => {
  it("refuses an id that already names other weights, and returns the row for the same weights", async () => {
    const first = entryOf("same-id", [{ name: "q4_k_m.gguf", bytes: A }]);
    const second = entryOf("same-id", [{ name: "q4_k_s.gguf", bytes: B }]);
    const { manager, models } = setup();
    const row = await manager.list(first);
    expect(row.entry.weights_digest).toBe(first.weights_digest);
    await expect(manager.list(second)).rejects.toMatchObject({ code: "model_id_taken" });
    expect((await models.get("same-id"))!.entry.weights_digest).toBe(first.weights_digest);
    expect((await manager.list(first)).listed_at).toBe(row.listed_at);
  });
});

describe("ModelManager: Verify and Delete", () => {
  it("marks a row mismatched when a byte changed, and Delete removes its files and row", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const { manager, models, store } = setup({ blobs: [{ entry, data: [A] }] });
    await manager.download(entry);
    await settled(manager, entry.id);
    store.files.get(entry.files[0]!.sha256)![0] ^= 0xff;
    expect(await manager.verify(entry.id)).toMatchObject({ verified: false, mismatch: true, last_error: { code: "model_digest_mismatch" } });
    await manager.delete(entry.id);
    expect(await models.get(entry.id)).toBeNull();
    expect([...store.files.keys()]).toEqual([]);
  });

  it("refuses to delete a model a run uses, and unloads a loaded one first", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const busy = setup({ engine: { runs: [{ run_id: "R", entry: entry.id }] } });
    await expect(busy.manager.delete(entry.id)).rejects.toBeInstanceOf(ModelError);
    const loaded = setup({ engine: { loaded: entry.id } });
    await loaded.manager.delete(entry.id);
    expect(loaded.unloads).toEqual([entry.id]);
  });

  // Nit 6: the partial file was removed while the download still held it open.
  it("waits for a download it cancels before removing its partial file", async () => {
    const entry = entryOf("test-a", [{ name: "a.gguf", bytes: A }]);
    const store = new LockingBlobStore();
    const { manager, models } = setup({ blobs: [{ entry, data: [A] }], hold: true, store });
    await manager.download(entry);
    await vi.waitFor(() => expect(store.open_.has(`${entry.files[0]!.sha256}.part`)).toBe(true));
    await manager.delete(entry.id);
    expect(await models.get(entry.id)).toBeNull();
    expect([...store.files.keys()]).toEqual([]);
    expect(manager.status()).toEqual([]);
  });
});
