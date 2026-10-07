/**
 * What a browser may show a person about a package's task, mirroring
 * `agentpkg/browser/presentation.py`: the task input schema bundled into one self-contained
 * document, the validated noncritical `agentpkg:presentation` hints, and task validation
 * against the package's own input schema. None of it executes anything, and presentation is
 * cosmetic by construction: a hint cannot grant a permission, approve a tool, select a model,
 * change the graph or skip a check. A Run label that does not say "run" is dropped.
 */
import { canonicalJson } from "./canonical.js";
import { ValidationError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import { packageJson, type Package } from "./package.js";
import { schemaReference } from "./references.js";
import { PackageSchemas, type SchemaFailure } from "./schema.js";

export const EXTENSION_KEY = "agentpkg:presentation";
export const PRESENTATION_SCHEMA = "agentpkg-presentation-v0";
export const INPUT_SCHEMA_VERSION = "agentpkg-task-input-v0";

export const MAX_INPUT_SCHEMA_BYTES = 64 * 1024;
export const MAX_TASK_INPUT_BYTES = 256 * 1024;
const MAX_ERRORS = 16;
const MAX_LABEL = 80;
const MAX_TEXT = 300;
const MAX_RUN_LABEL = 40;
const MAX_STAGES = 32;
const MAX_SUMMARY = 8;
const WIDGETS = new Set(["multiline", "selected_files"]);
const GROUPS = new Set(["primary", "optional", "advanced"]);
// C0 and C1 controls, zero-width and bidirectional formatting characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/gu;

/** `_text`: plain display text, normalized, control and bidi characters removed, bounded. */
export function displayText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFC")
    .replace(CONTROL, " ")
    .split(/\s+/u)
    .filter((piece) => piece)
    .join(" ");
  if (!cleaned) return null;
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

function hasRef(value: JsonValue): boolean {
  if (isJsonObject(value)) return "$ref" in value || Object.values(value).some(hasRef);
  if (Array.isArray(value)) return value.some(hasRef);
  return false;
}

/** `_bundle`: one self-contained schema with package-relative references moved into `$defs`. */
function bundle(pkg: Package, path: string): JsonValue {
  const documents = new Map<string, JsonValue>();
  for (const entry of pkg.manifest.schemas as JsonValue[]) {
    const schemaPath = String((entry as JsonObject).path);
    documents.set(schemaPath, packageJson(pkg, schemaPath));
  }
  const names = new Map([...documents.keys()].sort().map((name, index) => [name, `s${index}`] as const));
  const included: JsonObject = {};
  const pending: string[] = [path];

  const rewrite = (value: JsonValue, base: string): JsonValue => {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, base));
    if (!isJsonObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) if (key !== "$schema") out[key] = rewrite(item, base);
    if ("$ref" in value) {
      const [target, fragment] = schemaReference(base, String(value.$ref));
      const name = names.get(target);
      if (name === undefined) throw new ValidationError(`${base}: undeclared schema reference ${JSON.stringify(target)}`);
      out.$ref = `#/$defs/${name}${fragment}`;
      if (!(name in included) && !pending.includes(target)) pending.push(target);
    }
    return out;
  };

  const root = documents.get(path)!;
  if (!hasRef(root)) {
    if (!isJsonObject(root)) return root;
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(root)) if (key !== "$schema") out[key] = item;
    return out;
  }
  while (pending.length > 0) {
    const current = pending.pop()!;
    included[names.get(current)!] = rewrite(documents.get(current)!, current);
  }
  return { $ref: `#/$defs/${names.get(path)!}`, $defs: included };
}

export interface InputForm {
  schema: typeof INPUT_SCHEMA_VERSION;
  schema_path: string | null;
  schema_sha256: string | null;
  document: JsonValue | null;
  bytes: number;
  note: string;
}

