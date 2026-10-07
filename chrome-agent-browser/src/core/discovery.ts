/**
 * Website discovery: which agent packages does one HTML page advertise? A port of the
 * parsing and judging half of `agentpkg/browser/discovery.py`; the network half is the
 * shell's (D-026, D-033).
 *
 * A page is read for every
 *
 *     <link rel="agent-package" type="application/vnd.webagents.agent-package" href="...">
 *
 * in its document head, as an **untrusted candidate**: a location the website claims, and
 * nothing more. `rel="agent-package"` and that media type are an experimental WebAgents
 * convention, not a registered link relation or any web standard. Discovery never
 * downloads, verifies, trusts, authorizes or runs a package.
 *
 * Only the document head is searched, by the HTML tree builder's rules for where the head
 * ends; reading stops there. Each candidate is resolved against the page's final URL and
 * accepted only when it is a plain HTTPS URL of that same origin; anything else is
 * reported with a stable reason and never fetched. The page is tokenized, never rendered,
 * and nothing it references is fetched.
 */
import { CoreError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./html-entities.js";
import { pyRepr } from "./repr.js";
import { canonicalUrl, MAX_URL_CHARS, origin, originText, sameOrigin, validatePackageUrl } from "./policy.js";
import { urlsplit } from "./urls.js";

export const DISCOVERY_SCHEMA = "agentpkg-website-discovery-v0";
export const DISCOVERY_PROFILE = "same-origin-v0";
export const DISCOVERY_REL = "agent-package";
export const PACKAGE_MEDIA_TYPE = "application/vnd.webagents.agent-package";
export const HTML_MEDIA_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);
export const MAX_HTML_BYTES = 1024 * 1024;
export const MAX_LINKS = 16;
export const MAX_REDIRECTS = 5;
export const DISCOVERY_TIMEOUT_SECONDS = 20;

export interface DiscoveryLimits {
  maxHtmlBytes: number;
  maxRedirects: number;
  timeoutSeconds: number;
  maxLinks: number;
}

export const DEFAULT_LIMITS: DiscoveryLimits = Object.freeze({
  maxHtmlBytes: MAX_HTML_BYTES,
  maxRedirects: MAX_REDIRECTS,
  timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS,
  maxLinks: MAX_LINKS,
});

const ASCII_WHITESPACE = "\t\n\f\r ";

// The HTML tree builder keeps these start tags in the head; any other one opens the body.
const HEAD_START_TAGS = new Set(["html", "head", "base", "basefont", "bgsound", "link", "meta", "noframes", "noscript", "script", "style", "template", "title"]);
const TEXT_ONLY_ELEMENTS = new Set(["iframe", "noembed", "noframes", "plaintext", "script", "style", "textarea", "title", "xmp"]);
const BODY_END_TAGS = new Set(["body", "br", "html"]);

// WHATWG Encoding labels this reader handles specially or refuses.
const UTF16BE_LABELS = new Set(["unicodefffe", "utf-16be"]);
const UTF16LE_LABELS = new Set(["csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"]);
const REFUSED_LABELS = new Set(["csiso2022jp", "iso-2022-jp", "csiso2022kr", "iso-2022-kr", "iso-2022-cn", "iso-2022-cn-ext", "hz-gb-2312", "replacement"]);

