"""Deterministic stand-ins for the trusted host half of the tool boundary.

Three things live here, all of them *host* code in the design's terms:

* `registry_for`, which builds a host tool registry that satisfies one
  package's declarations. A real host writes these by hand, from what it has
  actually implemented; a test derives them from the package so a *mismatch*
  can then be introduced deliberately and named;
* `echo_package`, a minimal signed package whose whole point is one declared
  tool called `test.echo`. It is not a shipped artifact and never will be: it
  exists so the broker can be proved without a service, a network or a model;
* `FakeToolHost`, the parent side of the private protocol, answering
  `tool.call` from a scripted table and recording exactly what it was asked.

Nothing here is a production implementation of anything.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from urllib.parse import urlsplit

from agentpkg.package import build_package, canonical_json, load_package, sha256

ROOT = Path(__file__).resolve().parents[2]

REGISTRY_SCHEMA = "agentpkg-host-tool-registry-v0"
ECHO_TOOL = "test.echo"
ECHO_BINDING = "test.echo.builtin"


def host(**overrides) -> dict:
    record = {
        "runtime": "test-host",
        "runtime_version": "1.0.0",
        "source": "test",
        "captured_at": "2026-09-21T22:00:00+00:00",
    }
    record.update(overrides)
    return record


def binding_for(package, tool_id: str, **overrides) -> dict:
    """A host binding that exactly satisfies one declared tool."""
    tool = package.tools[tool_id]
    permissions = {item["id"]: item for item in package.policy["permissions"]}
    kinds = sorted({permissions[pid]["kind"] for pid in tool["permissions"]})
    remote = tool["execution"] == "remote"
    endpoint = None
    if remote:
        parts = urlsplit(tool["endpoint"])
        endpoint = {
            "origin": f"https://{parts.hostname}",
            "path": parts.path or "/",
            "method": tool["method"],
        }
    record = {
        "id": f"host:{tool_id}:1",
        "tool_id": tool_id,
        "binding": tool["binding"],
        "implementation_kind": "json_http" if remote else "local_builtin",
        "implementation_id": f"test.{tool['binding']}",
        "implementation_version": "0.1.0",
        "display_name": f"Test implementation of {tool_id}",
        "description": None,
        "remote": remote,
        "available": True,
        "availability_reason": None,
        "enabled": True,
        "endpoint": endpoint,
        "contract": {
            "input_schema_sha256": sha256(canonical_json(package.json(tool["input_schema"]))),
            "output_schema_sha256": sha256(canonical_json(package.json(tool["output_schema"]))),
            "permission_kinds": kinds,
            "side_effects": tool["side_effects"],
        },
        "limits": {"timeout_seconds": int(tool["timeout_seconds"]), "max_concurrent": 4},
        "credentials": {"required": False, "configured": False, "source": None},
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(record.get(key), dict):
            record[key] = {**record[key], **value}
        else:
            record[key] = value
    return record


def registry_for(package, *, only=None, overrides=None, extra=(), notes=()) -> dict:
    """A whole registry satisfying one package, with per-tool overrides."""
    overrides = overrides or {}
    tool_ids = sorted(package.tools) if only is None else list(only)
    return {
        "schema": REGISTRY_SCHEMA,
        "host": host(),
        "bindings": [
            binding_for(package, tool_id, **overrides.get(tool_id, {})) for tool_id in tool_ids
        ]
        + list(extra),
        "notes": list(notes),
    }


def empty_registry() -> dict:
    return {"schema": REGISTRY_SCHEMA, "host": host(), "bindings": [], "notes": []}


# -- a package whose only purpose is one deterministic tool ------------------
ECHO_INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["value"],
    "properties": {"value": {"type": "string", "maxLength": 200}},
}
ECHO_OUTPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["value"],
    "properties": {"value": {"type": "string", "maxLength": 200}},
}
ECHO_STATE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["request", "answer"],
    "properties": {
        "request": ECHO_INPUT_SCHEMA,
        "answer": {"type": ["object", "null"], **{}},
    },
}


def echo_source(directory: Path, *, tool_id: str = ECHO_TOOL) -> Path:
    """Write a minimal one-tool workflow.v0 package source tree."""
    root = Path(directory)
    (root / "skills").mkdir(parents=True)
    (root / "schemas").mkdir()
    (root / "tools").mkdir()
    (root / "policy").mkdir()

    def write(path: str, value) -> None:
        (root / path).write_text(json.dumps(value, indent=2) + "\n")

    (root / "skills/echo.SKILL.md").write_text("# Echo\n\nReturn the value unchanged.\n")
    write("schemas/echo-input.schema.json", ECHO_INPUT_SCHEMA)
    write("schemas/echo-output.schema.json", ECHO_OUTPUT_SCHEMA)
    write("schemas/state.schema.json", ECHO_STATE_SCHEMA)
    write(
        f"tools/{tool_id}.tool.json",
        {
            "spec_version": "0.1",
            "id": tool_id,
            "version": "0.1.0",
            "description": "A deterministic host-implemented echo, for boundary tests only.",
            "execution": "local",
            "binding": ECHO_BINDING,
            "endpoint": None,
            "method": None,
            "input_schema": "schemas/echo-input.schema.json",
            "output_schema": "schemas/echo-output.schema.json",
            "permissions": ["files.echo"],
            "domains": [],
            "timeout_seconds": 10,
            "retries": 0,
            "side_effects": "read",
            "approval_required": False,
            "extensions": {},
        },
    )
    write(
        "policy/policy.json",
        {
            "spec_version": "0.1",
            "permissions": [
                {
                    "id": "files.echo",
                    "kind": "files.read",
                    "description": "Use the host echo implementation.",
                    "required": True,
                    "resources": ["host-echo"],
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
                    "description": "Not used by this graph; declared so a run plan can bind.",
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
                "max_remote_calls": 4,
                "max_calls_per_tool": {tool_id: 4},
                "max_parallel_workers": 2,
                "estimated_cost_usd": None,
                "approval_threshold_tokens": None,
            },
            "delegation": {
                "max_depth": 1,
                "approved_roles": ["EchoWorker"],
                "allow_remote": False,
            },
            "extensions": {},
        },
    )
    write(
        "graph.json",
        {
            "spec_version": "0.1",
            "profile": "workflow.v0",
            "coordinator": "EchoCoordinator",
            "workers": [
                {
                    "id": "EchoCoordinator",
                    "kind": "packaged",
                    "skills": [],
                    "tools": [],
                    "max_instances": 1,
                    "budget": {"tokens": 1000, "remote_calls": 4},
                    "state_read": ["request", "answer"],
                    "state_write": ["answer"],
                },
                {
                    "id": "EchoWorker",
                    "kind": "packaged",
                    "skills": ["echo"],
                    "tools": [tool_id],
                    "max_instances": 2,
                    "budget": {"tokens": 1000, "remote_calls": 4},
                    "state_read": ["request"],
                    "state_write": ["answer"],
                },
            ],
            "input_schema": "schemas/echo-input.schema.json",
            "output_schema": "schemas/echo-output.schema.json",
            "initial_state": {
                "object": {
                    "request": {"from": "input", "path": ""},
                    "answer": {"literal": None},
                }
            },
            "deadline_seconds": 60,
            "nodes": [
                {
                    "id": "echo",
                    "type": "tool",
                    "worker": "EchoWorker",
                    "tool": tool_id,
                    "depends_on": [],
                    "input": {"from": "state", "path": "/request"},
                    "output_schema": "schemas/echo-output.schema.json",
                    "timeout_seconds": 30,
                    "writes": {"/answer": {"from": "result", "path": ""}},
                },
                {
                    "id": "result",
                    "type": "output",
                    "worker": "EchoCoordinator",
                    "depends_on": ["echo"],
                    "input": {"from": "state", "path": "/answer"},
                    "output_schema": "schemas/echo-output.schema.json",
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
            "package_id": "org.example.echo",
            "name": "Echo",
            "version": "0.1.0",
            "description": "A one-tool package used only to test the host tool broker.",
            "publisher": {"id": "example", "name": "Example"},
            "created_at": "2026-09-22T00:00:00Z",
            "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": "0.2.0"},
            "capabilities": ["echo"],
            "entrypoint": "workflow.v0",
            "graph": "graph.json",
            "policy": "policy/policy.json",
            "skills": [{"id": "echo", "version": "0.1.0", "path": "skills/echo.SKILL.md"}],
            "tools": [{"id": tool_id, "path": f"tools/{tool_id}.tool.json"}],
            "schemas": [
                {"id": "echo-input", "path": "schemas/echo-input.schema.json"},
                {"id": "echo-output", "path": "schemas/echo-output.schema.json"},
                {"id": "state", "path": "schemas/state.schema.json"},
            ],
            "model_requirements": {
                "tasks": [
                    {
                        "id": "echo",
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


def echo_package(tmp_path: Path):
    """Build and sign the echo package, and load it.

    It is signed with a throwaway key generated here: an execution runner
    re-verifies the artifact it is handed, so an unsigned package would be
    refused for the wrong reason and prove nothing about tools.
    """
    from agentpkg.signing import keygen, sign_package

    root = Path(tmp_path)
    source = echo_source(root / "echo-source")
    artifact = build_package(source, root / "echo.agent.pkg")
    private, public = root / "echo.private.pem", root / "echo.pub.pem"
    keygen(private, public)
    sign_package(artifact, private)
    package = load_package(artifact)
    return package, artifact


def signer_fingerprint(package) -> str:
    """The fingerprint of the key that signed this package, as a plan records it."""
    from agentpkg.signing import embedded_public_key, fingerprint

    return fingerprint(embedded_public_key(package.signature))


# -- the parent side of the private protocol ---------------------------------
class FakeToolHost:
    """Answers `tool.call` from a table, and records everything it was asked."""

    def __init__(self, *, answers=None, fail_with=None, delay: float = 0.0):
        self.answers = answers or {}
        self.fail_with = fail_with
        self.delay = delay
        self.requests: list[dict] = []
        self.cancelled: list[str] = []

    async def __call__(self, method: str, params: dict) -> dict:
        if method != "tool.call":
            raise AssertionError(f"unexpected method {method!r}")
        self.requests.append(params)
        if self.delay:
            try:
                await asyncio.sleep(self.delay)
            except asyncio.CancelledError:
                self.cancelled.append(params["tool_id"])
                raise
        if self.fail_with is not None:
            raise self.fail_with
        answer = self.answers.get(params["tool_id"])
        output = answer(params["args"]) if callable(answer) else answer
        return {
            "status": "ok",
            "output": output,
            "tool_id": params["tool_id"],
            "binding_id": params["binding_id"],
            "binding_sha256": params["binding_sha256"],
            "remote": False,
            "duration_ms": 1.0,
        }


__all__ = [
    "ECHO_BINDING",
    "ECHO_TOOL",
    "REGISTRY_SCHEMA",
    "FakeToolHost",
    "binding_for",
    "echo_package",
    "echo_source",
    "empty_registry",
    "host",
    "registry_for",
    "signer_fingerprint",
]
