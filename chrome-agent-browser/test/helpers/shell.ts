/**
 * Shell test helpers: a `fetch` over declared routes, the controller with every dependency
 * in memory, the WebAir site capture as routes, and hostile package variants built from the
 * shipped WebAir bytes (never modified on disk, D-003).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { BuiltinAvailability, Http, HttpRequest } from "../../src/core/models/catalog.js";
import type { BuiltinModelPort } from "../../src/core/models/adapters/chrome-builtin.js";
import { MemoryTrustStorage, TrustStore } from "../../src/core/trust.js";
import { Controller, type ControllerDeps, type Fetch, type Limits, type Sender } from "../../src/extension/background/controller.js";
import type { Event } from "../../src/extension/messages.js";
import { MemoryEnvelopeStorage, MemoryUnlockedStateStorage, SecretStore } from "../../src/core/secrets.js";
import { demoRecordId } from "../../src/extension/background/memory-controller.js";
import { MemoryMemoryStorage } from "../../src/extension/storage/memory.js";
import { EVERY_SITE_PATTERN, MemoryPermissions, PermissionStorage } from "../../src/extension/storage/permissions.js";
import { MemoryStorageArea, SettingsStorage } from "../../src/extension/storage/settings.js";
import { MemorySnapshotStore } from "../../src/extension/storage/snapshots.js";
import { MemoryTabStateStore } from "../../src/extension/storage/tab-state.js";
import { MemoryViewHolderStore } from "../../src/extension/storage/view-holders.js";
import { MemoryRunStore } from "../../src/extension/storage/runs.js";
import { MemoryFileStore } from "../../src/extension/storage/files.js";
import type { ExecutionHostBridge } from "../../src/extension/background/runs.js";
import { InProcessHost, refusingTransport } from "./host.js";
import type { HttpTransport } from "../../src/core/models/transport.js";
import { generateKeyPair, signedArchive } from "./keys.js";
import { PROJECT, readBytes, ROOT, SHIPPED } from "./paths.js";
import { makeSource, writeText } from "./source.js";
import { listMembers, writeZip, type Entry } from "./zip.js";
import type { NativePort } from "../../src/core/keychain.js";
import { KeychainStorage } from "../../src/extension/storage/keychain-storage.js";
import type { ComputeEngine } from "../../src/core/compute/engine.js";

export const SITE_ORIGIN = "https://webair.example";
export const PACKAGE_URL = `${SITE_ORIGIN}/agent.pkg`;
export const PACKAGE_MEDIA_TYPE = "application/vnd.webagents.agent-package";
export const LITERATURE_URL = "https://research.example/literature-review.agent.pkg";
/** WebAir 0.4.0 (profiles), served beside the 0.3.0 the captured site advertises. */
export const WEBAIR_040_URL = `${SITE_ORIGIN}/agent-0.4.0.pkg`;

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

/** `response.url` as Chrome reports it: the WHATWG serialization, with an IDN host in punycode. */
function reportedUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** A `fetch` over declared routes (looked up as requested or as Chrome would serialize them); unknown URLs answer 404. */
export function fakeFetch(routes: Record<string, Route>, log: FetchLog[] = []): Fetch {
  return async (requested, init) => {
    log.push({ url: requested, init });
    const route = routes[requested] ?? routes[reportedUrl(requested)];
    const url = reportedUrl(requested);
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
  const webair040 = readBytes(SHIPPED.webair040.archive);
  routes[WEBAIR_040_URL] = { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(webair040.length) }, body: webair040 };
  return routes;
}

/** The model-catalog transport over declared answers (`METHOD url` → body); `SHOW <model>` answers Ollama's /api/show. */
export function fakeHttp(answers: Record<string, unknown>, log: HttpRequest[] = []): Http {
  return async (request) => {
    log.push(request);
    const key = `${request.method} ${request.url}`;
    if (key in answers) return { status: 200, body: answers[key] };
    if (request.method === "POST" && request.url.endsWith("/api/show")) {
      const shown = answers[`SHOW ${(request.body as { model: string }).model}`];
      if (shown !== undefined) return { status: 200, body: shown };
    }
    return { status: 404, body: null };
  };
}

/** One local model as Settings → Models would state it after the STATE.md §5 override (qwen3:30b). */
export const OLLAMA_ANSWERS: Record<string, unknown> = {
  "GET http://127.0.0.1:11434/api/tags": { models: [{ name: "qwen3:30b", model: "qwen3:30b" }] },
  "SHOW qwen3:30b": { capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3moe.context_length": 262144 } },
};

/** The committed empty envelope (test scrypt parameters) and its master key: every harness starts with a passphrase set, unlocked (T16). */
const SEED = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "secret-store-vectors.json"), "utf8")) as { passphrase: string; empty: { master_key: string; envelope: unknown } };
export const SEED_PASSPHRASE: string = SEED.passphrase;

