"""The WebAir package, run by the generic WebAgents runtime against this origin.

Since 0.8.0 the package is conversational (conversation.v0): every run here is one
conversation of the package's turn graph under agentpkg's generic runner
(`agentpkg.conversation.Conversation`), each turn interpreted by `agentpkg.workflow` with a
`ModelRouter` (agentpkg's exact-input `FixtureRouter` over the package's own fixture, or a
script for the host-capability and failure cases) and one `ToolHandler` per declared WebAir
binding that calls this origin's JSON API in-process. Tool answers therefore come from
WebAirService itself, never from the fixture. The package's host-resource tools are answered
by the demo host's stand-in (`publisher/host.py`) with the fictional resources a scenario
picks, and the consent step before a purchase by the transcript's decision, as `agentpkg
converse` answers it. Nothing touches a network, a model provider or the HTTP server.

The Agent Browser's own host path (authorization, picks, plans, broker) is tested in
`openclaw-agent-browser/test/webair-capabilities.test.ts` on the 0.5.0 archive, and the
Chrome Agent Browser's conversation path in `chrome-agent-browser/test/`.
"""

import asyncio
import copy
import json
import re

import pytest
from agentpkg.conversation import Conversation
from agentpkg.execution.report import verify_audit_chain
from agentpkg.fixtures import FixtureRouter
from agentpkg.package import load_package
from agentpkg.runtime import PolicyError, Runtime
from agentpkg.workflow import WorkflowError

from origin.app import create_app
from publisher.binding import BindingError, json_http_handlers
from publisher.contract import PACKAGE_SOURCE
from publisher.fixture import (
    ScriptedRouter,
    all_grants,
    converse_package,
    run_package,
    turn_failure,
)
from publisher.host import host_resource_handlers, resource_value
from publisher.scenarios import (
    HERO_FARES,
    HERO_REQUEST,
    PURCHASE_REQUEST,
    WA101_BASIC,
    WA101_STANDARD,
    WA105_BASIC,
    WA105_STANDARD,
    WA205_731_BASIC,
    Turn,
    _plan,
    conversation_scenario,
    demo_booking,
    purchase_note,
    scenario,
    scenarios,
)

# workflow.v0, compute.v0 and conversation.v0: the node types the generic runtime implements.
CANONICAL_NODE_TYPES = {"llm", "tool", "map", "join", "validate", "output", "compute", "consent"}
HERO = {"message": HERO_REQUEST}
ALEX = resource_value("passenger_demo_alex")
VISA = resource_value("payment_demo_visa")


@pytest.fixture(scope="module")
def package():
    return load_package(PACKAGE_SOURCE)


@pytest.fixture(scope="module")
def origin_app():
    return create_app()


def fixture_router(package):
    return FixtureRouter(package.json(package.graph["fixture"])["models"])


def run(package, origin_app, input_value, *, router=None, record=None, **options):
    """One turn, as the first turn of a conversation; raises what the turn raised."""
    router = fixture_router(package) if router is None else router
    return asyncio.run(
        run_package(package, input_value, router=router, app=origin_app, record=record, **options)
    )


def failure(package, origin_app, input_value, **options):
    with pytest.raises(WorkflowError) as caught:
        run(package, origin_app, input_value, **options)
    return caught.value


def converse(package, origin_app, turns, *, routers, record=None, **options):
    """A whole conversation: its report and every turn's report."""
    return asyncio.run(
        converse_package(package, turns, routers=routers, app=origin_app, record=record, **options)
    )


def routers_for(case, *, remember=None, replace=None):
    """The scenario's scripted routers, one per turn, with the `remember` step's answer and
    any other task's answers replaced where a turn runs them."""
    routers = []
    for turn in case.turns:
        script = copy.deepcopy(turn.models)
        if remember is not None and "remember" in script:
            script["remember"] = [remember]
        for task, output in (replace or {}).items():
            if task in script:
                script[task] = [output]
        routers.append(ScriptedRouter(script))
    return routers


def capability(
    package,
    origin_app,
    case_id,
    *,
    grants=None,
    selections=None,
    turns=None,
    handlers=None,
    routers=None,
    **options,
):
    """A host-capability conversation: its grants and picks, the demo host's resources, the
    transcript's consent decisions. Returns the conversation's report and the turns' reports;
    a turn that did not complete raises what it raised, after the turns before it."""
    case = conversation_scenario(case_id)
    picked = case.selections if selections is None else selections
    if handlers is None:
        handlers = json_http_handlers(package, origin_app, record=options.pop("record", None))
    handlers = {**handlers, **host_resource_handlers(package, picked)}
    result, reports = converse(
        package,
        origin_app,
        case.turns if turns is None else turns,
        routers=routers_for(case, remember=options.pop("remember", None))
        if routers is None
        else routers,
        handlers=handlers,
        grants=case.decisions if grants is None else grants,
        **options,
    )
    for report in reports:
        if report["status"] != "completed":
            raise turn_failure(report)
    return result, reports


def capability_failure(package, origin_app, case_id, **options):
    with pytest.raises(WorkflowError) as caught:
        capability(package, origin_app, case_id, **options)
    return caught.value


