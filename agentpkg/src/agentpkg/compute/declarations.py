"""What a package may declare about compute, checked at validation (compute.v0 §2, C-1…C-9,
C-11…C-18, C-20), before any host compiles anything.

Refusals are `ValidationError`s whose text starts with the specification's code, so that both
runtimes refuse a package with the same message (the conformance suite compares refusals).
"""

from __future__ import annotations

import hashlib

from ..errors import ValidationError
from ..validation import release
from .module import MAX_MODULE_BYTES, ModuleError, ModuleFacts, check_module

COMPUTE_MINIMUM_VERSION = "0.5.0"
MAX_MODULES = 16
MODULE_SUFFIX = ".wasm"
PERMISSION_KIND = "compute"
#: Decoded modules by SHA-256 and the functions asked for: validation, the runtime's preflight,
#: the execution host and `inspect` each need the facts, and decoding is the same work each time.
_FACTS: dict[tuple[str, tuple[str, ...]], ModuleFacts] = {}
_FACTS_KEPT = 64


def _refuse(code: str, message: str) -> ValidationError:
    return ValidationError(f"{code}: {message}")


def checked_module(data: bytes, functions) -> ModuleFacts:
    """`check_module`, decoding each module once per process; a refusal is never kept."""
    key = (hashlib.sha256(data).hexdigest(), tuple(functions))
    facts = _FACTS.get(key)
    if facts is None:
        facts = check_module(data, functions=functions)
        if len(_FACTS) >= _FACTS_KEPT:
            _FACTS.pop(next(iter(_FACTS)), None)
        _FACTS[key] = facts
    return facts


def module_members(files) -> list[str]:
    return sorted(name for name in files if name.lower().endswith(MODULE_SUFFIX))


def compute_operations(graph) -> list[tuple[str, dict]]:
    """Every compute node and every compute map step, with its qualified identity."""
    found = []
    for node in graph.get("nodes", []):
        if node["type"] == "compute":
            found.append((node["id"], node))
        for step in node.get("steps", []):
            if step["type"] == "compute":
                found.append((f"{node['id']}/{step['id']}", step))
    return found


def check_compute_declarations(manifest, graph, policy, files) -> dict[str, ModuleFacts]:
    """The graph's modules against the members, the nodes and the permission; returns the facts
    of each accepted module by id. A package that declares none of it returns `{}`."""
    modules = graph.get("modules", [])
    operations = compute_operations(graph)
    members = module_members(files)
    permissions = [p for p in policy["permissions"] if p["kind"] == PERMISSION_KIND]
    if not modules and not operations and not members and not permissions:
        return {}
    if release(manifest["runtime"]["minimum_version"]) < release(COMPUTE_MINIMUM_VERSION):
        raise _refuse(
            "compute_minimum_version",
            f"compute nodes require runtime.minimum_version {COMPUTE_MINIMUM_VERSION} or later",
        )
    if len(modules) > MAX_MODULES:
        raise _refuse("module_count", f"a graph declares at most {MAX_MODULES} modules")
    declared: dict[str, dict] = {}
    for module in modules:
        if module["id"] in declared:
            raise _refuse("module_duplicate", f"module {module['id']!r} is declared twice")
        if module["path"] in {m["path"] for m in declared.values()}:
            raise _refuse(
                "module_duplicate", f"member {module['path']!r} is declared as two modules"
            )
        if module["path"] not in files:
            raise _refuse(
                "module_file_missing", f"module {module['id']!r}: no member {module['path']!r}"
            )
        data = files[module["path"]]
        if len(data) > MAX_MODULE_BYTES:
            raise _refuse(
                "module_too_large",
                f"module {module['id']!r}: {len(data)} bytes; a module is at most "
                f"{MAX_MODULE_BYTES}",
            )
        actual = hashlib.sha256(data).hexdigest()
        if actual != module["sha256"]:
            raise _refuse(
                "module_hash_mismatch",
                f"module {module['id']!r}: {module['path']} has SHA-256 {actual}, the graph "
                f"declares {module['sha256']}",
            )
        declared[module["id"]] = module
    undeclared = sorted(set(members) - {m["path"] for m in declared.values()})
    if undeclared:
        raise _refuse(
            "module_undeclared",
            f"member {undeclared[0]!r} is a WebAssembly module the graph does not declare",
        )
    functions: dict[str, list[str]] = {}
    for name, operation in operations:
        module_id = operation["module"]
        if module_id not in declared:
            raise _refuse("module_unknown", f"node {name}: module {module_id!r} is not declared")
        names = functions.setdefault(module_id, [])
        if operation["function"] not in names:
            names.append(operation["function"])
    unused = sorted(set(declared) - set(functions))
    if unused:
        raise _refuse("module_unused", f"module {unused[0]!r} is declared and no node runs it")
    facts: dict[str, ModuleFacts] = {}
    for module_id, module in declared.items():
        try:
            facts[module_id] = checked_module(files[module["path"]], functions[module_id])
        except ModuleError as exc:
            raise _refuse(exc.code, f"module {module_id!r}: {exc.reason}") from exc
    for name, operation in operations:
        limits = operation.get("limits") or {}
        maximum = facts[operation["module"]].memory_max_pages
        if limits.get("memory_pages", maximum) < maximum:
            raise _refuse(
                "compute_limits_below_module",
                f"node {name}: limits.memory_pages {limits['memory_pages']} is below the "
                f"module's declared maximum of {maximum} pages",
            )
    if not permissions:
        raise _refuse(
            "compute_permission_missing",
            "a graph with compute nodes declares one permission of kind compute naming its modules",
        )
    if len(permissions) > 1:
        raise _refuse(
            "compute_permission_duplicate", "a package declares at most one compute permission"
        )
    if not declared:
        raise _refuse(
            "compute_permission_unused",
            f"permission {permissions[0]['id']!r} is declared and the graph runs no module",
        )
    if set(permissions[0]["resources"]) != set(declared):
        raise _refuse(
            "compute_permission_resources",
            f"permission {permissions[0]['id']!r} must name exactly the declared modules "
            f"{sorted(declared)}, not {sorted(permissions[0]['resources'])}",
        )
    return facts


def module_facts(package) -> dict[str, ModuleFacts]:
    """The facts of a validated package's modules, by id (what the runtime and the agent page
    need; validation has already accepted every module)."""
    functions: dict[str, list[str]] = {}
    for _, operation in compute_operations(package.graph):
        names = functions.setdefault(operation["module"], [])
        if operation["function"] not in names:
            names.append(operation["function"])
    return {
        module["id"]: checked_module(package.files[module["path"]], functions[module["id"]])
        for module in package.graph.get("modules", [])
    }


def module_records(package) -> list[dict]:
    """The modules as `inspect` and the agent page list them: id, path, hash, memory, functions."""
    facts = module_facts(package)
    return [
        {"id": module["id"], "path": module["path"], **facts[module["id"]].as_json()}
        for module in package.graph.get("modules", [])
    ]


__all__ = [
    "COMPUTE_MINIMUM_VERSION",
    "MAX_MODULES",
    "MODULE_SUFFIX",
    "PERMISSION_KIND",
    "check_compute_declarations",
    "checked_module",
    "compute_operations",
    "module_facts",
    "module_members",
    "module_records",
]
