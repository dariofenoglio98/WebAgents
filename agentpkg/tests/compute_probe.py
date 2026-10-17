"""A small generic workflow.v0 package with compute nodes (compute.v0), written into a directory
so that each test can change one thing: the module bytes, the graph's declaration of them, the
node's limits, the permission, the schemas. Model-free by default: the fixture replays nothing,
the module runs for real, as it does in every mode.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "examples" / "compute" / "cases"
MODULES = CASES / "modules"
ANY = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
REQUEST = {"a": 1, "b": "two"}


def case_module(stem: str) -> bytes:
    return (MODULES / f"{stem}.wasm").read_bytes()


def builder():
    """The case generator, imported from its file (it is an example, not a package module)."""
    spec = importlib.util.spec_from_file_location("build_cases", CASES / "build_cases.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def compute_node(
    node_id="compute",
    *,
    module="echo",
    function="run",
    input_path="/request",
    limits=None,
    depends_on=(),
    writes=None,
    input_schema="schemas/compute-input.schema.json",
    output_schema="schemas/compute-output.schema.json",
    worker="Coordinator",
    when=None,
):
    node = {
        "id": node_id,
        "type": "compute",
        "worker": worker,
        "depends_on": list(depends_on),
        "input": {"from": "state", "path": input_path},
        "input_schema": input_schema,
        "output_schema": output_schema,
        "timeout_seconds": 30,
        "writes": {"/result": {"from": "result", "path": ""}} if writes is None else writes,
        "module": module,
        "function": function,
    }
    if limits is not None:
        node["limits"] = limits
    if when is not None:
        node.update(when)
    return node


def write_probe(
    directory: Path,
    *,
    modules=None,
    nodes=None,
    permission=True,
    permission_resources=None,
    minimum_version="0.5.0",
    input_schema=None,
    output_schema=None,
    declared=None,
    state_keys=("request", "result"),
    extra_files=None,
    fixture_input=None,
) -> Path:
    """Write the probe into `directory` and return it. `modules` maps a module id to its bytes
    (default: the echo module); `declared` overrides the graph's module list (to misdeclare a
    hash or a path); `nodes` replaces the one compute node."""
    modules = {"echo": case_module("echo")} if modules is None else modules
    directory.mkdir(parents=True, exist_ok=True)
    for module_id, data in modules.items():
        path = directory / "modules" / f"{module_id}.wasm"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    if declared is None:
        declared = [
            {
                "id": module_id,
                "path": f"modules/{module_id}.wasm",
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            for module_id, data in modules.items()
        ]
    nodes = [compute_node()] if nodes is None else copy.deepcopy(nodes)
    last = [n["id"] for n in nodes]
    nodes.append(
        {
            "id": "output",
            "type": "output",
            "worker": "Coordinator",
            "depends_on": last,
            "input": {"from": "state", "path": "/result"},
            "output_schema": "schemas/output.schema.json",
            "timeout_seconds": 10,
            "writes": {},
        }
    )
    state_properties = {key: {} for key in state_keys}
    _json(
        directory / "MANIFEST.agent",
        {
            "spec_version": "0.1",
            "package_id": "org.example.compute-probe",
            "name": "Compute Probe",
            "version": "0.1.0",
            "description": "A test package that runs WebAssembly modules under compute.v0.",
            "publisher": {"id": "example", "name": "Example"},
            "created_at": "2026-10-16T00:00:00Z",
            "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": minimum_version},
            "capabilities": [],
            "entrypoint": "workflow.v0",
            "graph": "graph.json",
            "policy": "policy/policy.json",
            "skills": [],
            "tools": [],
            "schemas": [
                {"id": name, "path": f"schemas/{name}.schema.json"}
                for name in ("input", "state", "compute-input", "compute-output", "output")
            ],
            "model_requirements": {
                "tasks": [],
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
    permissions = [
        {
            "id": "memory.session",
            "kind": "memory",
            "description": "Use isolated session state",
            "required": True,
            "resources": ["session"],
        }
    ]
    if permission:
        permissions.append(
            {
                "id": "compute.modules",
                "kind": "compute",
                "description": "Run the package's WebAssembly modules, which can only compute.",
                "required": True,
                "resources": (
                    sorted(modules) if permission_resources is None else permission_resources
                ),
            }
        )
    _json(
        directory / "policy" / "policy.json",
        {
            "spec_version": "0.1",
            "permissions": permissions,
            "network": {"allowed_domains": [], "https_only": True, "allow_redirects": False},
            "memory": {
                "scope": "session",
                "retention": "session",
                "raw_documents": False,
                "state_schema": "schemas/state.schema.json",
                "sharing": "explicit_views",
            },
            "budget": {
                "estimated_tokens": 0,
                "hard_tokens": 1000,
                "max_remote_calls": 0,
                "max_calls_per_tool": {},
                "max_parallel_workers": 2,
                "estimated_cost_usd": None,
                "approval_threshold_tokens": None,
            },
            "delegation": {"max_depth": 1, "approved_roles": ["Worker"], "allow_remote": False},
            "extensions": {},
        },
    )
    graph = {
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
                "budget": {"tokens": 1000, "remote_calls": 0},
                "state_read": list(state_keys),
                "state_write": [k for k in state_keys if k != "request"],
            },
            {
                "id": "Worker",
                "kind": "packaged",
                "skills": [],
                "tools": [],
                "max_instances": 2,
                "budget": {"tokens": 1000, "remote_calls": 0},
                "state_read": list(state_keys),
                "state_write": [k for k in state_keys if k != "request"],
            },
        ],
        "input_schema": "schemas/input.schema.json",
        "output_schema": "schemas/output.schema.json",
        "initial_state": {
            "object": {
                "request": {"from": "input", "path": ""},
                **{k: {"literal": None} for k in state_keys if k != "request"},
            }
        },
        "deadline_seconds": 120,
        "nodes": nodes,
        "fixture": "fixtures/workflow.json",
        "extensions": {},
    }
    if declared:
        graph["modules"] = declared
    _json(directory / "graph.json", graph)
    _json(directory / "schemas" / "input.schema.json", {**ANY, "type": "object"})
    _json(
        directory / "schemas" / "state.schema.json",
        {
            **ANY,
            "type": "object",
            "properties": state_properties,
            "required": list(state_keys),
            "additionalProperties": False,
        },
    )
    _json(
        directory / "schemas" / "compute-input.schema.json",
        {**ANY, "type": "object"} if input_schema is None else input_schema,
    )
    _json(
        directory / "schemas" / "compute-output.schema.json",
        {**ANY, "type": "object"} if output_schema is None else output_schema,
    )
    _json(directory / "schemas" / "output.schema.json", {**ANY})
    _json(
        directory / "fixtures" / "workflow.json",
        {
            "profile": "workflow.fixture.v0",
            "input": REQUEST if fixture_input is None else fixture_input,
            "models": {},
            "tools": {},
        },
    )
    for name, data in (extra_files or {}).items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return directory


def grants(package, **decisions):
    return {p["id"]: decisions.get(p["id"], "session") for p in package.policy["permissions"]}
