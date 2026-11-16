"""link.v0's run-time half on the reference runtime (spec/link-v0.md sections 6 and 7): where a
slot looks, what its card says, what the request-building call holds, the caps and the denial
that lasts for the run, and the rules of the one budget-raise request. The enforcement cases
N-35…N-51 are `test_link_cases.py`'s; these are the properties behind them."""

import asyncio
import copy
import json

import link_probe as probe
import network_probe as base
import pytest
from test_link_cases import build, events, run_fixture

from agentpkg.cli import main
from agentpkg.errors import ValidationError
from agentpkg.fixtures import fixture_adapters
from agentpkg.links.analysis import package_worst_case
from agentpkg.links.join import FixtureConsent, locate_urls
from agentpkg.package import load_package
from agentpkg.signing import _read_key, fingerprint
from agentpkg.validation import validate_document
from agentpkg.workflow import run_workflow

STEP = "delegate/Lookup/ask"


def decided(report):
    return [(e["accepted"], e["decided_by"], e["reason"]) for e in events(report, "link.decided")]


# -- where a slot looks (L-7) --------------------------------------------------------------------


def test_locate_reads_its_sources_in_order_and_yields_nothing_for_what_is_missing():
    environment = {
        "input": {"url": "https://a.example/", "other": None},
        "steps": {
            "find": {"results": [{"url": "https://b.example/"}, {"url": "https://c.example/"}]}
        },
    }
    person = {"from": "input", "path": "/url"}
    first = {"from": "steps", "path": "/find/results/0/url"}
    second = {"from": "steps", "path": "/find/results/1/url"}
    assert locate_urls(person, environment) == ["https://a.example/"]
    # A coalesce yields its first member that yields any: the person's address before a search's.
    assert locate_urls({"coalesce": [person, first]}, environment) == ["https://a.example/"]
    absent = {"from": "input", "path": "/other"}
    assert locate_urls({"coalesce": [absent, first]}, environment) == ["https://b.example/"]
    assert locate_urls({"array": [first, second, first]}, environment) == [
        "https://b.example/",
        "https://c.example/",
    ]
    # Null, a missing member, an index past the list, a value that is no string: no URL.
    for reference in (
        absent,
        {"from": "input", "path": "/missing"},
        {"from": "steps", "path": "/find/results/7/url"},
        {"from": "steps", "path": "/find/results"},
    ):
        assert locate_urls(reference, environment) == []


def test_a_slot_named_as_a_dependency_is_refused(tmp_path, keys):
    made = probe.scenario()
    probe.add_slot(made, slot="index")
    built = probe.write(tmp_path / "probe", made, keys)
    with pytest.raises(ValidationError, match="^link_slot_duplicate: "):
        load_package(built.caller)


# -- the card and the request-building call (L-34, L-37) ------------------------------------------


def test_the_card_states_facts_computed_from_the_candidates_own_bytes(tmp_path, keys):
    built = build(tmp_path, keys, "join-accepted")
    asked = []

    def prepare(router, links, options):
        consent = options["consent"]
        answer = consent.ask

        async def recording(request):
            asked.append(copy.deepcopy(request))
            return await answer(request)

        consent.ask = recording

    package, links, report, error = run_fixture(built, prepare)
    assert error is None
    (request,) = asked
    assert (request.kind, request.node_id) == ("link.join", STEP)
    assert 0 < request.timeout_seconds <= 20
    facts = request.facts
    validate_document(facts, "link-join-card", "join card")
    helper = load_package(built.joinable["helper"])
    assert facts["publisher"] == {
        "signer": fingerprint(_read_key(keys["helper"][1])),
        "trust": "trusted",
    }
    assert facts["package"]["digest"] == helper.digest
    assert facts["package"]["name"] == "Helper"
    assert facts["source"] == {"page_url": probe.HELPER_PAGE, "package_url": probe.HELPER_ARCHIVE}
    assert [tool["id"] for tool in facts["requirements"]["tools"]] == ["lookup"]
    assert {p["id"] for p in facts["requirements"]["permissions"]} == set(probe.HELPER_GRANTS)
    # The view is the slot's declared input, by field; the worst case is the candidate's own,
    # inside the ceiling; the accepted "at most" does not change.
    assert facts["view"] == ["query"]
    worst = package_worst_case(helper.graph, helper.policy)
    assert facts["worst_case"] == {key: worst[key] for key in facts["worst_case"]}
    assert facts["ceiling"] == {
        "model_calls": 1,
        "tool_calls": 1,
        "compute_calls": 0,
        "remote_calls": 0,
        "tokens": 400,
        "seconds": 20,
    }
    assert facts["at_most_unchanged"] is True
    assert facts["cards"] == {"slot": {"shown": 1, "max": 1}, "run": {"shown": 1, "max": 2}}
    # What the run had left when the card was shown is what the audit says it had.
    (event,) = events(report, "link.decided")
    assert event["worst_case"] == facts["worst_case"]
    assert facts["left"]["tokens"] == 14000 - sum(
        e["tokens"] for e in events(report, "model.completed") if e["sequence"] < event["sequence"]
    ) - sum(
        e["usage"]["tokens"]
        for e in events(report, "link.completed")
        if e["sequence"] < event["sequence"]
    )


