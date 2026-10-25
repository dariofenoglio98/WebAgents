"""Generic, bounded browser rendering of one verified package.

Everything here is derived from declared package structure. There are no
package-ID, publisher, capability-name or application-domain branches: the two
reference packages differ in this output only because their declarations
differ. Raw instruction text, schema bodies and attestation contents are
summarized by path/size/hash and never inlined — with one deliberate exception:
the **task input schema**, which is the contract a person fills in to start a
run, is included as one bounded self-contained document so a browser can render
a form from it. Presentation hints from the noncritical `agentpkg:presentation`
extension are included only after validation (`presentation.py`).
"""

from __future__ import annotations

import copy
from urllib.parse import urlsplit

from ..package import Package, permissions_summary, sha256
from .presentation import EXTENSION_KEY, input_form, presentation_hints

SCHEMA = "agentpkg-browser-summary-v0"
MAX_LISTED_KEYS = 32


def _file_facts(package: Package, path: str) -> dict:
    data = package.files.get(path, b"")
    return {"path": path, "bytes": len(data), "sha256": sha256(data)}


def _capabilities(package: Package) -> list:
    return list(package.manifest["capabilities"])


def _skills(package: Package) -> list:
    return [
        {"id": skill["id"], "version": skill["version"], **_file_facts(package, skill["path"])}
        for skill in package.manifest["skills"]
    ]


def _tools(package: Package) -> list:
    tools = []
    for tool_id in sorted(package.tools):
        tool = package.tools[tool_id]
        endpoint = tool.get("endpoint")
        origin = None
        if endpoint:
            parts = urlsplit(endpoint)
            origin = f"{parts.scheme}://{parts.hostname}"
        tools.append(
            {
                "id": tool["id"],
                "version": tool["version"],
                "description": tool["description"],
                "execution": tool["execution"],
                "binding": tool["binding"],
                "endpoint": endpoint,
                "endpoint_origin": origin,
                "method": tool.get("method"),
                "domains": list(tool["domains"]),
                "permissions": list(tool["permissions"]),
                "side_effects": tool["side_effects"],
                "approval_required": tool["approval_required"],
                "timeout_seconds": tool["timeout_seconds"],
                "retries": tool["retries"],
                "input_schema": tool["input_schema"],
                "output_schema": tool["output_schema"],
            }
        )
    return tools


def _workers(package: Package) -> list:
    coordinator = package.graph["coordinator"]
    return [
        {
            "id": worker["id"],
            "kind": worker["kind"],
            "is_coordinator": worker["id"] == coordinator,
            "skills": list(worker["skills"]),
            "tools": list(worker["tools"]),
            "max_instances": worker["max_instances"],
            "state_read": list(worker["state_read"]),
            "state_write": list(worker["state_write"]),
            "budget": dict(worker["budget"]),
        }
        for worker in package.graph["workers"]
    ]


def _node_facts(node: dict) -> dict:
    facts = {
        "id": node["id"],
        "type": node["type"],
        "worker": node["worker"],
        "depends_on": list(node["depends_on"]),
        "timeout_seconds": node["timeout_seconds"],
        "writes": sorted(node.get("writes", {})),
        "conditional": "when" in node,
    }
    for optional in (
        "task",
        "tool",
        "max_output_tokens",
        "max_items",
        "max_parallel",
        "limit",
        # compute.v0: which module and function a node runs, and what it lowers.
        "module",
        "function",
        "input_schema",
        "limits",
        # conversation.v0: the permissions a consent step decides.
        "permissions",
    ):
        if optional in node:
            facts[optional] = node[optional]
    if node["type"] == "map":
        facts["item_schema"] = node["item_schema"]
        facts["steps"] = [
            {
                "id": step["id"],
                "type": step["type"],
                **{k: step[k] for k in ("task", "tool", "module", "function") if k in step},
            }
            for step in node["steps"]
        ]
        facts["step_count"] = len(node["steps"])
    return facts


