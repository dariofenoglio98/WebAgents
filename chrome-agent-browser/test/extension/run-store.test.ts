/**
 * The IndexedDB run store (D-071) over `fake-indexeddb`: `updateRun` is one atomic step, so a
 * write by the service worker racing the execution host's final write never regresses a settled
 * run (T5 review 1, finding 1).
 */
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../../src/core/execution/record.js";
import { isTerminal } from "../../src/extension/background/runs.js";
import { Database } from "../../src/extension/storage/database.js";
import { IndexedDbRunStore, type RunInvocation, type StoredRun } from "../../src/extension/storage/runs.js";

function run(runId: string, status: RunRecord["status"], cancelRequested = false): StoredRun {
  return {
    run_id: runId,
    session_id: "session1",
    created_at: "2026-10-07T00:00:00.000Z",
    updated_at: "2026-10-07T00:00:00.000Z",
    record: { status, cancelRequested } as unknown as RunRecord,
    invocation: { archive_sha256: "a".repeat(64) } as unknown as RunInvocation,
    task_text: null,
    checkpoints: 0,
    progress: null,
    audit: [],
    usage: null,
    result: null,
  };
}

const flag = (current: StoredRun): StoredRun | null => (isTerminal(current.record.status) ? null : { ...current, record: { ...current.record, cancelRequested: true } });

describe("IndexedDbRunStore.updateRun", () => {
  const store = new IndexedDbRunStore(new Database());

  it("reads, decides and writes in one transaction, and returns what is stored", async () => {
    await store.putRun(run("run_a", "running"));
    const updated = await store.updateRun("run_a", flag);
    expect(updated?.record).toMatchObject({ status: "running", cancelRequested: true });
    expect((await store.getRun("run_a"))?.record).toMatchObject({ cancelRequested: true });
    // A terminal record is left alone; the result is the stored record.
    await store.putRun(run("run_b", "completed"));
    expect((await store.updateRun("run_b", flag))?.record).toMatchObject({ status: "completed", cancelRequested: false });
    expect(await store.updateRun("run_missing", flag)).toBeNull();
  });

  it("racing the host's final write in either order, the run ends settled, never back in flight (finding 1)", async () => {
    for (const hostFirst of [true, false]) {
      const id = `run_race_${hostFirst ? "host" : "worker"}`;
      await store.putRun(run(id, "running"));
      const hostWrite = () => store.putRun(run(id, "completed"));
      const workerWrite = () => store.updateRun(id, flag);
      await Promise.all(hostFirst ? [hostWrite(), workerWrite()] : [workerWrite(), hostWrite()]);
      expect((await store.getRun(id))?.record.status, id).toBe("completed");
    }
  });
});
