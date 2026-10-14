/**
 * The service worker's wiring over a fake `chrome` API (D-033, D-035): who may send what,
 * the badge, the per-tab state in `storage.session`, the trust store in `storage.local`,
 * broadcasts, and the tab lifecycle. The controller's logic itself is tested in
 * `controller.test.ts`; this file checks the glue Chrome sees.
 */
import "fake-indexeddb/auto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Response as Reply, SessionView, TrustList } from "../../src/extension/messages.js";
import { SHIPPED } from "../helpers/paths.js";
import { fakeFetch, PACKAGE_MEDIA_TYPE, PACKAGE_URL, SITE_ORIGIN, webairRoutes } from "../helpers/shell.js";

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined;

function storageArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key: string) {
      return data.has(key) ? { [key]: data.get(key) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key: string) {
      data.delete(key);
    },
  };
}

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const calls = {
  badge: [] as Array<{ tabId: number; text: string }>,
  titles: [] as Array<{ tabId: number; title: string }>,
  broadcasts: [] as unknown[],
  panelBehavior: [] as unknown[],
  accessLevels: [] as unknown[],
  alarms: [] as unknown[],
  menus: [] as unknown[],
  injected: [] as number[],
};
const listeners: { onMessage: Listener | null; onRemoved: ((tabId: number) => void) | null; onUpdated: ((tabId: number, change: { status?: string; url?: string }) => void) | null } = {
  onMessage: null,
  onRemoved: null,
  onUpdated: null,
};
const session = Object.assign(storageArea(), { setAccessLevel: async (level: unknown) => void calls.accessLevels.push(level) });
const local = storageArea();
const grantedOrigins = new Set<string>(["https://*/*"]);
const registeredScripts: unknown[] = [];

const fakeChrome = {
  runtime: {
    id: EXTENSION_ID,
    getManifest: () => ({ version: "0.2.0" }),
    onStartup: { addListener: () => undefined },
    onMessage: {
      addListener: (listener: Listener) => {
        listeners.onMessage = listener;
      },
      removeListener: () => undefined,
    },
    onInstalled: { addListener: (listener: () => void) => listener() },
    sendMessage: async (message: unknown) => {
      calls.broadcasts.push(message);
    },
  },
  tabs: {
    onRemoved: {
      addListener: (listener: (tabId: number) => void) => {
        listeners.onRemoved = listener;
      },
    },
    onUpdated: {
      addListener: (listener: (tabId: number, change: { status?: string; url?: string }) => void) => {
        listeners.onUpdated = listener;
      },
    },
  },
  action: {
    setBadgeText: async (details: { tabId: number; text: string }) => {
      calls.badge.push(details);
    },
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async (details: { tabId: number; title: string }) => {
      calls.titles.push(details);
    },
  },
  storage: { session, local },
  sidePanel: {
    setPanelBehavior: async (behavior: unknown) => {
      calls.panelBehavior.push(behavior);
    },
  },
  // T16: host permissions, the discovery script, the idle-lock alarm, the context menu and the shortcut.
  permissions: {
    contains: async ({ origins }: { origins: string[] }) => origins.every((origin) => grantedOrigins.has(origin) || (grantedOrigins.has("https://*/*") && origin.startsWith("https://"))),
    getAll: async () => ({ origins: [...grantedOrigins], permissions: [] }),
    remove: async ({ origins }: { origins: string[] }) => {
      for (const origin of origins) grantedOrigins.delete(origin);
      return true;
    },
    onRemoved: { addListener: () => undefined },
    onAdded: { addListener: () => undefined },
  },
  scripting: {
    getRegisteredContentScripts: async () => registeredScripts,
    unregisterContentScripts: async () => registeredScripts.splice(0),
    registerContentScripts: async (scripts: unknown[]) => void registeredScripts.push(...scripts),
    executeScript: async ({ target }: { target: { tabId: number } }) => void calls.injected.push(target.tabId),
  },
  alarms: {
    onAlarm: { addListener: () => undefined },
    get: async () => undefined,
    create: async (name: string, info: unknown) => void calls.alarms.push({ name, info }),
  },
  contextMenus: {
    create: (properties: unknown, done?: () => void) => {
      calls.menus.push(properties);
      done?.();
    },
    onClicked: { addListener: () => undefined },
  },
  commands: { onCommand: { addListener: () => undefined } },
};

const contentScript = { id: EXTENSION_ID, url: `${SITE_ORIGIN}/`, frameId: 0, tab: { id: 7, url: `${SITE_ORIGIN}/` } } as unknown as chrome.runtime.MessageSender;
const sidePanel = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` } as unknown as chrome.runtime.MessageSender;
const fullPageInTab = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/browser.html#open`,
  tab: { id: 9, url: `chrome-extension://${EXTENSION_ID}/browser.html#open` },
} as unknown as chrome.runtime.MessageSender;
const impostor = { id: "someotherextensionidabcdefghijkl", url: `chrome-extension://${EXTENSION_ID}/browser.html` } as unknown as chrome.runtime.MessageSender;

