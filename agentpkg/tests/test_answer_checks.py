"""Answer checks (workflow.v0, agentpkg 0.3.0, D-150): bounded assertions on a model's own answer.

An `llm` node or map `llm` step may declare `checks`, the existing equal/sum/relation vocabulary
evaluated on its schema-valid answer, named `{"from": "result"}`. A refused check is a
non-conforming answer: the call fails `model_output_not_conforming`, the node `model_error`,
and the audit names the check by the package's own index, kind and pointers, never by data.
This runtime asks no model twice (D-154); the Chrome runtime re-asks within the same bounds.
"""

import asyncio
import json
import shutil
from pathlib import Path

import pytest

import agentpkg
from agentpkg.errors import AgentPkgError, ValidationError
from agentpkg.fixtures import fixture_adapters
from agentpkg.hostbridge.errors import BridgeError
from agentpkg.hostbridge.router import render, token_upper_bound
from agentpkg.package import build_package, load_package
from agentpkg.validation import validate_document
from agentpkg.workflow import WorkflowError, run_workflow
from agentpkg.workflow_assertions import AnswerCheckFailure, check_answer

ROOT = Path(__file__).resolve().parents[2]

#: Every agenda owner is one of the meeting's participants (a relation on the answer).
OWNER_CHECK = {
    "kind": "relation",
    "rows": {"from": "result", "path": "/agenda"},
    "targets": {"from": "state", "path": "/request/participants"},
    "row_key": "/owner",
    "target_key": "/name",
}
#: The agenda's minutes add up to the meeting's duration (a sum on the answer).
MINUTES_CHECK = {
    "kind": "sum",
    "rows": {"from": "result", "path": "/agenda"},
    "path": "/minutes",
    "equals": {"from": "state", "path": "/request/duration"},
}
#: No focus point twice (the answer related to itself: duplicate keys fail).
UNIQUE_FOCUS = {
    "kind": "relation",
    "rows": {"from": "result", "path": "/focus"},
    "targets": {"from": "result", "path": "/focus"},
    "row_key": "",
    "target_key": "",
}
#: A perspective speaks for the participant it was asked about (an equality in a map step).
ROLE_CHECK = {
    "kind": "equal",
    "left": {"from": "result", "path": "/0/role"},
    "right": {"from": "item", "path": "/role"},
}


def _edit(path, change):
    value = json.loads(path.read_text())
    change(value)
    path.write_text(json.dumps(value, indent=2) + "\n")


def agenda(tmp_path, *, minimum="0.3.0", graph=None, fixture=None, checks=True):
    """Meeting Agenda with answer checks of all three kinds, on a node and on a map step."""
    path = tmp_path / "agenda"
    shutil.copytree(
        ROOT / "agents/meeting-agenda", path, ignore=shutil.ignore_patterns(".DS_Store")
    )
    _edit(path / "MANIFEST.agent", lambda m: m["runtime"].update(minimum_version=minimum))

    def add(g):
        nodes = {n["id"]: n for n in g["nodes"]}
        if checks:
            nodes["plan"]["checks"] = [UNIQUE_FOCUS]
            nodes["perspectives"]["steps"][0]["checks"] = [ROLE_CHECK]
            nodes["write"]["checks"] = [OWNER_CHECK, MINUTES_CHECK]
        if graph:
            graph(nodes)

    _edit(path / "graph.json", add)
    if fixture:
        _edit(path / "fixtures/workflow.json", fixture)
    return path


def execute(package):
    router, handlers, value = fixture_adapters(package)
    return asyncio.run(
        run_workflow(
            package,
            value,
            router=router,
            handlers=handlers,
            grants={p["id"]: "session" for p in package.policy["permissions"]},
            approved_tools=sorted(package.tools),
        )
    )


def failure(package):
    with pytest.raises(WorkflowError) as caught:
        execute(package)
    return caught.value, caught.value.execution_report["audit"]


def test_checks_that_hold_change_nothing_but_the_runtime_minimum(tmp_path):
    with_checks = execute(load_package(agenda(tmp_path / "a")))
    without = execute(load_package(agenda(tmp_path / "b", checks=False, minimum="0.2.2")))
    assert with_checks["status"] == "completed"
    assert with_checks["output"] == without["output"]
    assert with_checks["usage"]["tokens"] == without["usage"]["tokens"]
    actions = [e["action"] for e in with_checks["audit"]]
    assert "model.failed" not in actions
    assert actions.count("model.completed") == 5


def _owner_dana(fixture):
    fixture["models"]["write"][0]["output"]["agenda"][1]["owner"] = "Dana"


def _minutes_off(fixture):
    fixture["models"]["write"][0]["output"]["agenda"][0]["minutes"] = 6


