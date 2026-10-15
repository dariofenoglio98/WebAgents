"""Host-owned resources and the grants that let one run use one of them.

The tool registry describes what a host can *run*. This module describes what a
host *holds for the person*: a travel profile, an identity, a payment
instrument, a calendar — anything personal enough that the package publishing
the behavior must never own it. Three objects meet here, and the vocabulary
keeps them apart exactly as it does for tools:

    permission resource scope   what the package asks for       (signed, in the pkg)
    host resource registry      what this host holds            (host-owned, no values)
    resource grant              which one the person chose      (receipt, then run plan)

The package side needs no new language. A permission whose `kind` is a
resource kind (`personal.read`) names, in its `resources` scope, the *type* of
host resource it requests. Nothing in a package can name a concrete resource:
the registry is the host's statement of which resources exist, and the person
picks one when they grant the permission. The pick is frozen into the
authorization receipt by opaque id and digest, the run plan copies it, and
every later step compares against it.

What crosses into this module is deliberately small. A registry carries, per
resource, an opaque id, its type, a display-safe label the host composed, and
a digest the host computed over the value. The value itself never leaves the
host process that holds it: agentpkg can decide *whether* and *which*, never
*what*.

Nothing here resolves a resource or calls anything. Evaluation is set
membership and string equality over declared data.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from ..package import Package, canonical_json, sha256
from .errors import ControlPlaneError

REGISTRY_SCHEMA = "agentpkg-host-resource-registry-v0"
REQUESTS_SCHEMA = "agentpkg-host-resource-requests-v0"

# Permission kinds whose `resources` scope may name a host resource type. A
# scope string means "a host resource of this type" only under one of these
# kinds and only when the host offers that type; anywhere else it is the
# ordinary symbolic scope it always was.
RESOURCE_PERMISSION_KINDS = ("personal.read", "memory.read")

MAX_TYPES = 32
MAX_RESOURCES = 256
MAX_LABEL = 200
MAX_TEXT = 512
MAX_NOTES = 16
IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")

# Request statuses. Only `offered` can carry a grant.
OFFERED = "offered"
EMPTY = "empty"
AMBIGUOUS = "ambiguous"
KIND_MISMATCH = "kind_mismatch"
REQUEST_STATUSES = (OFFERED, EMPTY, AMBIGUOUS, KIND_MISMATCH)

DENY = "deny"


def _fields(value, field: str, allowed: set[str], required: set[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        raise ControlPlaneError("invalid_request", f"{field} must be an object")
    unknown = set(value) - allowed
    if unknown:
        # A closed field set is what keeps a resource *value* from travelling
        # through this boundary by accident.
        raise ControlPlaneError(
            "unknown_field", f"Unknown fields in {field}: {sorted(unknown)}", status=400
        )
    missing = required - set(value)
    if missing:
        raise ControlPlaneError("invalid_request", f"Missing fields in {field}: {sorted(missing)}")
    return value


def _text(value, field: str, *, limit: int = MAX_TEXT, allow_none: bool = False):
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not value:
        raise ControlPlaneError("invalid_request", f"{field} must be a non-empty string")
    if len(value) > limit:
        raise ControlPlaneError("invalid_request", f"{field} exceeds {limit} characters")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
        raise ControlPlaneError("invalid_request", f"{field} must not contain control characters")
    return value


def _identifier(value, field: str) -> str:
    text = _text(value, field, limit=128)
    if not IDENTIFIER.fullmatch(text):
        raise ControlPlaneError("invalid_request", f"{field} is not a valid identifier")
    return text


def _hex64(value, field: str) -> str:
    text = _text(value, field, limit=64)
    if len(text) != 64 or any(ch not in "0123456789abcdef" for ch in text):
        raise ControlPlaneError("invalid_request", f"{field} must be 64 lowercase hex characters")
    return text


# -- host registry -------------------------------------------------------------
def normalize_resource_registry(raw) -> dict:
    """Validate a host resource registry and bind it to a content hash.

    A registry is the host's description of what it holds, *without* the
    values: types with the digest of their value schema, and resources with an
    opaque id, a display-safe label and a digest of the value. A run plan
    records the hash, so it can never silently refer to a different registry
    state than the one a person chose from.
    """
    record = _fields(
        raw,
        "resource_registry",
        {"schema", "host", "types", "resources", "notes"},
        {"host", "types", "resources"},
    )
    schema = record.get("schema", REGISTRY_SCHEMA)
    if schema != REGISTRY_SCHEMA:
        raise ControlPlaneError(
            "invalid_request",
            f"resource_registry.schema must be {REGISTRY_SCHEMA!r}, got {schema!r}",
        )
    host = _fields(
        record["host"],
        "resource_registry.host",
        {"runtime", "runtime_version", "source", "captured_at"},
        {"runtime", "source", "captured_at"},
    )
    types_raw = record["types"]
    if not isinstance(types_raw, list) or len(types_raw) > MAX_TYPES:
        raise ControlPlaneError(
            "invalid_request", f"resource_registry.types must be a list of at most {MAX_TYPES}"
        )
    types = []
    for index, item in enumerate(types_raw):
        field = f"resource_registry.types[{index}]"
        entry = _fields(
            item,
            field,
            {"id", "display_name", "description", "permission_kind", "schema_sha256"},
            {"id", "display_name", "permission_kind", "schema_sha256"},
        )
        kind = _text(entry["permission_kind"], f"{field}.permission_kind", limit=64)
        if kind not in RESOURCE_PERMISSION_KINDS:
            raise ControlPlaneError(
                "invalid_request",
                f"{field}.permission_kind must be one of {list(RESOURCE_PERMISSION_KINDS)}",
            )
        types.append(
            {
                "id": _identifier(entry["id"], f"{field}.id"),
                "display_name": _text(entry["display_name"], f"{field}.display_name", limit=128),
                "description": _text(
                    entry.get("description"), f"{field}.description", allow_none=True
                ),
                "permission_kind": kind,
                "schema_sha256": _hex64(entry["schema_sha256"], f"{field}.schema_sha256"),
            }
        )
    type_ids = [entry["id"] for entry in types]
    if len(set(type_ids)) != len(type_ids):
        raise ControlPlaneError("invalid_request", "resource_registry.types has duplicate ids")
    resources_raw = record["resources"]
    if not isinstance(resources_raw, list) or len(resources_raw) > MAX_RESOURCES:
        raise ControlPlaneError(
            "invalid_request",
            f"resource_registry.resources must be a list of at most {MAX_RESOURCES}",
        )
    resources = []
    for index, item in enumerate(resources_raw):
        field = f"resource_registry.resources[{index}]"
        entry = _fields(
            item, field, {"id", "type", "label", "digest"}, {"id", "type", "label", "digest"}
        )
        resource_type = _identifier(entry["type"], f"{field}.type")
        if resource_type not in type_ids:
            raise ControlPlaneError("invalid_request", f"{field}.type names no declared type")
        resources.append(
            {
                "id": _identifier(entry["id"], f"{field}.id"),
                "type": resource_type,
                "label": _text(entry["label"], f"{field}.label", limit=MAX_LABEL),
                "digest": _hex64(entry["digest"], f"{field}.digest"),
            }
        )
    resource_ids = [entry["id"] for entry in resources]
    if len(set(resource_ids)) != len(resource_ids):
        raise ControlPlaneError("invalid_request", "resource_registry.resources has duplicate ids")
    notes_raw = record.get("notes") or []
    if not isinstance(notes_raw, list) or len(notes_raw) > MAX_NOTES:
        raise ControlPlaneError(
            "invalid_request", f"resource_registry.notes must be a list of at most {MAX_NOTES}"
        )
    notes = []
    for note in notes_raw:
        entry = _fields(note, "resource_registry.notes[]", {"code", "detail"}, {"code"})
        notes.append(
            {
                "code": _text(entry["code"], "resource_registry.notes[].code", limit=128),
                "detail": _text(
                    entry.get("detail"), "resource_registry.notes[].detail", allow_none=True
                ),
            }
        )
    registry = {
        "schema": REGISTRY_SCHEMA,
        "host": {
            "runtime": _text(host["runtime"], "resource_registry.host.runtime", limit=64),
            "runtime_version": _text(
                host.get("runtime_version"),
                "resource_registry.host.runtime_version",
                limit=64,
                allow_none=True,
            ),
            "source": _text(host["source"], "resource_registry.host.source"),
            "captured_at": _text(
                host["captured_at"], "resource_registry.host.captured_at", limit=64
            ),
        },
        "types": types,
        "resources": resources,
        "notes": notes,
    }
    registry["registry_sha256"] = sha256(canonical_json(registry))
    registry["type_count"] = len(types)
    registry["resource_count"] = len(resources)
    return registry


def empty_resource_registry(
    *, runtime: str = "none", source: str = "no host resource registry supplied"
) -> dict:
    """The registry of a host that holds no personal resource at all."""
    return normalize_resource_registry(
        {
            "schema": REGISTRY_SCHEMA,
            "host": {"runtime": runtime, "source": source, "captured_at": _now()},
            "types": [],
            "resources": [],
        }
    )


def registry_reference(registry: dict | None) -> dict | None:
    """The small record a receipt or plan keeps about the registry it used."""
    if registry is None:
        return None
    return {
        "registry_sha256": registry["registry_sha256"],
        "type_count": registry["type_count"],
        "resource_count": registry["resource_count"],
    }


def _now() -> str:
    return datetime.now(UTC).isoformat()


# -- package requests ----------------------------------------------------------
def _linked_tools(package: Package, permission_id: str) -> list[str]:
    return sorted(
        tool["id"] for tool in package.tools.values() if permission_id in tool["permissions"]
    )


def resource_requests(package: Package, registry: dict | None) -> list[dict]:
    """Which declared permissions request a host resource this host offers.

    A permission requests a host resource when one of its scopes is the id of a
    type in the host's registry. What it may then be granted is decided by
    three separate facts, each with its own status, so a UI can explain rather
    than assert:

    * exactly one scope names an offered type (two would be `ambiguous`: the
      person could not tell which they were granting);
    * the permission's kind is the kind the host says that type is read under
      (`kind_mismatch` otherwise: a package cannot relabel personal data as a
      milder class of authority);
    * the host holds at least one resource of that type (`empty` otherwise).
    """
    if registry is None:
        return []
    types = {entry["id"]: entry for entry in registry["types"]}
    requests = []
    for permission in package.policy["permissions"]:
        scopes = [scope for scope in permission["resources"] if scope in types]
        if not scopes:
            continue
        status = OFFERED
        resource_type = scopes[0] if len(scopes) == 1 else None
        options: list[dict] = []
        if resource_type is None:
            status = AMBIGUOUS
        elif permission["kind"] != types[resource_type]["permission_kind"]:
            status = KIND_MISMATCH
        else:
            options = [
                {"resource_id": entry["id"], "label": entry["label"]}
                for entry in registry["resources"]
                if entry["type"] == resource_type
            ]
            if not options:
                status = EMPTY
        type_record = types.get(resource_type) if resource_type else None
        requests.append(
            {
                "permission_id": permission["id"],
                "kind": permission["kind"],
                "required": permission["required"],
                "resource_type": resource_type,
                "resource_types": scopes,
                "type_display_name": type_record["display_name"] if type_record else None,
                "type_description": type_record["description"] if type_record else None,
                "status": status,
                "options": options,
                "linked_tools": _linked_tools(package, permission["id"]),
            }
        )
    return requests


def evaluate_resources(
    package: Package, registry: dict | None, *, decisions: dict, grants: list[dict]
) -> dict:
    """The resource half of an authorization request, for a UI to render."""
    selected = {grant["permission_id"]: grant["resource_id"] for grant in grants}
    requests = resource_requests(package, registry)
    for request in requests:
        request["decision"] = decisions.get(request["permission_id"], DENY)
        request["selected_resource_id"] = selected.get(request["permission_id"])
    return {
        "schema": REQUESTS_SCHEMA,
        "package_id": package.manifest["package_id"],
        "package_version": package.manifest["version"],
        "package_digest": package.digest,
        "registry": registry_reference(registry),
        "requests": requests,
        "resource_permission_kinds": list(RESOURCE_PERMISSION_KINDS),
        "note": (
            "A package can request a type of host resource; it can never name one. The host "
            "lists what it holds, and the person picks one when granting the permission. The "
            "values never leave the host: this evaluation carries ids, labels and digests."
        ),
    }


def normalize_resource_selections(
    package: Package, registry: dict | None, decisions: dict, submitted
) -> list[dict]:
    """Turn the person's picks into frozen grants, strictly, or refuse.

    Every refusal is a different mistake with its own code. A grant exists only
    for a permission that requests an offered type, is not denied, and names a
    resource of exactly that type in this registry. A granted resource-bearing
    permission without a pick is refused rather than defaulted: silence never
    selects someone's identity or card.
    """
    if submitted is None:
        submitted = {}
    if not isinstance(submitted, dict):
        raise ControlPlaneError(
            "invalid_request",
            "resource_selections must be an object of permission id to resource id",
        )
    if submitted and registry is None:
        raise ControlPlaneError(
            "resource_registry_missing",
            "A resource can be selected only against a host resource registry supplied with "
            "the same request.",
        )
    declared = {permission["id"] for permission in package.policy["permissions"]}
    requests = {item["permission_id"]: item for item in resource_requests(package, registry)}
    resources = {entry["id"]: entry for entry in (registry or {}).get("resources", [])}
    grants = []
    for permission_id, resource_id in submitted.items():
        if permission_id not in declared:
            raise ControlPlaneError(
                "unknown_permission", f"{permission_id!r} is not declared by this package"
            )
        request = requests.get(permission_id)
        if request is None or request["status"] != OFFERED:
            raise ControlPlaneError(
                "resource_not_requested",
                f"Permission {permission_id!r} does not request a host resource this host "
                "offers, so nothing can be selected for it.",
                details={"status": request["status"] if request else None},
            )
        if decisions.get(permission_id, DENY) == DENY:
            raise ControlPlaneError(
                "resource_selection_denied",
                f"Permission {permission_id!r} is denied; a denied permission carries no resource.",
            )
        if not isinstance(resource_id, str):
            raise ControlPlaneError("invalid_request", "resource ids must be strings")
        resource = resources.get(resource_id)
        if resource is None or resource["type"] != request["resource_type"]:
            # One answer for an unknown id and for a resource of another type:
            # the person can only choose among the options listed for this
            # permission.
            raise ControlPlaneError(
                "resource_unknown",
                f"That is not one of the {request['type_display_name'] or 'resources'} this "
                f"host offers for {permission_id!r}.",
            )
        grants.append(
            {
                "permission_id": permission_id,
                "resource_type": resource["type"],
                "resource_id": resource["id"],
                "resource_digest": resource["digest"],
            }
        )
    for permission_id, request in requests.items():
        if (
            request["status"] == OFFERED
            and decisions.get(permission_id, DENY) != DENY
            and permission_id not in submitted
        ):
            raise ControlPlaneError(
                "resource_selection_required",
                f"Permission {permission_id!r} grants access to a "
                f"{request['type_display_name'] or 'host resource'}; choose which one, or deny "
                "the permission.",
                details={"permission_id": permission_id},
            )
    return sorted(grants, key=lambda grant: grant["permission_id"])


# -- staleness and readiness ---------------------------------------------------
def _reason(code: str, message: str, subject=None) -> dict:
    return {"code": code, "message": message, "subject": subject}


def grant_staleness(grants: list[dict], registry: dict | None) -> list[dict]:
    """Whether every frozen grant still names exactly the resource that was chosen.

    Conservative on purpose: a resource whose digest moved is a different
    resource, even under the same id, so a decision about the old one does not
    quietly transfer to the new one.
    """
    if not grants:
        return []
    if registry is None:
        return [
            _reason(
                "resource_registry_unknown",
                "This authorization selected host resources, and no current host resource "
                "registry has been supplied to compare them against.",
            )
        ]
    current = {entry["id"]: entry for entry in registry["resources"]}
    reasons = []
    for grant in grants:
        subject = grant["permission_id"]
        entry = current.get(grant["resource_id"])
        if entry is None:
            reasons.append(
                _reason(
                    "resource_removed",
                    f"The host resource selected for {subject} no longer exists on this host.",
                    subject,
                )
            )
        elif entry["type"] != grant["resource_type"]:
            reasons.append(
                _reason(
                    "resource_type_changed",
                    f"The host resource selected for {subject} is now a different type.",
                    subject,
                )
            )
        elif entry["digest"] != grant["resource_digest"]:
            reasons.append(
                _reason(
                    "resource_changed",
                    f"The host resource selected for {subject} changed after it was chosen, so "
                    "it is no longer the one that was granted.",
                    subject,
                )
            )
    return reasons


def resource_tool_blockers(tool_evaluation: dict | None, *, receipt: dict) -> list[dict]:
    """Every host-resource tool that could run without a resource to return.

    A tool bound to a host resource type is usable only when a granted
    permission it links to carries a grant of exactly that type. A granted
    permission without one would be a run that fails at its first read, so the
    plan is refused instead.
    """
    if tool_evaluation is None:
        return []
    decisions = receipt.get("decisions", {})
    grants = receipt.get("resource_grants") or []
    reasons = []
    for tool in tool_evaluation["tools"]:
        binding = tool.get("binding") or {}
        resource_type = binding.get("resource_type")
        if binding.get("implementation_kind") != "host_resource" or not resource_type:
            continue
        linked = set(tool["permission_ids"])
        granted = [pid for pid in sorted(linked) if decisions.get(pid, DENY) != DENY]
        if not granted:
            continue
        if not any(
            grant["permission_id"] in linked and grant["resource_type"] == resource_type
            for grant in grants
        ):
            reasons.append(
                _reason(
                    "resource_not_selected",
                    f"Tool {tool['tool_id']} returns a host resource of type {resource_type}, "
                    f"and permission {granted[0]!r} is granted without one being selected.",
                    tool["tool_id"],
                )
            )
    return reasons


def grants_report(grants: list[dict], registry: dict | None) -> dict:
    """What a preflight says about frozen grants, without restating them."""
    reasons = grant_staleness(grants, registry)
    return {
        "granted": len(grants),
        "current": not reasons,
        "evaluated": registry is not None,
        "registry_sha256": registry["registry_sha256"] if registry else None,
    }


__all__ = [
    "AMBIGUOUS",
    "EMPTY",
    "KIND_MISMATCH",
    "OFFERED",
    "REGISTRY_SCHEMA",
    "REQUESTS_SCHEMA",
    "RESOURCE_PERMISSION_KINDS",
    "empty_resource_registry",
    "evaluate_resources",
    "grant_staleness",
    "grants_report",
    "normalize_resource_registry",
    "normalize_resource_selections",
    "registry_reference",
    "resource_requests",
    "resource_tool_blockers",
]
