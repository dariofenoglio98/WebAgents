/**
 * The operator-controlled publisher trust store, mirroring `agentpkg/browser/trust.py`.
 *
 * Three rules define it: the cryptographic identity of an entry is its **key fingerprint**,
 * never a publisher string from a manifest; the store lives outside every package and is
 * mutated only through the host's own trust operations, so no package operation can add
 * itself; and a key embedded in an artifact is evidence of self-consistency only, so trust
 * requires that the operator independently pinned that exact key here.
 *
 * The document format is the Python `agentpkg-trust-store-v0` file, so a store can be
 * exported or imported between the two runtimes, and every entry is re-derived and
 * re-checked on read. Where the store lives (a file, `chrome.storage.local`) is a
 * `TrustStorage` the shell supplies (D-032).
 */
import { canonicalJson } from "./canonical.js";
import { CoreError } from "./errors.js";
import type { TrustEvaluator, TrustVerdict } from "./evaluation.js";
import { sha256Hex } from "./hash.js";
import type { JsonObject } from "./json.js";
import { fingerprint, publicKeyFromRawBase64, rawBase64 } from "./keys.js";
import { embeddedPublicKey } from "./signature.js";

export const TRUST_STORE_FORMAT = "agentpkg-trust-store-v0";
export const MAX_ENTRIES = 256;
export const MAX_STORE_BYTES = 512 * 1024;
export const MAX_TEXT = 200;
const IDENTIFIER = /^[A-Za-z0-9_.:-]+$/u;
const ENTRY_FIELDS = new Set(["fingerprint", "public_key", "display_name", "publisher_id", "package_id_prefix", "notes", "added_at"]);

export interface TrustEntry {
  fingerprint: string;
  public_key: string;
  display_name: string;
  publisher_id: string | null;
  package_id_prefix: string | null;
  notes: string | null;
  added_at: string;
}

export interface TrustDocument {
  format: typeof TRUST_STORE_FORMAT;
  updated_at?: string;
  publishers: TrustEntry[];
}

export interface TrustState {
  /** Where the store lives, as a label; a file path in Python, a storage key here. */
  path: string;
  entry_count: number;
  state_sha256: string;
}

export interface TrustStorage {
  /** The stored document, or null when none exists yet. */
  read(): Promise<unknown>;
  write(document: TrustDocument): Promise<void>;
  /** A label for `TrustState.path`. */
  readonly location: string;
}

export interface PinOptions {
  displayName: string;
  publisherId?: string | null;
  packageIdPrefix?: string | null;
  notes?: string | null;
  replace?: boolean;
}

function invalid(message: string, options: { code?: string; status?: number } = {}): CoreError {
  return new CoreError(options.code ?? "trust_invalid", message, { status: options.status ?? 400 });
}

function text(value: unknown, field: string, options: { required?: boolean; status?: number } = {}): string | null {
  if (value === null || value === undefined) {
    if (options.required) throw invalid(`${field} is required`, options);
    return null;
  }
  if (typeof value !== "string" || value.length > MAX_TEXT) {
    throw invalid(`${field} must be a string of at most ${MAX_TEXT} characters`, options);
  }
  const stripped = value.trim();
  if (!stripped) {
    if (options.required) throw invalid(`${field} is required`, options);
    return null;
  }
  for (const character of stripped) {
    if (character.charCodeAt(0) < 32) throw invalid(`${field} must not contain control characters`, options);
  }
  return stripped;
}

function identifier(value: unknown, field: string, options: { status?: number } = {}): string | null {
  const stripped = text(value, field, options);
  if (stripped !== null && !IDENTIFIER.test(stripped)) {
    throw invalid(`${field} may use only letters, digits and _.:- characters`, options);
  }
  return stripped;
}

/** `TrustStore._entry_from`: re-derive and re-check one stored record. */
export async function entryFromRecord(record: unknown): Promise<TrustEntry> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw invalid("Trust store entries must be objects", { status: 500 });
  }
  const fields = record as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => !ENTRY_FIELDS.has(key)).sort();
  if (unknown.length > 0) throw invalid(`Unknown trust store fields: ${JSON.stringify(unknown)}`, { status: 500 });
  let key: Uint8Array;
  try {
    key = publicKeyFromRawBase64(String(fields.public_key ?? ""));
  } catch (error) {
    throw invalid(`Trust entry key is not a raw Ed25519 key: ${(error as Error).message}`, { status: 500 });
  }
  if (fields.fingerprint !== (await fingerprint(key))) {
    throw invalid("Trust entry fingerprint does not match its key", { status: 500 });
  }
  return {
    fingerprint: String(fields.fingerprint),
    public_key: String(fields.public_key),
    display_name: text(fields.display_name, "display_name", { status: 500 }) ?? "",
    publisher_id: identifier(fields.publisher_id, "publisher_id", { status: 500 }),
    package_id_prefix: identifier(fields.package_id_prefix, "package_id_prefix", { status: 500 }),
    notes: text(fields.notes, "notes", { status: 500 }),
    added_at: String(fields.added_at ?? ""),
  };
}

