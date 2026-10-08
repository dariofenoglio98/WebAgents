/**
 * Runs from the browser (T5, D-070…D-073): readiness and its reasons, a WebAir run end to end
 * through the in-process execution host with a scripted model and the real origin's recorded
 * answers, checkpoints after every wave, the record and the artifacts a view reads, `once` spent
 * by the first run, cancel, an unloaded host interrupting (never resuming) a run, the export
 * bundle, and the privacy observer (D-028): no sealed value in any model request, a granted value
 * only on the tool endpoint that links its permission.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { HttpTransport } from "../../src/core/models/transport.js";
import { verifyAuditChain } from "../../src/core/execution/report.js";
import type { JsonObject } from "../../src/core/json.js";
import type { ArtifactChunk, ArtifactContent, AuthorizeResult, ExportBundle, ObservationsView, RunListView, RunReadiness, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { MemoryRunStore, type StoredRun } from "../../src/extension/storage/runs.js";
import { originAnswers, scriptedOllama, scriptedOrigin, webairModelAnswers, type SeenRequest } from "../helpers/host.js";
import { SHIPPED } from "../helpers/paths.js";
import { makeHarness, OFFSCREEN, PAGE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";

const QWEN = "ollama/qwen3:30b";
const PICKS = { "profile.travel": "profile_demo_traveler", "identity.passenger": "passenger_demo_alex", "wallet.payment": "payment_demo_visa" };
const SEARCH = { request: "Find me a nonstop flight from Boston to Zurich on 9 October under $900.", booking: false, purchase: { quote_id: "", fare_id: "" } };
const BOOKING = { request: "Prepare WA101 Standard for 9 October for me.", booking: true, purchase: { quote_id: "", fare_id: "" } };
/** The sealed and personal values of the demo set (D-051): what no model request may carry. */
const SEALED = { email: "alex.traveler@example.com", payment: "demo-visa-4242", given: "Alex", family: "Traveler", display: "Demo Visa •••• 4242" };

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

interface World {
  h: Harness;
  session: SessionView;
  modelSeen: SeenRequest[];
  toolSeen: SeenRequest[];
}

/** A trusted WebAir 0.4.0 session with Ollama's qwen3:30b as the default model, the demo vault and scripted transports. */
async function world(options: { runs?: MemoryRunStore; hostOptions?: { available?: boolean; failStart?: boolean }; demo?: boolean } = {}): Promise<World> {
  const model = scriptedOllama(webairModelAnswers());
  const tool = scriptedOrigin();
  const h = makeHarness({ transports: { model: model.transport, tool: tool.transport }, runs: options.runs, hostOptions: options.hostOptions });
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "test" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
  const settings = current.settings;
  settings.models.default_model = QWEN;
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  if (options.demo ?? true) await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE);
  const session = (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
  return { h, session, modelSeen: model.seen, toolSeen: tool.seen };
}

async function authorize(w: World, profileId: "search" | "quote" | "book", picks: Record<string, string> = {}): Promise<AuthorizeResult> {
  const result = (await w.h.controller.handle({ type: "authorization.useProfile", sessionId: w.session.session.id, packageDigest: SHIPPED.webair040.digest, profileId, resourceSelections: picks, prepare: true }, PAGE)) as AuthorizeResult;
  expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
  return result;
}

async function startRun(w: World, result: AuthorizeResult, input: unknown): Promise<RunView> {
  const plan = result.run_plan!.run_plan;
  return (await w.h.controller.handle({ type: "run.start", sessionId: w.session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input }, PAGE)) as RunView;
}

async function finished(w: World, runId: string): Promise<RunView> {
  await w.h.host.drain();
  return (await w.h.controller.handle({ type: "run.get", runId }, PAGE)) as RunView;
}

const bodies = (seen: SeenRequest[], path?: string) => seen.filter((request) => path === undefined || new URL(request.url).pathname === path).map((request) => request.body ?? "");

