"""The worst case of a package and of a composition across links (link.v0 §4).

Pure arithmetic over declarations: no package is opened, no model is contacted, nothing here
imports the interpreter, so the control plane may compute what the review says.

* `link_operations` lists every `link` step of a graph with where it stands;
* `package_worst_case` is W(p) (L-18): what one run of a workflow.v0 package can cost at most,
  with its links' costs inside it when they are known (L-19);
* `composed_requirement` is what the composition needs of the caller's own budget (L-20).
"""

from __future__ import annotations

from collections import Counter

from ..delegation.analysis import (
    LINK_COMPONENTS,
    link_cost,
    network_nodes,
    network_of,
    worst_case,
)


def link_operations(graph):
    """Every `link` step of a graph as `(qualified id, step, where, role)`: `where` is `node` (a
    top-level node), `map` (a step of a map node) or `role` (a step of a network role); the id
    is the one the audit names (`<node>`, `<node>/<step>`, `<node>/<role>/<step>`)."""
    for node in graph.get("nodes", []):
        if node["type"] == "link":
            yield node["id"], node, "node", None
        elif node["type"] == "map":
            for step in node["steps"]:
                if step["type"] == "link":
                    yield f"{node['id']}/{step['id']}", step, "map", None
    network = network_of(graph)
    if network is None:
        return
    runners = network_nodes(graph)
    node_id = runners[0]["id"] if runners else "network"
    for role_id, role in network["roles"].items():
        for step in role["steps"]:
            if step["type"] == "link":
                yield f"{node_id}/{role_id}/{step['id']}", step, "role", role_id


def package_worst_case(graph, policy, *, budget=None, links=None) -> dict:
    """W(p) (L-18): the most one run of this package can cost, from its declaration: model calls,
    tool calls per tool under the package's caps, compute calls (exact for the program, a
    conditional operation counted as taken), and its own caps on remote calls, tokens and
    seconds. `budget` is the effective run budget (the declared one by default). `links` is
    `delegation.analysis.link_cost`'s: with a map of resolved worst cases the links' costs are
    inside the figures (L-19), their tools qualified; `requirement` is what the composition asks
    of this package's own budget (L-20)."""
    caps = dict(budget or policy["budget"])
    model = compute = 0
    tools: Counter = Counter()
    linked = {name: 0 for name in LINK_COMPONENTS}
    required = {"tokens": 0, "remote_calls": 0}
    # Where the network node is the graph's only spending node, the network's own bound caps
    # the package's remote calls and tokens below its budget.
    network_only = None

    def add(operation, times):
        nonlocal model, compute
        kind = operation["type"]
        if kind == "llm":
            model += times
        elif kind == "tool":
            tools[operation["tool"]] += times
        elif kind == "compute":
            compute += times
        elif kind == "link":
            cost = link_cost(operation, links)
            if cost is None:
                return
            for name in LINK_COMPONENTS:
                linked[name] += times * cost[name]
            for tool, count in cost["tool_calls"].items():
                tools[tool] += times * count
            required["tokens"] += times * cost["tokens"]
            required["remote_calls"] += times * cost["remote_calls"]

    for node in graph.get("nodes", []):
        if node["type"] == "map":
            for step in node["steps"]:
                add(step, node["max_items"])
        elif node["type"] == "network":
            # The network's own bound already holds its roles' links (R-19 with L-19).
            bound = worst_case(graph, policy, budget=caps, links=links)
            model += bound["model_calls"]
            compute += bound["compute_calls"]
            tools.update(bound["tool_calls"])
            required["tokens"] += bound["relaxation"]["tokens"]
            required["remote_calls"] += bound["relaxation"]["remote_calls"]
            network_only = bound
        else:
            add(node, 1)
    if any(node["type"] in ("llm", "tool", "map", "link") for node in graph.get("nodes", [])):
        network_only = None
    per_tool = dict(caps.get("max_calls_per_tool", {}))
    remote_calls, spent_tokens = caps["max_remote_calls"], caps["hard_tokens"]
    if network_only is not None:
        remote_calls = min(remote_calls, network_only["remote_calls"])
        spent_tokens = min(spent_tokens, network_only["tokens"])
    return {
        "model_calls": model + linked["model_calls"],
        "tool_calls": {
            tool: min(count, per_tool[tool]) if tool in per_tool else count
            for tool, count in sorted(tools.items())
        },
        "compute_calls": compute + linked["compute_calls"],
        "remote_calls": remote_calls,
        "tokens": spent_tokens,
        "seconds": graph["deadline_seconds"],
        "requirement": required,
    }


def composed_requirement(graph, policy, links=None) -> tuple[str, int, int] | None:
    """L-20: the first figure of the composition that the caller's own budget cannot hold, as
    `(name, needed, cap)`, or None when it fits. The network's relaxation (its roles' budgets
    and their links) and every other link's worst case, against `hard_tokens` and
    `max_remote_calls`."""
    budget = policy["budget"]
    required = package_worst_case(graph, policy, links=links)["requirement"]
    for name, cap in (("tokens", "hard_tokens"), ("remote_calls", "max_remote_calls")):
        if required[name] > budget[cap]:
            return name, required[name], budget[cap]
    return None


__all__ = ["composed_requirement", "link_operations", "package_worst_case"]
