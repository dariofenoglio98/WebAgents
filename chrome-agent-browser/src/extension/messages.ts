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
import { CoreError, thrownName } from "../core/errors.js";
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
import type { AuthorizationReceipt, BrowserPolicy, PolicyReference, PresetId, Reason, RunPlan, RunPlanPreflight } from "../core/types.js";
import type { AgentNoteView, ExportRequest, ImportPlanView, MemoryView, ReviewOutcome, ReviewView } from "./background/memory-controller.js";
import type { ImportFile } from "../core/memory/export.js";
import type { ReviewDecision } from "../core/memory/proposals.js";
import type { RecallCandidate } from "../core/memory/recall.js";
import type { MemoryRecord, UsageEntry } from "../core/memory/model.js";
import type { RecordDraft } from "../core/memory/store.js";
import type { ExportFile } from "../core/memory/export.js";
import type { MigrationReport } from "../core/memory/migration.js";
import type { PolicyBundle } from "../core/policies/bundle.js";
import type { AgentCandidate, ResolveQuery } from "../core/resolve/types.js";
import type { PlanOrigin } from "../core/origins.js";
import type { OllamaReport } from "../core/keychain.js";
import { MAX_PASSPHRASE_LENGTH, type SecretStoreState, type SecretStoreStatus } from "../core/secrets.js";
import type { LibraryEntry } from "./storage/subscriptions.js";
import type { FileView } from "./storage/files.js";
import type { GrantPurpose, GrantPurposeKind } from "./storage/permissions.js";
import type { Settings } from "./storage/settings.js";
import type { StoredObservation } from "./storage/runs.js";

export const MAX_URL = 2048;
export const MAX_ID = 200;
export const MAX_LINKS = 16;
/** Bound on a submitted decisions, approvals or picks object. */
export const MAX_DECISIONS = 256;
/** Bound on a submitted settings, provenance or vault record (JSON text). */
export const MAX_SUBMITTED_BYTES = 64 * 1024;
/** Bound on a search query (the core reads at most 200 characters of it). */
export const MAX_QUERY_TEXT = 512;

