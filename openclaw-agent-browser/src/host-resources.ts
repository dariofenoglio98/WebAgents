/**
 * Host-owned resources: what this host holds for the person, and the only way
 * one of them reaches a run.
 *
 * ```text
 *   operator configuration             resource types (id, schema, sealed fields)
 *        │                             and resources (id, type, label, value)
 *        ▼  validated once, held in this process's memory
 *   HostResourceStore
 *        │  registry: ids, labels, keyed digests — never a value
 *        ├──────────────────────────▶ control plane: which permission requests
 *        │                            which type; the person picks one; the
 *        │                            receipt and the run plan freeze its id
 *        │                            and digest
 *        ▼
 *   the run's broker                   one `host_resource` binding per type:
 *                                      returns exactly the granted resource,
 *                                      re-checks its digest, takes no argument
 * ```
 *
 * ## What a package can say, and what it cannot
 *
 * A package can request a *type* — a permission whose scope names it, and a
 * local tool whose id is that type. It cannot name a resource. The tool takes
 * no arguments at all, so there is no string a package or a model could put in
 * a call to select another identity or another card; the broker returns the
 * one resource the person granted, for the permission the tool links, or
 * refuses.
 *
 * ## Sealed values
 *
 * A type marks the fields that identify a person or an instrument — an email
 * address, a payment instrument's identifier. The broker refuses any tool call
 * whose arguments carry a sealed value of a resource this run was not granted,
 * and a granted one bound for a tool that does not link its permission. That
 * is an exact-value check over values this host holds, not a general
 * data-loss filter: it stops a package from substituting a resource by
 * guessing its identifier, and from sending a granted one where the person was
 * not told it would go.
 *
 * ## Digests
 *
 * A resource's digest is an HMAC-SHA256 under a key that lives only in this
 * process. It changes whenever the value (or its type's schema) changes, which
 * is what makes a plan that named the old value stale; and unlike a bare
 * SHA-256 of a short personal record it cannot be reversed by guessing the
 * record. Digests are equality-comparable references, nothing more.
 *
 * Nothing here knows what any type is for. Types, schemas and values are
 * operator data; this module validates, hashes, projects and resolves them.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AgentBrowserError } from "./errors.js";
import type { ToolBindingDefinition } from "./tool-registry.js";

/** The operator-facing definitions document. */
export const HOST_RESOURCES_SCHEMA = "openclaw-host-resources-v0";
/** What the control plane receives: no values. */
export const RESOURCE_REGISTRY_SCHEMA = "agentpkg-host-resource-registry-v0";
const DIGEST_SCHEMA = "openclaw-host-resource-digest-v0";
/** Permission kinds a host resource type can be read under. */
export const RESOURCE_PERMISSION_KINDS = ["personal.read"] as const;
export const HOST_RESOURCE_IMPLEMENTATION = "openclaw.tool.host_resource";

/**
 * The one input schema every host-resource tool declares: an empty object.
 * Pinned here, so a package whose tool accepts anything else — a resource id,
 * a selector — is reported incompatible rather than bound.
 */
export const HOST_RESOURCE_INPUT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false,
});

export const MAX_RESOURCE_TYPES = 32;
export const MAX_RESOURCES = 256;
export const MAX_VALUE_BYTES = 16 * 1024;
export const MAX_DEFINITIONS_BYTES = 1024 * 1024;
export const MAX_SEALED_FIELDS = 16;
/** A sealed value shorter than this would match ordinary text by accident. */
export const MIN_SEALED_LENGTH = 6;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const POINTER = /^(\/[^/]*)+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** One grant, exactly as a receipt and a run plan freeze it. */
export type ResourceGrant = {
  permission_id: string;
  resource_type: string;
  resource_id: string;
  resource_digest: string;
};

export type HostResourceTypeView = {
  id: string;
  displayName: string;
  description: string | null;
  permissionKind: (typeof RESOURCE_PERMISSION_KINDS)[number];
  schemaSha256: string;
  sealedFields: string[];
};

/** What a caller may see about one resource. Never its value. */
export type HostResourceView = { id: string; type: string; label: string; digest: string };

type StoredType = HostResourceTypeView & { schema: Record<string, unknown> };
type StoredResource = HostResourceView & { value: Record<string, unknown>; sealed: string[] };

