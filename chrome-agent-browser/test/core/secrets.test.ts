/**
 * The secret store (T16, D-191, D-192): the committed envelopes open with their passphrase and
 * with nothing else; every tampering is refused; a passphrase change keeps the entries; the
 * idle lock wipes the session key; what is readable while locked is the entry names only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { base64Decode, base64Encode } from "../../src/core/keys.js";
import {
  checkPassphrase,
  createEnvelope,
  DEFAULT_IDLE_LOCK_MINUTES,
  MAX_ENTRIES,
  MemoryEnvelopeStorage,
  MemoryUnlockedStateStorage,
  readEntry,
  removeEntry,
  rewrapEnvelope,
  SCRYPT_PARAMETERS,
  SECRET_STORE_SCHEMA,
  SecretStore,
  unlockEnvelope,
  utf8,
  validateEnvelope,
  writeEntry,
  type SecretEnvelope,
} from "../../src/core/secrets.js";
import { PROJECT } from "../helpers/paths.js";

interface Vectors {
  passphrase: string;
  wrong_passphrase: string;
  entries: Record<string, string>;
  production: { parameters: typeof SCRYPT_PARAMETERS; master_key: string; envelope: SecretEnvelope };
  test: { parameters: typeof SCRYPT_PARAMETERS; master_key: string; envelope: SecretEnvelope };
}

const vectors = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "secret-store-vectors.json"), "utf8")) as Vectors;
/** The test parameters: a few milliseconds per derivation instead of half a second. */
const TEST_KDF = { n: 2 ** 14, r: 8, p: 1 };
const NOW = new Date("2026-10-13T12:00:00.000Z");

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("the committed vectors", () => {
  it("the production envelope records D-191's parameters and opens every entry under the passphrase", async () => {
    const { envelope, master_key } = vectors.production;
    expect(validateEnvelope(envelope)).toEqual(envelope);
    expect(envelope.kdf).toMatchObject({ name: "scrypt", n: 131072, r: 8, p: 1, length: 32 });
    expect(SCRYPT_PARAMETERS).toMatchObject({ n: 131072, r: 8, p: 1, length: 32 });
    expect(base64Decode(envelope.kdf.salt).length).toBe(16);
    const masterKey = await unlockEnvelope(envelope, vectors.passphrase);
    expect(base64Encode(masterKey)).toBe(master_key);
    for (const [name, expected] of Object.entries(vectors.entries)) expect(base64Encode((await readEntry(envelope, masterKey, name))!)).toBe(expected);
    expect(await readEntry(envelope, masterKey, "provider_key:anthropic")).toBeNull();
  }, 20_000);

  it("the test envelope opens too, and a wrong passphrase is refused without any entry read", async () => {
    const { envelope, master_key } = vectors.test;
    expect(base64Encode(await unlockEnvelope(envelope, vectors.passphrase))).toBe(master_key);
    await expectCode(unlockEnvelope(envelope, vectors.wrong_passphrase), "passphrase_wrong");
    await expectCode(unlockEnvelope(envelope, ""), "passphrase_wrong");
    // NFKC: a composed and a decomposed spelling are one passphrase.
    const { envelope: accented, masterKey } = await createEnvelope("café passphrase", {}, { kdf: TEST_KDF });
    expect(base64Encode(await unlockEnvelope(accented, "café passphrase"))).toBe(base64Encode(masterKey));
  });

  it("every tampering is refused: the wrap, an entry's bytes, its IV, its name, the salt, the schema", async () => {
    const { envelope, master_key } = vectors.test;
    const masterKey = base64Decode(master_key);
    const flip = (text: string): string => {
      const bytes = base64Decode(text);
      bytes[0] ^= 0x01;
      return base64Encode(bytes);
    };
    await expectCode(unlockEnvelope({ ...envelope, wrapped_key: { ...envelope.wrapped_key, ciphertext: flip(envelope.wrapped_key.ciphertext) } }, vectors.passphrase), "passphrase_wrong");
    await expectCode(unlockEnvelope({ ...envelope, wrapped_key: { ...envelope.wrapped_key, iv: flip(envelope.wrapped_key.iv) } }, vectors.passphrase), "passphrase_wrong");
    await expectCode(unlockEnvelope({ ...envelope, kdf: { ...envelope.kdf, salt: flip(envelope.kdf.salt) } }, vectors.passphrase), "passphrase_wrong");
    const vault = envelope.entries.vault!;
    await expectCode(readEntry({ ...envelope, entries: { ...envelope.entries, vault: { ...vault, ciphertext: flip(vault.ciphertext) } } }, masterKey, "vault"), "store_invalid");
    await expectCode(readEntry({ ...envelope, entries: { ...envelope.entries, vault: { ...vault, iv: flip(vault.iv) } } }, masterKey, "vault"), "store_invalid");
    // The name is additional authenticated data: a box moved under another name does not open there.
    await expectCode(readEntry({ ...envelope, entries: { ...envelope.entries, vault_key: vault } }, masterKey, "vault_key"), "store_invalid");
    // A box sealed under another store's key does not open here.
    const other = await createEnvelope(vectors.passphrase, { vault: utf8.encode("{}") }, { kdf: TEST_KDF });
    await expectCode(readEntry({ ...envelope, entries: { vault: other.envelope.entries.vault! } }, masterKey, "vault"), "store_invalid");
    expect(() => validateEnvelope({ ...envelope, schema: "chrome-agent-browser-secret-store-v2" })).toThrow(/v1 envelopes only/u);
    expect(() => validateEnvelope({ ...envelope, cipher: "AES-128-GCM" })).toThrow(/cipher/u);
    expect(() => validateEnvelope({ ...envelope, kdf: { ...envelope.kdf, n: 2 ** 21 } })).toThrow(/kdf\.n/u);
    expect(() => validateEnvelope({ ...envelope, kdf: { ...envelope.kdf, n: 3 * 2 ** 14 } })).toThrow(/power of two/u);
    expect(() => validateEnvelope({ ...envelope, kdf: { ...envelope.kdf, name: "pbkdf2" } })).toThrow(/not scrypt/u);
    expect(() => validateEnvelope({ ...envelope, entries: { ...envelope.entries, "Bad Name": vault } })).toThrow(/entry name/u);
    expect(() => validateEnvelope({ ...envelope, extra: 1 })).toThrow();
    expect(() => validateEnvelope({ ...envelope, wrapped_key: { iv: envelope.wrapped_key.iv } })).toThrow();
  });
});

