/**
 * The interpreter's building blocks: the synchronous SHA-256 against WebCrypto, Python's JSON
 * and timestamp layouts against vectors the reference produced, cancellation tokens with
 * deadlines, and FIFO semaphores.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Hex, sha256HexSync } from "../../../src/core/hash.js";
import { pyFloatRepr, pyIsoTimestamp, pyJsonDumps } from "../../../src/core/pyjson.js";
import { CancelToken, sleep, withDeadline } from "../../../src/core/workflow/cancel.js";
import { CancelledError, TimeoutError } from "../../../src/core/workflow/errors.js";
import { Semaphore } from "../../../src/core/workflow/sync.js";
import { PROJECT } from "../../helpers/paths.js";

const VECTORS = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "py-json-vectors.json"), "utf8")) as {
  floats: Array<{ value: number; repr: string }>;
  dumps: Array<{ value: unknown; sorted: string; compact: string }>;
};

describe("sha256HexSync equals WebCrypto's digest", () => {
  it("on empty, short, block-boundary and long inputs", async () => {
    const inputs = [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70000].map((length) => {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 7919 + length) & 0xff;
      return bytes;
    });
    for (const bytes of inputs) expect(sha256HexSync(bytes)).toBe(await sha256Hex(bytes));
    expect(sha256HexSync(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("Python layouts", () => {
  it("repr(float) matches CPython on the recorded vectors", () => {
    for (const { value, repr } of VECTORS.floats) expect(pyFloatRepr(value), String(value)).toBe(repr);
  });

  it("json.dumps(sort_keys=True) matches with default and compact separators", () => {
    for (const { value, sorted, compact } of VECTORS.dumps) {
      expect(pyJsonDumps(value, { sortKeys: true })).toBe(sorted);
      expect(pyJsonDumps(value, { sortKeys: true, compact: true })).toBe(compact);
    }
  });

  it("isoformat: microseconds from milliseconds, +00:00, no fraction at zero", () => {
    expect(pyIsoTimestamp(new Date("2026-10-06T12:00:00.123Z"))).toBe("2026-10-06T12:00:00.123000+00:00");
    expect(pyIsoTimestamp(new Date("2026-10-06T12:00:00.000Z"))).toBe("2026-10-06T12:00:00+00:00");
  });
});

describe("CancelToken and withDeadline", () => {
  it("cancels a subtree once, exposes the reason and aborts the signal", () => {
    const root = new CancelToken();
    const child = root.child();
    const grandchild = child.child();
    expect(root.cancelled).toBe(false);
    root.cancel();
    expect(grandchild.cancelled).toBe(true);
    expect(grandchild.signal.aborted).toBe(true);
    expect(() => grandchild.throwIfCancelled()).toThrow(CancelledError);
    const late = root.child();
    expect(late.cancelled).toBe(true);
    root.cancel(new TimeoutError("ignored: already cancelled"));
    expect(root.reason).toBeInstanceOf(CancelledError);
  });

  it("converts a deadline into TimeoutError at the boundary while the inside sees CancelledError", async () => {
    const root = new CancelToken();
    let inner: unknown = null;
    await expect(
      withDeadline(0.02, root, async (token) => {
        try {
          await sleep(5, token);
        } catch (error) {
          inner = error;
          throw error;
        }
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(inner).toBeInstanceOf(CancelledError);
    expect(root.cancelled).toBe(false);
  });

  it("returns the value when the work finishes first, and discards a late value", async () => {
    const root = new CancelToken();
    await expect(withDeadline(1, root, async () => 42)).resolves.toBe(42);
    await expect(withDeadline(0.01, root, async () => sleep(0.05).then(() => "late"))).rejects.toBeInstanceOf(TimeoutError);
  });

  it("an outer cancellation surfaces as CancelledError, not as a timeout", async () => {
    const root = new CancelToken();
    const pending = withDeadline(5, root, (token) => sleep(5, token));
    root.cancel();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("Semaphore", () => {
  it("is FIFO, hands a released slot to the next waiter and never over-admits", async () => {
    const semaphore = new Semaphore(2);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const jobs = [0, 1, 2, 3, 4].map(async (index) => {
      const release = await semaphore.acquire();
      order.push(index);
      active += 1;
      peak = Math.max(peak, active);
      await sleep(0.005);
      active -= 1;
      release();
      release(); // idempotent
    });
    await Promise.all(jobs);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(semaphore.free).toBe(2);
  });

  it("a cancelled waiter leaves the queue holding nothing", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const token = new CancelToken();
    const waiting = semaphore.acquire(token);
    token.cancel();
    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
    release();
    expect(semaphore.free).toBe(1);
  });
});
