"""link.v0's run-time half on the reference runtime (spec/link-v0.md sections 6 and 7): where a
slot looks, what its card says, what the request-building call holds, the caps and the denial
that lasts for the run, and the rules of the one budget-raise request. The enforcement cases
N-35…N-51 are `test_link_cases.py`'s; these are the properties behind them."""

import asyncio
import copy
import json
import time

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


# -- review 3: fixture mode never dials; a candidate's bytes never fail the caller's step; a
# -- declined key stops its planned link; the view names all that is sent; the cards' time ----


def test_fixture_mode_never_dials_for_a_join_fixture_that_records_no_web(
    tmp_path, keys, capsys, monkeypatch
):
    import agentpkg.browser.discovery as discovery
    import agentpkg.links.fetch as fetch

    built = build(tmp_path, keys, "join-accepted")
    fixture = json.loads(built.join_fixture.read_text())
    # Only the person's decisions: no page and no package was recorded.
    del fixture["pages"], fixture["packages"]
    built.join_fixture.write_text(json.dumps(fixture), encoding="utf-8")
    discover, looks = discovery.discover_website, []

    def watched(url, **options):
        # The production discovery code, on recorded mechanics only: a call without them
        # would resolve and dial the page's real host.
        network = options.get("network")
        assert network is not None and network.resolver is not None, "the real web"
        assert network.connector is not discovery.DiscoveryNetwork.connector, "the real web"
        looks.append(url)
        return discover(url, **options)

    def no_fetch(record, **options):
        raise AssertionError("fixture mode would fetch a package from the real web")

    monkeypatch.setattr(discovery, "discover_website", watched)
    monkeypatch.setattr(fetch, "fetch_dependency", no_fetch)
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    out = tmp_path / "out"
    argv = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    assert main(argv + built.argv(tmp_path) + ["--out", str(out)]) == 0, capsys.readouterr().err
    assert looks == [probe.HELPER_PAGE]
    audit = json.loads((out / "audit.json").read_text())
    # The slot looked, at an empty recorded web, and found nothing.
    (looked,) = [e for e in audit if e["action"] == "link.requested"]
    assert [(f["url"], f["kind"]) for f in looked["fetches"]] == [(probe.HELPER_PAGE, "discovery")]
    assert looked["fetches"][0]["status"] != "ok" and looked["candidate"] is None
    (decision,) = [e for e in audit if e["action"] == "link.decided"]
    assert (decision["decided_by"], decision["reason"]) == ("runtime", "not_found")


def test_a_candidate_that_is_no_workflow_package_is_refused_as_data(tmp_path, keys):
    # A shipped, signed package of another entrypoint: valid bytes, and no graph a worst case
    # can be computed from.
    legacy = base.ROOT / "dist" / "literature-review-legacy.agent.pkg"
    built = build(tmp_path, keys, "join-accepted")
    fixture = json.loads(built.join_fixture.read_text())
    fixture["packages"][probe.HELPER_ARCHIVE] = str(legacy)
    built.join_fixture.write_text(json.dumps(fixture), encoding="utf-8")
    package, links, report, error = run_fixture(built)
    assert error is None and report["status"] == "completed"
    (event,) = events(report, "link.decided")
    assert decided(report) == [(False, "runtime", "conversational")]
    assert event["candidate"]["digest"] == load_package(legacy).digest
    # No worst case is defined for it, so none is stated.
    assert event["worst_case"] is None
    assert report["links"]["joins"][0]["worst_case"] is None
    assert report["usage"]["reserved_tokens"] == 0


def slot_failures(report):
    return [e for e in events(report, "link.failed") if "slot" in e]


def test_a_package_this_host_cannot_run_is_a_failed_join_after_the_decision(tmp_path, keys):
    built = build(tmp_path, keys, "join-accepted")

    def prepare(router, links, options):
        def unrunnable(linked):
            raise KeyError("fixtures/workflow.json")

        links.joins.adapters = unrunnable

    package, links, report, error = run_fixture(built, prepare)
    assert error is None and report["status"] == "completed"
    # The person's decision is recorded, then the failure, with no inner run to name.
    (event,) = events(report, "link.decided")
    assert event["accepted"] and event["decided_by"] == "person" and event["inner_plan_hash"]
    (failure,) = slot_failures(report)
    assert (failure["inner_run_id"], failure["error_code"]) == (None, "worker_error")
    assert event["sequence"] < failure["sequence"]
    assert not [e for e in events(report, "link.started") if "slot" in e]
    # The caller's model is not asked for a request no run would take.
    assert not [e for e in events(report, "model.called") if e["node_id"] == STEP]
    (entry,) = report["links"]["joins"]
    assert (entry["joined"], entry["reason"]) == (False, "failed")
    assert report["usage"]["links"]["helper"]["runs"] == 0
    assert report["usage"]["reserved_tokens"] == 0


@pytest.mark.parametrize("stage", ["build", "run"])
def test_whatever_a_joined_packages_inner_run_raises_is_its_failure(tmp_path, keys, stage):
    built = build(tmp_path, keys, "join-accepted")

    def prepare(router, links, options):
        start = links.start

        def broken(binding, **kwargs):
            if "slot" not in binding.plan["parent"]:
                return start(binding, **kwargs)
            if stage == "build":
                raise KeyError("deadline_seconds")
            inner = start(binding, **kwargs)

            async def boom(payload):
                raise RuntimeError("the candidate's own")

            inner.run = boom
            return inner

        links.start = broken

    package, links, report, error = run_fixture(built, prepare)
    assert error is None and report["status"] == "completed"
    (failure,) = slot_failures(report)
    assert failure["error_code"] == "worker_error"
    assert (failure["inner_run_id"] is None) == (stage == "build")
    assert [j["reason"] for j in report["links"]["joins"]] == ["failed"]
    assert report["usage"]["reserved_tokens"] == 0


