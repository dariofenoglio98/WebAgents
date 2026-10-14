/**
 * JSON Schema draft 2020-12 validation without `eval` (D-030).
 *
 * `@hyperjump/json-schema` is an interpreter with the official meta-schemas bundled, so a
 * Manifest V3 page can run it. Three services mirror `agentpkg/validation.py`:
 *
 * - `validateDocument` checks a document against one of agentpkg's own schemas
 *   (`validate_document`), reporting the first error in instance-path order;
 * - `checkSchema` checks that a package schema is itself a valid draft 2020-12 schema
 *   (`Draft202012Validator.check_schema`);
 * - `PackageSchemas` validates instances against a package's own schemas with every
 *   package-relative reference resolved offline and nothing retrievable from outside
 *   (`schema_validator` / `validate_instance`). Each opened package gets its own synthetic
 *   base URI, so loads never collide in the library's registry, and `close()` removes it.
 *
 * The library's schema registry and its dialect table are process-global, and registering
 * a document that carries `$id` or `$vocabulary` writes into both before any duplicate
 * check (a member with `"$id": "https://json-schema.org/draft/2020-12/schema"` and a
 * reduced `$vocabulary` would redefine the draft 2020-12 dialect for the rest of the
 * process, and every later manifest, integrity or signature check would accept anything).
 * The reference builds a fresh per-call registry, so package data can never reach its
 * dialects. Here the same property holds by two rules in `PackageSchemas.open`: only the
 * documents the manifest declares as schemas are registered, and only after
 * `registrable` has found no `$id`, `$vocabulary`, `$schema` other than draft 2020-12,
 * `$dynamicRef`, `$recursiveRef`, and no `$ref` with a scheme, an authority or an absolute
 * path anywhere in the tree (the same rules `validation.ts` applies to declared schemas;
 * `$dynamicAnchor` and `$recursiveAnchor` are document-local without a dynamic reference and
 * stay allowed, as the reference allows them). Anything else is simply not addressable by
 * `$ref`, and the library's remote retrieval is disabled at import, so nothing a package
 * writes can make this process fetch anything.
 *
 * `format` is an annotation here, as it is for the formats the reference checks nothing
 * about (`date-time`, `uri`); the reference's checker asserts a small set of other formats
 * that no agentpkg schema uses for package members.
 */
import { removeUriSchemePlugin } from "@hyperjump/browser";
import {
  InvalidSchemaError,
  registerSchema,
  unregisterSchema,
  validate,
} from "@hyperjump/json-schema/draft-2020-12";

import { ValidationError } from "./errors.js";
import { parseJson } from "./json.js";
import { EXTENSION_SCHEMAS } from "./schemas/extensions/index.js";
import { SCHEMAS } from "./schemas/index.js";
import { MEMORY_CONTRACTS } from "./schemas/memory/index.js";
import { urlsplit } from "./urls.js";

// `@hyperjump/browser` retrieves a reference its registry does not hold over the network
// (`http`, `https`) or, in Node, from disk (`file`). Package schemas resolve inside their
// private base URI and nowhere else, so those plugins are removed once, before any schema is
// registered (T1 review 2, finding 1). A reference that is not registered is then
// unresolvable, never fetched; `failures` reports it as an invalid schema.
for (const scheme of ["http", "https", "file"]) removeUriSchemePlugin(scheme);

export const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const AGENTPKG_BASE = "https://agentpkg.local/spec/0.1/";
const EXTENSION_BASE = "https://webagents.invalid/extensions/";
const PACKAGE_BASE = "https://package.invalid/";
const MEMORY_BASE = "https://agentpkg.local/spec/memory-v0/";
/** The memory.v0 contracts that are JSON Schemas (the taxonomy, the view template and the patches are not). */
const MEMORY_SCHEMA_NAMES: readonly string[] = Object.freeze(["memory-record.schema", "memory-type.schema", "memory-proposals.schema", "memory-empty-input.schema", "memory-agent-read.output.schema", "memory-agent-write.input.schema", "memory-agent-write.output.schema"]);

