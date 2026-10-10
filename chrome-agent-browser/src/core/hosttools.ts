/**
 * Host tool bindings and their evaluation against a package's declared tools, mirroring
 * `agentpkg/browser/hosttools.py`, plus the registry the Chrome host itself offers (D-054).
 *
 *     package tool declaration    what the package needs          (signed, in the pkg)
 *     host tool registry          what this host can run          (host-owned)
 *     tool binding in the plan    the one implementation approved (run plan)
 *
 * A binding is a host statement, never a package one: nothing in an `.agent.pkg` adds an
 * entry to a registry, and a package naming an origin no binding names cannot run. The Chrome
 * host has no operator file and no service-specific adapters in this version; what it offers
 * is derived from two sources, each named in the registry's `source`:
 *
 * - one **generic HTTPS JSON binding** per declared *remote* tool, taking origin, path, method
 *   and schema digests from the signed declaration (after the URL gate of `policy.ts`), so
 *   that what the compatibility check establishes is "this host will call exactly what the
 *   package declared, and nothing else", and the person's approval is of that exact call;
 * - one **host-resource binding** per type the vault holds, exactly as the reference plugin
 *   derives them: tool id = type id, an argument-free input schema, the type's schema as output;
 * - since T6, the host's own **service and file implementations** of two abstract capabilities
 *   (`SERVICE_IMPLEMENTATIONS`, `LOCAL_IMPLEMENTATIONS`): `scholarly.search` at Crossref's
 *   `GET /works` is served by the Crossref adapter (D-081), and `paper.read` by the selected-PDF
 *   reader (D-082). Each states the contract digests *this host* speaks, pinned here as the
 *   reference pins its built-ins, so a package whose schemas differ evaluates `incompatible`
 *   rather than being served a shape it did not declare.
 *
 * A remote tool declared as a GET with no service implementation stays `unbound`: the generic
 * adapter's contract is one JSON body, and a GET would drop every argument. Every other local
 * tool is `unbound` here with a note.
 */
import { canonicalJson } from "./canonical.js";
import { closedRecord, flag, hex64, invalid, positiveCount, requiredText, sortedUnique, text } from "./fields.js";
import { sha256Hex } from "./hash.js";
import type { JsonObject, JsonValue } from "./json.js";
import { packageJson, type Package } from "./package.js";
import { validatePackageUrl } from "./policy.js";
import { pyRepr } from "./repr.js";
import { DENY, type Decision } from "./types.js";
import { urlsplit } from "./urls.js";
import { CROSSREF_IMPLEMENTATION } from "./tools/adapters/crossref.js";
import { CROSSREF_DOI_IMPLEMENTATION, CROSSREF_DOI_PATH, CROSSREF_ORIGIN } from "./tools/adapters/crossref-doi.js";
import { SELECTED_PDF_IMPLEMENTATION } from "./tools/adapters/selected-file.js";

export const REGISTRY_SCHEMA = "agentpkg-host-tool-registry-v0";
export const BINDING_SCHEMA = "agentpkg-host-tool-binding-v0";
export const BINDING_DIGEST_SCHEMA = "agentpkg-tool-binding-digest-v0";
export const CONTRACT_SCHEMA = "agentpkg-tool-contract-v0";
export const EVALUATION_SCHEMA = "agentpkg-tool-evaluation-v0";
export const REQUIREMENTS_SCHEMA = "agentpkg-tool-requirements-v0";

export const MAX_BINDINGS = 128;
export const MAX_NOTES = 32;
export const MAX_KINDS = 16;

export const KIND_JSON_HTTP = "json_http";
export const KIND_LOCAL_BUILTIN = "local_builtin";
export const KIND_SELECTED_FILE = "selected_file";
export const KIND_HOST_RESOURCE = "host_resource";
export type ImplementationKind = typeof KIND_JSON_HTTP | typeof KIND_LOCAL_BUILTIN | typeof KIND_SELECTED_FILE | typeof KIND_HOST_RESOURCE;
export const IMPLEMENTATION_KINDS: readonly ImplementationKind[] = Object.freeze([KIND_JSON_HTTP, KIND_LOCAL_BUILTIN, KIND_SELECTED_FILE, KIND_HOST_RESOURCE]);
const REMOTE_KINDS: readonly string[] = Object.freeze([KIND_JSON_HTTP]);

export const BOUND = "bound";
export const UNBOUND = "unbound";
export const AMBIGUOUS = "ambiguous";
export const INCOMPATIBLE = "incompatible";
export const UNVERIFIED = "unverified";
export const UNAVAILABLE = "unavailable";
export type ToolStatus = typeof BOUND | typeof UNVERIFIED | typeof UNAVAILABLE | typeof AMBIGUOUS | typeof INCOMPATIBLE | typeof UNBOUND;
export const TOOL_STATUSES: readonly ToolStatus[] = Object.freeze([BOUND, UNVERIFIED, UNAVAILABLE, AMBIGUOUS, INCOMPATIBLE, UNBOUND]);

const SATISFIED = "satisfied";
const VIOLATED = "violated";
const UNKNOWN = "unknown";

/** This host's implementation identities (D-054). */
export const CHROME_JSON_HTTP_IMPLEMENTATION = Object.freeze({ id: "chrome.tool.json_http", version: "0.1.0" });
export const CHROME_HOST_RESOURCE_IMPLEMENTATION = Object.freeze({ id: "chrome.tool.host_resource", version: "0.1.0" });
export const HOST_RESOURCE_BINDING_PREFIX = "host.resource.";
/** The one input schema every host-resource tool declares: an empty object. */
export const HOST_RESOURCE_INPUT_SCHEMA: JsonObject = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false,
}) as JsonObject;

export interface ToolBindingDescriptor {
  schema: typeof BINDING_SCHEMA;
  id: string;
  tool_id: string;
  binding: string;
  implementation_kind: ImplementationKind;
  implementation_id: string;
  implementation_version: string;
  display_name: string;
  description: string | null;
  remote: boolean;
  available: boolean;
  availability_reason: string | null;
  enabled: boolean;
  endpoint: { origin: string; path: string; method: "GET" | "POST" } | null;
  contract: { input_schema_sha256: string | null; output_schema_sha256: string | null; permission_kinds: string[]; side_effects: "read" | "write" };
  limits: { timeout_seconds: number | null; max_request_bytes: number | null; max_response_bytes: number | null; max_concurrent: number | null; min_interval_ms: number | null };
  credentials: { required: boolean; configured: boolean; source: string | null };
  resource_type?: string;
  /** The implementation that answers when this binding's service is unavailable (D-153). */
  fallback?: { implementation_id: string; implementation_version: string; endpoint: { origin: string; path: string; method: "GET" } };
  binding_sha256: string;
}

export interface ToolRegistryHost {
  runtime: string;
  runtime_version: string | null;
  source: string;
  captured_at: string;
  agent_id: string | null;
}

