/**
 * The personal vault (D-051): what this browser holds for the person, and the only way one of
 * those records reaches a run.
 *
 * Mirrors the reference plugin's `host-resources.ts` as a store: typed records per resource
 * type (a travel profile, an identity, a payment method), each type with a JSON Schema for its
 * values and the fields that are **sealed** (identify a person or an instrument). A record's
 * digest is HMAC-SHA256 under a key that lives only in this browser profile's storage, so a
 * digest is an equality-comparable reference that says nothing to anyone who reads a receipt
 * or an audit, and changes whenever the value or its type's schema changes (which is what makes
 * a plan that named the old value stale). The registry the authorization flow reads carries
 * ids, labels and digests, never a value; the value leaves the vault only through `resolve`,
 * for the one grant a plan froze.
 *
 * Nothing here knows what any type is for. Types, schemas and values are data: the shell
 * ships the demo host's three types as its default configuration and the person edits records.
 */
import { canonicalJson } from "./canonical.js";
import { CoreError } from "./errors.js";
import { closedRecord, identifier, invalid, isRecord, requiredText, text } from "./fields.js";
import { bufferSource, sha256Hex, toHex } from "./hash.js";
import { REGISTRY_SCHEMA, RESOURCE_PERMISSION_KINDS, type ResourceRegistry, normalizeResourceRegistry } from "./hostresources.js";
import { isJsonObject, type JsonObject } from "./json.js";
import { validateInstance } from "./schema.js";
import type { ResourceGrant } from "./types.js";

export const VAULT_SCHEMA = "chrome-agent-browser-vault-v0";
export const VAULT_DIGEST_SCHEMA = "chrome-agent-browser-vault-digest-v0";
export const MAX_VAULT_TYPES = 32;
export const MAX_VAULT_RECORDS = 256;
export const MAX_VALUE_BYTES = 16 * 1024;
export const MAX_SEALED_FIELDS = 16;
/** A sealed value shorter than this would match ordinary text by accident. */
export const MIN_SEALED_LENGTH = 6;
export const KEY_BYTES = 32;
const POINTER = /^(\/[^/]*)+$/u;

export interface VaultType {
  id: string;
  display_name: string;
  description: string | null;
  permission_kind: string;
  schema: JsonObject;
  sealed_fields: string[];
}

