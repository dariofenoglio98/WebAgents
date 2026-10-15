/**
 * The graph view's model and state machine (T19; design `memory-ui.md` §3.2; D-218, D-224),
 * tested over a fake hit test: happy-dom has no layout, so the tests drive `GraphInteraction`
 * and `buildGraphModel` directly and never measure pixels.
 */
import { describe, expect, it } from "vitest";

import type { MemoryView } from "../../src/extension/messages.js";
import { buildGraphModel, colourOf, DRAG_THRESHOLD, emptyUiState, GraphInteraction, localIds, MAX_TICKS, Simulation, tick, type GraphModel, type GraphNode, type InteractionHost } from "../../src/extension/ui/memory/graph.js";
import { newMemoryPageState } from "../../src/extension/ui/memory/page.js";
import { DEMO, makeHarness, PAGE } from "../helpers/shell.js";

async function demoView(): Promise<MemoryView> {
  const h = makeHarness();
  await h.controller.handle({ type: "memory.installDemo" }, PAGE);
  await h.controller.handle({ type: "memory.link", from: DEMO.traveler, to: DEMO.visa, rel: "pays_with" }, PAGE);
  await h.controller.handle({ type: "memory.link", from: DEMO.traveler, to: DEMO.explorer, rel: "supersedes" }, PAGE);
  return h.controller.handle({ type: "memory.get" }, PAGE) as Promise<MemoryView>;
}

interface Recorded {
  opened: string[];
  local: Array<[string | null, number]>;
  relations: Array<[string, string]>;
  dropped: Array<[string, number, number]>;
  announced: string[];
  zoom: number[];
  pans: Array<[number, number]>;
  fits: number;
  redraws: number;
}

function fakeHost(model: () => GraphModel): { host: InteractionHost; recorded: Recorded } {
  const recorded: Recorded = { opened: [], local: [], relations: [], dropped: [], announced: [], zoom: [], pans: [], fits: 0, redraws: 0 };
  const host: InteractionHost = {
    nodeAt: (x, y) => model().nodes.find((node) => Math.hypot(node.x - x, node.y - y) <= node.radius + 4) ?? null,
    open: (id) => recorded.opened.push(id),
    local: (root, depth) => recorded.local.push([root, depth]),
    chooseRelation: (from, to) => recorded.relations.push([from, to]),
    dropped: (id, x, y) => recorded.dropped.push([id, x, y]),
    announce: (text) => recorded.announced.push(text),
    zoomBy: (factor) => recorded.zoom.push(factor),
    fit: () => (recorded.fits += 1),
    panBy: (dx, dy) => recorded.pans.push([dx, dy]),
    redraw: () => (recorded.redraws += 1),
  };
  return { host, recorded };
}

