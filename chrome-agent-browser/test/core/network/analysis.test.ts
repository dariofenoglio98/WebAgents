/**
 * The worst case of network.v0 §3 in the Chrome core (`src/core/network/analysis.ts`):
 * - the same figures as the reference's `worst_case`, the same walks in the same order as its
 *   `enumerate_walks`, and the same route data, over random small networks (asked of the Python
 *   reference in one process);
 * - sound: every reachable walk prefix (what a run can have spent when it stops anywhere) stays
 *   within the relaxation, component by component;
 * - exact on a star, and the effort cap deterministic.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { activationBound, allocate, EffortExceeded, enumerateWalks, routeData, walkCosts, worstCase } from "../../../src/core/network/analysis.js";
import { python } from "../../helpers/network-package.js";

/** A small deterministic PRNG (mulberry32), so a failure names its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random valid-shaped graph with a network of 2…4 roles, the fields the analysis reads. */
function randomGraph(seed: number): { graph: JsonObject; policy: JsonObject } {
  const random = prng(seed);
  const pick = (n: number) => Math.floor(random() * n);
  const count = 2 + pick(3);
  const ids = Array.from({ length: count }, (_, index) => `R${index}`);
  const tools = ["t1", "t2"];
  const roles: Record<string, JsonObject> = {};
  const workers: JsonObject[] = [{ id: "Coordinator", budget: { tokens: 0, remote_calls: 0 } }];
  for (const id of ids) {
    const steps = Array.from({ length: pick(3) }, (_, index): JsonObject => {
      const kind = ["llm", "tool", "compute"][pick(3)]!;
      return kind === "tool" ? { id: `s${index}`, type: "tool", tool: tools[pick(2)]! } : { id: `s${index}`, type: kind };
    });
    const edges = ids.filter(() => random() < 0.6).map((to) => ({ to, max_uses: 1 + pick(3) }));
    const role: JsonObject = {
      description: id,
      steps,
      route: random() < 0.5 ? { task: "route", max_output_tokens: 10, input: { literal: {} } } : { next: edges[0]?.to ?? "done", message: { literal: {} } },
      edges,
      may_end: edges.length === 0 || random() < 0.5,
      timeout_seconds: 1 + pick(30),
    };
    if (random() < 0.3) role.max_activations = 1 + pick(3);
    roles[id] = role;
    workers.push({ id, budget: { tokens: pick(5) * 100, remote_calls: pick(4) } });
  }
  const graph: JsonObject = {
    deadline_seconds: 50 + pick(100),
    workers,
    nodes: [{ id: "delegate", type: "network", timeout_seconds: 40 + pick(100) }],
    network: { entry: ids[pick(count)]!, max_hops: 1 + pick(6), roles },
  };
  const policy: JsonObject = { budget: { hard_tokens: 1 + pick(4000), max_remote_calls: 1 + pick(40), max_calls_per_tool: { t1: 1 + pick(5), t2: 1 + pick(5) } } };
  return { graph, policy };
}

const SEEDS = Array.from({ length: 120 }, (_, index) => index + 1);
const samples = SEEDS.map((seed) => ({ seed, ...randomGraph(seed) }));