def events(report, action):
    return [event for event in report["audit"] if event["action"] == action]


def tools_called(report):
    return [event["tool"] for event in events(report, "tool.called")]


def model_tasks(report):
    return [event["task"] for event in events(report, "model.called")]


# --- the hero message ------------------------------------------------------------------------


def test_hero_search_returns_webair_fares_under_900(package, origin_app):
    calls = []
    report = run(package, origin_app, HERO, record=calls)
    assert report["status"] == "completed"
    result = report["output"]
    assert (result["status"], result["intent"]) == ("options_found", "search")
    assert result["interpreted_request"]["search"] == {
        "origin": "BOS",
        "destination": "ZRH",
        "date": "2026-10-09",
        "passengers": 1,
        "nonstop_only": True,
        "max_price_usd": 900,
        "cabin": None,
    }
    flights = result["evidence"]["search"]["flights"]
    offered = {fare["fare_id"]: fare for flight in flights for fare in flight["fares"]}
    assert {fare_id: fare["price_usd"] for fare_id, fare in offered.items()} == {
        WA101_BASIC: 704,
        WA101_STANDARD: 858,
        WA105_BASIC: 749,
    }
    assert all(flight["stops"] == 0 for flight in flights)
    assert {fare_id: fare["checked_bags"] for fare_id, fare in offered.items()} == {
        WA101_BASIC: 0,
        WA101_STANDARD: 1,
        WA105_BASIC: 0,
    }
    rules = {rule["fare_id"]: rule for rule in result["evidence"]["fare_rules"]}
    assert set(rules) == set(HERO_FARES)
    assert rules[WA101_STANDARD]["baggage"]["checked_bag_kg"] == 23
    assert rules[WA101_BASIC]["changes"]["allowed"] is False
    assert result["selected_fare_id"] == WA101_BASIC
    assert (result["booking"], result["purchase"]) == (None, None)
    assert result["answer"].startswith("I found three nonstop WebAir fares")
    # Every tool answer in the result is the origin's own answer to that exact call.
    assert result["evidence"]["search"] == next(
        c["output"] for c in calls if c["tool"] == "search-flights"
    )
    assert tools_called(report) == [
        "search-flights",
        "get-fare-rules",
        "get-fare-rules",
        "get-fare-rules",
    ]
    assert model_tasks(report) == ["interpret", "select", "answer"]
    # What outlives the turn: the history, the fares the person may now name, no quote.
    state = report["conversation_state"]
    assert [h["intent"] for h in state["history"]] == ["search"]
    assert state["history"][0]["search"] == result["interpreted_request"]["search"]
    assert {f["fare_id"] for f in state["known_fares"]} == set(HERO_FARES)
    assert (state["quote_ref"], state["confirmation_ref"], state["profile_used"]) == (
        None,
        None,
        False,
    )


def test_hero_audit_chain_is_intact(package, origin_app):
    """The turn's audit is a slice of the conversation's one chain (V-17): it starts after
    `conversation.started` and `turn.started`, links to them, and the whole chain verifies."""
    from agentpkg.runtime import digest

    result, reports = converse(
        package, origin_app, [scenario("hero").turns[0]], routers=fixture_router(package)
    )
    audit = result["audit"]
    previous = None
    for index, event in enumerate(audit, 1):
        body = {k: v for k, v in event.items() if k != "event_hash"}
        assert event["sequence"] == index
        assert event["previous_hash"] == previous
        assert event["event_hash"] == digest(body)
        previous = event["event_hash"]
    assert [e["action"] for e in audit[:2]] == ["conversation.started", "turn.started"]
    assert audit[-2]["action"] == "turn.completed" and audit[-1]["action"] == "conversation.ended"
    turn = reports[0]["audit"]
    assert turn[0]["sequence"] == 3 and turn[0]["previous_hash"] == audit[1]["event_hash"]
    assert turn == audit[2 : 2 + len(turn)]
    assert verify_audit_chain(audit)["valid"] is True


# --- every demo conversation, against the live service ---------------------------------------


@pytest.mark.parametrize("case", scenarios(), ids=lambda s: s.id)
def test_scenario_runs_against_the_origin(case, package, origin_app):
    result, reports = converse(
        package, origin_app, case.turns, routers=[fixture_router(package)] * len(case.turns)
    )
    assert result["status"] == "completed" and len(reports) == len(case.turns)
    for turn, report in zip(case.turns, reports, strict=True):
        output = report["output"]
        assert output["status"] == turn.expect["status"]
        assert output["intent"] == turn.expect["intent"]
        assert output["selected_fare_id"] == turn.expect["selected_fare_id"]
        assert (output["booking"], output["purchase"]) == (None, None)
        offered = {
            fare["fare_id"]
            for flight in (output["evidence"]["search"] or {}).get("flights", [])
            for fare in flight["fares"]
        }
        known = {f["fare_id"] for f in report["conversation_state"]["known_fares"]}
        assert set(output["mentioned_fare_ids"]) <= offered | known
        if output["selected_fare_id"] is not None:
            assert output["selected_fare_id"] in offered


