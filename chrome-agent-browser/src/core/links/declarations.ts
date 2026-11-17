/**
 * What a package may declare about links, checked at validation (link.v0 §2 and L-21), before any
 * host fetches or runs anything (`agentpkg/links/declarations.py`, line for line).
 *
 * Refusals are `ValidationError`s whose text starts with the specification's code, so that both
 * runtimes refuse a package with the same message. Only the caller's own package is read here:
 * what needs a linked package's declaration (its digest, its profile, the composed bound of a
 * planned link) is checked at preparation, by `resolve`. Nothing here imports the interpreter.
 */
import { ValidationError } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import { tokens } from "../references.js";
import { pyRepr } from "../repr.js";
import { compareRelease } from "../version.js";
import { codepoint, composedRequirement, linkOperations } from "./analysis.js";

export const LINK_MINIMUM_VERSION = "0.8.0";
export const MAX_DEPENDENCIES = 8;
export const MAX_SLOTS = 2;
export const MAX_LOCATE_REFERENCES = 3;
export const MAX_REASON_CHARS = 500;
/** The members of a slot step's outcome, which the runtime builds (L-8). */
export const OUTCOME_MEMBERS = ["joined", "reason", "result"] as const;
/** What `locate` may read (L-7): the run's own input and a tool step's result. */
export const LOCATE_SOURCES: readonly string[] = ["input", "steps"];

type Schema = [schema: JsonValue, path: string];
type Env = Record<string, Schema | Record<string, Schema>>;

/** What `validateWorkflow` hands the check: its documents and its scope helpers. */
export interface LinkDeclarationHooks {
  documents: ReadonlyMap<string, JsonValue>;
  schema: (path: unknown, label: string) => Schema;
  expression: (value: JsonValue, env: Env, label: string, role?: string | null, nodeId?: string | null) => void;
  atSchema: (schema: JsonValue, parts: string[], path: string, label: string) => JsonValue;
}

function refuse(code: string, message: string): ValidationError {
  return Object.assign(new ValidationError(`${code}: ${message}`), { code });
}

/**
 * The references of a `locate` constructor in order, or null when it has another form: a
 * reference, an `array` of references, or a `coalesce` of those (L-7).
 */
export function locateReferences(locate: JsonValue | undefined): JsonObject[] | null {
  if (locate === null || typeof locate !== "object" || Array.isArray(locate)) return null;
  if ("from" in locate) return [locate];
  const members = (locate.array ?? locate.coalesce) as JsonValue | undefined;
  if (members === undefined || Object.keys(locate).some((key) => key !== "array" && key !== "coalesce")) return null;
  if (!Array.isArray(members)) return null;
  const found: JsonObject[] = [];
  for (const member of members) {
    const inner = locateReferences(member);
    if (inner === null) return null;
    found.push(...inner);
  }
  return found;
}

/** A string of `format: uri`, nullable allowed. */
function isUriString(schema: JsonValue): boolean {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return false;
  for (const union of ["anyOf", "oneOf"] as const) {
    if (union in schema) {
      const choices = schema[union] as JsonValue[];
      return choices.some((choice) => isUriString(choice)) && choices.every((choice) => isUriString(choice) || isNullSchema(choice));
    }
  }
  const declared = schema.type;
  const kinds = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared.map(String) : [];
  return schema.format === "uri" && kinds.includes("string") && kinds.every((kind) => kind === "string" || kind === "null");
}

const isNullSchema = (schema: JsonValue): boolean => schema !== null && typeof schema === "object" && !Array.isArray(schema) && Object.keys(schema).length === 1 && schema.type === "null";

/**
 * The dependency records, every `link` step against them, the slots (their place, their `locate`,
 * their request task, their outcome schema, the caps) and the slots' ceilings against the package's
 * own budget; called by `validateWorkflow` after the nodes and the network were checked. A package
 * without a dependency or a `link` step returns null.
 */