export type Request =
  | { type: "candidates.get"; tabId: number }
  | { type: "website.discover"; url: string }
  /** `foundVia`: the index (by id) whose search result the person opened, so its claims are compared with the bytes (T8). */
  | { type: "package.open"; url: string; advertisedOn?: string | null; viewId?: string | null; foundVia?: { indexId: string } | null }
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
      /** The permissions whose record the convenience preset chose (memory.v0 M-53): recorded as `preset` in the provenance. */
      presetSelections?: string[];
    }
  | { type: "authorization.useProfile"; sessionId: string; packageDigest: string; profileId: string; resourceSelections: Record<string, string>; prepare: boolean; presetSelections?: string[] }
  | { type: "models.evaluate"; sessionId: string; refresh: boolean }
  | { type: "models.probe"; provider: ProviderId }
  | { type: "runplan.prepare"; sessionId: string; packageDigest: string; receiptId: string; modelId: string }
  | { type: "runplan.get"; sessionId: string }
  | { type: "runplan.clear"; sessionId: string }
  | { type: "settings.get" }
  | { type: "settings.set"; settings: unknown }
  | { type: "settings.setKey"; provider: ProviderId; key: string | null }
  /** The Memory page and Settings → Memory (T19, memory.v0). Every write needs the unlocked store. */
  | { type: "memory.get" }
  | { type: "memory.reveal"; recordId: string; pointer: string }
  | { type: "memory.search"; query: string }
  | { type: "memory.create"; draft: unknown }
  | { type: "memory.edit"; recordId: string; changes: unknown }
  | { type: "memory.delete"; recordIds: string[] }
  | { type: "memory.link"; from: string; to: string; rel: string }
  | { type: "memory.unlink"; from: string; to: string; rel: string }
  | { type: "memory.installDemo" }
  | { type: "memory.removeDemo" }
  | { type: "memory.clearAgent"; packageId: string }
  | { type: "memory.forget"; confirmation: string }
  | { type: "memory.migrationDone" }
  | { type: "memory.export"; includeSealed: boolean; includeAgents: boolean; recordIds: string[] | null }
  | { type: "memory.importPlan"; files: ImportFile[] }
  | { type: "memory.importApply"; files: ImportFile[]; completions: Record<string, Record<string, string>> }
  /** The proposal review after a run (M-41, M-42): the sheet's facts, then the decisions together. */
  | { type: "memory.review"; runId: string }
  | { type: "memory.decide"; runId: string; decisions: ReviewDecision[] }
  // Settings → Files (T6, D-083): the person's picked PDFs; the bytes travel once, as base64.
  | { type: "files.list" }
  | { type: "files.add"; name: string; base64: string }
  | { type: "files.remove"; fileId: string }
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
  | { type: "host.finished"; runId: string }
  // -- search, indexes, policy subscription, Library (T8) ------------------------------------
  /** Free text or a locator against the enabled indexes (and the NANDA stub for a locator). */
  | { type: "search.query"; text: string }
  | { type: "indexes.list" }
  /** Add an index by URL with the key the person pins for it; it is fetched and verified at once. */
  | { type: "indexes.add"; url: string; publicKeyPem: string }
  | { type: "indexes.refresh"; url: string }
  | { type: "indexes.remove"; url: string }
  | { type: "indexes.enable"; url: string; enabled: boolean }
  | { type: "policy.get" }
  /** Subscribe to one policy bundle by URL, verified against the key the person pins; `replace` confirms replacing the current one (D-103). */
  | { type: "policy.subscribe"; url: string; publicKeyPem: string; replace: boolean }
  | { type: "policy.refresh" }
  | { type: "policy.unsubscribe" }
  | { type: "library.get" }
  | { type: "library.pin"; sessionId: string }
  | { type: "library.unpin"; packageUrl: string }
  | { type: "library.forget"; packageUrl: string }
  // The secret store (T16, D-191): the passphrase travels once, page → worker, and is never stored.
  | { type: "secrets.status" }
  | { type: "secrets.setup"; passphrase: string }
  | { type: "secrets.unlock"; passphrase: string }
  | { type: "secrets.lock" }
  | { type: "secrets.changePassphrase"; current: string; next: string }
  | { type: "secrets.forget"; confirmation: string }
  // Keychain unlock through the optional native helper (T17, D-204): the page asks Chrome for
  // `nativeMessaging` in the toggle's click; the worker talks to the helper.
  | { type: "secrets.unlockKeychain" }
  | { type: "keychain.status" }
  | { type: "keychain.enable" }
  | { type: "keychain.disable" }
  // Host permissions (T16, D-193): the page asks Chrome (the click is the gesture) and tells the worker what it obtained.
  | { type: "permissions.get" }
  | { type: "permissions.granted"; origins: string[]; purpose: GrantPurpose }
  | { type: "permissions.revoke"; origins: string[] }
  // Discovery on the clicked tab (D-190): inject the content script under activeTab or a granted origin.
  | { type: "discovery.readTab"; tabId: number };

/** The task input a view may submit: bounded as the reference host bounds it. */
export const MAX_INPUT_BYTES = 256 * 1024;
/** A picked file's bytes as base64: 20 MiB (the reader's limit) is 27,962,028 characters. */
export const MAX_FILE_BASE64 = 4 * Math.ceil((20 * 1024 * 1024) / 3);
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
  /** The memory changed: a record written or deleted, a review applied, the store locked or unlocked (T19). */
  | { type: "event.memory" }
  | { type: "event.files" }
  /** A run's record changed (started, progressed, settled, cleared); views re-read `run.get`. */
  | { type: "event.run"; runId: string; sessionId: string; status: string }
  | { type: "event.indexes" }
  | { type: "event.policy" }
  | { type: "event.library" }
  /** The secret store locked, unlocked, was set up or forgotten (T16). */
  | { type: "event.secrets" }
  /** An origin was granted or revoked (T16). */
  | { type: "event.permissions" };

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
  /** The index search result this session was opened from, with its claims compared with the bytes (T8). */
  found_via: FoundVia | null;
  /** Whether this package's URL is pinned in the Library. */
  pinned: boolean;
}

