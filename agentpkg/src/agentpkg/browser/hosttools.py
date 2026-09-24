"""Host tool registries and generic package/tool binding compatibility.

Two knowledge domains meet here and are deliberately kept apart, exactly as
they are for models in `hostmodels.py`:

* the **host** (OpenClaw, in the shipped integration) knows which tool
  implementations exist, where they run, what they are willing to talk to, and
  whether a credential is configured. It sends that as a bounded,
  provider-neutral **tool registry** of *binding descriptors*;
* **agentpkg** knows what a package *declares* and what those declarations
  mean. It never learns a service name, an API shape, a credential, or a
  vendor vocabulary, and it never calls anything.

Nothing in this module invokes anything. Evaluating a binding is hashing, set
membership and string equality over declared data.

Three objects with three different jobs, which the vocabulary keeps apart:

    package tool declaration   what the package asks for   (signed, in the pkg)
    host tool binding          what the host will run      (trusted, host-owned)
    tool approval              what the person allowed     (receipt, elsewhere)

The first two meet here. The third meets them in `runplan.py`.

Four rules shape the evaluation:

1. a missing host answer is `unknown`, never `false` and never `true`;
2. a package's declared `endpoint`/`domains` constrain the host binding
   *downwards* and never grant anything: a remote binding must land inside the
   domains the package declared, the network permission's resources, and the
   package's own network policy — all three — or it is incompatible. A package
   that names `example.test` cannot thereby reach it; a host that would like to
   reach somewhere else cannot do so behind that package's name either;
3. a binding's identity digest covers what it would *do*, not whether it
   happens to be up, so a momentarily unavailable implementation does not
   invalidate an authorization;
4. every check carries its own reason, so a UI can explain a verdict instead of
   asserting one.
"""

from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import urlsplit

from ..package import Package, canonical_json, sha256
from .errors import ControlPlaneError

REGISTRY_SCHEMA = "agentpkg-host-tool-registry-v0"
BINDING_SCHEMA = "agentpkg-host-tool-binding-v0"
BINDING_DIGEST_SCHEMA = "agentpkg-tool-binding-digest-v0"
CONTRACT_SCHEMA = "agentpkg-tool-contract-v0"
EVALUATION_SCHEMA = "agentpkg-tool-evaluation-v0"

MAX_BINDINGS = 128
MAX_STRING = 512
MAX_NOTES = 32
MAX_KINDS = 16

# Implementation categories this host understands. They are *categories*, not
# services: `json_http` is "one exact HTTPS request to one exact configured
# origin, path and method", `local_builtin` is "an implementation that ships
# with the host and performs no I/O", and `selected_file` is "a local
# implementation that reads only files the person explicitly selected for this
# run, by opaque host-held capability, and nothing else". Adding a service
# never adds a category; adding a way of reaching a resource does.
KIND_JSON_HTTP = "json_http"
KIND_LOCAL_BUILTIN = "local_builtin"
KIND_SELECTED_FILE = "selected_file"
IMPLEMENTATION_KINDS = (KIND_JSON_HTTP, KIND_LOCAL_BUILTIN, KIND_SELECTED_FILE)
REMOTE_KINDS = (KIND_JSON_HTTP,)

# Verdicts. `unverified` exists for the same reason it exists for models:
# collapsing "the host did not say" into either boolean would misinform the
# person making the decision.
BOUND = "bound"
UNBOUND = "unbound"
AMBIGUOUS = "ambiguous"
INCOMPATIBLE = "incompatible"
UNVERIFIED = "unverified"
UNAVAILABLE = "unavailable"
TOOL_STATUSES = (BOUND, UNVERIFIED, UNAVAILABLE, AMBIGUOUS, INCOMPATIBLE, UNBOUND)

SATISFIED = "satisfied"
VIOLATED = "violated"
UNKNOWN = "unknown"


def _text(value, field: str, *, limit: int = MAX_STRING, allow_none: bool = False):
    if value is None and allow_none:
        return None
    if not isinstance(value, str):
        raise ControlPlaneError("invalid_request", f"{field} must be a string")
    if len(value) > limit:
        raise ControlPlaneError("invalid_request", f"{field} exceeds {limit} characters")
    if any(ord(ch) < 0x20 for ch in value):
        raise ControlPlaneError("invalid_request", f"{field} must not contain control characters")
    return value


