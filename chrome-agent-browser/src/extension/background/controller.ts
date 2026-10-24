/**
 * The service worker's logic, with every Chrome and network dependency injected so it can
 * be tested in Node (D-035). It owns candidates per tab, sessions and their snapshots, and
 * the trust store; the side panel and the full page are views over it.
 *
 * Opening a package follows the control plane's lifecycle: bytes are captured exactly once,
 * hashed, stored, and every later answer about the session derives from the stored bytes;
 * container, integrity, schema and runtime are reported as separate layers; signature
 * validity and publisher trust are separate facts; a trust change re-evaluates every open
 * session. Nothing here executes a package: starting a run is the `RunManager`'s decision and
 * the execution host's work (T5, D-070).
 */
import { agentPageModel } from "../../core/agent-page.js";
import { MAX_ARCHIVE_BYTES } from "../../core/archive.js";
import {
  blockingReasons,
  buildReceipt,
  buildRequest,
  defaultDecisions,
  normalizeDecisions,
  normalizeProvenance,
  normalizeToolApprovals,
  PRESETS,
  profileDecisions,
  type Decided,
} from "../../core/authorization.js";
import { evaluateCatalog, findModel, type HostCatalog } from "../../core/compatibility.js";
import { classifyLinks, DEFAULT_LIMITS, discoverFromPage, mediaType, type FetchedPage } from "../../core/discovery.js";
import { CoreError, thrownName } from "../../core/errors.js";
import { evaluateSnapshot, evaluationLayers, publisherReport, structurallyValid, type EvaluationLayers, type PublisherReport } from "../../core/evaluation.js";
import { isRecord } from "../../core/fields.js";
import { sha256Hex } from "../../core/hash.js";
import { evaluateResources, normalizeResourceSelections, RESOURCE_PERMISSION_KINDS, type ResourceRegistry } from "../../core/hostresources.js";
import { buildHostToolRegistry, evaluateRegistry, planToolBindings, type RegistryEvaluation, type ToolRegistry } from "../../core/hosttools.js";
import type { JsonObject, JsonValue } from "../../core/json.js";
import { publicKeyFromPem, publicKeyFromRawBase64, rawBase64, fingerprint as keyFingerprint } from "../../core/keys.js";
import { applyPolicy, cappedLimits, modelPolicyReasons, PolicyTrust, type ActivePolicy, type ToolBindingFacts } from "../../core/policies/apply.js";
import { heldPolicy, policyLabel, policyState, type HeldPolicy } from "../../core/policies/bundle.js";
import { NANDA_NOT_CONFIGURED, NandaResolver } from "../../core/resolve/nanda.js";
import { indexState, StaticIndexResolver, verifiedIndex, type VerifiedIndex } from "../../core/resolve/static-index.js";
import { readQuery, type AgentCandidate, type ResolveNote } from "../../core/resolve/types.js";
import { AGENT_INDEX_TYPE, MAX_DOCUMENT_BYTES, POLICY_BUNDLE_TYPE, verifySignedDocument, type DocumentContentType, type VerifiedDocument } from "../../core/signed-document.js";
import { compareRelease } from "../../core/version.js";
import { buildHostCatalog, DEFAULT_BASE_URLS, probeProvider, PROVIDER_IDS, type BuiltinAvailability, type Http, type ProbeResult, type ProviderId } from "../../core/models/catalog.js";
import { httpsOrigin, originPattern, planOrigins, patternOrigin, toolBindingsForOrigins, type OriginString, type PlanOrigin } from "../../core/origins.js";
import { SerialQueue } from "../../core/serial.js";
import { agentToolDigests, requestedResourceTypes } from "../../core/memory/declarations.js";
import { planNeedsMemory } from "./runs.js";
import { MemoryController, type MemoryView } from "./memory-controller.js";
import { MemoryMemoryStorage, type MemoryStorage } from "../storage/memory.js";
import { unavailableStoreError, type SecretStoreState } from "../../core/secrets.js";
import { HelperClient, KEYCHAIN_RECORD_SCHEMA, NativePortError, PERMANENT_HELPER_CODES, type KeychainRecord, type NativePort, type OllamaReport } from "../../core/keychain.js";
import { KeychainStorage } from "../storage/keychain-storage.js";
import type { Package } from "../../core/package.js";
import { documentUrl, origin, originText, sameOrigin, validatePackageUrl } from "../../core/policy.js";
import { readProfiles, type Profile } from "../../core/profiles.js";
import { buildRunPlan, grantsOnce, MODE_MODEL, modePermissionIds, preflight, preparationBlockers } from "../../core/runplan.js";
import { buildSummary, type BrowserSummary } from "../../core/summary.js";
import { pyRepr } from "../../core/repr.js";
import { pinPackagePublisher, type TrustStore } from "../../core/trust.js";
import { DEFAULT_BROWSER_POLICY, DENY, type AuthorizationReceipt, type Decision, type PresetId, type Provenance, type Reason, type RunPlan, type SourceRef } from "../../core/types.js";
import { CORE_VERSION, SUPPORTED_RUNTIME_VERSION } from "../../core/version.js";
import {
  type AuthorizationOrigins,
  type AuthorizationPolicyView,
  type AuthorizationView,
  type AuthorizeResult,
  type ClaimCheck,
  type FoundVia,
  type IndexesView,
  type IndexView,
  type LibraryItemView,
  type LibraryView,
  type PolicyView,
  type SearchResultView,
  type SearchView,
  type CandidateState,
  type ContentMessage,
  type Event,
  type FilesView,
  type ModelsView,
  type PermissionsView,
  type PinResult,
  type ProbeView,
  type Request,
  type RunPlanState,
  type RunView,
  type SecretsView,
  type KeychainView,
  type SessionDescriptor,
  type SessionSource,
  type SessionView,
  type SettingsView,
  type StatusInfo,
  type ToolOffer,
  type TrustList,
  type RecallView,
  type RunReviewView,
  type WebsiteResult,
} from "../messages.js";
import { FileRefusal, MemoryFileStore, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_FILE_BYTES, newFile, viewOf, type FileStore } from "../storage/files.js";
import { EVERY_SITE_PATTERN, MemoryPermissions, PermissionStorage, type GrantPurpose, type PermissionsPort } from "../storage/permissions.js";
import { connectionsFor, endpointProblem, MemoryStorageArea, normalizeSettings, settingsProblem, type Settings, type SettingsStorage } from "../storage/settings.js";
import type { SnapshotStore, StoredSession } from "../storage/snapshots.js";
import { MAX_INDEXES, MAX_PINNED, SubscriptionStorage, type LibraryEntry, type StoredIndex, type StoredPolicy } from "../storage/subscriptions.js";
import type { TabStateStore } from "../storage/tab-state.js";
import type { ViewHolder, ViewHolderStore } from "../storage/view-holders.js";
import type { RunStore } from "../storage/runs.js";
import { MemoryConversationStore, type ConversationStore } from "../storage/conversations.js";
import { ConversationManager } from "./conversations.js";
import { inputGatedReads } from "../../core/inputs.js";
import { isTerminal, RunManager, type ExecutionHostBridge, type RunHooks } from "./runs.js";

export interface Limits {
  sessionTtlSeconds: number;
  maxSessions: number;
  maxPackageBytes: number;
  maxCacheBytes: number;
  downloadTimeoutMs: number;
  discoveryTimeoutMs: number;
  maxHtmlBytes: number;
}

export const DEFAULT_CONTROLLER_LIMITS: Limits = Object.freeze({
  sessionTtlSeconds: 7200,
  maxSessions: 8,
  maxPackageBytes: MAX_ARCHIVE_BYTES,
  maxCacheBytes: 128 * 1024 * 1024,
  downloadTimeoutMs: 60_000,
  discoveryTimeoutMs: DEFAULT_LIMITS.timeoutSeconds * 1000,
  maxHtmlBytes: DEFAULT_LIMITS.maxHtmlBytes,
});

export type Fetch = (url: string, init: RequestInit) => Promise<globalThis.Response>;

export interface ControllerDeps {
  fetch: Fetch;
  snapshots: SnapshotStore;
  trust: TrustStore;
  tabs: TabStateStore;
  /** Settings, keys, the vault and the install id (`chrome.storage.local`, D-032/D-051). */
  settings: SettingsStorage;
  /** The memory's rows (IndexedDB in the extension, memory in tests; T19). */
  memoryStorage?: MemoryStorage;
  /** The model-catalog transport: the shell adds credential headers and performs the request (D-055). */
  http: Http;
  /** Chrome's built-in model availability, read by the shell (`LanguageModel.availability()`); null when unknown. */
  builtin: () => Promise<BuiltinAvailability | null>;
  /** Which views hold each session (`chrome.storage.session`, D-056 as amended). */
  holders: ViewHolderStore;
  /**
   * Which of these documents are still open (`chrome.runtime.getContexts`), so a view that went
   * away without releasing stops holding its session. Absent or failing: every holder counts.
   */
  liveDocuments?: (documentIds: string[]) => Promise<Set<string>>;
  badge: (tabId: number, count: number) => Promise<void>;
  broadcast: (event: Event) => void;
  clock?: () => Date;
  randomId?: () => string;
  limits?: Partial<Limits>;
  version?: string;
  /** Runs, their checkpoints and artifacts (IndexedDB, D-071). */
  runs: RunStore;
  /** conversation.v0 (T24): the conversations between turns; in memory when absent (tests, Node). */
  conversations?: ConversationStore;
  /** The PDFs the person picked in Settings → Files (IndexedDB, T6 D-083); memory when absent (tests). */
  files?: FileStore;
  /** Indexes, the policy subscription and the Library (`chrome.storage.local`, T8); memory when absent (tests). */
  subscriptions?: SubscriptionStorage;
  /** The execution host (an offscreen document in the extension; in-process in tests). */
  host: ExecutionHostBridge;
  runId?: () => string;
  /**
   * Whether something answers at a URL at all, without reading the answer (a `no-cors` fetch):
   * tells "Ollama is not running" apart from "Ollama rejects this extension's origin" (B-117).
   * Absent: the diagnosis is `unknown`.
   */
  reachable?: (url: string) => Promise<boolean>;
  /** Chrome's host permissions and the discovery script (T16, D-190, D-193); in tests a port over sets, granting every HTTPS origin unless told otherwise. */
  permissions?: PermissionsPort;
  /** Why each origin was granted (`chrome.storage.local`, T16); memory when absent (tests). */
  permissionStorage?: PermissionStorage;
  /** The optional native helper (T17, D-204): Chrome's native port; absent means not installed. */
  native?: NativePort;
  /** Whether `nativeMessaging` is granted; false when absent. */
  nativePermission?: () => Promise<boolean>;
  /** Keychain unlock's record beside the envelope (`chrome.storage.local`, T17); memory when absent (tests). */
  keychain?: KeychainStorage;
}

interface LiveSession {
  stored: StoredSession;
  pkg: Package;
  evaluation: EvaluationLayers;
  publisher: PublisherReport;
  summary: BrowserSummary;
  receipt: AuthorizationReceipt | null;
  plan: RunPlan | null;
  onceSpent: boolean;
  /** The index search result it was opened from (T8), with the index's claims compared with the bytes. */
  foundVia: FoundVia | null;
}

/** At most this many views hold one session; the oldest holder goes first. */
const MAX_VIEW_HOLDERS = 16;

/** How long a probed catalog is reused before the providers are asked again. */
const CATALOG_TTL_MS = 60_000;
/**
 * A view's refresh accepts a catalog read this recently: preparing a plan probes, and the views
 * reloading on its broadcast would otherwise ask every provider again at once (D-077, review 1).
 */
const CATALOG_FRESH_MS = 5_000;
/**
 * An enabled index older than this is fetched again when the person searches (T8). Nothing is
 * fetched in the background: only adding, refreshing or searching an enabled index fetches it.
 */
const INDEX_REFRESH_MS = 60 * 60_000;
/** A signed document (index, policy) must arrive within this. */
const DOCUMENT_TIMEOUT_MS = 30_000;
const TRUST_RANK: Readonly<Record<string, number>> = Object.freeze({ trusted: 0, unknown: 1, mismatch: 2 });

/** The sender facts the service worker vouches for; a page cannot forge them. */
export interface Sender {
  /** True for the extension's own pages. */
  extensionPage: boolean;
  /** The tab a content script runs in, when the sender is one. */
  tabId: number | null;
  /** The tab's URL as Chrome reports it, never as the page says. */
  tabUrl: string | null;
  /** The URL of the frame the message came from, as Chrome reports it. */
  frameUrl: string | null;
  /** Whether that frame is the tab's top frame. */
  topFrame: boolean;
  /** The sending document's id as Chrome reports it (`MessageSender.documentId`), when it does. */
  documentId?: string | null;
  /** True for the extension's own offscreen document (the execution host): the only sender of `host.*` reports. */
  offscreen?: boolean;
}

const EXECUTION_NOTE = "Opening and inspecting a package never executes it. A run starts only from the Run button, under a ready run plan.";

/** The origin as the WHATWG parser serializes it (IDNA-encoded host), or null for a non-URL. */
function whatwgOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash >= 0 ? url.slice(0, hash) : url;
}

function reject(code: string, message: string, status = 400, details: Record<string, unknown> | null = null): CoreError {
  return new CoreError(code, message, { status, details });
}

/** The session source as the receipt and plan record it (`SourceRef`): the same fields, as JSON. */
function sourceRef(source: SessionSource): SourceRef {
  return { kind: source.kind, display: source.display, advertised_on: source.advertised_on, opened_at: source.opened_at };
}

/** The memory types a package requests (memory.v0 M-33 and the `personal.read` alias): the resources of its `memory.read` and `personal.read` permissions. */
function requestedTypesOf(pkg: Package): string[] {
  return requestedResourceTypes(pkg.policy);
}

/** The host implementation each declared tool would be bound to, as a policy's binding allowlist judges it (T8). */
function bindingFacts(evaluation: RegistryEvaluation): Record<string, ToolBindingFacts | null> {
  const facts: Record<string, ToolBindingFacts | null> = {};
  for (const tool of evaluation.tools) facts[tool.tool_id] = tool.binding ? { kind: tool.binding.implementation_kind, origin: tool.binding.endpoint_origin } : null;
  return facts;
}

const claimCheck = (claimed: string | null, actual: string | null): ClaimCheck => (claimed === null ? "not_stated" : claimed === actual ? "matches" : "differs");


/** How long a newly opened session is kept from `endUnshownSessions` while its view's hold lands (T10). */
export const SESSION_HOLD_GRACE_MS = 10_000;
export class Controller {
  private readonly sessions = new Map<string, LiveSession>();
  /** Serializes the read-modify-write of view holders in `chrome.storage.session`. */
  private holderQueue: Promise<unknown> = Promise.resolve();
  /** Archive hashes of opens in progress (review 2, nit 6): their snapshots are never dropped as orphans. */
  private readonly inFlight = new Map<string, number>();
  private readonly limits: Limits;
  private readonly clock: () => Date;
  private readonly randomId: () => string;
  private readonly version: string;
  private restored: Promise<void> | null = null;
  private readonly files: FileStore;
  private readonly subscriptions: SubscriptionStorage;
  /** The person's trust store, then the subscribed policy's anchors (T8, D-101). */
  private readonly trust: PolicyTrust;
  /** Verified documents by type, key and text: re-verification is skipped only for identical bytes. */
  private readonly verifiedDocuments = new Map<string, VerifiedDocument>();
  /** The last subscribed policy read (`heldPolicyOf`), by its stored text and pinned key. */
  private heldPolicyCache: { text: string; key: string; held: HeldPolicy } | null = null;
  private readonly permissions: PermissionsPort;
  private readonly grants: PermissionStorage;
  /** An empty resource registry: what authorization sees while the store is locked (no record can be chosen). */
  /** The native helper's client and keychain unlock's record (T17). */
  private readonly helper: HelperClient;
  private readonly keychain: KeychainStorage;
  private readonly nativePermission: () => Promise<boolean>;
  /** Enable, disable and unlock with the keychain, one at a time. */
  private readonly keychainWork = new SerialQueue();
  /** One review decided at a time (finding 2): the check of `memory_review` and the acceptance never interleave. */
  private readonly reviewWork = new SerialQueue();
  /**
   * What the helper last answered to `ollama.status`, in this worker's memory: Turn on and Turn off
   * show it instead of starting the helper once more in the same click (T17 review 1, nit 7).
   * Forgotten whenever the helper fails; Check again always asks.
   */
  private helperSeen: { helper_version: string | null; ollama: OllamaReport } | null = null;

  /** Runs from the browser (T5): decides whether a run starts; the host executes. */
  readonly runs: RunManager;
  /** conversation.v0 (T24): conversations between turns (D-270). */
  readonly conversations: ConversationManager;
  private readonly conversationStore: ConversationStore;