describe("envelope operations", () => {
  it("a passphrase change re-wraps under a new salt and leaves every entry byte for byte", async () => {
    const { envelope, master_key } = vectors.test;
    const masterKey = base64Decode(master_key);
    const changed = await rewrapEnvelope(envelope, masterKey, "another passphrase entirely", { kdf: TEST_KDF });
    expect(changed.entries).toEqual(envelope.entries);
    expect(changed.kdf.salt).not.toBe(envelope.kdf.salt);
    expect(changed.wrapped_key).not.toEqual(envelope.wrapped_key);
    expect(base64Encode(await unlockEnvelope(changed, "another passphrase entirely"))).toBe(master_key);
    await expectCode(unlockEnvelope(changed, vectors.passphrase), "passphrase_wrong");
    await expectCode(rewrapEnvelope(envelope, masterKey, "short", { kdf: TEST_KDF }), "passphrase_weak");
  });

  it("writes seal under a fresh IV each time, reads back, and are bounded", async () => {
    const { envelope, master_key } = vectors.test;
    const masterKey = base64Decode(master_key);
    const once = await writeEntry(envelope, masterKey, "provider_key:anthropic", utf8.encode("sk-ant-test"));
    const twice = await writeEntry(once, masterKey, "provider_key:anthropic", utf8.encode("sk-ant-test"));
    expect(once.entries["provider_key:anthropic"]!.iv).not.toBe(twice.entries["provider_key:anthropic"]!.iv);
    expect(utf8.decode((await readEntry(twice, masterKey, "provider_key:anthropic"))!)).toBe("sk-ant-test");
    expect(removeEntry(twice, "provider_key:anthropic").entries).toEqual(envelope.entries);
    await expectCode(writeEntry(envelope, masterKey, "Provider", utf8.encode("x")), "store_invalid");
    await expectCode(writeEntry(envelope, masterKey, "big", new Uint8Array(8 * 1024 * 1024 + 1)), "store_invalid");
    let full = envelope;
    for (let index = Object.keys(full.entries).length; index < MAX_ENTRIES; index += 1) full = await writeEntry(full, masterKey, `entry_${index}`, utf8.encode("x"));
    await expectCode(writeEntry(full, masterKey, "one_more", utf8.encode("x")), "store_invalid");
    expect(() => checkPassphrase("1234567")).toThrow(/at least 8/u);
    expect(checkPassphrase("12345678")).toBe("12345678");
  });
});

