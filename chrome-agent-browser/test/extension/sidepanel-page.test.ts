// @vitest-environment happy-dom
/**
 * The side panel (`sidepanel/sidepanel.ts`) over a fake `chrome` routed to the controller, the
 * way Chrome runs it: the panel document has its own id, a closing panel sends nothing, and a
 * reopened panel is a new document that imports the module afresh (a new view id, nothing open).
 * T5a, D-076: the reopened panel shows the run still in flight, with Cancel, and Inspect pressed
 * again from the same page brings the same run back. Demo 3's walk-through found the panel
 * showing the website card instead; the unit tests had reattached with the old session id, and
 * the live harness's `#session=` routing carried it, so neither noticed.
 */
import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../../src/core/models/transport.js";
import type { AuthorizeResult, Event, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { failure, success } from "../../src/extension/messages.js";
import type { Sender } from "../../src/extension/background/controller.js";
import { scriptedOrigin } from "../helpers/host.js";
import { SHIPPED } from "../helpers/paths.js";
import { makeHarness, PACKAGE_MEDIA_TYPE, PAGE, PAGE_IN_TAB, SITE_ORIGIN, TAB, WEBAIR_040_URL } from "../helpers/shell.js";

const SEARCH = { request: "Find me a nonstop flight from Boston to Zurich on 9 October under $900.", booking: false, purchase: { quote_id: "", fare_id: "" } };
const WEBAIR_TAB_ID = TAB.tabId!;

type Listener = (message: unknown) => void;
const listeners: Listener[] = [];
/** The documents Chrome still reports open (`chrome.runtime.getContexts`): a closed panel leaves it. */
const live = new Set<string>();

let reached = 0;
const hanging: HttpTransport = (request) =>
  new Promise((_resolve, reject) => {
    reached += 1;
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });

const h = makeHarness({
  transports: { model: hanging, tool: scriptedOrigin().transport },
  liveDocuments: live,
  onEvent: (event: Event) => {
    for (const listener of [...listeners]) listener(event);
  },
});

/** Message types the worker fails once, as a restarting worker would (finding 2 of review 1). */
const failOnce = new Set<string>();

/** `chrome` as one side-panel document sees it: messages carry its document id, the active tab is WebAir. */
function chromeFor(documentId: string) {
  const sender: Sender = { ...PAGE, documentId };
  return {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      sendMessage: async (message: unknown) => {
        const type = (message as { type: string }).type;
        if (failOnce.delete(type)) return { ok: false, error: { code: "worker_unavailable", message: "The service worker restarted" } };
        try {
          return success(await h.controller.handle(message as Parameters<typeof h.controller.handle>[0], sender));
        } catch (error) {
          return failure(error);
        }
      },
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: (listener: Listener) => listeners.splice(listeners.indexOf(listener), 1),
      },
    },
    tabs: {
      query: async () => [{ id: WEBAIR_TAB_ID, url: `${SITE_ORIGIN}/`, active: true }],
      create: async () => ({}),
      onActivated: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
    },
  };
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const app = () => document.getElementById("app")!;
const buttonNamed = (label: string) => [...app().querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);

