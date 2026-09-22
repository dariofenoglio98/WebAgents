"""Host model catalogs and generic package/model compatibility.

Two knowledge domains meet here and are deliberately kept apart:

* the **host** (OpenClaw, in the shipped integration) knows which models exist,
  which are usable, and what it is willing to say about them. It sends that as
  a bounded, provider-neutral catalog of *descriptors*;
* **agentpkg** knows what a package requires and what those requirements mean.
  It never learns a provider name, a model family, or a vendor capability
  vocabulary, and it never contacts a model.

Nothing in this module invokes anything. Evaluating compatibility is arithmetic
and set membership over declared data.

Three rules shape the evaluation:

1. a missing host answer is `unknown`, never `false` and never `true`;
2. a preference can never make a model incompatible;
3. every requirement carries its own reason, so a UI can explain a verdict
   instead of asserting one.
"""

from __future__ import annotations

from datetime import UTC, datetime

from ..package import Package, canonical_json, sha256
from .errors import ControlPlaneError

CATALOG_SCHEMA = "agentpkg-host-model-catalog-v0"
DESCRIPTOR_SCHEMA = "agentpkg-host-model-descriptor-v0"
EVALUATION_SCHEMA = "agentpkg-model-evaluation-v0"
REQUIREMENTS_SCHEMA = "agentpkg-model-requirements-v0"

MAX_MODELS = 256
MAX_CAPABILITIES = 64
MAX_STRING = 512
MAX_NOTES = 32
MAX_TAGS = 16

# Compatibility outcomes. `unverified` exists because collapsing "the host did
# not say" into either boolean would misinform the person making the decision.
COMPATIBLE = "compatible"
INCOMPATIBLE = "incompatible"
UNVERIFIED = "unverified"
COMPATIBILITY_STATUSES = (COMPATIBLE, UNVERIFIED, INCOMPATIBLE)

SATISFIED = "satisfied"
VIOLATED = "violated"
UNKNOWN = "unknown"

# How strongly the host backed a capability answer. `declared` is the host
# reporting a per-model fact; `host_default` is the host applying its own
# documented default to a model whose catalog row is silent; `derived` is the
# host mapping one of its own facts onto this capability name. All three are
# host statements — none is agentpkg guessing — and each is recorded so the
# difference stays visible all the way into the run plan.
BASES = ("declared", "host_default", "derived", "absent")


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
        # Refusing unknown fields is what keeps a future host from smuggling
        # credentials, endpoints or request parameters through this boundary.
        raise ControlPlaneError(
            "unknown_field", f"Unknown fields in {field}: {sorted(unknown)}", status=400
        )
    missing = required - set(value)
    if missing:
        raise ControlPlaneError("invalid_request", f"Missing fields in {field}: {sorted(missing)}")
    return value


def _tristate(value, field: str):
    if value is None or isinstance(value, bool):
        return value
    raise ControlPlaneError("invalid_request", f"{field} must be true, false or null")


def _count(value, field: str, *, allow_none: bool = True):
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ControlPlaneError("invalid_request", f"{field} must be a nonnegative integer")
    return value


def normalize_capability(name: str, raw, *, field: str) -> dict:
    """One host answer about one capability name, with its provenance."""
    record = _fields(raw, field, {"value", "basis", "detail"}, {"value"})
    value = _tristate(record["value"], f"{field}.value")
    basis = _text(
        record.get("basis") or ("absent" if value is None else "declared"), f"{field}.basis"
    )
    if basis not in BASES:
        raise ControlPlaneError("invalid_request", f"{field}.basis must be one of {list(BASES)}")
    if value is None and basis != "absent":
        raise ControlPlaneError(
            "invalid_request", f"{field} has no value, so its basis must be 'absent'"
        )
    return {
        "name": name,
        "value": value,
        "basis": basis,
        "detail": _text(record.get("detail"), f"{field}.detail", allow_none=True),
    }


