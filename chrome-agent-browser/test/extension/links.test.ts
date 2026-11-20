/**
 * Agent Links from the browser (T66; link.v0 §3, §5, §6, §7; D-701…D-705): the planner opened from
 * its origin, its two linked packages fetched from their locators as sessions of their own, the
 * review with one publisher per key, a denial of a key, the receipts the one Authorize issues, the
 * inner plans the caller's plan is hash-bound over, re-verification, the run through both links on
 * the execution host (each inner run on its own grants, tools and origins), the delegation tree
 * and the export; then the planner 0.2.0's slot: the look, the join card with the facts the core
 * computed, the person's answer (accepted, declined, lost on the way, never given), a pin made
 * from the card, and a policy that forbids joins.
 */
import { describe, expect, it } from "vitest";

import { verifyAuditChain } from "../../src/core/execution/report.js";
import type { JsonObject } from "../../src/core/json.js";
import type { DelegationTree } from "../../src/core/links/delegation.js";
import { POLICY_BUNDLE_TYPE } from "../../src/core/signed-document.js";
import type { AuthorizationView, AuthorizeResult, ExportBundle, LinksView, RunReadiness, RunView, SessionView, SettingsView, StatusInfo, TrustList } from "../../src/extension/messages.js";
import { MemoryRunStore } from "../../src/extension/storage/runs.js";
import { ARCHIVES, fixtureOf, grantsOf, linkRoutes, LOCATORS, PLANNER_URL, plannerVariant, read, recordedHotel, SALITUBAM, scriptedWorld, STAYMERE, TRIPWRIGHT, WEBAIR, type ScriptedWorld } from "../helpers/link-world.js";
import { makeHarness, PACKAGE_MEDIA_TYPE, PAGE, type Harness, type Route } from "../helpers/shell.js";
import { rawBase64 } from "../../src/core/keys.js";
import { generateKeyPair } from "../helpers/keys.js";
import { newSigner, signedBytes } from "../helpers/signing.js";

const QWEN = "ollama/qwen3:30b";

interface World {
  h: Harness;
  session: SessionView;
  scripted: ScriptedWorld;
  digest: string;
}

async function world(options: { planner?: "planner010" | "planner020"; routes?: Record<string, Route>; permissions?: readonly string[]; runs?: MemoryRunStore; pages?: Parameters<typeof scriptedWorld>[1]; extra?: ReadonlyArray<keyof typeof ARCHIVES>; findHotelTokens?: number; totalTokens?: number } = {}): Promise<World> {
  const planner = options.planner ?? "planner010";
  const scripted = await scriptedWorld([planner, "flights", "staymere", ...(options.extra ?? [])], options.pages ?? {});
  // The planner 0.2.0 with a larger `FindHotel` budget, signed with a throwaway key (`plannerVariant`), served at the planner's address.
  const variant = options.findHotelTokens === undefined ? null : (await plannerVariant(options.findHotelTokens)).bytes;
  const routes = { ...(variant === null ? {} : { [PLANNER_URL]: { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(variant.length) }, body: variant } }), ...(options.routes ?? {}) };
  const h = makeHarness({ routes: linkRoutes(planner, routes), transports: { model: scripted.model, tool: scripted.tool }, runs: options.runs, ...(options.permissions ? { permissions: options.permissions } : {}) });
  const view = (await h.controller.handle({ type: "package.open", url: PLANNER_URL, advertisedOn: null, viewId: "test" }, PAGE)) as SessionView;
  const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
  current.settings.models.default_model = QWEN;
  // Settings → Run limits: the person's own token limit, which a run may ask to raise once (link.v0 §7).
  if (options.totalTokens !== undefined) current.settings.limits = { ...(current.settings.limits ?? {}), total_tokens: options.totalTokens } as typeof current.settings.limits;
  await h.controller.handle({ type: "settings.set", settings: current.settings }, PAGE);
  return { h, session: view, scripted, digest: view.summary.package.digest as string };
}

const review = async (w: World): Promise<LinksView> => ((await w.h.controller.handle({ type: "authorization.get", sessionId: w.session.session.id }, PAGE)) as AuthorizationView).links!;
const resolveLinks = (w: World) => w.h.controller.handle({ type: "links.resolve", sessionId: w.session.session.id, packageDigest: w.digest }, PAGE) as Promise<LinksView>;

/** Pin the caller's publisher and every linked publisher: each from its own session, as if opened directly. */
async function pinAll(w: World, links: LinksView): Promise<void> {
  const caller = (await w.h.controller.handle({ type: "package.get", sessionId: w.session.session.id }, PAGE)) as SessionView;
  const publisher = caller.summary.publisher as { signer_fingerprint: string; trust_status: string };
  if (publisher.trust_status !== "trusted") await w.h.controller.handle({ type: "trust.pin", sessionId: w.session.session.id, signerFingerprint: publisher.signer_fingerprint, scope: "publisher" }, PAGE);
  for (const item of links.links) await w.h.controller.handle({ type: "trust.pin", sessionId: item.session_id, signerFingerprint: item.publisher.signer_fingerprint!, scope: "publisher" }, PAGE);
}

