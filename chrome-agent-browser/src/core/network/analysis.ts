/**
 * The worst case of a delegation network, computed from the declaration alone (network.v0 §3):
 * `agentpkg/delegation/analysis.py`, line for line.
 *
 * Pure arithmetic over the graph and the policy: no package is opened, no model is contacted, and
 * nothing here imports the interpreter, so the control plane may compute what the agent page says.
 *
 * - the **per-activation costs** of a role (model calls, tool calls per tool, compute calls, and
 *   the worker's own token and remote-call budgets, which the mediator enforces per instance);
 * - the **bound**: for each role the most activations any allowed walk can hold (R-20), and the
 *   greedy relaxation that maximizes each cost component over those counts under the hop cap
 *   (R-21), capped by the run's own limits: this is the normative "at most";
 * - the **enumerator** of every allowed walk (R-23), for tests and the evaluation: the exact
 *   maximum over walks is NP-hard in general, so it is never a plan figure.
 */
import type { JsonObject, JsonValue } from "../json.js";

export const DONE = "done";
/** The cost components of one activation that a walk sums. */
export const COMPONENTS = ["model_calls", "compute_calls", "remote_calls", "tokens", "seconds"] as const;
type Component = (typeof COMPONENTS)[number];
/** Walk prefixes an enumeration may visit before it gives up (deterministic, both runtimes). */
export const DEFAULT_EFFORT = 100_000;

/** The enumeration visited more walk prefixes than its effort cap allows. */
export class EffortExceeded extends Error {
  override readonly name = "EffortExceeded";
}

export interface ActivationCosts {
  model_calls: number;
  tool_calls: Record<string, number>;
  compute_calls: number;
  remote_calls: number;
  tokens: number;
  seconds: number;
}

export interface WorstCase extends JsonObject {
  max_hops: number;
  max_activations: number;
  activations: Record<string, number>;
  model_calls: number;
  tool_calls: Record<string, number>;
  compute_calls: number;
  remote_calls: number;
  tokens: number;
  seconds: number;
  relaxation: { model_calls: number; compute_calls: number; remote_calls: number; tokens: number; seconds: number; tool_calls: Record<string, number> };
  caps: { hard_tokens: number; max_remote_calls: number; max_calls_per_tool: Record<string, number>; timeout_seconds: number | null; deadline_seconds: number };
}

/** Where a walk is: uses of each edge (`from`→`to`) and activations of each role. */
export type Counts = Map<string, number>;
export const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;
const get = (counts: Counts, key: string): number => counts.get(key) ?? 0;

export function networkOf(graph: JsonObject): JsonObject | null {
  const value = graph.network;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function networkNodes(graph: JsonObject): JsonObject[] {
  return ((graph.nodes as JsonObject[] | undefined) ?? []).filter((node) => node.type === "network");
}

export function rolesOf(network: JsonObject): Record<string, JsonObject> {
  return network.roles as Record<string, JsonObject>;
}

function runnerId(graph: JsonObject): string {
  const nodes = networkNodes(graph);
  return nodes.length > 0 ? String(nodes[0]!.id) : "network";
}

/** Every step of every role, with its qualified identity `<node>/<role>/<step>`. */
export function roleSteps(graph: JsonObject): Array<[string, JsonObject]> {
  const network = networkOf(graph);
  if (network === null) return [];
  const nodeId = runnerId(graph);
  const found: Array<[string, JsonObject]> = [];
  for (const [roleId, role] of Object.entries(rolesOf(network))) {
    for (const step of role.steps as JsonObject[]) found.push([`${nodeId}/${roleId}/${step.id}`, step]);
  }
  return found;
}

/** Every model-chosen route, as the one model call it is (`<node>/<role>/route`). */
export function routeCalls(graph: JsonObject): Array<[string, JsonObject]> {
  const network = networkOf(graph);
  if (network === null) return [];
  const nodeId = runnerId(graph);
  const found: Array<[string, JsonObject]> = [];
  for (const [roleId, role] of Object.entries(rolesOf(network))) {
    const route = role.route as JsonObject;
    if ("task" in route) found.push([`${nodeId}/${roleId}/route`, route]);
  }
  return found;
}

/**
 * What one activation of a role can cost at most (R-19): each step runs at most once (a
 * conditional one counts as taken), a chosen route is one model call, and the worker's budgets
 * bound its tokens and remote calls per instance.
 */
export function activationCosts(graph: JsonObject, roleId: string): ActivationCosts {
  const role = rolesOf(networkOf(graph)!)[roleId]!;
  const worker = (graph.workers as JsonObject[]).find((item) => item.id === roleId)!;
  const steps = role.steps as JsonObject[];
  const tools: Record<string, number> = {};
  for (const step of steps) if (step.type === "tool") tools[String(step.tool)] = (tools[String(step.tool)] ?? 0) + 1;
  const budget = worker.budget as JsonObject;
  return {
    model_calls: steps.filter((step) => step.type === "llm").length + ("task" in (role.route as JsonObject) ? 1 : 0),
    tool_calls: tools,
    compute_calls: steps.filter((step) => step.type === "compute").length,
    remote_calls: budget.remote_calls as number,
    tokens: budget.tokens as number,
    seconds: role.timeout_seconds as number,
  };
}

/**
 * The most times any allowed walk activates a role (R-20): every activation but the entry's first
 * follows an edge into it, each edge is taken at most `max_uses` times, there are at most
 * `max_hops` transitions, and the role's own `max_activations` caps it further.
 */
export function activationBound(network: JsonObject, roleId: string): number {
  const roles = rolesOf(network);
  const role = roles[roleId]!;
  const entry = roleId === network.entry ? 1 : 0;
  let inbound = 0;
  for (const other of Object.values(roles)) for (const edge of other.edges as JsonObject[]) if (edge.to === roleId) inbound += edge.max_uses as number;
  let bound = Math.min(inbound + entry, (network.max_hops as number) + entry);
  if ("max_activations" in role) bound = Math.min(bound, role.max_activations as number);
  return bound;
}

/**
 * The greedy relaxation (R-21): one activation of the entry, then activations in descending order
 * of cost (declaration order breaks ties) up to each role's bound, until `total` activations are
 * placed. Exact for a bounded knapsack with unit weights.
 */
export function allocate(costs: Readonly<Record<string, number>>, bounds: Readonly<Record<string, number>>, entry: string, total: number): Record<string, number> {
  const roles = Object.keys(costs);
  const counts: Record<string, number> = Object.fromEntries(roles.map((role) => [role, 0]));
  if (total < 1 || (bounds[entry] ?? 0) < 1) return counts;
  counts[entry] = 1;
  let placed = 1;
  const order = [...roles].sort((a, b) => costs[b]! - costs[a]! || roles.indexOf(a) - roles.indexOf(b));
  for (const role of order) {
    const room = Math.min(bounds[role]! - counts[role]!, total - placed);
    if (room <= 0) continue;
    counts[role]! += room;
    placed += room;
    if (placed >= total) break;
  }
  return counts;
}

function summed(costsByRole: Readonly<Record<string, number>>, counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [role, cost] of Object.entries(costsByRole)) total += counts[role]! * cost;
  return total;
}