/**
 * RFC 6902 `add` and `replace` over JSON Pointers, which is all the memory.v0 patches use,
 * applied idempotently (an `add` whose value is already there is skipped), so the patched copy
 * is the same whether or not agentpkg's synced schema already carries the patch (T19, M-67).
 */
export function applyPatch(document: unknown, patch: ReadonlyArray<{ op: string; path: string; value: unknown }>): unknown {
  const result = JSON.parse(JSON.stringify(document)) as unknown;
  for (const operation of patch) {
    const parts = operation.path
      .split("/")
      .slice(1)
      .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
    let parent: unknown = result;
    for (const part of parts.slice(0, -1)) parent = Array.isArray(parent) ? parent[Number(part)] : (parent as Record<string, unknown>)[part];
    const last = parts[parts.length - 1]!;
    const value = JSON.parse(JSON.stringify(operation.value)) as unknown;
    if (operation.op === "add") {
      if (Array.isArray(parent)) {
        if (parent.some((item) => JSON.stringify(item) === JSON.stringify(value))) continue;
        if (last === "-") parent.push(value);
        else parent.splice(Number(last), 0, value);
      } else {
        const record = parent as Record<string, unknown>;
        if (Object.hasOwn(record, last) && JSON.stringify(record[last]) !== JSON.stringify(value)) throw new Error(`${operation.path} exists with a different value`);
        record[last] = value;
      }
    } else if (operation.op === "replace") {
      if (Array.isArray(parent)) parent[Number(last)] = value;
      else {
        const record = parent as Record<string, unknown>;
        if (!Object.hasOwn(record, last)) throw new Error(operation.path);
        record[last] = value;
      }
    } else throw new Error(`unsupported op ${operation.op}`);
  }
  return result;
}

type Patch = ReadonlyArray<{ op: string; path: string; value: unknown }>;
/** agentpkg's schemas with the memory.v0 patches applied (policy kinds and `memory_types`; the `memory.proposal` export format). */
export const PATCHED_SCHEMAS: Readonly<Record<string, unknown>> = Object.freeze({
  ...SCHEMAS,
  policy: applyPatch(SCHEMAS.policy, MEMORY_CONTRACTS["policy.schema.patch"] as Patch),
  workflow: applyPatch(SCHEMAS.workflow, MEMORY_CONTRACTS["workflow.schema.patch"] as Patch),
});
/** The policy bundle schema with the memory decisions and the `memory` ceilings (M-54). */
export const PATCHED_EXTENSION_SCHEMAS: Readonly<Record<string, unknown>> = Object.freeze({
  ...EXTENSION_SCHEMAS,
  "policy-bundle-v0": applyPatch(EXTENSION_SCHEMAS["policy-bundle-v0"], MEMORY_CONTRACTS["policy-bundle-v0.schema.patch"] as Patch),
});

export interface SchemaFailure {
  /** JSON pointer tokens of the failing instance location. */
  readonly instancePath: readonly string[];
  /** The keyword name, e.g. `required`, `const`, `additionalProperties`. */
  readonly keyword: string;
  /** The absolute keyword location the library reported. */
  readonly keywordLocation: string;
}

let agentpkgRegistered = false;

function ensureAgentpkgSchemas(): void {
  if (agentpkgRegistered) return;
  for (const [name, schema] of Object.entries(PATCHED_SCHEMAS)) {
    registerSchema(schema as never, `${AGENTPKG_BASE}${name}.schema.json`, DIALECT);
  }
  for (const [name, schema] of Object.entries(PATCHED_EXTENSION_SCHEMAS)) {
    registerSchema(schema as never, `${EXTENSION_BASE}${name}.schema.json`, DIALECT);
  }
  for (const name of MEMORY_SCHEMA_NAMES) {
    registerSchema(MEMORY_CONTRACTS[name] as never, `${MEMORY_BASE}${name}.json`, DIALECT);
  }
  agentpkgRegistered = true;
}

