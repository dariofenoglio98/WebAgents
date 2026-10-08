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
import type { RunRecord } from "../core/execution/record.js";
import type { CatalogEvaluation } from "../core/compatibility.js";
import type { Candidate, DiscoveryResult, DiscoveryStatus } from "../core/discovery.js";
import type { TaskValidation } from "../core/presentation.js";
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
import type { JsonValue } from "../core/json.js";
import type { AuthorizationReceipt, BrowserPolicy, PresetId, Reason, RunPlan, RunPlanPreflight } from "../core/types.js";
import type { VaultRecordView, VaultTypeView } from "../core/vault.js";
import type { Settings } from "./storage/settings.js";
import type { StoredObservation } from "./storage/runs.js";

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
      /** Also prepare a run plan, with `modelId` or else the default model, when one is set. */
      prepare: boolean;
      /** The model the person picked under "Customize your settings"; null or absent means the default model. */
      modelId?: string | null;
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
  | { type: "vault.installDemo"; records: boolean }
  // -- runs (T5, D-070…D-073) ---------------------------------------------------------------
  | { type: "run.readiness"; sessionId: string }
  | { type: "run.validateInput"; sessionId: string; input: unknown }
  | { type: "run.start"; sessionId: string; runPlanId: string; runPlanSha256: string; input: unknown }
  | { type: "run.get"; runId: string }
  | { type: "run.list"; sessionId?: string | null }
  /**
   * The run in flight a view that just opened should show (D-076): on an open session, the one
   * opened from `pageUrl` first, else the most recent; null when none.
   */
  | { type: "run.active"; pageUrl?: string | null }
  | { type: "run.cancel"; runId: string }
  | { type: "run.artifact"; runId: string; name: string }
  | { type: "run.artifactChunk"; runId: string; name: string; offset: number }
  | { type: "run.export"; runId: string }
  | { type: "run.clear"; runId: string }
  /** The request bodies recorded in test mode for one run (D-028); empty unless recording was on. */
  | { type: "run.observations"; runId: string }
  /** From the execution host only: a run's stored record changed; the worker re-reads and rebroadcasts. */
  | { type: "host.progress"; runId: string }
  | { type: "host.finished"; runId: string };

/** The task input a view may submit: bounded as the reference host bounds it. */
export const MAX_INPUT_BYTES = 256 * 1024;
export const ARTIFACT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/u;

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
  | { type: "event.vault" }
  /** A run's record changed (started, progressed, settled, cleared); views re-read `run.get`. */
  | { type: "event.run"; runId: string; sessionId: string; status: string };

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
  /** `enabled` once the execution host (T5) is wired; the host limits every run is bounded by. */
  execution: "enabled" | "disabled";
  execution_limits: { total_tokens: number; max_remote_calls: number; max_parallel_workers: number; max_output_tokens_per_call: number; run_timeout_seconds: number; max_calls_per_tool: number; model_call_timeout_seconds: number } | null;
  runs: { active: number; stored: number };
}

// -- run results (T5) ------------------------------------------------------------------
/** The Run Record as a view reads it (`record.ts`, the reference plugin's field names) plus the task quote. */
export interface RunView extends RunRecord {
  taskText: string | null;
  /** Whether this run's package session is still open in this browser. */
  sessionOpen: boolean;
  /** Which profile the authorization came from, when one was used (D-053 provenance). */
  profileId: string | null;
}

export interface RunSummary {
  runId: string;
  sessionId: string;
  runPlanId: string;
  status: RunRecord["status"];
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  package: { packageId: string; name: string | null; version: string };
  selectedModel: string | null;
  cancelRequested: boolean;
  errorCode: string | null;
  taskText: string | null;
}

export interface RunListView {
  runs: RunSummary[];
  /** The run in flight for the session asked about (or any session), with its full record. */
  active: RunView | null;
}

/** `execution.readiness`: whether Run may be pressed right now, and why not. */
export interface RunReadiness {
  session_id: string;
  checked_at: string;
  ready: boolean;
  run_plan_id: string | null;
  run_plan_sha256: string | null;
  blocker: Reason | null;
  /** What passed, in order, for the checklist. */
  checks: string[];
  receipt: { expires_at: string; remaining_seconds: number; required_seconds: number } | null;
  active_run_id: string | null;
  /** The preflight the readiness was computed from, when a plan exists. */
  preflight: RunPlanPreflight | null;
}

export type InputValidationView = TaskValidation;

export interface ArtifactContent {
  run_id: string;
  name: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
  shown_bytes: number;
  /** A small `.json` artifact, parsed. */
  json?: JsonValue;
  /** The text, up to the view limit. */
  text?: string;
}