def normalize_descriptor(raw, *, index: int) -> dict:
    """Validate one host model descriptor into the exact stored shape.

    The closed field set is the contract. A host may only send what is listed
    here, so no endpoint, header, key, profile id or request parameter has a
    place to travel in.
    """
    field = f"models[{index}]"
    record = _fields(
        raw,
        field,
        {
            "id",
            "provider_id",
            "model_id",
            "display_name",
            "available",
            "availability_reason",
            "selectable",
            "capabilities",
            "limits",
            "properties",
        },
        {"id", "provider_id", "model_id", "display_name", "available", "capabilities"},
    )
    limits = _fields(
        record.get("limits") or {},
        f"{field}.limits",
        {"context_tokens", "native_context_window", "max_output_tokens"},
    )
    properties = _fields(
        record.get("properties") or {},
        f"{field}.properties",
        {"local", "privacy_class", "cost_class", "status", "tags"},
    )
    capabilities_raw = record["capabilities"]
    if not isinstance(capabilities_raw, dict):
        raise ControlPlaneError("invalid_request", f"{field}.capabilities must be an object")
    if len(capabilities_raw) > MAX_CAPABILITIES:
        raise ControlPlaneError(
            "invalid_request", f"{field}.capabilities exceeds {MAX_CAPABILITIES} entries"
        )
    capabilities = {
        _text(name, f"{field}.capabilities key", limit=128): normalize_capability(
            name, value, field=f"{field}.capabilities[{name}]"
        )
        for name, value in sorted(capabilities_raw.items())
    }
    tags = properties.get("tags") or []
    if not isinstance(tags, list) or len(tags) > MAX_TAGS:
        raise ControlPlaneError(
            "invalid_request", f"{field}.properties.tags must be a list of at most {MAX_TAGS}"
        )
    return {
        "schema": DESCRIPTOR_SCHEMA,
        "id": _text(record["id"], f"{field}.id", limit=256),
        "provider_id": _text(record["provider_id"], f"{field}.provider_id", limit=128),
        "model_id": _text(record["model_id"], f"{field}.model_id", limit=256),
        "display_name": _text(record["display_name"], f"{field}.display_name"),
        "available": bool(_tristate(record["available"], f"{field}.available") is True),
        "availability_reason": _text(
            record.get("availability_reason"), f"{field}.availability_reason", allow_none=True
        ),
        "selectable": bool(record.get("selectable", True) is True),
        "capabilities": capabilities,
        "limits": {
            "context_tokens": _count(
                limits.get("context_tokens"), f"{field}.limits.context_tokens"
            ),
            "native_context_window": _count(
                limits.get("native_context_window"), f"{field}.limits.native_context_window"
            ),
            "max_output_tokens": _count(
                limits.get("max_output_tokens"), f"{field}.limits.max_output_tokens"
            ),
        },
        "properties": {
            "local": _tristate(properties.get("local"), f"{field}.properties.local"),
            "privacy_class": _text(
                properties.get("privacy_class"),
                f"{field}.properties.privacy_class",
                allow_none=True,
            ),
            "cost_class": _text(
                properties.get("cost_class"), f"{field}.properties.cost_class", allow_none=True
            ),
            "status": _text(
                properties.get("status"), f"{field}.properties.status", allow_none=True
            ),
            "tags": [_text(tag, f"{field}.properties.tags[]", limit=64) for tag in tags],
        },
    }


