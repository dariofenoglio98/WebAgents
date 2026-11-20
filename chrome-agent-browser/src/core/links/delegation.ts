/**
 * The delegation view's model (T66, D-704; link.v0's audit, §8; network.v0's events): who was asked,
 * who is working and who answered, drawn from the run's own audit events and from nothing else.
 *
 * A pure fold over the caller's chain, so that a page can redraw it after each event (`onAudit`)
 * and a test can recompute it from an export: every node of the tree is an event or a pair of
 * events, every figure on it is a figure an event states, and a message or an input is named by the
 * hash its event records, never by its text. Nothing here reads the package's words.
 *
 * An inner run is known by its `inner_run_id` (T66 review 1, finding 4): a map step's items run up
 * to `max_parallel` at once, so several runs of one step and one dependency can be open together.
 * A join is known by its step and slot until its inner run starts (its look, its decision), and a
 * join whose inner run could not be built fails with `inner_run_id: null` by the same key.
 */
import type { JsonObject, JsonValue } from "../json.js";
import type { AuditEvent } from "../types.js";

export type DelegationState = "working" | "answered" | "failed" | "refused" | "denied" | "looking" | "declined" | "not_joined" | "asked" | "raised" | "kept";

/** One link asked during an activation (a planned link's inner run, or a slot's join). */
export interface LinkNode {
  kind: "link" | "join";
  /** The step's qualified id (`<node>/<role>/<step>`, `<node>/<step>`, `<node>`). */
  node_id: string;
  /** The dependency id of a planned link, the slot id of a join. */
  name: string;
  state: DelegationState;
  /** The package that was asked (its id and digest from `link.started`, or a join's candidate). */
  package_id: string | null;
  digest: string | null;
  inner_run_id: string | null;
  /** What was held for it (`link.started`'s `reserved`) and what it spent (`link.completed` / `link.failed`'s `usage`). */
  reserved: JsonObject | null;
  usage: JsonObject | null;
  /** A failure's or a refusal's code (`link.failed`'s `error_code`, `link.refused`'s `reason`). */
  code: string | null;
  input_hash: string | null;
  result_hash: string | null;
  /** A network's `link.denied` names no dependency: the role whose program holds a denied link (its entry); null otherwise. */
  denied_role: string | null;
  /** A join's look and decision (`link.requested`, `link.decided`): the pages looked at and the decision's facts. */
  fetches: JsonValue[] | null;
  decision: JsonObject | null;
}

/** One activation of a role (`network.activated`) with the links its program asked. */
export interface ActivationNode {
  role: string;
  hop: number;
  activation: number;
  message_hash: string | null;
  state: "working" | "done" | "failed";
  /** Where the activation handed off (`route.decided` with `allowed: true`), or null while working. */
  next: string | null;
  links: LinkNode[];
}

/** The budget-raise request of the run, if one was asked (`budget.requested`, `budget.raised`). */
export interface RaiseNode {
  node_id: string | null;
  limit: string;
  from: number;
  to: number;
  state: "asked" | "raised" | "kept";
}

export interface DelegationTree {
  /** The network node's activations, in order; empty for a package without a network. */
  activations: ActivationNode[];
  /** Links asked outside a network (a top-level link node, a map step). */
  links: LinkNode[];
  raise: RaiseNode | null;
  /** Whether the run holds any link event at all (a page shows the view only then). */
  linked: boolean;
}

const text = (value: JsonValue | undefined): string | null => (typeof value === "string" ? value : null);
const object = (value: JsonValue | undefined): JsonObject | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);

