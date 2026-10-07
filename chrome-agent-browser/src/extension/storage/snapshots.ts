/**
 * Snapshots and sessions (D-032): the bytes of every opened package, captured once, and
 * the sessions that refer to them. The store is an interface so the controller can be tested
 * in Node; the extension uses IndexedDB (database `agent-browser`, stores `snapshots` keyed by
 * archive SHA-256, `sessions` keyed by session id, and `sizes`: one small record per snapshot
 * with its byte count, written in the same transaction, so that listing the cache never
 * loads the archives themselves).
 */
import type { AuthorizationReceipt, RunPlan } from "../../core/types.js";
import type { SessionSource } from "../messages.js";

export interface SnapshotRecord {
  archive_sha256: string;
  bytes: Uint8Array;
  stored_at: string;
}

export interface StoredSession {
  session_id: string;
  archive_sha256: string;
  archive_bytes: number;
  created_at: string;
  expires_at: string;
  source: SessionSource;
  /** The session's receipt and plan (D-056): stored with the session so a plan survives a worker restart or a page reload. */
  authorization?: AuthorizationReceipt | null;
  run_plan?: RunPlan | null;
  /** Whether a run has spent this receipt's `once` grants (set by the execution host, T5). */
  once_spent?: boolean;
}

export interface SnapshotStore {
  putSnapshot(record: SnapshotRecord): Promise<void>;
  getSnapshot(archiveSha256: string): Promise<SnapshotRecord | null>;
  deleteSnapshot(archiveSha256: string): Promise<void>;
  listSnapshots(): Promise<Array<{ archive_sha256: string; bytes: number }>>;
  putSession(session: StoredSession): Promise<void>;
  getSession(sessionId: string): Promise<StoredSession | null>;
  listSessions(): Promise<StoredSession[]>;
  deleteSession(sessionId: string): Promise<void>;
}

/** In-memory store for tests and for the CLI. */
export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly sessions = new Map<string, StoredSession>();

  async putSnapshot(record: SnapshotRecord): Promise<void> {
    this.snapshots.set(record.archive_sha256, { ...record, bytes: record.bytes.slice() });
  }

  async getSnapshot(archiveSha256: string): Promise<SnapshotRecord | null> {
    const record = this.snapshots.get(archiveSha256);
    return record ? { ...record, bytes: record.bytes.slice() } : null;
  }

  async deleteSnapshot(archiveSha256: string): Promise<void> {
    this.snapshots.delete(archiveSha256);
  }

  async listSnapshots(): Promise<Array<{ archive_sha256: string; bytes: number }>> {
    return [...this.snapshots.values()].map((record) => ({ archive_sha256: record.archive_sha256, bytes: record.bytes.length }));
  }

  async putSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.session_id, { ...session });
  }

  async getSession(sessionId: string): Promise<StoredSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  async listSessions(): Promise<StoredSession[]> {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

export const DATABASE = "agent-browser";
/** Version 2 added the `sizes` store; the upgrade fills it from the snapshots already stored. */
export const VERSION = 2;

type StoreName = "snapshots" | "sessions" | "sizes";

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** The IndexedDB store the extension uses. */
export class IndexedDbSnapshotStore implements SnapshotStore {
  private database: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const opened = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(DATABASE, VERSION);
      opening.onupgradeneeded = (event) => {
        const db = opening.result;
        if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "archive_sha256" });
        if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "session_id" });
        if (!db.objectStoreNames.contains("sizes")) {
          const sizes = db.createObjectStore("sizes", { keyPath: "archive_sha256" });
          if (event.oldVersion >= 1) {
            // Upgrading from version 1: index every snapshot already stored.
            const cursor = opening.transaction!.objectStore("snapshots").openCursor();
            cursor.onsuccess = () => {
              const current = cursor.result;
              if (!current) return;
              const record = current.value as SnapshotRecord;
              sizes.put({ archive_sha256: record.archive_sha256, bytes: record.bytes.byteLength });
              current.continue();
            };
          }
        }
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error("IndexedDB open failed"));
    });
    this.database = opened;
    opened.catch(() => {
      this.database = null; // A failed open is retried on the next call, never cached.
    });
    return opened;
  }

  /** Close the connection (tests, and a future explicit shutdown); the next call reopens. */
  async close(): Promise<void> {
    const pending = this.database;
    this.database = null;
    if (pending) (await pending).close();
  }

  private async transaction(names: StoreName[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    const db = await this.open();
    return db.transaction(names, mode);
  }

  private async store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.transaction([name], mode)).objectStore(name);
  }

  async putSnapshot(record: SnapshotRecord): Promise<void> {
    const transaction = await this.transaction(["snapshots", "sizes"], "readwrite");
    transaction.objectStore("snapshots").put(record);
    transaction.objectStore("sizes").put({ archive_sha256: record.archive_sha256, bytes: record.bytes.byteLength });
    await completion(transaction);
  }

  async getSnapshot(archiveSha256: string): Promise<SnapshotRecord | null> {
    const record = (await request((await this.store("snapshots", "readonly")).get(archiveSha256))) as SnapshotRecord | undefined;
    return record ?? null;
  }

  async deleteSnapshot(archiveSha256: string): Promise<void> {
    const transaction = await this.transaction(["snapshots", "sizes"], "readwrite");
    transaction.objectStore("snapshots").delete(archiveSha256);
    transaction.objectStore("sizes").delete(archiveSha256);
    await completion(transaction);
  }

  async listSnapshots(): Promise<Array<{ archive_sha256: string; bytes: number }>> {
    const records = (await request((await this.store("sizes", "readonly")).getAll())) as Array<{ archive_sha256: string; bytes: number }>;
    return records.map((record) => ({ archive_sha256: record.archive_sha256, bytes: record.bytes }));
  }

  async putSession(session: StoredSession): Promise<void> {
    await request((await this.store("sessions", "readwrite")).put(session));
  }

  async getSession(sessionId: string): Promise<StoredSession | null> {
    const session = (await request((await this.store("sessions", "readonly")).get(sessionId))) as StoredSession | undefined;
    return session ?? null;
  }

  async listSessions(): Promise<StoredSession[]> {
    return (await request((await this.store("sessions", "readonly")).getAll())) as StoredSession[];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await request((await this.store("sessions", "readwrite")).delete(sessionId));
  }
}
