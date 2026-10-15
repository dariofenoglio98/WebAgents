// @vitest-environment happy-dom
/**
 * The full-page agent browser (`browser/browser.ts`) over a fake `chrome.runtime` routed to the
 * controller: the Runs page shows the chosen run while a package is open in the same tab, and
 * going back to the package re-attaches its run surface (T5 review 1, finding 5); Open shows the
 * chosen run before the list and focuses it, and an open error is shown on the Runs page (T14).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthorizationView, AuthorizeResult, Event, ProbeView, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { failure, success } from "../../src/extension/messages.js";
import { probeSummary } from "../../src/extension/ui/settings-page.js";
import { scriptedOllama, scriptedOrigin, webairModelAnswers } from "../helpers/host.js";
import { SHIPPED } from "../helpers/paths.js";
import { makeHarness, PAGE_IN_TAB, SEED_PASSPHRASE, SITE_ORIGIN, WEBAIR_040_URL } from "../helpers/shell.js";

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
    expect(shown, "the chosen run is rendered while the package stays open").not.toBeNull();
    expect(shown!.dataset.state).toBe("completed");
    expect(shown!.textContent).toContain("WebAir answered");
    expect(app().textContent).toContain("Export"); // the list stays, below the run (D-160)

    // Back on the open package: the run surface is attached to the session again (its form and checklist, not a read-only view).
    await go(`#session=${encodeURIComponent(sessionId)}`);
    const back = app().querySelector<HTMLElement>(".ab-run");
    expect(back).not.toBeNull();
    expect([...back!.querySelectorAll("button")].map((item) => item.textContent)).toContain("New run");
    await go("#open");
    expect(app().querySelector<HTMLElement>(".ab-run")).not.toBeNull();
  });

  it("keeps showing the panel when it moves to another run from 'Earlier runs', and the address follows (review 2, nit 4)", async () => {
    // A second run of the open package, so the first has an "earlier" sibling.
    const sessionId = ((await h.controller.handle({ type: "sessions.list" }, PAGE_IN_TAB)) as { sessions: Array<{ session_id: string }> }).sessions[0]!.session_id;
    const authorization = (await h.controller.handle({ type: "authorization.get", sessionId }, PAGE_IN_TAB)) as AuthorizationView;
    const plan = authorization.run_plan!.run_plan;
    const secondRun = (await h.controller.handle({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE_IN_TAB)) as RunView;
    await h.h_drain();
    const second = secondRun.runId;
    const list = (await h.controller.handle({ type: "run.list", sessionId }, PAGE_IN_TAB)) as { runs: Array<{ runId: string }> };
    const first = list.runs.find((run) => run.runId !== second)!.runId;

    await go(`#run=${encodeURIComponent(first)}`);
    const shown = app().querySelector<HTMLElement>(".ab-run");
    expect(shown).not.toBeNull();
    const earlier = shown!.querySelector<HTMLButtonElement>(`.ab-run-list li[data-run="${second}"] button`);
    expect(earlier, "the other run is listed under 'Earlier runs of this agent'").not.toBeNull();
    earlier!.click();
    await settle();
    await settle();
    // The panel switched runs on its own; the page still shows it, and the address names the run now shown.
    expect(location.hash).toBe(`#run=${encodeURIComponent(second)}`);
    const after = app().querySelector<HTMLElement>(".ab-run");
    expect(after, "the run detail stays on the Runs page after the panel moved to another run").not.toBeNull();
    expect(after!.dataset.state).toBe("completed");
    expect(after!.querySelector(`.ab-run-list li[data-run="${first}"]`), "the earlier list now names the first run").not.toBeNull();
    expect(after!.querySelector(`.ab-run-list li[data-run="${second}"]`)).toBeNull();
  });
});

describe("Runs → Open shows the run (T14, D-160, D-161)", () => {
  const listRow = (runId: string) => app().querySelector<HTMLElement>(`.ab-card .ab-run-list li[data-run="${runId}"]`);
  const openButton = (runId: string) => [...(listRow(runId)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((node) => node.textContent === "Open") ?? null;
  const shownRun = () => app().querySelector<HTMLElement>(":scope > .ab-run");
  const heading = () => shownRun()?.querySelector<HTMLElement>(".ab-run-title h2") ?? null;

  it("with at least 10 runs listed, Open renders the chosen run before the list and focuses its heading; Open on it again re-shows it", async () => {
    const sessionId = ((await h.controller.handle({ type: "sessions.list" }, PAGE_IN_TAB)) as { sessions: Array<{ session_id: string }> }).sessions[0]!.session_id;
    const plan = ((await h.controller.handle({ type: "authorization.get", sessionId }, PAGE_IN_TAB)) as AuthorizationView).run_plan!.run_plan;
    for (let index = 0; index < 9; index += 1) {
      await h.controller.handle({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE_IN_TAB);
      await h.h_drain();
    }
    await go("#runs");
    const rows = await vi.waitFor(() => {
      const found = app().querySelectorAll<HTMLElement>(".ab-card .ab-run-list li[data-run]");
      expect(found.length).toBeGreaterThanOrEqual(10);
      return [...found];
    });
    expect(shownRun()).toBeNull();
    const oldest = rows.at(-1)!.dataset.run!;

    openButton(oldest)!.click();
    await vi.waitFor(() => expect(shownRun()?.dataset.state).toBe("completed"));
    expect(location.hash).toBe(`#run=${encodeURIComponent(oldest)}`);
    expect(shownRun()!.dataset.runId).toBe(oldest);
    const children = [...app().children];
    const listCard = listRow(oldest)!.closest(".ab-card")!;
    expect(children.indexOf(shownRun()!), "the run comes before the list").toBeLessThan(children.indexOf(listCard as HTMLElement));
    expect(app().querySelector(".ab-runs-back a")?.getAttribute("href")).toBe("#runs");
    await vi.waitFor(() => expect(document.activeElement).toBe(heading()));

    // Open again on the run already in the address: no hashchange, and the page shows and focuses it again.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).not.toBe(heading());
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    openButton(oldest)!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(scrolled).toHaveBeenCalled();
    scrolled.mockRestore();
    expect(shownRun()!.dataset.runId).toBe(oldest);
  });

  it("an unknown run id shows run_unknown on the Runs page, and the list stays usable", async () => {
    await go("#run=run_does_not_exist");
    const box = await vi.waitFor(() => {
      const found = app().querySelector<HTMLElement>(".ab-error");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(box.textContent).toContain("run_unknown");
    expect(box.textContent).toContain("This browser holds no run with that id.");
    expect(shownRun()).toBeNull();
    const first = app().querySelector<HTMLElement>(".ab-card .ab-run-list li[data-run]")!.dataset.run!;
    openButton(first)!.click();
    await vi.waitFor(() => expect(shownRun()?.dataset.runId).toBe(first));
    expect(app().querySelector(".ab-error"), "the error goes once a run is shown").toBeNull();
  });

  it("an error from another view does not follow the person to the next address (B-150 item 4, D-161)", async () => {
    // A session id this browser does not hold: the Open page shows the error.
    await go("#session=no_such_session");
    await vi.waitFor(() => expect(app().querySelector(".ab-error")).not.toBeNull());
    await go("#runs");
    await vi.waitFor(() => expect(app().querySelector(".ab-card .ab-run-list li[data-run]")).not.toBeNull());
    expect(app().querySelector(".ab-error"), "the Open page's error stays there").toBeNull();
    await go("#open");
    expect(app().querySelector(".ab-error")).toBeNull();
    expect(app().querySelector(".ab-open")?.classList.contains("ab-open--start"), "nothing is shown, so the start page (a stale error kept it compact)").toBe(true);
  });
});

describe("Settings → Models: the connection chips describe the providers now (T5a, D-077)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const ollamaCard = () => [...app().querySelectorAll<HTMLElement>(".ab-card")].find((node) => node.querySelector(".ab-card-title")?.textContent === "Ollama (local)")!;
  const ollamaChip = () => [...ollamaCard().querySelectorAll<HTMLElement>(".ab-chip")].find((node) => /reachable|failed/u.test(node.textContent ?? "")) ?? null;
  const tab = (label: string) => [...app().querySelectorAll<HTMLButtonElement>(".ab-tabs button")].find((node) => node.textContent === label)!;

  it("opening the section tests the enabled connections, the chip says when, and reopening clears the old answer and tests again, once per provider", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 8, 14, 2, 31));
    const probe = vi.spyOn(h.controller, "probe");
    await go("#settings?section=models");
    // (`go` also dispatches the hashchange happy-dom fires itself, so the page routes twice here.)
    expect(new Set(probe.mock.calls.map(([provider]) => provider)), "the enabled connections, without pressing Test").toEqual(new Set(["ollama", "chrome-builtin"]));
    expect(ollamaChip()?.textContent).toBe("reachable · 1 model · checked 14:02:31");

    // Ollama is stopped meanwhile; the person opens the Models section again a few minutes later.
    const answers = new Map<string, (value: ProbeView) => void>();
    probe.mockImplementation((provider) => new Promise<ProbeView>((resolve) => answers.set(provider, resolve)));
    probe.mockClear();
    vi.setSystemTime(new Date(2026, 9, 8, 14, 5, 0));
    tab("Policies").click();
    tab("Models").click();
    await settle(20);
    expect(ollamaChip(), "the old 'reachable' is gone while the new test runs").toBeNull();
    expect(ollamaCard().textContent).toContain("Testing…");
    tab("Models").click(); // opened again while the tests are still running: no second test of either
    await settle(20);
    expect(probe.mock.calls.map(([provider]) => provider).sort()).toEqual(["chrome-builtin", "ollama"]);
    answers.get("chrome-builtin")!({ provider: "chrome-builtin", ok: false, models: [], notes: [], error: "unsupported", diagnosis: null });
    answers.get("ollama")!({ provider: "ollama", ok: false, models: [], notes: [], error: "Ollama did not answer at http://127.0.0.1:11434 (/api/tags failed: TypeError)", diagnosis: { state: "not_running", hint: "Nothing answers at http://127.0.0.1:11434." } });
    await settle();
    expect(ollamaChip()?.textContent).toBe("failed: Ollama did not answer at http://127.0.0.1:11434 (/api/tags failed: TypeError) · checked 14:05:00");
    expect(ollamaCard().textContent).toContain("Nothing answers at http://127.0.0.1:11434.");
    // A click on the Models tab already shown is not a reopening: the answer stays, nothing is tested (review 1, nit 6).
    probe.mockClear();
    tab("Models").click();
    await settle(20);
    expect(probe).not.toHaveBeenCalled();
    expect(ollamaChip()?.textContent).toContain("checked 14:05:00");
  });

  it("a provider that answered and then stopped part way says how many models are usable, not a plain 'reachable' (review 1, nit 4)", () => {
    const model = (name: string, available: boolean) => ({ id: `ollama/${name}`, available });
    expect(probeSummary({ provider: "ollama", ok: true, models: [model("a", true), model("b", false), model("c", false)], notes: [], error: null })).toEqual({ text: "reachable · 1 of 3 models usable", tone: "warn" });
    expect(probeSummary({ provider: "ollama", ok: true, models: [model("a", true)], notes: [], error: null })).toEqual({ text: "reachable · 1 model", tone: "good" });
    expect(probeSummary({ provider: "ollama", ok: false, models: [], notes: [], error: "Ollama stopped answering" })).toEqual({ text: "failed: Ollama stopped answering", tone: "bad" });
  });
});

describe("Settings → Files: the file-input fallback (T6 review, nit 9)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a closed dialog settles the pick with nothing copied, so the page renders again and a later pick still works", async () => {
    // happy-dom has no File System Access picker, so Pick PDFs… takes the <input type=file> path.
    expect((window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker).toBeUndefined();
    const inputs: HTMLInputElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const node = create(tag, options);
      if (tag === "input") inputs.push(node as HTMLInputElement);
      return node;
    }) as typeof document.createElement);
    const send = vi.spyOn(h.controller, "handle");
    await go("#settings?section=files");
    const pick = () => [...app().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Pick PDFs…")!;
    pick().click();
    const input = inputs.find((node) => node.type === "file")!;
    expect(input).toBeDefined();
    const before = app().firstElementChild;
    input.dispatchEvent(new Event("cancel"));
    await settle();
    // `pickFiles` finished: it re-rendered the page and copied nothing.
    expect(app().firstElementChild).not.toBe(before);
    expect(send.mock.calls.filter(([message]) => (message as { type: string }).type === "files.add")).toHaveLength(0);
    pick().click();
    expect(inputs.filter((node) => node.type === "file")).toHaveLength(2);
  });
});

describe("Settings → Memory (T19, the user's walk-through)", () => {
  it("the Memory tab clicked inside Settings loads the section, and Add demo set adds the six records", async () => {
    await go("#settings?section=models");
    [...app().querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Memory")!.click();
    await settle();
    await settle();
    const add = [...app().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add demo set");
    expect(add, "the Memory section rendered after a tab click, not Loading…").toBeDefined();
    add!.click();
    await settle();
    await settle();
    await settle();
    expect(app().textContent).toContain("6 fictional records labelled demo");
    expect(app().textContent).toContain("Remove demo set…");
    await h.controller.handle({ type: "memory.removeDemo" }, PAGE_IN_TAB);
    await settle();
  });
});

describe("Memory while the store is locked (T16, the user's walk-through; memory.v0 M-10)", () => {
  it("is read-only with an Unlock button, and the lock line goes once the store is unlocked, without leaving the page", async () => {
    await h.controller.handle({ type: "memory.installDemo" }, PAGE_IN_TAB);
    await h.controller.handle({ type: "secrets.lock" }, PAGE_IN_TAB);
    await go("#memory");
    expect(app().querySelector(".ab-memory-status")?.textContent).toContain("store locked · unlock to edit");
    expect([...app().querySelectorAll("button")].some((node) => node.textContent === "Unlock")).toBe(true);
    [...app().querySelectorAll<HTMLButtonElement>(".ab-memory-toggle button")].find((node) => node.textContent === "List")!.click();
    expect(app().textContent).toContain("Demo Traveler"); // everything unsealed stays readable
    expect(app().textContent).not.toContain("alex.traveler@example.com");
    // Unlocked from anywhere (the sheet, the nav chip, another view): the worker broadcasts event.secrets and event.memory.
    await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE_IN_TAB);
    await settle();
    await settle();
    expect(app().querySelector(".ab-memory-status")?.textContent).not.toContain("store locked");
    expect(app().textContent).toContain("Demo");
  });
});
