/**
 * The graph index (§5, M-20, M-23, M-26…M-28): adjacency from the frontmatter links and the body
 * wikilinks, degree, chain heads, dangling links, the local subgraph at depth n, and the two
 * derived layers (type hubs and package nodes) computed from records, provenance and the usage
 * log. Rebuilt from the records; never authoritative, never exported.
 */
import { bodyEdges } from "./document.js";
import { type MemoryLink, type MemoryRecord, type Relation, SELF_ID, type UsageEntry } from "./model.js";

export interface GraphEdge {
  from: string;
  to: string;
  rel: Relation;
  /** `frontmatter` for a typed link, `body` for a wikilink read as `related`. */
  source: "frontmatter" | "body";
}

export interface DanglingLink extends GraphEdge {
  /** The alias cached in the body for a body link, else null. */
  alias: string | null;
}

/** A derived, display-only node (M-23). */
export interface DerivedNode {
  id: string;
  kind: "type" | "package";
  label: string;
  /** The records it connects to, with the display-only edge name. */
  edges: Array<{ to: string; label: "member" | "proposed" | "read" | "wrote" }>;
}

export interface GraphIndex {
  edges: GraphEdge[];
  out: ReadonlyMap<string, GraphEdge[]>;
  in: ReadonlyMap<string, GraphEdge[]>;
  degree: ReadonlyMap<string, number>;
  /** Record ids some record supersedes (M-26). */
  superseded: ReadonlySet<string>;
  /** The superseder of each superseded record. */
  supersededBy: ReadonlyMap<string, string>;
  dangling: DanglingLink[];
}

/** The edges of one record: its frontmatter links, then its body's id wikilinks as `related` (M-3), duplicates dropped. */
export function recordEdges(record: Pick<MemoryRecord, "id" | "links" | "body" | "scope">): GraphEdge[] {
  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const link of record.links ?? []) {
    const key = `${link.rel}:${link.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: record.id, to: link.to, rel: link.rel, source: "frontmatter" });
  }
  if (record.scope !== "agent") {
    for (const to of bodyEdges(record.body)) {
      const key = `related:${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: record.id, to, rel: "related", source: "body" });
    }
  }
  return out;
}

export function buildGraphIndex(records: Iterable<MemoryRecord>): GraphIndex {
  const byId = new Map<string, MemoryRecord>();
  for (const record of records) byId.set(record.id, record);
  const edges: GraphEdge[] = [];
  const out = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  const degree = new Map<string, number>();
  const superseded = new Set<string>();
  const supersededBy = new Map<string, string>();
  const dangling: DanglingLink[] = [];
  for (const id of byId.keys()) {
    out.set(id, []);
    incoming.set(id, []);
    degree.set(id, 0);
  }
  for (const record of byId.values()) {
    for (const edge of recordEdges(record)) {
      edges.push(edge);
      out.get(record.id)!.push(edge);
      if (byId.has(edge.to)) {
        incoming.get(edge.to)!.push(edge);
        degree.set(record.id, degree.get(record.id)! + 1);
        degree.set(edge.to, degree.get(edge.to)! + 1);
      } else {
        const alias = edge.source === "body" ? aliasOfBodyLink(record.body, edge.to) : null;
        dangling.push({ ...edge, alias });
      }
      if (edge.rel === "supersedes") {
        superseded.add(edge.to);
        supersededBy.set(edge.to, record.id);
      }
    }
  }
  return { edges, out, in: incoming, degree, superseded, supersededBy, dangling };
}

function aliasOfBodyLink(body: string, target: string): string | null {
  const match = new RegExp(`\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\|([^\\]]+)\\]\\]`, "u").exec(body);
  return match ? match[1]! : null;
}

/** M-26: the head of a record's chain: itself when nothing supersedes it, else its last superseder. */
export function headOf(index: Pick<GraphIndex, "supersededBy">, id: string): string {
  let current = id;
  const seen = new Set<string>();
  while (index.supersededBy.has(current) && !seen.has(current)) {
    seen.add(current);
    current = index.supersededBy.get(current)!;
  }
  return current;
}

/** The record ids within `depth` edges of `id`, in either direction, `id` included. */
export function localSubgraph(index: Pick<GraphIndex, "out" | "in">, id: string, depth: number): Set<string> {
  const found = new Set<string>([id]);
  let frontier = [id];
  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of index.out.get(current) ?? []) if (index.out.has(edge.to) && !found.has(edge.to)) found.add(edge.to) && next.push(edge.to);
      for (const edge of index.in.get(current) ?? []) if (!found.has(edge.from)) found.add(edge.from) && next.push(edge.from);
    }
    frontier = next;
  }
  return found;
}

/** Whether two records are linked in either direction (M-32's "+4"). */
export function linked(index: Pick<GraphIndex, "out" | "in">, a: string, b: string): boolean {
  return (index.out.get(a) ?? []).some((edge) => edge.to === b) || (index.out.get(b) ?? []).some((edge) => edge.to === a);
}

export function linksToSelf(record: Pick<MemoryRecord, "links" | "body" | "scope" | "id">): boolean {
  return recordEdges(record).some((edge) => edge.to === SELF_ID);
}

/** M-23: the derived layers, never stored: one hub per type with records, one node per package seen in provenance or the usage log. */
export function derivedLayers(records: Iterable<MemoryRecord>, usage: readonly UsageEntry[], displayNames: (typeId: string) => string): { types: DerivedNode[]; packages: DerivedNode[] } {
  const byType = new Map<string, string[]>();
  const packages = new Map<string, { label: string; edges: Map<string, DerivedNode["edges"][number]["label"]> }>();
  const touch = (packageId: string, label: string | null): { label: string; edges: Map<string, DerivedNode["edges"][number]["label"]> } => {
    const node = packages.get(packageId) ?? { label: label ?? packageId, edges: new Map() };
    if (label !== null && node.label === packageId) node.label = label;
    packages.set(packageId, node);
    return node;
  };
  for (const record of records) {
    byType.set(record.type, [...(byType.get(record.type) ?? []), record.id]);
    if (record.source.kind === "package") touch(record.source.package_id, null).edges.set(record.id, "proposed");
    if (record.source.kind === "agent") touch(record.source.package_id, record.title).edges.set(record.id, "wrote");
  }
  for (const entry of usage) {
    const node = touch(entry.package_id, null);
    if (entry.use === "read" && !node.edges.has(entry.record_id)) node.edges.set(entry.record_id, "read");
    if ((entry.use === "agent_write" || entry.use === "agent_read") && !node.edges.has(entry.record_id)) node.edges.set(entry.record_id, "wrote");
  }
  return {
    types: [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([typeId, ids]) => ({ id: `type:${typeId}`, kind: "type", label: displayNames(typeId), edges: ids.map((to) => ({ to, label: "member" as const })) })),
    packages: [...packages.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([packageId, node]) => ({ id: `package:${packageId}`, kind: "package", label: node.label, edges: [...node.edges.entries()].map(([to, label]) => ({ to, label })) })),
  };
}

export type { MemoryLink };
