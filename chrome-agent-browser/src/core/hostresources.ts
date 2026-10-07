/**
 * Host-owned resources and the grants that let one run use one of them, mirroring
 * `agentpkg/browser/hostresources.py` rule for rule.
 *
 * Three objects meet here, and the vocabulary keeps them apart exactly as for tools:
 *
 *     permission resource scope   what the package asks for       (signed, in the pkg)
 *     host resource registry      what this host holds            (host-owned, no values)
 *     resource grant              which one the person chose      (receipt, then run plan)
 *
 * A permission whose kind is a resource kind (`personal.read`) names, in its `resources`
 * scope, the *type* of host resource it requests. Nothing in a package can name a concrete
 * resource: the registry is the host's statement of which resources exist (opaque id, type,
 * display-safe label, keyed digest, never a value), and the person picks one when they grant
 * the permission. The pick is frozen into the receipt by id and digest, the plan copies it,
 * and every later step compares against it. Nothing here resolves a resource; the vault
 * (`vault.ts`) is the Chrome host's store behind the registry.
 */
import { canonicalJson } from "./canonical.js";
import { CoreError } from "./errors.js";
import { closedRecord, hex64, identifier, invalid, isRecord, requiredText, text } from "./fields.js";
import { sha256Hex } from "./hash.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { Package } from "./package.js";
import { pyRepr } from "./repr.js";
import { DENY, type Decision, type Reason, type RegistryRef, type ResourceGrant } from "./types.js";

export const REGISTRY_SCHEMA = "agentpkg-host-resource-registry-v0";
export const REQUESTS_SCHEMA = "agentpkg-host-resource-requests-v0";
/** Permission kinds whose `resources` scope may name a host resource type. */
export const RESOURCE_PERMISSION_KINDS: readonly string[] = Object.freeze(["personal.read"]);

export const MAX_TYPES = 32;
export const MAX_RESOURCES = 256;
export const MAX_LABEL = 200;
export const MAX_NOTES = 16;

export const OFFERED = "offered";
export const EMPTY = "empty";
export const AMBIGUOUS = "ambiguous";
export const KIND_MISMATCH = "kind_mismatch";
export type RequestStatus = typeof OFFERED | typeof EMPTY | typeof AMBIGUOUS | typeof KIND_MISMATCH;

export interface RegistryHost {
  runtime: string;
  runtime_version: string | null;
  source: string;
  captured_at: string;
}

export interface RegistryType {
  id: string;
  display_name: string;
  description: string | null;
  permission_kind: string;
  schema_sha256: string;
}

export interface RegistryResource {
  id: string;
  type: string;
  label: string;
  digest: string;
}

export interface RegistryNote {
  code: string;
  detail: string | null;
}

export interface ResourceRegistry {
  schema: typeof REGISTRY_SCHEMA;
  host: RegistryHost;
  types: RegistryType[];
  resources: RegistryResource[];
  notes: RegistryNote[];
  registry_sha256: string;
  type_count: number;
  resource_count: number;
}

export interface ResourceRequest {
  permission_id: string;
  kind: string;
  required: boolean;
  resource_type: string | null;
  resource_types: string[];
  type_display_name: string | null;
  type_description: string | null;
  status: RequestStatus;
  options: Array<{ resource_id: string; label: string }>;
  linked_tools: string[];
  decision?: Decision;
  selected_resource_id?: string | null;
}

export interface ResourceEvaluation {
  schema: typeof REQUESTS_SCHEMA;
  package_id: string;
  package_version: string;
  package_digest: string;
  registry: RegistryRef | null;
  requests: ResourceRequest[];
  resource_permission_kinds: string[];
  note: string;
}

const str = (value: JsonValue | undefined): string => String(value);
const permissionsOf = (pkg: Package): JsonObject[] => pkg.policy.permissions as JsonObject[];

