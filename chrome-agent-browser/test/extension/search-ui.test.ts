// @vitest-environment happy-dom
/**
 * T8 on the full page (`browser/browser.ts`) over a fake `chrome.runtime` routed to the
 * controller: Settings → Search adds the demo index from the filled-in demo values; the address
 * bar searches "literature review" and opens the result verified, with the index's claims shown
 * as matching; the agent is pinned to the Library; Settings → Policies subscribes to the research
 * policy; WebAir's authorize view then names the policy for what it pre-decided. The demo values
 * the page fills in are the shipped development keys.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { fingerprint, publicKeyFromPem } from "../../src/core/keys.js";
import type { Event, SessionView } from "../../src/extension/messages.js";
import { failure, success } from "../../src/extension/messages.js";
import demoDocuments from "../../src/extension/data/demo-documents.json" with { type: "json" };
import { readBytes, ROOT, SHIPPED } from "../helpers/paths.js";
import { until } from "../helpers/page.js";
import { makeHarness, PAGE_IN_TAB, type Route } from "../helpers/shell.js";

const ORIGIN = "https://webagents-webair-production.up.railway.app";
const routes: Record<string, Route> = {
  [`${ORIGIN}/agent-index.json`]: { body: readBytes(resolve(ROOT, "examples/agent-index.json")) },
  [`${ORIGIN}/policies/webagents-research.json`]: { body: readBytes(resolve(ROOT, "examples/policies/webagents-research.json")) },
  [`${ORIGIN}/packages/literature-review-0.2.9.agent.pkg`]: { body: readBytes(SHIPPED.literatureReview029.archive) },
  [`${ORIGIN}/agent.pkg`]: { body: readBytes(SHIPPED.webair080.archive) },
};

type Listener = (message: unknown) => void;
const listeners: Listener[] = [];
const h = makeHarness({
  routes,
  onEvent: (event: Event) => {
    for (const listener of listeners) listener(event);
  },
});
h.clock.now = new Date("2026-10-25T12:00:00Z");

document.body.innerHTML = `<nav class="ab-nav"><a href="#open" data-view="open">Open</a><a href="#library" data-view="library">Library</a><a href="#settings" data-view="settings">Settings</a></nav><main id="app"></main>`;
vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: async (message: unknown) => {
      try {
        return success(await h.controller.handle(message as Parameters<typeof h.controller.handle>[0], PAGE_IN_TAB));
      } catch (error) {
        return failure(error);
      }
    },
    onMessage: {
      addListener: (listener: Listener) => {
        listeners.push(listener);
      },
      removeListener: (listener: Listener) => {
        listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  },
});
await import("../../src/extension/browser/browser.js");

const app = () => document.getElementById("app")!;
/** The page's text contains `text` (B-149: every step waits for what it needs, with a deadline, never a fixed sleep). */
const shows = (text: string) => until(() => app().textContent?.includes(text), `"${text}" on the page; it shows: ${app().textContent?.slice(0, 300)}`);
const element = <T extends HTMLElement = HTMLElement>(selector: string) => until(() => app().querySelector<T>(selector), selector);

async function go(hash: string, ready: () => unknown): Promise<void> {
  location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
  await until(ready, `the page at ${hash}`);
}

function buttonNamed(text: string, root: ParentNode = app()): HTMLButtonElement | null {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text && !node.disabled) ?? null;
}

/**
 * Press the button named `text` once it is there, then wait for `after`. A press can land on a node
 * a re-render is about to replace, so the button is found and pressed again (at most every second)
 * until `after` holds or the deadline passes.
 */
