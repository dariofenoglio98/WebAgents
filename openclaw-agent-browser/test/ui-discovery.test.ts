/**
 * The address bar takes a website as well as a package address.
 *
 * A website is read for advertised packages and each one is shown as what it
 * is: an unverified address. Nothing is opened until the person presses
 * Inspect, and then only through the same `packages.open-url` a typed package
 * address uses. These tests assert what the page sends and what it shows.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountAgentBrowser } from "../src/ui/page.js";
import {
  discoveryView,
  packageView,
  permissionsView,
  serviceStatus,
  websiteCandidate,
} from "./fixtures.js";

type Handler = (input: any) => unknown;
type Handlers = Record<string, Handler>;

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function mount(handlers: Handlers = {}, options: { canWrite?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const calls: Array<{ operation: string; input: any }> = [];
  const controller = new AbortController();
  const defaults: Handlers = {
    "service.status": () => serviceStatus(),
    "packages.list": () => ({ ok: true, value: { sessions: [], max: 8 } }),
    "packages.get": () => ({ ok: true, value: packageView() }),
    "packages.permissions": () => ({ ok: true, value: permissionsView() }),
    "packages.authorization": () => ({ ok: true, value: null }),
    "packages.close": () => ({ ok: true, value: { sessionId: "x", closed: true } }),
    "execution.status": () => ({ ok: true, value: { runs: [], active: null } }),
    "websites.discover": () => ({ ok: true, value: discoveryView() }),
    "packages.open-url": () => ({ ok: true, value: packageView() }),
  };
  const merged = { ...defaults, ...handlers };
  const dispose = mountAgentBrowser(container, {
    invoke: async (operation: string, input: unknown) => {
      calls.push({ operation, input });
      const handler = merged[operation];
      if (!handler) throw new Error(`unexpected operation ${operation}`);
      return handler(input);
    },
    signal: controller.signal,
    canWrite: options.canWrite ?? true,
  });
  const text = () => container.textContent ?? "";
  const operations = () => calls.map((call) => call.operation);
  return { container, calls, dispose, text, operations };
}

type Page = ReturnType<typeof mount>;

async function go(page: Page, url: string): Promise<void> {
  await settle();
  const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
  input.value = url;
  page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
  await settle();
}

const buttons = (page: Page, label: string) =>
  [...page.container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (node) => node.textContent === label,
  );

const websiteCard = (page: Page) => page.container.querySelector<HTMLElement>('[data-section="website"]');

let scrolled: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.innerHTML = "";
  scrolled = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrolled;
});
afterEach(() => {
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("one address bar for websites and packages", () => {
  it("reads a website for advertisements instead of opening it", async () => {
    const page = mount();
    await go(page, "https://shop.example/");
    expect(page.calls.filter((call) => call.operation === "websites.discover")).toEqual([
      { operation: "websites.discover", input: { url: "https://shop.example/" } },
    ]);
    expect(page.operations()).not.toContain("packages.open-url");
    expect(websiteCard(page)).not.toBeNull();
    page.dispose();
  });

  it.each([
    "https://shop.example/travel.agent.pkg",
    "https://shop.example/agent.pkg",
    "https://shop.example/AGENT.PKG?v=2",
  ])("still opens a package address directly: %s", async (url) => {
    const page = mount();
    await go(page, url);
    expect(page.calls.filter((call) => call.operation === "packages.open-url")).toEqual([
      { operation: "packages.open-url", input: { url } },
    ]);
    expect(page.operations()).not.toContain("websites.discover");
    expect(page.text()).toContain("Literature Review Agent");
    page.dispose();
  });

  it("says what it is doing while it reads the page", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    const page = mount({
      "websites.discover": async () => {
        await gate;
        return { ok: true, value: discoveryView() };
      },
    });
    await go(page, "https://shop.example/");
    expect(page.text()).toContain("Reading the website for an advertised agent package");
    release(null);
    await settle();
    expect(page.text()).not.toContain("Reading the website");
    page.dispose();
  });
});

describe("a website's advertisement", () => {
  it("is shown as an unverified address, with no package identity", async () => {
    const page = mount();
    await go(page, "https://shop.example/");
    const card = websiteCard(page)!;
    const text = card.textContent ?? "";
    expect(text).toContain("https://shop.example/agent.pkg");
    expect(text).toContain("Agent package advertised");
    expect(text).toContain("Unverified candidate");
    expect(text).toContain("That is only a location");
    expect(text).toContain("experimental WebAgents metadata, not a web standard");
    // Nothing the page could have claimed about the package is shown as fact.
    for (const word of ["Trusted", "Verified ✓", "Cryptographically valid", "Authorized", "publisher:"]) {
      expect(text).not.toContain(word);
    }
    expect(page.text()).not.toContain("Literature Review Agent");
    expect(card.querySelector(".ab-chip-good")).toBeNull();
    expect(buttons(page, "Inspect agent package")).toHaveLength(1);
    page.dispose();
  });

  it("is inspected only on request, through the ordinary open, and labelled afterwards", async () => {
    const page = mount();
    await go(page, "https://shop.example/");
    expect(page.operations()).not.toContain("packages.open-url");
    buttons(page, "Inspect agent package")[0]!.click();
    await settle();
    expect(page.calls.filter((call) => call.operation === "packages.open-url")).toEqual([
      { operation: "packages.open-url", input: { url: "https://shop.example/agent.pkg" } },
    ]);
    // The ordinary package view, with everything coming from the package.
    expect(websiteCard(page)).toBeNull();
    expect(page.text()).toContain("Literature Review Agent");
    expect(page.text()).toContain("Unknown publisher");
    expect(page.text()).toContain("Advertised on https://shop.example/");
    expect(page.text()).toContain("everything below comes from the package itself");
    page.dispose();
  });

  it("comes back when the inspected package is closed", async () => {
    const page = mount();
    await go(page, "https://shop.example/");
    buttons(page, "Inspect agent package")[0]!.click();
    await settle();
    buttons(page, "Close package")[0]!.click();
    await settle();
    expect(websiteCard(page)).not.toBeNull();
    page.dispose();
  });

  it("is replaced by a package opened by its own address", async () => {
    const page = mount();
    await go(page, "https://shop.example/");
    await go(page, "https://elsewhere.example/tool.agent.pkg");
    expect(page.text()).not.toContain("Advertised on");
    buttons(page, "Close package")[0]!.click();
    await settle();
    expect(websiteCard(page)).toBeNull();
    expect(page.text()).toContain("No package open");
    page.dispose();
  });

  it("lists several candidates and chooses none", async () => {
    const page = mount({
      "websites.discover": () => ({
        ok: true,
        value: discoveryView({
          status: "multiple_candidates",
          candidates: [
            websiteCandidate(),
            websiteCandidate({ index: 1, href: "/beta.agent.pkg", resolvedUrl: "https://shop.example/beta.agent.pkg" }),
          ],
          acceptedCount: 2,
        }),
      }),
    });
    await go(page, "https://shop.example/");
    expect(page.text()).toContain("Several agent packages advertised");
    expect(page.text()).toContain("does not choose between them");
    expect(buttons(page, "Inspect agent package")).toHaveLength(2);
    expect(page.operations()).not.toContain("packages.open-url");
    buttons(page, "Inspect agent package")[1]!.click();
    await settle();
    expect(page.calls.find((call) => call.operation === "packages.open-url")?.input).toEqual({
      url: "https://shop.example/beta.agent.pkg",
    });
    page.dispose();
  });

  it("explains a page that advertises nothing", async () => {
    const page = mount({
      "websites.discover": () => ({
        ok: true,
        value: discoveryView({ status: "no_candidate", candidates: [], acceptedCount: 0 }),
      }),
    });
    await go(page, "https://news.example/");
    expect(page.text()).toContain("No agent package advertised");
    expect(buttons(page, "Inspect agent package")).toHaveLength(0);
    page.dispose();
  });

  it("shows a rejected advertisement with its reason and no way to open it", async () => {
    const rejected = websiteCandidate({
      href: "https://other.example/evil.agent.pkg",
      resolvedUrl: "https://other.example/evil.agent.pkg",
      sameOrigin: false,
      accepted: false,
      rejectionReason: "cross_origin",
      rejectionMessage: "The package is advertised at https://other.example, not at this page's origin.",
    });
    const page = mount({
      "websites.discover": () => ({
        ok: true,
        value: discoveryView({
          status: "candidates_rejected",
          candidates: [rejected],
          acceptedCount: 0,
          rejectedCount: 1,
        }),
      }),
    });
    await go(page, "https://victim.example/");
    const text = websiteCard(page)!.textContent ?? "";
    expect(text).toContain("Advertised package not usable");
    expect(text).toContain("cross_origin");
    expect(text).toContain("https://other.example/evil.agent.pkg");
    expect(text).toContain("Not fetched");
    expect(buttons(page, "Inspect agent package")).toHaveLength(0);
    page.dispose();
  });

  it("shows what the page wrote when it differs from the resolved address, escaped", async () => {
    const page = mount({
      "websites.discover": () => ({
        ok: true,
        value: discoveryView({
          candidates: [
            websiteCandidate({
              href: "agents/current.agent.pkg",
              resolvedUrl: "https://shop.example/travel/agents/current.agent.pkg",
            }),
            websiteCandidate({
              index: 1,
              href: "/x\\u202egkp.exe",
              resolvedUrl: null,
              accepted: false,
              rejectionReason: "href_malformed",
              rejectionMessage: "The href is not accepted.",
            }),
          ],
        }),
      }),
    });
    await go(page, "https://shop.example/travel/");
    const text = websiteCard(page)!.textContent ?? "";
    expect(text).toContain("Written on the page as agents/current.agent.pkg");
    expect(text).toContain("/x\\u202egkp.exe");
    expect(text).not.toContain("‮");
    page.dispose();
  });

  it("offers to open an address that is not a web page as a package, on request only", async () => {
    const page = mount({
      "websites.discover": () => ({
        ok: false,
        error: {
          code: "discovery_not_html",
          title: "Not a web page",
          detail: "The website did not answer with an HTML page",
          retryable: false,
        },
      }),
    });
    await go(page, "https://shop.example/download?id=7");
    expect(page.text()).toContain("Not a web page");
    expect(page.operations()).not.toContain("packages.open-url");
    buttons(page, "Open as agent package")[0]!.click();
    await settle();
    expect(page.calls.find((call) => call.operation === "packages.open-url")?.input).toEqual({
      url: "https://shop.example/download?id=7",
    });
    page.dispose();
  });

  it("reports a refused website with the control plane's reason and no package", async () => {
    const page = mount({
      "websites.discover": () => ({
        ok: false,
        error: {
          code: "url_rejected",
          title: "This destination is not allowed",
          detail: "Website host resolves to a non-public destination (loopback_address)",
          retryable: false,
        },
      }),
    });
    await go(page, "https://localhost/");
    expect(page.text()).toContain("This destination is not allowed");
    expect(page.text()).toContain("loopback_address");
    expect(buttons(page, "Open as agent package")).toHaveLength(0);
    expect(websiteCard(page)).toBeNull();
    page.dispose();
  });

  it("gives a read-only operator nothing to press", async () => {
    const page = mount({}, { canWrite: false });
    await settle();
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    expect(input.disabled).toBe(true);
    page.dispose();
  });

  it("never authorizes, plans or runs anything", async () => {
    const page = mount();
    await go(page, "https://shop.example/");
    buttons(page, "Inspect agent package")[0]!.click();
    await settle();
    for (const operation of page.operations()) {
      expect(operation).not.toMatch(/authorize|run-plan\.prepare|execution\.start|trust\.pin/u);
    }
    page.dispose();
  });

  it("replaces an open package's view and keeps its session", async () => {
    const session = {
      sessionId: packageView().sessionId,
      packageId: "org.example.tool",
      version: "1.0.0",
      trustStatus: "unknown",
      authorizationState: "pending",
      runnable: false,
    };
    const page = mount({ "packages.list": () => ({ ok: true, value: { sessions: [session], max: 8 } }) });
    await go(page, "https://elsewhere.example/tool.agent.pkg");
    expect(page.text()).toContain("Literature Review Agent");
    await go(page, "https://shop.example/");
    expect(websiteCard(page)).not.toBeNull();
    expect(page.text()).not.toContain("Literature Review Agent");
    expect(page.operations()).not.toContain("packages.close");
    expect(page.container.querySelector(".ab-sessions")?.textContent).toContain("org.example.tool");
    page.dispose();
  });
});

describe("re-rendering keeps the person's place", () => {
  /** What a layout at this instant would see of the page's main column. */
  const shape = (page: Page) => ({
    top: page.container.querySelector(".ab-top")!.childElementCount,
    setup: page.container.querySelector(".ab-setup")!.childElementCount,
  });

  it("Inspect: focus leaves while the page is whole, and nothing moves the view", async () => {
    const page = mount();
    await go(page, "https://shop.example/");
    const inspect = buttons(page, "Inspect agent package")[0]!;
    let atBlur: ReturnType<typeof shape> | null = null;
    inspect.addEventListener("blur", () => (atBlur = shape(page)), { once: true });
    inspect.focus();
    const before = shape(page);
    inspect.click();
    await settle();
    await settle();
    expect(inspect.isConnected).toBe(false);
    expect(atBlur).toEqual(before);
    expect(before.top).toBe(1);
    expect(scrolled).not.toHaveBeenCalled();
    page.dispose();
  });

  it("discovering a website, with or without a package open, moves nothing", async () => {
    const page = mount();
    await go(page, "https://elsewhere.example/tool.agent.pkg");
    const open = buttons(page, "Open")[0]!;
    open.focus();
    await go(page, "https://shop.example/");
    await go(page, "https://news.example/");
    expect(scrolled).not.toHaveBeenCalled();
    expect(shape(page).top).toBe(1);
    page.dispose();
  });
});