describe("readiness (the reference plugin's execution.readiness)", () => {
  it("names the first missing condition, then becomes ready with the receipt's remaining time", async () => {
    const w = await world();
    const before = (await w.h.controller.handle({ type: "run.readiness", sessionId: w.session.session.id }, PAGE)) as RunReadiness;
    expect(before).toMatchObject({ ready: false, blocker: { code: "run_plan_absent" }, checks: ["execution_host_available"] });
    const result = await authorize(w, "search");
    const ready = (await w.h.controller.handle({ type: "run.readiness", sessionId: w.session.session.id }, PAGE)) as RunReadiness;
    expect(ready).toMatchObject({ ready: true, blocker: null, run_plan_id: result.run_plan!.run_plan.run_plan_id, checks: ["execution_host_available", "plan_mode_model", "preflight_ready", "receipt_outlasts_run_deadline", "no_active_run"] });
    expect(ready.receipt).toMatchObject({ required_seconds: 660 });
    expect(ready.receipt!.remaining_seconds).toBeGreaterThan(660);
    // Without an execution host the browser says so first.
    const without = await world({ hostOptions: { available: false } });
    expect(((await without.h.controller.handle({ type: "run.readiness", sessionId: without.session.session.id }, PAGE)) as RunReadiness).blocker?.code).toBe("execution_unavailable");
  });

  it("validates a task against the package's own input schema before Run is offered", async () => {
    const w = await world();
    const valid = (await w.h.controller.handle({ type: "run.validateInput", sessionId: w.session.session.id, input: SEARCH }, PAGE)) as { valid: boolean; errors: unknown[] };
    expect(valid.valid).toBe(true);
    const invalid = (await w.h.controller.handle({ type: "run.validateInput", sessionId: w.session.session.id, input: { request: 42 } }, PAGE)) as { valid: boolean; errors: Array<{ pointer: string }> };
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });
});

