/**
 * T5a, the defects of the Demo 3 walk-through, through the worker: a stopped Ollama refuses a run
 * plan as unavailable (never "unverified") and names its address, a plan already prepared goes
 * stale with the same words; Luna and Astra both prepare a WebAir plan with no Settings override;
 * a view that just opened finds the run in flight (`run.active`); Inspect of the same bytes from
 * the same page while their run is in flight returns that run's session (D-076…D-078).
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { Http } from "../../src/core/models/catalog.js";
import type { HttpTransport } from "../../src/core/models/transport.js";
import type { AuthorizeResult, ModelsView, RunPlanState, RunReadiness, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { scriptedOrigin } from "../helpers/host.js";
import { SHIPPED } from "../helpers/paths.js";
import { fakeHttp, makeHarness, OLLAMA_ANSWERS, PAGE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";

const QWEN = "ollama/qwen3:30b";
const SEARCH = { request: "Find me a nonstop flight from Boston to Zurich on 9 October under $900.", booking: false, purchase: { quote_id: "", fare_id: "" } };

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

/** The catalog transport with a switch: Ollama answering, listing but not showing, or not answering at all. */
function switchableOllama(answers: Record<string, unknown> = OLLAMA_ANSWERS): { http: Http; state: { mode: "up" | "show-fails" | "down" } } {
  const state = { mode: "up" as "up" | "show-fails" | "down" };
  const answer = fakeHttp(answers);
  const http: Http = async (request) => {
    if (request.provider === "ollama" && (state.mode === "down" || (state.mode === "show-fails" && request.url.endsWith("/api/show")))) throw new TypeError("Failed to fetch");
    return answer(request);
  };
  return { http, state };
}

async function openWebair(h: Harness, options: { defaultModel?: string; page?: string; viewId?: string } = {}): Promise<SessionView> {
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: options.page ?? `${SITE_ORIGIN}/`, viewId: options.viewId ?? "test" }, PAGE)) as SessionView;
  if (view.summary.publisher.trust_status !== "trusted") await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = options.defaultModel ?? QWEN;
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  return (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
}

