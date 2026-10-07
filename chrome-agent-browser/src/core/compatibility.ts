/**
 * Host model catalogs and generic package/model compatibility, mirroring
 * `agentpkg/browser/hostmodels.py`.
 *
 * Two knowledge domains meet here and are kept apart: the **host** knows which models exist
 * and what it is willing to say about them, and sends a bounded, provider-neutral catalog of
 * descriptors; the **core** knows what a package requires and what those requirements mean.
 * Nothing here contacts a model. Evaluating compatibility is arithmetic and set membership
 * over declared data, under three rules: a missing host answer is `unknown`, never `false`
 * and never `true`; a preference can never make a model incompatible; every requirement
 * carries its own reason, so a UI can explain a verdict instead of asserting one.
 */
import { canonicalJson } from "./canonical.js";
import { closedRecord, invalid, isRecord, nonnegativeCount, requiredText, text, tristate } from "./fields.js";
import { sha256Hex } from "./hash.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { Package } from "./package.js";
import { pyRepr } from "./repr.js";

export const CATALOG_SCHEMA = "agentpkg-host-model-catalog-v0";
export const DESCRIPTOR_SCHEMA = "agentpkg-host-model-descriptor-v0";
export const EVALUATION_SCHEMA = "agentpkg-model-evaluation-v0";
export const REQUIREMENTS_SCHEMA = "agentpkg-model-requirements-v0";

export const MAX_MODELS = 256;
export const MAX_CAPABILITIES = 64;
export const MAX_NOTES = 32;
export const MAX_TAGS = 16;

export const COMPATIBLE = "compatible";
export const INCOMPATIBLE = "incompatible";
export const UNVERIFIED = "unverified";
export type CompatibilityStatus = typeof COMPATIBLE | typeof UNVERIFIED | typeof INCOMPATIBLE;
export const COMPATIBILITY_STATUSES: readonly CompatibilityStatus[] = Object.freeze([COMPATIBLE, UNVERIFIED, INCOMPATIBLE]);

export const SATISFIED = "satisfied";
export const VIOLATED = "violated";
export const UNKNOWN = "unknown";

/**
 * How strongly the host backed a capability answer. `declared` is a per-model fact the host
 * reports; `host_default` is the host applying its own documented default to a silent row;
 * `derived` is the host mapping one of its own facts onto this capability name; `absent` is
 * no answer. All but the last are host statements, and each is recorded into the run plan.
 */
export type CapabilityBasis = "declared" | "host_default" | "derived" | "absent";
export const BASES: readonly CapabilityBasis[] = Object.freeze(["declared", "host_default", "derived", "absent"]);

export interface CapabilityAnswer {
  name: string;
  value: boolean | null;
  basis: CapabilityBasis;
  detail: string | null;
}

export interface ModelDescriptor {
  schema: typeof DESCRIPTOR_SCHEMA;
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  available: boolean;
  availability_reason: string | null;
  selectable: boolean;
  capabilities: Record<string, CapabilityAnswer>;
  limits: { context_tokens: number | null; native_context_window: number | null; max_output_tokens: number | null };
  properties: { local: boolean | null; privacy_class: string | null; cost_class: string | null; status: string | null; tags: string[] };
}

export interface CatalogHost {
  runtime: string;
  runtime_version: string | null;
  source: string;
  captured_at: string;
  agent_id: string | null;
}

export interface CatalogNote {
  code: string;
  detail: string | null;
}

export interface HostCatalog {
  schema: typeof CATALOG_SCHEMA;
  host: CatalogHost;
  models: ModelDescriptor[];
  notes: CatalogNote[];
  catalog_sha256: string;
  model_count: number;
  available_model_count: number;
}

export interface CatalogReference {
  catalog_sha256: string;
  model_count: number;
  available_model_count: number;
  host: CatalogHost;
}

export interface HardRequirement {
  id: string;
  kind: "capability" | "context_tokens" | "property";
  subject: string;
  operator: "is_true" | "at_least";
  value: boolean | number;
  tasks: string[];
}

export interface Preference {
  id: string;
  kind: string;
  subject: string;
}

export interface RequirementSet {
  schema: typeof REQUIREMENTS_SCHEMA;
  package_id: string;
  package_version: string;
  package_digest: string;
  routing: JsonValue;
  fallback_policy: JsonValue;
  privacy: JsonValue | null;
  latency_preference: JsonValue | null;
  cost_sensitivity: JsonValue | null;
  tasks: Array<{ id: string; capabilities: string[]; context_window: number; preferred_tier: JsonValue | null }>;
  hard_requirements: HardRequirement[];
  preferences: Preference[];
  binding_strategy: "single_model";
  note: string;
}

