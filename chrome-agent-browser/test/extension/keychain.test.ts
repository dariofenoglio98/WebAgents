/**
 * Keychain unlock in the worker, over a fake native port (T17, D-181, D-204): with the helper
 * registered, Settings → Security says "keychain available" and the store unlocks with one click;
 * with the helper removed, refusing, or holding another key, the store stays locked, the
 * passphrase opens it as before, and nothing stored is lost. Only the master key ever crosses the
 * port; a record that can never work again is dropped, nothing else.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { KeychainView, SecretsView, SettingsView } from "../../src/extension/messages.js";
import { FakeHelper } from "../helpers/fake-helper.js";
import { makeHarness, PAGE, SEED_PASSPHRASE, type Harness } from "../helpers/shell.js";

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

const ask = <T>(h: Harness, request: Parameters<Harness["controller"]["handle"]>[0]) => h.controller.handle(request, PAGE) as Promise<T>;

/** A harness whose store holds an OpenAI key and the demo records, with keychain unlock on. */
async function enabled(): Promise<{ h: Harness; helper: FakeHelper }> {
  const helper = new FakeHelper();
  const h = makeHarness({ native: helper, nativePermission: true });
  await ask(h, { type: "settings.setKey", provider: "openai", key: "sk-test-key-kept" });
  await ask(h, { type: "vault.installDemo", records: true });
  const view = await ask<KeychainView>(h, { type: "keychain.enable" });
  expect(view).toMatchObject({ permission: true, enabled: true, helper: "available", helper_version: "0.1.0" });
  return { h, helper };
}

describe("Settings → Security's keychain card", () => {
  it("says not checked without the permission, not installed without the helper, and keychain available with it", async () => {
    const off = makeHarness();
    expect(await ask<KeychainView>(off, { type: "keychain.status" })).toEqual({ permission: false, enabled: false, enabled_at: null, helper: "not_checked", helper_version: null, problem: null, ollama: null });
    const missing = makeHarness({ nativePermission: true });
    expect(await ask<KeychainView>(missing, { type: "keychain.status" })).toMatchObject({ permission: true, helper: "not_installed", problem: { code: "helper_not_installed" } });
    const helper = new FakeHelper();
    const present = makeHarness({ native: helper, nativePermission: true });
    const view = await ask<KeychainView>(present, { type: "keychain.status" });
    expect(view).toMatchObject({ permission: true, enabled: false, helper: "available", helper_version: "0.1.0", problem: null });
    expect(view.ollama).toEqual(helper.ollama);
    helper.refuse = "caller_refused";
    expect(await ask<KeychainView>(present, { type: "keychain.status" })).toMatchObject({ helper: "refused", problem: { code: "caller_refused" } });
  });

  it("Turn on and Turn off reuse what the helper said last instead of starting it again (T17 review 1, nit 7)", async () => {
    const helper = new FakeHelper();
    const h = makeHarness({ native: helper, nativePermission: true });
    await ask(h, { type: "keychain.status" });
    expect(helper.sent.map((message) => message.op)).toEqual(["ollama.status"]);
    const on = await ask<KeychainView>(h, { type: "keychain.enable" });
    expect(on).toMatchObject({ enabled: true, helper: "available", helper_version: "0.1.0", ollama: helper.ollama });
    const off = await ask<KeychainView>(h, { type: "keychain.disable" });
    expect(off).toMatchObject({ enabled: false, helper: "available", helper_version: "0.1.0", ollama: helper.ollama });
    expect(helper.sent.map((message) => message.op)).toEqual(["ollama.status", "keychain.wrap", "keychain.unwrap"]);
    // Check again always asks; a failed helper is forgotten, so the next Turn off asks too.
    helper.portFailure = "not_installed";
    expect((await ask<KeychainView>(h, { type: "keychain.status" })).helper).toBe("not_installed");
    expect((await ask<KeychainView>(h, { type: "keychain.disable" })).helper).toBe("not_installed");
    expect(helper.sent.map((message) => message.op).slice(3)).toEqual(["ollama.status", "ollama.status"]);
  });

  it("turning it on needs the permission and an unlocked store", async () => {
    const helper = new FakeHelper();
    const h = makeHarness({ native: helper });
    expect((await refused(ask(h, { type: "keychain.enable" }))).code).toBe("native_permission_missing");
    h.native.permission = true;
    await ask(h, { type: "secrets.lock" });
    expect((await refused(ask(h, { type: "keychain.enable" }))).code).toBe("store_locked");
    expect(helper.sent).toHaveLength(0); // nothing reached the helper
    expect((await ask<SecretsView>(h, { type: "secrets.status" })).keychain_enabled).toBe(false);
  });
});