@pytest.mark.parametrize("case", scenarios(), ids=lambda s: s.id)
def test_scripted_answers_quote_only_tool_evidence(case, package, origin_app):
    """Fixture quality: every price and id the scripted prose states is in the evidence."""
    _, reports = converse(
        package, origin_app, case.turns, routers=[fixture_router(package)] * len(case.turns)
    )
    seen = []
    for report in reports:
        result = report["output"]
        seen.append(json.dumps([result["evidence"], result["interpreted_request"]]))
        evidence = "".join(seen)
        numbers = {int(n) for n in re.findall(r"(?<![\w.])(\d+)(?![\w.])", evidence)}
        for amount in re.findall(r"\$(\d[\d,]*)", result["answer"]):
            assert int(amount.replace(",", "")) in numbers, amount
        for identifier in re.findall(r"\bWA(?:Q|-DEMO)?-?[A-Z0-9-]{5,}\b", result["answer"]):
            assert identifier in evidence, identifier


def test_the_fixture_conversation_carries_the_search_across_turns(package, origin_app):
    """The conversation fixture: a broad search, a refinement that keeps the route, the date
    and the price limit from the history, then goodbye, which ends the conversation by the
    package's own rule without a model call."""
    case = scenario("fixture")
    calls = []
    result, reports = converse(
        package, origin_app, case.turns, routers=[fixture_router(package)] * 3, record=calls
    )
    assert [r["output"]["status"] for r in reports] == ["options_found", "options_found", "done"]
    assert reports[0]["output"]["selected_fare_id"] == WA205_731_BASIC
    searches = [c["input"] for c in calls if c["tool"] == "search-flights"]
    # The first turn left the nonstop preference open; with no profile it is searched as False.
    assert [s["nonstop_only"] for s in searches] == [False, True]
    assert all(
        (s["origin"], s["destination"], s["max_price_usd"]) == ("BOS", "ZRH", 900) for s in searches
    )
    assert reports[1]["output"]["selected_fare_id"] == WA101_BASIC
    assert model_tasks(reports[2]) == ["interpret"]
    assert tools_called(reports[2]) == []
    assert reports[2]["output"]["answer"].startswith("Glad to help.")
    assert result["ended"]["reason"] == "package"
    state = result["state"]
    assert [h["intent"] for h in state["history"]] == ["search", "search", "done"]
    assert state["history"][2]["search"] is None
    assert len(state["known_fares"]) == 8 and len({f["fare_id"] for f in state["known_fares"]}) == 8
    # One audit chain across the three turns (conversation.v0 V-17).
    chain = verify_audit_chain(result["audit"])
    assert chain["valid"] is True
    assert {e["turn"] for e in result["audit"]} == {0, 1, 2, 3}


def test_no_matching_flights_is_webair_evidence(package, origin_app):
    result = run(package, origin_app, scenario("no-results").input)["output"]
    assert result["evidence"]["search"]["flights"] == []
    assert result["evidence"]["search"]["query"]["destination"] == "GVA"
    assert result["evidence"]["fare_rules"] == [] and result["refusal"] is None


def test_refused_search_reports_webairs_own_refusal(package, origin_app):
    report = run(package, origin_app, scenario("refused").input)
    result = report["output"]
    assert result["refusal"]["code"] == "date_out_of_range"
    assert result["refusal"] == result["evidence"]["search"]["error"]
    assert tools_called(report) == ["search-flights"]


def test_unsupported_request_searches_nothing(package, origin_app):
    report = run(package, origin_app, scenario("unsupported").input)
    assert report["output"]["evidence"]["search"] is None
    assert tools_called(report) == []
    assert model_tasks(report) == ["interpret", "answer"]


# --- host-owned capabilities, as the package uses them ---------------------------------------


def test_profile_fills_only_what_the_request_left_open(package, origin_app):
    calls = []
    result, reports = capability(package, origin_app, "profile-search", record=calls)
    report = reports[0]
    output = report["output"]
    search = next(c for c in calls if c["tool"] == "search-flights")["input"]
    assert search == conversation_scenario("profile-search").expect["search_query"]
    assert output["interpreted_request"]["search"]["origin"] is None
    assert output["status"] == "options_found" and output["selected_fare_id"] == WA101_BASIC
    # The interpreting model saw the message and the conversation only; the profile reached
    # WebAir as criteria, and the conversation remembers that it was read.
    interpret = next(e for e in events(report, "model.called") if e["task"] == "interpret")
    assert interpret["worker"].startswith("Interpreter")
    assert result["state"]["profile_used"] is True


def test_explicit_search_never_reads_the_profile(package, origin_app):
    result, reports = capability(package, origin_app, "explicit-search-profile-denied")
    assert reports[0]["output"]["status"] == "options_found"
    assert "travel.profile" not in tools_called(reports[0])
    assert result["state"]["profile_used"] is False