// -- host registry -------------------------------------------------------------
/** `normalize_resource_registry`: validate a registry and bind it to a content hash. */
export async function normalizeResourceRegistry(raw: unknown): Promise<ResourceRegistry> {
  const record = closedRecord(raw, "resource_registry", ["schema", "host", "types", "resources", "notes"], ["host", "types", "resources"]);
  const schema = record.schema ?? REGISTRY_SCHEMA;
  if (schema !== REGISTRY_SCHEMA) throw invalid(`resource_registry.schema must be ${pyRepr(REGISTRY_SCHEMA)}, got ${pyRepr(schema)}`);
  const host = closedRecord(record.host, "resource_registry.host", ["runtime", "runtime_version", "source", "captured_at"], ["runtime", "source", "captured_at"]);
  const typesRaw = record.types;
  if (!Array.isArray(typesRaw) || typesRaw.length > MAX_TYPES) throw invalid(`resource_registry.types must be a list of at most ${MAX_TYPES}`);
  const types: RegistryType[] = typesRaw.map((item, index) => {
    const field = `resource_registry.types[${index}]`;
    const entry = closedRecord(item, field, ["id", "display_name", "description", "permission_kind", "schema_sha256"], ["id", "display_name", "permission_kind", "schema_sha256"]);
    const kind = requiredText(entry.permission_kind, `${field}.permission_kind`, { limit: 64, nonEmpty: true });
    if (!RESOURCE_PERMISSION_KINDS.includes(kind)) throw invalid(`${field}.permission_kind must be one of ${pyRepr([...RESOURCE_PERMISSION_KINDS])}`);
    return {
      id: identifier(entry.id, `${field}.id`),
      display_name: requiredText(entry.display_name, `${field}.display_name`, { limit: 128, nonEmpty: true }),
      description: text(entry.description, `${field}.description`, { allowNull: true, nonEmpty: true }),
      permission_kind: kind,
      schema_sha256: hex64(entry.schema_sha256, `${field}.schema_sha256`)!,
    };
  });
  const typeIds = types.map((entry) => entry.id);
  if (new Set(typeIds).size !== typeIds.length) throw invalid("resource_registry.types has duplicate ids");
  const resourcesRaw = record.resources;
  if (!Array.isArray(resourcesRaw) || resourcesRaw.length > MAX_RESOURCES) throw invalid(`resource_registry.resources must be a list of at most ${MAX_RESOURCES}`);
  const resources: RegistryResource[] = resourcesRaw.map((item, index) => {
    const field = `resource_registry.resources[${index}]`;
    const entry = closedRecord(item, field, ["id", "type", "label", "digest"], ["id", "type", "label", "digest"]);
    const type = identifier(entry.type, `${field}.type`);
    if (!typeIds.includes(type)) throw invalid(`${field}.type names no declared type`);
    return {
      id: identifier(entry.id, `${field}.id`),
      type,
      label: requiredText(entry.label, `${field}.label`, { limit: MAX_LABEL, nonEmpty: true }),
      digest: hex64(entry.digest, `${field}.digest`)!,
    };
  });
  const resourceIds = resources.map((entry) => entry.id);
  if (new Set(resourceIds).size !== resourceIds.length) throw invalid("resource_registry.resources has duplicate ids");
  const notesRaw = record.notes ?? [];
  if (!Array.isArray(notesRaw) || notesRaw.length > MAX_NOTES) throw invalid(`resource_registry.notes must be a list of at most ${MAX_NOTES}`);
  const notes: RegistryNote[] = notesRaw.map((note) => {
    const entry = closedRecord(note, "resource_registry.notes[]", ["code", "detail"], ["code"]);
    return {
      code: requiredText(entry.code, "resource_registry.notes[].code", { limit: 128, nonEmpty: true }),
      detail: text(entry.detail, "resource_registry.notes[].detail", { allowNull: true, nonEmpty: true }),
    };
  });
  const registry = {
    schema: REGISTRY_SCHEMA as typeof REGISTRY_SCHEMA,
    host: {
      runtime: requiredText(host.runtime, "resource_registry.host.runtime", { limit: 64, nonEmpty: true }),
      runtime_version: text(host.runtime_version, "resource_registry.host.runtime_version", { limit: 64, allowNull: true, nonEmpty: true }),
      source: requiredText(host.source, "resource_registry.host.source", { nonEmpty: true }),
      captured_at: requiredText(host.captured_at, "resource_registry.host.captured_at", { limit: 64, nonEmpty: true }),
    },
    types,
    resources,
    notes,
  };
  return {
    ...registry,
    registry_sha256: await sha256Hex(canonicalJson(registry)),
    type_count: types.length,
    resource_count: resources.length,
  };
}

