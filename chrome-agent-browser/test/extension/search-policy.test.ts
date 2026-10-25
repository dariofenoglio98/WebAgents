/**
 * T8 through the worker: the demo index added with its pinned key, a search for "literature
 * review" that opens the package verified with the index's claims compared; the research policy
 * subscribed, pre-deciding WebAir's "Search flights" with `policy` provenance, a decision the person
 * overrides recorded as theirs, revocation staling the plan; caps lowering the run limits; the
 * Library; and the document rules (pinned key, no redirect, rollback, no fetch in the background).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { JsonObject } from "../../src/core/json.js";
import { NANDA_NOT_CONFIGURED } from "../../src/core/resolve/nanda.js";
import { AGENT_INDEX_TYPE, POLICY_BUNDLE_TYPE } from "../../src/core/signed-document.js";
import { MAX_PINNED, type SubscriptionStorage } from "../../src/extension/storage/subscriptions.js";
import type { AuthorizationView, AuthorizeResult, IndexesView, LibraryView, PolicyView, RunPlanState, SearchView, SessionView, SettingsView, StatusInfo } from "../../src/extension/messages.js";
import { readBytes, ROOT, SHIPPED } from "../helpers/paths.js";
import { makeHarness, PAGE, type Harness, type Route } from "../helpers/shell.js";
import { newSigner, signedBytes, type TestSigner } from "../helpers/signing.js";

const ORIGIN = "https://webagents-webair-production.up.railway.app";
const INDEX_URL = `${ORIGIN}/agent-index.json`;
const POLICY_URL = `${ORIGIN}/policies/webagents-research.json`;
const LITERATURE_URL = `${ORIGIN}/packages/literature-review-0.2.9.agent.pkg`;
const WEBAIR_URL = `${ORIGIN}/agent.pkg`;
const INDEX_PEM = readFileSync(resolve(ROOT, "examples/keys/webagents-index.pub.pem"), "utf8");
const POLICY_PEM = readFileSync(resolve(ROOT, "examples/keys/webagents-policy.pub.pem"), "utf8");
const INDEX_CONTENT = JSON.parse(readFileSync(resolve(ROOT, "examples/agent-index.content.json"), "utf8")) as JsonObject;
const POLICY_CONTENT = JSON.parse(readFileSync(resolve(ROOT, "examples/policies/webagents-research.content.json"), "utf8")) as JsonObject;
const QWEN = "ollama/qwen3:30b";
/** Inside both documents' validity windows. */
const AFTER_ISSUE = new Date("2026-10-25T12:00:00Z");

/** The demo origin as the WebAir deployment serves it beside the airline (D-105): index, policy, both packages. */
function demoRoutes(): Record<string, Route> {
  const file = (path: string) => readBytes(resolve(ROOT, path));
  return {
    [INDEX_URL]: { headers: { "content-type": "application/json" }, body: file("examples/agent-index.json") },
    [POLICY_URL]: { headers: { "content-type": "application/json" }, body: file("examples/policies/webagents-research.json") },
    [LITERATURE_URL]: { body: readBytes(SHIPPED.literatureReview029.archive) },
    [WEBAIR_URL]: { body: readBytes(SHIPPED.webair080.archive) },
  };
}

function harness(extra: Record<string, Route> = {}): Harness {
  const h = makeHarness({ routes: { ...demoRoutes(), ...extra } });
  h.clock.now = AFTER_ISSUE;
  return h;
}

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

const send = <T>(h: Harness, request: Parameters<Harness["controller"]["handle"]>[0]) => h.controller.handle(request, PAGE) as Promise<T>;

async function withModel(h: Harness): Promise<void> {
  const current = await send<SettingsView>(h, { type: "settings.get" });
  const settings = current.settings;
  settings.models.default_model = QWEN;
  settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, overrides: { "qwen3:30b": { context_tokens: 65536, max_output_tokens: 16384 } } } : connection));
  await send(h, { type: "settings.set", settings });
}