/**
 * One of the noncritical-extension schemas copied from `spec/extensions` (D-040), applied to
 * a manifest extension value. Returns the first failure's description, or null when valid.
 */
export async function extensionSchemaFailure(value: unknown, schemaName: string): Promise<string | null> {
  ensureAgentpkgSchemas();
  if (!Object.hasOwn(EXTENSION_SCHEMAS, schemaName)) throw new Error(`unknown extension schema ${schemaName}`);
  const list = await failures(`${EXTENSION_BASE}${schemaName}.schema.json`, value);
  if (list.length === 0) return null;
  const first = list[0]!;
  const path = first.instancePath.join("/") || "<root>";
  return `${path}: ${describeFailure(first, value, (uri) => (uri.startsWith(EXTENSION_BASE) ? PATCHED_EXTENSION_SCHEMAS[uri.slice(EXTENSION_BASE.length).replace(/\.schema\.json$/u, "")] : agentpkgDocument(uri)))}`;
}

/** The failures of `value` against one memory.v0 contract (`memory-record.schema`, `memory-proposals.schema`, ...), in instance-path order. */
export async function memoryFailures(value: unknown, schemaName: string): Promise<SchemaFailure[]> {
  ensureAgentpkgSchemas();
  if (!MEMORY_SCHEMA_NAMES.includes(schemaName)) throw new Error(`unknown memory.v0 schema ${schemaName}`);
  return failures(`${MEMORY_BASE}${schemaName}.json`, value);
}

/** One memory.v0 contract, the first failure described in the reference's phrasing, or null when valid. */
export async function memorySchemaFailure(value: unknown, schemaName: string): Promise<string | null> {
  const list = await memoryFailures(value, schemaName);
  if (list.length === 0) return null;
  const first = list[0]!;
  const path = first.instancePath.join("/") || "<root>";
  return `${path}: ${describeFailure(first, value, (uri) => (uri.startsWith(MEMORY_BASE) ? MEMORY_CONTRACTS[uri.slice(MEMORY_BASE.length).replace(/\.json$/u, "")] : agentpkgDocument(uri)))}`;
}

function pointerTokens(pointer: string): string[] {
  const body = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (body === "" || body === "/") return body === "/" ? [""] : [];
  return body
    .slice(1)
    .split("/")
    .map((token) => decodeURIComponent(token).replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return a.length - b.length;
}

type LibraryError = { keyword?: string; absoluteKeywordLocation?: string; instanceLocation?: string };

async function failures(schemaUri: string, instance: unknown): Promise<SchemaFailure[]> {
  const output = (await validate(schemaUri, instance as never, "BASIC")) as { valid: boolean; errors?: LibraryError[] };
  if (output.valid) return [];
  const list = (output.errors ?? []).map((error) => {
    const location = error.absoluteKeywordLocation ?? "";
    const fragment = location.includes("#") ? location.slice(location.indexOf("#") + 1) : "";
    const keyword = fragment.split("/").filter(Boolean).pop() ?? "schema";
    return {
      instancePath: pointerTokens(error.instanceLocation ?? "#"),
      keyword,
      keywordLocation: location,
    };
  });
  // The reference reports the first error in instance-path order; ties keep report order.
  return list
    .map((failure, index) => ({ failure, index }))
    .sort((a, b) => comparePaths(a.failure.instancePath, b.failure.instancePath) || a.index - b.index)
    .map((item) => item.failure);
}

function at(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const token of path) {
    if (Array.isArray(current)) current = current[Number(token)];
    else if (typeof current === "object" && current !== null) current = (current as Record<string, unknown>)[token];
    else return undefined;
  }
  return current;
}