def normalize_catalog(raw) -> dict:
    """Validate a whole host catalog and bind it to a content hash.

    The hash is what a run plan records, so a plan can never silently refer to a
    different catalog state than the one its compatibility verdict was computed
    against.
    """
    record = _fields(raw, "catalog", {"schema", "host", "models", "notes"}, {"host", "models"})
    schema = _text(record.get("schema", CATALOG_SCHEMA), "catalog.schema")
    if schema != CATALOG_SCHEMA:
        raise ControlPlaneError(
            "invalid_request", f"catalog.schema must be {CATALOG_SCHEMA!r}, got {schema!r}"
        )
    host = _fields(
        record["host"],
        "catalog.host",
        {"runtime", "runtime_version", "source", "captured_at", "agent_id"},
        {"runtime", "source", "captured_at"},
    )
    models_raw = record["models"]
    if not isinstance(models_raw, list):
        raise ControlPlaneError("invalid_request", "catalog.models must be a list")
    if len(models_raw) > MAX_MODELS:
        raise ControlPlaneError("invalid_request", f"catalog.models exceeds {MAX_MODELS} entries")
    models = [normalize_descriptor(item, index=index) for index, item in enumerate(models_raw)]
    seen: set[str] = set()
    for model in models:
        if model["id"] in seen:
            raise ControlPlaneError("invalid_request", f"duplicate model id {model['id']!r}")
        seen.add(model["id"])
    notes_raw = record.get("notes") or []
    if not isinstance(notes_raw, list) or len(notes_raw) > MAX_NOTES:
        raise ControlPlaneError(
            "invalid_request", f"catalog.notes must be a list of at most {MAX_NOTES}"
        )
    notes = [
        {
            "code": _text(
                _fields(note, "catalog.notes[]", {"code", "detail"}, {"code"})["code"],
                "catalog.notes[].code",
                limit=128,
            ),
            "detail": _text(note.get("detail"), "catalog.notes[].detail", allow_none=True),
        }
        for note in notes_raw
    ]
    catalog = {
        "schema": CATALOG_SCHEMA,
        "host": {
            "runtime": _text(host["runtime"], "catalog.host.runtime", limit=64),
            "runtime_version": _text(
                host.get("runtime_version"), "catalog.host.runtime_version", allow_none=True
            ),
            "source": _text(host["source"], "catalog.host.source"),
            "captured_at": _text(host["captured_at"], "catalog.host.captured_at", limit=64),
            "agent_id": _text(host.get("agent_id"), "catalog.host.agent_id", allow_none=True),
        },
        "models": models,
        "notes": notes,
    }
    catalog["catalog_sha256"] = sha256(canonical_json(catalog))
    catalog["model_count"] = len(models)
    catalog["available_model_count"] = sum(1 for model in models if model["available"])
    return catalog


def catalog_reference(catalog: dict) -> dict:
    """The small binding record a receipt-like artifact stores about a catalog."""
    return {
        "catalog_sha256": catalog["catalog_sha256"],
        "model_count": catalog["model_count"],
        "available_model_count": catalog["available_model_count"],
        "host": dict(catalog["host"]),
    }