/** `TrustStore._read_document` + `entries()`: the whole store fails closed on any defect. */
export async function entriesFromDocument(document: unknown): Promise<TrustEntry[]> {
  if (document === null || document === undefined) return [];
  if (typeof document !== "object" || Array.isArray(document) || (document as Record<string, unknown>).format !== TRUST_STORE_FORMAT) {
    throw invalid(`Trust store must declare format ${TRUST_STORE_FORMAT}`, { status: 500 });
  }
  const publishers = (document as Record<string, unknown>).publishers;
  if (!Array.isArray(publishers)) throw invalid("Trust store publishers must be a list", { status: 500 });
  const entries: TrustEntry[] = [];
  const seen = new Set<string>();
  for (const record of publishers) {
    const entry = await entryFromRecord(record);
    if (seen.has(entry.fingerprint)) throw invalid("Trust store contains duplicate fingerprints", { status: 500 });
    seen.add(entry.fingerprint);
    entries.push(entry);
  }
  if (entries.length > MAX_ENTRIES) throw invalid(`Trust store exceeds ${MAX_ENTRIES} entries`, { status: 500 });
  return entries;
}

/** The document `TrustStore._write` serializes: entries in `added_at` order. */
export function trustDocument(entries: readonly TrustEntry[], now: string): TrustDocument {
  return {
    format: TRUST_STORE_FORMAT,
    updated_at: now,
    publishers: [...entries].sort((a, b) => (a.added_at < b.added_at ? -1 : a.added_at > b.added_at ? 1 : 0)).map((entry) => ({ ...entry })),
  };
}

/** `TrustStore.add` without the persistence: validated entry and the new list. */
export async function pinEntry(
  entries: readonly TrustEntry[],
  rawPublicKey: Uint8Array,
  options: PinOptions,
  now: string,
): Promise<{ entry: TrustEntry; entries: TrustEntry[] }> {
  const entry: TrustEntry = {
    fingerprint: await fingerprint(rawPublicKey),
    public_key: rawBase64(rawPublicKey),
    display_name: text(options.displayName, "display_name", { required: true }) ?? "",
    publisher_id: identifier(options.publisherId, "publisher_id"),
    package_id_prefix: identifier(options.packageIdPrefix, "package_id_prefix"),
    notes: text(options.notes, "notes"),
    added_at: now,
  };
  const existing = entries.filter((item) => item.fingerprint === entry.fingerprint);
  if (existing.length > 0 && !options.replace) {
    throw new CoreError("trust_entry_exists", `${entry.fingerprint} is already pinned; remove it first or pass replace`, {
      status: 409,
    });
  }
  if (entries.length - existing.length + 1 > MAX_ENTRIES) {
    throw invalid(`Trust store is limited to ${MAX_ENTRIES} entries`, { status: 409 });
  }
  const remaining = entries.filter((item) => item.fingerprint !== entry.fingerprint);
  return { entry, entries: [...remaining, entry] };
}

/** `TrustStore.remove` without the persistence. */
export function unpinEntry(entries: readonly TrustEntry[], keyFingerprint: string): { removed: TrustEntry; entries: TrustEntry[] } {
  const removed = entries.find((item) => item.fingerprint === keyFingerprint);
  if (!removed) throw new CoreError("trust_entry_unknown", `No trust entry for ${keyFingerprint}`, { status: 404 });
  return { removed, entries: entries.filter((item) => item.fingerprint !== keyFingerprint) };
}

/** `TrustStore.state`: a stable fingerprint of the exact trust state a receipt was issued under. */
export async function trustState(entries: readonly TrustEntry[], location: string): Promise<TrustState> {
  const canonical = canonicalJson(
    [...entries]
      .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
      .map((entry) => ({
        fingerprint: entry.fingerprint,
        publisher_id: entry.publisher_id,
        package_id_prefix: entry.package_id_prefix,
      })),
  );
  return { path: location, entry_count: entries.length, state_sha256: await sha256Hex(canonical) };
}

/**
 * `TrustStore.evaluate`: trusted / unknown / mismatch for one signer.
 *
 * The lookup is two-sided on purpose. A cryptographically valid signature from an unknown
 * key stays `unknown`, and a package whose claimed publisher is pinned to *different* keys
 * is `mismatch` rather than merely unknown, because that is an impersonation signal.
 */
