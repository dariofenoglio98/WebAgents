/**
 * The authorization flow through the worker (T3 acceptance): WebAir 0.4.0's "Search flights"
 * profile authorizes and prepares a plan in two requests with the booking tools and every
 * personal resource denied; Literature Review's customize path reproduces the recorded
 * OpenClaw decisions and the plan carries the three tool approvals; a changed vault record or
 * a removed model makes the plan stale with the ported codes; receipts and plans survive a
 * worker restart with their hashes; settings, keys and the vault live in storage.local.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { AuthorizationView, AuthorizeResult, ModelsView, RunPlanState, SessionView, SettingsView, VaultView } from "../../src/extension/messages.js";
import { MemoryTrustStorage } from "../../src/core/trust.js";
import { MemoryStorageArea } from "../../src/extension/storage/settings.js";
import { MemorySnapshotStore } from "../../src/extension/storage/snapshots.js";
import { MemoryTabStateStore } from "../../src/extension/storage/tab-state.js";
import { ROOT, SHIPPED } from "../helpers/paths.js";
import { LITERATURE_URL, makeHarness, OLLAMA_ANSWERS, PAGE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

const QWEN = "ollama/qwen3:30b";

/** A trusted WebAir 0.4.0 session with the default model set, as a person who finished Settings → Models would have it. */
async function openWebair(h: Harness, options: { trust?: boolean; defaultModel?: string | null; preset?: "privacy-first" | "balanced" | "convenience" } = {}): Promise<SessionView> {
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "test" }, PAGE)) as SessionView;
  if (options.trust ?? true) await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
  const settings = current.settings;
  settings.models.default_model = options.defaultModel === undefined ? QWEN : options.defaultModel;
  settings.models.connections = settings.models.connections.map((connection) =>
    connection.provider === "ollama" ? { ...connection, overrides: { "qwen3:30b": { context_tokens: 65536, max_output_tokens: 16384 } } } : connection,
  );
  if (options.preset) settings.preset = options.preset;
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  return (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
}

const demoPicks = { "profile.travel": "profile_demo_traveler", "identity.passenger": "passenger_demo_alex", "wallet.payment": "payment_demo_visa" };

describe("the authorization view", () => {
  it("offers WebAir 0.4.0's three profiles with the decisions each yields, the preset's defaults, the vault's resources and this host's tools", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    const view = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    expect(view.preset).toBe("balanced");
    expect(view.profiles?.map((item) => item.profile.id)).toEqual(["search", "quote", "book"]);
    expect(view.profiles?.[0]?.decided.decisions).toMatchObject({ "network.webair": "session", "profile.travel": "deny", "booking.simulate_purchase": "deny" });
    expect(view.profiles?.[2]?.decided.decisions["booking.simulate_purchase"]).toBe("once");
    expect(view.defaults.provenance.preset).toBe("balanced");
    expect(view.request.blocking_reasons.map((reason) => reason.code)).toEqual(["required_permission_denied", "required_permission_denied", "required_permission_denied"]);
    // The vault starts with the demo host's types and no record: every request is `empty` until the person adds data.
    expect(view.resources.requests.map((request) => [request.permission_id, request.status])).toEqual([
      ["profile.travel", "empty"],
      ["identity.passenger", "empty"],
      ["wallet.payment", "empty"],
    ]);
    expect(view.missing_resource_types).toEqual([]);
    expect(view.tools.map((tool) => [tool.tool_id, tool.status])).toEqual([
      ["get-fare-rules", "bound"],
      ["personal.passenger_identity", "bound"],
      ["personal.travel_profile", "bound"],
      ["prepare-booking", "bound"],
      ["search-flights", "bound"],
      ["simulate-purchase", "bound"],
      ["wallet.payment_method", "bound"],
    ]);
    expect(view.receipt).toBeNull();
    expect(view.run_plan).toBeNull();
    expect(view.default_model).toBe(QWEN);
    expect(session.authorization).toEqual({ state: "none", receipt_id: null, runnable: false });
  });
});