def test_booking_quote_is_webairs_quote_for_the_granted_passenger(package, origin_app):
    calls = []
    result, reports = capability(package, origin_app, "quote", record=calls)
    report = reports[0]
    output = report["output"]
    booking = output["booking"]
    assert (output["status"], output["intent"]) == ("quoted", "quote")
    assert booking["fare_id"] == output["selected_fare_id"] == WA101_STANDARD
    assert (booking["price_per_passenger_usd"], booking["total_usd"]) == (858, 858)
    assert booking["passenger_count"] == 1 and booking["simulated"] is True
    assert booking["quote_id"] == conversation_scenario("quote").expect["quote_id"]
    assert output["purchase"] is None
    prepare = [c for c in calls if c["tool"] == "prepare-booking"]
    assert [c["input"] for c in prepare] == [demo_booking()]
    # The identity went to prepare_booking and nowhere else.
    assert [c["tool"] for c in calls if ALEX["contact_email"] in str(c["input"])] == [
        "prepare-booking"
    ]
    assert "simulate-purchase" not in tools_called(report)
    assert set(model_tasks(report)) == {"interpret", "select", "answer", "remember"}
    text = json.dumps(output) + json.dumps(result["state"]) + json.dumps(result["transcript"])
    assert ALEX["given_name"] not in text and ALEX["contact_email"] not in text
    # The quote outlives the turn as its summary: the open quote of the conversation.
    assert result["state"]["quote_ref"] == booking


def test_a_known_fare_is_quoted_without_a_new_search(package, origin_app):
    """The second turn names a fare the first turn offered: no search, the quote only."""
    calls = []
    result, reports = capability(package, origin_app, "quote-known-fare", record=calls)
    second = reports[1]
    assert tools_called(second) == ["personal.passenger_identity", "prepare-booking"]
    assert model_tasks(second) == ["interpret", "answer", "remember"]
    output = second["output"]
    assert (output["status"], output["intent"]) == ("quoted", "quote")
    assert output["booking"]["fare_id"] == WA101_STANDARD
    assert output["evidence"]["search"] is None and output["selected_fare_id"] is None
    assert WA101_STANDARD in output["mentioned_fare_ids"]
    assert {f["fare_id"] for f in result["state"]["known_fares"]} == set(HERO_FARES)


def test_a_fare_the_conversation_never_saw_cannot_be_quoted(package, origin_app):
    """The interpreter names a well-formed fare id no turn offered: the turn stops before any
    identity is read."""
    case = conversation_scenario("quote-known-fare")
    routers = routers_for(case, replace={"interpret": _plan("quote", fare_id=WA105_STANDARD)})
    routers[0] = ScriptedRouter(case.turns[0].models)
    calls = []
    error = capability_failure(
        package, origin_app, "quote-known-fare", routers=routers, record=calls
    )
    assert error.code == "schema_validation" and error.node_id == "check-quote-fare"
    assert [c["tool"] for c in calls if c["tool"] == "prepare-booking"] == []
    assert "personal.passenger_identity" not in tools_called(error.execution_report)


def test_simulated_purchase_is_only_ever_simulated(package, origin_app):
    """\"Buy it\" after a quote: the card is shown with the quote's facts and the person's
    name, the transcript accepts, WebAir simulates, nothing is charged, and the
    conversation ends on goodbye with the once grant spent."""
    calls = []
    result, reports = capability(package, origin_app, "purchase", record=calls)
    quote, purchase, goodbye = reports
    output = purchase["output"]
    simulated = output["purchase"]
    assert (output["status"], output["intent"]) == ("purchase_simulated", "purchase")
    assert simulated["real_transaction"] is False
    assert simulated["amount_charged_usd"] == 0
    assert simulated["message"] == "No real transaction was performed."
    assert simulated["quote_id"] == quote["output"]["booking"]["quote_id"]
    assert simulated["payment_display"] == VISA["display"]
    assert output["notice"] == "Fictional WebAir demo: no real booking, payment or ticket."
    # Re-quoted first, then purchased; only the purchase carries the payment identifier.
    assert tools_called(purchase) == [
        "wallet.payment_method",
        "personal.passenger_identity",
        "prepare-booking",
        "simulate-purchase",
    ]
    assert [c["tool"] for c in calls if VISA["payment_method_id"] in str(c["input"])] == [
        "simulate-purchase"
    ]
    assert model_tasks(purchase) == ["interpret", "answer", "remember"]
    # The card: asked once, accepted from the transcript, its facts hashed in the audit and
    # shown in the transcript without the e-mail or the payment identifier.
    [decision] = purchase["consents"]
    assert (decision["step"], decision["accepted"], decision["decided_by"]) == (
        "confirm-purchase",
        True,
        "transcript",
    )
    assert decision["text"] == purchase_note(simulated["quote_id"])
    facts = decision["facts"]
    assert facts["passenger"] == {
        "given_name": ALEX["given_name"],
        "family_name": ALEX["family_name"],
    }
    assert facts["payment_method"] == VISA["display"]
    assert (facts["fare_id"], facts["total_usd"], facts["currency"]) == (WA101_STANDARD, 858, "USD")
    assert ALEX["contact_email"] not in json.dumps(facts)
    assert VISA["payment_method_id"] not in json.dumps(facts)
    requested = events(purchase, "consent.requested")
    assert [e["step"] for e in requested] == ["confirm-purchase"]
    assert "facts_hash" in requested[0] and "passenger" not in json.dumps(requested[0])
    # Nothing personal leaves the turn or the conversation's record.
    sealed = (ALEX["contact_email"], VISA["payment_method_id"])
    for text in (json.dumps(output), json.dumps(result["state"]), json.dumps(result["transcript"])):
        assert not any(value in text for value in sealed)
    assert result["state"]["confirmation_ref"] == simulated
    # Goodbye ends the conversation; the once grant was spent by the purchase.
    assert goodbye["output"]["status"] == "done"
    assert result["ended"]["reason"] == "package"
    assert result["transcript"]["spent_permissions"] == ["booking.simulate_purchase"]
    assert verify_audit_chain(result["audit"])["valid"] is True


