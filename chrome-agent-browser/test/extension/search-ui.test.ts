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
import { makeHarness, PAGE_IN_TAB, type Route } from "../helpers/shell.js";

const ORIGIN = "https://webagents-webair-production.up.railway.app";
const routes: Record<string, Route> = {
  [`${ORIGIN}/agent-index.json`]: { body: readBytes(resolve(ROOT, "examples/agent-index.json")) },
  [`${ORIGIN}/policies/webagents-research.json`]: { body: readBytes(resolve(ROOT, "examples/policies/webagents-research.json")) },
  [`${ORIGIN}/packages/literature-review-0.2.6.agent.pkg`]: { body: readBytes(SHIPPED.literatureReview026.archive) },
  [`${ORIGIN}/agent.pkg`]: { body: readBytes(SHIPPED.webair050.archive) },
};

type Listener = (message: unknown) => void;
const listeners: Listener[] = [];
const h = makeHarness({
  routes,
  onEvent: (event: Event) => {
    for (const listener of listeners) listener(event);
  },
});
h.clock.now = new Date("2026-10-09T12:00:00Z");

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
const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
async function go(hash: string): Promise<void> {
  location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
  await settle();
  await settle();
}

function buttonNamed(text: string, root: ParentNode = app()): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${app().textContent?.slice(0, 400)}`);
  return found;
}

async function press(text: string, root?: ParentNode): Promise<void> {
  buttonNamed(text, root).click();
  await settle();
  await settle();
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
    await go("#settings?section=search");
    expect(app().textContent).toContain("No index added yet.");
    await press("Fill in the WebAgents demo index");
    expect(app().querySelector<HTMLInputElement>("input[name=indexUrl]")!.value).toBe(demoDocuments.index.url);
    await press("Add and verify");
    const indexRow = app().querySelector<HTMLElement>(".ab-index-row")!;
    expect(indexRow.textContent).toContain("WebAgents demo index 1.1.0");
    expect(indexRow.textContent).toContain("verified, current");

    // The address bar searches words.
    await go("#open");
    const input = app().querySelector<HTMLInputElement>(".ab-address-input")!;
    input.value = "literature review";
    await press("Open", app().querySelector("form.ab-address")!);
    const results = app().querySelectorAll<HTMLElement>(".ab-result");
    expect(results).toHaveLength(1);
    expect(results[0]!.dataset.packageId).toBe(SHIPPED.literatureReview026.packageId);
    expect(results[0]!.textContent).toContain("Found in WebAgents demo index 1.1.0");
    // The chip judges the signer the index claims (T8 review 1, finding 2).
    expect(results[0]!.textContent).toContain("claims a key you have not trusted");

    // Open and verify: the agent page, with what the index said compared with the bytes.
    await press("Open and verify", results[0]!);
    await settle();
    expect(location.hash).toMatch(/^#session=/u);
    const banner = app().querySelector<HTMLElement>(".ab-found-via")!;
    expect(banner.dataset.claims).toBe("matches");
    expect(banner.textContent).toContain("matches what the index said");
    expect(app().textContent).toContain("Signed, publisher unknown");

    // Pin it, and find it in the Library.
    await press("Pin to Library");
    await go("#library");
    const pinned = app().querySelector<HTMLElement>(".ab-library-row")!;
    expect(pinned.dataset.packageUrl).toBe(`${ORIGIN}/packages/literature-review-0.2.6.agent.pkg`);
    expect(app().textContent).toContain("Recently opened");

    // Settings → Policies: subscribe to the example research policy.
    await go("#settings?section=policies");
    await press("Fill in the example WebAgents research policy");
    await press("Subscribe");
    expect(app().textContent).toContain("WebAgents research policy");
    expect(app().textContent).toContain("org.webagents.research@1.0.0");
    expect(app().textContent).toContain("WebAir (fictional demo airline) (webair-demo), for org.webagents.webair…");

    // WebAir by address: trusted through the policy, and its decisions name the policy.
    await go("#open");
    const address = app().querySelector<HTMLInputElement>(".ab-address-input")!;
    address.value = `${ORIGIN}/agent.pkg`;
    await press("Open", app().querySelector("form.ab-address")!);
    await settle();
    expect(app().textContent).toContain("Signed by a publisher your policy trusts");
    expect(app().textContent).toContain("pre-decided by your policy WebAgents research policy (org.webagents.research@1.0.0)");
    await press("Customize your settings");
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
