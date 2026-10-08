/**
 * The Chrome paper reader's parser (T6, D-082) against the reference parser
 * (`agentpkg.hostfiles.pdf.extract_text`, pypdf), on the vectors
 * `scripts/make-pdf-text-vectors.py` wrote: every refusal is the reference's reason exactly, under
 * the same limits; every accepted document has the same pages in the same order and the hash of
 * the exact bytes; page text is equal up to whitespace (both parsers' runs of whitespace collapse
 * to one space, ends trimmed). The two are different programs, which is why a package checks
 * quotes against the text its own run extracted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256HexSync } from "../../src/core/hash.js";
import { PDF_LIMITS, PdfRefusal } from "../../src/core/tools/adapters/selected-file.js";
import { extractPdfText } from "../../src/pdf/extract.js";
import { PROJECT } from "../helpers/paths.js";

interface Vector {
  name: string;
  base64: string;
  limits: typeof PDF_LIMITS;
  pages?: Array<{ page: number; text: string }>;
  refused?: string;
}
const VECTORS = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "pdf-text-vectors.json"), "utf8")) as { reference: string; default_limits: Record<string, number>; vectors: Vector[] };
const squash = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * Where the two parsers differ on a vector, printed here and asserted as pdf.js's own outcome, so
 * a change in either direction fails the test instead of passing silently (D-082).
 */
const DIVERGENCES: Record<string, { why: string; chrome: { refused: string } | { texts: string[] } }> = {
  latin1: {
    why: "byte 0xEF has no glyph in a standard font's StandardEncoding: pypdf falls back to Latin-1 ('ï'), pdf.js renders nothing (a space); real papers embed fonts with a ToUnicode map",
    chrome: { texts: ["cafØ na ve rØsumØ"] },
  },
  page_text_too_large: {
    why: "200 glyphs at 12 pt run 600 pt past the page's right edge; pdf.js omits text outside the page, pypdf extracts it, so the page is under the limit for pdf.js (page_text_too_large_on_page is the same refusal with the text on the page)",
    chrome: { texts: ["x".repeat(91)] },
  },
};

async function outcome(data: Uint8Array, limits: typeof PDF_LIMITS): Promise<{ refused: string } | { pages: Array<{ page: number; text: string }>; sha256: string }> {
  try {
    const answer = await extractPdfText(data, limits);
    expect(Object.keys(answer).sort()).toEqual(["pages", "sha256", "source"]);
    expect(answer.source).toBe("user_pdf");
    return { pages: answer.pages, sha256: answer.sha256 };
  } catch (error) {
    if (error instanceof PdfRefusal) return { refused: error.reason };
    throw error;
  }
}

describe("the pdf.js reader is bounded exactly as the reference parser", () => {
  it("diverges on two vectors only, each documented", () => {
    expect(Object.keys(DIVERGENCES).every((name) => VECTORS.vectors.some((vector) => vector.name === name))).toBe(true);
    expect(VECTORS.vectors.length - Object.keys(DIVERGENCES).length).toBe(14);
  });

  it("uses the reference's default limits", () => {
    expect(VECTORS.reference).toBe("agentpkg.hostfiles.pdf.extract_text");
    for (const key of ["max_bytes", "max_pages", "max_page_text_bytes", "max_total_text_bytes"] as const) expect(PDF_LIMITS[key]).toBe(VECTORS.default_limits[key]);
  });

  for (const vector of VECTORS.vectors) {
    it(`${vector.name}: ${DIVERGENCES[vector.name] ? "a documented divergence" : vector.refused ? `refuses as ${vector.refused}` : `${vector.pages!.length} page(s), text equal up to whitespace`}`, async () => {
      const data = new Uint8Array(Buffer.from(vector.base64, "base64"));
      const got = await outcome(data, vector.limits);
      const divergence = DIVERGENCES[vector.name];
      if (divergence) {
        console.info(`pdf-text-vectors: ${vector.name} diverges by design: ${divergence.why}`);
        if ("refused" in divergence.chrome) expect(got).toEqual(divergence.chrome);
        else expect("pages" in got ? got.pages.map((page) => squash(page.text)) : got).toEqual(divergence.chrome.texts);
        return;
      }
      if (vector.refused) {
        expect(got).toEqual({ refused: vector.refused });
        return;
      }
      expect("pages" in got).toBe(true);
      if (!("pages" in got)) return;
      expect(got.sha256).toBe(sha256HexSync(data));
      expect(got.pages.map((page) => page.page)).toEqual(vector.pages!.map((page) => page.page));
      expect(got.pages.map((page) => squash(page.text))).toEqual(vector.pages!.map((page) => squash(page.text)));
    });
  }

  it("stops when its signal aborts", async () => {
    const vector = VECTORS.vectors.find((item) => item.name === "many_lines")!;
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(extractPdfText(new Uint8Array(Buffer.from(vector.base64, "base64")), PDF_LIMITS, controller.signal)).rejects.toThrow(/stopped/u);
  });
});