def test_a_planned_links_fault_still_surfaces(tmp_path, keys):
    # The other side of the rule: a planned link's package was pinned and checked at
    # preparation, so what is not a classified error there is this runtime's fault.
    built = build(tmp_path, keys)

    def prepare(router, links, options):
        def broken(binding, **kwargs):
            raise KeyError("deadline_seconds")

        links.start = broken

    package, links, report, error = run_fixture(built, prepare)
    assert report["status"] == "failed" and report["error_code"] == "worker_error"
    assert not events(report, "link.failed")


def test_a_key_declined_on_a_card_stops_its_planned_link(tmp_path, keys):
    built = build(tmp_path, keys, "declined-key-planned-link")
    package, links, report, error = run_fixture(built)
    assert report["status"] == "failed" and report["error_code"] == "permission_denied"
    (card,) = events(report, "link.decided")
    (denied,) = events(report, "link.denied")
    assert (card["reason"], denied["dependency"]) == ("declined", "index")
    assert card["candidate"]["signer"] == links.binding("index").link.signer
    assert card["sequence"] < denied["sequence"]
    # The review's decision on `index` stands in the record; the denial is the card's.
    assert links.binding("index").decision == "accepted"
    assert not [e for e in events(report, "link.started") if e.get("dependency") == "index"]


def test_a_slots_input_is_an_object_constructor(tmp_path, keys):
    # The card's view is the fields of the slot's input (L-34): every constructor that is not
    # an object of named fields is refused, whatever it would yield.
    for constructor in (
        probe.message(),
        probe.message("/text"),
        {"literal": {"query": "x"}},
        {"coalesce": [{"object": {"query": probe.message("/text")}}]},
    ):
        made = probe.scenario()
        probe.add_slot(made, input=constructor)
        built = probe.write(tmp_path / f"probe-{len(list(tmp_path.iterdir()))}", made, keys)
        with pytest.raises(ValidationError, match="^link_slot_input: "):
            load_package(built.caller)


def test_a_joined_packages_run_ends_before_its_steps_time_as_its_own_failure(
    tmp_path, keys, monkeypatch
):
    import agentpkg.runtime as runtime

    built = build(tmp_path, keys, "join-accepted")
    # The slot's step has 20 seconds: leave the card and the inner run half a second of them.
    monkeypatch.setattr(runtime, "CARD_MARGIN_SECONDS", 19.5)
    handed = []

    def prepare(router, links, options):
        start = links.start

        def slow(binding, **kwargs):
            inner = start(binding, **kwargs)
            if "slot" in binding.plan["parent"]:
                handed.append(kwargs["deadline_seconds"])

                async def never(payload):
                    await asyncio.sleep(60)

                inner.run = never
            return inner

        links.start = slow

    began = time.monotonic()
    package, links, report, error = run_fixture(built, prepare)
    # The step did not time out: the inner run was ended first, and that is data.
    assert error is None and report["status"] == "completed"
    assert time.monotonic() - began < 10
    # The deadline the inner run reports is the step's declared one, not a clock's reading.
    assert handed == [20]
    (failure,) = slot_failures(report)
    assert failure["error_code"] == "cancelled" and failure["inner_run_id"]
    assert [j["reason"] for j in report["links"]["joins"]] == ["failed"]
    assert not [e for e in events(report, "node.failed") if e["node_id"] == STEP]
    assert report["usage"]["reserved_tokens"] == 0


def test_an_unanswered_raise_card_ends_before_its_nodes_time(tmp_path, monkeypatch):
    import agentpkg.runtime as runtime

    run = plain(tmp_path)
    reserved = events(run(), "model.called")[0]["reserved_tokens"]
    # The node has 20 seconds, far less than the card's own 120: leave the card 0.3 of them.
    monkeypatch.setattr(runtime, "CARD_MARGIN_SECONDS", 19.7)

    class Silent:
        asked = []

        async def ask(self, request):
            self.asked.append(request)
            await asyncio.sleep(3600)

    report = run(limits={"hard_tokens": reserved - 10}, consent=Silent(), plan_hash="ab" * 32)
    # The refusal of before (L-43), not the node's own timeout.
    assert report["status"] == "failed" and report["error_code"] == "budget_exhausted"
    (request,) = Silent.asked
    assert 0 < request.timeout_seconds <= 0.3
    assert len(events(report, "budget.requested")) == 1 and not events(report, "budget.raised")


def test_a_model_call_computes_nothing_for_a_raise_nobody_can_be_asked(tmp_path, monkeypatch):
    from agentpkg.runtime import Runtime

    calls = []
    asked = Runtime._ask_raise

    async def counting(self, *args, **kwargs):
        calls.append(args)
        return await asked(self, *args, **kwargs)

    monkeypatch.setattr(Runtime, "_ask_raise", counting)
    run = plain(tmp_path)
    assert run()["status"] == "completed" and calls == []
    # With a person there, the one check of the call that needs it.
    assert run(consent=FixtureConsent(), plan_hash="ab" * 32)["status"] == "completed"
    assert len(calls) == 1
