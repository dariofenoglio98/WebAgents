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
 * `format` is an annotation here, as it is for the formats the reference checks nothing
 * about (`date-time`, `uri`); the reference's checker asserts a small set of other formats
 * that no agentpkg schema uses for package members.
 */
import {
  InvalidSchemaError,
  registerSchema,
  unregisterSchema,
  validate,
} from "@hyperjump/json-schema/draft-2020-12";

import { ValidationError } from "./errors.js";
import { parseJson } from "./json.js";
import { SCHEMAS } from "./schemas/index.js";

export const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const AGENTPKG_BASE = "https://agentpkg.local/spec/0.1/";
const PACKAGE_BASE = "https://package.invalid/";

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
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    registerSchema(schema as never, `${AGENTPKG_BASE}${name}.schema.json`, DIALECT);
  }
  agentpkgRegistered = true;
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
  return SCHEMAS[name];
}

/** `validation.py::validate_document`: one of agentpkg's own schemas, first error reported. */
export async function validateDocument(value: unknown, schemaName: string, label: string): Promise<void> {
  ensureAgentpkgSchemas();
  if (!(schemaName in SCHEMAS)) throw new Error(`unknown agentpkg schema ${schemaName}`);
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
export class PackageSchemas {
  private constructor(
    private readonly base: string,
    private readonly documents: Map<string, unknown>,
  ) {}

  static async open(files: ReadonlyMap<string, Uint8Array>): Promise<PackageSchemas> {
    ensureAgentpkgSchemas();
    const base = `${PACKAGE_BASE}${crypto.randomUUID()}/`;
    const documents = new Map<string, unknown>();
    const registered: string[] = [];
    try {
      for (const [name, data] of files) {
        if (!name.endsWith(".json")) continue;
        const document = parseJson(data, name);
        documents.set(name, document);
        if (typeof document === "boolean" || (typeof document === "object" && document !== null && !Array.isArray(document))) {
          try {
            registerSchema(document as never, `${base}${name}`, DIALECT);
            registered.push(`${base}${name}`);
          } catch {
            // A JSON member that is not usable as a schema document (for example one
            // declaring another dialect) is simply not addressable by `$ref`; the walk in
            // validation.ts refuses any reference that lands on it.
          }
        }
      }
    } catch (error) {
      for (const uri of registered) unregisterSchema(uri);
      throw error;
    }
    return new PackageSchemas(base, documents);
  }

  document(path: string): unknown {
    return this.documents.get(path);
  }

  async failures(path: string, instance: unknown): Promise<SchemaFailure[]> {
    if (!this.documents.has(path)) throw new ValidationError(`undeclared schema ${JSON.stringify(path)}`);
    try {
      return await failures(`${this.base}${path}`, instance);
    } catch (error) {
      if (error instanceof InvalidSchemaError) throw new ValidationError(`${path}: invalid JSON Schema`);
      throw error;
    }
  }

  /** `validation.py::validate_instance`. */
  async validateInstance(path: string, instance: unknown, label = "instance"): Promise<void> {
    const list = await this.failures(path, instance);
    if (list.length === 0) return;
    const first = list[0]!;
    const location = first.instancePath.join("/") || "<root>";
    throw new ValidationError(`${label} does not match ${path} at ${location} (rule: ${first.keyword})`);
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
    for (const name of this.documents.keys()) {
      try {
        unregisterSchema(`${this.base}${name}`);
      } catch {
        // Not every document was registrable; see `open`.
      }
    }
    this.documents.clear();
  }
}

/** One-shot `validate_instance` over a package's files. */
export async function validateInstance(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  instance: unknown,
  label = "instance",
): Promise<void> {
  const schemas = await PackageSchemas.open(files);
  try {
    await schemas.validateInstance(path, instance, label);
  } finally {
    schemas.close();
  }
}
