/**
 * Offline semantic checks for the `workflow.v0` execution profile, mirroring
 * `agentpkg/workflow_validation.py`: the graph is a DAG with one output node, every
 * projection stays inside the role's declared state view and the declared schemas, writes
 * target one authorized key each, unordered conflicting accesses are refused, reads happen
 * after initialization, exports are safe names, and a declared fixture is schema-checked
 * and consistent. Nothing here executes anything (D-007).
 */
import { safeName } from "./archive.js";
import { checkComputeDeclarations } from "./compute/declarations.js";
import { checkConversationDeclarations, conversationInitialEnv } from "./conversation/declarations.js";
import { canonicalString } from "./canonical.js";
import { ValidationError } from "./errors.js";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "./json.js";
import { references, schemaReference, select, tokens, unique } from "./references.js";
import { pyRepr } from "./repr.js";
import { PackageSchemas, validateDocument } from "./schema.js";
import { compareRelease } from "./version.js";

type Documents = Map<string, JsonValue>;
type Schema = [schema: JsonValue, path: string];
/** The Python env dict: sources map to `(schema, path)`; `steps` maps step ids to the same. */
type Env = Record<string, Schema | Record<string, Schema>>;

const RESERVED_EXPORTS = new Set(["result.json", "audit.json", "usage.json", "provenance.json"]);
/** The first runtime that evaluates answer checks (`checks` on an llm node or map llm step; D-150). */
export const CHECKS_MINIMUM_VERSION = "0.3.0";

function declaresChecks(graph: JsonObject): boolean {
  return (graph.nodes as JsonValue[]).some((raw) => {
    const node = raw as JsonObject;
    return "checks" in node || ((node.steps as JsonValue[] | undefined) ?? []).some((step) => "checks" in (step as JsonObject));
  });
}

/** `workflow_validation.py::_at_schema`: reject statically impossible pointers. */
function atSchema(
  schema: JsonValue,
  parts: string[],
  path: string,
  documents: Documents,
  label: string,
  seen: Set<string> = new Set(),
): JsonValue {
  if (schema === true || (isJsonObject(schema) && Object.keys(schema).length === 0)) return {};
  if (!isJsonObject(schema)) throw new ValidationError(`${label}: projection targets a forbidden schema`);
  if ("$ref" in schema) {
    const [target, fragment] = schemaReference(path, String(schema.$ref));
    const key = JSON.stringify([target, fragment, parts]);
    if (seen.has(key)) throw new ValidationError(`${label}: recursive projection cannot be resolved`);
    const document = documents.get(target);
    if (document === undefined) throw new ValidationError(`${path}: missing or undeclared schema reference ${pyRepr(target)}`);
    return atSchema(select(document, fragment, label), parts, target, documents, label, new Set([...seen, key]));
  }
  if (parts.length === 0) return schema;
  for (const union of ["anyOf", "oneOf", "allOf"] as const) {
    if (union in schema) {
      for (const choice of schema[union] as JsonValue[]) {
        try {
          return atSchema(choice, parts, path, documents, label, seen);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
        }
      }
      throw new ValidationError(`${label}: no schema alternative contains projection`);
    }
  }
  const [key, ...rest] = parts as [string, ...string[]];
  let child: JsonValue;
  if (schema.type === "array") {
    if (!/^[0-9]+$/u.test(key) || String(Number(key)) !== key) {
      throw new ValidationError(`${label}: array projection needs a canonical numeric index`);
    }
    child = schema.items ?? {};
  } else {
    const declared = schema.type ?? ["object"];
    const types = typeof declared === "string" ? [declared] : (declared as JsonValue[]);
    if (!types.includes("object")) throw new ValidationError(`${label}: cannot traverse a scalar schema`);
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    // `properties.get(key)`: an own property only, never `Object.prototype`'s.
    child = (Object.hasOwn(properties, key) ? properties[key] : undefined) ?? schema.additionalProperties ?? true;
    if (child === false) throw new ValidationError(`${label}: state/data path component ${pyRepr(key)} not declared`);
  }
  return atSchema(child, rest, path, documents, label, seen);
}

