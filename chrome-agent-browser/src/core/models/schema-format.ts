/**
 * The schema a provider is asked to constrain decoding with (D-062), derived from the bundled
 * node schema and never from anything a package says about providers.
 *
 * `Workflow.modelSchema` bundles every package-relative reference into one document whose root
 * is `{"$ref": "#/$defs/sN", "$defs": {...}}`. A root reference is not something a provider's
 * response-format parser accepts, so the root is inlined (one hop; the `$defs` namespace stays
 * so inner references still resolve). Providers also refuse keywords they cannot constrain
 * with; those are dropped from the *constraint copy only*. Validation always runs against the
 * full package schema, so a constraint that is looser than the package's contract changes
 * nothing about what is accepted, and one that is tighter (a closed object where the package
 * left it open) can only remove freedom the model would not have needed for a valid answer.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import { deepCopy } from "../references.js";
import { utf8Length } from "../pyjson.js";

/** Above this, the schema is not worth sending twice; the prompt copy remains. */
export const MAX_RESPONSE_FORMAT_BYTES = 64 * 1024;
export const RESPONSE_FORMAT_NAME = "agentpkg_node_output";
const LOCAL_DEFS_REF = /^#\/\$defs\/([^/]+)$/u;
/** Root-level annotations a provider's response-format parser has no use for. */
const STRIPPED_ROOT_KEYS = ["$schema", "$id", "$anchor", "title", "description"];

/** Rewrite a `$ref`-rooted document so its root carries the referenced schema (one hop). */
export function inlineRootRef(schema: JsonObject): JsonObject {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const name = LOCAL_DEFS_REF.exec(ref)?.[1];
  const defs = schema.$defs;
  if (!name || !isJsonObject(defs) || !Object.hasOwn(defs, name)) return schema;
  const target = defs[name];
  if (!isJsonObject(target) || typeof target.$ref === "string") return schema;
  const { $ref: _dropped, ...rest } = schema;
  return { ...target, ...rest };
}

export interface ConstraintRules {
  /** Keywords the provider refuses, removed wherever they occur. */
  dropKeywords: readonly string[];
  /** Whether every object schema must say `additionalProperties: false`. */
  closeObjects: boolean;
  /** Whether an array root is acceptable to the provider. */
  arrayRoot: boolean;
}

/** Ollama's `format` constrains any root with the schema as given. */
export const OLLAMA_RULES: ConstraintRules = { dropKeywords: [], closeObjects: false, arrayRoot: true };
/** OpenAI's non-strict json_schema format: object roots, schema as given. */
export const OPENAI_RULES: ConstraintRules = { dropKeywords: [], closeObjects: false, arrayRoot: false };
/** Anthropic structured outputs: no numeric or string bounds, every object closed, object root. */
export const ANTHROPIC_RULES: ConstraintRules = {
  dropKeywords: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties"],
  closeObjects: true,
  arrayRoot: false,
};

function rewrite(value: JsonValue, rules: ConstraintRules, inProperties = false): JsonValue {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, rules));
  if (!isJsonObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (!inProperties && rules.dropKeywords.includes(key)) continue;
    // Under `properties` (and `$defs`) the keys are names, not keywords.
    const names = key === "properties" || key === "$defs" || key === "patternProperties";
    out[key] = names && isJsonObject(item) ? Object.fromEntries(Object.entries(item).map(([name, child]) => [name, rewrite(child, rules)])) : rewrite(item, rules);
  }
  // A nullable object (`type: ["object", "null"]`) is an object too (T9 review 1, nit 6).
  const objectTyped = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object"));
  if (!inProperties && rules.closeObjects && objectTyped && out.additionalProperties !== false) out.additionalProperties = false;
  return out;
}

/**
 * The constraint document for one provider, or null when the schema cannot carry a native
 * constraint (no stated root type, a root the provider refuses, or an oversized document), in
 * which case the caller reports an unconstrained request instead of pretending otherwise.
 */
export function constraintSchema(schema: JsonValue, rules: ConstraintRules): JsonObject | null {
  if (!isJsonObject(schema)) return null;
  const rooted = inlineRootRef(deepCopy(schema));
  if (rooted.type !== "object" && !(rules.arrayRoot && rooted.type === "array")) return null;
  const projected = rewrite(rooted, rules) as JsonObject;
  for (const key of STRIPPED_ROOT_KEYS) delete projected[key];
  if (utf8Length(JSON.stringify(projected)) > MAX_RESPONSE_FORMAT_BYTES) return null;
  return projected;
}