export interface RequirementCheck extends HardRequirement {
  host_value: boolean | number | null;
  status: typeof SATISFIED | typeof VIOLATED | typeof UNKNOWN;
  basis: CapabilityBasis;
  source: string;
  detail: string | null;
}

export interface ModelCompatibility {
  model_id: string;
  provider_id: string;
  display_name: string;
  available: boolean;
  availability_reason: string | null;
  selectable: boolean;
  status: CompatibilityStatus;
  selectable_for_run_plan: boolean;
  evidence_strength: "none" | "declared" | "derived" | "host_default";
  satisfied: string[];
  violated: string[];
  unknown: string[];
  checks: RequirementCheck[];
  preferences: Array<Preference & { host_value: JsonValue; status: string }>;
  limits: ModelDescriptor["limits"];
  properties: ModelDescriptor["properties"];
  capabilities: Record<string, { value: boolean | null; basis: CapabilityBasis; detail: string | null }>;
}

export interface CatalogEvaluation {
  schema: typeof EVALUATION_SCHEMA;
  evaluated_at: string;
  package_id: string;
  package_version: string;
  package_digest: string;
  requirements: RequirementSet;
  catalog: CatalogReference;
  models: ModelCompatibility[];
  counts: Record<string, number>;
  notes: CatalogNote[];
  execution: { performed: false; note: string };
}

/** `normalize_capability`: one host answer about one capability name, with its provenance. */
export function normalizeCapability(name: string, raw: unknown, field: string): CapabilityAnswer {
  const record = closedRecord(raw, field, ["value", "basis", "detail"], ["value"]);
  const value = tristate(record.value, `${field}.value`);
  const basisText = requiredText(record.basis || (value === null ? "absent" : "declared"), `${field}.basis`);
  if (!(BASES as readonly string[]).includes(basisText)) throw invalid(`${field}.basis must be one of ${pyRepr([...BASES])}`);
  const basis = basisText as CapabilityBasis;
  if (value === null && basis !== "absent") throw invalid(`${field} has no value, so its basis must be 'absent'`);
  return { name, value, basis, detail: text(record.detail, `${field}.detail`, { allowNull: true }) };
}

/** `normalize_descriptor`: validate one host model descriptor into the exact stored shape. */
export function normalizeDescriptor(raw: unknown, index: number): ModelDescriptor {
  const field = `models[${index}]`;
  const record = closedRecord(
    raw,
    field,
    ["id", "provider_id", "model_id", "display_name", "available", "availability_reason", "selectable", "capabilities", "limits", "properties"],
    ["id", "provider_id", "model_id", "display_name", "available", "capabilities"],
  );
  const limits = closedRecord(record.limits ?? {}, `${field}.limits`, ["context_tokens", "native_context_window", "max_output_tokens"]);
  const properties = closedRecord(record.properties ?? {}, `${field}.properties`, ["local", "privacy_class", "cost_class", "status", "tags"]);
  const capabilitiesRaw = record.capabilities;
  if (!isRecord(capabilitiesRaw)) throw invalid(`${field}.capabilities must be an object`);
  if (Object.keys(capabilitiesRaw).length > MAX_CAPABILITIES) throw invalid(`${field}.capabilities exceeds ${MAX_CAPABILITIES} entries`);
  const capabilities: Record<string, CapabilityAnswer> = {};
  for (const name of Object.keys(capabilitiesRaw).sort()) {
    capabilities[requiredText(name, `${field}.capabilities key`, { limit: 128 })] = normalizeCapability(name, capabilitiesRaw[name], `${field}.capabilities[${name}]`);
  }
  const tags = properties.tags ?? [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) throw invalid(`${field}.properties.tags must be a list of at most ${MAX_TAGS}`);
  return {
    schema: DESCRIPTOR_SCHEMA,
    id: requiredText(record.id, `${field}.id`, { limit: 256 }),
    provider_id: requiredText(record.provider_id, `${field}.provider_id`, { limit: 128 }),
    model_id: requiredText(record.model_id, `${field}.model_id`, { limit: 256 }),
    display_name: requiredText(record.display_name, `${field}.display_name`),
    available: tristate(record.available, `${field}.available`) === true,
    availability_reason: text(record.availability_reason, `${field}.availability_reason`, { allowNull: true }),
    selectable: (record.selectable ?? true) === true,
    capabilities,
    limits: {
      context_tokens: nonnegativeCount(limits.context_tokens, `${field}.limits.context_tokens`),
      native_context_window: nonnegativeCount(limits.native_context_window, `${field}.limits.native_context_window`),
      max_output_tokens: nonnegativeCount(limits.max_output_tokens, `${field}.limits.max_output_tokens`),
    },
    properties: {
      local: tristate(properties.local, `${field}.properties.local`),
      privacy_class: text(properties.privacy_class, `${field}.properties.privacy_class`, { allowNull: true }),
      cost_class: text(properties.cost_class, `${field}.properties.cost_class`, { allowNull: true }),
      status: text(properties.status, `${field}.properties.status`, { allowNull: true }),
      tags: tags.map((tag) => requiredText(tag, `${field}.properties.tags[]`, { limit: 64 })),
    },
  };
}

