/**
 * Pacing one host implementation: how many calls at once, and how often.
 *
 * A service states its own limits. Crossref's public pool, for example,
 * answers every request with `x-concurrency-limit: 1` and
 * `x-rate-limit-limit: 1` per second, and answers 429 when a client ignores
 * them. A package cannot know which host it runs on or which pool that host is
 * in, so honouring a service's limits is the host implementation's job.
 *
 * Two rules, per binding id, shared by every run in this process:
 *
 * * at most `maxConcurrent` calls in flight;
 * * at least `minIntervalMs` between the starts of two calls.
 *
 * A call that cannot start yet **waits its turn** (first in, first out) rather
 * than being refused: a package whose graph legitimately runs three workers
 * against a binding that serves one at a time is a scheduling fact, not an
 * error. The wait is bounded — by the caller's cancellation and by the
 * binding's own deadline — so pacing can delay a call but never outlive it.
 * Nothing here retries a request: a request that was sent and failed stays
 * failed.
 */
import { setTimeout as delay } from "node:timers/promises";

export type PaceLimits = { maxConcurrent: number; minIntervalMs: number };

type Lane = {
  active: number;
  /** The earliest moment the next call may start; each start reserves its own. */
  nextStart: number;
  queue: Array<() => void>;
};

export class Pacer {
  private readonly lanes = new Map<string, Lane>();

  constructor(private readonly now: () => number = Date.now) {}

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { active: 0, nextStart: Number.NEGATIVE_INFINITY, queue: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** How many calls are in flight or waiting for one binding, for tests and reports. */
  load(key: string): { active: number; waiting: number } {
    const lane = this.lanes.get(key);
    return { active: lane?.active ?? 0, waiting: lane?.queue.length ?? 0 };
  }

  /**
   * Wait for a turn, then return the function that gives it back.
   *
   * Rejects with the signal's reason if the caller is cancelled or the
   * binding's deadline passes while waiting; a rejected wait holds no slot.
   */
  async acquire(key: string, limits: PaceLimits, signal: AbortSignal): Promise<() => void> {
    const lane = this.lane(key);
    const maxConcurrent = Math.max(1, Math.floor(limits.maxConcurrent));
    const interval = Math.max(0, Math.floor(limits.minIntervalMs));
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (lane.active < maxConcurrent && lane.queue.length === 0) {
      lane.active += 1;
    } else {
      // First in, first out. A releasing call hands its slot straight to the
      // next waiter, so nobody arriving later can overtake it.
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = lane.queue.indexOf(wake);
          if (index >= 0) lane.queue.splice(index, 1);
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        lane.queue.push(wake);
      });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = lane.queue.shift();
      if (next) next();
      else lane.active -= 1;
    };
    // Reserve this call's start before waiting, so two calls that hold slots
    // at the same time still start at least one interval apart.
    const start = Math.max(this.now(), lane.nextStart);
    lane.nextStart = start + interval;
    try {
      const wait = start - this.now();
      if (wait > 0) await delay(wait, undefined, { signal });
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }
}

/** One pacer per process: a service's limits apply to this host, not to one run. */
export const HOST_PACER = new Pacer();
