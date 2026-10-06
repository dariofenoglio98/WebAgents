/**
 * Shell test helpers: a `fetch` over declared routes, the controller with every dependency
 * in memory, the WebAir site capture as routes, and hostile package variants built from the
 * shipped WebAir bytes (never modified on disk, D-003).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MemoryTrustStorage, TrustStore } from "../../src/core/trust.js";
import { Controller, type ControllerDeps, type Fetch, type Limits, type Sender } from "../../src/extension/background/controller.js";
import type { Event } from "../../src/extension/messages.js";
import { MemorySnapshotStore } from "../../src/extension/storage/snapshots.js";
import { MemoryTabStateStore } from "../../src/extension/storage/tab-state.js";
import { generateKeyPair, signedArchive } from "./keys.js";
import { readBytes, ROOT, SHIPPED } from "./paths.js";
import { makeSource, writeText } from "./source.js";
import { listMembers, writeZip, type Entry } from "./zip.js";

export const SITE_ORIGIN = "https://webair.example";
export const PACKAGE_URL = `${SITE_ORIGIN}/agent.pkg`;
export const PACKAGE_MEDIA_TYPE = "application/vnd.webagents.agent-package";
export const LITERATURE_URL = "https://research.example/literature-review.agent.pkg";

export interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string | null;
  /** `redirect: "follow"` lands here and serves the target; `redirect: "manual"` sees the 3xx. */
  redirectTo?: string;
  /** Never answer; reject when the request is aborted. */
  hang?: boolean;
  /** Throw a network error. */
  fail?: boolean;
}

export interface FetchLog {
  url: string;
  init: RequestInit;
}

export interface SiteCapture {
  origin: string;
  agent_package: { path: string; media_type: string };
  pages: Array<{ path: string; status: number; content_type: string; html: string }>;
}

/** `examples/webair-site.json`: WebAir's pages as its origin renders them. */
export function webairSite(): SiteCapture {
  return JSON.parse(readFileSync(join(ROOT, "examples", "webair-site.json"), "utf8")) as SiteCapture;
}

/** `Uint8Array` is a `BufferSource` at runtime; TypeScript's lib typing of `BodyInit` lags. */
function body(value: Uint8Array | string | null | undefined): BodyInit | null {
  return (value ?? null) as unknown as BodyInit | null;
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

/** A `fetch` over declared routes; unknown URLs answer 404. */
export function fakeFetch(routes: Record<string, Route>, log: FetchLog[] = []): Fetch {
  return async (url, init) => {
    log.push({ url, init });
    const route = routes[url];
    if (!route) return withUrl(new Response("not found", { status: 404 }), url);
    if (route.fail) throw new TypeError("fetch failed");
    if (route.hang) {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
      });
    }
    if (route.redirectTo) {
      if (init.redirect === "manual") return withUrl(new Response(null, { status: 302, headers: { location: route.redirectTo } }), url);
      const target = routes[route.redirectTo];
      return withUrl(new Response(body(target?.body), { status: target?.status ?? 404, headers: target?.headers ?? {} }), route.redirectTo);
    }
    return withUrl(new Response(body(route.body), { status: route.status ?? 200, headers: route.headers ?? {} }), url);
  };
}

/** The WebAir site and its package, as the origin serves them; Literature Review beside it. */
export function webairRoutes(): Record<string, Route> {
  const site = webairSite();
  const routes: Record<string, Route> = {};
  for (const page of site.pages) {
    routes[`${SITE_ORIGIN}${page.path}`] = { status: page.status, headers: { "content-type": page.content_type }, body: page.html };
  }
  const webair = readBytes(SHIPPED.webair.archive);
  routes[PACKAGE_URL] = {
    headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(webair.length), "x-agent-package-sha256": SHIPPED.webair.archiveSha256 },
    body: webair,
  };
  const literature = readBytes(SHIPPED.literatureReview.archive);
  routes[LITERATURE_URL] = { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(literature.length) }, body: literature };
  return routes;
}

