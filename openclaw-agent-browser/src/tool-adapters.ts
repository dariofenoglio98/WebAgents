/**
 * What one HTTP tool implementation sends and what it will believe.
 *
 * `tool-broker.ts` owns the transport policy for every `json_http` binding —
 * HTTPS only, exact origin/path/method, public-address resolution, a pinned
 * socket with TLS still bound to the hostname, a fixed header set, no
 * redirects, bounded bytes, a deadline and cancellation — and that policy has
 * no exception path. This module owns the part that differs between services:
 * how a package's validated arguments become one request, and how one response
 * becomes the value the package's own output schema will then check.
 *
 * ## The package controls values; the host controls the request shape
 *
 * An adapter is chosen by the binding's `implementation_id`, which is host
 * code, never by anything a package says. It reads only the argument names it
 * was written for, refuses any other, and places their values into a request
 * whose origin, path, method, parameter *names* and headers are fixed here. A
 * package can therefore choose *what to search for*, within its own declared
 * schema, and nothing about *where* or *how*.
 *
 * Because the mapping is part of what a binding would do, it is covered by the
 * binding digest through `implementation_id` and `implementation_version`:
 * changing a parameter name or a normalization rule without bumping the version
 * is caught by a test that fingerprints each adapter.
 *
 * ## Two adapters
 *
 * * `openclaw.tool.json_http` — the Citation Resolver's contract: the arguments
 *   are the JSON body of one POST, and 200/400/404/422/502 bodies are returned
 *   as data for the package's schema to accept or reject;
 * * `openclaw.tool.crossref_works_search` — one `GET /works` with three fixed
 *   parameters, returning only the fields a scholarly-search result declares,
 *   with markup rendered to text exactly as the Citation Resolver renders the
 *   same Crossref fields.
 */
import { clip } from "./errors.js";
import { pythonHtmlText } from "./html-text.js";

export type AdapterRequest = {
  /** Query parameters in a fixed order; names are adapter constants. */
  query: ReadonlyArray<readonly [string, string]> | null;
  /** A JSON body for POST, or null. */
  body: string | null;
};

export type AdapterAnswer = { status: number; json: unknown };

/** Raised by an adapter; the broker turns it into a stable tool code. */
export class AdapterRefusal extends Error {
  constructor(
    readonly code:
      | "tool_request_invalid"
      | "tool_response_invalid"
      | "tool_unavailable"
      | "tool_transport_error",
    message: string,
  ) {
    super(message);
  }
}

export type HttpAdapter = {
  id: string;
  /** One sentence for the operator: what request this binding sends. */
  describes: string;
  request(args: unknown, method: "GET" | "POST"): AdapterRequest;
  response(answer: AdapterAnswer, args: unknown, retrievedAt: string): unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -- the Citation Resolver's contract ----------------------------------------
export const JSON_HTTP_ADAPTER: HttpAdapter = {
  id: "openclaw.tool.json_http",
  describes: "One JSON request body to the configured origin and path; no query parameters.",
  request(args, method) {
    return { query: null, body: method === "POST" ? JSON.stringify(args ?? null) : null };
  },
  response({ status, json }) {
    if (status >= 500 && status !== 502) {
      throw new AdapterRefusal("tool_unavailable", `the tool host answered HTTP ${status}`);
    }
    if (status === 401 || status === 403) {
      throw new AdapterRefusal("tool_unavailable", "the tool host refused this call");
    }
    if (status >= 400 && ![400, 404, 422, 502].includes(status)) {
      throw new AdapterRefusal("tool_transport_error", `the tool host answered HTTP ${status}`);
    }
    // 4xx/502 bodies reach the package *only* because its own declared output
    // schema then has to accept them; an unresolved lookup is data, not an
    // exception. Anything the schema rejects fails the run in the runtime.
    return json;
  },
};

// -- Crossref /works search ---------------------------------------------------
/** Exactly the fields a scholarly-search result is built from. Nothing else. */
export const CROSSREF_SELECT = [
  "DOI",
  "title",
  "author",
  "published",
  "published-print",
  "published-online",
  "issued",
  "container-title",
  "abstract",
  "URL",
].join(",");

/**
 * Only scholarly works in their own right. Crossref's relevance ranking also
 * surfaces supplementary files (`component`), reviews *of* other works
 * (`peer-review`), datasets and containers; none is a paper a review can screen
 * and cite, so the host does not ask for them. A repeated `type:` filter is an
 * OR in Crossref's API.
 */
export const CROSSREF_TYPES = [
  "journal-article",
  "proceedings-article",
  "posted-content",
  "book-chapter",
  "book",
  "monograph",
  "report",
  "dissertation",
];
export const CROSSREF_FILTER = CROSSREF_TYPES.map((type) => `type:${type}`).join(",");

export const CROSSREF_MAX_QUERY_CHARS = 500;
export const CROSSREF_MAX_ROWS = 20;
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/iu;
// Non-printing controls. Tab and newline are harmless once percent-encoded.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function crossrefArgs(args: unknown): { query: string; limit: number } {
  if (!isRecord(args)) {
    throw new AdapterRefusal("tool_request_invalid", "scholarly search arguments must be an object");
  }
  for (const key of Object.keys(args)) {
    if (key !== "query" && key !== "limit") {
      // The host reads only the names it was written for. Any other name
      // would be a way for a package to shape the request, so it is refused.
      throw new AdapterRefusal(
        "tool_request_invalid",
        `scholarly search does not accept an argument named ${clip(key, 64)}`,
      );
    }
  }
  const { query, limit } = args;
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    [...query].length > CROSSREF_MAX_QUERY_CHARS ||
    CONTROL.test(query)
  ) {
    throw new AdapterRefusal(
      "tool_request_invalid",
      `the search query must be 1 to ${CROSSREF_MAX_QUERY_CHARS} characters of text`,
    );
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > CROSSREF_MAX_ROWS) {
    throw new AdapterRefusal(
      "tool_request_invalid",
      `the result limit must be an integer from 1 to ${CROSSREF_MAX_ROWS}`,
    );
  }
  return { query, limit };
}