def test_the_request_building_call_holds_the_view_and_the_packages_own_words_only(tmp_path, keys):
    built = build(tmp_path, keys, "join-accepted")
    seen = []

    def prepare(router, links, options):
        complete = router.complete

        async def recording(request, *, max_output_tokens):
            seen.append(copy.deepcopy(request))
            return await complete(request, max_output_tokens=max_output_tokens)

        router.complete = recording

    package, links, report, error = run_fixture(built, prepare)
    assert error is None
    helper = load_package(built.joinable["helper"])
    (request,) = [r for r in seen if r["audit_context"]["node_id"] == STEP]
    data = request["data"]
    # Exactly the slot's view and the joined package's name, description and input schema: no
    # message, no notes, no state beyond the view (L-37).
    assert set(data) == {"view", "package"}
    assert data["view"] == {"query": "look up hello"}
    assert set(data["package"]) == {"name", "description", "input_schema"}
    assert data["package"]["name"] == helper.manifest["name"]
    assert data["package"]["description"] == helper.manifest["description"]
    assert request["output_schema"] == data["package"]["input_schema"]
    assert request["task"] == "read"
    # Nothing of the candidate reaches the caller's model in any other call (L-34).
    for other in seen:
        if other is not request:
            assert helper.manifest["description"] not in json.dumps(other)
    # And that call comes after the person's decision.
    (decision,) = events(report, "link.decided")
    (call,) = [e for e in events(report, "model.called") if e["node_id"] == STEP]
    assert decision["accepted"] and decision["sequence"] < call["sequence"]


# -- the refusals a host or a cap makes (L-33, L-35, L-39) -----------------------------------------


def test_a_host_policy_that_forbids_joins_refuses_before_any_look(tmp_path, keys):
    built = build(tmp_path, keys, "join-accepted")

    def prepare(router, links, options):
        links.joins.policy = "forbid"

    package, links, report, error = run_fixture(built, prepare)
    assert error is None
    assert decided(report) == [(False, "runtime", "policy")]
    assert not events(report, "link.requested") and report["looked"] == []


def test_a_run_shows_at_most_two_cards_in_all(tmp_path, keys):
    built = build(tmp_path, keys, "join-accepted")

    def prepare(router, links, options):
        links.cards["another-slot"] = 2

    package, links, report, error = run_fixture(built, prepare)
    assert error is None
    assert decided(report) == [(False, "runtime", "join_cap")]
    assert report["looked"] == []


def test_a_card_that_is_not_answered_is_declined(tmp_path, keys):
    built = build(tmp_path, keys, "join-accepted")

    def prepare(router, links, options):
        async def silent(request):
            raise TimeoutError

        options["consent"].ask = silent

    package, links, report, error = run_fixture(built, prepare)
    assert error is None
    (event,) = events(report, "link.decided")
    assert (event["accepted"], event["decided_by"], event["reason"], event["provenance"]) == (
        False,
        "person",
        "declined",
        "timeout",
    )
    assert not [e for e in events(report, "link.started") if "slot" in e]
    # The reservation held for the card is released.
    assert report["usage"]["reserved_tokens"] == 0


