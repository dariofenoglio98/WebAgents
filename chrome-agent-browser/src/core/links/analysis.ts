/**
 * The worst case of a package and of a composition across links (link.v0 §4,
 * `agentpkg/links/analysis.py`, line for line).
 *
 * Pure arithmetic over declarations: no package is opened, no model is contacted, nothing here
 * imports the interpreter, so the review may compute what it states.
 *
 * - `linkOperations` lists every `link` step of a graph with where it stands;
 * - `packageWorstCase` is W(p) (L-18): what one run of a workflow.v0 package can cost at most,
 *   with its links' costs inside it when they are known (L-19);
 * - `composedRequirement` is what the composition needs of the caller's own budget (L-20).
 */
import type { JsonObject, JsonValue } from "../json.js";
import { LINK_COMPONENTS, linkCost, networkNodes, networkOf, rolesOf, worstCase, type LinkCosts, type WorstCase } from "../network/analysis.js";

/** The figures of a worst case that a record, a review or a plan states (W(p)'s own, without the `requirement`). */
export const WORST_CASE_FIGURES = ["model_calls", "tool_calls", "compute_calls", "remote_calls", "tokens", "seconds"] as const;

/** W(p) in the six figures a record states. */
export interface WorstCaseFigures extends JsonObject {
  model_calls: number;
  tool_calls: Record<string, number>;
  compute_calls: number;
  remote_calls: number;
  tokens: number;
  seconds: number;
}

/** W(p) with what the composition asks of the package's own budget (L-20). */
export interface PackageWorstCase extends WorstCaseFigures {
  requirement: { tokens: number; remote_calls: number };
}

export type LinkWhere = "node" | "map" | "role";

/** One `link` step: its qualified id (`<node>`, `<node>/<step>`, `<node>/<role>/<step>`), the step, where it stands, its role. */
export type LinkOperation = [label: string, step: JsonObject, where: LinkWhere, role: string | null];

/**
 * Every `link` step of a graph as `[qualified id, step, where, role]`: `where` is `node` (a
 * top-level node), `map` (a step of a map node) or `role` (a step of a network role); the id is
 * the one the audit names.
 */
export function linkOperations(graph: JsonObject): LinkOperation[] {
  const found: LinkOperation[] = [];
  for (const node of (graph.nodes as JsonObject[] | undefined) ?? []) {
    if (node.type === "link") found.push([String(node.id), node, "node", null]);
    else if (node.type === "map") {
      for (const step of node.steps as JsonObject[]) if (step.type === "link") found.push([`${String(node.id)}/${String(step.id)}`, step, "map", null]);
    }
  }
  const network = networkOf(graph);
  if (network === null) return found;
  const runners = networkNodes(graph);
  const nodeId = runners.length > 0 ? String(runners[0]!.id) : "network";
  for (const [roleId, role] of Object.entries(rolesOf(network))) {
    for (const step of role.steps as JsonObject[]) if (step.type === "link") found.push([`${nodeId}/${roleId}/${String(step.id)}`, step, "role", roleId]);
  }
  return found;
}

/** The six figures of a worst case, copied (`links/host.py::worst_case_figures`). */
export function worstCaseFigures(worst: WorstCaseFigures): WorstCaseFigures {
  return {
    model_calls: worst.model_calls,
    tool_calls: { ...worst.tool_calls },
    compute_calls: worst.compute_calls,
    remote_calls: worst.remote_calls,
    tokens: worst.tokens,
    seconds: worst.seconds,
  };
}

/**
 * W(p) (L-18): the most one run of this package can cost, from its declaration: model calls, tool
 * calls per tool under the package's caps, compute calls (exact for the program, a conditional
 * operation counted as taken), and its own caps on remote calls, tokens and seconds. `budget` is
 * the effective run budget (the declared one by default). `links` is `linkCost`'s: with a map of
 * resolved worst cases the links' costs are inside the figures (L-19), their tools qualified;
 * `requirement` is what the composition asks of this package's own budget (L-20).
 */