/** How an index's claims about a package compare with the bytes that were opened (metadata, never authority). */
export type ClaimCheck = "matches" | "differs" | "not_stated";

export interface FoundVia {
  index_id: string;
  label: string;
  version: string;
  position: number;
  claims: { digest: ClaimCheck; archive_sha256: ClaimCheck; signer_fingerprint: ClaimCheck; package_id: ClaimCheck; version: ClaimCheck };
}

// -- search, indexes, policy, Library (T8) ---------------------------------------------------
export interface SearchResultView {
  candidate: AgentCandidate;
  /** The trust store's (and the policy's) verdict on the signer the source *claims*: checked again when opened. */
  trust: { status: "trusted" | "unknown" | "mismatch"; reason: string };
}

export interface SearchView {
  query: ResolveQuery;
  results: SearchResultView[];
  notes: Array<{ source: string; code: string; detail: string | null }>;
  /** The indexes searched, with their versions; none when no index is enabled. */
  searched: Array<{ index_id: string; label: string; version: string }>;
  enabled_indexes: number;
}

export interface IndexView {
  url: string;
  key_fingerprint: string;
  enabled: boolean;
  added_at: string;
  fetched_at: string | null;
  /** `current`, `expired`, `not_yet_valid` for a verified copy; `unverified` when the stored copy no longer verifies; `never_fetched`. */
  state: "current" | "expired" | "not_yet_valid" | "unverified" | "never_fetched";
  index: { index_id: string; title: string; description: string | null; version: string; publisher: string; issued_at: string; expires_at: string; entries: number; notes: Array<{ code: string; detail: string | null }> } | null;
  signer_fingerprint: string | null;
  content_sha256: string | null;
  last_error: { code: string; message: string; at: string } | null;
  /** Why the stored copy does not verify (state `unverified`), else null. */
  unverified_reason: string | null;
}

export interface IndexesView {
  indexes: IndexView[];
  max_indexes: number;
  /** The NANDA resolver's state in this build (a stub; D-104). */
  nanda: { configured: false; note: string };
}

export type PolicyView =
  | { subscribed: false }
  | {
      subscribed: true;
      url: string;
      key_fingerprint: string;
      subscribed_at: string;
      fetched_at: string;
      /** Only a `current` policy applies; an expired one decides nothing and stales the plans made under it. */
      state: "current" | "expired" | "not_yet_valid" | "unverified";
      reference: PolicyReference | null;
      bundle: PolicyBundle | null;
      last_error: { code: string; message: string; at: string } | null;
    };

/** The policy in force, as the authorize view states it. */
export interface AuthorizationPolicyView {
  reference: PolicyReference;
  label: string;
  /** The run limits a run would get: the person's, lowered by the policy's caps. */
  limits_capped: string[];
  local_only: boolean;
  max_cost_usd_per_run: number | null;
  /** Whether the policy restricts which host implementations tools are approved for by default. */
  bindings_restricted: boolean;
}

export interface LibraryItemView extends LibraryEntry {
  /** The trust verdict on the signer as recorded when it was last opened, evaluated now. */
  trust_status: "trusted" | "unknown" | "mismatch";
  trust_reason: string;
  pinned: boolean;
  /** An open session of the same bytes from the same URL, when there is one. */
  open_session_id: string | null;
}

export interface LibraryView {
  pinned: LibraryItemView[];
  recent: LibraryItemView[];
}

// -- authorization results (T3) --------------------------------------------------------
/** One origin a plan needs, and whether Chrome grants it now (T16, D-193). */
export interface PlanOriginView extends PlanOrigin {
  granted: boolean;
}