function store(options: { idle?: number | null; clock?: { now: Date } } = {}) {
  const clock = options.clock ?? { now: new Date(NOW) };
  const envelope = new MemoryEnvelopeStorage();
  const unlocked = new MemoryUnlockedStateStorage();
  const idle = { minutes: options.idle === undefined ? DEFAULT_IDLE_LOCK_MINUTES : options.idle };
  const secrets = new SecretStore({ envelope, unlocked, idleMinutes: async () => idle.minutes, clock: () => clock.now, kdf: TEST_KDF });
  return { secrets, envelope, unlocked, clock, idle };
}

describe("SecretStore", () => {
  it("has no passphrase at first, refuses values, sets up with the migrated entries, and reports its status", async () => {
    const s = store();
    expect(await s.secrets.status()).toEqual({ state: "no_passphrase", unlocked_at: null, last_used_at: null, idle_minutes: 15, entries: [], created_at: null, problem: null });
    await expectCode(s.secrets.get("vault"), "store_no_passphrase");
    await expectCode(s.secrets.unlock("whatever passphrase"), "store_no_passphrase");
    expect(await s.secrets.has("vault")).toBe(false);
    await s.secrets.setup("my first passphrase", { "provider_key:openai": utf8.encode("sk-migrated"), vault_key: new Uint8Array(32) });
    expect(await s.secrets.status()).toMatchObject({ state: "unlocked", unlocked_at: NOW.toISOString(), entries: ["provider_key:openai", "vault_key"], created_at: NOW.toISOString() });
    expect(await s.secrets.getText("provider_key:openai")).toBe("sk-migrated");
    expect((s.envelope.value as SecretEnvelope).entries["provider_key:openai"]!.ciphertext).not.toContain("sk-migrated");
    expect(JSON.stringify(s.envelope.value)).not.toContain("sk-migrated");
    await expectCode(s.secrets.setup("again", {}), "store_exists");
    await expectCode(store().secrets.setup("short", {}), "passphrase_weak");
  });

  it("locks and unlocks; while locked the names are readable and the values are not", async () => {
    const s = store();
    await s.secrets.setup("my first passphrase", { vault: utf8.encode("{}") });
    await s.secrets.lock();
    expect((await s.secrets.status()).state).toBe("locked");
    expect(s.unlocked.value).toBeUndefined();
    expect(await s.secrets.has("vault")).toBe(true);
    await expectCode(s.secrets.get("vault"), "store_locked");
    await expectCode(s.secrets.put("vault", utf8.encode("{}")), "store_locked");
    await expectCode(s.secrets.delete("vault"), "store_locked");
    await expectCode(s.secrets.unlock("not the passphrase"), "passphrase_wrong");
    expect((await s.secrets.status()).state).toBe("locked");
    await s.secrets.unlock("my first passphrase");
    expect((await s.secrets.status()).state).toBe("unlocked");
    expect(await s.secrets.getText("vault")).toBe("{}");
    // A session key that is not a key (another extension context wrote garbage, a corrupted value) locks rather than decrypts.
    s.unlocked.value = { key: "not base64!", unlocked_at: NOW.toISOString(), last_used_at: NOW.toISOString() };
    await expectCode(s.secrets.get("vault"), "store_locked");
    expect(s.unlocked.value).toBeUndefined();
  });

  it("locks after the idle time, lazily on access and proactively on the sweep; a use resets the clock; null never idles", async () => {
    const s = store({ idle: 15 });
    await s.secrets.setup("my first passphrase", { vault: utf8.encode("{}") });
    s.clock.now = new Date(NOW.getTime() + 10 * 60_000);
    expect(await s.secrets.getText("vault")).toBe("{}"); // used at +10 min
    s.clock.now = new Date(NOW.getTime() + 24 * 60_000); // 14 min after the use
    expect(await s.secrets.lockIfIdle()).toBe(false);
    expect((await s.secrets.status()).state).toBe("unlocked");
    s.clock.now = new Date(NOW.getTime() + 26 * 60_000); // 16 min after the use
    expect((await s.secrets.status()).state).toBe("locked");
    expect(s.unlocked.value).toBeUndefined();
    await expectCode(s.secrets.get("vault"), "store_locked");
    await s.secrets.unlock("my first passphrase");
    s.clock.now = new Date(s.clock.now.getTime() + 16 * 60_000);
    expect(await s.secrets.lockIfIdle()).toBe(true);
    expect(await s.secrets.lockIfIdle()).toBe(false);
    // "Until the browser closes": no idle lock at all.
    s.idle.minutes = null;
    await s.secrets.unlock("my first passphrase");
    s.clock.now = new Date(s.clock.now.getTime() + 48 * 3_600_000);
    expect((await s.secrets.status()).state).toBe("unlocked");
    expect(await s.secrets.getText("vault")).toBe("{}");
    // A lower setting applies at once.
    s.idle.minutes = 5;
    s.clock.now = new Date(s.clock.now.getTime() + 6 * 60_000);
    expect((await s.secrets.status()).state).toBe("locked");
  });

  it("changes the passphrase (even while locked), forgets everything, and refuses a store it cannot read", async () => {
    const s = store();
    await s.secrets.setup("my first passphrase", { vault: utf8.encode("{}") });
    await s.secrets.lock();
    await expectCode(s.secrets.changePassphrase("wrong one here", "my second passphrase"), "passphrase_wrong");
    await s.secrets.changePassphrase("my first passphrase", "my second passphrase");
    expect((await s.secrets.status()).state).toBe("unlocked");
    expect(await s.secrets.getText("vault")).toBe("{}");
    await s.secrets.lock();
    await expectCode(s.secrets.unlock("my first passphrase"), "passphrase_wrong");
    await s.secrets.unlock("my second passphrase");
    await s.secrets.forget();
    expect(await s.secrets.status()).toMatchObject({ state: "no_passphrase", entries: [] });
    expect(s.envelope.value).toBeUndefined();
    expect(s.unlocked.value).toBeUndefined();
    // An envelope this build cannot read (review 1, finding 6): the status says `invalid` and why, instead of
    // failing; every value is refused `store_invalid`; the entry names are unknown; forgetting works and clears it.
    s.envelope.value = { schema: SECRET_STORE_SCHEMA };
    const invalid = await s.secrets.status();
    expect(invalid).toMatchObject({ state: "invalid", entries: [], created_at: null });
    expect(invalid.problem).toContain("secret_store");
    await expectCode(s.secrets.get("vault"), "store_invalid");
    expect(await s.secrets.has("vault")).toBe(false); // nothing is known to exist
    await expectCode(s.secrets.unlock("my second passphrase"), "store_invalid");
    await expectCode(s.secrets.setup("a third passphrase", {}), "store_exists");
    await s.secrets.forget();
    expect(s.envelope.value).toBeUndefined();
    expect((await s.secrets.status()).state).toBe("no_passphrase");
    s.envelope.value = { schema: "chrome-agent-browser-secret-store-v2", cipher: "AES-256-GCM" };
    expect((await s.secrets.status()).problem).toContain("v2");
  });

  it("runs one operation at a time: a read in flight cannot undo a lock, a write cannot bring back a forgotten store or revert a re-key (review 1, finding 2)", async () => {
    // Storage whose every step yields, so operations started together interleave their steps unless serialized.
    class SlowEnvelope extends MemoryEnvelopeStorage {
      override async load(): Promise<unknown> {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return super.load();
      }
    }
    class SlowUnlocked extends MemoryUnlockedStateStorage {
      override async load(): Promise<unknown> {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return super.load();
      }
    }
    const envelope = new SlowEnvelope();
    const unlocked = new SlowUnlocked();
    const clock = { now: new Date(NOW) };
    const secrets = new SecretStore({ envelope, unlocked, idleMinutes: async () => 15, clock: () => clock.now, kdf: TEST_KDF });
    await secrets.setup("my first passphrase", { vault: utf8.encode("{}"), "provider_key:openai": utf8.encode("sk-one") });
    // 1. A get that began before Lock now: the lock wins; the store stays locked afterwards.
    const read = secrets.get("vault");
    const lock = secrets.lock();
    expect(utf8.decode((await read)!)).toBe("{}");
    await lock;
    expect((await secrets.status()).state).toBe("locked");
    expect(unlocked.value).toBeUndefined();
    await expectCode(secrets.get("vault"), "store_locked");
    // 2. A put that began before Forget everything: nothing of the store comes back.
    await secrets.unlock("my first passphrase");
    const write = secrets.put("provider_key:anthropic", utf8.encode("sk-two"));
    const forget = secrets.forget();
    await write;
    await forget;
    expect(envelope.value).toBeUndefined();
    expect((await secrets.status()).state).toBe("no_passphrase");
    // 3. A put racing a passphrase change: the new passphrase stands and the entry is kept.
    await secrets.setup("my first passphrase", { vault: utf8.encode("{}") });
    const another = secrets.put("provider_key:openai", utf8.encode("sk-three"));
    const change = secrets.changePassphrase("my first passphrase", "my second passphrase");
    await another;
    await change;
    await secrets.lock();
    await expectCode(secrets.unlock("my first passphrase"), "passphrase_wrong");
    await secrets.unlock("my second passphrase");
    expect(await secrets.getText("provider_key:openai")).toBe("sk-three");
    expect(await secrets.getText("vault")).toBe("{}");
  });
});