def _fields(value, field: str, allowed: set[str], required: set[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        raise ControlPlaneError("invalid_request", f"{field} must be an object")
    unknown = set(value) - allowed
    if unknown:
        # Refusing unknown fields is what keeps a host from smuggling a header,
        # a credential or a second endpoint through this boundary.
        raise ControlPlaneError(
            "unknown_field", f"Unknown fields in {field}: {sorted(unknown)}", status=400
        )
    missing = required - set(value)
    if missing:
        raise ControlPlaneError("invalid_request", f"Missing fields in {field}: {sorted(missing)}")
    return value


def _flag(value, field: str) -> bool:
    if not isinstance(value, bool):
        raise ControlPlaneError("invalid_request", f"{field} must be true or false")
    return value


def _count(value, field: str, *, allow_none: bool = True, maximum: int | None = None):
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ControlPlaneError("invalid_request", f"{field} must be a positive integer")
    if maximum is not None and value > maximum:
        raise ControlPlaneError("invalid_request", f"{field} exceeds {maximum}")
    return value


def _hex64(value, field: str, *, allow_none: bool = True):
    if value is None and allow_none:
        return None
    text = _text(value, field, limit=64)
    if len(text) != 64 or any(ch not in "0123456789abcdef" for ch in text):
        raise ControlPlaneError("invalid_request", f"{field} must be 64 lowercase hex characters")
    return text


def _origin(value, field: str) -> str:
    """One HTTPS origin, port 443, no credentials, no path, no query."""
    text = _text(value, field, limit=256)
    parts = urlsplit(text)
    try:
        port = parts.port
    except ValueError as exc:
        raise ControlPlaneError("invalid_request", f"{field} has an invalid port") from exc
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or "@" in parts.netloc
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
        or port not in (None, 443)
    ):
        raise ControlPlaneError(
            "invalid_request",
            f"{field} must be an https origin on port 443 with no credentials, path or query",
        )
    return f"https://{parts.hostname}"


def _path(value, field: str) -> str:
    text = _text(value, field, limit=256)
    if not text.startswith("/") or "?" in text or "#" in text or ".." in text:
        raise ControlPlaneError(
            "invalid_request", f"{field} must be an absolute path with no query, fragment or '..'"
        )
    return text


# -- host registry -----------------------------------------------------------
def binding_digest(binding: dict) -> str:
    """The security-relevant identity of one binding, as a stable hash.

    It covers what the binding *would do*: which logical tool it satisfies,
    which implementation category runs it, exactly where that lands, the
    contract it claims, its bounds, and whether a credential is attached. It
    deliberately excludes liveness (`available`, `enabled`, availability
    reason) and presentation (`display_name`, `description`), because a
    binding that is briefly down is the same binding, and a relabelled one is
    too.

    No credential *value* is an input. `credentials.configured` is a boolean,
    so attaching or removing a secret changes the digest — and therefore makes
    a prepared run plan stale — without the secret ever being hashed, stored or
    shown.
    """
    subject = {
        "schema": BINDING_DIGEST_SCHEMA,
        "binding_id": binding["id"],
        "tool_id": binding["tool_id"],
        "binding": binding["binding"],
        "implementation_kind": binding["implementation_kind"],
        "implementation_id": binding["implementation_id"],
        "implementation_version": binding["implementation_version"],
        "remote": binding["remote"],
        "endpoint": binding["endpoint"],
        "contract": binding["contract"],
        "limits": binding["limits"],
        "credentials": {
            "required": binding["credentials"]["required"],
            "configured": binding["credentials"]["configured"],
            "source": binding["credentials"]["source"],
        },
    }
    return sha256(canonical_json(subject))


def normalize_binding(raw, *, index: int) -> dict:
    """Validate one host tool binding descriptor into the exact stored shape.

    The closed field set is the contract. A host may only send what is listed
    here, so no header, no credential value, no second endpoint, no request
    template and no local command has anywhere to travel.
    """
    field = f"bindings[{index}]"
    record = _fields(
        raw,
        field,
        {
            "id",
            "tool_id",
            "binding",
            "implementation_kind",
            "implementation_id",
            "implementation_version",
            "display_name",
            "description",
            "remote",
            "available",
            "availability_reason",
            "enabled",
            "endpoint",
            "contract",
            "limits",
            "credentials",
        },
        {
            "id",
            "tool_id",
            "binding",
            "implementation_kind",
            "implementation_id",
            "implementation_version",
            "display_name",
            "remote",
            "available",
            "contract",
        },
    )
    kind = _text(record["implementation_kind"], f"{field}.implementation_kind", limit=64)
    if kind not in IMPLEMENTATION_KINDS:
        raise ControlPlaneError(
            "invalid_request",
            f"{field}.implementation_kind must be one of {list(IMPLEMENTATION_KINDS)}",
        )
    remote = _flag(record["remote"], f"{field}.remote")
    if (kind in REMOTE_KINDS) is not remote:
        # A local implementation that calls out, or a remote one that claims to
        # be local, would make the remote-call budget meaningless.
        raise ControlPlaneError(
            "invalid_request",
            f"{field}: {KIND_JSON_HTTP} bindings are remote and {KIND_LOCAL_BUILTIN} / "
            f"{KIND_SELECTED_FILE} bindings are local; the two must agree",
        )
    endpoint_raw = record.get("endpoint")
    if remote:
        endpoint_record = _fields(
            endpoint_raw or {},
            f"{field}.endpoint",
            {"origin", "path", "method"},
            {"origin", "path", "method"},
        )
        method = _text(endpoint_record["method"], f"{field}.endpoint.method", limit=8)
        if method not in {"GET", "POST"}:
            raise ControlPlaneError(
                "invalid_request", f"{field}.endpoint.method must be GET or POST"
            )
        endpoint = {
            "origin": _origin(endpoint_record["origin"], f"{field}.endpoint.origin"),
            "path": _path(endpoint_record["path"], f"{field}.endpoint.path"),
            "method": method,
        }
    else:
        if endpoint_raw not in (None, {}):
            raise ControlPlaneError(
                "invalid_request", f"{field}.endpoint must be absent for a local binding"
            )
        endpoint = None

    contract_record = _fields(
        record["contract"],
        f"{field}.contract",
        {"input_schema_sha256", "output_schema_sha256", "permission_kinds", "side_effects"},
        {"permission_kinds", "side_effects"},
    )
    kinds_raw = contract_record["permission_kinds"]
    if not isinstance(kinds_raw, list) or len(kinds_raw) > MAX_KINDS:
        raise ControlPlaneError(
            "invalid_request", f"{field}.contract.permission_kinds must be a bounded list"
        )
    side_effects = _text(
        contract_record["side_effects"], f"{field}.contract.side_effects", limit=16
    )
    if side_effects not in {"read", "write"}:
        raise ControlPlaneError(
            "invalid_request", f"{field}.contract.side_effects must be read or write"
        )
    contract = {
        "input_schema_sha256": _hex64(
            contract_record.get("input_schema_sha256"), f"{field}.contract.input_schema_sha256"
        ),
        "output_schema_sha256": _hex64(
            contract_record.get("output_schema_sha256"), f"{field}.contract.output_schema_sha256"
        ),
        "permission_kinds": sorted(
            {_text(item, f"{field}.contract.permission_kinds[]", limit=64) for item in kinds_raw}
        ),
        "side_effects": side_effects,
    }

    limits_record = _fields(
        record.get("limits") or {},
        f"{field}.limits",
        {
            "timeout_seconds",
            "max_request_bytes",
            "max_response_bytes",
            "max_concurrent",
            "min_interval_ms",
        },
    )
    limits = {
        "timeout_seconds": _count(
            limits_record.get("timeout_seconds"), f"{field}.limits.timeout_seconds", maximum=120
        ),
        "max_request_bytes": _count(
            limits_record.get("max_request_bytes"),
            f"{field}.limits.max_request_bytes",
            maximum=4 * 1024 * 1024,
        ),
        "max_response_bytes": _count(
            limits_record.get("max_response_bytes"),
            f"{field}.limits.max_response_bytes",
            maximum=16 * 1024 * 1024,
        ),
        "max_concurrent": _count(
            limits_record.get("max_concurrent"), f"{field}.limits.max_concurrent", maximum=64
        ),
        # A service's own rate limit, honoured by the host. Part of what the
        # binding would do, so it is part of its digest.
        "min_interval_ms": _count(
            limits_record.get("min_interval_ms"), f"{field}.limits.min_interval_ms", maximum=60_000
        ),
    }

    credentials_record = _fields(
        record.get("credentials") or {},
        f"{field}.credentials",
        {"required", "configured", "source"},
    )
    credentials = {
        "required": bool(credentials_record.get("required") is True),
        "configured": bool(credentials_record.get("configured") is True),
        # A *name* for where the host would look, never a value. `None` means
        # no credential is attached at all.
        "source": _text(
            credentials_record.get("source"),
            f"{field}.credentials.source",
            limit=64,
            allow_none=True,
        ),
    }

    binding = {
        "schema": BINDING_SCHEMA,
        "id": _text(record["id"], f"{field}.id", limit=200),
        "tool_id": _text(record["tool_id"], f"{field}.tool_id", limit=200),
        "binding": _text(record["binding"], f"{field}.binding", limit=200),
        "implementation_kind": kind,
        "implementation_id": _text(
            record["implementation_id"], f"{field}.implementation_id", limit=200
        ),
        "implementation_version": _text(
            record["implementation_version"], f"{field}.implementation_version", limit=64
        ),
        "display_name": _text(record["display_name"], f"{field}.display_name"),
        "description": _text(record.get("description"), f"{field}.description", allow_none=True),
        "remote": remote,
        "available": _flag(record["available"], f"{field}.available"),
        "availability_reason": _text(
            record.get("availability_reason"), f"{field}.availability_reason", allow_none=True
        ),
        "enabled": bool(record.get("enabled", True) is True),
        "endpoint": endpoint,
        "contract": contract,
        "limits": limits,
        "credentials": credentials,
    }
    binding["binding_sha256"] = binding_digest(binding)
    return binding


def normalize_registry(raw) -> dict:
    """Validate a whole host tool registry and bind it to a content hash.

    The hash is what a run plan records, so a plan can never silently refer to
    a different registry state than the one its verdicts were computed against.
    """
    record = _fields(
        raw, "tool_registry", {"schema", "host", "bindings", "notes"}, {"host", "bindings"}
    )
    schema = _text(record.get("schema", REGISTRY_SCHEMA), "tool_registry.schema")
    if schema != REGISTRY_SCHEMA:
        raise ControlPlaneError(
            "invalid_request", f"tool_registry.schema must be {REGISTRY_SCHEMA!r}, got {schema!r}"
        )
    host = _fields(
        record["host"],
        "tool_registry.host",
        {"runtime", "runtime_version", "source", "captured_at", "agent_id"},
        {"runtime", "source", "captured_at"},
    )
    bindings_raw = record["bindings"]
    if not isinstance(bindings_raw, list):
        raise ControlPlaneError("invalid_request", "tool_registry.bindings must be a list")
    if len(bindings_raw) > MAX_BINDINGS:
        raise ControlPlaneError(
            "invalid_request", f"tool_registry.bindings exceeds {MAX_BINDINGS} entries"
        )
    bindings = [normalize_binding(item, index=i) for i, item in enumerate(bindings_raw)]
    seen: set[str] = set()
    for binding in bindings:
        if binding["id"] in seen:
            raise ControlPlaneError("invalid_request", f"duplicate binding id {binding['id']!r}")
        seen.add(binding["id"])
    notes_raw = record.get("notes") or []
    if not isinstance(notes_raw, list) or len(notes_raw) > MAX_NOTES:
        raise ControlPlaneError(
            "invalid_request", f"tool_registry.notes must be a list of at most {MAX_NOTES}"
        )
    notes = [
        {
            "code": _text(
                _fields(note, "tool_registry.notes[]", {"code", "detail"}, {"code"})["code"],
                "tool_registry.notes[].code",
                limit=128,
            ),
            "detail": _text(note.get("detail"), "tool_registry.notes[].detail", allow_none=True),
        }
        for note in notes_raw
    ]
    registry = {
        "schema": REGISTRY_SCHEMA,
        "host": {
            "runtime": _text(host["runtime"], "tool_registry.host.runtime", limit=64),
            "runtime_version": _text(
                host.get("runtime_version"), "tool_registry.host.runtime_version", allow_none=True
            ),
            "source": _text(host["source"], "tool_registry.host.source"),
            "captured_at": _text(host["captured_at"], "tool_registry.host.captured_at", limit=64),
            "agent_id": _text(host.get("agent_id"), "tool_registry.host.agent_id", allow_none=True),
        },
        "bindings": bindings,
        "notes": notes,
    }
    registry["registry_sha256"] = sha256(canonical_json(registry))
    registry["binding_count"] = len(bindings)
    registry["available_binding_count"] = sum(
        1 for binding in bindings if binding["available"] and binding["enabled"]
    )
    return registry


def empty_registry(
    *, runtime: str = "none", source: str = "no host tool registry supplied"
) -> dict:
    """The registry of a host that offers no tool implementation at all."""
    return normalize_registry(
        {
            "schema": REGISTRY_SCHEMA,
            "host": {
                "runtime": runtime,
                "source": source,
                "captured_at": datetime.now(UTC).isoformat(),
            },
            "bindings": [],
            "notes": [],
        }
    )


def registry_reference(registry: dict) -> dict:
    """The small binding record a receipt-like artifact stores about a registry."""
    return {
        "registry_sha256": registry["registry_sha256"],
        "binding_count": registry["binding_count"],
        "available_binding_count": registry["available_binding_count"],
        "host": dict(registry["host"]),
    }


# -- package declarations ----------------------------------------------------
def tool_contract(package: Package, tool_id: str) -> dict:
    """What one declared package tool asks a host implementation to be.

    Everything here is read out of the signed package: the tool document, the
    schemas it names, and the permissions/network policy those schemas travel
    under. Nothing is inferred and nothing is inherited from a host.
    """
    tool = package.tools[tool_id]
    permissions = {item["id"]: item for item in package.policy["permissions"]}
    linked = [pid for pid in tool["permissions"] if pid in permissions]
    endpoint = tool.get("endpoint")
    origin = path = None
    if endpoint:
        parts = urlsplit(endpoint)
        origin = f"{parts.scheme}://{parts.hostname}"
        path = parts.path or "/"
    contract = {
        "schema": CONTRACT_SCHEMA,
        "tool_id": tool["id"],
        "tool_version": tool["version"],
        "binding": tool["binding"],
        "execution": tool["execution"],
        "remote": tool["execution"] == "remote",
        "method": tool.get("method"),
        "side_effects": tool["side_effects"],
        "approval_required": tool["approval_required"],
        "domains": sorted(tool["domains"]),
        "permission_ids": sorted(linked),
        "required_permission_ids": sorted(pid for pid in linked if permissions[pid]["required"]),
        "optional_permission_ids": sorted(
            pid for pid in linked if not permissions[pid]["required"]
        ),
        "permission_kinds": sorted({permissions[pid]["kind"] for pid in linked}),
        "network_resources": sorted(
            {
                resource
                for pid in linked
                if permissions[pid]["kind"] == "network"
                for resource in permissions[pid]["resources"]
            }
        ),
        "allowed_domains": sorted(package.policy["network"]["allowed_domains"]),
        "timeout_seconds": tool["timeout_seconds"],
        "endpoint_origin": origin,
        "endpoint_path": path,
        "input_schema": tool["input_schema"],
        "output_schema": tool["output_schema"],
        "input_schema_sha256": sha256(canonical_json(package.json(tool["input_schema"]))),
        "output_schema_sha256": sha256(canonical_json(package.json(tool["output_schema"]))),
        "max_calls": package.policy["budget"]["max_calls_per_tool"].get(tool["id"], 0),
    }
    contract["contract_sha256"] = sha256(canonical_json(contract))
    return contract


def tool_requirement_set(package: Package) -> dict:
    """Every tool the package declares, as host-neutral requirements.

    agent.pkg 0.1 has no optional-tool flag, so **every declared tool is
    required**: a graph that declares one may call it, and a host that cannot
    implement it cannot honestly say the package is ready to run. Optional
    tools would need a format field, not an inference here.
    """
    contracts = [tool_contract(package, tool_id) for tool_id in sorted(package.tools)]
    used: dict[str, list[str]] = {}
    for node in package.graph.get("nodes", []):
        if node["type"] == "tool":
            used.setdefault(node["tool"], []).append(node["id"])
        for step in node.get("steps", []) if node["type"] == "map" else []:
            if step["type"] == "tool":
                used.setdefault(step["tool"], []).append(f"{node['id']}/{step['id']}")
    roles: dict[str, list[str]] = {}
    for worker in package.graph["workers"]:
        for tool_id in worker["tools"]:
            roles.setdefault(tool_id, []).append(worker["id"])
    return {
        "schema": "agentpkg-tool-requirements-v0",
        "package_id": package.manifest["package_id"],
        "package_version": package.manifest["version"],
        "package_digest": package.digest,
        "tools": [
            {
                **contract,
                "required": True,
                "nodes": sorted(used.get(contract["tool_id"], [])),
                "roles": sorted(roles.get(contract["tool_id"], [])),
            }
            for contract in contracts
        ],
        "tool_count": len(contracts),
        "note": (
            "agent.pkg 0.1 declares no optional tools, so every declared tool must have an "
            "approved host binding before a run plan can be ready."
        ),
    }


# -- evaluation --------------------------------------------------------------
def _check(identifier: str, subject: str, required, host_value, *, detail=None) -> dict:
    if host_value is None:
        status = UNKNOWN
    elif isinstance(required, (list, tuple, set)):
        status = SATISFIED if sorted(host_value) == sorted(required) else VIOLATED
    else:
        status = SATISFIED if host_value == required else VIOLATED
    return {
        "id": identifier,
        "subject": subject,
        "required": required,
        "host_value": host_value,
        "status": status,
        "detail": detail,
    }


def _host_from_origin(origin: str | None) -> str | None:
    return urlsplit(origin).hostname if origin else None


def evaluate_binding(contract: dict, binding: dict) -> dict:
    """Compare one host binding against one package tool contract, in detail."""
    checks = [
        _check("tool_id", "tool_id", contract["tool_id"], binding["tool_id"]),
        _check("binding_name", "binding", contract["binding"], binding["binding"]),
        _check("execution_locality", "remote", contract["remote"], binding["remote"]),
        _check(
            "side_effects",
            "side_effects",
            contract["side_effects"],
            binding["contract"]["side_effects"],
        ),
        _check(
            "permission_kinds",
            "permission_kinds",
            contract["permission_kinds"],
            binding["contract"]["permission_kinds"],
        ),
        _check(
            "input_schema",
            "input_schema_sha256",
            contract["input_schema_sha256"],
            binding["contract"]["input_schema_sha256"],
            detail=(
                None
                if binding["contract"]["input_schema_sha256"]
                else "This host binding declares no input-schema digest, so the wire contract "
                "it implements cannot be confirmed against the package's own schema."
            ),
        ),
        _check(
            "output_schema",
            "output_schema_sha256",
            contract["output_schema_sha256"],
            binding["contract"]["output_schema_sha256"],
            detail=(
                None
                if binding["contract"]["output_schema_sha256"]
                else "This host binding declares no output-schema digest, so the wire contract "
                "it implements cannot be confirmed against the package's own schema."
            ),
        ),
    ]
    if contract["remote"] and binding["remote"]:
        endpoint = binding["endpoint"] or {}
        host_name = _host_from_origin(endpoint.get("origin"))
        # The package declared where it expects to talk; three separate
        # declarations have to agree before the host may send anything there.
        permitted = (
            set(contract["domains"])
            & set(contract["network_resources"])
            & set(contract["allowed_domains"])
        )
        checks.append(
            {
                "id": "endpoint_domain",
                "subject": "endpoint_origin",
                "required": sorted(permitted),
                "host_value": host_name,
                "status": SATISFIED if host_name in permitted else VIOLATED,
                "detail": (
                    "A remote binding must land on a host the package declares, the linked "
                    "network permission names, and the package network policy allows."
                ),
            }
        )
        checks.append(
            _check(
                "endpoint_path", "endpoint_path", contract["endpoint_path"], endpoint.get("path")
            )
        )
        checks.append(_check("method", "method", contract["method"], endpoint.get("method")))
    violated = [check for check in checks if check["status"] == VIOLATED]
    unknown = [check for check in checks if check["status"] == UNKNOWN]
    if violated:
        status = INCOMPATIBLE
    elif not (binding["available"] and binding["enabled"]):
        status = UNAVAILABLE
    elif unknown:
        status = UNVERIFIED
    else:
        status = BOUND
    return {
        "status": status,
        "binding_id": binding["id"],
        "binding_sha256": binding["binding_sha256"],
        "implementation_kind": binding["implementation_kind"],
        "implementation_id": binding["implementation_id"],
        "implementation_version": binding["implementation_version"],
        "display_name": binding["display_name"],
        "description": binding["description"],
        "remote": binding["remote"],
        "available": binding["available"],
        "availability_reason": binding["availability_reason"],
        "enabled": binding["enabled"],
        "endpoint_origin": (binding["endpoint"] or {}).get("origin"),
        "endpoint_path": (binding["endpoint"] or {}).get("path"),
        "method": (binding["endpoint"] or {}).get("method"),
        "credentials_required": binding["credentials"]["required"],
        "credentials_configured": binding["credentials"]["configured"],
        "credentials_source": binding["credentials"]["source"],
        "timeout_seconds": binding["limits"]["timeout_seconds"],
        "checks": checks,
        "satisfied": [check["id"] for check in checks if check["status"] == SATISFIED],
        "violated": [check["id"] for check in violated],
        "unknown": [check["id"] for check in unknown],
    }


def evaluate_tool(contract: dict, registry: dict) -> dict:
    """Decide what this host offers for one declared tool, and say why."""
    candidates = [
        binding for binding in registry["bindings"] if binding["tool_id"] == contract["tool_id"]
    ]
    record = {
        "tool_id": contract["tool_id"],
        "tool_version": contract["tool_version"],
        "binding_name": contract["binding"],
        "required": True,
        "execution": contract["execution"],
        "remote": contract["remote"],
        "side_effects": contract["side_effects"],
        "approval_required": contract["approval_required"],
        "declared_domains": list(contract["domains"]),
        "declared_endpoint_origin": contract["endpoint_origin"],
        "declared_endpoint_path": contract["endpoint_path"],
        "permission_ids": list(contract["permission_ids"]),
        "required_permission_ids": list(contract["required_permission_ids"]),
        "optional_permission_ids": list(contract["optional_permission_ids"]),
        "permission_kinds": list(contract["permission_kinds"]),
        "timeout_seconds": contract["timeout_seconds"],
        "max_calls": contract["max_calls"],
        "contract_sha256": contract["contract_sha256"],
        "input_schema_sha256": contract["input_schema_sha256"],
        "output_schema_sha256": contract["output_schema_sha256"],
        "candidate_count": len(candidates),
    }
    if not candidates:
        return {
            **record,
            "status": UNBOUND,
            "binding": None,
            "reason": (
                "This host registers no implementation for this tool, so the package cannot "
                "be run here. The package declares what it needs; the host decides what, if "
                "anything, satisfies it."
            ),
        }
    if len(candidates) > 1:
        return {
            **record,
            "status": AMBIGUOUS,
            "binding": None,
            "reason": (
                f"This host registers {len(candidates)} implementations for this tool. Exactly "
                "one binding must satisfy a declaration, so that what ran can be named."
            ),
            "candidate_binding_ids": sorted(binding["id"] for binding in candidates),
        }
    evaluated = evaluate_binding(contract, candidates[0])
    reason = None
    if evaluated["status"] == INCOMPATIBLE:
        reason = (
            "The host implementation does not satisfy this tool's declared contract: "
            + ", ".join(evaluated["violated"])
        )
    elif evaluated["status"] == UNAVAILABLE:
        reason = evaluated["availability_reason"] or "This host reports the binding as unusable."
    elif evaluated["status"] == UNVERIFIED:
        reason = "The host does not state enough about this implementation to confirm " + ", ".join(
            evaluated["unknown"]
        )
    return {**record, "status": evaluated["status"], "binding": evaluated, "reason": reason}


_ORDER = {BOUND: 0, UNVERIFIED: 1, UNAVAILABLE: 2, AMBIGUOUS: 3, INCOMPATIBLE: 4, UNBOUND: 5}


def evaluate_registry(
    package: Package,
    registry: dict,
    *,
    decisions: dict | None = None,
    tool_approvals: dict | None = None,
) -> dict:
    """Evaluate every declared tool against one host registry, in a stable order.

    `decisions` and `tool_approvals` are the person's, not the host's. They are
    reported here only so a UI can show all three facts side by side; a verdict
    about consent is never inferred from a binding, and a binding is never
    inferred from consent.
    """
    requirements = tool_requirement_set(package)
    decisions = dict(decisions or {})
    approvals = dict(tool_approvals or {})
    tools = []
    for contract in requirements["tools"]:
        evaluated = evaluate_tool(contract, registry)
        denied = sorted(
            pid for pid in contract["permission_ids"] if decisions.get(pid, "deny") == "deny"
        )
        denied_required = [pid for pid in denied if pid in contract["required_permission_ids"]]
        approved = approvals.get(contract["tool_id"]) is True
        tools.append(
            {
                **evaluated,
                "nodes": contract["nodes"],
                "roles": contract["roles"],
                "approved": approved,
                "permissions_granted": not denied and bool(contract["permission_ids"]),
                "denied_permission_ids": denied,
                "denied_required_permission_ids": denied_required,
                # Callable right now: bound, approved, and every permission it
                # links to granted.
                "usable": (
                    evaluated["status"] == BOUND
                    and approved
                    and not denied
                    and bool(contract["permission_ids"])
                ),
                # A denied *optional* permission is a profile the package said
                # it supports, and its graph is responsible for not reaching the
                # tool. `Runtime` refuses the call if it does. A denied
                # *required* one means the package cannot run at all.
                "blocks_plan": not (
                    evaluated["status"] == BOUND
                    and approved
                    and not denied_required
                    and bool(contract["permission_ids"])
                ),
            }
        )
    tools.sort(key=lambda item: (_ORDER[item["status"]], item["tool_id"]))
    counts = {
        status: sum(1 for item in tools if item["status"] == status) for status in TOOL_STATUSES
    }
    return {
        "schema": EVALUATION_SCHEMA,
        "evaluated_at": datetime.now(UTC).isoformat(),
        "package_id": package.manifest["package_id"],
        "package_version": package.manifest["version"],
        "package_digest": package.digest,
        "requirements": {
            key: requirements[key]
            for key in (
                "schema",
                "package_id",
                "package_version",
                "package_digest",
                "tool_count",
                "note",
            )
        },
        "registry": registry_reference(registry),
        "tools": tools,
        "counts": {
            **counts,
            "total": len(tools),
            "approved": sum(1 for item in tools if item["approved"]),
            "usable": sum(1 for item in tools if item["usable"]),
            "blocking": sum(1 for item in tools if item["blocks_plan"]),
        },
        "all_tools_bound": all(item["status"] == BOUND for item in tools),
        "all_tools_usable": all(item["usable"] for item in tools),
        "notes": list(registry["notes"]),
        "execution": {
            "performed": False,
            "note": (
                "Evaluating a binding reads declarations only; no implementation was called "
                "and no request left this host."
            ),
        },
    }


def plan_tool_bindings(evaluation: dict) -> list[dict]:
    """The exact, secret-free binding records a run plan freezes.

    A plan binds *what would run*, so this is deliberately narrow: identity,
    digest, implementation category and version, where it lands, the contract
    it was matched against, the permissions it travels under, and the approval
    that authorized it. No credential, no header, no registry, no check detail.
    """
    records = []
    for tool in sorted(evaluation["tools"], key=lambda item: item["tool_id"]):
        binding = tool["binding"]
        if binding is None:
            continue
        records.append(
            {
                "tool_id": tool["tool_id"],
                "binding_name": tool["binding_name"],
                "binding_id": binding["binding_id"],
                "binding_sha256": binding["binding_sha256"],
                "implementation_kind": binding["implementation_kind"],
                "implementation_id": binding["implementation_id"],
                "implementation_version": binding["implementation_version"],
                "display_name": binding["display_name"],
                "remote": binding["remote"],
                "endpoint_origin": binding["endpoint_origin"],
                "endpoint_path": binding["endpoint_path"],
                "method": binding["method"],
                "contract_sha256": tool["contract_sha256"],
                "input_schema_sha256": tool["input_schema_sha256"],
                "output_schema_sha256": tool["output_schema_sha256"],
                "required_permission_ids": list(tool["permission_ids"]),
                "usable": tool["usable"],
                "timeout_seconds": min(
                    tool["timeout_seconds"],
                    binding["timeout_seconds"] or tool["timeout_seconds"],
                ),
                "max_calls": tool["max_calls"],
                "credentials_required": binding["credentials_required"],
                "credentials_configured": binding["credentials_configured"],
                "approved": tool["approved"],
                "approval_source": "authorization_receipt",
                "compatibility_status": tool["status"],
            }
        )
    return records


def find_binding(registry: dict, binding_id: str) -> dict | None:
    for binding in registry["bindings"]:
        if binding["id"] == binding_id:
            return binding
    return None


__all__ = [
    "BINDING_SCHEMA",
    "BOUND",
    "CONTRACT_SCHEMA",
    "EVALUATION_SCHEMA",
    "IMPLEMENTATION_KINDS",
    "KIND_JSON_HTTP",
    "KIND_LOCAL_BUILTIN",
    "KIND_SELECTED_FILE",
    "REGISTRY_SCHEMA",
    "TOOL_STATUSES",
    "binding_digest",
    "empty_registry",
    "evaluate_binding",
    "evaluate_registry",
    "evaluate_tool",
    "find_binding",
    "normalize_binding",
    "normalize_registry",
    "plan_tool_bindings",
    "registry_reference",
    "tool_contract",
    "tool_requirement_set",
]