describe("unlock with the keychain", () => {
  it("unlocks with one request; only the master key crossed the port, never a provider key or a record", async () => {
    const { h, helper } = await enabled();
    expect((await ask<SecretsView>(h, { type: "secrets.status" })).keychain_enabled).toBe(true);
    await ask(h, { type: "secrets.lock" });
    const unlocked = await ask<SecretsView>(h, { type: "secrets.unlockKeychain" });
    expect(unlocked.state).toBe("unlocked");
    expect(await h.settings.key("openai")).toBe("sk-test-key-kept");
    const sent = JSON.stringify(helper.sent);
    expect(sent).not.toContain("sk-test-key-kept");
    expect(sent).not.toContain("Demo");
    expect(helper.sent.map((message) => message.op)).toEqual(["keychain.wrap", "keychain.unwrap", "ollama.status", "keychain.unwrap"]);
    // What is stored beside the envelope holds the blob and the check, no key in clear.
    const stored = JSON.stringify(await h.settingsArea.get("secretKeychain"));
    expect(stored).toContain("chrome-agent-browser-keychain-unlock-v1");
    expect(stored).not.toContain(String((h.unlocked.value as { key: string }).key));
  });

  it("a removed helper degrades to the passphrase without data loss (the record stays for when it returns)", async () => {
    const { h, helper } = await enabled();
    await ask(h, { type: "secrets.lock" });
    helper.portFailure = "not_installed";
    expect((await refused(ask(h, { type: "secrets.unlockKeychain" }))).code).toBe("helper_not_installed");
    expect((await ask<SecretsView>(h, { type: "secrets.status" })).state).toBe("locked");
    expect((await ask<KeychainView>(h, { type: "keychain.status" })).helper).toBe("not_installed");
    await ask(h, { type: "secrets.unlock", passphrase: SEED_PASSPHRASE });
    expect(await h.settings.key("openai")).toBe("sk-test-key-kept");
    expect(((await ask<SettingsView>(h, { type: "settings.get" })).keys)).toEqual({ openai: true });
    expect((await ask<SecretsView>(h, { type: "secrets.status" })).keychain_enabled).toBe(true);
    // The helper is back: the same record unlocks again.
    helper.portFailure = null;
    await ask(h, { type: "secrets.lock" });
    expect((await ask<SecretsView>(h, { type: "secrets.unlockKeychain" })).state).toBe("unlocked");
  });

  it("a revoked permission, a timeout or a denied keychain prompt keep the record and the store locked", async () => {
    const { h, helper } = await enabled();
    await ask(h, { type: "secrets.lock" });
    h.native.permission = false;
    helper.portFailure = "no_permission";
    expect((await refused(ask(h, { type: "secrets.unlockKeychain" }))).code).toBe("native_permission_missing");
    helper.portFailure = "timeout";
    expect((await refused(ask(h, { type: "secrets.unlockKeychain" }))).code).toBe("helper_timeout");
    helper.portFailure = null;
    helper.refuse = "keychain_unavailable";
    const denied = await refused(ask(h, { type: "secrets.unlockKeychain" }));
    expect([denied.code, denied.details.helper_code]).toEqual(["helper_refused", "keychain_unavailable"]);
    expect(await ask<SecretsView>(h, { type: "secrets.status" })).toMatchObject({ state: "locked", keychain_enabled: true });
  });

  it("a keychain item that is gone, or a key that does not fit, turns keychain unlock off and leaves the store locked", async () => {
    const gone = await enabled();
    await ask(gone.h, { type: "secrets.lock" });
    gone.helper.kek = null; // the item was deleted (the uninstaller, or Keychain Access)
    const missing = await refused(ask(gone.h, { type: "secrets.unlockKeychain" }));
    expect([missing.code, missing.details.helper_code]).toEqual(["helper_refused", "keychain_item_missing"]);
    expect(await ask<SecretsView>(gone.h, { type: "secrets.status" })).toMatchObject({ state: "locked", keychain_enabled: false });
    expect((await refused(ask(gone.h, { type: "secrets.unlockKeychain" }))).code).toBe("keychain_not_enabled");

    const wrong = await enabled();
    await ask(wrong.h, { type: "secrets.lock" });
    wrong.helper.unwrapOverride = new Uint8Array(32).fill(5);
    expect((await refused(ask(wrong.h, { type: "secrets.unlockKeychain" }))).code).toBe("keychain_mismatch");
    expect(await ask<SecretsView>(wrong.h, { type: "secrets.status" })).toMatchObject({ state: "locked", keychain_enabled: false });
    await ask(wrong.h, { type: "secrets.unlock", passphrase: SEED_PASSPHRASE });
    expect(await wrong.h.settings.key("openai")).toBe("sk-test-key-kept");
  });

  it("is refused while no passphrase exists, is a no-op while unlocked, and works again after a passphrase change", async () => {
    const helper = new FakeHelper();
    const none = makeHarness({ native: helper, nativePermission: true, secrets: "none" });
    expect((await refused(ask(none, { type: "secrets.unlockKeychain" }))).code).toBe("store_no_passphrase");
    const { h } = await enabled();
    expect((await ask<SecretsView>(h, { type: "secrets.unlockKeychain" })).state).toBe("unlocked");
    await ask(h, { type: "secrets.changePassphrase", current: SEED_PASSPHRASE, next: "a brand new passphrase" });
    await ask(h, { type: "secrets.lock" });
    expect((await ask<SecretsView>(h, { type: "secrets.unlockKeychain" })).state).toBe("unlocked");
  });

  it("turning it off, or forgetting everything, deletes the record; a new store starts with it off", async () => {
    const { h } = await enabled();
    const off = await ask<KeychainView>(h, { type: "keychain.disable" });
    expect(off).toMatchObject({ enabled: false, enabled_at: null });
    expect((await h.settingsArea.get("secretKeychain")).secretKeychain).toBeUndefined();
    await ask(h, { type: "keychain.enable" });
    await ask(h, { type: "secrets.forget", confirmation: "forget" });
    expect((await h.settingsArea.get("secretKeychain")).secretKeychain).toBeUndefined();
    const fresh = await ask<SecretsView>(h, { type: "secrets.setup", passphrase: "a passphrase of mine" });
    expect(fresh.keychain_enabled).toBe(false);
  });
});

describe("T16 review 2, nit 3: a vault opened before a store change is never saved after it", () => {
  it("refuses store_changed and writes nothing", async () => {
    const h = makeHarness();
    await ask(h, { type: "vault.installDemo", records: true });
    const controller = h.controller as unknown as { vault(): Promise<unknown>; saveVault(vault: unknown): Promise<void> };
    const vault = await controller.vault();
    await ask(h, { type: "secrets.forget", confirmation: "forget" });
    await ask(h, { type: "secrets.setup", passphrase: "a passphrase of mine" });
    expect((await refused(controller.saveVault(vault))).code).toBe("store_changed");
    expect((await h.secrets.names()).includes("vault")).toBe(false);
  });
});