export interface ToolRegistry {
  schema: typeof REGISTRY_SCHEMA;
  host: ToolRegistryHost;
  bindings: ToolBindingDescriptor[];
  notes: Array<{ code: string; detail: string | null }>;
  registry_sha256: string;
  binding_count: number;
  available_binding_count: number;
}

export interface ToolRegistryReference {
  registry_sha256: string;
  binding_count: number;
  available_binding_count: number;
  host: ToolRegistryHost;
}

export interface ToolContract {
  schema: typeof CONTRACT_SCHEMA;
  tool_id: string;
  tool_version: string;
  binding: string;
  execution: string;
  remote: boolean;
  method: string | null;
  side_effects: string;
  approval_required: boolean;
  domains: string[];
  permission_ids: string[];
  required_permission_ids: string[];
  optional_permission_ids: string[];
  permission_kinds: string[];
  network_resources: string[];
  allowed_domains: string[];
  timeout_seconds: number;
  endpoint_origin: string | null;
  endpoint_path: string | null;
  input_schema: string;
  output_schema: string;
  input_schema_sha256: string;
  output_schema_sha256: string;
  max_calls: number;
  contract_sha256: string;
}

export interface BindingCheck {
  id: string;
  subject: string;
  required: JsonValue;
  host_value: JsonValue;
  status: typeof SATISFIED | typeof VIOLATED | typeof UNKNOWN;
  detail: string | null;
}

export interface BindingEvaluation {
  resource_type?: string;
  status: ToolStatus;
  binding_id: string;
  binding_sha256: string;
  implementation_kind: ImplementationKind;
  implementation_id: string;
  implementation_version: string;
  display_name: string;
  description: string | null;
  remote: boolean;
  available: boolean;
  availability_reason: string | null;
  enabled: boolean;
  endpoint_origin: string | null;
  endpoint_path: string | null;
  method: string | null;
  credentials_required: boolean;
  credentials_configured: boolean;
  credentials_source: string | null;
  timeout_seconds: number | null;
  checks: BindingCheck[];
  satisfied: string[];
  violated: string[];
  unknown: string[];
}

export interface ToolEvaluation {
  tool_id: string;
  tool_version: string;
  binding_name: string;
  required: true;
  execution: string;
  remote: boolean;
  side_effects: string;
  approval_required: boolean;
  declared_domains: string[];
  declared_endpoint_origin: string | null;
  declared_endpoint_path: string | null;
  permission_ids: string[];
  required_permission_ids: string[];
  optional_permission_ids: string[];
  permission_kinds: string[];
  timeout_seconds: number;
  max_calls: number;
  contract_sha256: string;
  input_schema_sha256: string;
  output_schema_sha256: string;
  candidate_count: number;
  status: ToolStatus;
  binding: BindingEvaluation | null;
  reason: string | null;
  candidate_binding_ids?: string[];
  nodes: string[];
  roles: string[];
  approved: boolean;
  permissions_granted: boolean;
  denied_permission_ids: string[];
  denied_required_permission_ids: string[];
  usable: boolean;
  blocks_plan: boolean;
}

export interface RegistryEvaluation {
  schema: typeof EVALUATION_SCHEMA;
  evaluated_at: string;
  package_id: string;
  package_version: string;
  package_digest: string;
  requirements: { schema: string; package_id: string; package_version: string; package_digest: string; tool_count: number; note: string };
  registry: ToolRegistryReference;
  tools: ToolEvaluation[];
  counts: Record<string, number>;
  all_tools_bound: boolean;
  all_tools_usable: boolean;
  notes: Array<{ code: string; detail: string | null }>;
  execution: { performed: false; note: string };
}

/** `plan_tool_bindings` record: the exact, secret-free binding a run plan freezes. */
export interface PlanToolBinding {
  tool_id: string;
  binding_name: string;
  binding_id: string;
  binding_sha256: string;
  implementation_kind: ImplementationKind;
  implementation_id: string;
  implementation_version: string;
  display_name: string;
  remote: boolean;
  endpoint_origin: string | null;
  endpoint_path: string | null;
  method: string | null;
  contract_sha256: string;
  input_schema_sha256: string;
  output_schema_sha256: string;
  required_permission_ids: string[];
  usable: boolean;
  timeout_seconds: number;
  max_calls: number;
  credentials_required: boolean;
  credentials_configured: boolean;
  approved: boolean;
  approval_source: "authorization_receipt";
  compatibility_status: ToolStatus;
  resource_type?: string;
}

// -- helpers ---------------------------------------------------------------------
/** `_origin`: one HTTPS origin, port 443, no credentials, no path, no query. */
function originField(value: unknown, field: string): string {
  const raw = requiredText(value, field, { limit: 256 });
  let parts;
  try {
    parts = urlsplit(raw);
  } catch {
    throw invalid(`${field} must be an https origin on port 443 with no credentials, path or query`);
  }
  if (parts.portError) throw invalid(`${field} has an invalid port`);
  if (
    parts.scheme !== "https" ||
    !parts.hostname ||
    parts.username ||
    parts.password ||
    parts.netloc.includes("@") ||
    (parts.path !== "" && parts.path !== "/") ||
    parts.query ||
    parts.fragment ||
    (parts.port !== null && parts.port !== 443)
  ) {
    throw invalid(`${field} must be an https origin on port 443 with no credentials, path or query`);
  }
  return `https://${parts.hostname}`;
}

function pathField(value: unknown, field: string): string {
  const raw = requiredText(value, field, { limit: 256 });
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes("..")) {
    throw invalid(`${field} must be an absolute path with no query, fragment or '..'`);
  }
  return raw;
}

const hostFromOrigin = (origin: string | null): string | null => {
  if (!origin) return null;
  try {
    return urlsplit(origin).hostname;
  } catch {
    return null;
  }
};

const str = (value: JsonValue | undefined): string => String(value);
const sortStrings = (values: readonly string[]): string[] => [...values].sort();

// -- binding digest and normalization ---------------------------------------------
/**
 * `binding_digest`: the security-relevant identity of one binding. It covers what the binding
 * would do and excludes liveness and presentation. `credentials.configured` is a boolean, so
 * attaching a secret changes the digest without the secret being hashed or stored.
 */
export async function bindingDigest(binding: Omit<ToolBindingDescriptor, "binding_sha256">): Promise<string> {
  const subject: Record<string, unknown> = {
    schema: BINDING_DIGEST_SCHEMA,
    binding_id: binding.id,
    tool_id: binding.tool_id,
    binding: binding.binding,
    implementation_kind: binding.implementation_kind,
    implementation_id: binding.implementation_id,
    implementation_version: binding.implementation_version,
    remote: binding.remote,
    endpoint: binding.endpoint,
    contract: binding.contract,
    limits: binding.limits,
    credentials: { required: binding.credentials.required, configured: binding.credentials.configured, source: binding.credentials.source },
  };
  if (binding.resource_type !== undefined && binding.resource_type !== null) subject.resource_type = binding.resource_type;
  // Present only when the binding has one (D-153), so every other binding keeps the reference's digest.
  if (binding.fallback !== undefined) subject.fallback = binding.fallback;
  return sha256Hex(canonicalJson(subject));
}

