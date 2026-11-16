"""The links of a run whose operator is the person: the developer CLI, a conformance driver, a
campaign runner (link.v0 §3 without a control plane).

The operator supplies, per dependency, the archive (accepted only by its pinned digest) or
nothing (the locator is fetched under the package-URL policy), and the decision on that
publisher's card: accepted with that package's own grants and tool approvals, or denied. The
result is the `LinkHost` a run holds. Nothing of a linked package runs here.
"""

from __future__ import annotations

from ..errors import AgentPkgError
from ..package import MAX_FILES, MAX_TOTAL_BYTES, Package, read_regular_bytes
from .analysis import link_operations
from .host import ACCEPTED, DENIED, LinkBinding, LinkHost
from .resolve import LinkRefusal, check_model, resolve_links

OPERATOR_PLAN_SCHEMA = "agentpkg-operator-plan-v0"


def operator_plan(caller: Package, *, grants, approved_tools, limits, decisions) -> dict:
    """What an operator decided before a run, where no control plane prepared a Run Plan: the
    package, its grants and tool approvals, the host's limits and the decision on each linked
    publisher. Its canonical SHA-256 is the `plan_hash` a join's inner plan and a raise name
    (L-36, L-44)."""
    manifest = caller.manifest
    return {
        "schema": OPERATOR_PLAN_SCHEMA,
        "package": {
            "package_id": manifest["package_id"],
            "version": manifest["version"],
            "digest": caller.digest,
        },
        "decisions": dict(sorted((grants or {}).items())),
        "tool_approvals": sorted(approved_tools or ()),
        "limits": dict(sorted((limits or {}).items())),
        "links": {
            name: {
                "decision": ACCEPTED if decision.get("decision") == ACCEPTED else DENIED,
                "decisions": dict(sorted(decision.get("grants", {}).items())),
                "tool_approvals": sorted(decision.get("approved_tools", ())),
            }
            for name, decision in sorted((decisions or {}).items())
        },
    }


def split_tool_approvals(caller: Package, approvals) -> tuple[list, dict]:
    """`--approve-tool` values: a caller's own tool id, or `<dependency>:<tool>` for a linked
    package's. A value that is exactly one of the caller's tools is the caller's."""
    own, linked = [], {}
    dependencies = {record.get("id") for record in caller.manifest["dependencies"]}
    for value in approvals:
        name, _, tool = value.partition(":")
        if value not in caller.tools and tool and name in dependencies:
            linked.setdefault(name, []).append(tool)
        else:
            own.append(value)
    return sorted(set(own)), {name: sorted(set(tools)) for name, tools in linked.items()}


def operator_links(
    caller: Package,
    *,
    archives=None,
    decisions=None,
    trusted=(),
    require_trusted=False,
    router=None,
    adapters=None,
    fetch=None,
    joins=None,
    caller_plan=None,
) -> LinkHost | None:
    """Resolve the caller's dependencies and bind the operator's decisions.

    `archives`: `{id: path}` of supplied archives. `decisions`: `{id: {"decision": "accepted" |
    "denied", "grants": {...}, "approved_tools": [...], "limits": {...}}}`. `trusted`: the
    publisher key fingerprints the operator pinned for this run. `adapters(package)` returns
    `(router or None, handlers)` for an accepted linked package: its own fixture replay, or
    the host's handlers for its tools with None for the caller's model route. A package
    without dependencies and without a slot returns None. `joins` (`links.join.JoinHost`) lets
    the run's slots look and join; `caller_plan` is the operator's plan, where a decision made
    during the run is to name it."""
    archives = dict(archives or {})
    decisions = dict(decisions or {})
    declared = [record.get("id") for record in caller.manifest["dependencies"]]
    stray = sorted((set(archives) | set(decisions)) - set(declared))
    if stray:
        raise LinkRefusal(
            "link_dependency_unknown",
            f"{stray[0]!r} is not a dependency this package declares",
        )
    if not declared and next(link_operations(caller.graph), None) is None:
        return None
    sources = {
        name: read_regular_bytes(path, MAX_TOTAL_BYTES + MAX_FILES * 1024)
        for name, path in archives.items()
    }
    resolved = resolve_links(
        caller,
        sources,
        trust=lambda signer, package: "trusted" if signer in set(trusted) else "unknown",
        fetch=fetch,
    )
    bindings = {}
    for name, link in resolved.items():
        decision = decisions.get(name)
        if decision is None:
            continue
        if decision.get("decision") != ACCEPTED:
            bindings[name] = LinkBinding(link, DENIED)
            continue
        if require_trusted and link.trust != "trusted":
            raise LinkRefusal(
                "link_publisher_untrusted",
                f"dependency {name!r}: its publisher key {link.signer} is not one this host "
                "trusts; pin it before accepting the link",
            )
        approved = sorted(set(decision.get("approved_tools", ())))
        unknown = sorted(set(approved) - set(link.package.tools))
        if unknown:
            raise AgentPkgError(
                f"approved tool {unknown[0]!r} is not declared by linked package {name!r}"
            )
        inner_router, handlers = adapters(link.package) if adapters is not None else (None, {})
        check_model(link, inner_router if inner_router is not None else router)
        bindings[name] = LinkBinding(
            link,
            ACCEPTED,
            grants=dict(decision.get("grants", {})),
            approved_tools=tuple(approved),
            handlers=handlers,
            router=inner_router,
            limits=decision.get("limits"),
        )
    return LinkHost(caller, bindings, joins=joins, caller_plan=caller_plan)


__all__ = ["OPERATOR_PLAN_SCHEMA", "operator_links", "operator_plan", "split_tool_approvals"]
