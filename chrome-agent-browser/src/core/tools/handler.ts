/**
 * The host tool-handler contract (`agentpkg/interfaces.py::ToolHandler`, spec §8). Binding
 * names identify installed host capabilities; no package name selects a handler. The context
 * identifies the authorized worker and lets the handler add namespaced operational events to
 * the runtime's audit; it grants no authority of its own.
 */
import type { JsonValue } from "../json.js";

/** The first remote-call bound one more request would pass, with its figures. */
export interface RemoteCallBound {
  bound: "global_remote_calls" | "worker_remote_calls";
  remote_calls: number;
  limit: number;
}

export interface ToolContext {
  readonly role: string;
  readonly worker_id: string;
  event(action: string, metadata?: Record<string, JsonValue | undefined>): void;
  /**
   * One more remote request inside the tool call in progress, which the runtime already charged
   * once (a transient retry or a fallback lookup, D-152, D-153): the bound it would pass, or null
   * when it fits; with `charge`, a request that fits is charged as a remote call against the run's
   * and the worker's budgets. It never refunds anything and charges no tool call. A context
   * without it allows no further request.
   */
  remoteCall?(charge: boolean): RemoteCallBound | null;
}

/** What the runtime tells a handler about the call it makes. */
export interface ToolCallBounds {
  /** The earliest deadline the call is under (the tool's, the step's, the node's, the run's), as a `Date.now()` instant. */
  deadline?: number;
  /** What the package's own declaration says the tool does: only a `read` may ever be sent twice (D-152). */
  side_effects?: "read" | "write";
}

export type ToolHandler = (context: ToolContext, payload: JsonValue, signal: AbortSignal, bounds?: ToolCallBounds) => Promise<JsonValue>;