/** `normalize_binding`: validate one host tool binding descriptor into the exact stored shape. */
export async function normalizeBinding(raw: unknown, index: number): Promise<ToolBindingDescriptor> {
  const field = `bindings[${index}]`;
  const record = closedRecord(
    raw,
    field,
    ["id", "tool_id", "binding", "implementation_kind", "implementation_id", "implementation_version", "display_name", "description", "remote", "available", "availability_reason", "enabled", "endpoint", "contract", "limits", "credentials", "resource_type", "fallback"],
    ["id", "tool_id", "binding", "implementation_kind", "implementation_id", "implementation_version", "display_name", "remote", "available", "contract"],
  );
  const kindText = requiredText(record.implementation_kind, `${field}.implementation_kind`, { limit: 64 });
  if (!(IMPLEMENTATION_KINDS as readonly string[]).includes(kindText)) throw invalid(`${field}.implementation_kind must be one of ${pyRepr([...IMPLEMENTATION_KINDS])}`);
  const kind = kindText as ImplementationKind;
  const remote = flag(record.remote, `${field}.remote`);
  if (REMOTE_KINDS.includes(kind) !== remote) {
    throw invalid(`${field}: ${KIND_JSON_HTTP} bindings are remote and ${KIND_LOCAL_BUILTIN} / ${KIND_SELECTED_FILE} / ${KIND_HOST_RESOURCE} bindings are local; the two must agree`);
  }
  let resourceType: string | null = null;
  if (kind === KIND_HOST_RESOURCE) resourceType = requiredText(record.resource_type, `${field}.resource_type`, { limit: 128 });
  else if (record.resource_type !== undefined && record.resource_type !== null) throw invalid(`${field}.resource_type belongs to a ${KIND_HOST_RESOURCE} binding only`);
  const endpointRaw = record.endpoint;
  let endpoint: ToolBindingDescriptor["endpoint"] = null;
  if (remote) {
    const endpointRecord = closedRecord(endpointRaw ?? {}, `${field}.endpoint`, ["origin", "path", "method"], ["origin", "path", "method"]);
    const method = requiredText(endpointRecord.method, `${field}.endpoint.method`, { limit: 8 });
    if (method !== "GET" && method !== "POST") throw invalid(`${field}.endpoint.method must be GET or POST`);
    endpoint = { origin: originField(endpointRecord.origin, `${field}.endpoint.origin`), path: pathField(endpointRecord.path, `${field}.endpoint.path`), method };
  } else if (endpointRaw !== undefined && endpointRaw !== null && !(typeof endpointRaw === "object" && Object.keys(endpointRaw as object).length === 0)) {
    throw invalid(`${field}.endpoint must be absent for a local binding`);
  }
  const contractRecord = closedRecord(record.contract, `${field}.contract`, ["input_schema_sha256", "output_schema_sha256", "permission_kinds", "side_effects"], ["permission_kinds", "side_effects"]);
  const kindsRaw = contractRecord.permission_kinds;
  if (!Array.isArray(kindsRaw) || kindsRaw.length > MAX_KINDS) throw invalid(`${field}.contract.permission_kinds must be a bounded list`);
  const sideEffects = requiredText(contractRecord.side_effects, `${field}.contract.side_effects`, { limit: 16 });
  if (sideEffects !== "read" && sideEffects !== "write") throw invalid(`${field}.contract.side_effects must be read or write`);
  const contract: ToolBindingDescriptor["contract"] = {
    input_schema_sha256: hex64(contractRecord.input_schema_sha256, `${field}.contract.input_schema_sha256`, true),
    output_schema_sha256: hex64(contractRecord.output_schema_sha256, `${field}.contract.output_schema_sha256`, true),
    permission_kinds: sortedUnique(kindsRaw.map((item) => requiredText(item, `${field}.contract.permission_kinds[]`, { limit: 64 }))),
    side_effects: sideEffects,
  };
  const limitsRecord = closedRecord(record.limits ?? {}, `${field}.limits`, ["timeout_seconds", "max_request_bytes", "max_response_bytes", "max_concurrent", "min_interval_ms"]);
  const limits: ToolBindingDescriptor["limits"] = {
    timeout_seconds: positiveCount(limitsRecord.timeout_seconds, `${field}.limits.timeout_seconds`, { maximum: 120 }),
    max_request_bytes: positiveCount(limitsRecord.max_request_bytes, `${field}.limits.max_request_bytes`, { maximum: 4 * 1024 * 1024 }),
    max_response_bytes: positiveCount(limitsRecord.max_response_bytes, `${field}.limits.max_response_bytes`, { maximum: 16 * 1024 * 1024 }),
    max_concurrent: positiveCount(limitsRecord.max_concurrent, `${field}.limits.max_concurrent`, { maximum: 64 }),
    min_interval_ms: positiveCount(limitsRecord.min_interval_ms, `${field}.limits.min_interval_ms`, { maximum: 60_000 }),
  };
  const credentialsRecord = closedRecord(record.credentials ?? {}, `${field}.credentials`, ["required", "configured", "source"]);
  const credentials: ToolBindingDescriptor["credentials"] = {
    required: credentialsRecord.required === true,
    configured: credentialsRecord.configured === true,
    source: text(credentialsRecord.source, `${field}.credentials.source`, { limit: 64, allowNull: true }),
  };
  const binding: Omit<ToolBindingDescriptor, "binding_sha256"> = {
    schema: BINDING_SCHEMA,
    id: requiredText(record.id, `${field}.id`, { limit: 200 }),
    tool_id: requiredText(record.tool_id, `${field}.tool_id`, { limit: 200 }),
    binding: requiredText(record.binding, `${field}.binding`, { limit: 200 }),
    implementation_kind: kind,
    implementation_id: requiredText(record.implementation_id, `${field}.implementation_id`, { limit: 200 }),
    implementation_version: requiredText(record.implementation_version, `${field}.implementation_version`, { limit: 64 }),
    display_name: requiredText(record.display_name, `${field}.display_name`),
    description: text(record.description, `${field}.description`, { allowNull: true }),
    remote,
    available: flag(record.available, `${field}.available`),
    availability_reason: text(record.availability_reason, `${field}.availability_reason`, { allowNull: true }),
    enabled: (record.enabled ?? true) === true,
    endpoint,
    contract,
    limits,
    credentials,
  };
  if (resourceType !== null) binding.resource_type = resourceType;
  if (record.fallback !== undefined && record.fallback !== null) {
    // Only the host's own Crossref DOI lookup, behind a remote citation.resolve binding (D-153).
    if (kind !== KIND_JSON_HTTP || binding.binding !== CITATION_RESOLVE) throw invalid(`${field}.fallback belongs to a ${KIND_JSON_HTTP} ${CITATION_RESOLVE} binding only`);
    const fallback = closedRecord(record.fallback, `${field}.fallback`, ["implementation_id", "implementation_version", "endpoint"], ["implementation_id", "implementation_version", "endpoint"]);
    const target = closedRecord(fallback.endpoint, `${field}.fallback.endpoint`, ["origin", "path", "method"], ["origin", "path", "method"]);
    if (fallback.implementation_id !== CROSSREF_DOI_IMPLEMENTATION.id || fallback.implementation_version !== CROSSREF_DOI_IMPLEMENTATION.version || target.origin !== CROSSREF_ORIGIN || target.path !== CROSSREF_DOI_PATH || target.method !== "GET") {
      throw invalid(`${field}.fallback must be this host's ${CROSSREF_DOI_IMPLEMENTATION.id} ${CROSSREF_DOI_IMPLEMENTATION.version} at ${CROSSREF_ORIGIN}${CROSSREF_DOI_PATH}`);
    }
    binding.fallback = { implementation_id: CROSSREF_DOI_IMPLEMENTATION.id, implementation_version: CROSSREF_DOI_IMPLEMENTATION.version, endpoint: { origin: CROSSREF_ORIGIN, path: CROSSREF_DOI_PATH, method: "GET" } };
  }
  return { ...binding, binding_sha256: await bindingDigest(binding) };
}

