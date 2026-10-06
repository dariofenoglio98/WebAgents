/**
 * The background service worker: the only place that holds state (D-035). It wires Chrome's
 * APIs to the controller and nothing else: messages from extension pages and content
 * scripts, tab navigation and removal, the action badge, and the side panel behaviour.
 */
import { TrustStore } from "../../core/trust.js";
import { failure, isEvent, parseContentMessage, parseRequest, success, type Event } from "../messages.js";
import { IndexedDbSnapshotStore } from "../storage/snapshots.js";
import { ChromeTabStateStore } from "../storage/tab-state.js";
import { ChromeTrustStorage } from "../storage/trust-storage.js";
import { Controller, type Sender } from "./controller.js";

const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

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

function broadcast(event: Event): void {
  chrome.runtime.sendMessage(event).catch(() => {
    // No page is listening; that is normal.
  });
}

const controller = new Controller({
  fetch: (url, init) => fetch(url, init),
  snapshots: new IndexedDbSnapshotStore(),
  trust: new TrustStore(new ChromeTrustStorage()),
  tabs: new ChromeTabStateStore(),
  badge,
  broadcast,
  version: chrome.runtime.getManifest().version,
});

function senderOf(sender: chrome.runtime.MessageSender): Sender {
  const fromExtensionPage = sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(`${extensionOrigin}/`) && !sender.tab;
  return {
    extensionPage: fromExtensionPage,
    tabId: sender.tab?.id ?? null,
    tabUrl: sender.tab?.url ?? null,
  };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isEvent(message)) return false; // Our own broadcasts, echoed back.
  const who = senderOf(sender);
  (async () => {
    try {
      if (who.tabId !== null && !who.extensionPage) {
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
