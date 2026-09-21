"""Invalid programs fail at package load, before any model or tool operation."""

import copy
import json
import shutil
from pathlib import Path

import pytest

from agentpkg.errors import ValidationError
from agentpkg.package import load_package

ROOT = Path(__file__).resolve().parents[2]


def edit(path, operation):
    doc = json.loads(path.read_text())
    operation(doc)
    path.write_text(json.dumps(doc))


@pytest.fixture
def source(tmp_path):
    p = tmp_path / "source"
    shutil.copytree(ROOT / "agents/meeting-agenda", p)
    return p


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda g: g.update(profile="workflow.v1"), "workflow.v0"),
        (lambda g: g["nodes"][0].update(type="python"), "llm"),
        (lambda g: g["nodes"][0].update(code="print(1)"), "Additional properties"),
        (lambda g: g["nodes"].append(copy.deepcopy(g["nodes"][0])), "duplicate id"),
        (lambda g: g["nodes"][0].update(worker="Missing"), "unknown worker"),
        (lambda g: g["nodes"][0].update(task="missing"), "undeclared model task"),
        (lambda g: g["nodes"][0].update(output_schema="schemas/missing.json"), "undeclared schema"),
        (lambda g: g["nodes"][0].update(depends_on=["missing"]), "unknown dependency"),
        (lambda g: g["nodes"][0].update(depends_on=["write"]), "cyclic"),
        (lambda g: g["nodes"][0].update(timeout_seconds=0), "minimum"),
        (lambda g: g["nodes"][0].update(max_output_tokens=-1), "minimum"),
        (lambda g: g["nodes"][0].update(retries=2), "Additional properties"),
        (lambda g: g["nodes"][1].update(max_parallel=4), "limits"),
        (lambda g: g["nodes"][1].update(max_items=-1), "minimum"),
        (lambda g: g["nodes"][1]["steps"][0].update(type="map"), "not be valid"),
        (lambda g: g["nodes"][1]["steps"][0].update(task="missing"), "undeclared model task"),
        (
            lambda g: g["nodes"][1]["steps"][0].update(input={"from": "steps", "path": "/later"}),
            "forward step",
        ),
        (
            lambda g: g["nodes"][0].update(input={"from": "state", "path": "/request/missing"}),
            "path component",
        ),
        (lambda g: g["nodes"][0].update(input={"from": "state", "path": ""}), "state_read"),
        (lambda g: g["nodes"][0].update(input={"from": "input", "path": ""}), "unavailable"),
        (
            lambda g: g["nodes"][0].update(input={"from": "state", "path": "/perspectives"}),
            "state_read",
        ),
        (lambda g: g["nodes"][0]["writes"].update({"/request": {"literal": {}}}), "state_write"),
        (lambda g: g["nodes"][0]["writes"].update({"/plan/focus": {"literal": []}}), "state_write"),
        (
            lambda g: g["nodes"][0]["writes"].update(
                {"/plan": {"from": "result", "path": "/missing"}}
            ),
            "path component",
        ),
        (lambda g: g["nodes"][-1].update(depends_on=[]), "every other node"),
        (lambda g: g["nodes"][-1].update(type="validate"), "exactly one output"),
        (
            lambda g: g["nodes"][-1].update(output_schema="schemas/plan.schema.json"),
            "output_schema",
        ),
        (lambda g: g["nodes"][0].update(tool="anything"), "not be valid"),
        (lambda g: g["workers"][1]["skills"].append("missing"), "unknown skills"),
        (lambda g: g["workers"][1]["state_read"].append("unknown"), "state view"),
        (lambda g: g["exports"][0].update(path="../escape.json"), "does not match"),
        (lambda g: g["exports"][0].update(path="audit.json"), "reserved export"),
    ],
)
def test_invalid_graphs_fail_before_execution(source, mutation, match):
    edit(source / "graph.json", mutation)
    with pytest.raises(ValidationError, match=match):
        load_package(source)


def test_unordered_state_dependency_is_rejected(source):
    def mutate(g):
        # Writer still reaches output through join, but no longer follows the planner.
        g["nodes"][1]["depends_on"] = []

    edit(source / "graph.json", mutate)
    with pytest.raises(ValidationError, match="every other node|unordered state conflict"):
        load_package(source)


@pytest.mark.parametrize(
    "file,operation,match",
    [
        ("policy/policy.json", lambda p: p["delegation"].update(max_depth=2), "max_depth"),
        (
            "policy/policy.json",
            lambda p: p["delegation"]["approved_roles"].remove("Planner"),
            "approved_roles",
        ),
        ("graph.json", lambda g: g["workers"][1]["budget"].update(tokens=999999), "worker budgets"),
        ("graph.json", lambda g: g["workers"][2].update(max_instances=4), "max_parallel_workers"),
        (
            "MANIFEST.agent",
            lambda m: m["model_requirements"]["tasks"][0].update(context_window=0),
            "minimum",
        ),
        (
            "schemas/plan.schema.json",
            lambda s: s.update(type="invalid-type"),
            "invalid JSON Schema",
        ),
        (
            "schemas/plan.schema.json",
            lambda s: s.update({"$ref": "https://example.org/schema"}),
            "offline",
        ),
        (
            "graph.json",
            lambda g: g.update(fixture="fixtures/missing.json"),
            "missing workflow fixture",
        ),
    ],
)
def test_invalid_policy_and_schema_references(source, file, operation, match):
    edit(source / file, operation)
    with pytest.raises(ValidationError, match=match):
        load_package(source)


def test_unknown_tool_and_denied_worker_binding(tmp_path):
    source = tmp_path / "source"
    shutil.copytree(ROOT / "agents/literature-review", source)

    def missing(g):
        next(n for n in g["nodes"] if n["id"] == "search")["steps"][0]["tool"] = "missing"

    edit(source / "graph.json", missing)
    with pytest.raises(ValidationError, match="unknown tool"):
        load_package(source)

    def denied(g):
        next(n for n in g["nodes"] if n["id"] == "search")["steps"][0]["tool"] = "paper-reader"

    edit(source / "graph.json", denied)
    with pytest.raises(ValidationError, match="not authorized"):
        load_package(source)


def test_tool_permission_and_domain_validation(tmp_path):
    source = tmp_path / "source"
    shutil.copytree(ROOT / "agents/literature-review", source)
    edit(source / "tools/citation-resolver.tool.json", lambda t: t["permissions"].append("unknown"))
    with pytest.raises(ValidationError, match="unknown permission"):
        load_package(source)
