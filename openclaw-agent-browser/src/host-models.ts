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
 * the published catalog the host's own `/models` picker reads. It performs no
 * provider discovery of its own and starts nothing.
 *
 * ## Which view, and why availability is not the picker's view
 *
 * That function takes a `view`. The two views answer different questions, and
 * an earlier version of this module asked the wrong one.
 *
 * `view: "default"` is the **picker's** listing. Its `byProvider` contains the
 * configured/default models plus those whose auth readiness OpenClaw could
 * positively confirm (`authBacked: evaluation.availability === true` in
 * `commands-models`). A local provider whose credential lives in
 * `models.providers.<id>.apiKey` rather than the auth store evaluates as
 * *indeterminate*, so none of its models are auth-backed and the picker lists
 * only the ones named in configuration. `openclaw models list --provider <id>`
 * disagrees for exactly this reason: its CLI passes `view: opts.all || provider
 * ? "all" : "default"`, so naming a provider silently switches it to the full
 * catalog.
 *
 * `view: "all"` is the **host catalog**: every model of a browsable provider
 * that OpenClaw considers route-compatible. That is the set this plugin can
 * address, so it is the set this module reports.
 *
 * Availability is then decided by the gate that actually applies to
 * `api.runtime.llm.complete` — this plugin's own LLM policy, mirrored in
 * `model-policy.ts` — plus the row's own retirement status. Nothing in
 * OpenClaw's completion path consults the picker view, so neither does this.
 * Whether the picker also lists a model is kept as a tag, never as a veto.
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
 * * `derived` — the bridge guarantees schema-validated JSON or a failed call.
 *
 * Structured-output transport evidence is absent: the public catalog does not
 * reveal the route selected after auth resolution. Tool capability cannot
 * establish that this plugin's responseFormat will reach a provider.
 *
 * A fact the host does not have at all is `null`, never `false`.
 */
import { buildModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { PLUGIN_ID } from "./contract.js";
import { AgentBrowserError } from "./errors.js";
import {
  modelKey,
  modelPermitted,
  normalizeProviderId,
  resolvePluginLlmPolicy,
} from "./model-policy.js";

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
  /** Whose `plugins.entries.<id>.llm` policy gates a model override. */
  pluginId?: string;
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
  // Catalog capability is not transport evidence: auth resolution can choose a
  // route that removes responseFormat. The public row does not attest to the
  // final transport, even when compat declares schema support. Do not infer it
  // from tools (this completion path does not use the synthetic tool).
  const transport: CapabilityAnswer = absent(
    (jsonSchema === null ? "The catalog supplies no JSON Schema route declaration. "
      : `The catalog declares supportsJsonSchemaResponseFormat=${String(jsonSchema)}. `) +
    "The public model descriptor does not identify the transport selected after auth resolution; " +
    "schema delivery and constrained decoding are unverified. The bridge requests a schema and " +
    "validates every answer, failing closed on nonconformance.",
  );

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

  return {
    tool_use: toolUse,
    // workflow.v0's existing contract means validated JSON or failure; it has
    // never promised successful generation or native constrained decoding.
    // Match HostBridgeModelRouter.capabilities_for rather than the tools gate.
    structured_output: {
      value: true,
      basis: "derived",
      detail: "The Agent Browser bridge returns schema-validated JSON or fails closed. " +
        "This is an adapter guarantee, not evidence of provider constrained decoding. " +
        "See structured_output_transport: actual schema delivery is unverified.",
    },
    structured_output_transport: transport,
    reasoning,
    multimodal,
  };
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
  const ask = (view: "default" | "all") =>
    browse(host.config, host.agentId, {
      view,
      ...(host.workspaceDir ? { workspaceDir: host.workspaceDir } : {}),
    });

  // The host catalog: every model of a browsable provider that OpenClaw
  // considers route-compatible, which is the set this plugin can address.
  let data: ProviderData;
  try {
    data = await ask("all");
  } catch (error) {
    throw new AgentBrowserError(
      "model_catalog_unavailable",
      "Model catalog unavailable",
      `OpenClaw could not report its model catalog: ${(error as Error).message}`,
      true,
    );
  }

  // The host's own picker listing, recorded as provenance only. It is a
  // presentation view — a local provider whose credential is not in the auth
  // store is absent from it while remaining perfectly routable — so it tags a
  // model here and never vetoes one.
  let pickerOffered = new Set<string>();
  try {
    const picker = await ask("default");
    for (const [provider, models] of picker.byProvider ?? new Map<string, Set<string>>()) {
      for (const model of models) pickerOffered.add(modelKey(provider, model));
    }
  } catch {
    // The picker view is optional evidence; losing it must not hide a model.
    pickerOffered = new Set<string>();
  }

  const routable = new Map<string, string>();
  for (const [provider, models] of data.byProvider ?? new Map<string, Set<string>>()) {
    for (const model of models) routable.set(modelKey(provider, model), provider);
  }
  const policy = resolvePluginLlmPolicy(host.config, host.pluginId ?? PLUGIN_ID);
  const names = data.modelNames ?? new Map<string, string>();
  const defaultKey = data.resolvedDefault
    ? modelKey(text(data.resolvedDefault.provider), text(data.resolvedDefault.model))
    : "";

  /** Availability: addressable by the host, permitted to us, and not retired. */
  const decide = (key: string, row: CatalogRow): { ok: boolean; reason: string | null } => {
    // Present as a catalog row, but absent from the set OpenClaw is willing to
    // address: a hidden provider, or a route it considers incompatible.
    if (!routable.has(key)) return { ok: false, reason: "not_routable_by_host" };
    const status = text(row.status);
    if (status === "deprecated" || status === "disabled") {
      return { ok: false, reason: `model_${status}` };
    }
    const permitted = modelPermitted(policy, key);
    return permitted.permitted ? { ok: true, reason: null } : { ok: false, reason: permitted.reason };
  };

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
    const verdict = decide(key, row);
    const tags: string[] = [];
    if (key === defaultKey) tags.push("host-default");
    if (pickerOffered.has(key)) tags.push("host-picker");
    if (typeof row.alias === "string" && row.alias) tags.push(`alias:${row.alias}`);
    const descriptor = descriptorOf(row, {
      available: verdict.ok,
      reason: verdict.reason,
      displayName: names.get(key) ?? null,
      tags,
    });
    (verdict.ok ? available : unavailable).push(descriptor);
  }
  // A model the host can route but whose catalog row was dropped by projection
  // is still a real choice, so it is reported with the little that is known
  // about it rather than silently omitted.
  for (const [key, provider] of routable) {
    if (seen.has(key)) continue;
    seen.add(key);
    const modelId = key.slice(key.indexOf("/") + 1);
    const row: CatalogRow = { id: modelId, provider, name: names.get(key) ?? modelId };
    const verdict = decide(key, row);
    const tags: string[] = [];
    if (key === defaultKey) tags.push("host-default");
    if (pickerOffered.has(key)) tags.push("host-picker");
    (verdict.ok ? available : unavailable).push(
      descriptorOf(row, {
        available: verdict.ok,
        reason: verdict.reason,
        displayName: names.get(key) ?? null,
        tags,
      }),
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
