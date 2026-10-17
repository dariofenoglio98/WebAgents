/**
 * The compute call's Worker in the extension (compute.v0, D-251): the run's Worker spawns one of
 * these per call, hands it the compiled module and the input bytes, and terminates it when the
 * answer arrives, the deadline passes or the run is cancelled. It answers exactly once and closes:
 * no chrome.* API, no storage, no network, no state between calls. The module itself imports
 * nothing (C-14), so the only thing this Worker can do is compute over the bytes it was given.
 */
import { answerComputeRequest } from "../../core/compute/engine.js";
import { runComputeCall } from "../../core/compute/worker-body.js";

const scope = self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void; close(): void };

scope.onmessage = (event) => {
  scope.onmessage = null; // one call per Worker
  const answer = answerComputeRequest(event.data, runComputeCall);
  if (answer === null) return;
  scope.postMessage(answer, answer.ok ? [answer.output] : []);
  scope.close();
};
