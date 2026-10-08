/** pdf.js ships no declaration for its parser module; the host only hands it to pdf.js (`globalThis.pdfjsWorker`). */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
