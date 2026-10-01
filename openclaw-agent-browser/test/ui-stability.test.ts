/**
 * The page keeps the person's place while it re-renders.
 *
 * The Agent Browser renders whole regions from state. In Chromium, removing
 * the element that holds focus — usually the control just pressed — makes the
 * browser lay the page out at that moment. Removing a region child by child,
 * or emptying one region before refilling another, exposed a half-empty page
 * to that layout, and the host's scroll container clamped its offset: after
 * Authorize, choosing a model, Prepare run or switching a contents tab, the
 * view jumped up by as much as two thousand pixels and stayed there.
 *
 * happy-dom performs no layout, so a scroll offset cannot be asserted here.
 * These tests pin the structural guarantees that make the jump impossible
 * instead: focus is released only while every region of the page is whole, a
 * region's children leave in one operation, focus returns to the equivalent
 * control without scrolling, and a disclosure the person opened stays open.
 * The offsets themselves were measured in headless Chrome against the host's
 * own stylesheet before and after the change.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSummary } from "../src/contract.js";
import { clear, el, replace } from "../src/ui/dom.js";
import { mountAgentBrowser } from "../src/ui/page.js";
import {
  modelCatalogView,
  packageView,
  permissionsView,
  receiptView,
  runPlanStateView,
  serviceStatus,
} from "./fixtures.js";
import { literaturePlan, literatureView, readiness, runRecord, screeningProgress } from "./run-fixtures.js";

type Handler = (input: any) => unknown;
type Handlers = Record<string, Handler>;

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function mount(handlers: Handlers = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const calls: Array<{ operation: string; input: any }> = [];
  const controller = new AbortController();
  const defaults: Handlers = {
    "service.status": () => serviceStatus(),
    "packages.list": () => ({ ok: true, value: { sessions: [], max: 8 } }),
    "packages.open-url": () => ({ ok: true, value: packageView() }),
    "packages.get": () => ({ ok: true, value: packageView() }),
    "packages.permissions": () => ({ ok: true, value: permissionsView() }),
    "packages.authorization": () => ({ ok: true, value: null }),
    "packages.authorize": () => ({ ok: true, value: receiptView() }),
    "models.evaluate": () => ({ ok: true, value: modelCatalogView() }),
    "run-plan.get": () => ({ ok: true, value: { plan: null, preflight: null, executionSupported: false } }),
    "run-plan.prepare": () => ({ ok: true, value: runPlanStateView() }),
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
    canWrite: true,
  });
  return { container, calls, dispose };
}

type Page = ReturnType<typeof mount>;

async function open(page: Page): Promise<void> {
  await settle();
  const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
  input.value = "https://packages.example/x.agent.pkg";
  page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
  await settle();
}

const buttonLabelled = (page: Page, label: string) =>
  [...page.container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!;

const modelRadio = (page: Page, modelId: string) =>
  page.container.querySelector<HTMLInputElement>(`input[name='agent-browser-model'][value='${modelId}']`)!;

/** What a layout at this instant would see of the page's main column. */
function shape(page: Page) {
  const region = (selector: string) => page.container.querySelector<HTMLElement>(selector)!;
  return {
    header: region(".ab-top").childElementCount,
    runPanel: region(".ab-run-host").childElementCount,
    cards: [...region(".ab-setup").children].map(
      (card) => card.querySelector(".ab-card-title")?.textContent ?? card.className,
    ),
  };
}

/**
 * Press a control the way a pointer does in Chromium, where it takes focus
 * first, and record the page's shape at the moment the control gives it up.
 */
async function press(page: Page, control: HTMLElement, act: () => void = () => control.click()) {
  const before = shape(page);
  let released: ReturnType<typeof shape> | null = null;
  control.addEventListener("blur", () => (released = shape(page)), { once: true });
  control.focus();
  expect(document.activeElement).toBe(control);
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  act();
  await settle();
  await settle();
  const focusCalls = focus.mock.calls.map(([options]) => options);
  focus.mockRestore();
  return { before, released: released as ReturnType<typeof shape> | null, focusCalls };
}