describe("two clicks: a profile becomes a ready plan (D-022)", () => {
  it("'Search flights' authorizes with the booking tools and every personal resource denied, and prepares a plan on the default model", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    const result = (await h.controller.handle(
      { type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true },
      PAGE,
    )) as AuthorizeResult;
    const receipt = result.receipt;
    expect(receipt.runnable).toBe(true);
    expect(receipt.decisions).toEqual({
      "network.webair": "session",
      "model.reasoning": "session",
      "memory.session": "session",
      "profile.travel": "deny",
      "identity.passenger": "deny",
      "wallet.payment": "deny",
      "booking.simulate_purchase": "deny",
    });
    expect(receipt.tool_approvals).toEqual({
      "search-flights": true,
      "get-fare-rules": true,
      "prepare-booking": false,
      "simulate-purchase": false,
      "personal.travel_profile": false,
      "personal.passenger_identity": false,
      "wallet.payment_method": false,
    });
    expect(receipt.resource_grants).toEqual([]);
    expect(receipt.provenance).toMatchObject({ profile_id: "search", preset: "balanced" });
    expect(new Set(Object.values(receipt.provenance!.decisions))).toEqual(new Set(["profile"]));
    expect(result.plan_refused).toBeNull();
    expect(result.model_id).toBe(QWEN);
    const plan = result.run_plan!;
    expect(plan.preflight).toMatchObject({ state: "ready", ready: true, stale: false, model_still_available: true });
    expect(plan.run_plan.execution).toMatchObject({ mode: "model", required_tool_ids: ["get-fare-rules", "search-flights"], denied_tool_ids: ["personal.passenger_identity", "personal.travel_profile", "prepare-booking", "simulate-purchase", "wallet.payment_method"], tool_binding_count: 2 });
    expect(plan.run_plan.model_binding?.host_model_id).toBe(QWEN);
    expect(plan.run_plan.model_binding?.compatibility).toMatchObject({ status: "compatible" });
    expect(plan.run_plan.authorization.provenance?.profile_id).toBe("search");
    expect(h.events).toContainEqual({ type: "event.authorization", sessionId: session.session.id });
    // The session summary says so.
    const again = (await h.controller.handle({ type: "package.get", sessionId: session.session.id }, PAGE)) as SessionView;
    expect(again.authorization).toEqual({ state: "issued", receipt_id: receipt.receipt_id, runnable: true });
    expect(again.run_plan).toEqual({ state: "prepared", run_plan_id: plan.run_plan.run_plan_id, ready: true });
  });

  it("the plan hash is stable across a worker restart: the stored plan comes back byte-identical and still ready", async () => {
    const first = makeHarness();
    const session = await openWebair(first);
    const result = (await first.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const second = makeHarness({ stores: { snapshots: first.snapshots, trustStorage: first.trustStorage, tabs: first.tabs, settingsArea: first.settingsArea } });
    const state = (await second.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(state.run_plan).toEqual(result.run_plan!.run_plan);
    expect(state.run_plan.run_plan_sha256).toBe(result.run_plan!.run_plan.run_plan_sha256);
    // No catalog has been probed in the new worker yet: model availability is unknown, not stale.
    expect(state.preflight).toMatchObject({ state: "ready", ready: true, stale: false, model_still_available: null });
    const view = (await second.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    expect(view.receipt?.receipt_sha256).toBe(result.receipt.receipt_sha256);
  });

  it("'Search and quote' needs the person's picks: without records it is refused by name, with them it binds the host-resource tools", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    // With the demo types but no record, every personal request is `empty`: the receipt is issued
    // (the permissions are optional) and the plan is refused because a granted host-resource tool
    // would have nothing to return (`resource_not_selected`), exactly as the reference refuses it.
    const empty = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "quote", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(empty.receipt.resource_grants).toEqual([]);
    expect(empty.run_plan).toBeNull();
    expect(empty.plan_refused?.map((reason) => [reason.code, reason.subject])).toEqual([
      ["resource_not_selected", "personal.passenger_identity"],
      ["resource_not_selected", "personal.travel_profile"],
    ]);
    await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE);
    const stillMissing = await refused(h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "quote", resourceSelections: {}, prepare: true }, PAGE));
    expect(stillMissing.code).toBe("resource_selection_required");
    const result = (await h.controller.handle(
      { type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "quote", resourceSelections: { "profile.travel": "profile_demo_traveler", "identity.passenger": "passenger_demo_alex" }, prepare: true },
      PAGE,
    )) as AuthorizeResult;
    expect(result.receipt.resource_grants.map((grant) => grant.resource_id)).toEqual(["passenger_demo_alex", "profile_demo_traveler"]);
    expect(result.receipt.provenance?.resource_selections).toEqual({ "identity.passenger": "user", "profile.travel": "user" });
    expect(result.run_plan?.preflight.ready).toBe(true);
    expect(result.run_plan?.run_plan.tool_bindings.map((binding) => binding.tool_id)).toEqual(["get-fare-rules", "personal.passenger_identity", "personal.travel_profile", "prepare-booking", "search-flights"]);
    expect(JSON.stringify(result.run_plan)).not.toContain("alex.traveler@example.com");
  });

  it("refuses an unknown profile, a stale digest, and a profile when the extension value is unusable", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    expect((await refused(h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "ghost", resourceSelections: {}, prepare: false }, PAGE))).code).toBe("profile_unknown");
    expect((await refused(h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair.digest, profileId: "search", resourceSelections: {}, prepare: false }, PAGE))).code).toBe("digest_mismatch");
    const literature = (await h.controller.handle({ type: "package.open", url: LITERATURE_URL, advertisedOn: null }, PAGE)) as SessionView;
    expect((await refused(h.controller.handle({ type: "authorization.useProfile", sessionId: literature.session.id, packageDigest: SHIPPED.literatureReview.digest, profileId: "search", resourceSelections: {}, prepare: false }, PAGE))).code).toBe("profile_unknown");
  });

  it("without a default model the authorization stands and the plan is refused with model_not_selected; an untrusted publisher blocks the plan, not the receipt", async () => {
    const h = makeHarness();
    const session = await openWebair(h, { defaultModel: null });
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(result.receipt.runnable).toBe(true);
    expect(result.run_plan).toBeNull();
    expect(result.plan_refused?.map((reason) => reason.code)).toEqual(["model_not_selected"]);

    const untrusted = makeHarness();
    const open = await openWebair(untrusted, { trust: false });
    const blocked = (await untrusted.controller.handle({ type: "authorization.useProfile", sessionId: open.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(blocked.receipt.runnable).toBe(false);
    expect(blocked.receipt.blocking_reasons.map((reason) => reason.code)).toEqual(["publisher_not_trusted"]);
    expect(blocked.plan_refused?.map((reason) => reason.code)).toEqual(["authorization_not_runnable", "publisher_not_trusted"]);
  });

  it("the privacy-first preset refuses a hosted default model with model_not_local", async () => {
    const h = makeHarness({ http: { ...OLLAMA_ANSWERS, "GET https://api.openai.com/v1/models": { data: [{ id: "gpt-5.6-luna" }] } } });
    const session = await openWebair(h, { defaultModel: "openai/gpt-5.6-luna", preset: "privacy-first" });
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "openai" ? { ...connection, enabled: true } : connection));
    await h.controller.handle({ type: "settings.set", settings }, PAGE);
    await h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-test-not-a-real-key" }, PAGE);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(result.receipt.decisions["network.webair"]).toBe("session");
    expect(result.plan_refused?.map((reason) => reason.code)).toEqual(["model_not_local"]);
    // The key never reaches the catalog or the view; only its presence does.
    const view = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    expect(view.keys).toEqual({ openai: true });
    expect(JSON.stringify(view)).not.toContain("sk-test");
    expect(h.httpLog.every((request) => !JSON.stringify(request).includes("sk-test"))).toBe(true);
  });
});

