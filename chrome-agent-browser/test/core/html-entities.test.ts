/**
 * The core's character-reference tables are the plugin's, byte for byte from the first
 * `export` on (one source of truth, as D-025 does for the schemas), and `unescapeAttribute`
 * is CPython's `html.unescape`: vectors below were produced with the venv's Python 3.13
 * (`html.unescape(...)`), including the legacy no-semicolon names, the longest-prefix rule
 * and the numeric remapping table.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyCandidate, scanHead, unescapeAttribute } from "../../src/core/discovery.js";
import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from "../../src/core/html-entities.js";
import { PROJECT, ROOT } from "../helpers/paths.js";

function dataPortion(text: string): string {
  return text.slice(text.indexOf("export const HTML5_ENTITIES"));
}

describe("html-entities.ts", () => {
  it("is the plugin's table from the first export on", () => {
    const core = readFileSync(join(PROJECT, "src", "core", "html-entities.ts"), "utf8");
    const plugin = readFileSync(join(ROOT, "openclaw-agent-browser", "src", "html-entities.ts"), "utf8");
    expect(dataPortion(core)).toBe(dataPortion(plugin));
  });

  it("has CPython 3.13's sizes: 2231 named references (106 without a semicolon), 34 remapped and 126 invalid code points", () => {
    expect(HTML5_ENTITIES.size).toBe(2231);
    expect([...HTML5_ENTITIES.keys()].filter((name) => !name.endsWith(";")).length).toBe(106);
    expect(INVALID_CHARREFS.size).toBe(34);
    expect(INVALID_CODEPOINTS.size).toBe(126);
  });
});

describe("unescapeAttribute is html.unescape", () => {
  const vectors: Array<[string, string]> = [
    ["plain", "plain"],
    ["&amp;&lt;&gt;&quot;&apos;", "&<>\"'"],
    ["&amp&lt&gt", "&<>"],
    ["&sol;&sol;evil.example/x.agent.pkg", "//evil.example/x.agent.pkg"],
    ["&colon;&sol;&sol;", "://"],
    ["&notit;", "¬it;"],
    ["&notin;", "∉"],
    ["&copy2026", "©2026"],
    ["&#47;agent.pkg", "/agent.pkg"],
    ["&#x2F;agent&#46;pkg", "/agent.pkg"],
    ["&#128;", "€"],
    ["&#0;", "�"],
    ["&#xD800;", "�"],
    ["&#1114112;", "�"],
    ["&#x1;", ""],
    ["&#99999999999999999999;", "�"],
    ["&unknownname;", "&unknownname;"],
    ["&;", "&;"],
    ["a & b", "a & b"],
    ["&Aacute;&Aacute", "ÁÁ"],
    ["&ThisIsAVeryLongNameThatIsLongerThanThirtyTwoCharacters;", "&ThisIsAVeryLongNameThatIsLongerThanThirtyTwoCharacters;"],
  ];
  for (const [input, expected] of vectors) {
    it(`decodes ${JSON.stringify(input)}`, () => {
      expect(unescapeAttribute(input)).toBe(expected);
    });
  }

  it("a protocol-relative href spelled with &sol; is cross-origin, as the reference finds it (review 1, finding 8)", () => {
    const html = '<!doctype html><html><head><link rel="agent-package" href="&sol;&sol;evil.example/x.agent.pkg"></head><body></body></html>';
    const scan = scanHead(new TextEncoder().encode(html), { httpCharset: "utf-8", complete: true, maxLinks: 16 });
    expect(scan.links[0]?.href).toBe("//evil.example/x.agent.pkg");
    const candidate = classifyCandidate(0, scan.links[0]!, "https://webair.example/");
    expect(candidate.accepted).toBe(false);
    expect(candidate.rejection_reason).toBe("cross_origin");
  });
});