/**
 * OpenAI's strict json_schema format (D-115): constrained decoding, so an accepted schema is a
 * guarantee rather than a hint. The copy drops the bounds strict mode refuses (string lengths,
 * `uniqueItems`, property counts, `format`, `default`, `examples`) and closes every object; the
 * router still validates the answer against the full package schema.
 */
export const OPENAI_STRICT_RULES: ConstraintRules = {
  dropKeywords: ["minLength", "maxLength", "uniqueItems", "minProperties", "maxProperties", "format", "default", "examples"],
  closeObjects: true,
  arrayRoot: false,
};

/** Keywords strict mode cannot express; a schema that uses one keeps the non-strict request. */
const STRICT_UNSUPPORTED = new Set(["allOf", "oneOf", "not", "if", "then", "else", "patternProperties", "dependentRequired", "dependentSchemas", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "contains", "prefixItems", "additionalItems", "$dynamicRef", "$anchor"]);

/**
 * Whether a projected schema meets strict mode's shape rules: every object lists its properties and
 * uses no keyword strict mode cannot express. An optional property is allowed here: the strict copy
 * encodes it (D-121).
 */
function strictShape(value: JsonValue, inProperties = false): boolean {
  if (Array.isArray(value)) return value.every((item) => strictShape(item));
  if (!isJsonObject(value)) return true;
  if (inProperties) return Object.values(value).every((child) => strictShape(child));
  for (const key of Object.keys(value)) if (STRICT_UNSUPPORTED.has(key)) return false;
  const types = Array.isArray(value.type) ? value.type : [value.type];
  const isObject = types.includes("object") || isJsonObject(value.properties);
  // A free-form map (no named properties) cannot be strict without changing the schema's meaning.
  if (isObject && (!isJsonObject(value.properties) || Object.keys(value.properties).length === 0)) return false;
  return Object.entries(value).every(([key, child]) => strictShape(child, key === "properties" || key === "$defs"));
}

/**
 * Follow local `#/$defs/<name>` references against the document root (bounded). Unlike
 * `inlineRootRef`, which rewrites a document's root once and keeps its sibling keys, this reads
 * the schema a reference stands for, wherever it occurs.
 */
function resolveLocal(schema: JsonValue, root: JsonValue): JsonValue {
  let current = schema;
  for (let hops = 0; hops < 32 && isJsonObject(current) && typeof current.$ref === "string"; hops += 1) {
    const name = LOCAL_DEFS_REF.exec(current.$ref)?.[1];
    const defs = isJsonObject(root) ? root.$defs : undefined;
    if (!name || !isJsonObject(defs) || !Object.hasOwn(defs, name)) return current;
    current = defs[name]!;
  }
  return current;
}

/**
 * Whether a schema accepts `null`, read from its `type`, `enum`, `const` or `anyOf` (local
 * references followed). Anything else is read as not admitting null, which can only make the
 * strict copy add an explicit null alternative that was already allowed.
 */
export function admitsNull(schema: JsonValue, root: JsonValue): boolean {
  const resolved = resolveLocal(schema, root);
  if (resolved === true) return true;
  if (!isJsonObject(resolved)) return false;
  if (Array.isArray(resolved.type)) return resolved.type.includes("null");
  if (resolved.type !== undefined) return resolved.type === "null";
  if (Array.isArray(resolved.enum)) return resolved.enum.includes(null);
  if (Object.hasOwn(resolved, "const")) return resolved.const === null;
  if (Array.isArray(resolved.anyOf)) return resolved.anyOf.some((branch) => admitsNull(branch, root));
  return Object.keys(resolved).length === 0;
}

/**
 * The strict encoding of "optional" (D-121): every property becomes required, and one the package
 * leaves optional whose schema does not admit null becomes `anyOf: [<schema>, {"type": "null"}]`.
 * `decodeConstrained` reads such a null back as an absent property.
 */
function encodeOptional(value: JsonValue, root: JsonValue): { schema: JsonValue; encoded: boolean } {
  let encoded = false;
  const walk = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isJsonObject(node)) return node;
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = (key === "properties" || key === "$defs") && isJsonObject(child) ? Object.fromEntries(Object.entries(child).map(([name, sub]) => [name, walk(sub)])) : walk(child);
    }
    if (isJsonObject(out.properties)) {
      const required = new Set(Array.isArray(out.required) ? out.required.map(String) : []);
      const properties: JsonObject = {};
      for (const [name, sub] of Object.entries(out.properties)) {
        if (required.has(name) || admitsNull(sub, root)) properties[name] = sub;
        else {
          properties[name] = { anyOf: [sub, { type: "null" }] };
          encoded = true;
        }
      }
      out.properties = properties;
      out.required = Object.keys(properties);
    }
    return out;
  };
  return { schema: walk(value), encoded };
}