export const REJECTION_REASONS = [
  "href_missing",
  "href_empty",
  "href_malformed",
  "fragment_only",
  "unsupported_scheme",
  "credentials_not_allowed",
  "cross_origin",
  "fragment_not_allowed",
  "points_to_page",
  "url_rejected",
  "unsupported_type",
  "duplicate",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

function reject(code: string, message: string, options: { status?: number; details?: Record<string, unknown> } = {}): CoreError {
  return new CoreError(code, message, { status: options.status ?? 502, details: options.details ?? null });
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function stripAsciiWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WHITESPACE.includes(value[start]!)) start += 1;
  while (end > start && ASCII_WHITESPACE.includes(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

/** Untrusted text for display: anything outside printable ASCII is escaped. */
export function printable(value: string, limit: number): string {
  let shown = "";
  for (const character of Array.from(value).slice(0, limit + 1)) {
    const code = character.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) shown += character;
    else if (code <= 0xffff) shown += `\\u${code.toString(16).padStart(4, "0")}`;
    else for (const unit of character) shown += `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }
  return shown.length <= limit ? shown : `${shown.slice(0, limit - 1)}…`;
}

/** `_media_type`: (essence, parameters) of a Content-Type or `type` value. */
export function mediaType(value: string | null | undefined): [string, Record<string, string>] {
  if (!value) return ["", {}];
  const semicolon = value.indexOf(";");
  const essence = semicolon < 0 ? value : value.slice(0, semicolon);
  const rest = semicolon < 0 ? "" : value.slice(semicolon + 1);
  const parameters: Record<string, string> = {};
  for (const part of rest.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const name = asciiLower(stripAsciiWhitespace(part.slice(0, equals)));
    if (!Object.hasOwn(parameters, name)) parameters[name] = stripAsciiWhitespace(part.slice(equals + 1)).replace(/^"|"$/gu, "");
  }
  return [asciiLower(stripAsciiWhitespace(essence)), parameters];
}

/** A rel attribute is a set of ASCII-whitespace-separated, ASCII case-insensitive tokens. */
export function relTokens(value: string): Set<string> {
  return new Set(
    value
      .split(/[\t\n\f\r ]/u)
      .filter((token) => token)
      .map(asciiLower),
  );
}

// -- a small HTML tokenizer ------------------------------------------------------------
type Token =
  | { kind: "start"; name: string; attributes: Map<string, string> }
  | { kind: "end"; name: string }
  | { kind: "data"; text: string }
  | { kind: "other" };

/**
 * CPython's `html.unescape`, which the reference's `HTMLParser` applies to every attribute
 * value: the full HTML5 named set (with the legacy names that need no semicolon and the
 * longest-prefix rule), the numeric forms with the standard's remapped and invalid code
 * points. An attribute such as `href="&sol;&sol;evil.example/x.pkg"` therefore resolves to
 * the same cross-origin URL in both runtimes and is refused for the same reason.
 */
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

function replaceCharref(whole: string, body: string): string {
  if (body[0] === "#") {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = body.slice(hex ? 2 : 1).replace(/;$/u, "");
    const code = Number.parseInt(digits, hex ? 16 : 10);
    const remapped = INVALID_CHARREFS.get(code);
    if (remapped !== undefined) return remapped;
    if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff || !Number.isFinite(code)) return "\ufffd";
    if (INVALID_CODEPOINTS.has(code)) return "";
    return String.fromCodePoint(code);
  }
  const exact = HTML5_ENTITIES.get(body);
  if (exact !== undefined) return exact;
  // The longest matching name, as the standard defines it, over code points.
  const points = Array.from(body);
  for (let x = points.length - 1; x > 1; x -= 1) {
    const value = HTML5_ENTITIES.get(points.slice(0, x).join(""));
    if (value !== undefined) return value + points.slice(x).join("");
  }
  return whole;
}

/** `html.unescape`. */
export function unescapeAttribute(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(CHARREF, (whole, body: string) => replaceCharref(whole, body));
}

/**
 * Tokenize enough HTML to find the head's links: start tags with attributes (the first of
 * duplicated attributes wins, as in HTML), end tags, text, and the comments, declarations
 * and processing instructions that change nothing. Text-only elements are handled by the
 * caller, which knows the tree-builder state. Every token carries the absolute index where
 * it ends, and the generator can be restarted from any position.
 */
const TAG_NAME = /[A-Za-z][^\t\n\f\r />]*/y;
const END_TAG = /<\/([A-Za-z][^\t\n\f\r />]*)[^>]*>/y;
const ATTRIBUTE_NAME = /[^\t\n\f\r />=][^\t\n\f\r />=]*/y;
const UNQUOTED_VALUE = /[^\t\n\f\r >]*/y;

function stickyExec(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function* tokenize(text: string, start = 0): Generator<Token & { end: number }> {
  let index = start;
  const length = text.length;
  while (index < length) {
    const open = text.indexOf("<", index);
    if (open < 0) {
      yield { kind: "data", text: text.slice(index), end: length };
      return;
    }
    if (open > index) yield { kind: "data", text: text.slice(index, open), end: open };
    index = open;
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      if (close < 0) return; // An unterminated comment holds the rest of the document.
      index = close + 3;
      yield { kind: "other", end: index };
      continue;
    }
    if (text.startsWith("<!", index) || text.startsWith("<?", index)) {
      const close = text.indexOf(">", index + 2);
      if (close < 0) return;
      index = close + 1;
      yield { kind: "other", end: index };
      continue;
    }
    if (text.startsWith("</", index)) {
      const match = stickyExec(END_TAG, text, index);
      if (match) {
        index += match[0].length;
        yield { kind: "end", name: asciiLower(match[1]!), end: index };
        continue;
      }
      // `</>` or a bogus comment: skipped up to the next `>`.
      const close = text.indexOf(">", index + 2);
      if (close < 0) return;
      index = close + 1;
      yield { kind: "other", end: index };
      continue;
    }
    const nameMatch = stickyExec(TAG_NAME, text, index + 1);
    if (!nameMatch) {
      // A lone `<` is text.
      yield { kind: "data", text: "<", end: index + 1 };
      index += 1;
      continue;
    }
    const name = asciiLower(nameMatch[0]);
    let cursor = index + 1 + nameMatch[0].length;
    const attributes = new Map<string, string>();
    let closed = false;
    for (;;) {
      while (cursor < length && (ASCII_WHITESPACE.includes(text[cursor]!) || text[cursor] === "/")) {
        if (text[cursor] === "/" && text[cursor + 1] === ">") break;
        cursor += 1;
      }
      if (cursor >= length) return; // An unterminated tag is withheld, never guessed.
      if (text[cursor] === ">") {
        cursor += 1;
        closed = true;
        break;
      }
      if (text[cursor] === "/" && text[cursor + 1] === ">") {
        cursor += 2;
        closed = true;
        break;
      }
      const attributeMatch = stickyExec(ATTRIBUTE_NAME, text, cursor);
      let attributeName: string;
      if (attributeMatch) {
        attributeName = asciiLower(attributeMatch[0]);
        cursor += attributeMatch[0].length;
      } else {
        // `=` or another stray character where a name should be: consume one character.
        attributeName = text[cursor]!;
        cursor += 1;
      }
      while (cursor < length && ASCII_WHITESPACE.includes(text[cursor]!)) cursor += 1;
      let value = "";
      if (text[cursor] === "=") {
        cursor += 1;
        while (cursor < length && ASCII_WHITESPACE.includes(text[cursor]!)) cursor += 1;
        const quote = text[cursor];
        if (quote === '"' || quote === "'") {
          const close = text.indexOf(quote, cursor + 1);
          if (close < 0) return;
          value = text.slice(cursor + 1, close);
          cursor = close + 1;
        } else {
          const unquoted = stickyExec(UNQUOTED_VALUE, text, cursor)!;
          value = unquoted[0];
          cursor += unquoted[0].length;
        }
      }
      if (!attributes.has(attributeName)) attributes.set(attributeName, unescapeAttribute(value));
    }
    if (!closed) return;
    index = cursor;
    yield { kind: "start", name, attributes, end: index };
  }
}

export interface HeadLink {
  href: string | null;
  type: string | null;
}

export interface HeadScan {
  links: HeadLink[];
  overflow: number;
  head_ended: boolean;
  base_href: boolean;
  codec: string;
  encoding_source: string;
  declared_charset: string | null;
}

/** `_charset_from_content`: the WHATWG algorithm for a charset in `<meta http-equiv content>`. */
export function charsetFromContent(content: string): string | null {
  const lowered = asciiLower(content);
  let position = 0;
  for (;;) {
    const found = lowered.indexOf("charset", position);
    if (found < 0) return null;
    position = found + "charset".length;
    while (position < content.length && ASCII_WHITESPACE.includes(content[position]!)) position += 1;
    if (position >= content.length || content[position] !== "=") continue;
    position += 1;
    while (position < content.length && ASCII_WHITESPACE.includes(content[position]!)) position += 1;
    if (position >= content.length) return null;
    const quote = content[position]!;
    if (quote === '"' || quote === "'") {
      const end = content.indexOf(quote, position + 1);
      return end > position ? content.slice(position + 1, end) : null;
    }
    let end = position;
    while (end < content.length && !(ASCII_WHITESPACE + ";").includes(content[end]!)) end += 1;
    return content.slice(position, end) || null;
  }
}

function label(value: string | null | undefined): string | null {
  if (!value) return null;
  const lowered = asciiLower(stripAsciiWhitespace(value).replace(/^["']+|["']+$/gu, ""));
  return printable(lowered, 64) || null;
}

/** The prescan: a `<meta>` charset declaration within the first 1024 bytes. */
function metaCharset(prefix: string): string | null {
  for (const token of tokenize(prefix)) {
    if (token.kind !== "start" || token.name !== "meta") continue;
    const charset = token.attributes.get("charset");
    if (charset) return charset;
    if (asciiLower(stripAsciiWhitespace(token.attributes.get("http-equiv") ?? "")) === "content-type") {
      return charsetFromContent(token.attributes.get("content") ?? "");
    }
  }
  return null;
}

/**
 * `choose_decoding`: (codec, source, declared label) after the HTML encoding-sniffing order.
 * A byte-order mark wins, then the HTTP charset, then a `<meta>` declaration in the first
 * 1024 bytes. ASCII-compatible encodings are read as UTF-8 with replacement characters,
 * UTF-16 as UTF-16; the stateful and "replacement" encodings are refused.
 */
export function chooseDecoding(body: Uint8Array, httpCharset: string | null): [codec: string, source: string, declared: string | null] {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return ["utf-8", "bom", null];
  if ((body[0] === 0xfe && body[1] === 0xff) || (body[0] === 0xff && body[1] === 0xfe)) {
    return [body[0] === 0xfe ? "utf-16be" : "utf-16le", "bom", null];
  }
  let source = "http";
  let declared = label(httpCharset);
  if (declared === null) {
    let prefix = "";
    for (const byte of body.subarray(0, 1024)) prefix += String.fromCharCode(byte);
    source = "meta";
    declared = label(metaCharset(prefix));
  }
  if (declared === null) return ["utf-8", "default", null];
  if (REFUSED_LABELS.has(declared)) {
    throw reject(
      "discovery_encoding_unsupported",
      `The page declares the ${pyRepr(declared)} character encoding, which discovery does not read`,
    );
  }
  // Per the HTML standard a <meta> cannot switch a page to UTF-16.
  if (UTF16BE_LABELS.has(declared) && source === "http") return ["utf-16be", source, declared];
  if (UTF16LE_LABELS.has(declared) && source === "http") return ["utf-16le", source, declared];
  return ["utf-8", source, declared];
}

/**
 * `_HeadLinks`: `rel="agent-package"` links in the document head, in document order.
 *
 * The head ends at the first start tag that cannot be in it, the first non-whitespace
 * text, or `</body>`, `</html>` or `</br>`; a link after `</head>` but before any of those
 * is still placed in the head. Template contents are inert, text-only elements hold no tags
 * (also inside a template), and `<plaintext>` never ends. HTML ignores a self-closing
 * slash, so `<script/>` still opens a script.
 */
function headLinks(text: string, maxLinks: number): { links: HeadLink[]; overflow: number; headEnded: boolean; baseHref: boolean } {
  const links: HeadLink[] = [];
  let overflow = 0;
  let headEnded = false;
  let baseHref = false;
  let afterHead = false;
  let templateDepth = 0;
  let position = 0;

  /** Jump past a text-only element's content and its end tag; false when it never ends. */
  const skipTextOnly = (name: string): boolean => {
    if (name === "plaintext") return false;
    const close = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "giu");
    close.lastIndex = position;
    const match = close.exec(text);
    if (!match) return false;
    const end = text.indexOf(">", match.index);
    if (end < 0) return false;
    position = end + 1;
    return true;
  };

  let restart = true;
  while (restart) {
    restart = false;
    for (const token of tokenize(text, position)) {
      position = token.end;
      if (token.kind === "start") {
        if (templateDepth > 0) {
          if (token.name === "template") templateDepth += 1;
          else if (TEXT_ONLY_ELEMENTS.has(token.name)) {
            if (!skipTextOnly(token.name)) return { links, overflow, headEnded, baseHref };
            restart = true;
            break;
          }
          continue;
        }
        if (!HEAD_START_TAGS.has(token.name) || (token.name === "noscript" && afterHead)) {
          headEnded = true;
          return { links, overflow, headEnded, baseHref };
        }
        if (token.name === "template") {
          templateDepth = 1;
        } else if (TEXT_ONLY_ELEMENTS.has(token.name)) {
          if (!skipTextOnly(token.name)) return { links, overflow, headEnded, baseHref };
          restart = true;
          break;
        } else if (token.name === "link") {
          if (relTokens(token.attributes.get("rel") ?? "").has(DISCOVERY_REL)) {
            if (links.length >= maxLinks) overflow += 1;
            else links.push({ href: token.attributes.get("href") ?? null, type: token.attributes.get("type") ?? null });
          }
        } else if (token.name === "base" && token.attributes.has("href")) {
          baseHref = true;
        }
      } else if (token.kind === "end") {
        if (templateDepth > 0) {
          if (token.name === "template") templateDepth -= 1;
        } else if (token.name === "head") {
          afterHead = true;
        } else if (BODY_END_TAGS.has(token.name)) {
          headEnded = true;
          return { links, overflow, headEnded, baseHref };
        }
      } else if (token.kind === "data") {
        if (templateDepth === 0 && stripAsciiWhitespace(token.text) !== "") {
          headEnded = true;
          return { links, overflow, headEnded, baseHref };
        }
      }
    }
  }
  return { links, overflow, headEnded, baseHref };
}

/**
 * `scan_head`: decode the page and collect the agent-package links of its head.
 * `complete` is false when only a prefix of the page was read; then a tag or a character
 * cut off by the limit is withheld rather than misread.
 */
export function scanHead(
  body: Uint8Array,
  options: { httpCharset: string | null; complete: boolean; maxLinks: number },
): HeadScan {
  const [codec, source, declared] = chooseDecoding(body, options.httpCharset);
  const decoder = new TextDecoder(codec, { fatal: false });
  const text = decoder.decode(body, { stream: !options.complete });
  const scan = headLinks(text, options.maxLinks);
  return {
    links: scan.links,
    overflow: scan.overflow,
    head_ended: scan.headEnded,
    base_href: scan.baseHref,
    codec,
    encoding_source: source,
    declared_charset: declared,
  };
}

// -- candidates ---------------------------------------------------------------------
export interface Candidate {
  index: number;
  href: string | null;
  type_hint: string | null;
  resolved_url: string | null;
  same_origin: boolean | null;
  accepted: boolean;
  rejection_reason: RejectionReason | null;
  rejection_message: string | null;
}

/** Why a URL string may resolve differently here than in a browser, if it may. */
function unsafeUrlText(value: string): string | null {
  if (value.length > MAX_URL_CHARS) return `it is longer than ${MAX_URL_CHARS} characters`;
  if (/[^\u0000-\u007f]/u.test(value)) return "it contains non-ASCII characters, which this profile does not accept";
  if (/[\u0000- \\\u007f]/u.test(value)) {
    return "it contains whitespace, control characters or a backslash, which browsers and this resolver can interpret differently";
  }
  return null;
}

function rejected(candidate: Candidate, reason: RejectionReason, message: string): Candidate {
  return { ...candidate, accepted: false, rejection_reason: reason, rejection_message: message };
}

/** `classify_candidate`: one advertised link, judged against the page it came from. Fetches nothing. */
export function classifyCandidate(index: number, link: HeadLink, pageUrl: string): Candidate {
  const pageOrigin = origin(pageUrl);
  const href = link.href === null ? null : stripAsciiWhitespace(link.href);
  const typeHint = link.type ? stripAsciiWhitespace(link.type) : "";
  const candidate: Candidate = {
    index,
    href: href === null ? null : printable(href, MAX_URL_CHARS),
    type_hint: typeHint ? printable(typeHint, 128) : null,
    resolved_url: null,
    same_origin: null,
    accepted: true,
    rejection_reason: null,
    rejection_message: null,
  };
  if (href === null) return rejected(candidate, "href_missing", "The link has no href attribute.");
  if (!href) return rejected(candidate, "href_empty", "The href is empty, which points at the page itself.");
  const problem = unsafeUrlText(href);
  if (problem) return rejected(candidate, "href_malformed", `The href is not accepted: ${problem}.`);
  if (href.startsWith("#")) return rejected(candidate, "fragment_only", "The href is only a fragment, which points at the page itself.");
  let resolved: string;
  try {
    // RFC 3986 reference resolution, as `urljoin` does; the href is ASCII without whitespace
    // or backslashes, where the WHATWG parser agrees with the reference's resolver.
    resolved = new URL(href, pageUrl).href;
    const parts = urlsplit(resolved);
    if (parts.portError) throw new Error("port");
  } catch {
    return rejected(candidate, "href_malformed", "The href is not a well-formed URL.");
  }
  const parts = urlsplit(resolved);
  candidate.resolved_url = printable(resolved, MAX_URL_CHARS);
  if (parts.scheme !== "http" && parts.scheme !== "https") {
    return rejected(candidate, "unsupported_scheme", `Only https:// candidates are accepted; this link uses ${pyRepr(parts.scheme || "no")}.`);
  }
  if (parts.username !== null || parts.password !== null || parts.netloc.includes("@")) {
    return rejected(candidate, "credentials_not_allowed", "The URL embeds credentials, which are refused.");
  }
  const where = origin(resolved);
  candidate.same_origin = sameOrigin(where, pageOrigin);
  if (!candidate.same_origin) {
    const names = ["scheme", "host", "port"] as const;
    const there = where ?? (["", "", 0] as const);
    const differs = names.filter((_, position) => pageOrigin![position] !== there[position]);
    return rejected(
      candidate,
      "cross_origin",
      `The package is advertised at ${where ? originText(where) : "another origin"}, not at this page's origin ${originText(pageOrigin!)} (different ${differs.join(" and ")}). This discovery profile accepts only packages served by the page's own origin.`,
    );
  }
  if (parts.fragment || resolved.includes("#")) {
    return rejected(candidate, "fragment_not_allowed", "Package URLs must not contain a fragment.");
  }
  const canonical = canonicalUrl(resolved);
  candidate.resolved_url = canonical;
  if (canonical === canonicalUrl(pageUrl)) {
    return rejected(candidate, "points_to_page", "The href resolves to this page itself, not a package.");
  }
  try {
    validatePackageUrl(canonical);
  } catch (error) {
    return rejected(candidate, "url_rejected", (error as Error).message);
  }
  if (typeHint && mediaType(typeHint)[0] !== PACKAGE_MEDIA_TYPE) {
    return rejected(candidate, "unsupported_type", `The link declares type ${pyRepr(printable(typeHint, 128))}, not ${PACKAGE_MEDIA_TYPE}.`);
  }
  return candidate;
}

export type DiscoveryStatus = "candidate" | "multiple_candidates" | "no_candidate" | "candidates_rejected";

function status(accepted: number, total: number): DiscoveryStatus {
  if (total === 0) return "no_candidate";
  if (accepted === 0) return "candidates_rejected";
  return accepted === 1 ? "candidate" : "multiple_candidates";
}

export function discoveryProfile(limits: DiscoveryLimits = DEFAULT_LIMITS): Record<string, unknown> {
  return {
    name: DISCOVERY_PROFILE,
    rel: DISCOVERY_REL,
    media_type: PACKAGE_MEDIA_TYPE,
    convention: "experimental WebAgents metadata; not a registered link relation or a web standard",
    scope: "document head",
    same_origin_required: true,
    // The reference follows same-origin hops; this runtime follows none (D-033 as amended, B-104).
    redirects: "not followed; open the final address yourself",
    max_redirects: 0,
    max_html_bytes: limits.maxHtmlBytes,
    max_links: limits.maxLinks,
    timeout_seconds: limits.timeoutSeconds,
  };
}

/** What the shell fetched: the `FetchedPage` of the reference. */
export interface FetchedPage {
  requested_url: string;
  final_url: string;
  redirects: Array<{ status: number; from_url: string; to_url: string }>;
  content_type: string;
  charset: string | null;
  content_coding: string;
  body: Uint8Array;
  truncated: boolean;
}

export interface DiscoveryResult {
  schema: typeof DISCOVERY_SCHEMA;
  requested_url: string;
  final_url: string;
  page_origin: string;
  redirects: FetchedPage["redirects"];
  discovery_status: DiscoveryStatus;
  candidates: Candidate[];
  accepted_count: number;
  rejected_count: number;
  links_not_listed: number;
  page: {
    content_type: string;
    declared_charset: string | null;
    decoded_as: string;
    encoding_source: string;
    content_coding: string;
    bytes_read: number;
    truncated: boolean;
    head_ended: boolean;
    html_sha256: string;
    base_element_ignored: boolean;
  };
  profile: Record<string, unknown>;
  trust: {
    conveys: "location_only";
    package_verified: false;
    publisher_trusted: false;
    permissions_granted: false;
    note: string;
  };
  execution: { performed: false; package_fetched: false; note: string };
  discovered_at: string;
}

/** `discover` after the fetch: scan the head, judge every advertised link. Opens nothing. */
export async function discoverFromPage(page: FetchedPage, limits: DiscoveryLimits = DEFAULT_LIMITS, now: Date = new Date()): Promise<DiscoveryResult> {
  const [essence] = mediaType(page.content_type);
  if (!HTML_MEDIA_TYPES.has(essence)) {
    throw reject("discovery_not_html", `The website did not answer with an HTML page (Content-Type ${pyRepr(printable(essence, 128) || "absent")})`, {
      details: { content_type: printable(essence, 128) || null },
    });
  }
  const scan = scanHead(page.body, { httpCharset: page.charset, complete: !page.truncated, maxLinks: limits.maxLinks });
  if (page.truncated && !scan.head_ended) {
    throw reject("discovery_too_large", `The page's head did not end within the first ${limits.maxHtmlBytes} bytes; discovery reads no further`, {
      status: 413,
    });
  }
  const candidates = scan.links.map((link, index) => classifyCandidate(index, link, page.final_url));
  const seen = new Set<string>();
  for (let position = 0; position < candidates.length; position += 1) {
    const candidate = candidates[position]!;
    if (!candidate.accepted) continue;
    if (seen.has(candidate.resolved_url!)) {
      candidates[position] = rejected(candidate, "duplicate", "The same package URL is advertised earlier on this page.");
    }
    seen.add(candidate.resolved_url!);
  }
  const accepted = candidates.filter((candidate) => candidate.accepted).length;
  const pageOrigin = origin(page.final_url);
  return {
    schema: DISCOVERY_SCHEMA,
    requested_url: page.requested_url,
    final_url: page.final_url,
    page_origin: pageOrigin ? originText(pageOrigin) : "",
    redirects: page.redirects,
    discovery_status: status(accepted, candidates.length),
    candidates,
    accepted_count: accepted,
    rejected_count: candidates.length - accepted,
    links_not_listed: scan.overflow,
    page: {
      content_type: essence,
      declared_charset: scan.declared_charset,
      decoded_as: scan.codec,
      encoding_source: scan.encoding_source,
      content_coding: page.content_coding,
      bytes_read: page.body.length,
      truncated: page.truncated,
      head_ended: scan.head_ended,
      html_sha256: await sha256Hex(page.body),
      base_element_ignored: scan.base_href,
    },
    profile: discoveryProfile(limits),
    trust: {
      conveys: "location_only",
      package_verified: false,
      publisher_trusted: false,
      permissions_granted: false,
      note: "A website's advertisement is an untrusted candidate. Identity, integrity, signature, publisher trust and permissions are established only by inspecting the package, through the same path as any package URL.",
    },
    execution: {
      performed: false,
      package_fetched: false,
      note: "Discovery read one HTML page. It fetched no package, created no session and ran nothing.",
    },
    discovered_at: now.toISOString(),
  };
}

/**
 * Candidates from links a content script read off the live document head
 * (`link[rel~="agent-package"]`), judged by the same rules as parsed HTML.
 */
export function classifyLinks(links: readonly HeadLink[], pageUrl: string, maxLinks = MAX_LINKS): { candidates: Candidate[]; status: DiscoveryStatus; overflow: number } {
  const kept = links.slice(0, maxLinks);
  const candidates = kept.map((link, index) => classifyCandidate(index, link, pageUrl));
  const seen = new Set<string>();
  for (let position = 0; position < candidates.length; position += 1) {
    const candidate = candidates[position]!;
    if (!candidate.accepted) continue;
    if (seen.has(candidate.resolved_url!)) {
      candidates[position] = rejected(candidate, "duplicate", "The same package URL is advertised earlier on this page.");
    }
    seen.add(candidate.resolved_url!);
  }
  const accepted = candidates.filter((candidate) => candidate.accepted).length;
  return { candidates, status: status(accepted, candidates.length), overflow: Math.max(0, links.length - maxLinks) };
}