def test_an_answer_outside_the_decision_contract_is_the_hosts_failure(tmp_path, keys):
    built = build(tmp_path, keys, "join-accepted")

    def prepare(router, links, options):
        async def wrong(request):
            return {"accepted": "yes"}

        options["consent"].ask = wrong

    package, links, report, error = run_fixture(built, prepare)
    assert report["status"] == "failed" and report["error_code"] == "worker_error"
    assert not [e for e in events(report, "link.started") if "slot" in e]
    assert report["usage"]["reserved_tokens"] == 0


def test_a_key_declined_on_a_card_is_not_offered_again_in_the_run(tmp_path, keys):
    made = probe.scenario()
    probe.with_join(made, decisions=[{"accepted": False}, probe.ACCEPT], slot={"max_joins": 2})
    made.walk = list(probe.FULL_TOUR)
    built = probe.write(tmp_path / "probe", made, keys)
    package, links, report, error = run_fixture(built)
    assert error is None
    assert decided(report) == [
        (False, "person", "declined"),
        (False, "runtime", "publisher_denied"),
    ]
    assert not [e for e in events(report, "link.started") if "slot" in e]
    # The second look is recorded; the second card never is.
    assert len(events(report, "link.requested")) == 2


def test_a_package_with_a_slot_and_no_host_for_it_runs_unattended(tmp_path, keys):
    made = probe.scenario()
    probe.with_join(made)
    built = probe.write(tmp_path / "probe", made, keys)
    built.join_fixture = None
    package, links, report, error = run_fixture(built)
    assert error is None
    assert decided(report) == [(False, "runtime", "unattended")]
    assert report["links"]["joins"][0]["reason"] == "unattended"
    assert "caller_plan" not in report["links"]


# -- the budget-raise request (L-41…L-44) ---------------------------------------------------------


def test_a_raise_of_more_than_half_is_not_asked(tmp_path, keys):
    made = probe.scenario("raise-accepted")
    # `scribe` needs 1,500 tokens beside about 930 spent: above one and a half times 1,500.
    made.limits = {"hard_tokens": 1500}
    built = probe.write(tmp_path / "probe", made, keys)
    package, links, report, error = run_fixture(built)
    assert report["status"] == "failed" and report["error_code"] == "budget_exhausted"
    assert not events(report, "budget.requested") and not events(report, "budget.raised")
    (refused,) = events(report, "link.refused")
    assert refused["reason"] == "tokens"
    # What the raise would have to reach: what is spent plus the reservation.
    target = (1500 - refused["tokens_left"]) + refused["needed"]["tokens"]
    assert target > 1500 + 1500 // 2


def plain(tmp_path, **budget):
    """`scribe` as a package of its own, with no link: one model step."""
    members = probe.scribe_files()
    members["policy/policy.json"]["budget"].update(budget)
    if "hard_tokens" in budget:
        # A worker's budget is inside its package's.
        members["graph.json"]["workers"][1]["budget"]["tokens"] = budget["hard_tokens"]
    request = {"answers": [], "text": "none"}
    members["fixtures/workflow.json"] = {
        "profile": "workflow.fixture.v0",
        "input": request,
        "models": {"draft": [{"input": request, "output": {"draft": "draft:none"}}]},
        "tools": {},
    }
    package = load_package(base.write(tmp_path / "plain", members))
    router, handlers, input_value = fixture_adapters(package)
    grants = {"model.reasoning": "session", "memory.session": "session"}

    def run(**options):
        try:
            return asyncio.run(
                run_workflow(
                    package, input_value, grants=grants, handlers=handlers, router=router, **options
                )
            )
        except Exception as exc:  # noqa: BLE001 - a classified failure carries its report
            return exc.execution_report

    return run


