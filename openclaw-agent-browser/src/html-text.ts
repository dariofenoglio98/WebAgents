/**
 * Plain text from JATS/HTML-marked metadata, exactly as the Citation Resolver
 * renders it.
 *
 * Crossref returns titles, container titles and abstracts with markup in them
 * (`<jats:p>`, `<jats:italic>`, `&amp;`, `&#x2013;`). Two tools on this host read
 * the same Crossref record: the Citation Resolver, which renders a field with
 * `app/providers/common.py::clean_text`, and this plugin's scholarly-search
 * adapter. A package later requires a quotation to occur *verbatim* in one of
 * those renderings, so the two must agree character for character — otherwise
 * a quote copied from the search result would fail against the resolver's copy
 * of the same abstract, and a correct run would be refused.
 *
 * `clean_text` is three steps on CPython 3.13:
 *
 * 1. `HTMLParser(convert_charrefs=True).feed(value)` — with **no `close()`**,
 *    which matters: text the parser is still holding back at the end of the
 *    buffer (an unterminated tag, a trailing `&` that could start a reference)
 *    is never emitted;
 * 2. `html.unescape` over the joined data, a second time;
 * 3. `" ".join(text.split())`, i.e. Python's Unicode whitespace, or `None`.
 *
 * This module ports those steps, not an approximation of them: the regular
 * expressions are CPython's (`html/parser.py`, `_markupbase.py`), `\s` is
 * CPython's `str.isspace()` set, and the reference tables are generated from
 * CPython's own `html` module (`html-entities.ts`). It evaluates nothing,
 * fetches nothing and keeps no markup: it only decides which characters are
 * text. `test/crossref.test.ts` checks it against vectors produced by the
 * resolver's real function.
 *
 * One deliberate divergence: CPython raises `AssertionError` on a marked
 * section with an unknown keyword (`<![foo[`). The resolver would then fail the
 * whole record; here the field is treated as unrenderable and becomes `null`,
 * so one malformed abstract cannot fail an entire search.
 */
import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./html-entities.js";

/** CPython `str.isspace()`, which is also what `re`'s `\s` means for `str`. */
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const S = `[${WS}]`;

// html/parser.py, CPython 3.13 — transcribed, with `\s` expanded as above.
const STARTTAGOPEN = /<[a-zA-Z]/y;
const TAGFIND_TOLERANT = new RegExp(`([a-zA-Z][^\\t\\n\\r\\f />\\x00]*)(?:${S}|/(?!>))*`, "y");
const ATTRFIND_TOLERANT = new RegExp(
  `((?<=['"${WS}/])[^${WS}/>][^${WS}/=>]*)` +
    `(${S}*=+${S}*` +
    `('[^']*'|"[^"]*"|(?!['"])[^>${WS}]*))?(?:${S}|/(?!>))*`,
  "y",
);
const LOCATESTARTTAGEND_TOLERANT = new RegExp(
  `<[a-zA-Z][^\\t\\n\\r\\f />\\x00]*` +
    `(?:[${WS}/]*` +
    `(?:(?<=['"${WS}/])[^${WS}/>][^${WS}/=>]*` +
    `(?:${S}*=+${S}*` +
    `(?:'[^']*'|"[^"]*"|(?!['"])[^>${WS}]*)` +
    `${S}*` +
    `)?(?:${S}|/(?!>))*` +
    `)*` +
    `)?` +
    `${S}*`,
  "y",
);
const ENDTAGFIND = new RegExp(`</${S}*([a-zA-Z][-.a-zA-Z0-9:_]*)${S}*>`, "y");
// _markupbase.py
const COMMENTCLOSE = new RegExp(`--${S}*>`, "g");
const MARKEDSECTIONCLOSE = new RegExp(`]${S}*]${S}*>`, "g");
const MSMARKEDSECTIONCLOSE = new RegExp(`]${S}*>`, "g");
const DECLNAME = new RegExp(`[a-zA-Z][-_.a-zA-Z0-9]*${S}*`, "y");
// The convert_charrefs lookahead in `goahead`.
const REF_TERMINATOR = new RegExp(`[${WS};]`, "g");
const CDATA_CONTENT_ELEMENTS = new Set(["script", "style"]);

