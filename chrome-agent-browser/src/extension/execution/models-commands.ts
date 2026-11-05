/**
 * The models Worker's commands over any blob store and fetch (T41, D-451, D-452): what
 * `models-worker.ts` runs over OPFS sync access handles and the Worker's `fetch`, and what the
 * `ModelManager` tests run over `MemoryBlobStore` and a fake fetch (T41 review 1: the manager is
 * tested against the very code its Worker runs). It decides nothing; the manager records outcomes.
 */
import type { InBrowserFile } from "../../core/models/in-browser-catalog.js";
import { downloadFile, PART_SUFFIX, readCachedHeader, verifyFile, type DownloadProgress, type FetchLike, type ModelBlobStore } from "../storage/models.js";

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

export interface ModelsCommandDeps {
  store: ModelBlobStore;
  fetch: FetchLike;
  progress: (event: Extract<ModelsEvent, { kind: "progress" }>) => void;
}

/** One command's work; its answer (or its error, mapped by the caller) is the Worker's reply. */
export async function runModelsCommand(command: Exclude<ModelsCommand, { kind: "cancel" }>, signal: AbortSignal, deps: ModelsCommandDeps): Promise<unknown> {
  const files = deps.store;
  switch (command.kind) {
    case "download": {
      const results = [];
      for (const [index, file] of command.files.entries()) {
        results.push(await downloadFile(file, { store: files, fetch: deps.fetch, signal, onProgress: (progress) => deps.progress({ kind: "progress", id: command.id, progress: { ...progress, file_index: index, files: command.files.length } }) }));
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
