// @vitest-environment happy-dom
/**
 * The authorize view, the Settings pages and the Your data page (T3, Demo 2) over the worker's
 * real answers through the fake `chrome` API: two clicks from the agent page to "Ready to run"
 * for WebAir 0.4.0's "Search flights"; the customize view with its per-item controls and
 * provenance; the trust prompt for an unknown publisher; keys typed and never echoed; the
 * fictional demo set added only on request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { failure, parseRequest, success, type AuthorizationView, type AuthorizeResult, type ModelsView, type RunPlanState, type SessionView, type SettingsView, type MemoryView } from "../../src/extension/messages.js";
import { bindAuthorization } from "../../src/extension/ui/authorization-flow.js";
import { newAuthorizeState, renderAuthorizeView, type AuthorizeActions, type AuthorizeState } from "../../src/extension/ui/authorize.js";
import { newSettingsPageState, renderSettingsPage } from "../../src/extension/ui/settings-page.js";
import { newMemoryPageState, openCard, renderMemoryPage, type MemoryPageActions } from "../../src/extension/ui/memory/page.js";
import { MASK } from "../../src/extension/ui/memory/strings.js";
import { SHIPPED } from "../helpers/paths.js";
import { DEMO, makeHarness, OLLAMA_ANSWERS, PAGE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";

const QWEN = "ollama/qwen3:30b";

async function openWebair(h: Harness, trust = true): Promise<SessionView> {
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "ui" }, PAGE)) as SessionView;
  if (trust) await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = QWEN;
  settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, overrides: { "qwen3:30b": { context_tokens: 65536 } } } : connection));
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  return (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
}

/** The view as the surfaces drive it: actions call the worker and re-render with its answers. */
function mount(h: Harness, session: SessionView, state: AuthorizeState = newAuthorizeState()) {
  const root = document.createElement("div");
  let view: AuthorizationView | null = null;
  let models: ModelsView | null = null;
  let busy: string | null = null;
  const calls: string[] = [];
  /** The last worker round trip an action started, so tests await the real work instead of a timer. */
  let pending: Promise<unknown> = Promise.resolve();
  const load = async () => {
    view = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    if (view.receipt || state.customize) models = (await h.controller.handle({ type: "models.evaluate", sessionId: session.session.id, refresh: false }, PAGE)) as ModelsView;
    session = (await h.controller.handle({ type: "package.get", sessionId: session.session.id }, PAGE)) as SessionView;
  };
  const render = () => {
    root.replaceChildren(renderAuthorizeView({ session, view: view!, models, busy }, state, actions));
  };
  const actions: AuthorizeActions = {
    onUseProfile: (profileId, picks) => {
      calls.push(`useProfile:${profileId}`);
      busy = "…";
      pending = h.controller
        .handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: view!.package_digest, profileId, resourceSelections: picks, prepare: true }, PAGE)
        .then(async (result) => {
          const outcome = result as AuthorizeResult;
          state.notice = { text: outcome.run_plan?.preflight.ready ? "Authorized and ready to run. Nothing has run." : "Authorized.", tone: "good" };
          busy = null;
          await load();
          render();
        });
    },
    onAuthorize: (decisions, approvals, picks, provenance, modelId) => {
      calls.push(`authorize:${modelId ?? "default"}`);
      pending = h.controller
        .handle({ type: "authorization.authorize", sessionId: session.session.id, packageDigest: view!.package_digest, decisions, toolApprovals: approvals, resourceSelections: picks, provenance, prepare: true, modelId }, PAGE)
        .then(async () => {
          state.customize = false;
          await load();
          render();
        });
    },
    onPrepare: (modelId) => {
      calls.push(`prepare:${modelId}`);
      pending = h.controller.handle({ type: "runplan.prepare", sessionId: session.session.id, packageDigest: view!.package_digest, receiptId: view!.receipt!.receipt_id, modelId }, PAGE).then(async () => {
        await load();
        render();
      });
    },
    onRefreshModels: () => {
      calls.push("refresh");
      pending = load().then(render);
    },
    onClearPlan: () => {
      calls.push("clear");
      pending = h.controller.handle({ type: "runplan.clear", sessionId: session.session.id }, PAGE).then(async () => {
        await load();
        render();
      });
    },
    onOpenSettings: (section) => calls.push(`settings:${section}`),
    onTrust: (scope) => calls.push(`trust:${scope}`),
    rerender: render,
  };
  return {
    root,
    calls,
    state,
    async ready() {
      await load();
      render();
      return root;
    },
    settle: () => pending,
    click(selector: string) {
      const node = root.querySelector<HTMLElement>(selector);
      if (!node) throw new Error(`no element ${selector}`);
      node.click();
    },
    button(text: string) {
      const node = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
      if (!node) throw new Error(`no button ${JSON.stringify(text)}; have ${[...root.querySelectorAll("button")].map((item) => item.textContent).join(" | ")}`);
      return node;
    },
    text: () => root.textContent ?? "",
  };
}