// html/__init__.py
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;
const SPLIT = new RegExp(`${S}+`, "u");

class UnrenderableMarkup extends Error {}

function searchFrom(pattern: RegExp, text: string, from: number): RegExpExecArray | null {
  pattern.lastIndex = from;
  return pattern.exec(text);
}

function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function pyStrip(text: string): string {
  return text.replace(new RegExp(`^${S}+|${S}+$`, "gu"), "");
}

function replaceCharref(whole: string, body: string): string {
  if (body[0] === "#") {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = body.slice(hex ? 2 : 1).replace(/;$/u, "");
    // Arbitrarily long digit strings are legal input; anything past the last
    // code point maps to U+FFFD exactly as CPython's unbounded int does.
    const num = Number.parseInt(digits, hex ? 16 : 10);
    const remapped = INVALID_CHARREFS.get(num);
    if (remapped !== undefined) return remapped;
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff || !Number.isFinite(num)) return "�";
    if (INVALID_CODEPOINTS.has(num)) return "";
    return String.fromCodePoint(num);
  }
  const exact = HTML5_ENTITIES.get(body);
  if (exact !== undefined) return exact;
  // The longest matching name, as the standard defines it, over code points.
  const points = Array.from(body);
  for (let x = points.length - 1; x > 1; x -= 1) {
    const prefix = points.slice(0, x).join("");
    const value = HTML5_ENTITIES.get(prefix);
    if (value !== undefined) return value + points.slice(x).join("");
  }
  return whole;
}

/** CPython `html.unescape`. */
export function pyUnescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF, (whole, body: string) => replaceCharref(whole, body));
}

/**
 * The data `HTMLParser(convert_charrefs=True).feed(text)` hands to
 * `handle_data`, with no `close()` afterwards.
 */
