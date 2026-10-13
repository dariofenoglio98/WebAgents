/**
 * The secret store (T16, D-181, D-191): provider keys, the vault's HMAC key and the vault
 * document encrypted at rest under a passphrase, with no Chrome API in sight.
 *
 * Shape. A random 32-byte **master key** encrypts every entry with AES-256-GCM: a fresh 12-byte
 * IV per message and the entry's name as additional authenticated data, so a ciphertext cannot
 * be moved under another name. The passphrase never touches an entry: scrypt derives a 32-byte
 * key from it (N = 2^17, r = 8, p = 1, a 16-byte random salt; OWASP's current minimum, about
 * half a second and 128 MiB on a 2024 laptop) and that key only **wraps** the master key. A
 * wrong passphrase therefore fails the unwrap's authentication tag and no entry is read, which
 * is the verifier the design asks for; a passphrase change re-wraps the master key under a new
 * salt and leaves every entry as it is; "forget everything" deletes the envelope.
 *
 * The envelope (`chrome-agent-browser-secret-store-v1`) is one JSON document the shell keeps in
 * `chrome.storage.local`; the unlocked state is the master key alone, which the shell keeps in
 * `chrome.storage.session` with the times it was unlocked and last used (D-192). Both live
 * behind the two small storage interfaces below, so the store runs identically in tests.
 */
import { scryptAsync } from "@noble/hashes/scrypt.js";

import { CoreError } from "./errors.js";
import { closedRecord, isRecord, requiredText } from "./fields.js";
import { base64Decode, base64Encode } from "./keys.js";

export const SECRET_STORE_SCHEMA = "chrome-agent-browser-secret-store-v1";
export const SECRET_CIPHER = "AES-256-GCM";
/** scrypt's parameters for a new envelope (D-191); an envelope records its own, so reading never guesses. */
export const SCRYPT_PARAMETERS = Object.freeze({ name: "scrypt", n: 131072, r: 8, p: 1, length: 32 });
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const MASTER_KEY_BYTES = 32;
export const MIN_PASSPHRASE_LENGTH = 8;
export const MAX_PASSPHRASE_LENGTH = 1024;
/** An entry's bytes are bounded; the vault document is the largest thing stored (MAX_VAULT_RECORDS × MAX_VALUE_BYTES is far below this). */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 64;
const ENTRY_NAME = /^[a-z][a-z0-9_]*(:[a-z0-9_-]+)?$/u;
/** The additional data of the wrapped master key; an entry's is `<schema>|<name>`, which no entry name can equal. */
const MASTER_AAD = `${SECRET_STORE_SCHEMA}|master`;
/** Bounds on the parameters an envelope may ask this build to run (a hostile envelope must not exhaust memory). */
const SCRYPT_BOUNDS = { minN: 2 ** 14, maxN: 2 ** 20, maxR: 16, maxP: 4 };

/** The idle-lock choices (D-192), in minutes; null means "until the browser closes". */
export const IDLE_LOCK_MINUTES: readonly (number | null)[] = Object.freeze([5, 15, 60, null]);
export const DEFAULT_IDLE_LOCK_MINUTES = 15;

export interface SealedBox {
  iv: string;
  ciphertext: string;
}

export interface SecretEnvelope {
  schema: typeof SECRET_STORE_SCHEMA;
  created_at: string;
  kdf: { name: "scrypt"; n: number; r: number; p: number; salt: string; length: number };
  cipher: typeof SECRET_CIPHER;
  wrapped_key: SealedBox;
  entries: Record<string, SealedBox>;
}

/** What the shell persists about the unlocked state (`chrome.storage.session`): the master key and the clock facts the idle lock needs. */
export interface UnlockedState {
  key: string;
  unlocked_at: string;
  last_used_at: string;
}

export interface EnvelopeStorage {
  load(): Promise<unknown>;
  save(envelope: SecretEnvelope): Promise<void>;
  clear(): Promise<void>;
}

export interface UnlockedStateStorage {
  load(): Promise<unknown>;
  save(state: UnlockedState): Promise<void>;
  clear(): Promise<void>;
}

export type SecretStoreState = "no_passphrase" | "locked" | "unlocked";

export interface SecretStoreStatus {
  state: SecretStoreState;
  unlocked_at: string | null;
  last_used_at: string | null;
  /** The idle time after which the store locks, or null for "until the browser closes". */
  idle_minutes: number | null;
  /** The names of the entries the envelope holds; readable while locked (never their values). */
  entries: string[];
  created_at: string | null;
}

