/**
 * Meeting Agenda with answer checks of all three kinds (D-150), on a node and on a map step: the
 * Chrome counterpart of `agenda()` in `agentpkg/tests/test_answer_checks.py`, built in memory.
 */
import type { JsonObject } from "../../src/core/json.js";
import { change, sourceTree, type Files } from "./source-tree.js";

export const OWNER_CHECK: JsonObject = { kind: "relation", rows: { from: "result", path: "/agenda" }, targets: { from: "state", path: "/request/participants" }, row_key: "/owner", target_key: "/name" };
export const MINUTES_CHECK: JsonObject = { kind: "sum", rows: { from: "result", path: "/agenda" }, path: "/minutes", equals: { from: "state", path: "/request/duration" } };
export const UNIQUE_FOCUS: JsonObject = { kind: "relation", rows: { from: "result", path: "/focus" }, targets: { from: "result", path: "/focus" }, row_key: "", target_key: "" };
export const ROLE_CHECK: JsonObject = { kind: "equal", left: { from: "result", path: "/0/role" }, right: { from: "item", path: "/role" } };

export type Nodes = Record<string, JsonObject>;

/** Meeting Agenda with answer checks of all three kinds, on a node and on a map step (`agenda()` in the reference test). */
export function agendaFiles(options: { minimum?: string; checks?: boolean; graph?: (nodes: Nodes) => void; fixture?: (fixture: JsonObject) => void } = {}): Files {
  const files = sourceTree("meeting-agenda");
  change(files, "MANIFEST.agent", (manifest) => {
    (manifest.runtime as JsonObject).minimum_version = options.minimum ?? "0.3.0";
  });
  change(files, "graph.json", (graph) => {
    const nodes: Nodes = Object.fromEntries((graph.nodes as JsonObject[]).map((node) => [String(node.id), node]));
    if (options.checks !== false) {
      nodes.plan!.checks = [UNIQUE_FOCUS];
      ((nodes.perspectives!.steps as JsonObject[])[0]!).checks = [ROLE_CHECK];
      nodes.write!.checks = [OWNER_CHECK, MINUTES_CHECK];
    }
    options.graph?.(nodes);
  });
  if (options.fixture) change(files, "fixtures/workflow.json", options.fixture);
  return files;
}
