/**
 * The IndexedDB snapshot store (D-032) over `fake-indexeddb`: snapshots keyed by archive
 * SHA-256, sessions keyed by session id, bytes returned as stored.
 */
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { IndexedDbSnapshotStore } from "../../src/extension/storage/snapshots.js";

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
  });

  it("a second instance sees the same database", async () => {
    const writer = new IndexedDbSnapshotStore();
    await writer.putSnapshot({ archive_sha256: "ef".repeat(32), bytes: new Uint8Array([1]), stored_at: "2026-10-06T12:00:00Z" });
    const reader = new IndexedDbSnapshotStore();
    expect((await reader.getSnapshot("ef".repeat(32)))?.bytes).toEqual(new Uint8Array([1]));
    await reader.deleteSnapshot("ef".repeat(32));
  });
});