  constructor(private readonly deps: ControllerDeps) {
    this.limits = { ...DEFAULT_CONTROLLER_LIMITS, ...(deps.limits ?? {}) };
    this.clock = deps.clock ?? (() => new Date());
    this.randomId = deps.randomId ?? (() => crypto.randomUUID().replace(/-/gu, "").slice(0, 24));
    this.version = deps.version ?? CORE_VERSION;
    this.files = deps.files ?? new MemoryFileStore();
    this.subscriptions = deps.subscriptions ?? new SubscriptionStorage(new MemoryStorageArea());
    this.trust = new PolicyTrust(deps.trust, () => this.activePolicy());
    this.permissions = deps.permissions ?? new MemoryPermissions([EVERY_SITE_PATTERN]);
    this.grants = deps.permissionStorage ?? new PermissionStorage(new MemoryStorageArea());
    this.helper = new HelperClient(
      deps.native ?? {
        send: () => Promise.reject(new NativePortError("not_installed", "no native port")),
      },
    );
    this.keychain = deps.keychain ?? new KeychainStorage(new MemoryStorageArea());
    this.nativePermission = deps.nativePermission ?? (() => Promise.resolve(false));
    this.memory = new MemoryController({
      settings: deps.settings,
      storage: deps.memoryStorage ?? new MemoryMemoryStorage(),
      secretsState: () => this.secretsState(),
      broadcast: () => deps.broadcast({ type: "event.memory" }),
      clock: this.clock,
      version: this.version,
    });
    const hooks: RunHooks = {
      session: async (sessionId) => {
        const live = await this.session(sessionId);
        return { stored: live.stored, pkg: live.pkg, plan: live.plan, onceSpent: live.onceSpent };
      },
      isSessionOpen: (sessionId) => this.sessions.has(sessionId),
      preflight: async (sessionId, options) => (await this.runPlanState(await this.session(sessionId), options)).preflight,
      toolRegistry: async (sessionId) => this.toolRegistry(await this.session(sessionId)),
      memory: () => this.memory,
      catalog: async () => (await this.currentCatalog()).catalog,
      snapshotBytes: async (archiveSha256) => (await this.deps.snapshots.getSnapshot(archiveSha256))?.bytes ?? null,
      markOnceSpent: (sessionId) => this.markOnceSpent(sessionId),
      file: async (fileId) => {
        const file = await this.files.get(fileId);
        return file === null ? null : viewOf(file);
      },
      // The run that kept a closed session's snapshot alive has settled: drop the bytes if nothing else refers to them.
      runSettled: (archiveSha256) => this.dropUnreferencedSnapshot(archiveSha256),
      // The subscribed policy's budget caps lower the person's run limits (T8, D-102).
      limitCaps: async () => (await this.activePolicy())?.bundle.budget_caps ?? null,
      // memory.v0 M-50, M-54: what the preset and the policy decide for the agent document and the proposals.
      memoryRules: async () => {
        const policy = await this.activePolicy();
        const preset = (await this.deps.settings.settings()).preset;
        return { preset, agent: policy?.bundle.memory?.agent ?? "allow", proposals: policy?.bundle.memory?.proposals ?? "ask" };
      },
      planOrigins: async (sessionId) => {
        const live = await this.session(sessionId);
        return live.plan === null ? [] : this.originsOfPlan(live, live.plan);
      },
      missingOrigins: (origins) => this.missingOrigins(origins),
      secretsState: async () => (await this.deps.settings.store.status()).state,
    };
    this.runs = new RunManager({ runs: deps.runs, host: deps.host, settings: deps.settings, hooks, broadcast: deps.broadcast, clock: this.clock, randomId: deps.runId, runtimeVersion: this.version });
    // conversation.v0 (T24, D-270): conversations over the same runs, the same host and the same hooks.
    this.conversationStore = deps.conversations ?? new MemoryConversationStore();
    this.conversations = new ConversationManager({
      conversations: this.conversationStore,
      runs: deps.runs,
      runner: this.runs,
      host: deps.host,
      hooks: {
        session: async (sessionId) => {
          const live = await this.session(sessionId);
          return { pkg: live.pkg, plan: live.plan, archiveSha256: live.stored.archive_sha256 };
        },
        isSessionOpen: (sessionId) => this.sessions.has(sessionId),
        snapshotBytes: async (archiveSha256) => (await this.deps.snapshots.getSnapshot(archiveSha256))?.bytes ?? null,
        turnCharged: (archiveSha256) => this.dropUnreferencedSnapshot(archiveSha256),
      },
      broadcast: deps.broadcast,
      clock: this.clock,
    });
    this.runs.onTurnSettled = (run) => this.conversations.turnSettled(run);
  }

  // -- requests from extension pages ----------------------------------------------
  async handle(request: Request, sender: Sender): Promise<unknown> {
    if (!sender.extensionPage) throw reject("not_allowed", "Only the extension's own pages may send requests", 403);
    await this.restore();
    switch (request.type) {
      case "candidates.get":
        return this.deps.tabs.get(request.tabId);
      case "website.discover":
        return this.discoverWebsite(request.url);
      case "package.open": {
        const view = await this.openUrl(request.url, request.advertisedOn ?? null, request.foundVia?.indexId ?? null);
        if (request.viewId) await this.hold(view.session.id, request.viewId, sender.documentId ?? null);
        return view;
      }
      case "package.get": {
        const live = await this.session(request.sessionId);
        if (request.viewId) await this.hold(request.sessionId, request.viewId, sender.documentId ?? null);
        return this.view(live);
      }
      case "package.release":
        return this.release(request.sessionId, request.viewId);
      case "package.close":
        return this.close(request.sessionId);
      case "sessions.list":
        return this.listSessions();
      case "trust.list":
        return this.trustList();
      case "trust.pin":
        return this.pinSession(request.sessionId, request.signerFingerprint, request.scope);
      case "trust.pinKey":
        return this.pinKey(request.publicKeyPem, request.displayName, request.publisherId ?? null, request.packageIdPrefix ?? null);
      case "trust.unpin":
        return this.unpin(request.fingerprint);
      case "status.get":
        return this.status();
      case "authorization.get":
        return this.authorizationView(await this.session(request.sessionId));
      case "authorization.authorize":
        return this.authorize(request.sessionId, request);
      case "authorization.useProfile":
        return this.useProfile(request.sessionId, request);
      case "models.evaluate":
        return this.evaluateModels(request.sessionId, request.refresh);
      case "models.probe":
        return this.probe(request.provider);
      case "runplan.prepare":
        return this.prepareRunPlan(request.sessionId, request);
      case "runplan.get":
        return this.runPlanState(await this.session(request.sessionId));
      case "runplan.clear":
        return this.clearRunPlan(request.sessionId);
      case "settings.get":
        return this.settingsView();
      case "settings.set":
        return this.setSettings(request.settings);
      case "settings.setKey":
        return this.setKey(request.provider, request.key);
      case "memory.get":
        return this.memory.view();
      case "memory.reveal":
        return this.memory.reveal(request.recordId, request.pointer);
      case "memory.search":
        return this.memory.search(request.query);
      case "memory.create":
        return this.memory.create(request.draft as never);
      case "memory.edit":
        return this.memory.edit(request.recordId, request.changes as never);
      case "memory.delete":
        return this.memory.delete(request.recordIds);
      case "memory.link":
        return this.memory.link(request.from, request.to, request.rel);
      case "memory.unlink":
        return this.memory.unlink(request.from, request.to, request.rel);
      case "memory.installDemo":
        return this.memory.installDemo();
      case "memory.removeDemo":
        return this.memory.removeDemo();
      case "memory.clearAgent":
        return this.memory.clearAgent(request.packageId);
      case "memory.agentNote":
        return this.memory.agentNote(request.packageId);
      case "memory.forget":
        if (request.confirmation !== "forget") throw reject("confirmation_required", "Type forget to delete every record, note and position.", 400);
        return this.memory.forget();
      case "memory.migrationDone":
        return this.memory.migrationDone();
      case "memory.export":
        return this.memory.export({ includeSealed: request.includeSealed, includeAgents: request.includeAgents, recordIds: request.recordIds });
      case "memory.importPlan":
        return this.memory.importPlan(request.files);
      case "memory.importApply":
        return this.memory.importApply(request.files, request.completions);
      case "memory.review":
        return this.runReview(request.runId);
      case "memory.decide":
        return this.runDecide(request.runId, request.decisions);
      case "files.list":
        return this.filesView();
      case "files.add":
        return this.addFile(request.name, request.base64);
      case "files.remove":
        return this.removeFile(request.fileId);
      case "run.readiness":
        return this.runs.readiness(request.sessionId);
      case "run.validateInput":
        return this.runs.validateInput(request.sessionId, request.input);
      case "run.start":
        return this.runs.start(request.sessionId, { runPlanId: request.runPlanId, runPlanSha256: request.runPlanSha256, input: request.input });
      case "run.get":
        return this.runs.get(request.runId);
      case "run.list":
        return this.runs.list(request.sessionId ?? null);
      case "run.active":
        return this.activeRun(request.pageUrl ?? null);
      case "run.cancel":
        return this.runs.cancel(request.runId);
      case "run.artifact":
        return this.runs.artifact(request.runId, request.name);
      case "run.artifactChunk":
        return this.runs.artifactChunk(request.runId, request.name, request.offset);
      case "run.export":
        return this.runs.exportBundle(request.runId);
      case "run.clear":
        return this.runs.clear(request.runId);
      case "run.observations":
        return this.runs.observations(request.runId);
      case "conversation.start":
        return this.conversations.start(request.sessionId, { runPlanId: request.runPlanId, runPlanSha256: request.runPlanSha256 });
      case "conversation.send":
        return this.conversations.send(request.conversationId, request.message);
      case "conversation.decide":
        return this.conversations.decide(request.conversationId, request.step, request.accepted);
      case "conversation.end":
        return this.conversations.endByPerson(request.conversationId);
      case "conversation.cancelTurn":
        return this.conversations.cancelTurn(request.conversationId);
      case "conversation.get":
        return this.conversations.get(request.conversationId);
      case "conversation.list":
        return this.conversations.list(request.sessionId ?? null);
      case "conversation.export":
        return this.conversations.exportBundle(request.conversationId);
      case "conversation.clear":
        return this.conversations.clear(request.conversationId);
      case "host.progress":
      case "host.finished":
        // Only the execution host reports on runs; a view cannot forge a host report.
        if (!sender.offscreen) throw reject("not_allowed", "Only the execution host may report on runs", 403);
        return request.type === "host.progress" ? this.runs.hostProgress(request.runId) : this.runs.hostFinished(request.runId);
      case "search.query":
        return this.search(request.text);
      case "indexes.list":
        return this.indexesView();
      case "indexes.add":
        return this.addIndex(request.url, request.publicKeyPem);
      case "indexes.refresh":
        return this.refreshIndex(request.url);
      case "indexes.remove":
        return this.removeIndex(request.url);
      case "indexes.enable":
        return this.enableIndex(request.url, request.enabled);
      case "policy.get":
        return this.policyView();
      case "policy.subscribe":
        return this.subscribePolicy(request.url, request.publicKeyPem, request.replace);
      case "policy.refresh":
        return this.refreshPolicy();
      case "policy.unsubscribe":
        return this.unsubscribePolicy();
      case "library.get":
        return this.libraryView();
      case "library.pin":
        return this.pinToLibrary(request.sessionId);
      case "library.unpin":
        return this.unpinFromLibrary(request.packageUrl);
      case "library.forget":
        return this.forgetRecent(request.packageUrl);
      case "secrets.status":
        return this.secretsView();
      case "secrets.setup":
        return this.setupPassphrase(request.passphrase);
      case "secrets.unlock":
        return this.unlockSecrets(request.passphrase);
      case "secrets.lock":
        return this.lockSecrets();
      case "secrets.changePassphrase":
        return this.changePassphrase(request.current, request.next);
      case "secrets.forget":
        return this.forgetSecrets(request.confirmation);
      case "secrets.unlockKeychain":
        return this.unlockWithKeychain();
      case "keychain.status":
        return this.keychainView();
      case "keychain.enable":
        return this.enableKeychain();
      case "keychain.disable":
        return this.disableKeychain();
      case "permissions.get":
        return this.permissionsView();
      case "permissions.granted":
        return this.recordGrant(request.origins, request.purpose);
      case "permissions.revoke":
        return this.revokeOrigins(request.origins);
      case "discovery.readTab":
        return this.readTab(request.tabId);
    }
  }

  // -- host permissions (T16, D-190, D-193) ---------------------------------------------------
  /**
   * Refuse, by name, a fetch to an origin Chrome does not grant (D-193): the page asked Chrome
   * before sending (the click was the gesture) and offers Allow on this code. Chrome would refuse
   * the request anyway; this says why, before any byte moves.
   */
  private async requireOrigin(url: string): Promise<void> {
    const origin = httpsOrigin(url);
    if (origin === null) return; // the URL gate says what is wrong with it
    if (await this.permissions.contains([originPattern(origin)])) return;
    throw reject("origin_not_granted", `This browser is not allowed to reach ${origin}. Allow it to continue.`, 403, { origins: [origin] });
  }