function useSearch(h: Harness, sessionId: string): Promise<AuthorizeResult> {
  return h.controller.handle({ type: "authorization.useProfile", sessionId, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE) as Promise<AuthorizeResult>;
}

/** A model that never answers: a run stays in its first model call until it is cancelled. */
function hanging(): { transport: HttpTransport; reached: () => number } {
  let reached = 0;
  const transport: HttpTransport = (request) =>
    new Promise((_resolve, reject) => {
      reached += 1;
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  return { transport, reached: () => reached };
}

async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startSearch(h: Harness, sessionId: string): Promise<RunView> {
  const result = await useSearch(h, sessionId);
  const plan = result.run_plan!.run_plan;
  return (await h.controller.handle({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: SEARCH }, PAGE)) as RunView;
}

describe("an unreachable provider is unavailable, not 'unverified' (D-077)", () => {
  it("Ollama listed its models a moment ago and then stopped answering: preparing a plan re-reads the catalog and refuses with model_unavailable, naming the address", async () => {
    const { http, state } = switchableOllama();
    const h = makeHarness({ catalogHttp: http });
    const session = await openWebair(h);
    // The views read the catalog while Ollama answered; it is cached for 60 s.
    const before = (await h.controller.handle({ type: "models.evaluate", sessionId: session.session.id, refresh: false }, PAGE)) as ModelsView;
    expect(before.evaluation.models.find((model) => model.model_id === QWEN)?.available).toBe(true);
    state.mode = "show-fails";
    const result = await useSearch(h, session.session.id);
    expect(result.run_plan, "no plan is frozen against a catalog the provider no longer confirms").toBeNull();
    expect(result.plan_refused?.map((reason) => [reason.code, reason.subject])).toEqual([["model_unavailable", QWEN]]);
    expect(result.plan_refused?.[0]?.message).toBe(
      "ollama/qwen3:30b is not usable now. Ollama stopped answering at http://127.0.0.1:11434 (/api/show failed). Test the connection in Settings → Models. Ollama must be running, with OLLAMA_ORIGINS allowing chrome-extension://*.",
    );
    expect(result.plan_refused?.[0]?.message).not.toContain("does not report enough");
  });

  it("Ollama not answering at all: model_unknown says where it was looked for", async () => {
    const { http, state } = switchableOllama();
    const h = makeHarness({ catalogHttp: http });
    const session = await openWebair(h);
    state.mode = "down";
    const result = await useSearch(h, session.session.id);
    expect(result.plan_refused?.map((reason) => reason.code)).toEqual(["model_unknown"]);
    expect(result.plan_refused?.[0]?.message).toContain("Ollama did not answer at http://127.0.0.1:11434 (/api/tags failed: TypeError). Test the connection in Settings → Models.");
  });

  it("a plan prepared while Ollama answered goes stale when it stops, and readiness says why in the same words", async () => {
    const { http, state } = switchableOllama();
    const h = makeHarness({ catalogHttp: http });
    const session = await openWebair(h);
    expect((await useSearch(h, session.session.id)).run_plan?.preflight.ready).toBe(true);
    state.mode = "show-fails";
    // A view opening on the session re-reads the catalog (the flow's first `models.evaluate` refreshes).
    const models = (await h.controller.handle({ type: "models.evaluate", sessionId: session.session.id, refresh: true }, PAGE)) as ModelsView;
    expect(models.evaluation.models.find((model) => model.model_id === QWEN)).toMatchObject({ available: false, availability_reason: "Ollama stopped answering at http://127.0.0.1:11434 (/api/show failed)." });
    const plan = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(plan.preflight.stale_reasons.map((reason) => reason.code)).toEqual(["model_no_longer_available"]);
    expect(plan.preflight.stale_reasons[0]!.message).toContain("Ollama stopped answering at http://127.0.0.1:11434 (/api/show failed). Test the connection in Settings → Models.");
    const readiness = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(readiness.blocker).toMatchObject({ code: "run_plan_stale", message: expect.stringContaining("Ollama stopped answering at http://127.0.0.1:11434") });
  });

  it("concurrent refreshes share one probe", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    const before = h.httpLog.length;
    await Promise.all([1, 2, 3].map(() => h.controller.handle({ type: "models.evaluate", sessionId: session.session.id, refresh: true }, PAGE)));
    expect(h.httpLog.slice(before).filter((request) => request.url.endsWith("/api/tags"))).toHaveLength(1);
  });
});

describe("GPT-6 reasons by default: Luna and Astra both prepare a WebAir plan (D-078)", () => {
  const openai = { ...OLLAMA_ANSWERS, "GET https://api.openai.com/v1/models": { data: [{ id: "gpt-5.6-luna" }, { id: "gpt-6-astra" }, { id: "gpt-4.1" }] } };

  for (const model of ["openai/gpt-5.6-luna", "openai/gpt-6-astra"]) {
    it(`${model} prepares a ready plan with no Settings override`, async () => {
      const h = makeHarness({ http: openai });
      const session = await openWebair(h, { defaultModel: model });
      const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
      settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "openai" ? { ...connection, enabled: true } : connection));
      await h.controller.handle({ type: "settings.set", settings }, PAGE);
      await h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-test-not-a-real-key" }, PAGE);
      const result = await useSearch(h, session.session.id);
      expect(result.plan_refused).toBeNull();
      expect(result.run_plan?.preflight.ready).toBe(true);
      expect(result.run_plan?.run_plan.model_binding?.host_model_id).toBe(model);
    });
  }

  it("a model outside the families (gpt-4.1) stays unverified and blocked", async () => {
    const h = makeHarness({ http: openai });
    const session = await openWebair(h, { defaultModel: "openai/gpt-4.1" });
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "openai" ? { ...connection, enabled: true } : connection));
    await h.controller.handle({ type: "settings.set", settings }, PAGE);
    await h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-test-not-a-real-key" }, PAGE);
    const result = await useSearch(h, session.session.id);
    expect(result.run_plan).toBeNull();
    expect(result.plan_refused?.map((reason) => reason.code)).toContain("model_compatibility_unverified");
  });
});

