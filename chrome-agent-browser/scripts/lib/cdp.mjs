/**
 * The DevTools protocol over Chrome's `--remote-debugging-pipe` (D-037): NUL-delimited JSON on
 * fds 3 and 4, flat sessions, and the small helpers the harnesses share (evaluate, poll, targets).
 */
export const STEP_TIMEOUT_MS = 20_000;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Cdp {
  constructor(child) {
    this.out = child.stdio[3];
    this.in = child.stdio[4];
    this.next = 0;
    this.pending = new Map();
    this.listeners = [];
    let buffer = "";
    this.in.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
          else resolve(message.result);
        } else if (message.method) {
          for (const listener of this.listeners) listener(message);
        }
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = (this.next += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.out.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId, expression, options = {}) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: options.userGesture ?? false }, sessionId);
    if (result.exceptionDetails) throw new Error(`page error: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
    return result.result?.value;
  }

  /** Poll an expression until it yields a truthy value. */
  async waitFor(sessionId, expression, label, timeoutMs = STEP_TIMEOUT_MS, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(sessionId, expression);
        if (last) return last;
      } catch (error) {
        last = error;
      }
      await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
  }

  async targets() {
    return (await this.send("Target.getTargets")).targetInfos;
  }

  async waitForTarget(predicate, label, timeoutMs = STEP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = (await this.targets()).find(predicate);
      if (found) return found;
      await sleep(150);
    }
    throw new Error(`timed out waiting for target ${label}`);
  }
}
