"""The worst case of a network (spec/network-v0.md section 3): the activation bound, the greedy
relaxation against brute force over every allowed walk on random small networks (sound: never
below the walk maximum), exact on stars and chains, the enumerator's order and effort cap, and
the route availability a fixture is built from."""

import random
from collections import Counter

import pytest

from agentpkg.delegation.analysis import (
    EffortExceeded,
    activation_bound,
    activation_costs,
    allocate,
    enumerate_walks,
    route_data,
    route_targets,
    walk_costs,
    worst_case,
)

COMPONENTS = ("model_calls", "compute_calls", "remote_calls", "tokens", "seconds")


def _graph(roles, entry, max_hops, *, deadline=1000):
    """A graph with one network over synthetic roles: `roles[r] = (edges, may_end, costs)` with
    `costs = (llm steps, tool steps, remote_calls, tokens, seconds, max_activations)`."""
    workers = [
        {
            "id": "C",
            "kind": "packaged",
            "skills": [],
            "tools": [],
            "max_instances": 1,
            "budget": {"tokens": 0, "remote_calls": 0},
            "state_read": [],
            "state_write": [],
        }
    ]
    network_roles = {}
    for role_id, (edges, may_end, costs) in roles.items():
        llm, tool, remote, tokens, seconds, cap = costs
        workers.append(
            {
                "id": role_id,
                "kind": "packaged",
                "skills": [],
                "tools": ["t"],
                "max_instances": 1,
                "budget": {"tokens": tokens, "remote_calls": remote},
                "state_read": [],
                "state_write": [],
            }
        )
        steps = [
            {
                "id": f"l{i}",
                "type": "llm",
                "task": "x",
                "max_output_tokens": 10,
                "input": {"literal": 1},
                "output_schema": "s",
                "timeout_seconds": 1,
            }
            for i in range(llm)
        ] + [
            {
                "id": f"t{i}",
                "type": "tool",
                "tool": "t",
                "input": {"literal": 1},
                "output_schema": "s",
                "timeout_seconds": 1,
            }
            for i in range(tool)
        ]
        role = {
            "description": role_id,
            "steps": steps,
            "writes": {},
            "route": {"task": "route", "max_output_tokens": 10, "input": {"literal": 1}},
            "timeout_seconds": seconds,
            "edges": [{"to": to, "max_uses": uses} for to, uses in edges],
            "may_end": may_end,
        }
        if cap is not None:
            role["max_activations"] = cap
        network_roles[role_id] = role
    return {
        "workers": workers,
        "deadline_seconds": deadline,
        "network": {
            "entry": entry,
            "max_hops": max_hops,
            "state_schema": "s",
            "initial": {"literal": {}},
            "message_schema": "m",
            "result": {"literal": 1},
            "roles": network_roles,
        },
        "nodes": [{"id": "n", "type": "network", "worker": "C", "timeout_seconds": 500}],
    }


POLICY = {
    "budget": {"hard_tokens": 10**9, "max_remote_calls": 10**9, "max_calls_per_tool": {"t": 10**9}}
}


def _star(k, *, hops=None, tokens_entry=800, tokens_leaf=300):
    """The entry (one model step and a chosen route) and k specialists (one tool step and a
    fixed return), each edge once: the travel network's shape."""
    roles = {"E": ([(f"S{i}", 1) for i in range(k)], True, (1, 0, 2, tokens_entry, 60, None))}
    for i in range(k):
        roles[f"S{i}"] = ([("E", 1)], False, (0, 1, 1, tokens_leaf, 30, None))
    graph = _graph(roles, "E", 2 * k if hops is None else hops)
    for i in range(k):
        graph["network"]["roles"][f"S{i}"]["route"] = {"next": "E", "message": {"literal": 1}}
    return graph


def test_the_activation_bound_counts_inbound_uses_and_the_entry():
    graph = _star(3)
    network = graph["network"]
    assert activation_bound(network, "E") == 4  # 1 + three returns
    assert activation_bound(network, "S0") == 1
    network["max_hops"] = 2
    assert activation_bound(network, "E") == 3  # the hops cap it: 2 transitions + the entry
    network["roles"]["E"]["max_activations"] = 2
    assert activation_bound(network, "E") == 2


