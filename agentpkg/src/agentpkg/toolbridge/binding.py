"""The bounded binding facts a runner is allowed to hold about one tool.

This is the tool half of what `hostbridge.session.normalize_binding` is for a
model: the closed field set that may cross into the process that will ask for
the call. It carries identity, a digest, a category, a display origin and the
contract it was matched against — and nothing that could be used to reach
somewhere else.

What is deliberately absent is the whole point:

* no credential, no header, no token, no secret name's *value*;
* no request template, no query parameters, no body shaping;
* no way to name a different origin, path, method, command or OpenClaw method.

The runner never composes a request. It names a `tool_id` it already holds a
binding for, and the trusted host resolves what that means.
"""

from __future__ import annotations

from .errors import ToolBridgeError, invalid

MAX_TEXT = 512
MAX_IDS = 64
MAX_BINDINGS = 64


def _fields(value, field: str, allowed: set[str], required: set[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        raise invalid(f"{field} must be an object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise invalid(f"Unknown fields in {field}: {unknown}")
    missing = sorted(required - set(value))
    if missing:
        raise invalid(f"Missing fields in {field}: {missing}")
    return value


def _text(value, field: str, *, limit: int = MAX_TEXT, allow_none: bool = False):
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not value or len(value) > limit:
        raise invalid(f"{field} must be a string of 1 to {limit} characters")
    return value


def _hex64(value, field: str) -> str:
    text = _text(value, field, limit=64)
    if len(text) != 64 or any(ch not in "0123456789abcdef" for ch in text):
        raise invalid(f"{field} must be 64 lowercase hex characters")
    return text


def _positive(value, field: str, *, maximum: int, allow_none: bool = False):
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise invalid(f"{field} must be a positive number")
    if value > maximum:
        raise invalid(f"{field} exceeds {maximum}")
    return value


def normalize_tool_binding(raw, *, index: int = 0) -> dict:
    """Validate one run-plan tool binding into the exact shape the runner uses."""
    field = f"tool_bindings[{index}]"
    record = _fields(
        raw,
        field,
        {
            "tool_id",
            "binding_name",
            "binding_id",
            "binding_sha256",
            "implementation_kind",
            "implementation_id",
            "implementation_version",
            "display_name",
            "remote",
            "endpoint_origin",
            "endpoint_path",
            "method",
            "contract_sha256",
            "input_schema_sha256",
            "output_schema_sha256",
            "required_permission_ids",
            "usable",
            "timeout_seconds",
            "max_calls",
            "credentials_required",
            "credentials_configured",
            "approved",
            "approval_source",
            "compatibility_status",
        },
        {
            "tool_id",
            "binding_name",
            "binding_id",
            "binding_sha256",
            "implementation_kind",
            "remote",
            "contract_sha256",
            "input_schema_sha256",
            "output_schema_sha256",
            "approved",
        },
    )
    permissions = record.get("required_permission_ids") or []
    if not isinstance(permissions, list) or len(permissions) > MAX_IDS:
        raise invalid(f"{field}.required_permission_ids must be a bounded list")
    if record["approved"] is not True:
        # A plan should never carry an unapproved binding; refusing it here
        # means a runner cannot be handed one by a caller that skipped the
        # control plane either.
        raise ToolBridgeError(
            "tool_not_approved",
            f"{field} is not approved, so it must not appear in an execution plan",
            detail={"tool_id": record.get("tool_id")},
        )
    if not isinstance(record["remote"], bool):
        raise invalid(f"{field}.remote must be true or false")
    return {
        "tool_id": _text(record["tool_id"], f"{field}.tool_id", limit=200),
        "binding_name": _text(record["binding_name"], f"{field}.binding_name", limit=200),
        "binding_id": _text(record["binding_id"], f"{field}.binding_id", limit=200),
        "binding_sha256": _hex64(record["binding_sha256"], f"{field}.binding_sha256"),
        "implementation_kind": _text(
            record["implementation_kind"], f"{field}.implementation_kind", limit=64
        ),
        "implementation_id": _text(
            record.get("implementation_id"),
            f"{field}.implementation_id",
            limit=200,
            allow_none=True,
        ),
        "implementation_version": _text(
            record.get("implementation_version"),
            f"{field}.implementation_version",
            limit=64,
            allow_none=True,
        ),
        "display_name": _text(record.get("display_name"), f"{field}.display_name", allow_none=True),
        "remote": record["remote"],
        "endpoint_origin": _text(
            record.get("endpoint_origin"), f"{field}.endpoint_origin", limit=256, allow_none=True
        ),
        "endpoint_path": _text(
            record.get("endpoint_path"), f"{field}.endpoint_path", limit=256, allow_none=True
        ),
        "method": _text(record.get("method"), f"{field}.method", limit=8, allow_none=True),
        "contract_sha256": _hex64(record["contract_sha256"], f"{field}.contract_sha256"),
        "input_schema_sha256": _hex64(
            record["input_schema_sha256"], f"{field}.input_schema_sha256"
        ),
        "output_schema_sha256": _hex64(
            record["output_schema_sha256"], f"{field}.output_schema_sha256"
        ),
        "required_permission_ids": [
            _text(item, f"{field}.required_permission_ids[]", limit=200) for item in permissions
        ],
        # Whether every permission this tool links to is currently granted. A
        # bound, approved tool whose *optional* permission was denied is still
        # in the plan; `Runtime` refuses the call if the graph reaches it.
        "usable": record.get("usable") is not False,
        "timeout_seconds": _positive(
            record.get("timeout_seconds"), f"{field}.timeout_seconds", maximum=120, allow_none=True
        ),
        "max_calls": record.get("max_calls") if isinstance(record.get("max_calls"), int) else None,
        "credentials_required": record.get("credentials_required") is True,
        "credentials_configured": record.get("credentials_configured") is True,
        "approved": True,
        "approval_source": _text(
            record.get("approval_source"), f"{field}.approval_source", limit=64, allow_none=True
        ),
        "compatibility_status": _text(
            record.get("compatibility_status"),
            f"{field}.compatibility_status",
            limit=64,
            allow_none=True,
        ),
    }


def normalize_tool_bindings(raw) -> list[dict]:
    """Validate a whole bounded list, refusing duplicate tools or bindings."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_BINDINGS:
        raise invalid("tool_bindings must be a bounded list")
    bindings = [normalize_tool_binding(item, index=index) for index, item in enumerate(raw)]
    tools = [binding["tool_id"] for binding in bindings]
    if len(set(tools)) != len(tools):
        raise ToolBridgeError(
            "tool_binding_ambiguous",
            "Each declared tool must be satisfied by exactly one binding",
            detail={"tool_ids": sorted(tools)},
        )
    identifiers = [binding["binding_id"] for binding in bindings]
    if len(set(identifiers)) != len(identifiers):
        raise ToolBridgeError("tool_binding_ambiguous", "Two tools may not share one binding id")
    return bindings


def describe(binding: dict) -> dict:
    """A safe, operator-readable summary. Never a credential, never a template."""
    return {
        "tool_id": binding["tool_id"],
        "binding_name": binding["binding_name"],
        "binding_id": binding["binding_id"],
        "binding_sha256": binding["binding_sha256"],
        "implementation_kind": binding["implementation_kind"],
        "implementation_version": binding["implementation_version"],
        "display_name": binding["display_name"],
        "remote": binding["remote"],
        "endpoint_origin": binding["endpoint_origin"],
        "endpoint_path": binding["endpoint_path"],
        "method": binding["method"],
        "timeout_seconds": binding["timeout_seconds"],
        "credentials_required": binding["credentials_required"],
        "credentials_configured": binding["credentials_configured"],
        "note": (
            "Credential values never cross this boundary. `credentials_configured` says only "
            "whether the trusted host has one attached to this binding."
        ),
    }


__all__ = [
    "MAX_BINDINGS",
    "describe",
    "normalize_tool_binding",
    "normalize_tool_bindings",
]
