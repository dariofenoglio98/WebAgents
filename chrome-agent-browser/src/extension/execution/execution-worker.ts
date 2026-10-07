/**
 * The execution Worker inside the offscreen document (D-070): one Worker per run, created by
 * `execution-page.ts`, running `executeRun` over the shared IndexedDB stores, the browser
 * transport and this context's Prompt API. It receives exactly two commands (`start`, `cancel`)
 * and reports `progress`, `finished` or `failed`; it never touches chrome.* APIs.
 */
import { IndexedDbSnapshotStore } from "../storage/snapshots.js";
import { IndexedDbRunStore } from "../storage/runs.js";
import { Database } from "../storage/database.js";
import { languageModelApi, LanguageModelPort } from "./builtin-port.js";
import { executeRun, type ExecutionHandle } from "./execute.js";
import type { WorkerCommand, WorkerEvent } from "./protocol.js";
import { browserTransport } from "./transport.js";

const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null; postMessage(message: WorkerEvent): void; close(): void };
let handle: ExecutionHandle | null = null;

scope.onmessage = (event) => {
  const command = event.data;
  if (command.kind === "cancel") {
    handle?.cancel();
    return;
  }
  if (command.kind !== "start" || handle !== null) return;
  const database = new Database();
  const api = languageModelApi();
  handle = executeRun({
    runs: new IndexedDbRunStore(database),
    snapshots: new IndexedDbSnapshotStore(database),
    message: command.message,
    transports: { model: browserTransport({ allowLoopbackHttp: true }), tool: browserTransport({ allowLoopbackHttp: false }) },
    builtin: api ? new LanguageModelPort(api) : null,
    onCheckpoint: (runId) => scope.postMessage({ kind: "progress", runId }),
  });
  void handle.done.then((status) => {
    scope.postMessage({ kind: "finished", runId: command.message.runId, status });
    scope.close();
  });
};