  /** Which of these origins Chrome does not grant now. */
  private async missingOrigins(origins: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const origin of origins) if (!(await this.permissions.contains([originPattern(origin)]))) missing.push(origin);
    return missing;
  }

  /** The host's endpoint for a provider: the connection's base URL, else the provider's default; null when it has none. */
  private providerOrigin(settings: Settings, providerId: string): string | null {
    if (providerId === "chrome-builtin" || !(PROVIDER_IDS as readonly string[]).includes(providerId)) return null;
    const connection = settings.models.connections.find((item) => item.provider === providerId);
    return connection?.base_url ?? DEFAULT_BASE_URLS[providerId as Exclude<ProviderId, "chrome-builtin">];
  }

  /** The origins a prepared plan needs (D-193): a pure function of the plan, the registry's fallbacks and the provider settings. */
  private async originsOfPlan(live: LiveSession, plan: RunPlan): Promise<PlanOrigin[]> {
    const settings = await this.deps.settings.settings();
    const registry = await this.toolRegistry(live);
    const bindings = toolBindingsForOrigins(plan.tool_bindings as unknown as Parameters<typeof toolBindingsForOrigins>[0], registry);
    const model = plan.model_binding === null ? null : { provider_id: plan.model_binding.provider_id, base_url: this.providerOrigin(settings, plan.model_binding.provider_id) };
    return planOrigins({ packageUrl: live.stored.source.display, toolBindings: bindings, model });
  }

  /** The origins an authorization could need, per part, for the page's request before it sends (D-193). */
  private async authorizationOrigins(live: LiveSession, evaluation: RegistryEvaluation): Promise<AuthorizationOrigins> {
    const settings = await this.deps.settings.settings();
    const registry = await this.toolRegistry(live);
    const tools: Record<string, string[]> = {};
    for (const binding of planToolBindings(evaluation)) {
      const [entry] = toolBindingsForOrigins([binding], registry);
      const origins = planOrigins({ packageUrl: null, toolBindings: [{ ...entry!, approved: true }], model: null }).map((item) => item.origin);
      if (origins.length > 0) tools[binding.tool_id] = origins;
    }
    const providers: Record<string, string | null> = {};
    for (const provider of PROVIDER_IDS) providers[provider] = planOrigins({ packageUrl: null, toolBindings: [], model: { provider_id: provider, base_url: this.providerOrigin(settings, provider) } })[0]?.origin ?? null;
    return { package: httpsOrigin(live.stored.source.display), tools, providers };
  }

  /** Note why a plan's origins are granted: for this package, and for its provider. */
  private recordPlanOrigins(live: LiveSession, plan: RunPlan, origins: readonly PlanOrigin[]): Promise<void> {
    // In the permission queue with the other writers (T16 review 2, nit 1).
    return this.permissionWork.run(async () => {
      const now = this.clock();
      for (const item of origins) {
        if (item.roles.includes("package") || item.roles.includes("tool")) await this.grants.record(item.origin, { kind: "package", subject: plan.package.package_id, label: plan.package.name }, now);
        if (item.roles.includes("provider") && plan.model_binding) await this.grants.record(item.origin, { kind: "provider", subject: plan.model_binding.provider_id }, now);
      }
      void live;
    });
  }

  async permissionsView(): Promise<PermissionsView> {
    const granted = await this.permissions.granted();
    const records = await this.grants.all();
    const everywhere = granted.includes(EVERY_SITE_PATTERN);
    const origins: PermissionsView["origins"] = [];
    const seen = new Set<string>();
    for (const record of records) {
      const pattern = record.origin === "*" ? EVERY_SITE_PATTERN : originPattern(record.origin);
      seen.add(pattern);
      origins.push({ origin: record.origin, pattern, purposes: record.purposes, recorded_at: record.recorded_at, granted: record.origin === "*" ? everywhere : granted.includes(pattern) || everywhere });
    }
    // Grants Chrome holds that this extension never recorded (an older build, chrome://extensions): listed, so they can be revoked.
    for (const pattern of granted) {
      if (seen.has(pattern)) continue;
      const origin = pattern === EVERY_SITE_PATTERN ? "*" : patternOrigin(pattern);
      if (origin === null) continue;
      origins.push({ origin, pattern, purposes: [], recorded_at: null, granted: true });
    }
    origins.sort((a, b) => (a.origin === "*" ? -1 : b.origin === "*" ? 1 : a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
    return { origins, detect_everywhere: everywhere, manifest_hosts: ["http://127.0.0.1", "http://localhost"] };
  }

  /** The page obtained a grant from Chrome: verify it, record why, and give granted sites the discovery script. */
  recordGrant(origins: readonly string[], purpose: GrantPurpose): Promise<PermissionsView> {
    return this.permissionWork.run(() => this.recordGrantNow(origins, purpose));
  }

  private async recordGrantNow(origins: readonly string[], purpose: GrantPurpose): Promise<PermissionsView> {
    const now = this.clock();
    for (const raw of origins) {
      if (purpose.kind === "everywhere" || raw === "*") {
        if (!(await this.permissions.contains([EVERY_SITE_PATTERN]))) throw reject("origin_not_granted", "Chrome did not grant access to every site.", 403, { origins: [EVERY_SITE_PATTERN] });
        await this.grants.record("*", { kind: "everywhere", subject: "everywhere" }, now);
        continue;
      }
      const origin = httpsOrigin(raw);
      if (origin === null) throw reject("invalid_request", `${raw} is not an HTTPS origin`);
      if (!(await this.permissions.contains([originPattern(origin)]))) throw reject("origin_not_granted", `Chrome did not grant access to ${origin}.`, 403, { origins: [origin] });
      await this.grants.record(origin, purpose, now);
    }
    await this.syncDiscovery();
    this.deps.broadcast({ type: "event.permissions" });
    return this.permissionsView();
  }

  /**
   * Revoke origins (`*` for every site): Chrome forgets them, the records go, prepared plans that
   * need them block Run by name. While "Detect agents on every site" is on, revoking one origin
   * would change nothing Chrome does (review 1, finding 5): refused by name, and the record stays,
   * so the page never reports a revocation that did not happen.
   */
  revokeOrigins(origins: readonly string[]): Promise<PermissionsView> {
    return this.permissionWork.run(() => this.revokeOriginsNow(origins));
  }

  private async revokeOriginsNow(origins: readonly string[]): Promise<PermissionsView> {
    const patterns: string[] = [];
    const named: Array<OriginString | "*"> = [];
    for (const raw of origins) {
      if (raw === "*") {
        patterns.push(EVERY_SITE_PATTERN);
        named.push("*");
        continue;
      }
      const origin = httpsOrigin(raw);
      if (origin === null) throw reject("invalid_request", `${raw} is not an HTTPS origin`);
      patterns.push(originPattern(origin));
      named.push(origin);
    }
    if (!named.includes("*") && (await this.permissions.contains([EVERY_SITE_PATTERN]))) {
      throw reject("origin_covered_everywhere", `Every site is granted, so revoking ${named.join(", ")} would change nothing: turn off "Detect agents on every site" first.`, 409, { origins: named });
    }
    if (!(await this.permissions.remove(patterns))) throw reject("revoke_failed", `Chrome did not remove ${named.join(", ")}.`, 500, { origins: named });
    for (const origin of named) await this.grants.forget(origin);
    await this.syncDiscovery();
    this.deps.broadcast({ type: "event.permissions" });
    this.deps.broadcast({ type: "event.sessions" });
    return this.permissionsView();
  }

  /** Chrome removed grants (chrome://extensions, `permissions.onRemoved`), or the worker started: the records and the discovery script follow Chrome. */
  reconcilePermissions(): Promise<void> {
    return this.permissionWork.run(async () => {
      await this.grants.reconcile(await this.permissions.granted());
      await this.syncDiscovery();
      this.deps.broadcast({ type: "event.permissions" });
    });
  }

  /** The discovery content script runs exactly where the person asked for detection (D-190): the sites they chose, or everywhere. */
  private async syncDiscovery(): Promise<void> {
    const granted = new Set(await this.permissions.granted());
    const matches = new Set<string>();
    for (const record of await this.grants.all()) {
      if (record.origin === "*" && granted.has(EVERY_SITE_PATTERN)) matches.add(EVERY_SITE_PATTERN);
      else if (record.origin !== "*" && record.purposes.some((purpose) => purpose.kind === "site") && granted.has(originPattern(record.origin))) matches.add(originPattern(record.origin));
    }
    await this.permissions.registerDiscovery([...matches].sort());
  }

  /** Read the clicked tab's advertised links now (D-190): the content script is injected under `activeTab` or a granted origin, and reports as usual. */
  async readTab(tabId: number): Promise<{ injected: true }> {
    try {
      await this.permissions.inject(tabId);
    } catch (error) {
      throw reject("tab_not_readable", `This browser may not read this page: ${thrownName(error) === "Error" ? "click the WebAgents button on it, or allow the site under Settings → Permissions" : thrownName(error)}.`, 403);
    }
    return { injected: true };
  }

  // -- the secret store (T16, D-191, D-192) -------------------------------------------------------
  async secretsView(): Promise<SecretsView> {
    const status = await this.deps.settings.store.status();
    const legacy = status.state === "no_passphrase" ? await this.deps.settings.legacySecrets() : null;
    return {
      ...status,
      migration_pending: legacy !== null && (Object.keys(legacy.provider_keys).length > 0 || legacy.vault !== null),
      legacy: legacy === null ? null : { providers: Object.keys(legacy.provider_keys).sort(), records: legacy.vault?.records.length ?? 0 },
      keychain_enabled: keychainFor(await this.keychain.load(), status.created_at) !== null,
    };
  }

  private secretsChanged(): void {
    // A memory opened before this change is never saved after it (T16 review 2, nit 3): the memory
    // controller compares the generation it was opened in.
    this.memory.invalidate();
    this.invalidateCatalog();
    this.deps.broadcast({ type: "event.secrets" });
    this.deps.broadcast({ type: "event.settings" });
    this.deps.broadcast({ type: "event.memory" });
    // Commits a locked store kept waiting (an agent document, usage entries) are applied now that it may be unlocked.
    void this.runs.applyPendingMemory().catch(() => undefined);
  }

  async setupPassphrase(passphrase: string): Promise<SecretsView> {
    await this.deps.settings.setPassphrase(passphrase);
    await this.keychainWork.run(() => this.keychain.clear()); // a record left from a forgotten store belongs to no envelope; queued like every other record writer (T17 review 2, nit 8)
    this.secretsChanged();
    return this.secretsView();
  }

  async unlockSecrets(passphrase: string): Promise<SecretsView> {
    await this.deps.settings.store.unlock(passphrase);
    this.secretsChanged();
    return this.secretsView();
  }

  async lockSecrets(): Promise<SecretsView> {
    await this.deps.settings.store.lock();
    this.secretsChanged();
    return this.secretsView();
  }

  /**
   * The minute alarm's sweep (D-192): the idle lock applied by the secret store and, when it
   * locked now, every cache dropped and every page told, exactly as for Lock now (T17 review 2,
   * nit 2; T19 review 1, finding 1). The memory controller also reads the state on every open,
   * so the store's own lazy lock (a status read past the idle time) is covered without an event.
   */
  async lockIfIdle(): Promise<boolean> {
    const locked = await this.deps.settings.store.lockIfIdle();
    if (locked) this.secretsChanged();
    return locked;
  }

  async changePassphrase(current: string, next: string): Promise<SecretsView> {
    await this.deps.settings.store.changePassphrase(current, next);
    this.secretsChanged();
    return this.secretsView();
  }

  /** Delete the envelope: every key and record is gone. The person types `forget` to confirm. */
  async forgetSecrets(confirmation: string): Promise<SecretsView> {
    if (confirmation.trim().toLowerCase() !== "forget") throw reject("confirmation_mismatch", "Type forget to delete every key and record.", 400);
    await this.deps.settings.store.forget();
    await this.keychainWork.run(() => this.keychain.clear());
    this.secretsChanged();
    this.deps.broadcast({ type: "event.sessions" });
    return this.secretsView();
  }

  // -- keychain unlock through the native helper (T17, D-204) -------------------------------------
  /**
   * Settings → Security's keychain card: the permission, the record, and what the helper says now
   * (or, with `reuse`, what it said last in this worker, when it said anything).
   */
  async keychainView(reuse = false): Promise<KeychainView> {
    const permission = await this.nativePermission();
    const record = keychainFor(await this.keychain.load(), (await this.deps.settings.store.status()).created_at);
    const base: KeychainView = { permission, enabled: record !== null, enabled_at: record?.enabled_at ?? null, helper: "not_checked", helper_version: null, problem: null, ollama: null };
    if (!permission) return base;
    if (reuse && this.helperSeen !== null) return { ...base, helper: "available", ...this.helperSeen };
    try {
      const status = await this.helper.status();
      this.helperSeen = { helper_version: status.helper, ollama: status.ollama };
      return { ...base, helper: "available", helper_version: status.helper, ollama: status.ollama };
    } catch (error) {
      this.helperSeen = null;
      const described = helperProblem(error);
      return { ...base, helper: described.state, problem: { code: described.code, message: described.message } };
    }
  }

  /**
   * Turn keychain unlock on: the store must be unlocked; the helper wraps the master key, and the
   * blob is unwrapped once at once, so "on" means the round trip works on this Mac.
   */
  enableKeychain(): Promise<KeychainView> {
    return this.keychainWork.run(async () => {
      if (!(await this.nativePermission())) throw reject("native_permission_missing", "Chrome has not granted the permission to talk to the WebAgents helper.", 403);
      const material = await this.deps.settings.store.keychainMaterial();
      try {
        const blob = await this.helper.wrap(material.key);
        const back = await this.helper.unwrap(blob);
        const same = back.length === material.key.length && back.every((byte, index) => byte === material.key[index]);
        back.fill(0);
        if (!same) throw reject("helper_failed", "The WebAgents helper did not return the key it wrapped; keychain unlock stays off.", 502);
        await this.keychain.save({ schema: KEYCHAIN_RECORD_SCHEMA, enabled_at: this.clock().toISOString(), envelope_created_at: material.envelope_created_at, blob, check: material.check });
      } catch (error) {
        this.helperSeen = null;
        throw error;
      } finally {
        material.key.fill(0);
      }
      this.deps.broadcast({ type: "event.secrets" });
      return this.keychainView(true);
    });
  }

  disableKeychain(): Promise<KeychainView> {
    return this.keychainWork.run(async () => {
      await this.keychain.clear();
      this.deps.broadcast({ type: "event.secrets" });
      return this.keychainView(true);
    });
  }

  /**
   * Unlock with the keychain: the helper unwraps the stored blob and the store accepts the key only
   * if it opens the check sealed for this envelope. Every failure leaves the store locked and the
   * passphrase the way in; a record that can never work again (the item is gone or replaced, the
   * key does not fit) is dropped, nothing else is.
   */
  unlockWithKeychain(): Promise<SecretsView> {
    return this.keychainWork.run(async () => {
      const status = await this.deps.settings.store.status();
      if (status.state === "unlocked") return this.secretsView();
      if (status.state !== "locked") throw unavailableStoreError(status.state);
      const record = keychainFor(await this.keychain.load(), status.created_at);
      if (record === null) throw reject("keychain_not_enabled", "Keychain unlock is off for this store; use your passphrase.", 409);
      let key: Uint8Array;
      try {
        key = await this.helper.unwrap(record.blob);
      } catch (error) {
        this.helperSeen = null;
        if (error instanceof CoreError && error.code === "helper_refused" && PERMANENT_HELPER_CODES.includes(String(error.details.helper_code))) await this.dropKeychain();
        throw error;
      }
      try {
        await this.deps.settings.store.unlockWithKey(key, record.check);
      } catch (error) {
        if (error instanceof CoreError && error.code === "keychain_mismatch") await this.dropKeychain();
        throw error;
      } finally {
        key.fill(0);
      }
      this.secretsChanged();
      return this.secretsView();
    });
  }

  private async dropKeychain(): Promise<void> {
    await this.keychain.clear();
    this.deps.broadcast({ type: "event.secrets" });
  }

  /** The store's state now (the idle lock applied). */
  private async secretsState(): Promise<SecretStoreState> {
    return (await this.deps.settings.store.status()).state;
  }

  // -- content scripts --------------------------------------------------------------
  /**
   * The links a tab's content script saw, judged against the URL of the document they were
   * read from, as Chrome reports it for the sending frame. The frame URL, not the tab URL,
   * is the page the links belong to: a report that arrives after the tab has moved on
   * names the old document, so when the two disagree in origin it is dropped rather than
   * attributed to the new page.
   */
  async contentLinks(message: ContentMessage, sender: Sender): Promise<void> {
    if (sender.tabId === null || !sender.frameUrl || !sender.topFrame) {
      throw reject("not_allowed", "content.links is accepted from a tab's top frame only", 403);
    }
    const where = origin(sender.frameUrl);
    if (!where || where[0] !== "https") {
      await this.clearTab(sender.tabId);
      return;
    }
    // Stale when the tab has moved on, even within one origin (review 2, nit 7): a late report
    // from /a must not be attributed to /b. Fragments never reach a document, so they are ignored.
    if (sender.tabUrl !== null && withoutFragment(sender.tabUrl) !== withoutFragment(sender.frameUrl)) return;
    const judged = classifyLinks(message.links, sender.frameUrl);
    const state: CandidateState = {
      tabId: sender.tabId,
      pageUrl: sender.frameUrl,
      pageOrigin: originText(where),
      status: judged.status,
      candidates: judged.candidates,
      linksNotListed: judged.overflow,
      updatedAt: this.clock().toISOString(),
    };
    await this.deps.tabs.set(state);
    await this.deps.badge(sender.tabId, judged.candidates.filter((candidate) => candidate.accepted).length);
    this.deps.broadcast({ type: "event.candidates", tabId: sender.tabId });
  }

  async clearTab(tabId: number): Promise<void> {
    await this.deps.tabs.clear(tabId);
    await this.deps.badge(tabId, 0);
    this.deps.broadcast({ type: "event.candidates", tabId });
  }

  // -- website discovery (full page address bar) ----------------------------------------
  async discoverWebsite(url: string): Promise<WebsiteResult> {
    const requested = documentUrl(url);
    const requestedOrigin = origin(requested)!;
    await this.requireOrigin(requested);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.discoveryTimeoutMs);
    let response: globalThis.Response;
    try {
      response = await this.deps.fetch(requested, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "text/html,application/xhtml+xml;q=0.9" },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw reject("discovery_timeout", "Website discovery deadline exceeded", 504);
      throw reject("discovery_failed", `Reading the website failed: ${thrownName(error)}`, 502);
    }
    try {
      // No redirect is followed (D-033 as amended): the reference re-validates and re-resolves
      // every hop, and an extension cannot see a hop before Chrome requests it, so a hop to a
      // loopback or private address would be fetched blind. The person opens the final address.
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw reject(
          "discovery_redirect_refused",
          `The website answered with a redirect. This browser does not follow redirects while reading a website, because it cannot check each hop against the address policy before Chrome requests it; open the address the website redirects to yourself.`,
          502,
          { reason: "redirect_not_followed" },
        );
      }
      const finalUrl = response.url || requested;
      const finalOrigin = origin(finalUrl);
      // Chrome reports `response.url` with the host in punycode while the requested URL keeps
      // the Unicode name, so the two are compared as the WHATWG parser serializes them (review
      // 2, should-fix 2): one origin, two spellings, is not a redirect.
      if (!sameOrigin(finalOrigin, requestedOrigin) && whatwgOrigin(finalUrl) !== whatwgOrigin(requested)) {
        throw reject(
          "discovery_redirect_refused",
          `The website's answer came from ${finalOrigin ? originText(finalOrigin) : "a non-web location"}, not from ${originText(requestedOrigin)}.`,
          502,
          { reason: "cross_origin", location: finalOrigin ? finalUrl : null },
        );
      }
      if (response.status !== 200) {
        throw reject("discovery_http_status", `The website answered HTTP ${response.status} instead of a page`, 502, { status: response.status });
      }
      const contentType = response.headers.get("content-type") ?? "";
      const [essence, parameters] = mediaType(contentType);
      if (essence !== "text/html" && essence !== "application/xhtml+xml") {
        throw reject("discovery_not_html", `The website did not answer with an HTML page (Content-Type ${pyRepr(essence || "absent")})`, 502, {
          content_type: essence || null,
        });
      }
      const { bytes, truncated } = await this.readBounded(response, this.limits.maxHtmlBytes, controller.signal, "discovery");
      const page: FetchedPage = {
        requested_url: url,
        final_url: finalUrl,
        redirects: [],
        content_type: essence,
        charset: parameters.charset ?? null,
        content_coding: "identity",
        body: bytes,
        truncated,
      };
      return await discoverFromPage(page, { ...DEFAULT_LIMITS, maxHtmlBytes: this.limits.maxHtmlBytes }, this.clock());
    } finally {
      clearTimeout(timer);
    }
  }

  // -- opening packages ---------------------------------------------------------------
  async openUrl(url: string, advertisedOn: string | null, foundViaIndex: string | null = null): Promise<SessionView> {
    const { hostname } = validatePackageUrl(url);
    void hostname;
    if (advertisedOn !== null) documentUrl(advertisedOn);
    const source: SessionSource = {
      kind: advertisedOn === null ? "url" : "website",
      display: url,
      advertised_on: advertisedOn,
      opened_at: this.clock().toISOString(),
    };
    // D-076 as amended (T5a review 2): Inspect again from the same place while a run of that
    // session is in flight is that session, found before any download, so it neither downloads
    // again nor fails when the origin stopped answering.
    await this.purgeExpired();
    const running = await this.sessionWithRunInFlight(null, source);
    if (running !== null) return this.view(running);
    // The index entry is read before the download, so a refused id is refused before any byte moves.
    const claimed = foundViaIndex === null ? null : await this.indexEntry(foundViaIndex, url);
    const bytes = await this.download(url);
    const view = await this.openBytes(bytes, source);
    const live = this.sessions.get(view.session.id);
    if (live && claimed !== null && live.foundVia === null) {
      live.foundVia = this.compareClaims(claimed, live);
      live.stored = { ...live.stored, found_via: live.foundVia };
      await this.deps.snapshots.putSession(live.stored);
    }
    if (live) await this.rememberRecent(live);
    return live ? this.view(live) : view;
  }

  /**
   * Fetch one URL's bytes the way a package is downloaded (D-033): the URL gate first, one
   * request, no redirect, no credentials, no referrer, bounded while streaming, a deadline. Used
   * for packages and, with their own bound, for signed documents (T8).
   */
  private async download(url: string, options: { subject?: string; cap?: number; timeoutMs?: number } = {}): Promise<Uint8Array> {
    const subject = options.subject ?? "Package";
    const cap = options.cap ?? this.limits.maxPackageBytes;
    if (subject !== "Package") validatePackageUrl(url, subject);
    await this.requireOrigin(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.limits.downloadTimeoutMs);
    let response: globalThis.Response;
    try {
      response = await this.deps.fetch(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/octet-stream" },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw reject("download_timeout", `${subject} download deadline exceeded`, 504);
      throw reject("download_failed", `Cannot connect to ${subject.toLowerCase()} host: ${thrownName(error)}`, 502);
    }
    try {
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw reject(
          "download_redirect_denied",
          `${subject} host returned a redirect; redirects are disabled because each hop would need the full destination policy re-applied`,
          502,
        );
      }
      if (response.status !== 200) throw reject("download_failed", `${subject} host returned HTTP ${response.status}`, 502);
      const declared = response.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isInteger(length) || length < 0) throw reject("download_failed", `${subject} host sent an invalid Content-Length`, 502);
        if (length > cap) {
          throw reject("download_too_large", `Declared ${subject.toLowerCase()} size exceeds the ${cap}-byte limit`, 413);
        }
      }
      const { bytes, truncated } = await this.readBounded(response, cap, controller.signal, "download");
      if (truncated) throw reject("download_too_large", `${subject} exceeds the ${cap}-byte download limit`, 413);
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBounded(
    response: globalThis.Response,
    cap: number,
    signal: AbortSignal,
    operation: "download" | "discovery",
  ): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const timeoutCode = operation === "download" ? "download_timeout" : "discovery_timeout";
    const failedCode = operation === "download" ? "download_failed" : "discovery_failed";
    try {
      if (!response.body) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        return buffer.length > cap ? { bytes: buffer.slice(0, cap), truncated: true } : { bytes: buffer, truncated: false };
      }
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const room = cap + 1 - total;
          const piece = value.length > room ? value.slice(0, room) : value;
          chunks.push(piece);
          total += piece.length;
          if (total > cap) {
            await reader.cancel();
            break;
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw reject(timeoutCode, `${operation === "download" ? "Package download" : "Website discovery"} deadline exceeded`, 504);
      throw reject(failedCode, `${operation === "download" ? "Package download" : "Reading the website"} failed: ${thrownName(error)}`, 502);
    }
    const bytes = new Uint8Array(Math.min(total, cap));
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, bytes.length - offset);
      bytes.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= bytes.length) break;
    }
    return { bytes, truncated: total > cap };
  }

  /** One capture, one hash, one stored snapshot, then evaluation only (`control.py::_open_bytes`). */
  async openBytes(bytes: Uint8Array, source: SessionSource): Promise<SessionView> {
    if (bytes.length > this.limits.maxPackageBytes) {
      throw reject("package_too_large", `Package exceeds the ${this.limits.maxPackageBytes}-byte limit`, 413);
    }
    const archiveSha256 = await sha256Hex(bytes);
    await this.purgeExpired();
    const running = await this.sessionWithRunInFlight(archiveSha256, source);
    if (running !== null) return this.view(running);
    await this.checkCapacity(bytes.length, archiveSha256);
    const evaluation = await evaluateSnapshot(bytes);
    const layers = evaluationLayers(evaluation);
    if (!structurallyValid(layers) || evaluation.package === null) {
      throw reject("package_rejected", "The package failed structural validation and was not opened", 422, {
        validation: layers,
        archive_sha256: archiveSha256,
        source,
      });
    }
    const now = this.clock();
    const stored: StoredSession = {
      session_id: this.randomId(),
      archive_sha256: archiveSha256,
      archive_bytes: bytes.length,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.limits.sessionTtlSeconds * 1000).toISOString(),
      source,
    };
    this.inFlight.set(archiveSha256, (this.inFlight.get(archiveSha256) ?? 0) + 1);
    let live: LiveSession;
    try {
      await this.deps.snapshots.putSnapshot({ archive_sha256: archiveSha256, bytes, stored_at: stored.created_at });
      try {
        // The snapshot is authoritative from here on; confirm it is byte-identical.
        const written = await this.deps.snapshots.getSnapshot(archiveSha256);
        if (!written || (await sha256Hex(written.bytes)) !== archiveSha256) {
          throw reject("snapshot_unstable", "Snapshot bytes changed while being stored", 500);
        }
        live = await this.evaluate(stored, evaluation.package, layers);
        await this.deps.snapshots.putSession(stored);
      } catch (error) {
        // A snapshot no session refers to must not stay in the cache and count against its cap.
        await this.dropOrphanSnapshot(archiveSha256);
        throw error;
      }
    } finally {
      const remaining = (this.inFlight.get(archiveSha256) ?? 1) - 1;
      if (remaining <= 0) this.inFlight.delete(archiveSha256);
      else this.inFlight.set(archiveSha256, remaining);
    }
    this.sessions.set(stored.session_id, live);
    this.deps.broadcast({ type: "event.sessions" });
    return this.view(live);
  }

  /**
   * D-076: the same bytes opened again from the same place (the same package URL, advertised on
   * the same page) while a run planned on an open session of them is in flight are that session,
   * so the person who presses Inspect again sees their run instead of a fresh, unauthorized copy.
   * Anything else opens a new session, as before: a session with no run in flight is not reused.
   */
  private async sessionWithRunInFlight(archiveSha256: string | null, source: SessionSource): Promise<LiveSession | null> {
    const page = (url: string | null) => (url === null ? null : withoutFragment(url));
    // `archiveSha256` null: matched on the source alone, before any download (`openUrl`).
    const candidates = [...this.sessions.values()].filter(
      (live) => (archiveSha256 === null || live.stored.archive_sha256 === archiveSha256) && live.stored.source.kind === source.kind && live.stored.source.display === source.display && page(live.stored.source.advertised_on) === page(source.advertised_on),
    );
    if (candidates.length === 0) return null;
    const inFlight = (await this.deps.runs.listRuns()).filter((run) => !isTerminal(run.record.status)).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    for (const run of inFlight) {
      const live = candidates.find((item) => item.stored.session_id === run.session_id);
      if (live) return live;
    }
    return null;
  }

  /**
   * D-076: the run in flight a view that just opened should reattach to. Only runs whose session
   * is still open qualify (a view can hold nothing else); among them, a session opened from the
   * page the view is looking at comes first, then the most recent run.
   */
  async activeRun(pageUrl: string | null): Promise<RunView | null> {
    await this.purgeExpired();
    const { runs } = await this.runs.list(null);
    const inFlight = runs.filter((run) => !isTerminal(run.status) && this.sessions.has(run.sessionId));
    const page = pageUrl === null ? null : withoutFragment(pageUrl);
    const fromPage = page === null ? undefined : inFlight.find((run) => {
      const advertised = this.sessions.get(run.sessionId)!.stored.source.advertised_on;
      return advertised !== null && withoutFragment(advertised) === page;
    });
    const chosen = fromPage ?? inFlight[0];
    return chosen === undefined ? null : this.runs.get(chosen.runId);
  }

  private async evaluate(stored: StoredSession, pkg: Package, layers: EvaluationLayers, previous?: Pick<LiveSession, "receipt" | "plan" | "onceSpent" | "foundVia">): Promise<LiveSession> {
    const publisher = await publisherReport(pkg, this.trust);
    const summary = await buildSummary(pkg, { evaluation: layers, publisher });
    return {
      stored,
      pkg,
      evaluation: layers,
      publisher,
      summary,
      receipt: previous?.receipt ?? stored.authorization ?? null,
      plan: previous?.plan ?? stored.run_plan ?? null,
      onceSpent: previous?.onceSpent ?? stored.once_spent ?? false,
      foundVia: previous?.foundVia ?? stored.found_via ?? null,
    };
  }

  private async view(live: LiveSession): Promise<SessionView> {
    const pinned = (await this.subscriptions.library()).pinned.some((entry) => entry.package_url === live.stored.source.display);
    return {
      session: {
        id: live.stored.session_id,
        created_at: live.stored.created_at,
        expires_at: live.stored.expires_at,
        ttl_seconds: this.limits.sessionTtlSeconds,
      },
      source: live.stored.source,
      snapshot: { archive_sha256: live.stored.archive_sha256, archive_bytes: live.stored.archive_bytes, captured_once: true },
      summary: live.summary,
      page: agentPageModel(live.pkg, live.summary, {
        source: {
          kind: live.stored.source.kind,
          display: live.stored.source.display,
          advertised_on: live.stored.source.advertised_on,
        },
        archiveSha256: live.stored.archive_sha256,
      }),
      authorization: live.receipt ? { state: "issued", receipt_id: live.receipt.receipt_id, runnable: live.receipt.runnable } : { state: "none", receipt_id: null, runnable: false },
      run_plan: live.plan ? { state: "prepared", run_plan_id: live.plan.run_plan_id, ready: live.plan.readiness.ready } : { state: "absent", run_plan_id: null, ready: false },
      execution: { performed: false, note: EXECUTION_NOTE },
      found_via: live.foundVia,
      pinned,
    };
  }

  /** Persist the session's consent and plan beside it (D-056). */
  private async persist(live: LiveSession): Promise<void> {
    live.stored = { ...live.stored, authorization: live.receipt, run_plan: live.plan, once_spent: live.onceSpent };
    await this.deps.snapshots.putSession(live.stored);
  }

  private descriptor(live: LiveSession): SessionDescriptor {
    return {
      session_id: live.stored.session_id,
      created_at: live.stored.created_at,
      expires_at: live.stored.expires_at,
      source: live.stored.source,
      archive_sha256: live.stored.archive_sha256,
      archive_bytes: live.stored.archive_bytes,
      package_id: String(live.pkg.manifest.package_id),
      name: String(live.pkg.manifest.name),
      version: String(live.pkg.manifest.version),
      digest: live.pkg.digest,
      signature_status: live.publisher.signature_status,
      trust_status: live.publisher.trust_status,
    };
  }

  // -- sessions -----------------------------------------------------------------------
  /**
   * Rebuild live sessions from stored bytes after a service-worker restart. One attempt is
   * shared by concurrent requests; a failed attempt (a storage error, say) is not memoized,
   * so the next request tries again instead of failing for the rest of the worker's life. A
   * stored session whose bytes cannot be evaluated is dropped, and the others still load.
   */
  private restore(): Promise<void> {
    if (this.restored) return this.restored;
    const attempt = (async () => {
      for (const stored of await this.deps.snapshots.listSessions()) {
        if (this.sessions.has(stored.session_id)) continue;
        if (new Date(stored.expires_at).getTime() <= this.clock().getTime()) {
          await this.drop(stored);
          continue;
        }
        const snapshot = await this.deps.snapshots.getSnapshot(stored.archive_sha256);
        if (!snapshot) {
          await this.deps.snapshots.deleteSession(stored.session_id);
          continue;
        }
        // Only the evaluation of the bytes is caught (review 2, nit 4): unusable bytes drop the
        // session, while a storage error in the trust read below propagates to the retry path.
        let evaluated: { pkg: Package; layers: EvaluationLayers } | null = null;
        try {
          const evaluation = await evaluateSnapshot(snapshot.bytes);
          if (evaluation.package !== null && (await sha256Hex(snapshot.bytes)) === stored.archive_sha256) {
            evaluated = { pkg: evaluation.package, layers: evaluationLayers(evaluation) };
          }
        } catch {
          evaluated = null;
        }
        if (evaluated === null) {
          await this.drop(stored);
          continue;
        }
        this.sessions.set(stored.session_id, await this.evaluate(stored, evaluated.pkg, evaluated.layers));
        // The stored receipt and plan came back with the session; the next read re-checks them.
      }
    })();
    this.restored = attempt.catch((error: unknown) => {
      this.restored = null;
      throw error;
    });
    return this.restored;
  }

  /**
   * Whether anything still needs these bytes: a stored session, a run in flight that was planned
   * on them, or an open conversation whose turn is not charged yet. The execution host reads a
   * run's snapshot only after `host.start`, so Run followed at once by Close must not take the
   * bytes away from the run (T5 review 1, nit 7); the snapshot goes when that run settles
   * (`RunHooks.runSettled`), or, for a turn, when the conversation has charged it: its end rule
   * reads the package (V-8; T24 review 3, nit 2).
   */
  private async snapshotReferenced(archiveSha256: string): Promise<boolean> {
    if ((await this.deps.snapshots.listSessions()).some((session) => session.archive_sha256 === archiveSha256)) return true;
    if ((await this.deps.runs.listRuns()).some((run) => !isTerminal(run.record.status) && run.invocation.archive_sha256 === archiveSha256)) return true;
    return (await this.conversationStore.listConversations()).some((item) => item.status === "open" && item.active_run_id !== null && item.archive_sha256 === archiveSha256);
  }

  /** Delete a snapshot no stored session refers to, unless another open of the same bytes is in flight (called by an open that failed). */
  private async dropOrphanSnapshot(archiveSha256: string): Promise<void> {
    if ((this.inFlight.get(archiveSha256) ?? 0) > 1) return; // another open owns these bytes right now
    if (!(await this.snapshotReferenced(archiveSha256))) await this.deps.snapshots.deleteSnapshot(archiveSha256);
  }

  /** Delete a snapshot nothing refers to any more (called when a run settles; no open of ours is in progress here). */
  private async dropUnreferencedSnapshot(archiveSha256: string): Promise<void> {
    if ((this.inFlight.get(archiveSha256) ?? 0) > 0) return;
    if (!(await this.snapshotReferenced(archiveSha256))) await this.deps.snapshots.deleteSnapshot(archiveSha256);
  }

  // -- views ------------------------------------------------------------------------
  /** Run one holder update at a time: two views asking at once must not overwrite each other. */
  private holderUpdate<T>(update: () => Promise<T>): Promise<T> {
    const next = this.holderQueue.then(update, update);
    this.holderQueue = next.catch(() => undefined);
    return next;
  }

  /** The holders whose document is still open; a holder Chrome named no document for always counts. */
  private async stillOpen(holders: ViewHolder[]): Promise<ViewHolder[]> {
    const ids = holders.map((holder) => holder.document_id).filter((id): id is string => id !== null);
    if (ids.length === 0 || !this.deps.liveDocuments) return holders;
    let open: Set<string>;
    try {
      open = await this.deps.liveDocuments(ids);
    } catch {
      return holders; // unknown is not closed: never end a session a page may still show
    }
    return holders.filter((holder) => holder.document_id === null || open.has(holder.document_id));
  }

  /**
   * A view shows one session at a time: holding this one drops the view's holds on every other
   * session, so a full page that moved on (address bar, Library) no longer keeps the previous
   * session open past another view's Close (T3 review 2, nit 20). The sessions it stops
   * holding stay open until a release or their TTL; navigating is not closing.
   */
  private async hold(sessionId: string, viewId: string, documentId: string | null): Promise<void> {
    await this.holderUpdate(async () => {
      for (const other of this.sessions.keys()) {
        if (other === sessionId) continue;
        const holders = await this.deps.holders.get(other);
        if (holders.some((holder) => holder.view_id === viewId)) await this.deps.holders.set(other, holders.filter((holder) => holder.view_id !== viewId));
      }
      const others = (await this.deps.holders.get(sessionId)).filter((holder) => holder.view_id !== viewId);
      const holders = [...(await this.stillOpen(others)), { view_id: viewId, document_id: documentId }];
      await this.deps.holders.set(sessionId, holders.slice(-MAX_VIEW_HOLDERS));
    });
  }

  /**
   * A view stops showing a session. The session ends only when no other open view holds it, so
   * Close in the side panel leaves a full page on the same session intact (review 2, nit 5),
   * also after the worker restarted in between (review 1 of T3, finding 5).
   */
  async release(sessionId: string, viewId: string): Promise<{ closed: boolean; session_id: string; holders: number }> {
    const live = await this.session(sessionId);
    // The "no holder left" decision and the clearing of the holders are one queued step, so a
    // hold that arrives in between cannot be wiped by a clear decided on stale facts (nit 20).
    const remaining = await this.holderUpdate(async () => {
      const holders = await this.stillOpen((await this.deps.holders.get(sessionId)).filter((holder) => holder.view_id !== viewId));
      if (holders.length > 0) await this.deps.holders.set(sessionId, holders);
      else await this.deps.holders.clear(sessionId);
      return holders.length;
    });
    if (remaining > 0) return { closed: false, session_id: sessionId, holders: remaining };
    await this.drop(live.stored, { holdersCleared: true });
    this.deps.broadcast({ type: "event.sessions" });
    return { closed: true, session_id: sessionId, holders: 0 };
  }

  private async session(sessionId: string): Promise<LiveSession> {
    await this.purgeExpired();
    const live = this.sessions.get(sessionId);
    if (!live) throw reject("session_unknown", "Unknown or expired session", 404);
    return live;
  }

  private async drop(stored: StoredSession, options: { holdersCleared?: boolean } = {}): Promise<void> {
    this.sessions.delete(stored.session_id);
    if (!options.holdersCleared) await this.holderUpdate(() => this.deps.holders.clear(stored.session_id));
    await this.deps.snapshots.deleteSession(stored.session_id);
    if (this.inFlight.has(stored.archive_sha256)) return; // an open in progress owns the snapshot
    if (!(await this.snapshotReferenced(stored.archive_sha256))) await this.deps.snapshots.deleteSnapshot(stored.archive_sha256);
  }

  private async purgeExpired(): Promise<void> {
    const now = this.clock().getTime();
    let changed = false;
    for (const live of [...this.sessions.values()]) {
      if (new Date(live.stored.expires_at).getTime() <= now) {
        await this.drop(live.stored);
        changed = true;
      }
    }
    if (changed) this.deps.broadcast({ type: "event.sessions" });
  }

  private async checkCapacity(incoming: number, archiveSha256: string): Promise<void> {
    if (this.sessions.size >= this.limits.maxSessions) await this.endUnshownSessions(this.sessions.size - this.limits.maxSessions + 1);
    if (this.sessions.size >= this.limits.maxSessions) {
      throw reject("session_limit_reached", `At most ${this.limits.maxSessions} packages can be open and every one is shown in an open page or panel, or has a run in flight; close one first`, 429);
    }
    const stored = await this.deps.snapshots.listSnapshots();
    const cached = stored.reduce((sum, item) => sum + item.bytes, 0);
    const already = stored.some((item) => item.archive_sha256 === archiveSha256);
    if (!already && cached + incoming > this.limits.maxCacheBytes) {
      throw reject("cache_limit_reached", "The snapshot cache is full; close a package first", 429);
    }
  }

  /**
   * Make room for a new session (T9, the user's report of 2026-10-09): end up to `count` sessions
   * that no open view holds and that no run in flight was planned on, oldest first. Navigating a
   * full page to another agent, or closing a side panel, stops showing a session without ending it
   * (`hold`; Chrome sends nothing when a panel closes), so such sessions used to fill the limit
   * until their TTL. A session a page still shows, or whose document Chrome cannot rule out
   * (`stillOpen`), is never ended here; past runs stay readable without their session.
   */
  private async endUnshownSessions(count: number): Promise<void> {
    const inFlight = new Set((await this.deps.runs.listRuns()).filter((run) => !isTerminal(run.record.status)).map((run) => run.session_id));
    const oldest = [...this.sessions.values()].sort((a, b) => (a.stored.created_at < b.stored.created_at ? -1 : a.stored.created_at > b.stored.created_at ? 1 : 0));
    // A session opened moments ago may not be held yet: the opening view's `hold` lands only after
    // `package.open` returns, so it is never ended here within the grace (T9 review 1, finding 3).
    const graceStart = this.clock().getTime() - SESSION_HOLD_GRACE_MS;
    let ended = 0;
    for (const live of oldest) {
      if (ended >= count) break;
      if (inFlight.has(live.stored.session_id)) continue;
      if (Date.parse(live.stored.created_at) > graceStart) continue;
      const unshown = await this.holderUpdate(async () => {
        const holders = await this.stillOpen(await this.deps.holders.get(live.stored.session_id));
        if (holders.length > 0) return false;
        await this.deps.holders.clear(live.stored.session_id);
        return true;
      });
      if (!unshown) continue;
      await this.drop(live.stored, { holdersCleared: true });
      ended += 1;
    }
    if (ended > 0) this.deps.broadcast({ type: "event.sessions" });
  }

  async close(sessionId: string): Promise<{ closed: true; session_id: string }> {
    const live = await this.session(sessionId);
    await this.drop(live.stored);
    this.deps.broadcast({ type: "event.sessions" });
    return { closed: true, session_id: sessionId };
  }

  async listSessions(): Promise<{ sessions: SessionDescriptor[] }> {
    await this.purgeExpired();
    return { sessions: [...this.sessions.values()].map((live) => this.descriptor(live)) };
  }

  // -- trust ---------------------------------------------------------------------------
  async trustList(): Promise<TrustList> {
    return { entries: await this.deps.trust.entries(), state: await this.deps.trust.state() };
  }

  private async refreshTrust(): Promise<void> {
    for (const [id, live] of this.sessions) this.sessions.set(id, await this.evaluate(live.stored, live.pkg, live.evaluation, live));
    this.deps.broadcast({ type: "event.trust" });
    this.deps.broadcast({ type: "event.sessions" });
  }

  async pinSession(sessionId: string, signerFingerprint: string, scope: "package" | "publisher"): Promise<PinResult> {
    const live = await this.session(sessionId);
    const result = await pinPackagePublisher(this.deps.trust, live.pkg, live.publisher, { signerFingerprint, scope });
    await this.refreshTrust();
    return { ...result, publisher: this.sessions.get(sessionId)!.publisher };
  }

  async pinKey(pem: string, displayName: string, publisherId: string | null, packageIdPrefix: string | null): Promise<TrustList> {
    await this.deps.trust.add(publicKeyFromPem(pem), { displayName, publisherId, packageIdPrefix });
    await this.refreshTrust();
    return this.trustList();
  }

  async unpin(fingerprint: string): Promise<TrustList> {
    await this.deps.trust.remove(fingerprint);
    await this.refreshTrust();
    return this.trustList();
  }

  // -- settings, keys and the memory (D-050, D-051, D-055; T19) -------------------------------
  /** The memory (T19, memory.v0): opened over the secret store's keys; every write behind the unlocked store. */
  readonly memory: MemoryController;
  /** The permission bookkeeping, one operation at a time (review 1, finding 5): a grant the page reports and Chrome's `onAdded` reconcile never interleave their read-modify-writes. */
  private readonly permissionWork = new SerialQueue();

  async settingsView(): Promise<SettingsView> {
    return { settings: await this.deps.settings.settings(), keys: await this.deps.settings.keyPresence() };
  }

  async setSettings(raw: unknown): Promise<SettingsView> {
    // A contact or a limit the settings would silently drop is refused by name (T6).
    const problem = settingsProblem(raw);
    if (problem !== null) throw reject("settings_invalid", problem, 400);
    // An endpoint the settings would silently drop is refused by name instead, so the person
    // learns why their Ollama or provider address was not kept.
    const connections = isRecord(raw) && isRecord(raw.models) && Array.isArray(raw.models.connections) ? raw.models.connections : [];
    for (const connection of connections) {
      if (!isRecord(connection) || typeof connection.base_url !== "string" || connection.base_url.trim().length === 0) continue;
      if (!(PROVIDER_IDS as readonly unknown[]).includes(connection.provider) || connection.provider === "chrome-builtin") continue;
      const problem = endpointProblem(connection.provider as ProviderId, connection.base_url);
      if (problem !== null) throw reject("settings_invalid", `The ${String(connection.provider)} endpoint ${problem}.`, 400, { provider: connection.provider });
    }
    const saved = await this.deps.settings.saveSettings(normalizeSettings(raw));
    this.invalidateCatalog(); // connections or caps may have changed
    this.deps.broadcast({ type: "event.settings" });
    return { settings: saved, keys: await this.deps.settings.keyPresence() };
  }

  async setKey(provider: ProviderId, key: string | null): Promise<SettingsView> {
    if (provider === "ollama" || provider === "chrome-builtin") throw reject("invalid_request", `${provider} takes no API key`);
    try {
      await this.deps.settings.setKey(provider, key);
    } catch (error) {
      if (error instanceof CoreError) throw error; // store_locked, store_no_passphrase
      throw reject("invalid_request", error instanceof Error ? error.message : "invalid key");
    }
    this.invalidateCatalog();
    this.deps.broadcast({ type: "event.settings" });
    return this.settingsView();
  }

  /** The recall card per `memory.read` (or alias) request (M-34, M-52): the preset's mode, clamped by the subscribed policy's ceiling (M-54). */
  private async recallViews(live: LiveSession, preset: PresetId, policy: ActivePolicy | null): Promise<RecallView[]> {
    const requests = (live.pkg.policy.permissions as JsonObject[])
      .filter((permission) => RESOURCE_PERMISSION_KINDS.includes(String(permission.kind)) && (permission.resources as JsonValue[]).length === 1)
      .map((permission) => ({ permission_id: String(permission.id), resource_type: String((permission.resources as JsonValue[])[0]) }));
    if (requests.length === 0 || (await this.secretsState()) !== "unlocked") return []; // locked: the picker says unlock, no card (M-34)
    const facts = await this.memory.recall({ requested: requests.map((request) => request.resource_type), packageId: String(live.pkg.manifest.package_id), selected: (live.receipt?.resource_grants ?? []).map((grant) => grant.resource_id) });
    const order = ["ask", "propose", "auto"] as const;
    const ceiling = ((policy?.bundle as { memory?: { recall?: unknown } } | undefined)?.memory?.recall ?? "auto") as (typeof order)[number];
    const presetMode: (typeof order)[number] = preset === "privacy-first" ? "ask" : preset === "balanced" ? "propose" : "auto";
    return requests.map((request) => {
      const found = facts[request.resource_type];
      const wanted = found?.sealed ? "ask" : presetMode;
      const mode = order[Math.min(order.indexOf(wanted), order.indexOf(order.includes(ceiling) ? ceiling : "auto"))]!;
      return { permission_id: request.permission_id, resource_type: request.resource_type, display_name: found?.display_name ?? null, sealed: found?.sealed ?? false, mode, candidates: found?.candidates ?? [], sealed_fields: found?.sealed_fields ?? [] };
    });
  }

  /** The proposal review sheet of a run (M-41): its `proposals.json` and the facts acceptance would use; null `review` when nothing was offered. */
  async runReview(runId: string): Promise<RunReviewView> {
    const run = await this.deps.runs.getRun(runId);
    if (run === null) throw reject("run_unknown", "This browser holds no run with that id.", 404);
    const memory = (run.record.memory ?? null) as { proposals?: { count: number; offered: number; reason: string | null } | null } | null;
    const facts = memory?.proposals ?? null;
    const plan = run.invocation.plan;
    const pkg = { package_id: plan.package.package_id, package_version: plan.package.version, name: plan.package.name ?? null };
    const base: RunReviewView = { run_id: runId, package: pkg, proposed_at: run.memory_proposed_at ?? null, offered: facts?.offered ?? 0, count: facts?.count ?? 0, reason: facts?.reason ?? null, review: null, decided: run.memory_review ?? null };
    if (!proposalsOffered(run) || base.decided !== null) return base;
    const artifact = await this.deps.runs.getArtifact(runId, "proposals.json");
    if (artifact === null) return base;
    const document = JSON.parse(new TextDecoder().decode(artifact.bytes)) as JsonValue;
    return { ...base, review: await this.memory.review(document, { granted: plan.resource_grants, packageId: plan.package.package_id, declared: run.memory_types ?? [] }) };
  }

  /**
   * M-42: the decisions of one review, applied together once; the run keeps the outcome and the
   * sheet never reopens. Only a run that completed with its proposals **offered** (the permission
   * granted, no refusing policy, room in the memory; D-223) takes decisions, and the decisions of
   * one run are taken one at a time, so a second Decide, however quick, finds the first recorded
   * (review 1, finding 2).
   */
  runDecide(runId: string, decisions: readonly import("../../core/memory/proposals.js").ReviewDecision[]): Promise<import("./memory-controller.js").ReviewOutcome> {
    return this.reviewWork.run(async () => {
      const run = await this.deps.runs.getRun(runId);
      if (run === null) throw reject("run_unknown", "This browser holds no run with that id.", 404);
      if (run.memory_review) throw reject("review_decided", "The proposals of this run were already decided.", 409);
      if (!proposalsOffered(run)) throw reject("review_not_offered", "This run offered no proposals to review: it did not complete, or its proposals were not offered (the permission denied, a policy, a full memory).", 409);
      const artifact = await this.deps.runs.getArtifact(runId, "proposals.json");
      if (artifact === null) throw reject("review_absent", "This run offered no proposals.", 404);
      const plan = run.invocation.plan;
      const document = JSON.parse(new TextDecoder().decode(artifact.bytes)) as JsonValue;
      const outcome = await this.memory.decide(document, { decisions, granted: plan.resource_grants, package: { package_id: plan.package.package_id, package_version: plan.package.version, run_id: runId }, proposedAt: run.memory_proposed_at ?? run.record.endedAt ?? this.clock().toISOString(), declared: run.memory_types ?? [] });
      await this.deps.runs.updateRun(runId, (current) => ({ ...current, memory_review: { at: this.clock().toISOString(), accepted: outcome.accepted.length, rejected: outcome.rejected.length } }));
      this.deps.broadcast({ type: "event.run", runId, sessionId: run.session_id, status: run.record.status });
      return outcome;
    });
  }

  // -- Settings → Files: the person's picked PDFs (T6, D-083) ---------------------------------
  async filesView(): Promise<FilesView> {
    return { files: await this.files.list(), max_files: MAX_FILES, max_file_bytes: MAX_FILE_BYTES, max_total_bytes: MAX_TOTAL_FILE_BYTES };
  }

  /** Copy one picked PDF into the store, after the reference's refusals; the view never learns more than its id, hash and size. */
  async addFile(name: string, base64: string): Promise<FilesView> {
    let data: Uint8Array;
    try {
      const binary = atob(base64);
      data = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    } catch {
      throw reject("file_invalid", "The picked file's bytes did not arrive intact.");
    }
    let file;
    try {
      const randomHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      file = newFile(name, data, await this.files.list(), this.clock(), randomHex);
    } catch (error) {
      if (error instanceof FileRefusal) throw reject(error.code, error.message, error.code === "file_limit" ? 413 : 400);
      throw error;
    }
    await this.files.put(file);
    this.deps.broadcast({ type: "event.files" });
    return this.filesView();
  }

  /** Remove a picked file. A run already given it fails its read ("no longer held"); its plan is unaffected. */
  async removeFile(fileId: string): Promise<FilesView> {
    if (!(await this.files.remove(fileId))) throw reject("file_unknown", "This browser holds no picked file with that id.", 404);
    this.deps.broadcast({ type: "event.files" });
    return this.filesView();
  }

  // -- the host registries for one session ---------------------------------------------------
  /** The memory's registry for this package's requests (memory.v0 M-16, M-17): the candidates in recall order; empty while the store is locked. */
  private resourceRegistry(live: LiveSession): Promise<ResourceRegistry> {
    return this.memory.registry({ requested: requestedTypesOf(live.pkg), packageId: String(live.pkg.manifest.package_id), selected: (live.receipt?.resource_grants ?? []).map((grant) => grant.resource_id) });
  }

  /** The registry for a preflight: null while the store is locked, so a grant is "not evaluated" rather than stale (T16). */
  private async resourceRegistryOrNull(live: LiveSession): Promise<ResourceRegistry | null> {
    return (await this.secretsState()) === "unlocked" ? this.resourceRegistry(live) : null;
  }

  private async toolRegistry(live: LiveSession): Promise<ToolRegistry> {
    const unlocked = (await this.secretsState()) === "unlocked";
    const types = await this.memory.resourceTypeFacts(requestedTypesOf(live.pkg));
    const contactConfigured = (await this.deps.settings.settings()).services.crossref_contact !== null;
    return buildHostToolRegistry(live.pkg, { resourceTypes: types, agentTools: unlocked ? agentToolDigests() : null, runtimeVersion: this.version, now: this.clock(), contactConfigured });
  }

  private async toolEvaluation(live: LiveSession, decisions?: Record<string, Decision>, approvals?: Record<string, boolean>): Promise<{ registry: ToolRegistry; evaluation: RegistryEvaluation }> {
    const registry = await this.toolRegistry(live);
    const evaluation = await evaluateRegistry(live.pkg, registry, { decisions, toolApprovals: approvals, now: this.clock() });
    return { registry, evaluation };
  }

  // -- the model catalog (D-023, D-055) ------------------------------------------------------
  private catalogCache: { catalog: HostCatalog; probes: ProbeResult[]; at: number } | null = null;
  /** The probe in progress: concurrent refreshes (two views opening at once) share one (D-077). */
  private catalogProbe: Promise<{ catalog: HostCatalog; probes: ProbeResult[] }> | null = null;
  /** Bumped when the settings change: a probe started before then does not write the cache. */
  private catalogGeneration = 0;

  private invalidateCatalog(): void {
    this.catalogCache = null;
    this.catalogProbe = null;
    this.catalogGeneration += 1;
  }

  /**
   * The catalog no older than `maxAgeMs`, probing the providers (or joining the probe in progress)
   * otherwise. `stampAt` dates a catalog built from answers already in hand (`mergeProbe`) by its
   * oldest source rather than by now (T5a review 2).
   */
  private async catalog(maxAgeMs = CATALOG_TTL_MS, probed?: ReadonlyMap<ProviderId, ProbeResult>, stampAt?: number): Promise<{ catalog: HostCatalog; probes: ProbeResult[] }> {
    if (this.catalogCache && this.clock().getTime() - this.catalogCache.at < maxAgeMs) return this.catalogCache;
    if (this.catalogProbe && !probed) return this.catalogProbe;
    const generation = this.catalogGeneration;
    const probe = (async () => {
      const settings = await this.deps.settings.settings();
      const connections = connectionsFor(settings, await this.deps.settings.keyPresence());
      const builtin = connections.some((connection) => connection.provider === "chrome-builtin" && connection.enabled) ? await this.deps.builtin() : null;
      const result = await buildHostCatalog(connections, this.deps.http, { builtin, runtimeVersion: this.version, now: this.clock(), probed });
      // Stamped when the answers land (or with its oldest source's time), and only if the settings
      // did not change meanwhile.
      if (this.catalogGeneration === generation) this.catalogCache = { ...result, at: stampAt ?? this.clock().getTime() };
      return result;
    })();
    this.catalogProbe = probe;
    try {
      return await probe;
    } finally {
      if (this.catalogProbe === probe) this.catalogProbe = null;
    }
  }

  /**
   * The catalog a check is made against: the last one whatever its age, or a new one when none is
   * held. A missing catalog is never read as "no opinion" (D-077, review 1): readiness and the
   * lease would otherwise accept a plan whose model its provider just stopped serving.
   */
  private async currentCatalog(): Promise<{ catalog: HostCatalog; probes: ProbeResult[] }> {
    return this.catalogCache ?? (await this.catalog());
  }

  /**
   * One provider's fresh answer (Test connection) replaces its part of the last catalog; the
   * others are not asked again. The merged catalog keeps the held catalog's time: every other
   * provider's part is that old, and a Test connection of one provider must not make an old answer
   * of another look fresh (T5a review 2). A settings change since the test started (`generation`)
   * means the answer may describe the old endpoint, so it is not merged at all.
   */
  private async mergeProbe(result: ProbeResult, generation: number): Promise<void> {
    if (this.catalogProbe) await this.catalogProbe.catch(() => undefined);
    if (generation !== this.catalogGeneration) return;
    const held = this.catalogCache;
    if (held === null) return; // the next check builds a whole catalog
    const probed = new Map<ProviderId, ProbeResult>(held.probes.map((item) => [item.provider, item]));
    probed.set(result.provider, result);
    await this.catalog(0, probed, held.at);
  }

  /**
   * Why a model cannot be used, in words a person can act on (D-077): the provider's own answer
   * from the last probe (which names its address), and where to test the connection.
   */
  private modelProblem(modelId: string, read: { catalog: HostCatalog; probes: readonly ProbeResult[] }): string {
    const provider = modelId.slice(0, Math.max(0, modelId.indexOf("/")));
    const descriptor = findModel(read.catalog, modelId);
    const probe = read.probes.find((item) => item.provider === provider) ?? null;
    const said = descriptor && !descriptor.available && descriptor.availability_reason ? descriptor.availability_reason : probe && !probe.ok && probe.error ? `${probe.error}.` : null;
    const ollama = provider === "ollama" ? " Ollama must be running, with OLLAMA_ORIGINS allowing chrome-extension://*." : "";
    return `${said ? `${said} ` : ""}Test the connection in Settings → Models.${ollama}`;
  }

  /** The readiness and plan messages for a model that is no longer offered, with the provider's answer (D-077). */
  private explainModelReasons(reasons: Reason[], read: { catalog: HostCatalog; probes: readonly ProbeResult[] }): Reason[] {
    return reasons.map((item) => (item.code === "model_no_longer_available" && item.subject ? { ...item, message: `${item.message} ${this.modelProblem(item.subject, read)}` } : item));
  }

  async probe(provider: ProviderId): Promise<ProbeView> {
    const settings = await this.deps.settings.settings();
    const connection = connectionsFor(settings, await this.deps.settings.keyPresence()).find((item) => item.provider === provider);
    if (!connection) throw reject("invalid_request", `No connection for ${provider}`);
    // Captured before the provider is asked: a settings save while it answers must not let the old
    // endpoint's answer into the new catalog (T5a review 2).
    const generation = this.catalogGeneration;
    // The built-in model is read from the Prompt API, never over the network, and its one model row
    // comes back like any provider's (D-113), so Settings → Models can make it the default.
    const builtin = provider === "chrome-builtin" ? await this.deps.builtin() : null;
    const result = await probeProvider({ ...connection, enabled: true }, this.deps.http, builtin);
    await this.mergeProbe(result, generation);
    return { ...result, diagnosis: provider === "ollama" && !result.ok ? await this.ollamaDiagnosis(connection.base_url ?? DEFAULT_BASE_URLS.ollama) : null };
  }

  /** B-117: a failed Ollama probe is one of two things a person can act on, when the shell can tell them apart. */
  private async ollamaDiagnosis(base: string): Promise<ProbeView["diagnosis"]> {
    if (!this.deps.reachable) return { state: "unknown", hint: "Ollama did not answer. Check that it is running and that OLLAMA_ORIGINS includes chrome-extension://*." };
    let reachable: boolean;
    try {
      reachable = await this.deps.reachable(`${base.replace(/\/+$/u, "")}/api/tags`);
    } catch {
      reachable = false;
    }
    return reachable
      ? { state: "rejecting_origin", hint: `Ollama is running at ${base} but rejects requests from this extension's origin. Set OLLAMA_ORIGINS to include chrome-extension://* and restart Ollama (the commands are above).` }
      : { state: "not_running", hint: `Nothing answers at ${base}. Start Ollama (with OLLAMA_ORIGINS set), or correct the endpoint.` };
  }

  async evaluateModels(sessionId: string, refresh: boolean): Promise<ModelsView> {
    const live = await this.session(sessionId);
    const settings = await this.deps.settings.settings();
    const { catalog, probes } = await this.catalog(refresh ? CATALOG_FRESH_MS : CATALOG_TTL_MS);
    const required = modePermissionIds(live.pkg, MODE_MODEL);
    const policy = await this.activePolicy();
    return {
      evaluation: evaluateCatalog(live.pkg, catalog, this.clock()),
      probes,
      default_model: settings.models.default_model,
      local_models_only: PRESETS[settings.preset].local_models_only || policy?.bundle.models.local_only === true,
      execution_mode_permission_ids: required,
      execution_mode_permissions_granted: required.length > 0 && required.every((id) => (live.receipt?.decisions[id] ?? DENY) !== DENY),
      captured_at: catalog.host.captured_at,
      model_policy: policy ? { label: policyLabel(policy.reference), title: policy.reference.title, local_only: policy.bundle.models.local_only, max_cost_usd_per_run: policy.bundle.models.max_cost_usd_per_run } : null,
    };
  }

  // -- authorization (authorization.py, D-022, D-050, D-053) ----------------------------------
  private requireDigest(live: LiveSession, digest: string): void {
    if (digest !== live.pkg.digest) {
      throw reject("digest_mismatch", "package_digest does not match the package this session holds; reload the view before deciding", 409, {
        session_digest: live.pkg.digest,
      });
    }
  }

  async authorizationView(live: LiveSession): Promise<AuthorizationView> {
    const settings = await this.deps.settings.settings();
    const request = buildRequest(live.pkg, { sessionId: live.stored.session_id, decisions: live.receipt?.decisions ?? {}, toolApprovals: live.receipt?.tool_approvals ?? {} });
    const policy = DEFAULT_BROWSER_POLICY;
    const secrets = await this.secretsState();
    const registry = await this.resourceRegistryOrNull(live);
    const profiles = readProfiles(live.pkg);
    const requestedTypes = requestedTypesOf(live.pkg);
    const known = new Set(registry === null ? requestedTypes : registry.types.map((type) => type.id));
    const { evaluation } = await this.toolEvaluation(live);
    // The subscribed policy pre-decides inside each profile and on the preset's defaults (T8, D-102).
    const subscription = await this.activePolicy();
    const decide = this.decider(live.pkg, subscription, bindingFacts(evaluation));
    return {
      session_id: live.stored.session_id,
      package_digest: live.pkg.digest,
      preset: settings.preset,
      local_models_only: PRESETS[settings.preset].local_models_only || subscription?.bundle.models.local_only === true,
      request: {
        ...request,
        blocking_reasons: blockingReasons(live.pkg, { evaluation: live.evaluation, publisher: live.publisher, decisions: live.receipt?.decisions ?? {}, policy }),
        browser_policy: { ...policy },
      },
      profiles: profiles.profiles ? profiles.profiles.map((profile) => ({ profile, decided: decide(profile, settings.preset) })) : null,
      profile_notes: profiles.notes,
      defaults: decide(null, settings.preset),
      resources: evaluateResources(live.pkg, registry, { decisions: live.receipt?.decisions ?? {}, grants: live.receipt?.resource_grants ?? [] }),
      missing_resource_types: [...new Set(requestedTypes.filter((type) => !known.has(type)))].sort(),
      recall: await this.recallViews(live, settings.preset, subscription),
      input_gated_reads: inputGatedReads(live.pkg),
      tools: evaluation.tools.map(
        (tool): ToolOffer => ({
          tool_id: tool.tool_id,
          binding_name: tool.binding_name,
          status: tool.status,
          reason: tool.reason,
          implementation_kind: tool.binding?.implementation_kind ?? null,
          display_name: tool.binding?.display_name ?? null,
          side_effects: tool.side_effects,
          approval_required: tool.approval_required,
          permission_ids: tool.permission_ids,
          resource_type: tool.binding?.resource_type ?? null,
        }),
      ),
      receipt: live.receipt,
      run_plan: live.plan ? await this.runPlanState(live) : null,
      default_model: settings.models.default_model,
      policy: subscription ? this.policyForAuthorization(subscription, settings) : null,
      secrets,
      origins: await this.authorizationOrigins(live, evaluation),
    };
  }

  /** The decisions a profile (or, with none, the preset) yields, with the subscribed policy applied when one is in force. */
  private decider(pkg: Package, policy: ActivePolicy | null, bindings: Record<string, ToolBindingFacts | null>): (profile: Profile | null, preset: PresetId) => Decided {
    return (profile, preset) => {
      const base = profile ? profileDecisions(pkg, profile, preset) : defaultDecisions(pkg, preset);
      return policy ? applyPolicy(pkg, base, { policy, preset, profile, bindings }) : base;
    };
  }

  private policyForAuthorization(policy: ActivePolicy, settings: Settings): AuthorizationPolicyView {
    const caps = policy.bundle.budget_caps;
    const capped = cappedLimits(settings.limits, caps);
    const words: Record<string, string> = {
      total_tokens: "tokens per run",
      max_remote_calls: "remote calls per run",
      max_parallel_workers: "parallel workers",
      max_output_tokens_per_call: "output tokens per model call",
      run_timeout_seconds: "seconds per run",
      max_calls_per_tool: "calls per tool",
      model_call_timeout_seconds: "seconds per model call",
    };
    const limits = Object.entries(caps).map(([field, value]) => {
      const lowered = capped[field as keyof typeof capped] < settings.limits[field as keyof typeof capped];
      return `at most ${(value as number).toLocaleString("en-US")} ${words[field] ?? field}${lowered ? " (lower than your own limit)" : ""}`;
    });
    return {
      reference: { ...policy.reference },
      label: policyLabel(policy.reference),
      limits_capped: limits,
      local_only: policy.bundle.models.local_only,
      max_cost_usd_per_run: policy.bundle.models.max_cost_usd_per_run,
      bindings_restricted: policy.bundle.bindings !== null,
    };
  }

  /** `control.py::authorize`: record explicit decisions and issue a digest-bound receipt; a new receipt discards the plan. */
  async authorize(
    sessionId: string,
    input: { packageDigest: string; decisions: Record<string, string>; toolApprovals: Record<string, boolean>; resourceSelections: Record<string, string>; provenance: unknown | null; prepare: boolean; modelId?: string | null; presetSelections?: string[] },
  ): Promise<AuthorizeResult> {
    const live = await this.session(sessionId);
    this.requireDigest(live, input.packageDigest);
    const decisions = normalizeDecisions(live.pkg, input.decisions);
    const approvals = normalizeToolApprovals(live.pkg, input.toolApprovals);
    if (Object.keys(input.resourceSelections).length > 0) await this.memory.unlocked(); // a pick needs the store unlocked (store_locked otherwise)
    const registry = await this.resourceRegistry(live);
    const grants = normalizeResourceSelections(live.pkg, registry, decisions, input.resourceSelections);
    // A `policy` claim is checked against the policy in force now (D-102); with one in force the receipt names it.
    const policy = await this.activePolicy();
    const expand = policy ? this.decider(live.pkg, policy, bindingFacts((await this.toolEvaluation(live)).evaluation)) : null;
    const provenance = normalizeProvenance(live.pkg, input.provenance, decisions, approvals, grants, { policy: policy && expand ? { reference: policy.reference, expand } : null });
    // M-53: a pick the convenience preset made is recorded as `preset`; the claim stands only for a grant that exists.
    const auto = new Set(input.presetSelections ?? []);
    const finalProvenance: Provenance | null = provenance === null ? null : { ...provenance, resource_selections: Object.fromEntries(grants.map((grant) => [grant.permission_id, auto.has(grant.permission_id) ? ("preset" as const) : (provenance.resource_selections[grant.permission_id] ?? ("user" as const))])) };
    return this.issue(live, decisions, approvals, grants, registry, finalProvenance, input.prepare, input.modelId ?? null);
  }

  /** The two-click path (D-022): a selected profile becomes decisions under the current preset, with the person's picks. */
  async useProfile(sessionId: string, input: { packageDigest: string; profileId: string; resourceSelections: Record<string, string>; prepare: boolean; presetSelections?: string[] }): Promise<AuthorizeResult> {
    const live = await this.session(sessionId);
    this.requireDigest(live, input.packageDigest);
    const profiles = readProfiles(live.pkg);
    const profile = profiles.profiles?.find((item) => item.id === input.profileId);
    if (!profile) throw reject("profile_unknown", `This package declares no usable profile ${pyRepr(input.profileId)}`, 404, { notes: profiles.notes });
    const settings = await this.deps.settings.settings();
    const policy = await this.activePolicy();
    const decided: Decided = this.decider(live.pkg, policy, bindingFacts((await this.toolEvaluation(live)).evaluation))(profile, settings.preset);
    if (Object.keys(input.resourceSelections).length > 0) await this.memory.unlocked();
    const registry = await this.resourceRegistry(live);
    const grants = normalizeResourceSelections(live.pkg, registry, decided.decisions, input.resourceSelections);
    // M-53: a pick the convenience preset made is recorded as `preset`, the person's as `user`.
    const auto = new Set(input.presetSelections ?? []);
    const provenance: Provenance = { ...decided.provenance, resource_selections: Object.fromEntries(grants.map((grant) => [grant.permission_id, auto.has(grant.permission_id) ? ("preset" as const) : ("user" as const)])) };
    return this.issue(live, decided.decisions, decided.tool_approvals, grants, registry, provenance, input.prepare);
  }

  private async issue(
    live: LiveSession,
    decisions: Record<string, Decision>,
    approvals: Record<string, boolean>,
    grants: ReturnType<typeof normalizeResourceSelections>,
    registry: ResourceRegistry,
    provenance: Provenance | null,
    prepare: boolean,
    modelId: string | null = null,
  ): Promise<AuthorizeResult> {
    const receipt = await buildReceipt(live.pkg, {
      sessionId: live.stored.session_id,
      source: sourceRef(live.stored.source),
      archiveSha256: live.stored.archive_sha256,
      evaluation: live.evaluation,
      publisher: live.publisher,
      trustState: await this.deps.trust.state(),
      decisions,
      toolApprovals: approvals,
      policy: DEFAULT_BROWSER_POLICY,
      instanceId: await this.deps.settings.instanceId(),
      expiresAt: live.stored.expires_at,
      resourceGrants: grants,
      resourceRegistry: registry,
      provenance,
      now: this.clock(),
    });
    // A new consent decision supersedes any plan prepared under the old one, and starts unspent.
    live.receipt = receipt;
    live.plan = null;
    live.onceSpent = false;
    await this.persist(live);
    const result: AuthorizeResult = { receipt, run_plan: null, plan_refused: null, model_id: null };
    try {
      if (prepare) {
        // The model picked under Customize your settings, else the default model.
        const chosen = modelId ?? (await this.deps.settings.settings()).models.default_model;
        result.model_id = chosen;
        if (chosen === null) {
          result.plan_refused = [{ code: "model_not_selected", message: "Choose a default model in Settings → Models, or pick one under Customize your settings.", subject: null }];
        } else {
          try {
            result.run_plan = await this.prepareRunPlan(live.stored.session_id, { packageDigest: live.pkg.digest, receiptId: receipt.receipt_id, modelId: chosen });
          } catch (error) {
            // The receipt is recorded whatever happens to the plan, so every refusal of the plan
            // (an unreachable provider's `model_unknown` included) is reported beside it rather
            // than as a failure of the authorization (review 1, finding 4).
            if (!(error instanceof CoreError)) throw error;
            const reasons = error.code === "run_plan_refused" ? (error.details.blocking_reasons as Reason[] | undefined) : undefined;
            result.plan_refused = reasons ?? [{ code: error.code, message: error.message, subject: error.code === "model_unknown" || error.code === "model_unavailable" ? chosen : null }];
          }
        }
      }
    } finally {
      // Every view learns of the new receipt, even when preparing its plan failed.
      this.deps.broadcast({ type: "event.authorization", sessionId: live.stored.session_id });
      this.deps.broadcast({ type: "event.sessions" });
    }
    return result;
  }

  // -- run plans (runplan.py) ---------------------------------------------------------------
  /** `control.py::prepare_run_plan`: freeze one package + authorization + model + tools into a plan, or refuse by name. */
  async prepareRunPlan(sessionId: string, input: { packageDigest: string; receiptId: string; modelId: string }): Promise<RunPlanState> {
    const live = await this.session(sessionId);
    this.requireDigest(live, input.packageDigest);
    if (live.receipt === null) throw reject("authorization_absent", "Authorize this package before preparing a run plan", 409);
    if (input.receiptId !== live.receipt.receipt_id) {
      throw reject("receipt_mismatch", "receipt_id does not match this session's current authorization receipt", 409, { session_receipt_id: live.receipt.receipt_id });
    }
    const settings = await this.deps.settings.settings();
    // A hosted provider's key lives in the secret store (T16, D-195): the person unlocks before
    // Prepare, so the probe below is made with the key and the plan is refused by name otherwise.
    const providerId = input.modelId.split("/")[0] ?? "";
    if ((providerId === "openai" || providerId === "anthropic") && (await this.deps.settings.keyPresence())[providerId] === true) {
      const state = await this.secretsState();
      if (state !== "unlocked") throw unavailableStoreError(state);
    }
    // A plan is frozen against what the providers answer now, not against a catalog read up to a
    // minute ago: a provider that stopped answering must refuse the plan by name (D-077).
    const read = await this.catalog(0);
    const { catalog } = read;
    const descriptor = findModel(catalog, input.modelId);
    if (descriptor === null) {
      throw reject("model_unknown", `No model ${pyRepr(input.modelId)} in this browser's model catalog: its provider did not list it. ${this.modelProblem(input.modelId, read)}`, 409);
    }
    if (!descriptor.available) {
      throw reject("model_unavailable", `${input.modelId} is not usable now. ${this.modelProblem(input.modelId, read)}`, 409, { model_id: input.modelId });
    }
    const evaluation = evaluateCatalog(live.pkg, catalog, this.clock());
    const compatibility = evaluation.models.find((item) => item.model_id === input.modelId) ?? null;
    const blockers: Reason[] = [];
    if (PRESETS[settings.preset].local_models_only && descriptor.properties.local !== true) {
      blockers.push({ code: "model_not_local", message: `The ${PRESETS[settings.preset].title} preset allows local models only; ${input.modelId} is not reported as local. Change the preset in Settings → Policies or choose a local model.`, subject: input.modelId });
    }
    // The subscribed policy's model constraints (T8, D-102): local only, or a cost this browser can bound.
    blockers.push(...modelPolicyReasons(await this.activePolicy(), { id: input.modelId, properties: descriptor.properties as { local?: unknown; cost_class?: unknown } }));
    const { registry: toolRegistry, evaluation: toolEvaluation } = await this.toolEvaluation(live, live.receipt.decisions, live.receipt.tool_approvals);
    // A receipt that grants a record needs the memory to prepare (the grant is checked against it); none needs nothing (D-195).
    if (live.receipt.resource_grants.length > 0) await this.memory.unlocked();
    const resourceRegistry = await this.resourceRegistry(live);
    // The origins this plan would reach must be granted before it is frozen (D-193): the page asked
    // Chrome with the click as the gesture; what it did not obtain is refused here by name.
    const approvals = live.receipt.tool_approvals;
    const prospective = planToolBindings(toolEvaluation).filter((item) => approvals[item.tool_id] === true);
    const origins = planOrigins({
      packageUrl: live.stored.source.display,
      toolBindings: toolBindingsForOrigins(prospective, toolRegistry),
      model: { provider_id: descriptor.provider_id, base_url: this.providerOrigin(settings, descriptor.provider_id) },
    });
    const missing = await this.missingOrigins(origins.map((item) => item.origin));
    if (missing.length > 0) {
      blockers.push({ code: "origins_not_granted", message: `This browser is not allowed to reach ${missing.join(", ")}. Allow ${missing.length === 1 ? "it" : "them"} and prepare the plan again.`, subject: missing.join(", ") });
    }
    blockers.push(
      ...preparationBlockers(live.pkg, {
        mode: MODE_MODEL,
        evaluation,
        receipt: live.receipt,
        publisher: live.publisher,
        compatibility,
        policy: DEFAULT_BROWSER_POLICY,
        toolEvaluation,
        resourceRegistry,
      }),
    );
    if (blockers.length > 0) {
      // A run plan exists only when it is ready (runplan.py): every reason is returned so a UI can
      // send the person to the exact control that fixes it.
      throw reject("run_plan_refused", blockers[0]!.message, 409, { blocking_reasons: blockers, missing_origins: missing });
    }
    const plan = await buildRunPlan(live.pkg, {
      sessionId: live.stored.session_id,
      source: sourceRef(live.stored.source),
      archiveSha256: live.stored.archive_sha256,
      evaluation,
      catalog,
      descriptor,
      compatibility,
      receipt: live.receipt,
      publisher: live.publisher,
      trustState: await this.deps.trust.state(),
      evaluationLayers: live.evaluation,
      policy: DEFAULT_BROWSER_POLICY,
      instanceId: await this.deps.settings.instanceId(),
      mode: MODE_MODEL,
      bindingStrategy: "single_model",
      expiresAt: live.stored.expires_at,
      blockingReasons: blockers,
      toolEvaluation,
      toolRegistry,
      resourceRegistry,
      // conversation.v0 (D-271): the subscribed policy's consent section pre-decides or forbids steps.
      consentPolicy: (await this.activePolicy())?.bundle.consent ?? null,
      consentPreset: settings.preset,
      now: this.clock(),
    });
    live.plan = plan;
    await this.persist(live);
    await this.recordPlanOrigins(live, plan, origins);
    this.deps.broadcast({ type: "event.authorization", sessionId: live.stored.session_id });
    this.deps.broadcast({ type: "event.sessions" });
    this.deps.broadcast({ type: "event.permissions" });
    return this.runPlanState(live);
  }

  /** The plan plus a preflight recomputed against the vault, the host registry and the last catalog; `ignoreOnceSpent` for a conversation's later turn (V-13, D-270). */
  async runPlanState(live: LiveSession, options: { ignoreOnceSpent?: boolean } = {}): Promise<RunPlanState> {
    if (live.plan === null) throw reject("run_plan_absent", "This session has no run plan", 404);
    // A plan that grants a record, or binds a host-resource tool, needs the vault's types, which a
    // locked store cannot give (T16, review 1 finding 1): the bindings and the grants are then "not
    // evaluated", never stale; Run says `store_locked` by name (D-195) and the plan is checked
    // again once unlocked.
    const lockedNeedingMemory = planNeedsMemory(live.plan) && (await this.secretsState()) !== "unlocked";
    const toolEvaluation = lockedNeedingMemory ? null : (await this.toolEvaluation(live, live.receipt?.decisions, live.receipt?.tool_approvals)).evaluation;
    const settings = await this.deps.settings.settings();
    const read = await this.currentCatalog();
    const checked = preflight(live.plan, {
      pkg: live.pkg,
      publisher: live.publisher,
      receipt: live.receipt,
      trustState: await this.deps.trust.state(),
      policy: DEFAULT_BROWSER_POLICY,
      toolEvaluation,
      resourceRegistry: await this.resourceRegistryOrNull(live),
      catalog: read.catalog,
      onceSpent: options.ignoreOnceSpent !== true && live.onceSpent && live.receipt !== null && grantsOnce(live.receipt),
      localModelsOnly: PRESETS[settings.preset].local_models_only,
      subscription: await this.activePolicy(),
      now: this.clock(),
    });
    const origins = await this.originsOfPlan(live, live.plan);
    const missing = new Set(await this.missingOrigins(origins.map((item) => item.origin)));
    return { run_plan: live.plan, preflight: { ...checked, stale_reasons: this.explainModelReasons(checked.stale_reasons, read) }, origins: origins.map((item) => ({ ...item, granted: !missing.has(item.origin) })) };
  }

  async clearRunPlan(sessionId: string): Promise<{ cleared: boolean; session_id: string }> {
    const live = await this.session(sessionId);
    const had = live.plan !== null;
    live.plan = null;
    await this.persist(live);
    this.deps.broadcast({ type: "event.authorization", sessionId });
    this.deps.broadcast({ type: "event.sessions" });
    return { cleared: had, session_id: sessionId };
  }

  /** The execution host (T5) records that a run under this receipt began, spending its `once` grants. */
  async markOnceSpent(sessionId: string): Promise<void> {
    const live = await this.session(sessionId);
    live.onceSpent = true;
    await this.persist(live);
    this.deps.broadcast({ type: "event.authorization", sessionId });
  }

  // -- signed documents: agent indexes and the policy subscription (T8) -----------------------------
  /** Verify a stored or fetched document against its pinned key; identical bytes are verified once per worker. */
  private async verifiedDocument(text: string, type: DocumentContentType, key: string): Promise<VerifiedDocument> {
    const bytes = new TextEncoder().encode(text);
    const cacheKey = `${type} ${key} ${await sha256Hex(bytes)}`;
    const cached = this.verifiedDocuments.get(cacheKey);
    if (cached) return cached;
    const verified = await verifySignedDocument(bytes, type, [publicKeyFromRawBase64(key)]);
    if (this.verifiedDocuments.size >= 16) this.verifiedDocuments.delete(this.verifiedDocuments.keys().next().value!);
    this.verifiedDocuments.set(cacheKey, verified);
    return verified;
  }

  /** One signed document over the package download's rules (D-033), bounded at 1 MiB, as UTF-8 text. */
  private async fetchDocument(url: string, subject: "Index" | "Policy"): Promise<string> {
    const bytes = await this.download(url, { subject, cap: MAX_DOCUMENT_BYTES, timeoutMs: DOCUMENT_TIMEOUT_MS });
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw reject("document_invalid", `The ${subject.toLowerCase()} is not UTF-8 text.`, 422);
    }
  }

  /** The key a person pasted, as the raw base64 the stores keep and its fingerprint. */
  private async pinnedKey(pem: string): Promise<{ key: string; fingerprint: string }> {
    let raw: Uint8Array;
    try {
      raw = publicKeyFromPem(pem);
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw reject("key_invalid", "The key must be an Ed25519 public key in PEM form (BEGIN PUBLIC KEY).");
    }
    return { key: rawBase64(raw), fingerprint: await keyFingerprint(raw) };
  }

  /** A newer copy of a document replaces the held one only if it is not older and does not reuse a version for other content. */
  private checkSuccession(held: { version: string; content_sha256: string }, next: { version: string; content_sha256: string }, what: string): void {
    const order = compareRelease(next.version, held.version);
    if (order < 0) throw reject("document_rollback", `The ${what} at this address is now version ${next.version}, older than the version ${held.version} held here; the newer copy is kept.`, 409);
    if (order === 0 && next.content_sha256 !== held.content_sha256) {
      throw reject("document_version_reused", `The ${what} at this address states version ${next.version} again with different content; the copy held here is kept. A changed ${what} must carry a new version.`, 409);
    }
  }

  private failureOf(error: unknown): { code: string; message: string; at: string } {
    return error instanceof CoreError ? { code: error.code, message: error.message, at: this.clock().toISOString() } : { code: "internal_error", message: `The operation failed (${thrownName(error)}).`, at: this.clock().toISOString() };
  }

  private async heldIndex(stored: StoredIndex): Promise<{ held: VerifiedIndex | null; error: string | null }> {
    if (stored.document === null) return { held: null, error: null };
    try {
      return { held: verifiedIndex(await this.verifiedDocument(stored.document.text, AGENT_INDEX_TYPE, stored.key)), error: null };
    } catch (error) {
      return { held: null, error: error instanceof Error ? error.message : "does not verify" };
    }
  }

  private async indexView(stored: StoredIndex): Promise<IndexView> {
    const { held, error } = await this.heldIndex(stored);
    const index = held?.index ?? null;
    return {
      url: stored.url,
      key_fingerprint: stored.key_fingerprint,
      enabled: stored.enabled,
      added_at: stored.added_at,
      fetched_at: stored.document?.fetched_at ?? null,
      state: stored.document === null ? "never_fetched" : held === null ? "unverified" : indexState(held.index, this.clock()),
      index: index ? { index_id: index.index_id, title: index.title, description: index.description, version: index.version, publisher: index.publisher.name, issued_at: index.issued_at, expires_at: index.expires_at, entries: index.entries.length, notes: index.notes } : null,
      signer_fingerprint: held?.signer_fingerprint ?? null,
      content_sha256: held?.content_sha256 ?? null,
      last_error: stored.last_error,
      unverified_reason: held === null ? error : null,
    };
  }

  async indexesView(): Promise<IndexesView> {
    const indexes = await this.subscriptions.indexes();
    return {
      indexes: await Promise.all(indexes.map((stored) => this.indexView(stored))),
      max_indexes: MAX_INDEXES,
      nanda: { configured: false, note: NANDA_NOT_CONFIGURED },
    };
  }

  /** Add an index by URL with the key the person pins for it: fetched and verified now, or not added at all. */
  async addIndex(url: string, pem: string): Promise<IndexesView> {
    validatePackageUrl(url, "Index");
    const pin = await this.pinnedKey(pem);
    const existing = await this.subscriptions.indexes();
    if (existing.some((item) => item.url === url)) throw reject("index_exists", "This index is already added; refresh it instead.", 409);
    if (existing.length >= MAX_INDEXES) throw reject("index_limit", `At most ${MAX_INDEXES} indexes can be added; remove one first.`, 409);
    const text = await this.fetchDocument(url, "Index");
    const held = verifiedIndex(await this.verifiedDocument(text, AGENT_INDEX_TYPE, pin.key));
    for (const other of existing) {
      if ((await this.heldIndex(other)).held?.index.index_id === held.index.index_id) throw reject("index_exists", `An index with the id ${pyRepr(held.index.index_id)} is already added from ${other.url}.`, 409);
    }
    const now = this.clock().toISOString();
    await this.subscriptions.updateIndexes((list) => [...list.filter((item) => item.url !== url), { url, key: pin.key, key_fingerprint: pin.fingerprint, added_at: now, enabled: true, document: { text, fetched_at: now }, last_error: null }]);
    this.deps.broadcast({ type: "event.indexes" });
    return this.indexesView();
  }

  /** Fetch an index again; on any refusal the held copy stays and the failure is recorded beside it. */
  private async refetchIndex(stored: StoredIndex): Promise<StoredIndex> {
    let updated: StoredIndex;
    try {
      const text = await this.fetchDocument(stored.url, "Index");
      const next = verifiedIndex(await this.verifiedDocument(text, AGENT_INDEX_TYPE, stored.key));
      const current = (await this.heldIndex(stored)).held;
      if (current !== null) this.checkSuccession({ version: current.index.version, content_sha256: current.content_sha256 }, { version: next.index.version, content_sha256: next.content_sha256 }, "index");
      updated = { ...stored, document: { text, fetched_at: this.clock().toISOString() }, last_error: null };
    } catch (error) {
      updated = { ...stored, last_error: this.failureOf(error) };
    }
    await this.subscriptions.updateIndexes((list) => list.map((item) => (item.url === stored.url ? updated : item)));
    this.deps.broadcast({ type: "event.indexes" });
    return updated;
  }

  private async storedIndex(url: string): Promise<StoredIndex> {
    const stored = (await this.subscriptions.indexes()).find((item) => item.url === url);
    if (!stored) throw reject("index_unknown", "No index is added from this address.", 404);
    return stored;
  }

  async refreshIndex(url: string): Promise<IndexesView> {
    await this.refetchIndex(await this.storedIndex(url));
    return this.indexesView();
  }

  async removeIndex(url: string): Promise<IndexesView> {
    await this.storedIndex(url);
    await this.subscriptions.updateIndexes((list) => list.filter((item) => item.url !== url));
    this.deps.broadcast({ type: "event.indexes" });
    return this.indexesView();
  }

  async enableIndex(url: string, enabled: boolean): Promise<IndexesView> {
    await this.storedIndex(url);
    await this.subscriptions.updateIndexes((list) => list.map((item) => (item.url === url ? { ...item, enabled } : item)));
    this.deps.broadcast({ type: "event.indexes" });
    return this.indexesView();
  }

  /**
   * Search the enabled indexes in the order they were added (and, for a locator, the NANDA stub).
   * Results are ranked by the trust status of the signer each source claims, then by source order
   * and the index's own order; nothing else (D-104). An index older than an hour is fetched again
   * first, because the person is searching it now; nothing is fetched otherwise.
   */
  async search(text: string): Promise<SearchView> {
    const query = readQuery(text);
    if (query === null) throw reject("invalid_request", "Type what you are looking for: words, or an agent name such as name@host.example.");
    const notes: SearchView["notes"] = [];
    const searched: SearchView["searched"] = [];
    const found: Array<{ candidate: AgentCandidate; order: number }> = [];
    const enabled = (await this.subscriptions.indexes()).filter((item) => item.enabled);
    for (const [order, initial] of enabled.entries()) {
      let stored = initial;
      const now = this.clock().getTime();
      const age = stored.document ? now - Date.parse(stored.document.fetched_at) : Number.POSITIVE_INFINITY;
      const refreshed = age > INDEX_REFRESH_MS;
      // A refresh that failed within the hour is not tried again on every search: each attempt can
      // wait out the document timeout while the host is down (T8 review 1, finding 1). Refresh in
      // Settings → Search always fetches.
      const failedRecently = stored.last_error !== null && now - Date.parse(stored.last_error.at) < INDEX_REFRESH_MS;
      if (refreshed && !failedRecently) stored = await this.refetchIndex(stored);
      const { held, error } = await this.heldIndex(stored);
      if (held === null) {
        notes.push({ source: stored.url, code: stored.last_error?.code ?? "index_unverified", detail: stored.last_error?.message ?? error ?? "This index has no verified copy; refresh it in Settings → Search." });
        continue;
      }
      if (refreshed && stored.last_error !== null) notes.push({ source: held.index.title, code: stored.last_error.code, detail: `Could not refresh it (${stored.last_error.message}); searched the copy fetched ${stored.document?.fetched_at}.` });
      const result = await new StaticIndexResolver(held, this.clock).query(query);
      searched.push({ index_id: held.index.index_id, label: held.index.title, version: held.index.version });
      notes.push(...result.notes.map((note: ResolveNote) => ({ source: held.index.title, code: note.code, detail: note.detail })));
      for (const candidate of result.candidates) found.push({ candidate, order });
    }
    if (query.kind === "locator") {
      const nanda = await new NandaResolver().query(query);
      notes.push(...nanda.notes.map((note) => ({ source: "NANDA index", code: note.code, detail: note.detail })));
    }
    const ranked: Array<SearchResultView & { order: number }> = [];
    for (const { candidate, order } of found) {
      const verdict = await this.trust.evaluate({ signerFingerprint: candidate.signer_fingerprint, claimedPublisherId: candidate.publisher.id ?? "", packageId: candidate.package_id });
      ranked.push({ candidate, trust: { status: verdict.trust_status, reason: candidate.signer_fingerprint === null ? "signer_not_stated" : verdict.trust_reason }, order });
    }
    ranked.sort((a, b) => TRUST_RANK[a.trust.status]! - TRUST_RANK[b.trust.status]! || a.order - b.order || a.candidate.source.position - b.candidate.source.position);
    return { query, results: ranked.map(({ candidate, trust }) => ({ candidate, trust })), notes, searched, enabled_indexes: enabled.length };
  }

  /** The entry an opened search result came from, or null when that index (or the entry) is not held here. */
  private async indexEntry(indexId: string, url: string): Promise<AgentCandidate | null> {
    for (const stored of await this.subscriptions.indexes()) {
      const { held } = await this.heldIndex(stored);
      if (held !== null && held.index.index_id === indexId) return new StaticIndexResolver(held, this.clock).entryFor(url);
    }
    return null;
  }

  /** What the index said, against what the bytes say: metadata compared, never authority. */
  private compareClaims(candidate: AgentCandidate, live: LiveSession): FoundVia {
    return {
      index_id: candidate.source.resolver_id,
      label: candidate.source.label,
      version: candidate.source.version ?? "",
      position: candidate.source.position,
      claims: {
        package_id: claimCheck(candidate.package_id, String(live.pkg.manifest.package_id)),
        version: claimCheck(candidate.version, String(live.pkg.manifest.version)),
        digest: claimCheck(candidate.digest, live.pkg.digest),
        archive_sha256: claimCheck(candidate.archive_sha256, live.stored.archive_sha256),
        signer_fingerprint: claimCheck(candidate.signer_fingerprint, live.publisher.signer_fingerprint),
      },
    };
  }

  // The policy subscription (D-103: one at a time).
  /**
   * The subscribed bundle, verified and read once per stored text and key (T8 review 1, nit 5):
   * `activePolicy` is asked per search candidate and per Library row, and the bytes rarely change.
   */
  private async heldPolicyOf(stored: StoredPolicy): Promise<HeldPolicy> {
    const cached = this.heldPolicyCache;
    if (cached !== null && cached.text === stored.document.text && cached.key === stored.key) return cached.held;
    const held = await heldPolicy(await this.verifiedDocument(stored.document.text, POLICY_BUNDLE_TYPE, stored.key));
    this.heldPolicyCache = { text: stored.document.text, key: stored.key, held };
    return held;
  }

  /** The subscribed policy, when it verifies and is inside its validity window; null otherwise (an expired policy decides nothing). */
  async activePolicy(): Promise<ActivePolicy | null> {
    const stored = await this.subscriptions.policy();
    if (stored === null) return null;
    let held: HeldPolicy;
    try {
      held = await this.heldPolicyOf(stored);
    } catch {
      return null;
    }
    return policyState(held.bundle, this.clock()) === "current" ? { bundle: held.bundle, reference: held.reference } : null;
  }

  async policyView(): Promise<PolicyView> {
    const stored = await this.subscriptions.policy();
    if (stored === null) return { subscribed: false };
    let held: HeldPolicy | null = null;
    try {
      held = await this.heldPolicyOf(stored);
    } catch {
      held = null;
    }
    return {
      subscribed: true,
      url: stored.url,
      key_fingerprint: stored.key_fingerprint,
      subscribed_at: stored.subscribed_at,
      fetched_at: stored.document.fetched_at,
      state: held === null ? "unverified" : policyState(held.bundle, this.clock()),
      reference: held?.reference ?? null,
      bundle: held?.bundle ?? null,
      last_error: stored.last_error,
    };
  }

  /**
   * Subscribe to a policy by URL, verified against the key the person pins. One at a time
   * (D-103): replacing the current one needs `replace`; the same address and key again is a
   * refresh. Only a bundle inside its validity window is taken.
   */
  async subscribePolicy(url: string, pem: string, replace: boolean): Promise<PolicyView> {
    validatePackageUrl(url, "Policy");
    const pin = await this.pinnedKey(pem);
    const current = await this.subscriptions.policy();
    const same = current !== null && current.url === url && current.key === pin.key;
    if (current !== null && !same && !replace) {
      const label = await this.heldPolicyOf(current).then((held) => `${held.reference.title} (${policyLabel(held.reference)})`, () => current.url);
      throw reject("policy_exists", `You already follow ${label}. One policy at a time: replace it to follow this one.`, 409, { current_url: current.url });
    }
    const text = await this.fetchDocument(url, "Policy");
    const held = await heldPolicy(await this.verifiedDocument(text, POLICY_BUNDLE_TYPE, pin.key));
    const state = policyState(held.bundle, this.clock());
    if (state !== "current") throw reject("policy_not_current", `This policy is valid from ${held.bundle.issued_at} to ${held.bundle.expires_at}; it is ${state === "expired" ? "expired" : "not valid yet"} and was not subscribed to.`, 422);
    if (same) {
      const previous = await this.heldPolicyOf(current!).catch(() => null);
      if (previous !== null) this.checkSuccession({ version: previous.bundle.version, content_sha256: previous.reference.content_sha256 }, { version: held.bundle.version, content_sha256: held.reference.content_sha256 }, "policy");
    }
    const now = this.clock().toISOString();
    await this.subscriptions.savePolicy({ url, key: pin.key, key_fingerprint: pin.fingerprint, subscribed_at: same ? current!.subscribed_at : now, document: { text, fetched_at: now }, last_error: null });
    await this.policyChanged();
    return this.policyView();
  }

  /** Fetch the subscribed policy again; a refusal keeps the held copy and is recorded beside it. */
  async refreshPolicy(): Promise<PolicyView> {
    const stored = await this.subscriptions.policy();
    if (stored === null) throw reject("policy_absent", "No policy is subscribed to.", 404);
    try {
      const text = await this.fetchDocument(stored.url, "Policy");
      const next = await heldPolicy(await this.verifiedDocument(text, POLICY_BUNDLE_TYPE, stored.key));
      const previous = await this.heldPolicyOf(stored).catch(() => null);
      if (previous !== null) this.checkSuccession({ version: previous.bundle.version, content_sha256: previous.reference.content_sha256 }, { version: next.bundle.version, content_sha256: next.reference.content_sha256 }, "policy");
      await this.subscriptions.savePolicy({ ...stored, document: { text, fetched_at: this.clock().toISOString() }, last_error: null });
    } catch (error) {
      await this.subscriptions.savePolicy({ ...stored, last_error: this.failureOf(error) });
    }
    await this.policyChanged();
    return this.policyView();
  }

  /** Revoke: the policy's anchors and decisions stop applying, and plans authorized under it go stale (D-102). */
  async unsubscribePolicy(): Promise<PolicyView> {
    await this.subscriptions.savePolicy(null);
    await this.policyChanged();
    return { subscribed: false };
  }

  /** Every open session's trust is evaluated again, and every view reloads its authorization. */
  private async policyChanged(): Promise<void> {
    await this.refreshTrust();
    this.deps.broadcast({ type: "event.policy" });
    for (const sessionId of this.sessions.keys()) this.deps.broadcast({ type: "event.authorization", sessionId });
  }

  // -- the Library (T8) --------------------------------------------------------------------------
  private libraryEntry(live: LiveSession): LibraryEntry {
    const manifest = live.pkg.manifest;
    const publisher = manifest.publisher as JsonObject;
    return {
      package_url: live.stored.source.display,
      advertised_on: live.stored.source.advertised_on,
      package_id: String(manifest.package_id),
      name: String(manifest.name),
      version: String(manifest.version),
      publisher: { id: String(publisher.id), name: String(publisher.name) },
      digest: live.pkg.digest,
      archive_sha256: live.stored.archive_sha256,
      signer_fingerprint: live.publisher.signer_fingerprint,
      at: this.clock().toISOString(),
    };
  }

  /** An agent opened by its address joins the recent list (newest first). */
  private async rememberRecent(live: LiveSession): Promise<void> {
    const entry = this.libraryEntry(live);
    await this.subscriptions.updateLibrary((library) => ({ ...library, recent: [entry, ...library.recent.filter((item) => item.package_url !== entry.package_url)] }));
    this.deps.broadcast({ type: "event.library" });
  }

  async libraryView(): Promise<LibraryView> {
    const library = await this.subscriptions.library();
    const pinnedUrls = new Set(library.pinned.map((entry) => entry.package_url));
    const item = async (entry: LibraryEntry): Promise<LibraryItemView> => {
      const verdict = await this.trust.evaluate({ signerFingerprint: entry.signer_fingerprint, claimedPublisherId: entry.publisher.id, packageId: entry.package_id });
      const open = [...this.sessions.values()].find((live) => live.stored.source.display === entry.package_url && live.stored.archive_sha256 === entry.archive_sha256);
      return { ...entry, trust_status: verdict.trust_status, trust_reason: verdict.trust_reason, pinned: pinnedUrls.has(entry.package_url), open_session_id: open?.stored.session_id ?? null };
    };
    return { pinned: await Promise.all(library.pinned.map(item)), recent: await Promise.all(library.recent.map(item)) };
  }

  async pinToLibrary(sessionId: string): Promise<LibraryView> {
    const entry = this.libraryEntry(await this.session(sessionId));
    await this.subscriptions.updateLibrary((library) => {
      const others = library.pinned.filter((item) => item.package_url !== entry.package_url);
      // Refused by name, as `addIndex` does, rather than silently dropping the oldest pin (T8 review 1, nit 6).
      if (others.length >= MAX_PINNED) throw reject("library_limit", `At most ${MAX_PINNED} agents can be pinned; unpin one first.`, 409);
      return { ...library, pinned: [entry, ...others] };
    });
    this.deps.broadcast({ type: "event.library" });
    this.deps.broadcast({ type: "event.sessions" });
    return this.libraryView();
  }

  async unpinFromLibrary(packageUrl: string): Promise<LibraryView> {
    await this.subscriptions.updateLibrary((library) => ({ ...library, pinned: library.pinned.filter((item) => item.package_url !== packageUrl) }));
    this.deps.broadcast({ type: "event.library" });
    this.deps.broadcast({ type: "event.sessions" });
    return this.libraryView();
  }

  async forgetRecent(packageUrl: string): Promise<LibraryView> {
    await this.subscriptions.updateLibrary((library) => ({ ...library, recent: library.recent.filter((item) => item.package_url !== packageUrl) }));
    this.deps.broadcast({ type: "event.library" });
    return this.libraryView();
  }

  // -- status ----------------------------------------------------------------------------
  async status(): Promise<StatusInfo> {
    const stored = await this.deps.snapshots.listSnapshots();
    const available = this.deps.host.available();
    return {
      version: this.version,
      core_version: CORE_VERSION,
      runtime_version: SUPPORTED_RUNTIME_VERSION,
      sessions: this.sessions.size,
      max_sessions: this.limits.maxSessions,
      cached_bytes: stored.reduce((sum, item) => sum + item.bytes, 0),
      max_cache_bytes: this.limits.maxCacheBytes,
      session_ttl_seconds: this.limits.sessionTtlSeconds,
      execution: available ? "enabled" : "disabled",
      execution_limits: available ? await this.runs.hostLimits() : null,
      runs: { active: await this.runs.activeCount(), stored: await this.runs.storedCount() },
      secrets: await this.secretsState(),
    };
  }
}

