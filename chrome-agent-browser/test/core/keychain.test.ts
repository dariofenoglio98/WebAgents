/**
 * The extension's half of the helper protocol (T17, D-204): one blob format with the Swift helper
 * (the shared vector), strict reading of every reply, the failures mapped to codes, the record's
 * strict reader, and the store's check box: a key from the keychain is accepted only for the
 * envelope it was enabled on.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import { HelperClient, KEYCHAIN_RECORD_SCHEMA, NativePortError, readKeychainRecord, type NativePort } from "../../src/core/keychain.js";
import { base64Encode } from "../../src/core/keys.js";
import { MemoryEnvelopeStorage, MemoryUnlockedStateStorage, SecretStore } from "../../src/core/secrets.js";
import { FakeHelper, helperWrap } from "../helpers/fake-helper.js";

const KDF = { n: 2 ** 14, r: 8, p: 1 };
const MASTER = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

function store(): { store: SecretStore; envelope: MemoryEnvelopeStorage; unlocked: MemoryUnlockedStateStorage } {
  const envelope = new MemoryEnvelopeStorage();
  const unlocked = new MemoryUnlockedStateStorage();
  return { store: new SecretStore({ envelope, unlocked, idleMinutes: async () => 15, kdf: KDF }), envelope, unlocked };
}

const answering = (reply: unknown): NativePort => ({ send: async () => reply });

describe("one blob format with the Swift helper", () => {
  it("wraps the shared vector to the bytes HelperCoreTests.wrapVector pins", async () => {
    const blob = await helperWrap(MASTER, new Uint8Array(32).fill(7), new Uint8Array(12).fill(1));
    expect(base64Encode(blob)).toBe("AQEBAQEBAQEBAQEBAXbgi7SUuuoJ2d3WKnw6fj646gbnDIItBEAoWXl6qSiklWFlojL26FOkM5pYSQAR6A==");
  });
});

describe("HelperClient reads every reply strictly", () => {
  it("round-trips through the fake helper and sends nothing but the operation's fields", async () => {
    const helper = new FakeHelper();
    const client = new HelperClient(helper);
    const blob = await client.wrap(MASTER);
    expect([...(await client.unwrap(blob))]).toEqual([...MASTER]);
    const status = await client.status();
    expect(status).toEqual({ helper: "0.1.0", ollama: helper.ollama });
    expect(helper.sent.map((message) => Object.keys(message).sort().join(","))).toEqual(["key,op", "blob,op", "op"]);
  });

  it("maps Chrome's failures and the helper's refusals to codes a view explains", async () => {
    const cases: Array<[NativePortError, string]> = [
      [new NativePortError("not_installed", "Specified native messaging host not found."), "helper_not_installed"],
      [new NativePortError("forbidden", "Access to the specified native messaging host is forbidden."), "helper_not_installed"],
      [new NativePortError("no_permission", "x"), "native_permission_missing"],
      [new NativePortError("timeout", "x"), "helper_timeout"],
      [new NativePortError("exited", "Native host has exited."), "helper_failed"],
    ];
    for (const [failure, code] of cases) {
      const client = new HelperClient({ send: () => Promise.reject(failure) });
      expect((await refused(client.status())).code).toBe(code);
    }
    const refusal = await refused(new HelperClient(answering({ ok: false, helper: "0.1.0", error: { code: "caller_refused", message: "Chrome only" } })).status());
    expect(refusal.code).toBe("helper_refused");
    expect(refusal.details.helper_code).toBe("caller_refused");
  });

  it("refuses a reply of another shape, another operation, an extra field, or a key or blob of the wrong size", async () => {
    const bad: unknown[] = [
      null,
      "ok",
      { ok: "yes" },
      { ok: true, op: "keychain.wrap", helper: "0.1.0", key: base64Encode(MASTER) },
      { ok: true, op: "keychain.unwrap", helper: "0.1.0", key: base64Encode(MASTER), provider_key: "sk-x" },
      { ok: true, op: "keychain.unwrap", helper: "0.1.0", key: base64Encode(MASTER.slice(0, 31)) },
      { ok: true, op: "keychain.unwrap", helper: "0.1.0", key: "not base64!" },
    ];
    for (const reply of bad) expect((await refused(new HelperClient(answering(reply)).unwrap("A".repeat(84)))).code).toBe("helper_failed");
    expect((await refused(new HelperClient(answering({ ok: true, op: "keychain.wrap", helper: "0.1.0", blob: "AAAA" })).wrap(MASTER))).code).toBe("helper_failed");
    expect((await refused(new HelperClient(answering({ ok: true, op: "ollama.status", helper: "0.1.0", ollama: { installed: "yes" } })).status())).code).toBe("helper_failed");
    expect((await refused(new HelperClient(new FakeHelper()).wrap(MASTER.slice(0, 16)))).code).toBe("invalid_request");
  });
});

describe("the keychain record and the check box", () => {
  it("reads the record strictly", () => {
    const record = { schema: KEYCHAIN_RECORD_SCHEMA, enabled_at: "2026-10-13T00:00:00.000Z", envelope_created_at: "2026-10-13T00:00:00.000Z", blob: `${"A".repeat(82)}==`, check: { iv: "A".repeat(16), ciphertext: `${"A".repeat(22)}==` } };
    expect(readKeychainRecord(record)).toEqual(record);
    expect(readKeychainRecord({ ...record, extra: 1 })).toBeNull();
    expect(readKeychainRecord({ ...record, schema: "other" })).toBeNull();
    expect(readKeychainRecord({ ...record, blob: "AAAA" })).toBeNull();
    expect(readKeychainRecord({ ...record, check: { iv: "AAAA", ciphertext: `${"A".repeat(22)}==` } })).toBeNull();
    expect(readKeychainRecord(undefined)).toBeNull();
  });

  it("unlocks with the master key only when it opens this envelope's check", async () => {
    const { store: secrets } = store();
    await secrets.setup("a passphrase of mine");
    await secrets.putText("provider_key:openai", "sk-kept");
    const material = await secrets.keychainMaterial();
    await secrets.lock();
    // A wrong key, and the right key with another envelope's check, are refused; the store stays locked.
    expect((await refused(secrets.unlockWithKey(new Uint8Array(32).fill(9), material.check))).code).toBe("keychain_mismatch");
    const other = store();
    await other.store.setup("another passphrase");
    const foreign = await other.store.keychainMaterial();
    expect((await refused(secrets.unlockWithKey(material.key, foreign.check))).code).toBe("keychain_mismatch");
    expect((await secrets.status()).state).toBe("locked");
    await secrets.unlockWithKey(material.key, material.check);
    expect(await secrets.getText("provider_key:openai")).toBe("sk-kept");
    // A passphrase change re-wraps the same master key: the check still opens.
    await secrets.changePassphrase("a passphrase of mine", "a new passphrase of mine");
    await secrets.lock();
    await secrets.unlockWithKey(material.key, material.check);
    expect((await secrets.status()).state).toBe("unlocked");
  });

  it("needs the store unlocked to hand out the material", async () => {
    const { store: secrets } = store();
    expect((await refused(secrets.keychainMaterial())).code).toBe("store_no_passphrase");
    await secrets.setup("a passphrase of mine");
    await secrets.lock();
    expect((await refused(secrets.keychainMaterial())).code).toBe("store_locked");
  });
});

describe("T16 review 2 carry-overs in the store", () => {
  it("a storage read that fails propagates instead of reporting the envelope invalid (nit 2)", async () => {
    const { store: secrets, envelope } = store();
    await secrets.setup("a passphrase of mine");
    const load = envelope.load.bind(envelope);
    envelope.load = () => Promise.reject(new Error("storage unavailable"));
    await expect(secrets.status()).rejects.toThrow("storage unavailable");
    envelope.load = load;
    expect((await secrets.status()).state).toBe("unlocked"); // the session key was not wiped
  });

  it("names() reads the entry names once, locked or not; ensure() creates a missing value once (nits 3, 8)", async () => {
    const { store: secrets } = store();
    await secrets.setup("a passphrase of mine");
    await secrets.putText("provider_key:openai", "sk");
    let created = 0;
    const make = () => {
      created += 1;
      return new Uint8Array(32).fill(created);
    };
    const [first, second] = await Promise.all([secrets.ensure("vault_key", (bytes) => bytes.length === 32, make), secrets.ensure("vault_key", (bytes) => bytes.length === 32, make)]);
    expect(created).toBe(1);
    expect([...second]).toEqual([...first]);
    await secrets.lock();
    expect(await secrets.names()).toEqual(["provider_key:openai", "vault_key"]);
  });
});
