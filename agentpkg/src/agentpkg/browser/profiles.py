"""Publisher-declared profiles: the noncritical manifest extension `org.webagents:profiles-v0`.

A profile groups permissions, tools and host resource types the package already
declares into a named choice. It presents authority and never grants it
(`spec/extensions/profiles-v0.md`). This module checks the shape
(`spec/extensions/profiles-v0.schema.json`) and the seven consistency rules of
the spec's section 4 against the package and, as section 5 requires, ignores
the whole value when anything fails: no profile is offered and the notes say
why. It is the port of the Chrome core's `profiles.ts`, so both runtimes accept
and refuse the same values.

What a selected profile changes is narrow (D-022, D-090): a declared tool
outside it that the person did not approve is *denied* rather than a blocker,
so a plan may leave it unbound, and the runtime refuses any call to it.
"""

from __future__ import annotations

import json
import re

from ..package import Package

PROFILES_EXTENSION = "org.webagents:profiles-v0"
_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,127}")
_LINE = re.compile(r"[^\x00-\x1f\x7f]+")
_MAX_PROFILES = 8
_MAX_IDENTIFIERS = 512
_MAX_TITLE = 60
_MAX_LINE = 240
_PROFILE_FIELDS = {"id", "title", "description", "permissions", "tools", "resources", "estimate"}
_MEMBERS = ("permissions", "tools", "resources")
_ESTIMATE_LIMITS = {"model_calls": 100000, "tool_calls": 100000, "tokens": 1000000000}


class _ProfileError(Exception):
    pass


def _fail(message: str):
    raise _ProfileError(message)


def _quote(value: str) -> str:
    # JSON.stringify's spelling, so both runtimes write the same notes (control characters too).
    return json.dumps(value, ensure_ascii=False)


def _identifiers(value, field: str, where: str) -> list[str]:
    if not isinstance(value, list) or len(value) > _MAX_IDENTIFIERS:
        _fail(f"{where}: {field} must be an array of at most {_MAX_IDENTIFIERS} identifiers")
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not _IDENTIFIER.fullmatch(item):
            _fail(f"{where}: {field} contains an invalid identifier")
        if item in out:
            _fail(f"{where}: {field} repeats {_quote(item)}")
        out.append(item)
    return out


def _line(value, field: str, where: str, limit: int) -> str:
    if not isinstance(value, str) or not _LINE.fullmatch(value) or len(value) > limit:
        _fail(f"{where}: {field} must be one line of at most {limit} characters")
    return value


def _count(value, field: str, where: str) -> int:
    # JSON Schema's "integer": any number with a zero fractional part, so `1000.0` counts as
    # the Chrome core's `Number.isInteger` reads it (spec §3; T7 review 1, finding 2).
    maximum = _ESTIMATE_LIMITS[field]
    integral = isinstance(value, int) or (isinstance(value, float) and value.is_integer())
    if isinstance(value, bool) or not integral or not 0 <= value <= maximum:
        _fail(f"{where}: estimate.{field} must be an integer between 0 and {maximum}")
    return int(value)


def _shape(raw) -> list[dict]:
    if not isinstance(raw, dict):
        _fail("the extension value must be an object")
    unknown = [key for key in raw if key != "profiles"]
    if unknown:
        _fail(f"unknown field {_quote(unknown[0])}")
    entries = raw.get("profiles")
    if not isinstance(entries, list) or not 1 <= len(entries) <= _MAX_PROFILES:
        _fail(f"profiles must list 1 to {_MAX_PROFILES} profiles")
    profiles = []
    for index, entry in enumerate(entries):
        where = f"profiles[{index}]"
        if not isinstance(entry, dict):
            _fail(f"{where}: must be an object")
        for key in entry:
            if key not in _PROFILE_FIELDS:
                _fail(f"{where}: unknown field {_quote(key)}")
        for key in ("id", "title", "description", "permissions", "tools", "resources"):
            if key not in entry:
                _fail(f"{where}: {key} is required")
        if not isinstance(entry["id"], str) or not _IDENTIFIER.fullmatch(entry["id"]):
            _fail(f"{where}: id must be an identifier")
        estimate = None
        if "estimate" in entry:
            value = entry["estimate"]
            if not isinstance(value, dict) or not value:
                _fail(f"{where}: estimate must be an object with at least one field")
            for key in value:
                if key not in {*_ESTIMATE_LIMITS, "notes"}:
                    _fail(f"{where}: estimate has unknown field {_quote(key)}")
            estimate = {
                key: _count(value[key], key, where) for key in _ESTIMATE_LIMITS if key in value
            }
            if "notes" in value:
                estimate["notes"] = _line(value["notes"], "estimate.notes", where, _MAX_LINE)
        profiles.append(
            {
                "id": entry["id"],
                "title": _line(entry["title"], "title", where, _MAX_TITLE),
                "description": _line(entry["description"], "description", where, _MAX_LINE),
                "permissions": _identifiers(entry["permissions"], "permissions", where),
                "tools": _identifiers(entry["tools"], "tools", where),
                "resources": _identifiers(entry["resources"], "resources", where),
                "estimate": estimate,
            }
        )
    return profiles


