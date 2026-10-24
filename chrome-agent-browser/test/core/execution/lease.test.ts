/**
 * Execution leases (`test_browser_lease.py` and the plugin's preflight): a lease is a private,
 * verified copy issued only against a plan that is ready right now; one outstanding per session;
 * consumable once; `once` is spent by the first lease; staleness of any kind refuses, including
 * a tool implementation that changed, a resource that changed and a model no longer offered.
 */
import { describe, expect, it } from "vitest";

import type { ExecutionError } from "../../../src/core/execution/errors.js";
import { LeaseRegistry, type LeaseInputs } from "../../../src/core/execution/lease.js";
import { preflight } from "../../../src/core/runplan.js";
import { bindingDigest, definitionsFromRegistry, describeDefinition } from "../../../src/core/tools/definitions.js";
import { MemoryResourceStore } from "../../../src/core/tools/resources.js";
import type { RunPlanPreflight } from "../../../src/core/types.js";
import { demoHostResources, inputs, webair040 } from "../../helpers/fixtures.js";
import { readBytes, SHIPPED } from "../../helpers/paths.js";
import { NOW, world, type World } from "../../helpers/world.js";

const ARCHIVE = readBytes(SHIPPED.webair040.archive);

async function ready(w: World, registry: LeaseRegistry, overrides: Partial<Parameters<typeof preflight>[1]> = {}): Promise<RunPlanPreflight> {
  const pkg = await webair040();
  return preflight(w.plan, { pkg, publisher: w.publisher, receipt: w.receipt, trustState: inputs().session.trust_state, policy: w.policy, toolEvaluation: w.toolEvaluation, resourceRegistry: w.resourceRegistry, catalog: w.catalog, now: NOW, onceSpent: registry.onceSpent(w.plan), ...overrides });
}

async function refusal(promise: Promise<unknown>): Promise<ExecutionError> {
  try {
    await promise;
  } catch (error) {
    return error as ExecutionError;
  }
  throw new Error("expected a refusal");
}

/** The vault the fixture registry was recorded from: the demo host's records under the fixture's key. */
async function store(): Promise<MemoryResourceStore> {
  const demo = demoHostResources();
  return MemoryResourceStore.load({ schema: "openclaw-host-resources-v0", types: demo.types, resources: demo.resources }, { key: new Uint8Array(32).fill(7) });
}

