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
import type { AuthorizationRequest, Decided } from "../core/authorization.js";
import type { CatalogEvaluation } from "../core/compatibility.js";
import type { Candidate, DiscoveryResult, DiscoveryStatus } from "../core/discovery.js";
import { CoreError } from "../core/errors.js";
import type { PublisherReport } from "../core/evaluation.js";
import { isRecord } from "../core/fields.js";
import type { ResourceEvaluation } from "../core/hostresources.js";
import type { ToolStatus } from "../core/hosttools.js";
import type { ProbeResult, ProviderId } from "../core/models/catalog.js";
import { PROVIDER_IDS } from "../core/models/catalog.js";
import type { Profile } from "../core/profiles.js";
import type { BrowserSummary } from "../core/summary.js";
import type { PinScope, TrustEntry, TrustState } from "../core/trust.js";
import type { AuthorizationReceipt, BrowserPolicy, PresetId, Reason, RunPlan, RunPlanPreflight } from "../core/types.js";
import type { VaultRecordView, VaultTypeView } from "../core/vault.js";
import type { Settings } from "./storage/settings.js";

export const MAX_URL = 2048;
export const MAX_ID = 200;
export const MAX_LINKS = 16;
/** Bound on a submitted decisions, approvals or picks object. */
export const MAX_DECISIONS = 256;
/** Bound on a submitted settings, provenance or vault record (JSON text). */
export const MAX_SUBMITTED_BYTES = 64 * 1024;

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
  | { type: "status.get" }
  // -- authorization (T3) ----------------------------------------------------------------
  | { type: "authorization.get"; sessionId: string }
  | {
      type: "authorization.authorize";
      sessionId: string;
      packageDigest: string;
      decisions: Record<string, string>;
      toolApprovals: Record<string, boolean>;
      resourceSelections: Record<string, string>;
      provenance: unknown | null;
      /** Also prepare a run plan with the default model, when one is set. */
      prepare: boolean;
    }
  | { type: "authorization.useProfile"; sessionId: string; packageDigest: string; profileId: string; resourceSelections: Record<string, string>; prepare: boolean }
  | { type: "models.evaluate"; sessionId: string; refresh: boolean }
  | { type: "models.probe"; provider: ProviderId }
  | { type: "runplan.prepare"; sessionId: string; packageDigest: string; receiptId: string; modelId: string }
  | { type: "runplan.get"; sessionId: string }
  | { type: "runplan.clear"; sessionId: string }
  | { type: "settings.get" }
  | { type: "settings.set"; settings: unknown }
  | { type: "settings.setKey"; provider: ProviderId; key: string | null }
  | { type: "vault.get" }
  | { type: "vault.putRecord"; record: unknown }
  | { type: "vault.deleteRecord"; recordId: string }
  | { type: "vault.installDemo"; records: boolean };

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

export type Event =
  | { type: "event.candidates"; tabId: number }
  | { type: "event.sessions" }
  | { type: "event.trust" }
  | { type: "event.authorization"; sessionId: string }
  | { type: "event.settings" }
  | { type: "event.vault" };

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
  /** The control plane's session summary of consent and plan (`control.py::_compose_summary`). */
  authorization: { state: "none" | "issued"; receipt_id: string | null; runnable: boolean };
  run_plan: { state: "absent" | "prepared"; run_plan_id: string | null; ready: boolean };
  execution: { performed: false; note: string };
}

// -- authorization results (T3) --------------------------------------------------------
export interface RunPlanState {
  run_plan: RunPlan;
  preflight: RunPlanPreflight;
}

export interface ToolOffer {
  tool_id: string;
  binding_name: string;
  status: ToolStatus;
  reason: string | null;
  implementation_kind: string | null;
  display_name: string | null;
  side_effects: string;
  approval_required: boolean;
  permission_ids: string[];
  resource_type: string | null;
}

/** Everything the authorize view needs for one session, computed by the worker (D-035). */
export interface AuthorizationView {
  session_id: string;
  package_digest: string;
  preset: PresetId;
  local_models_only: boolean;
  request: AuthorizationRequest & { blocking_reasons: Reason[]; browser_policy: BrowserPolicy };
  /** The publisher's profiles with the decisions each yields under the current preset, or null. */
  profiles: Array<{ profile: Profile; decided: Decided }> | null;
  profile_notes: string[];
  /** The customize view's starting point under the current preset. */
  defaults: Decided;
  /** Which permissions request a host resource the vault offers, with the labels to choose from. */
  resources: ResourceEvaluation;
  /** Resource types the package requests that the vault holds no type for. */
  missing_resource_types: string[];
  tools: ToolOffer[];
  receipt: AuthorizationReceipt | null;
  run_plan: RunPlanState | null;
  default_model: string | null;
}

export interface AuthorizeResult {
  receipt: AuthorizationReceipt;
  run_plan: RunPlanState | null;
  /** Why no plan was prepared, when one was asked for: the model, or the blockers. */
  plan_refused: Reason[] | null;
  model_id: string | null;
}