function feedData(raw: string): string[] {
  const parts: string[] = [];
  const n = raw.length;
  let cdata: string | null = null;
  let i = 0;

  const bogusComment = (at: number): number => {
    const pos = raw.indexOf(">", at + 2);
    return pos === -1 ? -1 : pos + 1;
  };

  const parseStartTag = (at: number): number => {
    // check_for_whole_start_tag
    const located = matchAt(LOCATESTARTTAGEND_TOLERANT, raw, at);
    if (!located) throw new UnrenderableMarkup("start tag");
    const j = at + located[0].length;
    const next = raw.slice(j, j + 1);
    let endpos: number;
    if (next === ">") endpos = j + 1;
    else if (next === "/") endpos = raw.startsWith("/>", j) ? j + 2 : -1;
    else if (next === "") endpos = -1;
    else if (/[a-zA-Z=/]/u.test(next)) endpos = -1;
    else endpos = j > at ? j : at + 1;
    if (endpos < 0) return endpos;

    const name = matchAt(TAGFIND_TOLERANT, raw, at + 1);
    if (!name) throw new UnrenderableMarkup("tag name");
    let k = at + 1 + name[0].length;
    const tag = name[1]!.toLowerCase();
    while (k < endpos) {
      const attr = matchAt(ATTRFIND_TOLERANT, raw, k);
      if (!attr) break;
      k += attr[0].length;
    }
    const end = pyStrip(raw.slice(k, endpos));
    if (end !== ">" && end !== "/>") {
      // CPython passes a malformed tag through as data, verbatim.
      parts.push(raw.slice(at, endpos));
      return endpos;
    }
    if (!end.endsWith("/>") && CDATA_CONTENT_ELEMENTS.has(tag)) cdata = tag;
    return endpos;
  };

  const parseEndTag = (at: number): number => {
    const gt = raw.indexOf(">", at + 1);
    if (gt === -1) return -1;
    const gtpos = gt + 1;
    const found = matchAt(ENDTAGFIND, raw, at);
    if (!found) {
      if (cdata !== null) {
        parts.push(raw.slice(at, gtpos));
        return gtpos;
      }
      const name = matchAt(TAGFIND_TOLERANT, raw, at + 2);
      if (!name) return raw.startsWith("</>", at) ? at + 3 : bogusComment(at);
      const close = raw.indexOf(">", at + 2 + name[0].length);
      return close + 1;
    }
    const elem = found[1]!.toLowerCase();
    if (cdata !== null && elem !== cdata) {
      parts.push(raw.slice(at, gtpos));
      return gtpos;
    }
    cdata = null;
    return gtpos;
  };

  const parseMarkedSection = (at: number): number => {
    // _scan_name(i + 3)
    const from = at + 3;
    if (from === n) return -1;
    const declared = matchAt(DECLNAME, raw, from);
    if (!declared) throw new UnrenderableMarkup("marked section");
    if (from + declared[0].length === n) return -1;
    const section = pyStrip(declared[0]).toLowerCase();
    let close: RegExpExecArray | null;
    if (["temp", "cdata", "ignore", "include", "rcdata"].includes(section)) {
      close = searchFrom(MARKEDSECTIONCLOSE, raw, from);
    } else if (["if", "else", "endif"].includes(section)) {
      close = searchFrom(MSMARKEDSECTIONCLOSE, raw, from);
    } else {
      throw new UnrenderableMarkup("marked section keyword");
    }
    // unknown_decl: the section's content is not text.
    return close ? close.index + close[0].length : -1;
  };

  const parseDeclaration = (at: number): number => {
    if (raw.startsWith("<!--", at)) {
      const close = searchFrom(COMMENTCLOSE, raw, at + 4);
      return close ? close.index + close[0].length : -1;
    }
    if (raw.startsWith("<![CDATA[", at)) return parseMarkedSection(at);
    if (raw.slice(at, at + 9).toLowerCase() === "<!doctype") {
      const gt = raw.indexOf(">", at + 9);
      return gt === -1 ? -1 : gt + 1;
    }
    return bogusComment(at);
  };

  while (i < n) {
    let j: number;
    if (cdata === null) {
      j = raw.indexOf("<", i);
      if (j < 0) {
        // A trailing `&` with no whitespace or `;` after it could be half a
        // reference, so CPython waits for more input — which never comes.
        const amp = raw.lastIndexOf("&");
        const window = Math.max(i, n - 34);
        if (amp >= window && !searchFrom(REF_TERMINATOR, raw, amp)) break;
        j = n;
      }
    } else {
      const close = searchFrom(new RegExp(`</${S}*${cdata}${S}*>`, "gi"), raw, i);
      if (!close) break;
      j = close.index;
    }
    if (i < j) parts.push(cdata === null ? pyUnescape(raw.slice(i, j)) : raw.slice(i, j));
    i = j;
    if (i === n) break;
    let k: number;
    if (matchAt(STARTTAGOPEN, raw, i)) k = parseStartTag(i);
    else if (raw.startsWith("</", i)) k = parseEndTag(i);
    else if (raw.startsWith("<!--", i)) k = parseDeclaration(i);
    else if (raw.startsWith("<?", i)) {
      const gt = raw.indexOf(">", i + 2);
      k = gt === -1 ? -1 : gt + 1;
    } else if (raw.startsWith("<!", i)) k = parseDeclaration(i);
    else if (i + 1 < n) {
      parts.push("<");
      k = i + 1;
    } else break;
    if (k < 0) break; // Incomplete, and `close()` is never called.
    i = k;
  }
  return parts;
}

/**
 * The Citation Resolver's `clean_text`: plain text, or `null` for nothing.
 *
 * Non-strings are `null`, as they are in the resolver.
 */
export function pythonHtmlText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let parts: string[];
  try {
    parts = feedData(value);
  } catch (error) {
    if (error instanceof UnrenderableMarkup) return null;
    throw error;
  }
  const text = pyUnescape(parts.join(""))
    .split(SPLIT)
    .filter((piece) => piece.length > 0)
    .join(" ");
  return text.length > 0 ? text : null;
}
