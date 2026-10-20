/**
 * The limits of one compute call (compute.v0 §5, C-30…C-36): the port of `agentpkg/compute/limits.py`.
 *
 * Three figures bound a call: the module's memory in pages, wall time, and fuel where the engine
 * meters instructions. The host has defaults and maxima; a node may only lower them; the module's
 * declared memory maximum must fit under the effective page bound, else the run is refused before
 * it starts (a bound that refuses instead of lowering, as `max_output_tokens_per_call` does).
 * Chrome's engine meters no fuel (D-250): the figure is accepted, recorded and never enforced;
 * the wall bound is the CPU bound.
 */

/** 64 MiB per call. A module declares its own maximum; this is what a host allows by default. */
export const DEFAULT_MEMORY_PAGES = 1024;
/** Seconds of wall time per call: the bound every engine has. */
export const DEFAULT_WALL_SECONDS = 10;
/** Fuel per call on a metering engine (D-242); on this runtime a figure the audit carries, never a bound. */
export const DEFAULT_FUEL = 50_000_000_000;
export const MAX_MEMORY_PAGES = 65_536;
export const MAX_WALL_SECONDS = 300;
export const MAX_FUEL = 1_000_000_000_000;
/** An output longer than this is refused unread (`abi_violation`), whatever the memory allowed. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const PAGE_BYTES = 65_536;

export const HOST_KEYS: readonly string[] = Object.freeze(["compute_memory_pages", "compute_wall_seconds", "compute_fuel"]);
export const NODE_KEYS: readonly string[] = Object.freeze(["memory_pages", "wall_seconds", "fuel"]);

export interface ComputeLimits {
  readonly memory_pages: number;
  readonly wall_seconds: number;
  readonly fuel: number;
}

export const DEFAULT_COMPUTE_LIMITS: ComputeLimits = Object.freeze({ memory_pages: DEFAULT_MEMORY_PAGES, wall_seconds: DEFAULT_WALL_SECONDS, fuel: DEFAULT_FUEL });

/** The node's `limits` can only lower; a higher figure is ignored, never applied. */
export function loweredBy(limits: ComputeLimits, nodeLimits: unknown): ComputeLimits {
  const node = (typeof nodeLimits === "object" && nodeLimits !== null && !Array.isArray(nodeLimits) ? nodeLimits : {}) as Record<string, unknown>;
  const figure = (key: string, fallback: number): number => (typeof node[key] === "number" ? Math.min(fallback, node[key] as number) : fallback);
  return { memory_pages: figure("memory_pages", limits.memory_pages), wall_seconds: figure("wall_seconds", limits.wall_seconds), fuel: figure("fuel", limits.fuel) };
}

export function limitsJson(limits: ComputeLimits): { memory_pages: number; wall_seconds: number; fuel: number } {
  return { memory_pages: limits.memory_pages, wall_seconds: limits.wall_seconds, fuel: limits.fuel };
}

function integer(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`Host limit ${name} must be a positive integer`);
  if (value > maximum) throw new Error(`Host limit ${name} exceeds the supported maximum of ${maximum}`);
  return value;
}

/** The host's compute bounds from the `limits` keys it may set; defaults for the rest. Throws a plain `Error` with the reference's message. */
export function hostComputeLimits(raw: unknown): ComputeLimits {
  const record = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const unknown = Object.keys(record)
    .filter((key) => !HOST_KEYS.includes(key))
    .sort();
  if (unknown.length > 0) throw new Error(`Unsupported host limit: ${unknown[0]}`);
  let limits: ComputeLimits = { ...DEFAULT_COMPUTE_LIMITS };
  if ("compute_memory_pages" in record) limits = { ...limits, memory_pages: integer(record.compute_memory_pages, "compute_memory_pages", MAX_MEMORY_PAGES) };
  if ("compute_wall_seconds" in record) {
    const seconds = record.compute_wall_seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) throw new Error("Host limit compute_wall_seconds must be a positive number");
    if (seconds > MAX_WALL_SECONDS) throw new Error(`Host limit compute_wall_seconds exceeds the supported maximum of ${MAX_WALL_SECONDS}`);
    limits = { ...limits, wall_seconds: seconds };
  }
  if ("compute_fuel" in record) limits = { ...limits, fuel: integer(record.compute_fuel, "compute_fuel", MAX_FUEL) };
  return limits;
}
