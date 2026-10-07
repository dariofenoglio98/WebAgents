/**
 * The service worker's logic, with every Chrome and network dependency injected so it can
 * be tested in Node (D-035). It owns candidates per tab, sessions and their snapshots, and
 * the trust store; the side panel and the full page are views over it.
 *
 * Opening a package follows the control plane's lifecycle: bytes are captured exactly once,
 * hashed, stored, and every later answer about the session derives from the stored bytes;
 * container, integrity, schema and runtime are reported as separate layers; signature
 * validity and publisher trust are separate facts; a trust change re-evaluates every open
 * session. Nothing here executes a package.
 */
import { agentPageModel } from "../../core/agent-page.js";
import { MAX_ARCHIVE_BYTES } from "../../core/archive.js";
import { classifyLinks, DEFAULT_LIMITS, discoverFromPage, mediaType, type FetchedPage } from "../../core/discovery.js";
import { CoreError } from "../../core/errors.js";
import { evaluateSnapshot, evaluationLayers, publisherReport, structurallyValid, type EvaluationLayers, type PublisherReport } from "../../core/evaluation.js";
import { sha256Hex } from "../../core/hash.js";
import { publicKeyFromPem } from "../../core/keys.js";
import type { Package } from "../../core/package.js";
import { documentUrl, origin, originText, sameOrigin, validatePackageUrl } from "../../core/policy.js";
import { buildSummary, type BrowserSummary } from "../../core/summary.js";
import { pyRepr } from "../../core/repr.js";
import { pinPackagePublisher, type TrustStore } from "../../core/trust.js";
import { CORE_VERSION, SUPPORTED_RUNTIME_VERSION } from "../../core/version.js";
import {
  type CandidateState,
  type ContentMessage,
  type Event,
  type PinResult,
  type Request,
  type SessionDescriptor,
  type SessionSource,
  type SessionView,
  type StatusInfo,
  type TrustList,
  type WebsiteResult,
} from "../messages.js";
import type { SnapshotStore, StoredSession } from "../storage/snapshots.js";
import type { TabStateStore } from "../storage/tab-state.js";

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
  badge: (tabId: number, count: number) => Promise<void>;
  broadcast: (event: Event) => void;
  clock?: () => Date;
  randomId?: () => string;
  limits?: Partial<Limits>;
  version?: string;
}

interface LiveSession {
  stored: StoredSession;
  pkg: Package;
  evaluation: EvaluationLayers;
  publisher: PublisherReport;
  summary: BrowserSummary;
}

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
}

const EXECUTION_NOTE = "Opening and inspecting a package never executes it.";

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

export class Controller {
  private readonly sessions = new Map<string, LiveSession>();
  /** Which views currently show each session (review 2, nit 5): a release closes it only when none is left. */
  private readonly holders = new Map<string, Set<string>>();
  /** Archive hashes of opens in progress (review 2, nit 6): their snapshots are never dropped as orphans. */
  private readonly inFlight = new Map<string, number>();
  private readonly limits: Limits;
  private readonly clock: () => Date;
  private readonly randomId: () => string;
  private readonly version: string;
  private restored: Promise<void> | null = null;

