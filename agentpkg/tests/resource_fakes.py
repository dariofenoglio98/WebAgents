"""A package that requests one host-owned resource, and a host that holds some.

Nothing here is WebAir's or any shipped package's: the point is that the host-resource
mechanism is generic. The package is a one-node "work hours" reader that asks the host for
the person's work hours (`personal.work_hours`) under a `personal.read` permission, through
an argument-free local tool; the host registry lists two such resources by opaque id,
display-safe label and digest. A test host derives these from data, as a real one would from
its own store.
"""

from __future__ import annotations

import json
from pathlib import Path

from agentpkg.package import build_package, canonical_json, load_package, sha256

RESOURCE_TYPE = "personal.work_hours"
PERMISSION = "calendar.hours"
EMPTY_INPUT = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}
HOURS_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "start": {"type": "string", "pattern": "^[0-9]{2}:[0-9]{2}$"},
        "end": {"type": "string", "pattern": "^[0-9]{2}:[0-9]{2}$"},
        "timezone": {"type": "string", "minLength": 1},
    },
    "required": ["start", "end", "timezone"],
    "additionalProperties": False,
}


def hours_source(directory: Path, *, kind: str = "personal.read", scopes=None) -> Path:
    root = Path(directory)
    for sub in ("schemas", "tools", "policy", "skills"):
        (root / sub).mkdir(parents=True, exist_ok=True)

    def write(path: str, value) -> None:
        (root / path).write_text(json.dumps(value, indent=2) + "\n")

    (root / "skills/hours.SKILL.md").write_text("# Hours\n\nNothing to do.\n")
    write("schemas/empty-input.schema.json", EMPTY_INPUT)
    write("schemas/hours.schema.json", HOURS_SCHEMA)
    write(
        "schemas/input.schema.json",
        {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object"},
    )
    write(
        "schemas/state.schema.json",
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "request": {"type": "object"},
                "hours": {"anyOf": [{"type": "null"}, {"$ref": "hours.schema.json"}]},
            },
            "required": ["request", "hours"],
            "additionalProperties": False,
        },
    )
    write(
        f"tools/{RESOURCE_TYPE}.tool.json",
        {
            "spec_version": "0.1",
            "id": RESOURCE_TYPE,
            "version": "0.1.0",
            "description": "The person's work hours, as their host holds them.",
            "execution": "local",
            "binding": f"host.resource.{RESOURCE_TYPE}",
            "endpoint": None,
            "method": None,
            "input_schema": "schemas/empty-input.schema.json",
            "output_schema": "schemas/hours.schema.json",
            "permissions": [PERMISSION],
            "domains": [],
            "timeout_seconds": 10,
            "retries": 0,
            "side_effects": "read",
            "approval_required": True,
            "extensions": {},
        },
    )
    write(
        "policy/policy.json",
        {
            "spec_version": "0.1",
            "permissions": [
                {
                    "id": PERMISSION,
                    "kind": kind,
                    "description": "Read the work hours you choose.",
                    "required": False,
                    "resources": list(scopes or [RESOURCE_TYPE]),
                },
                {
                    "id": "memory.session",
                    "kind": "memory",
                    "description": "Session state only.",
                    "required": True,
                    "resources": ["session"],
                },
                {
                    "id": "model.any",
                    "kind": "model",
                    "description": "Declared so a model-backed plan can bind; never used.",
                    "required": False,
                    "resources": ["host-router"],
                },
            ],
            "network": {"allowed_domains": [], "https_only": True, "allow_redirects": False},
            "memory": {
                "scope": "session",
                "retention": "session",
                "raw_documents": False,
                "state_schema": "schemas/state.schema.json",
                "sharing": "explicit_views",
            },
            "budget": {
                "estimated_tokens": 10,
                "hard_tokens": 1000,
                "max_remote_calls": 1,
                "max_calls_per_tool": {RESOURCE_TYPE: 1},
                "max_parallel_workers": 1,
                "estimated_cost_usd": None,
                "approval_threshold_tokens": None,
            },
            "delegation": {"max_depth": 1, "approved_roles": ["Reader"], "allow_remote": False},
            "extensions": {},
        },
    )
    write(
        "graph.json",
        {
            "spec_version": "0.1",
            "profile": "workflow.v0",
            "coordinator": "Coordinator",
            "workers": [
                {
                    "id": "Coordinator",
                    "kind": "packaged",
                    "skills": [],
                    "tools": [],
                    "max_instances": 1,
                    "budget": {"tokens": 0, "remote_calls": 0},
                    "state_read": ["request", "hours"],
                    "state_write": [],
                },
                {
                    "id": "Reader",
                    "kind": "packaged",
                    "skills": [],
                    "tools": [RESOURCE_TYPE],
                    "max_instances": 1,
                    "budget": {"tokens": 0, "remote_calls": 0},
                    "state_read": ["request"],
                    "state_write": ["hours"],
                },
            ],
            "input_schema": "schemas/input.schema.json",
            "output_schema": "schemas/hours.schema.json",
            "initial_state": {
                "object": {
                    "request": {"from": "input", "path": ""},
                    "hours": {"literal": None},
                }
            },
            "deadline_seconds": 60,
            "nodes": [
                {
                    "id": "read",
                    "type": "tool",
                    "worker": "Reader",
                    "tool": RESOURCE_TYPE,
                    "depends_on": [],
                    "input": {"literal": {}},
                    "output_schema": "schemas/hours.schema.json",
                    "timeout_seconds": 10,
                    "writes": {"/hours": {"from": "result", "path": ""}},
                },
                {
                    "id": "output",
                    "type": "output",
                    "worker": "Coordinator",
                    "depends_on": ["read"],
                    "input": {"from": "state", "path": "/hours"},
                    "output_schema": "schemas/hours.schema.json",
                    "timeout_seconds": 10,
                    "writes": {},
                },
            ],
            "extensions": {},
        },
    )
    write(
        "MANIFEST.agent",
        {
            "spec_version": "0.1",
            "package_id": "org.example.work-hours",
            "name": "Work hours",
            "version": "0.1.0",
            "description": "Reads the person's work hours from their host. Test package only.",
            "publisher": {"id": "example", "name": "Example"},
            "created_at": "2026-10-02T00:00:00Z",
            "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": "0.2.0"},
            "capabilities": ["work-hours"],
            "entrypoint": "workflow.v0",
            "graph": "graph.json",
            "policy": "policy/policy.json",
            "skills": [{"id": "hours", "version": "0.1.0", "path": "skills/hours.SKILL.md"}],
            "tools": [{"id": RESOURCE_TYPE, "path": f"tools/{RESOURCE_TYPE}.tool.json"}],
            "schemas": [
                {"id": "empty-input", "path": "schemas/empty-input.schema.json"},
                {"id": "hours", "path": "schemas/hours.schema.json"},
                {"id": "input", "path": "schemas/input.schema.json"},
                {"id": "state", "path": "schemas/state.schema.json"},
            ],
            "model_requirements": {
                "tasks": [
                    {
                        "id": "unused",
                        "capabilities": ["structured_output"],
                        "context_window": 1000,
                        "preferred_tier": "any",
                    }
                ],
                "routing": "host",
                "fallback_policy": "deny",
                "extensions": {},
            },
            "evals": [],
            "attestations": [],
            "dependencies": [],
            "update": {"channel": "local", "locator": None},
            "extensions": {},
        },
    )
    return root


