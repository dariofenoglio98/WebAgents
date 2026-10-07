/**
 * What the trusted host adds on top of what the package declares (`execution/policy.py`, the
 * limits half): host execution limits, which can only lower package-declared budgets, and an
 * upper bound on a single call's output cap, which is a refusal rather than a silent reduction.
 * Nothing here knows what a package is for.
 */
import type { JsonObject } from "../json.js";
import type { Package } from "../package.js";
import type { HostLimits } from "../workflow/runtime.js";
import { invalid } from "./errors.js";

export const DEFAULT_TOTAL_TOKENS = 120_000;
export const DEFAULT_MAX_REMOTE_CALLS = 32;
export const DEFAULT_MAX_PARALLEL_WORKERS = 3;
export const DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL = 16_000;
export const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
export const DEFAULT_MAX_CALLS_PER_TOOL = 32;
/** How long one model completion may take, queueing at the model server included. */
export const DEFAULT_MODEL_CALL_TIMEOUT_SECONDS = 300;

export const MAX_TOTAL_TOKENS = 10_000_000;
export const MAX_REMOTE_CALLS = 10_000;
export const MAX_PARALLEL_WORKERS = 64;
export const MAX_OUTPUT_TOKENS_PER_CALL = 200_000;
export const MAX_RUN_TIMEOUT_SECONDS = 86_400;
export const MAX_CALLS_PER_TOOL = 10_000;
export const MAX_MODEL_CALL_TIMEOUT_SECONDS = 3_600;

export interface HostExecutionLimits {
  total_tokens: number;
  max_remote_calls: number;
  max_parallel_workers: number;
  max_output_tokens_per_call: number;
  run_timeout_seconds: number;
  max_calls_per_tool: number;
  model_call_timeout_seconds: number;
}

export const DEFAULT_HOST_LIMITS: Readonly<HostExecutionLimits> = Object.freeze({
  total_tokens: DEFAULT_TOTAL_TOKENS,
  max_remote_calls: DEFAULT_MAX_REMOTE_CALLS,
  max_parallel_workers: DEFAULT_MAX_PARALLEL_WORKERS,
  max_output_tokens_per_call: DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL,
  run_timeout_seconds: DEFAULT_RUN_TIMEOUT_SECONDS,
  max_calls_per_tool: DEFAULT_MAX_CALLS_PER_TOOL,
  model_call_timeout_seconds: DEFAULT_MODEL_CALL_TIMEOUT_SECONDS,
});

/**
 * Limits that lower nothing: every ceiling at its supported maximum, so `min()` with the
 * package's declarations yields the declarations. What `agentpkg run` applies when the operator
 * passes no `--limits`; the model-call timeout keeps its default, since a package declares none.
 */
export const PERMISSIVE_HOST_LIMITS: Readonly<HostExecutionLimits> = Object.freeze({
  total_tokens: MAX_TOTAL_TOKENS,
  max_remote_calls: MAX_REMOTE_CALLS,
  max_parallel_workers: MAX_PARALLEL_WORKERS,
  max_output_tokens_per_call: MAX_OUTPUT_TOKENS_PER_CALL,
  run_timeout_seconds: MAX_RUN_TIMEOUT_SECONDS,
  max_calls_per_tool: MAX_CALLS_PER_TOOL,
  model_call_timeout_seconds: DEFAULT_MODEL_CALL_TIMEOUT_SECONDS,
});

const MAXIMA: Record<keyof HostExecutionLimits, number> = {
  total_tokens: MAX_TOTAL_TOKENS,
  max_remote_calls: MAX_REMOTE_CALLS,
  max_parallel_workers: MAX_PARALLEL_WORKERS,
  max_output_tokens_per_call: MAX_OUTPUT_TOKENS_PER_CALL,
  run_timeout_seconds: MAX_RUN_TIMEOUT_SECONDS,
  max_calls_per_tool: MAX_CALLS_PER_TOOL,
  model_call_timeout_seconds: MAX_MODEL_CALL_TIMEOUT_SECONDS,
};

function bounded(value: unknown, field: keyof HostExecutionLimits): number {
  if (value === null || value === undefined) return DEFAULT_HOST_LIMITS[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw invalid(`limits.${field} must be a positive integer`);
  if (value > MAXIMA[field]) throw invalid(`limits.${field} exceeds the supported maximum of ${MAXIMA[field]}`);
  return value;
}

export function normalizeHostLimits(raw: unknown): HostExecutionLimits {
  if (raw === null || raw === undefined) return { ...DEFAULT_HOST_LIMITS };
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("limits must be an object");
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(key in MAXIMA)).sort();
  if (unknown.length > 0) throw invalid(`Unknown fields in limits: [${unknown.map((key) => `'${key}'`).join(", ")}]`);
  const limits = { ...DEFAULT_HOST_LIMITS };
  for (const key of Object.keys(MAXIMA) as Array<keyof HostExecutionLimits>) limits[key] = bounded(record[key], key);
  return limits;
}

/** Exactly the keys the runtime accepts; it applies min() to each one. */
export function runtimeLimits(limits: HostExecutionLimits): HostLimits {
  return {
    hard_tokens: limits.total_tokens,
    max_remote_calls: limits.max_remote_calls,
    max_parallel_workers: limits.max_parallel_workers,
    max_calls_per_tool: limits.max_calls_per_tool,
  };
}

/** What the package declared, what the host allowed, and the min of both. */
export function effectiveBudget(pkg: Package, limits: HostExecutionLimits): JsonObject {
  const declared = pkg.policy.budget as JsonObject;
  const host = runtimeLimits(limits) as Record<string, number>;
  const perTool = declared.max_calls_per_tool as JsonObject;
  const effectivePerTool: JsonObject = {};
  for (const [toolId, cap] of Object.entries(perTool)) effectivePerTool[toolId] = Math.min(host.max_calls_per_tool!, cap as number);
  return {
    declared: {
      hard_tokens: declared.hard_tokens!,
      max_remote_calls: declared.max_remote_calls!,
      max_parallel_workers: declared.max_parallel_workers!,
      estimated_tokens: declared.estimated_tokens!,
      approval_threshold_tokens: declared.approval_threshold_tokens ?? null,
      max_calls_per_tool: { ...perTool },
    },
    host: { ...host },
    effective: {
      hard_tokens: Math.min(host.hard_tokens!, declared.hard_tokens as number),
      max_remote_calls: Math.min(host.max_remote_calls!, declared.max_remote_calls as number),
      max_parallel_workers: Math.min(host.max_parallel_workers!, declared.max_parallel_workers as number),
      max_calls_per_tool: effectivePerTool,
    },
  };
}

/** The tighter of the graph's own deadline and the host run timeout. */
export function effectiveDeadlineSeconds(pkg: Package, limits: HostExecutionLimits): number {
  return Math.min(Math.trunc(pkg.graph.deadline_seconds as number), limits.run_timeout_seconds);
}