/** The registry of a host that holds no personal resource at all. */
export function emptyResourceRegistry(options: { runtime?: string; source?: string; now?: Date } = {}): Promise<ResourceRegistry> {
  return normalizeResourceRegistry({
    schema: REGISTRY_SCHEMA,
    host: { runtime: options.runtime ?? "none", source: options.source ?? "no host resource registry supplied", captured_at: (options.now ?? new Date()).toISOString() },
    types: [],
    resources: [],
  });
}

/** `registry_reference`: the small record a receipt or plan keeps about the registry it used. */
export function resourceRegistryReference(registry: ResourceRegistry | null): RegistryRef | null {
  if (registry === null) return null;
  return { registry_sha256: registry.registry_sha256, type_count: registry.type_count, resource_count: registry.resource_count };
}

// -- package requests ----------------------------------------------------------
function linkedTools(pkg: Package, permissionId: string): string[] {
  return Object.values(pkg.tools)
    .filter((tool) => (tool.permissions as JsonValue[]).includes(permissionId))
    .map((tool) => str(tool.id))
    .sort();
}

/**
 * `resource_requests`: which declared permissions request a host resource this host offers.
 * Exactly one scope must name an offered type (`ambiguous` otherwise), the permission's kind
 * must be the kind the host reads that type under (`kind_mismatch`), and the host must hold
 * at least one resource of the type (`empty`).
 */
export function resourceRequests(pkg: Package, registry: ResourceRegistry | null): ResourceRequest[] {
  if (registry === null) return [];
  const types = new Map(registry.types.map((entry) => [entry.id, entry]));
  const requests: ResourceRequest[] = [];
  for (const permission of permissionsOf(pkg)) {
    const scopes = (permission.resources as JsonValue[]).map(str).filter((scope) => types.has(scope));
    if (scopes.length === 0) continue;
    let status: RequestStatus = OFFERED;
    const resourceType = scopes.length === 1 ? scopes[0]! : null;
    let options: Array<{ resource_id: string; label: string }> = [];
    if (resourceType === null) status = AMBIGUOUS;
    else if (permission.kind !== types.get(resourceType)!.permission_kind) status = KIND_MISMATCH;
    else {
      options = registry.resources.filter((entry) => entry.type === resourceType).map((entry) => ({ resource_id: entry.id, label: entry.label }));
      if (options.length === 0) status = EMPTY;
    }
    const typeRecord = resourceType ? types.get(resourceType) ?? null : null;
    requests.push({
      permission_id: str(permission.id),
      kind: str(permission.kind),
      required: permission.required === true,
      resource_type: resourceType,
      resource_types: scopes,
      type_display_name: typeRecord ? typeRecord.display_name : null,
      type_description: typeRecord ? typeRecord.description : null,
      status,
      options,
      linked_tools: linkedTools(pkg, str(permission.id)),
    });
  }
  return requests;
}

