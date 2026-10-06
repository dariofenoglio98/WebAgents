/**
 * Snapshots and sessions (D-032): the bytes of every opened package, captured once, and
 * the sessions that refer to them. The store is an interface so the controller can be tested
 * in Node; the extension uses IndexedDB (database `agent-browser`, stores `snapshots` keyed by
 * archive SHA-256 and `sessions` keyed by session id).
 */
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

const DATABASE = "agent-browser";
const VERSION = 1;

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

/** The IndexedDB store the extension uses. */
export class IndexedDbSnapshotStore implements SnapshotStore {
  private database: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const opening = indexedDB.open(DATABASE, VERSION);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "archive_sha256" });
        if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "session_id" });
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error("IndexedDB open failed"));
    });
    return this.database;
  }

  private async store(name: "snapshots" | "sessions", mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(name, mode).objectStore(name);
  }

  async putSnapshot(record: SnapshotRecord): Promise<void> {
    await request((await this.store("snapshots", "readwrite")).put(record));
  }

  async getSnapshot(archiveSha256: string): Promise<SnapshotRecord | null> {
    const record = (await request((await this.store("snapshots", "readonly")).get(archiveSha256))) as SnapshotRecord | undefined;
    return record ?? null;
  }

  async deleteSnapshot(archiveSha256: string): Promise<void> {
    await request((await this.store("snapshots", "readwrite")).delete(archiveSha256));
  }

  async listSnapshots(): Promise<Array<{ archive_sha256: string; bytes: number }>> {
    const records = (await request((await this.store("snapshots", "readonly")).getAll())) as SnapshotRecord[];
    return records.map((record) => ({ archive_sha256: record.archive_sha256, bytes: record.bytes.byteLength }));
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
