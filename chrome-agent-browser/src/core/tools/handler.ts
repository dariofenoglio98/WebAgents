/**
 * The host tool-handler contract (`agentpkg/interfaces.py::ToolHandler`, spec §8). Binding
 * names identify installed host capabilities; no package name selects a handler. The context
 * identifies the authorized worker and lets the handler add namespaced operational events to
 * the runtime's audit; it grants no authority of its own.
 */
import type { JsonValue } from "../json.js";

export interface ToolContext {
  readonly role: string;
  readonly worker_id: string;
  event(action: string, metadata?: Record<string, JsonValue | undefined>): void;
}

export type ToolHandler = (context: ToolContext, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