describe("the customize path: Literature Review 0.2.5 with today's OpenClaw decisions", () => {
  it("records the recorded decisions (examples/literature-review-grants.json), approves the three tools, and the plan carries them; paper-reader has no implementation here yet", async () => {
    const h = makeHarness();
    const session = (await h.controller.handle({ type: "package.open", url: LITERATURE_URL, advertisedOn: null }, PAGE)) as SessionView;
    await h.controller.handle({ type: "trust.pin", sessionId: session.session.id, signerFingerprint: SHIPPED.literatureReview.fingerprint, scope: "publisher" }, PAGE);
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    settings.models.default_model = QWEN;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, overrides: { "qwen3:30b": { context_tokens: 65536, max_output_tokens: 16384 } } } : connection));
    await h.controller.handle({ type: "settings.set", settings }, PAGE);
    const view = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    expect(view.profiles).toBeNull();
    expect(view.tools.map((tool) => [tool.tool_id, tool.status])).toEqual([
      ["citation-resolver", "bound"],
      ["scholarly-search", "bound"],
      ["paper-reader", "unbound"],
    ]);
    // Today's OpenClaw decisions: the recorded grants, every permission for the session (the recorded
    // runs in ~/.openclaw/agent-browser/runs grant files.pdfs in some runs and deny it in others).
    const decisions = JSON.parse(readFileSync(resolve(ROOT, "examples/literature-review-grants.json"), "utf8")) as Record<string, string>;
    expect(decisions).toEqual({ "network.scholarly": "session", "network.citations": "session", "files.pdfs": "session", "model.reasoning": "session", "memory.session": "session" });
    const toolApprovals = { "scholarly-search": true, "citation-resolver": true, "paper-reader": true };
    const result = (await h.controller.handle(
      { type: "authorization.authorize", sessionId: session.session.id, packageDigest: SHIPPED.literatureReview.digest, decisions, toolApprovals, resourceSelections: {}, provenance: null, prepare: true },
      PAGE,
    )) as AuthorizeResult;
    expect(result.receipt.decisions).toEqual(decisions);
    expect(result.receipt.tool_approvals).toEqual({ "citation-resolver": true, "paper-reader": true, "scholarly-search": true });
    expect(result.receipt.runnable).toBe(true);
    // An approved tool this host does not implement blocks the plan, as in the reference (D-022 covers denied tools only).
    expect(result.run_plan).toBeNull();
    expect(result.plan_refused?.map((reason) => [reason.code, reason.subject])).toEqual([["tool_not_bound", "paper-reader"]]);
    // Leaving paper-reader unapproved until T6 implements it: under D-022 it is denied, and the plan is ready and carries the three approval entries.
    const ready = (await h.controller.handle(
      { type: "authorization.authorize", sessionId: session.session.id, packageDigest: SHIPPED.literatureReview.digest, decisions, toolApprovals: { ...toolApprovals, "paper-reader": false }, resourceSelections: {}, provenance: null, prepare: true },
      PAGE,
    )) as AuthorizeResult;
    expect(ready.run_plan?.preflight.ready).toBe(true);
    expect(Object.keys(ready.run_plan!.run_plan.authorization.tool_approvals).sort()).toEqual(["citation-resolver", "paper-reader", "scholarly-search"]);
    expect(ready.run_plan?.run_plan.execution).toMatchObject({ required_tool_ids: ["citation-resolver", "scholarly-search"], denied_tool_ids: ["paper-reader"], required_permission_ids: ["model.reasoning"] });
    expect(ready.run_plan?.run_plan.tool_bindings.map((binding) => [binding.tool_id, binding.endpoint_origin])).toEqual([
      ["citation-resolver", "https://webagents-citation-resolver-production.up.railway.app"],
      ["scholarly-search", "https://api.crossref.org"],
    ]);
    // A new receipt superseded the first plan attempt's receipt.
    expect(ready.receipt.receipt_id).not.toBe(result.receipt.receipt_id);
  });

  it("refuses 'always', unknown permissions and a stale digest with the reference's codes, and never grants by silence", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    const base = { type: "authorization.authorize" as const, sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, toolApprovals: {}, resourceSelections: {}, provenance: null, prepare: false };
    expect((await refused(h.controller.handle({ ...base, decisions: { "network.webair": "always" } }, PAGE))).code).toBe("unsupported_decision");
    expect((await refused(h.controller.handle({ ...base, decisions: { ghost: "session" } }, PAGE))).code).toBe("unknown_permission");
    expect((await refused(h.controller.handle({ ...base, decisions: {}, packageDigest: "0".repeat(64) }, PAGE))).code).toBe("digest_mismatch");
    const silent = (await h.controller.handle({ ...base, decisions: {} }, PAGE)) as AuthorizeResult;
    expect(Object.values(silent.receipt.decisions).every((decision) => decision === "deny")).toBe(true);
    expect(silent.receipt.runnable).toBe(false);
  });
});