export interface ModelsView {
  evaluation: CatalogEvaluation;
  probes: ProbeResult[];
  default_model: string | null;
  local_models_only: boolean;
  execution_mode_permission_ids: string[];
  execution_mode_permissions_granted: boolean;
  captured_at: string;
}

export interface SettingsView {
  settings: Settings;
  /** Which hosted providers have a key; never the key. */
  keys: Record<string, boolean>;
}

export interface VaultView {
  types: VaultTypeView[];
  records: VaultRecordView[];
  /** Whether the fictional demo set could be added (its types are known to this build). */
  demo_available: boolean;
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

/** A bounded object of id → string. The ids and values are checked semantically by the core. */
function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).length > MAX_DECISIONS) throw invalid(`${field} must be an object of at most ${MAX_DECISIONS} entries`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[text(key, `${field} key`, MAX_ID)] = text(item, `${field}[${key}]`, MAX_ID);
  return out;
}

function booleanMap(value: unknown, field: string): Record<string, boolean> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).length > MAX_DECISIONS) throw invalid(`${field} must be an object of at most ${MAX_DECISIONS} entries`);
  const out: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "boolean") throw invalid(`${field}[${key}] must be a boolean`);
    out[text(key, `${field} key`, MAX_ID)] = item;
  }
  return out;
}

/** An opaque JSON value the core validates; only its size is bounded here. */
function bounded(value: unknown, field: string): unknown {
  if (value === undefined) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? "null";
  } catch {
    throw invalid(`${field} must be JSON`);
  }
  if (encoded.length > MAX_SUBMITTED_BYTES) throw invalid(`${field} exceeds ${MAX_SUBMITTED_BYTES} bytes`);
  return JSON.parse(encoded) as unknown;
}

function provider(value: unknown): ProviderId {
  if (typeof value !== "string" || !(PROVIDER_IDS as readonly string[]).includes(value)) throw invalid(`provider must be one of ${PROVIDER_IDS.join(", ")}`);
  return value as ProviderId;
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
    case "authorization.get":
    case "runplan.get":
    case "runplan.clear":
      only(fields, ["type", "sessionId"]);
      return { type, sessionId: text(fields.sessionId, "sessionId", MAX_ID) };
    case "authorization.authorize":
      only(fields, ["type", "sessionId", "packageDigest", "decisions", "toolApprovals", "resourceSelections", "provenance", "prepare"]);
      return {
        type,
        sessionId: text(fields.sessionId, "sessionId", MAX_ID),
        packageDigest: text(fields.packageDigest, "packageDigest", MAX_ID),
        decisions: stringMap(fields.decisions, "decisions"),
        toolApprovals: booleanMap(fields.toolApprovals, "toolApprovals"),
        resourceSelections: stringMap(fields.resourceSelections, "resourceSelections"),
        provenance: bounded(fields.provenance, "provenance"),
        prepare: fields.prepare === true,
      };
    case "authorization.useProfile":
      only(fields, ["type", "sessionId", "packageDigest", "profileId", "resourceSelections", "prepare"]);
      return {
        type,
        sessionId: text(fields.sessionId, "sessionId", MAX_ID),
        packageDigest: text(fields.packageDigest, "packageDigest", MAX_ID),
        profileId: text(fields.profileId, "profileId", MAX_ID),
        resourceSelections: stringMap(fields.resourceSelections, "resourceSelections"),
        prepare: fields.prepare === true,
      };
    case "models.evaluate":
      only(fields, ["type", "sessionId", "refresh"]);
      return { type, sessionId: text(fields.sessionId, "sessionId", MAX_ID), refresh: fields.refresh === true };
    case "models.probe":
      only(fields, ["type", "provider"]);
      return { type, provider: provider(fields.provider) };
    case "runplan.prepare":
      only(fields, ["type", "sessionId", "packageDigest", "receiptId", "modelId"]);
      return {
        type,
        sessionId: text(fields.sessionId, "sessionId", MAX_ID),
        packageDigest: text(fields.packageDigest, "packageDigest", MAX_ID),
        receiptId: text(fields.receiptId, "receiptId", MAX_ID),
        modelId: text(fields.modelId, "modelId", 300),
      };
    case "settings.get":
    case "vault.get":
      only(fields, ["type"]);
      return { type };
    case "settings.set":
      only(fields, ["type", "settings"]);
      return { type, settings: bounded(fields.settings, "settings") };
    case "settings.setKey":
      only(fields, ["type", "provider", "key"]);
      return { type, provider: provider(fields.provider), key: fields.key === null || fields.key === undefined ? null : text(fields.key, "key", 512) };
    case "vault.putRecord":
      only(fields, ["type", "record"]);
      return { type, record: bounded(fields.record, "record") };
    case "vault.deleteRecord":
      only(fields, ["type", "recordId"]);
      return { type, recordId: text(fields.recordId, "recordId", MAX_ID) };
    case "vault.installDemo":
      only(fields, ["type", "records"]);
      return { type, records: fields.records === true };
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
