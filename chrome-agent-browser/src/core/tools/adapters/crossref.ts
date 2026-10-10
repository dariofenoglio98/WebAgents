/**
 * The Crossref scholarly-search adapter (T6, D-081): a port of the reference plugin's
 * `CROSSREF_WORKS_ADAPTER` (`openclaw-agent-browser/src/tool-adapters.ts`). The package supplies a
 * query string and a row count, within its own declared input schema, and this host decides the
 * origin, path, method, parameter *names*, the selected fields, the work-type filter and how the
 * answer is rendered: one `GET /works?query.bibliographic=…&rows=…&select=…&filter=…`, and, when
 * the person entered a contact address in Settings → Services, `&mailto=…` (Crossref's polite
 * pool). Nothing a package sends can add a parameter, a header or a path.
 *
 * The answer is reduced to exactly the fields a scholarly-search result declares, with markup
 * rendered to text by `pythonHtmlText`, as the Citation Resolver renders the same Crossref fields,
 * because a package later requires a quote to occur verbatim in one of those renderings.
 * `test/core/tools/crossref.test.ts` holds both the request shape and the normalized answers equal
 * to what the reference adapter produces (`scripts/make-crossref-reference.mjs`).
 *
 * Crossref's public pool states `x-concurrency-limit: 1` and one request per second; the binding
 * that names this adapter (`hosttools.ts`) carries `max_concurrent 1` and `min_interval_ms 1000`,
 * and the broker's pacer makes calls beyond them wait their turn inside their deadline. The adapter
 * sends one request; the broker may send a read again after a transient failure (D-152), and that
 * request waits for its own turn like any other.
 */
import { pythonHtmlText } from "../../html-text.js";
import type { JsonObject, JsonValue } from "../../json.js";

/** Raised by an adapter for a request it will not build or an answer it will not believe. */
export class AdapterRefusal extends Error {
  constructor(
    readonly code: "tool_request_invalid" | "tool_response_invalid" | "tool_unavailable" | "tool_transport_error",
    message: string,
  ) {
    super(message);
  }
}

export interface AdapterRequest {
  /** Query parameters in a fixed order; names are adapter constants. */
  query: ReadonlyArray<readonly [string, string]> | null;
  /** A JSON body for POST, or null. */
  body: string | null;
}

export interface AdapterAnswer {
  status: number;
  json: JsonValue;
}

/** What one HTTP implementation sends and what it will believe (the reference's `HttpAdapter`). */
export interface HttpAdapter {
  id: string;
  request(args: JsonValue, method: "GET" | "POST", options: { contact: string | null }): AdapterRequest;
  response(answer: AdapterAnswer, args: JsonValue, retrievedAt: string): JsonValue;
}

export const CROSSREF_IMPLEMENTATION = Object.freeze({ id: "chrome.tool.crossref_works_search", version: "0.1.0" });

/** Exactly the fields a scholarly-search result is built from. Nothing else. */
export const CROSSREF_SELECT = ["DOI", "title", "author", "published", "published-print", "published-online", "issued", "container-title", "abstract", "URL"].join(",");

/**
 * Only scholarly works in their own right; a repeated `type:` filter is an OR in Crossref's API.
 * Supplementary files (`component`), reviews of other works (`peer-review`), datasets and
 * containers are not papers a review can screen and cite.
 */
export const CROSSREF_TYPES = ["journal-article", "proceedings-article", "posted-content", "book-chapter", "book", "monograph", "report", "dissertation"];
export const CROSSREF_FILTER = CROSSREF_TYPES.map((type) => `type:${type}`).join(",");

/**
 * The query's own bound, in characters, as the reference adapter states it. The URL the query
 * becomes is bounded separately by the binding's `maxRequestBytes` (4 KiB, in the binding's
 * digest), exactly as in the reference broker, so a query of non-ASCII characters can pass this
 * check and still be refused by that one (500 four-byte characters percent-encode to 6,000
 * bytes). Both refusals are `tool_request_invalid` before any request; neither runtime clips a
 * package's value to fit (T6 review, nit 5: kept for parity, documented here).
 */