/** `normalize_registry`: validate a whole host tool registry and bind it to a content hash. */
export async function normalizeRegistry(raw: unknown): Promise<ToolRegistry> {
  const record = closedRecord(raw, "tool_registry", ["schema", "host", "bindings", "notes"], ["host", "bindings"]);
  const schema = requiredText(record.schema ?? REGISTRY_SCHEMA, "tool_registry.schema");
  if (schema !== REGISTRY_SCHEMA) throw invalid(`tool_registry.schema must be ${pyRepr(REGISTRY_SCHEMA)}, got ${pyRepr(schema)}`);
  const host = closedRecord(record.host, "tool_registry.host", ["runtime", "runtime_version", "source", "captured_at", "agent_id"], ["runtime", "source", "captured_at"]);
  const bindingsRaw = record.bindings;
  if (!Array.isArray(bindingsRaw)) throw invalid("tool_registry.bindings must be a list");
  if (bindingsRaw.length > MAX_BINDINGS) throw invalid(`tool_registry.bindings exceeds ${MAX_BINDINGS} entries`);
  const bindings: ToolBindingDescriptor[] = [];
  for (const [index, item] of bindingsRaw.entries()) bindings.push(await normalizeBinding(item, index));
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.id)) throw invalid(`duplicate binding id ${pyRepr(binding.id)}`);
    seen.add(binding.id);
  }
  const notesRaw = record.notes ?? [];
  if (!Array.isArray(notesRaw) || notesRaw.length > MAX_NOTES) throw invalid(`tool_registry.notes must be a list of at most ${MAX_NOTES}`);
  const notes = notesRaw.map((note) => {
    const entry = closedRecord(note, "tool_registry.notes[]", ["code", "detail"], ["code"]);
    return { code: requiredText(entry.code, "tool_registry.notes[].code", { limit: 128 }), detail: text(entry.detail, "tool_registry.notes[].detail", { allowNull: true }) };
  });
  const registry = {
    schema: REGISTRY_SCHEMA as typeof REGISTRY_SCHEMA,
    host: {
      runtime: requiredText(host.runtime, "tool_registry.host.runtime", { limit: 64 }),
      runtime_version: text(host.runtime_version, "tool_registry.host.runtime_version", { allowNull: true }),
      source: requiredText(host.source, "tool_registry.host.source"),
      captured_at: requiredText(host.captured_at, "tool_registry.host.captured_at", { limit: 64 }),
      agent_id: text(host.agent_id, "tool_registry.host.agent_id", { allowNull: true }),
    },
    bindings,
    notes,
  };
  return {
    ...registry,
    registry_sha256: await sha256Hex(canonicalJson(registry)),
    binding_count: bindings.length,
    available_binding_count: bindings.filter((binding) => binding.available && binding.enabled).length,
  };
}

export function toolRegistryReference(registry: ToolRegistry): ToolRegistryReference {
  return { registry_sha256: registry.registry_sha256, binding_count: registry.binding_count, available_binding_count: registry.available_binding_count, host: { ...registry.host } };
}

// -- package declarations ----------------------------------------------------
/** `tool_contract`: what one declared package tool asks a host implementation to be. */
export async function toolContract(pkg: Package, toolId: string): Promise<ToolContract> {
  const tool = pkg.tools[toolId];
  if (!tool) throw invalid(`This package declares no tool named ${pyRepr(toolId)}`);
  const permissions = new Map((pkg.policy.permissions as JsonObject[]).map((item) => [str(item.id), item]));
  const linked = (tool.permissions as JsonValue[]).map(str).filter((pid) => permissions.has(pid));
  const endpoint = typeof tool.endpoint === "string" ? tool.endpoint : null;
  let origin: string | null = null;
  let path: string | null = null;
  if (endpoint) {
    const parts = urlsplit(endpoint);
    origin = `${parts.scheme}://${parts.hostname}`;
    path = parts.path || "/";
  }
  const kindOf = (pid: string) => str(permissions.get(pid)!.kind);
  const contract = {
    schema: CONTRACT_SCHEMA as typeof CONTRACT_SCHEMA,
    tool_id: str(tool.id),
    tool_version: str(tool.version),
    binding: str(tool.binding),
    execution: str(tool.execution),
    remote: tool.execution === "remote",
    method: typeof tool.method === "string" ? tool.method : null,
    side_effects: str(tool.side_effects),
    approval_required: tool.approval_required === true,
    domains: sortStrings((tool.domains as JsonValue[]).map(str)),
    permission_ids: sortStrings(linked),
    required_permission_ids: sortStrings(linked.filter((pid) => permissions.get(pid)!.required === true)),
    optional_permission_ids: sortStrings(linked.filter((pid) => permissions.get(pid)!.required !== true)),
    permission_kinds: sortedUnique(linked.map(kindOf)),
    network_resources: sortedUnique(linked.filter((pid) => kindOf(pid) === "network").flatMap((pid) => (permissions.get(pid)!.resources as JsonValue[]).map(str))),
    allowed_domains: sortStrings(((pkg.policy.network as JsonObject).allowed_domains as JsonValue[]).map(str)),
    timeout_seconds: tool.timeout_seconds as number,
    endpoint_origin: origin,
    endpoint_path: path,
    input_schema: str(tool.input_schema),
    output_schema: str(tool.output_schema),
    input_schema_sha256: await sha256Hex(canonicalJson(packageJson(pkg, str(tool.input_schema)))),
    output_schema_sha256: await sha256Hex(canonicalJson(packageJson(pkg, str(tool.output_schema)))),
    max_calls: (((pkg.policy.budget as JsonObject).max_calls_per_tool as JsonObject)[str(tool.id)] as number | undefined) ?? 0,
  };
  return { ...contract, contract_sha256: await sha256Hex(canonicalJson(contract)) };
}