export class MemoryEnvelopeStorage implements EnvelopeStorage {
  value: unknown = undefined;
  async load(): Promise<unknown> {
    return this.value === undefined ? undefined : JSON.parse(JSON.stringify(this.value));
  }
  async save(envelope: SecretEnvelope): Promise<void> {
    this.value = JSON.parse(JSON.stringify(envelope));
  }
  async clear(): Promise<void> {
    this.value = undefined;
  }
}

export class MemoryUnlockedStateStorage implements UnlockedStateStorage {
  value: unknown = undefined;
  async load(): Promise<unknown> {
    return this.value === undefined ? undefined : JSON.parse(JSON.stringify(this.value));
  }
  async save(state: UnlockedState): Promise<void> {
    this.value = JSON.parse(JSON.stringify(state));
  }
  async clear(): Promise<void> {
    this.value = undefined;
  }
}

function refuse(code: string, message: string, status = 400): CoreError {
  return new CoreError(code, message, { status });
}

/** `store_locked` carries the one message every surface shows before offering Unlock. */
export function lockedError(): CoreError {
  return refuse("store_locked", "Your keys and records are locked. Unlock them with your passphrase to continue.", 409);
}

export function noPassphraseError(): CoreError {
  return refuse("store_no_passphrase", "Set a passphrase first (Settings → Security): it protects your keys and records at rest.", 409);
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function checkPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== "string") throw refuse("passphrase_weak", "A passphrase must be text.");
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw refuse("passphrase_weak", `A passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) throw refuse("passphrase_weak", `A passphrase must be at most ${MAX_PASSPHRASE_LENGTH} characters.`);
  return passphrase;
}

export function checkEntryName(name: unknown): string {
  if (typeof name !== "string" || !ENTRY_NAME.test(name) || name.length > 64) throw refuse("store_invalid", "An entry name must be a short lowercase identifier, optionally qualified with a colon.");
  return name;
}

function sealedBox(raw: unknown, field: string): SealedBox {
  const record = closedRecord(raw, field, ["iv", "ciphertext"], ["iv", "ciphertext"]);
  const iv = requiredText(record.iv, `${field}.iv`, { limit: 64 });
  const ciphertext = requiredText(record.ciphertext, `${field}.ciphertext`, { limit: Math.ceil((MAX_ENTRY_BYTES + 16) / 3) * 4 + 4 });
  try {
    if (base64Decode(iv).length !== IV_BYTES) throw new TypeError("iv length");
    base64Decode(ciphertext);
  } catch {
    throw refuse("store_invalid", `${field} is not a sealed box`);
  }
  return { iv, ciphertext };
}

/** Read a stored envelope strictly: the schema, the cipher, bounded scrypt parameters, well-formed boxes. */
export function validateEnvelope(raw: unknown): SecretEnvelope {
  const record = closedRecord(raw, "secret_store", ["schema", "created_at", "kdf", "cipher", "wrapped_key", "entries"], ["schema", "created_at", "kdf", "cipher", "wrapped_key", "entries"]);
  if (record.schema !== SECRET_STORE_SCHEMA) throw refuse("store_invalid", `This build reads ${SECRET_STORE_SCHEMA} envelopes only; the stored one says ${JSON.stringify(String(record.schema).slice(0, 64))}.`);
  if (record.cipher !== SECRET_CIPHER) throw refuse("store_invalid", `The stored envelope names cipher ${JSON.stringify(String(record.cipher).slice(0, 32))}; this build uses ${SECRET_CIPHER}.`);
  const createdAt = requiredText(record.created_at, "secret_store.created_at", { limit: 64 });
  const kdf = closedRecord(record.kdf, "secret_store.kdf", ["name", "n", "r", "p", "salt", "length"], ["name", "n", "r", "p", "salt", "length"]);
  if (kdf.name !== "scrypt") throw refuse("store_invalid", "The stored envelope's key derivation is not scrypt.");
  const integer = (value: unknown, field: string, minimum: number, maximum: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw refuse("store_invalid", `${field} must be an integer between ${minimum} and ${maximum}`);
    return value;
  };
  const n = integer(kdf.n, "secret_store.kdf.n", SCRYPT_BOUNDS.minN, SCRYPT_BOUNDS.maxN);
  if ((n & (n - 1)) !== 0) throw refuse("store_invalid", "secret_store.kdf.n must be a power of two");
  const r = integer(kdf.r, "secret_store.kdf.r", 1, SCRYPT_BOUNDS.maxR);
  const p = integer(kdf.p, "secret_store.kdf.p", 1, SCRYPT_BOUNDS.maxP);
  const length = integer(kdf.length, "secret_store.kdf.length", 32, 32);
  const salt = requiredText(kdf.salt, "secret_store.kdf.salt", { limit: 64 });
  try {
    if (base64Decode(salt).length !== SALT_BYTES) throw new TypeError("salt length");
  } catch {
    throw refuse("store_invalid", "secret_store.kdf.salt must be 16 bytes in base64");
  }
  if (!isRecord(record.entries)) throw refuse("store_invalid", "secret_store.entries must be an object");
  const entries: Record<string, SealedBox> = {};
  const names = Object.keys(record.entries);
  if (names.length > MAX_ENTRIES) throw refuse("store_invalid", `secret_store.entries holds more than ${MAX_ENTRIES} entries`);
  for (const name of names) entries[checkEntryName(name)] = sealedBox(record.entries[name], `secret_store.entries[${name}]`);
  return { schema: SECRET_STORE_SCHEMA, created_at: createdAt, kdf: { name: "scrypt", n, r, p, salt, length }, cipher: SECRET_CIPHER, wrapped_key: sealedBox(record.wrapped_key, "secret_store.wrapped_key"), entries };
}

// -- primitives ---------------------------------------------------------------------------
async function deriveKey(passphrase: string, kdf: SecretEnvelope["kdf"]): Promise<Uint8Array> {
  const normalized = passphrase.normalize("NFKC");
  return scryptAsync(new TextEncoder().encode(normalized), base64Decode(kdf.salt), { N: kdf.n, r: kdf.r, p: kdf.p, dkLen: kdf.length, maxmem: 2 ** 31 });
}

async function aesKey(bytes: Uint8Array): Promise<CoreCryptoKey> {
  if (bytes.length !== MASTER_KEY_BYTES) throw refuse("store_invalid", "a key must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(key: Uint8Array, aad: string, plaintext: Uint8Array, random: (length: number) => Uint8Array): Promise<SealedBox> {
  const iv = random(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(key), plaintext);
  return { iv: base64Encode(iv), ciphertext: base64Encode(new Uint8Array(ciphertext)) };
}

async function open(key: Uint8Array, aad: string, box: SealedBox): Promise<Uint8Array | null> {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64Decode(box.iv), additionalData: new TextEncoder().encode(aad) }, await aesKey(key), base64Decode(box.ciphertext));
    return new Uint8Array(plaintext);
  } catch {
    return null; // an authentication failure: the key, the IV, the data or the name is not the one it was sealed with
  }
}

const entryAad = (name: string): string => `${SECRET_STORE_SCHEMA}|${name}`;

export interface EnvelopeOptions {
  now?: () => Date;
  /** Random bytes; injected by the vector generator, `crypto.getRandomValues` otherwise. */
  random?: (length: number) => Uint8Array;
  /** The scrypt parameters for a new envelope (tests lower N); readers use the envelope's own. */
  kdf?: { n: number; r: number; p: number };
}

/** A new envelope under `passphrase`, with a fresh master key, holding `entries`. */
export async function createEnvelope(passphrase: string, entries: Record<string, Uint8Array>, options: EnvelopeOptions = {}): Promise<{ envelope: SecretEnvelope; masterKey: Uint8Array }> {
  checkPassphrase(passphrase);
  const random = options.random ?? randomBytes;
  const parameters = options.kdf ?? SCRYPT_PARAMETERS;
  const kdf: SecretEnvelope["kdf"] = { name: "scrypt", n: parameters.n, r: parameters.r, p: parameters.p, salt: base64Encode(random(SALT_BYTES)), length: SCRYPT_PARAMETERS.length };
  const masterKey = random(MASTER_KEY_BYTES);
  const derived = await deriveKey(passphrase, kdf);
  const envelope: SecretEnvelope = {
    schema: SECRET_STORE_SCHEMA,
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    kdf,
    cipher: SECRET_CIPHER,
    wrapped_key: await seal(derived, MASTER_AAD, masterKey, random),
    entries: {},
  };
  let current = envelope;
  for (const [name, bytes] of Object.entries(entries)) current = await writeEntry(current, masterKey, name, bytes, options);
  validateEnvelope(current); // what was built reads back
  return { envelope: current, masterKey };
}

/** The master key, or `passphrase_wrong`: the wrap's authentication decides, and no entry is read. */
export async function unlockEnvelope(envelope: SecretEnvelope, passphrase: string): Promise<Uint8Array> {
  if (typeof passphrase !== "string" || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE_LENGTH) throw refuse("passphrase_wrong", "That passphrase does not open the store.", 403);
  const derived = await deriveKey(passphrase, envelope.kdf);
  const masterKey = await open(derived, MASTER_AAD, envelope.wrapped_key);
  if (masterKey === null || masterKey.length !== MASTER_KEY_BYTES) throw refuse("passphrase_wrong", "That passphrase does not open the store.", 403);
  return masterKey;
}

/** The same master key wrapped under a new passphrase and a new salt; every entry stays as it is. */
export async function rewrapEnvelope(envelope: SecretEnvelope, masterKey: Uint8Array, passphrase: string, options: EnvelopeOptions = {}): Promise<SecretEnvelope> {
  checkPassphrase(passphrase);
  const random = options.random ?? randomBytes;
  const parameters = options.kdf ?? SCRYPT_PARAMETERS;
  const kdf: SecretEnvelope["kdf"] = { name: "scrypt", n: parameters.n, r: parameters.r, p: parameters.p, salt: base64Encode(random(SALT_BYTES)), length: SCRYPT_PARAMETERS.length };
  const derived = await deriveKey(passphrase, kdf);
  return { ...envelope, kdf, wrapped_key: await seal(derived, MASTER_AAD, masterKey, random), entries: { ...envelope.entries } };
}

export async function readEntry(envelope: SecretEnvelope, masterKey: Uint8Array, name: string): Promise<Uint8Array | null> {
  const box = envelope.entries[checkEntryName(name)];
  if (box === undefined) return null;
  const bytes = await open(masterKey, entryAad(name), box);
  if (bytes === null) throw refuse("store_invalid", `The stored entry ${JSON.stringify(name)} does not open under this store's key: it was altered, or it belongs to another store.`, 500);
  return bytes;
}