function dispatch<T = unknown>(message: unknown, sender: chrome.runtime.MessageSender): Promise<Reply<T>> {
  return new Promise((resolve) => {
    const keepOpen = listeners.onMessage!(message, sender, (response) => resolve(response as Reply<T>));
    expect(keepOpen).toBe(true);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeAll(async () => {
  (globalThis as { chrome?: unknown }).chrome = fakeChrome;
  vi.stubGlobal("fetch", fakeFetch(webairRoutes()));
  await import("../../src/extension/background/service-worker.js");
});

describe("the service worker's wiring", () => {
  it("registers its listeners and opens the panel on the action click", () => {
    expect(listeners.onMessage).not.toBeNull();
    expect(listeners.onRemoved).not.toBeNull();
    expect(listeners.onUpdated).not.toBeNull();
    expect(calls.panelBehavior).toEqual([{ openPanelOnActionClick: true }]);
  });

  it("a content script's link report becomes the tab's candidates and badge", async () => {
    const reply = await dispatch({ type: "content.links", links: [{ href: "/agent.pkg", type: PACKAGE_MEDIA_TYPE, title: null }] }, contentScript);
    expect(reply).toEqual({ ok: true, result: { received: true } });
    expect(calls.badge.at(-1)).toEqual({ tabId: 7, text: "1" });
    expect(calls.titles.at(-1)?.title).toContain("1 agent package");
    const stored = session.data.get("tab:7") as { candidates: Array<{ resolved_url: string }>; pageUrl: string };
    expect(stored.pageUrl).toBe(`${SITE_ORIGIN}/`);
    expect(stored.candidates[0]?.resolved_url).toBe(PACKAGE_URL);
    expect(calls.broadcasts).toContainEqual({ type: "event.candidates", tabId: 7 });
  });

  it("a content script may send nothing else", async () => {
    const reply = await dispatch({ type: "status.get" }, contentScript);
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("invalid_request");
    const sessions = await dispatch({ type: "sessions.list" }, contentScript);
    expect(sessions.ok).toBe(false);
  });

  it("the side panel and the full page in a tab are both extension pages", async () => {
    const candidates = await dispatch<{ candidates: Array<{ accepted: boolean }> }>({ type: "candidates.get", tabId: 7 }, sidePanel);
    expect(candidates.ok).toBe(true);
    if (candidates.ok) expect(candidates.result.candidates[0]?.accepted).toBe(true);
    const status = await dispatch<{ execution: string }>({ type: "status.get" }, fullPageInTab);
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.result.execution).toBe("disabled");
  });

  it("another extension's page is never an extension page here", async () => {
    const reply = await dispatch({ type: "status.get" }, impostor);
    expect(reply.ok).toBe(false);
    const links = await dispatch({ type: "content.links", links: [] }, impostor);
    expect(links.ok).toBe(false);
    if (!links.ok) expect(links.error.code).toBe("not_allowed");
  });

  it("opens, inspects and trusts a package end to end, with the trust store in storage.local", async () => {
    const opened = await dispatch<SessionView>({ type: "package.open", url: PACKAGE_URL, advertisedOn: `${SITE_ORIGIN}/` }, sidePanel);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.result.page.identity.name).toBe("WebAir Travel Agent");
    expect(opened.result.snapshot.archive_sha256).toBe(SHIPPED.webair.archiveSha256);
    expect(opened.result.page.trust.headline).toBe("Signed, publisher unknown");

    const pinned = await dispatch({ type: "trust.pin", sessionId: opened.result.session.id, signerFingerprint: SHIPPED.webair.fingerprint, scope: "package" }, fullPageInTab);
    expect(pinned.ok).toBe(true);
    const stored = local.data.get("trustStore") as { format: string; publishers: Array<{ fingerprint: string }> };
    expect(stored.format).toBe("agentpkg-trust-store-v0");
    expect(stored.publishers.map((entry) => entry.fingerprint)).toEqual([SHIPPED.webair.fingerprint]);
    expect(calls.broadcasts).toContainEqual({ type: "event.trust" });

    const again = await dispatch<SessionView>({ type: "package.get", sessionId: opened.result.session.id }, sidePanel);
    if (again.ok) expect(again.result.page.trust.headline).toBe("Signed by a publisher you trust");
    const list = await dispatch<TrustList>({ type: "trust.list" }, sidePanel);
    if (list.ok) expect(list.result.entries).toHaveLength(1);
    expect(session.data.has("trustStore")).toBe(false);
  });

  it("unknown request types are refused with invalid_request", async () => {
    const reply = await dispatch({ type: "package.run", sessionId: "x" }, sidePanel);
    expect(reply).toEqual({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("unknown request type") } });
  });

  it("ignores its own broadcasts", () => {
    expect(listeners.onMessage!({ type: "event.trust" }, sidePanel, () => undefined)).toBe(false);
  });

  it("tab removal and navigation clear the candidates and the badge", async () => {
    listeners.onRemoved!(7);
    await settle();
    expect(session.data.has("tab:7")).toBe(false);
    expect(calls.badge.at(-1)).toEqual({ tabId: 7, text: "" });

    await dispatch({ type: "content.links", links: [{ href: "/agent.pkg", type: null, title: null }] }, contentScript);
    expect(session.data.has("tab:7")).toBe(true);
    listeners.onUpdated!(7, { status: "loading", url: `${SITE_ORIGIN}/flights` });
    await settle();
    expect(session.data.has("tab:7")).toBe(false);
    listeners.onUpdated!(7, { status: "complete" });
    await settle();
    expect(calls.badge.at(-1)).toEqual({ tabId: 7, text: "" });
  });
});