def _workflow(package: Package) -> dict:
    graph = package.graph
    if "nodes" not in graph:
        # An archival profile is still described generically, never executed.
        return {
            "profile": graph.get("profile", "legacy-host-entrypoint"),
            "coordinator": graph["coordinator"],
            "stage_count": len(graph.get("stages", [])),
            "stages": [
                {
                    "id": stage["id"],
                    "worker": stage["worker"],
                    "depends_on": list(stage["depends_on"]),
                    "parallel": stage["parallel"],
                    "merge": stage["merge"],
                }
                for stage in graph.get("stages", [])
            ],
            "edges": [
                {"from": dependency, "to": stage["id"]}
                for stage in graph.get("stages", [])
                for dependency in stage["depends_on"]
            ],
        }
    nodes = graph["nodes"]
    types: dict[str, int] = {}
    for node in nodes:
        types[node["type"]] = types.get(node["type"], 0) + 1
    output_nodes = [node["id"] for node in nodes if node["type"] == "output"]
    return {
        "profile": graph["profile"],
        "coordinator": graph["coordinator"],
        "deadline_seconds": graph["deadline_seconds"],
        "input_schema": graph["input_schema"],
        "output_schema": graph["output_schema"],
        "node_count": len(nodes),
        "node_types": dict(sorted(types.items())),
        "entry_nodes": [node["id"] for node in nodes if not node["depends_on"]],
        "output_nodes": output_nodes,
        "max_declared_parallel": max(
            (node["max_parallel"] for node in nodes if node["type"] == "map"), default=1
        ),
        "map_item_caps": {node["id"]: node["max_items"] for node in nodes if node["type"] == "map"},
        "edges": [
            {"from": dependency, "to": node["id"]}
            for node in nodes
            for dependency in node["depends_on"]
        ],
        "nodes": [_node_facts(node) for node in nodes],
        "exports": [
            {"path": export["path"], "format": export["format"]}
            for export in graph.get("exports", [])
        ],
        "fixture_declared": "fixture" in graph,
        # conversation.v0 (V-20): the turns, the persistent keys, the consent steps and the
        # permissions they decide, for the agent page; None for a one-shot package.
        "conversation": _conversation(package),
        # network.v0 (R-24): the roles, the edges, the caps and the worst case computed from the
        # declaration, for the agent page's "at most"; None for a package without a network.
        "network": _network(package),
        # The task a person fills in, and the package's cosmetic hints for it.
        "input": input_form(package),
        "presentation": presentation_hints(package)[0],
    }


def _conversation(package: Package) -> dict | None:
    from ..conversation.declarations import conversation_records

    return conversation_records(package)


def _network(package: Package) -> dict | None:
    from ..delegation.declarations import network_records

    return network_records(package)


def _and(names: list[str]) -> str:
    """Names joined as A, B and C."""
    return names[0] if len(names) <= 1 else ", ".join(names[:-1]) + " and " + names[-1]


def network_sentence(network: dict) -> str:
    """The envelope in words (network.v0 R-24): every figure is the bound computed from the
    signed declaration, not an estimate. Who picks the next role is the declaration's: the model
    at a chosen route, the package at a fixed one, and a mixed network says which roles are
    which."""
    bound = network["worst_case"]
    names = [role["id"] for role in network["roles"]]
    activations = ", ".join(
        f"{role['id']} at most {role['activation_bound']} "
        f"{'time' if role['activation_bound'] == 1 else 'times'}"
        for role in network["roles"]
    )
    tools = ", ".join(f"{tool} {count}" for tool, count in sorted(bound["tool_calls"].items()))
    chosen = [role["id"] for role in network["roles"] if role["route"]["kind"] == "chosen"]
    fixed = [role["id"] for role in network["roles"] if role["route"]["kind"] != "chosen"]
    if chosen and fixed:
        lead = (
            f"The package delegates between {len(names)} roles ({', '.join(names)}), the next "
            f"role chosen by the model after {_and(chosen)} and fixed by the package after "
            f"{_and(fixed)}"
        )
    else:
        # Every route chosen, or every route fixed (a valid network whose walk is one declared
        # sequence).
        choice = (
            "chosen by the model while it runs" if chosen else "along handoffs the package fixed"
        )
        lead = f"The package delegates between {len(names)} roles {choice} ({', '.join(names)})"
    return (
        f"{lead}, within a declared envelope: at most {bound['max_hops']} "
        f"handoffs; {activations}; at most {bound['model_calls']} model calls, "
        f"{sum(bound['tool_calls'].values())} tool calls"
        + (f" ({tools})" if tools else "")
        + f", {bound['remote_calls']} remote calls and {bound['tokens']} tokens in all; each "
        "role sees only its declared part of the shared state, and every handoff is recorded "
        "with the reason it was allowed."
    )


def _evals(package: Package) -> list:
    records = []
    for declaration in package.manifest["evals"]:
        document = package.json(declaration["path"])
        records.append(
            {
                "id": declaration["id"],
                "kind": declaration["kind"],
                "case_count": len(document.get("cases", [])),
                "description": document.get("description"),
                **_file_facts(package, declaration["path"]),
                "verified_by_host": False,
            }
        )
    return records


