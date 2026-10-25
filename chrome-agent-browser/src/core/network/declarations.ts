/**
 * What a package may declare about a delegation network, checked at validation (network.v0 §2,
 * R-2…R-12, and R-22), before any host runs anything: `agentpkg/delegation/declarations.py`.
 *
 * Refusals are `ValidationError`s whose text starts with the specification's code, so that both
 * runtimes refuse a package with the same message (the conformance suite compares refusals).
 * Nothing here imports the interpreter: the control plane describes a network from this module.
 */
import { ValidationError } from "../errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import { packageJson, type Package } from "../package.js";
import { references, tokens } from "../references.js";
import { pyRepr } from "../repr.js";
import { PackageSchemas } from "../schema.js";
import { compareRelease } from "../version.js";
import { activationBound, activationCosts, DONE, networkNodes, networkOf, rolesOf, worstCase, type ActivationCosts, type WorstCase } from "./analysis.js";

export const NETWORK_MINIMUM_VERSION = "0.7.0";
export const MAX_ROLES = 16;
export const MAX_HOPS = 64;
export const MAX_STATE_KEYS = 64;
/** The sources a role's program may read: its view of the shared state, the message it was handed, and its earlier steps. */
export const ROLE_SOURCES: readonly string[] = ["state", "message", "steps"];
/** An answer check of an `llm` step reads the answer as `result` (workflow.v0 §5), the one source beyond the three, and only there. */
export const CHECK_SOURCES: readonly string[] = [...ROLE_SOURCES, "result"];

function refuse(code: string, message: string): ValidationError {
  return Object.assign(new ValidationError(`${code}: ${message}`), { code });
}

type Documents = ReadonlyMap<string, JsonValue>;
type Schema = [schema: JsonValue, path: string];
type Env = Record<string, Schema | Record<string, Schema>>;

export interface NetworkHooks {
  documents: Documents;
  schema: (path: unknown, label: string) => Schema;
  expression: (value: JsonValue, env: Env, label: string, role?: string | null, nodeId?: string | null) => void;
  operation: (node: JsonObject, role: string, env: Env, label: string, nodeId: string | null) => void;
  nodes: ReadonlyMap<string, JsonObject>;
  files: ReadonlyMap<string, Uint8Array>;
  schemaPaths: ReadonlySet<string>;
}

/**
 * Every value constructor of a role's program, with a label and the sources it may read: step
 * inputs, conditions, assertions and checks, the writes, and the route's input or message.
 */
function constructors(role: JsonObject): Array<[label: string, value: JsonValue, sources: readonly string[]]> {
  const found: Array<[string, JsonValue, readonly string[]]> = [];
  for (const step of role.steps as JsonObject[]) {
    const label = `step ${step.id}`;
    found.push([`${label}/input`, step.input!, ROLE_SOURCES]);
    if ("when" in step) {
      const when = step.when as JsonObject;
      found.push([`${label}/when/left`, when.left!, ROLE_SOURCES]);
      found.push([`${label}/when/right`, when.right!, ROLE_SOURCES]);
      found.push([`${label}/otherwise`, step.otherwise!, ROLE_SOURCES]);
    }
    for (const [key, sources] of [["assertions", ROLE_SOURCES], ["checks", CHECK_SOURCES]] as const) {
      ((step[key] as JsonObject[] | undefined) ?? []).forEach((rule, index) => {
        for (const field of ["left", "right", "rows", "targets", "equals"]) {
          if (field in rule) found.push([`${label}/${key}/${index}/${field}`, rule[field]!, sources]);
        }
      });
    }
  }
  for (const [pointer, value] of Object.entries(role.writes as JsonObject)) found.push([`writes/${pointer}`, value, ROLE_SOURCES]);
  const route = role.route as JsonObject;
  if ("task" in route) found.push(["route/input", route.input!, ROLE_SOURCES]);
  else found.push(["route/message", route.message!, ROLE_SOURCES]);
  return found;
}

export interface NetworkDeclarations {
  node: string;
  roles: string[];
  bound: WorstCase;
}

/**
 * The network object, the one node that runs it, the roles against the workers, the edges, the
 * state views, the programs and the bound against the package's own budget; called by
 * `validateWorkflow` after the top-level nodes were checked. A graph without a network returns null
 * (and may hold no `network` node).
 */