/** `evaluate_resources`: the resource half of an authorization request, for a UI to render. */
export function evaluateResources(
  pkg: Package,
  registry: ResourceRegistry | null,
  options: { decisions: Record<string, Decision>; grants: readonly ResourceGrant[] },
): ResourceEvaluation {
  const selected = new Map(options.grants.map((grant) => [grant.permission_id, grant.resource_id]));
  const requests = resourceRequests(pkg, registry);
  for (const request of requests) {
    request.decision = options.decisions[request.permission_id] ?? DENY;
    request.selected_resource_id = selected.get(request.permission_id) ?? null;
  }
  return {
    schema: REQUESTS_SCHEMA,
    package_id: str(pkg.manifest.package_id),
    package_version: str(pkg.manifest.version),
    package_digest: pkg.digest,
    registry: resourceRegistryReference(registry),
    requests,
    resource_permission_kinds: [...RESOURCE_PERMISSION_KINDS],
    note: "A package can request a type of host resource; it can never name one. The host lists what it holds, and the person picks one when granting the permission. The values never leave the host: this evaluation carries ids, labels and digests.",
  };
}

/**
 * `normalize_resource_selections`: turn the person's picks into frozen grants, strictly, or
 * refuse. A grant exists only for a permission that requests an offered type, is not denied,
 * and names a resource of exactly that type in this registry. A granted resource-bearing
 * permission without a pick is refused rather than defaulted: silence never selects someone's
 * identity or card.
 */
export function normalizeResourceSelections(
  pkg: Package,
  registry: ResourceRegistry | null,
  decisions: Record<string, Decision>,
  submitted: unknown,
): ResourceGrant[] {
  const picks = submitted === null || submitted === undefined ? {} : submitted;
  if (!isRecord(picks)) throw invalid("resource_selections must be an object of permission id to resource id");
  if (Object.keys(picks).length > 0 && registry === null) {
    throw new CoreError("resource_registry_missing", "A resource can be selected only against a host resource registry supplied with the same request.");
  }
  const declared = new Set(permissionsOf(pkg).map((permission) => str(permission.id)));
  const requests = new Map(resourceRequests(pkg, registry).map((item) => [item.permission_id, item]));
  const resources = new Map((registry?.resources ?? []).map((entry) => [entry.id, entry]));
  const grants: ResourceGrant[] = [];
  for (const [permissionId, resourceId] of Object.entries(picks)) {
    if (!declared.has(permissionId)) throw new CoreError("unknown_permission", `${pyRepr(permissionId)} is not declared by this package`);
    const request = requests.get(permissionId);
    if (!request || request.status !== OFFERED) {
      throw new CoreError("resource_not_requested", `Permission ${pyRepr(permissionId)} does not request a host resource this host offers, so nothing can be selected for it.`, {
        details: { status: request ? request.status : null },
      });
    }
    if ((decisions[permissionId] ?? DENY) === DENY) {
      throw new CoreError("resource_selection_denied", `Permission ${pyRepr(permissionId)} is denied; a denied permission carries no resource.`);
    }
    if (typeof resourceId !== "string") throw invalid("resource ids must be strings");
    const resource = resources.get(resourceId);
    if (!resource || resource.type !== request.resource_type) {
      // One answer for an unknown id and for a resource of another type: the person can only
      // choose among the options listed for this permission.
      throw new CoreError("resource_unknown", `That is not one of the ${request.type_display_name ?? "resources"} this host offers for ${pyRepr(permissionId)}.`);
    }
    grants.push({ permission_id: permissionId, resource_type: resource.type, resource_id: resource.id, resource_digest: resource.digest });
  }
  for (const [permissionId, request] of requests) {
    if (request.status === OFFERED && (decisions[permissionId] ?? DENY) !== DENY && !Object.hasOwn(picks, permissionId)) {
      throw new CoreError(
        "resource_selection_required",
        `Permission ${pyRepr(permissionId)} grants access to a ${request.type_display_name ?? "host resource"}; choose which one, or deny the permission.`,
        { details: { permission_id: permissionId } },
      );
    }
  }
  return grants.sort((a, b) => (a.permission_id < b.permission_id ? -1 : a.permission_id > b.permission_id ? 1 : 0));
}

