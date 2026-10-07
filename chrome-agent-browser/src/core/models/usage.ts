/**
 * Mapping a provider's usage report onto the two numbers the runtime contract requires
 * (`hostbridge/router.py::project_usage`; D-061).
 *
 * `input_tokens` is every billable prompt token, cache reads and writes included, because the
 * runtime's reservation covers what a call costs rather than what a provider discounts.
 * `output_tokens` absorbs any difference between an aggregate total and its own breakdown,
 * which is where an unreported reasoning charge would otherwise disappear. A count the provider
 * did not report is not a count of zero: the charge must be established by the report itself
 * (an aggregate total, or both the input and the output count), else the call is refused as
 * `model_usage_unavailable` and the runtime charges its whole reservation.
 */
import { AdapterError } from "../workflow/errors.js";

/** What an adapter reports, each bucket a non-negative integer or null when not reported. */
export interface UsageReport {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  total_tokens?: number | null;
  cost_usd?: number | null;
}

export interface ProjectedUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  reported: Required<UsageReport>;
}

/** Catalog prices, USD per million tokens (T3's catalog supplies them; absent means no cost claim). */
export interface ModelPricing {
  input_usd_per_million: number;
  output_usd_per_million: number;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AdapterError("model_usage_invalid", `Host reported an invalid ${field}`);
  }
  return value;
}

function reported(usage: Record<string, unknown>, field: string): number | null {
  const value = usage[field];
  return value === null || value === undefined ? null : count(value, field);
}

export function projectUsage(usage: unknown): ProjectedUsage {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    throw new AdapterError("model_usage_unavailable", "The host reported no usage");
  }
  const record = usage as Record<string, unknown>;
  const read = reported(record, "cache_read_tokens") ?? 0;
  const write = reported(record, "cache_write_tokens") ?? 0;
  const reportedInput = reported(record, "input_tokens");
  const reportedOutput = reported(record, "output_tokens");
  const total = reported(record, "total_tokens");
  if (total === null && (reportedInput === null || reportedOutput === null)) {
    throw new AdapterError(
      "model_usage_unavailable",
      "The host reported neither a total nor both input and output tokens for this completion, so it cannot be accounted for",
    );
  }
  const prompt = (reportedInput ?? 0) + read + write;
  let output = reportedOutput ?? 0;
  if (total !== null && total > prompt + output) output = total - prompt;
  if (prompt === 0 && output === 0) {
    throw new AdapterError("model_usage_unavailable", "The host reported no token usage for this completion, so it cannot be accounted for");
  }
  const cost = record.cost_usd;
  if (cost !== null && cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost))) {
    throw new AdapterError("model_usage_invalid", "Host reported an invalid cost_usd");
  }
  return {
    input_tokens: prompt,
    output_tokens: output,
    cost_usd: typeof cost === "number" ? cost : null,
    reported: {
      input_tokens: (record.input_tokens as number | null | undefined) ?? null,
      output_tokens: (record.output_tokens as number | null | undefined) ?? null,
      cache_read_tokens: (record.cache_read_tokens as number | null | undefined) ?? null,
      cache_write_tokens: (record.cache_write_tokens as number | null | undefined) ?? null,
      total_tokens: (record.total_tokens as number | null | undefined) ?? null,
      cost_usd: typeof cost === "number" ? cost : null,
    },
  };
}

/** A cost from catalog prices and projected counts; null without prices. Never an estimate of tokens. */
export function priceUsage(usage: ProjectedUsage, pricing: ModelPricing | null): number | null {
  if (pricing === null) return null;
  const cost = (usage.input_tokens * pricing.input_usd_per_million + usage.output_tokens * pricing.output_usd_per_million) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