describe("staleness through the worker", () => {
  async function readyQuote(h: Harness): Promise<{ session: SessionView; result: AuthorizeResult }> {
    const session = await openWebair(h);
    await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE);
    const result = (await h.controller.handle(
      { type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "quote", resourceSelections: { "profile.travel": "profile_demo_traveler", "identity.passenger": "passenger_demo_alex" }, prepare: true },
      PAGE,
    )) as AuthorizeResult;
    expect(result.run_plan?.preflight.ready).toBe(true);
    return { session, result };
  }

  it("a changed vault record makes the plan stale (resource_changed), a deleted one resource_removed", async () => {
    const h = makeHarness();
    const { session } = await readyQuote(h);
    await h.controller.handle({ type: "vault.putRecord", record: { id: "profile_demo_traveler", type: "personal.travel_profile", label: "Demo Traveler — JFK", value: { home_airport: "JFK", preferred_cabin: "economy", prefer_nonstop: true, preferred_currency: "USD" }, demo: true } }, PAGE);
    let state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(state.preflight.stale_reasons.map((reason) => [reason.code, reason.subject])).toEqual([["resource_changed", "profile.travel"]]);
    expect(state.preflight.state).toBe("stale");
    await h.controller.handle({ type: "vault.deleteRecord", recordId: "passenger_demo_alex" }, PAGE);
    state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(state.preflight.stale_reasons.map((reason) => reason.code)).toEqual(["resource_removed", "resource_changed"]);
    // The plan itself did not move.
    expect(state.run_plan.run_plan_sha256).toBe(((await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView).run_plan?.run_plan.run_plan_sha256);
  });

  it("a removed model makes the plan stale (model_no_longer_available) once the catalog is read again", async () => {
    const answers = { ...OLLAMA_ANSWERS };
    const h = makeHarness({ http: answers });
    const { session } = await readyQuote(h);
    answers["GET http://127.0.0.1:11434/api/tags"] = { models: [] };
    // The cached catalog still lists the model until it is refreshed.
    let state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(state.preflight.model_still_available).toBe(true);
    await h.controller.handle({ type: "models.evaluate", sessionId: session.session.id, refresh: true }, PAGE);
    state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(state.preflight.stale_reasons.map((reason) => reason.code)).toEqual(["model_no_longer_available"]);
    expect(state.preflight.model_still_available).toBe(false);
  });

  it("withdrawing trust makes the plan stale; re-authorizing discards it; clearing removes it; a spent `once` receipt is stale", async () => {
    const h = makeHarness();
    const { session, result } = await readyQuote(h);
    await h.controller.handle({ type: "trust.unpin", fingerprint: SHIPPED.webair040.fingerprint }, PAGE);
    let state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(state.preflight.stale_reasons.map((reason) => reason.code)).toEqual(["publisher_trust_changed", "publisher_not_trusted"]);
    expect(state.preflight.trust_store_changed).toBe(true);
    await h.controller.handle({ type: "trust.pin", sessionId: session.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
    state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(state.preflight.stale_reasons.map((reason) => reason.code)).toEqual([]); // the same key pinned again: same trust state hash
    // A new authorization discards the plan.
    const again = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: false }, PAGE)) as AuthorizeResult;
    expect(again.receipt.receipt_id).not.toBe(result.receipt.receipt_id);
    expect((await refused(h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE))).code).toBe("run_plan_absent");
    expect((await refused(h.controller.handle({ type: "runplan.prepare", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, receiptId: result.receipt.receipt_id, modelId: QWEN }, PAGE))).code).toBe("receipt_mismatch");
    expect((await refused(h.controller.handle({ type: "runplan.prepare", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, receiptId: again.receipt.receipt_id, modelId: "ollama/ghost" }, PAGE))).code).toBe("model_unknown");
    const prepared = (await h.controller.handle({ type: "runplan.prepare", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, receiptId: again.receipt.receipt_id, modelId: QWEN }, PAGE)) as RunPlanState;
    expect(prepared.preflight.ready).toBe(true);
    expect(await h.controller.handle({ type: "runplan.clear", sessionId: session.session.id }, PAGE)).toEqual({ cleared: true, session_id: session.session.id });
    // `once` is spent by a run: the book profile grants the purchase once.
    const book = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "book", resourceSelections: demoPicks, prepare: true }, PAGE)) as AuthorizeResult;
    expect(book.receipt.decisions["booking.simulate_purchase"]).toBe("once");
    expect(book.run_plan?.preflight.ready).toBe(true);
    await h.controller.markOnceSpent(session.session.id);
    state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(state.preflight.stale_reasons.map((reason) => reason.code)).toEqual(["authorization_once_spent"]);
  });
});

