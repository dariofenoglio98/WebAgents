/**
 * Selected-file reads through the broker (T6, D-082): the run reads exactly the files it was
 * given, by opaque id, re-verified against the hash recorded at selection; a path, another id or
 * a changed copy is refused before the parser sees a byte; the parser's answer must describe
 * those bytes; a refused document names a stable reason and no content; and the audit names the
 * file by opaque id and hash only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256HexSync } from "../../../src/core/hash.js";
import { buildHostToolRegistry, evaluateRegistry, planToolBindings } from "../../../src/core/hosttools.js";
import type { JsonValue } from "../../../src/core/json.js";
import { PdfRefusal, readPdfAnswer, type PdfTextReader, type SelectedFileAttachment, type SelectedFiles } from "../../../src/core/tools/adapters/selected-file.js";
import { normalizeToolBindings } from "../../../src/core/tools/bindings.js";
import { toolHandlers } from "../../../src/core/tools/broker.js";
import { definitionsFromRegistry } from "../../../src/core/tools/definitions.js";
import { Pacer } from "../../../src/core/tools/pacer.js";
import { AdapterError } from "../../../src/core/workflow/errors.js";
import { extractPdfText } from "../../../src/pdf/extract.js";
import { literatureReview } from "../../helpers/fixtures.js";
import { ROOT } from "../../helpers/paths.js";

const PROBE = new Uint8Array(readFileSync(join(ROOT, "examples", "probe-files", "paper-reader-probe.pdf")));
const FILE_ID = `file_${"a".repeat(32)}`;
const OTHER_ID = `file_${"b".repeat(32)}`;
const NOW = new Date("2026-10-08T12:00:00.000Z");

function attachment(bytes: Uint8Array, fileId = FILE_ID): SelectedFileAttachment {
  return { file_id: fileId, sha256: sha256HexSync(bytes), bytes: bytes.length, media_type: "application/pdf" };
}

async function paperReader(files: SelectedFiles | null) {
  const pkg = await literatureReview();
  const registry = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: null, now: NOW });
  const evaluation = await evaluateRegistry(pkg, registry, { decisions: { "network.scholarly": "session", "network.citations": "session", "files.pdfs": "session", "model.reasoning": "session", "memory.session": "session" }, toolApprovals: { "scholarly-search": true, "citation-resolver": true, "paper-reader": true }, now: NOW });
  const { handlers } = toolHandlers(normalizeToolBindings(planToolBindings(evaluation)), { definitions: definitionsFromRegistry(registry), files, pacer: new Pacer() });
  const events: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const context = { role: "EvidenceWorker", worker_id: "EvidenceWorker:1", event: (action: string, metadata: Record<string, unknown> = {}) => void events.push({ action, metadata }) };
  return { call: (args: JsonValue) => handlers["paper.read"]!(context, args, new AbortController().signal), events };
}

const inProcess: PdfTextReader = (data, signal) => extractPdfText(data, undefined, signal);
const source = (stored: Map<string, Uint8Array>) => ({ read: async (file: SelectedFileAttachment) => stored.get(file.file_id) ?? Promise.reject(new Error("gone")) });

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AdapterError ? `${error.code}: ${error.message}` : `unexpected: ${String(error)}`;
  }
  return "resolved";
}

describe("a run reads exactly the files it was given", () => {
  it("returns the page text of an attached PDF, and the audit names it by opaque id and hash only", async () => {
    const files: SelectedFiles = { attached: new Map([[FILE_ID, attachment(PROBE)]]), source: source(new Map([[FILE_ID, PROBE]])), reader: inProcess };
    const { call, events } = await paperReader(files);
    const answer = (await call({ file_id: FILE_ID })) as { pages: Array<{ page: number; text: string }>; sha256: string; source: string };
    expect(answer.source).toBe("user_pdf");
    expect(answer.sha256).toBe(sha256HexSync(PROBE));
    expect(answer.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(answer.pages[0]!.text).toContain("SYNTHETIC PROBE DOCUMENT");
    const settled = events.find((event) => event.action === "tool.settled")!;
    expect(settled.metadata).toMatchObject({ tool: "paper-reader", status: "ok", file_id: FILE_ID, file_sha256: sha256HexSync(PROBE) });
    expect(JSON.stringify(events)).not.toMatch(/paper-reader-probe|\.pdf|SYNTHETIC/u);
  });

  it("refuses every string that is not one of this run's files, the same way, before reading anything", async () => {
    let reads = 0;
    const files: SelectedFiles = { attached: new Map([[FILE_ID, attachment(PROBE)]]), source: { read: async () => (reads += 1, PROBE) }, reader: inProcess };
    const { call } = await paperReader(files);
    for (const fileId of [OTHER_ID, "/etc/passwd", "../x.pdf", "~/paper.pdf", "file:///tmp/x.pdf", `${FILE_ID} `, FILE_ID.toUpperCase()]) {
      expect(await failure(call({ file_id: fileId }))).toBe("tool_request_invalid: this run was given no selected file with that id");
    }
    for (const args of [{}, { file_id: FILE_ID, page: 1 }, { path: "/etc/passwd" }, [FILE_ID], FILE_ID, { file_id: 7 }] as JsonValue[]) {
      expect(await failure(call(args))).toBe("tool_request_invalid: a selected-file read takes exactly one file_id");
    }
    expect(reads).toBe(0);
  });

  it("refuses a stored copy that no longer matches what was selected, and a host with no reader", async () => {
    const changed = PROBE.slice();
    changed[changed.length - 2] = 0x20;
    const { call } = await paperReader({ attached: new Map([[FILE_ID, attachment(PROBE)]]), source: source(new Map([[FILE_ID, changed]])), reader: inProcess });
    expect(await failure(call({ file_id: FILE_ID }))).toBe("tool_unavailable: the selected file no longer matches what was selected, so it is not read");
    const gone = await paperReader({ attached: new Map([[FILE_ID, attachment(PROBE)]]), source: source(new Map()), reader: inProcess });
    expect(await failure(gone.call({ file_id: FILE_ID }))).toBe("tool_unavailable: the selected file is no longer held by this browser, so it is not read");
    const none = await paperReader({ attached: new Map([[FILE_ID, attachment(PROBE)]]), source: null, reader: null });
    expect(await failure(none.call({ file_id: FILE_ID }))).toBe("tool_unavailable: this host has no file reader configured for runs");
    const noFiles = await paperReader(null);
    expect(await failure(noFiles.call({ file_id: FILE_ID }))).toBe("tool_request_invalid: this run was given no selected file with that id");
  });

  it("a refused document names a stable reason and no content; an answer about other bytes is not believed", async () => {
    const encryptedLike: PdfTextReader = async () => {
      throw new PdfRefusal("encrypted");
    };
    const files = (reader: PdfTextReader): SelectedFiles => ({ attached: new Map([[FILE_ID, attachment(PROBE)]]), source: source(new Map([[FILE_ID, PROBE]])), reader });
    expect(await failure((await paperReader(files(encryptedLike))).call({ file_id: FILE_ID }))).toBe("tool_response_invalid: the PDF could not be read (encrypted)");
    const odd: PdfTextReader = async () => {
      throw new PdfRefusal("secret text from page 3");
    };
    expect(await failure((await paperReader(files(odd))).call({ file_id: FILE_ID }))).toBe("tool_response_invalid: the PDF could not be read (parse_failed)");
    const liar: PdfTextReader = async () => ({ pages: [{ page: 1, text: "x" }], sha256: "0".repeat(64), source: "user_pdf" });
    expect(await failure((await paperReader(files(liar))).call({ file_id: FILE_ID }))).toBe("tool_response_invalid: the PDF parser described different bytes");
    expect(() => readPdfAnswer({ pages: [{ page: 2, text: "x" }], sha256: sha256HexSync(PROBE), source: "user_pdf" }, sha256HexSync(PROBE))).toThrow(/malformed page/u);
    expect(() => readPdfAnswer({ pages: [], sha256: sha256HexSync(PROBE), source: "user_pdf", path: "/x" }, sha256HexSync(PROBE))).toThrow(/unexpected fields/u);
  });
});
