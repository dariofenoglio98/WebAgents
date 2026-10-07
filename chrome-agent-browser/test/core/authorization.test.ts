/**
 * Authorization (`authorization.py`) and the Chrome additions (D-022, D-050, D-053): the
 * request and the receipt equal the reference's for the fixture inputs, the receipt hash is
 * computed as the reference computes it, decisions are normalized strictly, a profile
 * expands into ordinary decisions with everything outside it denied, presets supply
 * defaults with their provenance, and the first profile is the least.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  approvalCandidates,
  blockingReasons,
  buildReceipt,
  buildRequest,
  DEFAULT_PRESET,
  defaultDecisions,
  initialDecisions,
  initialToolApprovals,
  normalizeDecisions,
  normalizeProvenance,
  normalizeToolApprovals,
  presetDuration,
  PRESETS,
  profileDecisions,
  type ReceiptInputs,
} from "../../src/core/authorization.js";
import { CoreError } from "../../src/core/errors.js";
import type { EvaluationLayers, PublisherReport } from "../../src/core/evaluation.js";
import { normalizeResourceRegistry, normalizeResourceSelections } from "../../src/core/hostresources.js";
import type { JsonObject } from "../../src/core/json.js";
import { readProfiles } from "../../src/core/profiles.js";
import { DEFAULT_BROWSER_POLICY, hashReceipt, recordHashValid, type AuthorizationReceipt, type BrowserPolicy, type Provenance } from "../../src/core/types.js";
import { fixture, inputs, webair040, without } from "../helpers/fixtures.js";
import { PROJECT } from "../helpers/paths.js";

function code(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof CoreError) return error.code;
    throw error;
  }
  return "accepted";
}

/** The fixture session's facts as `buildReceipt` inputs. */
async function receiptInputs(overrides: Partial<ReceiptInputs> = {}): Promise<ReceiptInputs> {
  const input = inputs();
  const pkg = await webair040();
  const registry = await normalizeResourceRegistry(input.resource_registry);
  const reference = fixture<AuthorizationReceipt>("receipt");
  return {
    sessionId: input.session.session_id,
    source: input.session.source,
    archiveSha256: input.session.archive_sha256,
    evaluation: input.session.evaluation as unknown as EvaluationLayers,
    publisher: input.session.publisher as unknown as PublisherReport,
    trustState: input.session.trust_state,
    decisions: input.decisions,
    toolApprovals: input.tool_approvals,
    policy: input.session.browser_policy as unknown as BrowserPolicy,
    instanceId: input.session.instance_id,
    expiresAt: input.session.expires_at,
    resourceGrants: normalizeResourceSelections(pkg, registry, input.decisions, input.resource_selections),
    resourceRegistry: registry,
    receiptId: reference.receipt_id,
    now: new Date(reference.issued_at),
    ...overrides,
  };
}

/** The fields the Chrome receipt adds or names differently (D-053), ignored when comparing with the reference. */
const CHROME_ONLY = ["control_plane.service", "provenance", "receipt_sha256", "issued_at"];