/** The demo set's stable record ids (T19): the six fictional WebAir records by their 0.1.0 resource ids. */
export const DEMO = {
  traveler: demoRecordId("profile_demo_traveler"),
  explorer: demoRecordId("profile_demo_explorer"),
  alex: demoRecordId("passenger_demo_alex"),
  sam: demoRecordId("passenger_demo_sam"),
  visa: demoRecordId("payment_demo_visa"),
  travel: demoRecordId("payment_demo_travel"),
} as const;
/** The scrypt parameters the harness's store uses for new envelopes (a few milliseconds, not half a second). */
export const TEST_KDF = { n: 2 ** 14, r: 8, p: 1 };

export interface Harness {
  controller: Controller;
  snapshots: MemorySnapshotStore;
  trustStorage: MemoryTrustStorage;
  trust: TrustStore;
  tabs: MemoryTabStateStore;
  holders: MemoryViewHolderStore;
  settingsArea: MemoryStorageArea;
  settings: SettingsStorage;
  httpLog: HttpRequest[];
  builtin: { availability: BuiltinAvailability | null };
  badges: Array<[tabId: number, count: number]>;
  events: Event[];
  fetchLog: FetchLog[];
  routes: Record<string, Route>;
  clock: { now: Date };
  runs: MemoryRunStore;
  host: InProcessHost;
  /** The picked PDFs (Settings → Files, T6). */
  files: MemoryFileStore;
  /** The secret store (T16) and its two storages, for locking and inspecting what is on disk. */
  secrets: SecretStore;
  envelope: MemoryEnvelopeStorage;
  unlocked: MemoryUnlockedStateStorage;
  /** Chrome's host permissions, as the test grants them (every HTTPS origin unless `permissions` says otherwise). */
  permissions: MemoryPermissions;
  /** Keychain unlock's record (T17), in the settings area as in Chrome; and the `nativeMessaging` grant. */
  keychain: KeychainStorage;
  native: { permission: boolean };
  /** The memory's rows (T19), shared across "restarts" like the other stores. */
  memoryStorage: MemoryMemoryStorage;
  /** Wait for every run the host started to finish and report. */
  h_drain: () => Promise<void>;
}

