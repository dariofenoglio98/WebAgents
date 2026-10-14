/**
 * The graph view of the Memory page (T19; design `memory-ui.md` §3.2; D-218, D-224, D-225):
 * Canvas 2D over an own force layout (link distance 80, charge −160 through a Barnes–Hut
 * quadtree, a weak centring force, collision by radius; at most 300 ticks after a change, then
 * still), drag, pan, zoom, click to open the card, the local graph at depth 1 or 2, drag-to-link
 * ending in the relation chooser, filters and layers, colour by type and size by degree or
 * recency, search highlight, and positions remembered as UI state. Every pointer action has a
 * keyboard path. The canvas never draws a sealed value: labels are titles (M-4), and the tooltip
 * shows the summary fields with sealed ones masked.
 *
 * `GraphModel` (what is drawn) and `GraphInteraction` (the state machine) know no DOM, so the
 * tests drive them over a fake canvas; `renderMemoryGraph` is the thin DOM layer.
 */
import { SEALED_PLACEHOLDER, SELF_ID, type Relation } from "../../../core/memory/model.js";
import { lastUseWords, provenanceWords } from "../../../core/memory/words.js";
import type { MemoryView } from "../../messages.js";
import type { MemoryRecordListing } from "../../background/memory-controller.js";
import { button, el } from "../dom.js";
import { openCard, recordOf, typeOf, visibleRecords, type MemoryPageActions, type MemoryPageState } from "./page.js";
import { MASK } from "./strings.js";

// -- the model ---------------------------------------------------------------------------------
export interface GraphNode {
  id: string;
  label: string;
  kind: "record" | "self" | "type" | "package";
  typeId: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Fixed while dragged. */
  fixed: boolean;
  radius: number;
  degree: number;
  superseded: boolean;
  dimmed: boolean;
  match: boolean;
  demo: boolean;
}

export interface GraphLink {
  from: string;
  to: string;
  rel: Relation | "member" | "proposed" | "read" | "wrote";
  style: "solid" | "dashed" | "thin" | "dotted";
}

export interface GraphModel {
  nodes: GraphNode[];
  links: GraphLink[];
  byId: Map<string, GraphNode>;
  colours: Map<string, string>;
}

/** The twelve taxonomy colours in a fixed order, then the custom types by first appearance (design §3.2). */
export const PALETTE: readonly string[] = Object.freeze(["#0b6e4f", "#2a6fb0", "#c06a12", "#a23b5c", "#6b4fa0", "#1f8a8a", "#8a6d1f", "#b03a2e", "#3b7a57", "#5a5a8a", "#9a4f1f", "#2f6f9f"]);
export const TAXONOMY_ORDER: readonly string[] = Object.freeze(["person.self", "person.identity", "travel.profile", "travel.preference", "research.profile", "research.review", "contact.person", "contact.organization", "payment.card", "document.note", "agent.memory", "location.place"]);

export interface GraphUiState {
  positions: Record<string, { x: number; y: number }>;
  zoom: number;
  pan: { x: number; y: number };
  /** Custom type id → palette index beyond the taxonomy's (stable across sessions). */
  colours: Record<string, number>;
  mode?: "graph" | "list";
}

export function emptyUiState(): GraphUiState {
  return { positions: {}, zoom: 1, pan: { x: 0, y: 0 }, colours: {} };
}

export function colourOf(typeId: string, ui: GraphUiState): string {
  const fixed = TAXONOMY_ORDER.indexOf(typeId);
  if (fixed >= 0) return PALETTE[fixed % PALETTE.length]!;
  if (ui.colours[typeId] === undefined) ui.colours[typeId] = TAXONOMY_ORDER.length + Object.keys(ui.colours).length;
  return PALETTE[ui.colours[typeId]! % PALETTE.length]!;
}

/** The radius classes (three steps, never a continuous scale). */
function radiusFor(kind: GraphNode["kind"], degree: number, recentDays: number | null, size: "links" | "recent"): number {
  if (kind === "self") return 14;
  if (kind === "type" || kind === "package") return 9;
  const step = size === "links" ? (degree >= 5 ? 2 : degree >= 2 ? 1 : 0) : recentDays === null ? 0 : recentDays <= 7 ? 2 : recentDays <= 60 ? 1 : 0;
  return [6, 8, 11][step]!;
}

