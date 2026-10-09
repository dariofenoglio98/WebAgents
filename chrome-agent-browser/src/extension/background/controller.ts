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
import { buildHostToolRegistry, evaluateRegistry, type RegistryEvaluation, type ToolRegistry } from "../../core/hosttools.js";
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
import type { Package } from "../../core/package.js";
import { documentUrl, origin, originText, sameOrigin, validatePackageUrl } from "../../core/policy.js";
import { readProfiles, type Profile } from "../../core/profiles.js";
import { buildRunPlan, grantsOnce, MODE_MODEL, modePermissionIds, preflight, preparationBlockers } from "../../core/runplan.js";
import { buildSummary, type BrowserSummary } from "../../core/summary.js";
import { pyRepr } from "../../core/repr.js";
import { pinPackagePublisher, type TrustStore } from "../../core/trust.js";
import { DEFAULT_BROWSER_POLICY, DENY, type AuthorizationReceipt, type Decision, type PresetId, type Provenance, type Reason, type RunPlan, type SourceRef } from "../../core/types.js";
import { Vault, type VaultDocument } from "../../core/vault.js";
import { CORE_VERSION, SUPPORTED_RUNTIME_VERSION } from "../../core/version.js";
import demoHostResources from "../data/demo-host-resources.json" with { type: "json" };
import {
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
  type PinResult,
  type ProbeView,
  type Request,
  type RunPlanState,
  type RunView,
  type SessionDescriptor,
  type SessionSource,
  type SessionView,
  type SettingsView,
  type StatusInfo,
  type ToolOffer,
  type TrustList,
  type VaultView,
  type WebsiteResult,
} from "../messages.js";
import { FileRefusal, MemoryFileStore, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_FILE_BYTES, newFile, viewOf, type FileStore } from "../storage/files.js";
import { connectionsFor, endpointProblem, MemoryStorageArea, normalizeSettings, settingsProblem, type Settings, type SettingsStorage } from "../storage/settings.js";
import type { SnapshotStore, StoredSession } from "../storage/snapshots.js";
import { MAX_INDEXES, MAX_PINNED, SubscriptionStorage, type LibraryEntry, type StoredIndex, type StoredPolicy } from "../storage/subscriptions.js";
import type { TabStateStore } from "../storage/tab-state.js";
import type { ViewHolder, ViewHolderStore } from "../storage/view-holders.js";
import type { RunStore } from "../storage/runs.js";
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

/** The demo host's resource types (schemas and sealed fields only; no record). */
function demoTypes(): Array<Omit<VaultDocument["types"][number], never>> {
  return demoHostResources.types.map((type) => ({
    id: type.id,
    display_name: type.display_name,
    description: type.description ?? null,
    permission_kind: type.permission_kind,
    schema: type.schema as unknown as JsonObject,
    sealed_fields: type.sealed_fields ?? [],
  }));
}

/** The host implementation each declared tool would be bound to, as a policy's binding allowlist judges it (T8). */
function bindingFacts(evaluation: RegistryEvaluation): Record<string, ToolBindingFacts | null> {
  const facts: Record<string, ToolBindingFacts | null> = {};
  for (const tool of evaluation.tools) facts[tool.tool_id] = tool.binding ? { kind: tool.binding.implementation_kind, origin: tool.binding.endpoint_origin } : null;
  return facts;
}