describe("a WebAir run from the browser", () => {
  it("searches end to end: leased, checkpointed after every wave, completed with artifacts and a valid audit chain", async () => {
    const w = await world();
    const result = await authorize(w, "search");
    const started = await startRun(w, result, SEARCH);
    expect(started).toMatchObject({ status: "preparing", runId: "run_00000000000000000000000000000001", sessionOpen: true, profileId: "search", taskText: SEARCH.request });
    expect(started.revalidated).toContain("preflight_ready");
    expect(started.revalidated.some((item) => item.startsWith("tool_bindings:"))).toBe(true);
    expect(w.h.host.started[0]).toMatchObject({ type: "host.start", runId: started.runId, credentials: { openai: null, anthropic: null }, settings: { recordRequests: false } });
    const record = await finished(w, started.runId);
    expect(record).toMatchObject({ status: "completed", errorCode: null, cancelRequested: false, origin: "live" });
    expect(record.model).toMatchObject({ planned: QWEN, invoked: [QWEN], calls: 3, allCallsUsedPlannedModel: true });
    expect(record.usage!.tokens).toBeGreaterThan(0);
    expect(record.tools.map((tool) => [tool.toolId, tool.calls])).toEqual([
      ["get-fare-rules", 3],
      ["search-flights", 1],
    ]);
    expect(record.audit).toMatchObject({ chainValid: true, modelCalls: 3, toolCalls: 4 });
    expect(record.artifacts.map((artifact) => artifact.name).sort()).toEqual(["answer.md", "audit.json", "booking.json", "fare-rules.json", "provenance.json", "result.json", "search.json", "usage.json"]);
    // Checkpoints: one per committed wave at least, each with the audit so far (D-071).
    const stored = (await w.h.runs.getRun(started.runId))!;
    expect(stored.checkpoints).toBeGreaterThan(5);
    expect(stored.audit.length).toBe(record.audit!.events);
    expect(verifyAuditChain(stored.audit as unknown as JsonObject[])).toMatchObject({ valid: true, events: record.audit!.events });
    // The views learned of every change; the last broadcast is the settled run.
    const runEvents = w.h.events.filter((event) => event.type === "event.run");
    expect(runEvents[0]).toMatchObject({ type: "event.run", runId: started.runId, status: "preparing" });
    expect(runEvents.at(-1)).toMatchObject({ type: "event.run", runId: started.runId, status: "completed" });
    // Artifacts read whole, in chunks, and as the export bundle (D-073).
    const answer = (await w.h.controller.handle({ type: "run.artifact", runId: started.runId, name: "answer.md" }, PAGE)) as ArtifactContent;
    expect(answer.truncated).toBe(false);
    expect(answer.text).toContain("Boston to Zurich");
    const audit = (await w.h.controller.handle({ type: "run.artifact", runId: started.runId, name: "audit.json" }, PAGE)) as ArtifactContent;
    expect(audit.sha256).toBe(record.artifacts.find((artifact) => artifact.name === "audit.json")!.sha256);
    const chunk = (await w.h.controller.handle({ type: "run.artifactChunk", runId: started.runId, name: "answer.md", offset: 0 }, PAGE)) as ArtifactChunk;
    expect(chunk).toMatchObject({ eof: true, offset: 0, sha256: answer.sha256, bytes: answer.bytes });
    const runJson = (await w.h.controller.handle({ type: "run.artifact", runId: started.runId, name: "run.json" }, PAGE)) as ArtifactContent;
    expect((runJson.json as { status?: string }).status).toBe("completed");
    const bundle = (await w.h.controller.handle({ type: "run.export", runId: started.runId }, PAGE)) as ExportBundle;
    expect(bundle.entries.map((entry) => entry.name)).toEqual(["run.json", "run-plan.json", "input.json", "answer.md", "audit.json", "booking.json", "fare-rules.json", "provenance.json", "result.json", "search.json", "usage.json"]);
    const list = (await w.h.controller.handle({ type: "run.list", sessionId: w.session.session.id }, PAGE)) as RunListView;
    expect(list.runs.map((run) => [run.runId, run.status])).toEqual([[started.runId, "completed"]]);
    expect(list.active).toBeNull();
    // No personal value went anywhere: the search profile grants none, so none was resolved or sent.
    expect(record.resources).toEqual([]);
    for (const body of [...bodies(w.modelSeen), ...bodies(w.toolSeen)]) for (const value of Object.values(SEALED)) expect(body).not.toContain(value);
  });

  it("refuses a second start while one is active, a stale plan, an invalid task and an unknown run", async () => {
    const w = await world();
    const result = await authorize(w, "search");
    const plan = result.run_plan!.run_plan;
    expect((await refused(startRun(w, result, { request: 42 }))).code).toBe("input_invalid");
    expect((await refused(w.h.controller.handle({ type: "run.start", sessionId: w.session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: "0".repeat(64), input: SEARCH }, PAGE))).code).toBe("run_plan_mismatch");
    const started = await startRun(w, result, SEARCH);
    expect((await refused(startRun(w, result, SEARCH))).code).toBe("execution_active");
    await finished(w, started.runId);
    // The same plan runs again: a session grant is not spent by a run.
    const again = await startRun(w, result, SEARCH);
    expect((await finished(w, again.runId)).status).toBe("completed");
    expect(await w.h.controller.handle({ type: "run.get", runId: "run_missing" }, PAGE)).toBeNull();
    expect((await refused(w.h.controller.handle({ type: "run.artifact", runId: "run_missing", name: "answer.md" }, PAGE))).code).toBe("run_unknown");
  });

  it("a view cannot forge a host report", async () => {
    const w = await world();
    expect((await refused(w.h.controller.handle({ type: "host.progress", runId: "run_x" }, PAGE))).code).toBe("not_allowed");
    expect(await w.h.controller.handle({ type: "host.progress", runId: "run_x" }, OFFSCREEN)).toEqual({ received: true });
  });
});

