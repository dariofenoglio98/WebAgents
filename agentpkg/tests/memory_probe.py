"""A small generic workflow.v0 package that uses every memory.v0 permission (spec/memory-v0.md §7),
written into a directory so that each test can change one thing: a `memory.read` of a travel
profile (the record view), a `personal.read` of a passenger identity under its legacy id, the
agent document's two tools, one model step that proposes and writes notes, a local tool that
receives the identity's e-mail, and the `memory.proposal` export.

Nothing here names a real package; the records are the fictional ones of the spec's worked
example (spec/memory-v0/examples/webair-0.6.0).
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "spec" / "memory-v0"
EXAMPLE = CONTRACTS / "examples" / "webair-0.6.0"
PROFILE_ID = "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60"
IDENTITY_ID = "mem_0a1b2c3d4e5f60718293a4b5c6d7e8f9"
EMAIL = "alex.traveler@example.com"
REQUEST = {"request": "Remember what I chose."}
NOTES = "# Notes\n- Last run: one preference proposed.\n- [[Packing list]] and [[self]] are text."


def _json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def profile_view() -> dict:
    return json.loads((EXAMPLE / "fixture" / "travel.profile.json").read_text())["output"]


def identity_answer() -> dict:
    return {"given_name": "Alex", "family_name": "Traveler", "contact_email": EMAIL}


def proposals() -> list[dict]:
    return [
        {
            "action": "create",
            "type": "travel.preference",
            "title": "Aisle seat",
            "fields": {"kind": "seat", "value": "aisle"},
            "body": "Chosen on the probe run.",
            "tags": ["seat"],
            "links": [{"to": "self", "rel": "about"}],
            "rationale": "You chose an aisle seat.",
        },
        {
            "action": "update",
            "type": "travel.profile",
            "target": PROFILE_ID,
            "title": "Home travel profile",
            "fields": profile_view()["fields"],
            "body": profile_view()["body"],
            "tags": ["home"],
            "links": [{"to": "#0", "rel": "prefers"}],
            "rationale": "Links your home profile to the seat preference.",
        },
    ]


def remember_input() -> dict:
    return {"request": REQUEST["request"], "profile": profile_view()["fields"], "notes": ""}


def manifest() -> dict:
    return {
        "spec_version": "0.1",
        "package_id": "org.example.memory-probe",
        "name": "Memory Probe",
        "version": "0.1.0",
        "description": "A test package that uses every memory.v0 permission.",
        "publisher": {"id": "example", "name": "Example"},
        "created_at": "2026-10-14T00:00:00Z",
        "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": "0.4.0"},
        "capabilities": [],
        "entrypoint": "workflow.v0",
        "graph": "graph.json",
        "policy": "policy/policy.json",
        "skills": [{"id": "probe", "version": "0.1.0", "path": "skills/probe/SKILL.md"}],
        "tools": [
            {"id": "profile", "path": "tools/profile.tool.json"},
            {"id": "identity", "path": "tools/identity.tool.json"},
            {"id": "notes-read", "path": "tools/notes-read.tool.json"},
            {"id": "notes-write", "path": "tools/notes-write.tool.json"},
            {"id": "echo", "path": "tools/echo.tool.json"},
        ],
        "schemas": [
            {"id": name, "path": f"schemas/{name}.schema.json"}
            for name in (
                "input",
                "state",
                "any",
                "remember",
                "empty-input",
                "travel.profile.view",
                "identity",
                "agent-read.output",
                "agent-write.input",
                "agent-write.output",
                "echo.input",
            )
        ],
        "model_requirements": {
            "tasks": [
                {
                    "id": "remember",
                    "capabilities": ["structured_output"],
                    "context_window": 8000,
                    "preferred_tier": "reasoning",
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
    }


def policy() -> dict:
    def permission(pid, kind, resources, required=False):
        return {
            "id": pid,
            "kind": kind,
            "description": f"Probe permission {pid}.",
            "required": required,
            "resources": resources,
        }

    return {
        "spec_version": "0.1",
        "permissions": [
            permission("model.reasoning", "model", ["host-router"], True),
            permission("memory.session", "memory", ["session"], True),
            permission("memory.profile", "memory.read", ["travel.profile"]),
            permission("identity.read", "personal.read", ["personal.passenger_identity"]),
            permission("memory.remember", "memory.write", ["travel.preference", "travel.profile"]),
            permission("memory.agent", "memory", ["agent"]),
        ],
        "network": {"allowed_domains": [], "https_only": True, "allow_redirects": False},
        "memory": {
            "scope": "agent-scoped",
            "retention": "user-managed",
            "raw_documents": False,
            "state_schema": "schemas/state.schema.json",
            "sharing": "explicit_views",
        },
        "budget": {
            "estimated_tokens": 4000,
            "hard_tokens": 60000,
            "max_remote_calls": 8,
            "max_calls_per_tool": {
                "profile": 1,
                "identity": 1,
                "notes-read": 1,
                "notes-write": 1,
                "echo": 1,
            },
            "max_parallel_workers": 2,
            "estimated_cost_usd": None,
            "approval_threshold_tokens": None,
        },
        "delegation": {
            "max_depth": 1,
            "approved_roles": ["Reader", "Rememberer"],
            "allow_remote": False,
        },
        "extensions": {},
    }


def tool(tool_id, binding, input_schema, output_schema, permissions, side_effects="read"):
    return {
        "spec_version": "0.1",
        "id": tool_id,
        "version": "0.1.0",
        "description": f"Probe tool {tool_id}.",
        "execution": "local",
        "binding": binding,
        "endpoint": None,
        "method": None,
        "input_schema": f"schemas/{input_schema}.schema.json",
        "output_schema": f"schemas/{output_schema}.schema.json",
        "permissions": permissions,
        "domains": [],
        "timeout_seconds": 10,
        "retries": 0,
        "side_effects": side_effects,
        "approval_required": True,
        "extensions": {},
    }


def node(node_id, kind, worker, **rest):
    value = {
        "id": node_id,
        "type": kind,
        "worker": worker,
        "timeout_seconds": 30,
        "depends_on": [],
        "writes": {},
    }
    value.update(rest)
    return value


def state(path):
    return {"from": "state", "path": path}


def graph() -> dict:
    keys = ["request", "profile", "identity", "notes", "remember", "written", "echoed", "result"]
    return {
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
                "state_read": keys,
                "state_write": ["result"],
            },
            {
                "id": "Reader",
                "kind": "packaged",
                "skills": [],
                "tools": ["profile", "identity", "notes-read", "notes-write", "echo"],
                "max_instances": 1,
                "budget": {"tokens": 0, "remote_calls": 0},
                "state_read": ["request", "identity", "remember"],
                "state_write": ["profile", "identity", "notes", "written", "echoed"],
            },
            {
                "id": "Rememberer",
                "kind": "packaged",
                "skills": ["probe"],
                "tools": [],
                "max_instances": 1,
                "budget": {"tokens": 20000, "remote_calls": 2},
                "state_read": ["request", "profile", "identity", "notes"],
                "state_write": ["remember"],
            },
        ],
        "input_schema": "schemas/input.schema.json",
        "output_schema": "schemas/any.schema.json",
        "initial_state": {
            "object": {
                "request": {"from": "input", "path": ""},
                **{key: {"literal": None} for key in keys[1:]},
            }
        },
        "deadline_seconds": 60,
        "fixture": "fixtures/workflow.json",
        "nodes": [
            node(
                "profile",
                "tool",
                "Reader",
                tool="profile",
                input={"literal": {}},
                output_schema="schemas/travel.profile.view.schema.json",
                writes={"/profile": {"from": "result", "path": ""}},
            ),
            node(
                "identity",
                "tool",
                "Reader",
                tool="identity",
                input={"literal": {}},
                output_schema="schemas/identity.schema.json",
                writes={"/identity": {"from": "result", "path": ""}},
            ),
            node(
                "notes-read",
                "tool",
                "Reader",
                tool="notes-read",
                input={"literal": {}},
                output_schema="schemas/agent-read.output.schema.json",
                writes={"/notes": {"from": "result", "path": ""}},
            ),
            node(
                "remember",
                "llm",
                "Rememberer",
                task="remember",
                input={
                    "object": {
                        "request": state("/request/request"),
                        "profile": state("/profile/fields"),
                        "notes": state("/notes/body"),
                    }
                },
                output_schema="schemas/remember.schema.json",
                max_output_tokens=4000,
                depends_on=["profile", "identity", "notes-read"],
                writes={"/remember": {"from": "result", "path": ""}},
            ),
            node(
                "notes-write",
                "tool",
                "Reader",
                tool="notes-write",
                input={"object": {"body": state("/remember/notes")}},
                output_schema="schemas/agent-write.output.schema.json",
                depends_on=["remember"],
                writes={"/written": {"from": "result", "path": ""}},
            ),
            node(
                "echo",
                "tool",
                "Reader",
                tool="echo",
                input={"object": {"to": state("/identity/contact_email")}},
                output_schema="schemas/any.schema.json",
                depends_on=["identity"],
                writes={"/echoed": {"from": "result", "path": ""}},
            ),
            node(
                "assemble",
                "validate",
                "Coordinator",
                input={
                    "object": {
                        "memory_proposals": {
                            "object": {
                                "schema": {"literal": "memory.v0 proposals"},
                                "proposals": state("/remember/proposals"),
                            }
                        },
                        "staged": state("/written/staged"),
                    }
                },
                output_schema="schemas/any.schema.json",
                depends_on=["notes-write", "echo"],
                writes={"/result": {"from": "result", "path": ""}},
            ),
            node(
                "output",
                "output",
                "Coordinator",
                input=state("/result"),
                output_schema="schemas/any.schema.json",
                depends_on=["assemble"],
            ),
        ],
        "exports": [
            {
                "path": "proposals.json",
                "format": "memory.proposal",
                "value": {"from": "result", "path": "/memory_proposals"},
            }
        ],
        "extensions": {},
    }


def fixture() -> dict:
    notes = NOTES
    return {
        "profile": "workflow.fixture.v0",
        "input": REQUEST,
        "models": {
            "remember": [
                {
                    "input": remember_input(),
                    "output": {"proposals": proposals(), "notes": notes},
                }
            ]
        },
        "tools": {
            "profile": [{"input": {}, "output": profile_view()}],
            "identity": [{"input": {}, "output": identity_answer()}],
            "notes-read": [{"input": {}, "output": {"body": "", "updated": None}}],
            "notes-write": [
                {
                    "input": {"body": notes},
                    "output": {"staged": True, "bytes": len(notes.encode("utf-8"))},
                }
            ],
            "echo": [{"input": {"to": EMAIL}, "output": {"ok": True}}],
        },
    }


def write_probe(root: Path, change=None) -> Path:
    """Write the probe package's source into `root`; `change(files)` may edit the dict of
    relative path -> JSON value (or text) first."""
    view_schema = json.loads(
        (EXAMPLE / "schemas" / "host" / "travel.profile.view.schema.json").read_text()
    )
    identity_schema = json.loads(
        (EXAMPLE / "schemas" / "host" / "personal.passenger_identity.schema.json").read_text()
    )
    files: dict[str, object] = {
        "MANIFEST.agent": manifest(),
        "policy/policy.json": policy(),
        "graph.json": graph(),
        "fixtures/workflow.json": fixture(),
        "skills/probe/SKILL.md": "# Probe\nPropose what to remember; write short notes.\n",
        "schemas/input.schema.json": {
            "type": "object",
            "properties": {"request": {"type": "string"}},
            "required": ["request"],
            "additionalProperties": False,
        },
        "schemas/state.schema.json": {
            "type": "object",
            "properties": {
                key: {}
                for key in (
                    "request",
                    "profile",
                    "identity",
                    "notes",
                    "remember",
                    "written",
                    "echoed",
                    "result",
                )
            },
        },
        "schemas/any.schema.json": {"type": "object"},
        "schemas/remember.schema.json": {
            "type": "object",
            "properties": {"proposals": {"type": "array"}, "notes": {"type": "string"}},
            "required": ["proposals", "notes"],
        },
        "schemas/empty-input.schema.json": json.loads(
            (CONTRACTS / "memory-empty-input.schema.json").read_text()
        ),
        "schemas/travel.profile.view.schema.json": view_schema,
        "schemas/identity.schema.json": identity_schema,
        "schemas/agent-read.output.schema.json": json.loads(
            (CONTRACTS / "memory-agent-read.output.schema.json").read_text()
        ),
        "schemas/agent-write.input.schema.json": json.loads(
            (CONTRACTS / "memory-agent-write.input.schema.json").read_text()
        ),
        "schemas/agent-write.output.schema.json": json.loads(
            (CONTRACTS / "memory-agent-write.output.schema.json").read_text()
        ),
        "schemas/echo.input.schema.json": {
            "type": "object",
            "properties": {"to": {"type": "string"}},
            "required": ["to"],
            "additionalProperties": False,
        },
        "tools/profile.tool.json": tool(
            "profile",
            "host.memory.travel.profile",
            "empty-input",
            "travel.profile.view",
            ["memory.profile"],
        ),
        "tools/identity.tool.json": tool(
            "identity",
            "host.resource.personal.passenger_identity",
            "empty-input",
            "identity",
            ["identity.read"],
        ),
        "tools/notes-read.tool.json": tool(
            "notes-read",
            "host.memory.agent.read",
            "empty-input",
            "agent-read.output",
            ["memory.agent"],
        ),
        "tools/notes-write.tool.json": tool(
            "notes-write",
            "host.memory.agent.write",
            "agent-write.input",
            "agent-write.output",
            ["memory.agent"],
            side_effects="write",
        ),
        "tools/echo.tool.json": tool(
            "echo", "host.probe.echo", "echo.input", "any", ["identity.read"]
        ),
    }
    files = copy.deepcopy(files)
    if change is not None:
        change(files)
    for relative, value in files.items():
        path = root / relative
        if isinstance(value, str):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
        else:
            _json(path, value)
    return root


def grants(**overrides) -> dict:
    value = {
        "model.reasoning": "session",
        "memory.session": "session",
        "memory.profile": "session",
        "identity.read": "session",
        "memory.remember": "session",
        "memory.agent": "session",
    }
    value.update(overrides)
    return value


TOOLS = ["profile", "identity", "notes-read", "notes-write", "echo"]