describe("issuing a lease", () => {
  it("copies and re-verifies the exact snapshot against a ready plan, and reports what it re-checked", async () => {
    const w = await world();
    const registry = new LeaseRegistry({ ttlSeconds: 900 });
    const state = await ready(w, registry);
    expect(state.ready).toBe(true);
    const lease = await registry.issue({ plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW, sessionExpiresAt: w.plan.expires_at });
    expect(lease.archive_sha256).toBe(w.plan.package.archive_sha256);
    expect(lease.package.digest).toBe(w.plan.package.digest);
    expect(lease.evidence.signer_fingerprint).toBe(w.plan.publisher.signer_fingerprint);
    expect(lease.archive).not.toBe(ARCHIVE);
    expect(lease.archive_bytes).toBe(ARCHIVE.length);
    expect(lease.consumed).toBe(false);
    expect(lease.revalidated).toEqual(expect.arrayContaining(["preflight_ready", "once_not_spent", "artifact:publisher_signature", "artifact:signer_fingerprint"]));
    // The TTL never outlives the session.
    expect(Date.parse(lease.expires_at)).toBeLessThanOrEqual(Date.parse(w.plan.expires_at));
    expect(registry.outstanding(NOW)).toHaveLength(1);
    // The recorded receipt grants the purchase `once`: the first lease spends it.
    expect(registry.onceSpent(w.plan)).toBe(true);
    expect(registry.spentReceipts()).toEqual([w.plan.authorization.receipt_id]);
  });

  it("refuses a stale or blocked plan, a plan the preflight does not describe, and a second lease for the same session", async () => {
    const w = await world();
    const registry = new LeaseRegistry();
    const state = await ready(w, registry);
    const other = { ...state, run_plan_sha256: "0".repeat(64) };
    expect((await refusal(registry.issue({ plan: w.plan, preflight: other, archive: ARCHIVE, now: NOW }))).code).toBe("run_plan_mismatch");
    const stale = await ready(w, registry, { pkg: { digest: "0".repeat(64) } as never });
    const refused = await refusal(registry.issue({ plan: w.plan, preflight: stale, archive: ARCHIVE, now: NOW }));
    expect(refused.code).toBe("run_plan_stale");
    expect(refused.message).toMatch(/not the planned bytes/u);
    expect(registry.outstanding(NOW)).toHaveLength(0);
    // One outstanding lease per session (a session-only receipt, so `once` plays no part here).
    const plain = await world({ decisions: Object.fromEntries(Object.keys(inputs().decisions).map((pid) => [pid, "session" as const])) });
    const single = new LeaseRegistry();
    const ok = await ready(plain, single);
    await single.issue({ plan: plain.plan, preflight: ok, archive: ARCHIVE, now: NOW });
    expect((await refusal(single.issue({ plan: plain.plan, preflight: ok, archive: ARCHIVE, now: NOW }))).code).toBe("execution_lease_active");
  });

  it("`once` is spent by the first lease: the preflight says so and the registry refuses on its own too", async () => {
    const w = await world();
    const registry = new LeaseRegistry();
    const first = await registry.issue({ plan: w.plan, preflight: await ready(w, registry), archive: ARCHIVE, now: NOW });
    registry.release(first.lease_id);
    const again = await ready(w, registry);
    expect(again.stale_reasons.map((reason) => reason.code)).toEqual(["authorization_once_spent"]);
    expect((await refusal(registry.issue({ plan: w.plan, preflight: again, archive: ARCHIVE, now: NOW }))).code).toBe("authorization_once_spent");
    // A registry restored from the persisted spent set refuses the same way, even with a forged "ready" preflight.
    const restored = new LeaseRegistry({ spentReceipts: registry.spentReceipts() });
    const forged = await ready(w, new LeaseRegistry());
    expect(forged.ready).toBe(true);
    expect((await refusal(restored.issue({ plan: w.plan, preflight: forged, archive: ARCHIVE, now: NOW }))).code).toBe("authorization_once_spent");
    // A receipt without a `once` grant is never spent.
    const sessionOnly = await world({ decisions: Object.fromEntries(Object.keys(inputs().decisions).map((pid) => [pid, "session" as const])) });
    const plain = new LeaseRegistry();
    await plain.issue({ plan: sessionOnly.plan, preflight: await ready(sessionOnly, plain), archive: ARCHIVE, now: NOW });
    expect(plain.onceSpent(sessionOnly.plan)).toBe(false);
  });

  it("a conversation's later turn is leased under the receipt it spent itself, and still refused for any other reason (T24 review 1 nit 8)", async () => {
    const w = await world();
    const registry = new LeaseRegistry();
    registry.release((await registry.issue({ plan: w.plan, preflight: await ready(w, registry), archive: ARCHIVE, now: NOW })).lease_id);
    const spent = await ready(w, registry);
    const lease = await registry.issue({ plan: w.plan, preflight: spent, archive: ARCHIVE, now: NOW, spentByConversation: true });
    expect(lease.revalidated).toContain("once_spent_by_this_conversation");
    registry.release(lease.lease_id);
    // Not ready for another reason as well, with the stale list holding only the spent receipt: the blocking reasons refuse.
    const blocked: RunPlanPreflight = { ...spent, ready: false, blocking_reasons: [...spent.blocking_reasons, { code: "secret_missing", message: "The provider key is missing.", subject: null }] };
    const refused = await refusal(registry.issue({ plan: w.plan, preflight: blocked, archive: ARCHIVE, now: NOW, spentByConversation: true }));
    expect(refused.code).toBe("run_plan_stale");
    expect(refused.message).toBe("The provider key is missing.");
    // Not ready with no reason at all: refused, never assumed ready.
    expect((await refusal(registry.issue({ plan: w.plan, preflight: { ...spent, ready: false, stale_reasons: [], blocking_reasons: [] }, archive: ARCHIVE, now: NOW, spentByConversation: true }))).code).toBe("run_plan_stale");
  });

  it("refuses bytes that are not the planned archive, and a receipt that would lapse during the run", async () => {
    const w = await world();
    const registry = new LeaseRegistry();
    const state = await ready(w, registry);
    const otherBytes = readBytes(SHIPPED.webair.archive);
    expect((await refusal(registry.issue({ plan: w.plan, preflight: state, archive: otherBytes, now: NOW }))).code).toBe("execution_artifact_mismatch");
    const flipped = new Uint8Array(ARCHIVE);
    flipped[flipped.length - 1] ^= 1;
    expect((await refusal(registry.issue({ plan: w.plan, preflight: state, archive: flipped, now: NOW }))).code).toBe("execution_artifact_mismatch");
    const remaining = (Date.parse(w.plan.authorization.expires_at) - NOW.getTime()) / 1000;
    expect(remaining).toBeGreaterThan(0);
    const expiring = await refusal(registry.issue({ plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW, minimumReceiptRemainingSeconds: remaining + 60 }));
    expect(expiring.code).toBe("authorization_expiring");
    const ok = await registry.issue({ plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW, minimumReceiptRemainingSeconds: Math.floor(remaining) - 1 });
    expect(ok.revalidated).toContain("receipt_outlasts_run_deadline");
  });

  it("the registry's definitions digest exactly as the plan's bindings, and a changed or removed implementation refuses", async () => {
    const w = await world();
    const definitions = definitionsFromRegistry(w.toolRegistry);
    expect(definitions).toHaveLength(w.plan.tool_bindings.length);
    for (const binding of w.plan.tool_bindings) {
      const definition = definitions.find((item) => item.id === binding.binding_id)!;
      expect(bindingDigest(describeDefinition(definition)), binding.tool_id).toBe(binding.binding_sha256);
    }
    const registry = new LeaseRegistry();
    const state = await ready(w, registry);
    const base: LeaseInputs = { plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW, definitions };
    const lease = await registry.issue(base);
    expect(lease.revalidated).toContain(`tool_bindings:${w.plan.tool_bindings.length}`);
    registry.release(lease.lease_id);
    const fresh = new LeaseRegistry();
    const changed = definitions.map((definition) => (definition.toolId === "search-flights" ? { ...definition, path: "/api/v2/search" } : definition));
    expect((await refusal(fresh.issue({ ...base, definitions: changed }))).code).toBe("tool_binding_stale");
    expect((await refusal(fresh.issue({ ...base, definitions: definitions.filter((definition) => definition.toolId !== "search-flights") }))).code).toBe("tool_binding_stale");
  });

  it("a granted resource must still be the record that was chosen, and the planned model must still be offered", async () => {
    const w = await world();
    expect(w.plan.resource_grants.length).toBeGreaterThan(0);
    const resolver = await store();
    // The fixture registry's digests are the Python demo host's, not this store's: the grant no longer matches.
    const registry = new LeaseRegistry();
    const state = await ready(w, registry);
    const refused = await refusal(registry.issue({ plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW, resolver }));
    expect(refused.code).toBe("run_plan_stale");
    expect(refused.message).toMatch(/changed|no longer exists/u);
    expect((await refusal(registry.issue({ plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW, resolver: { resolve: () => ({}), sealedValues: () => new Map(), describe: () => undefined } }))).message).toMatch(/no longer exists/u);
    // Without a store the registry relies on the preflight's registry comparison, which already passed.
    const unchecked = await registry.issue({ plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW });
    expect(unchecked.revalidated.some((item) => item.startsWith("resource_grants:"))).toBe(false);
    // A resolver that still holds exactly the granted records passes (a fresh registry: the one above spent the `once` grant).
    const holding = { resolve: () => ({}), sealedValues: () => new Map(), describe: (id: string) => { const grant = w.plan.resource_grants.find((item) => item.resource_id === id)!; return { id, type: grant.resource_type, label: "x", digest: grant.resource_digest }; } };
    const lease = await new LeaseRegistry().issue({ plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW, resolver: holding, modelAvailable: () => true });
    expect(lease.revalidated).toEqual(expect.arrayContaining([`resource_grants:${w.plan.resource_grants.length}`, "model_still_available"]));
    expect((await refusal(new LeaseRegistry().issue({ plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW, resolver: holding, modelAvailable: () => false }))).code).toBe("selected_model_unavailable");
  });
});