async function press(text: string, after: () => unknown, root?: () => ParentNode | null, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const button = await until(() => buttonNamed(text, root?.() ?? app()), `a button "${text}"; the page shows: ${app().textContent?.slice(0, 300)}`, Math.max(1, deadline - Date.now()));
    button.click();
    try {
      await until(after, `the page after "${text}"`, Math.min(1_000, Math.max(1, deadline - Date.now())));
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
}

describe("the demo values the page fills in", () => {
  it("are the shipped development keys and the WebAir origin's paths", async () => {
    for (const [document, key] of [
      [demoDocuments.index, "examples/keys/webagents-index.pub.pem"],
      [demoDocuments.policy, "examples/keys/webagents-policy.pub.pem"],
    ] as const) {
      const pem = readFileSync(resolve(ROOT, key), "utf8");
      expect(document.public_key_pem).toBe(pem);
      expect(document.key_fingerprint).toBe(await fingerprint(publicKeyFromPem(pem)));
      expect(document.url.startsWith(`${ORIGIN}/`)).toBe(true);
    }
  });
});

describe("search, Library and policy on the full page (T8)", () => {
  it("adds the demo index, finds Literature Review, opens it verified, pins it, then a subscribed policy shows on WebAir's authorization", async () => {
    // Settings → Search: fill in the demo index and add it.
    await go("#settings?section=search", () => app().textContent?.includes("No index added yet."));
    await press("Fill in the WebAgents demo index", () => app().querySelector<HTMLInputElement>("input[name=indexUrl]")?.value);
    expect(app().querySelector<HTMLInputElement>("input[name=indexUrl]")!.value).toBe(demoDocuments.index.url);
    await press("Add and verify", () => app().querySelector(".ab-index-row"));
    const indexRow = await element(".ab-index-row");
    expect(indexRow.textContent).toContain("WebAgents demo index 1.6.0");
    expect(indexRow.textContent).toContain("verified, current");

    // The address bar searches words.
    await go("#open", () => app().querySelector(".ab-address-input"));
    const input = app().querySelector<HTMLInputElement>(".ab-address-input")!;
    input.value = "literature review";
    await press("Open", () => app().querySelector(".ab-result"), () => app().querySelector("form.ab-address"));
    const results = app().querySelectorAll<HTMLElement>(".ab-result");
    expect(results).toHaveLength(1);
    expect(results[0]!.dataset.packageId).toBe(SHIPPED.literatureReview029.packageId);
    expect(results[0]!.textContent).toContain("Found in WebAgents demo index 1.6.0");
    // The chip judges the signer the index claims (T8 review 1, finding 2).
    expect(results[0]!.textContent).toContain("claims a key you have not trusted");

    // Open and verify: the agent page, with what the index said compared with the bytes.
    const result = results[0]!;
    await press("Open and verify", () => app().querySelector(".ab-found-via") && app().textContent?.includes("Signed, publisher unknown"), () => result);
    expect(location.hash).toMatch(/^#session=/u);
    const banner = app().querySelector<HTMLElement>(".ab-found-via")!;
    expect(banner.dataset.claims).toBe("matches");
    expect(banner.textContent).toContain("matches what the index said");
    expect(app().textContent).toContain("Signed, publisher unknown");

    // Pin it, and find it in the Library.
    await press("Pin to Library", () => buttonNamed("Pin to Library") === null);
    await go("#library", () => app().querySelector(".ab-library-row") && app().textContent?.includes("Recently opened"));
    const pinned = app().querySelector<HTMLElement>(".ab-library-row")!;
    expect(pinned.dataset.packageUrl).toBe(`${ORIGIN}/packages/literature-review-0.2.9.agent.pkg`);
    expect(app().textContent).toContain("Recently opened");

    // Settings → Policies: subscribe to the example research policy.
    await go("#settings?section=policies", () => buttonNamed("Fill in the example WebAgents research policy"));
    await press("Fill in the example WebAgents research policy", () => buttonNamed("Subscribe"));
    await press("Subscribe", () => app().textContent?.includes("org.webagents.research@1.0.0"));
    expect(app().textContent).toContain("WebAgents research policy");
    expect(app().textContent).toContain("org.webagents.research@1.0.0");
    expect(app().textContent).toContain("WebAir (fictional demo airline) (webair-demo), for org.webagents.webair…");

    // WebAir by address: trusted through the policy, and its decisions name the policy.
    await go("#open", () => app().querySelector(".ab-address-input"));
    const address = app().querySelector<HTMLInputElement>(".ab-address-input")!;
    address.value = `${ORIGIN}/agent.pkg`;
    await press("Open", () => app().textContent?.includes("pre-decided by your policy"), () => app().querySelector("form.ab-address"));
    await shows("Signed by a publisher your policy trusts");
    expect(app().textContent).toContain("pre-decided by your policy WebAgents research policy (org.webagents.research@1.0.0)");
    // The flaky step before B-149: the customize view renders after its own reads, so wait for its chip.
    await press("Customize your settings", () => app().querySelector("[data-permission='network.webair']"));
    await until(() => [...app().querySelectorAll<HTMLElement>("[data-permission='network.webair'] .ab-chip, [data-permission='network.webair'] span")].some((node) => node.textContent === "decided by policy org.webagents.research@1.0.0"), "the policy chip on network.webair");
    const chips = [...app().querySelectorAll<HTMLElement>("[data-permission='network.webair'] .ab-chip, [data-permission='network.webair'] span")].map((node) => node.textContent);
    expect(chips).toContain("decided by policy org.webagents.research@1.0.0");
    const opened = (await h.controller.handle({ type: "sessions.list" }, PAGE_IN_TAB)) as { sessions: Array<Pick<SessionView["session"], "id">> };
    expect(opened.sessions.length).toBe(2);
  });
});

describe("T8 review carry-overs in the views (T9, B-136)", () => {
  it("the result chip says the index claims the key (finding 2)", async () => {
    const { trustChip } = await import("../../src/extension/ui/search.js");
    expect(trustChip("trusted", "pinned").textContent).toBe("claims a key you trust");
    expect(trustChip("trusted", "policy_anchor").textContent).toBe("claims a key your policy trusts");
    expect(trustChip("unknown", "signer_key_not_pinned").textContent).toBe("claims a key you have not trusted");
    expect(trustChip("mismatch", "publisher_key_mismatch").textContent).toBe("possible impersonation");
    expect(trustChip("unknown", "signer_not_stated").textContent).toBe("signer not stated by the index");
  });

  it("Settings → Search shows why a held index does not verify (nit 7)", async () => {
    const { newSettingsPageState, renderSettingsPage } = await import("../../src/extension/ui/settings-page.js");
    const h = makeHarness();
    const settings = (await h.controller.handle({ type: "settings.get" }, PAGE_IN_TAB)) as import("../../src/extension/messages.js").SettingsView;
    const indexes = {
      indexes: [{ url: "https://index.example/i.json", key_fingerprint: "sha256:00", enabled: true, added_at: "2026-10-08T00:00:00Z", fetched_at: "2026-10-08T00:00:00Z", state: "unverified" as const, index: null, signer_fingerprint: null, content_sha256: null, last_error: null, unverified_reason: "the document's signature does not verify" }],
      max_indexes: 8,
      nanda: { configured: false as const, note: "n" },
    };
    const root = renderSettingsPage(settings, null, newSettingsPageState("search"), { onSave: () => undefined, onSetKey: () => undefined, onProbe: () => undefined, rerender: () => undefined }, null, { indexes, policy: null });
    expect(root.querySelector(".ab-index-unverified")?.textContent).toBe("The copy held here does not verify: the document's signature does not verify");
  });
});

describe("an error that sends the page to another address shows there (T14 review 1, finding 1)", () => {
  it("a Library entry that cannot be opened lands on the Open page with its error", async () => {
    // The pinned agent's sessions closed, and its origin gone: "Open and verify" has to download again and fails.
    const opened = (await h.controller.handle({ type: "sessions.list" }, PAGE_IN_TAB)) as { sessions: Array<{ session_id: string }> };
    for (const session of opened.sessions) await h.controller.handle({ type: "package.close", sessionId: session.session_id }, PAGE_IN_TAB);
    const packageUrl = `${ORIGIN}/packages/literature-review-0.2.9.agent.pkg`;
    const saved = routes[packageUrl]!;
    delete routes[packageUrl];
    try {
      await go("#library", () => buttonNamed("Open and verify", app().querySelector(`.ab-library-row[data-package-url="${packageUrl}"]`) ?? app()));
      buttonNamed("Open and verify", app().querySelector(`.ab-library-row[data-package-url="${packageUrl}"]`)!)!.click();
      // The failed open moves to #open; the route there must not wipe the error that sent it.
      await until(() => location.hash === "#open" && app().querySelector(".ab-open"), "the Open page after the failed open");
      const error = await element(".ab-open--compact .ab-error");
      expect(error.textContent?.length).toBeGreaterThan(0);
      // It stays once the route's own reads have answered.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(app().querySelector(".ab-open--compact .ab-error")?.textContent).toBe(error.textContent);
    } finally {
      routes[packageUrl] = saved;
    }
  });
});