describe("quote, purchase under once, replay refused, denial (the live demo's phases)", () => {
  it("quotes with the passenger identity reaching only prepare_booking, then purchases once; the once grant is spent and the replay refused", async () => {
    const w = await world();
    const quoteAuth = await authorize(w, "quote", { "profile.travel": PICKS["profile.travel"], "identity.passenger": PICKS["identity.passenger"] });
    const booking = await finished(w, (await startRun(w, quoteAuth, BOOKING)).runId);
    expect(booking.status).toBe("completed");
    expect(booking.resources.map((grant) => grant.resourceId).sort()).toEqual(["passenger_demo_alex", "profile_demo_traveler"]);
    const quote = (await w.h.controller.handle({ type: "run.artifact", runId: booking.runId, name: "booking.json" }, PAGE)) as ArtifactContent;
    const quoteId = (quote.json as { booking?: { quote_id?: string } }).booking!.quote_id!;
    expect(quoteId).toBe(originAnswers().prepare_booking.output.quote_id);
    // Privacy (D-028): the identity reached prepare_booking only; no model request carries it; the payment id went nowhere.
    const bookingTools = w.toolSeen.filter((request) => (request.body ?? "").includes(SEALED.email));
    expect([...new Set(bookingTools.map((request) => new URL(request.url).pathname))]).toEqual(["/api/v1/prepare_booking"]);
    for (const body of bodies(w.modelSeen)) {
      expect(body).not.toContain(SEALED.email);
      expect(body).not.toContain(SEALED.payment);
      expect(body).not.toMatch(/\bAlex\b/u);
      expect(body).not.toMatch(/\bTraveler\b/u);
    }
    for (const body of bodies(w.toolSeen)) expect(body).not.toContain(SEALED.payment);
    // The result is redacted: no e-mail or given name in the booking artifact.
    expect(quote.text).not.toContain(SEALED.email);
    expect(quote.text).not.toContain("given_name");

    // Purchase under once.
    const bookAuth = await authorize(w, "book", PICKS);
    expect(bookAuth.receipt.decisions["booking.simulate_purchase"]).toBe("once");
    const purchaseInput = { request: `Simulate purchase of quote ${quoteId}.`, booking: false, purchase: { quote_id: quoteId, fare_id: "WA101-20261009-STANDARD" } };
    const modelCallsBefore = w.modelSeen.length;
    const purchase = await finished(w, (await startRun(w, bookAuth, purchaseInput)).runId);
    expect(purchase.status).toBe("completed");
    expect(purchase.grants.decisions.find((item) => item.permissionId === "booking.simulate_purchase")?.decision).toBe("once");
    expect(purchase.model?.calls).toBe(1); // only `answer`: the quote is authority, not a search
    expect(w.modelSeen.length - modelCallsBefore).toBe(1);
    // `result.json` embeds the audit and exceeds the whole-view limit; the export `booking.json` carries the purchase summary.
    const purchaseResult = (await w.h.controller.handle({ type: "run.artifact", runId: purchase.runId, name: "result.json" }, PAGE)) as ArtifactContent;
    expect(purchaseResult.truncated).toBe(true);
    const purchaseExport = (await w.h.controller.handle({ type: "run.artifact", runId: purchase.runId, name: "booking.json" }, PAGE)) as ArtifactContent;
    const summary = (purchaseExport.json as { purchase?: { simulated?: boolean; real_transaction?: boolean; amount_charged_usd?: number; quote_id?: string } }).purchase!;
    expect(summary).toMatchObject({ simulated: true, real_transaction: false, amount_charged_usd: 0, quote_id: quoteId });
    expect(purchase.outputSha256).not.toBeNull();
    // The payment identifier reached simulate_purchase only, and no model request.
    const paymentTools = w.toolSeen.filter((request) => (request.body ?? "").includes(SEALED.payment));
    expect([...new Set(paymentTools.map((request) => new URL(request.url).pathname))]).toEqual(["/api/v1/simulate_purchase"]);
    for (const body of [...bodies(w.modelSeen), ...bodies(w.toolSeen)]) expect(body).not.toContain(SEALED.display);
    // Purchase revalidated the exact quote: prepare_booking then simulate_purchase.
    const purchasePaths = w.toolSeen.slice(-2).map((request) => new URL(request.url).pathname);
    expect(purchasePaths).toEqual(["/api/v1/prepare_booking", "/api/v1/simulate_purchase"]);
    // Replay: the once grant is spent; the plan is stale and Run is refused.
    const readiness = (await w.h.controller.handle({ type: "run.readiness", sessionId: w.session.session.id }, PAGE)) as RunReadiness;
    expect(readiness.ready).toBe(false);
    expect(readiness.blocker?.code).toBe("run_plan_stale");
    expect(readiness.preflight?.stale_reasons.map((reason) => reason.code)).toContain("authorization_once_spent");
    const replay = await refused(startRun(w, bookAuth, purchaseInput));
    expect(replay.code).toBe("run_plan_stale");
    expect(replay.message).toContain("once");
    expect((await w.h.controller.handle({ type: "run.list", sessionId: w.session.session.id }, PAGE)) as RunListView).toMatchObject({ runs: expect.arrayContaining([expect.objectContaining({ runId: purchase.runId })]) });
    expect(((await w.h.controller.handle({ type: "run.list", sessionId: w.session.session.id }, PAGE)) as RunListView).runs).toHaveLength(2);
  });

  it("denied without the grant: the quote profile cannot purchase; the run fails with permission_denied before any model or WebAir call", async () => {
    const w = await world();
    const quoteAuth = await authorize(w, "quote", { "profile.travel": PICKS["profile.travel"], "identity.passenger": PICKS["identity.passenger"] });
    const quoteId = String(originAnswers().prepare_booking.output.quote_id);
    const toolsBefore = w.toolSeen.length;
    const modelsBefore = w.modelSeen.length;
    const denial = await finished(w, (await startRun(w, quoteAuth, { request: `Simulate purchase of quote ${quoteId}.`, booking: false, purchase: { quote_id: quoteId, fare_id: "WA101-20261009-STANDARD" } })).runId);
    expect(denial).toMatchObject({ status: "failed", errorCode: "permission_denied" });
    expect(denial.model?.calls ?? 0).toBe(0);
    expect(w.toolSeen.length).toBe(toolsBefore);
    expect(w.modelSeen.length).toBe(modelsBefore);
    expect(denial.resources.map((grant) => grant.permissionId)).not.toContain("wallet.payment");
    // In Chrome the unapproved tool is refused before its permission is even checked (D-022: a
    // denied tool has no binding and the runtime refuses the call); the audit names the refused
    // tool and the node's error code. The reference runtime, which approves every declared tool,
    // records `permission.checked allowed=false` for `wallet.payment` instead; T7's verifier takes either.
    const stored = (await w.h.runs.getRun(denial.runId))!;
    const refusedTool = stored.audit.find((event) => event.action === "tool.failed") as unknown as { tool?: string; error?: string } | undefined;
    expect(refusedTool).toMatchObject({ tool: "wallet.payment_method", error: "PolicyError" });
    expect(denial.failure).toMatchObject({ nodeId: "payment", errorCode: "permission_denied", call: { kind: "tool", tool: "wallet.payment_method" } });
    expect(stored.audit.some((event) => event.action === "tool.dispatched")).toBe(false);
    // The evidence of a failed run is written too.
    expect(denial.artifacts.map((artifact) => artifact.name).sort()).toEqual(["audit.json", "provenance.json", "result.json", "usage.json"]);
  });
});