/** The delegation tree of a run, from its caller's audit events (in order). */
export function delegationTree(events: readonly AuditEvent[]): DelegationTree {
  const tree: DelegationTree = { activations: [], links: [], raise: null, linked: false };
  // Joins by step and slot, oldest first, until their inner run starts or the decision ends them.
  const joins = new Map<string, LinkNode[]>();
  // Every inner run in flight, by its id.
  const runs = new Map<string, LinkNode>();
  const current = (): ActivationNode | null => tree.activations.at(-1) ?? null;
  const place = (node: LinkNode): void => {
    const activation = current();
    // A role's step is `<node>/<role>/<step>`; anything else ran beside the network.
    if (activation !== null && activation.state === "working" && node.node_id.split("/")[1] === activation.role) activation.links.push(node);
    else tree.links.push(node);
  };
  const linkNode = (event: JsonObject, kind: "link" | "join"): LinkNode => ({
    kind,
    node_id: text(event.node_id) ?? "",
    name: text(event.dependency) ?? text(event.slot) ?? "",
    state: "working",
    package_id: null,
    digest: null,
    inner_run_id: null,
    reserved: null,
    usage: null,
    code: null,
    input_hash: null,
    result_hash: null,
    denied_role: null,
    fetches: null,
    decision: null,
  });
  const key = (event: JsonObject): string => `${text(event.node_id) ?? ""}\u0000${text(event.slot) ?? ""}`;
  const waiting = (event: JsonObject): LinkNode[] => {
    const found = joins.get(key(event)) ?? [];
    joins.set(key(event), found);
    return found;
  };
  /** The oldest join of this step and slot that `test` admits, taken off the list when `take`. */
  const join = (event: JsonObject, test: (node: LinkNode) => boolean, take: boolean): LinkNode | undefined => {
    const list = waiting(event);
    const index = list.findIndex(test);
    if (index < 0) return undefined;
    const [node] = take ? list.splice(index, 1) : [list[index]];
    return node;
  };
  const accepted = (node: LinkNode): boolean => node.decision?.accepted === true && node.inner_run_id === null;
  for (const raw of events) {
    const event = raw as unknown as JsonObject;
    const action = String(event.action);
    if (action === "network.activated") {
      tree.activations.push({ role: String(event.role), hop: event.hop as number, activation: event.activation as number, message_hash: text(event.message_hash), state: "working", next: null, links: [] });
    } else if (action === "route.decided" && event.allowed === true) {
      const activation = current();
      if (activation !== null) {
        activation.state = "done";
        activation.next = text(event.next);
      }
    } else if (action === "network.failed") {
      const activation = current();
      if (activation !== null && activation.state === "working") activation.state = "failed";
    } else if (action === "link.requested") {
      tree.linked = true;
      const node = linkNode(event, "join");
      node.state = "looking";
      node.fetches = Array.isArray(event.fetches) ? [...event.fetches] : [];
      const candidate = object(event.candidate);
      node.package_id = text(candidate?.package_id);
      node.digest = text(candidate?.digest);
      waiting(event).push(node);
      place(node);
    } else if (action === "link.decided") {
      tree.linked = true;
      let node = join(event, (item) => item.decision === null, false);
      if (node === undefined) {
        // A refusal before any look (`unattended`, `policy`, `join_cap`, no URL) has no `link.requested`.
        node = linkNode(event, "join");
        waiting(event).push(node);
        place(node);
      }
      const candidate = object(event.candidate);
      node.package_id = node.package_id ?? text(candidate?.package_id);
      node.digest = node.digest ?? text(candidate?.digest);
      node.decision = { accepted: event.accepted ?? false, decided_by: event.decided_by ?? null, reason: event.reason ?? null, provenance: event.provenance ?? null, ...(event.figure !== undefined ? { figure: event.figure } : {}) };
      node.state = event.accepted === true ? "working" : event.decided_by === "person" ? "declined" : "not_joined";
      node.code = event.accepted === true ? null : text(event.reason);
      // A join that was not accepted is over: nothing starts for it.
      if (event.accepted !== true) join(event, (item) => item === node, true);
    } else if (action === "link.started") {
      tree.linked = true;
      let node = "slot" in event ? join(event, accepted, true) : undefined;
      if (node === undefined) {
        node = linkNode(event, "slot" in event ? "join" : "link");
        place(node);
      }
      node.state = "working";
      node.package_id = text(event.package_id);
      node.digest = text(event.digest);
      node.inner_run_id = text(event.inner_run_id);
      node.reserved = object(event.reserved);
      node.input_hash = text(event.input_hash);
      if (node.inner_run_id !== null) runs.set(node.inner_run_id, node);
    } else if (action === "link.completed" || action === "link.failed") {
      tree.linked = true;
      const inner = text(event.inner_run_id);
      let node = inner !== null ? runs.get(inner) : undefined;
      if (inner !== null) runs.delete(inner);
      // An accepted join whose inner run could not be built fails with no run id (L-27, L-33).
      if (node === undefined && inner === null && "slot" in event) node = join(event, accepted, true);
      if (node === undefined) {
        node = linkNode(event, "slot" in event ? "join" : "link");
        place(node);
      }
      node.state = action === "link.completed" ? "answered" : "failed";
      node.usage = object(event.usage);
      node.inner_run_id = node.inner_run_id ?? text(event.inner_run_id);
      if (action === "link.completed") node.result_hash = text(event.result_hash);
      else node.code = text(event.error_code);
    } else if (action === "link.refused" || action === "link.denied") {
      tree.linked = true;
      const node = linkNode(event, "link");
      node.state = action === "link.refused" ? "refused" : "denied";
      node.code = action === "link.refused" ? text(event.reason) : "denied";
      // The network's own `link.denied` (its entry role holds a denied link) names the role, no dependency.
      if (action === "link.denied" && text(event.dependency) === null && text(event.slot) === null) {
        node.denied_role = text(event.role);
        node.name = node.denied_role ?? "";
      }
      place(node);
    } else if (action === "budget.requested") {
      tree.raise = { node_id: text(event.node_id), limit: String(event.limit), from: event.from as number, to: event.to as number, state: "asked" };
    } else if (action === "budget.raised" && tree.raise !== null) {
      tree.raise.state = "raised";
    } else if (action.endsWith(".refused") && tree.raise !== null && tree.raise.state === "asked" && text(event.node_id) === tree.raise.node_id) {
      // A declined or unanswered raise records nothing itself: the refusal it would have avoided follows, at the same operation.
      tree.raise.state = "kept";
    } else if ((action === "workflow.completed" || action === "workflow.failed" || action === "workflow.cancelled") && tree.raise !== null && tree.raise.state === "asked") {
      tree.raise.state = "kept";
    }
  }
  return tree;
}