/** The stored keychain record when it belongs to the envelope created at `createdAt` (T17). */
function keychainFor(record: KeychainRecord | null, createdAt: string | null): KeychainRecord | null {
  return record !== null && createdAt !== null && record.envelope_created_at === createdAt ? record : null;
}

/** What a failed helper call means for Settings → Security's keychain card. */
function helperProblem(error: unknown): { state: KeychainView["helper"]; code: string; message: string } {
  if (error instanceof CoreError) {
    if (error.code === "helper_not_installed") return { state: "not_installed", code: error.code, message: error.message };
    if (error.code === "helper_forbidden") return { state: "forbidden", code: error.code, message: error.message };
    if (error.code === "helper_refused") return { state: "refused", code: String(error.details.helper_code ?? "unknown"), message: error.message };
    return { state: "failed", code: error.code, message: error.message };
  }
  return { state: "failed", code: "helper_failed", message: error instanceof Error ? error.message : "unknown error" };
}

/** Whether a stored run's proposals were offered to the person (memory.v0 M-41, D-223): it completed, and the record says `offered > 0` with no reason. */
function proposalsOffered(run: { record: { status: string; memory?: unknown } }): boolean {
  const memory = (run.record.memory ?? null) as { proposals?: { offered?: number; reason?: string | null } | null } | null;
  const facts = memory?.proposals ?? null;
  return run.record.status === "completed" && facts !== null && (facts.offered ?? 0) > 0 && (facts.reason ?? null) === null;
}