describe("the graph model", () => {
  it("draws the visible records as nodes coloured by type, the typed links and body wikilinks as edges, hides superseded records by default, and seeds positions around self", async () => {
    const view = await demoView();
    const state = newMemoryPageState();
    const ui = emptyUiState();
    const model = buildGraphModel(view, state, ui, null, new Date("2026-10-14T12:00:00Z"));
    // The explorer is superseded by the traveler and hidden by default (design §3.2).
    expect(model.nodes.map((node) => node.id)).not.toContain(DEMO.explorer);
    expect(model.nodes.find((node) => node.id === "self")).toMatchObject({ kind: "self", x: 0, y: 0, radius: 14 });
    expect(model.links.find((link) => link.from === DEMO.traveler && link.to === DEMO.visa)).toMatchObject({ rel: "pays_with", style: "solid" });
    expect(model.colours.get("travel.profile")).toBe(colourOf("travel.profile", ui));
    expect(model.colours.get("travel.profile")).not.toBe(model.colours.get("payment.card"));
    expect(model.nodes.filter((node) => node.id !== "self").every((node) => node.x !== 0 || node.y !== 0)).toBe(true);
    // With superseded shown, the dashed supersedes edge appears and the superseded node is flagged.
    state.filters.showSuperseded = true;
    const withOld = buildGraphModel(view, state, ui, model);
    expect(withOld.nodes.find((node) => node.id === DEMO.explorer)?.superseded).toBe(true);
    expect(withOld.links.find((link) => link.rel === "supersedes")?.style).toBe("dashed");
    // Positions remembered in UI state win over the seed; the previous model's positions over nothing.
    ui.positions[DEMO.traveler] = { x: 123, y: -45 };
    const remembered = buildGraphModel(view, state, ui, null);
    expect(remembered.byId.get(DEMO.traveler)).toMatchObject({ x: 123, y: -45 });
    // Layers: the type hubs and the package nodes are hollow derived nodes with dotted edges.
    state.filters.typeHubs = true;
    const hubs = buildGraphModel(view, state, ui, null);
    expect(hubs.nodes.some((node) => node.kind === "type" && node.label === "Travel profile")).toBe(true);
    expect(hubs.links.filter((link) => link.style === "dotted").length).toBeGreaterThan(0);
    // Search matches ring and the rest dims; a package filter dims records the package never touched.
    state.filters.typeHubs = false;
    state.matches = [{ id: DEMO.visa, score: 1 }];
    const searched = buildGraphModel(view, state, ui, null);
    expect(searched.nodes.find((node) => node.id === DEMO.visa)).toMatchObject({ match: true, dimmed: false });
    expect(searched.nodes.filter((node) => node.id !== DEMO.visa).length).toBe(0); // the search filters the drawn set
  });

  it("the local subgraph keeps the neighbourhood at depth 1 and 2", async () => {
    const view = await demoView();
    const one = localIds(view.edges, DEMO.visa, 1);
    expect(one).toEqual(new Set([DEMO.visa, DEMO.traveler, "self"])); // pays_with from the traveler, about → self
    const two = localIds(view.edges, DEMO.visa, 2);
    expect(two.has(DEMO.traveler)).toBe(true);
    expect(two.has("self")).toBe(true); // traveler → self
    expect(two.size).toBeGreaterThan(one.size);
    const state = newMemoryPageState();
    state.local = { root: DEMO.visa, depth: 1 };
    const model = buildGraphModel(view, state, emptyUiState(), null);
    expect(model.nodes.map((node) => node.id).sort()).toEqual([...one].sort());
  });

  it("the simulation pulls linked nodes toward the link distance, pushes the rest apart, and stops after at most 300 ticks", async () => {
    const view = await demoView();
    const model = buildGraphModel(view, newMemoryPageState(), emptyUiState(), null);
    const simulation = new Simulation(model);
    simulation.restart();
    let ticks = 0;
    while (simulation.step()) ticks += 1;
    expect(ticks).toBe(MAX_TICKS);
    expect(simulation.running).toBe(false);
    const a = model.byId.get(DEMO.traveler)!;
    const b = model.byId.get(DEMO.visa)!;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    expect(distance).toBeGreaterThan(20);
    expect(distance).toBeLessThan(400);
    for (const node of model.nodes) for (const other of model.nodes) if (node !== other) expect(Math.hypot(node.x - other.x, node.y - other.y)).toBeGreaterThan(8);
    // A fixed node never moves.
    a.fixed = true;
    const { x, y } = a;
    tick(model, 1);
    expect([a.x, a.y]).toEqual([x, y]);
  });
});