export const CROSSREF_MAX_QUERY_CHARS = 500;
export const CROSSREF_MAX_ROWS = 20;
/** A contact address for the polite pool: one address, no spaces or controls, bounded. */
export const CONTACT_PATTERN = /^[^\s@<>"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/iu;
// Non-printing controls. Tab and newline are harmless once percent-encoded.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** The reference's `clip`: at most `max` characters, an ellipsis marking a cut. */
function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A contact address this adapter will send, or null for anything else. */
export function validContact(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length <= 254 && CONTACT_PATTERN.test(trimmed) ? trimmed : null;
}

function crossrefArgs(args: unknown): { query: string; limit: number } {
  if (!isRecord(args)) throw new AdapterRefusal("tool_request_invalid", "scholarly search arguments must be an object");
  for (const key of Object.keys(args)) {
    if (key !== "query" && key !== "limit") {
      // The host reads only the names it was written for. Any other name would be a way for a
      // package to shape the request, so it is refused.
      throw new AdapterRefusal("tool_request_invalid", `scholarly search does not accept an argument named ${clipText(key, 64)}`);
    }
  }
  const { query, limit } = args;
  if (typeof query !== "string" || query.trim().length === 0 || [...query].length > CROSSREF_MAX_QUERY_CHARS || CONTROL.test(query)) {
    throw new AdapterRefusal("tool_request_invalid", `the search query must be 1 to ${CROSSREF_MAX_QUERY_CHARS} characters of text`);
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > CROSSREF_MAX_ROWS) {
    throw new AdapterRefusal("tool_request_invalid", `the result limit must be an integer from 1 to ${CROSSREF_MAX_ROWS}`);
  }
  return { query, limit };
}

function firstString(value: JsonValue | undefined): JsonValue | undefined {
  return Array.isArray(value) ? value[0] : undefined;
}

function yearOf(item: Record<string, JsonValue>): number | null {
  // The Citation Resolver's order, so both tools date one record identically.
  for (const field of ["published", "published-print", "published-online", "issued"]) {
    const holder = item[field];
    const parts = isRecord(holder) ? holder["date-parts"] : null;
    const first = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
    if (typeof first === "number" && Number.isInteger(first) && first !== 0) return first;
  }
  return null;
}

function doiOf(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // DOIs are case-insensitive; the Citation Resolver stores them lowercase, and a package that
  // later compares the two identities must see the same string.
  return DOI_PATTERN.test(trimmed) && !CONTROL.test(trimmed) ? trimmed.toLowerCase() : null;
}

function urlOf(value: JsonValue | undefined): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

function authorsOf(value: JsonValue | undefined): Array<{ name: string }> {
  const authors: Array<{ name: string }> = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry)) continue;
    const given = pythonHtmlText(entry.given);
    const family = pythonHtmlText(entry.family);
    const name = pythonHtmlText(entry.name) ?? ([given, family].filter(Boolean).join(" ") || null);
    if (name) authors.push({ name });
  }
  return authors;
}

export const CROSSREF_WORKS_ADAPTER: HttpAdapter = {
  id: CROSSREF_IMPLEMENTATION.id,
  request(args, method, options) {
    if (method !== "GET") throw new AdapterRefusal("tool_request_invalid", "the Crossref search binding sends GET only");
    const { query, limit } = crossrefArgs(args);
    const parameters: Array<readonly [string, string]> = [
      ["query.bibliographic", query],
      ["rows", String(limit)],
      ["select", CROSSREF_SELECT],
      ["filter", CROSSREF_FILTER],
    ];
    // The person's contact address, only when they entered one; never a package value.
    const contact = validContact(options.contact);
    if (contact !== null) parameters.push(["mailto", contact]);
    return { body: null, query: parameters };
  },
  response({ status, json }, args, retrievedAt) {
    if (status === 429) throw new AdapterRefusal("tool_unavailable", "Crossref is rate-limiting this host");
    if (status >= 500 || status === 401 || status === 403) throw new AdapterRefusal("tool_unavailable", `Crossref answered HTTP ${status}`);
    // The request shape is host code and the values were validated twice, so anything but 200 is
    // a failed call, never data for the package.
    if (status !== 200) throw new AdapterRefusal("tool_transport_error", `Crossref answered HTTP ${status}`);
    const { query, limit } = crossrefArgs(args);
    const message = isRecord(json) ? json.message : undefined;
    const items = isRecord(message) ? message.items : undefined;
    if (!isRecord(json) || json.status !== "ok" || !Array.isArray(items)) throw new AdapterRefusal("tool_response_invalid", "Crossref returned no work list");
    const papers: JsonObject[] = [];
    let skipped = 0;
    for (const raw of items.slice(0, limit)) {
      if (!isRecord(raw)) {
        skipped += 1;
        continue;
      }
      const title = pythonHtmlText(firstString(raw.title));
      if (!title) {
        // A record without a title cannot be screened or cited. It is counted, not invented.
        skipped += 1;
        continue;
      }
      const doi = doiOf(raw.DOI);
      papers.push({
        title,
        doi,
        arxiv_id: null,
        authors: authorsOf(raw.author),
        year: yearOf(raw),
        venue: pythonHtmlText(firstString(raw["container-title"])),
        abstract: pythonHtmlText(raw.abstract),
        url: urlOf(raw.URL),
        source: "crossref",
        provenance: [{ source: "crossref", query, locator: doi, synthetic: false, retrieved_at: retrievedAt }],
      });
    }
    return { papers, query, source: "crossref", skipped_records: skipped };
  },
};

const UNRESERVED = /[A-Za-z0-9*\-._]/u;

/**
 * `application/x-www-form-urlencoded` serialization, as `URLSearchParams.toString()` writes it
 * (the reference's `encodeQuery`): UTF-8 bytes, `*-._` and alphanumerics kept, a space as `+`,
 * every other byte as `%XX`. The core has no `URLSearchParams` (D-031), so it is spelled out and
 * tested against the reference's own encoding.
 */
export function encodeQuery(query: ReadonlyArray<readonly [string, string]>): string {
  const encodeOne = (text: string): string => {
    let out = "";
    for (const char of text) {
      if (char === " ") out += "+";
      else if (UNRESERVED.test(char)) out += char;
      else for (const byte of new TextEncoder().encode(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
  };
  return query.map(([name, value]) => `${encodeOne(name)}=${encodeOne(value)}`).join("&");
}
