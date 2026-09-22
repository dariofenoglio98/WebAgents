/**
 * Model discovery: the one place in this plugin that knows what OpenClaw is.
 *
 * The control plane deliberately discovers nothing. This module asks the host
 * which models exist and which are usable, projects the answer into the
 * provider-neutral descriptor the control plane accepts, and sends it there.
 * No provider, model family or vendor is named anywhere in this file's logic.
 *
 * ## What it reads, and why that surface
 *
 * `buildModelsProviderData` (`openclaw/plugin-sdk/models-provider-runtime`) is
 * the same published catalog the host's own `/models` picker reads. It returns
 * the catalog rows plus `byProvider`, the set the host is currently willing to
 * offer — which is exactly "available on this host" rather than "exists
 * somewhere". It performs no provider discovery of its own and starts nothing.
 *
 * The Gateway RPC `models.list` would carry the same facts, but
 * `api.runtime.gateway.request` refuses any plugin that is not bundled or
 * trusted-official (`canTrustedOfficialPluginRequestScopes` in OpenClaw
 * 2026.9.5), and this plugin is neither. The SDK subpath is the supported route
 * for a workspace plugin.
 *
 * ## What it never sends
 *
 * The descriptor mirrors OpenClaw's own public model projection
 * (`buildPublicModelProjection`, "keeps concrete route, auth, cost, and
 * provider parameters out of public model rows"). Base URLs, request
 * parameters, transport compatibility flags, auth profiles and credentials stay
 * in this process. The control plane additionally refuses unknown fields, so a
 * mistake here fails loudly instead of leaking.
 *
 * ## Capability provenance
 *
 * Every capability answer carries a `basis`, because the three kinds of host
 * answer are not equally strong and collapsing them would be dishonest:
 *
 * * `declared` — the catalog row states this fact about this model;
 * * `host_default` — the row is silent and OpenClaw applies a documented
 *   default to it (`supportsModelTools`: tools are offered unless a provider
 *   opts out with `compat.supportsTools === false`);
 * * `derived` — OpenClaw's own mechanism for one capability is another
 *   capability. Structured output is the synthetic `structured_output` tool
 *   (`docs/tools/swarm.md`), gated on tool capability — `sessions_spawn`
 *   refuses an `outputSchema` for a model that declares
 *   `compat.supportsTools=false`.
 *
 * A fact the host does not have at all is `null`, never `false`.
 */
import { buildModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { AgentBrowserError } from "./errors.js";

/**
 * Mirrors OpenClaw's `normalizeProviderId` (trim + lowercase).
 *
 * The host exports that helper only from an untyped SDK subpath, so matching
 * its one-line behavior here keeps this module type-checked without widening
 * the plugin to implicit `any` imports.
 */
function normalizeProviderId(provider: unknown): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

/** Upper bound on descriptors sent to the control plane in one catalog. */
export const MAX_CATALOG_MODELS = 128;

export type CapabilityBasis = "declared" | "host_default" | "derived" | "absent";

export type CapabilityAnswer = {
  value: boolean | null;
  basis: CapabilityBasis;
  detail: string | null;
};

export type HostModelDescriptor = {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  available: boolean;
  availability_reason: string | null;
  selectable: boolean;
  capabilities: Record<string, CapabilityAnswer>;
  limits: {
    context_tokens: number | null;
    native_context_window: number | null;
    max_output_tokens: number | null;
  };
  properties: {
    local: boolean | null;
    privacy_class: string | null;
    cost_class: string | null;
    status: string | null;
    tags: string[];
  };
};

export type HostCatalog = {
  schema: "agentpkg-host-model-catalog-v0";
  host: {
    runtime: "openclaw";
    runtime_version: string | null;
    source: string;
    captured_at: string;
    agent_id: string | null;
  };
  models: HostModelDescriptor[];
  notes: Array<{ code: string; detail: string | null }>;
};

/** The minimal shape this module uses from an OpenClaw catalog row. */
type CatalogRow = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  alias?: unknown;
  contextWindow?: unknown;
  contextTokens?: unknown;
  reasoning?: unknown;
  input?: unknown;
  status?: unknown;
  baseUrl?: unknown;
  compat?: unknown;
};

type ProviderData = {
  byProvider?: Map<string, Set<string>>;
  providers?: string[];
  modelNames?: Map<string, string>;
  modelCatalog?: CatalogRow[];
  pendingProviders?: readonly string[];
  refreshWarning?: string;
  resolvedDefault?: { provider?: unknown; model?: unknown };
};