export async function checkNetworkDeclarations(manifest: JsonObject, graph: JsonObject, policy: JsonObject, hooks: NetworkHooks): Promise<NetworkDeclarations | null> {
  const network = networkOf(graph);
  const runners = networkNodes(graph);
  const coordinator = String(graph.coordinator);
  if (network === null) {
    if (runners.length > 0) {
      throw refuse("network_without_declaration", `node ${runners[0]!.id}: a network node runs the graph's network, and the graph declares none`);
    }
    return null;
  }
  if (compareRelease(String((manifest.runtime as JsonObject).minimum_version), NETWORK_MINIMUM_VERSION) < 0) {
    throw refuse("network_minimum_version", `a network requires runtime.minimum_version ${NETWORK_MINIMUM_VERSION} or later`);
  }
  if (runners.length === 0) throw refuse("network_node_required", "the graph declares a network and no node of type network");
  if (runners.length > 1) throw refuse("network_node_once", `a graph runs its network in one node; ${runners.length} nodes of type network`);
  const runner = runners[0]!;
  if (runner.worker !== coordinator) {
    throw refuse("network_node_role", `node ${runner.id}: the network node runs on the coordinator; its roles are the workers it activates`);
  }
  const workers = new Map((graph.workers as JsonObject[]).map((worker) => [String(worker.id), worker]));
  const roles = rolesOf(network);
  const roleIds = Object.keys(roles);
  if (roleIds.length > MAX_ROLES) throw refuse("network_roles", `a network declares at most ${MAX_ROLES} roles`);
  for (const roleId of roleIds) {
    if (roleId === DONE) throw refuse("network_role_reserved", `${pyRepr(DONE)} is the end, not a role`);
    if (!workers.has(roleId)) throw refuse("network_role_unknown", `role ${pyRepr(roleId)} is not a declared worker`);
    if (roleId === coordinator) throw refuse("network_role_coordinator", `role ${pyRepr(roleId)} is the coordinator, which routes nothing`);
  }
  for (const node of hooks.nodes.values()) {
    if (Object.hasOwn(roles, String(node.worker))) {
      throw refuse("network_worker_shared", `node ${node.id}: worker ${pyRepr(String(node.worker))} is a network role and runs only inside the network`);
    }
  }
  if (!Object.hasOwn(roles, String(network.entry))) throw refuse("network_entry_unknown", `entry ${pyRepr(String(network.entry))} is not a role`);
  for (const [roleId, role] of Object.entries(roles)) {
    const seen = new Set<string>();
    for (const edge of role.edges as JsonObject[]) {
      const to = String(edge.to);
      if (!Object.hasOwn(roles, to)) throw refuse("network_edge_unknown", `role ${roleId}: edge to undeclared role ${pyRepr(to)}`);
      if (seen.has(to)) throw refuse("network_edge_duplicate", `role ${roleId}: two edges to ${pyRepr(to)}`);
      seen.add(to);
    }
    if ((role.edges as JsonValue[]).length === 0 && role.may_end !== true) {
      throw refuse("network_role_dead_end", `role ${roleId}: no edge and may_end false, so no activation of it could end`);
    }
  }
  const statePath = String(network.state_schema);
  if (!hooks.schemaPaths.has(statePath)) throw refuse("network_state_schema_undeclared", `network.state_schema ${pyRepr(statePath)} is not a declared schema`);
  const stateSchema = hooks.documents.get(statePath)!;
  const properties = isJsonObject(stateSchema) ? stateSchema.properties : undefined;
  if (!isJsonObject(stateSchema) || stateSchema.type !== "object" || stateSchema.additionalProperties !== false || !isJsonObject(properties ?? null) || Object.keys(properties as JsonObject).length > MAX_STATE_KEYS) {
    throw refuse("network_state_schema_open", `${statePath}: the shared state is a closed object schema (type object, additionalProperties false) of at most ${MAX_STATE_KEYS} properties`);
  }
  const keys = new Set(Object.keys(properties as JsonObject));
  for (const roleId of roleIds) {
    const worker = workers.get(roleId)!;
    const view = new Set([...(worker.state_read as JsonValue[]), ...(worker.state_write as JsonValue[])].map(String));
    const outside = [...view].filter((key) => !keys.has(key)).sort();
    if (outside.length > 0) {
      throw refuse("network_state_key_undeclared", `role ${roleId}: state view names ${pyRepr(outside[0]!)}, which the network's state schema ${statePath} does not declare`);
    }
  }
  const initial = network.initial as JsonObject;
  if (!isJsonObject(initial) || !("literal" in initial)) throw refuse("network_initial_literal", "network.initial must be a literal");
  const schemas = await PackageSchemas.open(hooks.files, hooks.schemaPaths);
  try {
    await schemas.validateInstance(statePath, initial.literal!, "network.initial");
  } catch (error) {
    if (error instanceof ValidationError) throw refuse("network_initial_invalid", error.message);
    throw error;
  } finally {
    schemas.close();
  }
  // Read before initialization (R-6): a patch sets keys and never removes one, so a key that
  // `initial` sets is present in every later state, and a key it does not set may be absent when a
  // role reads it (the order of writes is the model's). Every key of a role's view is set by `initial`.
  const initialized = new Set(isJsonObject(initial.literal ?? null) ? Object.keys(initial.literal as JsonObject) : []);
  for (const roleId of roleIds) {
    const missing = [...new Set((workers.get(roleId)!.state_read as JsonValue[]).map(String))].filter((key) => !initialized.has(key)).sort();
    if (missing.length > 0) {
      throw refuse(
        "network_state_read_uninitialized",
        `role ${roleId}: state view reads ${pyRepr(missing[0]!)}, which network.initial does not set (a key read by a role is set by initial, since the order of the roles' writes is chosen at run time)`,
      );
    }
  }
  const messagePath = String(network.message_schema);
  if (!hooks.schemaPaths.has(messagePath)) throw refuse("network_message_schema_undeclared", `network.message_schema ${pyRepr(messagePath)} is not a declared schema`);
  const tasks = new Set(((manifest.model_requirements as JsonObject).tasks as JsonObject[]).map((task) => String(task.id)));
  for (const [roleId, role] of Object.entries(roles)) {
    const worker = workers.get(roleId)!;
    const stateRead = (worker.state_read as JsonValue[]).map(String);
    const label = `network role ${roleId}`;
    // The view first (R-8): a program reads its own view of the shared state, the message and its
    // earlier steps; a read outside the view is refused by name before the generic scope check.
    for (const [name, value, sources] of constructors(role)) {
      for (const [source, pointer] of references(value)) {
        if (!sources.includes(source)) {
          throw refuse("network_source_scope", `${label}/${name}: source ${pyRepr(source)} is not available inside a role (the sources are ${sources.join(", ")})`);
        }
        const parts = tokens(pointer);
        if (source === "state" && (parts.length === 0 || !stateRead.includes(parts[0]!))) {
          throw refuse("network_state_read_outside_view", `${label}/${name}: reads ${pyRepr(pointer)} outside the role's state_read view`);
        }
      }
    }
    const env: Env = { state: [stateSchema, statePath], message: [hooks.documents.get(messagePath)!, messagePath], steps: {} };
    const seen = new Set<string>();
    for (const step of role.steps as JsonObject[]) {
      const stepId = String(step.id);
      if (seen.has(stepId)) throw refuse("network_step_duplicate", `${label}: two steps named ${pyRepr(stepId)}`);
      seen.add(stepId);
      hooks.operation(step, roleId, env, `${label}/${stepId}`, null);
      (env.steps as Record<string, Schema>)[stepId] = hooks.schema(step.output_schema, label);
    }
    const stateWrite = (worker.state_write as JsonValue[]).map(String);
    for (const [pointer, value] of Object.entries(role.writes as JsonObject)) {
      const parts = tokens(pointer);
      if (parts.length !== 1 || !stateWrite.includes(parts[0]!)) {
        throw refuse("network_state_write_outside_view", `${label}: writes ${pyRepr(pointer)}, which is not one key of the role's state_write view`);
      }
      hooks.expression(value, env, `${label}/writes/${pointer}`, roleId, null);
    }
    const route = role.route as JsonObject;
    if ("task" in route) {
      if (!tasks.has(String(route.task))) throw refuse("network_route_task_unknown", `${label}: route task ${pyRepr(String(route.task))} is not a declared model task`);
      hooks.expression(route.input!, env, `${label}/route/input`, roleId, null);
    } else {
      if (route.next === DONE) {
        if (role.may_end !== true) throw refuse("network_end_not_allowed", `${label}: the route ends the network and may_end is false`);
      } else if (!(role.edges as JsonObject[]).some((edge) => edge.to === route.next)) {
        throw refuse("network_edge_undeclared", `${label}: the route hands off to ${pyRepr(String(route.next))} and no edge to it is declared`);
      }
      hooks.expression(route.message!, env, `${label}/route/message`, roleId, null);
    }
  }
  for (const [source, pointer] of references(network.result!)) {
    const parts = tokens(pointer);
    if (source === "state" && parts.length > 0 && !initialized.has(parts[0]!)) {
      throw refuse("network_state_read_uninitialized", `network.result: reads ${pyRepr(parts[0]!)}, which network.initial does not set`);
    }
  }
  hooks.expression(network.result!, { state: [stateSchema, statePath], message: [hooks.documents.get(messagePath)!, messagePath] }, "network.result");
  // The bound against the package's own budgets (R-22): what the page says the network can spend at
  // most must be what the package lets it spend.
  const bound = worstCase(graph, policy);
  const budget = policy.budget as JsonObject;
  if (bound.relaxation.tokens > (budget.hard_tokens as number)) {
    throw refuse("network_bound_exceeds_budget", `the network's worst case is ${bound.relaxation.tokens} tokens, above the package's hard_tokens of ${budget.hard_tokens}`);
  }
  if (bound.relaxation.remote_calls > (budget.max_remote_calls as number)) {
    throw refuse("network_bound_exceeds_budget", `the network's worst case is ${bound.relaxation.remote_calls} remote calls, above the package's max_remote_calls of ${budget.max_remote_calls}`);
  }
  return { node: String(runner.id), roles: roleIds, bound };
}

