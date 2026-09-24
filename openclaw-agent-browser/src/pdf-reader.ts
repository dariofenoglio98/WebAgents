/**
 * Page text from one selected PDF, through the trusted parser.
 *
 * Parsing a PDF is the riskiest thing a file capability does, so it happens in
 * a separate, short-lived process that is given **bytes on stdin and nothing
 * else**: no path, no descriptor to a directory, no credential in its
 * environment. The parser (`agentpkg host-pdf-read`, in the
 * `agentpkg.hostfiles` namespace) sets its own CPU, address-space and
 * file-size limits, refuses encrypted or oversized documents, bounds pages and
 * extracted text, and writes one JSON document to stdout.
 *
 * This side adds what a parent can enforce and a child cannot promise: a
 * wall-clock deadline, SIGKILL on cancellation or timeout, a byte cap on what
 * it will read back, and a check that the answer describes the bytes it sent.
 * A malformed PDF is a controlled `tool_response_invalid`, never a crash.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { AgentBrowserError, clip } from "./errors.js";

export type PdfText = {
  pages: Array<{ page: number; text: string }>;
  sha256: string;
  source: "user_pdf";
};

export type PdfReaderOptions = {
  agentpkgPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Test seam: replace process creation, never the checks around it. */
  spawnImpl?: typeof spawn;
};

/** A reader the broker can call; tests substitute one that spawns nothing. */
export type PdfReader = (data: Buffer, signal: AbortSignal) => Promise<PdfText>;

const STDERR_KEEP = 2_000;
const HEX64 = /^[0-9a-f]{64}$/u;

function failure(code: string, detail: string): AgentBrowserError {
  return new AgentBrowserError("tool_call_failed", "The tool call failed", `${code}: ${detail}`);
}

/** Validate the parser's answer as a closed shape before believing it. */
export function readPdfAnswer(raw: string, expectedSha256: string): PdfText {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw failure("tool_response_invalid", "the PDF parser returned something other than JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure("tool_response_invalid", "the PDF parser returned no result object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "pages,sha256,source") {
    throw failure("tool_response_invalid", "the PDF parser result carries unexpected fields");
  }
  if (record.source !== "user_pdf" || typeof record.sha256 !== "string" || !HEX64.test(record.sha256)) {
    throw failure("tool_response_invalid", "the PDF parser result is malformed");
  }
  if (record.sha256 !== expectedSha256) {
    // The parser must describe the bytes it was given, which are the bytes
    // the person selected; anything else is a different document.
    throw failure("tool_response_invalid", "the PDF parser described different bytes");
  }
  if (!Array.isArray(record.pages)) {
    throw failure("tool_response_invalid", "the PDF parser returned no pages");
  }
  const pages: PdfText["pages"] = [];
  for (const [index, entry] of record.pages.entries()) {
    const page = entry as Record<string, unknown>;
    if (
      typeof entry !== "object" ||
      entry === null ||
      Object.keys(page).sort().join(",") !== "page,text" ||
      page.page !== index + 1 ||
      typeof page.text !== "string"
    ) {
      throw failure("tool_response_invalid", "the PDF parser returned a malformed page");
    }
    pages.push({ page: index + 1, text: page.text });
  }
  return { pages, sha256: record.sha256, source: "user_pdf" };
}

/** Build the real reader: one `agentpkg host-pdf-read` process per call. */
export function spawnPdfReader(options: PdfReaderOptions): PdfReader {
  return (data, signal) =>
    new Promise<PdfText>((resolve, reject) => {
      const expected = createHash("sha256").update(data).digest("hex");
      let child: ChildProcess;
      try {
        child = (options.spawnImpl ?? spawn)(options.agentpkgPath, ["host-pdf-read"], {
          stdio: ["pipe", "pipe", "pipe"],
          // A minimal environment: the parser needs no credential, no proxy
          // setting and no host configuration, so none reaches it.
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LANG: "C.UTF-8",
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONUNBUFFERED: "1",
            NO_COLOR: "1",
          },
          windowsHide: true,
        });
      } catch {
        reject(failure("tool_unavailable", "the PDF parser could not be started"));
        return;
      }
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = "";
      const finish = (error: AgentBrowserError | null, value?: PdfText) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (error) reject(error);
        else resolve(value!);
      };
      const onAbort = () => finish(failure("tool_cancelled", "the tool call was cancelled"));
      const timer = setTimeout(
        () => finish(failure("tool_timeout", "the PDF parser did not finish in time")),
        options.timeoutMs,
      );
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => finish(failure("tool_unavailable", "the PDF parser could not be started")));
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.byteLength > options.maxOutputBytes) {
          finish(failure("tool_response_invalid", "the extracted text exceeds this binding's limit"));
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-STDERR_KEEP);
      });
      child.on("close", (code) => {
        if (settled) return;
        const text = stdout.toString("utf8");
        if (code === 0) {
          try {
            finish(null, readPdfAnswer(text, expected));
          } catch (error) {
            finish(error as AgentBrowserError);
          }
          return;
        }
        // A refusal is a JSON object naming a stable reason; the document's own
        // content never appears in it.
        let reason = "parse_failed";
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (typeof parsed.error === "string") reason = clip(parsed.error, 64);
        } catch {
          // Keep the generic reason.
        }
        void stderr;
        finish(failure("tool_response_invalid", `the PDF could not be read (${reason})`));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(data);
    });
}