def test_the_greedy_allocation_is_the_unit_weight_knapsack():
    counts = allocate({"a": 5, "b": 9, "c": 1}, {"a": 2, "b": 1, "c": 3}, "a", 4)
    # One of the entry first, then the costliest (b, capped at 1), then a's second, then c.
    assert counts == {"a": 2, "b": 1, "c": 1}
    assert allocate({"a": 5, "b": 9}, {"a": 2, "b": 1}, "a", 1) == {"a": 1, "b": 0}
    # Declaration order breaks ties.
    assert allocate({"a": 1, "b": 1, "c": 1}, {"a": 1, "b": 1, "c": 1}, "a", 2) == {
        "a": 1,
        "b": 1,
        "c": 0,
    }


def test_a_star_is_exact_in_every_component():
    graph = _star(3)
    bound = worst_case(graph, POLICY)
    walks = enumerate_walks(graph["network"])
    assert len(walks) == 16  # E alone, 3 single tours, 6 double, 6 triple
    observed = [walk_costs(graph, walk) for walk in walks]
    for name in COMPONENTS:
        assert bound["relaxation"][name] == max(w[name] for w in observed), name
    assert bound["tool_calls"]["t"] == max(w["tool_calls"].get("t", 0) for w in observed) == 3
    assert bound["activations"] == {"E": 4, "S0": 1, "S1": 1, "S2": 1}
    assert bound["max_activations"] == 7 and bound["max_hops"] == 6
    assert bound["model_calls"] == 8 and bound["tokens"] == 4 * 800 + 3 * 300
    full = max(observed, key=lambda w: w["tokens"])
    assert full["activations"] == {"E": 4, "S0": 1, "S1": 1, "S2": 1} and full["hops"] == 6


def test_the_bound_is_capped_by_the_run_and_the_node():
    graph = _star(2)
    policy = {
        "budget": {"hard_tokens": 1000, "max_remote_calls": 3, "max_calls_per_tool": {"t": 1}}
    }
    bound = worst_case(graph, policy)
    assert bound["relaxation"]["tokens"] == 3 * 800 + 2 * 300 and bound["tokens"] == 1000
    assert bound["relaxation"]["remote_calls"] == 3 * 2 + 2 and bound["remote_calls"] == 3
    assert bound["relaxation"]["tool_calls"] == {"t": 2} and bound["tool_calls"] == {"t": 1}
    assert bound["relaxation"]["seconds"] == 3 * 60 + 2 * 30 and bound["seconds"] == 240
    assert worst_case(graph, policy, node_timeout=50)["seconds"] == 50
    assert (
        worst_case(graph, policy, budget={"hard_tokens": 5, "max_remote_calls": 0})["tokens"] == 5
    )


def test_the_relaxation_can_exceed_the_walk_maximum_and_never_falls_below_it():
    # r0 -> r1 three times, r1 -> r0 once: no walk activates r1 three times, the relaxation
    # allows it (the note's example of a loose bound).
    graph = _graph(
        {
            "r0": ([("r1", 3)], True, (1, 0, 0, 100, 10, None)),
            "r1": ([("r0", 1)], False, (0, 1, 0, 50, 10, None)),
        },
        "r0",
        6,
    )
    bound = worst_case(graph, POLICY)
    walks = enumerate_walks(graph["network"])
    # r1 can return once, so one tour is the most; a second visit to r1 could not end.
    assert walks == [("r0",), ("r0", "r1", "r0")]
    assert max(walk_costs(graph, w)["tokens"] for w in walks) == 2 * 100 + 1 * 50
    assert bound["activations"] == {"r0": 2, "r1": 3}
    assert bound["relaxation"]["tokens"] == 2 * 100 + 3 * 50


