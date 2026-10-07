/**
 * The IndexedDB snapshot store (D-032) over `fake-indexeddb`: snapshots keyed by archive
 * SHA-256, sessions keyed by session id, bytes returned as stored.
 */
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { DATABASE, IndexedDbSnapshotStore } from "../../src/extension/storage/snapshots.js";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** A version 1 database, as the shell wrote it before the size index existed. */
function writeVersionOne(records: Array<{ archive_sha256: string; bytes: Uint8Array; stored_at: string }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore("snapshots", { keyPath: "archive_sha256" });
      db.createObjectStore("sessions", { keyPath: "session_id" });
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction("snapshots", "readwrite");
      for (const record of records) transaction.objectStore("snapshots").put(record);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

describe("the IndexedDB snapshot store", () => {
  it("round-trips snapshots and sessions by their keys", async () => {
    const store = new IndexedDbSnapshotStore();
    const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]);
    await store.putSnapshot({ archive_sha256: "ab".repeat(32), bytes, stored_at: "2026-10-06T12:00:00Z" });
    const stored = await store.getSnapshot("ab".repeat(32));
    expect(stored?.bytes).toEqual(bytes);
    expect(stored?.stored_at).toBe("2026-10-06T12:00:00Z");
    expect(await store.listSnapshots()).toEqual([{ archive_sha256: "ab".repeat(32), bytes: 8 }]);
    expect(await store.getSnapshot("cd".repeat(32))).toBeNull();

    const session = {
      session_id: "s1",
      archive_sha256: "ab".repeat(32),
      archive_bytes: 8,
      created_at: "2026-10-06T12:00:00Z",
      expires_at: "2026-10-06T14:00:00Z",
      source: { kind: "url" as const, display: "https://a.example/x.pkg", advertised_on: null, opened_at: "2026-10-06T12:00:00Z" },
    };
    await store.putSession(session);
    expect(await store.getSession("s1")).toEqual(session);
    expect((await store.listSessions()).map((item) => item.session_id)).toEqual(["s1"]);
    expect(await store.getSession("s2")).toBeNull();

    await store.deleteSession("s1");
    await store.deleteSnapshot("ab".repeat(32));
    expect(await store.getSession("s1")).toBeNull();
    expect(await store.getSnapshot("ab".repeat(32))).toBeNull();
    expect(await store.listSnapshots()).toEqual([]);
    await store.close();
  });

  it("lists sizes from the index, never by loading the archives, and upgrades a version 1 database", async () => {
    await deleteDatabase();
    const big = new Uint8Array(4096);
    await writeVersionOne([
      { archive_sha256: "11".repeat(32), bytes: big, stored_at: "2026-10-06T12:00:00Z" },
      { archive_sha256: "22".repeat(32), bytes: new Uint8Array([1, 2, 3]), stored_at: "2026-10-06T12:00:00Z" },
    ]);
    const store = new IndexedDbSnapshotStore();
    const listed = (await store.listSnapshots()).sort((a, b) => (a.archive_sha256 < b.archive_sha256 ? -1 : 1));
    expect(listed).toEqual([
      { archive_sha256: "11".repeat(32), bytes: 4096 },
      { archive_sha256: "22".repeat(32), bytes: 3 },
    ]);
    // The index follows every write and delete.
    await store.putSnapshot({ archive_sha256: "33".repeat(32), bytes: new Uint8Array(10), stored_at: "2026-10-06T12:00:00Z" });
    await store.deleteSnapshot("11".repeat(32));
    expect((await store.listSnapshots()).map((item) => [item.archive_sha256.slice(0, 2), item.bytes]).sort()).toEqual([
      ["22", 3],
      ["33", 10],
    ]);
    expect(await store.getSnapshot("11".repeat(32))).toBeNull();
    await store.deleteSnapshot("22".repeat(32));
    await store.deleteSnapshot("33".repeat(32));
    await store.close();
  });

  it("a second instance sees the same database", async () => {
    const writer = new IndexedDbSnapshotStore();
    await writer.putSnapshot({ archive_sha256: "ef".repeat(32), bytes: new Uint8Array([1]), stored_at: "2026-10-06T12:00:00Z" });
    const reader = new IndexedDbSnapshotStore();
    expect((await reader.getSnapshot("ef".repeat(32)))?.bytes).toEqual(new Uint8Array([1]));
    await reader.deleteSnapshot("ef".repeat(32));
    await writer.close();
    await reader.close();
  });
});
