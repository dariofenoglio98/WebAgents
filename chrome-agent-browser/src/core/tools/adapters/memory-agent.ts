/**
 * The agent document's two reserved tools (§7.4, M-48…M-51): `host.memory.agent.read` returns
 * the package's own document (the empty document under a preset or a policy that persists none),
 * and `host.memory.agent.write` stages a body the host commits only when the run completes. The
 * document is the run's own package's; the package id is never an argument.
 */
import type { JsonValue } from "../../json.js";
import { MAX_AGENT_BODY_CHARS, codePoints } from "../../memory/model.js";
import type { ToolBindingRecord } from "../bindings.js";
import type { ToolImplementationDefinition } from "../definitions.js";
import { toolError } from "./json-http.js";

export const MEMORY_AGENT_IMPLEMENTATION = Object.freeze({ id: "chrome.tool.memory_agent", version: "0.1.0" });

/** What the host holds for a run's agent document. */
export interface AgentMemoryContext {
  package_id: string;
  /** The stored notes, or null when the package never wrote any (or the preset / policy persists none). */
  stored: { body: string; updated: string } | null;
  /** The staged body, set by the write; the host commits it on completion. */
  staged: { body: string; bytes: number } | null;
}

export function memoryAgentCall(definition: ToolImplementationDefinition, binding: ToolBindingRecord, args: JsonValue, agent: AgentMemoryContext | null): { output: JsonValue; facts: Record<string, JsonValue> } {
  if (definition.implementationId !== MEMORY_AGENT_IMPLEMENTATION.id) throw toolError("tool_unavailable", "this host has no code for that agent-document implementation");
  if (agent === null) throw toolError("tool_unavailable", "this run holds no agent document");
  const record = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, JsonValue>) : null;
  if (binding.binding_name === "host.memory.agent.read") {
    if (record === null || Object.keys(record).length > 0) throw toolError("tool_request_invalid", "the agent document read takes no arguments");
    const body = agent.stored?.body ?? "";
    const bytes = new TextEncoder().encode(body).length;
    return { output: { body, updated: agent.stored?.updated ?? null }, facts: { package_id: agent.package_id, bytes, present: agent.stored !== null } };
  }
  if (binding.binding_name === "host.memory.agent.write") {
    if (record === null || Object.keys(record).join(",") !== "body" || typeof record.body !== "string") throw toolError("tool_request_invalid", "the agent document write takes exactly one body");
    if (codePoints(record.body) > MAX_AGENT_BODY_CHARS) throw toolError("tool_request_invalid", `the agent document holds at most ${MAX_AGENT_BODY_CHARS} characters`);
    const bytes = new TextEncoder().encode(record.body).length;
    agent.staged = { body: record.body, bytes };
    return { output: { staged: true, bytes }, facts: { package_id: agent.package_id, bytes } };
  }
  throw toolError("tool_unavailable", "this host serves no agent-document tool of that name");
}
