/**
 * The one message contract of the extension (D-033).
 *
 * Three kinds of message cross process boundaries: requests from the extension's own pages
 * (side panel, full page) to the service worker; the single `content.links` report a content
 * script may send; and `event.*` broadcasts from the service worker. Every message is
 * validated structurally at the receiver with bounded strings; unknown types are refused.
 * Responses are `{ok: true, result}` or `{ok: false, error}` with the control plane's stable
 * codes, never prose a UI would branch on.
 */
import type { AgentPageModel } from "../core/agent-page.js";
import type { Candidate, DiscoveryResult, DiscoveryStatus } from "../core/discovery.js";
import { CoreError } from "../core/errors.js";
import type { PublisherReport } from "../core/evaluation.js";
import type { BrowserSummary } from "../core/summary.js";
import type { PinScope, TrustEntry, TrustState } from "../core/trust.js";

export const MAX_URL = 2048;
export const MAX_ID = 200;
export const MAX_LINKS = 16;

export type Request =
  | { type: "candidates.get"; tabId: number }
  | { type: "website.discover"; url: string }
  | { type: "package.open"; url: string; advertisedOn?: string | null; viewId?: string | null }
  | { type: "package.get"; sessionId: string; viewId?: string | null }
  /** A view stops showing a session; the session ends when no view holds it (review 2, nit 5). */
  | { type: "package.release"; sessionId: string; viewId: string }
  /** End a session for every view (Library). */
  | { type: "package.close"; sessionId: string }
  | { type: "sessions.list" }
  | { type: "trust.list" }
  | { type: "trust.pin"; sessionId: string; signerFingerprint: string; scope: PinScope }
  | { type: "trust.pinKey"; publicKeyPem: string; displayName: string; publisherId?: string | null; packageIdPrefix?: string | null }
  | { type: "trust.unpin"; fingerprint: string }
  | { type: "status.get" };

export interface ContentLink {
  href: string | null;
  type: string | null;
  title: string | null;
}

/** The only message a content script may send: the link elements it saw, nothing else. */
export interface ContentMessage {
  type: "content.links";
  links: ContentLink[];
}

export type Event = { type: "event.candidates"; tabId: number } | { type: "event.sessions" } | { type: "event.trust" };

export type Response<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

// -- results -------------------------------------------------------------------------
export interface CandidateState {
  tabId: number;
  pageUrl: string;
  pageOrigin: string;
  status: DiscoveryStatus;
  candidates: Candidate[];
  linksNotListed: number;
  updatedAt: string;
}

export interface SessionSource {
  kind: "url" | "website";
  display: string;
  advertised_on: string | null;
  opened_at: string;
}

export interface SessionDescriptor {
  session_id: string;
  created_at: string;
  expires_at: string;
  source: SessionSource;
  archive_sha256: string;
  archive_bytes: number;
  package_id: string;
  name: string;
  version: string;
  digest: string;
  signature_status: PublisherReport["signature_status"];
  trust_status: PublisherReport["trust_status"];
}

export interface SessionView {
  session: { id: string; created_at: string; expires_at: string; ttl_seconds: number };
  source: SessionSource;
  snapshot: { archive_sha256: string; archive_bytes: number; captured_once: true };
  summary: BrowserSummary;
  page: AgentPageModel;
  execution: { performed: false; note: string };
}

export interface TrustList {
  entries: TrustEntry[];
  state: TrustState;
}

export interface PinResult {
  added: TrustEntry;
  scope: PinScope;
  trust_store: TrustState;
  publisher: PublisherReport;
}

export interface StatusInfo {
  version: string;
  core_version: string;
  runtime_version: string;
  sessions: number;
  max_sessions: number;
  cached_bytes: number;
  max_cache_bytes: number;
  session_ttl_seconds: number;
  execution: "disabled";
}

export type WebsiteResult = DiscoveryResult;

// -- validation ----------------------------------------------------------------------
function invalid(message: string): CoreError {
  return new CoreError("invalid_request", message);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("message must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${field} must be a string of 1 to ${max} characters`);
  }
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field, max);
}

function only(fields: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) throw invalid(`unknown field ${JSON.stringify(key)}`);
  }
}

