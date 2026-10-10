/**
 * Waiting in the happy-dom page tests (B-149, T14): poll for what the next step needs, with a
 * deadline, instead of sleeping a fixed time and hoping the page has rendered by then.
 */

/** Poll `probe` until it returns a truthy value, and return that value; throw with `label` at the deadline. */
export async function until<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 10_000, intervalMs = 10): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${last instanceof Error ? `: ${last.message}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