export type ResourceRegistry = {
  schema: typeof RESOURCE_REGISTRY_SCHEMA;
  host: { runtime: "openclaw"; runtime_version: string | null; source: string; captured_at: string };
  types: Array<{
    id: string;
    display_name: string;
    description: string | null;
    permission_kind: string;
    schema_sha256: string;
  }>;
  resources: Array<{ id: string; type: string; label: string; digest: string }>;
  notes: Array<{ code: string; detail: string | null }>;
};

function refuse(detail: string): never {
  throw new AgentBrowserError("invalid_request", "Host resources rejected", detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closed(value: unknown, field: string, allowed: readonly string[], required: readonly string[]) {
  if (!isRecord(value)) refuse(`${field} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse(`${field} has an unknown field ${key.slice(0, 64)}`);
  }
  for (const key of required) {
    if (!(key in value)) refuse(`${field} is missing ${key}`);
  }
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL.test(value)) {
    refuse(`${field} must be a string of 1 to ${max} characters without control characters`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const id = text(value, field, 128);
  if (!IDENTIFIER.test(id)) refuse(`${field} is not a valid identifier`);
  return id;
}

/**
 * Canonical JSON: sorted keys, no whitespace, ECMAScript number and string
 * serialization. For the JSON this module handles (no non-finite numbers) it
 * is the RFC 8785 serialization agentpkg hashes package schemas with, which is
 * what lets a binding's schema digest be compared with a package's.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) refuse("values must be finite JSON");
    if (value === undefined || typeof value === "function" || typeof value === "bigint") {
      refuse("values must be JSON");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** RFC 6901 lookup, refusing anything that is not a plain path into objects. */
function pointerValue(document: unknown, pointer: string): unknown {
  let current: unknown = document;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function plainJson(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) refuse(`${field} must be a JSON object`);
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch (error) {
    if (error instanceof AgentBrowserError) throw error;
    refuse(`${field} must be finite JSON`);
  }
  if (Buffer.byteLength(encoded) > MAX_VALUE_BYTES) refuse(`${field} exceeds ${MAX_VALUE_BYTES} bytes`);
  // A deep, prototype-free copy: nothing the operator object holds a
  // reference to can change a stored value afterwards.
  return JSON.parse(encoded) as Record<string, unknown>;
}

/** Every string in a JSON value, lower-cased, bounded. For the egress check. */
function strings(value: unknown, found: string[] = [], depth = 0): string[] {
  if (depth > 32 || found.length > 4096) return found;
  if (typeof value === "string") found.push(value.toLowerCase());
  else if (Array.isArray(value)) for (const item of value) strings(item, found, depth + 1);
  else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      found.push(key.toLowerCase());
      strings(item, found, depth + 1);
    }
  }
  return found;
}

export class HostResourceStore {
  private types = new Map<string, StoredType>();
  private resources = new Map<string, StoredResource>();
  private readonly key: Buffer;
  private readonly source: string;

  constructor(
    definitions?: unknown,
    options: { key?: Buffer; source?: string } = {},
  ) {
    // A key that exists only in this process: digests are comparable within
    // it, and say nothing to anyone who reads a receipt or an audit later.
    this.key = options.key ?? randomBytes(32);
    this.source = options.source ?? "openclaw plugin host resources";
    if (definitions !== undefined) this.load(definitions);
  }

  get size(): number {
    return this.resources.size;
  }

  /**
   * Validate a whole definitions document and replace what this store holds.
   *
   * All or nothing: a document with one bad entry changes nothing. Replacing
   * a resource's value changes its digest, so every plan that named the old
   * value becomes stale rather than quietly using the new one.
   */
  load(definitions: unknown): void {
    const document = closed(definitions, "host resources", ["schema", "types", "resources"], [
      "types",
      "resources",
    ]);
    if (document.schema !== undefined && document.schema !== HOST_RESOURCES_SCHEMA) {
      refuse(`host resources schema must be ${HOST_RESOURCES_SCHEMA}`);
    }
    const typesRaw = document.types;
    if (!Array.isArray(typesRaw) || typesRaw.length > MAX_RESOURCE_TYPES) {
      refuse(`types must be a list of at most ${MAX_RESOURCE_TYPES}`);
    }
    const types = new Map<string, StoredType>();
    typesRaw.forEach((raw, index) => {
      const field = `types[${index}]`;
      const entry = closed(
        raw,
        field,
        ["id", "display_name", "description", "permission_kind", "schema", "sealed_fields"],
        ["id", "display_name", "permission_kind", "schema"],
      );
      const id = identifier(entry.id, `${field}.id`);
      if (types.has(id)) refuse(`${field}.id is duplicated`);
      const kind = text(entry.permission_kind, `${field}.permission_kind`, 64);
      if (!(RESOURCE_PERMISSION_KINDS as readonly string[]).includes(kind)) {
        refuse(`${field}.permission_kind must be one of ${RESOURCE_PERMISSION_KINDS.join(", ")}`);
      }
      const schema = plainJson(entry.schema, `${field}.schema`);
      const sealedRaw = entry.sealed_fields ?? [];
      if (!Array.isArray(sealedRaw) || sealedRaw.length > MAX_SEALED_FIELDS) {
        refuse(`${field}.sealed_fields must be a list of at most ${MAX_SEALED_FIELDS} pointers`);
      }
      const sealedFields = sealedRaw.map((pointer, at) => {
        const value = text(pointer, `${field}.sealed_fields[${at}]`, 256);
        if (!POINTER.test(value)) refuse(`${field}.sealed_fields[${at}] must be a JSON Pointer`);
        return value;
      });
      types.set(id, {
        id,
        displayName: text(entry.display_name, `${field}.display_name`, 128),
        description:
          entry.description === undefined || entry.description === null
            ? null
            : text(entry.description, `${field}.description`, 512),
        permissionKind: kind as StoredType["permissionKind"],
        schema,
        schemaSha256: sha256Hex(canonicalJson(schema)),
        sealedFields,
      });
    });
    const resourcesRaw = document.resources;
    if (!Array.isArray(resourcesRaw) || resourcesRaw.length > MAX_RESOURCES) {
      refuse(`resources must be a list of at most ${MAX_RESOURCES}`);
    }
    const resources = new Map<string, StoredResource>();
    resourcesRaw.forEach((raw, index) => {
      const field = `resources[${index}]`;
      const entry = closed(raw, field, ["id", "type", "label", "value"], ["id", "type", "label", "value"]);
      const id = identifier(entry.id, `${field}.id`);
      if (resources.has(id)) refuse(`${field}.id is duplicated`);
      const type = types.get(identifier(entry.type, `${field}.type`));
      if (!type) refuse(`${field}.type names no declared type`);
      const label = text(entry.label, `${field}.label`, 200);
      const value = plainJson(entry.value, `${field}.value`);
      const sealed = type.sealedFields.map((pointer) => {
        const found = pointerValue(value, pointer);
        if (typeof found !== "string" || found.length < MIN_SEALED_LENGTH) {
          refuse(
            `${field}.value must hold a string of at least ${MIN_SEALED_LENGTH} characters at ` +
              `every sealed field of its type`,
          );
        }
        return found;
      });
      // A label is what a person is shown when choosing; it is display-safe
      // by construction, and a sealed value inside one would undo the seal.
      const lowered = label.toLowerCase();
      if (sealed.some((value) => lowered.includes(value.toLowerCase()))) {
        refuse(`${field}.label must not contain a sealed value of the resource`);
      }
      resources.set(id, {
        id,
        type: type.id,
        label,
        value,
        sealed,
        digest: createHmac("sha256", this.key)
          .update(
            canonicalJson({
              schema: DIGEST_SCHEMA,
              type: type.id,
              type_schema_sha256: type.schemaSha256,
              id,
              value,
            }),
          )
          .digest("hex"),
      });
    });
    this.types = types;
    this.resources = resources;
  }

  typeViews(): HostResourceTypeView[] {
    return [...this.types.values()].map(({ schema: _schema, ...view }) => ({
      ...view,
      sealedFields: [...view.sealedFields],
    }));
  }

  /** The resource with this id, without its value, or nothing. */
  describe(resourceId: string): HostResourceView | undefined {
    const stored = this.resources.get(resourceId);
    return stored ? { id: stored.id, type: stored.type, label: stored.label, digest: stored.digest } : undefined;
  }

  /** What the control plane is told: everything a person chooses from, no value. */
  registry(host: { runtimeVersion?: string | null } = {}): ResourceRegistry {
    return {
      schema: RESOURCE_REGISTRY_SCHEMA,
      host: {
        runtime: "openclaw",
        runtime_version: host.runtimeVersion ?? null,
        source: this.source,
        captured_at: new Date().toISOString(),
      },
      types: [...this.types.values()].map((type) => ({
        id: type.id,
        display_name: type.displayName,
        description: type.description,
        permission_kind: type.permissionKind,
        schema_sha256: type.schemaSha256,
      })),
      resources: [...this.resources.values()].map((resource) => ({
        id: resource.id,
        type: resource.type,
        label: resource.label,
        digest: resource.digest,
      })),
      notes: [],
    };
  }

  /**
   * One tool implementation per type, in the shape every other binding has.
   *
   * The tool id is the type id, so a package asks for "a host resource of this
   * type" by declaring a tool of that id; its input schema must be the pinned
   * empty object and its output schema exactly the type's schema, or the
   * binding is reported incompatible.
   */
  bindings(): ToolBindingDefinition[] {
    const input = sha256Hex(canonicalJson(HOST_RESOURCE_INPUT_SCHEMA));
    return [...this.types.values()].map((type) => ({
      id: `openclaw:host-resource:${type.id}:1`,
      toolId: type.id,
      binding: `host.resource.${type.id}`,
      kind: "host_resource" as const,
      implementationId: HOST_RESOURCE_IMPLEMENTATION,
      implementationVersion: "0.1.0",
      displayName: `${type.displayName} (held by this host)`,
      description:
        `Returns the one ${type.displayName.toLowerCase()} the person granted for this run. ` +
        "It takes no arguments, so nothing a package sends can name another; it reaches no " +
        "network and writes nothing.",
      inputSchemaSha256: input,
      outputSchemaSha256: type.schemaSha256,
      permissionKinds: [type.permissionKind],
      sideEffects: "read" as const,
      timeoutSeconds: 5,
      maxRequestBytes: 64,
      maxResponseBytes: MAX_VALUE_BYTES * 2,
      maxConcurrent: 4,
      resourceType: type.id,
    }));
  }

  /**
   * The value of exactly the granted resource, or a refusal.
   *
   * The grant names an id, a type and the digest the person's decision was
   * made against; all three must still hold. A removed resource, one of
   * another type, or one whose value changed since is refused rather than
   * substituted.
   */
  resolve(grant: ResourceGrant): Record<string, unknown> {
    const stored = this.resources.get(grant.resource_id);
    if (!stored || stored.type !== grant.resource_type || stored.digest !== grant.resource_digest) {
      throw new AgentBrowserError(
        "not_allowed",
        "Host resource unavailable",
        "the granted host resource no longer exists or is no longer the one that was granted",
      );
    }
    return JSON.parse(JSON.stringify(stored.value)) as Record<string, unknown>;
  }

  /**
   * Which sealed value, if any, a tool call's arguments may not carry.
   *
   * `grants` are this run's; `linked` are the permissions the called tool
   * declares. Returns a refusal reason, or null when the arguments carry no
   * sealed value they should not.
   */
  egressRefusal(args: unknown, grants: readonly ResourceGrant[], linked: readonly string[]): string | null {
    if (this.resources.size === 0) return null;
    const carried = strings(args);
    if (carried.length === 0) return null;
    for (const resource of this.resources.values()) {
      for (const value of resource.sealed) {
        const needle = value.toLowerCase();
        if (!carried.some((item) => item.includes(needle))) continue;
        const grant = grants.find((item) => item.resource_id === resource.id);
        if (!grant) {
          return "the arguments carry a value of a host resource this run was not granted";
        }
        if (!linked.includes(grant.permission_id)) {
          return (
            "the arguments carry a granted host value to a tool that does not link the " +
            "permission it was granted under"
          );
        }
      }
    }
    return null;
  }
}

/**
 * Read an operator's definitions file: an absolute path to a regular file, not
 * a link, bounded, parsed as JSON. Its contents are validated by the store.
 */
export async function readHostResourceFile(path: string): Promise<unknown> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\u0000")) {
    refuse("hostResources.file must be an absolute path");
  }
  let info;
  try {
    info = await lstat(path);
  } catch {
    refuse("hostResources.file does not exist");
  }
  if (info.isSymbolicLink() || !info.isFile()) refuse("hostResources.file must be a regular file");
  if (info.size > MAX_DEFINITIONS_BYTES) refuse(`hostResources.file exceeds ${MAX_DEFINITIONS_BYTES} bytes`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    refuse("hostResources.file is not valid JSON");
  }
}