describe("the reference semantics", () => {
  it("every declared permission starts denied and every declared tool unapproved", async () => {
    const pkg = await webair040();
    expect(Object.values(initialDecisions(pkg)).every((decision) => decision === "deny")).toBe(true);
    expect(Object.keys(initialDecisions(pkg)).sort()).toEqual(Object.keys(inputs().decisions).sort());
    expect(approvalCandidates(pkg)).toEqual(Object.keys(inputs().tool_approvals).sort());
    expect(Object.values(initialToolApprovals(pkg)).every((approved) => approved === false)).toBe(true);
  });

  it("the authorization request equals the reference's (permissions.json)", async () => {
    const pkg = await webair040();
    // The fixture was taken before authorization: every decision deny, every tool unapproved.
    const request = buildRequest(pkg, { sessionId: inputs().session.session_id, decisions: initialDecisions(pkg), toolApprovals: initialToolApprovals(pkg) });
    // The reference's /permissions adds the control plane's blocking reasons and policy to the request.
    expect(request).toEqual(without(fixture("permissions"), ["blocking_reasons", "browser_policy"]));
    const decided = buildRequest(pkg, { sessionId: inputs().session.session_id, decisions: inputs().decisions, toolApprovals: inputs().tool_approvals });
    expect(decided.permissions.map((item) => item.decision)).toEqual(["session", "session", "session", "session", "once", "session", "session"]);
    expect(decided.tool_approvals.every((item) => item.decision)).toBe(true);
    expect(request.decision_model.unsupported).toHaveProperty("always");
  });

  it("decisions are normalized strictly: unknown ids, 'always' and unknown words are refused; silence stays denied", async () => {
    const pkg = await webair040();
    expect(normalizeDecisions(pkg, null)).toEqual(initialDecisions(pkg));
    expect(normalizeDecisions(pkg, { "network.webair": "session" })).toMatchObject({ "network.webair": "session", "profile.travel": "deny" });
    expect(code(() => normalizeDecisions(pkg, { "no.such": "session" }))).toBe("unknown_permission");
    expect(code(() => normalizeDecisions(pkg, { "network.webair": "always" }))).toBe("unsupported_decision");
    expect(code(() => normalizeDecisions(pkg, { "network.webair": "forever" }))).toBe("invalid_decision");
    expect(code(() => normalizeDecisions(pkg, "session"))).toBe("invalid_request");
    expect(code(() => normalizeToolApprovals(pkg, { ghost: true }))).toBe("unknown_tool_approval");
    expect(code(() => normalizeToolApprovals(pkg, { "search-flights": "yes" }))).toBe("invalid_request");
    expect(normalizeToolApprovals(pkg, { "search-flights": true })).toMatchObject({ "search-flights": true, "prepare-booking": false });
  });

  it("inherited property names are not declared ids or decisions (review 1, finding 1)", async () => {
    const pkg = await webair040();
    // JSON.parse makes `__proto__` an own key, as a message from a view would carry it.
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(code(() => normalizeDecisions(pkg, JSON.parse(`{"${name}": "session"}`)))).toBe("unknown_permission");
      expect(code(() => normalizeToolApprovals(pkg, JSON.parse(`{"${name}": true}`)))).toBe("unknown_tool_approval");
      expect(code(() => normalizeDecisions(pkg, { "network.webair": name }))).toBe("invalid_decision");
    }
  });

  it("blocking reasons carry the reference's codes and subjects", async () => {
    const pkg = await webair040();
    const input = inputs();
    const base = { evaluation: input.session.evaluation as unknown as EvaluationLayers, publisher: input.session.publisher as unknown as PublisherReport, policy: DEFAULT_BROWSER_POLICY };
    expect(blockingReasons(pkg, { ...base, decisions: input.decisions })).toEqual([]);
    expect(blockingReasons(pkg, { ...base, decisions: initialDecisions(pkg) }).map((reason) => [reason.code, reason.subject])).toEqual([
      ["required_permission_denied", "network.webair"],
      ["required_permission_denied", "model.reasoning"],
      ["required_permission_denied", "memory.session"],
    ]);
    const unknown = { ...base.publisher, trust_status: "unknown" as const, trust_reason: "signer_key_not_pinned" };
    expect(blockingReasons(pkg, { ...base, publisher: unknown, decisions: input.decisions }).map((reason) => reason.code)).toEqual(["publisher_not_trusted"]);
    expect(blockingReasons(pkg, { ...base, publisher: unknown, decisions: input.decisions, policy: { ...DEFAULT_BROWSER_POLICY, require_trusted_publisher: false } })).toEqual([]);
  });

  it("the receipt equals the reference's for the same inputs, except the documented Chrome fields, and hashes as the reference hashes", async () => {
    const pkg = await webair040();
    const receipt = await buildReceipt(pkg, await receiptInputs());
    const reference = fixture<AuthorizationReceipt>("receipt");
    expect(without(receipt, CHROME_ONLY)).toEqual(without(reference, CHROME_ONLY));
    expect(receipt.runnable).toBe(true);
    expect(receipt.resource_grants).toHaveLength(3);
    // The reference's hash is reproducible with this canonicalizer, and ours is self-consistent.
    expect(await hashReceipt(reference)).toBe(reference.receipt_sha256);
    expect(await recordHashValid(receipt, "receipt_sha256")).toBe(true);
    // The service name and the provenance are the only additions.
    expect(receipt.control_plane.service).toBe("chrome-agent-browser-control-plane");
    expect(receipt.provenance).toBeNull();
    // The issued_at differs only by Python's ISO format (+00:00 vs Z) for the same instant.
    expect(new Date(receipt.issued_at).getTime()).toBe(new Date(reference.issued_at).getTime());
  });

  it("the reference records name the package by a repository-relative path, never a home directory (review 1, finding 7)", () => {
    const directory = join(PROJECT, "test", "fixtures");
    const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(8);
    // Nor a temporary directory of the generator's machine (T3 review 2, nit 21): the trust store is recorded as `trust.json`, nowhere.
    for (const name of files) expect(readFileSync(join(directory, name), "utf8"), name).not.toMatch(/\/(?:Users|home)\/|[A-Za-z]:\\\\|\/var\/folders|\/private\/var|\/tmp\//u);
    expect(inputs().session.trust_state.path).toBe("trust.json");
    expect(inputs().session.source.display).toBe("dist/webair-0.4.0.agent.pkg");
  });

  it("a receipt binds the exact bytes: a different archive hash or digest is a different receipt", async () => {
    const pkg = await webair040();
    const base = await buildReceipt(pkg, await receiptInputs());
    const other = await buildReceipt(pkg, await receiptInputs({ archiveSha256: "0".repeat(64) }));
    expect(other.receipt_sha256).not.toBe(base.receipt_sha256);
    const denied = await buildReceipt(pkg, await receiptInputs({ decisions: { ...inputs().decisions, "network.webair": "deny" }, resourceGrants: [] }));
    expect(denied.runnable).toBe(false);
    expect(denied.blocking_reasons.map((reason) => reason.code)).toEqual(["required_permission_denied"]);
    expect(denied.granted_permission_ids).not.toContain("network.webair");
  });
});