export interface ToolRequirementSet {
  schema: typeof REQUIREMENTS_SCHEMA;
  package_id: string;
  package_version: string;
  package_digest: string;
  tools: Array<ToolContract & { required: true; nodes: string[]; roles: string[] }>;
  tool_count: number;
  note: string;
}

/** `tool_requirement_set`: every tool the package declares, as host-neutral requirements. */
export async function toolRequirementSet(pkg: Package): Promise<ToolRequirementSet> {
  const contracts: ToolContract[] = [];
  for (const toolId of Object.keys(pkg.tools).sort()) contracts.push(await toolContract(pkg, toolId));
  const used = new Map<string, string[]>();
  for (const node of ((pkg.graph.nodes as JsonObject[] | undefined) ?? [])) {
    if (node.type === "tool") used.set(str(node.tool), [...(used.get(str(node.tool)) ?? []), str(node.id)]);
    if (node.type === "map") {
      for (const step of ((node.steps as JsonObject[] | undefined) ?? [])) {
        if (step.type === "tool") used.set(str(step.tool), [...(used.get(str(step.tool)) ?? []), `${str(node.id)}/${str(step.id)}`]);
      }
    }
  }
  const roles = new Map<string, string[]>();
  for (const worker of pkg.graph.workers as JsonObject[]) {
    for (const toolId of (worker.tools as JsonValue[]).map(str)) roles.set(toolId, [...(roles.get(toolId) ?? []), str(worker.id)]);
  }
  return {
    schema: REQUIREMENTS_SCHEMA,
    package_id: str(pkg.manifest.package_id),
    package_version: str(pkg.manifest.version),
    package_digest: pkg.digest,
    tools: contracts.map((contract) => ({ ...contract, required: true as const, nodes: sortStrings(used.get(contract.tool_id) ?? []), roles: sortStrings(roles.get(contract.tool_id) ?? []) })),
    tool_count: contracts.length,
    note: "agent.pkg 0.1 declares no optional tools, so every declared tool must have an approved host binding before a run plan can be ready.",
  };
}

// -- evaluation --------------------------------------------------------------
function check(id: string, subject: string, required: JsonValue, hostValue: JsonValue | undefined, detail: string | null = null): BindingCheck {
  const value = hostValue === undefined ? null : hostValue;
  let status: BindingCheck["status"];
  if (value === null) status = UNKNOWN;
  else if (Array.isArray(required)) status = Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify([...required].sort()) ? SATISFIED : VIOLATED;
  else status = value === required ? SATISFIED : VIOLATED;
  return { id, subject, required, host_value: value, status, detail };
}

/** `evaluate_binding`: compare one host binding against one package tool contract, in detail. */
export function evaluateBinding(contract: ToolContract, binding: ToolBindingDescriptor): BindingEvaluation {
  const checks: BindingCheck[] = [
    check("tool_id", "tool_id", contract.tool_id, binding.tool_id),
    check("binding_name", "binding", contract.binding, binding.binding),
    check("execution_locality", "remote", contract.remote, binding.remote),
    check("side_effects", "side_effects", contract.side_effects, binding.contract.side_effects),
    check("permission_kinds", "permission_kinds", contract.permission_kinds, binding.contract.permission_kinds),
    check(
      "input_schema",
      "input_schema_sha256",
      contract.input_schema_sha256,
      binding.contract.input_schema_sha256,
      binding.contract.input_schema_sha256 ? null : "This host binding declares no input-schema digest, so the wire contract it implements cannot be confirmed against the package's own schema.",
    ),
    check(
      "output_schema",
      "output_schema_sha256",
      contract.output_schema_sha256,
      binding.contract.output_schema_sha256,
      binding.contract.output_schema_sha256 ? null : "This host binding declares no output-schema digest, so the wire contract it implements cannot be confirmed against the package's own schema.",
    ),
  ];
  if (contract.remote && binding.remote) {
    const endpoint = binding.endpoint;
    const hostName = hostFromOrigin(endpoint?.origin ?? null);
    const permitted = contract.domains.filter((domain) => contract.network_resources.includes(domain) && contract.allowed_domains.includes(domain)).sort();
    checks.push({
      id: "endpoint_domain",
      subject: "endpoint_origin",
      required: permitted,
      host_value: hostName,
      status: hostName !== null && permitted.includes(hostName) ? SATISFIED : VIOLATED,
      detail: "A remote binding must land on a host the package declares, the linked network permission names, and the package network policy allows.",
    });
    checks.push(check("endpoint_path", "endpoint_path", contract.endpoint_path, endpoint?.path));
    checks.push(check("method", "method", contract.method, endpoint?.method));
  }
  const violated = checks.filter((item) => item.status === VIOLATED);
  const unknown = checks.filter((item) => item.status === UNKNOWN);
  let status: ToolStatus;
  if (violated.length > 0) status = INCOMPATIBLE;
  else if (!(binding.available && binding.enabled)) status = UNAVAILABLE;
  else if (unknown.length > 0) status = UNVERIFIED;
  else status = BOUND;
  const extra = binding.resource_type ? { resource_type: binding.resource_type } : {};
  return {
    ...extra,
    status,
    binding_id: binding.id,
    binding_sha256: binding.binding_sha256,
    implementation_kind: binding.implementation_kind,
    implementation_id: binding.implementation_id,
    implementation_version: binding.implementation_version,
    display_name: binding.display_name,
    description: binding.description,
    remote: binding.remote,
    available: binding.available,
    availability_reason: binding.availability_reason,
    enabled: binding.enabled,
    endpoint_origin: binding.endpoint?.origin ?? null,
    endpoint_path: binding.endpoint?.path ?? null,
    method: binding.endpoint?.method ?? null,
    credentials_required: binding.credentials.required,
    credentials_configured: binding.credentials.configured,
    credentials_source: binding.credentials.source,
    timeout_seconds: binding.limits.timeout_seconds,
    checks,
    satisfied: checks.filter((item) => item.status === SATISFIED).map((item) => item.id),
    violated: violated.map((item) => item.id),
    unknown: unknown.map((item) => item.id),
  };
}

type ToolRecord = Omit<ToolEvaluation, "status" | "binding" | "reason" | "candidate_binding_ids" | "nodes" | "roles" | "approved" | "permissions_granted" | "denied_permission_ids" | "denied_required_permission_ids" | "usable" | "blocks_plan">;