/** `normalize_catalog`: validate a whole host catalog and bind it to a content hash. */
export async function normalizeCatalog(raw: unknown): Promise<HostCatalog> {
  const record = closedRecord(raw, "catalog", ["schema", "host", "models", "notes"], ["host", "models"]);
  const schema = requiredText(record.schema ?? CATALOG_SCHEMA, "catalog.schema");
  if (schema !== CATALOG_SCHEMA) throw invalid(`catalog.schema must be ${pyRepr(CATALOG_SCHEMA)}, got ${pyRepr(schema)}`);
  const host = closedRecord(record.host, "catalog.host", ["runtime", "runtime_version", "source", "captured_at", "agent_id"], ["runtime", "source", "captured_at"]);
  const modelsRaw = record.models;
  if (!Array.isArray(modelsRaw)) throw invalid("catalog.models must be a list");
  if (modelsRaw.length > MAX_MODELS) throw invalid(`catalog.models exceeds ${MAX_MODELS} entries`);
  const models = modelsRaw.map((item, index) => normalizeDescriptor(item, index));
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw invalid(`duplicate model id ${pyRepr(model.id)}`);
    seen.add(model.id);
  }
  const notesRaw = record.notes ?? [];
  if (!Array.isArray(notesRaw) || notesRaw.length > MAX_NOTES) throw invalid(`catalog.notes must be a list of at most ${MAX_NOTES}`);
  const notes: CatalogNote[] = notesRaw.map((note) => {
    const entry = closedRecord(note, "catalog.notes[]", ["code", "detail"], ["code"]);
    return { code: requiredText(entry.code, "catalog.notes[].code", { limit: 128 }), detail: text(entry.detail, "catalog.notes[].detail", { allowNull: true }) };
  });
  const catalog = {
    schema: CATALOG_SCHEMA as typeof CATALOG_SCHEMA,
    host: {
      runtime: requiredText(host.runtime, "catalog.host.runtime", { limit: 64 }),
      runtime_version: text(host.runtime_version, "catalog.host.runtime_version", { allowNull: true }),
      source: requiredText(host.source, "catalog.host.source"),
      captured_at: requiredText(host.captured_at, "catalog.host.captured_at", { limit: 64 }),
      agent_id: text(host.agent_id, "catalog.host.agent_id", { allowNull: true }),
    },
    models,
    notes,
  };
  return {
    ...catalog,
    catalog_sha256: await sha256Hex(canonicalJson(catalog)),
    model_count: models.length,
    available_model_count: models.filter((model) => model.available).length,
  };
}

/** `catalog_reference`: the small binding record a receipt-like artifact stores about a catalog. */
export function catalogReference(catalog: HostCatalog): CatalogReference {
  return { catalog_sha256: catalog.catalog_sha256, model_count: catalog.model_count, available_model_count: catalog.available_model_count, host: { ...catalog.host } };
}

// -- package requirements ----------------------------------------------------
/**
 * `requirement_set`: a package's declared model requirements, normalized generically. With
 * `single_model` binding the effective hard requirement is the union of task capabilities and
 * the largest declared context window; per-task detail is retained.
 */
