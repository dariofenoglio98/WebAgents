// @vitest-environment happy-dom
/**
 * The views (D-034): the agent page renders the core's model through `textContent` only, the
 * pin control needs two presses, a hostile README can never become markup, and the website
 * and trust cards offer exactly the actions they should. No file under `src/extension` uses
 * `innerHTML` or any other markup sink.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import type { CandidateState, SessionView, TrustList } from "../../src/extension/messages.js";
import { renderAgentPage } from "../../src/extension/ui/agent-page.js";
import { renderTrustPage } from "../../src/extension/ui/trust-page.js";
import { renderWebsiteCard } from "../../src/extension/ui/website.js";
import { PROJECT, readBytes, SHIPPED } from "../helpers/paths.js";
import { hostilePackage, makeHarness, PACKAGE_MEDIA_TYPE, PACKAGE_URL, PAGE, SITE_ORIGIN, TAB, type Harness } from "../helpers/shell.js";

const SOURCE = { kind: "website" as const, display: PACKAGE_URL, advertised_on: `${SITE_ORIGIN}/`, opened_at: "2026-10-06T12:00:00Z" };

async function webairView(h: Harness = makeHarness()): Promise<SessionView> {
  return h.controller.openBytes(readBytes(SHIPPED.webair.archive), SOURCE);
}

function texts(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? "");
}

describe("the agent page", () => {
  it("renders the person-first card in D-034's order, then the technical details", async () => {
    const view = await webairView();
    const article = renderAgentPage(view);
    expect(article.dataset.trust).toBe("unknown");
    expect(article.dataset.session).toBe(view.session.id);
    expect(article.querySelector("h2")?.textContent).toBe("WebAir Travel Agent");
    expect(article.querySelector(".ab-agent-publisher")?.textContent).toBe("by WebAir (fictional demo airline)");
    expect(texts(article, ".ab-card-title")).toEqual(["Publisher", "What it does", "Access", "Origin and cost"]);
    expect(article.querySelector(".ab-trust-head .ab-chip")?.textContent).toBe("Signed, publisher unknown");
    expect(article.querySelector(".ab-trust")?.getAttribute("data-signature")).toBe("valid");
    expect(article.querySelector(".ab-description")?.textContent).toBe(view.page.about.description);
    const kinds = [...article.querySelectorAll(".ab-access-group")].map((group) => group.getAttribute("data-kind"));
    expect(kinds[0]).toBe("personal.read");
    expect(kinds).toContain("network");
    expect(texts(article, ".ab-access-item .ab-chip")).toContain("Required");
    expect(article.textContent).toContain("Websites it may contact: webagents-webair-production.up.railway.app");
    expect(article.querySelector(".ab-source")?.textContent).toContain(PACKAGE_URL);
    expect(article.querySelector(".ab-source")?.textContent).toContain(`${SITE_ORIGIN}/`);
    const technical = [...article.querySelectorAll("details.ab-details")].find((node) => node.querySelector("summary")?.textContent === "Technical details");
    expect(technical).toBeDefined();
    expect(technical?.hasAttribute("open")).toBe(false);
    expect(technical?.textContent).toContain(SHIPPED.webair.digest);
    expect(technical?.textContent).toContain(SHIPPED.webair.archiveSha256);
    expect(technical?.textContent).toContain(SHIPPED.webair.fingerprint);
    expect(technical?.querySelector("pre.ab-pre")?.textContent).toContain('"package_id": "org.webagents.webair"');
    expect(article.querySelector(".ab-execution-note")?.textContent).toContain("never executes");
    expect(article.querySelector(".ab-profiles")).toBeNull();
  });

  it("offers the full page from the compact panel view and closes", async () => {
    const view = await webairView();
    let opened = 0;
    let closed = 0;
    const article = renderAgentPage(view, { compact: true, onOpenFullPage: () => (opened += 1), onClose: () => (closed += 1) });
    expect(article.classList.contains("ab-agent-compact")).toBe(true);
    const buttons = [...article.querySelectorAll<HTMLButtonElement>(".ab-agent-actions button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Open in full page", "Close"]);
    buttons[0]!.click();
    buttons[1]!.click();
    expect([opened, closed]).toEqual([1, 1]);
  });

  it("pins only after two presses, with the chosen scope, and never shows the control for a trusted key", async () => {
    const h = makeHarness();
    const view = await webairView(h);
    const scopes: string[] = [];
    const article = renderAgentPage(view, { onTrust: (scope) => scopes.push(scope) });
    const confirm = article.querySelector<HTMLButtonElement>(".ab-pin button")!;
    expect(confirm.textContent).toBe("Trust this publisher key");
    confirm.click();
    expect(scopes).toEqual([]);
    expect(confirm.textContent).toBe("Press again to trust this key");
    confirm.click();
    expect(scopes).toEqual(["package"]);

    const wide = renderAgentPage(view, { onTrust: (scope) => scopes.push(scope) });
    wide.querySelector<HTMLSelectElement>(".ab-pin select")!.value = "publisher";
    const button = wide.querySelector<HTMLButtonElement>(".ab-pin button")!;
    button.click();
    button.click();
    expect(scopes).toEqual(["package", "publisher"]);

    await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair.fingerprint, scope: "package" }, PAGE);
    const trusted = renderAgentPage((await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView, { onTrust: () => undefined });
    expect(trusted.dataset.trust).toBe("trusted");
    expect(trusted.querySelector(".ab-trust-head .ab-chip")?.textContent).toBe("Signed by a publisher you trust");
    expect(trusted.querySelector(".ab-pin")).toBeNull();
  });

  it("a hostile README reaches the page as text, never as markup", async () => {
    const h = makeHarness();
    const { bytes } = await hostilePackage();
    const view = await h.controller.openBytes(bytes, { kind: "url", display: "https://agenda.example/a.pkg", advertised_on: null, opened_at: "2026-10-06T12:00:00Z" });
    const article = renderAgentPage(view);
    expect(article.querySelector("script")).toBeNull();
    expect(article.querySelector("img")).toBeNull();
    const readme = article.querySelector(".ab-markdown")!;
    expect(readme.textContent).toContain("<script>alert(1)</script>");
    expect(readme.textContent).toContain("<img src=x onerror=alert(1)>");
    const anchors = [...readme.querySelectorAll("a")];
    expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual(["https://example.com/docs"]);
    expect(anchors[0]?.getAttribute("rel")).toContain("noopener");
    expect(readme.textContent).toContain("unsafe link");
    expect(view.page.identity.runtime_status).toBe("incompatible");
    expect(article.querySelector(".ab-technical")?.textContent).toContain("Not runnable here");
  });
});

describe("the website card", () => {
  it("offers Inspect for accepted candidates only and names the rejected ones", async () => {
    const h = makeHarness();
    await h.controller.contentLinks(
      { type: "content.links", links: [{ href: "/agent.pkg", type: PACKAGE_MEDIA_TYPE, title: null }, { href: "https://other.example/x.pkg", type: null, title: null }] },
      TAB,
    );
    const state = (await h.controller.handle({ type: "candidates.get", tabId: 7 }, PAGE)) as CandidateState;
    const inspected: string[] = [];
    const card = renderWebsiteCard(state, (candidate) => inspected.push(candidate.resolved_url!));
    expect(card.querySelector(".ab-website-url")?.textContent).toBe(`${SITE_ORIGIN}/`);
    const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Inspect agent package"]);
    expect(card.querySelector(".ab-candidate code")?.textContent).toBe(PACKAGE_URL);
    expect(texts(card, ".ab-candidate .ab-chip")).toContain("Unverified candidate");
    expect(card.querySelector(".ab-rejected")?.textContent).toContain("cross_origin");
    buttons[0]!.click();
    expect(inspected).toEqual([PACKAGE_URL]);
    expect(card.textContent).toContain("experimental WebAgents convention");
  });

  it("says so when nothing is advertised", () => {
    const card = renderWebsiteCard({ pageUrl: `${SITE_ORIGIN}/about`, pageOrigin: SITE_ORIGIN, status: "no_candidate", candidates: [], linksNotListed: 0 }, () => undefined);
    expect(card.textContent).toContain("advertises no agent package");
    expect(card.querySelector("button")).toBeNull();
  });
});

describe("the trust page", () => {
  it("lists pinned keys with their scope, arms removal, and pins pasted keys", async () => {
    const h = makeHarness();
    const view = await webairView(h);
    await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair.fingerprint, scope: "package" }, PAGE);
    const list = (await h.controller.handle({ type: "trust.list" }, PAGE)) as TrustList;
    const removed: string[] = [];
    const pinned: unknown[] = [];
    const page = renderTrustPage(list.entries, list.state, { onUnpin: (fingerprint) => removed.push(fingerprint), onPinKey: (input) => pinned.push(input) });
    const entry = page.querySelector<HTMLElement>(".ab-trust-entry")!;
    expect(entry.dataset.fingerprint).toBe(SHIPPED.webair.fingerprint);
    expect(entry.textContent).toContain("one package id");
    expect(entry.textContent).toContain(SHIPPED.webair.packageId);
    const remove = entry.querySelector<HTMLButtonElement>("button")!;
    remove.click();
    expect(removed).toEqual([]);
    expect(remove.textContent).toBe("Press again to remove");
    remove.click();
    expect(removed).toEqual([SHIPPED.webair.fingerprint]);

    page.querySelector<HTMLTextAreaElement>("textarea[name=public-key-pem]")!.value = "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----";
    page.querySelector<HTMLInputElement>("input[name=display-name]")!.value = "Out of band";
    page.querySelector<HTMLInputElement>("input[name=publisher-id]")!.value = " pub ";
    [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Pin this key")!.click();
    expect(pinned).toEqual([{ publicKeyPem: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----", displayName: "Out of band", publisherId: "pub", packageIdPrefix: null }]);
  });
});

describe("no markup sink in the shell", () => {
  it("src/extension never assigns innerHTML, outerHTML, srcdoc or calls insertAdjacentHTML or document.write", () => {
    const root = join(PROJECT, "src", "extension");
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|html|css|json)$/u.test(name)) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      // Comments may mention the sinks by name; code may not use them.
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
      const hit = /\b(?:innerHTML|outerHTML|srcdoc|insertAdjacentHTML|document\.write|eval\s*\(|new\s+Function\b)/u.exec(text);
      expect(hit, `${relative(PROJECT, file)} uses ${hit?.[0]}`).toBeNull();
    }
  });
});