/** The JSON types a schema admits, `integer` read as `number` (an integer value matches both); null for "any". */
function admittedTypes(schema: JsonValue): Set<string> | null {
  if (!isJsonObject(schema) || schema.type === undefined) return null;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return new Set(types.map((type) => (type === "integer" ? "number" : String(type))));
}

/** Whether some value's JSON type matches both schemas, as `typeMatches` reads them. */
function typesOverlap(a: JsonValue, b: JsonValue): boolean {
  const left = admittedTypes(a);
  const right = admittedTypes(b);
  return left === null || right === null || [...left].some((type) => right.has(type));
}

/** Whether a schema, followed through local references, `properties`, `items` and `anyOf`, holds an optional property the strict copy would encode as nullable. */
function holdsEncodedOptional(schema: JsonValue, root: JsonValue, seen = new Set<JsonValue>()): boolean {
  const resolved = resolveLocal(schema, root);
  if (!isJsonObject(resolved) || seen.has(resolved)) return false;
  seen.add(resolved);
  const children: JsonValue[] = [];
  if (isJsonObject(resolved.properties)) {
    const required = new Set(Array.isArray(resolved.required) ? resolved.required.map(String) : []);
    for (const [name, sub] of Object.entries(resolved.properties)) {
      if (!required.has(name) && !admitsNull(sub, root)) return true;
      children.push(sub);
    }
  }
  if (resolved.items !== undefined) children.push(...(Array.isArray(resolved.items) ? resolved.items : [resolved.items]));
  if (Array.isArray(resolved.anyOf)) children.push(...resolved.anyOf);
  return children.some((child) => holdsEncodedOptional(child, root, seen));
}

/**
 * Whether `decodeConstrained` could meet a forced null it cannot read back (T10 review 1, finding 1;
 * D-132): an `anyOf` anywhere in the package schema with two branches some value matches by type,
 * one of which holds an optional property the strict copy encodes. The decoder follows an `anyOf`
 * only when exactly one branch matches, so such a schema keeps the non-strict request.
 */
function ambiguousOptional(schema: JsonValue): boolean {
  const visit = (node: JsonValue): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!isJsonObject(node)) return false;
    if (Array.isArray(node.anyOf)) {
      const branches = node.anyOf.map((branch) => resolveLocal(branch, schema));
      for (let i = 0; i < branches.length; i += 1) {
        for (let j = i + 1; j < branches.length; j += 1) {
          if (typesOverlap(branches[i]!, branches[j]!) && (holdsEncodedOptional(branches[i]!, schema) || holdsEncodedOptional(branches[j]!, schema))) return true;
        }
      }
    }
    return Object.values(node).some(visit);
  };
  return visit(schema);
}

/** The key an array root is wrapped under for a provider that takes object roots only (D-122). */
export const ENVELOPE_KEY = "items";

/**
 * An array-root document as the object `{"items": <array>}` (D-122), the `$defs` namespace kept at
 * the top so inner references still resolve; null for any other root.
 */
export function envelopeArrayRoot(schema: JsonValue): JsonObject | null {
  if (!isJsonObject(schema)) return null;
  const rooted = inlineRootRef(deepCopy(schema));
  if (rooted.type !== "array") return null;
  const { $defs, ...array } = rooted;
  for (const key of STRIPPED_ROOT_KEYS) delete array[key];
  return { type: "object", properties: { [ENVELOPE_KEY]: array }, required: [ENVELOPE_KEY], additionalProperties: false, ...($defs !== undefined ? { $defs } : {}) };
}

/** What an OpenAI request is constrained with, and how its answer is read back. */
export interface OpenAiConstraint {
  /** The strict json_schema copy, or null when the schema cannot be one without changing its meaning. */
  strict: JsonObject | null;
  /** The non-strict copy (the fallback when OpenAI refuses the strict one), or null. */
  nonStrict: JsonObject | null;
  /** The schema's array root is wrapped as `{"items": …}` in both copies. */
  envelope: boolean;
  /** The strict copy encodes at least one optional property as required and nullable. */
  encodedOptional: boolean;
}