export interface RunPlanState {
  run_plan: RunPlan;
  preflight: RunPlanPreflight;
  /** The origins this plan may reach, each with whether it is granted now; shown under Technical details. */
  origins: PlanOriginView[];
}

/**
 * The origins an authorization would need, per part, so a page can ask Chrome for exactly the set
 * its decisions imply before it sends them (the click is the gesture; D-193): the package's own
 * origin, each remote tool's origins (its endpoint and its declared fallback) by tool id, and
 * each hosted provider's endpoint by provider id (null for a provider with no origin).
 */
export interface AuthorizationOrigins {
  package: string | null;
  tools: Record<string, string[]>;
  providers: Record<string, string | null>;
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
  /** Resource types the package requests that the memory holds no type for. */
  missing_resource_types: string[];
  /** The recall card per `memory.read` (or alias) request (M-34, M-52): the candidates with their signals and the preset's mode. Empty while locked. */
  recall: RecallView[];
  tools: ToolOffer[];
  receipt: AuthorizationReceipt | null;
  run_plan: RunPlanState | null;
  default_model: string | null;
  /** The subscribed policy in force (T8), applied to `profiles[].decided` and `defaults`; null when none. */
  policy: AuthorizationPolicyView | null;
  /** The secret store's state (T16): while not unlocked, `resources` is evaluated against no registry and records cannot be chosen. */
  secrets: SecretStoreState;
  origins: AuthorizationOrigins;
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
  /** The subscribed policy's model constraints (T8), when one is in force. */
  model_policy: { label: string; title: string; local_only: boolean; max_cost_usd_per_run: number | null } | null;
}

export interface SettingsView {
  settings: Settings;
  /** Which hosted providers have a key; never the key. */
  keys: Record<string, boolean>;
}

/** Settings → Files: what this browser holds for runs to read, and the bounds (T6, D-083). */
export interface FilesView {
  files: FileView[];
  max_files: number;
  max_file_bytes: number;
  max_total_bytes: number;
}

/** The review sheet's view for one run: null `review` when the run offered nothing (M-41). */
export interface RunReviewView {
  run_id: string;
  package: { package_id: string; package_version: string; name: string | null };
  proposed_at: string | null;
  offered: number;
  count: number;
  reason: string | null;
  review: ReviewView | null;
  /** The decisions already applied for this run, when they were (the sheet does not reopen). */
  decided: { at: string; accepted: number; rejected: number } | null;
}

/** The recall card's facts per `memory.read` request (M-34), beside the registry's options. */
export interface RecallView {
  permission_id: string;
  resource_type: string;
  display_name: string | null;
  sealed: boolean;
  /** `ask`: nothing pre-selected; `propose`: the top candidate pre-selected, one click confirms; `auto`: auto-selected and shown in the summary (M-52). */
  mode: "ask" | "propose" | "auto";
  /** The type's sealed fields (for "Sealed details (e-mail) go only to …"). */
  sealed_fields: string[];
  candidates: Array<RecallCandidate & { last_use: { package_id: string; at: string; runs: number } | null; provenance: string }>;
}

export type { MemoryView, AgentNoteView, ExportRequest, ImportPlanView, ReviewOutcome, ReviewView, ReviewDecision, ImportFile, ExportFile, MemoryRecord, UsageEntry, RecordDraft, MigrationReport, RecallCandidate };

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
  /** The secret store's state (T16), for the lock chip. */
  secrets: SecretStoreState;
}

// -- the secret store and host permissions (T16) ------------------------------------------------
export interface SecretsView extends SecretStoreStatus {
  /** 0.1.0 left clear keys or records that wait for the first passphrase to be migrated. */
  migration_pending: boolean;
  /** What waits: which providers have a clear key, and how many records the clear vault holds. */
  legacy: { providers: string[]; records: number } | null;
  /** Keychain unlock is on (T17): a record from the helper is stored for this envelope. Read without asking the helper. */
  keychain_enabled: boolean;
}