export interface RoleRecord extends JsonObject {
  id: string;
  description: string;
  skills: string[];
  tools: string[];
  steps: Array<{ id: string; type: string }>;
  route: JsonObject & ({ kind: "chosen"; task: string } | { kind: "fixed"; next: string });
  edges: Array<{ to: string; max_uses: number }>;
  may_end: boolean;
  max_activations: number | null;
  activation_bound: number;
  timeout_seconds: number;
  budget: { tokens: number; remote_calls: number };
  state_read: string[];
  state_write: string[];
  per_activation: ActivationCosts & JsonObject;
}

export interface NetworkRecords extends JsonObject {
  node: string | null;
  entry: string;
  max_hops: number;
  state_schema: string;
  state_keys: string[];
  message_schema: string;
  roles: RoleRecord[];
  worst_case: WorstCase;
}

/**
 * The network as `inspect` and the agent page list it (R-24): the entry, the hop cap, the schemas,
 * each role with its program's shape, its edges and its activation bound, and the worst case under
 * the package's own budgets.
 */
export function networkRecords(pkg: Package): NetworkRecords | null {
  const graph = pkg.graph;
  const network = networkOf(graph);
  if (network === null) return null;
  const runners = networkNodes(graph);
  const workers = new Map((graph.workers as JsonObject[]).map((worker) => [String(worker.id), worker]));
  const roles: RoleRecord[] = Object.entries(rolesOf(network)).map(([roleId, role]) => {
    const worker = workers.get(roleId)!;
    const route = role.route as JsonObject;
    const steps = role.steps as JsonObject[];
    return {
      id: roleId,
      description: String(role.description),
      skills: (worker.skills as JsonValue[]).map(String),
      tools: [...new Set(steps.filter((step) => step.type === "tool").map((step) => String(step.tool)))].sort(),
      steps: steps.map((step) => ({ id: String(step.id), type: String(step.type) })),
      route: ("task" in route ? { kind: "chosen", task: String(route.task) } : { kind: "fixed", next: String(route.next) }) as RoleRecord["route"],
      edges: (role.edges as JsonObject[]).map((edge) => ({ ...edge }) as { to: string; max_uses: number }),
      may_end: role.may_end === true,
      max_activations: (role.max_activations as number | undefined) ?? null,
      activation_bound: activationBound(network, roleId),
      timeout_seconds: role.timeout_seconds as number,
      budget: { ...(worker.budget as JsonObject) } as { tokens: number; remote_calls: number },
      state_read: (worker.state_read as JsonValue[]).map(String),
      state_write: (worker.state_write as JsonValue[]).map(String),
      per_activation: activationCosts(graph, roleId) as ActivationCosts & JsonObject,
    };
  });
  const stateDocument = packageJson(pkg, String(network.state_schema));
  return {
    node: runners.length > 0 ? String(runners[0]!.id) : null,
    entry: String(network.entry),
    max_hops: network.max_hops as number,
    state_schema: String(network.state_schema),
    state_keys: Object.keys(isJsonObject(stateDocument) && isJsonObject(stateDocument.properties) ? stateDocument.properties : {}),
    message_schema: String(network.message_schema),
    roles,
    worst_case: worstCase(graph, pkg.policy),
  };
}
