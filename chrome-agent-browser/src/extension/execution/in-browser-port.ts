/**
 * The run Worker's `InBrowserEnginePort` (T41, D-441, D-450): the core's port over the
 * `MessagePort` the offscreen page transferred in `host.start`, exactly as `builtin-port.ts` wraps
 * the Prompt API. It never loads a model and never spawns an engine: it asks the page's
 * `EngineHost` for the status and for completions, and on the run's abort it tells the host to
 * stop and rejects at once with the signal's reason.
 *
 * The host's refusals arrive with the core's codes and are rethrown as `AdapterError`s, so
 * `model_request_invalid` (over `n_ctx`) and `model_unavailable` with `engine_worker_died` reach
 * the run as the contract names them (design §4); anything else is an engine failure the adapter
 * maps to `model_unavailable` with `stage: engine`.
 */
import { AdapterError } from "../../core/workflow/errors.js";
import type { InBrowserCompletion, InBrowserCompletionRequest, InBrowserEnginePort, InBrowserEngineStatus } from "../../core/models/adapters/in-browser.js";
import type { PortReply, PortRequest, WithoutId } from "./engine-protocol.js";

export interface RunPortLike {
  postMessage(message: PortRequest): void;
  onmessage: ((event: { data: PortReply }) => void) | null;
  start?(): void;
  close(): void;
}

const ADAPTER_CODES = new Set(["model_unavailable", "model_request_invalid", "model_usage_unavailable", "model_response_invalid"]);

export class MessagePortEnginePort implements InBrowserEnginePort {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;

  constructor(private readonly port: RunPortLike) {
    port.onmessage = (event) => {
      const reply = event.data;
      const waiter = this.waiting.get(reply.id);
      if (!waiter) return;
      this.waiting.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.result);
      else if (ADAPTER_CODES.has(reply.error.code)) waiter.reject(new AdapterError(reply.error.code, reply.error.message, { detail: reply.error.detail ?? null, audit_facts: reply.error.audit_facts ?? { stage: "engine" } }));
      else waiter.reject(Object.assign(new Error(reply.error.message), { name: "EngineError", code: reply.error.code }));
    };
    port.start?.();
  }

  private ask<T>(message: WithoutId<Extract<PortRequest, { kind: "status" | "complete" }>>, onId?: (id: number) => void): Promise<T> {
    if (this.closed) return Promise.reject(new AdapterError("model_unavailable", "The in-browser engine's channel is closed"));
    const id = this.nextId++;
    onId?.(id);
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.port.postMessage({ ...message, id } as PortRequest);
    });
  }

  status(): Promise<InBrowserEngineStatus> {
    return this.ask<InBrowserEngineStatus>({ kind: "status" });
  }

  complete(request: InBrowserCompletionRequest, signal: AbortSignal): Promise<InBrowserCompletion> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    let id = 0;
    const answer = this.ask<InBrowserCompletion>({ kind: "complete", request }, (assigned) => (id = assigned));
    return new Promise<InBrowserCompletion>((resolve, reject) => {
      const onAbort = () => {
        this.port.postMessage({ id: this.nextId++, kind: "abort", target: id });
        this.waiting.delete(id);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      answer.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /** The run ended: nothing more is asked, and every waiting call fails as the engine being gone. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.values()) waiter.reject(new AdapterError("model_unavailable", "The in-browser engine's channel closed"));
    this.waiting.clear();
    this.port.close();
  }
}
