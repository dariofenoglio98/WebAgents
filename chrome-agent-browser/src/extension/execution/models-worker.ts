/**
 * The model cache's byte work (T41, D-451, D-452): a dedicated Worker of the offscreen page, the
 * only context with OPFS sync access handles. It downloads an entry's files (`downloadFile`:
 * URL check, `Range` resume, streaming SHA-256, a mismatch deleted), re-hashes them (Verify),
 * reads the first file's GGUF header, deletes files, and lists the cache. It decides nothing:
 * the page's `ModelManager` asks, records the outcome in IndexedDB, and reports to the service
 * worker. A cancel stops the transfer and leaves no file.
 */
import type { InBrowserFile } from "../../core/models/in-browser-catalog.js";
import { DigestMismatchError, DownloadError, downloadFile, PART_SUFFIX, readCachedHeader, verifyFile, type DownloadProgress } from "../storage/models.js";
import { OpfsBlobStore } from "../storage/opfs-models.js";

export type ModelsCommand =
  | { id: number; kind: "download"; files: InBrowserFile[] }
  | { id: number; kind: "verify"; files: Array<Pick<InBrowserFile, "sha256" | "bytes">> }
  | { id: number; kind: "header"; sha256: string; bytes: number }
  | { id: number; kind: "delete"; sha256s: string[] }
  | { id: number; kind: "list" }
  | { kind: "cancel"; target: number };

export type ModelsEvent =
  | { kind: "progress"; id: number; progress: DownloadProgress & { file_index: number; files: number } }
  | { kind: "answer"; id: number; ok: true; result: unknown }
  | { kind: "answer"; id: number; ok: false; error: { code: string; message: string; file?: string } };

const scope = self as unknown as { onmessage: ((event: MessageEvent<ModelsCommand>) => void) | null; postMessage(message: ModelsEvent): void };
const running = new Map<number, AbortController>();
let opened: Promise<OpfsBlobStore> | null = null;
const store = (): Promise<OpfsBlobStore> => (opened ??= OpfsBlobStore.open());

async function handle(command: Exclude<ModelsCommand, { kind: "cancel" }>, signal: AbortSignal): Promise<unknown> {
  const files = await store();
  switch (command.kind) {
    case "download": {
      const results = [];
      for (const [index, file] of command.files.entries()) {
        results.push(await downloadFile(file, { store: files, fetch: (url, init) => fetch(url, init), signal, onProgress: (progress) => scope.postMessage({ kind: "progress", id: command.id, progress: { ...progress, file_index: index, files: command.files.length } }) }));
      }
      return { files: results };
    }
    case "verify": {
      const results = [];
      for (const file of command.files) results.push({ sha256: file.sha256, ok: await verifyFile(files, file, signal) });
      return { files: results };
    }
    case "header":
      return readCachedHeader(files, command.sha256, command.bytes);
    case "delete":
      for (const sha256 of command.sha256s) {
        await files.remove(sha256);
        await files.remove(`${sha256}${PART_SUFFIX}`);
      }
      return { deleted: command.sha256s.length };
    case "list":
      return { files: await files.list() };
  }
}

scope.onmessage = (event) => {
  const command = event.data;
  if (command.kind === "cancel") {
    running.get(command.target)?.abort();
    return;
  }
  const controller = new AbortController();
  running.set(command.id, controller);
  void handle(command, controller.signal)
    .then(
      (result) => scope.postMessage({ kind: "answer", id: command.id, ok: true, result }),
      (error: unknown) => {
        const code = error instanceof DigestMismatchError || error instanceof DownloadError ? error.code : "model_cache_error";
        scope.postMessage({ kind: "answer", id: command.id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error), ...(error instanceof DigestMismatchError ? { file: error.file } : {}) } });
      },
    )
    .finally(() => running.delete(command.id));
};
