/**
 * A package's links as `inspect` and the review list them (link.v0 L-22; `agentpkg/links/records.py`):
 * the dependencies and the slots the signed program declares, and the composed envelope once the
 * links are resolved.
 */
import type { JsonObject } from "../json.js";
import { linkCost, networkOf, type LinkCosts } from "../network/analysis.js";
import type { Package } from "../package.js";
import { codepoint, linkOperations, packageWorstCase, WORST_CASE_FIGURES } from "./analysis.js";
import { linkFacts, type ResolvedLink } from "./resolve.js";

/**
 * `resolved`: the resolved links once preparation ran, else null: the declaration alone, which
 * states a slot at its ceiling and cannot yet state a planned link's cost. `denied`: the dependency
 * ids the person denied, left out of the envelope.
 */
export function linkRecords(pkg: Package, resolved: ReadonlyMap<string, ResolvedLink> | null = null, denied: ReadonlySet<string> = new Set()): JsonObject | null {
  const graph = pkg.graph;
  const dependencies = (pkg.manifest.dependencies as JsonObject[] | undefined) ?? [];
  const operations = linkOperations(graph);
  if (dependencies.length === 0 && operations.length === 0) return null;
  let costs: LinkCosts | null = null;
  if (resolved !== null) {
    const map: Record<string, ResolvedLink["worst_case"]> = {};
    for (const [name, link] of resolved) map[name] = denied.has(name) ? null : link.worst_case;
    costs = map;
  }
  const steps: Record<string, JsonObject[]> = {};
  const slots: JsonObject[] = [];
  for (const [label, step, where, roleId] of operations) {
    if ("slot" in step) {
      const ceiling = linkCost(step)!;
      slots.push({
        slot: String(step.slot),
        step: label,
        role: roleId,
        max_joins: step.max_joins as number,
        view: Object.keys(((step.input as JsonObject).object as JsonObject | undefined) ?? {}).sort(codepoint),
        ceiling: { ...ceiling, seconds: step.timeout_seconds as number },
      });
    } else {
      (steps[String(step.dependency)] ??= []).push({ step: label, where });
    }
  }
  const listed = dependencies.map((record) => {
    const entry: JsonObject = { ...record, steps: steps[String(record.id)] ?? [] };
    const link = resolved?.get(String(record.id));
    if (link !== undefined) {
      entry.resolved = {
        ...linkFacts(link),
        decision: denied.has(String(record.id)) ? "denied" : "accepted",
        worst_case: Object.fromEntries(WORST_CASE_FIGURES.map((name) => [name, JSON.parse(JSON.stringify(link.worst_case![name]))])),
      };
    }
    return entry;
  });
  const composed = packageWorstCase(graph, pkg.policy, { links: costs });
  return {
    resolved: resolved !== null,
    dependencies: listed,
    slots,
    // Without resolution the envelope holds the slots at their ceilings and no planned link yet: a
    // figure that is not an "at most" until every dependency is resolved.
    worst_case: Object.fromEntries(WORST_CASE_FIGURES.map((name) => [name, JSON.parse(JSON.stringify(composed[name]))])),
    network: networkOf(graph) !== null,
  };
}