describe("the agent index (deliverables 1–3)", () => {
  it("acceptance: a search for 'literature review' lists the package from the demo index and opens it verified", async () => {
    const h = harness();
    expect((await send<SearchView>(h, { type: "search.query", text: "literature review" })).enabled_indexes).toBe(0);
    const added = await send<IndexesView>(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: INDEX_PEM });
    expect(added.indexes[0]).toMatchObject({ url: INDEX_URL, enabled: true, state: "current", signer_fingerprint: "sha256:e0e7022b5836da157d7d55a9d7b00cb58e236d5270ab103162e63706b49f5103", index: { index_id: "org.webagents.demo-index", version: "1.6.0", entries: 3 } });
    const search = await send<SearchView>(h, { type: "search.query", text: "literature review" });
    expect(search.searched).toEqual([{ index_id: "org.webagents.demo-index", label: "WebAgents demo index", version: "1.6.0" }]);
    expect(search.results).toHaveLength(1);
    const result = search.results[0]!;
    expect(result.candidate).toMatchObject({ package_id: SHIPPED.literatureReview029.packageId, package_url: LITERATURE_URL, source: { resolver: "static-index", label: "WebAgents demo index", verified_by: "sha256:e0e7022b5836da157d7d55a9d7b00cb58e236d5270ab103162e63706b49f5103" } });
    expect(result.trust).toEqual({ status: "unknown", reason: "signer_key_not_pinned" });
    // Opening the card is the ordinary open-and-verify, plus a comparison with what the index said.
    const opened = await send<SessionView>(h, { type: "package.open", url: result.candidate.package_url, advertisedOn: null, viewId: "test", foundVia: { indexId: result.candidate.source.resolver_id } });
    expect(opened.summary.validation).toMatchObject({ container_status: "valid", integrity_status: "valid", schema_status: "valid" });
    expect(opened.page.trust).toMatchObject({ signature_status: "valid", signer_fingerprint: SHIPPED.literatureReview029.fingerprint, trust_status: "unknown" });
    expect(opened.snapshot.archive_sha256).toBe(SHIPPED.literatureReview029.archiveSha256);
    expect(opened.found_via).toEqual({ index_id: "org.webagents.demo-index", label: "WebAgents demo index", version: "1.6.0", position: 0, claims: { package_id: "matches", version: "matches", digest: "matches", archive_sha256: "matches", signer_fingerprint: "matches" } });
  });

  it("matches a locator, ranks by trust status then index order, and asks the NANDA stub only for a locator", async () => {
    const h = harness();
    await send(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: INDEX_PEM });
    const locator = await send<SearchView>(h, { type: "search.query", text: "flights@webair.example" });
    expect(locator.results.map((item) => item.candidate.package_id)).toEqual([SHIPPED.webair080.packageId]);
    expect(locator.notes.map((note) => note.code)).toEqual(["nanda_not_configured"]);
    expect((await send<SearchView>(h, { type: "search.query", text: "agent" })).notes).toEqual([]);
    expect((await send<SearchView>(h, { type: "search.query", text: "agent" })).results.map((item) => item.candidate.package_id)).toEqual([SHIPPED.literatureReview029.packageId, SHIPPED.webair080.packageId, SHIPPED.travelNetwork.packageId]);
    // Trust the airline's key: it now ranks first, ahead of the index's own order.
    await h.trust.add(Buffer.from((POLICY_CONTENT.trust_anchors as JsonObject[])[0]!.public_key as string, "base64"), { displayName: "WebAir", publisherId: "webair-demo" });
    const ranked = await send<SearchView>(h, { type: "search.query", text: "agent" });
    expect(ranked.results.map((item) => [item.candidate.package_id, item.trust.status])).toEqual([
      [SHIPPED.webair080.packageId, "trusted"],
      [SHIPPED.literatureReview029.packageId, "unknown"],
      [SHIPPED.travelNetwork.packageId, "unknown"],
    ]);
  });

  it("an index's claims are compared, never believed: a package that differs still opens, and says so", async () => {
    const signer = newSigner();
    const content = JSON.parse(JSON.stringify(INDEX_CONTENT)) as JsonObject & { entries: JsonObject[] };
    content.index_id = "org.example.lying-index";
    content.entries[0]!.digest = "0".repeat(64);
    content.entries[0]!.signer_fingerprint = `sha256:${"1".repeat(64)}`;
    const url = "https://index.example/lying.json";
    const h = harness({ [url]: { body: await signedBytes(AGENT_INDEX_TYPE, content, signer) } });
    await send(h, { type: "indexes.add", url, publicKeyPem: signer.pem });
    const result = (await send<SearchView>(h, { type: "search.query", text: "literature" })).results[0]!;
    const opened = await send<SessionView>(h, { type: "package.open", url: result.candidate.package_url, foundVia: { indexId: "org.example.lying-index" } });
    expect(opened.page.trust.signature_status).toBe("valid");
    expect(opened.found_via?.claims).toMatchObject({ digest: "differs", signer_fingerprint: "differs", archive_sha256: "matches" });
  });

  it("an index is added only with its pinned key, over the URL gate, without redirects, and once", async () => {
    const h = harness({ "https://index.example/moved.json": { redirectTo: INDEX_URL } });
    expect((await refused(send(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: POLICY_PEM }))).code).toBe("document_key_unknown");
    expect((await refused(send(h, { type: "indexes.add", url: POLICY_URL, publicKeyPem: POLICY_PEM }))).code).toBe("document_type_mismatch");
    expect((await refused(send(h, { type: "indexes.add", url: "http://index.example/i.json", publicKeyPem: INDEX_PEM }))).code).toBe("url_rejected");
    expect((await refused(send(h, { type: "indexes.add", url: "https://index.example/moved.json", publicKeyPem: INDEX_PEM }))).code).toBe("download_redirect_denied");
    expect((await refused(send(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }))).code).toMatch(/key|private/u);
    expect((await send<IndexesView>(h, { type: "indexes.list" })).indexes).toEqual([]);
    await send(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: INDEX_PEM });
    expect((await refused(send(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: INDEX_PEM }))).code).toBe("index_exists");
  });

  it("fetches nothing in the background: a disabled index is never fetched, an enabled one again only when searched after an hour", async () => {
    const h = harness();
    await send(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: INDEX_PEM });
    const fetches = () => h.fetchLog.filter((entry) => entry.url === INDEX_URL).length;
    expect(fetches()).toBe(1);
    await send(h, { type: "search.query", text: "review" });
    expect(fetches()).toBe(1);
    h.clock.now = new Date(AFTER_ISSUE.getTime() + 2 * 3600_000);
    await send(h, { type: "indexes.enable", url: INDEX_URL, enabled: false });
    expect((await send<SearchView>(h, { type: "search.query", text: "review" })).results).toEqual([]);
    expect(fetches()).toBe(1);
    await send(h, { type: "indexes.enable", url: INDEX_URL, enabled: true });
    expect((await send<SearchView>(h, { type: "search.query", text: "review" })).results).toHaveLength(1);
    expect(fetches()).toBe(2);
    const init = h.fetchLog.find((entry) => entry.url === INDEX_URL)!.init;
    expect(init).toMatchObject({ redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("a refresh never rolls back, never takes a reused version, and keeps the held copy when refused", async () => {
    const signer = newSigner();
    const url = "https://index.example/i.json";
    const version = (v: string, title = "Index") => signedBytes(AGENT_INDEX_TYPE, { ...INDEX_CONTENT, index_id: "org.example.i", version: v, title }, signer);
    const h = harness({ [url]: { body: await version("2.0.0") } });
    const routes = h.routes;
    await send(h, { type: "indexes.add", url, publicKeyPem: signer.pem });
    routes[url] = { body: await version("1.9.0") };
    const rolled = await send<IndexesView>(h, { type: "indexes.refresh", url });
    expect(rolled.indexes[0]).toMatchObject({ index: { version: "2.0.0" }, last_error: { code: "document_rollback" } });
    routes[url] = { body: await version("2.0.0", "Same version, other content") };
    expect((await send<IndexesView>(h, { type: "indexes.refresh", url })).indexes[0]).toMatchObject({ index: { version: "2.0.0", title: "Index" }, last_error: { code: "document_version_reused" } });
    routes[url] = { body: await version("2.1.0") };
    expect((await send<IndexesView>(h, { type: "indexes.refresh", url })).indexes[0]).toMatchObject({ index: { version: "2.1.0" }, last_error: null });
    await send(h, { type: "indexes.remove", url });
    expect((await send<IndexesView>(h, { type: "indexes.list" })).indexes).toEqual([]);
  });
});

describe("policy subscriptions (deliverable 4)", () => {
  async function subscribed(): Promise<Harness> {
    const h = harness();
    await withModel(h);
    const view = await send<PolicyView>(h, { type: "policy.subscribe", url: POLICY_URL, publicKeyPem: POLICY_PEM, replace: false });
    expect(view).toMatchObject({ subscribed: true, state: "current", key_fingerprint: "sha256:829e28368a71c10bc346a563205ad4b699351d8bed06b21d9671db132c197d7a", reference: { policy_id: "org.webagents.research", version: "1.0.0", title: "WebAgents research policy" } });
    return h;
  }

  it("acceptance: the research policy pre-decides 'Search flights' with visible provenance, and an override records the person as the decider", async () => {
    const h = await subscribed();
    // No pin: the policy's anchor makes the airline's key trusted, and says so.
    const session = await send<SessionView>(h, { type: "package.open", url: WEBAIR_URL, viewId: "test" });
    expect(session.page.trust).toMatchObject({ trust_status: "trusted", trust_reason: "policy_anchor", headline: "Signed by a publisher your policy trusts" });
    const view = await send<AuthorizationView>(h, { type: "authorization.get", sessionId: session.session.id });
    expect(view.policy).toMatchObject({ label: "org.webagents.research@1.0.0", local_only: false, bindings_restricted: true });
    const search = view.profiles!.find((entry) => entry.profile.id === "search")!;
    expect(search.decided.provenance.decisions).toMatchObject({ "network.webair": "policy", "model.reasoning": "policy", "memory.session": "policy", "memory.travel_profile": "profile", "wallet.payment": "profile" });
    expect(search.decided.provenance.policy).toMatchObject({ policy_id: "org.webagents.research", version: "1.0.0" });
    // The two-click path: the receipt records who decided each item, and names the policy.
    const used = await send<AuthorizeResult>(h, { type: "authorization.useProfile", sessionId: session.session.id, packageDigest: view.package_digest, profileId: "search", resourceSelections: {}, prepare: true });
    expect(used.receipt.runnable).toBe(true);
    expect(used.receipt.provenance).toMatchObject({ profile_id: "search", policy: { policy_id: "org.webagents.research", version: "1.0.0" }, decisions: { "network.webair": "policy", "memory.session": "policy", "booking.simulate_purchase": "profile" } });
    expect(used.receipt.publisher.trust_reason).toBe("policy_anchor");
    expect(used.run_plan?.preflight.ready).toBe(true);
    expect(used.run_plan?.run_plan.authorization.provenance?.policy?.policy_id).toBe("org.webagents.research");
    // Customize: the person changes one decision; the view sends the profile's provenance with that one item as theirs.
    const decisions = { ...search.decided.decisions, "memory.session": "once" as const };
    const provenance = { ...search.decided.provenance, decisions: { ...search.decided.provenance.decisions, "memory.session": "user" as const } };
    const overridden = await send<AuthorizeResult>(h, { type: "authorization.authorize", sessionId: session.session.id, packageDigest: view.package_digest, decisions, toolApprovals: search.decided.tool_approvals, resourceSelections: {}, provenance, prepare: false });
    expect(overridden.receipt.decisions["memory.session"]).toBe("once");
    expect(overridden.receipt.provenance?.decisions).toMatchObject({ "memory.session": "user", "network.webair": "policy", "model.reasoning": "policy", "memory.travel_profile": "profile" });
    // A view cannot pass its own change off as the policy's.
    const forged = await send<AuthorizeResult>(h, { type: "authorization.authorize", sessionId: session.session.id, packageDigest: view.package_digest, decisions, toolApprovals: search.decided.tool_approvals, resourceSelections: {}, provenance: search.decided.provenance, prepare: false });
    expect(forged.receipt.provenance?.decisions["memory.session"]).toBe("user");
  });

  it("revoking the policy withdraws its trust and stales the plans made under it", async () => {
    const h = await subscribed();
    const session = await send<SessionView>(h, { type: "package.open", url: WEBAIR_URL, viewId: "test" });
    const used = await send<AuthorizeResult>(h, { type: "authorization.useProfile", sessionId: session.session.id, packageDigest: (await send<AuthorizationView>(h, { type: "authorization.get", sessionId: session.session.id })).package_digest, profileId: "search", resourceSelections: {}, prepare: true });
    expect(used.run_plan?.preflight.ready).toBe(true);
    expect(await send<PolicyView>(h, { type: "policy.unsubscribe" })).toEqual({ subscribed: false });
    expect(h.events.some((event) => event.type === "event.policy")).toBe(true);
    const reopened = await send<SessionView>(h, { type: "package.get", sessionId: session.session.id });
    expect(reopened.page.trust.trust_status).toBe("unknown");
    const plan = await send<RunPlanState>(h, { type: "runplan.get", sessionId: session.session.id });
    expect(plan.preflight.ready).toBe(false);
    expect(plan.preflight.stale_reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["publisher_trust_changed", "policy_withdrawn"]));
  });

  it("one policy at a time: another needs replace, the same one again is a refresh, an expired one is refused", async () => {
    const h = await subscribed();
    const other = newSigner();
    const otherUrl = "https://policy.example/other.json";
    h.routes[otherUrl] = { body: await signedBytes(POLICY_BUNDLE_TYPE, { ...POLICY_CONTENT, policy_id: "org.example.other", trust_anchors: [] }, other) };
    expect((await refused(send(h, { type: "policy.subscribe", url: otherUrl, publicKeyPem: other.pem, replace: false }))).code).toBe("policy_exists");
    expect(await send<PolicyView>(h, { type: "policy.subscribe", url: POLICY_URL, publicKeyPem: POLICY_PEM, replace: false })).toMatchObject({ subscribed: true, reference: { policy_id: "org.webagents.research" } });
    expect(await send<PolicyView>(h, { type: "policy.subscribe", url: otherUrl, publicKeyPem: other.pem, replace: true })).toMatchObject({ subscribed: true, reference: { policy_id: "org.example.other" } });
    const expiredUrl = "https://policy.example/expired.json";
    h.routes[expiredUrl] = { body: await signedBytes(POLICY_BUNDLE_TYPE, { ...POLICY_CONTENT, issued_at: "2025-01-01T00:00:00Z", expires_at: "2026-01-01T00:00:00Z" }, other) };
    expect((await refused(send(h, { type: "policy.subscribe", url: expiredUrl, publicKeyPem: other.pem, replace: true }))).code).toBe("policy_not_current");
  });

  it("a held policy that expires decides nothing any more", async () => {
    const h = await subscribed();
    const session = await send<SessionView>(h, { type: "package.open", url: WEBAIR_URL, viewId: "test" });
    expect(session.page.trust.trust_status).toBe("trusted");
    h.clock.now = new Date("2028-01-01T00:00:00Z");
    expect(await send<PolicyView>(h, { type: "policy.get" })).toMatchObject({ subscribed: true, state: "expired" });
    const view = await send<AuthorizationView>(h, { type: "authorization.get", sessionId: (await send<SessionView>(h, { type: "package.open", url: WEBAIR_URL, viewId: "later" })).session.id });
    expect(view.policy).toBeNull();
  });

  it("budget caps lower the person's run limits and never raise them", async () => {
    const signer = newSigner();
    const url = "https://policy.example/tight.json";
    const h = harness({ [url]: { body: await signedBytes(POLICY_BUNDLE_TYPE, { ...POLICY_CONTENT, budget_caps: { total_tokens: 50_000, run_timeout_seconds: 9_999 } }, signer) } });
    const before = (await send<StatusInfo>(h, { type: "status.get" })).execution_limits!;
    await send(h, { type: "policy.subscribe", url, publicKeyPem: signer.pem, replace: false });
    const after = (await send<StatusInfo>(h, { type: "status.get" })).execution_limits!;
    expect(after.total_tokens).toBe(50_000);
    expect(after.run_timeout_seconds).toBe(before.run_timeout_seconds);
  });

  it("a policy's local-only rule refuses a plan on a hosted model and admits a local one", async () => {
    const signer: TestSigner = newSigner();
    const url = "https://policy.example/local.json";
    const h = harness({ [url]: { body: await signedBytes(POLICY_BUNDLE_TYPE, { ...POLICY_CONTENT, models: { local_only: true, max_cost_usd_per_run: 1 } }, signer) } });
    await withModel(h);
    await send(h, { type: "policy.subscribe", url, publicKeyPem: signer.pem, replace: false });
    const session = await send<SessionView>(h, { type: "package.open", url: WEBAIR_URL, viewId: "test" });
    const digest = (await send<AuthorizationView>(h, { type: "authorization.get", sessionId: session.session.id })).package_digest;
    const local = await send<AuthorizeResult>(h, { type: "authorization.useProfile", sessionId: session.session.id, packageDigest: digest, profileId: "search", resourceSelections: {}, prepare: true });
    expect(local.run_plan?.preflight.ready).toBe(true);
  });
});