async function authorize(w: World, planner: "planner010" | "planner020" = "planner010"): Promise<AuthorizeResult> {
  const grants = grantsOf(planner === "planner010" ? "examples/link/travel-planner-grants.json" : "examples/link/travel-planner-0.2.0-grants.json");
  const tools: Record<string, boolean> = planner === "planner010" ? { "check-calendar": true } : { "check-calendar": true, "web.search": true };
  return (await w.h.controller.handle({ type: "authorization.authorize", sessionId: w.session.session.id, packageDigest: w.digest, decisions: grants, toolApprovals: tools, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
}

async function start(w: World, result: AuthorizeResult, input?: JsonObject): Promise<RunView> {
  const plan = result.run_plan!.run_plan;
  const fixture = fixtureOf(w.scripted.packages[0]!);
  return (await w.h.controller.handle({ type: "run.start", sessionId: w.session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: input ?? fixture.input }, PAGE)) as RunView;
}

const getRun = (w: World, runId: string) => w.h.controller.handle({ type: "run.get", runId }, PAGE) as Promise<RunView>;

async function waitFor(w: World, runId: string, predicate: (view: RunView) => boolean, label: string, timeoutMs = 15_000): Promise<RunView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await getRun(w, runId);
    if (view !== null && predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (status ${view?.status}, error ${view?.errorCode})`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function settled(w: World, runId: string): Promise<RunView> {
  await w.h.host.drain();
  return waitFor(w, runId, (view) => ["completed", "failed", "cancelled", "interrupted"].includes(view.status), "the run settled");
}

/** A prepared world: resolved, every publisher pinned, authorized, the plan ready. */
async function prepared(options: Parameters<typeof world>[0] & { deny?: string } = {}): Promise<{ w: World; links: LinksView; result: AuthorizeResult }> {
  const w = await world(options);
  const links = await resolveLinks(w);
  await pinAll(w, links);
  if (options.deny) await w.h.controller.handle({ type: "links.decide", sessionId: w.session.session.id, packageDigest: w.digest, dependency: options.deny, decision: "denied" }, PAGE);
  const result = await authorize(w, options.planner ?? "planner010");
  expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
  return { w, links, result };
}

describe("the review of a package's links (link.v0 §3, D-702)", () => {
  it("before anything is fetched: the declaration, where each dependency is published, and a plan refused link_unresolved", async () => {
    const w = await world();
    const links = await review(w);
    expect(links.resolved).toBe(false);
    expect(links.links).toEqual([]);
    expect(links.locators).toEqual([
      { dependency: "webair-flights", package_id: "org.webagents.webair-flights", version: "0.1.0", locator: LOCATORS["webair-flights"], origin: WEBAIR },
      { dependency: "hotel-aggregator", package_id: "org.webagents.staymere-hotels", version: "0.1.0", locator: LOCATORS["hotel-aggregator"], origin: STAYMERE },
    ]);
    expect(links.composed.resolved).toBe(false);
    // The summary says what a dependency is, in the reference's words (`browser/summary.py`).
    expect((w.session.summary.warnings as Array<{ code: string; severity: string; message: string }>).find((warning) => warning.code === "links_declared")).toEqual({ code: "links_declared", severity: "info", message: "This package asks 2 other package(s) for help (Agent Links). Each is fetched and verified first, is shown with its own publisher and requirements, and runs under what you grant it, never under this package's grants; you can deny one." });
    // Opening fetched the planner and nothing else: a dependency is fetched only when the person asks.
    expect(w.h.fetchLog.map((entry) => entry.url)).toEqual([PLANNER_URL]);
    const caller = (await w.h.controller.handle({ type: "package.get", sessionId: w.session.session.id }, PAGE)) as SessionView;
    await w.h.controller.handle({ type: "trust.pin", sessionId: w.session.session.id, signerFingerprint: (caller.summary.publisher as { signer_fingerprint: string }).signer_fingerprint, scope: "publisher" }, PAGE);
    const result = await authorize(w);
    expect(result.run_plan).toBeNull();
    expect(result.plan_refused?.map((reason) => reason.code)).toContain("link_unresolved");
  });

  it("resolves each dependency from its locator as a session of its own: no cookie, no referrer, no redirect; the caller is the one open package", async () => {
    const w = await world();
    const links = await resolveLinks(w);
    expect(links.resolved).toBe(true);
    expect(links.links.map((item) => [item.dependency, item.package.package_id, item.package.version, item.decision])).toEqual([
      ["hotel-aggregator", "org.webagents.staymere-hotels", "0.1.0", "undecided"],
      ["webair-flights", "org.webagents.webair-flights", "0.1.0", "undecided"],
    ]);
    const fetched = w.h.fetchLog.filter((entry) => entry.url !== PLANNER_URL);
    expect(fetched.map((entry) => entry.url)).toEqual([LOCATORS["webair-flights"], LOCATORS["hotel-aggregator"]]);
    for (const entry of fetched) expect(entry.init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", headers: { Accept: "application/octet-stream" } });
    // A linked package is its caller's: one session listed, one counted, three snapshots held.
    const sessions = (await w.h.controller.handle({ type: "sessions.list" }, PAGE)) as { sessions: Array<{ package_id: string }> };
    expect(sessions.sessions.map((item) => item.package_id)).toEqual(["org.webagents.travel-planner"]);
    expect(((await w.h.controller.handle({ type: "status.get" }, PAGE)) as StatusInfo).sessions).toBe(1);
    expect((await w.h.snapshots.listSnapshots()).length).toBe(3);
    // Each publisher as the person's own store sees it: three keys, none of them the caller's to vouch for.
    expect(links.publishers.map((group) => [group.claimed_name, group.trust_status, group.dependencies, group.denied])).toEqual(
      expect.arrayContaining([
        ["WebAir (fictional demo airline)", "unknown", ["webair-flights"], false],
        ["Staymere (fictional hotel aggregator)", "unknown", ["hotel-aggregator"], false],
      ]),
    );
    const flights = links.links.find((item) => item.dependency === "webair-flights")!;
    expect(flights.publisher).toMatchObject({ signature_status: "valid", trust_status: "unknown" });
    expect(flights.tools).toEqual([{ id: "search-flights", execution: "remote", endpoint: `${WEBAIR}/api/v1/travel/flights`, method: "POST", domains: expect.any(Array), permissions: ["network.webair"], side_effects: expect.any(String), status: expect.any(String) }]);
    expect(flights.permissions.map((permission) => permission.id)).toEqual(["model.reasoning", "memory.session", "network.webair"]);
    expect(flights.decided.decisions).toEqual({ "model.reasoning": "session", "memory.session": "session", "network.webair": "session" });
    expect(flights.decided.tool_approvals).toEqual({ "search-flights": true });
    expect(flights.records).toEqual([]);
    expect(flights.worst_case).toMatchObject({ model_calls: 1, tool_calls: { "search-flights": 1 }, remote_calls: 3, tokens: 6000 });
    expect(flights.steps).toEqual([{ step: expect.stringContaining("Flights"), where: "role" }]);
    expect(flights.problems.map((reason) => reason.code)).toEqual(["publisher_not_trusted"]);
    // The composed "at most" names each package's tools (L-22, §11).
    expect(links.composed.worst_case).toMatchObject({ model_calls: 10, tool_calls: { "check-calendar": 1, "hotel-aggregator:search-hotels": 1, "webair-flights:search-flights": 1 }, remote_calls: 23, tokens: 92000 });
    expect(links.run_cards).toEqual({ max_join_cards: 2, join: "allow", raise: "allow", policy: null });
  });

  it("asks Chrome for the locators' origins first: nothing is fetched from an origin that is not granted", async () => {
    const w = await world({ permissions: [`${TRIPWRIGHT}/*`, `${WEBAIR}/*`] });
    await expect(resolveLinks(w)).rejects.toMatchObject({ code: "origin_not_granted", details: { origins: [STAYMERE] } });
    expect(w.h.fetchLog.map((entry) => entry.url)).toEqual([PLANNER_URL]);
    expect((await review(w)).resolved).toBe(false);
  });

  it("refuses bytes that are not the pinned package and leaves no session or snapshot behind (L-11)", async () => {
    const other = read(ARCHIVES.salitubam);
    const w = await world({ routes: { [LOCATORS["hotel-aggregator"]]: { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(other.length) }, body: other } } });
    await expect(resolveLinks(w)).rejects.toMatchObject({ code: "link_identity_mismatch", details: { dependency: "hotel-aggregator" } });
    expect((await review(w)).resolved).toBe(false);
    expect((await w.h.snapshots.listSnapshots()).length).toBe(1);
    expect((await w.h.snapshots.listSessions()).length).toBe(1);
    // A redirect at a locator is a failed fetch, never followed (D-033).
    const redirected = await world({ routes: { [LOCATORS["webair-flights"]]: { redirectTo: LOCATORS["hotel-aggregator"] } } });
    await expect(resolveLinks(redirected)).rejects.toMatchObject({ code: "link_fetch_failed", details: { dependency: "webair-flights", cause: "download_redirect_denied" } });
  });
});

describe("one Authorize, one receipt per linked package, inner plans (L-13…L-15)", () => {
  it("a linked publisher the person does not trust blocks the plan by name until it is pinned or denied", async () => {
    const w = await world();
    const links = await resolveLinks(w);
    const caller = (await w.h.controller.handle({ type: "package.get", sessionId: w.session.session.id }, PAGE)) as SessionView;
    await w.h.controller.handle({ type: "trust.pin", sessionId: w.session.session.id, signerFingerprint: (caller.summary.publisher as { signer_fingerprint: string }).signer_fingerprint, scope: "publisher" }, PAGE);
    const refused = await authorize(w);
    expect(refused.run_plan).toBeNull();
    expect(refused.plan_refused?.filter((reason) => reason.code === "link_undecided").map((reason) => reason.subject)).toEqual(["hotel-aggregator", "webair-flights"]);
    // Pinning the caller's key never extended to a linked publisher (L-12).
    expect((await review(w)).links.every((item) => item.publisher.trust_status === "unknown")).toBe(true);
    await pinAll(w, links);
    const ready = await authorize(w);
    expect(ready.run_plan?.preflight.ready, JSON.stringify(ready.plan_refused)).toBe(true);
  });

  it("the caller's plan records each link with the person's decision and its inner plan's hash, and states the composed envelope", async () => {
    const { w, result } = await prepared();
    const plan = result.run_plan!.run_plan;
    const after = await review(w);
    expect(after.links.map((item) => [item.dependency, item.decision, item.authorization.state, item.run_plan.state])).toEqual([
      ["hotel-aggregator", "accepted", "issued", "prepared"],
      ["webair-flights", "accepted", "issued", "prepared"],
    ]);
    expect(Object.keys(plan.links!)).toEqual(["hotel-aggregator", "webair-flights"]);
    for (const item of after.links) {
      expect(plan.links![item.dependency]).toEqual({ package_id: item.package.package_id, version: item.package.version, digest: item.package.digest, archive_sha256: item.package.archive_sha256, signer: item.publisher.signer_fingerprint, trust: "trusted", decision: "accepted", plan_hash: item.run_plan.run_plan_sha256 });
    }
    expect(plan.execution.network?.worst_case).toMatchObject({ tokens: 92000, remote_calls: 23, model_calls: 10 });
    expect((plan.execution as unknown as { links: { worst_case: JsonObject } }).links.worst_case).toMatchObject({ tokens: 92000, remote_calls: 23 });
    // The run reaches the caller's origins and each accepted link's, named by dependency.
    expect(result.run_plan!.origins.map((item) => item.origin)).toEqual([STAYMERE, TRIPWRIGHT, WEBAIR].sort());
    expect(result.run_plan!.origins.find((item) => item.origin === STAYMERE)!.subjects).toEqual(["hotel-aggregator:package", "hotel-aggregator:search-hotels"]);
    // An inner plan is prepared with its caller's, never alone (L-15).
    const child = after.links[0]!;
    await expect(w.h.controller.handle({ type: "runplan.prepare", sessionId: child.session_id, packageDigest: child.package.digest, receiptId: child.authorization.receipt_id!, modelId: QWEN }, PAGE)).rejects.toMatchObject({ code: "link_plan_parent_mismatch" });
  });

  it("Authorize grants each linked package what the review listed, or refuses link_decisions_changed (review 1, nit 10)", async () => {
    const w = await world();
    await pinAll(w, await resolveLinks(w));
    const decide = (decision: "denied" | "undecided") => w.h.controller.handle({ type: "links.decide", sessionId: w.session.session.id, packageDigest: w.digest, dependency: "hotel-aggregator", decision }, PAGE);
    await decide("denied");
    // The view this page shows: Staymere denied, so not listed for Authorize.
    const listed = await review(w);
    const echoed = Object.fromEntries(listed.links.filter((item) => item.decision !== "denied").map((item) => [item.dependency, item.decided_sha256]));
    expect(Object.keys(echoed)).toEqual(["webair-flights"]);
    const grants = grantsOf("examples/link/travel-planner-grants.json");
    const click = (linkDecisions: Record<string, string>) => w.h.controller.handle({ type: "authorization.authorize", sessionId: w.session.session.id, packageDigest: w.digest, decisions: grants, toolApprovals: { "check-calendar": true }, resourceSelections: {}, provenance: null, prepare: false, linkDecisions }, PAGE) as Promise<AuthorizeResult>;
    // Another tab withdraws the denial after this view: Authorize would grant Staymere unseen, so nothing is issued.
    await decide("undecided");
    await expect(click(echoed)).rejects.toMatchObject({ code: "link_decisions_changed", details: { dependencies: ["hotel-aggregator"] } });
    expect((await review(w)).links.every((item) => item.authorization.state === "pending")).toBe(true);
    // A hash that is not what would be granted now is refused the same way.
    await expect(click({ ...echoed, "hotel-aggregator": "0".repeat(64) })).rejects.toMatchObject({ code: "link_decisions_changed" });
    // The review shown again: its hashes are what is granted.
    const again = await review(w);
    const result = await click(Object.fromEntries(again.links.map((item) => [item.dependency, item.decided_sha256])));
    expect(result.receipt.receipt_id).toBeTruthy();
    expect((await review(w)).links.every((item) => item.authorization.state === "issued")).toBe(true);
  });

  it("the service worker never readies or starts a linked package's session alone: link_lease_without_caller, nothing started (review 1, finding 5)", async () => {
    const { w } = await prepared();
    for (const child of (await review(w)).links) {
      expect(child.run_plan.state).toBe("prepared");
      const readiness = (await w.h.controller.handle({ type: "run.readiness", sessionId: child.session_id }, PAGE)) as RunReadiness;
      expect(readiness).toMatchObject({ ready: false, blocker: { code: "link_lease_without_caller", subject: child.dependency } });
      // The inner plan's own hash, as a page that held it would send it.
      await expect(w.h.controller.handle({ type: "run.start", sessionId: child.session_id, runPlanId: "any", runPlanSha256: child.run_plan.run_plan_sha256!, input: {} }, PAGE)).rejects.toMatchObject({ code: "link_lease_without_caller" });
    }
    expect(w.h.host.started).toEqual([]);
    expect(await w.h.runs.listRuns()).toEqual([]);
  });

  it("a denial is of the publisher's key: the plan states it, the envelope leaves it out, and withdrawing it asks for a new plan", async () => {
    const { w, result } = await prepared({ deny: "hotel-aggregator" });
    const plan = result.run_plan!.run_plan;
    expect(plan.links!["hotel-aggregator"]).toMatchObject({ decision: "denied", plan_hash: null });
    expect(plan.links!["webair-flights"]).toMatchObject({ decision: "accepted" });
    expect(plan.execution.network?.worst_case).toMatchObject({ tool_calls: { "check-calendar": 1, "webair-flights:search-flights": 1 } });
    expect(result.run_plan!.origins.map((item) => item.origin)).toEqual([TRIPWRIGHT, WEBAIR].sort());
    const denied = await review(w);
    expect(denied.links.find((item) => item.dependency === "hotel-aggregator")).toMatchObject({ decision: "denied", authorization: { state: "pending" }, run_plan: { state: "absent" } });
    expect(denied.publishers.find((group) => group.dependencies.includes("hotel-aggregator"))!.denied).toBe(true);
    const withdrawn = (await w.h.controller.handle({ type: "links.decide", sessionId: w.session.session.id, packageDigest: w.digest, dependency: "hotel-aggregator", decision: "undecided" }, PAGE)) as LinksView;
    expect(withdrawn.links.find((item) => item.dependency === "hotel-aggregator")!.decision).toBe("undecided");
    // A decision on a link changes what the caller's plan may say: the plan is gone.
    expect(((await w.h.controller.handle({ type: "authorization.get", sessionId: w.session.session.id }, PAGE)) as AuthorizationView).run_plan).toBeNull();
    await expect(w.h.controller.handle({ type: "links.decide", sessionId: w.session.session.id, packageDigest: w.digest, dependency: "nobody", decision: "denied" }, PAGE)).rejects.toMatchObject({ code: "link_dependency_unknown" });
  });

  it("re-verification covers the inner plans: a linked publisher unpinned after the plan makes the caller's plan stale by name", async () => {
    const { w, links } = await prepared();
    const flights = links.links.find((item) => item.dependency === "webair-flights")!;
    await w.h.controller.handle({ type: "trust.unpin", fingerprint: flights.publisher.signer_fingerprint! }, PAGE);
    const readiness = (await w.h.controller.handle({ type: "run.readiness", sessionId: w.session.session.id }, PAGE)) as RunReadiness;
    expect(readiness.ready).toBe(false);
    expect(readiness.blocker).toMatchObject({ code: "run_plan_stale", subject: "webair-flights" });
    expect(readiness.preflight!.stale_reasons.map((reason) => reason.code)).toEqual(["link_plan_stale"]);
  });

  it("a linked package's session ends with its caller's, and comes back with it after a restart", async () => {
    const { w, result } = await prepared();
    const restarted = makeHarness({ routes: linkRoutes(), stores: { snapshots: w.h.snapshots, trustStorage: w.h.trustStorage, tabs: w.h.tabs, settingsArea: w.h.settingsArea, holders: w.h.holders } });
    const again = (await restarted.controller.handle({ type: "authorization.get", sessionId: w.session.session.id }, PAGE)) as AuthorizationView;
    expect(again.links!.resolved).toBe(true);
    expect(again.run_plan?.run_plan.run_plan_sha256).toBe(result.run_plan!.run_plan.run_plan_sha256);
    expect(again.run_plan?.preflight.stale).toBe(false);
    await restarted.controller.handle({ type: "package.close", sessionId: w.session.session.id }, PAGE);
    expect(await restarted.snapshots.listSessions()).toEqual([]);
    expect(await restarted.snapshots.listSnapshots()).toEqual([]);
  });
});

describe("a run through both links on the execution host (link.v0 §5, D-704, D-705)", () => {
  it("completes the walk: each inner run on its own plan and origin, the delegation tree from the audit, the export with the inner plans and records", async () => {
    const { w, result } = await prepared();
    const started = await start(w, result);
    const run = await settled(w, started.runId);
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    expect(w.scripted.modelSeen.every((request) => request.matched)).toBe(true);
    // The linked tools were called at their own origins, the planner's calendar at its own.
    expect(w.scripted.toolSeen.map((request) => request.url).sort()).toEqual([`${STAYMERE}/api/v1/travel/hotels`, `${WEBAIR}/api/v1/travel/calendar`, `${WEBAIR}/api/v1/travel/flights`].sort());
    expect(w.h.host.started[0]!.allowedOrigins).toEqual([STAYMERE, TRIPWRIGHT, WEBAIR].sort());
    expect(run.links).toEqual([
      { dependency: "hotel-aggregator", package_id: "org.webagents.staymere-hotels", name: "Staymere", version: "0.1.0", signer: expect.stringMatching(/^sha256:/u), trust: "trusted", decision: "accepted" },
      { dependency: "webair-flights", package_id: "org.webagents.webair-flights", name: "WebAir Flights", version: "0.1.0", signer: expect.stringMatching(/^sha256:/u), trust: "trusted", decision: "accepted" },
    ]);
    const stored = (await w.h.runs.getRun(started.runId))!;
    expect((await verifyAuditChain(stored.audit as unknown as JsonObject[])).valid).toBe(true);
    const actions = stored.audit.map((event) => String(event.action));
    expect(actions.filter((action) => action.startsWith("link."))).toEqual(["link.started", "link.completed", "link.started", "link.completed"]);
    // The delegation view: who was asked, who answered, each link's reservation and settlement, hashes for what crossed.
    const tree = run.delegation as DelegationTree;
    expect(tree.linked).toBe(true);
    const asked = tree.activations.flatMap((activation) => activation.links.map((link) => [activation.role, link.kind, link.name, link.state, link.package_id]));
    expect(asked).toEqual([
      ["Flights", "link", "webair-flights", "answered", "org.webagents.webair-flights"],
      ["Hotels", "link", "hotel-aggregator", "answered", "org.webagents.staymere-hotels"],
    ]);
    for (const link of tree.activations.flatMap((activation) => activation.links)) {
      expect(link.reserved).toEqual({ tokens: 6000, remote_calls: 3 });
      expect(link.usage).toMatchObject({ model_calls: 1, remote_calls: 1 });
      expect(link.input_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(link.result_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(link)).not.toContain("Reykjavik");
    }
    // The export: the caller's files, the links record, each inner run's files, each inner Run Plan.
    const bundle = (await w.h.controller.handle({ type: "run.export", runId: started.runId }, PAGE)) as ExportBundle;
    const names = bundle.entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["run.json", "run-plan.json", "audit.json", "links.json", "link-plan-hotel-aggregator.json", "link-plan-webair-flights.json"]));
    const decode = (name: string) => JSON.parse(Buffer.from(bundle.entries.find((entry) => entry.name === name)!.base64, "base64").toString("utf8")) as JsonObject;
    const record = decode("links.json");
    const runs = record.runs as Array<{ inner_run_id: string; dependency: string; status: string }>;
    expect(runs.map((item) => [item.dependency, item.status]).sort()).toEqual([["hotel-aggregator", "completed"], ["webair-flights", "completed"]]);
    for (const inner of runs) expect(names).toEqual(expect.arrayContaining([`link-${inner.inner_run_id}.audit.json`, `link-${inner.inner_run_id}.result.json`]));
    const innerPlan = decode("link-plan-webair-flights.json");
    expect(innerPlan.parent).toEqual({ package_digest: w.digest, dependency: "webair-flights" });
    expect(innerPlan.run_plan_sha256).toBe(result.run_plan!.run_plan.links!["webair-flights"]!.plan_hash);
    expect((record.links as JsonObject[]).find((link) => link.dependency === "webair-flights")!.plan_hash).toBe(innerPlan.run_plan_sha256);
    // The snapshots a settled run read stay while the session is open, and go with it.
    await w.h.controller.handle({ type: "package.close", sessionId: w.session.session.id }, PAGE);
    expect(await w.h.snapshots.listSnapshots()).toEqual([]);
  });

  it("with one publisher denied the run starts no inner run of it and never reaches its origin (L-16)", async () => {
    // The planner's fixture records the full tour, whose route requests offer Hotels. With Hotels out of
    // every enum the requests change, so the scripted model improvises the routes the recording does
    // not hold (each role still offered, once); every other request is still matched exactly.
    const { w, result } = await prepared({ deny: "hotel-aggregator", pages: { improvise: true } });
    const started = await start(w, result);
    const run = await settled(w, started.runId);
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    expect(w.scripted.modelSeen.filter((request) => !request.matched).every((request) => request.improvised && ["route", "understand"].includes(request.task))).toBe(true);
    // No route offered the denied publisher's role, so the model could not choose it.
    for (const request of w.scripted.modelSeen.filter((item) => item.task === "route")) {
      const data = JSON.parse((JSON.parse(request.body!) as { messages: Array<{ role: string; content: string }> }).messages.find((message) => message.role === "user")!.content) as { targets: Array<{ role: string }> };
      expect(data.targets.map((target) => target.role)).toEqual(["Flights", "Calendar"]);
    }
    expect(w.scripted.toolSeen.some((request) => request.url.startsWith(STAYMERE))).toBe(false);
    const tree = run.delegation as DelegationTree;
    expect(tree.activations.flatMap((activation) => activation.links.map((link) => [activation.role, link.name, link.state]))).toEqual([["Flights", "webair-flights", "answered"]]);
    expect(tree.activations.map((activation) => activation.role)).not.toContain("Hotels");
    expect(w.h.host.started[0]!.allowedOrigins).toEqual([TRIPWRIGHT, WEBAIR].sort());
    const stored = (await w.h.runs.getRun(started.runId))!;
    const startedLinks = stored.audit.filter((event) => event.action === "link.started").map((event) => (event as unknown as { dependency: string }).dependency);
    expect(startedLinks).toEqual(["webair-flights"]);
    expect(run.links!.map((link) => [link.dependency, link.decision])).toEqual([["hotel-aggregator", "denied"], ["webair-flights", "accepted"]]);
    expect(Object.keys(stored.invocation.links ?? {})).toEqual(["webair-flights"]);
  });
});

describe("the budget-raise card through the execution host (link.v0 §7, D-703; review 1, nit 13)", () => {
  // At an 8,000-token run limit the planner's FrontMan route call would fail on that limit alone.
  const raiseCard = async (w: World, runId: string) => {
    const view = await waitFor(w, runId, (item) => (item.runCard ?? null) !== null || ["completed", "failed"].includes(item.status), "the raise card");
    expect(view.runCard, `${view.status}: ${view.errorCode}`).toMatchObject({ kind: "budget.raise", node_id: "plan-trip/FrontMan/route", facts: { limit: "tokens", from: 8000, to: 8154 } });
    return view.runCard!;
  };

  it("accepted from the run page's answer: the limit raised once, recorded, drawn raised", async () => {
    const { w, result } = await prepared({ totalTokens: 8000 });
    const started = await start(w, result);
    const pending = await raiseCard(w, started.runId);
    // A raise carries no grants or tools.
    await expect(w.h.controller.handle({ type: "run.decide", runId: started.runId, cardId: pending.card_id, accepted: true, approvedTools: ["search-flights"] }, PAGE)).rejects.toMatchObject({ code: "invalid_request" });
    await w.h.controller.handle({ type: "run.decide", runId: started.runId, cardId: pending.card_id, accepted: true }, PAGE);
    const run = await settled(w, started.runId);
    const audit = (await w.h.runs.getRun(started.runId))!.audit as unknown as JsonObject[];
    expect(audit.filter((event) => String(event.action).startsWith("budget.r")).map((event) => [event.action, event.from, event.to])).toEqual([
      ["budget.requested", 8000, 8154],
      ["budget.raised", 8000, 8154],
    ]);
    expect(audit.find((event) => event.action === "budget.raised")).toMatchObject({ decided_by: "person", provenance: "person" });
    expect((run.delegation as DelegationTree).raise).toMatchObject({ state: "raised", from: 8000, to: 8154 });
    expect((await w.h.runs.getRun(started.runId))!.run_card_taken).toEqual([pending.card_id]);
  });

  it("declined: the limit kept, the refusal it would have avoided stands, drawn kept", async () => {
    const { w, result } = await prepared({ totalTokens: 8000 });
    const started = await start(w, result);
    const pending = await raiseCard(w, started.runId);
    await w.h.controller.handle({ type: "run.decide", runId: started.runId, cardId: pending.card_id, accepted: false }, PAGE);
    const run = await settled(w, started.runId);
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("budget_exhausted");
    const audit = (await w.h.runs.getRun(started.runId))!.audit as unknown as JsonObject[];
    expect(audit.some((event) => event.action === "budget.raised")).toBe(false);
    expect((run.delegation as DelegationTree).raise).toMatchObject({ state: "kept" });
  });
});

describe("a link made during a run: the join card (link.v0 §6, D-703)", () => {
  const HOTEL_PAGE = `${SALITUBAM}/`;
  const HOTEL_PACKAGE = `${SALITUBAM}/agent.pkg`;
  const HOTEL_GRANTS = grantsOf("examples/link/hotel-salitubam-grants.json");

  async function joining(options: Parameters<typeof world>[0] = {}): Promise<{ w: World; result: AuthorizeResult; runId: string }> {
    const { w, result } = await prepared({ planner: "planner020", extra: ["salitubam"], pages: recordedHotel(), ...options });
    const started = await start(w, result);
    return { w, result, runId: started.runId };
  }
  const card = (w: World, runId: string) => waitFor(w, runId, (view) => (view.runCard ?? null) !== null || ["completed", "failed", "cancelled", "interrupted"].includes(view.status), "the join card");
  const decide = (w: World, runId: string, cardId: string, accepted: boolean, extra: { grants?: Record<string, string>; approvedTools?: string[]; pin?: "package" | "publisher" } = {}) => w.h.controller.handle({ type: "run.decide", runId, cardId, accepted, ...extra }, PAGE) as Promise<RunView>;
  const auditOf = async (w: World, runId: string) => ((await w.h.runs.getRun(runId))!.audit as unknown as JsonObject[]);

  it("the plan states the slot at its ceiling before the run: 14 model calls, 33 remote calls, 122,000 tokens", async () => {
    const { w, result } = await prepared({ planner: "planner020", extra: ["salitubam"], pages: recordedHotel() });
    expect(result.run_plan!.run_plan.execution.network?.worst_case).toMatchObject({ model_calls: 14, remote_calls: 33, tokens: 122000 });
    expect(result.run_plan!.run_plan.execution.network?.worst_case.tool_calls).toMatchObject({ "named-hotel:*": 1 });
    const links = await review(w);
    expect((links.composed.slots as JsonObject[]).map((slot) => [slot.slot, slot.max_joins, slot.view])).toEqual([["named-hotel", 1, expect.any(Array)]]);
  });

  it("the signed planner 0.2.0 reaches the card and the accepted decision; its request-building call is then refused by FindHotel's own 4,000-token budget under this host's UTF-8 input bound (D-115)", async () => {
    const { w, runId } = await joining();
    const waiting = await card(w, runId);
    expect(waiting.runCard).toMatchObject({ kind: "link.join", card_id: "card_1" });
    await decide(w, runId, waiting.runCard!.card_id, true, { grants: HOTEL_GRANTS, approvedTools: ["check-availability"] });
    const run = await settled(w, runId);
    const events = await auditOf(w, runId);
    expect(events.find((event) => event.action === "link.decided")).toMatchObject({ accepted: true, decided_by: "person" });
    // The package's own cap, never the person's to raise (L-41): no raise is asked, and the step fails as a model call's reservation does.
    expect(events.find((event) => event.action === "model.refused")).toMatchObject({ task: "request", reason: "worker_token_budget", input_bound: 2886, max_output_tokens: 1500, reserved_tokens: 4386, limit: 4000 });
    expect(events.some((event) => event.action === "budget.requested")).toBe(false);
    expect([run.status, run.errorCode]).toEqual(["failed", "budget_exhausted"]);
    // Nothing was sent to the hotel beyond the look and the download.
    expect(w.scripted.toolSeen.filter((request) => request.url.startsWith(SALITUBAM)).map((request) => request.method)).toEqual(["GET", "GET"]);
  });

  it("shows the card with the facts the core computed, before anything of the candidate reaches the model; accepted, the joined package runs on the card's grants at its own origin; a pin is made from the card", async () => {
    const { w, result, runId } = await joining({ findHotelTokens: 6000 });
    const waiting = await card(w, runId);
    expect(waiting.status, `${waiting.errorCode}: ${waiting.errorDetail}`).toBe("running");
    const pending = waiting.runCard!;
    expect(pending).toMatchObject({ kind: "link.join", card_id: "card_1" });
    const facts = pending.facts as JsonObject & { publisher: JsonObject; package: JsonObject; source: JsonObject; requirements: { tools: JsonObject[]; permissions: JsonObject[] }; worst_case: JsonObject; ceiling: JsonObject; left: JsonObject; cards: JsonObject };
    expect(facts.slot).toBe("named-hotel");
    expect(facts.publisher).toEqual({ signer: expect.stringMatching(/^sha256:/u), trust: "unknown" });
    expect(facts.package).toMatchObject({ package_id: "org.webagents.hotel-salitubam", version: "0.1.0", name: expect.any(String), description: expect.any(String) });
    expect(facts.source).toEqual({ page_url: HOTEL_PAGE, package_url: HOTEL_PACKAGE });
    expect(facts.requirements.tools.map((tool) => [tool.id, tool.endpoint])).toEqual([["check-availability", `${SALITUBAM}/api/v1/hotel/availability`]]);
    expect(facts.requirements.permissions.map((permission) => permission.id)).toEqual(["model.reasoning", "memory.session", "network.salitubam"]);
    expect(facts.worst_case).toMatchObject({ model_calls: 1, tool_calls: { "check-availability": 1 }, remote_calls: 3, tokens: 6000 });
    expect(facts.ceiling).toMatchObject({ model_calls: 1, tool_calls: 1, remote_calls: 3, tokens: 6000 });
    expect(facts.at_most_unchanged).toBe(true);
    expect(facts.cards).toEqual({ slot: { shown: 1, max: 1 }, run: { shown: 1, max: 2 } });
    // What a pin from the card would record is the candidate's own verified key.
    expect(pending.publisher).toMatchObject({ claimed_id: "hotel-salitubam", package_id: "org.webagents.hotel-salitubam", public_key: expect.any(String) });
    // Before the decision: the page and the package were read with a plain GET and nothing else was
    // sent to the hotel; no model request holds the candidate's own words or its input schema.
    const before = w.scripted.toolSeen.filter((request) => request.url.startsWith(SALITUBAM));
    expect(before.map((request) => [request.method, request.url, request.body])).toEqual([["GET", HOTEL_PAGE, null], ["GET", HOTEL_PACKAGE, null]]);
    for (const request of before) expect(Object.keys(request.headers).map((name) => name.toLowerCase())).toEqual(["accept"]);
    expect(w.scripted.modelSeen.map((request) => request.task)).not.toContain("request");
    for (const request of w.scripted.modelSeen) expect(request.body).not.toContain(String(facts.package.description));
    const events = await auditOf(w, runId);
    expect(events.filter((event) => String(event.action).startsWith("link.")).map((event) => event.action)).toEqual(["link.started", "link.completed", "link.started", "link.completed", "link.requested"]);
    // An answer that names what the card does not list is refused, and the card still waits.
    await expect(decide(w, runId, "card_9", true)).rejects.toMatchObject({ code: "card_unknown" });
    await expect(decide(w, runId, pending.card_id, true, { grants: { "payments.charge": "session" } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(decide(w, runId, pending.card_id, true, { approvedTools: ["book-room"] })).rejects.toMatchObject({ code: "invalid_request" });
    const answered = await decide(w, runId, pending.card_id, true, { grants: HOTEL_GRANTS, approvedTools: ["check-availability"], pin: "publisher" });
    // The pin is made once the run took the answer (review 1, nit 8).
    expect(answered.cardPin).toEqual({ card_id: pending.card_id, made: true, reason: null });
    expect((await w.h.runs.getRun(runId))!.run_card_taken).toEqual([pending.card_id]);
    const run = await settled(w, runId);
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    expect(run.runCard ?? null).toBeNull();
    expect(w.scripted.modelSeen.every((request) => request.matched)).toBe(true);
    // After the decision: the request-building call (the slot's view and the joined package's name, description and input schema), then the hotel's own service.
    const tasks = w.scripted.modelSeen.map((request) => request.task);
    expect(tasks.filter((task) => task === "request")).toHaveLength(1);
    const requestCall = JSON.parse((JSON.parse(w.scripted.modelSeen.find((request) => request.task === "request")!.body!) as { messages: Array<{ role: string; content: string }> }).messages.find((message) => message.role === "user")!.content) as JsonObject;
    expect(Object.keys(requestCall).sort()).toEqual(["package", "view"]);
    expect(Object.keys(requestCall.package as JsonObject).sort()).toEqual(["description", "input_schema", "name"]);
    expect(w.scripted.toolSeen.filter((request) => request.url.startsWith(SALITUBAM)).map((request) => [request.method, request.url])).toEqual([["GET", HOTEL_PAGE], ["GET", HOTEL_PACKAGE], ["POST", `${SALITUBAM}/api/v1/hotel/availability`]]);
    const after = await auditOf(w, runId);
    const slot = after.filter((event) => event.slot === "named-hotel" || (event.action === "model.called" && String(event.node_id).includes("FindHotel"))).map((event) => event.action);
    expect(slot.filter((action) => String(action).startsWith("link."))).toEqual(["link.requested", "link.decided", "link.started", "link.completed"]);
    const decided = after.find((event) => event.action === "link.decided")!;
    expect(decided).toMatchObject({ accepted: true, decided_by: "person", provenance: "person", reason: null });
    // The delegation view holds the join with its look and its decision; the texts that crossed are hashes.
    const tree = run.delegation as DelegationTree;
    const join = tree.activations.flatMap((activation) => activation.links).find((link) => link.kind === "join")!;
    expect(join).toMatchObject({ name: "named-hotel", state: "answered", package_id: "org.webagents.hotel-salitubam", decision: { accepted: true, decided_by: "person" } });
    expect(join.fetches).toEqual([{ url: HOTEL_PAGE, kind: "discovery", status: "ok" }, { url: HOTEL_PACKAGE, kind: "package", status: "ok" }]);
    // The record: the join's inner plan names the caller's plan, this run and the slot (L-36).
    const bundle = (await w.h.controller.handle({ type: "run.export", runId }, PAGE)) as ExportBundle;
    const record = JSON.parse(Buffer.from(bundle.entries.find((entry) => entry.name === "links.json")!.base64, "base64").toString("utf8")) as { joins: Array<{ joined: boolean; inner_plan_hash: string; package: { plan: { parent: JsonObject; decisions: JsonObject; tool_approvals: string[] } } }> };
    expect(record.joins).toHaveLength(1);
    expect(record.joins[0]).toMatchObject({ joined: true, inner_plan_hash: decided.inner_plan_hash });
    // The run is named as its audit names it (the runtime's own id, on every event of the chain).
    expect(record.joins[0]!.package.plan.parent).toEqual({ plan_hash: result.run_plan!.run_plan.run_plan_sha256, run_id: after[0]!.run_id, slot: "named-hotel" });
    expect(record.joins[0]!.package.plan).toMatchObject({ decisions: HOTEL_GRANTS, tool_approvals: ["check-availability"] });
    // The record states which plan that is: the caller's Run Plan, by its hash (L-30); the plan itself is the run's own record.
    expect(record).toMatchObject({ caller_plan_hash: result.run_plan!.run_plan.run_plan_sha256 });
    expect(record).not.toHaveProperty("caller_plan");
    // The pin made from the card is on the trust page, with where it came from.
    const trust = (await w.h.controller.handle({ type: "trust.list" }, PAGE)) as TrustList;
    const pinned = trust.entries.find((entry) => entry.fingerprint === (facts.publisher.signer as string))!;
    expect(pinned).toMatchObject({ publisher_id: "hotel-salitubam", package_id_prefix: null, notes: `Pinned from a join card (run ${runId}, slot named-hotel).` });
  });

  it("declined, the slot yields joined false as data, nothing is sent to the candidate and no request is built", async () => {
    const { w, runId } = await joining({ pages: { ...recordedHotel(), improvise: true } });
    const waiting = await card(w, runId);
    await decide(w, runId, waiting.runCard!.card_id, false);
    const run = await settled(w, runId);
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    const events = await auditOf(w, runId);
    expect(events.find((event) => event.action === "link.decided")).toMatchObject({ accepted: false, decided_by: "person", reason: "declined", provenance: "person" });
    expect(events.filter((event) => event.slot === "named-hotel").map((event) => event.action)).toEqual(["link.requested", "link.decided"]);
    expect(w.scripted.modelSeen.map((request) => request.task)).not.toContain("request");
    expect(w.scripted.toolSeen.filter((request) => request.url.startsWith(SALITUBAM)).map((request) => request.method)).toEqual(["GET", "GET"]);
    const join = (run.delegation as DelegationTree).activations.flatMap((activation) => activation.links).find((link) => link.kind === "join")!;
    expect(join).toMatchObject({ state: "declined", code: "declined" });
    expect(((await w.h.controller.handle({ type: "trust.list" }, PAGE)) as TrustList).entries.some((entry) => entry.publisher_id === "hotel-salitubam")).toBe(false);
  });

  it("an answer the Worker never receives is read from the record: the card does not hang, and its pin waits for the run to take it", async () => {
    const { w, runId } = await joining({ findHotelTokens: 6000 });
    w.h.host.cardLost = true;
    const waiting = await card(w, runId);
    const answered = await decide(w, runId, waiting.runCard!.card_id, true, { grants: HOTEL_GRANTS, approvedTools: ["check-availability"], pin: "package" });
    expect(answered.cardPin).toMatchObject({ made: true });
    const run = await settled(w, runId);
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    expect((await auditOf(w, runId)).find((event) => event.action === "link.decided")).toMatchObject({ accepted: true, decided_by: "person" });
  });

  it("a pin that fails leaves the answer standing and says so; nothing is pinned (review 1, nit 8)", async () => {
    const { w, runId } = await joining({ findHotelTokens: 6000 });
    const waiting = await card(w, runId);
    const cardId = waiting.runCard!.card_id;
    // The key the card would pin no longer matches the candidate's signer (the worker checks it).
    const other = rawBase64((await generateKeyPair()).publicKey);
    await w.h.runs.updateRun(runId, (current) => ({ ...current, run_card_pending: { ...current.run_card_pending!, publisher: { ...current.run_card_pending!.publisher!, public_key: other } } }));
    const answered = await decide(w, runId, cardId, true, { grants: HOTEL_GRANTS, approvedTools: ["check-availability"], pin: "publisher" });
    expect(answered.cardPin).toMatchObject({ card_id: cardId, made: false, reason: expect.stringContaining("Your answer stands") });
    const run = await settled(w, runId);
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    expect((await auditOf(w, runId)).find((event) => event.action === "link.decided")).toMatchObject({ accepted: true, decided_by: "person" });
    expect(((await w.h.controller.handle({ type: "trust.list" }, PAGE)) as TrustList).entries.some((entry) => entry.publisher_id === "hotel-salitubam")).toBe(false);
  });

  it("an origin Chrome does not grant is never dialled: the look is listed origin_not_granted and the slot finds nothing (review 1, finding 1)", async () => {
    // The hotel's page and package are there and would be found (as a server sending
    // Access-Control-Allow-Origin: * lets an ungranted extension read them); only the grant is missing.
    const granted = [TRIPWRIGHT, WEBAIR, STAYMERE].map((origin) => `${origin}/*`);
    const { w, runId } = await joining({ permissions: granted, pages: { ...recordedHotel(), improvise: true } });
    const run = await settled(w, runId);
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    expect(w.h.host.started[0]!.cards!.granted).toEqual([...granted].sort());
    const events = await auditOf(w, runId);
    expect(events.find((event) => event.action === "link.requested")).toMatchObject({ candidate: null, fetches: [{ url: HOTEL_PAGE, kind: "discovery", status: "origin_not_granted" }] });
    expect(events.find((event) => event.action === "link.decided")).toMatchObject({ accepted: false, decided_by: "runtime", reason: "not_found" });
    expect(run.runCard ?? null).toBeNull();
    // Nothing was handed to the transport for the hotel's origin.
    expect(w.scripted.toolSeen.filter((request) => request.url.startsWith(SALITUBAM))).toEqual([]);
  });

  it("the same origin granted is looked at and its card shown (the control of the test above)", async () => {
    const granted = [TRIPWRIGHT, WEBAIR, STAYMERE, SALITUBAM].map((origin) => `${origin}/*`);
    const { w, runId } = await joining({ permissions: granted, pages: { ...recordedHotel(), improvise: true } });
    const waiting = await card(w, runId);
    expect(waiting.runCard?.kind).toBe("link.join");
    await decide(w, runId, waiting.runCard!.card_id, false);
    await settled(w, runId);
    expect(w.scripted.toolSeen.filter((request) => request.url.startsWith(SALITUBAM)).map((request) => request.url)).toEqual([HOTEL_PAGE, HOTEL_PACKAGE]);
  });

  it("a subscribed policy that forbids joins: nothing is looked at, no card is shown, the slot says policy; the review says so before the run", async () => {
    const signer = newSigner();
    const url = "https://policy.example.org/policy.json";
    const content: JsonObject = { policy_id: "org.example.no-joins", version: "1.0.0", title: "No joins", issuer: { name: "Example" }, issued_at: "2026-10-01T00:00:00Z", expires_at: "2027-10-01T00:00:00Z", trust_anchors: [], decisions: {}, links: { join: "forbid", raise: "forbid" } };
    const w = await world({ planner: "planner020", extra: ["salitubam"], pages: { ...recordedHotel(), improvise: true }, routes: { [url]: { headers: { "content-type": "application/json" }, body: await signedBytes(POLICY_BUNDLE_TYPE, content, signer) } } });
    await w.h.controller.handle({ type: "policy.subscribe", url, publicKeyPem: signer.pem, replace: false }, PAGE);
    const links = await resolveLinks(w);
    expect(links.run_cards).toMatchObject({ join: "forbid", raise: "forbid", policy: expect.stringContaining("org.example.no-joins") });
    await pinAll(w, links);
    const result = await authorize(w, "planner020");
    expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
    const started = await start(w, result);
    const run = await settled(w, started.runId);
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    expect(w.h.host.started[0]!.cards).toMatchObject({ join: "forbid", raise: "forbid" });
    const events = await auditOf(w, started.runId);
    expect(events.find((event) => event.action === "link.decided")).toMatchObject({ accepted: false, decided_by: "runtime", reason: "policy" });
    expect(events.some((event) => event.action === "link.requested")).toBe(false);
    expect(w.scripted.toolSeen.some((request) => request.url.startsWith(SALITUBAM))).toBe(false);
  });
});

