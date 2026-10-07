/**
 * Cooperative cancellation and deadlines (D-060), standing in for `asyncio` task
 * cancellation and `asyncio.timeout`.
 *
 * A run holds a root `CancelToken`; every wave, node, worker, step and adapter call gets a
 * child. Cancelling a token cancels its subtree and aborts the `AbortSignal` the adapters hand
 * to their transport, so in-flight HTTP work stops. Code that must notice cancellation calls
 * `throwIfCancelled()` at its yield points, which is where an asyncio task would have been
 * interrupted.
 *
 * `withDeadline` is `asyncio.timeout`: the timer cancels the child with a plain
 * `CancelledError`, exactly what code inside the block would have seen in Python, and the
 * boundary converts it into a `TimeoutError` on the way out. A result produced after the
 * deadline fired is discarded, as the cancelled task would never have returned it.
 */
import { CancelledError, TimeoutError } from "./errors.js";

export class CancelToken {
  private readonly controller = new AbortController();
  private readonly children = new Set<CancelToken>();
  private reasonValue: Error | null = null;

  constructor(private readonly parent: CancelToken | null = null) {
    if (parent !== null) {
      parent.children.add(this);
      if (parent.reasonValue !== null) this.cancel(parent.reasonValue);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.reasonValue !== null;
  }

  get reason(): Error | null {
    return this.reasonValue;
  }

  /** Cancel this token and its subtree; idempotent. */
  cancel(reason: Error = new CancelledError()): void {
    if (this.reasonValue !== null) return;
    this.reasonValue = reason;
    for (const child of [...this.children]) child.cancel(reason);
    this.controller.abort(reason);
  }

  throwIfCancelled(): void {
    if (this.reasonValue !== null) throw this.reasonValue;
  }

  child(): CancelToken {
    return new CancelToken(this);
  }

  /** Detach from the parent once the work it bounded is over, so the tree does not grow. */
  dispose(): void {
    this.parent?.children.delete(this);
  }
}

/** `asyncio.timeout(seconds)` around `fn`, which receives the bounded child token. */
export async function withDeadline<T>(seconds: number, parent: CancelToken, fn: (token: CancelToken) => Promise<T>): Promise<T> {
  const child = parent.child();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.cancel(new CancelledError("deadline"));
  }, Math.max(0, seconds * 1000));
  try {
    const value = await fn(child);
    if (timedOut) throw new TimeoutError("deadline elapsed");
    return value;
  } catch (error) {
    if (timedOut) throw new TimeoutError("deadline elapsed");
    throw error;
  } finally {
    clearTimeout(timer);
    child.dispose();
  }
}

/** `asyncio.sleep(seconds)`, cancellable. */
export function sleep(seconds: number, token?: CancelToken): Promise<void> {
  return new Promise((resolve, reject) => {
    token?.throwIfCancelled();
    const onAbort = () => {
      clearTimeout(timer);
      reject(token!.reason!);
    };
    const timer = setTimeout(() => {
      token?.signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, seconds * 1000));
    token?.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A yield point: `await asyncio.sleep(0)` with the cancellation check it implies. */
export async function yieldPoint(token: CancelToken): Promise<void> {
  token.throwIfCancelled();
  await Promise.resolve();
  token.throwIfCancelled();
}