/**
 * Settings → Security's keychain card (T17, D-204). `helper` is what asking the helper just now
 * found: `available` (it answered), `not_installed`, `refused` (it answered with a refusal, the
 * code in `problem`), `failed`, or `not_checked` while `nativeMessaging` is not granted.
 */
export interface KeychainView {
  permission: boolean;
  enabled: boolean;
  enabled_at: string | null;
  helper: "available" | "not_installed" | "refused" | "failed" | "not_checked";
  helper_version: string | null;
  problem: { code: string; message: string } | null;
  ollama: OllamaReport | null;
}

export interface PermissionOriginView {
  /** `https://host`, or `*` for the every-site grant. */
  origin: string;
  pattern: string;
  purposes: GrantPurpose[];
  recorded_at: string | null;
  /** Granted by Chrome now; a record Chrome no longer grants is listed as not granted until reconciled. */
  granted: boolean;
}

export interface PermissionsView {
  origins: PermissionOriginView[];
  /** "Detect agents on every site" (D-182): whether the every-site pattern is granted. */
  detect_everywhere: boolean;
  /** The origins the manifest holds without asking (Ollama on this machine). */
  manifest_hosts: string[];
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
  /** The plan's origins Chrome does not grant now (blocker `origins_not_granted`), for the Allow button. */
  missing_origins: string[];
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

/** A list of at most 8,192 ids. */
function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 8192) throw invalid(`${field} must be a list of at most 8192 ids`);
  return value.map((item, index) => text(item, `${field}[${index}]`, MAX_ID));
}

/** An import's files (memory.v0 §8): at most 8,192 paths of 512 bytes, texts of 1 MiB each. */
function importFiles(value: unknown): ImportFile[] {
  if (!Array.isArray(value) || value.length > 8192) throw invalid("files must be a list of at most 8192 files");
  return value.map((item, index) => {
    const fields = record(item);
    return { path: text(fields.path, `files[${index}].path`, 512), text: text(fields.text, `files[${index}].text`, 1024 * 1024) };
  });
}