def _consistency(profiles: list[dict], package: Package) -> None:
    """The seven rules of `spec/extensions/profiles-v0.md` section 4."""
    permissions = {permission["id"]: permission for permission in package.policy["permissions"]}
    resource_types = {
        resource: permission["id"]
        for permission in permissions.values()
        if permission["kind"] == "personal.read"
        for resource in permission["resources"]
    }
    required = [pid for pid, permission in permissions.items() if permission["required"]]
    budget = package.policy["budget"]
    per_tool = budget["max_calls_per_tool"]
    seen: set[str] = set()
    for profile in profiles:
        where = f"profile {_quote(profile['id'])}"
        # 7. Unique ids.
        if profile["id"] in seen:
            _fail(f"{where}: duplicate id")
        seen.add(profile["id"])
        # 1. Declared only.
        for pid in profile["permissions"]:
            if pid not in permissions:
                _fail(f"{where}: undeclared permission {_quote(pid)}")
        for tool_id in profile["tools"]:
            if tool_id not in package.tools:
                _fail(f"{where}: undeclared tool {_quote(tool_id)}")
        for resource in profile["resources"]:
            if resource not in resource_types:
                _fail(f"{where}: undeclared resource type {_quote(resource)}")
        # 2. Required permissions included.
        for pid in required:
            if pid not in profile["permissions"]:
                _fail(f"{where}: required permission {_quote(pid)} is missing")
        # 3. Tools bring their permissions.
        for tool_id in profile["tools"]:
            for pid in package.tools[tool_id]["permissions"]:
                if pid not in profile["permissions"]:
                    _fail(f"{where}: tool {_quote(tool_id)} needs permission {_quote(pid)}")
        # 4. Resources match their permissions.
        expected = {
            resource for resource, pid in resource_types.items() if pid in profile["permissions"]
        }
        if expected != set(profile["resources"]):
            _fail(f"{where}: resources must be exactly those of its personal.read permissions")
        # 6. Estimates within the policy.
        estimate = profile["estimate"] or {}
        if "tokens" in estimate and estimate["tokens"] > budget["hard_tokens"]:
            _fail(f"{where}: estimate.tokens exceeds hard_tokens")
        if "tool_calls" in estimate:
            allowed = sum(per_tool.get(tool_id, 0) for tool_id in profile["tools"])
            if estimate["tool_calls"] > allowed:
                _fail(f"{where}: estimate.tool_calls exceeds the tools' call budgets")
    # 5. Least authority first.
    first = profiles[0]
    for other in profiles[1:]:
        if any(not set(first[field]) <= set(other[field]) for field in _MEMBERS):
            _fail(
                f"profile {_quote(first['id'])} must be a subset of {_quote(other['id'])} "
                "(least authority first)"
            )


def read_profiles(package: Package) -> dict:
    """`{declared, profiles, notes}`: the validated profiles, or None with the reason."""
    extensions = package.manifest.get("extensions") or {}
    if PROFILES_EXTENSION not in extensions:
        return {"declared": False, "profiles": None, "notes": []}
    try:
        profiles = _shape(extensions[PROFILES_EXTENSION])
        _consistency(profiles, package)
    except _ProfileError as error:
        return {
            "declared": True,
            "profiles": None,
            "notes": [f"{PROFILES_EXTENSION} ignored as a whole: {error}"],
        }
    return {"declared": True, "profiles": profiles, "notes": []}


def find_profile(package: Package, profile_id: str) -> dict | None:
    """The valid declared profile with this id, or None."""
    for profile in read_profiles(package)["profiles"] or []:
        if profile["id"] == profile_id:
            return profile
    return None


def profile_denied_tools(receipt: dict | None) -> set[str]:
    """Tools a receipt's selected profile left out and the person did not approve (D-090)."""
    profile = (receipt or {}).get("profile") or {}
    return set(profile.get("denied_tool_ids") or ())


__all__ = ["PROFILES_EXTENSION", "find_profile", "profile_denied_tools", "read_profiles"]