describe("two issues at the same time (review 1, blocker 1)", () => {
  const kinds = (settled: PromiseSettledResult<unknown>[]) => settled.map((result) => (result.status === "fulfilled" ? "lease" : (result.reason as ExecutionError).code));

  it("a `once` receipt is spent by the first of two concurrent issues; the second is refused before any await", async () => {
    const w = await world();
    const registry = new LeaseRegistry();
    const state = await ready(w, registry);
    const input = { plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW };
    const settled = await Promise.allSettled([registry.issue(input), registry.issue(input)]);
    expect(kinds(settled)).toEqual(["lease", "authorization_once_spent"]);
    expect(registry.outstanding(NOW)).toHaveLength(1);
    expect(registry.spentReceipts()).toEqual([w.plan.authorization.receipt_id]);
  });

  it("one session gets one lease even when two issues interleave", async () => {
    const plain = await world({ decisions: Object.fromEntries(Object.keys(inputs().decisions).map((pid) => [pid, "session" as const])) });
    const registry = new LeaseRegistry();
    const state = await ready(plain, registry);
    const input = { plan: plain.plan, preflight: state, archive: ARCHIVE, now: NOW };
    const settled = await Promise.allSettled([registry.issue(input), registry.issue(input)]);
    expect(kinds(settled)).toEqual(["lease", "execution_lease_active"]);
    expect(registry.outstanding(NOW)).toHaveLength(1);
    // The reservation is gone with the lease: after a release the session can lease again.
    registry.release(registry.outstanding(NOW)[0]!.lease_id);
    expect((await registry.issue(input)).session_id).toBe(plain.plan.session_id);
  });

  it("a refused issue releases its reservation; the concurrent second is refused closed, a later one succeeds", async () => {
    const w = await world();
    const registry = new LeaseRegistry();
    const state = await ready(w, registry);
    const good = { plan: w.plan, preflight: state, archive: ARCHIVE, now: NOW };
    const settled = await Promise.allSettled([registry.issue({ ...good, archive: readBytes(SHIPPED.webair.archive) }), registry.issue(good)]);
    expect(kinds(settled)).toEqual(["execution_artifact_mismatch", "authorization_once_spent"]);
    expect(registry.outstanding(NOW)).toHaveLength(0);
    expect(registry.spentReceipts()).toEqual([]);
    const lease = await registry.issue(good);
    expect(lease.consumed).toBe(false);
    expect(registry.spentReceipts()).toEqual([w.plan.authorization.receipt_id]);
  });
});