/** `evaluate_tool`: decide what this host offers for one declared tool, and say why. */
export function evaluateTool(contract: ToolContract, registry: ToolRegistry): Pick<ToolEvaluation, keyof ToolRecord | "status" | "binding" | "reason" | "candidate_binding_ids"> {
  const candidates = registry.bindings.filter((binding) => binding.tool_id === contract.tool_id);
  const record: ToolRecord = {
    tool_id: contract.tool_id,
    tool_version: contract.tool_version,
    binding_name: contract.binding,
    required: true,
    execution: contract.execution,
    remote: contract.remote,
    side_effects: contract.side_effects,
    approval_required: contract.approval_required,
    declared_domains: [...contract.domains],
    declared_endpoint_origin: contract.endpoint_origin,
    declared_endpoint_path: contract.endpoint_path,
    permission_ids: [...contract.permission_ids],
    required_permission_ids: [...contract.required_permission_ids],
    optional_permission_ids: [...contract.optional_permission_ids],
    permission_kinds: [...contract.permission_kinds],
    timeout_seconds: contract.timeout_seconds,
    max_calls: contract.max_calls,
    contract_sha256: contract.contract_sha256,
    input_schema_sha256: contract.input_schema_sha256,
    output_schema_sha256: contract.output_schema_sha256,
    candidate_count: candidates.length,
  };
  if (candidates.length === 0) {
    return {
      ...record,
      status: UNBOUND,
      binding: null,
      reason: "This host registers no implementation for this tool, so the package cannot be run here. The package declares what it needs; the host decides what, if anything, satisfies it.",
    };
  }
  if (candidates.length > 1) {
    return {
      ...record,
      status: AMBIGUOUS,
      binding: null,
      reason: `This host registers ${candidates.length} implementations for this tool. Exactly one binding must satisfy a declaration, so that what ran can be named.`,
      candidate_binding_ids: sortStrings(candidates.map((binding) => binding.id)),
    };
  }
  const evaluated = evaluateBinding(contract, candidates[0]!);
  let reason: string | null = null;
  if (evaluated.status === INCOMPATIBLE) reason = `The host implementation does not satisfy this tool's declared contract: ${evaluated.violated.join(", ")}`;
  else if (evaluated.status === UNAVAILABLE) reason = evaluated.availability_reason ?? "This host reports the binding as unusable.";
  else if (evaluated.status === UNVERIFIED) reason = `The host does not state enough about this implementation to confirm ${evaluated.unknown.join(", ")}`;
  return { ...record, status: evaluated.status, binding: evaluated, reason };
}

const ORDER: Record<ToolStatus, number> = { [BOUND]: 0, [UNVERIFIED]: 1, [UNAVAILABLE]: 2, [AMBIGUOUS]: 3, [INCOMPATIBLE]: 4, [UNBOUND]: 5 };

/**
 * `evaluate_registry`: every declared tool against one host registry, in a stable order.
 * `decisions` and `tool_approvals` are the person's, not the host's; they are reported beside
 * the verdict so a UI can show all three facts, never inferred from a binding.
 */
export async function evaluateRegistry(
  pkg: Package,
  registry: ToolRegistry,
  options: { decisions?: Record<string, Decision>; toolApprovals?: Record<string, boolean>; now?: Date } = {},
): Promise<RegistryEvaluation> {
  const requirements = await toolRequirementSet(pkg);
  const decisions = options.decisions ?? {};
  const approvals = options.toolApprovals ?? {};
  const tools: ToolEvaluation[] = requirements.tools.map((contract) => {
    const evaluated = evaluateTool(contract, registry);
    const denied = contract.permission_ids.filter((pid) => (decisions[pid] ?? DENY) === DENY).sort();
    const deniedRequired = denied.filter((pid) => contract.required_permission_ids.includes(pid));
    const approved = approvals[contract.tool_id] === true;
    return {
      ...evaluated,
      nodes: contract.nodes,
      roles: contract.roles,
      approved,
      permissions_granted: denied.length === 0 && contract.permission_ids.length > 0,
      denied_permission_ids: denied,
      denied_required_permission_ids: deniedRequired,
      usable: evaluated.status === BOUND && approved && denied.length === 0 && contract.permission_ids.length > 0,
      blocks_plan: !(evaluated.status === BOUND && approved && deniedRequired.length === 0 && contract.permission_ids.length > 0),
    };
  });
  tools.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.tool_id < b.tool_id ? -1 : a.tool_id > b.tool_id ? 1 : 0));
  const counts: Record<string, number> = {};
  for (const status of TOOL_STATUSES) counts[status] = tools.filter((item) => item.status === status).length;
  return {
    schema: EVALUATION_SCHEMA,
    evaluated_at: (options.now ?? new Date()).toISOString(),
    package_id: str(pkg.manifest.package_id),
    package_version: str(pkg.manifest.version),
    package_digest: pkg.digest,
    requirements: { schema: requirements.schema, package_id: requirements.package_id, package_version: requirements.package_version, package_digest: requirements.package_digest, tool_count: requirements.tool_count, note: requirements.note },
    registry: toolRegistryReference(registry),
    tools,
    counts: { ...counts, total: tools.length, approved: tools.filter((item) => item.approved).length, usable: tools.filter((item) => item.usable).length, blocking: tools.filter((item) => item.blocks_plan).length },
    all_tools_bound: tools.every((item) => item.status === BOUND),
    all_tools_usable: tools.every((item) => item.usable),
    notes: registry.notes.map((note) => ({ ...note })),
    execution: { performed: false, note: "Evaluating a binding reads declarations only; no implementation was called and no request left this host." },
  };
}

/** `plan_tool_bindings`: the exact, secret-free binding records a run plan freezes. */
export function planToolBindings(evaluation: RegistryEvaluation): PlanToolBinding[] {
  const records: PlanToolBinding[] = [];
  for (const tool of [...evaluation.tools].sort((a, b) => (a.tool_id < b.tool_id ? -1 : a.tool_id > b.tool_id ? 1 : 0))) {
    const binding = tool.binding;
    if (binding === null) continue;
    const record: PlanToolBinding = {
      tool_id: tool.tool_id,
      binding_name: tool.binding_name,
      binding_id: binding.binding_id,
      binding_sha256: binding.binding_sha256,
      implementation_kind: binding.implementation_kind,
      implementation_id: binding.implementation_id,
      implementation_version: binding.implementation_version,
      display_name: binding.display_name,
      remote: binding.remote,
      endpoint_origin: binding.endpoint_origin,
      endpoint_path: binding.endpoint_path,
      method: binding.method,
      contract_sha256: tool.contract_sha256,
      input_schema_sha256: tool.input_schema_sha256,
      output_schema_sha256: tool.output_schema_sha256,
      required_permission_ids: [...tool.permission_ids],
      usable: tool.usable,
      timeout_seconds: Math.min(tool.timeout_seconds, binding.timeout_seconds ?? tool.timeout_seconds),
      max_calls: tool.max_calls,
      credentials_required: binding.credentials_required,
      credentials_configured: binding.credentials_configured,
      approved: tool.approved,
      approval_source: "authorization_receipt",
      compatibility_status: tool.status,
    };
    if (binding.resource_type) record.resource_type = binding.resource_type;
    records.push(record);
  }
  return records;
}