export function requirementSet(pkg: Package): RequirementSet {
  const declared = pkg.manifest.model_requirements as JsonObject;
  const tasks: RequirementSet["tasks"] = [];
  const capabilityTasks = new Map<string, string[]>();
  const contextTasks = new Map<number, string[]>();
  for (const task of declared.tasks as JsonObject[]) {
    const id = String(task.id);
    const capabilities = (task.capabilities as JsonValue[]).map(String);
    const contextWindow = task.context_window as number;
    tasks.push({ id, capabilities, context_window: contextWindow, preferred_tier: task.preferred_tier ?? null });
    for (const capability of capabilities) capabilityTasks.set(capability, [...(capabilityTasks.get(capability) ?? []), id]);
    contextTasks.set(contextWindow, [...(contextTasks.get(contextWindow) ?? []), id]);
  }
  const hard: HardRequirement[] = [];
  for (const capability of [...capabilityTasks.keys()].sort()) {
    hard.push({ id: `capability:${capability}`, kind: "capability", subject: capability, operator: "is_true", value: true, tasks: [...new Set(capabilityTasks.get(capability)!)].sort() });
  }
  if (contextTasks.size > 0) {
    const largest = Math.max(...contextTasks.keys());
    hard.push({ id: "context_tokens:minimum", kind: "context_tokens", subject: "context_tokens", operator: "at_least", value: largest, tasks: [...new Set(contextTasks.get(largest)!)].sort() });
  }
  const privacy = declared.privacy ?? null;
  if (privacy === "local-only") {
    hard.push({ id: "property:local", kind: "property", subject: "local", operator: "is_true", value: true, tasks: tasks.map((task) => task.id).sort() });
  }
  const preferences: Preference[] = [];
  const tiers = [...new Set(tasks.map((task) => task.preferred_tier).filter((tier): tier is string => typeof tier === "string" && tier.length > 0))].sort();
  for (const tier of tiers) preferences.push({ id: `preferred_tier:${tier}`, kind: "preferred_tier", subject: tier });
  for (const key of ["latency_preference", "cost_sensitivity"] as const) {
    const value = declared[key];
    if (value) preferences.push({ id: `${key}:${String(value)}`, kind: key, subject: String(value) });
  }
  return {
    schema: REQUIREMENTS_SCHEMA,
    package_id: String(pkg.manifest.package_id),
    package_version: String(pkg.manifest.version),
    package_digest: pkg.digest,
    routing: declared.routing!,
    fallback_policy: declared.fallback_policy!,
    privacy,
    latency_preference: declared.latency_preference ?? null,
    cost_sensitivity: declared.cost_sensitivity ?? null,
    tasks,
    hard_requirements: hard,
    preferences,
    binding_strategy: "single_model",
    note: "Hard requirements must hold for the one selected model, because this profile binds a single model to every declared task.",
  };
}

// -- evaluation --------------------------------------------------------------
function hostCapability(descriptor: ModelDescriptor, name: string): CapabilityAnswer {
  return descriptor.capabilities[name] ?? { name, value: null, basis: "absent", detail: null };
}

function contextValue(descriptor: ModelDescriptor): [number | null, string] {
  const limits = descriptor.limits;
  if (limits.context_tokens !== null) return [limits.context_tokens, "limits.context_tokens"];
  if (limits.native_context_window !== null) return [limits.native_context_window, "limits.native_context_window"];
  return [null, "absent"];
}

function check(requirement: HardRequirement, descriptor: ModelDescriptor): RequirementCheck {
  if (requirement.kind === "capability") {
    const answer = hostCapability(descriptor, requirement.subject);
    const hostValue = answer.value;
    const status = hostValue === null ? UNKNOWN : hostValue ? SATISFIED : VIOLATED;
    return { ...requirement, host_value: hostValue, status, basis: answer.basis, source: "capabilities", detail: answer.detail };
  }
  if (requirement.kind === "context_tokens") {
    const [hostValue, source] = contextValue(descriptor);
    const status = hostValue === null ? UNKNOWN : hostValue >= (requirement.value as number) ? SATISFIED : VIOLATED;
    return { ...requirement, host_value: hostValue, status, basis: hostValue === null ? "absent" : "declared", source, detail: null };
  }
  // property: a boolean fact the host reports about the model itself.
  const hostValue = (descriptor.properties as unknown as Record<string, boolean | null | undefined>)[requirement.subject] ?? null;
  const status = hostValue === null ? UNKNOWN : hostValue ? SATISFIED : VIOLATED;
  return { ...requirement, host_value: hostValue, status, basis: hostValue === null ? "absent" : "declared", source: `properties.${requirement.subject}`, detail: null };
}

