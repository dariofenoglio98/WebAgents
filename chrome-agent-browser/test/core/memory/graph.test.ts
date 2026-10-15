/**
 * The graph index (§5): adjacency from frontmatter links and body wikilinks, degree, heads,
 * dangling links, the local subgraph and the derived layers (M-20, M-23, M-26…M-28).
 */
import { describe, expect, it } from "vitest";

import { buildGraphIndex, derivedLayers, headOf, localSubgraph } from "../../../src/core/memory/graph.js";
import { exampleStore, WEBAIR_EXAMPLE } from "../../helpers/memory.js";

const PROFILE = "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60";
const HEAD = "mem_9b8a7c6d5e4f30211203a4b5c6d7e8f9";
const CARD = "mem_4e5f60718293a4b5c6d7e8f90a1b2c3d";
const SEAT = "mem_5f60718293a4b5c6d7e8f90a1b2c3d4e";
const NOTE = "mem_8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

describe("the graph index", () => {
  it("reads frontmatter links and body wikilinks as edges, counts degree, finds heads and the local subgraph", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE);
    const index = buildGraphIndex(store.all());
    expect(index.out.get(HEAD)!.map((edge) => [edge.to, edge.rel, edge.source])).toEqual([
      ["self", "about", "frontmatter"],
      [SEAT, "prefers", "frontmatter"],
      [CARD, "pays_with", "frontmatter"],
      [PROFILE, "supersedes", "frontmatter"],
      [NOTE, "related", "body"],
    ]);
    expect(index.degree.get("self")).toBe(5);
    expect(index.degree.get(NOTE)).toBe(2);
    expect(index.dangling).toEqual([]);
    expect(headOf(index, PROFILE)).toBe(HEAD);
    expect(headOf(index, HEAD)).toBe(HEAD);
    expect([...localSubgraph(index, NOTE, 1)].sort()).toEqual([NOTE, PROFILE, HEAD].sort());
    expect(localSubgraph(index, NOTE, 2).size).toBe(6); // the identity is three edges away, through self
    const layers = derivedLayers(store.all(), store.usage, (typeId) => store.types.get(typeId)?.display_name ?? typeId);
    expect(layers.types.map((node) => [node.label, node.edges.length])).toEqual([
      ["Note", 1],
      ["Payment card", 1],
      ["Identity", 1],
      ["Me", 1],
      ["Travel preference", 1],
      ["Travel profile", 2],
    ]);
    expect(layers.packages.map((node) => [node.id, node.edges.map((edge) => edge.label).sort()])).toEqual([["package:org.webagents.webair", ["proposed", "proposed", "read", "read", "read"]]]);
  });

  it("a deleted target leaves a dangling edge with its cached alias", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE);
    store.delete(NOTE);
    const dangling = store.graph.dangling;
    expect(dangling.map((edge) => [edge.from, edge.alias])).toEqual([
      [PROFILE, "Packing list"],
      [HEAD, "Packing list"],
    ]);
  });
});