/** The host surface this module needs; narrowed so tests can supply a stub. */
export type ModelHost = {
  config: unknown;
  agentId?: string;
  workspaceDir?: string;
  runtimeVersion?: string | null;
  /** Test seam. Defaults to the plugin-SDK function. */
  browse?: (
    config: unknown,
    agentId: string | undefined,
    options: { view: "default" | "all"; workspaceDir?: string },
  ) => Promise<ProviderData>;
};

const SOURCE = "openclaw/plugin-sdk/models-provider-runtime#buildModelsProviderData";

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function compatOf(row: CatalogRow): Record<string, unknown> | undefined {
  return typeof row.compat === "object" && row.compat !== null
    ? (row.compat as Record<string, unknown>)
    : undefined;
}

/**
 * Mirrors OpenClaw's `isLocalBaseUrl` (loopback, wildcard and mDNS hosts).
 *
 * That helper is internal rather than a plugin-SDK subpath, so the check is
 * reproduced here. The URL itself never leaves this function: only the boolean
 * does, which is what the host's own `includeDetails` projection exposes too.
 */
function localEndpoint(baseUrl: unknown): boolean | null {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::" ||
      host === "::1" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host) ||
      host.endsWith(".local")
    );
  } catch {
    return null;
  }
}

const absent = (detail: string): CapabilityAnswer => ({
  value: null,
  basis: "absent",
  detail,
});

/** Translate one catalog row's facts into named, sourced capability answers. */
export function capabilitiesOf(row: CatalogRow): Record<string, CapabilityAnswer> {
  const compat = compatOf(row);
  const declaredTools = typeof compat?.supportsTools === "boolean" ? compat.supportsTools : null;
  // OpenClaw's own predicate is total: `supportsModelTools` returns
  // `compat?.supportsTools !== false`. A silent row means the host will offer
  // tools, so the answer is the host's, not a guess — but its weaker basis is
  // recorded rather than hidden.
  const toolUse: CapabilityAnswer =
    declaredTools === null
      ? {
          value: true,
          basis: "host_default",
          detail:
            "The catalog row does not set compat.supportsTools; OpenClaw offers tools unless a " +
            "provider opts out (supportsModelTools).",
        }
      : {
          value: declaredTools,
          basis: "declared",
          detail: `Catalog row declares compat.supportsTools=${String(declaredTools)}.`,
        };

  const jsonSchema =
    typeof compat?.supportsJsonSchemaResponseFormat === "boolean"
      ? (compat.supportsJsonSchemaResponseFormat as boolean)
      : null;
  const structured: CapabilityAnswer =
    jsonSchema === true
      ? {
          value: true,
          basis: "declared",
          detail: "The provider route accepts a JSON Schema response format.",
        }
      : {
          value: toolUse.value,
          basis: "derived",
          detail:
            "OpenClaw produces structured output through its synthetic structured_output tool, " +
            `so it follows tool capability (${toolUse.basis}).`,
        };

  const reasoning: CapabilityAnswer =
    typeof row.reasoning === "boolean"
      ? {
          value: row.reasoning,
          basis: "declared",
          detail: `Catalog row declares reasoning=${String(row.reasoning)}.`,
        }
      : absent("The catalog row states no reasoning capability.");

  const inputs = Array.isArray(row.input) ? row.input.filter((item) => typeof item === "string") : null;
  const multimodal: CapabilityAnswer =
    inputs === null || inputs.length === 0
      ? absent("The catalog row lists no input modalities.")
      : {
          value: inputs.some((item) => item !== "text"),
          basis: "declared",
          detail: `Accepted input modalities: ${inputs.join(", ")}.`,
        };

  return { tool_use: toolUse, structured_output: structured, reasoning, multimodal };
}

function descriptorOf(
  row: CatalogRow,
  options: { available: boolean; reason: string | null; displayName: string | null; tags: string[] },
): HostModelDescriptor {
  const provider = normalizeProviderId(text(row.provider));
  const modelId = text(row.id);
  return {
    id: `${provider}/${modelId}`,
    provider_id: provider,
    model_id: modelId,
    display_name: options.displayName ?? text(row.name, modelId),
    available: options.available,
    availability_reason: options.reason,
    // OpenClaw's picker set is the manual-choice set; a row outside it is
    // reported but not offered.
    selectable: options.available,
    capabilities: capabilitiesOf(row),
    limits: {
      context_tokens: positiveInt(row.contextTokens),
      native_context_window: positiveInt(row.contextWindow),
      max_output_tokens: null,
    },
    properties: {
      local: localEndpoint(row.baseUrl),
      privacy_class: null,
      cost_class: null,
      status: typeof row.status === "string" ? row.status : null,
      tags: options.tags,
    },
  };
}