describe("profiles become decisions (D-022)", () => {
  it("'Search flights' grants its members and denies the booking tools and every personal resource, all decided by the profile", async () => {
    const pkg = await webair040();
    const profiles = readProfiles(pkg).profiles!;
    const search = profiles.find((profile) => profile.id === "search")!;
    const decided = profileDecisions(pkg, search, DEFAULT_PRESET);
    expect(decided.decisions).toEqual({
      "network.webair": "session",
      "model.reasoning": "session",
      "memory.session": "session",
      "profile.travel": "deny",
      "identity.passenger": "deny",
      "wallet.payment": "deny",
      "booking.simulate_purchase": "deny",
    });
    expect(decided.tool_approvals).toEqual({
      "search-flights": true,
      "get-fare-rules": true,
      "prepare-booking": false,
      "simulate-purchase": false,
      "personal.travel_profile": false,
      "personal.passenger_identity": false,
      "wallet.payment_method": false,
    });
    expect(decided.provenance).toMatchObject({ schema: "org.webagents:decision-provenance-v0", profile_id: "search", profile_title: "Search flights", preset: "balanced", resource_selections: {} });
    expect(new Set(Object.values(decided.provenance.decisions))).toEqual(new Set(["profile"]));
    expect(new Set(Object.values(decided.provenance.tool_approvals))).toEqual(new Set(["profile"]));
    // The receipt under these decisions is runnable: the required permissions are all members.
    const receipt = await buildReceipt(pkg, await receiptInputs({ decisions: decided.decisions, toolApprovals: decided.tool_approvals, resourceGrants: [], provenance: decided.provenance }));
    expect(receipt.runnable).toBe(true);
    expect(receipt.provenance?.profile_id).toBe("search");
  });

  it("'Book (simulated)' grants everything, with the payment permission single-use under every preset", async () => {
    const pkg = await webair040();
    const book = readProfiles(pkg).profiles!.find((profile) => profile.id === "book")!;
    for (const preset of ["privacy-first", "balanced", "convenience"] as const) {
      const decided = profileDecisions(pkg, book, preset);
      expect(decided.decisions["booking.simulate_purchase"]).toBe("once");
      expect(Object.values(decided.decisions).every((decision) => decision !== "deny")).toBe(true);
      expect(Object.values(decided.tool_approvals).every((approved) => approved)).toBe(true);
      expect(decided.decisions["identity.passenger"]).toBe(preset === "privacy-first" ? "once" : "session");
    }
  });

  it("the subset rule holds for the shipped profiles: the first is the least, and each profile's grants are within the next", async () => {
    const pkg = await webair040();
    const profiles = readProfiles(pkg).profiles!;
    const granted = (profile: (typeof profiles)[number]) => {
      const decided = profileDecisions(pkg, profile, DEFAULT_PRESET);
      return {
        permissions: Object.entries(decided.decisions).filter(([, decision]) => decision !== "deny").map(([id]) => id).sort(),
        tools: Object.entries(decided.tool_approvals).filter(([, approved]) => approved).map(([id]) => id).sort(),
      };
    };
    const [first, ...rest] = profiles.map(granted);
    for (const other of rest) {
      expect(first!.permissions.every((id) => other.permissions.includes(id))).toBe(true);
      expect(first!.tools.every((id) => other.tools.includes(id))).toBe(true);
    }
    expect(profiles.map((profile) => profile.id)).toEqual(["search", "quote", "book"]);
  });
});