/** Validate a request from an extension page. Unknown types and fields are refused. */
export function parseRequest(value: unknown): Request {
  const fields = record(value);
  const type = fields.type;
  switch (type) {
    case "candidates.get": {
      only(fields, ["type", "tabId"]);
      if (typeof fields.tabId !== "number" || !Number.isInteger(fields.tabId) || fields.tabId < 0) throw invalid("tabId must be a tab id");
      return { type, tabId: fields.tabId };
    }
    case "website.discover":
      only(fields, ["type", "url"]);
      return { type, url: text(fields.url, "url", MAX_URL) };
    case "package.open":
      only(fields, ["type", "url", "advertisedOn", "viewId"]);
      return {
        type,
        url: text(fields.url, "url", MAX_URL),
        advertisedOn: optionalText(fields.advertisedOn, "advertisedOn", MAX_URL),
        viewId: optionalText(fields.viewId, "viewId", MAX_ID),
      };
    case "package.get":
      only(fields, ["type", "sessionId", "viewId"]);
      return { type, sessionId: text(fields.sessionId, "sessionId", MAX_ID), viewId: optionalText(fields.viewId, "viewId", MAX_ID) };
    case "package.release":
      only(fields, ["type", "sessionId", "viewId"]);
      return { type, sessionId: text(fields.sessionId, "sessionId", MAX_ID), viewId: text(fields.viewId, "viewId", MAX_ID) };
    case "package.close":
      only(fields, ["type", "sessionId"]);
      return { type, sessionId: text(fields.sessionId, "sessionId", MAX_ID) };
    case "sessions.list":
    case "trust.list":
    case "status.get":
      only(fields, ["type"]);
      return { type };
    case "trust.pin": {
      only(fields, ["type", "sessionId", "signerFingerprint", "scope"]);
      const scope = fields.scope ?? "package";
      if (scope !== "package" && scope !== "publisher") throw invalid("scope must be 'package' (narrow) or 'publisher'");
      return {
        type,
        sessionId: text(fields.sessionId, "sessionId", MAX_ID),
        signerFingerprint: text(fields.signerFingerprint, "signerFingerprint", MAX_ID),
        scope,
      };
    }
    case "trust.pinKey":
      only(fields, ["type", "publicKeyPem", "displayName", "publisherId", "packageIdPrefix"]);
      return {
        type,
        publicKeyPem: text(fields.publicKeyPem, "publicKeyPem", 16 * 1024),
        displayName: text(fields.displayName, "displayName", MAX_ID),
        publisherId: optionalText(fields.publisherId, "publisherId", MAX_ID),
        packageIdPrefix: optionalText(fields.packageIdPrefix, "packageIdPrefix", MAX_ID),
      };
    case "trust.unpin":
      only(fields, ["type", "fingerprint"]);
      return { type, fingerprint: text(fields.fingerprint, "fingerprint", MAX_ID) };
    default:
      throw invalid(`unknown request type ${JSON.stringify(String(type).slice(0, 40))}`);
  }
}

/** Validate the one message a content script may send. */
export function parseContentMessage(value: unknown): ContentMessage {
  const fields = record(value);
  if (fields.type !== "content.links") throw invalid("content scripts may send content.links only");
  only(fields, ["type", "links"]);
  if (!Array.isArray(fields.links) || fields.links.length > MAX_LINKS) throw invalid(`links must be an array of at most ${MAX_LINKS} items`);
  const links: ContentLink[] = fields.links.map((item) => {
    const link = record(item);
    only(link, ["href", "type", "title"]);
    const bounded = (field: unknown, name: string): string | null => {
      if (field === null || field === undefined) return null;
      if (typeof field !== "string") throw invalid(`${name} must be a string or null`);
      return field.slice(0, MAX_URL);
    };
    return { href: bounded(link.href, "href"), type: bounded(link.type, "type"), title: bounded(link.title, "title") };
  });
  return { type: "content.links", links };
}

export function isEvent(value: unknown): value is Event {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" && (value as { type: string }).type.startsWith("event.");
}

export function success<T>(result: T): Response<T> {
  return { ok: true, result };
}

export function failure(error: unknown): Response<never> {
  if (error instanceof CoreError) {
    const payload: { code: string; message: string; details?: Record<string, unknown> } = { code: error.code, message: error.message };
    if (Object.keys(error.details).length > 0) payload.details = error.details;
    return { ok: false, error: payload };
  }
  // Never carry an unexpected error's text (it could quote a page or a provider body).
  return { ok: false, error: { code: "internal_error", message: `The operation failed (${error instanceof Error ? error.name : "error"}).` } };
}