export function checkLinkDeclarations(manifest: JsonObject, graph: JsonObject, policy: JsonObject, hooks: LinkDeclarationHooks): { dependencies: string[]; slots: string[] } | null {
  const dependencies = (manifest.dependencies as JsonObject[] | undefined) ?? [];
  const operations = linkOperations(graph);
  if (dependencies.length === 0 && operations.length === 0) return null;
  if (compareRelease(String((manifest.runtime as JsonObject).minimum_version), LINK_MINIMUM_VERSION) < 0) {
    throw refuse("link_minimum_version", `a dependency or a link step requires runtime.minimum_version ${LINK_MINIMUM_VERSION} or later`);
  }
  if (dependencies.length > MAX_DEPENDENCIES) throw refuse("link_caps", `a package declares at most ${MAX_DEPENDENCIES} dependencies`);
  const records = new Map<string, JsonObject>();
  for (const record of dependencies) {
    if (!("id" in record)) throw refuse("link_dependency_unused", `dependency ${pyRepr(String(record.package_id))} carries no id, so no link step can name it`);
    const id = String(record.id);
    if (records.has(id)) throw refuse("link_dependency_duplicate", `two dependencies named ${pyRepr(id)}`);
    if (!String(record.locator).startsWith("https://")) throw refuse("link_locator_scheme", `dependency ${pyRepr(id)}: a link's locator is an https:// URL`);
    if (record.package_id === manifest.package_id) throw refuse("link_nested", `dependency ${pyRepr(id)} names this package itself (a cycle)`);
    records.set(id, record);
  }
  for (const entry of (graph.exports as JsonObject[] | undefined) ?? []) {
    const name = String(entry.path).toLowerCase();
    // The host writes the run's links and each inner run's record under these names.
    if (name === "links.json" || name.startsWith("link-")) throw new ValidationError(`duplicate or reserved export path ${name}`);
  }
  const used = new Set<string>();
  const slots: Array<[label: string, step: JsonObject, role: string]> = [];
  for (const [label, step, where, roleId] of operations) {
    if ("slot" in step) {
      if (where !== "role") throw refuse("link_slot_scope", `link step ${label}: a slot is a step of a network role's program`);
      slots.push([label, step, roleId!]);
    } else {
      const dependency = String(step.dependency);
      if (!records.has(dependency)) throw refuse("link_dependency_unknown", `link step ${label}: dependency ${pyRepr(dependency)} is not declared`);
      used.add(dependency);
    }
  }
  const unused = [...records.keys()].filter((id) => !used.has(id)).sort(codepoint);
  if (unused.length > 0) throw refuse("link_dependency_unused", `dependency ${pyRepr(unused[0]!)} is declared and no link step names it`);
  if (slots.length > MAX_SLOTS) throw refuse("link_caps", `a graph holds at most ${MAX_SLOTS} slot steps`);
  const names = slots.map(([, step]) => String(step.slot));
  for (const name of names) {
    if (names.filter((other) => other === name).length > 1) throw refuse("link_slot_duplicate", `two slot steps named ${pyRepr(name)}`);
    // A slot and a dependency share the names of the usage record and the audit.
    if (records.has(name)) throw refuse("link_slot_duplicate", `slot ${pyRepr(name)} is named as a dependency is`);
  }
  for (const [label, step, roleId] of slots) checkSlot(label, step, roleId, manifest, graph, hooks);
  // A slot's ceiling is this package's own declaration, so its place in the bound is checked here
  // (L-21); a planned link's needs the linked declaration and waits for preparation.
  const excess = composedRequirement(graph, policy);
  if (excess !== null) {
    const [name, needed, cap] = excess;
    throw refuse("link_bound_exceeds_budget", `with its slots at their ceilings the package's worst case is ${needed} ${name.replaceAll("_", " ")}, above its own budget of ${cap}`);
  }
  return { dependencies: [...records.keys()].sort(codepoint), slots: [...names].sort(codepoint) };
}