describe("a view that just opened finds the run in flight (D-076)", () => {
  it("run.active prefers a run opened from the page the view looks at, else the most recent; settled runs and closed sessions do not count", async () => {
    const model = hanging();
    const h = makeHarness({ transports: { model: model.transport, tool: scriptedOrigin().transport } });
    expect(await h.controller.handle({ type: "run.active", pageUrl: `${SITE_ORIGIN}/` }, PAGE)).toBeNull();
    const fromHome = await openWebair(h, { page: `${SITE_ORIGIN}/`, viewId: "a" });
    const homeRun = await startSearch(h, fromHome.session.id);
    await until(() => model.reached() === 1, "the first model call");
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    const fromFlights = await openWebair(h, { page: `${SITE_ORIGIN}/flights`, viewId: "b" });
    const flightsRun = await startSearch(h, fromFlights.session.id);
    await until(() => model.reached() === 2, "the second model call");

    expect(((await h.controller.handle({ type: "run.active", pageUrl: `${SITE_ORIGIN}/#top` }, PAGE)) as RunView).runId).toBe(homeRun.runId);
    expect(((await h.controller.handle({ type: "run.active", pageUrl: `${SITE_ORIGIN}/flights` }, PAGE)) as RunView).runId).toBe(flightsRun.runId);
    // Another page, or none: the most recent run in flight.
    expect(((await h.controller.handle({ type: "run.active", pageUrl: "https://elsewhere.example/" }, PAGE)) as RunView).runId).toBe(flightsRun.runId);
    expect(((await h.controller.handle({ type: "run.active", pageUrl: null }, PAGE)) as RunView)).toMatchObject({ runId: flightsRun.runId, sessionId: fromFlights.session.id, status: "running" });

    // A closed session cannot be held again: its run is left to the Runs page.
    await h.controller.handle({ type: "package.close", sessionId: fromFlights.session.id }, PAGE);
    expect(((await h.controller.handle({ type: "run.active", pageUrl: `${SITE_ORIGIN}/flights` }, PAGE)) as RunView).runId).toBe(homeRun.runId);
    for (const runId of [homeRun.runId, flightsRun.runId]) await h.controller.handle({ type: "run.cancel", runId }, PAGE);
    await h.h_drain();
    expect(await h.controller.handle({ type: "run.active", pageUrl: null }, PAGE)).toBeNull();
  });

  it("Inspect of the same bytes from the same page while their run is in flight returns that session; otherwise a new one", async () => {
    const model = hanging();
    const h = makeHarness({ transports: { model: model.transport, tool: scriptedOrigin().transport } });
    const first = await openWebair(h, { viewId: "panel-1" });
    // No run yet: a second Inspect opens a second session, as before.
    const idle = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "other" }, PAGE)) as SessionView;
    expect(idle.session.id).not.toBe(first.session.id);
    await h.controller.handle({ type: "package.close", sessionId: idle.session.id }, PAGE);

    const run = await startSearch(h, first.session.id);
    await until(() => model.reached() === 1, "the model call");
    const sessions = () => h.controller.handle({ type: "sessions.list" }, PAGE) as Promise<{ sessions: unknown[] }>;
    const count = (await sessions()).sessions.length;
    const again = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/#again`, viewId: "panel-2" }, PAGE)) as SessionView;
    expect(again.session.id, "the run's session, so the person sees their run").toBe(first.session.id);
    expect(again.authorization.state).toBe("issued");
    expect((await sessions()).sessions).toHaveLength(count);
    expect(((await h.controller.handle({ type: "run.list", sessionId: again.session.id }, PAGE)) as { active: RunView | null }).active?.runId).toBe(run.runId);
    // The same bytes advertised on another page, or opened from the address bar, are another session.
    const elsewhere = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/flights`, viewId: "panel-3" }, PAGE)) as SessionView;
    expect(elsewhere.session.id).not.toBe(first.session.id);
    const typed = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: null, viewId: "panel-4" }, PAGE)) as SessionView;
    expect(typed.session.id).not.toBe(first.session.id);
    await h.controller.handle({ type: "run.cancel", runId: run.runId }, PAGE);
    await h.h_drain();
  });
});