/** The guarantees every in-place re-render owes the person who pressed something. */
function expectPlaceKept(
  pressed: HTMLElement,
  result: Awaited<ReturnType<typeof press>>,
  same: (node: Element | null) => boolean,
) {
  // The control really was re-rendered, so this exercises the dangerous path.
  expect(pressed.isConnected).toBe(false);
  // Focus left it only while every region was whole: header, Run panel and
  // every setup card still attached, exactly as before the press.
  expect(result.released).not.toBeNull();
  expect(result.released).toEqual(result.before);
  expect(result.before.header).toBe(1);
  expect(result.before.runPanel).toBe(1);
  // It came back to the control standing where the pressed one stood, and
  // nothing the page did moved the view to get it there.
  expect(same(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(pressed);
  expect(result.focusCalls.length).toBeGreaterThan(0);
  expect(result.focusCalls.every((options) => options?.preventScroll === true)).toBe(true);
}

let scrolled: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.innerHTML = "";
  scrolled = vi.fn();
  // happy-dom has no layout; record any request to move the view.
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrolled;
});
afterEach(() => {
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("re-rendering keeps the person's place", () => {
  it("Authorize", async () => {
    const page = mount();
    await open(page);
    const authorize = buttonLabelled(page, "Authorize");
    const result = await press(page, authorize);
    expect(page.calls.map((call) => call.operation)).toContain("packages.authorize");
    expectPlaceKept(authorize, result, (node) => node instanceof HTMLButtonElement && node.textContent === "Authorize");
    expect(page.container.textContent).toContain("Authorized for this session");
    expect(scrolled).not.toHaveBeenCalled();
    page.dispose();
  });

  it("choosing a model", async () => {
    const page = mount({ "packages.authorization": () => ({ ok: true, value: receiptView() }) });
    await open(page);
    const radio = modelRadio(page, "acme/big");
    const result = await press(page, radio, () => {
      radio.checked = true;
      radio.dispatchEvent(new Event("change"));
    });
    expectPlaceKept(radio, result, (node) => node === modelRadio(page, "acme/big"));
    expect(modelRadio(page, "acme/big").checked).toBe(true);
    expect(buttonLabelled(page, "Prepare run").disabled).toBe(false);
    expect(scrolled).not.toHaveBeenCalled();
    page.dispose();
  });

  it("Prepare run", async () => {
    const page = mount({ "packages.authorization": () => ({ ok: true, value: receiptView() }) });
    await open(page);
    const radio = modelRadio(page, "acme/big");
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    await settle();
    const prepare = buttonLabelled(page, "Prepare run");
    const result = await press(page, prepare);
    expect(page.calls.map((call) => call.operation)).toContain("run-plan.prepare");
    expectPlaceKept(prepare, result, (node) => node instanceof HTMLButtonElement && node.textContent === "Prepare run");
    expect(page.container.textContent).toContain("Ready to run");
    expect(scrolled).not.toHaveBeenCalled();
    page.dispose();
  });

  it.each(["Tools", "Workflow", "Overview"])("switching the contents tab to %s", async (label) => {
    const page = mount();
    await open(page);
    // Start somewhere else so every label is a real switch.
    if (label === "Overview") {
      buttonLabelled(page, "Workers").click();
      await settle();
    }
    const tab = buttonLabelled(page, label);
    const result = await press(page, tab);
    const selected = (node: Element | null) =>
      node instanceof HTMLButtonElement &&
      node.textContent === label &&
      node.getAttribute("role") === "tab" &&
      node.getAttribute("aria-selected") === "true";
    expectPlaceKept(tab, result, selected);
    expect(scrolled).not.toHaveBeenCalled();
    page.dispose();
  });

  it("keeps a disclosure the person opened open across the re-render", async () => {
    const page = mount({ "packages.authorization": () => ({ ok: true, value: receiptView() }) });
    await open(page);
    const details = () => [...page.container.querySelectorAll<HTMLDetailsElement>("details.ab-model-details")];
    expect(details().length).toBe(3);
    details()[0]!.open = true;
    const radio = modelRadio(page, "acme/silent");
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    await settle();
    expect(details().map((node) => node.open)).toEqual([true, false, false]);
    page.dispose();
  });

  it("still moves the page when a checklist Go link asks for it", async () => {
    const page = mount({
      "packages.list": () => ({
        ok: true,
        value: {
          sessions: [
            {
              sessionId: packageView().sessionId,
              packageId: packageView().identity.packageId,
              version: packageView().identity.version,
              trustStatus: "trusted",
              authorizationState: "none",
              runnable: false,
            },
          ],
          max: 8,
        },
      }),
    });
    await open(page);
    const go = page.container.querySelector<HTMLButtonElement>(".ab-checklist li.ab-check-no button")!;
    expect(go.textContent).toBe("Go");
    go.click();
    await settle();
    // Intended navigation is the page's own decision and is left alone.
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    page.dispose();
  });
});

describe("progress updates", () => {
  it("re-render the run without touching the setup cards, and keep focus on Cancel", async () => {
    const pkg = literatureView();
    const running = runRecord({ status: "running", progress: screeningProgress(), sessionId: pkg.sessionId });
    const page = mount({
      "packages.list": () => ({
        ok: true,
        value: {
          sessions: [
            {
              sessionId: pkg.sessionId,
              packageId: pkg.identity.packageId,
              version: pkg.identity.version,
              trustStatus: pkg.publisher.trustStatus,
              authorizationState: "issued",
              runnable: true,
            },
          ],
          max: 8,
        },
      }),
      "packages.get": () => ({ ok: true, value: pkg }),
      "packages.authorization": () => ({ ok: true, value: receiptView() }),
      "run-plan.get": () => ({ ok: true, value: literaturePlan() }),
      "files.list": () => ({ ok: true, value: { files: [] } }),
      "execution.status": () => ({ ok: true, value: { runs: [runSummary(running)], active: running } }),
      "execution.readiness": () => ({ ok: true, value: readiness() }),
      "execution.get": () => ({ ok: true, value: running }),
    });
    // A reload reconnects to the run in flight; wait until that session has
    // also read its model catalog, the last thing that re-renders the cards.
    await waitFor(() => Boolean(page.container.querySelector(".ab-progress")));
    await waitFor(() => page.calls.some((call) => call.operation === "models.evaluate"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    const cards = [...page.container.querySelector(".ab-setup")!.children];
    expect(cards.length).toBeGreaterThan(4);
    const progress = page.container.querySelector(".ab-progress");
    buttonLabelled(page, "Cancel").focus();
    const polls = () => page.calls.filter((call) => call.operation === "execution.get").length;
    const seen = polls();
    await waitFor(() => polls() >= seen + 2, 8000);
    await settle();
    // The run view re-rendered; the cards the person may be reading did not.
    expect(page.container.querySelector(".ab-progress")).not.toBe(progress);
    const after = [...page.container.querySelector(".ab-setup")!.children];
    expect(after).toHaveLength(cards.length);
    expect(after.every((card, index) => card === cards[index])).toBe(true);
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe("Cancel");
    expect(scrolled).not.toHaveBeenCalled();
    page.dispose();
  });
});

describe("the region primitives", () => {
  function region(...children: HTMLElement[]) {
    const node = el("div", {}, ...children);
    document.body.append(node);
    return node;
  }
  const button = (text: string) => el("button", { text });

  it("release focus while every child is still attached, then empty the region", async () => {
    const node = region(button("One"), button("Two"), button("Three"), button("Four"));
    const focused = node.children[2] as HTMLElement;
    focused.focus();
    let attachedAtBlur = -1;
    focused.addEventListener("blur", () => (attachedAtBlur = node.childElementCount));
    clear(node);
    // The two children before the focused one were still there: a layout the
    // browser forces while fixing focus up sees the region whole.
    expect(attachedAtBlur).toBe(4);
    expect(node.childElementCount).toBe(0);
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("return focus to the matching control by label, then position, without scrolling", async () => {
    const node = region(button("Open"), button("Open"), button("Close"));
    (node.children[1] as HTMLElement).focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const next = [button("Open"), button("Open"), button("Close")];
    replace(node, next);
    await settle();
    expect(document.activeElement).toBe(next[1]);
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    focus.mockRestore();
  });

  it("match a radio by its value even when the order changes", async () => {
    const radio = (value: string) => el("input", { attrs: { type: "radio", name: "pick", value } });
    const node = region(radio("x"), radio("y"), radio("z"));
    (node.children[1] as HTMLElement).focus();
    const next = [radio("z"), radio("x"), radio("y")];
    replace(node, next);
    await settle();
    expect(document.activeElement).toBe(next[2]);
  });

  it("never touch focus held outside the region", async () => {
    const typing = el("textarea");
    document.body.append(typing);
    typing.focus();
    const blurred = vi.fn();
    typing.addEventListener("blur", blurred);
    const node = region(button("Run"));
    replace(node, [button("Run")]);
    await settle();
    expect(blurred).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(typing);
  });

  it("not return focus into a disabled or missing control, or over focus taken meanwhile", async () => {
    const node = region(button("Authorize"));
    (node.children[0] as HTMLElement).focus();
    const disabled = button("Authorize");
    disabled.disabled = true;
    replace(node, [disabled]);
    await settle();
    expect(document.activeElement).toBe(document.body);

    (node.children[0] as HTMLButtonElement).disabled = false;
    (node.children[0] as HTMLElement).focus();
    replace(node, [button("Discard")]);
    await settle();
    expect(document.activeElement).toBe(document.body);

    (node.children[0] as HTMLElement).focus();
    const elsewhere = el("input");
    document.body.append(elsewhere);
    replace(node, [button("Discard")]);
    elsewhere.focus();
    await settle();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("reopen the disclosures the person opened, and leave closed ones closed", async () => {
    const disclosure = (summary: string, open: boolean) => {
      const node = el("details", {}, el("summary", { text: summary }), el("p", { text: "body" }));
      node.open = open;
      return node;
    };
    const node = region(disclosure("Details", true), disclosure("Details", false), disclosure("Receipt", true));
    const next = [disclosure("Details", false), disclosure("Details", false), disclosure("Receipt", false)];
    replace(node, next);
    await settle();
    expect(next.map((item) => item.open)).toEqual([true, false, true]);
  });
});