export async function writeEntry(envelope: SecretEnvelope, masterKey: Uint8Array, name: string, bytes: Uint8Array, options: EnvelopeOptions = {}): Promise<SecretEnvelope> {
  checkEntryName(name);
  if (bytes.length > MAX_ENTRY_BYTES) throw refuse("store_invalid", `An entry may hold at most ${MAX_ENTRY_BYTES} bytes.`);
  if (!(name in envelope.entries) && Object.keys(envelope.entries).length >= MAX_ENTRIES) throw refuse("store_invalid", `The store holds at most ${MAX_ENTRIES} entries.`);
  const box = await seal(masterKey, entryAad(name), bytes, options.random ?? randomBytes);
  return { ...envelope, entries: { ...envelope.entries, [name]: box } };
}

export function removeEntry(envelope: SecretEnvelope, name: string): SecretEnvelope {
  const entries = { ...envelope.entries };
  delete entries[checkEntryName(name)];
  return { ...envelope, entries };
}

export const utf8 = {
  encode: (text: string): Uint8Array => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};

// -- the store: envelope + unlocked state + idle lock --------------------------------------
export interface SecretStoreDeps {
  envelope: EnvelopeStorage;
  unlocked: UnlockedStateStorage;
  /** The idle time (minutes) after which the store locks, or null for "until the browser closes" (Settings → Security). */
  idleMinutes: () => Promise<number | null>;
  clock?: () => Date;
  random?: (length: number) => Uint8Array;
  kdf?: { n: number; r: number; p: number };
}