def test_a_model_calls_reservation_may_ask_the_raise_and_names_its_run_and_plan(tmp_path):
    run = plain(tmp_path)
    reserved = events(run(), "model.called")[0]["reserved_tokens"]
    limit, plan = reserved - 10, "ab" * 32
    consent = FixtureConsent(raise_={"accepted": True})
    report = run(limits={"hard_tokens": limit}, consent=consent, plan_hash=plan)
    assert report["status"] == "completed"
    (asked,) = events(report, "budget.requested")
    (raised,) = events(report, "budget.raised")
    assert (asked["limit"], asked["from"], asked["to"], asked["needed"]) == (
        "tokens",
        limit,
        reserved,
        reserved,
    )
    assert (raised["from"], raised["to"], raised["decided_by"], raised["provenance"]) == (
        limit,
        reserved,
        "person",
        "fixture",
    )
    assert raised["plan_hash"] == plan and raised["run_id"] == report["audit"][0]["run_id"]
    assert asked["sequence"] < raised["sequence"] < events(report, "model.called")[0]["sequence"]
    assert report["usage"]["limits"]["hard_tokens"] == reserved
    # The card's facts are the runtime's figures.
    (request,) = consent.asked
    validate_document(request.facts, "budget-raise-card", "budget-raise card")
    assert request.kind == "budget.raise"
    assert request.facts["package_cap"] == 1500 and request.facts["used"] == 0
    # Declined, or nobody to ask: the refusal of before.
    for options in ({"consent": FixtureConsent(raise_={"accepted": False})}, {}):
        report = run(limits={"hard_tokens": limit}, **options)
        assert report["error_code"] == "budget_exhausted"
        assert not events(report, "budget.raised")
        assert len(events(report, "budget.requested")) == (1 if options else 0)


def test_the_packages_own_cap_is_never_raised(tmp_path):
    reserved = events(plain(tmp_path / "a")(), "model.called")[0]["reserved_tokens"]
    # The same shortfall, where the limit that refuses is the publisher's own `hard_tokens`.
    run = plain(tmp_path / "b", estimated_tokens=reserved - 10, hard_tokens=reserved - 10)
    consent = FixtureConsent(raise_={"accepted": True})
    report = run(consent=consent, plan_hash="ab" * 32)
    assert report["status"] == "failed" and report["error_code"] == "budget_exhausted"
    assert not events(report, "budget.requested") and consent.asked == []
    assert events(report, "model.refused")[0]["reason"] == "global_token_budget"


# -- the CLI: `--join-fixture` (the conformance driver's cases, as a runner passes them) ----------


@pytest.mark.parametrize("case", ["join-accepted", "join-declined", "raise-accepted"])
def test_the_cli_runs_a_case_of_the_run_time_half(tmp_path, capsys, case):
    import subprocess
    import sys

    driver = base.ROOT / "conformance" / "drivers" / "link_probe.py"
    done = subprocess.run(
        [sys.executable, str(driver), str(tmp_path / "case"), case],
        capture_output=True,
        text=True,
        check=True,
    )
    written = json.loads(done.stdout)
    assert "--join-fixture" in written["argv"]
    out = tmp_path / "out"
    argv = ["run", written["source"], "--mode", "fixture", "--grants", written["grants"]]
    assert main(argv + written["argv"] + ["--out", str(out)]) == 0, capsys.readouterr().err
    record = json.loads((out / "links.json").read_text())
    audit = json.loads((out / "audit.json").read_text())
    assert record["caller_plan"]["schema"] == "agentpkg-operator-plan-v0"
    if case == "raise-accepted":
        (raised,) = [e for e in audit if e["action"] == "budget.raised"]
        assert raised["plan_hash"] == record["caller_plan_hash"]
        assert "joins" not in record
        return
    (entry,) = record["joins"]
    assert entry["joined"] is (case == "join-accepted")
    if case == "join-accepted":
        assert entry["package"]["plan"]["parent"] == {
            "plan_hash": record["caller_plan_hash"],
            "run_id": audit[0]["run_id"],
            "slot": "helper",
        }
        (run,) = [r for r in record["runs"] if "slot" in r]
        assert (out / f"link-{run['inner_run_id']}.audit.json").is_file()
    else:
        assert entry["package"] is None and entry["reason"] == "declined"
