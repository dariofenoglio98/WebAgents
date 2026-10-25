"""The worst case of a delegation network, computed from the declaration alone (network.v0 §3).

Pure arithmetic over the graph and the policy: no package is opened, no model is contacted, and
nothing here imports the interpreter, so the control plane may compute what the agent page says.

Three things live here:

* the **per-activation costs** of a role (model calls, tool calls per tool, compute calls, and
  the worker's own token and remote-call budgets, which the mediator enforces per instance);
* the **bound**: for each role the most activations any allowed walk can hold (R-20), and the
  greedy relaxation that maximizes each cost component over those counts under the hop cap
  (R-21), capped by the run's own limits: this is the normative "at most";
* the **enumerator** of every allowed walk (R-23), for tests and the evaluation: the exact
  maximum over walks is NP-hard in general, so it is never a plan figure, but on a small network
  it tells whether the bound is attained.
"""

from __future__ import annotations

from collections import Counter

DONE = "done"
#: The cost components of one activation that a walk sums.
COMPONENTS = ("model_calls", "compute_calls", "remote_calls", "tokens", "seconds")
#: Walk prefixes an enumeration may visit before it gives up (deterministic, both runtimes).
DEFAULT_EFFORT = 100_000


class EffortExceeded(Exception):
    """The enumeration visited more walk prefixes than its effort cap allows."""


def network_of(graph) -> dict | None:
    return graph.get("network")


def network_nodes(graph) -> list[dict]:
    return [node for node in graph.get("nodes", []) if node["type"] == "network"]


def role_steps(graph):
    """Every step of every role, with its qualified identity `<node>/<role>/<step>`."""
    network = network_of(graph)
    if network is None:
        return
    nodes = network_nodes(graph)
    node_id = nodes[0]["id"] if nodes else "network"
    for role_id, role in network["roles"].items():
        for step in role["steps"]:
            yield f"{node_id}/{role_id}/{step['id']}", step


def route_calls(graph):
    """Every model-chosen route, as the one model call it is (`<node>/<role>/route`)."""
    network = network_of(graph)
    if network is None:
        return
    nodes = network_nodes(graph)
    node_id = nodes[0]["id"] if nodes else "network"
    for role_id, role in network["roles"].items():
        if "task" in role["route"]:
            yield f"{node_id}/{role_id}/route", role["route"]


def activation_costs(graph, role_id: str) -> dict:
    """What one activation of a role can cost at most (R-19): each step runs at most once (a
    conditional one counts as taken), a chosen route is one model call, and the worker's
    budgets bound its tokens and remote calls per instance."""
    network = network_of(graph)
    role = network["roles"][role_id]
    worker = next(w for w in graph["workers"] if w["id"] == role_id)
    steps = role["steps"]
    return {
        "model_calls": sum(1 for s in steps if s["type"] == "llm")
        + (1 if "task" in role["route"] else 0),
        "tool_calls": dict(Counter(s["tool"] for s in steps if s["type"] == "tool")),
        "compute_calls": sum(1 for s in steps if s["type"] == "compute"),
        "remote_calls": worker["budget"]["remote_calls"],
        "tokens": worker["budget"]["tokens"],
        "seconds": role["timeout_seconds"],
    }


def activation_bound(network, role_id: str) -> int:
    """The most times any allowed walk activates a role (R-20): every activation but the entry's
    first follows an edge into it, each edge is taken at most `max_uses` times, there are at
    most `max_hops` transitions, and the role's own `max_activations` caps it further."""
    role = network["roles"][role_id]
    entry = 1 if role_id == network["entry"] else 0
    inbound = sum(
        edge["max_uses"]
        for other in network["roles"].values()
        for edge in other["edges"]
        if edge["to"] == role_id
    )
    bound = min(inbound + entry, network["max_hops"] + entry)
    if "max_activations" in role:
        bound = min(bound, role["max_activations"])
    return bound


def allocate(costs: dict, bounds: dict, entry: str, total: int) -> dict:
    """The greedy relaxation (R-21): one activation of the entry, then activations in descending
    order of cost (declaration order breaks ties) up to each role's bound, until `total`
    activations are placed. Exact for a bounded knapsack with unit weights."""
    counts = {role: 0 for role in costs}
    if total < 1 or bounds.get(entry, 0) < 1:
        return counts
    counts[entry] = 1
    placed = 1
    order = sorted(costs, key=lambda role: (-costs[role], list(costs).index(role)))
    for role in order:
        room = min(bounds[role] - counts[role], total - placed)
        if room <= 0:
            continue
        counts[role] += room
        placed += room
        if placed >= total:
            break
    return counts


def _summed(costs_by_role: dict, counts: dict):
    return sum(counts[role] * cost for role, cost in costs_by_role.items())