/** The local subgraph: the ids within `depth` of `root` over the record edges, both directions. */
export function localIds(edges: ReadonlyArray<{ from: string; to: string }>, root: string, depth: number): Set<string> {
  const seen = new Set([root]);
  let frontier = [root];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const edge of edges) {
      if (seen.has(edge.from) && !seen.has(edge.to)) {
        seen.add(edge.to);
        next.push(edge.to);
      } else if (seen.has(edge.to) && !seen.has(edge.from)) {
        seen.add(edge.from);
        next.push(edge.from);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return seen;
}

/** Build the drawn set from the worker's view, the page's filters and the remembered positions (design §3.2: filters reduce what is drawn). */
export function buildGraphModel(view: MemoryView, state: MemoryPageState, ui: GraphUiState, previous: GraphModel | null, now: Date = new Date()): GraphModel {
  const records = visibleRecords(view, state);
  let ids = new Set(records.map((record) => record.id));
  const recordEdges = view.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  if (state.local) {
    const keep = localIds(view.edges, state.local.root, state.local.depth);
    ids = new Set([...ids].filter((id) => keep.has(id)));
  }
  const matches = state.matches === null ? null : new Set(state.matches.map((match) => match.id));
  const packageFilter = state.filters.packageId;
  const nodes: GraphNode[] = [];
  const byId = new Map<string, GraphNode>();
  const degree = new Map<string, number>();
  for (const edge of recordEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const colours = new Map<string, string>();
  const place = (id: string, index: number, total: number): { x: number; y: number } => {
    const remembered = ui.positions[id];
    if (remembered) return remembered;
    const old = previous?.byId.get(id);
    if (old) return { x: old.x, y: old.y };
    if (id === SELF_ID) return { x: 0, y: 0 };
    // Seeded radially around `self` on first open (design §3.2).
    const angle = (index / Math.max(1, total)) * Math.PI * 2;
    const ring = 120 + 40 * (index % 3);
    return { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
  };
  let index = 0;
  for (const record of records) {
    if (!ids.has(record.id)) continue;
    const type = typeOf(view, record.type);
    colours.set(record.type, colourOf(record.type, ui));
    const last = record.usage[0]?.last ?? null;
    const recentDays = last === null ? null : Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000);
    const position = place(record.id, index, records.length);
    const node: GraphNode = {
      id: record.id,
      label: record.title,
      kind: record.id === SELF_ID ? "self" : "record",
      typeId: record.type,
      x: position.x,
      y: position.y,
      vx: 0,
      vy: 0,
      fixed: false,
      radius: radiusFor(record.id === SELF_ID ? "self" : "record", degree.get(record.id) ?? 0, recentDays, state.filters.size),
      degree: degree.get(record.id) ?? 0,
      superseded: record.superseded_by !== null,
      dimmed: (matches !== null && !matches.has(record.id)) || (packageFilter !== null && !record.usage.some((usage) => usage.package_id === packageFilter)),
      match: matches !== null && matches.has(record.id),
      demo: record.demo === true,
    };
    void type;
    nodes.push(node);
    byId.set(node.id, node);
    index += 1;
  }
  const links: GraphLink[] = recordEdges.filter((edge) => byId.has(edge.from) && byId.has(edge.to)).map((edge) => ({ from: edge.from, to: edge.to, rel: edge.rel, style: edge.rel === "supersedes" ? "dashed" : edge.rel === "related" || edge.source === "body" ? "thin" : "solid" }));
  const derived = [...(state.filters.typeHubs ? view.layers.types : []), ...(state.filters.packages ? view.layers.packages : [])];
  for (const [at, hub] of derived.entries()) {
    const connected = hub.edges.filter((edge) => byId.has(edge.to));
    if (connected.length === 0) continue;
    const position = place(hub.id, at, derived.length);
    const node: GraphNode = { id: hub.id, label: hub.label, kind: hub.kind, typeId: null, x: position.x === 0 && position.y === 0 ? 260 : position.x, y: position.y, vx: 0, vy: 0, fixed: false, radius: 9, degree: connected.length, superseded: false, dimmed: false, match: false, demo: false };
    nodes.push(node);
    byId.set(node.id, node);
    for (const edge of connected) links.push({ from: hub.id, to: edge.to, rel: edge.label, style: "dotted" });
  }
  return { nodes, links, byId, colours };
}

// -- the force layout (D-224: an own implementation; Barnes–Hut for the charge) ----------------
export const LINK_DISTANCE = 80;
export const CHARGE = -160;
export const MAX_TICKS = 300;

interface Quad {
  x: number;
  y: number;
  size: number;
  mass: number;
  cx: number;
  cy: number;
  node: GraphNode | null;
  children: Quad[] | null;
}

function insert(quad: Quad, node: GraphNode, depth = 0): void {
  if (quad.mass === 0 && quad.node === null && quad.children === null) {
    quad.node = node;
    quad.mass = 1;
    quad.cx = node.x;
    quad.cy = node.y;
    return;
  }
  if (quad.children === null) {
    if (depth > 24) {
      // Coincident points: fold into the mass rather than recursing forever.
      quad.cx = (quad.cx * quad.mass + node.x) / (quad.mass + 1);
      quad.cy = (quad.cy * quad.mass + node.y) / (quad.mass + 1);
      quad.mass += 1;
      return;
    }
    const half = quad.size / 2;
    quad.children = [
      { x: quad.x, y: quad.y, size: half, mass: 0, cx: 0, cy: 0, node: null, children: null },
      { x: quad.x + half, y: quad.y, size: half, mass: 0, cx: 0, cy: 0, node: null, children: null },
      { x: quad.x, y: quad.y + half, size: half, mass: 0, cx: 0, cy: 0, node: null, children: null },
      { x: quad.x + half, y: quad.y + half, size: half, mass: 0, cx: 0, cy: 0, node: null, children: null },
    ];
    const held = quad.node;
    quad.node = null;
    if (held) insert(quad.children[(held.x >= quad.x + half ? 1 : 0) + (held.y >= quad.y + half ? 2 : 0)]!, held, depth + 1);
  }
  const half = quad.size / 2;
  insert(quad.children[(node.x >= quad.x + half ? 1 : 0) + (node.y >= quad.y + half ? 2 : 0)]!, node, depth + 1);
  quad.cx = (quad.cx * quad.mass + node.x) / (quad.mass + 1);
  quad.cy = (quad.cy * quad.mass + node.y) / (quad.mass + 1);
  quad.mass += 1;
}

function applyCharge(quad: Quad, node: GraphNode, theta: number, alpha: number): void {
  if (quad.mass === 0) return;
  const dx = quad.cx - node.x;
  const dy = quad.cy - node.y;
  const distance2 = dx * dx + dy * dy;
  if (quad.children !== null && quad.size * quad.size > theta * theta * distance2) {
    for (const child of quad.children) applyCharge(child, node, theta, alpha);
    return;
  }
  if (quad.node === node) return;
  const distance = Math.sqrt(distance2) || 1;
  const force = (CHARGE * quad.mass * alpha) / Math.max(distance2, 64);
  node.vx += (dx / distance) * force;
  node.vy += (dy / distance) * force;
}

/** One tick of the simulation: links, charge (Barnes–Hut, θ = 0.9), centring, collision, then velocity decay. Pure over the model. */
export function tick(model: GraphModel, alpha: number): void {
  const nodes = model.nodes;
  if (nodes.length === 0) return;
  for (const link of model.links) {
    const a = model.byId.get(link.from);
    const b = model.byId.get(link.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const strength = (distance - LINK_DISTANCE) * 0.08 * alpha;
    const fx = (dx / distance) * strength;
    const fy = (dy / distance) * strength;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
  const root: Quad = { x: minX, y: minY, size, mass: 0, cx: 0, cy: 0, node: null, children: null };
  for (const node of nodes) insert(root, node);
  for (const node of nodes) applyCharge(root, node, 0.9, alpha);
  for (const node of nodes) {
    node.vx -= node.x * 0.01 * alpha;
    node.vy -= node.y * 0.01 * alpha;
  }
  // Collision by radius: a simple grid so two near nodes push apart.
  const cell = 32;
  const grid = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = `${Math.floor(node.x / cell)}:${Math.floor(node.y / cell)}`;
    grid.set(key, [...(grid.get(key) ?? []), node]);
  }
  for (const node of nodes) {
    const gx = Math.floor(node.x / cell);
    const gy = Math.floor(node.y / cell);
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        for (const other of grid.get(`${gx + ox}:${gy + oy}`) ?? []) {
          if (other === node || other.id < node.id) continue;
          const dx = other.x - node.x;
          const dy = other.y - node.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const minimum = node.radius + other.radius + 4;
          if (distance < minimum) {
            const push = ((minimum - distance) / distance) * 0.5;
            node.vx -= dx * push;
            node.vy -= dy * push;
            other.vx += dx * push;
            other.vy += dy * push;
          }
        }
      }
    }
  }
  for (const node of nodes) {
    if (node.fixed) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= 0.6;
    node.vy *= 0.6;
    node.x += node.vx;
    node.y += node.vy;
  }
}

export class Simulation {
  private remaining = 0;
  alpha = 1;
  constructor(readonly model: GraphModel) {}
  /** (Re)start after a change: at most `MAX_TICKS` more ticks, then still (no idle CPU). */
  restart(ticks = MAX_TICKS): void {
    this.remaining = ticks;
    this.alpha = 1;
  }
  get running(): boolean {
    return this.remaining > 0;
  }
  step(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    this.alpha = Math.max(0.02, this.alpha * 0.985);
    tick(this.model, this.alpha);
    return true;
  }
  /** Settle instantly (reduced motion, tests). */
  settle(): void {
    while (this.step()) {
      // run to the cap
    }
  }
}

// -- the interaction state machine (design §3.2) ------------------------------------------------
export type InteractionState =
  | { kind: "idle" }
  | { kind: "pressing"; id: string; x: number; y: number }
  | { kind: "dragging"; id: string }
  | { kind: "panning"; x: number; y: number }
  | { kind: "linking"; from: string; target: string | null; x: number; y: number }
  | { kind: "grabbing"; id: string };

export interface InteractionHost {
  /** The node under a canvas point, or null. */
  nodeAt(x: number, y: number): GraphNode | null;
  /** Open the record card (click, Enter). */
  open(id: string): void;
  /** Enter or change the local graph (double-click, Shift+Enter, 1, 2), or leave it (Backspace). */
  local(root: string | null, depth: 1 | 2): void;
  /** The relation chooser for a link from → to (drop, Enter in link mode). */
  chooseRelation(from: string, to: string): void;
  /** A node was dropped: its position is remembered. */
  dropped(id: string, x: number, y: number): void;
  announce(text: string): void;
  zoomBy(factor: number): void;
  fit(): void;
  panBy(dx: number, dy: number): void;
  /** Request a redraw. */
  redraw(): void;
}

export const DRAG_THRESHOLD = 4;

/** The state machine, driven by pointer and key facts; it holds no DOM. */
export class GraphInteraction {
  state: InteractionState = { kind: "idle" };
  focused: string | null = null;
  hovered: string | null = null;
  localDepth: 1 | 2 | null = null;
  private hitting: ((x: number, y: number) => GraphNode | null) | null = null;

  constructor(
    private readonly model: () => GraphModel,
    private readonly host: InteractionHost,
  ) {}

  private nodeAt(x: number, y: number): GraphNode | null {
    return (this.hitting ?? this.host.nodeAt.bind(this.host))(x, y);
  }

  pointerDown(x: number, y: number, options: { alt?: boolean } = {}): void {
    const node = this.nodeAt(x, y);
    if (node === null) {
      this.state = { kind: "panning", x, y };
      return;
    }
    this.focused = node.id;
    if (options.alt) {
      this.state = { kind: "linking", from: node.id, target: null, x, y };
      return;
    }
    this.state = { kind: "pressing", id: node.id, x, y };
  }

  pointerMove(x: number, y: number): void {
    const state = this.state;
    if (state.kind === "pressing") {
      if (Math.hypot(x - state.x, y - state.y) > DRAG_THRESHOLD) {
        const node = this.model().byId.get(state.id);
        if (node) node.fixed = true;
        this.state = { kind: "dragging", id: state.id };
        this.moveNode(state.id, x, y);
      }
      return;
    }
    if (state.kind === "dragging") {
      this.moveNode(state.id, x, y);
      return;
    }
    if (state.kind === "panning") {
      this.host.panBy(x - state.x, y - state.y);
      this.state = { kind: "panning", x, y };
      return;
    }
    if (state.kind === "linking") {
      const target = this.nodeAt(x, y);
      this.state = { ...state, target: target && target.id !== state.from ? target.id : null, x, y };
      this.host.redraw();
      return;
    }
    const over = this.nodeAt(x, y);
    const id = over?.id ?? null;
    if (id !== this.hovered) {
      this.hovered = id;
      this.host.redraw();
    }
  }

  pointerUp(x: number, y: number): void {
    const state = this.state;
    this.state = { kind: "idle" };
    if (state.kind === "pressing") {
      this.host.open(state.id);
      return;
    }
    if (state.kind === "dragging") {
      const node = this.model().byId.get(state.id);
      if (node) {
        node.fixed = false;
        this.host.dropped(state.id, node.x, node.y);
      }
      return;
    }
    if (state.kind === "linking") {
      const target = this.nodeAt(x, y);
      if (target && target.id !== state.from && target.kind !== "type" && target.kind !== "package") this.host.chooseRelation(state.from, target.id);
      else this.host.redraw();
    }
  }

  doubleClick(x: number, y: number): void {
    const node = this.nodeAt(x, y);
    if (!node || node.kind === "type" || node.kind === "package") return;
    this.focused = node.id;
    this.localDepth = 1;
    this.host.local(node.id, 1);
  }

  wheel(delta: number): void {
    this.host.zoomBy(delta < 0 ? 1.1 : 1 / 1.1);
  }

  private moveNode(id: string, x: number, y: number): void {
    const node = this.model().byId.get(id);
    if (!node) return;
    node.x = x;
    node.y = y;
    this.host.redraw();
  }

  /** The nearest node in a direction (arrow keys), or the current one when none lies that way. */
  nearest(direction: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): string | null {
    const model = this.model();
    const from = this.focused ? model.byId.get(this.focused) : null;
    if (!from) return model.nodes[0]?.id ?? null;
    let best: GraphNode | null = null;
    let bestScore = Infinity;
    for (const node of model.nodes) {
      if (node === from) continue;
      const dx = node.x - from.x;
      const dy = node.y - from.y;
      const along = direction === "ArrowLeft" ? -dx : direction === "ArrowRight" ? dx : direction === "ArrowUp" ? -dy : dy;
      const across = direction === "ArrowLeft" || direction === "ArrowRight" ? Math.abs(dy) : Math.abs(dx);
      if (along <= 0) continue;
      const score = along + across * 2;
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best?.id ?? from.id;
  }

  /** Returns true when the key was handled. */
  keyDown(key: string, options: { shift?: boolean } = {}): boolean {
    const model = this.model();
    const state = this.state;
    if (state.kind === "grabbing") {
      const node = model.byId.get(state.id);
      if (!node) {
        this.state = { kind: "idle" };
        return true;
      }
      const step = options.shift ? 50 : 10;
      if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
        node.x += key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
        node.y += key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
        this.host.redraw();
        return true;
      }
      if (key === "Enter") {
        node.fixed = false;
        this.state = { kind: "idle" };
        this.host.dropped(node.id, node.x, node.y);
        return true;
      }
      if (key === "Escape") {
        node.fixed = false;
        this.state = { kind: "idle" };
        this.host.redraw();
        return true;
      }
      return false;
    }
    if (state.kind === "linking") {
      if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
        const current = this.focused;
        this.focused = state.target ?? state.from;
        const next = this.nearest(key);
        this.focused = current;
        this.state = { ...state, target: next && next !== state.from ? next : state.target };
        this.host.redraw();
        return true;
      }
      if (key === "Enter" && state.target) {
        this.state = { kind: "idle" };
        this.host.chooseRelation(state.from, state.target);
        return true;
      }
      if (key === "Escape") {
        this.state = { kind: "idle" };
        this.host.redraw();
        return true;
      }
      return false;
    }
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
      if (this.focused === null) {
        const step = options.shift ? 100 : 10;
        this.host.panBy(key === "ArrowLeft" ? step : key === "ArrowRight" ? -step : 0, key === "ArrowUp" ? step : key === "ArrowDown" ? -step : 0);
        return true;
      }
      const next = this.nearest(key);
      if (next) this.focus(next);
      return true;
    }
    if (key === "Home") {
      if (model.byId.has(SELF_ID)) this.focus(SELF_ID);
      return true;
    }
    if (key === "Enter" && this.focused) {
      if (options.shift) {
        this.localDepth = 1;
        this.host.local(this.focused, 1);
      } else this.host.open(this.focused);
      return true;
    }
    if ((key === "1" || key === "2") && this.localDepth !== null && this.focused) {
      this.localDepth = key === "1" ? 1 : 2;
      this.host.local(this.focused, this.localDepth);
      return true;
    }
    if (key === "Backspace" && this.localDepth !== null) {
      this.localDepth = null;
      this.host.local(null, 1);
      return true;
    }
    if ((key === "g" || key === "G") && this.focused) {
      const node = model.byId.get(this.focused);
      if (node) {
        node.fixed = true;
        this.state = { kind: "grabbing", id: node.id };
        this.host.announce(`Moving ${node.label}: arrows move, Enter drops, Escape cancels`);
      }
      return true;
    }
    if ((key === "l" || key === "L") && this.focused) {
      this.state = { kind: "linking", from: this.focused, target: null, x: 0, y: 0 };
      this.host.announce("Link mode: arrows pick the target, Enter chooses the relation, Escape cancels");
      return true;
    }
    if (key === "-" || key === "+" || key === "=" || key === "0") {
      if (key === "0") this.host.fit();
      else if (key === "=") this.host.zoomBy(0); // 100 %
      else this.host.zoomBy(key === "+" ? 1.2 : 1 / 1.2);
      return true;
    }
    return false;
  }

  focus(id: string): void {
    this.focused = id;
    const node = this.model().byId.get(id);
    if (node) this.host.announce(`${node.label}, ${node.typeId ?? node.kind}, ${node.degree} link${node.degree === 1 ? "" : "s"}`);
    this.host.redraw();
  }

  /** Tests: replace the hit test. */
  useHitTest(hitting: (x: number, y: number) => GraphNode | null): void {
    this.hitting = hitting;
  }
}

