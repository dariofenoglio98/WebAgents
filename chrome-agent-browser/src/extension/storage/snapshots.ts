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
import { completion, Database, request } from "./database.js";

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

export { DATABASE, VERSION } from "./database.js";

/** The IndexedDB store the extension uses. */
export class IndexedDbSnapshotStore implements SnapshotStore {
  constructor(private readonly database: Database = new Database()) {}

  /** Close the connection (tests, and a future explicit shutdown); the next call reopens. */
  async close(): Promise<void> {
    await this.database.close();
  }

  async putSnapshot(record: SnapshotRecord): Promise<void> {
    const transaction = await this.database.transaction(["snapshots", "sizes"], "readwrite");
    transaction.objectStore("snapshots").put(record);
    transaction.objectStore("sizes").put({ archive_sha256: record.archive_sha256, bytes: record.bytes.byteLength });
    await completion(transaction);
  }

  async getSnapshot(archiveSha256: string): Promise<SnapshotRecord | null> {
    const record = (await request((await this.database.store("snapshots", "readonly")).get(archiveSha256))) as SnapshotRecord | undefined;
    return record ?? null;
  }

  async deleteSnapshot(archiveSha256: string): Promise<void> {
    const transaction = await this.database.transaction(["snapshots", "sizes"], "readwrite");
    transaction.objectStore("snapshots").delete(archiveSha256);
    transaction.objectStore("sizes").delete(archiveSha256);
    await completion(transaction);
  }

  async listSnapshots(): Promise<Array<{ archive_sha256: string; bytes: number }>> {
    const records = (await request((await this.database.store("sizes", "readonly")).getAll())) as Array<{ archive_sha256: string; bytes: number }>;
    return records.map((record) => ({ archive_sha256: record.archive_sha256, bytes: record.bytes }));
  }

  async putSession(session: StoredSession): Promise<void> {
    await request((await this.database.store("sessions", "readwrite")).put(session));
  }

  async getSession(sessionId: string): Promise<StoredSession | null> {
    const session = (await request((await this.database.store("sessions", "readonly")).get(sessionId))) as StoredSession | undefined;
    return session ?? null;
  }

  async listSessions(): Promise<StoredSession[]> {
    return (await request((await this.database.store("sessions", "readonly")).getAll())) as StoredSession[];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await request((await this.database.store("sessions", "readwrite")).delete(sessionId));
  }
}