# -- package requirements ----------------------------------------------------
def requirement_set(package: Package) -> dict:
    """Normalize a package's declared model requirements, generically.

    `single_model` binding means one host model serves every declared task, so
    the effective hard requirement is the union of task capabilities and the
    largest declared context window. Per-task detail is retained so a future
    per-task or per-node binding can use the same structure without a format
    change.
    """
    declared = package.manifest["model_requirements"]
    tasks = []
    capability_tasks: dict[str, list[str]] = {}
    context_tasks: dict[int, list[str]] = {}
    for task in declared["tasks"]:
        tasks.append(
            {
                "id": task["id"],
                "capabilities": list(task["capabilities"]),
                "context_window": task["context_window"],
                "preferred_tier": task.get("preferred_tier"),
            }
        )
        for capability in task["capabilities"]:
            capability_tasks.setdefault(capability, []).append(task["id"])
        context_tasks.setdefault(task["context_window"], []).append(task["id"])

    hard = []
    for capability in sorted(capability_tasks):
        hard.append(
            {
                "id": f"capability:{capability}",
                "kind": "capability",
                "subject": capability,
                "operator": "is_true",
                "value": True,
                "tasks": sorted(set(capability_tasks[capability])),
            }
        )
    if context_tasks:
        largest = max(context_tasks)
        hard.append(
            {
                "id": "context_tokens:minimum",
                "kind": "context_tokens",
                "subject": "context_tokens",
                "operator": "at_least",
                "value": largest,
                "tasks": sorted(
                    {tid for size, ids in context_tasks.items() if size == largest for tid in ids}
                ),
            }
        )
    privacy = declared.get("privacy")
    if privacy == "local-only":
        hard.append(
            {
                "id": "property:local",
                "kind": "property",
                "subject": "local",
                "operator": "is_true",
                "value": True,
                "tasks": sorted(task["id"] for task in tasks),
            }
        )

    preferences = []
    tiers = sorted({task["preferred_tier"] for task in tasks if task.get("preferred_tier")})
    for tier in tiers:
        preferences.append(
            {"id": f"preferred_tier:{tier}", "kind": "preferred_tier", "subject": tier}
        )
    for key in ("latency_preference", "cost_sensitivity"):
        value = declared.get(key)
        if value:
            preferences.append({"id": f"{key}:{value}", "kind": key, "subject": value})

    return {
        "schema": REQUIREMENTS_SCHEMA,
        "package_id": package.manifest["package_id"],
        "package_version": package.manifest["version"],
        "package_digest": package.digest,
        "routing": declared["routing"],
        "fallback_policy": declared["fallback_policy"],
        "privacy": privacy,
        "latency_preference": declared.get("latency_preference"),
        "cost_sensitivity": declared.get("cost_sensitivity"),
        "tasks": tasks,
        "hard_requirements": hard,
        "preferences": preferences,
        "binding_strategy": "single_model",
        "note": (
            "Hard requirements must hold for the one selected model, because this profile "
            "binds a single model to every declared task."
        ),
    }


# -- evaluation --------------------------------------------------------------
def _host_capability(descriptor: dict, name: str) -> dict:
    found = descriptor["capabilities"].get(name)
    if found is None:
        return {"name": name, "value": None, "basis": "absent", "detail": None}
    return found


def _context_value(descriptor: dict) -> tuple[int | None, str]:
    limits = descriptor["limits"]
    if limits["context_tokens"] is not None:
        return limits["context_tokens"], "limits.context_tokens"
    if limits["native_context_window"] is not None:
        return limits["native_context_window"], "limits.native_context_window"
    return None, "absent"


def _check(requirement: dict, descriptor: dict) -> dict:
    kind = requirement["kind"]
    if kind == "capability":
        answer = _host_capability(descriptor, requirement["subject"])
        host_value = answer["value"]
        status = UNKNOWN if host_value is None else (SATISFIED if host_value else VIOLATED)
        return {
            **requirement,
            "host_value": host_value,
            "status": status,
            "basis": answer["basis"],
            "source": "capabilities",
            "detail": answer["detail"],
        }
    if kind == "context_tokens":
        host_value, source = _context_value(descriptor)
        status = (
            UNKNOWN
            if host_value is None
            else (SATISFIED if host_value >= requirement["value"] else VIOLATED)
        )
        return {
            **requirement,
            "host_value": host_value,
            "status": status,
            "basis": "absent" if host_value is None else "declared",
            "source": source,
            "detail": None,
        }
    # property: a boolean fact the host reports about the model itself.
    host_value = descriptor["properties"].get(requirement["subject"])
    status = UNKNOWN if host_value is None else (SATISFIED if host_value else VIOLATED)
    return {
        **requirement,
        "host_value": host_value,
        "status": status,
        "basis": "absent" if host_value is None else "declared",
        "source": f"properties.{requirement['subject']}",
        "detail": None,
    }


def _preference(preference: dict, descriptor: dict) -> dict:
    """Preferences are reported, never enforced. An unmet one is not a failure."""
    if preference["kind"] == "preferred_tier":
        tags = descriptor["properties"]["tags"]
        met = preference["subject"] in tags
        return {**preference, "host_value": tags, "status": "met" if met else "unknown"}
    if preference["kind"] == "cost_sensitivity":
        host_value = descriptor["properties"]["cost_class"]
    else:
        host_value = None
    return {
        **preference,
        "host_value": host_value,
        "status": "unknown" if host_value is None else "reported",
    }


