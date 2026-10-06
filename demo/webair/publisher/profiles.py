"""The package's profiles (`org.webagents:profiles-v0`), checked before the package is signed.

A profile groups permissions, tools and host resource types the package already declares, with a
title, a one-line description and an estimate, so that a host can offer a short path to
authorization. It presents authority and never grants it (`spec/extensions/profiles-v0.md`).

`profile_problems` checks a package's declared profiles against the extension's JSON Schema
(`spec/extensions/profiles-v0.schema.json`) and the consistency rules of the spec's section 4:
every member is declared, every profile holds the required permissions, a tool brings its
permissions, resources match their `personal.read` permissions, the first profile is the least,
estimates stay within the policy and ids are unique. Nothing here is WebAir-specific; the
manifest's profiles are written by hand, and `python -m publisher check` fails while any of these
rules does.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from functools import cache

from agentpkg.browser.hostresources import RESOURCE_PERMISSION_KINDS
from jsonschema import Draft202012Validator

from .contract import PACKAGE_SOURCE, REPO_ROOT
from .fixture import package_from_files, source_files

EXTENSION = "org.webagents:profiles-v0"
SCHEMA_PATH = REPO_ROOT / "spec" / "extensions" / "profiles-v0.schema.json"
MEMBERS = ("permissions", "tools", "resources")


@cache
def validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def schema_problems(value) -> list[str]:
    return [
        f"schema: {error.json_path}: {error.message}"
        for error in sorted(validator().iter_errors(value), key=lambda e: e.json_path)
    ]


def profile_problems(manifest: Mapping, policy: Mapping, tools: Mapping) -> list[str]:
    """Every way the manifest's profiles break the schema or section 4; empty when they hold.

    A package without the extension has nothing to check. Schema errors are reported alone:
    the consistency rules assume the shape.
    """
    value = manifest.get("extensions", {}).get(EXTENSION)
    if value is None:
        return []
    problems = schema_problems(value)
    if problems:
        return problems
    permissions = {permission["id"]: permission for permission in policy["permissions"]}
    required = sorted(pid for pid, permission in permissions.items() if permission["required"])
    resource_types = {
        resource
        for permission in permissions.values()
        if permission["kind"] in RESOURCE_PERMISSION_KINDS
        for resource in permission["resources"]
    }
    budget = policy["budget"]
    seen: set[str] = set()
    for profile in value["profiles"]:
        where = f"profile {profile['id']!r}"
        if profile["id"] in seen:
            problems.append(f"{where}: duplicate id")
        seen.add(profile["id"])
        members = {field: set(profile[field]) for field in MEMBERS}
        # 1. Declared only.
        for pid in sorted(members["permissions"] - set(permissions)):
            problems.append(f"{where}: permission {pid!r} is not declared by the package")
        for tid in sorted(members["tools"] - set(tools)):
            problems.append(f"{where}: tool {tid!r} is not declared by the package")
        for rid in sorted(members["resources"] - resource_types):
            problems.append(
                f"{where}: resource {rid!r} is not a resource type of a declared "
                f"{'/'.join(RESOURCE_PERMISSION_KINDS)} permission"
            )
        # 2. Required permissions included.
        for pid in required:
            if pid not in members["permissions"]:
                problems.append(f"{where}: required permission {pid!r} is missing")
        # 3. Tools bring their permissions.
        for tid in sorted(members["tools"] & set(tools)):
            for pid in tools[tid]["permissions"]:
                if pid not in members["permissions"]:
                    problems.append(f"{where}: tool {tid!r} needs permission {pid!r}")
        # 4. Resources match their permissions.
        expected = {
            resource
            for pid in members["permissions"] & set(permissions)
            if permissions[pid]["kind"] in RESOURCE_PERMISSION_KINDS
            for resource in permissions[pid]["resources"]
        }
        for rid in sorted(expected - members["resources"]):
            problems.append(f"{where}: resource {rid!r} is requested by a member permission")
        for rid in sorted((members["resources"] & resource_types) - expected):
            problems.append(f"{where}: resource {rid!r} has no member permission requesting it")
        # 6. Estimates within the policy.
        estimate = profile.get("estimate", {})
        if estimate.get("tokens", 0) > budget["hard_tokens"]:
            problems.append(
                f"{where}: estimate.tokens {estimate['tokens']} exceeds budget.hard_tokens "
                f"{budget['hard_tokens']}"
            )
        calls = sum(budget["max_calls_per_tool"].get(tid, 0) for tid in members["tools"])
        if estimate.get("tool_calls", 0) > calls:
            problems.append(
                f"{where}: estimate.tool_calls {estimate['tool_calls']} exceeds the tools' "
                f"call budgets ({calls})"
            )
    # 5. Least authority first.
    first, *others = value["profiles"]
    for other in others:
        for field in MEMBERS:
            extra = sorted(set(first[field]) - set(other[field]))
            if extra:
                problems.append(
                    f"profile {first['id']!r} is first but has {field} {extra} that "
                    f"profile {other['id']!r} lacks"
                )
    return problems


def source_profile_problems(files: dict[str, bytes] | None = None) -> list[str]:
    """`profile_problems` for the package source in `agents/webair` (or the given files)."""
    package = package_from_files(source_files(PACKAGE_SOURCE) if files is None else files)
    return profile_problems(package.manifest, package.policy, package.tools)