/** Typed sealed values for an import's incomplete items: path → pointer → value. */
function completions(value: unknown): Record<string, Record<string, string>> {
  if (value === undefined || value === null) return {};
  const fields = record(value);
  const out: Record<string, Record<string, string>> = {};
  for (const [path, typed] of Object.entries(fields)) {
    const inner = record(typed);
    out[path] = {};
    for (const [pointer, item] of Object.entries(inner)) out[path][pointer] = text(item, `completions[${path}][${pointer}]`, 4096);
  }
  return out;
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

/** A bounded list of origins (`https://host`, or `*` for every site). */
function originList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw invalid("origins must be a list of 1 to 64 origins");
  return value.map((item, index) => text(item, `origins[${index}]`, MAX_URL));
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
    case "package.open": {
      only(fields, ["type", "url", "advertisedOn", "viewId", "foundVia"]);
      let foundVia: { indexId: string } | null = null;
      if (fields.foundVia !== undefined && fields.foundVia !== null) {
        const via = record(fields.foundVia);
        only(via, ["indexId"]);
        foundVia = { indexId: text(via.indexId, "foundVia.indexId", MAX_ID) };
      }
      return {
        type,
        url: text(fields.url, "url", MAX_URL),
        advertisedOn: optionalText(fields.advertisedOn, "advertisedOn", MAX_URL),
        viewId: optionalText(fields.viewId, "viewId", MAX_ID),
        foundVia,
      };
    }
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
      only(fields, ["type", "sessionId", "packageDigest", "decisions", "toolApprovals", "resourceSelections", "provenance", "prepare", "modelId", "presetSelections"]);
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
        ...(fields.presetSelections !== undefined ? { presetSelections: stringList(fields.presetSelections, "presetSelections") } : {}),
      };
    case "authorization.useProfile":
      only(fields, ["type", "sessionId", "packageDigest", "profileId", "resourceSelections", "prepare", "presetSelections"]);
      return {
        type,
        sessionId: text(fields.sessionId, "sessionId", MAX_ID),
        packageDigest: text(fields.packageDigest, "packageDigest", MAX_ID),
        profileId: text(fields.profileId, "profileId", MAX_ID),
        resourceSelections: stringMap(fields.resourceSelections, "resourceSelections"),
        prepare: fields.prepare === true,
        ...(fields.presetSelections !== undefined ? { presetSelections: stringList(fields.presetSelections, "presetSelections") } : {}),
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
    case "memory.get":
    case "memory.installDemo":
    case "memory.removeDemo":
    case "memory.migrationDone":
      only(fields, ["type"]);
      return { type };
    case "memory.reveal":
      only(fields, ["type", "recordId", "pointer"]);
      return { type, recordId: text(fields.recordId, "recordId", MAX_ID), pointer: text(fields.pointer, "pointer", 256) };
    case "memory.search":
      only(fields, ["type", "query"]);
      return { type, query: text(fields.query, "query", 512) };
    case "memory.create":
      only(fields, ["type", "draft"]);
      return { type, draft: bounded(fields.draft, "draft") };
    case "memory.edit":
      only(fields, ["type", "recordId", "changes"]);
      return { type, recordId: text(fields.recordId, "recordId", MAX_ID), changes: bounded(fields.changes, "changes") };
    case "memory.delete":
      only(fields, ["type", "recordIds"]);
      return { type, recordIds: stringList(fields.recordIds, "recordIds") };
    case "memory.link":
    case "memory.unlink":
      only(fields, ["type", "from", "to", "rel"]);
      return { type, from: text(fields.from, "from", MAX_ID), to: text(fields.to, "to", MAX_ID), rel: text(fields.rel, "rel", 32) };
    case "memory.clearAgent":
      only(fields, ["type", "packageId"]);
      return { type, packageId: text(fields.packageId, "packageId", 256) };
    case "memory.forget":
      only(fields, ["type", "confirmation"]);
      return { type, confirmation: text(fields.confirmation, "confirmation", 64) };
    case "memory.export":
      only(fields, ["type", "includeSealed", "includeAgents", "recordIds"]);
      return { type, includeSealed: fields.includeSealed === true, includeAgents: fields.includeAgents === true, recordIds: fields.recordIds === null || fields.recordIds === undefined ? null : stringList(fields.recordIds, "recordIds") };
    case "memory.importPlan":
      only(fields, ["type", "files"]);
      return { type, files: importFiles(fields.files) };
    case "memory.importApply":
      only(fields, ["type", "files", "completions"]);
      return { type, files: importFiles(fields.files), completions: completions(fields.completions) };
    case "memory.review":
      only(fields, ["type", "runId"]);
      return { type, runId: text(fields.runId, "runId", MAX_ID) };
    case "memory.decide":
      only(fields, ["type", "runId", "decisions"]);
      return { type, runId: text(fields.runId, "runId", MAX_ID), decisions: bounded(fields.decisions, "decisions") as unknown as ReviewDecision[] };
    case "settings.set":
      only(fields, ["type", "settings"]);
      return { type, settings: bounded(fields.settings, "settings") };
    case "settings.setKey":
      only(fields, ["type", "provider", "key"]);
      return { type, provider: provider(fields.provider), key: fields.key === null || fields.key === undefined ? null : text(fields.key, "key", 512) };
    case "files.list":
      only(fields, ["type"]);
      return { type };
    case "files.add": {
      only(fields, ["type", "name", "base64"]);
      if (typeof fields.base64 !== "string" || fields.base64.length > MAX_FILE_BASE64 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(fields.base64)) throw invalid(`base64 must be the file's bytes in base64, at most ${MAX_FILE_BASE64} characters`);
      return { type, name: text(fields.name, "name", 512), base64: fields.base64 };
    }
    case "files.remove":
      only(fields, ["type", "fileId"]);
      return { type, fileId: text(fields.fileId, "fileId", MAX_ID) };
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
    case "search.query":
      only(fields, ["type", "text"]);
      return { type, text: text(fields.text, "text", MAX_QUERY_TEXT) };
    case "indexes.list":
    case "policy.get":
    case "policy.refresh":
    case "policy.unsubscribe":
    case "library.get":
      only(fields, ["type"]);
      return { type };
    case "indexes.add":
      only(fields, ["type", "url", "publicKeyPem"]);
      return { type, url: text(fields.url, "url", MAX_URL), publicKeyPem: text(fields.publicKeyPem, "publicKeyPem", 16 * 1024) };
    case "indexes.refresh":
    case "indexes.remove":
      only(fields, ["type", "url"]);
      return { type, url: text(fields.url, "url", MAX_URL) };
    case "indexes.enable":
      only(fields, ["type", "url", "enabled"]);
      if (typeof fields.enabled !== "boolean") throw invalid("enabled must be a boolean");
      return { type, url: text(fields.url, "url", MAX_URL), enabled: fields.enabled };
    case "policy.subscribe":
      only(fields, ["type", "url", "publicKeyPem", "replace"]);
      return { type, url: text(fields.url, "url", MAX_URL), publicKeyPem: text(fields.publicKeyPem, "publicKeyPem", 16 * 1024), replace: fields.replace === true };
    case "library.pin":
      only(fields, ["type", "sessionId"]);
      return { type, sessionId: text(fields.sessionId, "sessionId", MAX_ID) };
    case "library.unpin":
    case "library.forget":
      only(fields, ["type", "packageUrl"]);
      return { type, packageUrl: text(fields.packageUrl, "packageUrl", MAX_URL) };
    case "secrets.status":
    case "secrets.lock":
    case "secrets.unlockKeychain":
    case "keychain.status":
    case "keychain.enable":
    case "keychain.disable":
    case "permissions.get":
      only(fields, ["type"]);
      return { type };
    case "secrets.setup":
    case "secrets.unlock":
      only(fields, ["type", "passphrase"]);
      return { type, passphrase: text(fields.passphrase, "passphrase", MAX_PASSPHRASE_LENGTH) };
    case "secrets.changePassphrase":
      only(fields, ["type", "current", "next"]);
      return { type, current: text(fields.current, "current", MAX_PASSPHRASE_LENGTH), next: text(fields.next, "next", MAX_PASSPHRASE_LENGTH) };
    case "secrets.forget":
      only(fields, ["type", "confirmation"]);
      return { type, confirmation: text(fields.confirmation, "confirmation", 64) };
    case "permissions.granted": {
      only(fields, ["type", "origins", "purpose"]);
      const purpose = record(fields.purpose);
      only(purpose, ["kind", "subject", "label"]);
      const kinds: readonly GrantPurposeKind[] = ["package", "provider", "site", "document", "everywhere"];
      if (!kinds.includes(purpose.kind as GrantPurposeKind)) throw invalid(`purpose.kind must be one of ${kinds.join(", ")}`);
      const label = optionalText(purpose.label, "purpose.label", 200);
      return { type, origins: originList(fields.origins), purpose: { kind: purpose.kind as GrantPurposeKind, subject: text(purpose.subject, "purpose.subject", MAX_URL), ...(label === null ? {} : { label }) } };
    }
    case "permissions.revoke":
      only(fields, ["type", "origins"]);
      return { type, origins: originList(fields.origins) };
    case "discovery.readTab": {
      only(fields, ["type", "tabId"]);
      if (typeof fields.tabId !== "number" || !Number.isInteger(fields.tabId) || fields.tabId < 0) throw invalid("tabId must be a tab id");
      return { type, tabId: fields.tabId };
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
  return { ok: false, error: { code: "internal_error", message: `The operation failed (${thrownName(error)}).` } };
}
