/**
 * Host-owned resources, as the tool layer needs them (`host-resources.ts`, D-011): a
 * `ResourceResolver` is what a `host_resource` binding reads from and what the egress guard
 * consults; `MemoryResourceStore` implements it over the operator definitions document
 * (`openclaw-host-resources-v0`, the WebAir demo's format) for the CLI and the tests. T3's vault
 * is the extension's resolver; it implements the same interface so the broker never knows
 * where a value lives.
 *
 * A resource's digest is an HMAC-SHA256 under a key that lives only in this process: it changes
 * whenever the value or its type's schema changes, which makes a plan that named the old value
 * stale, and it cannot be reversed by guessing a short personal record. Digests are equality-
 * comparable references, nothing more. Nothing here knows what any type is for.
 */
import { canonicalJson, canonicalString } from "../canonical.js";
import { sha256HexSync, toHex } from "../hash.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import { deepCopy } from "../references.js";
import type { ResourceGrant } from "../types.js";
import { AdapterError } from "../workflow/errors.js";
import { type ToolImplementationDefinition } from "./definitions.js";
import { MAX_SEALED_FIELDS, MAX_VALUE_BYTES, MIN_SEALED_LENGTH } from "../vault.js";
import type { SealedValues } from "./egress.js";

export const HOST_RESOURCES_SCHEMA = "openclaw-host-resources-v0";
export const RESOURCE_REGISTRY_SCHEMA = "agentpkg-host-resource-registry-v0";
const DIGEST_SCHEMA = "openclaw-host-resource-digest-v0";
export const RESOURCE_PERMISSION_KINDS = ["personal.read", "memory.read"] as const;
export const HOST_RESOURCE_IMPLEMENTATION = "chrome.tool.host_resource";
export const HOST_RESOURCE_IMPLEMENTATION_VERSION = "0.1.0";
/** The one input schema every host-resource tool declares: an empty object. */
export const HOST_RESOURCE_INPUT_SCHEMA: JsonObject = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false,
}) as JsonObject;
export const MAX_RESOURCE_TYPES = 32;
export const MAX_RESOURCES = 256;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const POINTER = /^(\/[^/]*)+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** What the broker needs from whoever holds the person's resources. */
export interface ResourceResolver {
  /** The value of exactly the granted resource (id, type and digest all still holding), or a refusal. */
  resolve(grant: ResourceGrant): JsonObject;
  /** The sealed strings of every resource the host holds, by resource id, for the egress guard (the `Vault` shape). */
  sealedValues(): SealedValues;
  /** The resource's view without its value, or undefined. */
  describe(resourceId: string): HostResourceView | undefined;
}

export interface HostResourceTypeView {
  id: string;
  displayName: string;
  description: string | null;
  permissionKind: (typeof RESOURCE_PERMISSION_KINDS)[number];
  schemaSha256: string;
  sealedFields: string[];
}

export interface HostResourceView {
  id: string;
  type: string;
  label: string;
  digest: string;
}

interface StoredType extends HostResourceTypeView {
  schema: JsonObject;
}

interface StoredResource extends HostResourceView {
  value: JsonObject;
  sealed: string[];
}

function refuse(detail: string): AdapterError {
  return new AdapterError("host_resources_invalid", `Host resources rejected: ${detail}`);
}

function closed(value: unknown, field: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!isJsonObject(value as JsonValue)) throw refuse(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw refuse(`${field} has an unknown field ${key.slice(0, 64)}`);
  for (const key of required) if (!(key in record)) throw refuse(`${field} is missing ${key}`);
  return record;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL.test(value)) {
    throw refuse(`${field} must be a string of 1 to ${max} characters without control characters`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const id = text(value, field, 128);
  if (!IDENTIFIER.test(id)) throw refuse(`${field} is not a valid identifier`);
  return id;
}

function pointerValue(document: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = document;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isJsonObject(current as JsonValue) || !Object.hasOwn(current as JsonObject, key)) return undefined;
    current = (current as JsonObject)[key];
  }
  return current;
}