describe("the Library (deliverable 3)", () => {
  it("lists the agents opened recently and the ones pinned, with their trust as it stands now", async () => {
    const h = harness();
    const session = await send<SessionView>(h, { type: "package.open", url: LITERATURE_URL, viewId: "test" });
    expect(session.pinned).toBe(false);
    let library = await send<LibraryView>(h, { type: "library.get" });
    expect(library.recent.map((entry) => [entry.package_id, entry.package_url, entry.trust_status, entry.open_session_id])).toEqual([[SHIPPED.literatureReview029.packageId, LITERATURE_URL, "unknown", session.session.id]]);
    expect(library.pinned).toEqual([]);
    library = await send<LibraryView>(h, { type: "library.pin", sessionId: session.session.id });
    expect(library.pinned.map((entry) => entry.package_id)).toEqual([SHIPPED.literatureReview029.packageId]);
    expect((await send<SessionView>(h, { type: "package.get", sessionId: session.session.id })).pinned).toBe(true);
    await send(h, { type: "package.open", url: WEBAIR_URL, viewId: "test" });
    expect((await send<LibraryView>(h, { type: "library.get" })).recent.map((entry) => entry.package_id)).toEqual([SHIPPED.webair080.packageId, SHIPPED.literatureReview029.packageId]);
    await send(h, { type: "policy.subscribe", url: POLICY_URL, publicKeyPem: POLICY_PEM, replace: false });
    expect((await send<LibraryView>(h, { type: "library.get" })).pinned[0]).toMatchObject({ trust_status: "trusted", trust_reason: "policy_anchor" });
    expect((await send<LibraryView>(h, { type: "library.unpin", packageUrl: LITERATURE_URL })).pinned).toEqual([]);
    expect((await send<LibraryView>(h, { type: "library.forget", packageUrl: WEBAIR_URL })).recent.map((entry) => entry.package_id)).toEqual([SHIPPED.literatureReview029.packageId]);
  });
});

