/**
 * The Node CLI's compute engine (compute.v0, D-250, D-251): one `worker_threads` Worker per call
 * over the built `compute-worker.js` beside the CLI bundle, named `node/<version>` in the audit.
 * The same adapter serves the test suite, which builds the Worker entry itself.
 */
import { Worker } from "node:worker_threads";

import { workerComputeEngine, type ComputeEngine, type ComputeWorkerLike } from "./core/compute/engine.js";

/** A `worker_threads` Worker behind the core's Worker-like surface (the extension's `Worker` has it natively). */
export function nodeWorkerLike(worker: Worker): ComputeWorkerLike {
  const like: ComputeWorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    terminate: () => void worker.terminate(),
  };
  worker.on("message", (data: unknown) => like.onmessage?.({ data }));
  worker.on("error", (error: unknown) => like.onerror?.(error));
  worker.on("messageerror", (error: unknown) => like.onmessageerror?.(error));
  // A Worker that exits before answering (a crash the engine did not report) is the host's fault.
  worker.on("exit", (code: number) => {
    if (code !== 0) like.onerror?.(code);
  });
  return like;
}

/** The engine over Node Workers; `script` defaults to `compute-worker.js` beside the running bundle. */
export function nodeComputeEngine(script: URL = new URL("./compute-worker.js", import.meta.url)): ComputeEngine {
  return workerComputeEngine(() => nodeWorkerLike(new Worker(script)), { id: `node/${process.version}` });
}
