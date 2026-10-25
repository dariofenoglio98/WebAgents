"""What a package may declare about a delegation network, checked at validation (network.v0 §2,
R-2…R-12, and R-22), before any host runs anything.

Refusals are `ValidationError`s whose text starts with the specification's code, so that both
runtimes refuse a package with the same message (the conformance suite compares refusals).
Nothing here imports the interpreter: the control plane describes a network from this module.
"""

from __future__ import annotations

from ..errors import ValidationError
from ..validation import release, validate_instance
from ..workflow_values import references, tokens
from .analysis import (
    DONE,
    activation_bound,
    activation_costs,
    network_nodes,
    network_of,
    worst_case,
)

NETWORK_MINIMUM_VERSION = "0.7.0"
MAX_ROLES = 16
MAX_HOPS = 64
MAX_STATE_KEYS = 64
#: The sources a role's program may read: its view of the shared state, the message it was
#: handed, and the results of its earlier steps.
ROLE_SOURCES = ("state", "message", "steps")
#: An answer check of an `llm` step reads the answer as `result` (workflow.v0 §5), the one
#: source beyond the three, and only there.
CHECK_SOURCES = ROLE_SOURCES + ("result",)


def _refuse(code: str, message: str) -> ValidationError:
    error = ValidationError(f"{code}: {message}")
    error.code = code
    return error


def _constructors(role) -> list[tuple[str, dict, tuple]]:
    """Every value constructor of a role's program, with a label and the sources it may read:
    step inputs, conditions, assertions and checks, the writes, and the route's input or
    message."""
    found = []
    for step in role["steps"]:
        label = f"step {step['id']}"
        found.append((label + "/input", step["input"], ROLE_SOURCES))
        if "when" in step:
            found.append((label + "/when/left", step["when"]["left"], ROLE_SOURCES))
            found.append((label + "/when/right", step["when"]["right"], ROLE_SOURCES))
            found.append((label + "/otherwise", step["otherwise"], ROLE_SOURCES))
        for key, sources in (("assertions", ROLE_SOURCES), ("checks", CHECK_SOURCES)):
            for index, rule in enumerate(step.get(key, [])):
                for field in ("left", "right", "rows", "targets", "equals"):
                    if field in rule:
                        found.append((f"{label}/{key}/{index}/{field}", rule[field], sources))
    for pointer, value in role["writes"].items():
        found.append((f"writes/{pointer}", value, ROLE_SOURCES))
    route = role["route"]
    if "task" in route:
        found.append(("route/input", route["input"], ROLE_SOURCES))
    else:
        found.append(("route/message", route["message"], ROLE_SOURCES))
    return found


