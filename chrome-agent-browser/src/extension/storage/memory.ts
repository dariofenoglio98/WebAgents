/**
 * Where the memory lives in Chrome (T19, memory.v0 §2, D-221): one row per record in IndexedDB
 * (`memory_records`), the types, the usage log and the custom-type approvals as one document
 * (`memory_meta`). A record's sealed values are sealed at rest under the memory data key the
 * secret store holds (AES-256-GCM, the associated data naming the record and the pointer), and
 * replaced in the row by the `sealed:omitted` placeholder: with the store locked the Memory page
 * still shows every title, field and body (M-10), and no sealed value is readable; with it
 * unlocked the values are opened on load, and a value the key cannot open marks its record
 * unreadable rather than silently emptying it. Nothing here touches `storage.sync`.
 */
import type { JsonObject } from "../../core/json.js";
import { MEMORY_STORE_SCHEMA, type MemorySnapshot } from "../../core/memory/store.js";
import { type MemoryRecord, type UsageEntry, pointerSet, SEALED_PLACEHOLDER } from "../../core/memory/model.js";
import type { MemoryType } from "../../core/memory/types.js";
import { sealedValuesOf } from "../../core/memory/validate.js";
import { openBox, sealBox, type SealedBox } from "../../core/secrets.js";
import { completion, request, type Database } from "./database.js";

export const MEMORY_ROW_SCHEMA = "chrome-agent-browser-memory-row-v0";
export const MEMORY_META_KEY = "memory";

/** One record at rest: the record with placeholders at its sealed pointers, and the sealed values beside it. */
export interface StoredMemoryRecord {
  id: string;
  schema: typeof MEMORY_ROW_SCHEMA;
  record: MemoryRecord;
  /** JSON Pointer → the value sealed under the data key; absent for a record without sealed fields. */
  sealed_values: Record<string, SealedBox>;
}

export interface StoredMemoryMeta {
  key: typeof MEMORY_META_KEY;
  schema: typeof MEMORY_STORE_SCHEMA;
  types: MemoryType[];
  usage: UsageEntry[];
  approvals: Record<string, string>;
}

export interface MemoryStorage {
  loadRecords(): Promise<StoredMemoryRecord[]>;
  putRecords(rows: readonly StoredMemoryRecord[]): Promise<void>;
  deleteRecords(ids: readonly string[]): Promise<void>;
  loadMeta(): Promise<StoredMemoryMeta | null>;
  saveMeta(meta: StoredMemoryMeta): Promise<void>;
  /** Forget memory: every row and the meta document. */
  clear(): Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The associated data of one sealed value: the row schema, the record and the pointer, so a box opens only where it was sealed. */
export function sealedAad(recordId: string, pointer: string): string {
  return `${MEMORY_ROW_SCHEMA}|${recordId}|${pointer}`;
}

/** A record as it is stored: sealed values sealed under the data key, placeholders in the row. */
export async function sealRecord(record: MemoryRecord, dataKey: Uint8Array, random?: (length: number) => Uint8Array): Promise<StoredMemoryRecord> {
  const row: MemoryRecord = clone(record);
  const boxes: Record<string, SealedBox> = {};
  for (const [pointer, value] of sealedValuesOf(record)) {
    boxes[pointer] = await sealBox(dataKey, sealedAad(record.id, pointer), new TextEncoder().encode(value), random);
    pointerSet(row.fields, pointer, SEALED_PLACEHOLDER);
  }
  return { id: record.id, schema: MEMORY_ROW_SCHEMA, record: row, sealed_values: boxes };
}

/**
 * A stored row as the store reads it: with the data key, every sealed value opened (a box the
 * key cannot open leaves the placeholder and marks the record unreadable); without it (the store
 * locked), the placeholders stay and the record counts as locked, not unreadable.
 */
export async function openRecord(row: StoredMemoryRecord, dataKey: Uint8Array | null): Promise<{ record: MemoryRecord; unreadable: boolean }> {
  const record: MemoryRecord = clone(row.record);
  let unreadable = false;
  if (dataKey !== null) {
    for (const [pointer, box] of Object.entries(row.sealed_values ?? {})) {
      const opened = await openBox(dataKey, sealedAad(row.id, pointer), box);
      if (opened === null) unreadable = true;
      else pointerSet(record.fields, pointer, new TextDecoder().decode(opened));
    }
  }
  return { record, unreadable };
}

/** The meta document of a snapshot (everything but the records). */
export function metaOf(snapshot: MemorySnapshot): StoredMemoryMeta {
  return { key: MEMORY_META_KEY, schema: MEMORY_STORE_SCHEMA, types: clone(snapshot.types), usage: clone(snapshot.usage), approvals: { ...snapshot.approvals } };
}

export class MemoryMemoryStorage implements MemoryStorage {
  readonly rows = new Map<string, StoredMemoryRecord>();
  meta: StoredMemoryMeta | null = null;

  async loadRecords(): Promise<StoredMemoryRecord[]> {
    return [...this.rows.values()].map(clone);
  }
  async putRecords(rows: readonly StoredMemoryRecord[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, clone(row));
  }
  async deleteRecords(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
  async loadMeta(): Promise<StoredMemoryMeta | null> {
    return this.meta === null ? null : clone(this.meta);
  }
  async saveMeta(meta: StoredMemoryMeta): Promise<void> {
    this.meta = clone(meta);
  }
  async clear(): Promise<void> {
    this.rows.clear();
    this.meta = null;
  }
}

export class IndexedDbMemoryStorage implements MemoryStorage {
  constructor(private readonly database: Database) {}

  async loadRecords(): Promise<StoredMemoryRecord[]> {
    const store = await this.database.store("memory_records", "readonly");
    const rows = (await request(store.getAll())) as StoredMemoryRecord[];
    return rows.filter((row) => row !== null && typeof row === "object" && row.schema === MEMORY_ROW_SCHEMA && typeof row.id === "string" && typeof row.record === "object");
  }

  async putRecords(rows: readonly StoredMemoryRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const transaction = await this.database.transaction(["memory_records"], "readwrite");
    const store = transaction.objectStore("memory_records");
    for (const row of rows) store.put(row as unknown as JsonObject);
    await completion(transaction);
  }

  async deleteRecords(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const transaction = await this.database.transaction(["memory_records"], "readwrite");
    const store = transaction.objectStore("memory_records");
    for (const id of ids) store.delete(id);
    await completion(transaction);
  }

  async loadMeta(): Promise<StoredMemoryMeta | null> {
    const store = await this.database.store("memory_meta", "readonly");
    const meta = (await request(store.get(MEMORY_META_KEY))) as StoredMemoryMeta | undefined;
    return meta !== undefined && meta.schema === MEMORY_STORE_SCHEMA ? meta : null;
  }

  async saveMeta(meta: StoredMemoryMeta): Promise<void> {
    const transaction = await this.database.transaction(["memory_meta"], "readwrite");
    transaction.objectStore("memory_meta").put(meta as unknown as JsonObject);
    await completion(transaction);
  }

  async clear(): Promise<void> {
    const transaction = await this.database.transaction(["memory_records", "memory_meta"], "readwrite");
    transaction.objectStore("memory_records").clear();
    transaction.objectStore("memory_meta").clear();
    await completion(transaction);
  }
}
