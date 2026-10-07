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
  if (!inProperties && rules.closeObjects && out.type === "object" && out.additionalProperties !== false) out.additionalProperties = false;
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
