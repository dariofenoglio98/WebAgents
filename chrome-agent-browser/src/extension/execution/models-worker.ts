/**
 * The model cache's byte work (T41, D-451, D-452): a dedicated Worker of the offscreen page, the
 * only context with OPFS sync access handles. It downloads an entry's files (`downloadFile`:
 * URL check, `Range` resume, streaming SHA-256, a mismatch deleted), re-hashes them (Verify),
 * reads the first file's GGUF header, deletes files, and lists the cache. It decides nothing:
 * the page's `ModelManager` asks, records the outcome in IndexedDB, and reports to the service
 * worker. A cancel stops the transfer and leaves no file.
 */
import { DigestMismatchError, DownloadError } from "../storage/models.js";
import { OpfsBlobStore } from "../storage/opfs-models.js";
import { runModelsCommand, type ModelsCommand, type ModelsEvent } from "./models-commands.js";

export type { ModelsCommand, ModelsEvent } from "./models-commands.js";

const scope = self as unknown as { onmessage: ((event: MessageEvent<ModelsCommand>) => void) | null; postMessage(message: ModelsEvent): void };
const running = new Map<number, AbortController>();
let opened: Promise<OpfsBlobStore> | null = null;
const store = (): Promise<OpfsBlobStore> => (opened ??= OpfsBlobStore.open());

async function handle(command: Exclude<ModelsCommand, { kind: "cancel" }>, signal: AbortSignal): Promise<unknown> {
  return runModelsCommand(command, signal, { store: await store(), fetch: (url, init) => fetch(url, init), progress: (event) => scope.postMessage(event) });
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
