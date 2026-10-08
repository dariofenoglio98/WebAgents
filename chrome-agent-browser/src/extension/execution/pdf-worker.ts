/**
 * The PDF parser's Worker (T6, D-082): the browser's stand-in for the reference's killable
 * `agentpkg host-pdf-read` process. The run's Worker spawns one of these per read, hands it the
 * verified **bytes** (never a path or a handle) and terminates it when the answer arrives, the
 * run is cancelled or the binding's deadline passes. It answers exactly once and closes: no
 * chrome.* API, no storage, no network, no state between documents.
 */
import { PdfRefusal } from "../../core/tools/adapters/selected-file.js";
import { extractPdfText } from "../../pdf/extract.js";

export type PdfWorkerRequest = { data: ArrayBuffer };
export type PdfWorkerAnswer = { ok: true; result: unknown } | { ok: false; reason: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent<PdfWorkerRequest>) => void) | null; postMessage(message: PdfWorkerAnswer): void; close(): void };

scope.onmessage = (event) => {
  scope.onmessage = null; // one document per Worker
  const data = event.data?.data;
  void (async () => {
    let answer: PdfWorkerAnswer;
    try {
      if (!(data instanceof ArrayBuffer)) throw new PdfRefusal("not_bytes");
      answer = { ok: true, result: await extractPdfText(new Uint8Array(data)) };
    } catch (error) {
      // A refusal is a stable reason; anything else is `parse_failed`. No document text either way.
      answer = { ok: false, reason: error instanceof PdfRefusal ? error.reason : "parse_failed" };
    }
    scope.postMessage(answer);
    scope.close();
  })();
};