/** `input_form`: the package's declared task input contract, as one bounded document. */
export async function inputForm(pkg: Package): Promise<InputForm> {
  const graph = pkg.graph;
  const path = graph.input_schema;
  if (!path || !("nodes" in graph)) {
    return {
      schema: INPUT_SCHEMA_VERSION,
      schema_path: null,
      schema_sha256: null,
      document: null,
      bytes: 0,
      note: "This execution profile declares no task input schema.",
    };
  }
  const declared = packageJson(pkg, String(path));
  const bundled = bundle(pkg, String(path));
  const data = canonicalJson(bundled);
  const tooLarge = data.length > MAX_INPUT_SCHEMA_BYTES;
  return {
    schema: INPUT_SCHEMA_VERSION,
    schema_path: String(path),
    schema_sha256: await sha256Hex(canonicalJson(declared)),
    document: tooLarge ? null : bundled,
    bytes: data.length,
    note: tooLarge
      ? `The input schema exceeds ${MAX_INPUT_SCHEMA_BYTES} bytes; edit the task as JSON.`
      : "The package's own declared input schema. The runner validates every run against it again before any instruction reaches a model.",
  };
}

// -- validating a task ----------------------------------------------------------------
function pointer(parts: readonly string[]): string {
  return parts.map((part) => `/${part.replace(/~/gu, "~0").replace(/\//gu, "~1")}`).join("");
}

function at(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const token of path) {
    if (Array.isArray(current)) current = current[Number(token)];
    else if (isJsonObject(current as JsonValue)) current = (current as JsonObject)[token];
    else return undefined;
  }
  return current;
}

/** `_describe`: pointers and host-written messages. The person's own text is never echoed. */
function describe(failure: SchemaFailure, instance: unknown, schemas: PackageSchemas): Array<[string, string]> {
  const rule = failure.keyword;
  const constraint = schemas.keywordValue(failure);
  const value = at(instance, failure.instancePath);
  const location = [...failure.instancePath];
  if (rule === "required") {
    const required = Array.isArray(constraint) ? (constraint as string[]) : [];
    const present = isJsonObject(value as JsonValue) ? (value as JsonObject) : {};
    const missing = required.filter((name) => !(name in present));
    if (missing.length > 0) return missing.map((name) => [pointer([...location, name]), "is required"]);
  }
  const plural = (count: unknown, word: string) => `${count} ${word}${count !== 1 ? "s" : ""}`;
  const messages: Record<string, () => string> = {
    minLength: () => `must be at least ${plural(constraint, "character")}`,
    maxLength: () => `must be at most ${constraint} characters`,
    minItems: () => `must have at least ${plural(constraint, "item")}`,
    maxItems: () => `must have at most ${constraint} items`,
    minimum: () => `must be at least ${constraint}`,
    maximum: () => `must be at most ${constraint}`,
    exclusiveMinimum: () => `must be greater than ${constraint}`,
    exclusiveMaximum: () => `must be less than ${constraint}`,
    enum: () => `must be one of: ${(Array.isArray(constraint) ? constraint : []).map(String).join(", ").slice(0, 200)}`,
    const: () => "has a fixed value that was not supplied",
    pattern: () => "does not have the required format",
    type: () => `must be ${Array.isArray(constraint) ? constraint.join(" or ") : String(constraint)}`,
    additionalProperties: () => "contains a field this package does not accept",
    uniqueItems: () => "must not repeat items",
    format: () => `must be a valid ${constraint}`,
  };
  const message = (messages[rule] ?? (() => `does not satisfy the schema rule ${JSON.stringify(rule)}`))();
  return [[pointer(location), message]];
}

export interface TaskValidation {
  schema_path: string | null;
  valid: boolean;
  errors: Array<{ pointer: string; rule: string; message: string }>;
  error_count: number;
  input_sha256: string | null;
  input_bytes: number;
}