def evaluate_model(requirements: dict, descriptor: dict) -> dict:
    """Compare one host model against one package's normalized requirements."""
    checks = [_check(requirement, descriptor) for requirement in requirements["hard_requirements"]]
    violated = [check for check in checks if check["status"] == VIOLATED]
    unknown = [check for check in checks if check["status"] == UNKNOWN]
    if violated:
        status = INCOMPATIBLE
    elif unknown:
        status = UNVERIFIED
    else:
        status = COMPATIBLE
    bases = {check["basis"] for check in checks if check["status"] == SATISFIED}
    if not bases:
        strength = "none"
    elif bases == {"declared"}:
        strength = "declared"
    elif "derived" in bases:
        strength = "derived"
    else:
        strength = "host_default"
    return {
        "model_id": descriptor["id"],
        "provider_id": descriptor["provider_id"],
        "display_name": descriptor["display_name"],
        "available": descriptor["available"],
        "availability_reason": descriptor["availability_reason"],
        "selectable": descriptor["selectable"],
        "status": status,
        "selectable_for_run_plan": descriptor["available"]
        and descriptor["selectable"]
        and status != INCOMPATIBLE,
        "evidence_strength": strength,
        "satisfied": [check["id"] for check in checks if check["status"] == SATISFIED],
        "violated": [check["id"] for check in violated],
        "unknown": [check["id"] for check in unknown],
        "checks": checks,
        "preferences": [
            _preference(preference, descriptor) for preference in requirements["preferences"]
        ],
        "limits": dict(descriptor["limits"]),
        "properties": dict(descriptor["properties"]),
        "capabilities": {
            name: {"value": answer["value"], "basis": answer["basis"], "detail": answer["detail"]}
            for name, answer in descriptor["capabilities"].items()
        },
    }


_ORDER = {COMPATIBLE: 0, UNVERIFIED: 1, INCOMPATIBLE: 2}


def evaluate_catalog(package: Package, catalog: dict) -> dict:
    """Evaluate every host model against one package, in a stable order."""
    requirements = requirement_set(package)
    models = [evaluate_model(requirements, descriptor) for descriptor in catalog["models"]]
    # Available first, then compatible before unverified before incompatible,
    # then by identifier. This is presentation order, not a quality ranking:
    # nothing here says one compatible model is better than another.
    models.sort(key=lambda item: (not item["available"], _ORDER[item["status"]], item["model_id"]))
    counts = {
        status: sum(1 for item in models if item["status"] == status)
        for status in COMPATIBILITY_STATUSES
    }
    return {
        "schema": EVALUATION_SCHEMA,
        "evaluated_at": datetime.now(UTC).isoformat(),
        "package_id": package.manifest["package_id"],
        "package_version": package.manifest["version"],
        "package_digest": package.digest,
        "requirements": requirements,
        "catalog": catalog_reference(catalog),
        "models": models,
        "counts": {
            **counts,
            "total": len(models),
            "available": sum(1 for item in models if item["available"]),
            "selectable": sum(1 for item in models if item["selectable_for_run_plan"]),
        },
        "notes": list(catalog["notes"]),
        "execution": {
            "performed": False,
            "note": "Evaluating compatibility reads declarations only; no model was contacted.",
        },
    }


def find_model(catalog: dict, model_id: str) -> dict | None:
    for descriptor in catalog["models"]:
        if descriptor["id"] == model_id:
            return descriptor
    return None


__all__ = [
    "CATALOG_SCHEMA",
    "COMPATIBILITY_STATUSES",
    "DESCRIPTOR_SCHEMA",
    "EVALUATION_SCHEMA",
    "REQUIREMENTS_SCHEMA",
    "catalog_reference",
    "evaluate_catalog",
    "evaluate_model",
    "find_model",
    "normalize_catalog",
    "normalize_descriptor",
    "requirement_set",
]