function checkSlot(label: string, step: JsonObject, roleId: string, manifest: JsonObject, graph: JsonObject, hooks: LinkDeclarationHooks): void {
  const name = `link step ${label}`;
  const view = step.input;
  if (view === null || typeof view !== "object" || Array.isArray(view) || Object.keys(view).length !== 1 || !("object" in view) || view.object === null || typeof view.object !== "object" || Array.isArray(view.object)) {
    // The join card states the view by the names of its fields (L-34): a reference or any other
    // constructor would hand the request-building call a value the card cannot name.
    throw refuse("link_slot_input", `${name}: a slot's input is an object constructor, whose fields are the view`);
  }
  const tasks = new Set(((manifest.model_requirements as JsonObject).tasks as JsonObject[]).map((task) => String(task.id)));
  const request = step.request as JsonObject;
  if (!tasks.has(String(request.task))) throw refuse("link_request_task_unknown", `${name}: request task ${pyRepr(String(request.task))} is not a declared model task`);
  const outcome = hooks.documents.get(String(step.output_schema));
  const properties = outcome !== null && typeof outcome === "object" && !Array.isArray(outcome) ? outcome.properties : undefined;
  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    (outcome as JsonObject).type !== "object" ||
    (outcome as JsonObject).additionalProperties !== false ||
    Object.keys(properties).length !== OUTCOME_MEMBERS.length ||
    !OUTCOME_MEMBERS.every((member) => Object.hasOwn(properties, member))
  ) {
    throw refuse("link_slot_outcome_schema", `${name}: a slot's output_schema is a closed object over ${OUTCOME_MEMBERS.join(", ")}, which the runtime builds`);
  }
  const network = graph.network as JsonObject;
  const role = (network.roles as Record<string, JsonObject>)[roleId]!;
  const earlier = new Map<string, JsonObject>();
  for (const other of role.steps as JsonObject[]) {
    if (other === step) break;
    earlier.set(String(other.id), other);
  }
  const references = locateReferences(step.locate);
  if (references === null) throw refuse("link_locate_source", `${name}: locate is a reference, an array of references or a coalesce of those`);
  if (references.length > MAX_LOCATE_REFERENCES) throw refuse("link_caps", `${name}: locate names at most ${MAX_LOCATE_REFERENCES} references`);
  for (const reference of references) {
    const source = String(reference.from);
    let parts = tokens(String(reference.path));
    if (!LOCATE_SOURCES.includes(source)) {
      throw refuse("link_locate_source", `${name}: locate reads ${pyRepr(source)}; it may read only the run's input or a tool step's result, never something a model can write`);
    }
    let root: JsonValue;
    let path: string;
    if (source === "input") {
      [root, path] = hooks.schema(graph.input_schema, name);
    } else {
      const producer = parts.length > 0 ? earlier.get(parts[0]!) : undefined;
      if (producer === undefined || producer.type !== "tool") {
        throw refuse("link_locate_source", `${name}: locate reads steps${pyRepr(String(reference.path))}, which is not the result of an earlier tool step of this role`);
      }
      [root, path] = hooks.schema(producer.output_schema, name);
      parts = parts.slice(1);
    }
    let target: JsonValue;
    try {
      target = hooks.atSchema(root, parts, path, `${name}/locate`);
    } catch (error) {
      if (error instanceof ValidationError) throw refuse("link_locate_source", error.message);
      throw error;
    }
    if (!isUriString(target)) throw refuse("link_locate_source", `${name}: locate reads ${source}${pyRepr(String(reference.path))}, whose schema is not a string of format uri`);
  }
  if ("reason" in step) {
    const steps: Record<string, Schema> = {};
    for (const [key, other] of earlier) steps[key] = hooks.schema(other.output_schema, name);
    const env: Env = { state: hooks.schema(network.state_schema, name), message: hooks.schema(network.message_schema, name), steps };
    hooks.expression(step.reason!, env, `${name}/reason`, roleId, null);
  }
}