def _random_graph(rng):
    n = rng.randint(1, 4)
    names = [f"r{i}" for i in range(n)]
    roles = {}
    for name in names:
        edges = []
        for target in names:
            if rng.random() < 0.6:
                edges.append((target, rng.randint(1, 3)))
        may_end = rng.random() < 0.6
        if not edges and not may_end:
            may_end = True
        cap = rng.choice([None, None, 1, 2, 3])
        roles[name] = (
            edges,
            may_end,
            (
                rng.randint(0, 2),
                rng.randint(0, 2),
                rng.randint(0, 3),
                rng.randint(0, 500),
                rng.randint(1, 30),
                cap,
            ),
        )
    return _graph(roles, "r0", rng.randint(1, 5))


def test_the_relaxation_dominates_every_walk_on_random_networks():
    """Soundness by brute force: on random small networks, no allowed walk costs more than the
    bound in any component. Seeds whose networks admit no complete walk (a role that may not
    end leading only to such roles: valid to declare, failed by the runtime at the last
    transition) or too many walks for the effort cap are passed over, and at least sixty must
    be checked."""
    checked = 0
    for seed in range(160):
        rng = random.Random(seed)
        graph = _random_graph(rng)
        bound = worst_case(graph, POLICY)
        try:
            walks = enumerate_walks(graph["network"], effort=20000)
        except EffortExceeded:
            continue
        if not walks:
            continue
        checked += 1
        for walk in walks:
            costs = walk_costs(graph, walk)
            assert costs["hops"] <= bound["max_hops"]
            assert sum(costs["activations"].values()) <= bound["max_activations"]
            for role_id, count in costs["activations"].items():
                assert count <= bound["activations"][role_id]
            for name in COMPONENTS:
                assert costs[name] <= bound["relaxation"][name], (name, walk, seed)
            for tool, count in costs["tool_calls"].items():
                assert count <= bound["relaxation"]["tool_calls"][tool]
    assert checked >= 60


def test_the_enumerator_lists_walks_depth_first_in_declaration_order_and_caps_its_effort():
    graph = _graph(
        {
            "a": ([("b", 1), ("c", 1)], True, (0, 0, 0, 1, 1, None)),
            "b": ([("a", 1)], True, (0, 0, 0, 1, 1, None)),
            "c": ([], True, (0, 0, 0, 1, 1, None)),
        },
        "a",
        4,
    )
    walks = enumerate_walks(graph["network"])
    assert walks == [
        ("a",),
        ("a", "b"),
        ("a", "b", "a"),
        ("a", "b", "a", "c"),
        ("a", "c"),
    ]
    with pytest.raises(EffortExceeded):
        enumerate_walks(graph["network"], effort=3)


def test_activation_costs_count_steps_and_the_chosen_route():
    graph = _star(1)
    costs = activation_costs(graph, "E")
    assert costs == {
        "model_calls": 2,
        "tool_calls": {},
        "compute_calls": 0,
        "remote_calls": 2,
        "tokens": 800,
        "seconds": 60,
    }
    graph["network"]["roles"]["E"]["route"] = {"next": "done", "message": {"literal": 1}}
    assert activation_costs(graph, "E")["model_calls"] == 1
    assert activation_costs(graph, "S0")["tool_calls"] == {"t": 1}


def test_route_availability_counts_down_uses_activations_and_hops():
    graph = _star(2, hops=3)
    network = graph["network"]
    network["roles"]["S1"]["max_activations"] = 1
    uses, activations = Counter(), Counter({"E": 1})
    first = route_targets(network, "E", uses, activations, 0)
    assert [(t["role"], t["uses_left"]) for t in first] == [("S0", 1), ("S1", 1)]
    uses[("E", "S0")] += 1
    activations["S0"] += 1
    activations["S1"] += 1
    later = route_targets(network, "E", uses, activations, 2)
    assert [(t["role"], t["uses_left"]) for t in later] == [("S0", 0), ("S1", 0)]
    data = route_data(network, "E", {"q": 1}, uses, activations, 2)
    assert data == {"input": {"q": 1}, "targets": later, "hops_left": 1, "may_end": True}
    assert route_targets(network, "E", Counter(), Counter(), 3)[0]["uses_left"] == 0
