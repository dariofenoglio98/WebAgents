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
from agentpkg.links.host import check_once, plan_hash
from agentpkg.links.join import JoinHost, load_join_fixture
from agentpkg.links.operator import operator_links, operator_plan
from agentpkg.links.resolve import LinkRefusal
from agentpkg.package import load_package
from agentpkg.signing import _read_key, fingerprint
from agentpkg.workflow import run_workflow

CASE_LIST = json.loads((CASES / "cases.json").read_text())


def build(tmp_path, keys, variant=None):
    return write(tmp_path / "probe", scenario(variant), keys)


def link_host(built, package, router=None, options=None):
    """The run's links as the operator's decisions bind them, each linked package on its own
    fixture replay; with a join fixture, the recorded web the run's slots look at and the
    person's recorded decisions, as `agentpkg run --join-fixture` binds them (`options` takes
    the run's `consent` and `plan_hash`)."""
    trusted = {fingerprint(_read_key(key)) for key in built.public_keys}

    def adapters(linked):
        return fixture_adapters(linked)[:2]

    joins = caller_plan = None
    if built.join_fixture is not None:
        web, consent = load_join_fixture(
            json.loads(built.join_fixture.read_text()), built.join_fixture.parent
        )
        if web is not None:
            joins = JoinHost(
                look=web.look,
                fetch=web.fetch,
                trust=lambda signer, linked: "trusted" if signer in trusted else "unknown",
                adapters=adapters,
            )
        caller_plan = operator_plan(
            package,
            grants=built.grants,
            approved_tools=[],
            limits=built.limits,
            decisions=built.decisions,
        )
        if options is not None:
            options.update(consent=consent, plan_hash=plan_hash(caller_plan), web=web)
    return operator_links(
        package,
        archives=built.archives,
        decisions=built.decisions,
        trusted=trusted,
        router=router,
        adapters=adapters,
        joins=joins,
        caller_plan=caller_plan,
    )


def run_fixture(built, prepare=None):
    """The caller's fixture walk with its links; the report and the exception, if any.
    `prepare(router, links, options)` may change what the run is handed before it starts."""
    package = load_package(built.caller)
    router, handlers, input_value = fixture_adapters(package)
    options = {}
    links = link_host(built, package, router, options)
    web = options.pop("web", None)
    if prepare is not None:
        prepare(router, links, options)
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
                **options,
                **({"limits": built.limits} if built.limits else {}),
            )
        )
        report["looked"] = list(web.requests) if web is not None else []
        return package, links, report, None
    except Exception as exc:  # noqa: BLE001 - a classified failure carries its report
        report = getattr(exc, "execution_report", None)
        assert report is not None, exc
        report["looked"] = list(web.requests) if web is not None else []
        return package, links, report, exc


def name_of(event):
    """What a link event names: a dependency, or a slot."""
    return event.get("dependency") or event["slot"]


def events(report, action):
    return [event for event in report["audit"] if event["action"] == action]


