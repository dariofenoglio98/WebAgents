// @vitest-environment happy-dom
/**
 * Chrome's built-in model is usable like any other (F-14, D-113): the Prompt API reading measures
 * the session quota once without prompting, Test connection returns the model's row, Settings →
 * Models offers "Make default" only when Chrome reports it `available`, the person can state that a
 * model reasons, and a WebAir plan then binds the built-in model; a plan keeps the model it was
 * prepared with when the default changes later.
 */
import { describe, expect, it, vi } from "vitest";

import { CHROME_BUILTIN_MODEL_ID } from "../../src/core/models/catalog.js";
import { builtinReader } from "../../src/extension/execution/builtin-port.js";
import type { AuthorizationView, AuthorizeResult, ProbeView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { newAuthorizeState, renderAuthorizeView } from "../../src/extension/ui/authorize.js";
import { newSettingsPageState, renderSettingsPage } from "../../src/extension/ui/settings-page.js";
import type { Settings } from "../../src/extension/storage/settings.js";
import { SHIPPED } from "../helpers/paths.js";
import { makeHarness, PAGE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";

const QWEN = "ollama/qwen3:30b";

/** A stubbed `LanguageModel` global: its availability answer and the quota of the sessions it creates. */
function promptApi(availability: string, inputQuota = 9216) {
  const destroyed: number[] = [];
  const api = {
    availability: vi.fn(async () => availability),
    create: vi.fn(async () => ({ inputQuota, destroy: () => destroyed.push(1) })),
    prompt: vi.fn(),
  };
  return { scope: { LanguageModel: api }, api, destroyed };
}

async function openWebair(h: Harness): Promise<SessionView> {
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "ui" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  return view;
}

async function settingsOf(h: Harness): Promise<Settings> {
  return ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
}

async function save(h: Harness, change: (settings: Settings) => Settings): Promise<void> {
  await h.controller.handle({ type: "settings.set", settings: change(await settingsOf(h)) }, PAGE);
}

function builtinOverride(settings: Settings, override: Record<string, unknown>): Settings {
  return { ...settings, models: { ...settings.models, connections: settings.models.connections.map((item) => (item.provider === "chrome-builtin" ? { ...item, overrides: { "gemini-nano": override } } : item)) } };
}

function renderModels(h: Harness, view: SettingsView, probe: ProbeView, saved: Settings[]): HTMLElement {
  const state = newSettingsPageState("models");
  state.probes["chrome-builtin"] = probe;
  return renderSettingsPage(view, null, state, { onSave: (next) => saved.push(next), onSetKey: () => undefined, onProbe: () => undefined, rerender: () => undefined });
}

describe("the Prompt API reading (builtinReader)", () => {
  it("measures the quota once when available, never prompts, and destroys the session", async () => {
    const { scope, api, destroyed } = promptApi("available", 9216);
    const read = builtinReader(scope);
    expect(await read()).toEqual({ availability: "available", input_quota: 9216 });
    expect(await read()).toEqual({ availability: "available", input_quota: 9216 });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(destroyed).toHaveLength(1);
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("creates no session for a model Chrome has not made available, and reports what the API said", async () => {
    for (const answer of ["downloadable", "downloading", "unavailable"]) {
      const { scope, api } = promptApi(answer);
      expect(await builtinReader(scope)()).toEqual({ availability: answer, input_quota: null });
      expect(api.create).not.toHaveBeenCalled();
    }
    expect(await builtinReader({})()).toEqual({ availability: "unsupported", input_quota: null });
    expect(await builtinReader({ LanguageModel: { availability: async () => "something-new" } })()).toEqual({ availability: "unavailable", input_quota: null });
    expect(await builtinReader({ LanguageModel: { availability: async () => Promise.reject(new Error("boom")) } })()).toBeNull();
  });

  it("a session that cannot be created leaves the quota unknown, and a later reading tries again", async () => {
    const { scope, api } = promptApi("available", 4096);
    api.create.mockRejectedValueOnce(new Error("NotAllowedError"));
    const read = builtinReader(scope);
    expect(await read()).toEqual({ availability: "available", input_quota: null });
    expect(await read()).toEqual({ availability: "available", input_quota: 4096 });
  });
});

describe("Settings → Models: the built-in model's row", () => {
  it("Test connection returns the one model; 'Make default' is offered when Chrome reports it available and saves it", async () => {
    const h = makeHarness();
    h.builtin.availability = { availability: "available", input_quota: 9216 };
    const probe = (await h.controller.handle({ type: "models.probe", provider: "chrome-builtin" }, PAGE)) as ProbeView;
    expect(probe).toMatchObject({ provider: "chrome-builtin", ok: true, error: null });
    expect(probe.models).toEqual([expect.objectContaining({ id: CHROME_BUILTIN_MODEL_ID, available: true, limits: { context_tokens: 9216, native_context_window: 9216, max_output_tokens: null } })]);
    const saved: Settings[] = [];
    const root = renderModels(h, (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView, probe, saved);
    const row = root.querySelector<HTMLElement>(`.ab-model-row[data-model="${CHROME_BUILTIN_MODEL_ID}"]`)!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("Context 9,216");
    const make = [...row.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Make default")!;
    expect(make).toBeDefined();
    expect(make.disabled).toBe(false);
    make.click();
    expect(saved.at(-1)!.models.default_model).toBe(CHROME_BUILTIN_MODEL_ID);
  });

  it("shows the row without 'Make default' when Chrome reports the model unavailable (or not yet downloaded)", async () => {
    for (const availability of ["unavailable", "downloadable"] as const) {
      const h = makeHarness();
      h.builtin.availability = { availability, input_quota: null };
      const probe = (await h.controller.handle({ type: "models.probe", provider: "chrome-builtin" }, PAGE)) as ProbeView;
      expect(probe).toMatchObject({ ok: false, error: availability });
      const root = renderModels(h, (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView, probe, []);
      const row = root.querySelector<HTMLElement>(`.ab-model-row[data-model="${CHROME_BUILTIN_MODEL_ID}"]`)!;
      expect(row).not.toBeNull();
      expect(row.textContent).toContain("not available");
      expect([...root.querySelectorAll("button")].some((button) => button.textContent === "Make default"), availability).toBe(false);
    }
  });

  it("the person states that a model reasons (recorded as declared), or withdraws the statement", async () => {
    const h = makeHarness();
    h.builtin.availability = { availability: "available", input_quota: 9216 };
    const probe = (await h.controller.handle({ type: "models.probe", provider: "chrome-builtin" }, PAGE)) as ProbeView;
    const saved: Settings[] = [];
    const root = renderModels(h, (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView, probe, saved);
    const select = root.querySelector<HTMLSelectElement>(`select[name="reasoning-${CHROME_BUILTIN_MODEL_ID}"]`)!;
    expect(select.value).toBe("");
    select.value = "yes";
    select.dispatchEvent(new Event("change"));
    const stated = saved.at(-1)!.models.connections.find((item) => item.provider === "chrome-builtin")!.overrides["gemini-nano"];
    expect(stated).toEqual({ reasoning: true });
    await h.controller.handle({ type: "settings.set", settings: saved.at(-1)! }, PAGE);
    const evaluated = (await h.controller.handle({ type: "models.probe", provider: "chrome-builtin" }, PAGE)) as ProbeView;
    expect((evaluated.models[0] as { capabilities: { reasoning: unknown } }).capabilities.reasoning).toMatchObject({ value: true, basis: "declared" });
    select.value = "";
    select.dispatchEvent(new Event("change"));
    await h.controller.handle({ type: "settings.set", settings: saved.at(-1)! }, PAGE);
    expect((await settingsOf(h)).models.connections.find((item) => item.provider === "chrome-builtin")!.overrides["gemini-nano"]).toEqual({});
  });
});

describe("a WebAir plan on the built-in model", () => {
  it("is refused as unverified until the person states reasoning and the context fits, then binds the built-in model as the default", async () => {
    const h = makeHarness();
    h.builtin.availability = { availability: "available", input_quota: null };
    const session = await openWebair(h);
    await save(h, (settings) => ({ ...settings, models: { ...settings.models, default_model: CHROME_BUILTIN_MODEL_ID } }));
    const use = async () => (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    // The Prompt API states no reasoning, and no quota was measured: not enough is known.
    const unstated = await use();
    expect(unstated.run_plan).toBeNull();
    expect(unstated.plan_refused!.map((reason) => reason.code)).toEqual(["model_compatibility_unverified"]);
    expect(unstated.plan_refused![0]!.message).toContain("capability:reasoning");
    await save(h, (settings) => builtinOverride(settings, { reasoning: true }));
    const reasons = await use();
    expect(reasons.plan_refused!.map((reason) => reason.code)).toEqual(["model_compatibility_unverified"]);
    expect(reasons.plan_refused![0]!.message).not.toContain("capability:reasoning");
    // A measured quota below WebAir's 16,000 makes it incompatible, by the facts.
    h.builtin.availability = { availability: "available", input_quota: 9216 };
    expect((await use()).plan_refused!.map((reason) => reason.code)).toEqual(["model_incompatible"]);
    // The person states the context as well (their declaration; the Prompt API still enforces its quota at run time, D-072).
    await save(h, (settings) => builtinOverride(settings, { reasoning: true, context_tokens: 16384 }));
    const ready = await use();
    expect(ready.plan_refused).toBeNull();
    expect(ready.model_id).toBe(CHROME_BUILTIN_MODEL_ID);
    expect(ready.run_plan!.preflight.ready).toBe(true);
    expect(ready.run_plan!.run_plan.model_binding).toMatchObject({ host_model_id: CHROME_BUILTIN_MODEL_ID });
  });

  it("an existing plan keeps its model when the default changes, and the plan card says how to move to the new default", async () => {
    const h = makeHarness();
    h.builtin.availability = { availability: "available", input_quota: 9216 };
    const session = await openWebair(h);
    await save(h, (settings) => ({
      ...builtinOverride(settings, { reasoning: true, context_tokens: 16384 }),
      models: { ...builtinOverride(settings, { reasoning: true, context_tokens: 16384 }).models, default_model: QWEN, connections: builtinOverride(settings, { reasoning: true, context_tokens: 16384 }).models.connections.map((item) => (item.provider === "ollama" ? { ...item, overrides: { "qwen3:30b": { context_tokens: 65536 } } } : item)) },
    }));
    const first = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(first.run_plan!.run_plan.model_binding).toMatchObject({ host_model_id: QWEN });
    await save(h, (settings) => ({ ...settings, models: { ...settings.models, default_model: CHROME_BUILTIN_MODEL_ID } }));
    const view = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    expect(view.run_plan!.run_plan.model_binding).toMatchObject({ host_model_id: QWEN });
    expect(view.run_plan!.preflight.ready).toBe(true);
    const current = (await h.controller.handle({ type: "package.get", sessionId: session.session.id }, PAGE)) as SessionView;
    const root = renderAuthorizeView({ session: current, view, models: null, busy: null }, newAuthorizeState(), { onUseProfile: () => undefined, onAuthorize: () => undefined, onPrepare: () => undefined, onRefreshModels: () => undefined, onClearPlan: () => undefined, onOpenSettings: () => undefined, rerender: () => undefined });
    expect(root.querySelector(".ab-plan-model-note")?.textContent).toBe(`This plan runs on ${QWEN}. Your default model is now ${CHROME_BUILTIN_MODEL_ID}: press “Use this agent” to prepare a plan on it.`);
    const second = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(second.run_plan!.run_plan.model_binding).toMatchObject({ host_model_id: CHROME_BUILTIN_MODEL_ID });
  });
});