def worst_case(graph, policy, *, budget=None, node_timeout=None) -> dict:
    """The "at most" of a network (R-21, R-22): per component, the relaxation's maximum capped by
    the run's own limit for that component (`budget`: the effective run budget, the declared one
    by default). `relaxation` keeps the uncapped figures (validation compares them with the
    package's own budget, R-22); `activations` is each role's bound."""
    network = network_of(graph)
    roles = list(network["roles"])
    entry = network["entry"]
    bounds = {role: activation_bound(network, role) for role in roles}
    total = min(network["max_hops"] + 1, sum(bounds.values()))
    costs = {role: activation_costs(graph, role) for role in roles}
    caps = dict(budget or policy["budget"])
    deadline = graph["deadline_seconds"]
    nodes = network_nodes(graph)
    timeout = node_timeout
    if timeout is None and nodes:
        timeout = nodes[0]["timeout_seconds"]

    def component(name):
        by_role = {role: costs[role][name] for role in roles}
        return _summed(by_role, allocate(by_role, bounds, entry, total))

    tools = sorted({tool for role in roles for tool in costs[role]["tool_calls"]})
    tool_calls = {}
    for tool in tools:
        by_role = {role: costs[role]["tool_calls"].get(tool, 0) for role in roles}
        tool_calls[tool] = _summed(by_role, allocate(by_role, bounds, entry, total))
    relaxation = {
        name: component(name) for name in ("model_calls", "compute_calls", "remote_calls", "tokens")
    }
    relaxation["seconds"] = component("seconds")
    relaxation["tool_calls"] = dict(tool_calls)
    per_tool_caps = dict(caps.get("max_calls_per_tool", {}))
    seconds_caps = [relaxation["seconds"], deadline] + ([timeout] if timeout is not None else [])
    return {
        "max_hops": network["max_hops"],
        "max_activations": total,
        "activations": bounds,
        "model_calls": relaxation["model_calls"],
        "tool_calls": {
            tool: min(count, per_tool_caps[tool]) if tool in per_tool_caps else count
            for tool, count in tool_calls.items()
        },
        "compute_calls": relaxation["compute_calls"],
        "remote_calls": min(relaxation["remote_calls"], caps["max_remote_calls"]),
        "tokens": min(relaxation["tokens"], caps["hard_tokens"]),
        "seconds": min(seconds_caps),
        "relaxation": relaxation,
        "caps": {
            "hard_tokens": caps["hard_tokens"],
            "max_remote_calls": caps["max_remote_calls"],
            "max_calls_per_tool": per_tool_caps,
            "timeout_seconds": timeout,
            "deadline_seconds": deadline,
        },
    }


def route_targets(network, role_id: str, uses: Counter, activations: Counter, hop: int) -> list:
    """What a role may still hand off to at this point of the walk, in edge order: each declared
    target with its description and how many more times the edge can be taken (zero when the
    edge, the target's activations or the hops are exhausted). Pure, so a fixture can be built
    from it."""
    role = network["roles"][role_id]
    hops_left = network["max_hops"] - hop
    targets = []
    for edge in role["edges"]:
        target = network["roles"][edge["to"]]
        left = edge["max_uses"] - uses[(role_id, edge["to"])]
        if "max_activations" in target:
            left = min(left, target["max_activations"] - activations[edge["to"]])
        targets.append(
            {
                "role": edge["to"],
                "description": target["description"],
                "uses_left": max(0, min(left, hops_left)),
            }
        )
    return targets


def route_data(network, role_id: str, input_value, uses: Counter, activations: Counter, hop: int):
    """The data of a route request (R-13): the role's constructed input and the availability."""
    return {
        "input": input_value,
        "targets": route_targets(network, role_id, uses, activations, hop),
        "hops_left": network["max_hops"] - hop,
        "may_end": network["roles"][role_id]["may_end"],
    }


def enumerate_walks(
    network, *, effort: int = DEFAULT_EFFORT, complete: bool = True
) -> list[tuple[str, ...]]:
    """Every complete walk the network admits (R-23): from the entry, along declared edges within
    their `max_uses`, the targets' `max_activations` and `max_hops`, ending at a role that may
    end. Depth first in declaration order, so two runtimes list the same walks in the same
    order. Raises `EffortExceeded` past `effort` visited prefixes. With `complete` false, every
    reachable prefix instead (the walks of failed runs too: what a run can have spent when it
    stops anywhere), for the soundness checks."""
    roles = network["roles"]
    entry = network["entry"]
    walks: list[tuple[str, ...]] = []
    visited = 0

    def visit(current, path, uses, activations, hop):
        nonlocal visited
        visited += 1
        if visited > effort:
            raise EffortExceeded(f"more than {effort} walk prefixes")
        if not complete or roles[current]["may_end"]:
            walks.append(tuple(path))
        if hop >= network["max_hops"]:
            return
        for edge in roles[current]["edges"]:
            target = edge["to"]
            if uses[(current, target)] >= edge["max_uses"]:
                continue
            cap = roles[target].get("max_activations")
            if cap is not None and activations[target] >= cap:
                continue
            uses[(current, target)] += 1
            activations[target] += 1
            path.append(target)
            visit(target, path, uses, activations, hop + 1)
            path.pop()
            uses[(current, target)] -= 1
            activations[target] -= 1

    visit(entry, [entry], Counter(), Counter({entry: 1}), 0)
    return walks


def walk_costs(graph, walk) -> dict:
    """The cost vector of one walk: the per-activation costs summed over its activations."""
    totals = {name: 0 for name in COMPONENTS}
    tools: Counter = Counter()
    for role_id in walk:
        costs = activation_costs(graph, role_id)
        for name in COMPONENTS:
            totals[name] += costs[name]
        tools.update(costs["tool_calls"])
    return {
        **totals,
        "tool_calls": dict(tools),
        "activations": dict(Counter(walk)),
        "hops": len(walk) - 1,
    }


__all__ = [
    "COMPONENTS",
    "DEFAULT_EFFORT",
    "DONE",
    "EffortExceeded",
    "activation_bound",
    "activation_costs",
    "allocate",
    "enumerate_walks",
    "network_nodes",
    "network_of",
    "role_steps",
    "route_calls",
    "route_data",
    "route_targets",
    "walk_costs",
    "worst_case",
]