def test_the_card_declined_buys_nothing(package, origin_app):
    calls = []
    result, reports = capability(package, origin_app, "purchase-declined", record=calls)
    purchase = reports[1]
    output = purchase["output"]
    assert (output["status"], output["intent"]) == ("purchase_declined", "purchase")
    assert output["purchase"] is None
    assert "simulate-purchase" not in tools_called(purchase)
    assert "simulate-purchase" not in [c["tool"] for c in calls]
    [decision] = purchase["consents"]
    assert (decision["accepted"], decision["decided_by"]) == (False, "transcript")
    assert output["answer"].startswith("Understood, I did not buy anything.")
    # The quote stays open; nothing was spent.
    assert result["state"]["quote_ref"]["fare_id"] == WA101_STANDARD
    assert result["state"]["confirmation_ref"] is None
    assert result["transcript"]["spent_permissions"] == []


def test_a_purchase_without_an_open_quote_stops_before_any_personal_read(package, origin_app):
    case = conversation_scenario("purchase")
    turns = [Turn(message=PURCHASE_REQUEST, models={"interpret": [_plan("purchase", note="Buy?")]})]
    calls = []
    error = capability_failure(
        package,
        origin_app,
        "purchase",
        turns=turns,
        routers=[ScriptedRouter(turns[0].models)],
        grants=case.decisions,
        record=calls,
    )
    assert error.code == "schema_validation" and error.node_id == "check-open-quote"
    assert calls == [] and tools_called(error.execution_report) == []


def test_a_quote_webair_no_longer_honours_is_not_purchased(package, origin_app):
    """The purchase turn quotes the fare again for the same passenger; a quote that is not
    exactly the open one stops the turn before any purchase (a stale or substituted quote)."""
    handlers = json_http_handlers(package, origin_app)
    honest = handlers["webair.prepare_booking"]
    answers = []

    async def drifting(context, payload):
        answer = await honest(context, payload)
        answers.append(answer)
        if len(answers) > 1:
            answer["quote_id"] = "WAQ-0000000000000000"
        return answer

    handlers["webair.prepare_booking"] = drifting
    calls = []
    error = capability_failure(package, origin_app, "purchase", handlers=handlers, record=calls)
    assert error.code == "schema_validation" and error.node_id == "check-quote-authorized"
    assert "simulate-purchase" not in [c["tool"] for c in calls]
    assert not events(error.execution_report, "consent.requested")


def test_a_second_purchase_is_not_asked_again(package, origin_app):
    """V-13: `once` is one use per conversation. A second \"buy it\" after the purchase is
    not put to the person: the step resolves denied by the plan (`permission_consumed`) and
    nothing is purchased again."""
    case = conversation_scenario("purchase")
    again = Turn(
        message=PURCHASE_REQUEST,
        models={
            "interpret": [_plan("purchase", note=purchase_note(case.expect.get("quote_id", "")))],
            "answer": [
                {"answer": "Already bought; nothing more was purchased.", "mentioned_fare_ids": []}
            ],
            "remember": [{"proposals": []}],
        },
        consents={"confirm-purchase": True},
    )
    turns = [*case.turns[:2], again]
    routers = [ScriptedRouter(t.models) for t in turns]
    result, reports = capability(package, origin_app, "purchase", turns=turns, routers=routers)
    third = reports[2]
    assert third["output"]["status"] == "purchase_declined"
    [decision] = third["consents"]
    assert (decision["accepted"], decision["decided_by"], decision["reason"]) == (
        False,
        "plan",
        "permission_consumed",
    )
    assert events(third, "consent.decided")[0]["decided_by"] == "plan"
    assert "simulate-purchase" not in tools_called(third)
    assert result["usage"]["tool_calls"]["simulate-purchase"] == 1


# --- authority stays with the host -----------------------------------------------------------


def test_search_runs_with_every_personal_permission_denied(package, origin_app):
    grants = {
        **all_grants(package),
        **dict.fromkeys(
            [
                "memory.travel_profile",
                "identity.passenger",
                "wallet.payment",
                "booking.simulate_purchase",
            ],
            "deny",
        ),
    }
    approved = ["get-fare-rules", "search-flights"]
    report = run(package, origin_app, HERO, grants=grants, approved_tools=approved)
    assert report["output"]["status"] == "options_found"


def test_a_profile_request_needs_the_profile_permission(package, origin_app):
    grants = {
        **conversation_scenario("profile-search").decisions,
        "memory.travel_profile": "deny",
    }
    error = capability_failure(package, origin_app, "profile-search", grants=grants)
    assert error.code == "permission_denied" and error.node_id == "profile"


