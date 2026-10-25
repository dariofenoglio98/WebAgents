"""network.v0 enforcement cases (examples/network/cases/cases.json): every case ends at the stage
with the code the list expects, on the reference runtime. The same list is the catalog v2's
delegation family and the conformance suite's input (T26, T27)."""

import asyncio
import json

import pytest
from network_probe import CASES, VARIANTS, grants, write_probe

from agentpkg.errors import ValidationError
from agentpkg.execution.errors import ExecutionError
from agentpkg.execution.policy import HostExecutionLimits, check_capabilities, normalize_grants
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import load_package
from agentpkg.workflow import run_workflow

CASE_LIST = json.loads((CASES / "cases.json").read_text())


def _build(tmp_path, case):
    mutate = VARIANTS[case["variant"]] if case.get("variant") else None
    return write_probe(tmp_path / "probe", mutate=mutate)


def run_fixture(package):
    """The fixture walk under the probe's grants; the report and the exception, if any."""
    router, handlers, input_value = fixture_adapters(package)
    try:
        report = asyncio.run(
            run_workflow(
                package,
                input_value,
                grants=grants(),
                handlers=handlers,
                router=router,
                approved_tools=["lookup"],
            )
        )
        return report, None
    except Exception as exc:  # noqa: BLE001 - a classified failure carries its report
        report = getattr(exc, "execution_report", None)
        assert report is not None, exc
        return report, exc


def _events(audit, action):
    return [e for e in audit if e["action"] == action]


@pytest.mark.parametrize("case", CASE_LIST["cases"], ids=lambda c: c["id"])
def test_enforcement_case(case, tmp_path):
    source = _build(tmp_path, case)
    stage = case["stage"]
    if stage == "validation":
        with pytest.raises(ValidationError, match=f"^{case['code']}: "):
            load_package(source)
        return
    package = load_package(source)
    if stage == "grants":
        with pytest.raises(ExecutionError) as caught:
            normalize_grants(package, grants(**case["grants"]))
        assert caught.value.code == case["code"]
        return
    if stage == "host":
        bindings = [{"tool_id": tool_id} for tool_id in package.tools]
        with pytest.raises(ExecutionError) as caught:
            check_capabilities(package, HostExecutionLimits(), tool_bindings=bindings)
        assert caught.value.code == case["code"]
        if case.get("expect", {}).get("node"):
            assert caught.value.detail["node"] == case["expect"]["node"]
        return
    report, exc = run_fixture(package)
    audit = report["audit"]
    expect = case.get("expect", {})
    if case["code"] == "completed":
        assert exc is None and report["status"] == "completed"
        assert _events(audit, "network.completed")
        assert not _events(audit, "network.failed")
    else:
        assert exc is not None and report["status"] == "failed"
        assert report["error_code"] == case["code"]
        failed = [e for e in _events(audit, "node.failed") if e.get("node_id") == expect["node"]]
        assert failed and failed[0]["error_code"] == case["code"], failed
        if expect.get("refused_before_start"):
            refused = _events(audit, "network.refused")
            assert refused and refused[0]["reason"] == case["reason"]
            assert not _events(audit, "network.started")
            assert not _events(audit, "network.activated")
        else:
            assert _events(audit, "network.failed")
            assert _events(audit, "network.failed")[0]["error_code"] == case["code"]
    if "reason" in case and not expect.get("refused_before_start"):
        decided = [e for e in _events(audit, "route.decided") if e["allowed"] is False]
        assert len(decided) == 1 and decided[0]["reason"] == case["reason"], decided
        assert decided[0]["chosen_by"] == expect["chosen_by"]
        if expect["chosen_by"] == "model":
            # A refused chosen route is a non-conforming answer: charged, audited as a model
            # failure that names the route check, and nothing dispatched after it.
            failed_calls = _events(audit, "model.failed")
            assert failed_calls and failed_calls[-1]["reason"] == "model_output_not_conforming"
            assert failed_calls[-1]["failed_check"] == {
                "check": "route",
                "failure": case["reason"],
                "next": decided[0]["next"],
            }
            step = [e for e in _events(audit, "node.failed") if e.get("node_id") == expect["route"]]
            assert step == [] or step[0]["error_code"] == case["code"]
    if "route_decided" in expect:
        assert len(_events(audit, "route.decided")) == expect["route_decided"]
    if "step" in expect:
        step = [e for e in _events(audit, "node.failed") if e.get("node_id") == expect["step"]]
        assert step and step[0]["error_code"] == case["code"]
    if "refused" in expect:
        refused = _events(audit, "model.refused")
        assert refused and refused[0]["reason"] == expect["refused"]
    if "activations" in expect:
        activated = _events(audit, "network.activated")
        counts = {}
        for event in activated:
            counts[event["role"]] = counts.get(event["role"], 0) + 1
        assert counts == expect["activations"]
    if "hops" in expect:
        assert _events(audit, "network.completed")[0]["hops"] == expect["hops"]
    tool_calls = len(_events(audit, "tool.called"))
    if expect.get("tool_called") is False:
        assert tool_calls == 0
    if "tool_calls" in expect:
        assert tool_calls == expect["tool_calls"]
    if "model_calls" in expect:
        assert len(_events(audit, "model.completed")) == expect["model_calls"]
    if "committed" in expect:
        assert len(_events(audit, "network.state.committed")) == expect["committed"]