describe("the worst case equals the reference's, figure for figure", () => {
  it("worst_case, enumerate_walks (complete and prefixes) and route_data over 120 random networks", () => {
    const reference = python(
      [
        "import json, sys",
        "from collections import Counter",
        "from agentpkg.delegation.analysis import worst_case, enumerate_walks, route_data, EffortExceeded",
        "out = []",
        "for item in json.load(sys.stdin):",
        "    g, p = item['graph'], item['policy']",
        "    n = g['network']",
        "    try:",
        "        walks = [list(w) for w in enumerate_walks(n, effort=20000)]",
        "        prefixes = [list(w) for w in enumerate_walks(n, effort=20000, complete=False)]",
        "    except EffortExceeded:",
        "        walks = prefixes = None",
        "    data = route_data(n, n['entry'], {'x': 1}, Counter(), Counter({n['entry']: 1}), 0)",
        "    out.append({'bound': worst_case(g, p), 'walks': walks, 'prefixes': prefixes, 'data': data})",
        "print(json.dumps(out))",
      ].join("\n"),
      samples.map(({ graph, policy }) => ({ graph, policy })),
    ) as Array<{ bound: JsonObject; walks: string[][] | null; prefixes: string[][] | null; data: JsonObject }>;
    let enumerated = 0;
    samples.forEach(({ seed, graph, policy }, index) => {
      const expected = reference[index]!;
      expect(JSON.parse(JSON.stringify(worstCase(graph, policy))), `seed ${seed}`).toEqual(expected.bound);
      const network = graph.network as JsonObject;
      let walks: string[][] | null;
      let prefixes: string[][] | null;
      try {
        walks = enumerateWalks(network, { effort: 20000 });
        prefixes = enumerateWalks(network, { effort: 20000, complete: false });
      } catch (error) {
        if (!(error instanceof EffortExceeded)) throw error;
        walks = prefixes = null;
      }
      expect(walks, `seed ${seed}`).toEqual(expected.walks);
      expect(prefixes, `seed ${seed}`).toEqual(expected.prefixes);
      if (walks !== null) enumerated += 1;
      const entry = String(network.entry);
      expect(routeData(network, entry, { x: 1 }, new Map(), new Map([[entry, 1]]), 0), `seed ${seed}`).toEqual(expected.data);
    });
    expect(enumerated).toBeGreaterThan(60);
  });
});

describe("the bound is sound and, on a star, exact", () => {
  it("every reachable prefix of every random network stays within the relaxation", () => {
    for (const { seed, graph, policy } of samples) {
      const network = graph.network as JsonObject;
      let prefixes: string[][];
      try {
        prefixes = enumerateWalks(network, { effort: 20000, complete: false });
      } catch {
        continue;
      }
      const bound = worstCase(graph, policy);
      for (const prefix of prefixes) {
        const costs = walkCosts(graph, prefix);
        for (const name of ["model_calls", "compute_calls", "remote_calls", "tokens", "seconds"] as const) {
          expect(costs[name] as number, `seed ${seed} ${prefix.join(">")} ${name}`).toBeLessThanOrEqual(bound.relaxation[name]);
        }
        for (const [tool, count] of Object.entries(costs.tool_calls as Record<string, number>)) expect(count, `seed ${seed} ${tool}`).toBeLessThanOrEqual(bound.relaxation.tool_calls[tool] ?? 0);
        for (const [role, count] of Object.entries(costs.activations as Record<string, number>)) expect(count).toBeLessThanOrEqual(activationBound(network, role));
        expect(costs.hops as number).toBeLessThanOrEqual(bound.max_hops);
      }
    }
  });

  it("allocates greedily by cost, the entry first, declaration order breaking ties", () => {
    expect(allocate({ A: 1, B: 5, C: 5 }, { A: 2, B: 1, C: 3 }, "A", 4)).toEqual({ A: 1, B: 1, C: 2 });
    expect(allocate({ A: 1, B: 5 }, { A: 0, B: 3 }, "A", 4)).toEqual({ A: 0, B: 0 });
  });

  it("stops deterministically at the effort cap", () => {
    const { graph } = randomGraph(7);
    const network = { ...(graph.network as JsonObject), max_hops: 64 } as JsonObject;
    for (const role of Object.values(network.roles as Record<string, JsonObject>)) {
      role.edges = Object.keys(network.roles as JsonObject).map((to) => ({ to, max_uses: 16 }));
      role.may_end = true;
      delete role.max_activations;
    }
    expect(() => enumerateWalks(network, { effort: 50 })).toThrow(EffortExceeded);
  });
});