function keywordValue(failure: SchemaFailure, documents: (uri: string) => unknown): unknown {
  const location = failure.keywordLocation;
  const hash = location.indexOf("#");
  if (hash < 0) return undefined;
  const document = documents(location.slice(0, hash));
  if (document === undefined) return undefined;
  return at(document, pointerTokens(location.slice(hash)));
}

/** A message in the reference's phrasing where it is cheap to reproduce. */
export function describeFailure(
  failure: SchemaFailure,
  instance: unknown,
  documents: (uri: string) => unknown,
): string {
  const value = at(instance, failure.instancePath);
  const shown = (item: unknown) => {
    const text = JSON.stringify(item);
    return text === undefined ? String(item) : text.length > 120 ? `${text.slice(0, 117)}...` : text;
  };
  const constraint = keywordValue(failure, documents);
  switch (failure.keyword) {
    case "required": {
      const required = Array.isArray(constraint) ? (constraint as string[]) : [];
      const missing = required.find((name) => !(typeof value === "object" && value !== null && name in (value as object)));
      return missing === undefined ? "a required property is missing" : `'${missing}' is a required property`;
    }
    case "additionalProperties": {
      const name = failure.instancePath[failure.instancePath.length - 1];
      return name === undefined
        ? "Additional properties are not allowed"
        : `Additional properties are not allowed ('${name}' was unexpected)`;
    }
    case "const":
      return `${shown(constraint)} was expected`;
    case "enum":
      return `${shown(value)} is not one of ${shown(constraint)}`;
    case "type":
      return `${shown(value)} is not of type ${shown(constraint)}`;
    case "pattern":
      return `${shown(value)} does not match ${shown(constraint)}`;
    case "anyOf":
      return `${shown(value)} is not valid under any of the given schemas`;
    case "propertyNames":
      return `a property name of ${shown(value)} does not match the schema's property name rule`;
    default:
      return constraint === undefined
        ? `${shown(value)} does not satisfy ${failure.keyword}`
        : `${shown(value)} does not satisfy ${failure.keyword}: ${shown(constraint)}`;
  }
}

function agentpkgDocument(uri: string): unknown {
  if (!uri.startsWith(AGENTPKG_BASE)) return undefined;
  const name = uri.slice(AGENTPKG_BASE.length).replace(/\.schema\.json$/u, "");
  return PATCHED_SCHEMAS[name];
}

/** `validation.py::validate_document`: one of agentpkg's own schemas, first error reported. */
export async function validateDocument(value: unknown, schemaName: string, label: string): Promise<void> {
  ensureAgentpkgSchemas();
  if (!Object.hasOwn(SCHEMAS, schemaName)) throw new Error(`unknown agentpkg schema ${schemaName}`);
  const list = await failures(`${AGENTPKG_BASE}${schemaName}.schema.json`, value);
  if (list.length === 0) return;
  const first = list[0]!;
  const path = first.instancePath.join("/") || "<root>";
  throw new ValidationError(`${label}/${path}: ${describeFailure(first, value, agentpkgDocument)}`);
}

/** `Draft202012Validator.check_schema`: is this document a valid draft 2020-12 schema? */
export async function checkSchema(schema: unknown, path: string): Promise<void> {
  ensureAgentpkgSchemas();
  const list = await failures(DIALECT, schema);
  if (list.length === 0) return;
  const first = list[0]!;
  const location = first.instancePath.join("/") || "<root>";
  throw new ValidationError(`${path}: invalid JSON Schema: ${location} does not satisfy ${first.keyword}`);
}

/**
 * The declared schemas of one package, registered under a private base URI so that
 * package-relative references resolve offline and nothing else can be retrieved.
 */
/**
 * Keywords that would write into the library's global registry or dialect table, or resolve
 * through it dynamically. `$dynamicAnchor` and `$recursiveAnchor` are not among them: without
 * `$dynamicRef`/`$recursiveRef` (refused here and by `validation.py`) they are document-local
 * names, and the reference accepts a declared schema that carries one (T1 review 2, finding 3).
 */