export interface Harness {
  controller: Controller;
  snapshots: MemorySnapshotStore;
  trustStorage: MemoryTrustStorage;
  trust: TrustStore;
  tabs: MemoryTabStateStore;
  badges: Array<[tabId: number, count: number]>;
  events: Event[];
  fetchLog: FetchLog[];
  routes: Record<string, Route>;
  clock: { now: Date };
}

export function makeHarness(
  options: { routes?: Record<string, Route>; limits?: Partial<Limits>; stores?: Pick<Harness, "snapshots" | "trustStorage" | "tabs"> } = {},
): Harness {
  const routes = options.routes ?? webairRoutes();
  const fetchLog: FetchLog[] = [];
  const snapshots = options.stores?.snapshots ?? new MemorySnapshotStore();
  const trustStorage = options.stores?.trustStorage ?? new MemoryTrustStorage("chrome.storage.local:trustStore");
  const tabs = options.stores?.tabs ?? new MemoryTabStateStore();
  const badges: Array<[number, number]> = [];
  const events: Event[] = [];
  const clock = { now: new Date("2026-10-06T12:00:00Z") };
  let counter = 0;
  const trust = new TrustStore(trustStorage, () => clock.now.toISOString());
  const deps: ControllerDeps = {
    fetch: fakeFetch(routes, fetchLog),
    snapshots,
    trust,
    tabs,
    badge: async (tabId, count) => {
      badges.push([tabId, count]);
    },
    broadcast: (event) => {
      events.push(event);
    },
    clock: () => clock.now,
    randomId: () => `session${(counter += 1)}`,
    limits: options.limits,
    version: "0.1.0-test",
  };
  return { controller: new Controller(deps), snapshots, trustStorage, trust, tabs, badges, events, fetchLog, routes, clock };
}

/** The side panel: an extension page outside any tab. */
export const PAGE: Sender = { extensionPage: true, tabId: null, tabUrl: null };
/** `browser.html` opened in a tab: still an extension page. */
export const PAGE_IN_TAB: Sender = { extensionPage: true, tabId: 9, tabUrl: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/browser.html" };
/** A content script in the WebAir tab, as Chrome reports it. */
export const TAB: Sender = { extensionPage: false, tabId: 7, tabUrl: `${SITE_ORIGIN}/` };

/** The shipped WebAir bytes with one payload byte changed: the hashes no longer agree. */
export function tamperedWebair(): Uint8Array {
  const members = listMembers(readBytes(SHIPPED.webair.archive));
  const readme = new Uint8Array(members.get("README.md")!);
  readme[0] = readme[0] === 0x23 ? 0x2a : 0x23;
  members.set("README.md", readme);
  return writeZip(members);
}

/** The shipped WebAir members plus a member whose name escapes the archive root. */
export function traversalArchive(): Uint8Array {
  const entries: Entry[] = [...listMembers(readBytes(SHIPPED.webair.archive))].map(([name, data]) => [name, data]);
  entries.push(["escape.txt", new TextEncoder().encode("hostile"), { name: "../escape.txt" }]);
  return writeZip(entries);
}

/** A signed, structurally valid package whose README tries to become markup. */
export async function hostilePackage(): Promise<{ bytes: Uint8Array; fingerprint: string }> {
  const source = makeSource();
  writeText(
    source,
    "README.md",
    [
      "# Agenda <script>alert(1)</script>",
      "",
      "Plain *text* with an [unsafe link](javascript:alert(1)) and a [safe link](https://example.com/docs).",
      "",
      "<img src=x onerror=alert(1)>",
      "",
      "```",
      "<b>code</b>",
      "```",
    ].join("\n"),
  );
  const key = await generateKeyPair();
  return { bytes: await signedArchive(source, key), fingerprint: key.fingerprint };
}