def _attestations(package: Package) -> list:
    records = []
    for path in package.manifest["attestations"]:
        document = package.json(path)
        keys = sorted(document)[:MAX_LISTED_KEYS] if isinstance(document, dict) else []
        records.append(
            {
                **_file_facts(package, path),
                "keys": keys,
                "verified_by_host": False,
            }
        )
    return records


def _model_requirements(package: Package) -> dict:
    requirements = package.manifest["model_requirements"]
    return {
        "routing": requirements["routing"],
        "fallback_policy": requirements["fallback_policy"],
        "privacy": requirements.get("privacy"),
        "latency_preference": requirements.get("latency_preference"),
        "cost_sensitivity": requirements.get("cost_sensitivity"),
        "tasks": [
            {
                "id": task["id"],
                "capabilities": list(task["capabilities"]),
                "context_window": task["context_window"],
                "preferred_tier": task.get("preferred_tier"),
            }
            for task in requirements["tasks"]
        ],
    }


def _payload(package: Package) -> dict:
    files = [_file_facts(package, path) for path in sorted(package.files)]
    return {
        "file_count": len(files),
        "total_bytes": sum(item["bytes"] for item in files),
        "files": files,
    }


def warnings(package: Package, evaluation: dict, publisher: dict) -> list:
    """Generic, declaration-derived cautions. No application-domain judgments."""
    found = []

    def warn(code, severity, message):
        found.append({"code": code, "severity": severity, "message": message})

    status = publisher["signature_status"]
    if status == "absent":
        warn("signature_absent", "critical", "This package carries no publisher signature.")
    elif status == "invalid":
        warn(
            "signature_invalid",
            "critical",
            "The publisher signature does not verify against the key inside the package.",
        )
    trust = publisher["trust_status"]
    if trust == "unknown":
        warn(
            "publisher_unknown",
            "warning",
            "The signing key is not pinned in this host's trust store, so the publisher is "
            "unverified even when the signature is self-consistent.",
        )
    elif trust == "mismatch":
        warn(
            "publisher_mismatch",
            "critical",
            "The claimed publisher is pinned to a different key, or the pinned key does not "
            "cover this package identity.",
        )
    if evaluation["runtime_status"] != "compatible":
        warn(
            "execution_profile_unsupported",
            "warning",
            "No installed execution profile can run this package; inspection only.",
        )
    policy = package.policy
    for permission in policy["permissions"]:
        if permission["kind"] == "files.write":
            warn(
                "requests_file_write_permission",
                "warning",
                f"The package requests write access to: "
                f"{', '.join(permission['resources']) or 'unspecified resources'}.",
            )
        linked = sorted(
            tool["id"] for tool in package.tools.values() if permission["id"] in tool["permissions"]
        )
        if permission["kind"] == "payment" and linked:
            # A payment permission that gates declared tools is enforced like
            # any other grant; what this host does not have is payment
            # infrastructure of its own, and saying so is the honest version.
            warn(
                "requests_payment_permission",
                "warning",
                f"The package requests payment authority ({permission['id']}) for "
                f"{', '.join(linked)}. This host charges nothing itself: the permission only "
                "decides whether those tools may be called.",
            )
        elif permission["kind"] in {"shell", "payment"}:
            warn(
                f"requests_{permission['kind']}_permission",
                "critical",
                f"The package requests a {permission['kind']} permission, which this host "
                "does not implement.",
            )
        if permission["kind"] == "personal.read":
            warn(
                "requests_personal_data",
                "warning",
                f"The package requests host-owned personal data ({permission['id']}: "
                f"{', '.join(permission['resources']) or 'unspecified'}). You choose whether "
                "to grant it and which of your resources is shared.",
            )
        if permission["kind"] == "compute":
            # compute.v0 (C-9): the words the agent page uses, with the hashes a person can
            # compare against the graph; the modules import nothing, so the sentence is exact.
            modules = {m["id"]: m["sha256"] for m in package.graph.get("modules", [])}
            named = ", ".join(
                f"{module_id} ({modules.get(module_id, 'undeclared')[:16]}…)"
                for module_id in permission["resources"]
            )
            warn(
                "runs_code_that_can_only_compute",
                "info",
                f"The package runs code that can only compute ({permission['id']}): WebAssembly "
                f"module(s) {named or 'none'}, with no imports, run under this host's memory, "
                "time and fuel bounds on the data the graph gives them.",
            )
    conversation = _conversation(package)
    if conversation is not None:
        # conversation.v0 (V-20): what a person agrees to when they start a conversation, in
        # words: how many turns at most, what is kept between turns, and which steps will ask.
        steps = ", ".join(
            f"{step['id']} (before {', '.join(step['permissions'])})"
            for step in conversation["consent_steps"]
        )
        warn(
            "conversational_package",
            "info",
            f"The package is a conversation of at most {conversation['budget']['max_turns']} "
            f"turns, within {conversation['budget']['hard_tokens']} tokens and "
            f"{conversation['budget']['max_remote_calls']} remote calls in all; it keeps "
            f"{', '.join(conversation['persistent_keys']) or 'nothing'} between turns, and asks "
            f"you before: {steps or 'nothing'}.",
        )
    network = _network(package)
    if network is not None:
        warn("delegation_network", "info", network_sentence(network))
    remote = [tool for tool in package.tools.values() if tool["execution"] == "remote"]
    if remote:
        domains = sorted({domain for tool in remote for domain in tool["domains"]})
        warn(
            "remote_tools_declared",
            "info",
            f"{len(remote)} remote tool(s) may contact: {', '.join(domains)}.",
        )
    writers = [
        tool["id"]
        for tool in package.tools.values()
        if tool["side_effects"] != "read" or tool["approval_required"]
    ]
    if writers:
        warn(
            "side_effecting_tools_declared",
            "warning",
            f"Tools requiring explicit approval before dispatch: {', '.join(sorted(writers))}.",
        )
    if policy["memory"]["scope"] not in {"session", "ephemeral"}:
        warn(
            "memory_scope_unsupported",
            "warning",
            f"Declared memory scope {policy['memory']['scope']!r} is not implemented here.",
        )
    if policy["delegation"]["allow_remote"]:
        warn("remote_delegation_requested", "critical", "Remote delegation is not implemented.")
    if package.manifest["dependencies"]:
        warn(
            "dependencies_declared",
            "warning",
            "Pinned dependencies are declared; no dependency resolver is installed.",
        )
    if package.manifest["update"]["locator"]:
        warn(
            "update_locator_declared",
            "info",
            "An update locator is declared. Updates are never fetched automatically.",
        )
    hints, notes = presentation_hints(package)
    if package.graph.get("extensions", {}).get(EXTENSION_KEY) is not None and notes:
        warn(
            "presentation_ignored" if hints is None else "presentation_hints_adjusted",
            "info",
            "Some presentation hints were not used: " + "; ".join(notes)[:900],
        )
    if not package.manifest["evals"]:
        warn("no_evals_declared", "info", "The package declares no evaluations.")
    if not package.manifest["attestations"]:
        warn("no_attestations_declared", "info", "The package declares no attestations.")
    return found