/** Preferences are reported, never enforced. An unmet one is not a failure. */
function preference(item: Preference, descriptor: ModelDescriptor): Preference & { host_value: JsonValue; status: string } {
  if (item.kind === "preferred_tier") {
    const tags = descriptor.properties.tags;
    return { ...item, host_value: [...tags], status: tags.includes(item.subject) ? "met" : "unknown" };
  }
  const hostValue = item.kind === "cost_sensitivity" ? descriptor.properties.cost_class : null;
  return { ...item, host_value: hostValue, status: hostValue === null ? "unknown" : "reported" };
}

/** `evaluate_model`: compare one host model against one package's normalized requirements. */
export function evaluateModel(requirements: RequirementSet, descriptor: ModelDescriptor): ModelCompatibility {
  const checks = requirements.hard_requirements.map((requirement) => check(requirement, descriptor));
  const violated = checks.filter((item) => item.status === VIOLATED);
  const unknown = checks.filter((item) => item.status === UNKNOWN);
  const status: CompatibilityStatus = violated.length > 0 ? INCOMPATIBLE : unknown.length > 0 ? UNVERIFIED : COMPATIBLE;
  const bases = new Set(checks.filter((item) => item.status === SATISFIED).map((item) => item.basis));
  let strength: ModelCompatibility["evidence_strength"];
  if (bases.size === 0) strength = "none";
  else if (bases.size === 1 && bases.has("declared")) strength = "declared";
  else if (bases.has("derived")) strength = "derived";
  else strength = "host_default";
  const capabilities: ModelCompatibility["capabilities"] = {};
  for (const [name, answer] of Object.entries(descriptor.capabilities)) capabilities[name] = { value: answer.value, basis: answer.basis, detail: answer.detail };
  return {
    model_id: descriptor.id,
    provider_id: descriptor.provider_id,
    display_name: descriptor.display_name,
    available: descriptor.available,
    availability_reason: descriptor.availability_reason,
    selectable: descriptor.selectable,
    status,
    selectable_for_run_plan: descriptor.available && descriptor.selectable && status !== INCOMPATIBLE,
    evidence_strength: strength,
    satisfied: checks.filter((item) => item.status === SATISFIED).map((item) => item.id),
    violated: violated.map((item) => item.id),
    unknown: unknown.map((item) => item.id),
    checks,
    preferences: requirements.preferences.map((item) => preference(item, descriptor)),
    limits: { ...descriptor.limits },
    properties: { ...descriptor.properties, tags: [...descriptor.properties.tags] },
    capabilities,
  };
}

const ORDER: Record<CompatibilityStatus, number> = { [COMPATIBLE]: 0, [UNVERIFIED]: 1, [INCOMPATIBLE]: 2 };

/**
 * `evaluate_catalog`: every host model against one package, in a stable order: available
 * first, then compatible before unverified before incompatible, then by identifier. This is
 * presentation order, not a quality ranking.
 */
export function evaluateCatalog(pkg: Package, catalog: HostCatalog, now: Date = new Date()): CatalogEvaluation {
  const requirements = requirementSet(pkg);
  const models = catalog.models.map((descriptor) => evaluateModel(requirements, descriptor));
  models.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (ORDER[a.status] !== ORDER[b.status]) return ORDER[a.status] - ORDER[b.status];
    return a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0;
  });
  const counts: Record<string, number> = {};
  for (const status of COMPATIBILITY_STATUSES) counts[status] = models.filter((item) => item.status === status).length;
  return {
    schema: EVALUATION_SCHEMA,
    evaluated_at: now.toISOString(),
    package_id: String(pkg.manifest.package_id),
    package_version: String(pkg.manifest.version),
    package_digest: pkg.digest,
    requirements,
    catalog: catalogReference(catalog),
    models,
    counts: { ...counts, total: models.length, available: models.filter((item) => item.available).length, selectable: models.filter((item) => item.selectable_for_run_plan).length },
    notes: catalog.notes.map((note) => ({ ...note })),
    execution: { performed: false, note: "Evaluating compatibility reads declarations only; no model was contacted." },
  };
}

export function findModel(catalog: HostCatalog, modelId: string): ModelDescriptor | null {
  return catalog.models.find((descriptor) => descriptor.id === modelId) ?? null;
}

/** The plugin's `stillAvailable`: the catalog still offers this exact model as a usable choice. */
export function stillAvailable(catalog: HostCatalog, modelId: string): boolean {
  return catalog.models.some((model) => model.id === modelId && model.available && model.selectable);
}
