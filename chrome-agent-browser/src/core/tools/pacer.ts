/**
 * Pacing one host implementation (`tool-pacer.ts`): at most `maxConcurrent` calls in flight
 * per binding id and at least `minIntervalMs` between two starts, shared by every run in this
 * process. A call that cannot start yet waits its turn (first in, first out) rather than being
 * refused; the wait is bounded by the caller's signal, so pacing can delay a call but never
 * outlive it. Nothing here retries a request.
 *
 * The interval also separates a call's **answer** from the next start (D-081 as amended, T6): a
 * browser reuses one connection to a service, so only the first request pays the connection's
 * setup and reaches the service late, and a second request started one interval after the first
 * *started* reached Crossref under a second after it and was refused with 429 (the first live
 * Chrome run, 2026-10-08). The reference's Node transport opens a connection per request, so its
 * start-to-start spacing survives the trip; measuring from the answer as well restores that
 * guarantee here. It only ever adds delay; the values (`maxConcurrent`, `minIntervalMs`) are the
 * binding's, unchanged.
 */
import { CancelledError } from "../workflow/errors.js";

export interface PaceLimits {
  maxConcurrent: number;
  minIntervalMs: number;
}

interface Lane {
  active: number;
  /** The earliest moment the next call may start; each start reserves its own. */
  nextStart: number;
  queue: Array<() => void>;
}

function reasonOf(signal: AbortSignal): Error {
  return (signal.reason as Error | undefined) ?? new CancelledError();
}

export class Pacer {
  private readonly lanes = new Map<string, Lane>();

  constructor(private readonly now: () => number = () => Date.now()) {}

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

  /** Wait for a turn, then return the function that gives it back. Rejects with the signal's reason when cancelled while waiting. */
  async acquire(key: string, limits: PaceLimits, signal: AbortSignal): Promise<(answered?: boolean) => void> {
    const lane = this.lane(key);
    const maxConcurrent = Math.max(1, Math.floor(limits.maxConcurrent));
    const interval = Math.max(0, Math.floor(limits.minIntervalMs));
    if (signal.aborted) throw reasonOf(signal);
    if (lane.active < maxConcurrent && lane.queue.length === 0) {
      lane.active += 1;
    } else {
      // First in, first out: a releasing call hands its slot straight to the next waiter.
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = lane.queue.indexOf(wake);
          if (index >= 0) lane.queue.splice(index, 1);
          reject(reasonOf(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        lane.queue.push(wake);
      });
    }
    let released = false;
    /** Give the slot back; `answered` (the call reached the service) also starts an interval from now. */
    const release = (answered = true) => {
      if (released) return;
      released = true;
      if (answered && interval > 0) lane.nextStart = Math.max(lane.nextStart, this.now() + interval);
      const next = lane.queue.shift();
      if (next) next();
      else lane.active -= 1;
    };
    // Reserve this call's start before waiting, so two calls that hold slots at the same
    // time still start at least one interval apart.
    const start = Math.max(this.now(), lane.nextStart);
    lane.nextStart = start + interval;
    const wait = start - this.now();
    if (wait > 0) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, wait);
          const onAbort = () => {
            clearTimeout(timer);
            reject(reasonOf(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      } catch (error) {
        // Cancelled while waiting for its start: nothing was sent, so no interval follows it.
        release(false);
        throw error;
      }
    }
    return release;
  }
}

/** One pacer per process: a service's limits apply to this host, not to one run. */
export const HOST_PACER = new Pacer();