/** `validate_task_input`: one proposed task against the package's own input schema. */
export async function validateTaskInput(pkg: Package, value: unknown): Promise<TaskValidation> {
  const path = pkg.graph.input_schema ? String(pkg.graph.input_schema) : null;
  const report: TaskValidation = { schema_path: path, valid: false, errors: [], error_count: 0, input_sha256: null, input_bytes: 0 };
  let data: Uint8Array;
  try {
    data = canonicalJson(value);
  } catch {
    report.errors = [{ pointer: "", rule: "json", message: "is not finite JSON" }];
    report.error_count = 1;
    return report;
  }
  report.input_sha256 = await sha256Hex(data);
  report.input_bytes = data.length;
  if (data.length > MAX_TASK_INPUT_BYTES) {
    report.errors = [{ pointer: "", rule: "size", message: `is larger than the ${MAX_TASK_INPUT_BYTES}-byte task limit` }];
    report.error_count = 1;
    return report;
  }
  if (!path) {
    report.errors = [{ pointer: "", rule: "schema", message: "this package declares no task input" }];
    report.error_count = 1;
    return report;
  }
  const schemas = await PackageSchemas.open(pkg.files);
  try {
    const failures = await schemas.failures(path, value);
    const described: TaskValidation["errors"] = [];
    for (const failure of failures) {
      for (const [where, message] of describe(failure, value, schemas)) {
        const entry = { pointer: where, rule: failure.keyword, message };
        if (!described.some((item) => item.pointer === entry.pointer && item.rule === entry.rule && item.message === entry.message)) {
          described.push(entry);
        }
      }
    }
    report.errors = described.slice(0, MAX_ERRORS);
    report.error_count = described.length;
    report.valid = described.length === 0;
  } finally {
    schemas.close();
  }
  return report;
}

// -- presentation hints ---------------------------------------------------------------
export interface PresentationHints {
  schema: typeof PRESENTATION_SCHEMA;
  task: Record<string, string>;
  input: Record<string, Record<string, string | number>>;
  nodes: Record<string, string>;
  stages: Array<{ label: string; nodes: string[] }>;
  result: { primary_export?: string; summary?: Array<{ label: string; export: string }> };
  noncritical: true;
}

function inputHints(raw: unknown, properties: Set<string>, notes: string[]): PresentationHints["input"] {
  const hints: PresentationHints["input"] = {};
  if (!isJsonObject(raw as JsonValue)) return hints;
  for (const [name, value] of Object.entries(raw as JsonObject)) {
    if (!properties.has(name) || !isJsonObject(value)) {
      notes.push(`input hint for undeclared field ${JSON.stringify(String(name).slice(0, 40))} ignored`);
      continue;
    }
    const hint: Record<string, string | number> = {};
    const widget = value.widget;
    if (typeof widget === "string" && WIDGETS.has(widget)) hint.widget = widget;
    else if (widget !== undefined && widget !== null) notes.push(`unknown widget for ${JSON.stringify(name)} ignored`);
    const group = value.group;
    if (typeof group === "string" && GROUPS.has(group)) hint.group = group;
    const rows = value.rows;
    if (typeof rows === "number" && Number.isInteger(rows) && rows >= 1 && rows <= 12) hint.rows = rows;
    for (const [key, limit] of [
      ["label", MAX_LABEL],
      ["placeholder", MAX_TEXT],
      ["item_placeholder", MAX_TEXT],
      ["key_label", MAX_LABEL],
      ["key_placeholder", MAX_TEXT],
    ] as const) {
      const text = displayText(value[key], limit);
      if (text) hint[key] = text;
    }
    if (Object.keys(hint).length > 0) hints[name] = hint;
  }
  return hints;
}