const claimCheck = (claimed: string | null, actual: string | null): ClaimCheck => (claimed === null ? "not_stated" : claimed === actual ? "matches" : "differs");

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

  /** Runs from the browser (T5): decides whether a run starts; the host executes. */
  readonly runs: RunManager;

  constructor(private readonly deps: ControllerDeps) {
    this.limits = { ...DEFAULT_CONTROLLER_LIMITS, ...(deps.limits ?? {}) };
    this.clock = deps.clock ?? (() => new Date());
    this.randomId = deps.randomId ?? (() => crypto.randomUUID().replace(/-/gu, "").slice(0, 24));
    this.version = deps.version ?? CORE_VERSION;
    this.files = deps.files ?? new MemoryFileStore();
    this.subscriptions = deps.subscriptions ?? new SubscriptionStorage(new MemoryStorageArea());
    this.trust = new PolicyTrust(deps.trust, () => this.activePolicy());
    const hooks: RunHooks = {
      session: async (sessionId) => {
        const live = await this.session(sessionId);
        return { stored: live.stored, pkg: live.pkg, plan: live.plan, onceSpent: live.onceSpent };
      },
      isSessionOpen: (sessionId) => this.sessions.has(sessionId),
      preflight: async (sessionId) => (await this.runPlanState(await this.session(sessionId))).preflight,
      toolRegistry: async (sessionId) => this.toolRegistry(await this.session(sessionId)),
      vault: () => this.vault(),
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
    };
    this.runs = new RunManager({ runs: deps.runs, host: deps.host, settings: deps.settings, hooks, broadcast: deps.broadcast, clock: this.clock, randomId: deps.runId, runtimeVersion: this.version });
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
      case "vault.get":
        return this.vaultView();
      case "vault.putRecord":
        return this.putVaultRecord(request.record);
      case "vault.deleteRecord":
        return this.deleteVaultRecord(request.recordId);
      case "vault.installDemo":
        return this.installDemo(request.records);
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
    }
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
   * Whether anything still needs these bytes: a stored session, or a run in flight that was
   * planned on them. The execution host reads a run's snapshot only after `host.start`, so Run
   * followed at once by Close must not take the bytes away from the run (T5 review 1, nit 7);
   * the snapshot goes when that run settles (`RunHooks.runSettled`).
   */
  private async snapshotReferenced(archiveSha256: string): Promise<boolean> {
    if ((await this.deps.snapshots.listSessions()).some((session) => session.archive_sha256 === archiveSha256)) return true;
    return (await this.deps.runs.listRuns()).some((run) => !isTerminal(run.record.status) && run.invocation.archive_sha256 === archiveSha256);
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
    let ended = 0;
    for (const live of oldest) {
      if (ended >= count) break;
      if (inFlight.has(live.stored.session_id)) continue;
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

  // -- settings, keys and the vault (D-050, D-051, D-055) ------------------------------------
  /** The opening, not only the opened vault, so concurrent first calls share one key and one document (review 1, nit 12). */
  private vaultCache: Promise<Vault> | null = null;

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
      throw reject("invalid_request", error instanceof Error ? error.message : "invalid key");
    }
    this.invalidateCatalog();
    this.deps.broadcast({ type: "event.settings" });
    return this.settingsView();
  }

  private vault(): Promise<Vault> {
    if (!this.vaultCache) {
      this.vaultCache = this.openVault().catch((error: unknown) => {
        this.vaultCache = null; // a failed opening is retried by the next call
        throw error;
      });
    }
    return this.vaultCache;
  }

  private async openVault(): Promise<Vault> {
    const key = await this.deps.settings.vaultKey();
    let document = await this.deps.settings.vaultDocument();
    let vault: Vault;
    try {
      vault = await Vault.open(key, document);
    } catch (error) {
      // A document this build cannot read is left in place and reported, never silently replaced.
      throw reject("vault_unreadable", `The stored vault could not be opened: ${error instanceof Error ? error.message : "invalid"}`, 500);
    }
    // A fresh profile starts with the demo host's resource *types* (schemas, no personal data), so
    // a package's requests can be explained and records can be created; records are never pre-filled.
    if (vault.typeViews().length === 0 && document.records.length === 0) {
      for (const type of demoTypes()) await vault.putType(type);
      document = vault.toDocument();
      await this.deps.settings.saveVaultDocument(document);
    }
    return vault;
  }

  private async saveVault(vault: Vault): Promise<void> {
    await this.deps.settings.saveVaultDocument(vault.toDocument());
    this.vaultCache = Promise.resolve(vault);
    this.deps.broadcast({ type: "event.vault" });
  }

  async vaultView(): Promise<VaultView> {
    const vault = await this.vault();
    return { types: vault.typeViews(), records: vault.recordViews(), demo_available: true };
  }

  async putVaultRecord(raw: unknown): Promise<VaultView> {
    const vault = await this.vault();
    try {
      await vault.putRecord(raw, { allowReplace: true, now: this.clock() });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw reject("vault_invalid", error instanceof Error ? error.message : "invalid record");
    }
    await this.saveVault(vault);
    return this.vaultView();
  }

  async deleteVaultRecord(recordId: string): Promise<VaultView> {
    const vault = await this.vault();
    if (!vault.deleteRecord(recordId)) throw reject("vault_record_unknown", `No vault record ${pyRepr(recordId)}`, 404);
    await this.saveVault(vault);
    return this.vaultView();
  }

  /** Add the clearly labelled fictional demo set: its types always, its records only when asked. */
  async installDemo(records: boolean): Promise<VaultView> {
    const vault = await this.vault();
    for (const type of demoTypes()) if (!vault.typeViews().some((existing) => existing.id === type.id)) await vault.putType(type);
    if (records) {
      for (const resource of demoHostResources.resources) {
        await vault.putRecord({ id: resource.id, type: resource.type, label: resource.label, value: resource.value as unknown as JsonObject, demo: true }, { allowReplace: true, now: this.clock() });
      }
    }
    await this.saveVault(vault);
    return this.vaultView();
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
  private async resourceRegistry(): Promise<ResourceRegistry> {
    return (await this.vault()).registry({ runtimeVersion: this.version, now: this.clock() });
  }

  private async toolRegistry(live: LiveSession): Promise<ToolRegistry> {
    const types = (await this.vault()).typeViews().map((type) => ({ id: type.id, display_name: type.display_name, permission_kind: type.permission_kind, schema_sha256: type.schema_sha256 }));
    const contactConfigured = (await this.deps.settings.settings()).services.crossref_contact !== null;
    return buildHostToolRegistry(live.pkg, { resourceTypes: types, runtimeVersion: this.version, now: this.clock(), contactConfigured });
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
    const vault = await this.vault();
    const registry = await this.resourceRegistry();
    const profiles = readProfiles(live.pkg);
    const requestedTypes = (live.pkg.policy.permissions as JsonObject[])
      .filter((permission) => RESOURCE_PERMISSION_KINDS.includes(String(permission.kind)))
      .flatMap((permission) => (permission.resources as JsonValue[]).map(String));
    const known = new Set(vault.typeViews().map((type) => type.id));
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
    input: { packageDigest: string; decisions: Record<string, string>; toolApprovals: Record<string, boolean>; resourceSelections: Record<string, string>; provenance: unknown | null; prepare: boolean; modelId?: string | null },
  ): Promise<AuthorizeResult> {
    const live = await this.session(sessionId);
    this.requireDigest(live, input.packageDigest);
    const decisions = normalizeDecisions(live.pkg, input.decisions);
    const approvals = normalizeToolApprovals(live.pkg, input.toolApprovals);
    const registry = await this.resourceRegistry();
    const grants = normalizeResourceSelections(live.pkg, registry, decisions, input.resourceSelections);
    // A `policy` claim is checked against the policy in force now (D-102); with one in force the receipt names it.
    const policy = await this.activePolicy();
    const expand = policy ? this.decider(live.pkg, policy, bindingFacts((await this.toolEvaluation(live)).evaluation)) : null;
    const provenance = normalizeProvenance(live.pkg, input.provenance, decisions, approvals, grants, { policy: policy && expand ? { reference: policy.reference, expand } : null });
    return this.issue(live, decisions, approvals, grants, registry, provenance, input.prepare, input.modelId ?? null);
  }

  /** The two-click path (D-022): a selected profile becomes decisions under the current preset, with the person's picks. */
  async useProfile(sessionId: string, input: { packageDigest: string; profileId: string; resourceSelections: Record<string, string>; prepare: boolean }): Promise<AuthorizeResult> {
    const live = await this.session(sessionId);
    this.requireDigest(live, input.packageDigest);
    const profiles = readProfiles(live.pkg);
    const profile = profiles.profiles?.find((item) => item.id === input.profileId);
    if (!profile) throw reject("profile_unknown", `This package declares no usable profile ${pyRepr(input.profileId)}`, 404, { notes: profiles.notes });
    const settings = await this.deps.settings.settings();
    const policy = await this.activePolicy();
    const decided: Decided = this.decider(live.pkg, policy, bindingFacts((await this.toolEvaluation(live)).evaluation))(profile, settings.preset);
    const registry = await this.resourceRegistry();
    const grants = normalizeResourceSelections(live.pkg, registry, decided.decisions, input.resourceSelections);
    const provenance: Provenance = { ...decided.provenance, resource_selections: Object.fromEntries(grants.map((grant) => [grant.permission_id, "user" as const])) };
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
    const resourceRegistry = await this.resourceRegistry();
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
      throw reject("run_plan_refused", blockers[0]!.message, 409, { blocking_reasons: blockers });
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
      now: this.clock(),
    });
    live.plan = plan;
    await this.persist(live);
    this.deps.broadcast({ type: "event.authorization", sessionId: live.stored.session_id });
    this.deps.broadcast({ type: "event.sessions" });
    return this.runPlanState(live);
  }

  /** The plan plus a preflight recomputed against the vault, the host registry and the last catalog. */
  async runPlanState(live: LiveSession): Promise<RunPlanState> {
    if (live.plan === null) throw reject("run_plan_absent", "This session has no run plan", 404);
    const { evaluation: toolEvaluation } = await this.toolEvaluation(live, live.receipt?.decisions, live.receipt?.tool_approvals);
    const settings = await this.deps.settings.settings();
    const read = await this.currentCatalog();
    const checked = preflight(live.plan, {
      pkg: live.pkg,
      publisher: live.publisher,
      receipt: live.receipt,
      trustState: await this.deps.trust.state(),
      policy: DEFAULT_BROWSER_POLICY,
      toolEvaluation,
      resourceRegistry: await this.resourceRegistry(),
      catalog: read.catalog,
      onceSpent: live.onceSpent && live.receipt !== null && grantsOnce(live.receipt),
      localModelsOnly: PRESETS[settings.preset].local_models_only,
      subscription: await this.activePolicy(),
      now: this.clock(),
    });
    return { run_plan: live.plan, preflight: { ...checked, stale_reasons: this.explainModelReasons(checked.stale_reasons, read) } };
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
    };
  }
}
