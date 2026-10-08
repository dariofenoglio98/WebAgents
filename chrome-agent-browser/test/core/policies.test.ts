/**
 * Policy bundles (T8, `spec/extensions/policy-bundle-v0.md`): the rules beyond the schema, trust
 * anchors behind the person's own store, decisions inside the profile and under the preset's
 * ceiling with `policy` provenance, binding allowlists, caps, model constraints, provenance
 * claims, plan staleness, and the invariant that a policy never grants more than the package
 * declares, the profile contains or the preset allows (random bundles).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultDecisions, normalizeProvenance, presetDuration, PRESET_IDS, profileDecisions, type Decided } from "../../src/core/authorization.js";
import { CoreError } from "../../src/core/errors.js";
import { DEFAULT_HOST_LIMITS } from "../../src/core/execution/limits.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { fingerprint } from "../../src/core/keys.js";
import type { Package } from "../../src/core/package.js";
import { anchorVerdict, applyPolicy, bindingAllowed, cappedLimits, decisionRank, modelPolicyReasons, PolicyTrust, type ActivePolicy, type ToolBindingFacts } from "../../src/core/policies/apply.js";
import { policyLabel, policyState, readPolicyBundle, type PolicyBundle } from "../../src/core/policies/bundle.js";
import { readProfiles, type Profile } from "../../src/core/profiles.js";
import { preflight } from "../../src/core/runplan.js";
import { MemoryTrustStorage, TrustStore } from "../../src/core/trust.js";
import type { Decision, PresetId } from "../../src/core/types.js";
import { literatureReview, webair040 } from "../helpers/fixtures.js";
import { ROOT, SHIPPED } from "../helpers/paths.js";
import { newSigner, rawKeyBase64 } from "../helpers/signing.js";
import { NOW, world } from "../helpers/world.js";

const CONTENT = JSON.parse(readFileSync(resolve(ROOT, "examples/policies/webagents-research.content.json"), "utf8")) as JsonObject;
const WEBAIR_ORIGIN = "https://webagents-webair-production.up.railway.app";

async function active(content: JsonObject = CONTENT): Promise<ActivePolicy> {
  const bundle = await readPolicyBundle(content);
  return { bundle, reference: { policy_id: bundle.policy_id, version: bundle.version, title: bundle.title, content_sha256: "f".repeat(64), signer_fingerprint: `sha256:${"9".repeat(64)}` } };
}

function variant(change: (content: Record<string, unknown>) => void): JsonObject {
  const copy = JSON.parse(JSON.stringify(CONTENT)) as Record<string, unknown>;
  change(copy);
  return copy as JsonObject;
}

/** The binding each declared tool would get, read from the declarations as the Chrome host binds them (D-054, D-081, D-082). */
function bindingFacts(pkg: Package): Record<string, ToolBindingFacts | null> {
  const facts: Record<string, ToolBindingFacts | null> = {};
  for (const [toolId, tool] of Object.entries(pkg.tools)) {
    if (tool.execution === "remote" && typeof tool.endpoint === "string") facts[toolId] = { kind: "json_http", origin: new URL(tool.endpoint).origin };
    else if (tool.binding === "host.selected-file" || String(tool.binding).includes("file")) facts[toolId] = { kind: "selected_file", origin: null };
    else facts[toolId] = { kind: "host_resource", origin: null };
  }
  return facts;
}

function profileOf(pkg: Package, id: string): Profile {
  return readProfiles(pkg).profiles!.find((profile) => profile.id === id)!;
}

function apply(pkg: Package, policy: ActivePolicy, preset: PresetId, profile: Profile | null): Decided {
  const base = profile ? profileDecisions(pkg, profile, preset) : defaultDecisions(pkg, preset);
  return applyPolicy(pkg, base, { policy, preset, profile, bindings: bindingFacts(pkg) });
}

