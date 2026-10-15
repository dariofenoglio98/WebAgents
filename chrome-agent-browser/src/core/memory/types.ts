/**
 * Types (§4): the starter taxonomy (M-65), legacy aliases under `personal.read` (M-17), the
 * person's own types, packages' custom types with the name rule and the closed-schema rule
 * (M-18, M-19), the record view schema a `memory.read` tool returns (M-16) and the legacy
 * projection. Pure data and pure functions; the registry is a value the store holds.
 */
import { canonicalJson } from "../canonical.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import { MEMORY_CONTRACTS } from "../schemas/memory/index.js";
import { AGENT_TYPE, MAX_CUSTOM_TYPES_PER_PACKAGE, type MemoryLink, NOTE_TYPE, POINTER, RELATIONS, RESERVED_FAMILIES, RESERVED_KEYS, SELF_TYPE, WELL_KNOWN_TYPE_ID } from "./model.js";

export interface LegacyAlias {
  id: string;
  schema: JsonObject;
  /** Legacy pointer → record pointer. */
  projection: Record<string, string>;
}

export interface MemoryType {
  id: string;
  display_name: string;
  description: string | null;
  schema: JsonObject;
  sealed_fields: string[];
  identity: string[];
  default_links: MemoryLink[];
  display: { title_from: string | null; summary: string[] };
  declared_by: { kind: "spec" | "person" | "package"; package_id?: string };
  legacy?: LegacyAlias[];
}

/** A type with its derived facts: the schema digest (M-14) and the view's (M-16). */
export interface MemoryTypeView extends MemoryType {
  schema_sha256: string;
  view_sha256: string;
}

export class MemoryTypeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MemoryTypeError";
  }
}

export function schemaSha256(schema: JsonValue): string {
  return sha256HexSync(canonicalJson(schema));
}

/** M-16: the record view schema of a type, built from the template and nothing else. */
export function recordViewSchema(type: Pick<MemoryType, "id" | "schema">): JsonObject {
  const template = JSON.parse(JSON.stringify(MEMORY_CONTRACTS["memory-record-view.template"])) as JsonObject;
  const fields = JSON.parse(JSON.stringify(type.schema)) as JsonObject;
  delete fields.$schema;
  const properties = template.properties as JsonObject;
  properties.type = { const: type.id };
  properties.fields = fields;
  return template;
}

export function typeView(type: MemoryType): MemoryTypeView {
  return { ...type, schema_sha256: schemaSha256(type.schema), view_sha256: schemaSha256(recordViewSchema(type)) };
}

/** The starter taxonomy (M-65), as shipped in `spec/memory-v0/taxonomy.json`. */
export function starterTypes(): MemoryType[] {
  const taxonomy = MEMORY_CONTRACTS.taxonomy as { types: MemoryType[] };
  return JSON.parse(JSON.stringify(taxonomy.types)) as MemoryType[];
}

/** The sealed field names of the starter types, computed from the taxonomy, never written down (M-19). */
export function sealedStarterNames(types: readonly MemoryType[] = starterTypes()): Set<string> {
  const names = new Set<string>();
  for (const type of types) if (type.declared_by.kind === "spec") for (const pointer of type.sealed_fields) names.add(pointer.split("/")[1]!);
  return names;
}

/** Every property name a closed schema can hold, at any depth (nested objects and array items). */
export function propertyNames(schema: JsonValue, found = new Set<string>()): Set<string> {
  if (typeof schema !== "object" || schema === null) return found;
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, found);
    return found;
  }
  const properties = schema.properties;
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      found.add(name);
      propertyNames(child, found);
    }
  }
  if (schema.items !== undefined) propertyNames(schema.items, found);
  return found;
}

const COMBINATORS = ["allOf", "anyOf", "oneOf", "not", "if", "then", "else", "patternProperties", "propertyNames", "dependentSchemas", "unevaluatedProperties", "unevaluatedItems", "prefixItems", "contains"];
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const isScalar = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);