describe("two clicks to Ready to run (WebAir 0.4.0, Search flights)", () => {
  it("the first profile is preselected, its card says what it gets, and Use this agent yields a ready plan whose id and hash sit under Technical details", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    const ui = mount(h, session);
    const root = await ui.ready();
    const cards = [...root.querySelectorAll<HTMLButtonElement>(".ab-profile-card")];
    expect(cards.map((item) => item.dataset.profile)).toEqual(["search", "quote", "book"]);
    expect(cards[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(cards[0]!.textContent).toContain("Gets: contact webagents-webair-production.up.railway.app");
    // One chooser with less text (F-12, D-111): title, description, what it gets, one estimate line; no notes, no member lists.
    expect(cards[0]!.querySelector(".ab-profile-card-estimate")?.textContent).toBe("Estimate: 3 model calls · about 12,000 tokens · 4 tool calls");
    for (const card of cards) {
      expect(card.textContent).not.toContain("recorded runs");
      expect(card.textContent).not.toMatch(/Permissions|Tools/u);
      expect([...card.children].map((node) => node.className)).toEqual(["ab-profile-card-title", "ab-profile-card-text", "ab-profile-card-gets", "ab-hint ab-profile-card-estimate"]);
    }
    // Generic payment words: the host cannot know a payment is fictional, only the publisher says so (review 1, finding 3).
    expect(cards[2]!.textContent).toContain("make a payment through simulate-purchase at webagents-webair-production.up.railway.app, one run only");
    expect(root.textContent).not.toContain("nothing is charged");
    expect(root.querySelector(".ab-summary")?.textContent).toContain("It will not: read your travel profile");
    expect(root.querySelector(".ab-summary")?.textContent).toContain("use personal.passenger_identity, personal.travel_profile, prepare-booking, simulate-purchase, wallet.payment_method");
    // Click 1: the profile card (already selected; pressing it again is harmless). Click 2: Use this agent.
    ui.click('.ab-profile-card[data-profile="search"]');
    ui.button("Use this agent").click();
    expect(ui.calls).toEqual(["useProfile:search"]);
    await ui.settle();
    expect(ui.text()).toContain("Ready to run");
    expect(ui.text()).toContain("Authorized and ready to run. Nothing has run.");
    const plan = ((await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState).run_plan;
    const technical = [...root.querySelectorAll("details")].find((node) => node.querySelector("summary")?.textContent === "Technical details")!;
    expect(technical.hasAttribute("open")).toBe(false);
    expect(technical.textContent).toContain(plan.run_plan_id);
    expect(technical.textContent).toContain(`sha256:${plan.run_plan_sha256}`);
    expect(technical.textContent).toContain(`sha256:${plan.authorization.receipt_sha256}`);
    expect(root.textContent).toContain("Tools it may not call");
    expect(root.textContent).toContain("personal.passenger_identity, personal.travel_profile, prepare-booking, simulate-purchase, wallet.payment_method");
    // The page never carries a personal value or a key.
    expect(ui.text()).not.toContain("alex.traveler@example.com");
  });

  it("a payment is described generically, with the publisher's own words quoted and attributed (review 1, finding 3)", async () => {
    const h = makeHarness();
    const ui = mount(h, await openWebair(h));
    const root = await ui.ready();
    expect(root.querySelector(".ab-payment-claim")).toBeNull(); // Search flights grants no payment
    ui.click('.ab-profile-card[data-profile="book"]');
    const summary = root.querySelector<HTMLElement>(".ab-summary")!;
    expect(summary.textContent).toContain("make a payment through simulate-purchase at webagents-webair-production.up.railway.app, one run only");
    const claim = root.querySelector<HTMLElement>(".ab-payment-claim")!.textContent!;
    expect(claim.startsWith("About this payment, in the publisher's words: “Simulate purchasing the one exact quote")).toBe(true);
    expect(claim).toContain("charges nothing");
  });

  it("choosing another profile while the detailed view is open shows that profile's details (review 1, nit 15)", async () => {
    const h = makeHarness();
    const ui = mount(h, await openWebair(h));
    const root = await ui.ready();
    ui.button("Customize your settings").click();
    expect(root.querySelector<HTMLSelectElement>('.ab-permission[data-permission="identity.passenger"] select')!.value).toBe("deny");
    ui.click('.ab-profile-card[data-profile="quote"]');
    expect(ui.state.customize).toBe(true);
    expect(root.querySelector<HTMLSelectElement>('.ab-permission[data-permission="identity.passenger"] select')!.value).toBe("session");
    expect(ui.button("Hide the detailed settings")).toBeTruthy();
    ui.button("Hide the detailed settings").click();
    expect(root.querySelector(".ab-permission")).toBeNull();
    ui.click('.ab-profile-card[data-profile="search"]');
    expect(ui.button("Customize your settings")).toBeTruthy();
  });

  it("re-rendering from the stored session keeps the plan hash", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    const first = mount(h, session);
    await first.ready();
    first.button("Use this agent").click();
    await first.settle();
    const hash = ((await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState).run_plan.run_plan_sha256;
    const second = mount(h, session);
    const root = await second.ready();
    expect(root.textContent).toContain(`sha256:${hash}`);
    expect(root.textContent).toContain("Ready to run");
  });

  it("an unknown publisher gets the trust prompt first and cannot press Use this agent", async () => {
    const h = makeHarness();
    const session = await openWebair(h, false);
    const ui = mount(h, session);
    const root = await ui.ready();
    expect(root.textContent).toContain("Before you use this agent");
    expect(root.textContent).toContain("Signed, publisher unknown");
    expect(ui.button("Use this agent").disabled).toBe(true);
    const pin = root.querySelector<HTMLButtonElement>(".ab-pin button")!;
    pin.click();
    pin.click();
    expect(ui.calls).toEqual(["trust:package"]);
  });
});

describe("Customize your settings", () => {
  it("expands the per-item view, records a changed decision as the person's own, and authorizes with the model picked there", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    const ui = mount(h, session);
    const root = await ui.ready();
    ui.button("Customize your settings").click();
    expect(ui.state.customize).toBe(true);
    expect(root.textContent).toContain("Tool approvals");
    expect(root.querySelectorAll(".ab-permission")).toHaveLength(7);
    expect(root.querySelectorAll(".ab-approval")).toHaveLength(7);
    // The search profile's defaults: everything decided by the profile.
    const row = root.querySelector<HTMLElement>('.ab-permission[data-permission="profile.travel"]')!;
    expect(row.textContent).toContain("decided by profile");
    const select = row.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("deny");
    select.value = "session";
    select.dispatchEvent(new Event("change"));
    expect(root.querySelector<HTMLElement>('.ab-permission[data-permission="profile.travel"]')!.textContent).toContain("decided by user");
    // With the permission granted, the recall card appears, and the memory holds no travel profile yet (M-34: Create one · Continue without).
    expect(root.querySelector<HTMLElement>('.ab-permission[data-permission="profile.travel"] .ab-resource-choice')!.textContent).toContain("You have no travel profile yet");
    // Models are listed once read; the first compatible one can be picked.
    ui.button("Read it now").click();
    await ui.settle();
    const radio = root.querySelector<HTMLInputElement>('.ab-model-row[data-model="ollama/qwen3:30b"] input[type=radio]')!;
    expect(radio.disabled).toBe(false);
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    expect(ui.state.selectedModel).toBe(QWEN);
    expect(root.textContent).toContain("Declared limits");
    ui.button("Authorize with these settings").click();
    expect(ui.calls).toContain(`authorize:${QWEN}`);
    await ui.settle();
    const view = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    expect(view.receipt?.decisions["profile.travel"]).toBe("session");
    expect(view.receipt?.provenance).toMatchObject({ profile_id: "search", decisions: { "profile.travel": "user", "network.webair": "profile" } });
    // The permission is granted but its tool stays unapproved (the search profile left it out), so
    // under D-022 nothing needs a record and the plan is ready; the tool is listed as denied.
    expect(view.run_plan?.preflight.ready).toBe(true);
    expect(view.run_plan?.run_plan.execution.denied_tool_ids).toContain("personal.travel_profile");
    expect(root.textContent).toContain("Ready to run");
  });

  it("Literature Review has no profiles: the preset's defaults start the view, with every decision marked decided by preset", async () => {
    const h = makeHarness();
    const session = (await h.controller.handle({ type: "package.open", url: "https://research.example/literature-review.agent.pkg", advertisedOn: null, viewId: "ui" }, PAGE)) as SessionView;
    await h.controller.handle({ type: "trust.pin", sessionId: session.session.id, signerFingerprint: SHIPPED.literatureReview.fingerprint, scope: "publisher" }, PAGE);
    const ui = mount(h, (await h.controller.handle({ type: "package.get", sessionId: session.session.id }, PAGE)) as SessionView);
    const root = await ui.ready();
    expect(root.querySelector(".ab-profile-card")).toBeNull();
    expect(root.querySelector(".ab-card-title")?.textContent).toBe("What you are about to allow"); // trusted: no prompt; the first card is the summary
    expect(root.querySelector(".ab-summary")?.textContent).toContain("the Balanced preset's defaults");
    ui.button("Customize your settings").click();
    // Balanced grants the optional network/model/files permissions for the session (none is personal data or a payment); required ones first.
    expect([...root.querySelectorAll<HTMLElement>(".ab-permission")].map((node) => [node.dataset.permission, node.querySelector("select")!.value])).toEqual([
      ["network.scholarly", "session"],
      ["network.citations", "session"],
      ["memory.session", "session"],
      ["files.pdfs", "session"],
      ["model.reasoning", "session"],
    ]);
    expect(root.querySelector<HTMLElement>('.ab-permission[data-permission="files.pdfs"]')!.textContent).toContain("decided by preset");
    // Some recorded OpenClaw runs deny files.pdfs: one change, recorded as the person's own.
    const pdfs = root.querySelector<HTMLSelectElement>('.ab-permission[data-permission="files.pdfs"] select')!;
    pdfs.value = "deny";
    pdfs.dispatchEvent(new Event("change"));
    expect(root.querySelector<HTMLElement>('.ab-permission[data-permission="files.pdfs"]')!.textContent).toContain("decided by user");
    // T6: the paper reader is this browser's own selected-PDF reader, bound like the other two tools.
    expect(root.querySelector<HTMLElement>('.ab-approval[data-tool="paper-reader"]')!.textContent).toContain("Selected PDF text");
  });
});

describe("a model whose provider stopped answering (T5a, D-077)", () => {
  it("is shown as not available with Ollama's address, never as 'unverified', in the summary and in Customize", async () => {
    let stopped = false;
    const h = makeHarness({
      catalogHttp: async (request) => {
        if (stopped && request.url.endsWith("/api/show")) throw new TypeError("Failed to fetch");
        const key = `${request.method} ${request.url}`;
        if (key in OLLAMA_ANSWERS) return { status: 200, body: OLLAMA_ANSWERS[key] };
        if (request.url.endsWith("/api/show")) return { status: 200, body: OLLAMA_ANSWERS[`SHOW ${(request.body as { model: string }).model}`] ?? null };
        return { status: 404, body: null };
      },
    });
    const session = await openWebair(h);
    stopped = true;
    const ui = mount(h, session);
    await ui.ready();
    ui.button("Customize your settings").click();
    ui.button("Read it now").click();
    await vi.waitFor(() => expect(ui.root.querySelector(`.ab-model-row[data-model="${QWEN}"]`)).not.toBeNull());
    const row = ui.root.querySelector<HTMLElement>(`.ab-model-row[data-model="${QWEN}"]`)!;
    expect(row.textContent).toContain("Not available");
    expect(row.querySelector(".ab-model-unavailable")?.textContent).toBe("Not available: Ollama stopped answering at http://127.0.0.1:11434 (/api/show failed). Test the connection in Settings → Models.");
    expect(row.textContent).not.toContain("unverified");
    expect(row.textContent).not.toContain("Not enough is known");
    expect(row.querySelector<HTMLInputElement>("input[type=radio]")!.disabled).toBe(true);
  });
});

describe("the shared flow module over the message contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a model picked under Customize your settings is the one the plan binds, not the default model", async () => {
    // Two local models; the default is the small one, the person picks qwen3:30b in the customize view.
    const h = makeHarness({
      http: {
        ...OLLAMA_ANSWERS,
        "GET http://127.0.0.1:11434/api/tags": { models: [{ name: "qwen3:30b", model: "qwen3:30b" }, { name: "llama3.2:3b", model: "llama3.2:3b" }] },
        "SHOW llama3.2:3b": { capabilities: ["completion"], model_info: { "llama.context_length": 131072 } },
      },
    });
    const session = await openWebair(h);
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    await h.controller.handle({ type: "settings.set", settings: { ...settings, models: { ...settings.models, default_model: "ollama/llama3.2:3b" } } }, PAGE);
    // The views' `send` goes through chrome.runtime.sendMessage; route it through the real request parser to the worker.
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: (message: unknown) =>
          Promise.resolve()
            .then(() => h.controller.handle(parseRequest(message), PAGE))
            .then(success, failure),
      },
    });
    const store: { view: AuthorizationView | null; models: ModelsView | null } = { view: null, models: null };
    const root = document.createElement("div");
    const flow = bindAuthorization({
      session: () => session,
      get: () => store.view,
      set: (view) => {
        store.view = view;
      },
      models: () => store.models,
      setModels: (models) => {
        store.models = models;
      },
      setBusy: () => undefined,
      setError: (error) => {
        if (error) throw new Error(`${error.code}: ${error.message}`);
      },
      openSettings: () => undefined,
      rerender: () => root.replaceChildren(flow.render(() => undefined) ?? ""),
    });
    await flow.load();
    root.replaceChildren(flow.render(() => undefined)!);
    const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
    button("Customize your settings").click();
    button("Read it now").click();
    await vi.waitFor(() => expect(root.querySelector('.ab-model-row[data-model="ollama/qwen3:30b"] input[type=radio]')).not.toBeNull());
    const radio = root.querySelector<HTMLInputElement>('.ab-model-row[data-model="ollama/qwen3:30b"] input[type=radio]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    button("Authorize with these settings").click();
    await vi.waitFor(() => expect(root.textContent).toContain("Ready to run"));
    const plan = ((await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState).run_plan;
    expect(plan.model_binding?.host_model_id).toBe(QWEN);
    expect(root.textContent).toContain(`(${QWEN})`);
  });
});