def hours_package(tmp_path: Path, **options):
    """Build and sign the package under a throwaway key; return (package, artifact, public key)."""
    from agentpkg.signing import keygen, sign_package

    root = Path(tmp_path)
    source = hours_source(root / "hours-source", **options)
    artifact = build_package(source, root / "hours.agent.pkg")
    private, public = root / "hours.private.pem", root / "hours.pub.pem"
    keygen(private, public)
    sign_package(artifact, private)
    return load_package(artifact), artifact, public


def digest_of(value) -> str:
    """A test host's digest of a value (a real host keys it; equality is all that matters)."""
    return sha256(canonical_json(value))


HOURS = {
    "hours_weekday": {"start": "09:00", "end": "17:00", "timezone": "Europe/Zurich"},
    "hours_early": {"start": "07:00", "end": "15:00", "timezone": "Europe/Zurich"},
}


def resource_registry(values=None, *, types=None) -> dict:
    values = HOURS if values is None else values
    return {
        "schema": "agentpkg-host-resource-registry-v0",
        "host": {
            "runtime": "test-host",
            "source": "test",
            "captured_at": "2026-10-02T00:00:00+00:00",
        },
        "types": types
        if types is not None
        else [
            {
                "id": RESOURCE_TYPE,
                "display_name": "Work hours",
                "description": None,
                "permission_kind": "personal.read",
                "schema_sha256": digest_of(HOURS_SCHEMA),
            }
        ],
        "resources": [
            {
                "id": resource_id,
                "type": RESOURCE_TYPE,
                "label": f"{value['start']}–{value['end']}",
                "digest": digest_of({"id": resource_id, "value": value}),
            }
            for resource_id, value in values.items()
        ],
        "notes": [],
    }


def resource_binding(package) -> dict:
    """The host_resource binding a host offering `personal.work_hours` registers."""
    return {
        "id": f"host:host-resource:{RESOURCE_TYPE}:1",
        "tool_id": RESOURCE_TYPE,
        "binding": f"host.resource.{RESOURCE_TYPE}",
        "implementation_kind": "host_resource",
        "implementation_id": "test.host_resource",
        "implementation_version": "0.1.0",
        "display_name": "Work hours (held by this host)",
        "description": None,
        "remote": False,
        "available": True,
        "availability_reason": None,
        "enabled": True,
        "endpoint": None,
        "contract": {
            "input_schema_sha256": digest_of(EMPTY_INPUT),
            "output_schema_sha256": digest_of(HOURS_SCHEMA),
            "permission_kinds": ["personal.read"],
            "side_effects": "read",
        },
        "limits": {"timeout_seconds": 5, "max_concurrent": 2},
        "credentials": {"required": False, "configured": False, "source": None},
        "resource_type": RESOURCE_TYPE,
    }


def tool_registry(package) -> dict:
    return {
        "schema": "agentpkg-host-tool-registry-v0",
        "host": {
            "runtime": "test-host",
            "source": "test",
            "captured_at": "2026-10-02T00:00:00+00:00",
        },
        "bindings": [resource_binding(package)],
        "notes": [],
    }