/**
 * Ask OpenClaw what models this host has, and project the answer.
 *
 * Throws an `AgentBrowserError` the page can render when the host's catalog is
 * not published yet, so "not ready" never looks like "no models exist".
 */
export async function discoverHostModels(host: ModelHost): Promise<HostCatalog> {
  const browse = host.browse ?? (buildModelsProviderData as ModelHost["browse"])!;
  let data: ProviderData;
  try {
    data = await browse(host.config, host.agentId, {
      view: "default",
      ...(host.workspaceDir ? { workspaceDir: host.workspaceDir } : {}),
    });
  } catch (error) {
    throw new AgentBrowserError(
      "model_catalog_unavailable",
      "Model catalog unavailable",
      `OpenClaw could not report its model catalog: ${(error as Error).message}`,
      true,
    );
  }

  const offered = new Map<string, string>();
  for (const [provider, models] of data.byProvider ?? new Map<string, Set<string>>()) {
    for (const model of models) offered.set(`${normalizeProviderId(provider)}/${model}`, provider);
  }
  const names = data.modelNames ?? new Map<string, string>();
  const defaultKey = data.resolvedDefault
    ? `${normalizeProviderId(text(data.resolvedDefault.provider))}/${text(data.resolvedDefault.model)}`
    : "";

  const seen = new Set<string>();
  const available: HostModelDescriptor[] = [];
  const unavailable: HostModelDescriptor[] = [];
  for (const row of data.modelCatalog ?? []) {
    const provider = normalizeProviderId(text(row.provider));
    const modelId = text(row.id);
    if (!provider || !modelId) continue;
    const key = `${provider}/${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isOffered = offered.has(key);
    const tags: string[] = [];
    if (key === defaultKey) tags.push("host-default");
    if (typeof row.alias === "string" && row.alias) tags.push(`alias:${row.alias}`);
    const descriptor = descriptorOf(row, {
      available: isOffered,
      reason: isOffered ? null : "not_offered_by_host",
      displayName: names.get(key) ?? null,
      tags,
    });
    (isOffered ? available : unavailable).push(descriptor);
  }
  // A model the host offers but whose catalog row was dropped by visibility
  // filtering is still a real choice, so it is reported with the little that
  // is known about it rather than silently omitted.
  for (const [key, provider] of offered) {
    if (seen.has(key)) continue;
    seen.add(key);
    const modelId = key.slice(key.indexOf("/") + 1);
    available.push(
      descriptorOf(
        { id: modelId, provider, name: names.get(key) ?? modelId },
        {
          available: true,
          reason: null,
          displayName: names.get(key) ?? null,
          tags: key === defaultKey ? ["host-default"] : [],
        },
      ),
    );
  }

  const byId = (a: HostModelDescriptor, b: HostModelDescriptor) => a.id.localeCompare(b.id);
  available.sort(byId);
  unavailable.sort(byId);
  const models = [...available, ...unavailable].slice(0, MAX_CATALOG_MODELS);

  const notes: HostCatalog["notes"] = [];
  for (const provider of data.pendingProviders ?? []) {
    notes.push({
      code: "provider_discovery_pending",
      detail: `${provider}: OpenClaw is still discovering this provider's models.`,
    });
  }
  if (data.refreshWarning) {
    notes.push({ code: "catalog_refresh_failed", detail: data.refreshWarning });
  }
  if (available.length + unavailable.length > MAX_CATALOG_MODELS) {
    notes.push({
      code: "catalog_truncated",
      detail: `Showing ${MAX_CATALOG_MODELS} of ${available.length + unavailable.length} models.`,
    });
  }
  if (available.length === 0) {
    notes.push({
      code: "no_models_available",
      detail:
        "OpenClaw reports no usable model on this host. Configure a model provider and its " +
        "credentials, then refresh.",
    });
  }

  return {
    schema: "agentpkg-host-model-catalog-v0",
    host: {
      runtime: "openclaw",
      runtime_version: host.runtimeVersion ?? null,
      source: SOURCE,
      captured_at: new Date().toISOString(),
      agent_id: host.agentId ?? null,
    },
    models,
    notes: notes.slice(0, 16),
  };
}

/** True when the catalog still offers this exact model as a usable choice. */
export function stillAvailable(catalog: HostCatalog, modelId: string): boolean {
  return catalog.models.some(
    (model) => model.id === modelId && model.available && model.selectable,
  );
}
