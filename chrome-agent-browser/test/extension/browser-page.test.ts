// @vitest-environment happy-dom
/**
 * The full-page agent browser (`browser/browser.ts`) over a fake `chrome.runtime` routed to the
 * controller: the Runs page shows the chosen run while a package is open in the same tab, and
 * going back to the package re-attaches its run surface (T5 review 1, finding 5).
 */
import { describe, expect, it, vi } from "vitest";

import type { AuthorizeResult, Event, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { failure, success } from "../../src/extension/messages.js";
import { scriptedOllama, scriptedOrigin, webairModelAnswers } from "../helpers/host.js";
import { SHIPPED } from "../helpers/paths.js";
import { makeHarness, PAGE_IN_TAB, SITE_ORIGIN, WEBAIR_040_URL } from "../helpers/shell.js";

const SEARCH_TEXT = "Find me a nonstop flight from Boston to Zurich on 9 October under $900.";
type Listener = (message: unknown) => void;
const listeners: Listener[] = [];
const h = makeHarness({
  transports: { model: scriptedOllama(webairModelAnswers()).transport, tool: scriptedOrigin().transport },
  onEvent: (event: Event) => {
    for (const listener of listeners) listener(event);
  },
});

document.body.innerHTML = `<nav class="ab-nav"><a href="#open" data-view="open">Open</a><a href="#runs" data-view="runs">Runs</a></nav><main id="app"></main>`;
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
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
async function go(hash: string): Promise<void> {
  location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
  await settle();
  await settle();
}

describe("the full-page browser's Runs page", () => {
  it("shows the chosen run while a package is open, and re-attaches the package's run surface on the way back (finding 5)", async () => {
    // A trusted WebAir session with one completed run, made through the controller as the page would.
    const opened = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "seed" }, PAGE_IN_TAB)) as SessionView;
    const sessionId = opened.session.id;
    await h.controller.handle({ type: "trust.pin", sessionId, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE_IN_TAB);
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE_IN_TAB)) as SettingsView).settings;
    settings.models.default_model = "ollama/qwen3:30b";
    await h.controller.handle({ type: "settings.set", settings }, PAGE_IN_TAB);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE_IN_TAB)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE_IN_TAB)) as RunView;
    await h.h_drain();

    // The package is open in this tab: the agent page with the run surface showing the adopted run.
    await go(`#session=${encodeURIComponent(sessionId)}`);
    expect(app().querySelector(".ab-agent-page, .ab-authorize")).not.toBeNull();
    const surface = app().querySelector<HTMLElement>(".ab-run");
    expect(surface).not.toBeNull();
    expect(surface!.dataset.state).toBe("completed");

    // The Runs page lists the run; clicking it must show the run, not only the list.
    await go("#runs");
    expect(app().textContent).toContain("Runs");
    expect(app().querySelector(".ab-run")).toBeNull(); // the list alone until a run is chosen
    await go(`#run=${encodeURIComponent(started.runId)}`);
    const shown = app().querySelector<HTMLElement>(".ab-run");
    expect(shown, "the chosen run is rendered under the list while the package stays open").not.toBeNull();
    expect(shown!.dataset.state).toBe("completed");
    expect(shown!.textContent).toContain("WebAir answered");
    expect(app().textContent).toContain("Export"); // the list stays above it

    // Back on the open package: the run surface is attached to the session again (its form and checklist, not a read-only view).
    await go(`#session=${encodeURIComponent(sessionId)}`);
    const back = app().querySelector<HTMLElement>(".ab-run");
    expect(back).not.toBeNull();
    expect([...back!.querySelectorAll("button")].map((item) => item.textContent)).toContain("New run");
    await go("#open");
    expect(app().querySelector<HTMLElement>(".ab-run")).not.toBeNull();
  });
});
