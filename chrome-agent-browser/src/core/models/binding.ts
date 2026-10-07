/**
 * The bounded model-binding facts a runner is allowed to hold (`hostbridge/session.py::
 * normalize_binding`): identity, capabilities, limits and locality, as the Run Plan froze
 * them. No base URL, credential or catalog body travels here; the host that builds the
 * adapter adds those from its own settings.
 */
import { AdapterError } from "../workflow/errors.js";
import type { ModelPricing } from "./usage.js";

export const MAX_BINDING_TEXT = 512;
export const MAX_CAPABILITIES = 64;

export interface CapabilityAnswer {
  value: boolean | null;
  basis: string | null;
}

export interface ModelBindingDescriptor {
  host_model_id: string;
  provider_id: string;
  model_id: string;
  display_name: string | null;
  compatibility_status: string | null;
  evidence_strength: string | null;
  capabilities: Record<string, CapabilityAnswer>;
  limits: { context_tokens: number | null; native_context_window: number | null; max_output_tokens: number | null };
  properties: { local: boolean | null };
  /** Catalog prices, when the host catalog states them (D-061). */
  pricing: ModelPricing | null;
}

function invalid(message: string): AdapterError {
  return new AdapterError("session_invalid", message);
}

function fields(value: unknown, field: string, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) throw invalid(`Unknown fields in ${field}: [${unknown.map((key) => `'${key}'`).join(", ")}]`);
  const missing = required.filter((key) => !Object.hasOwn(record, key)).sort();
  if (missing.length > 0) throw invalid(`Missing fields in ${field}: [${missing.map((key) => `'${key}'`).join(", ")}]`);
  return record;
}

function text(value: unknown, field: string, options: { limit?: number; allowNull?: boolean } = {}): string | null {
  if ((value === null || value === undefined) && options.allowNull) return null;
  const limit = options.limit ?? MAX_BINDING_TEXT;
  if (typeof value !== "string" || value.length > limit) throw invalid(`${field} must be a string of at most ${limit} characters`);
  return value;
}

function count(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(`${field} must be a nonnegative integer`);
  return value;
}

function tristate(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined || typeof value === "boolean") return value ?? null;
  throw invalid(`${field} must be true, false or null`);
}

/** Validate the model binding a Run Plan carries into the exact shape the router uses. */
export function normalizeModelBinding(raw: unknown): ModelBindingDescriptor {
  const record = fields(
    raw,
    "model_binding",
    ["host_model_id", "provider_id", "model_id", "display_name", "compatibility_status", "evidence_strength", "capabilities", "limits", "properties", "pricing", "strategy", "selected_at", "descriptor", "compatibility", "catalog"],
    ["host_model_id", "provider_id", "model_id"],
  );
  const capabilitiesRaw = (record.capabilities ?? {}) as Record<string, unknown>;
  if (typeof capabilitiesRaw !== "object" || capabilitiesRaw === null || Array.isArray(capabilitiesRaw) || Object.keys(capabilitiesRaw).length > MAX_CAPABILITIES) {
    throw invalid("model_binding.capabilities must be a bounded object");
  }
  const capabilities: Record<string, CapabilityAnswer> = {};
  for (const name of Object.keys(capabilitiesRaw).sort()) {
    text(name, "model_binding.capabilities key", { limit: 128 });
    const entry = fields(capabilitiesRaw[name], `model_binding.capabilities[${name}]`, ["value", "basis", "detail"]);
    capabilities[name] = { value: tristate(entry.value, "capability value"), basis: text(entry.basis, "capability basis", { allowNull: true }) };
  }
  const limits = fields(record.limits ?? {}, "model_binding.limits", ["context_tokens", "native_context_window", "max_output_tokens"]);
  const properties = fields(record.properties ?? {}, "model_binding.properties", ["local", "privacy_class", "cost_class", "status", "tags"]);
  let pricing: ModelPricing | null = null;
  if (record.pricing !== undefined && record.pricing !== null) {
    const price = fields(record.pricing, "model_binding.pricing", ["input_usd_per_million", "output_usd_per_million"], ["input_usd_per_million", "output_usd_per_million"]);
    for (const key of ["input_usd_per_million", "output_usd_per_million"]) {
      if (typeof price[key] !== "number" || !Number.isFinite(price[key] as number) || (price[key] as number) < 0) throw invalid(`model_binding.pricing.${key} must be a nonnegative number`);
    }
    pricing = { input_usd_per_million: price.input_usd_per_million as number, output_usd_per_million: price.output_usd_per_million as number };
  }
  return {
    host_model_id: text(record.host_model_id, "host_model_id", { limit: 256 })!,
    provider_id: text(record.provider_id, "provider_id", { limit: 128 })!,
    model_id: text(record.model_id, "model_id", { limit: 256 })!,
    display_name: text(record.display_name, "display_name", { allowNull: true }),
    compatibility_status: text(record.compatibility_status, "compatibility_status", { limit: 64, allowNull: true }),
    evidence_strength: text(record.evidence_strength, "evidence_strength", { limit: 64, allowNull: true }),
    capabilities,
    limits: {
      context_tokens: count(limits.context_tokens, "limits.context_tokens"),
      native_context_window: count(limits.native_context_window, "limits.native_context_window"),
      max_output_tokens: count(limits.max_output_tokens, "limits.max_output_tokens"),
    },
    properties: { local: tristate(properties.local, "properties.local") },
    pricing,
  };
}

/** `context_window_for`: the binding's context window, or a refusal rather than a guess. */
export function contextWindowFor(binding: ModelBindingDescriptor): number {
  for (const value of [binding.limits.context_tokens, binding.limits.native_context_window]) {
    if (typeof value === "number" && value > 0) return value;
  }
  throw new AdapterError("model_context_window_unknown", "The host reports no context window for the selected model, so no request can be bounded against it");
}

/** `capabilities_for`'s reasoning half: declared only when the binding's descriptor says so. */
export function reasoningFor(binding: ModelBindingDescriptor): boolean {
  return binding.capabilities[CAPABILITY_KEY]?.value === true;
}

const CAPABILITY_KEY = "reasoning";