describe("models, settings and the vault", () => {
  it("models.evaluate reports the catalog's verdicts, the preset's constraint and whether the run-mode permission is granted", async () => {
    const h = makeHarness();
    const session = await openWebair(h);
    const before = (await h.controller.handle({ type: "models.evaluate", sessionId: session.session.id, refresh: false }, PAGE)) as ModelsView;
    // Chrome's built-in model is enabled by default and listed as unavailable here (no Prompt API in this context).
    expect(before.evaluation.models.map((model) => [model.model_id, model.status, model.available])).toEqual([
      [QWEN, "compatible", true],
      ["chrome-builtin/gemini-nano", "unverified", false],
    ]);
    expect(before).toMatchObject({ default_model: QWEN, local_models_only: false, execution_mode_permission_ids: ["model.reasoning"], execution_mode_permissions_granted: false });
    expect(before.probes.map((probe) => [probe.provider, probe.ok])).toEqual([
      ["ollama", true],
      ["chrome-builtin", false],
    ]);
    await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: false }, PAGE);
    const after = (await h.controller.handle({ type: "models.evaluate", sessionId: session.session.id, refresh: false }, PAGE)) as ModelsView;
    expect(after.execution_mode_permissions_granted).toBe(true);
    expect(h.httpLog.filter((request) => request.url.endsWith("/api/tags"))).toHaveLength(1); // cached within its TTL
    const probe = await h.controller.handle({ type: "models.probe", provider: "ollama" }, PAGE);
    expect(probe).toMatchObject({ provider: "ollama", ok: true });
    expect(await h.controller.handle({ type: "models.probe", provider: "openai" }, PAGE)).toMatchObject({ ok: false, error: expect.stringContaining("No OpenAI API key") });
  });

  it("settings normalize strictly, keys are stored apart and reported by presence only, and nothing goes to storage.sync", async () => {
    const h = makeHarness();
    const saved = (await h.controller.handle({ type: "settings.set", settings: { preset: "convenience", models: { connections: [{ provider: "ollama", enabled: true, base_url: "http://evil.example:11434" }, { provider: "openai", enabled: true, base_url: "https://proxy.example/v1/" }], default_model: QWEN } } }, PAGE)) as SettingsView;
    expect(saved.settings.preset).toBe("convenience");
    expect(saved.settings.models.connections.find((connection) => connection.provider === "ollama")?.base_url).toBeNull(); // not loopback: dropped
    expect(saved.settings.models.connections.find((connection) => connection.provider === "openai")?.base_url).toBe("https://proxy.example/v1");
    expect(saved.keys).toEqual({});
    const defaulted = (await h.controller.handle({ type: "settings.set", settings: { preset: "yolo" } }, PAGE)) as SettingsView;
    expect(defaulted.settings.preset).toBe("balanced");
    await h.controller.handle({ type: "settings.setKey", provider: "anthropic", key: "  sk-ant-test  " }, PAGE);
    expect(((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).keys).toEqual({ anthropic: true });
    expect((await refused(h.controller.handle({ type: "settings.setKey", provider: "ollama", key: "x" }, PAGE))).code).toBe("invalid_request");
    expect((await refused(h.controller.handle({ type: "settings.setKey", provider: "openai", key: "two\nlines" }, PAGE))).code).toBe("invalid_request");
    await h.controller.handle({ type: "settings.setKey", provider: "anthropic", key: null }, PAGE);
    expect(((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).keys).toEqual({});
    expect([...h.settingsArea.data.keys()].sort()).toEqual(["providerKeys", "settings"]);
    expect(h.events).toContainEqual({ type: "event.settings" });
  });

  it("the vault starts with the demo types and no record, adds the fictional set only on request, validates records and persists without digests", async () => {
    const h = makeHarness();
    const empty = (await h.controller.handle({ type: "vault.get" }, PAGE)) as VaultView;
    expect(empty.types.map((type) => type.id)).toEqual(["personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"]);
    expect(empty.records).toEqual([]);
    expect(empty.demo_available).toBe(true);
    const withTypes = (await h.controller.handle({ type: "vault.installDemo", records: false }, PAGE)) as VaultView;
    expect(withTypes.records).toEqual([]);
    const demo = (await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE)) as VaultView;
    expect(demo.records).toHaveLength(6);
    expect(demo.records.every((record) => record.demo)).toBe(true);
    const own = (await h.controller.handle({ type: "vault.putRecord", record: { id: "my_profile", type: "personal.travel_profile", label: "Me — ZRH", value: { home_airport: "ZRH", preferred_cabin: "economy", prefer_nonstop: false, preferred_currency: "CHF" } } }, PAGE)) as VaultView;
    expect(own.records.find((record) => record.id === "my_profile")).toMatchObject({ demo: false, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect((await refused(h.controller.handle({ type: "vault.putRecord", record: { id: "bad", type: "personal.travel_profile", label: "Bad", value: { home_airport: "zurich" } } }, PAGE))).code).toBe("vault_invalid");
    expect((await refused(h.controller.handle({ type: "vault.deleteRecord", recordId: "ghost" }, PAGE))).code).toBe("vault_record_unknown");
    const stored = h.settingsArea.data.get("vault") as { records: Array<Record<string, unknown>> };
    expect(stored.records).toHaveLength(7);
    expect(stored.records.every((record) => !("digest" in record))).toBe(true);
    expect(typeof h.settingsArea.data.get("vaultKey")).toBe("string");
    expect(h.events).toContainEqual({ type: "event.vault" });
    // Another worker over the same storage sees the same digests (same key).
    const second = makeHarness({ stores: { snapshots: new MemorySnapshotStore(), trustStorage: new MemoryTrustStorage(), tabs: new MemoryTabStateStore(), settingsArea: h.settingsArea } });
    const again = (await second.controller.handle({ type: "vault.get" }, PAGE)) as VaultView;
    expect(again.records.map((record) => record.digest).sort()).toEqual(own.records.map((record) => record.digest).sort());
  });
});