def check_network_declarations(
    manifest,
    graph,
    policy,
    tools,
    files,
    *,
    documents,
    schema,
    expression,
    operation,
    nodes,
) -> dict | None:
    """The network object, the one node that runs it, the roles against the workers, the edges,
    the state views, the programs and the bound against the package's own budget; called by
    `validate_workflow` after the top-level nodes were checked. A graph without a network
    returns None (and may hold no `network` node)."""
    network = network_of(graph)
    runners = network_nodes(graph)
    coordinator = graph["coordinator"]
    if network is None:
        if runners:
            raise _refuse(
                "network_without_declaration",
                f"node {runners[0]['id']}: a network node runs the graph's network, and the "
                "graph declares none",
            )
        return None
    if release(manifest["runtime"]["minimum_version"]) < release(NETWORK_MINIMUM_VERSION):
        raise _refuse(
            "network_minimum_version",
            f"a network requires runtime.minimum_version {NETWORK_MINIMUM_VERSION} or later",
        )
    if not runners:
        raise _refuse(
            "network_node_required", "the graph declares a network and no node of type network"
        )
    if len(runners) > 1:
        raise _refuse(
            "network_node_once",
            f"a graph runs its network in one node; {len(runners)} nodes of type network",
        )
    runner = runners[0]
    if runner["worker"] != coordinator:
        raise _refuse(
            "network_node_role",
            f"node {runner['id']}: the network node runs on the coordinator; its roles are the "
            "workers it activates",
        )
    workers = {w["id"]: w for w in graph["workers"]}
    roles = network["roles"]
    if len(roles) > MAX_ROLES:
        raise _refuse("network_roles", f"a network declares at most {MAX_ROLES} roles")
    for role_id in roles:
        if role_id == DONE:
            raise _refuse("network_role_reserved", f"{DONE!r} is the end, not a role")
        if role_id not in workers:
            raise _refuse("network_role_unknown", f"role {role_id!r} is not a declared worker")
        if role_id == coordinator:
            raise _refuse(
                "network_role_coordinator",
                f"role {role_id!r} is the coordinator, which routes nothing",
            )
    for node in nodes.values():
        if node["worker"] in roles:
            raise _refuse(
                "network_worker_shared",
                f"node {node['id']}: worker {node['worker']!r} is a network role and runs only "
                "inside the network",
            )
    if network["entry"] not in roles:
        raise _refuse("network_entry_unknown", f"entry {network['entry']!r} is not a role")
    for role_id, role in roles.items():
        seen = set()
        for edge in role["edges"]:
            if edge["to"] not in roles:
                raise _refuse(
                    "network_edge_unknown",
                    f"role {role_id}: edge to undeclared role {edge['to']!r}",
                )
            if edge["to"] in seen:
                raise _refuse(
                    "network_edge_duplicate", f"role {role_id}: two edges to {edge['to']!r}"
                )
            seen.add(edge["to"])
        if not role["edges"] and not role["may_end"]:
            raise _refuse(
                "network_role_dead_end",
                f"role {role_id}: no edge and may_end false, so no activation of it could end",
            )
    state_path = network["state_schema"]
    schema_paths = set(documents)
    if state_path not in schema_paths:
        raise _refuse(
            "network_state_schema_undeclared",
            f"network.state_schema {state_path!r} is not a declared schema",
        )
    state_schema = documents[state_path]
    properties = state_schema.get("properties") if isinstance(state_schema, dict) else None
    if (
        not isinstance(state_schema, dict)
        or state_schema.get("type") != "object"
        or state_schema.get("additionalProperties") is not False
        or not isinstance(properties, dict)
        or len(properties) > MAX_STATE_KEYS
    ):
        raise _refuse(
            "network_state_schema_open",
            f"{state_path}: the shared state is a closed object schema (type object, "
            f"additionalProperties false) of at most {MAX_STATE_KEYS} properties",
        )
    keys = set(properties)
    for role_id in roles:
        worker = workers[role_id]
        outside = sorted((set(worker["state_read"]) | set(worker["state_write"])) - keys)
        if outside:
            raise _refuse(
                "network_state_key_undeclared",
                f"role {role_id}: state view names {outside[0]!r}, which the network's state "
                f"schema {state_path} does not declare",
            )
    initial = network["initial"]
    if "literal" not in initial:
        raise _refuse("network_initial_literal", "network.initial must be a literal")
    try:
        validate_instance(files, state_path, initial["literal"], "network.initial")
    except ValidationError as exc:
        raise _refuse("network_initial_invalid", str(exc)) from exc
    # Read before initialization (R-6): a patch sets keys and never removes one, so a key that
    # `initial` sets is present in every later state, and a key it does not set may be absent
    # when a role reads it (the order of writes is the model's). Every key of a role's view is
    # set by `initial`; the top-level graph is refused for the same read statically.
    initialized = set(initial["literal"])
    for role_id in roles:
        missing = sorted(set(workers[role_id]["state_read"]) - initialized)
        if missing:
            raise _refuse(
                "network_state_read_uninitialized",
                f"role {role_id}: state view reads {missing[0]!r}, which network.initial does "
                "not set (a key read by a role is set by initial, since the order of the "
                "roles' writes is chosen at run time)",
            )
    message_path = network["message_schema"]
    if message_path not in schema_paths:
        raise _refuse(
            "network_message_schema_undeclared",
            f"network.message_schema {message_path!r} is not a declared schema",
        )
    tasks = {t["id"] for t in manifest["model_requirements"]["tasks"]}
    for role_id, role in roles.items():
        worker = workers[role_id]
        label = f"network role {role_id}"
        # The view first (R-8): a program reads its own view of the shared state, the message
        # and its earlier steps; a read outside the view is refused by name before the generic
        # scope check would word it differently.
        for name, value, sources in _constructors(role):
            for source, pointer in references(value):
                if source not in sources:
                    raise _refuse(
                        "network_source_scope",
                        f"{label}/{name}: source {source!r} is not available inside a role "
                        f"(the sources are {', '.join(sources)})",
                    )
                parts = tokens(pointer)
                if source == "state" and (not parts or parts[0] not in worker["state_read"]):
                    raise _refuse(
                        "network_state_read_outside_view",
                        f"{label}/{name}: reads {pointer!r} outside the role's state_read view",
                    )
        env = {
            "state": (state_schema, state_path),
            "message": (documents[message_path], message_path),
            "steps": {},
        }
        seen = set()
        for step in role["steps"]:
            if step["id"] in seen:
                raise _refuse("network_step_duplicate", f"{label}: two steps named {step['id']!r}")
            seen.add(step["id"])
            operation(step, role_id, env, f"{label}/{step['id']}", None)
            env["steps"][step["id"]] = schema(step["output_schema"], label)
        for pointer, value in role["writes"].items():
            parts = tokens(pointer)
            if len(parts) != 1 or parts[0] not in worker["state_write"]:
                raise _refuse(
                    "network_state_write_outside_view",
                    f"{label}: writes {pointer!r}, which is not one key of the role's "
                    "state_write view",
                )
            expression(value, env, f"{label}/writes/{pointer}", role_id, None)
        route = role["route"]
        if "task" in route:
            if route["task"] not in tasks:
                raise _refuse(
                    "network_route_task_unknown",
                    f"{label}: route task {route['task']!r} is not a declared model task",
                )
            expression(route["input"], env, f"{label}/route/input", role_id, None)
        else:
            if route["next"] == DONE:
                if not role["may_end"]:
                    raise _refuse(
                        "network_end_not_allowed",
                        f"{label}: the route ends the network and may_end is false",
                    )
            elif route["next"] not in {edge["to"] for edge in role["edges"]}:
                raise _refuse(
                    "network_edge_undeclared",
                    f"{label}: the route hands off to {route['next']!r} and no edge to it is "
                    "declared",
                )
            expression(route["message"], env, f"{label}/route/message", role_id, None)
    for source, pointer in references(network["result"]):
        parts = tokens(pointer)
        if source == "state" and parts and parts[0] not in initialized:
            raise _refuse(
                "network_state_read_uninitialized",
                f"network.result: reads {parts[0]!r}, which network.initial does not set",
            )
    expression(
        network["result"],
        {"state": (state_schema, state_path), "message": (documents[message_path], message_path)},
        "network.result",
    )
    # The bound against the package's own budgets (R-22): what the page says the network can
    # spend at most must be what the package lets it spend.
    bound = worst_case(graph, policy)
    budget = policy["budget"]
    if bound["relaxation"]["tokens"] > budget["hard_tokens"]:
        raise _refuse(
            "network_bound_exceeds_budget",
            f"the network's worst case is {bound['relaxation']['tokens']} tokens, above the "
            f"package's hard_tokens of {budget['hard_tokens']}",
        )
    if bound["relaxation"]["remote_calls"] > budget["max_remote_calls"]:
        raise _refuse(
            "network_bound_exceeds_budget",
            f"the network's worst case is {bound['relaxation']['remote_calls']} remote calls, "
            f"above the package's max_remote_calls of {budget['max_remote_calls']}",
        )
    return {"node": runner["id"], "roles": list(roles), "bound": bound}