const REGISTRY_KEYWORDS: ReadonlySet<string> = new Set(["$id", "$vocabulary", "$dynamicRef", "$recursiveRef"]);

/**
 * `validation.py::_schema_reference`'s syntax rule, applied to a `$ref` before registration:
 * no scheme, no authority, no absolute path, no backslash. A reference that passes resolves
 * inside the package's private base; one that fails could only name somewhere else.
 */
export function localReference(ref: unknown): boolean {
  if (typeof ref !== "string" || ref.includes("\\")) return false;
  try {
    const parsed = urlsplit(ref);
    return !parsed.scheme && !parsed.netloc && !parsed.path.startsWith("/");
  } catch {
    return false;
  }
}

/**
 * Whether a package document may be handed to `registerSchema` without touching anything
 * outside its own private base URI: a boolean, or an object tree with none of
 * `REGISTRY_KEYWORDS`, no `$schema` other than draft 2020-12 and no non-local `$ref` at any
 * depth. This is the same rule `validation.ts` enforces on declared schemas, applied here as
 * the registry's own guard so that no caller can bypass it.
 */
export function registrable(document: unknown): boolean {
  if (typeof document === "boolean") return true;
  if (typeof document !== "object" || document === null || Array.isArray(document)) return false;
  return clean(document);
}

function clean(value: object): boolean {
  if (Array.isArray(value)) return value.every((item) => typeof item !== "object" || item === null || clean(item));
  for (const [key, item] of Object.entries(value)) {
    if (REGISTRY_KEYWORDS.has(key)) return false;
    if (key === "$schema" && item !== DIALECT) return false;
    if (key === "$ref" && !localReference(item)) return false;
    if (typeof item === "object" && item !== null && !clean(item)) return false;
  }
  return true;
}

export class PackageSchemas {
  private constructor(
    private readonly base: string,
    private readonly documents: Map<string, unknown>,
    private readonly registered: Set<string>,
  ) {}

  /**
   * Open the schemas of one package. `paths` names the documents the manifest declares as
   * schemas; only those are parsed and registered, and only when `registrable`. Without
   * `paths`, every `.json` member is a candidate, still behind the same guard.
   */
  static async open(files: ReadonlyMap<string, Uint8Array>, paths?: Iterable<string>): Promise<PackageSchemas> {
    ensureAgentpkgSchemas();
    const base = `${PACKAGE_BASE}${crypto.randomUUID()}/`;
    const documents = new Map<string, unknown>();
    const registered = new Set<string>();
    const wanted = paths === undefined ? null : new Set(paths);
    try {
      for (const [name, data] of files) {
        if (!name.endsWith(".json")) continue;
        if (wanted !== null && !wanted.has(name)) continue;
        const document = parseJson(data, name);
        documents.set(name, document);
        if (!registrable(document)) continue;
        try {
          registerSchema(document as never, `${base}${name}`, DIALECT);
          registered.add(name);
        } catch {
          // Not usable as a schema document; it is simply not addressable by `$ref`, and
          // the walk in validation.ts refuses any reference that lands on it.
        }
      }
    } catch (error) {
      for (const name of registered) unregisterSchema(`${base}${name}`);
      throw error;
    }
    return new PackageSchemas(base, documents, registered);
  }

  document(path: string): unknown {
    return this.documents.get(path);
  }

  async failures(path: string, instance: unknown): Promise<SchemaFailure[]> {
    if (!this.documents.has(path)) throw new ValidationError(`undeclared schema ${JSON.stringify(path)}`);
    if (!this.registered.has(path)) throw new ValidationError(`${path}: invalid JSON Schema`);
    try {
      return await failures(`${this.base}${path}`, instance);
    } catch (error) {
      // An invalid schema, or a reference to a document that is not registered: with the
      // retrieval plugins removed the library cannot fetch it and throws instead. Both are
      // the same fact for a caller: this path is not a usable schema of this package.
      if (error instanceof ValidationError) throw error;
      if (error instanceof InvalidSchemaError || error instanceof Error) {
        throw new ValidationError(`${path}: invalid JSON Schema`);
      }
      throw error;
    }
  }

