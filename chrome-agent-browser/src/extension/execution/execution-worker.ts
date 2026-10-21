/**
 * The execution Worker inside the offscreen document (D-070): one Worker per run, created by
 * `execution-page.ts`, running `executeRun` over the shared IndexedDB stores, the browser
 * transport and this context's Prompt API. It receives exactly two commands (`start`, `cancel`)
 * and reports `progress`, `finished` or `failed`; it never touches chrome.* APIs.
 */
import { workerComputeEngine, type ComputeWorkerLike } from "../../core/compute/engine.js";
import { IndexedDbSnapshotStore } from "../storage/snapshots.js";
import { IndexedDbRunStore } from "../storage/runs.js";
import { Database } from "../storage/database.js";
import { languageModelApi, LanguageModelPort } from "./builtin-port.js";
import { IndexedDbFileStore } from "../storage/files.js";
import { executeRun, type ExecutionHandle } from "./execute.js";
import { PDF_WORKER_SCRIPT, workerPdfReader, type WorkerLike } from "./pdf-reader.js";
import type { WorkerCommand, WorkerEvent } from "./protocol.js";
import { browserTransport } from "./transport.js";

const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null; postMessage(message: WorkerEvent): void; close(): void };
let handle: ExecutionHandle | null = null;

/** The compute call's Worker script, beside this one (compute.v0, D-251). */
export const COMPUTE_WORKER_SCRIPT = "compute-worker.js";

/** The engine's identity for the audit: Chrome's version from the user agent (`chrome/155.0.8059.41`), else the engine alone. */
export function engineId(userAgent: string): string {
  const match = /Chrome\/([0-9.]+)/u.exec(userAgent);
  return match ? `chrome/${match[1]}` : "v8/unknown";
}

/** A dedicated Worker behind the core's Worker-like surface (the core declares no DOM types). */
export function browserWorkerLike(worker: Worker): ComputeWorkerLike {
  const like: ComputeWorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    terminate: () => worker.terminate(),
  };
  worker.onmessage = (event) => like.onmessage?.({ data: event.data as unknown });
  worker.onerror = (event) => like.onerror?.(event);
  worker.onmessageerror = (event) => like.onmessageerror?.(event);
  return like;
}

scope.onmessage = (event) => {
  const command = event.data;
  if (command.kind === "cancel") {
    handle?.cancel();
    return;
  }
  if (command.kind === "decide") {
    handle?.decide(command.step, command.accepted);
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
    files: new IndexedDbFileStore(database),
    // One compute Worker per call, nested in this run's Worker, terminated on answer, deadline and cancel (D-251).
    compute: workerComputeEngine(() => browserWorkerLike(new Worker(COMPUTE_WORKER_SCRIPT, { type: "module" })), { id: engineId(navigator.userAgent) }),
    // One parser Worker per read, nested in this run's Worker, terminated when it answers or is stopped (D-082).
    pdfReader: workerPdfReader(() => new Worker(new URL(PDF_WORKER_SCRIPT, self.location.href), { type: "module" }) as unknown as WorkerLike),
    onCheckpoint: (runId) => scope.postMessage({ kind: "progress", runId }),
  });
  void handle.done.then((status) => {
    scope.postMessage({ kind: "finished", runId: command.message.runId, status });
    scope.close();
  });
};
