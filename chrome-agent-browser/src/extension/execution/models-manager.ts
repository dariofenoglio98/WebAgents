/**
 * The model cache's manager in the offscreen page (T41, D-444, D-451, D-452): it starts, follows
 * and cancels downloads in the models Worker, verifies and deletes cached files, and keeps the
 * IndexedDB rows true to what the Worker did. The offscreen page is the long-lived context (STATE
 * §10: it keeps running while the side panel and the service worker come and go), so a 26-minute
 * download is held here, never in the service worker.
 *
 * A download starts only from the person's click (the service worker sends `host.models` after
 * the card's Download), names the entry it was clicked for, and fetches only the URLs that entry
 * names after `checkModelFileUrl` admits them. A file that does not match its digest is not kept;
 * a cancelled download leaves no file; a deleted entry's files go unless another row names them.
 */
import type { InBrowserEntry } from "../../core/models/in-browser-catalog.js";
import type { GgufHeaderFacts } from "../../core/models/gguf-header.js";
import { cacheState, headerFromFacts, newModelRecord, type ModelRecord, type ModelStore } from "../storage/models.js";
import type { EngineHost } from "./engine-host.js";
import type { ModelsCommand, ModelsEvent } from "./models-commands.js";
import type { WithoutId } from "./engine-protocol.js";

