/**
 * The one IndexedDB database of the extension (`agent-browser`, D-032), opened by every store
 * through this module so that the schema upgrade runs exactly once per version.
 *
 *   snapshots     archive bytes, keyed by archive SHA-256 (version 1)
 *   sessions      sessions, keyed by session id (version 1)
 *   sizes         one small record per snapshot with its byte count (version 2)
 *   runs          run records with their checkpoints, keyed by run id (version 3, D-071)
 *   artifacts     a run's files as bytes, keyed by `<run id>/<name>` (version 3)
 *   observations  outbound request bodies recorded in test mode, auto-keyed (version 3, D-028)
 */

export const DATABASE = "agent-browser";
/** Version 2 added the `sizes` store; version 3 the run, artifact and observation stores. */
export const VERSION = 3;

export type StoreName = "snapshots" | "sessions" | "sizes" | "runs" | "artifacts" | "observations";

export function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

export function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function upgrade(opening: IDBOpenDBRequest, event: IDBVersionChangeEvent): void {
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
        const record = current.value as { archive_sha256: string; bytes: Uint8Array };
        sizes.put({ archive_sha256: record.archive_sha256, bytes: record.bytes.byteLength });
        current.continue();
      };
    }
  }
  if (!db.objectStoreNames.contains("runs")) {
    const runs = db.createObjectStore("runs", { keyPath: "run_id" });
    runs.createIndex("session_id", "session_id", { unique: false });
    runs.createIndex("created_at", "created_at", { unique: false });
  }
  if (!db.objectStoreNames.contains("artifacts")) {
    const artifacts = db.createObjectStore("artifacts", { keyPath: "key" });
    artifacts.createIndex("run_id", "run_id", { unique: false });
  }
  if (!db.objectStoreNames.contains("observations")) {
    const observations = db.createObjectStore("observations", { keyPath: "id", autoIncrement: true });
    observations.createIndex("run_id", "run_id", { unique: false });
  }
}

/** A lazily opened connection; a failed open is retried on the next call, never cached. */
export class Database {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: () => IDBFactory = () => indexedDB) {}

  open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const opened = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = this.factory().open(DATABASE, VERSION);
      opening.onupgradeneeded = (event) => upgrade(opening, event);
      opening.onsuccess = () => {
        // Another context upgrading the schema later asks this connection to close.
        opening.result.onversionchange = () => {
          opening.result.close();
          this.database = null;
        };
        resolve(opening.result);
      };
      opening.onerror = () => reject(opening.error ?? new Error("IndexedDB open failed"));
      opening.onblocked = () => reject(new Error("IndexedDB open blocked by another connection"));
    });
    this.database = opened;
    opened.catch(() => {
      this.database = null;
    });
    return opened;
  }

  async close(): Promise<void> {
    const pending = this.database;
    this.database = null;
    if (pending) (await pending).close();
  }

  async transaction(names: StoreName[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    const db = await this.open();
    return db.transaction(names, mode);
  }

  async store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.transaction([name], mode)).objectStore(name);
  }
}
