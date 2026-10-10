/**
 * The built-in Crossref DOI lookup behind the `citation.resolve` fallback (D-153): when the
 * Citation Resolver is unavailable for a DOI query, the host asks Crossref for that one work and
 * answers in the resolver's own output contract, as the resolver itself would for a DOI it found
 * at Crossref (`citation-resolver/app/providers/crossref.py::normalize`, `resolver.py`).
 *
 * The request is host code: one `GET https://api.crossref.org/works/{doi}`, the DOI percent-encoded
 * as the resolver encodes it (`quote(doi, safe="")`), plus `mailto` only when the person entered a
 * contact address in Settings → Services (the search binding's rule, D-081). The same transport,
 * header set and response limits as the search binding apply. Crossref answers an unknown DOI
 * with 404 and a plain-text body ("Resource not found.", observed 2026-10-10), so a 404 is read
 * before any content type; a 200 must be JSON with `status: "ok"`.
 *
 * The answer is never invented: a record whose DOI is not the one asked for, or that has no
 * title, is refused (`tool_response_invalid`), and the caller then ends the call exactly as it
 * would have without the fallback. Text fields are rendered by `pythonHtmlText`, the resolver's
 * `clean_text`, so a quote later checked against an abstract reads the same characters.
 */
import { pythonHtmlText } from "../../html-text.js";
import type { JsonObject, JsonValue } from "../../json.js";
import type { HttpTransport } from "../../models/transport.js";
import { contentTypeCategory, type ToolFailureFacts } from "../facts.js";
import { encodeQuery, validContact } from "./crossref.js";
import { retryAfterMs, toolError, transportFailure, USER_AGENT } from "./json-http.js";

export const CROSSREF_DOI_IMPLEMENTATION = Object.freeze({ id: "chrome.tool.crossref_doi_lookup", version: "0.1.0" });
export const CROSSREF_ORIGIN = "https://api.crossref.org";
/** The endpoint as a binding descriptor names it; `{doi}` is one encoded path segment. */
export const CROSSREF_DOI_PATH = "/works/{doi}";
/** The search binding's limits (D-081), which the lookup shares. */
export const CROSSREF_DOI_LIMITS = Object.freeze({ timeout_seconds: 25, max_request_bytes: 4 * 1024, max_response_bytes: 512 * 1024, max_concurrent: 1, min_interval_ms: 1000 });
export const FALLBACK_WARNING = "The Citation Resolver was unavailable, so this browser looked the DOI up at Crossref only (built-in fallback).";
export const BIBTEX_WARNING = "BibTeX was not generated: the built-in lookup returns metadata only.";
export const RESOLVED_MESSAGE = "Exact identifier verified against the provider record.";
export const NOT_FOUND_MESSAGE = "No credible work found in the queried providers.";

// `identifiers.py::DOI_PATTERN` (`10\.\d{4,9}/[^\s]+` on a `str`: Unicode digits and spaces).
const DOI_PATTERN = /^10\.\p{Nd}{4,9}\/[^\s\u0085\u001c-\u001f]+$/u;
const DOI_HOSTS = new Set(["doi.org", "dx.doi.org", "www.doi.org"]);

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `urllib.parse.unquote`: percent-escapes decoded as UTF-8, an invalid sequence replaced. */
function unquote(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  });
}

/** `identifiers.py::identifier_url` for the DOI hosts: the decoded path, or null. */
function doiUrlPath(value: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/u.exec(value);
  if (!match) return null;
  const [, scheme, authority, path] = match;
  if (scheme!.toLowerCase() !== "http" && scheme!.toLowerCase() !== "https") return null;
  if (authority!.includes("@")) return null;
  const hostPort = /^([^:]*)(?::([0-9]*))?$/u.exec(authority!);
  if (!hostPort) return null;
  const host = hostPort[1]!.toLowerCase();
  const port = hostPort[2];
  if (!DOI_HOSTS.has(host)) return null;
  if (port !== undefined && port !== "" && port !== "80" && port !== "443") return null;
  return unquote(path!.replace(/^\/+/u, ""));
}