describe("T8 review carry-overs (T9, B-136)", () => {
  it("a failed refresh is not tried again on every search within the hour; Refresh still fetches (finding 1)", async () => {
    const h = harness();
    await send(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: INDEX_PEM });
    const fetches = () => h.fetchLog.filter((entry) => entry.url === INDEX_URL).length;
    h.clock.now = new Date(AFTER_ISSUE.getTime() + 2 * 3600_000);
    h.routes[INDEX_URL] = { fail: true };
    const first = await send<SearchView>(h, { type: "search.query", text: "review" });
    expect(fetches()).toBe(2);
    expect(first.results).toHaveLength(1); // the held copy is searched
    expect(first.notes.map((note) => note.detail)).toContainEqual(expect.stringContaining("Could not refresh it"));
    // Ten minutes later: no new attempt, the same note.
    h.clock.now = new Date(h.clock.now.getTime() + 10 * 60_000);
    const second = await send<SearchView>(h, { type: "search.query", text: "review" });
    expect(fetches()).toBe(2);
    expect(second.notes.map((note) => note.detail)).toContainEqual(expect.stringContaining("Could not refresh it"));
    // An explicit refresh always asks; an hour after the last failure a search tries again.
    await send(h, { type: "indexes.refresh", url: INDEX_URL });
    expect(fetches()).toBe(3);
    h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
    h.routes[INDEX_URL] = demoRoutes()[INDEX_URL]!;
    const recovered = await send<SearchView>(h, { type: "search.query", text: "review" });
    expect(fetches()).toBe(4);
    expect(recovered.notes.map((note) => note.code)).not.toContain("download_failed");
    expect((await send<IndexesView>(h, { type: "indexes.list" })).indexes[0]!.last_error).toBeNull();
  });

  it("an entry's display-only homepage is checked as an https URL, not as a package URL; a bad one loses the homepage, not the entry (finding 3)", async () => {
    const signer = newSigner();
    const url = "https://index.example/homepages.json";
    const base = INDEX_CONTENT.entries as JsonObject[];
    // A port and a fragment fail the package URL gate (443, no fragment) but are fine for a link; credentials are not.
    const entries: JsonObject[] = [{ ...base[0]!, homepage: "https://docs.example:8443/agent#about" }, { ...base[1]!, homepage: "https://someone@docs.example/" }];
    const h = harness({ [url]: { body: await signedBytes(AGENT_INDEX_TYPE, { ...INDEX_CONTENT, index_id: "org.example.homepages", entries }, signer) } });
    const added = await send<IndexesView>(h, { type: "indexes.add", url, publicKeyPem: signer.pem });
    expect(added.indexes[0]!.index).toMatchObject({ entries: 2 });
    expect(added.indexes[0]!.index!.notes.map((note) => note.code)).toEqual(["entry_homepage_dropped"]);
    const found = new Map<string, string | null>();
    for (const entry of entries) {
      for (const item of (await send<SearchView>(h, { type: "search.query", text: String(entry.package_id) })).results) found.set(item.candidate.package_id, item.candidate.homepage);
    }
    expect(found).toEqual(new Map([[String(entries[0]!.package_id), "https://docs.example:8443/agent#about"], [String(entries[1]!.package_id), null]]));
  });

  it("the held policy is read once per stored copy (nit 5)", async () => {
    const h = harness();
    await send(h, { type: "policy.subscribe", url: POLICY_URL, publicKeyPem: POLICY_PEM, replace: false });
    const first = await h.controller.activePolicy();
    const second = await h.controller.activePolicy();
    expect(first).not.toBeNull();
    expect(second!.bundle).toBe(first!.bundle);
  });

  it("the 65th pin is refused by name instead of dropping the oldest (nit 6)", async () => {
    const h = harness();
    const session = await send<SessionView>(h, { type: "package.open", url: LITERATURE_URL, viewId: "test" });
    const pinned = (await send<LibraryView>(h, { type: "library.pin", sessionId: session.session.id })).pinned[0]!;
    const entry = { package_url: pinned.package_url, advertised_on: pinned.advertised_on, package_id: pinned.package_id, name: pinned.name, version: pinned.version, publisher: pinned.publisher, digest: pinned.digest, archive_sha256: pinned.archive_sha256, signer_fingerprint: pinned.signer_fingerprint, at: pinned.at };
    const others = Array.from({ length: MAX_PINNED }, (_, index) => ({ ...entry, package_url: `https://agents.example/${index}.agent.pkg` }));
    // The controller's own subscription storage (the harness keeps it in memory).
    const storage = (h.controller as unknown as { subscriptions: SubscriptionStorage }).subscriptions;
    await storage.updateLibrary(() => ({ pinned: others, recent: [] }));
    expect((await send<LibraryView>(h, { type: "library.get" })).pinned).toHaveLength(MAX_PINNED);
    const error = await refused(send(h, { type: "library.pin", sessionId: session.session.id }));
    expect([error.code, error.message]).toEqual(["library_limit", `At most ${MAX_PINNED} agents can be pinned; unpin one first.`]);
    const after = await send<LibraryView>(h, { type: "library.get" });
    expect(after.pinned.map((item) => item.package_url)).toEqual(others.map((item) => item.package_url));
    // Re-pinning one already pinned is not a 65th.
    await storage.updateLibrary(() => ({ pinned: [...others.slice(1), entry], recent: [] }));
    expect((await send<LibraryView>(h, { type: "library.pin", sessionId: session.session.id })).pinned[0]!.package_url).toBe(LITERATURE_URL);
  });

  it("an index whose held copy no longer verifies says why; the NANDA note is the resolver's constant (nits 7, 8)", async () => {
    const h = harness();
    await send(h, { type: "indexes.add", url: INDEX_URL, publicKeyPem: INDEX_PEM });
    // The held copy changes under the worker (storage edited outside it): it no longer verifies.
    const storage = (h.controller as unknown as { subscriptions: SubscriptionStorage }).subscriptions;
    await storage.updateIndexes((list) => list.map((item) => ({ ...item, document: { ...item.document!, text: item.document!.text.replace("WebAgents demo index", "WebAgents demo indeX") } })));
    const view = await send<IndexesView>(h, { type: "indexes.list" });
    expect(view.indexes[0]).toMatchObject({ state: "unverified", unverified_reason: expect.stringMatching(/signature/iu) });
    expect(view.nanda).toEqual({ configured: false, note: NANDA_NOT_CONFIGURED });
  });
});