def _focus_twice(fixture):
    focus = fixture["models"]["plan"][0]["output"]["focus"]
    focus[2] = focus[0]


def _role_wrong(fixture):
    fixture["models"]["perspective"][2]["output"][0]["role"] = "Sales"


@pytest.mark.parametrize(
    ("change", "task", "node", "failed_check", "secret"),
    [
        (
            _owner_dana,
            "write",
            "write",
            {
                "check": "answer_check",
                "index": 0,
                "kind": "relation",
                "failure": "missing_target_key",
                "row_key": "/owner",
                "target_key": "/name",
            },
            "Dana",
        ),
        (
            _minutes_off,
            "write",
            "write",
            {
                "check": "answer_check",
                "index": 1,
                "kind": "sum",
                "failure": "sum_differs",
                "path": "/minutes",
            },
            None,
        ),
        (
            _focus_twice,
            "plan",
            "plan",
            {
                "check": "answer_check",
                "index": 0,
                "kind": "relation",
                "failure": "duplicate_target_key",
                "target_key": "",
            },
            None,
        ),
        (
            _role_wrong,
            "perspective",
            "perspectives",
            {
                "check": "answer_check",
                "index": 0,
                "kind": "equal",
                "failure": "values_differ",
            },
            "Sales",
        ),
    ],
)
def test_a_refused_check_fails_the_call_as_a_non_conforming_answer(
    tmp_path, change, task, node, failed_check, secret
):
    error, audit = failure(load_package(agenda(tmp_path / "checked", fixture=change)))
    assert (error.code, error.node_id) == ("model_error", node)
    failed = [e for e in audit if e["action"] == "model.failed"]
    assert len(failed) == 1
    event = failed[0]
    assert event["task"] == task
    assert event["error"] == "AnswerCheckFailure"
    assert event["reason"] == "model_output_not_conforming"
    assert event["failure_facts"] == {"output_failure": "check"}
    assert event["failed_check"] == failed_check
    # The answer was complete and reported: it is charged what the router reported (the
    # synthetic count of its request and of the refused answer), not the reservation.
    called = [e for e in audit if e["action"] == "model.called" and e["worker"] == event["worker"]]
    reserved = called[-1]["reserved_tokens"]
    package = load_package(agenda(tmp_path / "again", fixture=change))
    cases = package.json("fixtures/workflow.json")["models"][task]
    answers = [case["output"] for case in cases]
    out = {
        (len(json.dumps(a, ensure_ascii=False, sort_keys=True).encode()) + 3) // 4 for a in answers
    }
    assert event["tokens_charged"] in {reserved - 12000 + o for o in out}
    assert event["tokens_charged"] < reserved
    # node.failed names the check too: the node, and for a map step the step and the map.
    named = [e["node_id"] for e in audit if e["action"] == "node.failed" and "failed_check" in e]
    expected = [f"{node}/one-perspective", node] if node == "perspectives" else [node]
    assert named == expected
    assert all(
        e["failed_check"] == failed_check
        for e in audit
        if e["action"] == "node.failed" and "failed_check" in e
    )
    # Pointers only: the offending value never reaches the audit.
    if secret is not None:
        assert secret not in json.dumps(audit)


def test_a_check_that_cannot_be_evaluated_on_this_answer_fails_as_not_evaluable(tmp_path):
    missing_row = {
        "kind": "equal",
        "left": {"from": "result", "path": "/agenda/9/topic"},
        "right": {"literal": "x"},
    }
    path = agenda(tmp_path, graph=lambda nodes: nodes["write"].update(checks=[missing_row]))
    error, audit = failure(load_package(path))
    assert (error.code, error.node_id) == ("model_error", "write")
    event = next(e for e in audit if e["action"] == "model.failed")
    assert event["failed_check"] == {
        "check": "answer_check",
        "index": 0,
        "kind": "equal",
        "failure": "not_evaluable",
    }


def test_check_answer_reads_the_answer_as_result_and_the_operation_scope_beside_it():
    env = {"state": {"request": {"participants": [{"name": "Ari"}], "duration": 5}}}
    answer = {"agenda": [{"owner": "Ari", "minutes": 5}]}
    check_answer([OWNER_CHECK, MINUTES_CHECK], env, answer)
    with pytest.raises(AnswerCheckFailure) as caught:
        check_answer([MINUTES_CHECK, OWNER_CHECK], env, {"agenda": [{"owner": "Bo", "minutes": 5}]})
    refused = caught.value
    assert refused.failed_check["index"] == 1
    assert refused.code == "model_output_not_conforming"
    assert refused.audit_facts == {"output_failure": "check"}
    # A non-conforming answer, not a package error: the interpreter maps it to model_error.
    assert isinstance(refused, AgentPkgError) and not isinstance(refused, ValidationError)
    assert "Bo" not in json.dumps(refused.failed_check)