describe("the interaction state machine (design §3.2)", () => {
  function setup(): { interaction: GraphInteraction; model: GraphModel; recorded: Recorded; node: (id: string) => GraphNode } {
    const model: GraphModel = { nodes: [], links: [], byId: new Map(), colours: new Map() };
    const add = (id: string, x: number, y: number, kind: GraphNode["kind"] = "record") => {
      const node: GraphNode = { id, label: id, kind, typeId: "document.note", x, y, vx: 0, vy: 0, fixed: false, radius: 8, degree: 0, superseded: false, dimmed: false, match: false, demo: false };
      model.nodes.push(node);
      model.byId.set(id, node);
    };
    add("self", 0, 0, "self");
    add("a", 100, 0);
    add("b", 0, 100);
    add("c", -100, 0);
    add("type:document.note", 200, 200, "type");
    const { host, recorded } = fakeHost(() => model);
    const interaction = new GraphInteraction(() => model, host);
    return { interaction, model, recorded, node: (id) => model.byId.get(id)! };
  }

  it("pressing a node and releasing opens it; moving past the threshold drags it and the drop is remembered", () => {
    const { interaction, recorded, node } = setup();
    interaction.pointerDown(100, 0);
    expect(interaction.state.kind).toBe("pressing");
    interaction.pointerMove(101, 1); // within the threshold: still pressing
    expect(interaction.state.kind).toBe("pressing");
    interaction.pointerUp(101, 1);
    expect(interaction.state.kind).toBe("idle");
    expect(recorded.opened).toEqual(["a"]);
    interaction.pointerDown(100, 0);
    interaction.pointerMove(100 + DRAG_THRESHOLD + 2, 0);
    expect(interaction.state.kind).toBe("dragging");
    expect(node("a").fixed).toBe(true);
    interaction.pointerMove(150, 30);
    expect([node("a").x, node("a").y]).toEqual([150, 30]);
    interaction.pointerUp(150, 30);
    expect(interaction.state.kind).toBe("idle");
    expect(node("a").fixed).toBe(false);
    expect(recorded.dropped).toEqual([["a", 150, 30]]);
    expect(recorded.opened).toEqual(["a"]); // a drag is not a click
  });

  it("pressing the background pans; the wheel zooms; a double-click opens the local graph", () => {
    const { interaction, recorded } = setup();
    interaction.pointerDown(50, 50);
    expect(interaction.state.kind).toBe("panning");
    interaction.pointerMove(60, 55);
    expect(recorded.pans).toEqual([[10, 5]]);
    interaction.pointerUp(60, 55);
    expect(interaction.state.kind).toBe("idle");
    interaction.wheel(-100);
    interaction.wheel(100);
    expect(recorded.zoom).toEqual([1.1, 1 / 1.1]);
    interaction.doubleClick(0, 100);
    expect(recorded.local).toEqual([["b", 1]]);
    expect(interaction.localDepth).toBe(1);
    interaction.doubleClick(200, 200); // a derived node has no local graph
    expect(recorded.local).toHaveLength(1);
  });

  it("drag with Alt links: a ghost edge follows the pointer and the drop on a node opens the relation chooser; a drop on the background cancels", () => {
    const { interaction, recorded } = setup();
    interaction.pointerDown(100, 0, { alt: true });
    expect(interaction.state).toMatchObject({ kind: "linking", from: "a", target: null });
    interaction.pointerMove(0, 100);
    expect(interaction.state).toMatchObject({ kind: "linking", target: "b" });
    interaction.pointerUp(0, 100);
    expect(recorded.relations).toEqual([["a", "b"]]);
    expect(interaction.state.kind).toBe("idle");
    interaction.pointerDown(100, 0, { alt: true });
    interaction.pointerUp(50, 50);
    expect(recorded.relations).toHaveLength(1);
    interaction.pointerDown(100, 0, { alt: true });
    interaction.pointerUp(200, 200); // a type hub is never a link target
    expect(recorded.relations).toHaveLength(1);
  });

  it("every pointer action has a keyboard path: arrows, Home, Enter, Shift+Enter and the depth keys, G to grab, L to link, the zoom keys", () => {
    const { interaction, recorded, node } = setup();
    expect(interaction.keyDown("ArrowRight")).toBe(true); // nothing focused: the canvas pans
    expect(recorded.pans).toEqual([[-10, 0]]);
    interaction.focus("self");
    expect(recorded.announced.at(-1)).toContain("self");
    expect(interaction.keyDown("ArrowRight")).toBe(true);
    expect(interaction.focused).toBe("a");
    interaction.keyDown("ArrowDown");
    expect(interaction.focused).toBe("b");
    interaction.keyDown("Home");
    expect(interaction.focused).toBe("self");
    interaction.keyDown("ArrowLeft");
    expect(interaction.focused).toBe("c");
    interaction.keyDown("Enter");
    expect(recorded.opened).toEqual(["c"]);
    interaction.keyDown("Enter", { shift: true });
    expect(recorded.local.at(-1)).toEqual(["c", 1]);
    interaction.keyDown("2");
    expect(recorded.local.at(-1)).toEqual(["c", 2]);
    interaction.keyDown("Backspace");
    expect(recorded.local.at(-1)).toEqual([null, 1]);
    // Grab: arrows move by 10 (50 with Shift), Enter drops, Escape cancels.
    interaction.keyDown("g");
    expect(interaction.state).toMatchObject({ kind: "grabbing", id: "c" });
    interaction.keyDown("ArrowUp");
    interaction.keyDown("ArrowRight", { shift: true });
    expect([node("c").x, node("c").y]).toEqual([-50, -10]);
    interaction.keyDown("Enter");
    expect(interaction.state.kind).toBe("idle");
    expect(recorded.dropped.at(-1)).toEqual(["c", -50, -10]);
    interaction.keyDown("G");
    interaction.keyDown("ArrowDown");
    interaction.keyDown("Escape");
    expect(interaction.state.kind).toBe("idle");
    expect(node("c").fixed).toBe(false);
    // Link mode: arrows pick the target, Enter opens the chooser.
    interaction.focus("a");
    interaction.keyDown("l");
    expect(interaction.state).toMatchObject({ kind: "linking", from: "a" });
    interaction.keyDown("ArrowDown");
    expect(interaction.state).toMatchObject({ kind: "linking", target: "b" });
    interaction.keyDown("Enter");
    expect(recorded.relations).toEqual([["a", "b"]]);
    interaction.keyDown("L");
    interaction.keyDown("Escape");
    expect(interaction.state.kind).toBe("idle");
    // Zoom keys.
    interaction.keyDown("+");
    interaction.keyDown("-");
    interaction.keyDown("=");
    interaction.keyDown("0");
    expect(recorded.zoom).toEqual([1.2, 1 / 1.2, 0]);
    expect(recorded.fits).toBe(1);
    expect(interaction.keyDown("x")).toBe(false);
  });
});