/**
 * The resolver's `parse_doi`: a bare DOI, `doi:`-prefixed, or a doi.org URL, without control
 * characters, lowercased (DOIs are case-insensitive and the resolver stores them lowercase); null
 * for anything else.
 */
export function parseDoi(value: string): string | null {
  let text = value.trim();
  if (text.toLowerCase().startsWith("doi:")) text = text.slice(4).trim();
  if (text.includes("://")) text = doiUrlPath(text) ?? "";
  if (!DOI_PATTERN.test(text) || [...text].some((char) => char.codePointAt(0)! < 32)) return null;
  return text.toLowerCase();
}

/**
 * The DOI a `citation.resolve` call asks for, when the call is a DOI query as the resolver reads
 * one (`detect_query`: `query_type` absent, `auto` or `doi`, and the query a DOI); null otherwise.
 */
export function doiQuery(args: JsonValue): string | null {
  if (!isRecord(args) || typeof args.query !== "string") return null;
  const type = args.query_type ?? "auto";
  if (type !== "auto" && type !== "doi") return null;
  return parseDoi(args.query);
}

const PYTHON_SAFE = /[A-Za-z0-9_.~-]/u;

/** `urllib.parse.quote(text, safe)`: UTF-8 bytes, unreserved characters (and `safe`) kept, `%XX` otherwise. */
export function pyQuote(text: string, safe = ""): string {
  let out = "";
  for (const char of text) {
    if (PYTHON_SAFE.test(char) || safe.includes(char)) out += char;
    else for (const byte of new TextEncoder().encode(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function yearOf(record: Record<string, JsonValue>): number | null {
  for (const field of ["published", "published-print", "published-online", "issued"]) {
    const holder = record[field];
    const parts = isRecord(holder) ? holder["date-parts"] : null;
    const first = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
    if (typeof first === "number" && Number.isInteger(first) && first !== 0) return first;
  }
  return null;
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** `crossref.py::normalize` for one work, or null when the record is not the work asked for. */
export function paperFromWork(record: Record<string, JsonValue>, doi: string): JsonObject | null {
  const recordDoi = typeof record.DOI === "string" ? parseDoi(record.DOI) : null;
  if (recordDoi === null || recordDoi !== doi) return null;
  const titles = Array.isArray(record.title) ? record.title : [];
  const title = titles.length > 0 ? pythonHtmlText(titles[0]) : null;
  if (!title) return null;
  const authors: JsonObject[] = [];
  for (const author of Array.isArray(record.author) ? record.author : []) {
    if (!isRecord(author)) continue;
    const given = pythonHtmlText(author.given);
    const family = pythonHtmlText(author.family);
    const name = pythonHtmlText(author.name) ?? ([given, family].filter(Boolean).join(" ") || null);
    if (name) authors.push({ name, given, family, orcid: text(author.ORCID) });
  }
  const venues = Array.isArray(record["container-title"]) ? record["container-title"] : [];
  return {
    title,
    authors,
    year: yearOf(record),
    venue: venues.length > 0 ? pythonHtmlText(venues[0]) : null,
    publisher: pythonHtmlText(record.publisher),
    doi,
    arxiv_id: null,
    url: `https://doi.org/${pyQuote(doi, "/")}`,
    publication_type: text(record.type),
    abstract: pythonHtmlText(record.abstract),
    volume: text(record.volume),
    issue: text(record.issue),
    pages: text(record.page),
    journal_reference: null,
    provider_ids: { crossref: doi },
    source: "crossref",
    bibtex: null,
  };
}

/** The resolver-output document the lookup answers with (`ResolveResponse`). */
export function fallbackAnswer(query: string, paper: JsonObject | null, format: JsonValue | undefined): JsonObject {
  if (paper === null) {
    return { status: "not_found", query, detected_type: "doi", best_match: null, match_score: null, alternatives: [], sources: [{ provider: "crossref", status: "not_found", error_code: null }], warnings: [FALLBACK_WARNING], message: NOT_FOUND_MESSAGE };
  }
  const warnings = format === "bibtex" ? [FALLBACK_WARNING, BIBTEX_WARNING] : [FALLBACK_WARNING];
  return { status: "resolved", query, detected_type: "doi", best_match: paper, match_score: 1, alternatives: [], sources: [{ provider: "crossref", status: "ok", error_code: null }], warnings, message: RESOLVED_MESSAGE };
}

export interface DoiLookupOptions {
  transport: HttpTransport;
  /** The call's arguments, as the package sent them to `citation.resolve`. */
  args: JsonValue;
  doi: string;
  signal: AbortSignal;
  contact?: string | null;
  now?: () => number;
  observe?: (request: { tool_id: string; binding_id: string; url: string; body: string | null }) => void;
  toolId: string;
}

/** One lookup: the resolver-output answer and the HTTP status, or a refusal with the shared tool codes. */
export async function crossrefDoiLookup(options: DoiLookupOptions): Promise<{ output: JsonValue; status: number }> {
  const { doi, signal } = options;
  const contact = validContact(options.contact);
  const target = `/works/${pyQuote(doi)}${contact !== null ? `?${encodeQuery([["mailto", contact]])}` : ""}`;
  if (new TextEncoder().encode(target).length > CROSSREF_DOI_LIMITS.max_request_bytes) throw toolError("tool_request_invalid", "the DOI is too long for the lookup's URL bound");
  const url = `${CROSSREF_ORIGIN}${target}`;
  options.observe?.({ tool_id: options.toolId, binding_id: CROSSREF_DOI_IMPLEMENTATION.id, url, body: null });
  let answer;
  try {
    answer = await options.transport({ url, method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT }, body: null, signal, maxResponseBytes: CROSSREF_DOI_LIMITS.max_response_bytes });
  } catch (error) {
    throw transportFailure(error, signal);
  }
  const status = answer.status;
  const responseBytes = new TextEncoder().encode(answer.body).length;
  const facts: ToolFailureFacts = { http_status: status, content_type: contentTypeCategory(answer.headers["content-type"] ?? null), response_bytes: responseBytes, body_exceeded: false };
  const retryAfter = status >= 400 ? retryAfterMs(answer.headers["retry-after"], (options.now ?? Date.now)()) : undefined;
  const fail = (code: string, message: string, stage: string) => toolError(code, message, { ...facts, stage }, retryAfter !== undefined ? { retry_after_ms: retryAfter } : {});
  if (status >= 300 && status < 400) throw toolError("tool_transport_error", "Crossref returned a redirect, which is never followed", { stage: "status", http_status: status });
  if (responseBytes > CROSSREF_DOI_LIMITS.max_response_bytes) throw fail("tool_response_invalid", "the Crossref answer is too large", "body_size");
  const args = isRecord(options.args) ? options.args : {};
  const query = typeof args.query === "string" ? args.query.trim() : doi;
  // Crossref answers an unknown DOI with 404 and a plain-text body.
  if (status === 404) return { output: fallbackAnswer(query, null, args.format), status };
  if (status === 429 || status >= 500 || status === 401 || status === 403) throw fail("tool_unavailable", `Crossref answered HTTP ${status}`, "status");
  if (status !== 200) throw fail("tool_transport_error", `Crossref answered HTTP ${status}`, "status");
  if ((answer.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") throw fail("tool_response_invalid", "Crossref did not answer with JSON", "content_type");
  let json: JsonValue;
  try {
    json = JSON.parse(answer.body) as JsonValue;
  } catch {
    throw toolError("tool_response_invalid", "Crossref answered with invalid JSON", { ...facts, stage: "json_parse", json_parsed: false });
  }
  const message = isRecord(json) ? json.message : undefined;
  const paper = isRecord(json) && json.status === "ok" && isRecord(message) ? paperFromWork(message, doi) : null;
  if (paper === null) throw toolError("tool_response_invalid", "the Crossref record is not the work asked for", { ...facts, json_parsed: true, stage: "adapter_response" });
  return { output: fallbackAnswer(query, paper, args.format), status };
}
