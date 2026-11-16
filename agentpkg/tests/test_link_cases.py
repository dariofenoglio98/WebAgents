"""link.v0 enforcement cases (examples/link/cases/cases.json): every case ends at the stage with
the code the list expects, on the reference runtime. The same list is the conformance suite's
input for both runtimes (T66)."""

import asyncio
import json

import pytest
from link_probe import CASES, VARIANTS, scenario, write

from agentpkg.delegation.analysis import worst_case
from agentpkg.errors import ValidationError
from agentpkg.execution.errors import ExecutionError
from agentpkg.fixtures import fixture_adapters
from agentpkg.links.host import check_once
from agentpkg.links.operator import operator_links
from agentpkg.links.resolve import LinkRefusal
from agentpkg.package import load_package
from agentpkg.signing import _read_key, fingerprint, keygen
from agentpkg.workflow import run_workflow

CASE_LIST = json.loads((CASES / "cases.json").read_text())


@pytest.fixture(scope="module")
def keys(tmp_path_factory):
    """One publisher key per linked package: a denial is of a key (L-13)."""
    directory = tmp_path_factory.mktemp("link-keys")
    made = {}
    for name in ("default", "index", "scribe"):
        made[name] = (directory / f"{name}.private.pem", directory / f"{name}.pub.pem")
        keygen(*made[name])
    return made


def build(tmp_path, keys, variant=None):
    return write(tmp_path / "probe", scenario(variant), keys)


def link_host(built, package, router=None):
    """The run's links as the operator's decisions bind them, each linked package on its own
    fixture replay."""
    return operator_links(
        package,
        archives=built.archives,
        decisions=built.decisions,
        trusted={fingerprint(_read_key(key)) for key in built.public_keys},
        router=router,
        adapters=lambda linked: fixture_adapters(linked)[:2],
    )


def run_fixture(built):
    """The caller's fixture walk with its links; the report and the exception, if any."""
    package = load_package(built.caller)
    router, handlers, input_value = fixture_adapters(package)
    links = link_host(built, package, router)
    try:
        report = asyncio.run(
            run_workflow(
                package,
                input_value,
                grants=built.grants,
                handlers=handlers,
                router=router,
                approved_tools=[],
                links=links,
                **({"limits": built.limits} if built.limits else {}),
            )
        )
        return package, links, report, None
    except Exception as exc:  # noqa: BLE001 - a classified failure carries its report
        report = getattr(exc, "execution_report", None)
        assert report is not None, exc
        return package, links, report, exc


def events(report, action):
    return [event for event in report["audit"] if event["action"] == action]


def test_the_list_names_every_variant_once():
    ids = [case["id"] for case in CASE_LIST["cases"]]
    assert len(ids) == len(set(ids))
    assert {case["variant"] for case in CASE_LIST["cases"]} <= set(VARIANTS)
    assert CASE_LIST["family"] == "link"


@pytest.mark.parametrize(
    "case", [c for c in CASE_LIST["cases"] if c["stage"] == "validation"], ids=lambda c: c["id"]
)
def test_refused_at_validation(case, tmp_path, keys):
    built = build(tmp_path, keys, case["variant"])
    with pytest.raises(ValidationError, match=f"^{case['code']}: "):
        load_package(built.caller)


@pytest.mark.parametrize(
    "case", [c for c in CASE_LIST["cases"] if c["stage"] == "prepare"], ids=lambda c: c["id"]
)
def test_refused_at_preparation(case, tmp_path, keys):
    built = build(tmp_path, keys, case["variant"])
    package = load_package(built.caller)
    router, _, _ = fixture_adapters(package)
    with pytest.raises(LinkRefusal, match=f"^{case['code']}: ") as refusal:
        link_host(built, package, router)
    assert refusal.value.code == case["code"]


@pytest.mark.parametrize(
    "case", [c for c in CASE_LIST["cases"] if c["stage"] == "grants"], ids=lambda c: c["id"]
)
def test_refused_at_the_grant_check(case, tmp_path, keys):
    built = build(tmp_path, keys, case["variant"])
    package = load_package(built.caller)
    links = link_host(built, package, fixture_adapters(package)[0])
    with pytest.raises(ExecutionError) as refusal:
        check_once(package, links.bindings)
    assert refusal.value.code == case["code"]


@pytest.mark.parametrize(
    "case", [c for c in CASE_LIST["cases"] if c["stage"] == "run"], ids=lambda c: c["id"]
)
def test_run_cases(case, tmp_path, keys):
    built = build(tmp_path, keys, case["variant"])
    package, links, report, error = run_fixture(built)
    expect = case.get("expect", {})
    started = events(report, "link.started")
    completed = events(report, "link.completed")
    failed = events(report, "link.failed")
    if case["code"] == "completed":
        assert error is None and report["status"] == "completed", (error, report.get("error_code"))
        assert not failed
    else:
        assert report["status"] == "failed"
        assert report["error_code"] == case["code"]
        node = [e for e in events(report, "node.failed") if e["node_id"] == expect["node"]]
        assert node and node[0]["error_code"] == case["code"]
    if "step" in expect:
        step = [e for e in events(report, "node.failed") if e["node_id"] == expect["step"]]
        assert step and step[0]["error_code"] == case["code"]
        if "failed_check" in expect:
            assert step[0]["failed_check"]["check"] == expect["failed_check"]
    if "started" in expect:
        assert sorted(e["dependency"] for e in started) == sorted(expect["started"])
    if "completed" in expect:
        assert sorted(e["dependency"] for e in completed) == sorted(expect["completed"])
    assert {e["dependency"]: e["error_code"] for e in failed} == expect.get("failed", {})
    assert len(events(report, "link.refused")) == expect.get("refused", 0)
    if "reason" in expect:
        assert events(report, "link.refused")[0]["reason"] == expect["reason"]
    assert len(events(report, "link.denied")) == expect.get("denied", 0)
    if "activations" in expect:
        counts = {}
        for event in events(report, "network.activated"):
            counts[event["role"]] = counts.get(event["role"], 0) + 1
        assert counts == expect["activations"]
    # Every inner run that started is recorded beside the caller's, under its own run id, and
    # its decision is the accepted binding's plan (L-30).
    recorded = {run["inner_run_id"]: run for run in report["links"]["runs"]}
    assert set(recorded) == {e["inner_run_id"] for e in started}
    for event in started:
        binding = links.binding(event["dependency"])
        assert binding.decision == "accepted"
        assert event["inner_plan_hash"] == binding.plan_hash
        assert report["inner_runs"][event["inner_run_id"]]["provenance"]["package_digest"] == (
            binding.link.package.digest
        )
    # No inner run of a denied publisher (L-16).
    denied = {name for name, b in links.bindings.items() if b.decision != "accepted"}
    assert not {e["dependency"] for e in started} & denied
    if "absent_target" in expect:
        for event in events(report, "route.decided"):
            assert event["next"] != expect["absent_target"]
    if "attains" in expect:
        bound = worst_case(package.graph, package.policy, links=links.worst_cases)
        usage = report["usage"]
        inner_models = sum(link["model_calls"] for link in usage["links"].values())
        own_models = len(events(report, "model.called"))
        assert own_models + inner_models == bound["model_calls"]
        assert usage["tool_calls"] == bound["tool_calls"]
        assert usage["tokens"] <= bound["tokens"]
