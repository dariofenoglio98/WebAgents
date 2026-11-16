"""A package's links as `inspect` and the review list them (link.v0 L-22): the dependencies and
the slots the signed program declares, and the composed envelope once the links are resolved."""

from __future__ import annotations

from ..delegation.analysis import link_cost, network_of
from .analysis import WORST_CASE_FIGURES as FIGURES
from .analysis import link_operations, package_worst_case


def link_records(package, resolved=None, denied=()) -> dict | None:
    """`resolved`: `{id: ResolvedLink}` once preparation ran, else None: the declaration alone,
    which states a slot at its ceiling and cannot yet state a planned link's cost. `denied`:
    the dependency ids the person denied, left out of the envelope."""
    graph = package.graph
    dependencies = package.manifest.get("dependencies", [])
    operations = list(link_operations(graph))
    if not dependencies and not operations:
        return None
    costs = None
    if resolved is not None:
        costs = {
            name: None if name in denied else link.worst_case for name, link in resolved.items()
        }
    steps: dict = {}
    slots = []
    for label, step, where, role_id in operations:
        if "slot" in step:
            ceiling = link_cost(step)
            slots.append(
                {
                    "slot": step["slot"],
                    "step": label,
                    "role": role_id,
                    "max_joins": step["max_joins"],
                    "view": sorted(step["input"].get("object", {})),
                    "ceiling": {**ceiling, "seconds": step["timeout_seconds"]},
                }
            )
        else:
            steps.setdefault(step["dependency"], []).append({"step": label, "where": where})
    listed = []
    for record in dependencies:
        entry = {**record, "steps": steps.get(record.get("id"), [])}
        link = (resolved or {}).get(record.get("id"))
        if link is not None:
            entry["resolved"] = {
                **link.facts(),
                "decision": "denied" if record["id"] in denied else "accepted",
                "worst_case": {name: link.worst_case[name] for name in FIGURES},
            }
        listed.append(entry)
    composed = package_worst_case(graph, package.policy, links=costs)
    return {
        "resolved": resolved is not None,
        "dependencies": listed,
        "slots": slots,
        # Without resolution the envelope holds the slots at their ceilings and no planned
        # link yet: a figure that is not an "at most" until every dependency is resolved.
        "worst_case": {name: composed[name] for name in FIGURES},
        "network": network_of(graph) is not None,
    }


__all__ = ["link_records"]
