/**
 * Selected-file capabilities and the paper-reader binding.
 *
 * The authority model under test: a package can only ever say a *string*. The
 * host turns an explicit operator selection into an opaque capability bound to
 * one package session and one run, copies the exact bytes once, and reads that
 * copy — re-verified — and nothing else. A path, a traversal, a symlink, a
 * non-PDF, an oversized file, another session's id and a tampered copy are each
 * refused, and no path ever appears in what a caller or a package sees.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentBrowserError } from "../src/errors.js";
import {
  FileCapabilityStore,
  MAX_FILES_PER_SESSION,
  MAX_SELECTED_FILE_BYTES,
  attachmentsOf,
} from "../src/file-capabilities.js";
import { readPdfAnswer, spawnPdfReader, type PdfReader } from "../src/pdf-reader.js";
import { ToolBroker } from "../src/tool-broker.js";
import { BUILT_IN_BINDINGS } from "../src/tool-registry.js";
import { AGENTPKG_BIN, hasAgentpkg } from "./fixtures.js";
import { makePdf } from "./pdf.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const READER = BUILT_IN_BINDINGS.find((item) => item.toolId === "paper-reader")!;
const SESSION = "session-files-12345678";
const OTHER = "session-other-12345678";

let dir = "";
let root = "";
let state = "";
let store: FileCapabilityStore;

async function refusal(promise: Promise<unknown>): Promise<AgentBrowserError> {
  try {
    await promise;
  } catch (error) {
    return error as AgentBrowserError;
  }
  throw new Error("expected a refusal");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-browser-files-"));
  root = join(dir, "allowed");
  state = join(dir, "state");
  await mkdir(root);
  store = new FileCapabilityStore(state);
  await store.initialize();
});

afterEach(async () => {
  await store.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("selecting a file makes an opaque capability over exact bytes", () => {
  it("copies an explicitly selected PDF once and names it by id, hash and size only", async () => {
    const data = makePdf(["A selected page."]);
    const path = join(root, "paper.pdf");
    await writeFile(path, data);
    const view = await store.selectLocal(SESSION, path, [root]);
    expect(view.fileId).toMatch(/^file_[0-9a-f]{32}$/u);
    expect(view.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(view.bytes).toBe(data.length);
    expect(view.mediaType).toBe("application/pdf");
    expect(view.displayName).toBe("paper.pdf");
    expect(JSON.stringify(view)).not.toContain(root);
    expect(JSON.stringify(view)).not.toContain(state);
    // The private copy is owner-read-only, in an owner-only directory.
    expect(await store.rootMode()).toBe(0o700);
    const [copy] = await readdir(state);
    expect(copy).toBe(`${view.fileId}.pdf`);
    expect((await stat(join(state, copy!))).mode & 0o777).toBe(0o400);
    // A change to the original after selection changes nothing about the run.
    await writeFile(path, makePdf(["A different page."]));
    expect((await store.readVerified(view)).equals(data)).toBe(true);
  });

  it("refuses paths it was not configured for, and anything but a regular PDF", async () => {
    const outside = join(dir, "outside.pdf");
    await writeFile(outside, makePdf(["outside"]));
    await writeFile(join(root, "notes.txt"), "not a pdf");
    await writeFile(join(root, "fake.pdf"), "GIF89a pretending");
    await mkdir(join(root, "folder.pdf"));
    await symlink(outside, join(root, "link.pdf"));
    await writeFile(join(root, "empty.pdf"), "");
    const cases: Array<[string, string[], RegExp]> = [
      [outside, [root], /outside the allowed/u],
      [join(root, "..", "outside.pdf"), [root], /outside the allowed/u],
      [join(root, "missing.pdf"), [root], /not found/iu],
      ["relative/paper.pdf", [root], /Absolute path/u],
      ["~/paper.pdf", [root], /Absolute path/u],
      ["file:///etc/passwd", [root], /Absolute path/u],
      ["/etc/passwd", [root], /Not a PDF/u],
      [join(root, "notes.txt"), [root], /Not a PDF/u],
      [join(root, "fake.pdf"), [root], /Not a PDF/u],
      [join(root, "folder.pdf"), [root], /regular file/u],
      [join(root, "link.pdf"), [root], /Symbolic links/u],
      [join(root, "empty.pdf"), [root], /size/iu],
      [join(root, "paper.pdf"), [], /not enabled/u],
    ];
    await writeFile(join(root, "paper.pdf"), makePdf(["fine"]));
    for (const [path, roots, message] of cases) {
      const error = await refusal(store.selectLocal(SESSION, path, roots));
      expect(`${error.title} ${error.detail}`, path).toMatch(message);
    }
    expect(store.list(SESSION)).toEqual([]);
  });

  it("refuses an oversized file before keeping a byte", async () => {
    const path = join(root, "huge.pdf");
    const big = Buffer.alloc(MAX_SELECTED_FILE_BYTES + 1, 0x20);
    Buffer.from("%PDF-1.4\n").copy(big);
    await writeFile(path, big);
    const error = await refusal(store.selectLocal(SESSION, path, [root]));
    expect(error.detail).toMatch(/between 1 byte/u);
    expect(await readdir(state)).toEqual([]);
  });

  it("bounds how many files one session may hold", async () => {
    for (let index = 0; index < MAX_FILES_PER_SESSION; index += 1) {
      const path = join(root, `p${index}.pdf`);
      await writeFile(path, makePdf([`page ${index}`]));
      await store.selectLocal(SESSION, path, [root]);
    }
    const path = join(root, "one-more.pdf");
    await writeFile(path, makePdf(["one more"]));
    const error = await refusal(store.selectLocal(SESSION, path, [root]));
    expect(error.code).toBe("limit_reached");
  });

  it("attaches only this session's live capabilities to a run", async () => {
    const path = join(root, "paper.pdf");
    await writeFile(path, makePdf(["mine"]));
    const mine = await store.selectLocal(SESSION, path, [root]);
    const theirs = await store.selectLocal(OTHER, path, [root]);
    const attached = store.attach(SESSION, [mine.fileId]);
    expect([...attached.keys()]).toEqual([mine.fileId]);
    expect(attachmentsOf(attached)).toEqual([
      { file_id: mine.fileId, sha256: mine.sha256, bytes: mine.bytes, media_type: "application/pdf" },
    ]);
    for (const id of [theirs.fileId, "/etc/passwd", "../x.pdf", `file_${"0".repeat(32)}`]) {
      const error = await refusal(Promise.resolve().then(() => store.attach(SESSION, [id])));
      expect(error.code).toBe("invalid_request");
    }
  });

  it("expires capabilities and releases them with their session", async () => {
    let now = Date.parse("2026-09-23T12:00:00Z");
    const timed = new FileCapabilityStore(join(dir, "timed"), { ttlSeconds: 60, now: () => now });
    await timed.initialize();
    const path = join(root, "paper.pdf");
    await writeFile(path, makePdf(["timed"]));
    const view = await timed.selectLocal(SESSION, path, [root]);
    now += 61_000;
    expect(timed.list(SESSION)).toEqual([]);
    const error = await refusal(Promise.resolve().then(() => timed.attach(SESSION, [view.fileId])));
    expect(error.code).toBe("invalid_request");
    const again = await store.selectLocal(SESSION, path, [root]);
    expect(await store.releaseSession(SESSION)).toBe(1);
    expect(store.list(SESSION)).toEqual([]);
    expect(await readdir(state)).not.toContain(`${again.fileId}.pdf`);
    await timed.stop();
  });

  it("refuses to read a copy whose bytes no longer match the selection", async () => {
    const path = join(root, "paper.pdf");
    await writeFile(path, makePdf(["original"]));
    const view = await store.selectLocal(SESSION, path, [root]);
    const copy = join(state, `${view.fileId}.pdf`);
    await chmod(copy, 0o600);
    await writeFile(copy, makePdf(["tampered"]));
    await expect(store.readVerified(view)).rejects.toThrow();
    await writeFile(copy, "short");
    await expect(store.readVerified(view)).rejects.toThrow();
  });
});

function readerBroker(options: { files: Map<string, Awaited<ReturnType<FileCapabilityStore["selectLocal"]>>>; pdfReader: PdfReader }) {
  const item = {
    toolId: "paper-reader",
    bindingId: READER.id,
    bindingSha256: "b".repeat(64),
    remote: false,
    timeoutSeconds: 20,
  };
  return {
    item,
    broker: new ToolBroker({
      bound: [item],
      definitions: [READER],
      logger: log,
      files: options.files,
      fileStore: store,
      pdfReader: options.pdfReader,
    }),
  };
}

function call(item: { toolId: string; bindingId: string; bindingSha256: string }, args: unknown) {
  return { tool_id: item.toolId, binding_id: item.bindingId, binding_sha256: item.bindingSha256, args };
}

describe("the paper-reader binding reads this run's files and nothing else", () => {
  it("hands the parser the exact selected bytes and returns its checked answer", async () => {
    const data = makePdf([["Evidence sentence one.", "Evidence sentence two."], "Second page."]);
    const path = join(root, "paper.pdf");
    await writeFile(path, data);
    const view = await store.selectLocal(SESSION, path, [root]);
    const seen: Buffer[] = [];
    const { item, broker } = readerBroker({
      files: new Map([[view.fileId, view]]),
      pdfReader: async (bytes) => {
        seen.push(bytes);
        return {
          pages: [{ page: 1, text: "stub" }],
          sha256: createHash("sha256").update(bytes).digest("hex"),
          source: "user_pdf",
        };
      },
    });
    const answer = await broker.call(call(item, { file_id: view.fileId }), new AbortController().signal);
    expect(answer.remote).toBe(false);
    expect(answer.transport_status).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.equals(data)).toBe(true);
  });

  it("refuses every string that is not one of this run's capabilities, before any read", async () => {
    const path = join(root, "paper.pdf");
    await writeFile(path, makePdf(["x"]));
    const view = await store.selectLocal(SESSION, path, [root]);
    const other = await store.selectLocal(OTHER, path, [root]);
    let parsed = 0;
    const { item, broker } = readerBroker({
      files: new Map([[view.fileId, view]]),
      pdfReader: async () => {
        parsed += 1;
        throw new Error("must not be reached");
      },
    });
    const signal = new AbortController().signal;
    for (const args of [
      { file_id: "/etc/passwd" },
      { file_id: "../../etc/passwd" },
      { file_id: "~/paper.pdf" },
      { file_id: "file:///etc/passwd" },
      { file_id: path },
      { file_id: other.fileId },
      { file_id: `file_${"f".repeat(32)}` },
      { file_id: view.fileId, path: "/etc/passwd" },
      { path: path },
      { file_id: 7 },
      "file_id",
    ]) {
      const error = await refusal(broker.call(call(item, args), signal));
      expect(error.detail, JSON.stringify(args)).toMatch(/^tool_request_invalid/u);
      // The refusal never echoes a path back.
      expect(error.detail).not.toContain(root);
    }
    expect(parsed).toBe(0);
  });

  it("stops when the run is cancelled", async () => {
    const path = join(root, "paper.pdf");
    await writeFile(path, makePdf(["x"]));
    const view = await store.selectLocal(SESSION, path, [root]);
    const { item, broker } = readerBroker({
      files: new Map([[view.fileId, view]]),
      pdfReader: (_bytes, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const controller = new AbortController();
    const pending = broker.call(call(item, { file_id: view.fileId }), controller.signal);
    setTimeout(() => controller.abort(), 20);
    const error = await refusal(pending);
    expect(error.detail).toMatch(/^tool_cancelled/u);
  });
});

describe("the parser's answer is checked before it is believed", () => {
  const sha = "c".repeat(64);
  it("accepts exactly pages, sha256 and source, describing the bytes it was sent", () => {
    const answer = readPdfAnswer(
      JSON.stringify({ pages: [{ page: 1, text: "a" }, { page: 2, text: "b" }], sha256: sha, source: "user_pdf" }),
      sha,
    );
    expect(answer.pages).toHaveLength(2);
  });

  it("refuses anything else", () => {
    for (const raw of [
      "not json",
      "[]",
      JSON.stringify({ pages: [], sha256: sha, source: "user_pdf", extra: 1 }),
      JSON.stringify({ pages: [], sha256: "d".repeat(64), source: "user_pdf" }),
      JSON.stringify({ pages: [], sha256: sha, source: "web" }),
      JSON.stringify({ pages: [{ page: 2, text: "skipped page one" }], sha256: sha, source: "user_pdf" }),
      JSON.stringify({ pages: [{ page: 1, text: 5 }], sha256: sha, source: "user_pdf" }),
      JSON.stringify({ pages: [{ page: 1, text: "a", path: "/x" }], sha256: sha, source: "user_pdf" }),
    ]) {
      expect(() => readPdfAnswer(raw, sha), raw).toThrow(AgentBrowserError);
    }
  });
});

describe.runIf(hasAgentpkg())("the real parser, spawned as the broker spawns it", () => {
  const reader = () =>
    spawnPdfReader({ agentpkgPath: AGENTPKG_BIN, timeoutMs: 30_000, maxOutputBytes: 512 * 1024 });

  it("extracts every page of a real PDF from bytes on stdin", async () => {
    const data = makePdf([["Dynamic agent selection routes tasks.", "Second line."], "Page two."]);
    const answer = await reader()(data, new AbortController().signal);
    expect(answer.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(answer.pages).toEqual([
      { page: 1, text: "Dynamic agent selection routes tasks.\nSecond line.\n" },
      { page: 2, text: "Page two.\n" },
    ]);
  }, 60_000);

  it("turns a malformed document into a controlled refusal", async () => {
    const error = await refusal(
      reader()(Buffer.from("%PDF-1.4\nthis is not a real document\n%%EOF\n"), new AbortController().signal),
    );
    expect(error.detail).toMatch(/^tool_response_invalid: the PDF could not be read \(malformed_pdf\)/u);
    const notPdf = await refusal(reader()(Buffer.from("plain text"), new AbortController().signal));
    expect(notPdf.detail).toMatch(/not_a_pdf/u);
  }, 60_000);

  it("kills the parser when the call is cancelled or its deadline passes", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await refusal(reader()(makePdf(["x"]), controller.signal));
    expect(cancelled.detail).toMatch(/^tool_cancelled/u);
    const slow = spawnPdfReader({ agentpkgPath: AGENTPKG_BIN, timeoutMs: 1, maxOutputBytes: 512 * 1024 });
    const timedOut = await refusal(slow(makePdf(["x"]), new AbortController().signal));
    expect(timedOut.detail).toMatch(/^tool_timeout/u);
  }, 60_000);

  it("refuses an answer larger than the binding allows", async () => {
    const tiny = spawnPdfReader({ agentpkgPath: AGENTPKG_BIN, timeoutMs: 30_000, maxOutputBytes: 32 });
    const error = await refusal(tiny(makePdf(["more than thirty-two bytes of text"]), new AbortController().signal));
    expect(error.detail).toMatch(/exceeds this binding's limit/u);
  }, 60_000);
});
