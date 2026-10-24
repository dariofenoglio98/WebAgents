/**
 * Input switches that need a host read (D-273, B-219): an input key that reaches a tool node's
 * `when` (`/state/<key>` copied from `input`, `op: eq`, the literal `true`) whose tool binds the
 * host's memory or a host resource is linked to that tool's permissions. Derived from the graph
 * alone, so no package-specific code: the run form renders the recall card under such a switch
 * when the plan denies a linked permission or grants no record for it, and re-authorizes in place.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import type { Package } from "./package.js";

export interface InputGatedRead {
  /** The input's top-level key (the switch). */
  input_key: string;
  /** The state key the switch is copied into. */
  state_key: string;
  tool_id: string;
  node_id: string;
  permission_ids: string[];
  /** The memory or resource types the tool's permissions request, for the card's words. */
  resource_types: string[];
}

const HOST_READ_BINDINGS = ["host.memory.", "host.resource."];

/** The input keys `initial_state` copies into state keys, as `{state_key: input_key}`. */
function inputCopies(graph: JsonObject): Record<string, string> {
  const initial = graph.initial_state;
  const out: Record<string, string> = {};
  if (!isJsonObject(initial) || !isJsonObject(initial.object)) return out;
  for (const [stateKey, constructor] of Object.entries(initial.object)) {
    if (!isJsonObject(constructor) || constructor.from !== "input" || typeof constructor.path !== "string") continue;
    const path = constructor.path;
    if (!/^\/[^/]+$/u.test(path)) continue;
    out[stateKey] = path.slice(1).replace(/~1/gu, "/").replace(/~0/gu, "~");
  }
  return out;
}

/** Whether `when` is "state key equals true". */
function switchOf(when: JsonValue | undefined): string | null {
  if (!isJsonObject(when) || when.op !== "eq") return null;
  const left = when.left;
  const right = when.right;
  if (!isJsonObject(left) || left.from !== "state" || typeof left.path !== "string" || !/^\/[^/]+$/u.test(left.path)) return null;
  if (!isJsonObject(right) || right.literal !== true) return null;
  return left.path.slice(1);
}

export function inputGatedReads(pkg: Package): InputGatedRead[] {
  const copies = inputCopies(pkg.graph);
  const permissions = new Map((pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), permission]));
  const out: InputGatedRead[] = [];
  for (const raw of (pkg.graph.nodes as JsonValue[] | undefined) ?? []) {
    const node = raw as JsonObject;
    if (node.type !== "tool") continue;
    const tool = pkg.tools[String(node.tool)];
    if (tool === undefined) continue;
    const binding = String(tool.binding ?? "");
    if (!HOST_READ_BINDINGS.some((prefix) => binding.startsWith(prefix)) || binding.startsWith("host.memory.agent.")) continue;
    const stateKey = switchOf(node.when);
    if (stateKey === null || !Object.hasOwn(copies, stateKey)) continue;
    const permissionIds = (tool.permissions as JsonValue[]).map(String);
    const types = [...new Set(permissionIds.flatMap((id) => ((permissions.get(id)?.resources as JsonValue[] | undefined) ?? []).map(String)))].sort();
    out.push({ input_key: copies[stateKey]!, state_key: stateKey, tool_id: String(node.tool), node_id: String(node.id), permission_ids: permissionIds, resource_types: types });
  }
  return out;
}