/** `workflow_validation.py::validate_workflow`. */
export async function validateWorkflow(
  manifest: JsonObject,
  graph: JsonObject,
  policy: JsonObject,
  tools: Record<string, JsonObject>,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  if (manifest.entrypoint !== "workflow.v0") throw new ValidationError("workflow.v0 graph requires entrypoint workflow.v0");
  if (declaresChecks(graph) && compareRelease(String((manifest.runtime as JsonObject).minimum_version), CHECKS_MINIMUM_VERSION) < 0) {
    // An older runtime would refuse the unknown field anyway; declaring the minimum makes it refuse
    // the package by its version, with the reason a person can act on.
    throw new ValidationError("answer checks require runtime.minimum_version 0.3.0 or later");
  }
  // compute.v0 (agentpkg 0.5.0, Chrome core 0.3.0): the modules, the members, the nodes' functions
  // and the permission agree before anything else is checked; a graph without any of it passes.
  checkComputeDeclarations(manifest, graph, policy, files);
  const schemaPaths = new Set((manifest.schemas as JsonValue[]).map((entry) => String((entry as JsonObject).path)));
  const documents: Documents = new Map();
  for (const path of schemaPaths) documents.set(path, parseJson(files.get(path)!, path));
  const workers = new Map((graph.workers as JsonValue[]).map((worker) => [String((worker as JsonObject).id), worker as JsonObject]));
  const tasks = new Set(((manifest.model_requirements as JsonObject).tasks as JsonValue[]).map((task) => String((task as JsonObject).id)));
  const nodes = unique(graph.nodes as JsonValue[], "workflow nodes");
  const memory = policy.memory as JsonObject;
  const statePath = String(memory.state_schema);
  const coordinator = String(graph.coordinator);
  const delegation = policy.delegation as JsonObject;
  const budget = policy.budget as JsonObject;
  if (delegation.max_depth !== 1 || delegation.allow_remote) {
    throw new ValidationError("workflow.v0 requires local delegation max_depth=1");
  }
  if ([...workers.values()].some((worker) => worker.kind !== "packaged")) {
    throw new ValidationError("workflow.v0 supports packaged workers only");
  }
  if (Object.values(tools).some((tool) => tool.retries !== 0 || tool.execution === "agent")) {
    throw new ValidationError("workflow.v0 supports local/remote tools with retries=0");
  }

  const schema = (path: unknown, label: string): Schema => {
    const text = String(path);
    if (!schemaPaths.has(text)) throw new ValidationError(`${label}: undeclared schema ${pyRepr(text)}`);
    return [documents.get(text)!, text];
  };
  schema(graph.input_schema, "workflow input");
  schema(graph.output_schema, "workflow output");

  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (nodeId: string): Set<string> => {
    if (visiting.has(nodeId)) throw new ValidationError(`workflow node ${nodeId}: cyclic dependency`);
    const known = ancestors.get(nodeId);
    if (known) return known;
    visiting.add(nodeId);
    const node = nodes.get(nodeId)!;
    const found = new Set<string>();
    for (const raw of node.depends_on as JsonValue[]) {
      const dependency = String(raw);
      if (!nodes.has(dependency)) throw new ValidationError(`workflow node ${nodeId}: unknown dependency ${pyRepr(dependency)}`);
      found.add(dependency);
      for (const item of visit(dependency)) found.add(item);
    }
    visiting.delete(nodeId);
    ancestors.set(nodeId, found);
    return found;
  };
  for (const nodeId of nodes.keys()) visit(nodeId);

  const outputs = [...nodes.values()].filter((node) => node.type === "output");
  if (outputs.length !== 1) throw new ValidationError("workflow requires exactly one output node");
  const output = outputs[0]!;
  const outputId = String(output.id);
  const others = new Set([...nodes.keys()].filter((id) => id !== outputId));
  const outputAncestors = ancestors.get(outputId)!;
  if (outputAncestors.size !== others.size || [...others].some((id) => !outputAncestors.has(id))) {
    throw new ValidationError(`output node ${outputId} must depend on every other node`);
  }
  if (output.output_schema !== graph.output_schema) {
    throw new ValidationError("output node schema must equal workflow output_schema");
  }

  const reads = new Map<string, Set<string>>([...nodes.keys()].map((id) => [id, new Set()]));
  const writes = new Map<string, Set<string>>([...nodes.keys()].map((id) => [id, new Set()]));

  const expression = (value: JsonValue, env: Env, label: string, role: string | null = null, nodeId: string | null = null): void => {
    for (const [source, pointer] of references(value)) {
      if (!Object.hasOwn(env, source)) throw new ValidationError(`${label}: source ${pyRepr(source)} is unavailable in this scope`);
      let parts = tokens(pointer);
      let root: JsonValue;
      let path: string;
      if (source === "state") {
        const stateRead = (workers.get(role!)!.state_read as JsonValue[]).map(String);
        if (parts.length === 0 || !stateRead.includes(parts[0]!)) {
          throw new ValidationError(`${label}: projection exceeds ${role} state_read`);
        }
        reads.get(nodeId!)!.add(parts[0]!);
      }
      if (source === "steps") {
        const steps = env.steps as Record<string, Schema>;
        if (parts.length === 0 || !Object.hasOwn(steps, parts[0]!)) throw new ValidationError(`${label}: unknown or forward step reference`);
        [root, path] = steps[parts[0]!]!;
        parts = parts.slice(1);
      } else {
        [root, path] = env[source] as Schema;
      }
      atSchema(root, parts, path, documents, label);
    }
  };

  // conversation.v0 (Chrome core 0.4.0): a conversational graph's initial state also reads the
  // persisted state, typed by the conversation's state schema; nowhere else (V-4).
  expression(graph.initial_state!, { input: schema(graph.input_schema, "input"), ...conversationInitialEnv(graph, documents, schemaPaths) }, "initial_state");

  const operation = (node: JsonObject, role: string, env: Env, label: string, nodeId: string): void => {
    schema(node.output_schema, label);
    expression(node.input!, env, `${label}/input`, role, nodeId);
    if ("when" in node) {
      const when = node.when as JsonObject;
      for (const side of ["left", "right"] as const) expression(when[side]!, env, `${label}/when`, role, nodeId);
      expression(node.otherwise!, env, `${label}/otherwise`, role, nodeId);
    }
    for (const assertion of (node.assertions as JsonValue[] | undefined) ?? []) {
      const record = assertion as JsonObject;
      for (const key of ["left", "right", "rows", "targets", "equals"] as const) {
        if (key in record) expression(record[key]!, env, `${label}/assertions/${key}`, role, nodeId);
      }
    }
    // Answer checks see the operation's own sources and the answer itself as `result`.
    const answerEnv: Env = { ...env, result: schema(node.output_schema, label) };
    for (const check of (node.checks as JsonValue[] | undefined) ?? []) {
      const record = check as JsonObject;
      for (const key of ["left", "right", "rows", "targets", "equals"] as const) {
        if (key in record) expression(record[key]!, answerEnv, `${label}/checks/${key}`, role, nodeId);
      }
    }
    const kind = node.type;
    if (kind === "compute") {
      // The constructed input is checked against the module's own input contract before the
      // call, as a tool's is; both schemas are declared package schemas.
      schema(node.input_schema, `${label}/input_schema`);
    }
    if (kind === "llm" && !tasks.has(String(node.task))) {
      throw new ValidationError(`${label}: undeclared model task ${pyRepr(node.task)}`);
    }
    if (kind === "tool") {
      const tool = String(node.tool);
      if (!Object.hasOwn(tools, tool)) throw new ValidationError(`${label}: unknown tool ${pyRepr(node.tool)}`);
      if (!(workers.get(role)!.tools as JsonValue[]).map(String).includes(tool)) {
        throw new ValidationError(`${label}: tool is not authorized for worker ${role}`);
      }
    }
    if (kind === "map") {
      if ("when" in node) throw new ValidationError(`${label}: map conditions unsupported; use an empty array`);
      const limit = Math.min(workers.get(role)!.max_instances as number, budget.max_parallel_workers as number);
      if ((node.max_parallel as number) > limit) throw new ValidationError(`${label}: max_parallel exceeds worker/package limits`);
      const item = schema(node.item_schema, `${label}/item_schema`);
      unique(node.steps as JsonValue[], `${label}/steps`);
      const stepEnv: Env = { ...env, item, steps: {} };
      for (const raw of node.steps as JsonValue[]) {
        const step = raw as JsonObject;
        operation(step, role, stepEnv, `${label}/${step.id}`, nodeId);
        (stepEnv.steps as Record<string, Schema>)[String(step.id)] = schema(step.output_schema, label);
      }
      expression(node.yield!, stepEnv, `${label}/yield`, role, nodeId);
    }
    if ((kind === "llm" || kind === "tool" || kind === "map") && role === coordinator) {
      throw new ValidationError(`${label}: effectful nodes require a non-coordinator worker`);
    }
  };

  for (const [nodeId, node] of nodes) {
    const role = String(node.worker);
    const label = `workflow node ${nodeId}`;
    if (!workers.has(role)) throw new ValidationError(`${label}: unknown worker ${pyRepr(role)}`);
    const env: Env = { state: [documents.get(statePath)!, statePath] };
    operation(node, role, env, label, nodeId);
    const stateWrite = (workers.get(role)!.state_write as JsonValue[]).map(String);
    for (const [pointer, value] of Object.entries(node.writes as JsonObject)) {
      const parts = tokens(pointer);
      if (parts.length !== 1 || !stateWrite.includes(parts[0]!)) {
        throw new ValidationError(`${label}: writes must target one authorized state_write key`);
      }
      writes.get(nodeId)!.add(parts[0]!);
      expression(value, { result: schema(node.output_schema, label) }, `${label}/writes/${pointer}`, role, nodeId);
    }
    if (node.type === "output" && Object.keys(node.writes as JsonObject).length > 0) {
      throw new ValidationError(`${label}: output cannot write state`);
    }
  }
  // Unordered conflicting accesses are invalid, independent of incidental array order.
  for (const a of nodes.keys()) {
    for (const b of nodes.keys()) {
      if (a === b || ancestors.get(b)!.has(a) || ancestors.get(a)!.has(b)) continue;
      const conflict = [...writes.get(a)!].filter((key) => reads.get(b)!.has(key) || writes.get(b)!.has(key)).sort();
      if (conflict.length > 0) {
        throw new ValidationError(`workflow nodes ${a}/${b}: unordered state conflict ${pyRepr(conflict)}; add a dependency`);
      }
    }
  }
  const initial = graph.initial_state as JsonObject;
  let initialKeys: Set<string> | null = null;
  if (isJsonObject(initial.object)) initialKeys = new Set(Object.keys(initial.object));
  else if (isJsonObject(initial.literal)) initialKeys = new Set(Object.keys(initial.literal));
  if (initialKeys !== null) {
    for (const nodeId of nodes.keys()) {
      const available = new Set(initialKeys);
      for (const dependency of ancestors.get(nodeId)!) for (const key of writes.get(dependency)!) available.add(key);
      const missing = [...reads.get(nodeId)!].filter((key) => !available.has(key)).sort();
      if (missing.length > 0) {
        throw new ValidationError(`workflow node ${nodeId}: read before initialization ${pyRepr(missing)}`);
      }
    }
  }
  const exported = new Set<string>();
  for (const raw of (graph.exports as JsonValue[] | undefined) ?? []) {
    const record = raw as JsonObject;
    const path = String(record.path);
    safeName(path);
    const name = path.toLowerCase();
    if (exported.has(name) || RESERVED_EXPORTS.has(name)) throw new ValidationError(`duplicate or reserved export path ${name}`);
    exported.add(name);
    expression(record.value!, { result: schema(graph.output_schema, "export") }, `export ${name}`);
  }
  if (graph.fixture) {
    const path = String(graph.fixture);
    const data = files.get(path);
    if (data === undefined) throw new ValidationError(`missing workflow fixture ${path}`);
    const fixture = parseJson(data, path) as JsonObject;
    await validateDocument(fixture, "workflow-fixture", path);
    const schemas = await PackageSchemas.open(files, schemaPaths);
    try {
      await schemas.validateInstance(String(graph.input_schema), fixture.input, "fixture input");
      const models = fixture.models as JsonObject;
      const fixtureTools = fixture.tools as JsonObject;
      for (const cases of [...Object.values(models), ...Object.values(fixtureTools)]) {
        const inputs = (cases as JsonValue[]).map((item) => canonicalString((item as JsonObject).input));
        if (new Set(inputs).size !== inputs.length) throw new ValidationError("fixture contains duplicate input cases");
      }
      if (Object.keys(models).some((task) => !tasks.has(task)) || Object.keys(fixtureTools).some((tool) => !Object.hasOwn(tools, tool))) {
        throw new ValidationError("fixture contains undeclared model task/tool");
      }
      for (const [toolId, cases] of Object.entries(fixtureTools)) {
        for (const raw of cases as JsonValue[]) {
          const item = raw as JsonObject;
          for (const field of ["input", "output"] as const) {
            await schemas.validateInstance(String(tools[toolId]![`${field}_schema`]), item[field], `fixture tool ${toolId} ${field}`);
          }
        }
      }
    } finally {
      schemas.close();
    }
  }
  // conversation.v0: the conversation object, the consent steps, the gate before every tool that
  // links a consented permission, and the fixture transcript; a graph without a conversation
  // passes (and may hold no consent step).
  await checkConversationDeclarations(manifest, graph, policy, tools, { documents, schema, expression: (value, env, label) => expression(value, env, label), ancestors, nodes, files, schemaPaths });
}