function plainJson(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value as JsonValue)) throw refuse(`${field} must be a JSON object`);
  let encoded: string;
  try {
    encoded = canonicalString(value);
  } catch {
    throw refuse(`${field} must be finite JSON`);
  }
  if (new TextEncoder().encode(encoded).length > MAX_VALUE_BYTES) throw refuse(`${field} exceeds ${MAX_VALUE_BYTES} bytes`);
  return JSON.parse(encoded) as JsonObject;
}

async function hmacHex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign({ name: "HMAC" }, imported, data as Uint8Array<ArrayBuffer>)));
}

export class MemoryResourceStore implements ResourceResolver {
  private readonly types = new Map<string, StoredType>();
  private readonly resources = new Map<string, StoredResource>();

  private constructor(private readonly source: string) {}

  get size(): number {
    return this.resources.size;
  }

  /**
   * Validate a whole definitions document and build a store. All or nothing. `key` is the
   * process-local HMAC key; a caller that passes none gets a random one.
   */
  static async load(definitions: unknown, options: { key?: Uint8Array; source?: string } = {}): Promise<MemoryResourceStore> {
    const store = new MemoryResourceStore(options.source ?? "chrome agent browser host resources");
    const key = options.key ?? crypto.getRandomValues(new Uint8Array(32));
    const record = closed(definitions, "host resources", ["schema", "types", "resources"], ["types", "resources"]);
    if (record.schema !== undefined && record.schema !== HOST_RESOURCES_SCHEMA) throw refuse(`host resources schema must be ${HOST_RESOURCES_SCHEMA}`);
    const typesRaw = record.types;
    if (!Array.isArray(typesRaw) || typesRaw.length > MAX_RESOURCE_TYPES) throw refuse(`types must be a list of at most ${MAX_RESOURCE_TYPES}`);
    const types = new Map<string, StoredType>();
    typesRaw.forEach((raw, index) => {
      const field = `types[${index}]`;
      const entry = closed(raw, field, ["id", "display_name", "description", "permission_kind", "schema", "sealed_fields"], ["id", "display_name", "permission_kind", "schema"]);
      const id = identifier(entry.id, `${field}.id`);
      if (types.has(id)) throw refuse(`${field}.id is duplicated`);
      const kind = text(entry.permission_kind, `${field}.permission_kind`, 64);
      if (!(RESOURCE_PERMISSION_KINDS as readonly string[]).includes(kind)) throw refuse(`${field}.permission_kind must be one of ${RESOURCE_PERMISSION_KINDS.join(", ")}`);
      const schema = plainJson(entry.schema, `${field}.schema`);
      const sealedRaw = (entry.sealed_fields as unknown[] | undefined) ?? [];
      if (!Array.isArray(sealedRaw) || sealedRaw.length > MAX_SEALED_FIELDS) throw refuse(`${field}.sealed_fields must be a list of at most ${MAX_SEALED_FIELDS} pointers`);
      const sealedFields = sealedRaw.map((pointer, at) => {
        const value = text(pointer, `${field}.sealed_fields[${at}]`, 256);
        if (!POINTER.test(value)) throw refuse(`${field}.sealed_fields[${at}] must be a JSON Pointer`);
        return value;
      });
      types.set(id, {
        id,
        displayName: text(entry.display_name, `${field}.display_name`, 128),
        description: entry.description === undefined || entry.description === null ? null : text(entry.description, `${field}.description`, 512),
        permissionKind: kind as StoredType["permissionKind"],
        schema,
        schemaSha256: sha256HexSync(canonicalJson(schema)),
        sealedFields,
      });
    });
    const resourcesRaw = record.resources;
    if (!Array.isArray(resourcesRaw) || resourcesRaw.length > MAX_RESOURCES) throw refuse(`resources must be a list of at most ${MAX_RESOURCES}`);
    const resources = new Map<string, StoredResource>();
    for (const [index, raw] of resourcesRaw.entries()) {
      const field = `resources[${index}]`;
      const entry = closed(raw, field, ["id", "type", "label", "value"], ["id", "type", "label", "value"]);
      const id = identifier(entry.id, `${field}.id`);
      if (resources.has(id)) throw refuse(`${field}.id is duplicated`);
      const type = types.get(identifier(entry.type, `${field}.type`));
      if (!type) throw refuse(`${field}.type names no declared type`);
      const label = text(entry.label, `${field}.label`, 200);
      const value = plainJson(entry.value, `${field}.value`);
      const sealed = type.sealedFields.map((pointer) => {
        const found = pointerValue(value, pointer);
        if (typeof found !== "string" || found.length < MIN_SEALED_LENGTH) {
          throw refuse(`${field}.value must hold a string of at least ${MIN_SEALED_LENGTH} characters at every sealed field of its type`);
        }
        return found;
      });
      // A label is what a person is shown when choosing; a sealed value inside one would undo the seal.
      const lowered = label.toLowerCase();
      if (sealed.some((item) => lowered.includes(item.toLowerCase()))) throw refuse(`${field}.label must not contain a sealed value of the resource`);
      const digest = await hmacHex(key, canonicalJson({ schema: DIGEST_SCHEMA, type: type.id, type_schema_sha256: type.schemaSha256, id, value }));
      resources.set(id, { id, type: type.id, label, value, sealed, digest });
    }
    for (const [id, type] of types) store.types.set(id, type);
    for (const [id, resource] of resources) store.resources.set(id, resource);
    return store;
  }