export interface ArtifactChunk {
  run_id: string;
  name: string;
  bytes: number;
  sha256: string;
  offset: number;
  length: number;
  base64: string;
  eof: boolean;
}

/** The export bundle (D-073): the run directory as the Python runtime would write it, plus the plan and the input. */
export interface ExportBundle {
  run_id: string;
  entries: Array<{ name: string; bytes: number; sha256: string; base64: string }>;
}

/** `models.probe`'s answer: the core's probe plus, for Ollama, the B-117 diagnosis of a failed probe. */
export interface ProbeView extends ProbeResult {
  diagnosis: { state: "not_running" | "rejecting_origin" | "unknown"; hint: string } | null;
}

export interface ObservationsView {
  run_id: string;
  recording: boolean;
  observations: StoredObservation[];
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
  // Object.fromEntries defines own keys, so a `__proto__` key reaches the core and is refused by name.
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key, `${field} key`, MAX_ID), text(item, `${field}[${key}]`, MAX_ID)]));
}

function booleanMap(value: unknown, field: string): Record<string, boolean> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).length > MAX_DECISIONS) throw invalid(`${field} must be an object of at most ${MAX_DECISIONS} entries`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item !== "boolean") throw invalid(`${field}[${key}] must be a boolean`);
      return [text(key, `${field} key`, MAX_ID), item];
    }),
  );
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

/** A task input: any JSON value, bounded in bytes (the reference host's `MAX_INPUT_BYTES`); the package schema judges it. */
function boundedInput(value: unknown): unknown {
  if (value === undefined) throw invalid("input is required");
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? "null";
  } catch {
    throw invalid("input must be JSON");
  }
  if (new TextEncoder().encode(encoded).length > MAX_INPUT_BYTES) throw invalid(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  return JSON.parse(encoded) as unknown;
}

function artifactName(value: unknown): string {
  if (typeof value !== "string" || !ARTIFACT_NAME.test(value) || value.includes("..")) throw invalid("name must be an artifact name");
  return value;
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
      only(fields, ["type", "sessionId", "packageDigest", "decisions", "toolApprovals", "resourceSelections", "provenance", "prepare", "modelId"]);
      return {
        type,
        sessionId: text(fields.sessionId, "sessionId", MAX_ID),
        packageDigest: text(fields.packageDigest, "packageDigest", MAX_ID),
        decisions: stringMap(fields.decisions, "decisions"),
        toolApprovals: booleanMap(fields.toolApprovals, "toolApprovals"),
        resourceSelections: stringMap(fields.resourceSelections, "resourceSelections"),
        provenance: bounded(fields.provenance, "provenance"),
        prepare: fields.prepare === true,
        modelId: optionalText(fields.modelId, "modelId", 300),
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
    case "run.readiness":
      only(fields, ["type", "sessionId"]);
      return { type, sessionId: text(fields.sessionId, "sessionId", MAX_ID) };
    case "run.validateInput":
      only(fields, ["type", "sessionId", "input"]);
      return { type, sessionId: text(fields.sessionId, "sessionId", MAX_ID), input: boundedInput(fields.input) };
    case "run.start":
      only(fields, ["type", "sessionId", "runPlanId", "runPlanSha256", "input"]);
      return {
        type,
        sessionId: text(fields.sessionId, "sessionId", MAX_ID),
        runPlanId: text(fields.runPlanId, "runPlanId", MAX_ID),
        runPlanSha256: text(fields.runPlanSha256, "runPlanSha256", MAX_ID),
        input: boundedInput(fields.input),
      };
    case "run.get":
    case "run.cancel":
    case "run.export":
    case "run.clear":
    case "run.observations":
    case "host.progress":
    case "host.finished":
      only(fields, ["type", "runId"]);
      return { type, runId: text(fields.runId, "runId", MAX_ID) };
    case "run.list":
      only(fields, ["type", "sessionId"]);
      return { type, sessionId: optionalText(fields.sessionId, "sessionId", MAX_ID) };
    case "run.active":
      only(fields, ["type", "pageUrl"]);
      return { type, pageUrl: optionalText(fields.pageUrl, "pageUrl", MAX_URL) };
    case "run.artifact":
      only(fields, ["type", "runId", "name"]);
      return { type, runId: text(fields.runId, "runId", MAX_ID), name: artifactName(fields.name) };
    case "run.artifactChunk": {
      only(fields, ["type", "runId", "name", "offset"]);
      if (typeof fields.offset !== "number" || !Number.isInteger(fields.offset) || fields.offset < 0) throw invalid("offset must be a non-negative integer");
      return { type, runId: text(fields.runId, "runId", MAX_ID), name: artifactName(fields.name), offset: fields.offset };
    }
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
