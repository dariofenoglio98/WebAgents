/** Pacing one binding: concurrency, spacing, FIFO order and cancellation while waiting. */
import { describe, expect, it } from "vitest";

import { Pacer } from "../../../src/core/tools/pacer.js";
import { CancelledError } from "../../../src/core/workflow/errors.js";

describe("Pacer", () => {
  it("admits at most maxConcurrent calls and hands slots on in arrival order", async () => {
    const pacer = new Pacer();
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    await Promise.all(
      [0, 1, 2, 3, 4].map(async (index) => {
        const release = await pacer.acquire("b", { maxConcurrent: 2, minIntervalMs: 0 }, new AbortController().signal);
        order.push(index);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        release();
      }),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(pacer.load("b")).toEqual({ active: 0, waiting: 0 });
  });

  it("spaces call starts by minIntervalMs even when slots are free", async () => {
    let now = 1000;
    const pacer = new Pacer(() => now);
    const first = await pacer.acquire("c", { maxConcurrent: 4, minIntervalMs: 50 }, new AbortController().signal);
    const started = Date.now();
    // The second start is reserved at now + 50 ms; the real timer waits for it.
    const secondPromise = pacer.acquire("c", { maxConcurrent: 4, minIntervalMs: 50 }, new AbortController().signal);
    now += 10;
    const second = await secondPromise;
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    first();
    second();
  });

  it("a waiter that is cancelled leaves the queue and holds nothing", async () => {
    const pacer = new Pacer();
    const release = await pacer.acquire("d", { maxConcurrent: 1, minIntervalMs: 0 }, new AbortController().signal);
    const controller = new AbortController();
    const waiting = pacer.acquire("d", { maxConcurrent: 1, minIntervalMs: 0 }, controller.signal);
    expect(pacer.load("d").waiting).toBe(1);
    controller.abort(new CancelledError());
    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
    expect(pacer.load("d").waiting).toBe(0);
    release();
    expect(pacer.load("d").active).toBe(0);
  });
});