  constructor(private readonly deps: ControllerDeps) {
    this.limits = { ...DEFAULT_CONTROLLER_LIMITS, ...(deps.limits ?? {}) };
    this.clock = deps.clock ?? (() => new Date());
    this.randomId = deps.randomId ?? (() => crypto.randomUUID().replace(/-/gu, "").slice(0, 24));
    this.version = deps.version ?? CORE_VERSION;
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
        const view = await this.openUrl(request.url, request.advertisedOn ?? null);
        if (request.viewId) this.hold(view.session.id, request.viewId);
        return view;
      }
      case "package.get": {
        const live = await this.session(request.sessionId);
        if (request.viewId) this.hold(request.sessionId, request.viewId);
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
      throw reject("discovery_failed", `Reading the website failed: ${error instanceof Error ? error.name : "error"}`, 502);
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
  async openUrl(url: string, advertisedOn: string | null): Promise<SessionView> {
    const { hostname } = validatePackageUrl(url);
    void hostname;
    if (advertisedOn !== null) documentUrl(advertisedOn);
    const bytes = await this.download(url);
    const source: SessionSource = {
      kind: advertisedOn === null ? "url" : "website",
      display: url,
      advertised_on: advertisedOn,
      opened_at: this.clock().toISOString(),
    };
    return this.openBytes(bytes, source);
  }

  private async download(url: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.downloadTimeoutMs);
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
      if (controller.signal.aborted) throw reject("download_timeout", "Package download deadline exceeded", 504);
      throw reject("download_failed", `Cannot connect to package host: ${error instanceof Error ? error.name : "error"}`, 502);
    }
    try {
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw reject(
          "download_redirect_denied",
          "Package host returned a redirect; redirects are disabled because each hop would need the full destination policy re-applied",
          502,
        );
      }
      if (response.status !== 200) throw reject("download_failed", `Package host returned HTTP ${response.status}`, 502);
      const declared = response.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isInteger(length) || length < 0) throw reject("download_failed", "Package host sent an invalid Content-Length", 502);
        if (length > this.limits.maxPackageBytes) {
          throw reject("download_too_large", `Declared package size exceeds the ${this.limits.maxPackageBytes}-byte limit`, 413);
        }
      }
      const { bytes, truncated } = await this.readBounded(response, this.limits.maxPackageBytes, controller.signal, "download");
      if (truncated) throw reject("download_too_large", `Package exceeds the ${this.limits.maxPackageBytes}-byte download limit`, 413);
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
      throw reject(failedCode, `${operation === "download" ? "Package download" : "Reading the website"} failed: ${error instanceof Error ? error.name : "error"}`, 502);
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

  private async evaluate(stored: StoredSession, pkg: Package, layers: EvaluationLayers): Promise<LiveSession> {
    const publisher = await publisherReport(pkg, this.deps.trust);
    const summary = await buildSummary(pkg, { evaluation: layers, publisher });
    return { stored, pkg, evaluation: layers, publisher, summary };
  }

  private view(live: LiveSession): SessionView {
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
      execution: { performed: false, note: EXECUTION_NOTE },
    };
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
      }
    })();
    this.restored = attempt.catch((error: unknown) => {
      this.restored = null;
      throw error;
    });
    return this.restored;
  }

  /** Delete a snapshot no stored session refers to, unless another open of the same bytes is in flight. */
  private async dropOrphanSnapshot(archiveSha256: string): Promise<void> {
    if ((this.inFlight.get(archiveSha256) ?? 0) > 1) return; // another open owns these bytes right now
    const referenced = (await this.deps.snapshots.listSessions()).some((session) => session.archive_sha256 === archiveSha256);
    if (!referenced) await this.deps.snapshots.deleteSnapshot(archiveSha256);
  }

  // -- views ------------------------------------------------------------------------
  private hold(sessionId: string, viewId: string): void {
    const set = this.holders.get(sessionId) ?? new Set<string>();
    set.add(viewId);
    this.holders.set(sessionId, set);
  }

  /**
   * A view stops showing a session. The session ends only when no other view holds it, so
   * Close in the side panel leaves a full page on the same session intact (review 2, nit 5).
   */
  async release(sessionId: string, viewId: string): Promise<{ closed: boolean; session_id: string; holders: number }> {
    const live = await this.session(sessionId);
    const set = this.holders.get(sessionId);
    set?.delete(viewId);
    const remaining = set?.size ?? 0;
    if (remaining > 0) return { closed: false, session_id: sessionId, holders: remaining };
    this.holders.delete(sessionId);
    await this.drop(live.stored);
    this.deps.broadcast({ type: "event.sessions" });
    return { closed: true, session_id: sessionId, holders: 0 };
  }

  private async session(sessionId: string): Promise<LiveSession> {
    await this.purgeExpired();
    const live = this.sessions.get(sessionId);
    if (!live) throw reject("session_unknown", "Unknown or expired session", 404);
    return live;
  }

  private async drop(stored: StoredSession): Promise<void> {
    this.sessions.delete(stored.session_id);
    this.holders.delete(stored.session_id);
    await this.deps.snapshots.deleteSession(stored.session_id);
    if (this.inFlight.has(stored.archive_sha256)) return; // an open in progress owns the snapshot
    const others = (await this.deps.snapshots.listSessions()).some((session) => session.archive_sha256 === stored.archive_sha256);
    if (!others) await this.deps.snapshots.deleteSnapshot(stored.archive_sha256);
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
    if (this.sessions.size >= this.limits.maxSessions) {
      throw reject("session_limit_reached", `At most ${this.limits.maxSessions} packages can be open; close one first`, 429);
    }
    const stored = await this.deps.snapshots.listSnapshots();
    const cached = stored.reduce((sum, item) => sum + item.bytes, 0);
    const already = stored.some((item) => item.archive_sha256 === archiveSha256);
    if (!already && cached + incoming > this.limits.maxCacheBytes) {
      throw reject("cache_limit_reached", "The snapshot cache is full; close a package first", 429);
    }
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
    for (const [id, live] of this.sessions) this.sessions.set(id, await this.evaluate(live.stored, live.pkg, live.evaluation));
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

  // -- status ----------------------------------------------------------------------------
  async status(): Promise<StatusInfo> {
    const stored = await this.deps.snapshots.listSnapshots();
    return {
      version: this.version,
      core_version: CORE_VERSION,
      runtime_version: SUPPORTED_RUNTIME_VERSION,
      sessions: this.sessions.size,
      max_sessions: this.limits.maxSessions,
      cached_bytes: stored.reduce((sum, item) => sum + item.bytes, 0),
      max_cache_bytes: this.limits.maxCacheBytes,
      session_ttl_seconds: this.limits.sessionTtlSeconds,
      execution: "disabled",
    };
  }
}
