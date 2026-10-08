/**
 * Selected-file reads (T6, D-082): the `selected_file` category of `tool-registry.ts` and the
 * reference broker's `selectedFile`, over two host ports. A package can only put a *string* in a
 * `file_id` argument; the handler looks that string up among the files attached to **this run**
 * (the Run Invocation's `attachments`, which the service worker resolved from the task before the
 * lease) and refuses anything else, so a path, `../x.pdf`, a `file://` URL and a valid id the
 * person picked but did not give this run are the same refusal: not a file this run was given.
 * No path, display name or handle ever crosses into a package, a plan, an audit, a model or a
 * result; the audit names the opaque id and the hash only.
 *
 *   person picks a PDF          (Settings → Files: its bytes are copied once, hashed, kept)
 *        │  opaque capability   file_<32 hex>, sha256 and size recorded at selection
 *        ▼
 *   the task names it           (the `selected_files` input widget), the run is given exactly it
 *        ▼
 *   this handler                reads the stored copy, re-checks size and hash, hands **bytes**
 *                               to the parser (a killable Worker in the extension), and checks
 *                               the parser's answer describes those bytes before believing it
 */
import { sha256HexSync } from "../../hash.js";
import type { JsonValue } from "../../json.js";
import type { ToolBindingRecord } from "../bindings.js";
import type { ToolImplementationDefinition } from "../definitions.js";
import { toolError } from "./json-http.js";

export const SELECTED_PDF_IMPLEMENTATION = Object.freeze({ id: "chrome.tool.selected_pdf_text", version: "0.1.0" });
export const FILE_ID_PATTERN = /^file_[0-9a-f]{32}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * The parser's bounds: `agentpkg.hostfiles.pdf.PdfLimits` (`DEFAULT_LIMITS`), the same numbers so
 * that a document one runtime refuses the other refuses too. The Python CPU and address-space
 * limits have no browser equivalent; the binding's deadline and a terminated Worker stand in.
 */
export const PDF_LIMITS = Object.freeze({
  max_bytes: 20 * 1024 * 1024,
  max_pages: 100,
  max_page_text_bytes: 64 * 1024,
  // The answer travels to a package whose tool output is capped at 512 KiB; the text must fit
  // with room for its JSON escaping.
  max_total_text_bytes: 256 * 1024,
});

/** The stable reasons a parser refuses a document with (`PdfRefused` codes); never document content. */
export const PDF_REFUSALS = new Set(["not_bytes", "empty", "too_large", "not_a_pdf", "encrypted", "too_many_pages", "page_text_too_large", "text_too_large", "malformed_pdf", "parse_failed"]);

/** One file this run was given, as the Run Invocation binds it: path-free. */
export interface SelectedFileAttachment {
  file_id: string;
  sha256: string;
  bytes: number;
  media_type: string;
}

export interface PdfText {
  pages: Array<{ page: number; text: string }>;
  sha256: string;
  source: "user_pdf";
}

/** A parser refusal with a stable reason from `PDF_REFUSALS`. */
export class PdfRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Where a run's attached files' bytes come from (host code): the stored copy, never the original. */
export interface SelectedFileSource {
  read(file: SelectedFileAttachment, signal: AbortSignal): Promise<Uint8Array>;
}

/** The trusted parser, handed bytes and never a path; rejects with `PdfRefusal` for a document it will not read. */
export type PdfTextReader = (data: Uint8Array, signal: AbortSignal) => Promise<PdfText>;

/** The files one run was given, and the host code that reads them. */
export interface SelectedFiles {
  attached: ReadonlyMap<string, SelectedFileAttachment>;
  source: SelectedFileSource | null;
  reader: PdfTextReader | null;
}

/** Validate the parser's answer as a closed shape before believing it (`pdf-reader.ts::readPdfAnswer`). */
export function readPdfAnswer(value: unknown, expectedSha256: string): PdfText {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw toolError("tool_response_invalid", "the PDF parser returned no result object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "pages,sha256,source") throw toolError("tool_response_invalid", "the PDF parser result carries unexpected fields");
  if (record.source !== "user_pdf" || typeof record.sha256 !== "string" || !HEX64.test(record.sha256)) throw toolError("tool_response_invalid", "the PDF parser result is malformed");
  // The parser must describe the bytes it was given, which are the bytes the person selected.
  if (record.sha256 !== expectedSha256) throw toolError("tool_response_invalid", "the PDF parser described different bytes");
  if (!Array.isArray(record.pages)) throw toolError("tool_response_invalid", "the PDF parser returned no pages");
  const pages: PdfText["pages"] = [];
  for (const [index, entry] of record.pages.entries()) {
    const page = entry as Record<string, unknown>;
    if (typeof entry !== "object" || entry === null || Object.keys(page).sort().join(",") !== "page,text" || page.page !== index + 1 || typeof page.text !== "string") {
      throw toolError("tool_response_invalid", "the PDF parser returned a malformed page");
    }
    pages.push({ page: index + 1, text: page.text });
  }
  return { pages, sha256: record.sha256, source: "user_pdf" };
}

/**
 * Read one file this run was given, by opaque id, and nothing else. The argument set is closed
 * to `file_id`; the bytes are re-verified against the size and hash the selection recorded; the
 * parser's answer must describe those bytes. A malformed PDF is a controlled
 * `tool_response_invalid` naming a stable reason, never a crash and never document text.
 */
export async function selectedFileCall(definition: ToolImplementationDefinition, binding: ToolBindingRecord, args: JsonValue, files: SelectedFiles | null, signal: AbortSignal, maxRequestBytes: number): Promise<JsonValue> {
  if (definition.implementationId !== SELECTED_PDF_IMPLEMENTATION.id) throw toolError("tool_unavailable", "this host has no code for that file implementation");
  const record = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, JsonValue>) : null;
  if (record === null || Object.keys(record).join(",") !== "file_id" || typeof record.file_id !== "string") {
    throw toolError("tool_request_invalid", "a selected-file read takes exactly one file_id");
  }
  if (new TextEncoder().encode(record.file_id).length > maxRequestBytes) throw toolError("tool_request_invalid", "the file id exceeds this binding's limit");
  const attachment = FILE_ID_PATTERN.test(record.file_id) ? files?.attached.get(record.file_id) : undefined;
  // The same answer for every string that is not one of this run's files; it never says whether
  // a path exists or whether the person picked that id for another run.
  if (attachment === undefined) throw toolError("tool_request_invalid", "this run was given no selected file with that id");
  if (!files?.source || !files.reader) throw toolError("tool_unavailable", "this host has no file reader configured for runs");
  void binding;
  let data: Uint8Array;
  try {
    data = await files.source.read(attachment, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw toolError("tool_unavailable", "the selected file is no longer held by this browser, so it is not read");
  }
  if (data.length !== attachment.bytes || sha256HexSync(data) !== attachment.sha256) {
    throw toolError("tool_unavailable", "the selected file no longer matches what was selected, so it is not read");
  }
  let answer: PdfText;
  try {
    answer = await files.reader(data, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof PdfRefusal) {
      const reason = PDF_REFUSALS.has(error.reason) ? error.reason : "parse_failed";
      throw toolError("tool_response_invalid", `the PDF could not be read (${reason})`, { stage: "adapter_response" });
    }
    throw toolError("tool_response_invalid", "the PDF could not be read (parse_failed)", { stage: "adapter_response" });
  }
  return readPdfAnswer(answer, attachment.sha256) as unknown as JsonValue;
}