// -- UI state (chrome.storage.local) ---------------------------------------------------------------
export const UI_STATE_KEY = "memoryUiState";

async function loadUiState(): Promise<GraphUiState> {
  try {
    const area = (globalThis as { chrome?: { storage?: { local?: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome?.storage?.local;
    if (!area) return emptyUiState();
    const stored = (await area.get(UI_STATE_KEY))[UI_STATE_KEY] as Partial<GraphUiState> | undefined;
    if (!stored || typeof stored !== "object") return emptyUiState();
    return { ...emptyUiState(), ...stored, positions: { ...(stored.positions ?? {}) }, colours: { ...(stored.colours ?? {}) }, pan: { ...(stored.pan ?? { x: 0, y: 0 }) } };
  } catch {
    return emptyUiState();
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveUiState(ui: GraphUiState): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const area = (globalThis as { chrome?: { storage?: { local?: { set(items: Record<string, unknown>): Promise<void> } } } }).chrome?.storage?.local;
      void area?.set({ [UI_STATE_KEY]: ui });
    } catch {
      // UI state is a convenience; losing it loses nothing of the memory.
    }
  }, 250);
}

// -- the DOM layer --------------------------------------------------------------------------------
interface GraphInstance {
  canvas: HTMLCanvasElement;
  live: HTMLElement;
  ui: GraphUiState;
  model: GraphModel | null;
  simulation: Simulation | null;
  interaction: GraphInteraction | null;
  frame: number | null;
  fingerprint: string;
  view: MemoryView | null;
  state: MemoryPageState | null;
  actions: MemoryPageActions | null;
  reducedMotion: boolean;
  width: number;
  height: number;
  loaded: boolean;
}

let instance: GraphInstance | null = null;

function modelFingerprint(view: MemoryView, state: MemoryPageState): string {
  return JSON.stringify([view.records.map((record) => [record.id, record.updated, record.superseded_by, record.expired]), view.edges.length, state.filters, state.local, state.matches?.map((match) => match.id) ?? null, state.tidyGroup]);
}

function toCanvas(inst: GraphInstance, clientX: number, clientY: number): { x: number; y: number } {
  const rect = inst.canvas.getBoundingClientRect();
  const sx = clientX - rect.left - rect.width / 2;
  const sy = clientY - rect.top - rect.height / 2;
  return { x: (sx - inst.ui.pan.x) / inst.ui.zoom, y: (sy - inst.ui.pan.y) / inst.ui.zoom };
}

/** Hit test by a uniform grid over the drawn set. */
function hitTester(model: GraphModel): (x: number, y: number) => GraphNode | null {
  const cell = 40;
  const grid = new Map<string, GraphNode[]>();
  for (const node of model.nodes) {
    const key = `${Math.floor(node.x / cell)}:${Math.floor(node.y / cell)}`;
    grid.set(key, [...(grid.get(key) ?? []), node]);
  }
  return (x, y) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    let best: GraphNode | null = null;
    let bestDistance = Infinity;
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        for (const node of grid.get(`${gx + ox}:${gy + oy}`) ?? []) {
          const distance = Math.hypot(node.x - x, node.y - y);
          if (distance <= node.radius + 4 && distance < bestDistance) {
            best = node;
            bestDistance = distance;
          }
        }
      }
    }
    return best;
  };
}

