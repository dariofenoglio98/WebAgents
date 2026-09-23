/**
 * The gate OpenClaw actually applies when this plugin names a model.
 *
 * `api.runtime.llm.complete({ model })` is the only way this plugin reaches a
 * model, and OpenClaw 2026.9.5 decides whether that call may name one in
 * `runtime-llm.runtime`:
 *
 * ```js
 * if (requestedModel) assertAllowedModelOverride({ resolvedModelRef, pluginPolicyId,
 *                                                  authorityPolicy, pluginPolicy });
 * // assertAllowedModelOverride:
 * //   allowModelOverride !== true            -> LLM_COMPLETION_NOT_AUTHORIZED
 * //   assertModelAllowed(kind: "override")   -> llm.allowedModels
 * // and, for every completion:
 * //   assertModelAllowed(kind: "completion") -> llm.allowedCompletionModels
 * ```
 *
 * with allowlists compiled by `compileModelAllowlist`: an absent key is
 * *unconfigured* and permits everything, a `"*"` entry permits everything, and
 * anything else is an exact `provider/model` set.
 *
 * Nothing in that path consults the model picker's default view. This module
 * mirrors those few rules — and only those — so the Agent Browser can say
 * "available" about exactly the models the host would let it invoke. It reads
 * this plugin's own configuration entry and no provider credential, base URL or
 * auth profile.
 */

/** Mirrors OpenClaw's `normalizeProviderId` (trim + lowercase). */
export function normalizeProviderId(provider: unknown): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

/** Mirrors `modelKey(provider, model)` for a catalog row. */
export function modelKey(provider: unknown, model: unknown): string {
  const providerId = normalizeProviderId(provider);
  const modelId = typeof model === "string" ? model.trim() : "";
  if (!providerId) return modelId;
  if (!modelId) return providerId;
  return `${providerId}/${modelId}`;
}

/** Mirrors `compileModelAllowlist`. */
export type ModelAllowlist = {
  configured: boolean;
  allowAny: boolean;
  models: ReadonlySet<string>;
};

export type PluginLlmPolicy = {
  /** Whether this plugin may name a model at all. */
  allowModelOverride: boolean;
  /** `plugins.entries.<id>.llm.allowedModels` */
  overrideModels: ModelAllowlist;
  /** `plugins.entries.<id>.llm.allowedCompletionModels` */
  completionModels: ModelAllowlist;
};

/** Stable reasons a model cannot be invoked by this plugin. */
export const POLICY_REASONS = {
  overrideNotAuthorized: "model_override_not_authorized",
  notAllowlistedForOverride: "not_allowlisted_for_override",
  notAllowlistedForCompletion: "not_allowlisted_for_completion",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compileAllowlist(raw: unknown): ModelAllowlist {
  const configured = raw !== undefined;
  const models = new Set<string>();
  let allowAny = false;
  for (const value of Array.isArray(raw) ? raw : []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "*") {
      allowAny = true;
      continue;
    }
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) continue;
    models.add(modelKey(trimmed.slice(0, slash), trimmed.slice(slash + 1)));
  }
  return { configured, allowAny, models };
}

/**
 * Read this plugin's LLM policy out of the host configuration it was given.
 *
 * An absent entry means no policy, which OpenClaw treats as "no allowlist" for
 * the two model lists and as "override not authorized" for the flag — so the
 * default is the safe one: without an explicit opt-in this plugin can name no
 * model, and therefore offers none.
 */
export function resolvePluginLlmPolicy(config: unknown, pluginId: string): PluginLlmPolicy {
  const plugins = isRecord(config) && isRecord(config.plugins) ? config.plugins : undefined;
  const entries = plugins && isRecord(plugins.entries) ? plugins.entries : undefined;
  const entry = entries && isRecord(entries[pluginId]) ? entries[pluginId] : undefined;
  const llm = entry && isRecord(entry.llm) ? entry.llm : undefined;
  return {
    allowModelOverride: llm?.allowModelOverride === true,
    overrideModels: compileAllowlist(llm?.allowedModels),
    completionModels: compileAllowlist(llm?.allowedCompletionModels),
  };
}

function allows(list: ModelAllowlist, key: string): boolean {
  if (!list.configured || list.allowAny) return true;
  return list.models.has(key);
}

/**
 * Whether this plugin may invoke one exact model, and why not when it may not.
 *
 * This answers the same question `assertAllowedModelOverride` answers, in the
 * same order, so a model reported available here is one the host would accept
 * rather than one that merely exists.
 */
export function modelPermitted(
  policy: PluginLlmPolicy,
  key: string,
): { permitted: boolean; reason: string | null } {
  if (!policy.allowModelOverride) {
    return { permitted: false, reason: POLICY_REASONS.overrideNotAuthorized };
  }
  if (!allows(policy.overrideModels, key)) {
    return { permitted: false, reason: POLICY_REASONS.notAllowlistedForOverride };
  }
  if (!allows(policy.completionModels, key)) {
    return { permitted: false, reason: POLICY_REASONS.notAllowlistedForCompletion };
  }
  return { permitted: true, reason: null };
}
