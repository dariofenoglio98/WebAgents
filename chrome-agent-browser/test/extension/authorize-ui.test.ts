// @vitest-environment happy-dom
/**
 * The authorize view, the Settings pages and the Your data page (T3, Demo 2) over the worker's
 * real answers through the fake `chrome` API: two clicks from the agent page to "Ready to run"
 * for WebAir 0.4.0's "Search flights"; the customize view with its per-item controls and
 * provenance; the trust prompt for an unknown publisher; keys typed and never echoed; the
 * fictional demo set added only on request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { failure, parseRequest, success, type AuthorizationView, type AuthorizeResult, type ModelsView, type RunPlanState, type SessionView, type SettingsView, type VaultView } from "../../src/extension/messages.js";
import { bindAuthorization } from "../../src/extension/ui/authorization-flow.js";
import { newAuthorizeState, renderAuthorizeView, type AuthorizeActions, type AuthorizeState } from "../../src/extension/ui/authorize.js";
import { newSettingsPageState, renderSettingsPage } from "../../src/extension/ui/settings-page.js";
import { newVaultPageState, renderVaultPage } from "../../src/extension/ui/vault-page.js";
import { SHIPPED } from "../helpers/paths.js";
import { makeHarness, OLLAMA_ANSWERS, PAGE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";

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
    expect(cards[2]!.textContent).toContain("simulate a purchase (fictional, nothing is charged), one run only");
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
    // With the permission granted, the chooser appears, and the vault holds no travel profile yet.
    expect(root.querySelector<HTMLElement>('.ab-permission[data-permission="profile.travel"] .ab-resource-choice')!.textContent).toContain("You have no travel profile in Your data yet");
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
    // The recorded OpenClaw decisions deny files.pdfs: one change, recorded as the person's own.
    const pdfs = root.querySelector<HTMLSelectElement>('.ab-permission[data-permission="files.pdfs"] select')!;
    pdfs.value = "deny";
    pdfs.dispatchEvent(new Event("change"));
    expect(root.querySelector<HTMLElement>('.ab-permission[data-permission="files.pdfs"]')!.textContent).toContain("decided by user");
    expect(root.querySelector<HTMLElement>('.ab-approval[data-tool="paper-reader"]')!.textContent).toContain("unbound");
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

  it("Your data starts empty with the demo types, adds the fictional set only on the button, and builds a form from the type's schema", async () => {
    const h = makeHarness();
    const view = (await h.controller.handle({ type: "vault.get" }, PAGE)) as VaultView;
    const state = newVaultPageState();
    const puts: unknown[] = [];
    let installs = 0;
    const render = (current: VaultView) => renderVaultPage(current, state, { onPut: (record) => puts.push(record), onDelete: () => undefined, onInstallDemo: () => (installs += 1), rerender: () => undefined });
    let root = render(view);
    expect(root.textContent).toContain("No record yet");
    expect([...root.querySelectorAll(".ab-card-title")].map((node) => node.textContent)).toEqual(["Your data", "Travel profile", "Passenger identity", "Payment method"]);
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add fictional demo data")!.click();
    expect(installs).toBe(1);
    const demo = (await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE)) as VaultView;
    root = render(demo);
    expect(root.querySelectorAll(".ab-vault-record")).toHaveLength(6);
    expect([...root.querySelectorAll(".ab-vault-record")].every((node) => node.textContent?.includes("fictional demo data"))).toBe(true);
    expect(root.querySelector('.ab-vault-record[data-record="passenger_demo_alex"]')?.textContent).toContain("alex.traveler@example.com (sealed)"); // the person's own page shows their own data
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add a travel profile")!.click();
    root = render(demo);
    const fields = [...root.querySelectorAll<HTMLElement>(".ab-vault-field")];
    // The vault stores schemas canonically (sorted keys), so the form lists properties alphabetically.
    expect(fields.map((node) => node.querySelector(".ab-row-label span")?.textContent)).toEqual(["home_airport", "prefer_nonstop", "preferred_cabin", "preferred_currency"]);
    expect(root.querySelector<HTMLSelectElement>('select[name="field-preferred_cabin"]')).not.toBeNull();
    root.querySelector<HTMLInputElement>('input[name="record-label"]')!.value = "Me";
    root.querySelector<HTMLInputElement>('input[name="record-label"]')!.dispatchEvent(new Event("input"));
    root.querySelector<HTMLInputElement>('input[name="field-home_airport"]')!.value = "ZRH";
    root.querySelector<HTMLInputElement>('input[name="field-home_airport"]')!.dispatchEvent(new Event("input"));
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!.click();
    expect(puts[0]).toMatchObject({ type: "personal.travel_profile", label: "Me", value: { home_airport: "ZRH" }, demo: false });
  });
});