/** M-19: why a custom type's schema is not closed, or null when it is (N21). */
export function openSchemaReason(schema: JsonValue, path = ""): string | null {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return `${path || "/"}: not an object schema`;
  for (const keyword of COMBINATORS) if (Object.hasOwn(schema, keyword)) return `${path || "/"}: ${keyword}`;
  if (Object.hasOwn(schema, "const")) return isScalar(schema.const) ? null : `${path || "/"}: const holds an object or an array`;
  if (Object.hasOwn(schema, "enum")) return Array.isArray(schema.enum) && schema.enum.every(isScalar) ? null : `${path || "/"}: enum holds an object or an array`;
  const type = schema.type;
  if (typeof type !== "string") return `${path || "/"}: untyped`;
  if (type === "object") {
    const properties = schema.properties;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return `${path || "/"}: an object without properties`;
    if (schema.additionalProperties !== false) return `${path || "/"}: additionalProperties is not false`;
    for (const [name, child] of Object.entries(properties)) {
      const reason = openSchemaReason(child, `${path}/${name}`);
      if (reason !== null) return reason;
    }
    return null;
  }
  if (type === "array") {
    if (schema.items === undefined) return `${path || "/"}: an array without items`;
    return openSchemaReason(schema.items, `${path}/items`);
  }
  return SCALAR_TYPES.has(type) ? null : `${path || "/"}: type ${type}`;
}

export interface CustomTypeDeclaration {
  id: string;
  display_name: string;
  description: string;
  schema: string;
  identity?: string[];
}

/**
 * §4.4: a package's custom type, checked and qualified, or a `MemoryTypeError` with the spec's
 * code: `reserved_field_name`, `custom_type_reserved`, `custom_type_shadows_sealed_type` (before
 * the schema rule), `custom_type_schema_open`.
 */
export function customType(packageId: string, declaration: CustomTypeDeclaration, schema: JsonObject, wellKnown: readonly MemoryType[] = starterTypes()): MemoryType {
  const local = declaration.id;
  if (!WELL_KNOWN_TYPE_ID.test(local)) throw new MemoryTypeError("custom_type_reserved", `custom type id ${JSON.stringify(local)} is not in the well-known form`);
  const knownIds = new Set(wellKnown.flatMap((type) => [type.id, ...(type.legacy ?? []).map((alias) => alias.id)]));
  if (knownIds.has(local) || RESERVED_FAMILIES.some((family) => local.startsWith(family))) throw new MemoryTypeError("custom_type_reserved", `custom type id ${JSON.stringify(local)} is a well-known id or in a reserved family`);
  const properties = typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties) ? schema.properties : null;
  if (schema.type !== "object" || properties === null) throw new MemoryTypeError("custom_type_schema_open", `custom type ${local}: the schema must be an object schema with properties`);
  for (const name of Object.keys(properties)) {
    if (RESERVED_KEYS.has(name)) throw new MemoryTypeError("reserved_field_name", `custom type ${local}: ${name} is a reserved key`);
  }
  const sealedNames = sealedStarterNames(wellKnown);
  for (const name of propertyNames(schema)) {
    if (sealedNames.has(name)) throw new MemoryTypeError("custom_type_shadows_sealed_type", `custom type ${local}: a property named ${name} is a sealed field of a starter type; read that type by grant instead`);
  }
  const open = openSchemaReason(schema);
  if (open !== null) throw new MemoryTypeError("custom_type_schema_open", `custom type ${local}: the schema is not closed (${open})`);
  const identity = declaration.identity ?? [];
  for (const pointer of identity) if (!POINTER.test(pointer)) throw new MemoryTypeError("custom_type_schema_open", `custom type ${local}: identity pointer ${pointer} is not a JSON Pointer`);
  return {
    id: `${packageId}:${local}`,
    display_name: declaration.display_name,
    description: declaration.description,
    schema: JSON.parse(JSON.stringify(schema)) as JsonObject,
    sealed_fields: [],
    identity: [...identity],
    default_links: [],
    display: { title_from: null, summary: Object.keys(properties).slice(0, 4).map((name) => `/${name}`) },
    declared_by: { kind: "package", package_id: packageId },
  };
}

/** The custom types a policy declares (`memory_types`, M-18), read from the package's own files. */
export function customTypesOf(packageId: string, policy: JsonObject, files: ReadonlyMap<string, Uint8Array>, wellKnown: readonly MemoryType[] = starterTypes()): MemoryType[] {
  const declared = Array.isArray(policy.memory_types) ? (policy.memory_types as unknown as CustomTypeDeclaration[]) : [];
  if (declared.length > MAX_CUSTOM_TYPES_PER_PACKAGE) throw new MemoryTypeError("custom_type_reserved", `a package declares at most ${MAX_CUSTOM_TYPES_PER_PACKAGE} custom types`);
  const out: MemoryType[] = [];
  for (const declaration of declared) {
    const bytes = files.get(declaration.schema);
    if (bytes === undefined) throw new MemoryTypeError("custom_type_schema_open", `custom type ${declaration.id}: schema file ${declaration.schema} is not in the package`);
    const schema = JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;
    out.push(customType(packageId, declaration, schema, wellKnown));
  }
  return out;
}