  typeViews(): HostResourceTypeView[] {
    return [...this.types.values()].map(({ schema: _schema, ...view }) => ({ ...view, sealedFields: [...view.sealedFields] }));
  }

  describe(resourceId: string): HostResourceView | undefined {
    const stored = this.resources.get(resourceId);
    return stored ? { id: stored.id, type: stored.type, label: stored.label, digest: stored.digest } : undefined;
  }

  /** What the control plane is told: everything a person chooses from, no value. */
  registry(host: { runtimeVersion?: string | null } = {}): JsonObject {
    return {
      schema: RESOURCE_REGISTRY_SCHEMA,
      host: { runtime: "chrome-agent-browser", runtime_version: host.runtimeVersion ?? null, source: this.source, captured_at: new Date().toISOString() },
      types: [...this.types.values()].map((type) => ({ id: type.id, display_name: type.displayName, description: type.description, permission_kind: type.permissionKind, schema_sha256: type.schemaSha256 })),
      resources: [...this.resources.values()].map((resource) => ({ id: resource.id, type: resource.type, label: resource.label, digest: resource.digest })),
      notes: [],
    };
  }

  /**
   * One tool implementation per type, in the shape every other binding has: the tool id is the
   * type id, the input schema is the pinned empty object and the output schema the type's.
   */
  bindings(): ToolImplementationDefinition[] {
    const input = sha256HexSync(canonicalJson(HOST_RESOURCE_INPUT_SCHEMA));
    return [...this.types.values()].map((type) => ({
      id: `chrome:host-resource:${type.id}:1`,
      toolId: type.id,
      binding: `host.resource.${type.id}`,
      kind: "host_resource" as const,
      implementationId: HOST_RESOURCE_IMPLEMENTATION,
      implementationVersion: HOST_RESOURCE_IMPLEMENTATION_VERSION,
      displayName: `${type.displayName} (held by this host)`,
      description: `Returns the one ${type.displayName.toLowerCase()} the person granted for this run. It takes no arguments, so nothing a package sends can name another; it reaches no network and writes nothing.`,
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

  resolve(grant: ResourceGrant): JsonObject {
    const stored = this.resources.get(grant.resource_id);
    if (!stored || stored.type !== grant.resource_type || stored.digest !== grant.resource_digest) {
      throw new AdapterError("tool_unavailable", "the granted host resource is no longer the one that was granted, so it is not returned");
    }
    return deepCopy(stored.value);
  }

  sealedValues(): SealedValues {
    return new Map([...this.resources.values()].filter((resource) => resource.sealed.length > 0).map((resource) => [resource.id, [...resource.sealed]]));
  }
}