def test_booking_needs_the_identity_permission(package, origin_app):
    grants = {**conversation_scenario("quote").decisions, "identity.passenger": "deny"}
    error = capability_failure(package, origin_app, "quote", grants=grants)
    assert error.code == "permission_denied" and error.node_id == "passenger"


def test_booking_needs_the_identity_tool_approval(package, origin_app):
    approved = sorted(set(package.tools) - {"personal.passenger_identity"})
    error = capability_failure(package, origin_app, "quote", approved_tools=approved)
    assert error.code == "permission_denied" and error.node_id == "passenger"


def test_purchase_needs_the_payment_method_before_any_identity_is_read(package, origin_app):
    calls = []
    error = capability_failure(package, origin_app, "purchase-denied", record=calls)
    assert error.code == "permission_denied" and error.node_id == "payment"
    # The quote turn ran; the purchase turn read nothing and asked nothing.
    assert [c["tool"] for c in calls] == ["search-flights", "get-fare-rules", "prepare-booking"]
    assert tools_called(error.execution_report) == []
    assert not events(error.execution_report, "consent.requested")


def test_quote_authority_is_not_purchase_authority(package, origin_app):
    """With the purchase permission denied, the card is never shown (V-12): the step resolves
    denied by the plan and the turn ends as declined, with no purchase call."""
    grants = {**conversation_scenario("purchase").decisions, "booking.simulate_purchase": "deny"}
    calls = []
    result, reports = capability(
        package,
        origin_app,
        "purchase",
        grants=grants,
        turns=conversation_scenario("purchase").turns[:2],
        routers=routers_for(conversation_scenario("purchase"))[:2],
        record=calls,
    )
    purchase = reports[1]
    assert purchase["output"]["status"] == "purchase_declined"
    [decision] = purchase["consents"]
    assert (decision["accepted"], decision["decided_by"], decision["reason"]) == (
        False,
        "plan",
        "permission_denied",
    )
    # The audit records the request and the plan's decision (V-23); no host was asked.
    assert events(purchase, "consent.decided")[0]["decided_by"] == "plan"
    assert "simulate-purchase" not in [c["tool"] for c in calls]


def test_a_once_purchase_grant_covers_exactly_one_purchase(package, origin_app):
    _, reports = capability(package, origin_app, "purchase")
    checked = [
        e
        for e in events(reports[1], "permission.checked")
        if e["permission"] == "booking.simulate_purchase"
    ]
    assert [(e["grant"], e["allowed"]) for e in checked] == [("once", True), ("once", True)]


def test_search_needs_its_permission(package, origin_app):
    grants = {**all_grants(package), "network.webair": "deny"}
    assert failure(package, origin_app, HERO, grants=grants).code == "permission_denied"


def test_an_undeclared_tool_cannot_be_called(package):
    runtime = Runtime(
        package, grants=all_grants(package), handlers={}, approved_tools=sorted(package.tools)
    )

    async def attempt(context, data):
        return await context.tool("get-flight", {"flight_id": "WA101-20261009"})

    with pytest.raises(PolicyError):
        asyncio.run(runtime.run_worker("Searcher", {}, attempt, return_value=True))


def test_tool_arguments_cannot_smuggle_fields(package, origin_app):
    runtime = Runtime(
        package,
        grants=all_grants(package),
        handlers=json_http_handlers(package, origin_app),
        approved_tools=sorted(package.tools),
    )
    smuggled = {
        "origin": "BOS",
        "destination": "ZRH",
        "date": "2026-10-09",
        "url": "https://elsewhere.example/",
        "headers": {"authorization": "x"},
    }

    async def attempt(context, data):
        return await context.tool("search-flights", smuggled)

    with pytest.raises(Exception) as caught:
        asyncio.run(runtime.run_worker("Searcher", {}, attempt, return_value=True))
    assert getattr(caught.value, "code", None) == "tool_request_invalid"
    assert not [e for e in runtime.audit if e["action"] == "tool.called"]


def test_tool_roles_are_least_privilege(package):
    roles = {role["id"]: role for role in package.graph["workers"]}
    assert roles["Searcher"]["tools"] == ["search-flights", "get-fare-rules"]
    assert roles["Booker"]["tools"] == ["prepare-booking", "simulate-purchase"]
    assert roles["Personal"]["tools"] == [
        "travel.profile",
        "personal.passenger_identity",
        "wallet.payment_method",
    ]
    personal = {
        "profile",
        "passenger",
        "payment",
        "booking_request",
        "purchase_request",
        "purchase_facts",
    }
    for model_role in ("Interpreter", "Selector", "Writer", "Rememberer"):
        assert roles[model_role]["tools"] == []
        assert not personal & set(roles[model_role]["state_read"])
    assert "message" not in roles["Booker"]["state_read"]
    assert "message" not in roles["Personal"]["state_read"]