describe("Settings → Permissions (T16 review 2, nit 4)", () => {
  it("a single origin's Revoke is disabled while every site is granted, since it could only end in the 409 banner", async () => {
    const h = makeHarness();
    const settings = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    const state = newSettingsPageState("permissions");
    const origins = [{ origin: "https://a.example", granted: true, purposes: [{ kind: "site" as const, subject: "https://a.example", label: null }] }];
    const render = (everywhere: boolean) => renderSettingsPage(settings, null, state, { onSave: () => undefined, onSetKey: () => undefined, onProbe: () => undefined, onRevoke: () => undefined, rerender: () => undefined }, null, { indexes: null, policy: null, permissions: { origins, detect_everywhere: everywhere, manifest_hosts: ["http://localhost:11434/*"] } as never });
    const revoke = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Revoke")!;
    expect(revoke(render(false)).disabled).toBe(false);
    expect(revoke(render(true)).disabled).toBe(true);
  });
});

describe("Settings and Your data", () => {
  it("Settings → Models shows key presence only, tests a connection, and makes a probed model the default; Policies selects the preset", async () => {
    const h = makeHarness();
    const settings = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    const state = newSettingsPageState();
    const saved: unknown[] = [];
    const keys: Array<[string, string | null]> = [];
    const probes: string[] = [];
    let current = settings;
    const render = () => renderSettingsPage(current, null, state, { onSave: (next) => saved.push(next), onSetKey: (provider, key) => keys.push([provider, key]), onProbe: (provider) => probes.push(provider), rerender: () => undefined });
    let root = render();
    expect(root.textContent).toContain("Ollama (local)");
    expect(root.textContent).toContain("no key");
    // The endpoint placeholder names the endpoint actually used when the field is empty (user feedback 2026-10-07).
    expect(root.querySelector<HTMLInputElement>('input[name="base-url-openai"]')?.placeholder).toBe("https://api.openai.com (default)");
    expect(root.querySelector<HTMLInputElement>('input[name="base-url-anthropic"]')?.placeholder).toBe("https://api.anthropic.com (default)");
    expect(root.querySelector<HTMLInputElement>('input[name="base-url-ollama"]')?.placeholder).toBe("http://127.0.0.1:11434 (default)");
    const keyInput = root.querySelector<HTMLInputElement>('input[name="key-openai"]')!;
    expect(keyInput.type).toBe("password");
    keyInput.value = "sk-test-secret";
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save key")!.click();
    expect(keys).toEqual([["openai", "sk-test-secret"]]);
    expect(keyInput.value).toBe(""); // cleared on save, never kept in the page
    [...root.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Test connection")[0]!.click();
    expect(probes).toEqual(["ollama"]);
    state.probes.ollama = await h.controller.probe("ollama");
    current = (await h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-test-secret" }, PAGE)) as SettingsView;
    root = render();
    expect(root.textContent).toContain("key stored");
    expect(root.textContent).not.toContain("sk-test-secret");
    expect(root.querySelector('.ab-model-row[data-model="ollama/qwen3:30b"]')).not.toBeNull();
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Make default")!.click();
    expect((saved.at(-1) as SettingsView["settings"]).models.default_model).toBe(QWEN);
    state.section = "policies";
    root = render();
    expect([...root.querySelectorAll<HTMLElement>(".ab-preset")].map((node) => node.dataset.preset)).toEqual(["privacy-first", "balanced", "convenience"]);
    const privacy = root.querySelector<HTMLInputElement>('.ab-preset[data-preset="privacy-first"] input')!;
    privacy.checked = true;
    privacy.dispatchEvent(new Event("change"));
    expect((saved.at(-1) as SettingsView["settings"]).preset).toBe("privacy-first");
  });

  it("the record card saves an optional boolean only when the person set it, and a required one as false when left off (review 1, finding 6; T3 review 2, nit 22)", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const view = (await h.controller.handle({ type: "memory.get" }, PAGE)) as MemoryView;
    const state = newMemoryPageState();
    const sent: unknown[] = [];
    const actions: MemoryPageActions = { send: async (request) => { sent.push(request); return { id: DEMO.traveler } as never; }, rerender: () => undefined, reload: () => undefined, unlock: () => undefined, openRun: () => undefined, saveBlob: async () => null };
    openCard(view, state, DEMO.traveler);
    let root = renderMemoryPage(view, state, actions);
    // The form lists the summary fields first, then the schema's order; the demo record's values are the person's own.
    expect([...root.querySelectorAll<HTMLElement>(".ab-memory-field .ab-row-label span:first-child")].map((node) => node.textContent)).toEqual(["home airport", "preferred cabin", "prefer nonstop", "preferred currency"]);
    expect(root.querySelector<HTMLInputElement>('input[name="field-home_airport"]')!.value).toBe("BOS");
    root.querySelector<HTMLInputElement>('input[name="field-home_airport"]')!.value = "GVA";
    root.querySelector<HTMLInputElement>('input[name="field-home_airport"]')!.dispatchEvent(new Event("input"));
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!.click();
    expect(sent[0]).toMatchObject({ type: "memory.edit", recordId: DEMO.traveler, changes: { fields: { home_airport: "GVA", preferred_cabin: "economy", prefer_nonstop: true, preferred_currency: "USD" } } });
    // A sealed field is masked until Reveal, and Reveal asks the worker for that one value.
    openCard(view, state, DEMO.alex);
    root = renderMemoryPage(view, state, actions);
    const sealed = root.querySelector<HTMLElement>(".ab-sealed-value")!;
    expect(sealed.textContent).toContain(MASK);
    expect(root.textContent).not.toContain("alex.traveler@example.com");
    [...sealed.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Reveal")!.click();
    expect(sent[1]).toEqual({ type: "memory.reveal", recordId: DEMO.alex, pointer: "/email" });
  });

  it("the Memory page lists the Me record and the demo set with their flags, opens a card from a row, and the list is the graph's accessible equivalent", async () => {
    const h = makeHarness();
    const empty = (await h.controller.handle({ type: "memory.get" }, PAGE)) as MemoryView;
    const state = newMemoryPageState();
    state.mode = "list";
    const sent: unknown[] = [];
    const actions: MemoryPageActions = { send: async (request) => { sent.push(request); return {} as never; }, rerender: () => undefined, reload: () => undefined, unlock: () => undefined, openRun: () => undefined, saveBlob: async () => null };
    let root = renderMemoryPage(empty, state, actions);
    expect(root.querySelectorAll(".ab-memory-row")).toHaveLength(1); // Me
    expect(root.querySelector(".ab-memory-status")?.textContent).toContain("1 records · ");
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const demo = (await h.controller.handle({ type: "memory.get" }, PAGE)) as MemoryView;
    root = renderMemoryPage(demo, state, actions);
    const rows = [...root.querySelectorAll<HTMLElement>(".ab-memory-row")];
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => row.textContent?.includes("(demo)"))).toHaveLength(6);
    expect(rows.find((row) => row.dataset.record === DEMO.alex)?.textContent).toContain("🔒");
    expect(root.textContent).not.toContain("alex.traveler@example.com");
    // Sortable headers carry aria-sort; a row opens the card on Enter.
    expect(root.querySelector('th[aria-sort="ascending"]')?.textContent).toContain("Title");
    rows.find((row) => row.dataset.record === DEMO.traveler)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(state.card?.id).toBe(DEMO.traveler);
    root = renderMemoryPage(demo, state, actions);
    expect(root.querySelector<HTMLElement>(".ab-memory-card")?.dataset.record).toBe(DEMO.traveler);
    expect(root.querySelector(".ab-memory-provenance")?.textContent).toContain("Migrated from Your data");
    // New record opens the type chooser; a type opens the card in create mode with its default links.
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ New record")!.click();
    expect(state.sheet).toEqual({ kind: "types" });
    root = renderMemoryPage(demo, state, actions);
    [...root.querySelectorAll<HTMLButtonElement>(".ab-memory-type-group button")].find((button) => button.textContent?.startsWith("Travel preference"))!.click();
    expect(state.card).toMatchObject({ mode: "create", type: "travel.preference" });
    expect(state.card?.draft.links).toEqual([{ to: "self", rel: "about" }]);
  });

});
