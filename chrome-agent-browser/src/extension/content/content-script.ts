/**
 * The content script (D-026): reads only the `link` elements of the document head whose
 * `rel` tokens include `agent-package`, and reports their `href`, `type` and `title`
 * attributes to the service worker. It reads nothing else on the page, writes nothing into
 * it, exposes nothing to it and listens to nothing from it. The page's URL is not sent: the
 * service worker takes it from Chrome's own record of the tab.
 */
import { DISCOVERY_REL, relTokens } from "../../core/discovery.js";
import type { ContentLink, ContentMessage } from "../messages.js";

const MAX_LINKS = 16;

export function collectLinks(root: Document): ContentLink[] {
  const head = root.head;
  if (!head) return [];
  const links: ContentLink[] = [];
  for (const element of head.querySelectorAll("link")) {
    const rel = element.getAttribute("rel");
    if (rel === null || !relTokens(rel).has(DISCOVERY_REL)) continue;
    links.push({
      href: element.getAttribute("href"),
      type: element.getAttribute("type"),
      title: element.getAttribute("title"),
    });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

function report(): void {
  const links = collectLinks(document);
  const message: ContentMessage = { type: "content.links", links };
  chrome.runtime.sendMessage(message).catch(() => {
    // The service worker is not reachable (for example during an extension update); nothing to do.
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) report();
