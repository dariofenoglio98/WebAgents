/**
 * The secret store in the extension (T16, D-191, D-192, D-195): no clear key or record is ever
 * written to `chrome.storage.local`; the migration moves 0.1.0's clear values into the envelope
 * and removes them; a locked store refuses to prepare a plan that needs a record or a hosted key
 * with `store_locked`, while a plan that needs nothing from it runs; the idle lock applies to the
 * controller's reads; forgetting wipes the envelope.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { SecretEnvelope } from "../../src/core/secrets.js";
import type { AuthorizationView, AuthorizeResult, RunReadiness, RunView, SecretsView, SessionView, SettingsView, StatusInfo, VaultView } from "../../src/extension/messages.js";
import { SHIPPED } from "../helpers/paths.js";
import { makeHarness, PAGE, SEED_PASSPHRASE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";
import { scriptedOllama, scriptedOrigin, webairModelAnswers } from "../helpers/host.js";

const QWEN = "ollama/qwen3:30b";
const PICKS = { "profile.travel": "profile_demo_traveler", "identity.passenger": "passenger_demo_alex" };

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

async function trustedSession(h: Harness): Promise<SessionView> {
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "test" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
  current.settings.models.default_model = QWEN;
  await h.controller.handle({ type: "settings.set", settings: current.settings }, PAGE);
  return view;
}

describe("no passphrase yet (strict, the T16 gate)", () => {
  it("keys and records cannot be saved or read, the status says so, and the migration moves 0.1.0's clear values on setup", async () => {
    const h = makeHarness({ secrets: "none" });
    // What 0.1.0 left behind, in clear.
    await h.settingsArea.set({ providerKeys: { openai: "sk-legacy-key", bogus: "ignored" }, vault: { schema: "chrome-agent-browser-vault-v0", types: [], records: [] }, vaultKey: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") });
    const status = (await h.controller.handle({ type: "secrets.status" }, PAGE)) as SecretsView;
    expect(status).toMatchObject({ state: "no_passphrase", migration_pending: true, legacy: { providers: ["openai"], records: 0 }, entries: [] });
    expect((await refused(h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-new" }, PAGE))).code).toBe("store_no_passphrase");
    expect((await refused(h.controller.handle({ type: "vault.get" }, PAGE))).code).toBe("store_no_passphrase");
    expect(((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).keys).toEqual({});
    expect(((await h.controller.handle({ type: "status.get" }, PAGE)) as StatusInfo).secrets).toBe("no_passphrase");
    expect((await refused(h.controller.handle({ type: "secrets.setup", passphrase: "short" }, PAGE))).code).toBe("passphrase_weak");
    const set = (await h.controller.handle({ type: "secrets.setup", passphrase: "a passphrase of my own" }, PAGE)) as SecretsView;
    expect(set).toMatchObject({ state: "unlocked", migration_pending: false, legacy: null, entries: ["provider_key:openai", "vault", "vault_key"] });
    // The clear values are gone from storage.local; the envelope holds them encrypted; the key is usable.
    expect([...h.settingsArea.data.keys()]).toEqual([]);
    expect(JSON.stringify(h.envelope.value)).not.toContain("sk-legacy-key");
    expect(Object.keys((h.envelope.value as SecretEnvelope).entries).sort()).toEqual(["provider_key:openai", "vault", "vault_key"]);
    expect(await h.settings.key("openai")).toBe("sk-legacy-key");
    expect((await h.settings.vaultKey())[0]).toBe(7);
    expect(((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).keys).toEqual({ openai: true });
    expect((await refused(h.controller.handle({ type: "secrets.setup", passphrase: "another passphrase" }, PAGE))).code).toBe("store_exists");
    expect(h.events).toContainEqual({ type: "event.secrets" });
  });

  it("a fresh install sets up with nothing to migrate", async () => {
    const h = makeHarness({ secrets: "none" });
    const status = (await h.controller.handle({ type: "secrets.status" }, PAGE)) as SecretsView;
    expect(status).toMatchObject({ state: "no_passphrase", migration_pending: false, legacy: null });
    await h.controller.handle({ type: "secrets.setup", passphrase: "a passphrase of my own" }, PAGE);
    const vault = (await h.controller.handle({ type: "vault.get" }, PAGE)) as VaultView;
    expect(vault.types.length).toBeGreaterThan(0);
    expect(vault.records).toEqual([]);
  });
});

describe("locked", () => {
  it("records cannot be chosen or read, a hosted key cannot be used, and the authorization view says so without failing", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-test-not-a-real-key" }, PAGE);
    await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE);
    const session = await trustedSession(h);
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    expect(((await h.controller.handle({ type: "status.get" }, PAGE)) as StatusInfo).secrets).toBe("locked");
    expect(((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).keys).toEqual({ openai: true }); // presence is readable
    expect((await refused(h.controller.handle({ type: "vault.get" }, PAGE))).code).toBe("store_locked");
    expect((await refused(h.controller.handle({ type: "settings.setKey", provider: "anthropic", key: "sk-ant" }, PAGE))).code).toBe("store_locked");
    const view = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    expect(view.secrets).toBe("locked");
    expect(view.resources.requests.every((request) => request.options.length === 0)).toBe(true);
    expect(view.missing_resource_types).toEqual([]);
    // A profile that needs records: the picks cannot be made (store_locked), not "no record".
    const quote = await refused(h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "quote", resourceSelections: PICKS, prepare: true }, PAGE));
    expect(quote.code).toBe("store_locked");
    // A plan on a hosted model whose key is stored: refused before the probe, by name.
    const hosted = await refused(h.controller.handle({ type: "runplan.prepare", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, receiptId: "none", modelId: "openai/gpt-5.6-luna" }, PAGE));
    expect(["store_locked", "authorization_absent"]).toContain(hosted.code);
    // Unlock with the wrong passphrase: refused; with the right one: the records are back.
    expect((await refused(h.controller.handle({ type: "secrets.unlock", passphrase: "not it" }, PAGE))).code).toBe("passphrase_wrong");
    const unlocked = (await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE)) as SecretsView;
    expect(unlocked.state).toBe("unlocked");
    expect(((await h.controller.handle({ type: "vault.get" }, PAGE)) as VaultView).records).toHaveLength(6);
  });

  it("a plan that needs nothing from the store runs while locked; one that needs a record is blocked at Run by name (D-195)", async () => {
    const model = scriptedOllama(webairModelAnswers());
    const tool = scriptedOrigin();
    const h = makeHarness({ transports: { model: model.transport, tool: tool.transport } });
    await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE);
    const session = await trustedSession(h);
    const search = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(search.run_plan?.preflight.ready).toBe(true);
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    const ready = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(ready).toMatchObject({ ready: true, checks: expect.arrayContaining(["secrets_available"]) });
    const plan = search.run_plan!.run_plan;
    await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: "Find me a nonstop flight from Boston to Zurich on 9 October under $900.", booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE);
    await h.h_drain();
    expect(h.host.started[0]?.vault).toBeNull();
    expect(h.host.started[0]?.credentials).toEqual({ openai: null, anthropic: null });
    expect(model.seen.length).toBeGreaterThan(0);
    // Now a plan with records, prepared unlocked, then locked: the plan is not stale, Run is blocked by name.
    await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE);
    const quote = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "quote", resourceSelections: PICKS, prepare: true }, PAGE)) as AuthorizeResult;
    expect(quote.run_plan?.preflight.ready, JSON.stringify(quote.plan_refused)).toBe(true);
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    const blocked = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(blocked).toMatchObject({ ready: false, blocker: { code: "store_locked" } });
    const start = await refused(h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: quote.run_plan!.run_plan.run_plan_id, runPlanSha256: quote.run_plan!.run_plan.run_plan_sha256, input: { request: "Prepare WA101 Standard for 9 October for me.", booking: true, purchase: { quote_id: "", fare_id: "" } } }, PAGE));
    expect(start.code).toBe("store_locked");
    // The preflight while locked compares nothing (the registries cannot be rebuilt): in the reference's
    // words the plan is stale for `*_registry_unknown`, never for a missing binding or record; Run names
    // the lock first, and the plan is checked again once unlocked.
    const state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as { preflight: { stale: boolean; stale_reasons: Array<{ code: string }>; resource_grants: { evaluated: boolean }; tool_bindings: { evaluated: boolean } } };
    expect(state.preflight.stale_reasons.map((reason) => reason.code)).toEqual(["tool_registry_unknown", "resource_registry_unknown"]);
    expect(state.preflight.resource_grants.evaluated).toBe(false);
    expect(state.preflight.tool_bindings.evaluated).toBe(false);
    await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE);
    const again = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(again.ready).toBe(true);
  });

  it("a plan that binds a host-resource tool without granting a record runs with the vault's types alone, and needs the store unlocked (review 1, finding 1)", async () => {
    // The reviewer's reproduction: the resource tool approved, its permission denied, so no record is granted.
    // The plan binds `host-resource:personal.travel_profile`; the run's registry must hold that binding or
    // `begin` fails `tool_not_bound` before any model call. The types travel without the records.
    const model = scriptedOllama(webairModelAnswers());
    const tool = scriptedOrigin();
    const h = makeHarness({ transports: { model: model.transport, tool: tool.transport } });
    await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE);
    const session = await trustedSession(h);
    const decisions = { "network.webair": "session", "model.reasoning": "session", "memory.session": "session", "profile.travel": "deny", "identity.passenger": "deny", "wallet.payment": "deny", "booking.simulate_purchase": "deny" };
    const toolApprovals = { "search-flights": true, "get-fare-rules": true, "personal.travel_profile": true };
    const result = (await h.controller.handle({ type: "authorization.authorize", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, decisions, toolApprovals, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
    expect(result.plan_refused).toBeNull();
    const plan = result.run_plan!.run_plan;
    expect(plan.resource_grants).toEqual([]);
    expect(plan.tool_bindings.map((binding) => binding.tool_id).sort()).toEqual(["get-fare-rules", "personal.travel_profile", "search-flights"]);
    expect(result.run_plan!.preflight.ready).toBe(true);
    const ready = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(ready).toMatchObject({ ready: true, checks: expect.arrayContaining(["secrets_available", "preflight_ready"]) });
    const input = { request: "Find me a nonstop flight from Boston to Zurich on 9 October under $900.", booking: false, purchase: { quote_id: "", fare_id: "" } };
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input }, PAGE)) as RunView;
    await h.h_drain();
    const message = h.host.started[0]!;
    expect(message.vault).not.toBeNull();
    expect(message.vault!.document.records).toEqual([]); // the types alone: no record was granted
    expect(message.vault!.document.types.map((type) => type.id)).toContain("personal.travel_profile");
    expect(message.credentials).toEqual({ openai: null, anthropic: null });
    const run = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect(run.status, `${run.errorCode}: ${run.errorDetail}`).toBe("completed");
    expect(model.seen.length).toBeGreaterThan(0);
    // Locked: the same plan is "unlock to check", not stale, and Run names the lock.
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    const blocked = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(blocked).toMatchObject({ ready: false, blocker: { code: "store_locked" } });
    const state = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as { preflight: { stale_reasons: Array<{ code: string }>; resource_grants: { evaluated: boolean }; tool_bindings: { evaluated: boolean } } };
    expect(state.preflight.stale_reasons.map((reason) => reason.code)).toEqual(["tool_registry_unknown"]); // no grant, so no resource registry to miss
    expect(state.preflight.tool_bindings.evaluated).toBe(false);
    await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE);
    expect(((await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness).ready).toBe(true);
  });

  it("an envelope this build cannot read is reported as `invalid`, refuses what needs it by name, and can be forgotten (review 1, finding 6)", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-test-not-a-real-key" }, PAGE);
    h.envelope.value = { schema: "chrome-agent-browser-secret-store-v2", cipher: "AES-256-GCM", entries: {} };
    const status = (await h.controller.handle({ type: "secrets.status" }, PAGE)) as SecretsView;
    expect(status).toMatchObject({ state: "invalid", entries: [], migration_pending: false, legacy: null });
    expect(status.problem).toContain("v2");
    expect(((await h.controller.handle({ type: "status.get" }, PAGE)) as StatusInfo).secrets).toBe("invalid");
    expect((await refused(h.controller.handle({ type: "vault.get" }, PAGE))).code).toBe("store_invalid");
    expect((await refused(h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE))).code).toBe("store_invalid");
    expect((await refused(h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-other" }, PAGE))).code).toBe("store_invalid");
    expect(((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).keys).toEqual({});
    const gone = (await h.controller.handle({ type: "secrets.forget", confirmation: "forget" }, PAGE)) as SecretsView;
    expect(gone.state).toBe("no_passphrase");
    expect(h.envelope.value).toBeUndefined();
  });

  it("the idle lock applies to the controller's reads, and the setting takes one of the offered values only", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "vault.installDemo", records: true }, PAGE);
    h.clock.now = new Date(h.clock.now.getTime() + 16 * 60_000);
    expect((await refused(h.controller.handle({ type: "vault.get" }, PAGE))).code).toBe("store_locked");
    expect(h.unlocked.value).toBeUndefined();
    await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE);
    const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    expect(current.settings.security.idle_lock_minutes).toBe(15);
    const saved = (await h.controller.handle({ type: "settings.set", settings: { ...current.settings, security: { idle_lock_minutes: 7 } } }, PAGE)) as SettingsView;
    expect(saved.settings.security.idle_lock_minutes).toBe(15);
    const never = (await h.controller.handle({ type: "settings.set", settings: { ...current.settings, security: { idle_lock_minutes: null } } }, PAGE)) as SettingsView;
    expect(never.settings.security.idle_lock_minutes).toBeNull();
    h.clock.now = new Date(h.clock.now.getTime() + 24 * 3_600_000);
    expect(((await h.controller.handle({ type: "vault.get" }, PAGE)) as VaultView).records).toHaveLength(6);
  });

  it("changing the passphrase keeps every entry; forgetting needs the typed word and wipes the envelope", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-test-not-a-real-key" }, PAGE);
    const before = (h.envelope.value as SecretEnvelope).entries;
    await h.controller.handle({ type: "secrets.changePassphrase", current: SEED_PASSPHRASE, next: "a brand new passphrase" }, PAGE);
    expect((h.envelope.value as SecretEnvelope).entries).toEqual(before);
    expect(await h.settings.key("openai")).toBe("sk-test-not-a-real-key");
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    expect((await refused(h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE))).code).toBe("passphrase_wrong");
    await h.controller.handle({ type: "secrets.unlock", passphrase: "a brand new passphrase" }, PAGE);
    expect((await refused(h.controller.handle({ type: "secrets.forget", confirmation: "yes" }, PAGE))).code).toBe("confirmation_mismatch");
    const gone = (await h.controller.handle({ type: "secrets.forget", confirmation: " Forget " }, PAGE)) as SecretsView;
    expect(gone.state).toBe("no_passphrase");
    expect(h.envelope.value).toBeUndefined();
    expect(h.settingsArea.data.has("secretStore")).toBe(false);
    expect(((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).keys).toEqual({});
  });
});