describe("consuming and releasing", () => {
  it("a lease is consumed once, for its own plan, before it expires; release drops it", async () => {
    const w = await world();
    const registry = new LeaseRegistry({ ttlSeconds: 60 });
    const lease = await registry.issue({ plan: w.plan, preflight: await ready(w, registry), archive: ARCHIVE, now: NOW });
    expect(() => registry.consume(lease.lease_id, { run_plan_id: "other", run_plan_sha256: w.plan.run_plan_sha256 }, NOW)).toThrow(/different run plan/u);
    const taken = registry.consume(lease.lease_id, w.plan, NOW);
    expect(taken.consumed).toBe(true);
    expect(taken.package.digest).toBe(w.plan.package.digest);
    expect(() => registry.consume(lease.lease_id, w.plan, NOW)).toThrow(/already consumed/u);
    expect(registry.release(lease.lease_id)).toBe(true);
    expect(registry.release(lease.lease_id)).toBe(false);
    expect(() => registry.consume(lease.lease_id, w.plan, NOW)).toThrow(/No outstanding/u);
    // An expired lease is swept and cannot be consumed.
    const second = new LeaseRegistry({ ttlSeconds: 60 });
    const late = await second.issue({ plan: w.plan, preflight: await ready(w, second), archive: ARCHIVE, now: NOW });
    expect(() => second.consume(late.lease_id, w.plan, new Date(NOW.getTime() + 61_000))).toThrow(/No outstanding/u);
    expect(second.outstanding(new Date(NOW.getTime() + 61_000))).toHaveLength(0);
  });
});