async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return;
    await settle(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Open the panel as Chrome does: a fresh document, the module imported anew. The previous
 * panel document is gone: Chrome reports it no longer, and it sent no release when it closed.
 */
async function openPanel(documentId: string): Promise<void> {
  for (const id of [...live]) if (id.startsWith("panel-")) live.delete(id);
  listeners.length = 0;
  document.body.innerHTML = `<main id="app"></main>`;
  live.add(documentId);
  vi.stubGlobal("chrome", chromeFor(documentId));
  vi.resetModules();
  await import("../../src/extension/sidepanel/sidepanel.js");
  await settle();
  await settle();
}

/** The run surface the panel shows, or null. */
const runSurface = () => app().querySelector<HTMLElement>(".ab-run");

describe("the side panel finds its run again (T5a, D-076)", () => {
  let runId = "";
  let sessionId = "";

  it("a panel closed during a run and reopened shows the run as running, with Cancel", async () => {
    // The WebAir tab advertises 0.4.0; the person opens the panel and presses Inspect.
    await h.controller.contentLinks({ type: "content.links", links: [{ href: WEBAIR_040_URL, type: PACKAGE_MEDIA_TYPE, title: "WebAir Travel Agent" }] }, TAB);
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    settings.models.default_model = "ollama/qwen3:30b";
    await h.controller.handle({ type: "settings.set", settings }, PAGE);
    await openPanel("panel-1");
    expect(app().textContent).toContain("Inspect agent package");
    buttonNamed("Inspect agent package")!.click();
    await until(() => app().querySelector(".ab-agent") !== null, "the agent page");
    sessionId = ((await h.controller.handle({ type: "sessions.list" }, PAGE)) as { sessions: Array<{ session_id: string }> }).sessions[0]!.session_id;
    // Trust, "Search flights" and Run, as the panel's own buttons do them.
    await h.controller.handle({ type: "trust.pin", sessionId, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    runId = ((await h.controller.handle({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: SEARCH }, PAGE)) as RunView).runId;
    await until(() => reached === 1, "the model call in flight");
    await until(() => runSurface()?.dataset.runId === runId, "the run in the first panel");

    // The person closes the panel (no message) and opens it again a little later: a new document, nothing open.
    h.clock.now = new Date(h.clock.now.getTime() + 10_000);
    const tagsBefore = h.httpLog.filter((request) => request.url.endsWith("/api/tags")).length;
    await openPanel("panel-2");
    await until(() => runSurface() !== null, "the run surface in the reopened panel");
    expect(runSurface()!.dataset.runId).toBe(runId);
    expect(runSurface()!.dataset.state).toBe("running");
    expect(buttonNamed("Cancel"), "Cancel is offered").toBeDefined();
    expect(app().textContent).not.toContain("Inspect agent package");
    // Its model list was read from the providers again when it opened, not from the worker's cache (D-077).
    expect(h.httpLog.filter((request) => request.url.endsWith("/api/tags")).length).toBeGreaterThan(tagsBefore);
    // The reopened panel holds the run's session as its own view, so its Close works as before.
    const holders = await h.holders.get(sessionId);
    expect(holders.map((holder) => holder.document_id)).toContain("panel-2");
  });

  it("a reopened panel whose run history cannot be read at first (the worker restarting) still shows the run and its session", async () => {
    failOnce.add("run.list");
    await openPanel("panel-3");
    await until(() => runSurface()?.dataset.runId === runId, "the run found by the readiness check");
    expect(runSurface()!.dataset.state).toBe("running");
    expect(failOnce.size, "the history read did fail once").toBe(0);
    expect(app().textContent).not.toContain("Inspect agent package");
    expect((await h.holders.get(sessionId)).map((holder) => holder.document_id)).toContain("panel-3");
  });

  it("Inspect pressed again from the same page brings the same run back", async () => {
    // A full page shows the session too, so Close in the panel leaves the session (and its run) open.
    live.add("page-1");
    await h.controller.handle({ type: "package.get", sessionId, viewId: "browser:1" }, { ...PAGE_IN_TAB, documentId: "page-1" });
    buttonNamed("Close")!.click();
    await until(() => buttonNamed("Inspect agent package") !== undefined, "the website card after Close");
    expect(runSurface()).toBeNull();
    buttonNamed("Inspect agent package")!.click();
    await until(() => runSurface() !== null, "the run surface after Inspect");
    expect(runSurface()!.dataset.runId).toBe(runId);
    expect(runSurface()!.dataset.state).toBe("running");
    expect(((await h.controller.handle({ type: "sessions.list" }, PAGE)) as { sessions: SessionView[] }).sessions).toHaveLength(1);
  });

  it("the full page opened fresh (no #session=) during the run shows it too, and Cancel ends it", async () => {
    listeners.length = 0;
    document.body.innerHTML = `<nav class="ab-nav"><a href="#open" data-view="open">Open</a></nav><main id="app"></main>`;
    history.replaceState(null, "", location.pathname);
    live.add("page-2");
    vi.stubGlobal("chrome", chromeFor("page-2"));
    vi.resetModules();
    await import("../../src/extension/browser/browser.js");
    await until(() => runSurface() !== null, "the run surface on the fresh full page");
    expect(runSurface()!.dataset.runId).toBe(runId);
    expect(runSurface()!.dataset.state).toBe("running");
    expect(location.hash).toBe(`#session=${encodeURIComponent(sessionId)}`);
    buttonNamed("Cancel")!.click();
    await h.h_drain();
    await until(() => runSurface()?.dataset.state === "cancelled", "the cancelled run");
  });
});