/**
 * The store as the shell uses it. Every access to a value goes through `masterKey()`, which
 * applies the idle lock lazily (D-192): a key last used longer ago than the setting is wiped and
 * the call fails `store_locked`. The shell's alarm wipes proactively on the same rule
 * (`lockIfIdle`). Entry names are readable while locked; values never.
 */
export class SecretStore {
  private readonly clock: () => Date;
  private readonly options: EnvelopeOptions;

  constructor(private readonly deps: SecretStoreDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.options = { now: this.clock, ...(deps.random ? { random: deps.random } : {}), ...(deps.kdf ? { kdf: deps.kdf } : {}) };
  }

  /** The stored envelope, validated, or null when no passphrase was ever set. */
  async envelope(): Promise<SecretEnvelope | null> {
    const raw = await this.deps.envelope.load();
    if (raw === undefined || raw === null) return null;
    return validateEnvelope(raw);
  }

  private async unlockedState(): Promise<UnlockedState | null> {
    const raw = await this.deps.unlocked.load();
    if (raw === undefined || raw === null) return null;
    if (!isRecord(raw) || typeof raw.key !== "string" || typeof raw.unlocked_at !== "string" || typeof raw.last_used_at !== "string") {
      await this.deps.unlocked.clear();
      return null;
    }
    return { key: raw.key, unlocked_at: raw.unlocked_at, last_used_at: raw.last_used_at };
  }

  private idleExceeded(state: UnlockedState, idleMinutes: number | null): boolean {
    if (idleMinutes === null) return false;
    const last = Date.parse(state.last_used_at);
    if (!Number.isFinite(last)) return true;
    return this.clock().getTime() - last > idleMinutes * 60_000;
  }

