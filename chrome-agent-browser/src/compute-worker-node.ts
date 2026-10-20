/**
 * The compute call's Worker for the Node CLI (compute.v0, D-251): the `worker_threads` entry that
 * `dist/compute-worker.js` is built from. One request per Worker: the pure body runs the call and
 * the answer goes back once; the parent terminates the Worker on answer, deadline and cancel.
 */
import { parentPort } from "node:worker_threads";

import { answerComputeRequest } from "./core/compute/engine.js";
import { runComputeCall } from "./core/compute/worker-body.js";

const port = parentPort;
if (port === null) throw new Error("compute-worker runs inside a worker_threads Worker");
port.on("message", (request: unknown) => {
  const answer = answerComputeRequest(request, runComputeCall);
  if (answer === null) return;
  port.postMessage(answer, answer.ok ? [answer.output] : []);
});