/**
 * The "at most" of a network (R-21, R-22): per component, the relaxation's maximum capped by the
 * run's own limit for that component (`budget`: the effective run budget, the declared one by
 * default). `relaxation` keeps the uncapped figures (validation compares them with the package's
 * own budget, R-22); `activations` is each role's bound.
 */
export function worstCase(graph: JsonObject, policy: JsonObject, options: { budget?: JsonObject | null; nodeTimeout?: number | null } = {}): WorstCase {
  const network = networkOf(graph)!;
  const roles = Object.keys(rolesOf(network));
  const entry = String(network.entry);
  const bounds: Record<string, number> = Object.fromEntries(roles.map((role) => [role, activationBound(network, role)]));
  const total = Math.min((network.max_hops as number) + 1, Object.values(bounds).reduce((sum, bound) => sum + bound, 0));
  const costs: Record<string, ActivationCosts> = Object.fromEntries(roles.map((role) => [role, activationCosts(graph, role)]));
  const caps = { ...((options.budget ?? null) !== null && Object.keys(options.budget!).length > 0 ? options.budget! : (policy.budget as JsonObject)) };
  const deadline = graph.deadline_seconds as number;
  const nodes = networkNodes(graph);
  let timeout = options.nodeTimeout ?? null;
  if (timeout === null && nodes.length > 0) timeout = nodes[0]!.timeout_seconds as number;
  const component = (name: Component): number => {
    const byRole: Record<string, number> = Object.fromEntries(roles.map((role) => [role, costs[role]![name]]));
    return summed(byRole, allocate(byRole, bounds, entry, total));
  };
  const tools = [...new Set(roles.flatMap((role) => Object.keys(costs[role]!.tool_calls)))].sort();
  const toolCalls: Record<string, number> = {};
  for (const tool of tools) {
    const byRole: Record<string, number> = Object.fromEntries(roles.map((role) => [role, costs[role]!.tool_calls[tool] ?? 0]));
    toolCalls[tool] = summed(byRole, allocate(byRole, bounds, entry, total));
  }
  const relaxation = {
    model_calls: component("model_calls"),
    compute_calls: component("compute_calls"),
    remote_calls: component("remote_calls"),
    tokens: component("tokens"),
    seconds: component("seconds"),
    tool_calls: { ...toolCalls },
  };
  const perToolCaps: Record<string, number> = { ...((caps.max_calls_per_tool as Record<string, number> | undefined) ?? {}) };
  const secondsCaps = [relaxation.seconds, deadline, ...(timeout !== null ? [timeout] : [])];
  const capped: Record<string, number> = {};
  for (const [tool, count] of Object.entries(toolCalls)) capped[tool] = Object.hasOwn(perToolCaps, tool) ? Math.min(count, perToolCaps[tool]!) : count;
  return {
    max_hops: network.max_hops as number,
    max_activations: total,
    activations: bounds,
    model_calls: relaxation.model_calls,
    tool_calls: capped,
    compute_calls: relaxation.compute_calls,
    remote_calls: Math.min(relaxation.remote_calls, caps.max_remote_calls as number),
    tokens: Math.min(relaxation.tokens, caps.hard_tokens as number),
    seconds: Math.min(...secondsCaps),
    relaxation,
    caps: {
      hard_tokens: caps.hard_tokens as number,
      max_remote_calls: caps.max_remote_calls as number,
      max_calls_per_tool: perToolCaps,
      timeout_seconds: timeout,
      deadline_seconds: deadline,
    },
  };
}