describe("cancel, interruption and clearing", () => {
  it("cancel stops the run within one wave and settles it as cancelled with its audit (D-060)", async () => {
    // A model that answers only when its request is aborted: the run waits inside `interpret` until Cancel.
    let reached = 0;
    const hanging: HttpTransport = (request) =>
      new Promise((_resolve, reject) => {
        reached += 1;
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    const h = makeHarness({ transports: { model: hanging, tool: scriptedOrigin().transport } });
    const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "test" }, PAGE)) as SessionView;
    await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
    const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    await h.controller.handle({ type: "settings.set", settings: { ...current.settings, models: { ...current.settings.models, default_model: QWEN } } }, PAGE);
    const w: World = { h, session: view, modelSeen: [], toolSeen: [] };
    const result = await authorize(w, "search");
    const started = await startRun(w, result, SEARCH);
    // Wait until the model call is in flight, then cancel.
    for (let attempt = 0; attempt < 200 && reached === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reached).toBe(1);
    const running = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect(running.status).toBe("running");
    const cancelled = (await h.controller.handle({ type: "run.cancel", runId: started.runId }, PAGE)) as RunView;
    expect(cancelled.cancelRequested).toBe(true);
    const settled = await finished(w, started.runId);
    expect(settled).toMatchObject({ status: "cancelled", cancelRequested: true, errorCode: "cancelled" });
    expect(settled.audit?.chainValid).toBe(true);
    expect(settled.artifacts.map((artifact) => artifact.name).sort()).toEqual(["audit.json", "provenance.json", "result.json", "usage.json"]);
    expect(reached).toBe(1); // nothing else was dispatched after the cancel
    expect(h.events.at(-1)).toMatchObject({ type: "event.run", runId: started.runId, status: "cancelled" });
    // Cancelling a settled run changes nothing.
    expect(((await h.controller.handle({ type: "run.cancel", runId: started.runId }, PAGE)) as RunView).status).toBe("cancelled");
  });

  it("a run whose host is gone is interrupted on the next start, never resumed (D-027)", async () => {
    const runs = new MemoryRunStore();
    const first = await world({ runs, hostOptions: { failStart: true } });
    const result = await authorize(first, "search");
    // The host refused to start: the run fails at once and the lease is released.
    const failed = await refused(startRun(first, result, SEARCH));
    expect(failed.code).toBe("execution_unavailable");
    const stored = (await runs.listRuns())[0]!;
    expect(stored.record.status).toBe("failed");
    // Now a run that the store says is running, whose host does not know it: the next worker marks it interrupted.
    stored.record = { ...stored.record, status: "running", errorCode: null, errorDetail: null, endedAt: null };
    await runs.putRun(stored);
    const second = makeHarness({ runs, stores: { snapshots: first.h.snapshots, trustStorage: first.h.trustStorage, tabs: first.h.tabs, settingsArea: first.h.settingsArea } });
    const view = (await second.controller.handle({ type: "run.get", runId: stored.run_id }, PAGE)) as RunView;
    expect(view).toMatchObject({ status: "interrupted", errorCode: "host_unloaded" });
    expect(view.errorDetail).toContain("never resumed");
    expect(second.events).toContainEqual(expect.objectContaining({ type: "event.run", runId: stored.run_id, status: "interrupted" }));
    // Terminal runs clear; a run in flight does not.
    expect(await second.controller.handle({ type: "run.clear", runId: stored.run_id }, PAGE)).toEqual({ cleared: true, run_id: stored.run_id });
    expect(await second.controller.handle({ type: "run.get", runId: stored.run_id }, PAGE)).toBeNull();
  });

  it("records every outbound request body only in test mode (D-028)", async () => {
    const w = await world();
    const current = (await w.h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    await w.h.controller.handle({ type: "settings.set", settings: { ...current.settings, developer: { record_requests: true } } }, PAGE);
    const result = await authorize(w, "search");
    const record = await finished(w, (await startRun(w, result, SEARCH)).runId);
    const observed = (await w.h.controller.handle({ type: "run.observations", runId: record.runId }, PAGE)) as ObservationsView;
    expect(observed.recording).toBe(true);
    expect(observed.observations.filter((item) => item.kind === "model")).toHaveLength(3);
    expect(observed.observations.filter((item) => item.kind === "tool").map((item) => new URL(item.url).pathname).sort()).toEqual(["/api/v1/get_fare_rules", "/api/v1/get_fare_rules", "/api/v1/get_fare_rules", "/api/v1/search_flights"]);
    expect(observed.observations.every((item) => item.body_sha256.length === 64 && item.body_bytes > 0)).toBe(true);
    // Off by default: nothing recorded.
    const quiet = await world();
    const quietRun = await finished(quiet, (await startRun(quiet, await authorize(quiet, "search"), SEARCH)).runId);
    expect(((await quiet.h.controller.handle({ type: "run.observations", runId: quietRun.runId }, PAGE)) as ObservationsView)).toMatchObject({ recording: false, observations: [] });
  });
});