def network_records(package) -> dict | None:
    """The network as `inspect` and the agent page list it (R-24): the entry, the hop cap, the
    schemas, each role with its program's shape, its edges and its activation bound, and the
    worst case under the package's own budgets."""
    graph = package.graph
    network = network_of(graph)
    if network is None:
        return None
    runners = network_nodes(graph)
    workers = {w["id"]: w for w in graph["workers"]}
    roles = []
    for role_id, role in network["roles"].items():
        costs = activation_costs(graph, role_id)
        roles.append(
            {
                "id": role_id,
                "description": role["description"],
                "skills": list(workers[role_id]["skills"]),
                "tools": sorted({s["tool"] for s in role["steps"] if s["type"] == "tool"}),
                "steps": [{"id": s["id"], "type": s["type"]} for s in role["steps"]],
                "route": (
                    {"kind": "chosen", "task": role["route"]["task"]}
                    if "task" in role["route"]
                    else {"kind": "fixed", "next": role["route"]["next"]}
                ),
                "edges": [dict(edge) for edge in role["edges"]],
                "may_end": role["may_end"],
                "max_activations": role.get("max_activations"),
                "activation_bound": activation_bound(network, role_id),
                "timeout_seconds": role["timeout_seconds"],
                "budget": dict(workers[role_id]["budget"]),
                "state_read": list(workers[role_id]["state_read"]),
                "state_write": list(workers[role_id]["state_write"]),
                "per_activation": costs,
            }
        )
    return {
        "node": runners[0]["id"] if runners else None,
        "entry": network["entry"],
        "max_hops": network["max_hops"],
        "state_schema": network["state_schema"],
        "state_keys": list(package.json(network["state_schema"]).get("properties", {})),
        "message_schema": network["message_schema"],
        "roles": roles,
        "worst_case": worst_case(graph, package.policy),
    }


__all__ = [
    "CHECK_SOURCES",
    "MAX_HOPS",
    "MAX_ROLES",
    "MAX_STATE_KEYS",
    "NETWORK_MINIMUM_VERSION",
    "ROLE_SOURCES",
    "check_network_declarations",
    "network_records",
]