/**
 * The type registry: the well-known types, the person's and the approved package types by id,
 * with the legacy aliases resolved (M-17). Every type carries its digests.
 */
export class TypeRegistry {
  private readonly types = new Map<string, MemoryTypeView>();
  private readonly legacy = new Map<string, { type: MemoryTypeView; alias: LegacyAlias }>();

  constructor(types: Iterable<MemoryType> = starterTypes()) {
    for (const type of types) this.put(type);
  }

  put(type: MemoryType): MemoryTypeView {
    const view = typeView(type);
    this.types.set(type.id, view);
    for (const alias of type.legacy ?? []) this.legacy.set(alias.id, { type: view, alias });
    return view;
  }

  delete(id: string): boolean {
    const type = this.types.get(id);
    if (!type) return false;
    for (const alias of type.legacy ?? []) this.legacy.delete(alias.id);
    return this.types.delete(id);
  }

  has(id: string): boolean {
    return this.types.has(id);
  }

  get(id: string): MemoryTypeView | undefined {
    return this.types.get(id);
  }

  /** The type a legacy id names (M-17), with its alias. */
  legacyOf(id: string): { type: MemoryTypeView; alias: LegacyAlias } | undefined {
    return this.legacy.get(id);
  }

  /** The type a `resources` entry names: a type id, or a legacy id through its alias. */
  resolve(resourceType: string): MemoryTypeView | undefined {
    return this.types.get(resourceType) ?? this.legacy.get(resourceType)?.type;
  }

  all(): MemoryTypeView[] {
    return [...this.types.values()];
  }

  get size(): number {
    return this.types.size;
  }

  /** The agent document's type (reserved, §7.4). */
  agent(): MemoryTypeView {
    return this.types.get(AGENT_TYPE)!;
  }

  self(): MemoryTypeView {
    return this.types.get(SELF_TYPE)!;
  }

  note(): MemoryTypeView {
    return this.types.get(NOTE_TYPE)!;
  }

  /** Types in the order the Memory page assigns colours: the taxonomy's twelve, then the rest by id (D-218). */
  ordered(): MemoryTypeView[] {
    const starter = starterTypes().map((type) => type.id);
    return [...this.types.values()].sort((a, b) => {
      const left = starter.indexOf(a.id);
      const right = starter.indexOf(b.id);
      if (left >= 0 && right >= 0) return left - right;
      if (left >= 0) return -1;
      if (right >= 0) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  toJSON(): MemoryType[] {
    return this.all().map(({ schema_sha256: _schema, view_sha256: _view, ...type }) => type);
  }
}

/** The legacy projection of a record's fields (M-17): legacy pointer → record pointer. */
export function projectLegacy(fields: JsonObject, alias: LegacyAlias): JsonObject {
  const out: JsonObject = {};
  for (const [legacyPointer, recordPointer] of Object.entries(alias.projection)) {
    const value = pointerGetLocal(fields, recordPointer);
    if (value !== undefined) setPointer(out, legacyPointer, value);
  }
  return out;
}

/** The sealed pointers of the legacy view: a legacy pointer whose record pointer is sealed. */
export function legacySealedPointers(sealed: readonly string[], alias: LegacyAlias): string[] {
  return Object.entries(alias.projection)
    .filter(([, recordPointer]) => sealed.includes(recordPointer))
    .map(([legacyPointer]) => legacyPointer);
}

function pointerGetLocal(value: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const part of pointer.split("/").slice(1)) {
    if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function setPointer(value: JsonObject, pointer: string, next: JsonValue): void {
  const parts = pointer.split("/").slice(1);
  let current: JsonObject = value;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      const fresh: JsonObject = {};
      current[part] = fresh;
      current = fresh;
    } else current = child;
  }
  current[parts[parts.length - 1]!] = next;
}

export { RELATIONS };