# --- malformed input --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_input",
    [
        {"request": HERO_REQUEST, "booking": False, "purchase": {"quote_id": "", "fare_id": ""}},
        {"message": ""},
        {"message": 42},
        {**HERO, "url": "https://elsewhere.example/"},
        {**HERO, "booking": True},
        {**HERO, "purchase": {"quote_id": "WAQ-0000000000000000", "fare_id": WA101_STANDARD}},
        {**HERO, "passengers": [{"given_name": "A", "family_name": "B"}]},
        {**HERO, "payment_method_id": "demo-visa-4242"},
        {**HERO, "card_number": "4242424242424242"},
    ],
    ids=[
        "the-one-shot-task",
        "empty-message",
        "not-a-string",
        "extra-field",
        "booking-switch",
        "purchase-authorization",
        "passengers-in-the-message",
        "payment-method-in-the-message",
        "card-number",
    ],
)
def test_malformed_input_is_rejected_before_anything_runs(bad_input, package, origin_app):
    calls = []
    router = fixture_router(package)
    error = failure(package, origin_app, bad_input, router=router, record=calls)
    assert error.code == "schema_validation" and error.node_id is None
    assert calls == [] and router.calls == []


# --- a model cannot introduce data the tools did not return ----------------------------------


def scripted(case_id, **replace):
    script = copy.deepcopy(scenario(case_id).turns[0].models)
    for task, output in replace.items():
        script[task] = [output]
    return ScriptedRouter(script)


def test_malformed_model_output_is_rejected(package, origin_app):
    plan = copy.deepcopy(scenario("hero").turns[0].models["interpret"][0])
    plan["search"]["date"] = "9 October"
    error = failure(package, origin_app, HERO, router=scripted("hero", interpret=plan))
    assert error.code == "schema_validation" and error.node_id == "interpret"


def test_an_interpretation_without_an_intent_is_rejected(package, origin_app):
    plan = {
        k: v for k, v in scenario("hero").turns[0].models["interpret"][0].items() if k != "intent"
    }
    error = failure(package, origin_app, HERO, router=scripted("hero", interpret=plan))
    assert error.code == "schema_validation" and error.node_id == "interpret"


@pytest.mark.parametrize(
    "selection,node",
    [
        # An invented fare id, well-formed but not returned by the search.
        (
            {
                "outcome": "options_found",
                "fare_ids": ["WA101-20261009-FLEX"],
                "selected_fare_id": "WA101-20261009-FLEX",
            },
            "check-options",
        ),
        # A real fare chosen but never listed for its rules.
        (
            {
                "outcome": "options_found",
                "fare_ids": [WA101_BASIC],
                "selected_fare_id": WA101_STANDARD,
            },
            "check-options",
        ),
        # Claiming WebAir returned nothing when it returned three fares.
        (
            {"outcome": "no_matching_flights", "fare_ids": [], "selected_fare_id": None},
            "check-no-flights",
        ),
        # Claiming a refusal that never happened.
        ({"outcome": "request_refused", "fare_ids": [], "selected_fare_id": None}, "refusal"),
        # Claiming nothing was searched.
        (
            {"outcome": "request_not_supported", "fare_ids": [], "selected_fare_id": None},
            "check-not-searched",
        ),
        # Options found, but none listed.
        ({"outcome": "options_found", "fare_ids": [], "selected_fare_id": None}, "check-options"),
    ],
    ids=[
        "invented-fare",
        "unlisted-selection",
        "false-empty",
        "false-refusal",
        "false-unsupported",
        "empty-options",
    ],
)
def test_a_wrong_reading_of_the_search_stops_the_run(selection, node, package, origin_app):
    calls = []
    error = failure(
        package, origin_app, HERO, router=scripted("hero", select=selection), record=calls
    )
    assert error.code == "schema_validation" and error.node_id == node
    # Nothing was fetched for an invented fare.
    assert [c for c in calls if c["tool"] == "get-fare-rules"] == []


def test_claiming_flights_after_a_refusal_stops_the_run(package, origin_app):
    selection = {
        "outcome": "options_found",
        "fare_ids": [WA101_BASIC],
        "selected_fare_id": WA101_BASIC,
    }
    error = failure(
        package, origin_app, scenario("refused").input, router=scripted("refused", select=selection)
    )
    assert error.code == "schema_validation" and error.node_id == "offered-flights"


def test_an_answer_cannot_cite_a_fare_webair_did_not_offer(package, origin_app):
    answer = {"answer": "WA101 Flex costs $1,201.", "mentioned_fare_ids": ["WA101-20261009-FLEX"]}
    error = failure(package, origin_app, HERO, router=scripted("hero", answer=answer))
    assert error.code == "schema_validation" and error.node_id == "assemble"


def test_an_answer_may_cite_a_fare_an_earlier_turn_offered(package, origin_app):
    """The relation check admits the fares the conversation knows, not only this turn's."""
    case = scenario("fixture")
    answer = {
        "answer": "You saw WA205-WA731-20261009-BASIC at $505 earlier; the nonstop WA101 Basic "
        "is $704.",
        "mentioned_fare_ids": [WA205_731_BASIC, WA101_BASIC],
    }
    routers = [
        ScriptedRouter(case.turns[0].models),
        ScriptedRouter({**case.turns[1].models, "answer": [answer]}),
    ]
    _, reports = converse(package, origin_app, case.turns[:2], routers=routers)
    assert reports[1]["output"]["mentioned_fare_ids"] == [WA205_731_BASIC, WA101_BASIC]