export interface ModelsWorkerLike {
  postMessage(message: ModelsCommand): void;
  terminate(): void;
  onmessage: ((event: { data: ModelsEvent }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DownloadView {
  entry_id: string;
  state: "downloading" | "reading_header" | "done" | "failed" | "cancelled";
  file_index: number;
  files: number;
  bytes_done: number;
  bytes_total: number;
  resumed_from: number;
  /** A complete cached file is being re-hashed before it is kept (T41 review 2, nit 6). */
  verifying?: boolean;
  started_at: string;
  ended_at: string | null;
  error: { code: string; message: string } | null;
}

export class ModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface ModelManagerDeps {
  spawn: () => ModelsWorkerLike;
  models: ModelStore;
  engine: Pick<EngineHost, "loadedEntry" | "unload" | "status">;
  now?: () => Date;
  onChange?: () => void;
}

export class ModelManager {
  private worker: ModelsWorkerLike | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (event: Extract<ModelsEvent, { kind: "progress" }>["progress"]) => void }>();
  private readonly downloads = new Map<string, DownloadView & { id: number | null; settled: Promise<void>; sha256s: ReadonlySet<string> }>();
  /** The last orphan listing (`cachedOrphans`), dropped whenever this manager adds or removes files (T41 review 2, nit 9). */
  private orphanList: Promise<Array<{ name: string; size: number }>> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: ModelManagerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private ask<T>(command: WithoutId<Exclude<ModelsCommand, { kind: "cancel" }>>, onId?: (id: number) => void, progress?: (event: Extract<ModelsEvent, { kind: "progress" }>["progress"]) => void): Promise<T> {
    if (this.worker === null) {
      const worker = this.deps.spawn();
      worker.onmessage = (event) => {
        const data = event.data;
        const waiter = this.waiting.get(data.id);
        if (!waiter) return;
        if (data.kind === "progress") {
          waiter.progress?.(data.progress);
          return;
        }
        this.waiting.delete(data.id);
        if (data.ok) waiter.resolve(data.result);
        else waiter.reject(new ModelError(data.error.code, data.error.message));
      };
      worker.onerror = () => {
        for (const waiter of this.waiting.values()) waiter.reject(new ModelError("model_cache_error", "the model cache's Worker stopped"));
        this.waiting.clear();
        this.worker?.terminate();
        this.worker = null;
      };
      this.worker = worker;
    }
    const id = this.nextId++;
    onId?.(id);
    const worker = this.worker;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, progress });
      worker.postMessage({ ...command, id } as ModelsCommand);
    });
  }

  /** Files were added or removed: the next status read lists the cache again. */
  private filesMoved(): void {
    this.orphanList = null;
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // a report that fails never steers the cache
    }
  }

  /** List an entry without downloading it (a pasted repository's file, before the person's Download). */
  async list(entry: InBrowserEntry): Promise<ModelRecord> {
    const taken: ModelRecord[] = [];
    const row = await this.deps.models.update(entry.id, (current) => {
      if (current !== null && current.entry.weights_digest !== entry.weights_digest) {
        taken.push(current);
        return null;
      }
      return current ?? newModelRecord(entry, this.now());
    });
    // Another file under the same id would show one file's digest under the other's name (T41 review 1, finding 5).
    if (taken.length > 0) throw new ModelError("model_id_taken", `The id ${entry.id} already names other weights (${taken[0]!.entry.display_name}); delete that model first.`);
    this.filesMoved();
    this.changed();
    return row!;
  }

  /** Start a download (the person's click); resolves once it has started, the outcome lands in the row and `status()`. */
  async download(entry: InBrowserEntry): Promise<DownloadView> {
    const running = this.downloads.get(entry.id);
    if (running && (running.state === "downloading" || running.state === "reading_header")) throw new ModelError("model_download_running", `${entry.display_name} is already downloading`);
    const existing = await this.deps.models.get(entry.id);
    if (existing && cacheState(existing).verified && existing.entry.weights_digest === entry.weights_digest) throw new ModelError("model_cached", `${entry.display_name} is already downloaded and verified`);
    if (existing && existing.entry.weights_digest !== entry.weights_digest) {
      // A newer list changed this entry's files (D-453): the old files go now, or no row would name
      // them and nothing would show or delete them (T41 review 1, finding 4).
      const user = this.deps.engine.status().runs.find((item) => item.entry === entry.id);
      if (user) throw new ModelError("model_in_use", `This model is in use by run ${user.run_id}; it can be downloaded again when the run ends`);
      if (this.deps.engine.loadedEntry() === entry.id) await this.deps.engine.unload();
      const named = new Set(entry.files.map((file) => file.sha256));
      await this.removeFiles(entry, existing.files.map((file) => file.sha256).filter((sha256) => !named.has(sha256)));
    }
    const at = this.now().toISOString();
    // The files an earlier download completed: a cancel of this one keeps them (D-452: it removes what this download fetched).
    const earlier = new Set<string>();
    await this.deps.models.update(entry.id, (current) => {
      const base = current !== null && current.entry.weights_digest === entry.weights_digest ? current : newModelRecord(entry, this.now());
      for (const file of base.files) if (file.state === "complete") earlier.add(file.sha256);
      return { ...base, entry, files: base.files.map((file) => (file.state === "complete" ? file : { ...file, state: "partial" })), last_error: null };
    });
    const view: DownloadView & { id: number | null; settled: Promise<void>; sha256s: ReadonlySet<string> } = { id: null, settled: Promise.resolve(), sha256s: new Set(entry.files.map((file) => file.sha256)), entry_id: entry.id, state: "downloading", file_index: 0, files: entry.files.length, bytes_done: 0, bytes_total: entry.bytes_total, resumed_from: 0, started_at: at, ended_at: null, error: null };
    this.downloads.set(entry.id, view);
    this.filesMoved();
    this.changed();
    const offsets = entry.files.map((_, index) => entry.files.slice(0, index).reduce((sum, file) => sum + file.bytes, 0));
    let lastReport = 0;
    // The files this download fetches bytes for (T41 review 3, nit 3): an earlier file whose re-hash
    // failed is discarded and fetched again, and then it is this download's, so a cancel removes it.
    const fetching = new Set<string>();
    view.settled = this.ask<{ files: Array<{ sha256: string; bytes: number }> }>({ kind: "download", files: entry.files }, (id) => (view.id = id), (progress) => {
      view.file_index = progress.file_index;
      view.verifying = progress.verifying === true;
      if (progress.verifying !== true && progress.cached !== true) fetching.add(progress.sha256);
      view.bytes_done = offsets[progress.file_index]! + progress.bytes_done;
      if (progress.resumed_from > 0 && progress.bytes_done === progress.resumed_from) view.resumed_from += progress.resumed_from;
      const now = Date.now();
      if (now - lastReport > 1000) {
        lastReport = now;
        this.changed();
      }
    })
      .then(async (answer) => {
        // The row says verified only for the digests the Worker computed, file by file.
        if (answer.files.length !== entry.files.length || answer.files.some((file, index) => file.sha256 !== entry.files[index]!.sha256)) throw new ModelError("model_digest_mismatch", "the bytes did not match the digest the catalog states");
        view.state = "reading_header";
        view.verifying = false;
        view.bytes_done = entry.bytes_total;
        this.changed();
        let header: GgufHeaderFacts | null = null;
        let headerError: string | null = null;
        try {
          header = await this.ask<GgufHeaderFacts>({ kind: "header", sha256: entry.files[0]!.sha256, bytes: entry.files[0]!.bytes });
        } catch (error) {
          headerError = error instanceof Error ? error.message : "the header could not be read";
        }
        const done = this.now().toISOString();
        await this.deps.models.update(entry.id, (current) => ({
          ...(current ?? newModelRecord(entry, this.now())),
          entry,
          files: entry.files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes, state: "complete" })),
          verified: true,
          mismatch: false,
          downloaded_at: done,
          verified_at: done,
          header: header === null ? null : headerFromFacts(header),
          last_error: headerError === null ? null : { code: "model_header_unreadable", message: `The file's GGUF header could not be read (${headerError}): its GPU memory is unknown`, at: done },
        }));
        view.state = "done";
        view.ended_at = done;
      })
      .catch(async (error: unknown) => {
        const code = error instanceof ModelError ? error.code : "model_cache_error";
        const message = error instanceof Error ? error.message : "the download failed";
        const ended = this.now().toISOString();
        const cancelled = code === "model_download_cancelled";
        // A cancel removes what this download fetched (D-452), unless another row names it; a file an
        // earlier download completed stays when it is still whole on disk and this download fetched
        // none of its bytes (T41 review 2, nit 6; review 3, nit 3).
        const kept = new Set<string>();
        if (cancelled) {
          const whole = new Map(((await this.files().catch(() => ({ files: [] }))).files ?? []).map((file) => [file.name, file.size]));
          for (const file of entry.files) if (earlier.has(file.sha256) && !fetching.has(file.sha256) && whole.get(file.sha256) === file.bytes) kept.add(file.sha256);
          await this.removeFiles(entry, entry.files.map((file) => file.sha256).filter((sha256) => !kept.has(sha256))).catch(() => undefined);
        }
        await this.deps.models.update(entry.id, (current) =>
          current === null
            ? null
            : {
                ...current,
                files: current.files.map((file) => ({ ...file, state: cancelled ? (kept.has(file.sha256) ? "complete" : "missing") : code === "model_digest_mismatch" ? (file.state === "complete" ? "complete" : "missing") : file.state })),
                verified: false,
                last_error: cancelled ? null : { code, message, at: ended },
              },
        );
        view.state = cancelled ? "cancelled" : "failed";
        view.error = cancelled ? null : { code, message };
        view.ended_at = ended;
      })
      .finally(() => {
        view.id = null;
        view.verifying = false;
        this.filesMoved();
        this.changed();
      });
    const { id: _id, settled: _settled, sha256s: _sha256s, ...shown } = view;
    return { ...shown };
  }

  cancel(entryId: string): boolean {
    const view = this.downloads.get(entryId);
    if (!view || view.id === null) return false;
    this.worker?.postMessage({ kind: "cancel", target: view.id });
    return true;
  }

  /** Re-hash every cached file of an entry (Verify): the digests and `verified_at` are recorded. */
  async verify(entryId: string): Promise<ModelRecord> {
    const row = await this.deps.models.get(entryId);
    if (row === null || !cacheState(row).cached) throw new ModelError("model_not_cached", "This model is not downloaded");
    const answer = await this.ask<{ files: Array<{ sha256: string; ok: boolean }> }>({ kind: "verify", files: row.files.map((file) => ({ sha256: file.sha256, bytes: file.bytes })) });
    const ok = answer.files.every((file) => file.ok);
    const at = this.now().toISOString();
    const next = await this.deps.models.update(entryId, (current) => (current === null ? null : { ...current, verified: ok, mismatch: !ok, verified_at: at, last_error: ok ? null : { code: "model_digest_mismatch", message: "the bytes did not match the digest the catalog states", at } }));
    this.changed();
    return next!;
  }

  /** Delete an entry's files and row (a loaded model is unloaded first; one a run is using is refused). */
  async delete(entryId: string): Promise<void> {
    const status = this.deps.engine.status();
    const user = status.runs.find((item) => item.entry === entryId);
    if (user) throw new ModelError("model_in_use", `This model is in use by run ${user.run_id}; it can be deleted when the run ends`);
    if (this.deps.engine.loadedEntry() === entryId) await this.deps.engine.unload();
    // A download in flight holds its partial file open: cancel it and wait for it to let go (T41 review 1, nit 6).
    const running = this.downloads.get(entryId);
    if (this.cancel(entryId)) await running?.settled;
    const row = await this.deps.models.get(entryId);
    if (row !== null) await this.removeFiles(row.entry, row.files.map((file) => file.sha256));
    await this.deps.models.delete(entryId);
    this.downloads.delete(entryId);
    this.filesMoved();
    this.changed();
  }

  private async removeFiles(entry: InBrowserEntry, sha256s: string[]): Promise<void> {
    const shared = new Set((await this.deps.models.list()).filter((row) => row.entry_id !== entry.id && cacheState(row).cached).flatMap((row) => row.files.map((file) => file.sha256)));
    const own = sha256s.filter((sha256) => !shared.has(sha256));
    if (own.length > 0) await this.ask({ kind: "delete", sha256s: own });
    this.filesMoved();
  }

  /** The digests a download in flight is writing: never an orphan, whatever its row says yet. */
  private downloading(): Set<string> {
    const busy = new Set<string>();
    for (const view of this.downloads.values()) if (view.id !== null) for (const sha256 of view.sha256s) busy.add(sha256);
    return busy;
  }

  /** What is cached on disk, for the totals and to find files no row names. */
  files(): Promise<{ files: Array<{ name: string; size: number }> }> {
    return this.ask({ kind: "list" });
  }

  /**
   * The cache's files no row names (T41 review 1, finding 4): left by an earlier version, or by a
   * row removed outside this manager. The files are listed before the rows are read, so a download
   * that starts in between has its row read too, and a download in flight is never an orphan
   * (T41 review 2, nit 8).
   */
  async orphans(): Promise<Array<{ name: string; size: number }>> {
    const { files } = await this.files();
    const named = new Set((await this.deps.models.list()).flatMap((row) => row.files.map((file) => file.sha256)));
    for (const sha256 of this.downloading()) named.add(sha256);
    return files.filter((file) => {
      const match = /^([0-9a-f]{64})(\.part)?$/u.exec(file.name);
      return match !== null && !named.has(match[1]!);
    });
  }

  /** `orphans` for a status read: listed once, again only after this manager added or removed files (T41 review 2, nit 9). */
  cachedOrphans(): Promise<Array<{ name: string; size: number }>> {
    if (this.orphanList === null) {
      const listing = this.orphans();
      this.orphanList = listing;
      listing.catch(() => {
        if (this.orphanList === listing) this.orphanList = null;
      });
    }
    return this.orphanList;
  }

  /** Remove every file `orphans` names (the cache section's "Remove them"), never one a download started since is writing. */
  async prune(): Promise<{ removed: number; bytes: number }> {
    const orphans = await this.orphans();
    // One filter (T41 review 3, nit 5): `orphans` left out the downloads in flight when it listed;
    // this drops one that started in the tick since, and what is removed is what is counted.
    const busy = this.downloading();
    const removable = orphans.filter((file) => !busy.has(file.name.slice(0, 64)));
    const sha256s = [...new Set(removable.map((file) => file.name.slice(0, 64)))];
    if (sha256s.length > 0) await this.ask({ kind: "delete", sha256s });
    this.filesMoved();
    this.changed();
    return { removed: removable.length, bytes: removable.reduce((sum, file) => sum + file.size, 0) };
  }

  status(): DownloadView[] {
    return [...this.downloads.values()].map(({ id: _id, settled: _settled, sha256s: _sha256s, ...view }) => ({ ...view }));
  }
}