export function packageWorstCase(graph: JsonObject, policy: JsonObject, options: { budget?: JsonObject | null; links?: LinkCosts | null } = {}): PackageWorstCase {
  const caps: JsonObject = { ...((options.budget ?? (policy.budget as JsonObject)) as JsonObject) };
  const links = options.links ?? null;
  let model = 0;
  let compute = 0;
  const tools = new Map<string, number>();
  const bump = (tool: string, times: number) => tools.set(tool, (tools.get(tool) ?? 0) + times);
  const linked: Record<(typeof LINK_COMPONENTS)[number], number> = { model_calls: 0, compute_calls: 0, remote_calls: 0, tokens: 0 };
  const required = { tokens: 0, remote_calls: 0 };
  // Where the network node is the graph's only spending node, the network's own bound caps the
  // package's remote calls and tokens below its budget.
  let networkOnly: WorstCase | null = null;
  const add = (operation: JsonObject, times: number): void => {
    const kind = operation.type;
    if (kind === "llm") model += times;
    else if (kind === "tool") bump(String(operation.tool), times);
    else if (kind === "compute") compute += times;
    else if (kind === "link") {
      const cost = linkCost(operation, links);
      if (cost === null) return;
      for (const name of LINK_COMPONENTS) linked[name] += times * cost[name];
      for (const [tool, count] of Object.entries(cost.tool_calls)) bump(tool, times * count);
      required.tokens += times * cost.tokens;
      required.remote_calls += times * cost.remote_calls;
    }
  };
  const nodes = (graph.nodes as JsonObject[] | undefined) ?? [];
  for (const node of nodes) {
    if (node.type === "map") {
      for (const step of node.steps as JsonObject[]) add(step, node.max_items as number);
    } else if (node.type === "network") {
      // The network's own bound already holds its roles' links (R-19 with L-19).
      const bound = worstCase(graph, policy, { budget: caps, links });
      model += bound.model_calls;
      compute += bound.compute_calls;
      for (const [tool, count] of Object.entries(bound.tool_calls)) bump(tool, count);
      required.tokens += bound.relaxation.tokens;
      required.remote_calls += bound.relaxation.remote_calls;
      networkOnly = bound;
    } else {
      add(node, 1);
    }
  }
  if (nodes.some((node) => ["llm", "tool", "map", "link"].includes(String(node.type)))) networkOnly = null;
  const perTool = { ...((caps.max_calls_per_tool as Record<string, number> | undefined) ?? {}) };
  let remoteCalls = caps.max_remote_calls as number;
  let spentTokens = caps.hard_tokens as number;
  if (networkOnly !== null) {
    remoteCalls = Math.min(remoteCalls, (networkOnly as WorstCase).remote_calls);
    spentTokens = Math.min(spentTokens, (networkOnly as WorstCase).tokens);
  }
  const toolCalls: Record<string, number> = {};
  for (const tool of [...tools.keys()].sort(codepoint)) {
    const count = tools.get(tool)!;
    toolCalls[tool] = Object.hasOwn(perTool, tool) ? Math.min(count, perTool[tool]!) : count;
  }
  return {
    model_calls: model + linked.model_calls,
    tool_calls: toolCalls,
    compute_calls: compute + linked.compute_calls,
    remote_calls: remoteCalls,
    tokens: spentTokens,
    seconds: graph.deadline_seconds as number,
    requirement: required,
  };
}

/** Python's `sorted` on strings: by code point. */
export function codepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * L-20: the first figure of the composition that the caller's own budget cannot hold, as
 * `[name, needed, cap]`, or null when it fits. The network's relaxation (its roles' budgets and
 * their links) and every other link's worst case, against `hard_tokens` and `max_remote_calls`.
 */
export function composedRequirement(graph: JsonObject, policy: JsonObject, links?: LinkCosts | null): [name: "tokens" | "remote_calls", needed: number, cap: number] | null {
  const budget = policy.budget as JsonObject;
  const required = packageWorstCase(graph, policy, { links: links ?? null }).requirement;
  for (const [name, cap] of [["tokens", "hard_tokens"], ["remote_calls", "max_remote_calls"]] as const) {
    if (required[name] > (budget[cap] as number)) return [name, required[name], budget[cap] as number];
  }
  return null;
}

/** A value as a JSON value (the figures are plain JSON already; this narrows the type). */
export const asJson = (value: WorstCaseFigures): JsonValue => value as unknown as JsonValue;