function stages(raw: unknown, nodeIds: string[], notes: string[]): PresentationHints["stages"] {
  const out: PresentationHints["stages"] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw.slice(0, MAX_STAGES)) {
    if (!isJsonObject(entry)) continue;
    const label = displayText(entry.label, MAX_LABEL);
    const nodes = (Array.isArray(entry.nodes) ? entry.nodes : []).filter(
      (node): node is string => typeof node === "string" && nodeIds.includes(node) && !seen.has(node),
    );
    if (!label || nodes.length === 0) {
      notes.push("a stage without a label or known nodes was ignored");
      continue;
    }
    for (const node of nodes) seen.add(node);
    out.push({ label, nodes });
  }
  return out;
}

/** `presentation_hints`: validated hints and notes about what was dropped; null when absent or unusable. */
export function presentationHints(pkg: Package): [PresentationHints | null, string[]] {
  const graph = pkg.graph;
  const extensions = isJsonObject(graph.extensions) ? graph.extensions : {};
  const raw = extensions[EXTENSION_KEY];
  if (raw === undefined || raw === null) return [null, []];
  if (!isJsonObject(raw) || raw.schema !== PRESENTATION_SCHEMA) return [null, [`${EXTENSION_KEY} is not ${PRESENTATION_SCHEMA}; ignored`]];
  const notes: string[] = [];
  const nodeIds = (Array.isArray(graph.nodes) ? graph.nodes : []).map((node) => String((node as JsonObject).id));
  let inputSchema: JsonValue = {};
  try {
    inputSchema = graph.input_schema ? packageJson(pkg, String(graph.input_schema)) : {};
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  const properties = new Set(isJsonObject(inputSchema) && isJsonObject(inputSchema.properties) ? Object.keys(inputSchema.properties) : []);
  const exports = new Map<string, string>();
  for (const entry of (Array.isArray(graph.exports) ? graph.exports : []) as JsonObject[]) exports.set(String(entry.path), String(entry.format));

  const taskRaw = isJsonObject(raw.task) ? raw.task : {};
  const task: Record<string, string> = {};
  for (const [key, limit] of [
    ["prompt", MAX_TEXT],
    ["running_label", MAX_LABEL],
    ["completed_label", MAX_LABEL],
  ] as const) {
    const text = displayText(taskRaw[key], limit);
    if (text) task[key] = text;
  }
  const runLabel = displayText(taskRaw.run_label, MAX_RUN_LABEL);
  if (runLabel && /\brun\b/iu.test(runLabel)) task.run_label = runLabel;
  else if (runLabel) notes.push("run_label must say 'Run'; the host label is used instead");

  const labels: Record<string, string> = {};
  const rawLabels = isJsonObject(raw.nodes) ? raw.nodes : {};
  for (const [nodeId, label] of Object.entries(rawLabels)) {
    const text = displayText(label, MAX_LABEL);
    if (nodeIds.includes(nodeId) && text) labels[nodeId] = text;
  }

  const resultRaw = isJsonObject(raw.result) ? raw.result : {};
  const result: PresentationHints["result"] = {};
  const primary = resultRaw.primary_export;
  if (typeof primary === "string") {
    if (exports.get(primary) === "text") result.primary_export = primary;
    else notes.push("primary_export must name a declared text export; ignored");
  }
  const summary: Array<{ label: string; export: string }> = [];
  for (const entry of (Array.isArray(resultRaw.summary) ? resultRaw.summary : []).slice(0, MAX_SUMMARY)) {
    if (!isJsonObject(entry)) continue;
    const label = displayText(entry.label, MAX_LABEL);
    const exportPath = entry.export;
    if (label && typeof exportPath === "string" && exports.get(exportPath) === "json") summary.push({ label, export: exportPath });
    else notes.push("a summary entry without a label or a declared JSON export was ignored");
  }
  if (summary.length > 0) result.summary = summary;

  return [
    {
      schema: PRESENTATION_SCHEMA,
      task,
      input: inputHints(raw.input, properties, notes),
      nodes: labels,
      stages: stages(raw.stages, nodeIds, notes),
      result,
      noncritical: true,
    },
    notes.slice(0, 16),
  ];
}