@pytest.mark.parametrize(
    ("graph", "message"),
    [
        # Only llm nodes and map llm steps take answer checks.
        (
            lambda nodes: nodes["validate"].update(checks=[MINUTES_CHECK]),
            "graph.json",
        ),
        (
            lambda nodes: nodes["perspectives"].update(checks=[ROLE_CHECK]),
            "graph.json",
        ),
        # Sources and pointers are checked like any assertion's.
        (
            lambda nodes: nodes["plan"].update(
                checks=[
                    {
                        "kind": "equal",
                        "left": {"from": "input", "path": "/goal"},
                        "right": {"literal": 1},
                    }
                ]
            ),
            "source 'input' is unavailable in this scope",
        ),
        (
            lambda nodes: nodes["plan"].update(
                checks=[
                    {
                        "kind": "equal",
                        "left": {"from": "state", "path": "/plan"},
                        "right": {"literal": 1},
                    }
                ]
            ),
            "projection exceeds Planner state_read",
        ),
        (
            lambda nodes: nodes["plan"].update(
                checks=[
                    {
                        "kind": "equal",
                        "left": {"from": "result", "path": "/elsewhere"},
                        "right": {"literal": 1},
                    }
                ]
            ),
            "state/data path component 'elsewhere' not declared",
        ),
        (
            lambda nodes: nodes["perspectives"]["steps"][0].update(
                checks=[
                    {
                        "kind": "equal",
                        "left": {"from": "steps", "path": "/one-perspective"},
                        "right": {"literal": 1},
                    }
                ]
            ),
            "unknown or forward step reference",
        ),
    ],
)
def test_static_validation_refuses_checks_out_of_place_or_out_of_scope(tmp_path, graph, message):
    path = agenda(tmp_path, graph=graph)
    with pytest.raises(ValidationError, match=message):
        load_package(path)


def test_a_package_with_checks_declares_the_runtime_that_evaluates_them(tmp_path):
    with pytest.raises(
        ValidationError, match=r"answer checks require runtime\.minimum_version 0\.3\.0 or later"
    ):
        load_package(agenda(tmp_path / "old", minimum="0.2.2"))
    # Even an empty list is the 0.3.0 field.
    path = agenda(
        tmp_path / "empty",
        minimum="0.2.2",
        checks=False,
        graph=lambda nodes: nodes["plan"].update(checks=[]),
    )
    with pytest.raises(ValidationError, match="answer checks require"):
        load_package(path)


def test_an_older_runtime_refuses_a_package_with_checks_at_load(tmp_path, monkeypatch):
    artifact = build_package(agenda(tmp_path), tmp_path / "agenda-checks.agent.pkg")
    assert load_package(artifact).manifest["runtime"]["minimum_version"] == "0.3.0"
    monkeypatch.setattr(agentpkg, "__version__", "0.2.2")
    with pytest.raises(ValidationError, match="minimum_version exceeds reference runtime 0.2.2"):
        load_package(artifact)


REQUEST = {
    "task": "plan",
    "instructions": ["Plan the meeting."],
    "data": {"goal": "x"},
    "output_schema": {
        "type": "object",
        "properties": {"focus": {"type": "array"}},
        "required": ["focus"],
        "additionalProperties": False,
    },
    "requirements": {
        "id": "plan",
        "capabilities": ["structured_output"],
        "context_window": 16000,
        "preferred_tier": "reasoning",
    },
    "budget_context": {"max_output_tokens": 100},
    "audit_context": {"worker": "Planner:1", "node_id": "plan"},
}
LINE = (
    "The previous answer was not accepted: answer check 0 (relation) failed: "
    'duplicate_target_key at /paper_id for "p3". Return the complete JSON document again, '
    "corrected."
)


def test_a_re_ask_renders_its_feedback_line_as_the_last_section_and_is_counted():
    plain = render(REQUEST)
    asked = render({**REQUEST, "feedback": LINE})
    assert asked["system"] == plain["system"] + "\n\n## Correction\n" + LINE
    assert asked["user"] == plain["user"]
    added = len(("\n\n## Correction\n" + LINE).encode("utf-8"))
    assert token_upper_bound(asked) == token_upper_bound(plain) + added
    for bad in ("", 7):
        with pytest.raises(BridgeError) as caught:
            render({**REQUEST, "feedback": bad})
        assert caught.value.code == "model_request_invalid"


def test_the_request_contract_admits_one_bounded_feedback_line():
    validate_document({**REQUEST, "feedback": LINE}, "model-request", "request")
    validate_document({**REQUEST, "feedback": "x" * 1000}, "model-request", "request")
    for bad in ("", "x" * 1001, ["a"]):
        with pytest.raises(ValidationError):
            validate_document({**REQUEST, "feedback": bad}, "model-request", "request")
