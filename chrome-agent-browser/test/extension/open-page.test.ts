// @vitest-environment happy-dom
/**
 * T12 on the full page (`browser/browser.ts`): the Open view is a start page (the "WebAgents"
 * wordmark, the box, a hint, the open sessions) until something is shown, then a compact page with
 * the same box (D-140, D-141). Only the layout changes: the form, its input and button, the results
 * and the session rows are the elements the harnesses and the other tests select. happy-dom does no
 * layout; the geometry is checked in real Chrome by `scripts/screenshot-open-page.mjs`.
 */
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Event, SessionView } from "../../src/extension/messages.js";
import { failure, success } from "../../src/extension/messages.js";
import { readBytes, ROOT, SHIPPED } from "../helpers/paths.js";
import { makeHarness, PAGE_IN_TAB, type Route } from "../helpers/shell.js";

const ORIGIN = "https://webagents-webair-production.up.railway.app";
const routes: Record<string, Route> = {
  [`${ORIGIN}/agent-index.json`]: { body: readBytes(resolve(ROOT, "examples/agent-index.json")) },
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
h.clock.now = new Date("2026-10-10T12:00:00Z");

document.body.innerHTML = `<nav class="ab-nav"><a href="#open" data-view="open">Open</a><a href="#settings" data-view="settings">Settings</a></nav><main id="app"></main>`;
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

async function press(text: string, root: ParentNode = app()): Promise<void> {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${app().textContent?.slice(0, 400)}`);
  found.click();
  await settle();
  await settle();
}

/** What every layout of the Open view has: one wordmark heading and one address form, as before. */
function expectAddressBar(layout: "start" | "compact"): HTMLFormElement {
  const view = app().querySelectorAll<HTMLElement>(".ab-open");
  expect(view).toHaveLength(1);
  expect(view[0]!.classList.contains(`ab-open--${layout}`)).toBe(true);
  expect(view[0]!.classList.contains(`ab-open--${layout === "start" ? "compact" : "start"}`)).toBe(false);

  const marks = app().querySelectorAll<HTMLHeadingElement>("h1.ab-wordmark");
  expect(marks).toHaveLength(1);
  expect(marks[0]!.getAttribute("aria-label")).toBe("WebAgents");
  const letters = [...marks[0]!.children];
  expect(letters.map((node) => node.textContent).join("")).toBe("WebAgents");
  expect(letters.every((node) => node.tagName === "SPAN" && node.getAttribute("aria-hidden") === "true")).toBe(true);

  const forms = app().querySelectorAll<HTMLFormElement>("form.ab-address");
  expect(forms).toHaveLength(1);
  const form = forms[0]!;
  expect(form.closest(".ab-open-head")).not.toBeNull();
  expect(app().querySelectorAll('input[name="package-url"]')).toHaveLength(1);
  const input = form.querySelector<HTMLInputElement>('input[name="package-url"]')!;
  expect(input.classList.contains("ab-address-input")).toBe(true);
  expect(input.getAttribute("aria-label")).toBe("Search agents or open an address");
  expect(input.placeholder).toBe("Search agents, or paste an agent.pkg URL or a locator like flights@webair.example");
  const buttons = [...form.querySelectorAll("button")];
  expect(buttons.map((node) => node.textContent?.trim())).toEqual(["Open"]);
  expect(form.querySelector("svg.ab-address-icon")?.getAttribute("aria-hidden")).toBe("true");
  return form;
}

describe("the Open view as a start page (T12, D-140, D-141)", () => {
  it("starts with the wordmark, the tagline, the box, the hint and the link to the indexes", async () => {
    await go("#open");
    expectAddressBar("start");
    expect(app().querySelector(".ab-tagline")?.textContent).toBe("Find agents on the web. Run them on your terms.");
    expect(app().querySelector(".ab-open-intro")?.textContent).toContain("Nothing runs until you authorize an agent and press Run.");
    const manage = [...app().querySelectorAll<HTMLAnchorElement>(".ab-open-start a")].find((node) => node.textContent === "Manage indexes");
    expect(manage?.getAttribute("href")).toBe("#settings?section=search");
    // Nothing is open yet: no "Open now", no results, no card.
    expect(app().textContent).not.toContain("Open now");
    expect(app().querySelector(".ab-result, .ab-card, .ab-error")).toBeNull();
  });

  it("shows the open sessions on the start page as before (same rows, same links)", async () => {
    const opened = (await h.controller.handle({ type: "package.open", url: `${ORIGIN}/agent.pkg`, viewId: "seed" }, PAGE_IN_TAB)) as SessionView;
    await go("#settings");
    await go("#open");
    expectAddressBar("start");
    const start = app().querySelector<HTMLElement>(".ab-open-start")!;
    expect([...start.querySelectorAll("h4")].map((node) => node.textContent)).toEqual(["Open now"]);
    const rows = start.querySelectorAll<HTMLElement>(".ab-session-row");
    expect(rows).toHaveLength(1);
    const link = rows[0]!.querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toBe(`${opened.page.identity.name} v${opened.page.identity.version}`);
    expect(link.getAttribute("href")).toBe(`#session=${encodeURIComponent(opened.session.id)}`);
    expect(rows[0]!.querySelector(".ab-chip")?.textContent).toBe("unknown");
  });

  it("switches to the compact layout on a search, submitted with Enter, and keeps the result cards", async () => {
    await go("#settings?section=search");
    await press("Fill in the WebAgents demo index");
    await press("Add and verify");
    expect(app().querySelector(".ab-index-row")?.textContent).toContain("verified, current");

    await go("#open");
    const form = expectAddressBar("start");
    form.querySelector<HTMLInputElement>('input[name="package-url"]')!.value = "flights@webair.example";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    await settle();

    expectAddressBar("compact");
    expect(app().querySelector<HTMLInputElement>('input[name="package-url"]')!.value).toBe("flights@webair.example");
    const results = app().querySelectorAll<HTMLElement>(".ab-result");
    expect(results).toHaveLength(1);
    expect(results[0]!.closest(".ab-open-results")).not.toBeNull();
    expect(results[0]!.dataset.packageId).toBe(SHIPPED.webair050.packageId);
    expect(results[0]!.dataset.packageUrl).toBe(`${ORIGIN}/agent.pkg`);
    expect(results[0]!.textContent).toContain("Found in WebAgents demo index 1.2.0");
    expect([...results[0]!.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Open and verify"]);
    // The start block is not shown beside results.
    expect(app().querySelector(".ab-open-start")).toBeNull();
  });

  it("is compact on an error and still offers the hint and the open sessions below it", async () => {
    await go("#open");
    const input = app().querySelector<HTMLInputElement>('input[name="package-url"]')!;
    input.value = `${ORIGIN}/missing.agent.pkg`;
    await press("Open", app().querySelector("form.ab-address")!);
    expectAddressBar("compact");
    expect(app().querySelector(".ab-error")).not.toBeNull();
    const start = app().querySelector<HTMLElement>(".ab-open-start")!;
    expect(start.querySelectorAll(".ab-session-row")).toHaveLength(1);
  });

  it("is compact with an agent open, the agent page below the same box", async () => {
    const sessions = (await h.controller.handle({ type: "sessions.list" }, PAGE_IN_TAB)) as { sessions: Array<{ session_id: string }> };
    await go(`#session=${encodeURIComponent(sessions.sessions[0]!.session_id)}`);
    await settle();
    expectAddressBar("compact");
    expect(app().querySelector("article.ab-agent")).not.toBeNull();
    expect(app().querySelector(".ab-open-start")).toBeNull();
  });
});