export interface RouteTarget extends JsonObject {
  role: string;
  description: string;
  uses_left: number;
}

/**
 * What a role may still hand off to at this point of the walk, in edge order: each declared
 * target with its description and how many more times the edge can be taken (zero when the edge,
 * the target's activations or the hops are exhausted). Pure, so a fixture can be built from it.
 */
export function routeTargets(network: JsonObject, roleId: string, uses: Counts, activations: Counts, hop: number): RouteTarget[] {
  const roles = rolesOf(network);
  const hopsLeft = (network.max_hops as number) - hop;
  return (roles[roleId]!.edges as JsonObject[]).map((edge) => {
    const to = String(edge.to);
    const target = roles[to]!;
    let left = (edge.max_uses as number) - get(uses, edgeKey(roleId, to));
    if ("max_activations" in target) left = Math.min(left, (target.max_activations as number) - get(activations, to));
    return { role: to, description: String(target.description), uses_left: Math.max(0, Math.min(left, hopsLeft)) };
  });
}

/** The data of a route request (R-13): the role's constructed input and the availability. */
export function routeData(network: JsonObject, roleId: string, input: JsonValue, uses: Counts, activations: Counts, hop: number): JsonObject {
  return {
    input,
    targets: routeTargets(network, roleId, uses, activations, hop),
    hops_left: (network.max_hops as number) - hop,
    may_end: rolesOf(network)[roleId]!.may_end as boolean,
  };
}

/**
 * Every complete walk the network admits (R-23): from the entry, along declared edges within their
 * `max_uses`, the targets' `max_activations` and `max_hops`, ending at a role that may end. Depth
 * first in declaration order, so two runtimes list the same walks in the same order. Throws
 * `EffortExceeded` past `effort` visited prefixes. With `complete` false, every reachable prefix.
 */
export function enumerateWalks(network: JsonObject, options: { effort?: number; complete?: boolean } = {}): string[][] {
  const effort = options.effort ?? DEFAULT_EFFORT;
  const complete = options.complete ?? true;
  const roles = rolesOf(network);
  const walks: string[][] = [];
  let visited = 0;
  const uses: Counts = new Map();
  const activations: Counts = new Map();
  const bump = (counts: Counts, key: string, by: number) => counts.set(key, get(counts, key) + by);
  const visit = (current: string, path: string[], hop: number): void => {
    visited += 1;
    if (visited > effort) throw new EffortExceeded(`more than ${effort} walk prefixes`);
    if (!complete || roles[current]!.may_end === true) walks.push([...path]);
    if (hop >= (network.max_hops as number)) return;
    for (const edge of roles[current]!.edges as JsonObject[]) {
      const target = String(edge.to);
      if (get(uses, edgeKey(current, target)) >= (edge.max_uses as number)) continue;
      const cap = roles[target]!.max_activations;
      if (cap !== undefined && get(activations, target) >= (cap as number)) continue;
      bump(uses, edgeKey(current, target), 1);
      bump(activations, target, 1);
      path.push(target);
      visit(target, path, hop + 1);
      path.pop();
      bump(uses, edgeKey(current, target), -1);
      bump(activations, target, -1);
    }
  };
  const entry = String(network.entry);
  activations.set(entry, 1);
  visit(entry, [entry], 0);
  return walks;
}

/** The cost vector of one walk: the per-activation costs summed over its activations. */
export function walkCosts(graph: JsonObject, walk: readonly string[]): JsonObject {
  const totals: Record<string, number> = Object.fromEntries(COMPONENTS.map((name) => [name, 0]));
  const tools: Record<string, number> = {};
  const activations: Record<string, number> = {};
  for (const roleId of walk) {
    const costs = activationCosts(graph, roleId);
    for (const name of COMPONENTS) totals[name]! += costs[name];
    for (const [tool, count] of Object.entries(costs.tool_calls)) tools[tool] = (tools[tool] ?? 0) + count;
    activations[roleId] = (activations[roleId] ?? 0) + 1;
  }
  return { ...totals, tool_calls: tools, activations, hops: walk.length - 1 };
}
