/**
 * The service worker's logic with every dependency in memory (D-035): the control plane's
 * open lifecycle, the URL and download policy (D-026, D-033), layered refusals, trust
 * decisions (D-006), candidates from content scripts, website discovery, and the session
 * and snapshot rules of D-032.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import { publicKeyToPem } from "../../src/core/keys.js";
import { MemoryTrustStorage } from "../../src/core/trust.js";
import type { CandidateState, PinResult, SessionDescriptor, SessionView, StatusInfo, TrustList, WebsiteResult } from "../../src/extension/messages.js";
import type { Sender } from "../../src/extension/background/controller.js";
import { MemorySnapshotStore, type StoredSession } from "../../src/extension/storage/snapshots.js";
import { MemoryTabStateStore } from "../../src/extension/storage/tab-state.js";
import { generateKeyPair } from "../helpers/keys.js";
import { readBytes, readText, SHIPPED } from "../helpers/paths.js";
import {
  LITERATURE_URL,
  makeHarness,
  PACKAGE_MEDIA_TYPE,
  PACKAGE_URL,
  PAGE,
  PAGE_IN_TAB,
  SITE_ORIGIN,
  TAB,
  tamperedWebair,
  traversalArchive,
  type Harness,
} from "../helpers/shell.js";

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

const open = (h: Harness, url = PACKAGE_URL, advertisedOn: string | null = `${SITE_ORIGIN}/`): Promise<SessionView> =>
  h.controller.handle({ type: "package.open", url, advertisedOn }, PAGE) as Promise<SessionView>;
const get = (h: Harness, sessionId: string): Promise<SessionView> => h.controller.handle({ type: "package.get", sessionId }, PAGE) as Promise<SessionView>;
const sessions = async (h: Harness): Promise<SessionDescriptor[]> =>
  ((await h.controller.handle({ type: "sessions.list" }, PAGE)) as { sessions: SessionDescriptor[] }).sessions;
const trustList = (h: Harness): Promise<TrustList> => h.controller.handle({ type: "trust.list" }, PAGE) as Promise<TrustList>;
const WEBAIR_BYTES = readBytes(SHIPPED.webair.archive).length;

describe("opening a package (control.py::_open_bytes)", () => {
  it("captures the bytes once, evaluates every layer and reports signature and trust separately", async () => {
    const h = makeHarness();
    const view = await open(h);
    expect(view.snapshot).toEqual({ archive_sha256: SHIPPED.webair.archiveSha256, archive_bytes: WEBAIR_BYTES, captured_once: true });
    expect(view.summary.package.digest).toBe(SHIPPED.webair.digest);
    expect(view.page.technical.digest).toBe(SHIPPED.webair.digest);
    expect(view.page.technical.archive_sha256).toBe(SHIPPED.webair.archiveSha256);
    expect(view.page.trust).toMatchObject({
      signature_status: "valid",
      trust_status: "unknown",
      headline: "Signed, publisher unknown",
      signer_fingerprint: SHIPPED.webair.fingerprint,
      can_pin: true,
    });
    expect(view.summary.validation).toMatchObject({ container_status: "valid", integrity_status: "valid", schema_status: "valid", runtime_status: "compatible" });
    expect(view.source).toMatchObject({ kind: "website", display: PACKAGE_URL, advertised_on: `${SITE_ORIGIN}/` });
    expect(view.page.source).toEqual({ kind: "website", display: PACKAGE_URL, advertised_on: `${SITE_ORIGIN}/` });
    expect(view.execution).toEqual({ performed: false, note: expect.stringContaining("never executes") });
    expect(view.session).toMatchObject({ id: "session1", ttl_seconds: 7200, created_at: "2026-10-06T12:00:00.000Z", expires_at: "2026-10-06T14:00:00.000Z" });
    expect(await h.snapshots.listSnapshots()).toEqual([{ archive_sha256: SHIPPED.webair.archiveSha256, bytes: WEBAIR_BYTES }]);
    expect(h.events).toContainEqual({ type: "event.sessions" });
    const request = h.fetchLog.find((entry) => entry.url === PACKAGE_URL)!;
    expect(request.init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(h.trustStorage.writes).toBe(0);
  });

  it("answers package.get and sessions.list from the stored session", async () => {
    const h = makeHarness();
    const opened = await open(h);
    const again = await get(h, opened.session.id);
    expect(again).toEqual(opened);
    expect(h.fetchLog.filter((entry) => entry.url === PACKAGE_URL)).toHaveLength(1);
    expect(await sessions(h)).toEqual([
      expect.objectContaining({
        session_id: "session1",
        package_id: SHIPPED.webair.packageId,
        name: "WebAir Travel Agent",
        version: SHIPPED.webair.version,
        digest: SHIPPED.webair.digest,
        archive_sha256: SHIPPED.webair.archiveSha256,
        signature_status: "valid",
        trust_status: "unknown",
      }),
    ]);
  });

  it("opened by URL alone, the source says so", async () => {
    const h = makeHarness();
    const view = await open(h, PACKAGE_URL, null);
    expect(view.source.kind).toBe("url");
    expect(view.page.source).toEqual({ kind: "url", display: PACKAGE_URL, advertised_on: null });
  });

  it("the same bytes opened twice share one snapshot and get two sessions", async () => {
    const h = makeHarness();
    const first = await open(h);
    const second = await open(h, PACKAGE_URL, null);
    expect(second.session.id).not.toBe(first.session.id);
    expect(await h.snapshots.listSnapshots()).toHaveLength(1);
    expect(await sessions(h)).toHaveLength(2);
  });

  it("refuses requests that are not from the extension's own pages, and accepts the full page in a tab", async () => {
    const h = makeHarness();
    expect((await refused(h.controller.handle({ type: "status.get" }, TAB))).code).toBe("not_allowed");
    const status = (await h.controller.handle({ type: "status.get" }, PAGE_IN_TAB)) as StatusInfo;
    expect(status.execution).toBe("enabled");
  });
});

describe("the URL policy applies before any request (D-026)", () => {
  const cases = [
    "http://webair.example/agent.pkg",
    "https://203.0.113.5/agent.pkg",
    "https://[2001:db8::1]/agent.pkg",
    "https://localhost/agent.pkg",
    "https://webair.localhost/agent.pkg",
    "https://webair.local/agent.pkg",
    "https://user:pw@webair.example/agent.pkg",
    "https://webair.example:8443/agent.pkg",
    "https://webair.example/agent.pkg#fragment",
    "https://webair.example/a gent.pkg",
    "ftp://webair.example/agent.pkg",
    "webair.example/agent.pkg",
  ];
  for (const url of cases) {
    it(`refuses ${url} without fetching`, async () => {
      const h = makeHarness();
      expect((await refused(open(h, url, null))).code).toBe("url_rejected");
      expect(h.fetchLog).toHaveLength(0);
    });
  }

  it("applies the same policy to the advertising page and to website addresses", async () => {
    const h = makeHarness();
    expect((await refused(open(h, PACKAGE_URL, "http://webair.example/"))).code).toBe("url_rejected");
    expect((await refused(h.controller.handle({ type: "website.discover", url: "https://127.0.0.1/" }, PAGE))).code).toBe("url_rejected");
    expect((await refused(h.controller.handle({ type: "website.discover", url: "https://webair.example:8080/" }, PAGE))).code).toBe("url_rejected");
    expect(h.fetchLog).toHaveLength(0);
  });
});

describe("downloads fail closed (fetch.py)", () => {
  it("a redirect is refused: download_redirect_denied", async () => {
    const h = makeHarness();
    h.routes[PACKAGE_URL] = { redirectTo: "https://cdn.example/webair.pkg" };
    expect((await refused(open(h))).code).toBe("download_redirect_denied");
    expect(h.fetchLog.map((entry) => entry.url)).toEqual([PACKAGE_URL]);
  });

  it("an HTTP error: download_failed", async () => {
    const h = makeHarness();
    h.routes[PACKAGE_URL] = { status: 404, body: "gone" };
    expect((await refused(open(h))).code).toBe("download_failed");
  });

  it("a network failure: download_failed", async () => {
    const h = makeHarness();
    h.routes[PACKAGE_URL] = { fail: true };
    expect((await refused(open(h))).code).toBe("download_failed");
  });

  it("a declared size over the limit: download_too_large", async () => {
    const h = makeHarness({ limits: { maxPackageBytes: 100_000 } });
    expect((await refused(open(h))).code).toBe("download_too_large");
  });

  it("a body over the limit while streaming: download_too_large", async () => {
    const h = makeHarness({ limits: { maxPackageBytes: 100_000 } });
    h.routes[PACKAGE_URL] = { headers: { "content-type": PACKAGE_MEDIA_TYPE }, body: readBytes(SHIPPED.webair.archive) };
    expect((await refused(open(h))).code).toBe("download_too_large");
    expect(await h.snapshots.listSnapshots()).toEqual([]);
  });

  it("a deadline: download_timeout", async () => {
    const h = makeHarness({ limits: { downloadTimeoutMs: 20 } });
    h.routes[PACKAGE_URL] = { hang: true };
    expect((await refused(open(h))).code).toBe("download_timeout");
  });
});

describe("packages that fail a layer are refused with the layered report", () => {
  async function rejectedWith(h: Harness, bytes: Uint8Array): Promise<CoreError> {
    h.routes[PACKAGE_URL] = { headers: { "content-type": PACKAGE_MEDIA_TYPE }, body: bytes };
    const error = await refused(open(h));
    expect(error.code).toBe("package_rejected");
    expect(await sessions(h)).toEqual([]);
    expect(await h.snapshots.listSnapshots()).toEqual([]);
    return error;
  }

  it("tampered bytes: the container parses, the integrity statement disagrees", async () => {
    const h = makeHarness();
    const error = await rejectedWith(h, tamperedWebair());
    expect(error.details.validation).toMatchObject({ container_status: "valid", integrity_status: "invalid", schema_status: "not_evaluated", runtime_status: "not_evaluated" });
    expect((error.details.validation as { errors: Array<{ layer: string }> }).errors.map((item) => item.layer)).toEqual(["integrity"]);
  });

  it("a traversal member name: the container is refused", async () => {
    const h = makeHarness();
    const error = await rejectedWith(h, traversalArchive());
    expect(error.details.validation).toMatchObject({ container_status: "invalid", integrity_status: "not_evaluated" });
    expect(JSON.stringify(error.details.validation)).toMatch(/unsafe\/nonportable/u);
  });

  it("bytes that are not an archive: the container is refused", async () => {
    const h = makeHarness();
    const error = await rejectedWith(h, new TextEncoder().encode("<html>not a package</html>"));
    expect(error.details.validation).toMatchObject({ container_status: "invalid" });
  });
});

describe("trust decisions (D-006)", () => {
  it("pins the key under review, narrowly by default, and re-evaluates the open session", async () => {
    const h = makeHarness();
    const view = await open(h);
    const result = (await h.controller.handle(
      { type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair.fingerprint, scope: "package" },
      PAGE,
    )) as PinResult;
    expect(result.scope).toBe("package");
    expect(result.added).toMatchObject({
      fingerprint: SHIPPED.webair.fingerprint,
      display_name: "WebAir (fictional demo airline)",
      publisher_id: SHIPPED.webair.publisherId,
      package_id_prefix: SHIPPED.webair.packageId,
    });
    expect(result.publisher.trust_status).toBe("trusted");
    expect(result.trust_store.entry_count).toBe(1);
    const after = await get(h, view.session.id);
    expect(after.page.trust).toMatchObject({ trust_status: "trusted", headline: "Signed by a publisher you trust", can_pin: false });
    expect((await sessions(h))[0]!.trust_status).toBe("trusted");
    expect(h.events).toContainEqual({ type: "event.trust" });
    expect(h.trustStorage.writes).toBe(1);
    expect(h.trustStorage.document).toMatchObject({ format: "agentpkg-trust-store-v0" });
  });

  it("refuses a fingerprint that is not the session's signer", async () => {
    const h = makeHarness();
    const view = await open(h);
    const error = await refused(
      h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.literatureReview.fingerprint, scope: "package" }, PAGE),
    );
    expect(error.code).toBe("fingerprint_mismatch");
    expect((await trustList(h)).entries).toEqual([]);
  });

  it("refuses pinning twice, unpinning an unknown key, and an unknown session", async () => {
    const h = makeHarness();
    const view = await open(h);
    const pin = { type: "trust.pin" as const, sessionId: view.session.id, signerFingerprint: SHIPPED.webair.fingerprint, scope: "package" as const };
    await h.controller.handle(pin, PAGE);
    expect((await refused(h.controller.handle(pin, PAGE))).code).toBe("trust_entry_exists");
    expect((await refused(h.controller.handle({ type: "trust.unpin", fingerprint: "sha256:" + "0".repeat(64) }, PAGE))).code).toBe("trust_entry_unknown");
    expect((await refused(h.controller.handle({ ...pin, sessionId: "nope" }, PAGE))).code).toBe("session_unknown");
  });

  it("unpinning downgrades the session to unknown again", async () => {
    const h = makeHarness();
    const view = await open(h);
    await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair.fingerprint, scope: "package" }, PAGE);
    const list = (await h.controller.handle({ type: "trust.unpin", fingerprint: SHIPPED.webair.fingerprint }, PAGE)) as TrustList;
    expect(list.entries).toEqual([]);
    expect((await get(h, view.session.id)).page.trust.headline).toBe("Signed, publisher unknown");
  });

  it("the publisher scope covers every package of that publisher", async () => {
    const h = makeHarness();
    const view = await open(h);
    const result = (await h.controller.handle(
      { type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair.fingerprint, scope: "publisher" },
      PAGE,
    )) as PinResult;
    expect(result.added.package_id_prefix).toBeNull();
    expect(result.added.publisher_id).toBe(SHIPPED.webair.publisherId);
  });

  it("a key pinned out of band for the claimed publisher makes the package a possible impersonation", async () => {
    const h = makeHarness();
    const other = await generateKeyPair();
    const list = (await h.controller.handle(
      { type: "trust.pinKey", publicKeyPem: publicKeyToPem(other.publicKey), displayName: "WebAir (real key, I think)", publisherId: SHIPPED.webair.publisherId },
      PAGE,
    )) as TrustList;
    expect(list.entries).toHaveLength(1);
    const view = await open(h);
    expect(view.page.trust).toMatchObject({ signature_status: "valid", trust_status: "mismatch", headline: "Possible impersonation", can_pin: false });
  });

  it("refuses a private key and a malformed key out of band", async () => {
    const h = makeHarness();
    const privateLike = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----\n";
    expect((await refused(h.controller.handle({ type: "trust.pinKey", publicKeyPem: privateLike, displayName: "x" }, PAGE))).code).toBe("trust_private_key_refused");
    expect((await refused(h.controller.handle({ type: "trust.pinKey", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----", displayName: "x" }, PAGE))).code).toBe(
      "trust_invalid",
    );
    expect((await trustList(h)).entries).toEqual([]);
  });

  it("a pinned Literature Review key trusts that package and no other", async () => {
    const h = makeHarness();
    await h.controller.handle(
      { type: "trust.pinKey", publicKeyPem: readText(SHIPPED.literatureReview.key), displayName: "WebAgents Research", publisherId: SHIPPED.literatureReview.publisherId },
      PAGE,
    );
    const literature = await open(h, LITERATURE_URL, null);
    expect(literature.page.trust.trust_status).toBe("trusted");
    expect(literature.summary.package.digest).toBe(SHIPPED.literatureReview.digest);
    expect(literature.snapshot.archive_sha256).toBe(SHIPPED.literatureReview.archiveSha256);
    const webair = await open(h);
    expect(webair.page.trust.trust_status).toBe("unknown");
  });
});

describe("candidates from content scripts (D-026, D-035)", () => {
  const links = [
    { href: "/agent.pkg", type: PACKAGE_MEDIA_TYPE, title: "WebAir" },
    { href: "https://other.example/x.pkg", type: null, title: null },
  ];

  it("judges the links against the tab URL Chrome reports, sets the badge and broadcasts", async () => {
    const h = makeHarness();
    await h.controller.contentLinks({ type: "content.links", links }, TAB);
    const state = (await h.controller.handle({ type: "candidates.get", tabId: 7 }, PAGE)) as CandidateState;
    expect(state).toMatchObject({ tabId: 7, pageUrl: `${SITE_ORIGIN}/`, pageOrigin: SITE_ORIGIN, status: "candidate", linksNotListed: 0 });
    expect(state.candidates[0]).toMatchObject({ accepted: true, resolved_url: PACKAGE_URL, type_hint: PACKAGE_MEDIA_TYPE });
    expect(state.candidates[1]).toMatchObject({ accepted: false, rejection_reason: "cross_origin" });
    expect(h.badges.at(-1)).toEqual([7, 1]);
    expect(h.events).toContainEqual({ type: "event.candidates", tabId: 7 });
    expect(h.fetchLog).toHaveLength(0);
  });

  it("a sender without a tab, or not in the tab's top frame, is refused", async () => {
    const h = makeHarness();
    expect((await refused(h.controller.contentLinks({ type: "content.links", links }, PAGE))).code).toBe("not_allowed");
    expect((await refused(h.controller.contentLinks({ type: "content.links", links }, { ...TAB, topFrame: false }))).code).toBe("not_allowed");
    expect((await refused(h.controller.contentLinks({ type: "content.links", links }, { ...TAB, frameUrl: null }))).code).toBe("not_allowed");
    expect(await h.tabs.get(7)).toBeNull();
  });

  it("judges links against the frame's own document URL, and drops a report from a page the tab has left (review 1, finding 13)", async () => {
    const h = makeHarness();
    await h.controller.contentLinks({ type: "content.links", links: [{ href: "agent.pkg", type: null, title: null }] }, { ...TAB, frameUrl: `${SITE_ORIGIN}/flights/`, tabUrl: `${SITE_ORIGIN}/flights/` });
    const state = (await h.controller.handle({ type: "candidates.get", tabId: 7 }, PAGE)) as CandidateState;
    expect(state.pageUrl).toBe(`${SITE_ORIGIN}/flights/`);
    expect(state.candidates[0]?.resolved_url).toBe(`${SITE_ORIGIN}/flights/agent.pkg`);
    // A late report from the previous page: the tab is on WebAir now, the frame URL says old.example.
    await h.controller.contentLinks({ type: "content.links", links }, { ...TAB, frameUrl: "https://old.example/", tabUrl: `${SITE_ORIGIN}/` });
    expect(((await h.controller.handle({ type: "candidates.get", tabId: 7 }, PAGE)) as CandidateState).pageUrl).toBe(`${SITE_ORIGIN}/flights/`);
    expect(h.badges.filter(([tabId]) => tabId === 7)).toHaveLength(1);
  });

  it("drops a late report from another path of the same origin (review 2, nit 7)", async () => {
    const h = makeHarness();
    await h.controller.contentLinks({ type: "content.links", links: [{ href: "agent.pkg", type: null, title: null }] }, { ...TAB, frameUrl: `${SITE_ORIGIN}/b`, tabUrl: `${SITE_ORIGIN}/b` });
    // The tab is on /b now; a report that still names /a is stale even though the origin matches.
    await h.controller.contentLinks({ type: "content.links", links }, { ...TAB, frameUrl: `${SITE_ORIGIN}/a`, tabUrl: `${SITE_ORIGIN}/b` });
    const state = (await h.controller.handle({ type: "candidates.get", tabId: 7 }, PAGE)) as CandidateState;
    expect(state.pageUrl).toBe(`${SITE_ORIGIN}/b`);
    expect(state.candidates[0]?.resolved_url).toBe(`${SITE_ORIGIN}/agent.pkg`);
    // A fragment is not part of the document: the same page with a hash is not stale.
    await h.controller.contentLinks({ type: "content.links", links }, { ...TAB, frameUrl: `${SITE_ORIGIN}/b`, tabUrl: `${SITE_ORIGIN}/b#fares` });
    expect(((await h.controller.handle({ type: "candidates.get", tabId: 7 }, PAGE)) as CandidateState).candidates[0]?.resolved_url).toBe(PACKAGE_URL);
  });

  it("a non-https page clears its tab's state", async () => {
    const h = makeHarness();
    await h.controller.contentLinks({ type: "content.links", links }, TAB);
    await h.controller.contentLinks({ type: "content.links", links }, { ...TAB, frameUrl: "http://webair.example/", tabUrl: "http://webair.example/" });
    expect(await h.controller.handle({ type: "candidates.get", tabId: 7 }, PAGE)).toBeNull();
    expect(h.badges.at(-1)).toEqual([7, 0]);
  });

  it("clearing a tab removes its state and badge", async () => {
    const h = makeHarness();
    await h.controller.contentLinks({ type: "content.links", links }, TAB);
    await h.controller.clearTab(7);
    expect(await h.tabs.get(7)).toBeNull();
    expect(h.badges.at(-1)).toEqual([7, 0]);
  });
});

describe("website discovery from the address bar (discovery.py)", () => {
  it("reads the page and lists the advertised package as a location only", async () => {
    const h = makeHarness();
    const result = (await h.controller.handle({ type: "website.discover", url: `${SITE_ORIGIN}/` }, PAGE)) as WebsiteResult;
    expect(result).toMatchObject({ discovery_status: "candidate", page_origin: SITE_ORIGIN, final_url: `${SITE_ORIGIN}/`, accepted_count: 1 });
    expect(result.candidates[0]).toMatchObject({ accepted: true, resolved_url: PACKAGE_URL });
    expect(result.trust).toMatchObject({ conveys: "location_only", package_verified: false, publisher_trusted: false, permissions_granted: false });
    expect(result.execution).toMatchObject({ performed: false, package_fetched: false });
    const request = h.fetchLog[0]!;
    expect(request.init).toMatchObject({ redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(h.fetchLog).toHaveLength(1);
  });

  it("follows no redirect at all, so no hop is ever requested blind (review 1, finding 3; D-033 amended)", async () => {
    const h = makeHarness();
    h.routes[`${SITE_ORIGIN}/moved`] = { redirectTo: "http://127.0.0.1:11434/" };
    h.routes["http://127.0.0.1:11434/"] = { headers: { "content-type": "text/html" }, body: "<html><head></head></html>" };
    const error = await refused(h.controller.handle({ type: "website.discover", url: `${SITE_ORIGIN}/moved` }, PAGE));
    expect(error.code).toBe("discovery_redirect_refused");
    expect(error.details).toMatchObject({ reason: "redirect_not_followed" });
    expect(error.message).toMatch(/open the address the website redirects to yourself/u);
    expect(h.fetchLog.map((entry) => entry.url)).toEqual([`${SITE_ORIGIN}/moved`]);
    // The same for a same-origin hop: the person opens the final address.
    h.routes[`${SITE_ORIGIN}/old`] = { redirectTo: `${SITE_ORIGIN}/` };
    expect((await refused(h.controller.handle({ type: "website.discover", url: `${SITE_ORIGIN}/old` }, PAGE))).code).toBe("discovery_redirect_refused");
  });

  it("an IDN website is one origin in two spellings, not a redirect (review 2, should-fix 2)", async () => {
    const h = makeHarness();
    // Chrome requests the Unicode name and reports `response.url` with the punycode host.
    h.routes["https://xn--bcher-kva.example/"] = {
      headers: { "content-type": "text/html; charset=utf-8" },
      body: '<html><head><link rel="agent-package" href="/agent.pkg" type="application/vnd.webagents.agent-package"></head><body></body></html>',
    };
    const result = (await h.controller.handle({ type: "website.discover", url: "https://bücher.example/" }, PAGE)) as WebsiteResult;
    expect(result.discovery_status).toBe("candidate");
    expect(result.final_url).toBe("https://xn--bcher-kva.example/");
    expect(result.candidates[0]).toMatchObject({ accepted: true, resolved_url: "https://xn--bcher-kva.example/agent.pkg" });
    expect(h.fetchLog.map((entry) => entry.url)).toEqual(["https://bücher.example/"]);
    // A genuinely different origin is still refused.
    h.routes["https://other.example/"] = { headers: { "content-type": "text/html" }, body: "<html><head></head></html>" };
    h.routes[`${SITE_ORIGIN}/elsewhere`] = { redirectTo: "https://other.example/" };
    expect((await refused(h.controller.handle({ type: "website.discover", url: `${SITE_ORIGIN}/elsewhere` }, PAGE))).code).toBe("discovery_redirect_refused");
  });

  it("refuses a non-HTML answer, an HTTP error and a deadline", async () => {
    const h = makeHarness({ limits: { discoveryTimeoutMs: 20 } });
    h.routes[`${SITE_ORIGIN}/api`] = { headers: { "content-type": "application/json" }, body: "{}" };
    h.routes[`${SITE_ORIGIN}/down`] = { status: 503, headers: { "content-type": "text/html" }, body: "<html></html>" };
    h.routes[`${SITE_ORIGIN}/slow`] = { hang: true };
    expect((await refused(h.controller.handle({ type: "website.discover", url: `${SITE_ORIGIN}/api` }, PAGE))).code).toBe("discovery_not_html");
    expect((await refused(h.controller.handle({ type: "website.discover", url: `${SITE_ORIGIN}/down` }, PAGE))).code).toBe("discovery_http_status");
    expect((await refused(h.controller.handle({ type: "website.discover", url: `${SITE_ORIGIN}/slow` }, PAGE))).code).toBe("discovery_timeout");
  });
});

class FlakySnapshots extends MemorySnapshotStore {
  listFailures = 0;
  putSessionFailures = 0;

  override async listSessions(): Promise<StoredSession[]> {
    if (this.listFailures > 0) {
      this.listFailures -= 1;
      throw new Error("IndexedDB unavailable");
    }
    return super.listSessions();
  }

  override async putSession(session: StoredSession): Promise<void> {
    if (this.putSessionFailures > 0) {
      this.putSessionFailures -= 1;
      throw new Error("IndexedDB write failed");
    }
    return super.putSession(session);
  }
}

describe("sessions: limits, expiry, close and restore (D-032)", () => {
  it("a failed restore is retried on the next request instead of poisoning the worker (review 1, finding 6)", async () => {
    const snapshots = new FlakySnapshots();
    snapshots.listFailures = 1;
    const h = makeHarness({ stores: { snapshots, trustStorage: new MemoryTrustStorage(), tabs: new MemoryTabStateStore() } });
    await expect(h.controller.handle({ type: "status.get" }, PAGE)).rejects.toThrow(/IndexedDB unavailable/u);
    const status = (await h.controller.handle({ type: "status.get" }, PAGE)) as StatusInfo;
    expect(status.sessions).toBe(0);
    expect((await open(h)).summary.package.digest).toBe(SHIPPED.webair.digest);
  });

  it("a snapshot stored for a session that could not be created is removed again (review 1, finding 12)", async () => {
    const snapshots = new FlakySnapshots();
    snapshots.putSessionFailures = 1;
    const h = makeHarness({ stores: { snapshots, trustStorage: new MemoryTrustStorage(), tabs: new MemoryTabStateStore() } });
    await expect(open(h)).rejects.toThrow(/IndexedDB write failed/u);
    expect(await h.snapshots.listSnapshots()).toEqual([]);
    expect(await sessions(h)).toEqual([]);
    // Nothing is lost that another session still needs: the second open shares the snapshot.
    const first = await open(h);
    snapshots.putSessionFailures = 1;
    await expect(open(h, PACKAGE_URL, null)).rejects.toThrow(/IndexedDB write failed/u);
    expect(await h.snapshots.listSnapshots()).toHaveLength(1);
    expect((await get(h, first.session.id)).session.id).toBe(first.session.id);
  });

  it("a storage error while reading the trust store during restore is retried, not a dropped session (review 2, nit 4)", async () => {
    const first = makeHarness();
    const view = await open(first);
    const trustStorage = new MemoryTrustStorage("chrome.storage.local:trustStore");
    let failures = 1;
    const read = trustStorage.read.bind(trustStorage);
    trustStorage.read = async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("chrome.storage unavailable");
      }
      return read();
    };
    const second = makeHarness({ stores: { snapshots: first.snapshots, trustStorage, tabs: first.tabs } });
    await expect(second.controller.handle({ type: "sessions.list" }, PAGE)).rejects.toThrow(/chrome.storage unavailable/u);
    // The session and its snapshot survived the failed attempt; the next request restores it.
    expect((await sessions(second)).map((session) => session.session_id)).toEqual([view.session.id]);
    expect(await second.snapshots.listSnapshots()).toHaveLength(1);
  });

  it("a concurrent open of the same bytes keeps the snapshot a failing open would drop as an orphan (review 2, nit 6)", async () => {
    class GatedSnapshots extends MemorySnapshotStore {
      gate: Promise<void> | null = null;
      failNext = false;
      /** Resolves when a putSession has started waiting at the gate. */
      entered!: () => void;
      waiting = new Promise<void>((resolve) => {
        this.entered = resolve;
      });
      override async putSession(session: StoredSession): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("IndexedDB write failed");
        }
        if (this.gate) {
          this.entered();
          await this.gate;
        }
        return super.putSession(session);
      }
    }
    const snapshots = new GatedSnapshots();
    const h = makeHarness({ stores: { snapshots, trustStorage: new MemoryTrustStorage(), tabs: new MemoryTabStateStore() } });
    let release!: () => void;
    snapshots.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // B has stored the snapshot and is waiting to store its session when A's open fails.
    const b = open(h, PACKAGE_URL, null);
    await snapshots.waiting;
    snapshots.gate = null;
    snapshots.failNext = true;
    await expect(open(h)).rejects.toThrow(/IndexedDB write failed/u);
    release();
    const view = await b;
    expect(await h.snapshots.listSnapshots()).toEqual([{ archive_sha256: SHIPPED.webair.archiveSha256, bytes: WEBAIR_BYTES }]);
    expect((await get(h, view.session.id)).summary.package.digest).toBe(SHIPPED.webair.digest);
  });

  it("a view's release ends the session only when no other view holds it (review 2, nit 5)", async () => {
    const h = makeHarness();
    const view = (await h.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "sidepanel:1" }, PAGE)) as SessionView;
    await h.controller.handle({ type: "package.get", sessionId: view.session.id, viewId: "browser:1" }, PAGE_IN_TAB);
    expect(await h.controller.handle({ type: "package.release", sessionId: view.session.id, viewId: "sidepanel:1" }, PAGE)).toEqual({ closed: false, session_id: view.session.id, holders: 1 });
    expect((await get(h, view.session.id)).session.id).toBe(view.session.id);
    expect(await h.controller.handle({ type: "package.release", sessionId: view.session.id, viewId: "browser:1" }, PAGE_IN_TAB)).toEqual({ closed: true, session_id: view.session.id, holders: 0 });
    expect((await refused(get(h, view.session.id))).code).toBe("session_unknown");
    expect(await h.snapshots.listSnapshots()).toEqual([]);
    // A session nobody ever held closes on its first release, as before.
    const alone = await open(h);
    expect((await h.controller.handle({ type: "package.release", sessionId: alone.session.id, viewId: "sidepanel:2" }, PAGE)) as { closed: boolean }).toMatchObject({ closed: true });
  });

  it("a view holds one session at a time: showing another drops its hold on the previous one (T3 review 2, nit 20)", async () => {
    const h = makeHarness();
    // The full page shows A, the panel shows A too; the full page moves on to B.
    const a = (await h.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: null, viewId: "browser:1" }, PAGE_IN_TAB)) as SessionView;
    await h.controller.handle({ type: "package.get", sessionId: a.session.id, viewId: "sidepanel:1" }, PAGE);
    const b = (await h.controller.handle({ type: "package.open", url: LITERATURE_URL, advertisedOn: null, viewId: "browser:1" }, PAGE_IN_TAB)) as SessionView;
    expect((await h.holders.get(a.session.id)).map((holder) => holder.view_id)).toEqual(["sidepanel:1"]);
    expect((await h.holders.get(b.session.id)).map((holder) => holder.view_id)).toEqual(["browser:1"]);
    // Navigating is not closing: A is still open for the panel.
    expect((await get(h, a.session.id)).session.id).toBe(a.session.id);
    // Close in the panel now ends A, because the page's stale hold is gone; B is untouched.
    expect(await h.controller.handle({ type: "package.release", sessionId: a.session.id, viewId: "sidepanel:1" }, PAGE)).toEqual({ closed: true, session_id: a.session.id, holders: 0 });
    expect(await h.holders.get(a.session.id)).toEqual([]);
    expect((await sessions(h)).map((session) => session.session_id)).toEqual([b.session.id]);
  });

  it("a hold survives a worker restart: Close in the panel still leaves the full page's session open (review 1 of T3, finding 5)", async () => {
    const first = makeHarness();
    const panel: Sender = { ...PAGE, documentId: "doc-panel" };
    const page: Sender = { ...PAGE_IN_TAB, documentId: "doc-page" };
    const view = (await first.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "sidepanel:1" }, panel)) as SessionView;
    await first.controller.handle({ type: "package.get", sessionId: view.session.id, viewId: "browser:1" }, page);
    expect(await first.holders.get(view.session.id)).toEqual([
      { view_id: "sidepanel:1", document_id: "doc-panel" },
      { view_id: "browser:1", document_id: "doc-page" },
    ]);
    // Chrome stops the idle worker; a new one starts over the same storage, both views still open.
    const stores = { snapshots: first.snapshots, trustStorage: first.trustStorage, tabs: first.tabs, holders: first.holders };
    const second = makeHarness({ stores, liveDocuments: new Set(["doc-panel", "doc-page"]) });
    expect(await second.controller.handle({ type: "package.release", sessionId: view.session.id, viewId: "sidepanel:1" }, panel)).toEqual({ closed: false, session_id: view.session.id, holders: 1 });
    expect(((await second.controller.handle({ type: "package.get", sessionId: view.session.id, viewId: "browser:1" }, page)) as SessionView).session.id).toBe(view.session.id);
    expect(await second.controller.handle({ type: "package.release", sessionId: view.session.id, viewId: "browser:1" }, page)).toEqual({ closed: true, session_id: view.session.id, holders: 0 });
    expect(await second.holders.get(view.session.id)).toEqual([]);
  });

  it("a view whose page closed without releasing stops holding its session", async () => {
    const open = new Set(["doc-panel", "doc-page"]);
    const h = makeHarness({ liveDocuments: open });
    const view = (await h.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "sidepanel:1" }, { ...PAGE, documentId: "doc-panel" })) as SessionView;
    await h.controller.handle({ type: "package.get", sessionId: view.session.id, viewId: "browser:1" }, { ...PAGE_IN_TAB, documentId: "doc-page" });
    open.delete("doc-page"); // the full page's tab was closed
    expect(await h.controller.handle({ type: "package.release", sessionId: view.session.id, viewId: "sidepanel:1" }, PAGE)).toMatchObject({ closed: true, holders: 0 });
    // A reload is a new document and a new view id: the old holder goes on the next hold.
    const again = (await h.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "browser:2" }, { ...PAGE_IN_TAB, documentId: "doc-old" })) as SessionView;
    await h.controller.handle({ type: "package.get", sessionId: again.session.id, viewId: "browser:3" }, { ...PAGE_IN_TAB, documentId: "doc-page" });
    open.add("doc-page");
    await h.controller.handle({ type: "package.get", sessionId: again.session.id, viewId: "sidepanel:2" }, { ...PAGE, documentId: "doc-panel" });
    expect((await h.holders.get(again.session.id)).map((holder) => holder.view_id)).toEqual(["browser:3", "sidepanel:2"]);
    // When Chrome cannot say which documents are open, every holder still counts.
    const unknown = makeHarness();
    const held = (await unknown.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "a" }, { ...PAGE, documentId: "doc-a" })) as SessionView;
    await unknown.controller.handle({ type: "package.get", sessionId: held.session.id, viewId: "b" }, { ...PAGE_IN_TAB, documentId: "doc-b" });
    expect(await unknown.controller.handle({ type: "package.release", sessionId: held.session.id, viewId: "a" }, PAGE)).toMatchObject({ closed: false, holders: 1 });
  });

  it("refuses more than the session limit", async () => {
    const h = makeHarness({ limits: { maxSessions: 1 } });
    await open(h);
    expect((await refused(open(h))).code).toBe("session_limit_reached");
  });

  it("refuses a cache overflow but reopens an already cached package", async () => {
    const h = makeHarness({ limits: { maxCacheBytes: WEBAIR_BYTES } });
    await open(h);
    await open(h, PACKAGE_URL, null);
    expect((await refused(open(h, LITERATURE_URL, null))).code).toBe("cache_limit_reached");
    expect(await h.snapshots.listSnapshots()).toHaveLength(1);
  });

  it("expires sessions by the clock and removes their snapshots", async () => {
    const h = makeHarness();
    const view = await open(h);
    h.clock.now = new Date("2026-10-06T14:00:01Z");
    expect((await refused(get(h, view.session.id))).code).toBe("session_unknown");
    expect(await sessions(h)).toEqual([]);
    expect(await h.snapshots.listSnapshots()).toEqual([]);
  });

  it("close removes the session and its snapshot", async () => {
    const h = makeHarness();
    const view = await open(h);
    expect(await h.controller.handle({ type: "package.close", sessionId: view.session.id }, PAGE)).toEqual({ closed: true, session_id: view.session.id });
    expect((await refused(get(h, view.session.id))).code).toBe("session_unknown");
    expect(await h.snapshots.listSnapshots()).toEqual([]);
  });

  it("restores sessions from stored bytes after a restart and drops a snapshot that changed", async () => {
    const first = makeHarness();
    const view = await open(first);
    const stores = { snapshots: first.snapshots, trustStorage: first.trustStorage, tabs: first.tabs };

    const second = makeHarness({ stores });
    expect((await sessions(second)).map((session) => session.session_id)).toEqual([view.session.id]);
    expect((await get(second, view.session.id)).summary.package.digest).toBe(SHIPPED.webair.digest);
    expect(second.fetchLog).toHaveLength(0);

    await first.snapshots.putSnapshot({ archive_sha256: SHIPPED.webair.archiveSha256, bytes: tamperedWebair(), stored_at: "2026-10-06T12:00:00Z" });
    const third = makeHarness({ stores });
    expect(await sessions(third)).toEqual([]);
    expect(await third.snapshots.listSnapshots()).toEqual([]);
  });
});

describe("status", () => {
  it("reports the limits in force, the execution host and its limits (T5)", async () => {
    const h = makeHarness({ limits: { maxSessions: 3 } });
    await open(h);
    const status = (await h.controller.handle({ type: "status.get" }, PAGE)) as StatusInfo;
    expect(status).toMatchObject({ version: "0.1.0-test", runtime_version: "0.2.2", sessions: 1, max_sessions: 3, cached_bytes: WEBAIR_BYTES, session_ttl_seconds: 7200, execution: "enabled", runs: { active: 0, stored: 0 } });
    expect(status.execution_limits).toMatchObject({ total_tokens: 120000, max_remote_calls: 32, max_parallel_workers: 3, run_timeout_seconds: 600, model_call_timeout_seconds: 300 });
    const without = makeHarness({ hostOptions: { available: false } });
    expect(((await without.controller.handle({ type: "status.get" }, PAGE)) as StatusInfo)).toMatchObject({ execution: "disabled", execution_limits: null });
  });
});