export function findBinding(registry: ToolRegistry, bindingId: string): ToolBindingDescriptor | null {
  return registry.bindings.find((binding) => binding.id === bindingId) ?? null;
}

// -- the Chrome host's own registry (D-054) ----------------------------------------
/** A vault type as the registry builder needs it: id, permission kind and value-schema digest. */
export interface HostResourceTypeFacts {
  id: string;
  display_name: string;
  permission_kind: string;
  schema_sha256: string;
}

export interface HostToolRegistryOptions {
  resourceTypes: readonly HostResourceTypeFacts[];
  runtimeVersion: string | null;
  now?: Date;
  /** Whether the person entered a Crossref contact address in Settings → Services (D-081). */
  contactConfigured?: boolean;
}

export const CHROME_TOOL_REGISTRY_SOURCE =
  "chrome-agent-browser host tool registry (D-054, D-081, D-082): one generic HTTPS JSON binding per declared remote POST tool, derived from the signed declaration after the URL gate; the host's Crossref search for scholarly.search at Crossref's works endpoint; the selected-PDF reader for paper.read; one host-resource binding per vault type; other tools unbound";

/** The abstract capability the citation fallback serves (D-153), and the domain its package tool must declare. */
export const CITATION_RESOLVE = "citation.resolve";
export const CROSSREF_HOST = "api.crossref.org";

/** Where the Crossref adapter's optional contact address comes from (Settings → Services, D-081). */
export const CROSSREF_CONTACT_SOURCE = "settings:crossref.contact";

interface HostImplementation {
  binding: string;
  kind: ImplementationKind;
  implementation: { id: string; version: string };
  display_name: string;
  description: string;
  /** For a remote implementation: the exact endpoint a declaration must name for this host to serve it. */
  endpoint?: { origin: string; path: string; method: "GET" | "POST" };
  input_schema_sha256: string;
  output_schema_sha256: string;
  permission_kinds: string[];
  limits: { timeout_seconds: number; max_request_bytes: number; max_response_bytes: number; max_concurrent: number; min_interval_ms?: number };
  /** Whether the implementation sends the person's optional contact address when one is set. */
  contact?: boolean;
}

/**
 * The service implementations this host ships. The digests are the canonical-JSON SHA-256 of the
 * request and response contract each adapter speaks, the same values the reference plugin pins
 * (`tool-registry.ts::BUILT_IN_BINDINGS`); `test/core/tools/service-bindings.test.ts` checks them
 * against Literature Review 0.2.5's declared schemas, which is how "the host and the package agree"
 * is established rather than assumed.
 */
export const SERVICE_IMPLEMENTATIONS: readonly HostImplementation[] = Object.freeze([
  {
    binding: "scholarly.search",
    kind: KIND_JSON_HTTP,
    implementation: CROSSREF_IMPLEMENTATION,
    display_name: "Crossref works search",
    description:
      "One GET to https://api.crossref.org/works with exactly four parameters (query.bibliographic, rows, a fixed field selection and a fixed filter to scholarly work types) whose names and fixed values are host code, plus mailto when you entered a contact address in Settings → Services. At most one call at a time and one start per second, as Crossref's public pool asks. The answer is reduced to the declared search result, with markup rendered to text as the Citation Resolver renders the same fields.",
    endpoint: { origin: "https://api.crossref.org", path: "/works", method: "GET" },
    input_schema_sha256: "f8a6f920b23bf1731a85d5275c10eee77a9d055fb14917be114c1b9e8249baf2",
    output_schema_sha256: "eb83100404221fd9a489046d6741a046aae07c31c672ab6dc2daabffeda3c9ee",
    permission_kinds: ["network"],
    // A GET carries its arguments in the URL; this bounds that URL.
    limits: { timeout_seconds: 25, max_request_bytes: 4 * 1024, max_response_bytes: 512 * 1024, max_concurrent: 1, min_interval_ms: 1000 },
    contact: true,
  },
]);

/** The local implementations this host ships beside the host-resource ones. */
export const LOCAL_IMPLEMENTATIONS: readonly HostImplementation[] = Object.freeze([
  {
    binding: "paper.read",
    kind: KIND_SELECTED_FILE,
    implementation: SELECTED_PDF_IMPLEMENTATION,
    display_name: "Selected PDF text",
    description:
      "Extracts page text from one PDF you picked in Settings → Files and gave this run, named by an opaque id. No path is accepted, no other file is readable, and nothing is fetched, rendered, executed or OCRed; the parser runs in its own Worker under the reference's page and text limits.",
    input_schema_sha256: "5b1df5dc0d13ca9a8b76cce86d93639f2b13baf3eb66ec895a725fc9169686ca",
    output_schema_sha256: "4feee1362ccba94d82ffbd56e106525c1fab7643e664172d63469ec241ab3167",
    permission_kinds: ["files.read"],
    limits: { timeout_seconds: 20, max_request_bytes: 1024, max_response_bytes: 512 * 1024, max_concurrent: 2 },
  },
]);

function implementationBinding(toolId: string, contract: ToolContract, item: HostImplementation, options: HostToolRegistryOptions): JsonObject {
  const timeout = Math.min(Math.max(contract.timeout_seconds, 1), item.limits.timeout_seconds);
  return {
    id: `chrome:${item.implementation.id.split(".").pop()}:${toolId}:1`,
    tool_id: toolId,
    binding: item.binding,
    implementation_kind: item.kind,
    implementation_id: item.implementation.id,
    implementation_version: item.implementation.version,
    display_name: item.display_name,
    description: item.description,
    remote: item.kind === KIND_JSON_HTTP,
    available: true,
    enabled: true,
    ...(item.endpoint ? { endpoint: { ...item.endpoint } } : {}),
    contract: { input_schema_sha256: item.input_schema_sha256, output_schema_sha256: item.output_schema_sha256, permission_kinds: [...item.permission_kinds], side_effects: "read" },
    limits: { ...item.limits, timeout_seconds: timeout },
    credentials: item.contact ? { required: false, configured: options.contactConfigured === true, source: CROSSREF_CONTACT_SOURCE } : { required: false, configured: false },
  };
}

/**
 * The registry this Chrome host offers for one package. Derived, not configured: see the
 * module header. The declaration constrains the binding downwards and grants nothing; a
 * declared endpoint the URL gate refuses leaves the tool `unbound` with a note.
 */
