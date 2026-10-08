/**
 * The paper reader's parser as the run's Worker calls it (T6, D-082): one `pdf-worker.js` Worker
 * per read, given a copy of the verified bytes and **terminated** when it answers, when the run
 * is cancelled and when the binding's deadline passes (the broker's signal carries both). A
 * Worker that dies without answering is `parse_failed`. The answer is believed only after the
 * core adapter checks it describes the bytes it was given (`readPdfAnswer`).
 */
import { PdfRefusal, type PdfText, type PdfTextReader } from "../../core/tools/adapters/selected-file.js";
import { PDF_ANSWER_KIND, type PdfWorkerAnswer } from "./pdf-worker.js";

export const PDF_WORKER_SCRIPT = "pdf-worker.js";

export interface WorkerLike {
  onmessage: ((event: MessageEvent<PdfWorkerAnswer>) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

/** `spawn` creates the parser Worker (`new Worker(url, {type: "module"})` in the extension; a fake in tests). */
export function workerPdfReader(spawn: () => WorkerLike): PdfTextReader {
  return (data, signal) =>
    new Promise<PdfText>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      let worker: WorkerLike;
      try {
        worker = spawn();
      } catch {
        reject(new PdfRefusal("parse_failed"));
        return;
      }
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        worker.terminate();
        outcome();
      };
      const onAbort = (): void => finish(() => reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      worker.onmessage = (event) => {
        const answer = event.data as PdfWorkerAnswer | { kind?: unknown } | null;
        // Only this protocol's answer counts: pdf.js's own "ready" announcement is not one.
        if (typeof answer !== "object" || answer === null || answer.kind !== PDF_ANSWER_KIND) return;
        if ("ok" in answer && answer.ok === true) finish(() => resolve(answer.result as PdfText));
        else finish(() => reject(new PdfRefusal("ok" in answer && answer.ok === false && typeof answer.reason === "string" ? answer.reason : "parse_failed")));
      };
      worker.onerror = () => finish(() => reject(new PdfRefusal("parse_failed")));
      worker.onmessageerror = () => finish(() => reject(new PdfRefusal("parse_failed")));
      const copy = data.slice().buffer;
      worker.postMessage({ data: copy }, [copy]);
    });
}
