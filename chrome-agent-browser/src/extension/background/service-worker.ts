/**
 * The background service worker: the only place that holds state (D-035). It wires Chrome's
 * APIs to the controller and nothing else: messages from extension pages and content
 * scripts, tab navigation and removal, the action badge, and the side panel behaviour.
 */
import type { BuiltinAvailability, Http } from "../../core/models/catalog.js";
import { TrustStore } from "../../core/trust.js";
import { failure, isEvent, parseContentMessage, parseRequest, success, type Event } from "../messages.js";
import { isHostCommand } from "../execution/protocol.js";
import { Database } from "../storage/database.js";
import { IndexedDbRunStore } from "../storage/runs.js";
import { SettingsStorage } from "../storage/settings.js";
import { IndexedDbSnapshotStore } from "../storage/snapshots.js";
import { ChromeTabStateStore } from "../storage/tab-state.js";
import { ChromeTrustStorage } from "../storage/trust-storage.js";
import { ChromeViewHolderStore } from "../storage/view-holders.js";
import { Controller, type Sender } from "./controller.js";
import { OffscreenHostBridge } from "./offscreen-host.js";

const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
const settings = new SettingsStorage(chrome.storage.local);
/** A model-catalog probe never waits longer than this. */
const PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_BYTES = 2 * 1024 * 1024;

/**
 * The catalog transport (D-055): the only place a provider key is read. It is added as the
 * provider's own header here and never leaves this worker; the core sees `key_configured` only.
 * Requests go to the configured origins alone, with no credentials or referrer of the browser's.
 */
const http: Http = async (request) => {
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  if (request.provider === "openai") {
    const key = await settings.key("openai");
    if (key) headers.authorization = `Bearer ${key}`;
  } else if (request.provider === "anthropic") {
    const key = await settings.key("anthropic");
    if (key) headers["x-api-key"] = key;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > MAX_PROBE_BYTES) return { status: response.status, body: null };
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * B-117: whether anything answers at a URL. A `no-cors` fetch succeeds (opaquely) when a server
 * is up even if it refuses this origin, and fails when nothing listens; nothing is read.
 */
async function reachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(url, { method: "GET", mode: "no-cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "manual", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Chrome's built-in model (Prompt API), as this context exposes it; never a network request. */
async function builtin(): Promise<BuiltinAvailability | null> {
  const api = (globalThis as { LanguageModel?: { availability?: () => Promise<string> } }).LanguageModel;
  if (!api || typeof api.availability !== "function") return { availability: "unsupported", input_quota: null };
  try {
    const availability = await api.availability();
    const known = ["available", "downloadable", "downloading", "unavailable"] as const;
    return { availability: (known as readonly string[]).includes(availability) ? (availability as (typeof known)[number]) : "unavailable", input_quota: null };
  } catch {
    return null;
  }
}

async function badge(tabId: number, count: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0b6e4f" });
      await chrome.action.setTitle({ tabId, title: `WebAgents: ${count} agent package${count === 1 ? "" : "s"} advertised on this page` });
    } else {
      await chrome.action.setTitle({ tabId, title: "WebAgents Agent Browser" });
    }
  } catch {
    // The tab may be gone; a badge is cosmetic.
  }
}

/** Which of these documents are still open: the side panel and full pages a view lives in. */
async function liveDocuments(documentIds: string[]): Promise<Set<string>> {
  const contexts = await chrome.runtime.getContexts({ documentIds });
  return new Set(contexts.map((context) => context.documentId).filter((id): id is string => typeof id === "string"));
}

function broadcast(event: Event): void {
  chrome.runtime.sendMessage(event).catch(() => {
    // No page is listening; that is normal.
  });
}

const database = new Database();
const controller = new Controller({
  fetch: (url, init) => fetch(url, init),
  snapshots: new IndexedDbSnapshotStore(database),
  runs: new IndexedDbRunStore(database),
  host: new OffscreenHostBridge(),
  trust: new TrustStore(new ChromeTrustStorage()),
  tabs: new ChromeTabStateStore(),
  holders: new ChromeViewHolderStore(),
  liveDocuments,
  settings,
  http,
  builtin,
  reachable,
  badge,
  broadcast,
  version: chrome.runtime.getManifest().version,
});

/**
 * Who sent a message, from facts Chrome vouches for. An extension page is one whose frame URL
 * is on the extension's own origin: the side panel (no tab) and `browser.html` (opened in a
 * tab) alike. A content script's frame URL is the website's, so it never passes that test,
 * and only the tab Chrome records for it, never anything it says, identifies the page.
 */
function senderOf(sender: chrome.runtime.MessageSender): Sender {
  const fromExtensionPage = sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(`${extensionOrigin}/`);
  return {
    extensionPage: fromExtensionPage,
    // The offscreen document (the execution host) is the only sender of `host.*` reports.
    offscreen: fromExtensionPage && sender.url === `${extensionOrigin}/execution.html`,
    tabId: sender.tab?.id ?? null,
    tabUrl: sender.tab?.url ?? null,
    frameUrl: typeof sender.url === "string" ? sender.url : null,
    topFrame: sender.frameId === 0,
    documentId: typeof sender.documentId === "string" ? sender.documentId : null,
  };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isEvent(message)) return false; // Our own broadcasts, echoed back.
  if (isHostCommand(message)) return false; // Our own commands to the execution host; it answers them.
  const who = senderOf(sender);
  (async () => {
    try {
      if (!who.extensionPage) {
        // A content script: the one message it may send, judged against Chrome's view of the tab.
        await controller.contentLinks(parseContentMessage(message), who);
        return success({ received: true });
      }
      return success(await controller.handle(parseRequest(message), who));
    } catch (error) {
      return failure(error);
    }
  })().then(sendResponse, (error: unknown) => sendResponse(failure(error)));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void controller.clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  // A navigation starts: the previous page's advertisements no longer apply. The new page's
  // content script reports again at document_idle.
  if (change.status === "loading" && change.url) void controller.clearTab(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
