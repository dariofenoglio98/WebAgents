/**
 * FIFO counting semaphores (`asyncio.Semaphore`) whose waiters can be cancelled.
 *
 * `Runtime` holds one per worker role (`max_instances`) and one global one
 * (`max_parallel_workers`); a map's consumers queue on them in arrival order, and a waiter
 * whose token is cancelled leaves the queue holding nothing. A released slot is handed straight
 * to the next waiter, so nobody arriving later can overtake it.
 */
import type { CancelToken } from "./cancel.js";

interface Waiter {
  grant: () => void;
  fail: (reason: Error) => void;
}

export class Semaphore {
  private available: number;
  private readonly queue: Waiter[] = [];

  constructor(count: number) {
    this.available = count;
  }

  /** How many slots are free right now (tests). */
  get free(): number {
    return this.available;
  }

  /** Wait for a slot, then return the function that gives it back (idempotent). */
  async acquire(token?: CancelToken): Promise<() => void> {
    token?.throwIfCancelled();
    if (this.available > 0 && this.queue.length === 0) {
      this.available -= 1;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          token?.signal.removeEventListener("abort", onAbort);
          resolve();
        },
        fail: (reason) => {
          token?.signal.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        waiter.fail(token!.reason!);
      };
      token?.signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.grant();
      else this.available += 1;
    };
  }
}