// -- staleness and readiness ---------------------------------------------------
const reason = (code: string, message: string, subject: string | null = null): Reason => ({ code, message, subject });

/**
 * `grant_staleness`: whether every frozen grant still names exactly the resource that was
 * chosen. Conservative on purpose: a resource whose digest moved is a different resource,
 * even under the same id, so a decision about the old one does not quietly transfer.
 */
export function grantStaleness(grants: readonly ResourceGrant[], registry: ResourceRegistry | null): Reason[] {
  if (grants.length === 0) return [];
  if (registry === null) {
    return [reason("resource_registry_unknown", "This authorization selected host resources, and no current host resource registry has been supplied to compare them against.")];
  }
  const current = new Map(registry.resources.map((entry) => [entry.id, entry]));
  const reasons: Reason[] = [];
  for (const grant of grants) {
    const subject = grant.permission_id;
    const entry = current.get(grant.resource_id);
    if (!entry) reasons.push(reason("resource_removed", `The host resource selected for ${subject} no longer exists on this host.`, subject));
    else if (entry.type !== grant.resource_type) reasons.push(reason("resource_type_changed", `The host resource selected for ${subject} is now a different type.`, subject));
    else if (entry.digest !== grant.resource_digest) {
      reasons.push(reason("resource_changed", `The host resource selected for ${subject} changed after it was chosen, so it is no longer the one that was granted.`, subject));
    }
  }
  return reasons;
}

/** The slice of a tool evaluation `resource_tool_blockers` reads. */
export interface ResourceToolView {
  tool_id: string;
  permission_ids: string[];
  binding: { implementation_kind?: string; resource_type?: string } | null;
}

/**
 * `resource_tool_blockers`: every host-resource tool that could run without a resource to
 * return. A tool bound to a host resource type is usable only when a granted permission it
 * links to carries a grant of exactly that type.
 */
export function resourceToolBlockers(
  tools: readonly ResourceToolView[] | null,
  receipt: { decisions: Record<string, Decision>; resource_grants?: readonly ResourceGrant[]; tool_approvals?: Record<string, boolean> },
  options: { approvedOnly?: boolean } = {},
): Reason[] {
  if (tools === null) return [];
  const grants = receipt.resource_grants ?? [];
  const reasons: Reason[] = [];
  for (const tool of tools) {
    const binding = tool.binding ?? {};
    const resourceType = binding.resource_type;
    if (binding.implementation_kind !== "host_resource" || !resourceType) continue;
    // Chrome (D-022): a tool the person did not approve is denied and never runs, so it needs no grant.
    if (options.approvedOnly && receipt.tool_approvals?.[tool.tool_id] !== true) continue;
    const linked = new Set(tool.permission_ids);
    const granted = [...linked].sort().filter((pid) => (receipt.decisions[pid] ?? DENY) !== DENY);
    if (granted.length === 0) continue;
    if (!grants.some((grant) => linked.has(grant.permission_id) && grant.resource_type === resourceType)) {
      reasons.push(
        reason(
          "resource_not_selected",
          `Tool ${tool.tool_id} returns a host resource of type ${resourceType}, and permission ${pyRepr(granted[0]!)} is granted without one being selected.`,
          tool.tool_id,
        ),
      );
    }
  }
  return reasons;
}

/** `grants_report`: what a preflight says about frozen grants, without restating them. */
export function grantsReport(grants: readonly ResourceGrant[], registry: ResourceRegistry | null): { granted: number; current: boolean; evaluated: boolean; registry_sha256: string | null } {
  const reasons = grantStaleness(grants, registry);
  return { granted: grants.length, current: reasons.length === 0, evaluated: registry !== null, registry_sha256: registry ? registry.registry_sha256 : null };
}