/** A session on a model that never answers: the run stays inside its first model call until something ends it. */
async function hangingWorld(options: { runs?: MemoryRunStore; hostOptions?: { workerDies?: boolean } } = {}): Promise<{ w: World; reached: () => number }> {
  let reached = 0;
  const hanging: HttpTransport = (request) =>
    new Promise((_resolve, reject) => {
      reached += 1;
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  const h = makeHarness({ transports: { model: hanging, tool: scriptedOrigin().transport }, runs: options.runs, hostOptions: options.hostOptions });
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "test" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
  await h.controller.handle({ type: "settings.set", settings: { ...current.settings, models: { ...current.settings.models, default_model: QWEN } } }, PAGE);
  return { w: { h, session: view, modelSeen: [], toolSeen: [] }, reached: () => reached };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition(), what).toBe(true);
}

describe("review 1: the host owns a record in flight", () => {
  it("Cancel racing the host's final write never puts a completed run back in flight (finding 1)", async () => {
    // The service worker is scheduled late: its one atomic write happens after the host settled.
    class LateStore extends MemoryRunStore {
      gate: Promise<void> = Promise.resolve();
      override async updateRun(runId: string, mutate: (run: StoredRun) => StoredRun | null): Promise<StoredRun | null> {
        // Hold the worker's flag write only (it adds no checkpoint); the host's checkpoints and final write go through.
        const current = this.runs.get(runId);
        const probe = current ? mutate(structuredClone(current)) : null;
        if (current && probe !== null && probe.checkpoints === current.checkpoints) await this.gate;
        return super.updateRun(runId, mutate);
      }
    }
    const runs = new LateStore();
    const w = await world({ runs });
    const result = await authorize(w, "search");
    const started = await startRun(w, result, SEARCH);
    expect(started.status).toBe("preparing");
    let open!: () => void;
    runs.gate = new Promise((resolve) => {
      open = resolve;
    });
    const cancelling = w.h.controller.handle({ type: "run.cancel", runId: started.runId }, PAGE) as Promise<RunView>;
    await w.h.host.drain(); // the host completes the run while Cancel waits between its read and its write
    open();
    const answered = await cancelling;
    expect(answered).toMatchObject({ status: "completed", cancelRequested: false });
    const after = (await w.h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect(after.status).toBe("completed");
    expect(after.artifacts.map((artifact) => artifact.name)).toContain("result.json");
    expect(after.audit?.chainValid).toBe(true);
    // The package is free again, and the host was not asked to cancel a run it no longer had.
    const readiness = (await w.h.controller.handle({ type: "run.readiness", sessionId: w.session.session.id }, PAGE)) as RunReadiness;
    expect(readiness.blocker?.code).not.toBe("execution_active");
    expect(w.h.events.filter((event) => event.type === "event.run" && event.runId === started.runId).at(-1)).toMatchObject({ status: "completed" });
    // A later worker start finds a completed run, not one to interrupt.
    const second = makeHarness({ runs, stores: { snapshots: w.h.snapshots, trustStorage: w.h.trustStorage, tabs: w.h.tabs, settingsArea: w.h.settingsArea } });
    expect(((await second.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView).status).toBe("completed");
    // And a cancel that lands while the run is in flight still sets the flag in one step and reaches the host.
    const next = await startRun(w, result, SEARCH);
    const flagged = (await w.h.controller.handle({ type: "run.cancel", runId: next.runId }, PAGE)) as RunView;
    expect(flagged.cancelRequested).toBe(true);
    await w.h.host.drain();
  });

  it("a Worker that dies leaves no run in flight: the host's finished report interrupts it (finding 2, D-071)", async () => {
    const { w, reached } = await hangingWorld({ hostOptions: { workerDies: true } });
    const result = await authorize(w, "search");
    const started = await startRun(w, result, SEARCH);
    await until(() => w.h.events.some((event) => event.type === "event.run" && event.runId === started.runId && event.status === "interrupted"), "the interrupted event");
    const view = (await w.h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect(view).toMatchObject({ status: "interrupted", errorCode: "host_failed" });
    expect(view.errorDetail).toContain("never resumed");
    const kept = (await w.h.runs.getRun(started.runId))!;
    expect(kept.checkpoints).toBeGreaterThanOrEqual(1); // the last checkpoint is kept
    // The plan and the session are free: readiness is not blocked by the dead run, and a new run starts.
    const readiness = (await w.h.controller.handle({ type: "run.readiness", sessionId: w.session.session.id }, PAGE)) as RunReadiness;
    expect(readiness.ready, JSON.stringify(readiness.blocker)).toBe(true);
    const again = await startRun(w, result, SEARCH);
    expect(again.status).toBe("preparing");
    expect(reached()).toBeGreaterThanOrEqual(1);
  });

  it("the host executes a run exactly once: a start naming a settled run writes and calls nothing (finding 3)", async () => {
    const w = await world();
    const result = await authorize(w, "search");
    const record = await finished(w, (await startRun(w, result, SEARCH)).runId);
    expect(record.status).toBe("completed");
    const before = await w.h.runs.getRun(record.runId);
    const modelCalls = w.modelSeen.length;
    const toolCalls = w.toolSeen.length;
    // The same `host.start` again (what a forged command naming a completed `once` purchase would be): refused by the host, nothing re-runs.
    await w.h.host.start(w.h.host.started[0]!);
    await w.h.host.drain();
    expect(await w.h.runs.getRun(record.runId)).toEqual(before);
    expect(w.modelSeen).toHaveLength(modelCalls);
    expect(w.toolSeen).toHaveLength(toolCalls);
  });

  it("a host that exists but did not answer decides nothing: the runs stay and the next call asks again (nit 6)", async () => {
    const runs = new MemoryRunStore();
    const first = await world({ runs, hostOptions: { failStart: true } });
    await refused(startRun(first, await authorize(first, "search"), SEARCH));
    const stored = (await runs.listRuns())[0]!;
    stored.record = { ...stored.record, status: "running", errorCode: null, errorDetail: null, endedAt: null };
    await runs.putRun(stored);
    const second = makeHarness({ runs, stores: { snapshots: first.h.snapshots, trustStorage: first.h.trustStorage, tabs: first.h.tabs, settingsArea: first.h.settingsArea }, hostOptions: { statusFailures: 1 } });
    expect(((await second.controller.handle({ type: "run.get", runId: stored.run_id }, PAGE)) as RunView).status).toBe("running");
    expect(second.events.some((event) => event.type === "event.run" && event.status === "interrupted")).toBe(false);
    expect(((await second.controller.handle({ type: "run.get", runId: stored.run_id }, PAGE)) as RunView)).toMatchObject({ status: "interrupted", errorCode: "host_unloaded" });
    expect(second.host.statusCalls).toBe(2);
  });

  it("Close keeps the snapshot a run in flight still has to read; it goes when the run settles (nit 7)", async () => {
    const { w, reached } = await hangingWorld();
    const result = await authorize(w, "search");
    const started = await startRun(w, result, SEARCH);
    await until(() => reached() === 1, "the model call in flight");
    const closed = await w.h.controller.handle({ type: "package.release", sessionId: w.session.session.id, viewId: "test" }, PAGE);
    expect(closed).toMatchObject({ closed: true });
    expect(await w.h.controller.handle({ type: "sessions.list" }, PAGE)).toEqual({ sessions: [] });
    expect(await w.h.snapshots.listSnapshots()).toHaveLength(1);
    await w.h.controller.handle({ type: "run.cancel", runId: started.runId }, PAGE);
    await w.h.host.drain();
    expect(((await w.h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView).status).toBe("cancelled");
    expect(await w.h.snapshots.listSnapshots()).toEqual([]);
  });
});