  /** Wipe the session key when the idle time has passed (the alarm's work); true when it locked now. */
  async lockIfIdle(): Promise<boolean> {
    const state = await this.unlockedState();
    if (state === null) return false;
    if (!this.idleExceeded(state, await this.deps.idleMinutes())) return false;
    await this.deps.unlocked.clear();
    return true;
  }

  async status(): Promise<SecretStoreStatus> {
    const envelope = await this.envelope();
    const idle = await this.deps.idleMinutes();
    const entries = envelope ? Object.keys(envelope.entries).sort() : [];
    if (envelope === null) {
      await this.deps.unlocked.clear();
      return { state: "no_passphrase", unlocked_at: null, last_used_at: null, idle_minutes: idle, entries, created_at: null };
    }
    await this.lockIfIdle();
    const state = await this.unlockedState();
    return { state: state ? "unlocked" : "locked", unlocked_at: state?.unlocked_at ?? null, last_used_at: state?.last_used_at ?? null, idle_minutes: idle, entries, created_at: envelope.created_at };
  }

  /** The master key for one access: refuses when no passphrase exists or the store is locked; marks the use. */
  private async masterKey(): Promise<{ envelope: SecretEnvelope; key: Uint8Array }> {
    const envelope = await this.envelope();
    if (envelope === null) throw noPassphraseError();
    if (await this.lockIfIdle()) throw lockedError();
    const state = await this.unlockedState();
    if (state === null) throw lockedError();
    let key: Uint8Array;
    try {
      key = base64Decode(state.key);
    } catch {
      await this.deps.unlocked.clear();
      throw lockedError();
    }
    if (key.length !== MASTER_KEY_BYTES) {
      await this.deps.unlocked.clear();
      throw lockedError();
    }
    await this.deps.unlocked.save({ ...state, last_used_at: this.clock().toISOString() });
    return { envelope, key };
  }

  /** Create the envelope under a first passphrase, holding `entries` (the migration's clear values), and unlock. */
  async setup(passphrase: string, entries: Record<string, Uint8Array> = {}): Promise<void> {
    if ((await this.envelope()) !== null) throw refuse("store_exists", "A passphrase is already set. Change it, or forget everything first.", 409);
    const { envelope, masterKey } = await createEnvelope(passphrase, entries, this.options);
    await this.deps.envelope.save(envelope);
    await this.remember(masterKey);
  }

  async unlock(passphrase: string): Promise<void> {
    const envelope = await this.envelope();
    if (envelope === null) throw noPassphraseError();
    const masterKey = await unlockEnvelope(envelope, passphrase);
    await this.remember(masterKey);
  }

  private async remember(masterKey: Uint8Array): Promise<void> {
    const now = this.clock().toISOString();
    await this.deps.unlocked.save({ key: base64Encode(masterKey), unlocked_at: now, last_used_at: now });
  }

  async lock(): Promise<void> {
    await this.deps.unlocked.clear();
  }

  /** Re-wrap under a new passphrase; the current one must open the store (whether or not it is unlocked now). */
  async changePassphrase(current: string, next: string): Promise<void> {
    const envelope = await this.envelope();
    if (envelope === null) throw noPassphraseError();
    const masterKey = await unlockEnvelope(envelope, current);
    await this.deps.envelope.save(await rewrapEnvelope(envelope, masterKey, next, this.options));
    await this.remember(masterKey);
  }

  /** Delete the envelope and the session key: every entry is gone for good. */
  async forget(): Promise<void> {
    await this.deps.unlocked.clear();
    await this.deps.envelope.clear();
  }

  /** Whether an entry exists; readable while locked. */
  async has(name: string): Promise<boolean> {
    const envelope = await this.envelope();
    return envelope !== null && checkEntryName(name) in envelope.entries;
  }

  async get(name: string): Promise<Uint8Array | null> {
    const { envelope, key } = await this.masterKey();
    return readEntry(envelope, key, name);
  }

  async getText(name: string): Promise<string | null> {
    const bytes = await this.get(name);
    return bytes === null ? null : utf8.decode(bytes);
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    const { envelope, key } = await this.masterKey();
    await this.deps.envelope.save(await writeEntry(envelope, key, name, bytes, this.options));
  }

  async putText(name: string, text: string): Promise<void> {
    await this.put(name, utf8.encode(text));
  }

  async delete(name: string): Promise<void> {
    const { envelope } = await this.masterKey();
    await this.deps.envelope.save(removeEntry(envelope, name));
  }
}