/**
 * The OpenAI constraint for a package schema (D-115, D-121, D-122): a strict copy where the schema
 * allows one (optional properties encoded) and its answer can be read back (D-132), the non-strict
 * copy otherwise, an array root wrapped.
 */
export function openAiConstraint(schema: JsonValue): OpenAiConstraint {
  const wrapped = envelopeArrayRoot(schema);
  const source: JsonValue = wrapped ?? schema;
  const nonStrict = constraintSchema(source, OPENAI_RULES);
  const projected = constraintSchema(source, OPENAI_STRICT_RULES);
  let strict: JsonObject | null = null;
  let encodedOptional = false;
  if (projected !== null && strictShape(projected)) {
    const encoding = encodeOptional(projected, projected);
    const decodable = !encoding.encoded || !ambiguousOptional(schema);
    if (decodable && utf8Length(JSON.stringify(encoding.schema)) <= MAX_RESPONSE_FORMAT_BYTES) {
      strict = encoding.schema as JsonObject;
      encodedOptional = encoding.encoded;
    }
  }
  return { strict, nonStrict, envelope: wrapped !== null && (strict !== null || nonStrict !== null), encodedOptional: strict !== null && encodedOptional };
}

/**
 * The strict constraint for an OpenAI request, or null when the package schema cannot be one
 * without changing what it means (a free-form map, `allOf`, `if`, …); the caller then sends the
 * non-strict request (D-062).
 */
export function openAiStrictSchema(schema: JsonValue): JsonObject | null {
  return openAiConstraint(schema).strict;
}

/** How an answer to a constrained request is read back before validation (D-121, D-122). */
export interface ConstraintDecoding {
  /** The request wrapped an array root as `{"items": …}`. */
  envelope: boolean;
  /** The request encoded optional properties as required and nullable. */
  optional_nulls: boolean;
}

function jsonTypeOf(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(schema: JsonValue, value: JsonValue): boolean {
  if (!isJsonObject(schema) || schema.type === undefined) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = jsonTypeOf(value);
  return types.includes(actual) || (actual === "integer" && types.includes("number"));
}

/**
 * Read an answer back from the constraint's own encoding, deterministically and against the
 * **package** schema (D-121, D-122):
 * - with `envelope`, an object whose only key is `items` is its value; anything else is left as it
 *   came, for validation to decide;
 * - with `optional_nulls`, a `null` under a property the package schema leaves optional and whose
 *   own schema does not admit null is read as absent. The walk follows local references,
 *   `properties` and `items`, and an `anyOf` only when exactly one branch matches the value's JSON
 *   type; nothing else is touched.
 * Validation against the full package schema always follows; this is not a repair.
 */
export function decodeConstrained(value: JsonValue, schema: JsonValue, decoding: ConstraintDecoding): { value: JsonValue; unwrapped: boolean; nullsDropped: number } {
  let current = value;
  let unwrapped = false;
  if (decoding.envelope && isJsonObject(current) && Object.keys(current).length === 1 && Object.hasOwn(current, ENVELOPE_KEY)) {
    current = current[ENVELOPE_KEY]!;
    unwrapped = true;
  }
  let nullsDropped = 0;
  const walk = (node: JsonValue, nodeSchema: JsonValue, depth: number): JsonValue => {
    if (depth > 256) return node;
    const resolved = resolveLocal(nodeSchema, schema);
    if (!isJsonObject(resolved)) return node;
    if (Array.isArray(resolved.anyOf)) {
      const matching = resolved.anyOf.filter((branch) => typeMatches(resolveLocal(branch, schema), node));
      return matching.length === 1 ? walk(node, matching[0]!, depth + 1) : node;
    }
    if (Array.isArray(node)) return isJsonObject(resolved.items) ? node.map((item) => walk(item, resolved.items as JsonValue, depth + 1)) : node;
    if (!isJsonObject(node) || !isJsonObject(resolved.properties)) return node;
    const properties = resolved.properties;
    const required = new Set(Array.isArray(resolved.required) ? resolved.required.map(String) : []);
    const out: JsonObject = {};
    for (const [name, child] of Object.entries(node)) {
      if (!Object.hasOwn(properties, name)) {
        out[name] = child;
        continue;
      }
      if (child === null && !required.has(name) && !admitsNull(properties[name]!, schema)) {
        nullsDropped += 1;
        continue;
      }
      out[name] = walk(child, properties[name]!, depth + 1);
    }
    return out;
  };
  if (decoding.optional_nulls) current = walk(current, schema, 0);
  return { value: current, unwrapped, nullsDropped };
}