export interface VaultRecord {
  id: string;
  type: string;
  label: string;
  value: JsonObject;
  /** Part of the clearly labelled fictional demo set, never pre-filled silently. */
  demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface VaultDocument {
  schema: typeof VAULT_SCHEMA;
  types: VaultType[];
  records: VaultRecord[];
}

/** A type as the UI and the registry builder see it: the schema's digest beside it. */
export interface VaultTypeView extends VaultType {
  schema_sha256: string;
}

/** A record as the UI sees it: the value is the person's own, shown to them; the digest beside it. */
export interface VaultRecordView extends VaultRecord {
  digest: string;
}

function refuse(message: string): never {
  throw new CoreError("vault_invalid", message, { status: 400 });
}

/** RFC 6901 lookup, refusing anything that is not a plain path into objects. */
function pointerValue(document: unknown, pointer: string): unknown {
  let current: unknown = document;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function plainJson(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) refuse(`${field} must be a JSON object`);
  let encoded: Uint8Array;
  try {
    encoded = canonicalJson(value);
  } catch {
    refuse(`${field} must be finite JSON`);
  }
  if (encoded.length > MAX_VALUE_BYTES) refuse(`${field} exceeds ${MAX_VALUE_BYTES} bytes`);
  return JSON.parse(new TextDecoder().decode(encoded)) as JsonObject;
}

export function generateVaultKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export function validateVaultType(raw: unknown, field = "type"): VaultType {
  const entry = closedRecord(raw, field, ["id", "display_name", "description", "permission_kind", "schema", "sealed_fields"], ["id", "display_name", "permission_kind", "schema"]);
  const kind = requiredText(entry.permission_kind, `${field}.permission_kind`, { limit: 64 });
  if (!RESOURCE_PERMISSION_KINDS.includes(kind)) refuse(`${field}.permission_kind must be one of ${RESOURCE_PERMISSION_KINDS.join(", ")}`);
  const sealedRaw = entry.sealed_fields ?? [];
  if (!Array.isArray(sealedRaw) || sealedRaw.length > MAX_SEALED_FIELDS) refuse(`${field}.sealed_fields must be a list of at most ${MAX_SEALED_FIELDS} pointers`);
  return {
    id: identifier(entry.id, `${field}.id`),
    display_name: requiredText(entry.display_name, `${field}.display_name`, { limit: 128, nonEmpty: true }),
    description: text(entry.description, `${field}.description`, { allowNull: true, nonEmpty: true }),
    permission_kind: kind,
    schema: plainJson(entry.schema, `${field}.schema`),
    sealed_fields: sealedRaw.map((pointer, at) => {
      const value = requiredText(pointer, `${field}.sealed_fields[${at}]`, { limit: 256, nonEmpty: true });
      if (!POINTER.test(value)) refuse(`${field}.sealed_fields[${at}] must be a JSON Pointer`);
      return value;
    }),
  };
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function validateRecordShape(raw: unknown, field: string): VaultRecord {
  const entry = closedRecord(raw, field, ["id", "type", "label", "value", "demo", "created_at", "updated_at"], ["id", "type", "label", "value"]);
  const stamp = (value: unknown, name: string): string => {
    if (value === undefined || value === null) return "1970-01-01T00:00:00.000Z";
    const out = requiredText(value, `${field}.${name}`, { limit: 64 });
    if (!TIMESTAMP.test(out)) refuse(`${field}.${name} must be an ISO 8601 timestamp`);
    return out;
  };
  return {
    id: identifier(entry.id, `${field}.id`),
    type: identifier(entry.type, `${field}.type`),
    label: requiredText(entry.label, `${field}.label`, { limit: 200, nonEmpty: true }),
    value: plainJson(entry.value, `${field}.value`),
    demo: entry.demo === true,
    created_at: stamp(entry.created_at, "created_at"),
    updated_at: stamp(entry.updated_at, "updated_at"),
  };
}

interface StoredRecord extends VaultRecord {
  digest: string;
  sealed: string[];
}

/**
 * The vault: a validated document plus the HMAC key. `open` validates the whole document or
 * refuses it (all or nothing), validates every record's value against its type's schema, and
 * computes the digests. Mutations go through `putType`, `putRecord` and `deleteRecord`, each
 * validating first; `toDocument` is what the shell persists (without the key).
 */
export class Vault {
  private readonly types = new Map<string, VaultTypeView>();
  private readonly records = new Map<string, StoredRecord>();
  private hmacKey: Awaited<ReturnType<typeof crypto.subtle.importKey>> | null = null;

  private constructor(private readonly key: Uint8Array) {
    if (key.length !== KEY_BYTES) refuse(`the vault key must be ${KEY_BYTES} bytes`);
  }

  static async open(key: Uint8Array, document: unknown): Promise<Vault> {
    const vault = new Vault(key);
    const root = closedRecord(document, "vault", ["schema", "types", "records"], ["types", "records"]);
    if (root.schema !== undefined && root.schema !== VAULT_SCHEMA) refuse(`vault.schema must be ${VAULT_SCHEMA}`);
    if (!Array.isArray(root.types) || root.types.length > MAX_VAULT_TYPES) refuse(`vault.types must be a list of at most ${MAX_VAULT_TYPES}`);
    if (!Array.isArray(root.records) || root.records.length > MAX_VAULT_RECORDS) refuse(`vault.records must be a list of at most ${MAX_VAULT_RECORDS}`);
    for (const [index, raw] of root.types.entries()) await vault.putType(validateVaultType(raw, `vault.types[${index}]`), { allowReplace: false });
    for (const [index, raw] of root.records.entries()) await vault.putRecord(validateRecordShape(raw, `vault.records[${index}]`), { allowReplace: false });
    return vault;
  }

  get size(): number {
    return this.records.size;
  }

  private async hmac(data: Uint8Array): Promise<string> {
    if (!this.hmacKey) this.hmacKey = await crypto.subtle.importKey("raw", bufferSource(this.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return toHex(new Uint8Array(await crypto.subtle.sign({ name: "HMAC" }, this.hmacKey, bufferSource(data))));
  }

  /** Add or replace a type. Replacing a type re-digests its records, which makes plans that named them stale. */
  async putType(raw: unknown, options: { allowReplace?: boolean } = {}): Promise<VaultTypeView> {
    // A view may come back from the UI with its digest beside it; the digest is recomputed, never trusted.
    const { schema_sha256: _digest, ...plain } = isRecord(raw) ? raw : { schema_sha256: undefined };
    const type = validateVaultType(isRecord(raw) ? plain : raw);
    if (this.types.has(type.id) && options.allowReplace === false) refuse(`vault.types has a duplicate id ${type.id}`);
    const view: VaultTypeView = { ...type, schema_sha256: await sha256Hex(canonicalJson(type.schema)) };
    const previous = this.types.get(type.id);
    this.types.set(type.id, view);
    if (previous) {
      const affected = [...this.records.values()].filter((item) => item.type === type.id);
      try {
        for (const record of affected) {
          const { digest: _oldDigest, sealed: _oldSealed, ...plainRecord } = record;
          await this.putRecord(plainRecord, { allowReplace: true });
        }
      } catch (error) {
        // All or nothing: the type and every record already re-digested under it go back, so no
        // record keeps a digest for a schema the vault does not hold (review 1, nit 13).
        this.types.set(type.id, previous);
        for (const record of affected) this.records.set(record.id, record);
        throw error;
      }
    }
    return view;
  }

  deleteType(typeId: string): void {
    if ([...this.records.values()].some((record) => record.type === typeId)) refuse(`type ${typeId} still has records; delete them first`);
    this.types.delete(typeId);
  }

  /** Validate a record against its type's schema and sealed fields, digest it, and store it. */
  async putRecord(raw: unknown, options: { allowReplace?: boolean; now?: Date } = {}): Promise<VaultRecordView> {
    const record = validateRecordShape(raw, "record");
    const type = this.types.get(record.type);
    if (!type) refuse(`record.type ${record.type} names no vault type`);
    if (this.records.has(record.id) && options.allowReplace === false) refuse(`vault.records has a duplicate id ${record.id}`);
    if (this.records.size >= MAX_VAULT_RECORDS && !this.records.has(record.id)) refuse(`the vault holds at most ${MAX_VAULT_RECORDS} records`);
    // The type's own JSON Schema, through the same guarded validator packages' schemas use.
    const files = new Map<string, Uint8Array>([[`vault/${type.id}.schema.json`, canonicalJson(type.schema)]]);
    try {
      await validateInstance(files, `vault/${type.id}.schema.json`, record.value, `${type.display_name} record`);
    } catch (error) {
      refuse(`record.value does not match the ${type.display_name} schema: ${error instanceof Error ? error.message : "invalid"}`);
    }
    const sealed = type.sealed_fields.map((pointer) => {
      const found = pointerValue(record.value, pointer);
      if (typeof found !== "string" || found.length < MIN_SEALED_LENGTH) {
        refuse(`record.value must hold a string of at least ${MIN_SEALED_LENGTH} characters at every sealed field of its type (${pointer})`);
      }
      return found;
    });
    const lowered = record.label.toLowerCase();
    if (sealed.some((value) => lowered.includes(value.toLowerCase()))) refuse("record.label must not contain a sealed value of the record");
    const digest = await this.hmac(canonicalJson({ schema: VAULT_DIGEST_SCHEMA, type: type.id, type_schema_sha256: type.schema_sha256, id: record.id, value: record.value }));
    const now = (options.now ?? new Date()).toISOString();
    const previous = this.records.get(record.id);
    const stored: StoredRecord = {
      ...record,
      created_at: previous?.created_at ?? (record.created_at === "1970-01-01T00:00:00.000Z" ? now : record.created_at),
      updated_at: record.updated_at === "1970-01-01T00:00:00.000Z" || previous ? now : record.updated_at,
      digest,
      sealed,
    };
    this.records.set(record.id, stored);
    return this.view(stored);
  }

  deleteRecord(recordId: string): boolean {
    return this.records.delete(recordId);
  }

  private view(stored: StoredRecord): VaultRecordView {
    const { sealed: _sealed, ...rest } = stored;
    return { ...rest, value: JSON.parse(JSON.stringify(rest.value)) as JsonObject };
  }

  typeViews(): VaultTypeView[] {
    return [...this.types.values()].map((type) => ({ ...type, sealed_fields: [...type.sealed_fields], schema: JSON.parse(JSON.stringify(type.schema)) as JsonObject }));
  }

  recordViews(): VaultRecordView[] {
    return [...this.records.values()].map((record) => this.view(record));
  }

  /** The record with this id, without its value, or nothing. */
  describe(recordId: string): { id: string; type: string; label: string; digest: string } | undefined {
    const stored = this.records.get(recordId);
    return stored ? { id: stored.id, type: stored.type, label: stored.label, digest: stored.digest } : undefined;
  }

  /** What the authorization flow is told: everything a person chooses from, no value. */
  registry(host: { runtimeVersion?: string | null; now?: Date } = {}): Promise<ResourceRegistry> {
    return normalizeResourceRegistry({
      schema: REGISTRY_SCHEMA,
      host: {
        runtime: "chrome-agent-browser",
        runtime_version: host.runtimeVersion ?? null,
        source: "chrome-agent-browser personal vault (chrome.storage.local, HMAC-SHA256 digests under a per-profile key, D-051)",
        captured_at: (host.now ?? new Date()).toISOString(),
      },
      types: [...this.types.values()].map((type) => ({ id: type.id, display_name: type.display_name, description: type.description, permission_kind: type.permission_kind, schema_sha256: type.schema_sha256 })),
      resources: [...this.records.values()].map((record) => ({ id: record.id, type: record.type, label: record.label, digest: record.digest })),
      notes: [],
    });
  }

  /**
   * The value of exactly the granted record, or a refusal: the grant's id, type and digest
   * must all still hold. A removed record, one of another type, or one whose value changed
   * since is refused rather than substituted.
   */
  resolve(grant: ResourceGrant): JsonObject {
    const stored = this.records.get(grant.resource_id);
    if (!stored || stored.type !== grant.resource_type || stored.digest !== grant.resource_digest) {
      throw new CoreError("not_allowed", "the granted host resource no longer exists or is no longer the one that was granted", { status: 403 });
    }
    return JSON.parse(JSON.stringify(stored.value)) as JsonObject;
  }

  /** The sealed values of every record, by record id, for T4's egress guard. */
  sealedValues(): Map<string, string[]> {
    return new Map([...this.records.values()].map((record) => [record.id, [...record.sealed]]));
  }

  toDocument(): VaultDocument {
    return {
      schema: VAULT_SCHEMA,
      types: [...this.types.values()].map(({ schema_sha256: _digest, ...type }) => ({ ...type, sealed_fields: [...type.sealed_fields] })),
      records: [...this.records.values()].map(({ digest: _digest, sealed: _sealed, ...record }) => ({ ...record })),
    };
  }
}

/** The empty vault document a fresh profile starts from: no types, no records. */
export function emptyVaultDocument(): VaultDocument {
  return { schema: VAULT_SCHEMA, types: [], records: [] };
}

/** A fresh demo-set id that cannot collide with a person's own records. */
export function demoRecordId(base: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(base)) throw invalid("demo record ids must be identifiers");
  return base.startsWith("demo_") ? base : `demo_${base}`;
}