  /**
   * `validation.py::validate_instance`. The thrown error carries the first failure as
   * `schema_failure`, the way the reference's error carries its jsonschema cause, so the
   * runtime can record which keyword refused a tool payload without recording the payload.
   */
  async validateInstance(path: string, instance: unknown, label = "instance"): Promise<void> {
    const list = await this.failures(path, instance);
    if (list.length === 0) return;
    const first = list[0]!;
    const location = first.instancePath.join("/") || "<root>";
    throw schemaError(`${label} does not match ${path} at ${location} (rule: ${first.keyword})`, first);
  }

  /** The schema document a keyword location points into: one of this package's, or agentpkg's. */
  resolveDocument(uri: string): unknown {
    const hash = uri.indexOf("#");
    const base = hash < 0 ? uri : uri.slice(0, hash);
    return base.startsWith(this.base) ? this.documents.get(base.slice(this.base.length)) : agentpkgDocument(base);
  }

  /** The value of the failing keyword, e.g. the `required` list or the `enum` members. */
  keywordValue(failure: SchemaFailure): unknown {
    return keywordValue(failure, (uri) => this.resolveDocument(uri));
  }

  describe(failure: SchemaFailure, instance: unknown): string {
    return describeFailure(failure, instance, (uri) => this.resolveDocument(uri));
  }

  close(): void {
    for (const name of this.registered) unregisterSchema(`${this.base}${name}`);
    this.registered.clear();
    this.documents.clear();
  }
}

const ADHOC_BASE = "https://package.invalid/adhoc/";

/**
 * Failures of `instance` against a self-contained schema document that is not a package member:
 * the bundled node schema a model request carries (`Draft202012Validator(output_schema)` in
 * `runtime.py::call_model`). The document is registered under a private one-off base and
 * unregistered again; it must be `registrable`, so it resolves only its own `#/$defs`.
 */
export async function failuresForSchema(schema: unknown, instance: unknown, label = "schema"): Promise<SchemaFailure[]> {
  ensureAgentpkgSchemas();
  if (!registrable(schema)) throw new ValidationError(`${label}: invalid JSON Schema`);
  const uri = `${ADHOC_BASE}${crypto.randomUUID()}/schema.json`;
  registerSchema(schema as never, uri, DIALECT);
  try {
    return await failures(uri, instance);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`${label}: invalid JSON Schema`);
  } finally {
    unregisterSchema(uri);
  }
}

/** Validate against a self-contained schema document, in the reference's phrasing. */
export async function validateWithSchema(schema: unknown, instance: unknown, label = "instance"): Promise<void> {
  const list = await failuresForSchema(schema, instance, label);
  if (list.length === 0) return;
  const first = list[0]!;
  const location = first.instancePath.join("/") || "<root>";
  throw schemaError(`${label} does not match schema at ${location} (rule: ${first.keyword})`, first);
}

/** A `ValidationError` that carries the failure that caused it (`exc.__cause__` in the reference). */
export type SchemaValidationError = ValidationError & { schema_failure: SchemaFailure };

export function schemaError(message: string, failure: SchemaFailure): SchemaValidationError {
  return Object.assign(new ValidationError(message), { schema_failure: failure });
}

/** One-shot `validate_instance` over a package's files. */
export async function validateInstance(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  instance: unknown,
  label = "instance",
  paths?: Iterable<string>,
): Promise<void> {
  const schemas = await PackageSchemas.open(files, paths);
  try {
    await schemas.validateInstance(path, instance, label);
  } finally {
    schemas.close();
  }
}