def test_the_list_names_every_variant_once():
    ids = [case["id"] for case in CASE_LIST["cases"]]
    assert len(ids) == len(set(ids))
    assert {case["variant"] for case in CASE_LIST["cases"] if case["variant"]} <= set(VARIANTS)
    assert CASE_LIST["family"] == "link"
    assert {case["stage"] for case in CASE_LIST["cases"]} <= set(CASE_LIST["stages"])
    # The host stage is the execution session's (`test_link_execution.py`).
    assert [c["id"] for c in CASE_LIST["cases"] if c["stage"] == "host"] == [
        "inner-plan-replay",
        "inner-plan-alone",
    ]


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
        assert sorted(name_of(e) for e in started) == sorted(expect["started"])
    if "completed" in expect:
        assert sorted(name_of(e) for e in completed) == sorted(expect["completed"])
    assert {name_of(e): e["error_code"] for e in failed} == expect.get("failed", {})
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
        if "slot" in event:
            # A join's inner run starts on the card's decision, recorded with its plan (L-36).
            binding = links.joined[event["inner_plan_hash"]]
            accepted = [e for e in events(report, "link.decided") if e["accepted"]]
            assert [e["inner_plan_hash"] for e in accepted] == [event["inner_plan_hash"]]
            assert accepted[0]["sequence"] < event["sequence"]
            assert binding.plan["parent"] == {
                "plan_hash": links.caller_plan_hash,
                "run_id": report["audit"][0]["run_id"],
                "slot": event["slot"],
            }
        else:
            binding = links.binding(event["dependency"])
        assert binding.decision == "accepted"
        assert event["inner_plan_hash"] == binding.plan_hash
        assert report["inner_runs"][event["inner_run_id"]]["provenance"]["package_digest"] == (
            binding.link.package.digest
        )
    # No inner run of a denied publisher (L-16).
    denied = {name for name, b in links.bindings.items() if b.decision != "accepted"}
    assert not {name_of(e) for e in started} & denied
    assert not {links.joined[e["inner_plan_hash"]].link.signer for e in started if "slot" in e} & (
        {b.link.signer for b in links.bindings.values() if b.decision != "accepted"}
    )
    # -- the run-time half (sections 6 and 7) ---------------------------------------------------
    decided = events(report, "link.decided")
    if "decided" in expect:
        assert [
            {key: e.get(key) for key in outcome} for e, outcome in zip(decided, expect["decided"])
        ] == expect["decided"]
        assert len(decided) == len(expect["decided"])
    else:
        assert not decided
    requested = events(report, "link.requested")
    assert [[f["kind"] + ":" + f["status"] for f in e["fetches"]] for e in requested] == (
        expect.get("requested", [])
    )
    # What left before any decision is exactly what the audit lists (the recorded web's log).
    assert [(r["url"], r["kind"]) for r in report["looked"]] == [
        (f["url"], f["kind"]) for e in requested for f in e["fetches"]
    ]
    # A card only for a decision the person made; a publisher denied in the run gets none.
    cards = [e for e in decided if e["decided_by"] == "person"]
    assert len(cards) == expect.get("cards", 0)
    if "request_calls" in expect:
        calls = [e for e in events(report, "model.called") if e["node_id"] == expect["slot_step"]]
        assert len(calls) == expect["request_calls"]
        for call in calls:
            # The request-building call comes after the accepted decision, never before.
            assert any(e["accepted"] and e["sequence"] < call["sequence"] for e in decided)
    if "order" in expect:
        at = [
            e["action"]
            for e in report["audit"]
            if e["action"] in set(expect["order"]) and (e["node_id"] == expect["slot_step"])
        ]
        assert at == expect["order"]
    asked, raised = events(report, "budget.requested"), events(report, "budget.raised")
    assert [len(asked), len(raised)] == expect.get("raise", [0, 0])
    for event in raised:
        assert event["plan_hash"] == links.caller_plan_hash and event["plan_hash"] is not None
        assert event["run_id"] == report["audit"][0]["run_id"]
        assert event["to"] - event["from"] <= event["from"] // 2
        assert event["to"] <= package.policy["budget"]["hard_tokens"]
    if "joins" in report["links"]:
        assert [j["reason"] for j in report["links"]["joins"]] == [
            "failed" if (e["accepted"] and name_of(e) in expect.get("failed", {})) else e["reason"]
            for e in decided
        ]
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
        if "compute_calls" in expect["attains"]:
            assert usage["compute_calls"] == bound["compute_calls"]
    # L-26: the caller's own usage holds every inner call; a link's model calls are per link.
    for figure, value in expect.get("usage", {}).items():
        assert report["usage"][figure] == value, figure
    for name, figures in expect.get("link_usage", {}).items():
        for figure, value in figures.items():
            assert report["usage"]["links"][name][figure] == value, (name, figure)