describe("reading a bundle (spec §4)", () => {
  it("reads the research policy", async () => {
    const bundle = await readPolicyBundle(CONTENT);
    expect(bundle).toMatchObject({ policy_id: "org.webagents.research", version: "1.0.0", models: { local_only: false, max_cost_usd_per_run: null } });
    expect(bundle.budget_caps).toEqual({ total_tokens: 200000, max_remote_calls: 50, run_timeout_seconds: 4500 });
    expect(bundle.bindings?.allow.map((item) => item.kind)).toEqual(["json_http", "host_resource", "selected_file"]);
    expect(policyLabel(bundle)).toBe("org.webagents.research@1.0.0");
    expect(policyState(bundle, NOW)).toBe("not_yet_valid");
    expect(policyState(bundle, new Date("2026-10-09T00:00:00Z"))).toBe("current");
    expect(policyState(bundle, new Date("2028-01-01T00:00:00Z"))).toBe("expired");
  });

  it.each([
    ["a fingerprint that is not its key's", (c: Record<string, unknown>) => ((c.trust_anchors as JsonObject[])[0]!.fingerprint = `sha256:${"0".repeat(64)}`), /fingerprint is not its key's/u],
    ["a key anchored twice", (c: Record<string, unknown>) => (c.trust_anchors as JsonObject[]).push({ ...(c.trust_anchors as JsonObject[])[0]!, package_id_prefix: "org.other" }), /already anchored/u],
    ["a window that ends before it starts", (c: Record<string, unknown>) => (c.expires_at = "2026-01-01T00:00:00Z"), /expires_at/u],
  ])("refuses %s as a whole", async (_label, change, pattern) => {
    await expect(readPolicyBundle(variant(change))).rejects.toThrow(pattern);
  });
});

describe("trust anchors behind the person's own store", () => {
  const webairInput = { signerFingerprint: SHIPPED.webair040.fingerprint, claimedPublisherId: "webair-demo", packageId: "org.webagents.webair" };

  it("an anchored key is trusted for its scope, and the verdict names the policy", async () => {
    const policy = await active();
    const trust = new PolicyTrust(new TrustStore(new MemoryTrustStorage()), async () => policy);
    const verdict = await trust.evaluate(webairInput);
    expect(verdict).toMatchObject({ trust_status: "trusted", trust_reason: "policy_anchor", trust_entry: { fingerprint: SHIPPED.webair040.fingerprint, package_id_prefix: "org.webagents.webair", policy: "org.webagents.research@1.0.0" } });
  });

  it("outside its scope, or for a publisher it anchors to another key, it is a mismatch", async () => {
    const policy = await active();
    // The scope is a string prefix, exactly as an operator pin's `package_id_prefix` is (trust.py, D-006).
    expect(anchorVerdict(policy, { ...webairInput, packageId: "org.webagents.webair.v2" })).toMatchObject({ trust_status: "trusted" });
    expect(anchorVerdict(policy, { ...webairInput, packageId: "org.other.package" })).toMatchObject({ trust_status: "mismatch", trust_reason: "policy_package_id_outside_pinned_prefix" });
    expect(anchorVerdict(policy, { ...webairInput, signerFingerprint: `sha256:${"1".repeat(64)}` })).toMatchObject({ trust_status: "mismatch", trust_reason: "policy_claimed_publisher_pinned_to_other_key" });
    expect(anchorVerdict(policy, { ...webairInput, claimedPublisherId: "someone-else" })).toMatchObject({ trust_status: "mismatch", trust_reason: "policy_pinned_key_bound_to_other_publisher" });
    expect(anchorVerdict(policy, { ...webairInput, signerFingerprint: null })).toBeNull();
  });

  it("the person's store decides first: their pin, and their pin of the publisher to another key", async () => {
    const policy = await active();
    const own = newSigner();
    const store = new TrustStore(new MemoryTrustStorage());
    await store.add(own.publicKey, { displayName: "Someone else's WebAir", publisherId: "webair-demo" });
    // The person pinned webair-demo to another key: impersonation signal, whatever the policy says.
    expect(await new PolicyTrust(store, async () => policy).evaluate(webairInput)).toMatchObject({ trust_status: "mismatch", trust_reason: "claimed_publisher_pinned_to_other_key" });
    const pinned = new TrustStore(new MemoryTrustStorage());
    await pinned.add(Buffer.from((CONTENT.trust_anchors as JsonObject[])[0]!.public_key as string, "base64"), { displayName: "WebAir", publisherId: "webair-demo" });
    expect(await new PolicyTrust(pinned, async () => policy).evaluate(webairInput)).toMatchObject({ trust_status: "trusted", trust_reason: "operator_pinned_key" });
    // No policy: unknown, as before.
    expect(await new PolicyTrust(new TrustStore(new MemoryTrustStorage()), async () => null).evaluate(webairInput)).toMatchObject({ trust_status: "unknown", trust_reason: "signer_key_not_pinned" });
  });

  it("an issuer anchor confers no trust in v0 (D-101)", async () => {
    const issuer = newSigner();
    const content = variant((c) => (c.trust_anchors = []));
    (content.trust_anchors as JsonValue[]).push({ kind: "issuer", public_key: rawKeyBase64(issuer.publicKey), fingerprint: await fingerprint(issuer.publicKey), display_name: "A credential issuer", scope: { package_id_prefix: "org.webagents" } });
    const issuerOnly = await active(content);
    expect(issuerOnly.bundle.trust_anchors[0]?.kind).toBe("issuer");
    expect(anchorVerdict(issuerOnly, webairInput)).toBeNull();
    expect(anchorVerdict(issuerOnly, { ...webairInput, signerFingerprint: await fingerprint(issuer.publicKey) })).toBeNull();
  });
});

describe("decisions", () => {
  it("'Search flights' under the research policy: the members are decided by the policy, the rest stays the profile's", async () => {
    const pkg = await webair040();
    const policy = await active();
    const decided = apply(pkg, policy, "balanced", profileOf(pkg, "search"));
    const base = profileDecisions(pkg, profileOf(pkg, "search"), "balanced");
    expect(decided.decisions).toEqual(base.decisions);
    expect(decided.tool_approvals).toEqual(base.tool_approvals);
    expect(decided.provenance.decisions).toEqual({
      "booking.simulate_purchase": "profile",
      "identity.passenger": "profile",
      "memory.session": "policy",
      "model.reasoning": "policy",
      "network.webair": "policy",
      "profile.travel": "profile",
      "wallet.payment": "profile",
    });
    expect(new Set(Object.values(decided.provenance.tool_approvals))).toEqual(new Set(["profile"]));
    expect(decided.provenance.policy).toEqual(policy.reference);
    expect(decided.provenance.profile_id).toBe("search");
  });

  it("is lowered to the person's ceiling: payment never above once, personal data once under privacy-first", async () => {
    const pkg = await webair040();
    const generous = await active(variant((c) => (c.decisions = { network: "session", model: "session", memory: "session", "personal.read": "session", payment: "session" })));
    const book = apply(pkg, generous, "privacy-first", profileOf(pkg, "book"));
    expect(book.decisions["booking.simulate_purchase"]).toBe("once");
    expect(book.decisions["profile.travel"]).toBe("once");
    expect(book.decisions["network.webair"]).toBe("session");
    expect(apply(pkg, generous, "balanced", profileOf(pkg, "book")).decisions["profile.travel"]).toBe("session");
  });

  it("the research policy denies payment inside 'Book', and the purchase tool follows", async () => {
    const pkg = await webair040();
    const decided = apply(pkg, await active(), "balanced", profileOf(pkg, "book"));
    expect(decided.decisions["booking.simulate_purchase"]).toBe("deny");
    expect(decided.provenance.decisions["booking.simulate_purchase"]).toBe("policy");
    expect(decided.tool_approvals["simulate-purchase"]).toBe(false);
    expect(decided.provenance.tool_approvals["simulate-purchase"]).toBe("policy");
    expect(decided.decisions["profile.travel"]).toBe("once");
  });

  it("a binding allowlist that does not admit the airline's origin leaves its tools unapproved, by the policy", async () => {
    const pkg = await webair040();
    const narrow = await active(variant((c) => (c.bindings = { allow: [{ kind: "json_http", origins: ["https://api.crossref.org"] }, { kind: "host_resource" }] })));
    const decided = apply(pkg, narrow, "balanced", profileOf(pkg, "search"));
    expect(decided.tool_approvals["search-flights"]).toBe(false);
    expect(decided.provenance.tool_approvals["search-flights"]).toBe("policy");
    expect(bindingAllowed(narrow.bundle, { kind: "json_http", origin: WEBAIR_ORIGIN })).toBe(false);
    expect(bindingAllowed(narrow.bundle, { kind: "host_resource", origin: null })).toBe(true);
    expect(bindingAllowed(narrow.bundle, null)).toBe(false);
    expect(bindingAllowed((await active(variant((c) => delete c.bindings))).bundle, null)).toBe(true);
  });

  it("without a profile the policy decides every kind it names, and the tools follow the permissions", async () => {
    const pkg = await literatureReview();
    const decided = apply(pkg, await active(), "privacy-first", null);
    for (const [id, by] of Object.entries(decided.provenance.decisions)) expect(by).toBe("policy");
    expect(Object.values(decided.decisions).every((decision) => decision !== "deny")).toBe(true);
    expect(decided.decisions["files.pdfs"]).toBe("once");
    expect(Object.values(decided.tool_approvals).every(Boolean)).toBe(true);
  });

  it("never grants more than the package declares, the profile contains or the preset allows (random bundles)", async () => {
    const packages = [await webair040(), await literatureReview()];
    const decisions: Array<Decision | undefined> = ["deny", "once", "session", undefined];
    const kinds = ["network", "files.read", "files.write", "model", "memory", "shell", "payment", "personal.read"];
    let seed = 20261008;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let checked = 0;
    for (let round = 0; round < 60; round += 1) {
      const rule: Record<string, Decision> = {};
      for (const kind of kinds) {
        const pick = decisions[Math.floor(random() * decisions.length)];
        if (pick !== undefined) rule[kind] = pick;
      }
      const allow = random() < 0.5 ? undefined : { allow: [{ kind: "json_http", origins: random() < 0.5 ? [WEBAIR_ORIGIN] : ["https://api.crossref.org"] }, ...(random() < 0.5 ? [{ kind: "host_resource" }] : [])] };
      const policy = await active(variant((c) => ((c.decisions = rule), allow === undefined ? delete c.bindings : (c.bindings = allow))));
      for (const pkg of packages) {
        const facts = bindingFacts(pkg);
        const profiles = [null, ...(readProfiles(pkg).profiles ?? [])];
        for (const preset of PRESET_IDS) {
          for (const profile of profiles) {
            const decided = apply(pkg, policy, preset, profile);
            const declared = (pkg.policy.permissions as JsonObject[]).map((permission) => String(permission.id)).sort();
            expect(Object.keys(decided.decisions).sort()).toEqual(declared);
            expect(Object.keys(decided.tool_approvals).sort()).toEqual(Object.keys(pkg.tools).sort());
            for (const permission of pkg.policy.permissions as JsonObject[]) {
              const id = String(permission.id);
              const decision = decided.decisions[id]!;
              expect(decisionRank(decision)).toBeLessThanOrEqual(decisionRank(presetDuration(preset, String(permission.kind))));
              if (profile && !profile.permissions.includes(id)) expect(decision).toBe("deny");
              if (permission.kind === "payment") expect(decision).not.toBe("session");
            }
            for (const [toolId, approved] of Object.entries(decided.tool_approvals)) {
              if (!approved) continue;
              if (profile) expect(profile.tools).toContain(toolId);
              expect(bindingAllowed(policy.bundle, facts[toolId] ?? null)).toBe(true);
              const linked = (pkg.tools[toolId]!.permissions as JsonValue[]).map(String);
              for (const id of linked) expect(decided.decisions[id]).not.toBe("deny");
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("caps and models", () => {
  it("caps only lower the person's limits", () => {
    expect(cappedLimits(DEFAULT_HOST_LIMITS, { total_tokens: 200000, max_remote_calls: 10 })).toEqual({ ...DEFAULT_HOST_LIMITS, max_remote_calls: 10 });
    expect(cappedLimits(DEFAULT_HOST_LIMITS, null)).toEqual(DEFAULT_HOST_LIMITS);
  });

  it("local_only and a cost cap refuse what the browser cannot keep within them", async () => {
    const strict = await active(variant((c) => (c.models = { local_only: true, max_cost_usd_per_run: 0.5 })));
    const hosted = { id: "openai/gpt-5.6-luna", properties: { local: false, cost_class: "metered" } };
    expect(modelPolicyReasons(strict, hosted).map((reason) => reason.code)).toEqual(["model_not_local", "model_cost_unbounded"]);
    expect(modelPolicyReasons(strict, { id: "ollama/qwen3:30b", properties: { local: true, cost_class: "free" } })).toEqual([]);
    expect(modelPolicyReasons(await active(), hosted)).toEqual([]);
    expect(modelPolicyReasons(null, hosted)).toEqual([]);
  });
});

describe("provenance claims under a policy (D-102)", () => {
  it("a policy claim stands only where the policy in force decided that very item", async () => {
    const pkg = await webair040();
    const policy = await active();
    const search = profileOf(pkg, "search");
    const decided = apply(pkg, policy, "balanced", search);
    const expand = (profile: Profile | null, preset: PresetId) => apply(pkg, policy, preset, profile);
    const normalized = normalizeProvenance(pkg, decided.provenance, decided.decisions, decided.tool_approvals, [], { policy: { reference: policy.reference, expand } })!;
    expect(normalized.decisions).toEqual(decided.provenance.decisions);
    expect(normalized.policy).toEqual(policy.reference);
    // The person changed memory to once: their decision, not the policy's.
    const overridden = { ...decided.decisions, "memory.session": "once" as const };
    expect(normalizeProvenance(pkg, decided.provenance, overridden, decided.tool_approvals, [], { policy: { reference: policy.reference, expand } })!.decisions["memory.session"]).toBe("user");
    // A policy claim on an item the policy did not decide, or with no policy in force, is the person's.
    expect(normalizeProvenance(pkg, { ...decided.provenance, decisions: { ...decided.provenance.decisions, "profile.travel": "policy" } }, decided.decisions, decided.tool_approvals, [], { policy: { reference: policy.reference, expand } })!.decisions["profile.travel"]).toBe("user");
    const without = normalizeProvenance(pkg, decided.provenance, decided.decisions, decided.tool_approvals, [])!;
    expect(without.decisions["network.webair"]).toBe("user");
    expect(without).not.toHaveProperty("policy");
    expect(() => normalizeProvenance(pkg, { ...decided.provenance, decisions: { "network.webair": "institution" } }, decided.decisions, decided.tool_approvals, [])).toThrow(CoreError);
  });
});

describe("plan staleness (D-102)", () => {
  it("a plan authorized under a policy goes stale when the policy is withdrawn or replaced; a policy's model constraint applies to any plan", async () => {
    const w = await world();
    const policy = await active();
    const plan = { ...w.plan, authorization: { ...w.plan.authorization, provenance: { schema: "org.webagents:decision-provenance-v0", profile_id: null, profile_title: null, preset: "balanced", decisions: {}, tool_approvals: {}, resource_selections: {}, policy: policy.reference } } } as typeof w.plan;
    const pkg = await webair040();
    const base = { pkg, publisher: w.publisher, receipt: w.receipt, trustState: w.planInputs.trustState, policy: w.policy, toolEvaluation: w.toolEvaluation, resourceRegistry: w.resourceRegistry, catalog: w.catalog, now: NOW };
    const codes = (state: ReturnType<typeof preflight>) => state.stale_reasons.map((reason) => reason.code);
    expect(codes(preflight(plan, { ...base, subscription: policy }))).toEqual([]);
    expect(codes(preflight(plan, { ...base }))).toEqual([]); // a caller that does not take part
    expect(codes(preflight(plan, { ...base, subscription: null }))).toEqual(["policy_withdrawn"]);
    const newer = { ...policy, reference: { ...policy.reference, version: "1.0.1", content_sha256: "e".repeat(64) } };
    expect(codes(preflight(plan, { ...base, subscription: newer }))).toEqual(["policy_changed"]);
    // A plan made without a policy is not stale when one is added, unless its model is not admitted.
    expect(codes(preflight(w.plan, { ...base, subscription: policy }))).toEqual([]);
    const localOnly = await active(variant((c) => (c.models = { local_only: true })));
    const local = w.plan.model_binding?.descriptor.properties as { local?: boolean } | undefined;
    expect(codes(preflight(w.plan, { ...base, subscription: localOnly }))).toEqual(local?.local === true ? [] : ["model_not_local"]);
  });
});

describe("the bundle itself", () => {
  it("a bundle's own decisions never include always (schema)", async () => {
    const { extensionSchemaFailure } = await import("../../src/core/schema.js");
    expect(await extensionSchemaFailure(variant((c) => ((c.decisions as JsonObject).network = "always")), "policy-bundle-v0")).not.toBeNull();
    expect(await extensionSchemaFailure(CONTENT, "policy-bundle-v0")).toBeNull();
    const bundle: PolicyBundle = await readPolicyBundle(CONTENT);
    expect(Object.keys(bundle.decisions).sort()).toEqual(["files.read", "files.write", "memory", "model", "network", "payment", "personal.read", "shell"]);
  });
});
