/**
 * Whether a value fits what OpenClaw lets an operation carry.
 *
 * `defineFeaturePlugin` refuses any input or output over the host's plugin
 * JSON limits (`HOST_JSON_LIMITS`), before and regardless of its schema. A
 * projection that carries package- or model-produced data of unbounded shape —
 * an artifact, a task input, an input schema — asks `fitsJson` first and
 * degrades to something smaller rather than failing the whole operation.
 */
import { HOST_JSON_LIMITS } from "./contract.js";

export type JsonBudget = {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxObjectKeys: number;
  readonly maxStringLength: number;
  readonly maxSerializedBytes: number;
};

/**
 * Counted as the host counts: every value is a node, strings and keys are
 * measured in UTF-16 code units, and only plain JSON is accepted.
 */
export function fitsJson(value: unknown, budget: JsonBudget = HOST_JSON_LIMITS): boolean {
  const state = { nodes: 0, depth: 0 };
  const walk = (item: unknown): boolean => {
    state.nodes += 1;
    if (state.nodes > budget.maxNodes || state.depth > budget.maxDepth) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "string") return item.length <= budget.maxStringLength;
    if (typeof item === "number") return Number.isFinite(item);
    if (Array.isArray(item)) {
      state.depth += 1;
      const ok = item.every(walk);
      state.depth -= 1;
      return ok;
    }
    if (typeof item !== "object") return false;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(item as Record<string, unknown>);
    if (entries.length > budget.maxObjectKeys) return false;
    state.depth += 1;
    const ok = entries.every(([key, entry]) => key.length <= budget.maxStringLength && walk(entry));
    state.depth -= 1;
    return ok;
  };
  if (!walk(value)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= budget.maxSerializedBytes;
  } catch {
    return false;
  }
}

/**
 * Room for data inside one operation's output. Each leaves the rest of the
 * host's limits to the envelope around it: a record's own fields, a view's
 * metadata, the result wrapper.
 */
export const BUDGETS = {
  /** A parsed JSON artifact shown in a view. */
  artifactJson: { ...HOST_JSON_LIMITS, maxNodes: 3072, maxSerializedBytes: 200 * 1024 },
  /** The task input echoed in a run record, beside ~700 nodes of its own. */
  echoedInput: {
    maxDepth: 16,
    maxNodes: 512,
    maxObjectKeys: 128,
    maxStringLength: 16 * 1024,
    maxSerializedBytes: 16 * 1024,
  },
  /** A package's bundled input schema, carried in the package view to build a form. */
  inputSchema: { ...HOST_JSON_LIMITS, maxNodes: 2048, maxSerializedBytes: 64 * 1024 },
} as const satisfies Record<string, JsonBudget>;