describe("presets (D-050)", () => {
  it("define three tiers, each keeping payments single-use and offering no 'always'", () => {
    expect(Object.keys(PRESETS)).toEqual(["privacy-first", "balanced", "convenience"]);
    for (const preset of Object.values(PRESETS)) {
      expect(presetDuration(preset.id, "payment")).toBe("once");
      expect(Object.values(preset.durations)).not.toContain("always");
    }
    expect(PRESETS["privacy-first"].local_models_only).toBe(true);
    expect(PRESETS.balanced.local_models_only).toBe(false);
    expect(presetDuration("privacy-first", "personal.read")).toBe("once");
    expect(presetDuration("balanced", "personal.read")).toBe("session");
  });

  it("supply the customize view's defaults with 'preset' provenance: privacy-first denies every optional permission, convenience grants all but never picks a record", async () => {
    const pkg = await webair040();
    const privacy = defaultDecisions(pkg, "privacy-first");
    expect(privacy.decisions).toMatchObject({ "network.webair": "session", "model.reasoning": "session", "memory.session": "session", "profile.travel": "deny", "wallet.payment": "deny", "booking.simulate_purchase": "deny" });
    expect(privacy.tool_approvals).toMatchObject({ "search-flights": true, "get-fare-rules": true, "prepare-booking": false, "simulate-purchase": false, "personal.travel_profile": false });
    expect(new Set(Object.values(privacy.provenance.decisions))).toEqual(new Set(["preset"]));
    expect(privacy.provenance.profile_id).toBeNull();

    const balanced = defaultDecisions(pkg, "balanced");
    // WebAir's optional permissions are personal.read and payment, which balanced leaves to the person.
    expect(balanced.decisions).toEqual(privacy.decisions);

    const convenience = defaultDecisions(pkg, "convenience");
    expect(Object.values(convenience.decisions).every((decision) => decision !== "deny")).toBe(true);
    expect(convenience.decisions["booking.simulate_purchase"]).toBe("once");
    expect(Object.values(convenience.tool_approvals).every((approved) => approved)).toBe(true);
    expect(convenience.provenance.resource_selections).toEqual({});
  });

  it("normalizes a submitted provenance against the decisions it accompanies", async () => {
    const pkg = await webair040();
    const decisions = inputs().decisions;
    const approvals = inputs().tool_approvals;
    const raw: Provenance = {
      schema: "org.webagents:decision-provenance-v0",
      profile_id: "book",
      profile_title: "Book (simulated)",
      preset: "balanced",
      decisions: Object.fromEntries(Object.keys(decisions).map((id) => [id, "profile"])) as Record<string, "profile">,
      tool_approvals: Object.fromEntries(Object.keys(approvals).map((id) => [id, "profile"])) as Record<string, "profile">,
      resource_selections: { "profile.travel": "user", "identity.passenger": "user", "wallet.payment": "user" },
    };
    const grants = fixture<AuthorizationReceipt>("receipt").resource_grants;
    expect(normalizeProvenance(pkg, raw, decisions, approvals, grants)).toEqual(raw);
    expect(normalizeProvenance(pkg, null, decisions, approvals, grants)).toBeNull();
    expect(code(() => normalizeProvenance(pkg, { ...raw, preset: "yolo" }, decisions, approvals, grants))).toBe("invalid_request");
    expect(code(() => normalizeProvenance(pkg, { ...raw, decisions: { ...raw.decisions, ghost: "user" } }, decisions, approvals, grants))).toBe("invalid_request");
    expect(code(() => normalizeProvenance(pkg, { ...raw, decisions: { ...raw.decisions, "network.webair": "robot" } }, decisions, approvals, grants))).toBe("invalid_request");
    // A missing entry defaults to the person's own decision.
    expect(normalizeProvenance(pkg, { ...raw, decisions: {} }, decisions, approvals, grants)?.decisions["network.webair"]).toBe("user");
    void (0 as unknown as JsonObject);
  });

  it("believes a provenance claim only when the profile or the preset yields that exact decision (review 1, nit 8)", async () => {
    const pkg = await webair040();
    const search = readProfiles(pkg).profiles!.find((profile) => profile.id === "search")!;
    const decided = profileDecisions(pkg, search, "balanced");
    const all = (by: "profile" | "preset" | "user", record: Record<string, unknown>) => Object.fromEntries(Object.keys(record).map((id) => [id, by]));
    const raw = {
      schema: "org.webagents:decision-provenance-v0",
      profile_id: "search",
      profile_title: "A title the view made up",
      preset: "balanced",
      decisions: all("profile", decided.decisions),
      tool_approvals: all("profile", decided.tool_approvals),
      resource_selections: {},
    };
    // The person then grants the travel profile by hand, but the view still says "profile".
    const changed = { ...decided.decisions, "profile.travel": "session" as const };
    const registry = await normalizeResourceRegistry(inputs().resource_registry);
    const grants = normalizeResourceSelections(pkg, registry, changed, { "profile.travel": "profile_demo_traveler" });
    const normalized = normalizeProvenance(pkg, { ...raw, resource_selections: { "profile.travel": "profile" } }, changed, decided.tool_approvals, grants)!;
    expect(normalized.profile_title).toBe(search.title); // the package's title, never the view's
    expect(normalized.decisions["profile.travel"]).toBe("user"); // the profile denies it
    expect(normalized.decisions["network.webair"]).toBe("profile");
    expect(normalized.resource_selections).toEqual({ "profile.travel": "user" }); // picks are always the person's
    // An undeclared profile is no profile: every "profile" claim becomes the person's.
    const unknown = normalizeProvenance(pkg, { ...raw, profile_id: "everything" }, decided.decisions, decided.tool_approvals, [])!;
    expect([unknown.profile_id, unknown.profile_title]).toEqual([null, null]);
    expect(new Set(Object.values(unknown.decisions))).toEqual(new Set(["user"]));
    // A "preset" claim stands where the preset's defaults agree, and nowhere else.
    const defaults = defaultDecisions(pkg, "privacy-first");
    const claimed = normalizeProvenance(pkg, { ...raw, profile_id: null, preset: "privacy-first", decisions: all("preset", defaults.decisions), tool_approvals: all("preset", defaults.tool_approvals) }, { ...defaults.decisions, "model.reasoning": "once" }, defaults.tool_approvals, [])!;
    expect(claimed.decisions["network.webair"]).toBe("preset");
    expect(claimed.decisions["model.reasoning"]).toBe("user");
    expect(new Set(Object.values(claimed.tool_approvals))).toEqual(new Set(["preset"]));
    expect(code(() => normalizeProvenance(pkg, { ...raw, profile_id: 7 }, decided.decisions, decided.tool_approvals, []))).toBe("invalid_request");
    expect(code(() => normalizeProvenance(pkg, { ...raw, resource_selections: { "wallet.payment": "user" } }, decided.decisions, decided.tool_approvals, []))).toBe("invalid_request");
  });
});
