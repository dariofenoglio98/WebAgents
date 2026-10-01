"""Exact input copying and deterministic time allocation, through the real graph."""

import asyncio
import copy
from pathlib import Path

import pytest

from agentpkg.execution.report import verify_audit_chain
from agentpkg.fixtures import FixtureRouter
from agentpkg.package import load_package
from agentpkg.workflow import WorkflowError, run_workflow
from agentpkg.workflow_assertions import AssertionFailure, check_assertions

ROOT = Path(__file__).resolve().parents[2]


class DraftRouter(FixtureRouter):
    def __init__(self, package):
        super().__init__({})
        self.draft = package.json("fixtures/workflow.json")["models"]["write"][0]["output"]
        self.seen = []

    async def complete(self, request, *, max_output_tokens):
        self.seen.append(copy.deepcopy(request))
        task, data = request["task"], request["data"]
        if task == "plan":
            output = {"focus": ["Decide priorities"]}
        elif task == "perspective":
            output = [{"role": data["participant"]["role"], "priorities": [], "questions": []}]
        else:
            output = copy.deepcopy(self.draft)  # Always totals 45, even for 25/37.
        return {"output": output, "input_tokens": 10, "output_tokens": 100}


def run(duration):
    package = load_package(ROOT / "agents/meeting-agenda")
    router = DraftRouter(package)
    value = package.json("fixtures/workflow.json")["input"]
    value.update(duration=duration, goal="Decide\npriorities — exactly.  ")
    result = asyncio.run(
        run_workflow(
            package,
            value,
            router=router,
            handlers={},
            grants={p["id"]: "session" for p in package.policy["permissions"]},
        )
    )
    return package, value, router, result


@pytest.mark.parametrize("duration", [10, 25, 37, 45, 240])
def test_exact_total_input_copy_and_five_calls(duration):
    package, value, router, result = run(duration)
    assert result["status"] == "completed"
    output = result["output"]
    assert output["goal"] == value["goal"]
    assert output["duration"] == duration
    assert sum(row["minutes"] for row in output["agenda"]) == duration
    assert all(row["minutes"] >= 1 for row in output["agenda"])
    assert [{k: v for k, v in row.items() if k != "minutes"} for row in output["agenda"]] == [
        {k: v for k, v in row.items() if k != "minutes"} for row in router.draft["agenda"]
    ]
    assert len(router.seen) == 5
    assert [r["data"]["participant"] for r in router.seen if r["task"] == "perspective"] == value[
        "participants"
    ]
    assert verify_audit_chain(result["audit"])["valid"]
    assert (
        len(
            [
                e
                for e in result["audit"]
                if e["action"] == "worker.spawned" and e["role"] == "Perspective"
            ]
        )
        == 3
    )


@pytest.mark.parametrize("duration", [0, -1, 9, 241, 25.5, "25", True])
def test_invalid_input_fails_before_any_model_call(duration):
    with pytest.raises(WorkflowError) as caught:
        run(duration)
    assert caught.value.code == "schema_validation"
    assert not any(e["action"] == "model.called" for e in caught.value.execution_report["audit"])


@pytest.mark.parametrize("mutation,index", [("goal", 0), ("duration", 1), ("minutes", 2)])
def test_final_checks_still_reject_corruption(mutation, index):
    package, value, _, result = run(25)
    output = result["output"]
    if mutation == "minutes":
        output["agenda"][0]["minutes"] += 1
    elif mutation == "duration":
        output["duration"] = 37
    else:
        output["goal"] = "Paraphrased"
    rules = next(n for n in package.graph["nodes"] if n["id"] == "validate")["assertions"]
    with pytest.raises(AssertionFailure) as caught:
        check_assertions(rules, {"state": {"request": value, "agenda": output}})
    assert caught.value.failed_check["index"] == index


def test_final_checks_unchanged_from_preserved_021():
    old = load_package(ROOT / "dist/meeting-agenda-0.2.1.agent.pkg")
    new = load_package(ROOT / "agents/meeting-agenda")

    def assertions(p):
        return next(n for n in p.graph["nodes"] if n["id"] == "validate")["assertions"]

    assert assertions(old) == assertions(new)


@pytest.mark.parametrize("duration", [25, 37])
def test_invocation_serialization_preserves_entered_duration(duration):
    import json

    from agentpkg.execution.invocation import build_invocation, canonical_input
    from agentpkg.package import sha256

    value = {"duration": duration, "goal": "Decide\nnext steps"}
    transported = json.loads(json.dumps(value))
    plan = {
        "run_plan_id": "plan",
        "run_plan_sha256": "a" * 64,
        "package": {
            "package_id": "arbitrary",
            "version": "1.0.0",
            "digest": "b" * 64,
            "archive_sha256": "c" * 64,
        },
    }
    invocation = build_invocation(run_id="run", plan=plan, input_value=transported)
    assert json.loads(canonical_input(transported)) == value
    assert invocation["input_sha256"] == sha256(canonical_input(value))
    assert invocation["input_sha256"] != sha256(canonical_input(value | {"duration": 15}))