export function evaluateTrust(
  entries: readonly TrustEntry[],
  input: { signerFingerprint: string | null; claimedPublisherId: string; packageId: string },
): TrustVerdict {
  if (input.signerFingerprint === null) {
    return { trust_status: "unknown", trust_reason: "no_valid_signature", trust_entry: null };
  }
  const pinned = entries.find((entry) => entry.fingerprint === input.signerFingerprint) ?? null;
  const forPublisher = entries.filter((entry) => input.claimedPublisherId && entry.publisher_id === input.claimedPublisherId);
  if (pinned !== null) {
    if (pinned.publisher_id !== null && pinned.publisher_id !== input.claimedPublisherId) {
      return { trust_status: "mismatch", trust_reason: "pinned_key_bound_to_other_publisher", trust_entry: { ...pinned } };
    }
    if (pinned.package_id_prefix && !String(input.packageId).startsWith(pinned.package_id_prefix)) {
      return { trust_status: "mismatch", trust_reason: "package_id_outside_pinned_prefix", trust_entry: { ...pinned } };
    }
    return { trust_status: "trusted", trust_reason: "operator_pinned_key", trust_entry: { ...pinned } };
  }
  if (forPublisher.length > 0) {
    return {
      trust_status: "mismatch",
      trust_reason: "claimed_publisher_pinned_to_other_key",
      trust_entry: null,
      pinned_fingerprints_for_claimed_publisher: forPublisher.map((entry) => entry.fingerprint),
    };
  }
  return { trust_status: "unknown", trust_reason: "signer_key_not_pinned", trust_entry: null };
}

/** A trust store over any storage: the reference's `TrustStore` with persistence injected. */
export class TrustStore implements TrustEvaluator {
  constructor(
    private readonly storage: TrustStorage,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async entries(): Promise<TrustEntry[]> {
    return entriesFromDocument(await this.storage.read());
  }

  private async write(entries: readonly TrustEntry[]): Promise<void> {
    const document = trustDocument(entries, this.clock());
    const size = new TextEncoder().encode(JSON.stringify(document)).length;
    if (size > MAX_STORE_BYTES) throw invalid("Trust store update exceeds its size limit");
    await this.storage.write(document);
  }

  async add(rawPublicKey: Uint8Array, options: PinOptions): Promise<TrustEntry> {
    const { entry, entries } = await pinEntry(await this.entries(), rawPublicKey, options, this.clock());
    await this.write(entries);
    return entry;
  }

  async remove(keyFingerprint: string): Promise<TrustEntry> {
    const { removed, entries } = unpinEntry(await this.entries(), keyFingerprint);
    await this.write(entries);
    return removed;
  }

  async state(): Promise<TrustState> {
    return trustState(await this.entries(), this.storage.location);
  }

  async evaluate(input: { signerFingerprint: string | null; claimedPublisherId: string; packageId: string }): Promise<TrustVerdict> {
    return evaluateTrust(await this.entries(), input);
  }
}

export type PinScope = "package" | "publisher";

/**
 * `ControlPlane.trust_session_publisher`: pin the key that signed one open package, and
 * nothing else. The key comes from that package's own verified signature envelope, so a
 * caller never supplies key material and cannot pin a key belonging to a different
 * artifact. The caller must echo the fingerprint it displayed. `package` (the default and
 * narrowest scope) pins `publisher_id` and `package_id_prefix` set to this exact package
 * id; `publisher` pins `publisher_id` only.
 */
export async function pinPackagePublisher(
  store: TrustStore,
  pkg: { manifest: JsonObject; signature: JsonObject | null },
  publisher: { signature_status: string; signer_fingerprint: string | null },
  options: { signerFingerprint: string; scope?: PinScope; notes?: string | null; replace?: boolean },
): Promise<{ added: TrustEntry; scope: PinScope; trust_store: TrustState }> {
  const scope = options.scope ?? "package";
  if (scope !== "package" && scope !== "publisher") {
    throw new CoreError("invalid_request", "scope must be 'package' (narrow) or 'publisher'");
  }
  if (publisher.signature_status !== "valid" || pkg.signature === null) {
    throw new CoreError(
      "signature_not_valid",
      `Only a self-consistent signature can have its key pinned; this package's signature status is ${JSON.stringify(publisher.signature_status)}`,
      { status: 409 },
    );
  }
  if (options.signerFingerprint !== publisher.signer_fingerprint) {
    throw new CoreError("fingerprint_mismatch", "signer_fingerprint does not match this session's signer; refusing to pin", {
      status: 409,
      details: { session_signer_fingerprint: publisher.signer_fingerprint },
    });
  }
  const manifest = pkg.manifest;
  const claimed = manifest.publisher as JsonObject;
  const key = await embeddedPublicKey(pkg.signature);
  const added = await store.add(key, {
    displayName: String(claimed.name),
    publisherId: String(claimed.id),
    packageIdPrefix: scope === "package" ? String(manifest.package_id) : null,
    notes: options.notes ?? null,
    replace: options.replace ?? false,
  });
  return { added, scope, trust_store: await store.state() };
}

/** An in-memory storage for tests and for a CLI that was given no store. */
export class MemoryTrustStorage implements TrustStorage {
  document: TrustDocument | null = null;
  writes = 0;
  readonly location: string;

  constructor(location = "memory") {
    this.location = location;
  }

  async read(): Promise<unknown> {
    return this.document === null ? null : JSON.parse(JSON.stringify(this.document));
  }

  async write(document: TrustDocument): Promise<void> {
    this.writes += 1;
    this.document = JSON.parse(JSON.stringify(document)) as TrustDocument;
  }
}
