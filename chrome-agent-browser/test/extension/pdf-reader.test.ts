/**
 * The paper reader's Worker protocol (T6, D-082): one Worker per read, terminated when it
 * answers, when the run is cancelled and when the deadline passes; only this protocol's tagged
 * answer counts, so pdf.js's own "ready" announcement (posted by its parser module in any Worker,
 * found in Chrome 154 by `scripts/e2e-paper-reader.mjs`) is ignored; a Worker that dies is
 * `parse_failed`.
 */
import { describe, expect, it } from "vitest";

import { PdfRefusal } from "../../src/core/tools/adapters/selected-file.js";
import { workerPdfReader, type WorkerLike } from "../../src/extension/execution/pdf-reader.js";
import { PDF_ANSWER_KIND } from "../../src/extension/execution/pdf-worker.js";

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  onmessageerror: WorkerLike["onmessageerror"] = null;
  terminated = false;
  received: unknown[] = [];
  constructor(private readonly script: (worker: FakeWorker) => void) {}
  postMessage(message: unknown): void {
    this.received.push(message);
    queueMicrotask(() => this.script(this));
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const RESULT = { pages: [{ page: 1, text: "x" }], sha256: "a".repeat(64), source: "user_pdf" };

describe("the parser Worker protocol", () => {
  it("ignores pdf.js's ready announcement and resolves with the tagged answer, then terminates the Worker", async () => {
    let worker!: FakeWorker;
    const reader = workerPdfReader(() => (worker = new FakeWorker((self) => {
      self.emit({ sourceName: "worker", targetName: "main", action: "ready", data: null });
      self.emit({ kind: PDF_ANSWER_KIND, ok: true, result: RESULT });
    })));
    await expect(reader(new Uint8Array([1, 2, 3]), new AbortController().signal)).resolves.toEqual(RESULT);
    expect(worker.terminated).toBe(true);
    expect(worker.received).toEqual([{ data: new Uint8Array([1, 2, 3]).buffer }]);
  });

  it("a tagged refusal names its reason; a Worker error is parse_failed", async () => {
    const refusing = workerPdfReader(() => new FakeWorker((self) => self.emit({ kind: PDF_ANSWER_KIND, ok: false, reason: "encrypted" })));
    await expect(refusing(new Uint8Array([1]), new AbortController().signal)).rejects.toEqual(new PdfRefusal("encrypted"));
    const dying = workerPdfReader(() => new FakeWorker((self) => self.onerror?.(new Event("error"))));
    await expect(dying(new Uint8Array([1]), new AbortController().signal)).rejects.toEqual(new PdfRefusal("parse_failed"));
  });

  it("a cancel or a deadline terminates a Worker that has not answered", async () => {
    let worker!: FakeWorker;
    const silent = workerPdfReader(() => (worker = new FakeWorker(() => undefined)));
    const controller = new AbortController();
    const reading = silent(new Uint8Array([1]), controller.signal);
    controller.abort(new Error("deadline"));
    await expect(reading).rejects.toThrow(/deadline/u);
    expect(worker.terminated).toBe(true);
  });
});