def test_a_miscounted_party_cannot_be_quoted(package, origin_app):
    """One granted passenger is one traveler: a two-traveler search cannot be quoted for one."""
    case = conversation_scenario("quote")
    plan = copy.deepcopy(case.turns[0].models["interpret"][0])
    plan["search"]["passengers"] = 2
    error = capability_failure(
        package, origin_app, "quote", routers=routers_for(case, replace={"interpret": plan})
    )
    assert error.code == "schema_validation" and error.node_id == "check-quote-offer"


# --- fare totals, recomputed by a module (0.7.0, compute.v0) ---------------------------------


def misstating(package, origin_app, binding, change):
    """The origin's handlers, with one binding's answer changed by `change` after WebAir answers."""
    handlers = json_http_handlers(package, origin_app)
    honest = handlers[binding]

    async def tampered(context, payload):
        answer = await honest(context, payload)
        change(answer)
        return answer

    return {**handlers, binding: tampered}


def test_the_module_recomputes_every_total_webair_states(package, origin_app):
    _, reports = capability(package, origin_app, "quote")
    report = reports[0]
    completed = events(report, "compute.completed")
    by_node = {}
    for event in completed:
        by_node.setdefault(event["node_id"], []).append(event)
    selected = report["output"]["evidence"]["fare_rules"]
    assert len(by_node["fare-rules/total"]) == len(selected)
    assert len(by_node["quote-total"]) == 1
    assert {e["module"] for e in completed} == {"fares"}
    assert {e["function"] for e in completed} == {"run"}
    assert report["usage"]["compute_calls"] == len(completed)
    assert report["state"]["quote_total"]["total_cents"] == report["output"]["booking"]["total_usd"]


def test_a_quote_whose_total_webair_misstates_is_refused(package, origin_app):
    def inflate(answer):
        answer["total_usd"] += 1

    handlers = misstating(package, origin_app, "webair.prepare_booking", inflate)
    error = capability_failure(package, origin_app, "quote", handlers=handlers)
    assert (error.code, error.node_id) == ("schema_validation", "check-quote")


def test_fare_rules_whose_total_webair_misstates_are_refused(package, origin_app):
    def inflate(answer):
        answer["total_usd"] += 100

    handlers = misstating(package, origin_app, "webair.get_fare_rules", inflate)
    error = failure(package, origin_app, HERO, handlers=handlers)
    assert (error.code, error.node_id) == ("schema_validation", "fare-rules")


# --- tool failures ---------------------------------------------------------------------------


def test_a_failing_tool_binding_fails_the_turn_not_the_conversation(package, origin_app):
    handlers = json_http_handlers(package, origin_app)
    calls = 0

    async def flaky(context, payload):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise BindingError("search-flights: HTTP 503 is not data")
        return await json_http_handlers(package, origin_app)["webair.search_flights"](
            context, payload
        )

    handlers["webair.search_flights"] = flaky
    turns = [scenario("hero").turns[0], scenario("hero").turns[0]]
    result, reports = converse(
        package, origin_app, turns, routers=[fixture_router(package)] * 2, handlers=handlers
    )
    assert [r["status"] for r in reports] == ["failed", "completed"]
    assert reports[0]["error_code"] == "tool_error"
    # A failed turn persists nothing (V-5): the second turn starts from the empty state.
    assert [t["status"] for t in result["transcript"]["turns"]] == ["failed", "completed"]
    assert [h["intent"] for h in result["state"]["history"]] == ["search"]
    assert result["status"] == "failed"


def test_an_answer_outside_the_contract_is_rejected(package, origin_app):
    handlers = json_http_handlers(package, origin_app)

    async def tampered(context, payload):
        return {"query": payload, "currency": "USD", "flights": "three cheap flights"}

    handlers["webair.search_flights"] = tampered
    error = failure(package, origin_app, HERO, handlers=handlers)
    assert error.code == "schema_validation" and error.node_id == "search"
    failed = [e for e in error.execution_report["audit"] if e["action"] == "tool.failed"]
    assert failed and failed[0]["reason"] == "tool_response_invalid"


# --- nothing here is WebAir-specific runtime code --------------------------------------------


def test_the_run_uses_only_the_generic_runtime(package, origin_app):
    handlers = json_http_handlers(package, origin_app)
    router = fixture_router(package)
    conversation = Conversation(
        package,
        grants=all_grants(package),
        approved_tools=sorted(package.tools),
        adapters=lambda turn: {"router": router, "handlers": handlers, "memory": None},
    )
    assert type(conversation).__module__ == "agentpkg.conversation.runner"
    result = asyncio.run(
        conversation.run({"schema": "conversation.transcript.v0", "turns": [{"message": HERO}]})
    )
    assert result["provenance"]["interpreter"] == "agentpkg.conversation.Conversation"
    assert result["status"] == "completed"
    node_types = {node["type"] for node in package.graph["nodes"]}
    assert node_types <= CANONICAL_NODE_TYPES
    step_types = {
        step["type"]
        for node in package.graph["nodes"]
        if node["type"] == "map"
        for step in node["steps"]
    }
    assert step_types <= CANONICAL_NODE_TYPES
