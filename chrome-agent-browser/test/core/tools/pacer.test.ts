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

  it("spaces the next start from the previous answer too, so a slow first call cannot crowd the second (D-081 as amended)", async () => {
    let now = 0;
    const pacer = new Pacer(() => now);
    const limits = { maxConcurrent: 1, minIntervalMs: 40 };
    const first = await pacer.acquire("e", limits, new AbortController().signal);
    const second = pacer.acquire("e", limits, new AbortController().signal);
    // The first call takes longer than the interval (a connection being set up), then answers.
    now = 100;
    const answeredAt = Date.now();
    first();
    // Measured from the start alone the second could leave at once (0 + 40 < 100); from the answer it waits 40 ms.
    await second;
    expect(Date.now() - answeredAt).toBeGreaterThanOrEqual(30);
  });

  it("a call cancelled while waiting for its start sent nothing, so no interval follows it", async () => {
    let now = 0;
    const pacer = new Pacer(() => now);
    const limits = { maxConcurrent: 1, minIntervalMs: 10_000 };
    (await pacer.acquire("f", limits, new AbortController().signal))(false);
    now = 20_000;
    const started = Date.now();
    const next = await pacer.acquire("f", limits, new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(50);
    next();
  });

  it("a call cancelled during its timed wait withdraws its start reservation (T6 review, nit 2)", async () => {
    let now = 0;
    const pacer = new Pacer(() => now);
    const limits = { maxConcurrent: 4, minIntervalMs: 10_000 };
    const first = await pacer.acquire("g", limits, new AbortController().signal);
    // The second reserves its start at 10 s and waits for it; it is cancelled before then.
    const controller = new AbortController();
    const second = pacer.acquire("g", limits, controller.signal);
    controller.abort(new CancelledError());
    await expect(second).rejects.toBeInstanceOf(CancelledError);
    // The third starts where the second would have: 10 s after the first, not 20 s.
    now = 10_000;
    const started = Date.now();
    const third = await pacer.acquire("g", limits, new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(50);
    first();
    third();
    expect(pacer.load("g")).toEqual({ active: 0, waiting: 0 });
  });

  it("withdrawing a cancelled reservation keeps the floor an answer set meanwhile (T7 review 1, finding 1)", async () => {
    let now = 0;
    const pacer = new Pacer(() => now);
    const limits = { maxConcurrent: 2, minIntervalMs: 1_000 };
    // A starts at 0; B reserves 1 s and waits for it.
    const a = await pacer.acquire("i", limits, new AbortController().signal);
    const controller = new AbortController();
    const b = pacer.acquire("i", limits, controller.signal);
    // A answers at 0.3 s: the next start may not come before 1.3 s.
    now = 300;
    a();
    // B is cancelled at 0.5 s, before its start: its 1 s reservation is withdrawn.
    now = 500;
    controller.abort(new CancelledError());
    await expect(b).rejects.toBeInstanceOf(CancelledError);
    // C at 1 s must still wait for 1.3 s (one interval after A's answer), not start at once.
    now = 1_000;
    const started = Date.now();
    const c = await pacer.acquire("i", limits, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    c();
    expect(pacer.load("i")).toEqual({ active: 0, waiting: 0 });
  });

  it("a slot handed to a waiter whose signal aborted in the same turn is given back at once (T6 review, nit 3)", async () => {
    let now = 0;
    const pacer = new Pacer(() => now);
    const limits = { maxConcurrent: 1, minIntervalMs: 10_000 };
    const first = await pacer.acquire("h", limits, new AbortController().signal);
    const controller = new AbortController();
    const waiting = pacer.acquire("h", limits, controller.signal);
    // The release hands the slot over (resolving the waiter's promise); the abort lands before
    // the waiter runs again, so its abort listener has already been removed.
    first(false);
    controller.abort(new CancelledError());
    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
    expect(pacer.load("h")).toEqual({ active: 0, waiting: 0 });
    // Nothing was sent and the waiter reserved nothing: at the first call's own spacing (10 s
    // after its start) the next call starts at once, not another interval later.
    now = 10_000;
    const started = Date.now();
    const next = await pacer.acquire("h", limits, new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(50);
    next();
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