function draw(inst: GraphInstance): void {
  const model = inst.model;
  const context = inst.canvas.getContext("2d");
  if (!model || !context) return;
  const { width, height } = inst;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.translate(width / 2 + inst.ui.pan.x, height / 2 + inst.ui.pan.y);
  context.scale(inst.ui.zoom, inst.ui.zoom);
  const interaction = inst.interaction;
  const selected = inst.state?.selected ?? null;
  const linking = interaction?.state.kind === "linking" ? interaction.state : null;
  // Edges.
  for (const link of model.links) {
    const a = model.byId.get(link.from);
    const b = model.byId.get(link.to);
    if (!a || !b) continue;
    context.beginPath();
    context.setLineDash(link.style === "dashed" ? [6, 4] : link.style === "dotted" ? [2, 4] : []);
    context.lineWidth = link.style === "thin" ? 0.6 : link.style === "dotted" ? 0.8 : 1.2;
    context.strokeStyle = a.dimmed || b.dimmed ? "rgba(91,100,112,0.25)" : "rgba(91,100,112,0.75)";
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    // Arrowhead at the target.
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const tipX = b.x - Math.cos(angle) * (b.radius + 2);
    const tipY = b.y - Math.sin(angle) * (b.radius + 2);
    context.beginPath();
    context.setLineDash([]);
    context.moveTo(tipX, tipY);
    context.lineTo(tipX - Math.cos(angle - 0.5) * 6, tipY - Math.sin(angle - 0.5) * 6);
    context.lineTo(tipX - Math.cos(angle + 0.5) * 6, tipY - Math.sin(angle + 0.5) * 6);
    context.closePath();
    context.fillStyle = context.strokeStyle;
    context.fill();
  }
  if (linking) {
    const from = model.byId.get(linking.from);
    if (from) {
      const target = linking.target ? model.byId.get(linking.target) : null;
      context.beginPath();
      context.setLineDash([4, 4]);
      context.strokeStyle = "#0b6e4f";
      context.lineWidth = 1.5;
      context.moveTo(from.x, from.y);
      context.lineTo(target ? target.x : linking.x, target ? target.y : linking.y);
      context.stroke();
      context.setLineDash([]);
    }
  }
  // Nodes.
  const showLabels = inst.ui.zoom > 0.6;
  for (const node of model.nodes) {
    const colour = node.typeId ? (model.colours.get(node.typeId) ?? "#5b6470") : "#5b6470";
    context.globalAlpha = node.superseded ? 0.4 : node.dimmed ? 0.3 : 1;
    context.beginPath();
    context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    if (node.kind === "type" || node.kind === "package") {
      context.strokeStyle = "#5b6470";
      context.lineWidth = 1.5;
      context.fillStyle = "#ffffff";
      context.fill();
      context.stroke();
    } else if (node.kind === "self") {
      context.strokeStyle = colour;
      context.lineWidth = 3;
      context.fillStyle = "#ffffff";
      context.fill();
      context.stroke();
    } else {
      context.fillStyle = colour;
      context.fill();
    }
    const ring = node.id === selected || node.id === interaction?.focused || node.match || node.id === linking?.target;
    if (ring) {
      context.beginPath();
      context.arc(node.x, node.y, node.radius + 4, 0, Math.PI * 2);
      context.strokeStyle = node.match && node.id !== selected ? "#c06a12" : "#1b1f24";
      context.lineWidth = node.id === interaction?.focused ? 2.5 : 1.5;
      context.setLineDash(node.id === interaction?.focused ? [] : [3, 3]);
      context.stroke();
      context.setLineDash([]);
    }
    if (showLabels || node.id === selected || node.id === interaction?.hovered || node.id === interaction?.focused || node.match) {
      context.fillStyle = "#1b1f24";
      context.font = `${node.kind === "self" ? "600 " : ""}${12 / Math.max(inst.ui.zoom, 0.8)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      context.textAlign = "center";
      context.fillText(node.label.length > 40 ? `${node.label.slice(0, 39)}…` : node.label, node.x, node.y + node.radius + 13 / Math.max(inst.ui.zoom, 0.8));
    }
    context.globalAlpha = 1;
  }
}

function loop(inst: GraphInstance): void {
  if (inst.frame !== null) return;
  const step = () => {
    inst.frame = null;
    if (inst.simulation && inst.simulation.step()) {
      draw(inst);
      inst.frame = requestAnimationFrame(step);
    } else draw(inst);
  };
  inst.frame = requestAnimationFrame(step);
}

function fitView(inst: GraphInstance): void {
  const model = inst.model;
  if (!model || model.nodes.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of model.nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  inst.ui.zoom = Math.min(2, Math.max(0.2, Math.min((inst.width - 80) / spanX, (inst.height - 80) / spanY)));
  inst.ui.pan = { x: (-(minX + maxX) / 2) * inst.ui.zoom, y: (-(minY + maxY) / 2) * inst.ui.zoom };
}

function tooltipText(view: MemoryView, record: MemoryRecordListing): string {
  const type = typeOf(view, record.type);
  const summary = (type?.display.summary ?? []).map((pointer) => {
    const name = pointer.slice(1);
    const value = record.fields[name];
    const shown = record.sealed_pointers.includes(pointer) || value === SEALED_PLACEHOLDER ? MASK : value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
    return `${name.replace(/_/gu, " ")}: ${shown}`;
  });
  return [`${record.title} · ${type?.display_name ?? record.type}`, ...summary, provenanceWords(record.source), lastUseWords(record.usage[0] ? { package_id: record.usage[0].package_id, at: record.usage[0].last } : null)].filter(Boolean).join("\n");
}

function ensureInstance(): GraphInstance {
  if (instance) return instance;
  const canvas = el("canvas", { className: "ab-memory-canvas", attrs: { role: "application", "aria-label": "Memory graph", tabindex: "0", "aria-describedby": "ab-memory-graph-help" } });
  const live = el("div", { className: "ab-visually-hidden", attrs: { "aria-live": "polite" } });
  instance = { canvas, live, ui: emptyUiState(), model: null, simulation: null, interaction: null, frame: null, fingerprint: "", view: null, state: null, actions: null, reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, width: 800, height: 520, loaded: false };
  const inst = instance;
  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus();
    const { x, y } = toCanvas(inst, event.clientX, event.clientY);
    canvas.setPointerCapture(event.pointerId);
    inst.interaction?.pointerDown(x, y, { alt: event.altKey });
  });
  canvas.addEventListener("pointermove", (event) => {
    const { x, y } = toCanvas(inst, event.clientX, event.clientY);
    inst.interaction?.pointerMove(x, y);
    const over = inst.interaction?.hovered ?? null;
    const record = inst.view && over ? recordOf(inst.view, over) : undefined;
    canvas.title = record && inst.view ? tooltipText(inst.view, record) : "";
    const kind = inst.interaction?.state.kind;
    canvas.style.cursor = kind === "dragging" ? "grabbing" : kind === "panning" ? "move" : over ? "pointer" : "default";
  });
  canvas.addEventListener("pointerup", (event) => {
    const { x, y } = toCanvas(inst, event.clientX, event.clientY);
    inst.interaction?.pointerUp(x, y);
  });
  canvas.addEventListener("dblclick", (event) => {
    const { x, y } = toCanvas(inst, event.clientX, event.clientY);
    inst.interaction?.doubleClick(x, y);
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    inst.interaction?.wheel(event.deltaY);
  }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    if (inst.interaction?.keyDown(event.key, { shift: event.shiftKey })) event.preventDefault();
  });
  return instance;
}

function hostFor(inst: GraphInstance): InteractionHost {
  return {
    nodeAt: (x, y) => (inst.model ? hitTester(inst.model)(x, y) : null),
    open: (id) => {
      if (!inst.view || !inst.state || !inst.actions) return;
      if (id.startsWith("type:") || id.startsWith("package:")) return;
      openCard(inst.view, inst.state, id);
      inst.actions.rerender();
    },
    local: (root, depth) => {
      if (!inst.state || !inst.actions) return;
      inst.state.local = root === null ? null : { root, depth };
      inst.actions.rerender();
    },
    chooseRelation: (from, to) => {
      if (!inst.state || !inst.actions) return;
      inst.state.sheet = { kind: "relation", from, to, rel: null, error: null };
      inst.actions.rerender();
    },
    dropped: (id, x, y) => {
      inst.ui.positions[id] = { x, y };
      saveUiState(inst.ui);
      inst.simulation?.restart(60);
      loop(inst);
    },
    announce: (text) => {
      inst.live.textContent = text;
    },
    zoomBy: (factor) => {
      inst.ui.zoom = factor === 0 ? 1 : Math.min(4, Math.max(0.1, inst.ui.zoom * factor));
      saveUiState(inst.ui);
      draw(inst);
    },
    fit: () => {
      fitView(inst);
      saveUiState(inst.ui);
      draw(inst);
    },
    panBy: (dx, dy) => {
      inst.ui.pan = { x: inst.ui.pan.x + dx, y: inst.ui.pan.y + dy };
      saveUiState(inst.ui);
      draw(inst);
    },
    redraw: () => draw(inst),
  };
}

/** The graph canvas for the Memory page's main column; the page calls it on every render and the instance persists across renders. */
export function renderMemoryGraph(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const inst = ensureInstance();
  inst.view = view;
  inst.state = state;
  inst.actions = actions;
  if (!inst.loaded) {
    inst.loaded = true;
    void loadUiState().then((ui) => {
      inst.ui = ui;
      if (ui.mode && inst.state) inst.state.mode = ui.mode;
      inst.fingerprint = "";
      if (inst.view && inst.state && inst.actions) inst.actions.rerender();
    });
  }
  const fingerprint = modelFingerprint(view, state);
  if (fingerprint !== inst.fingerprint) {
    inst.fingerprint = fingerprint;
    const hadPositions = inst.model !== null;
    inst.model = buildGraphModel(view, state, inst.ui, inst.model);
    inst.simulation = new Simulation(inst.model);
    inst.interaction = new GraphInteraction(() => inst.model!, hostFor(inst));
    inst.interaction.localDepth = state.local?.depth ?? null;
    inst.interaction.focused = state.selected && inst.model.byId.has(state.selected) ? state.selected : null;
    const remembered = Object.keys(inst.ui.positions).length > 0;
    inst.simulation.restart(remembered && hadPositions ? 60 : MAX_TICKS);
    if (inst.reducedMotion) inst.simulation.settle();
    if (!remembered && !hadPositions) fitView(inst);
    for (const node of inst.model.nodes) inst.ui.positions[node.id] = { x: node.x, y: node.y };
  }
  const wrap = el("div", { className: "ab-memory-graph" });
  const size = () => {
    const rect = wrap.getBoundingClientRect();
    inst.width = Math.max(320, Math.floor(rect.width) || 800);
    inst.height = Math.max(320, Math.floor(rect.height) || 520);
    const ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    inst.canvas.width = inst.width * ratio;
    inst.canvas.height = inst.height * ratio;
    inst.canvas.style.width = `${inst.width}px`;
    inst.canvas.style.height = `${inst.height}px`;
    const context = inst.canvas.getContext("2d");
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  queueMicrotask(() => {
    size();
    loop(inst);
  });
  const legend = el("div", { className: "ab-memory-legend", attrs: { "aria-label": "Legend" } }, ...[...inst.model!.colours.entries()].map(([typeId, colour]) => el("span", { className: "ab-memory-legend-item" }, el("span", { className: "ab-memory-swatch", attrs: { style: `background:${colour}` } }), el("span", { text: typeOf(view, typeId)?.display_name ?? typeId }))));
  const controls = el(
    "div",
    { className: "ab-memory-graph-controls" },
    button("−", () => hostFor(inst).zoomBy(1 / 1.2), { title: "Zoom out (-)" }),
    button("+", () => hostFor(inst).zoomBy(1.2), { title: "Zoom in (+)" }),
    button("⌖ fit", () => hostFor(inst).fit(), { title: "Fit (0)" }),
    button("⟲", () => {
      inst.ui.positions = {};
      inst.fingerprint = "";
      saveUiState(inst.ui);
      actions.rerender();
    }, { title: "Re-run the layout" }),
    state.local ? el("span", { className: "ab-memory-depth" }, el("span", { text: `Local graph of ${recordOf(view, state.local.root)?.title ?? ""}: depth` }), button("1", () => hostFor(inst).local(state.local!.root, 1), { variant: state.local.depth === 1 ? "primary" : "ghost" }), button("2", () => hostFor(inst).local(state.local!.root, 2), { variant: state.local.depth === 2 ? "primary" : "ghost" }), button("Back", () => hostFor(inst).local(null, 1))) : null,
  );
  const help = el("p", { className: "ab-visually-hidden", attrs: { id: "ab-memory-graph-help" }, text: "Arrow keys move between records, Home selects you, Enter opens the record, Shift+Enter shows its neighbourhood, G grabs a record to move it with the arrows, L starts a link, minus and plus zoom, 0 fits, slash searches." });
  wrap.append(inst.canvas, inst.live, help, legend, controls);
  inst.ui.mode = state.mode;
  return wrap;
}

/** Tests: the current instance's model and interaction, or null before the first render. */
export function graphInstance(): { model: GraphModel | null; interaction: GraphInteraction | null; ui: GraphUiState } | null {
  return instance ? { model: instance.model, interaction: instance.interaction, ui: instance.ui } : null;
}