export async function buildHostToolRegistry(pkg: Package, options: HostToolRegistryOptions): Promise<ToolRegistry> {
  const now = options.now ?? new Date();
  const bindings: unknown[] = [];
  const notes: Array<{ code: string; detail: string | null }> = [];
  const emptyInputSha256 = await sha256Hex(canonicalJson(HOST_RESOURCE_INPUT_SCHEMA));
  const types = new Map(options.resourceTypes.map((type) => [type.id, type]));
  for (const toolId of Object.keys(pkg.tools).sort()) {
    const tool = pkg.tools[toolId]!;
    const contract = await toolContract(pkg, toolId);
    if (contract.remote) {
      const endpoint = typeof tool.endpoint === "string" ? tool.endpoint : null;
      if (!endpoint || (contract.method !== "GET" && contract.method !== "POST")) {
        notes.push({ code: "tool_endpoint_undeclared", detail: `${toolId}: a remote tool must declare an HTTPS endpoint and a GET or POST method for this host to bind it.` });
        continue;
      }
      try {
        validatePackageUrl(endpoint, "Tool endpoint");
        // The registry's own endpoint rules (a path with '..' or over 256 characters passes the
        // URL gate): a value `normalizeRegistry` would refuse leaves this one tool unbound
        // instead of failing the whole registry (review 1, nit 11).
        originField(contract.endpoint_origin, "Tool endpoint origin");
        pathField(contract.endpoint_path, "Tool endpoint path");
      } catch (error) {
        notes.push({ code: "tool_endpoint_refused", detail: `${toolId}: ${error instanceof Error ? error.message : "the declared endpoint is refused by the URL policy"}` });
        continue;
      }
      const service = SERVICE_IMPLEMENTATIONS.find((item) => item.binding === contract.binding && item.endpoint?.origin === contract.endpoint_origin && item.endpoint.path === contract.endpoint_path && item.endpoint.method === contract.method);
      if (service) {
        bindings.push(implementationBinding(toolId, contract, service, options));
        continue;
      }
      if (contract.method !== "POST") {
        // The generic adapter's contract is one JSON request body; a GET would drop every argument.
        notes.push({ code: "tool_method_unsupported", detail: `${toolId}: the generic HTTPS JSON adapter sends one POST body, and this browser has no service adapter for a ${contract.method} to ${contract.endpoint_origin}${contract.endpoint_path}, so the tool stays unbound.` });
        continue;
      }
      // The citation fallback (D-153): only for the abstract citation.resolve capability, and only
      // when the signed declaration lists Crossref's domain, so the person's grant of the tool's
      // network permission covers the lookup.
      const fallback = contract.binding === CITATION_RESOLVE && contract.domains.includes(CROSSREF_HOST) ? { implementation_id: CROSSREF_DOI_IMPLEMENTATION.id, implementation_version: CROSSREF_DOI_IMPLEMENTATION.version, endpoint: { origin: CROSSREF_ORIGIN, path: CROSSREF_DOI_PATH, method: "GET" } } : null;
      bindings.push({
        id: `chrome:json_http:${toolId}:1`,
        tool_id: toolId,
        binding: contract.binding,
        implementation_kind: KIND_JSON_HTTP,
        implementation_id: CHROME_JSON_HTTP_IMPLEMENTATION.id,
        implementation_version: CHROME_JSON_HTTP_IMPLEMENTATION.version,
        display_name: `${toolId}: one HTTPS ${contract.method} to ${contract.endpoint_origin}${contract.endpoint_path}`,
        description:
          `This browser's generic JSON-over-HTTPS adapter, bound to exactly the origin, path, method and schemas the package declares for this tool. No other request shape, path or destination is reachable through it; no credential is attached.${fallback ? ` When the service is unavailable for a DOI, this browser looks that DOI up at ${CROSSREF_ORIGIN}/works/ instead (its built-in Crossref lookup, at the same pace as Crossref search) and says so in the answer.` : ""}`,
        remote: true,
        available: true,
        enabled: true,
        endpoint: { origin: contract.endpoint_origin, path: contract.endpoint_path, method: contract.method },
        contract: {
          input_schema_sha256: contract.input_schema_sha256,
          output_schema_sha256: contract.output_schema_sha256,
          permission_kinds: contract.permission_kinds,
          side_effects: contract.side_effects,
        },
        limits: { timeout_seconds: Math.min(Math.max(contract.timeout_seconds, 1), 120), max_request_bytes: 64 * 1024, max_response_bytes: 4 * 1024 * 1024, max_concurrent: 4 },
        credentials: { required: false, configured: false },
        ...(fallback ? { fallback } : {}),
      });
      continue;
    }
    if (contract.binding.startsWith(HOST_RESOURCE_BINDING_PREFIX)) {
      const type = types.get(toolId);
      if (!type || contract.binding !== `${HOST_RESOURCE_BINDING_PREFIX}${type.id}`) {
        notes.push({ code: "resource_type_unknown", detail: `${toolId}: this browser's vault holds no resource type of that name, so the tool stays unbound.` });
        continue;
      }
      bindings.push({
        id: `chrome:host-resource:${type.id}:1`,
        tool_id: type.id,
        binding: `${HOST_RESOURCE_BINDING_PREFIX}${type.id}`,
        implementation_kind: KIND_HOST_RESOURCE,
        implementation_id: CHROME_HOST_RESOURCE_IMPLEMENTATION.id,
        implementation_version: CHROME_HOST_RESOURCE_IMPLEMENTATION.version,
        display_name: `${type.display_name} (held in this browser's vault)`,
        description: `Returns the one ${type.display_name.toLowerCase()} the person granted for this run. It takes no arguments, so nothing a package sends can name another; it reaches no network and writes nothing.`,
        remote: false,
        available: true,
        enabled: true,
        contract: { input_schema_sha256: emptyInputSha256, output_schema_sha256: type.schema_sha256, permission_kinds: [type.permission_kind], side_effects: "read" },
        limits: { timeout_seconds: 5, max_request_bytes: 64, max_response_bytes: 32 * 1024, max_concurrent: 4 },
        credentials: { required: false, configured: false },
        resource_type: type.id,
      });
      continue;
    }
    const local = LOCAL_IMPLEMENTATIONS.find((item) => item.binding === contract.binding);
    if (local) {
      bindings.push(implementationBinding(toolId, contract, local, options));
      continue;
    }
    notes.push({ code: "local_tool_unimplemented", detail: `${toolId} (${contract.binding}): this version of the browser implements no local tool of that binding, so it stays unbound.` });
  }
  return normalizeRegistry({
    schema: REGISTRY_SCHEMA,
    host: { runtime: "chrome-agent-browser", runtime_version: options.runtimeVersion, source: CHROME_TOOL_REGISTRY_SOURCE, captured_at: now.toISOString(), agent_id: null },
    bindings,
    notes: notes.slice(0, MAX_NOTES),
  });
}