export function makeHarness(
  options: {
    routes?: Record<string, Route>;
    limits?: Partial<Limits>;
    stores?: Pick<Harness, "snapshots" | "trustStorage" | "tabs"> & Partial<Pick<Harness, "settingsArea" | "holders">> & { secrets?: Pick<Harness, "envelope" | "unlocked"> };
    /** The documents `chrome.runtime.getContexts` would still report open; absent: every holder counts. */
    liveDocuments?: Set<string>;
    /** Model-catalog answers; the Ollama qwen3:30b answers by default. */
    http?: Record<string, unknown>;
    /** The model-catalog transport itself, replacing `http` (a provider that stops answering, T5a). */
    catalogHttp?: Http;
    /** The run store (shared across "restarts"). */
    runs?: MemoryRunStore;
    /** The execution host's transports: a scripted model and a scripted origin; without them every run fails at its first call. */
    transports?: { model: HttpTransport; tool: HttpTransport };
    /** A host that refuses to start (no offscreen document) or reports no execution capability. */
    hostOptions?: { available?: boolean; failStart?: boolean; workerDies?: boolean; statusFailures?: number; cancelUnreachable?: boolean; compute?: ComputeEngine | null };
    runIds?: () => string;
    /** Also deliver every broadcast here (a page's `subscribe`, in the browser-page tests). */
    onEvent?: (event: Event) => void;
    /** The picked-file store (T6), shared by the controller and the in-process host. */
    files?: MemoryFileStore;
    /** The execution host's built-in model port (the Prompt API, D-072); absent: the host has none. */
    builtinPort?: BuiltinModelPort;
    /** The secret store's starting state (T16): `unlocked` (a passphrase set, the seed envelope, unlocked), `locked`, or `none` (no passphrase yet). */
    secrets?: "unlocked" | "locked" | "none";
    /** The origin match patterns Chrome grants; every HTTPS origin by default. */
    permissions?: readonly string[];
    /** The native helper behind the native port (T17); absent: not installed. */
    native?: NativePort;
    /** Whether `nativeMessaging` is granted (T17); false by default. */
    nativePermission?: boolean;
    /** The memory's rows (T19), shared across "restarts". */
    memoryStorage?: MemoryMemoryStorage;
  } = {},
): Harness {
  const routes = options.routes ?? webairRoutes();
  const fetchLog: FetchLog[] = [];
  const httpLog: HttpRequest[] = [];
  const snapshots = options.stores?.snapshots ?? new MemorySnapshotStore();
  const trustStorage = options.stores?.trustStorage ?? new MemoryTrustStorage("chrome.storage.local:trustStore");
  const tabs = options.stores?.tabs ?? new MemoryTabStateStore();
  const holders = options.stores?.holders ?? new MemoryViewHolderStore();
  const settingsArea = options.stores?.settingsArea ?? new MemoryStorageArea();
  const clock = { now: new Date("2026-10-06T12:00:00Z") };
  const envelope = options.stores?.secrets?.envelope ?? new MemoryEnvelopeStorage();
  const unlocked = options.stores?.secrets?.unlocked ?? new MemoryUnlockedStateStorage();
  const secretsState = options.secrets ?? "unlocked";
  if (!options.stores?.secrets) {
    if (secretsState !== "none") envelope.value = SEED.empty.envelope;
    if (secretsState === "unlocked") unlocked.value = { key: SEED.empty.master_key, unlocked_at: clock.now.toISOString(), last_used_at: clock.now.toISOString() };
  }
  const secrets: SecretStore = new SecretStore({ envelope, unlocked, idleMinutes: async (): Promise<number | null> => (await settings.settings()).security.idle_lock_minutes, clock: () => clock.now, kdf: TEST_KDF });
  const settings: SettingsStorage = new SettingsStorage(settingsArea, secrets);
  const permissions = new MemoryPermissions(options.permissions ?? [EVERY_SITE_PATTERN]);
  const keychain = new KeychainStorage(settingsArea);
  const native = { permission: options.nativePermission ?? false };
  const builtin = { availability: null as BuiltinAvailability | null };
  const badges: Array<[number, number]> = [];
  const events: Event[] = [];
  let counter = 0;
  let runCounter = 0;
  const trust = new TrustStore(trustStorage, () => clock.now.toISOString());
  const runs = options.runs ?? new MemoryRunStore();
  const files = options.files ?? new MemoryFileStore();
  const memoryStorage = options.memoryStorage ?? new MemoryMemoryStorage();
  const host = new InProcessHost({ runs, snapshots, files, model: options.transports?.model ?? refusingTransport(), tool: options.transports?.tool ?? refusingTransport(), builtin: options.builtinPort ?? null, now: () => clock.now, ...(options.hostOptions ?? {}) });
  const deps: ControllerDeps = {
    runs,
    files,
    host: host as ExecutionHostBridge,
    runId: options.runIds ?? (() => `run_${String((runCounter += 1)).padStart(32, "0")}`),
    fetch: fakeFetch(routes, fetchLog),
    snapshots,
    trust,
    tabs,
    holders,
    liveDocuments: options.liveDocuments ? async (ids) => new Set(ids.filter((id) => options.liveDocuments!.has(id))) : undefined,
    settings,
    memoryStorage,
    permissions,
    permissionStorage: new PermissionStorage(settingsArea),
    ...(options.native ? { native: options.native } : {}),
    nativePermission: async () => native.permission,
    keychain,
    http: options.catalogHttp
      ? async (request) => {
          httpLog.push(request);
          return options.catalogHttp!(request);
        }
      : fakeHttp(options.http ?? OLLAMA_ANSWERS, httpLog),
    builtin: async () => builtin.availability,
    badge: async (tabId, count) => {
      badges.push([tabId, count]);
    },
    broadcast: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
    clock: () => clock.now,
    randomId: () => `session${(counter += 1)}`,
    limits: options.limits,
    version: "0.1.0-test",
  };
  const controller = new Controller(deps);
  host.report = (type, runId) => controller.handle({ type, runId }, OFFSCREEN);
  return { controller, snapshots, trustStorage, trust, tabs, holders, settingsArea, settings, httpLog, builtin, badges, events, fetchLog, routes, clock, runs, host, files, secrets, envelope, unlocked, permissions, keychain, native, memoryStorage, h_drain: () => host.drain() };
}

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
/** The side panel: an extension page outside any tab. */
export const PAGE: Sender = { extensionPage: true, tabId: null, tabUrl: null, frameUrl: `${EXTENSION_ORIGIN}/sidepanel.html`, topFrame: false };
/** `browser.html` opened in a tab: still an extension page. */
export const PAGE_IN_TAB: Sender = { extensionPage: true, tabId: 9, tabUrl: `${EXTENSION_ORIGIN}/browser.html`, frameUrl: `${EXTENSION_ORIGIN}/browser.html`, topFrame: true };
/** The offscreen execution host: an extension page, and the only sender of `host.*` reports. */
export const OFFSCREEN: Sender = { extensionPage: true, tabId: null, tabUrl: null, frameUrl: `${EXTENSION_ORIGIN}/execution.html`, topFrame: false, offscreen: true };
/** A content script in the WebAir tab's top frame, as Chrome reports it. */
export const TAB: Sender = { extensionPage: false, tabId: 7, tabUrl: `${SITE_ORIGIN}/`, frameUrl: `${SITE_ORIGIN}/`, topFrame: true };

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
