/**
 * Bounded page-text extraction from PDF bytes with pdf.js (T6, D-082): the Chrome host's port of
 * `agentpkg.hostfiles.pdf.extract_text`. One function, two callers: the extension's PDF Worker
 * (`src/extension/execution/pdf-worker.ts`, a short-lived Worker the run's Worker spawns per read
 * and terminates on cancel or deadline, the browser's stand-in for the reference's killable
 * process) and the Node CLI.
 *
 * What it refuses, before or during parsing, with the reference's stable reasons
 * (`PDF_REFUSALS`): more bytes than the limit, bytes not beginning with `%PDF-`, an encrypted
 * document, more pages than the limit, one page whose text exceeds the per-page limit, more text
 * in total than the total limit; anything pdf.js cannot read is `malformed_pdf`.
 *
 * What it never does: render, OCR, run a script (pdf.js 6 evaluates no code; XFA is off), fetch a font,
 * a CMap, a WASM decoder or any range of the document (`data` in memory; no URL is given for any
 * of them), extract an attachment, or write anything. `getTextContent` reads each page's content
 * streams. Page text is the text items in content order, a newline after an item pdf.js marks as
 * ending a line. It agrees with pypdf's up to whitespace on the vectors in
 * `test/fixtures/pdf-text-vectors.json`; the two parsers are different programs, so a package's
 * quote checks always compare against the text *this* run extracted, never another parser's.
 *
 * pdf.js normally runs its parser in its own worker; here the parser module is loaded into this
 * context (`globalThis.pdfjsWorker`), which pdf.js then uses in place of a nested worker, so no
 * script is loaded from a URL at run time. The legacy build is used in Node and in Chrome alike so
 * that both hosts run one parser.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

import { sha256HexSync } from "../core/hash.js";
import { PDF_LIMITS, PdfRefusal, type PdfText } from "../core/tools/adapters/selected-file.js";

export type PdfLimits = typeof PDF_LIMITS;

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= pdfjsWorker;

interface TextItemLike {
  str?: unknown;
  hasEOL?: unknown;
}

/** Return `{pages, sha256, source}` for one PDF, or reject with `PdfRefusal`. */
export async function extractPdfText(data: Uint8Array, limits: PdfLimits = PDF_LIMITS, signal?: AbortSignal): Promise<PdfText> {
  if (!(data instanceof Uint8Array)) throw new PdfRefusal("not_bytes");
  if (data.length === 0) throw new PdfRefusal("empty");
  if (data.length > limits.max_bytes) throw new PdfRefusal("too_large");
  if (!MAGIC.every((byte, index) => data[index] === byte)) throw new PdfRefusal("not_a_pdf");
  const sha256 = sha256HexSync(data);
  // pdf.js takes ownership of the buffer it is given; it gets a copy, so the hash above names
  // the bytes the caller still holds.
  const task = pdfjs.getDocument({
    data: data.slice(),
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: true,
    verbosity: 0,
  });
  const onAbort = () => void task.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let document;
    try {
      document = await task.promise;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if ((error as { name?: unknown } | null)?.name === "PasswordException") throw new PdfRefusal("encrypted");
      throw new PdfRefusal("malformed_pdf");
    }
    const metadata = await document.getMetadata().catch(() => null);
    if ((metadata?.info as { EncryptFilterName?: unknown } | undefined)?.EncryptFilterName) throw new PdfRefusal("encrypted");
    if (document.numPages > limits.max_pages) throw new PdfRefusal("too_many_pages");
    const pages: PdfText["pages"] = [];
    const encoder = new TextEncoder();
    let total = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      if (signal?.aborted) throw signal.reason;
      let text = "";
      try {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        for (const item of content.items as TextItemLike[]) {
          if (typeof item.str === "string") text += item.str;
          if (item.hasEOL === true) text += "\n";
        }
        page.cleanup();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof PdfRefusal) throw error;
        throw new PdfRefusal("malformed_pdf");
      }
      const size = encoder.encode(text).length;
      if (size > limits.max_page_text_bytes) throw new PdfRefusal("page_text_too_large");
      total += size;
      if (total > limits.max_total_text_bytes) throw new PdfRefusal("text_too_large");
      pages.push({ page: number, text });
    }
    return { pages, sha256, source: "user_pdf" };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await task.destroy().catch(() => undefined);
  }
}