function firstString(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function yearOf(item: Record<string, unknown>): number | null {
  // The Citation Resolver's order, so both tools date one record identically.
  for (const field of ["published", "published-print", "published-online", "issued"]) {
    const parts = isRecord(item[field]) ? (item[field] as Record<string, unknown>)["date-parts"] : null;
    const first = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
    if (typeof first === "number" && Number.isInteger(first) && first !== 0) return first;
  }
  return null;
}

function doiOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // DOIs are case-insensitive; the Citation Resolver stores them lowercase, and
  // a package that later compares the two identities must see the same string.
  return DOI_PATTERN.test(trimmed) && !CONTROL.test(trimmed) ? trimmed.toLowerCase() : null;
}

function urlOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

function authorsOf(value: unknown): Array<{ name: string }> {
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
  id: "openclaw.tool.crossref_works_search",
  describes:
    "GET /works?query.bibliographic=<query>&rows=<limit>&select=<fixed field list>" +
    "&filter=<scholarly work types>; no other parameter, path or header can be supplied.",
  request(args, method) {
    if (method !== "GET") {
      throw new AdapterRefusal("tool_request_invalid", "the Crossref search binding sends GET only");
    }
    const { query, limit } = crossrefArgs(args);
    return {
      body: null,
      query: [
        ["query.bibliographic", query],
        ["rows", String(limit)],
        ["select", CROSSREF_SELECT],
        ["filter", CROSSREF_FILTER],
      ],
    };
  },
  response({ status, json }, args, retrievedAt) {
    if (status === 429) {
      throw new AdapterRefusal("tool_unavailable", "Crossref is rate-limiting this host");
    }
    if (status >= 500 || status === 401 || status === 403) {
      throw new AdapterRefusal("tool_unavailable", `Crossref answered HTTP ${status}`);
    }
    if (status !== 200) {
      // The request shape is host code and the values were validated twice,
      // so anything but 200 is a failed call, never data for the package.
      throw new AdapterRefusal("tool_transport_error", `Crossref answered HTTP ${status}`);
    }
    const { query, limit } = crossrefArgs(args);
    const message = isRecord(json) ? json.message : undefined;
    const items = isRecord(message) ? message.items : undefined;
    if (!isRecord(json) || json.status !== "ok" || !Array.isArray(items)) {
      throw new AdapterRefusal("tool_response_invalid", "Crossref returned no work list");
    }
    const papers: Array<Record<string, unknown>> = [];
    let skipped = 0;
    for (const raw of items.slice(0, limit)) {
      if (!isRecord(raw)) {
        skipped += 1;
        continue;
      }
      const title = pythonHtmlText(firstString(raw.title));
      if (!title) {
        // A record without a title cannot be screened or cited. It is counted,
        // not invented.
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
        provenance: [
          { source: "crossref", query, locator: doi, synthetic: false, retrieved_at: retrievedAt },
        ],
      });
    }
    return { papers, query, source: "crossref", skipped_records: skipped };
  },
};

export const HTTP_ADAPTERS: ReadonlyMap<string, HttpAdapter> = new Map(
  [JSON_HTTP_ADAPTER, CROSSREF_WORKS_ADAPTER].map((adapter) => [adapter.id, adapter]),
);

/** Encode a fixed-order parameter list; values are percent-encoded, names are constants. */
export function encodeQuery(query: ReadonlyArray<readonly [string, string]>): string {
  return new URLSearchParams(query.map(([name, value]) => [name, value])).toString();
}