def build_summary(package: Package, *, evaluation: dict, publisher: dict) -> dict:
    """The stable JSON a future OpenClaw plugin renders without domain knowledge."""
    manifest = package.manifest
    policy = permissions_summary(package)
    return {
        "schema": SCHEMA,
        "package": {
            "spec_version": manifest["spec_version"],
            "package_id": manifest["package_id"],
            "name": manifest["name"],
            "version": manifest["version"],
            "description": manifest["description"],
            "created_at": manifest["created_at"],
            "digest": package.digest,
            "entrypoint": manifest["entrypoint"],
            "execution_profile": package.graph.get("profile", manifest["entrypoint"]),
            "runtime": dict(manifest["runtime"]),
            "update": dict(manifest["update"]),
            "dependencies": list(manifest["dependencies"]),
            "extension_keys": sorted(manifest["extensions"])[:MAX_LISTED_KEYS],
        },
        "validation": evaluation,
        "publisher": publisher,
        "capabilities": _capabilities(package),
        "skills": _skills(package),
        "tools": _tools(package),
        "workers": _workers(package),
        "workflow": _workflow(package),
        "model_requirements": _model_requirements(package),
        "evals": _evals(package),
        "attestations": _attestations(package),
        # Copied: a caller must not be able to mutate the loaded package policy.
        "policy": copy.deepcopy(
            {
                "permissions": policy["permissions"],
                "network": policy["network"],
                "memory": policy["memory"],
                "budget": policy["budget"],
                "delegation": policy["delegation"],
            }
        ),
        "payload": _payload(package),
        "warnings": warnings(package, evaluation, publisher),
    }
