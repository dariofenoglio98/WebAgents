"""The WebAir package, run by the generic WebAgents runtime against this origin.

Every run uses `agentpkg.workflow` (the domain-independent workflow.v0 interpreter), a
`ModelRouter` (agentpkg's exact-input `FixtureRouter` over the package's own fixture, or a
script for the host-capability and failure cases) and one `ToolHandler` per declared WebAir
binding that calls this origin's JSON API in-process. Tool answers therefore come from
WebAirService itself, never from the fixture. The package's host-resource tools are answered
by the demo host's stand-in (`publisher/host.py`) with the fictional resources a scenario
picks. Nothing touches a network, a model provider or the HTTP server.

The Agent Browser's own host path (authorization, picks, plans, broker) is tested in
`openclaw-agent-browser/test/webair-capabilities.test.ts`.
"""

import asyncio
import copy
import json
import re

import pytest
from agentpkg.fixtures import FixtureRouter
from agentpkg.package import load_package
from agentpkg.runtime import PolicyError, Runtime
from agentpkg.workflow import Workflow, WorkflowError

from origin.app import create_app
from publisher.binding import BindingError, json_http_handlers
from publisher.contract import PACKAGE_SOURCE
from publisher.fixture import ScriptedRouter, all_grants, run_package
from publisher.host import host_resource_handlers, resource_value
from publisher.scenarios import (
    HERO_FARES,
    HERO_REQUEST,
    NO_PURCHASE,
    WA101_BASIC,
    WA101_STANDARD,
    WA105_BASIC,
    capability_scenario,
    demo_booking,
    scenario,
    scenarios,
)

CANONICAL_NODE_TYPES = {"llm", "tool", "map", "join", "validate", "output"}
HERO = {"request": HERO_REQUEST, "booking": False, "purchase": dict(NO_PURCHASE)}
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
    router = fixture_router(package) if router is None else router
    return asyncio.run(
        run_package(package, input_value, router=router, app=origin_app, record=record, **options)
    )


def failure(package, origin_app, input_value, **options):
    with pytest.raises(WorkflowError) as caught:
        run(package, origin_app, input_value, **options)
    return caught.value


def capability(package, origin_app, case_id, *, grants=None, selections=None, **options):
    """A host-capability scenario: its grants and picks, the demo host's resources."""
    case = capability_scenario(case_id)
    picked = case.selections if selections is None else selections
    handlers = {
        **json_http_handlers(package, origin_app, record=options.pop("record", None)),
        **host_resource_handlers(package, picked),
    }
    return run(
        package,
        origin_app,
        options.pop("input_value", case.input),
        router=options.pop("router", ScriptedRouter(case.models)),
        handlers=handlers,
        grants=case.decisions if grants is None else grants,
        **options,
    )


def capability_failure(package, origin_app, case_id, **options):
    with pytest.raises(WorkflowError) as caught:
        capability(package, origin_app, case_id, **options)
    return caught.value


def events(report, action):
    return [event for event in report["audit"] if event["action"] == action]


def tools_called(report):
    return [event["tool"] for event in events(report, "tool.called")]


# --- the hero task ------------------------------------------------------------------------


def test_hero_search_returns_webair_fares_under_900(package, origin_app):
    calls = []
    report = run(package, origin_app, HERO, record=calls)
    assert report["status"] == "completed"
    result = report["output"]
    assert result["status"] == "options_found"
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
    assert [event["task"] for event in events(report, "model.called")] == [
        "interpret",
        "select",
        "answer",
    ]


def test_hero_audit_chain_is_intact(package, origin_app):
    from agentpkg.runtime import digest

    audit = run(package, origin_app, HERO)["audit"]
    previous = None
    for index, event in enumerate(audit, 1):
        body = {k: v for k, v in event.items() if k != "event_hash"}
        assert event["sequence"] == index
        assert event["previous_hash"] == previous
        assert event["event_hash"] == digest(body)
        previous = event["event_hash"]


# --- every demo scenario, against the live service ----------------------------------------


@pytest.mark.parametrize("case", scenarios(), ids=lambda s: s.id)
def test_scenario_runs_against_the_origin(case, package, origin_app):
    report = run(package, origin_app, case.input)
    result = report["output"]
    assert result["status"] == case.expect["status"]
    assert result["selected_fare_id"] == case.expect["selected_fare_id"]
    assert (result["booking"], result["purchase"]) == (None, None)
    offered = {
        fare["fare_id"]
        for flight in (result["evidence"]["search"] or {}).get("flights", [])
        for fare in flight["fares"]
    }
    assert set(result["mentioned_fare_ids"]) <= offered
    if result["selected_fare_id"] is not None:
        assert result["selected_fare_id"] in offered


@pytest.mark.parametrize("case", scenarios(), ids=lambda s: s.id)
def test_scripted_answers_quote_only_tool_evidence(case, package, origin_app):
    """Fixture quality: every price and id the scripted prose states is in the evidence."""
    result = run(package, origin_app, case.input)["output"]
    evidence = json.dumps([result["evidence"], result["interpreted_request"]])
    numbers = {int(n) for n in re.findall(r"(?<![\w.])(\d+)(?![\w.])", evidence)}
    for amount in re.findall(r"\$(\d[\d,]*)", result["answer"]):
        assert int(amount.replace(",", "")) in numbers, amount
    for identifier in re.findall(r"\bWA(?:Q|-DEMO)?-?[A-Z0-9-]{5,}\b", result["answer"]):
        assert identifier in evidence, identifier


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
    assert [event["task"] for event in events(report, "model.called")] == ["interpret", "answer"]


# --- host-owned capabilities, as the package uses them ---------------------------------------


def test_profile_fills_only_what_the_request_left_open(package, origin_app):
    calls = []
    report = capability(package, origin_app, "profile-search", record=calls)
    result = report["output"]
    search = next(c for c in calls if c["tool"] == "search-flights")["input"]
    assert search == capability_scenario("profile-search").expect["search_query"]
    assert result["interpreted_request"]["search"]["origin"] is None
    assert result["status"] == "options_found" and result["selected_fare_id"] == WA101_BASIC
    # The interpreting model saw the request only; the profile reached WebAir as criteria.
    interpret = next(e for e in events(report, "model.called") if e["task"] == "interpret")
    assert interpret["worker"].startswith("Interpreter")


def test_explicit_search_never_reads_the_profile(package, origin_app):
    report = capability(package, origin_app, "explicit-search-profile-denied")
    assert report["output"]["status"] == "options_found"
    assert "personal.travel_profile" not in tools_called(report)


def test_booking_quote_is_webairs_quote_for_the_granted_passenger(package, origin_app):
    calls = []
    report = capability(package, origin_app, "booking", record=calls)
    result = report["output"]
    booking = result["booking"]
    assert booking["fare_id"] == result["selected_fare_id"] == WA101_STANDARD
    assert (booking["price_per_passenger_usd"], booking["total_usd"]) == (858, 858)
    assert booking["passenger_count"] == 1 and booking["simulated"] is True
    assert booking["quote_id"] == capability_scenario("booking").expect["quote_id"]
    assert result["purchase"] is None
    prepare = [c for c in calls if c["tool"] == "prepare-booking"]
    assert [c["input"] for c in prepare] == [demo_booking()]
    # The identity went to prepare_booking and nowhere else.
    assert [c["tool"] for c in calls if ALEX["contact_email"] in str(c["input"])] == [
        "prepare-booking"
    ]
    assert "simulate-purchase" not in tools_called(report)
    for model in events(report, "model.called"):
        assert model["task"] in {"interpret", "select", "answer"}
    text = str(result)
    assert ALEX["given_name"] not in text and ALEX["contact_email"] not in text


def test_simulated_purchase_is_only_ever_simulated(package, origin_app):
    calls = []
    report = capability(package, origin_app, "purchase-visa", record=calls)
    result = report["output"]
    purchase = result["purchase"]
    assert purchase["real_transaction"] is False
    assert purchase["amount_charged_usd"] == 0
    assert purchase["message"] == "No real transaction was performed."
    assert purchase["quote_id"] == capability_scenario("purchase-visa").expect["quote_id"]
    assert purchase["payment_display"] == VISA["display"]
    assert result["status"] == "purchase_simulated"
    assert result["notice"] == "Fictional WebAir demo: no real booking, payment or ticket."
    # Re-quoted first, then purchased; only the purchase carries the payment identifier.
    assert [c["tool"] for c in calls] == ["prepare-booking", "simulate-purchase"]
    assert [c["tool"] for c in calls if VISA["payment_method_id"] in str(c["input"])] == [
        "simulate-purchase"
    ]
    assert [e["task"] for e in events(report, "model.called")] == ["answer"]
    assert VISA["payment_method_id"] not in str(result)


def test_another_passenger_cannot_buy_this_quote(package, origin_app):
    """A quote binds the passenger: picking someone else stops the run before any purchase."""
    calls = []
    selections = {"identity.passenger": "passenger_demo_sam", "wallet.payment": "payment_demo_visa"}
    error = capability_failure(
        package, origin_app, "purchase-visa", selections=selections, record=calls
    )
    assert error.code == "schema_validation" and error.node_id == "check-quote-authorized"
    assert "simulate-purchase" not in [c["tool"] for c in calls]


def test_a_stale_purchase_authorization_sends_nothing(package, origin_app):
    stale = copy.deepcopy(capability_scenario("purchase-visa").input)
    stale["purchase"]["quote_id"] = "WAQ-0000000000000000"
    calls = []
    error = capability_failure(
        package, origin_app, "purchase-visa", input_value=stale, record=calls
    )
    assert error.code == "schema_validation" and error.node_id == "check-quote-authorized"
    assert [c["tool"] for c in calls if c["tool"] == "simulate-purchase"] == []
    assert "simulate-purchase" not in tools_called(error.execution_report)


# --- authority stays with the host ---------------------------------------------------------


def test_search_runs_with_every_personal_permission_denied(package, origin_app):
    grants = {
        **all_grants(package),
        **dict.fromkeys(
            ["profile.travel", "identity.passenger", "wallet.payment", "booking.simulate_purchase"],
            "deny",
        ),
    }
    approved = ["get-fare-rules", "search-flights"]
    report = run(package, origin_app, HERO, grants=grants, approved_tools=approved)
    assert report["output"]["status"] == "options_found"


def test_a_profile_request_needs_the_profile_permission(package, origin_app):
    grants = {**capability_scenario("profile-search").decisions, "profile.travel": "deny"}
    error = capability_failure(package, origin_app, "profile-search", grants=grants)
    assert error.code == "permission_denied" and error.node_id == "profile"


def test_booking_needs_the_identity_permission(package, origin_app):
    grants = {**capability_scenario("booking").decisions, "identity.passenger": "deny"}
    error = capability_failure(package, origin_app, "booking", grants=grants)
    assert error.code == "permission_denied" and error.node_id == "passenger"


def test_booking_needs_the_identity_tool_approval(package, origin_app):
    approved = sorted(set(package.tools) - {"personal.passenger_identity"})
    error = capability_failure(package, origin_app, "booking", approved_tools=approved)
    assert error.code == "permission_denied" and error.node_id == "passenger"


def test_purchase_needs_the_payment_method_before_any_identity_is_read(package, origin_app):
    calls = []
    error = capability_failure(package, origin_app, "purchase-denied", record=calls)
    assert error.code == "permission_denied" and error.node_id == "payment"
    assert calls == []
    assert "personal.passenger_identity" not in tools_called(error.execution_report)


def test_quote_authority_is_not_purchase_authority(package, origin_app):
    grants = {**capability_scenario("purchase-visa").decisions, "booking.simulate_purchase": "deny"}
    calls = []
    error = capability_failure(package, origin_app, "purchase-visa", grants=grants, record=calls)
    assert error.code == "permission_denied" and error.node_id == "purchase"
    assert "simulate-purchase" not in [c["tool"] for c in calls]


def test_a_once_purchase_grant_covers_exactly_one_purchase(package, origin_app):
    report = capability(package, origin_app, "purchase-visa")
    checked = [
        e
        for e in events(report, "permission.checked")
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
        "personal.travel_profile",
        "personal.passenger_identity",
        "wallet.payment_method",
    ]
    for model_role in ("Interpreter", "Selector", "Writer"):
        assert roles[model_role]["tools"] == []
        assert not {"profile", "passenger", "payment", "booking_request", "purchase_request"} & set(
            roles[model_role]["state_read"]
        )
    assert "request" not in roles["Booker"]["state_read"]


# --- malformed input ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_input",
    [
        {"request": HERO_REQUEST},
        {**HERO, "request": ""},
        {**HERO, "url": "https://elsewhere.example/"},
        {**HERO, "booking": {"passengers": [{"given_name": "A", "family_name": "B"}]}},
        {**HERO, "purchase": {"quote_id": "WAQ-0000000000000000", "fare_id": ""}},
        {**HERO, "purchase": {"quote_id": "", "fare_id": WA101_STANDARD}},
        {
            **HERO,
            "booking": True,
            "purchase": {"quote_id": "WAQ-0000000000000000", "fare_id": WA101_STANDARD},
        },
        {**HERO, "purchase": {**NO_PURCHASE, "payment_method_id": "demo-visa-4242"}},
        {**HERO, "purchase": {**NO_PURCHASE, "card_number": "4242424242424242"}},
    ],
    ids=[
        "missing-fields",
        "empty-request",
        "extra-field",
        "passengers-in-the-task",
        "quote-without-fare",
        "fare-without-quote",
        "booking-and-purchase",
        "payment-method-in-the-task",
        "card-number",
    ],
)
def test_malformed_input_is_rejected_before_anything_runs(bad_input, package, origin_app):
    calls = []
    router = fixture_router(package)
    error = failure(package, origin_app, bad_input, router=router, record=calls)
    assert error.code == "schema_validation" and error.node_id is None
    assert calls == [] and router.calls == []


# --- a model cannot introduce data the tools did not return -------------------------------


def scripted(case_id, **replace):
    script = copy.deepcopy(scenario(case_id).models)
    for task, output in replace.items():
        script[task] = [output]
    return ScriptedRouter(script)


def test_malformed_model_output_is_rejected(package, origin_app):
    plan = copy.deepcopy(scenario("hero").models["interpret"][0])
    plan["search"]["date"] = "9 October"
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


def test_a_miscounted_party_cannot_be_quoted(package, origin_app):
    """One granted passenger is one traveler: a two-traveler search cannot be quoted for one."""
    case = capability_scenario("booking")
    plan = copy.deepcopy(case.models["interpret"][0])
    plan["search"]["passengers"] = 2
    script = {**copy.deepcopy(case.models), "interpret": [plan]}
    error = capability_failure(package, origin_app, "booking", router=ScriptedRouter(script))
    assert error.code == "schema_validation" and error.node_id == "check-quote-offer"


# --- tool failures ------------------------------------------------------------------------


def test_a_failing_tool_binding_fails_the_run(package, origin_app):
    handlers = json_http_handlers(package, origin_app)

    async def unavailable(context, payload):
        raise BindingError("search-flights: HTTP 503 is not data")

    handlers["webair.search_flights"] = unavailable
    error = failure(package, origin_app, HERO, handlers=handlers)
    assert error.code == "tool_error" and error.node_id == "search"


def test_an_answer_outside_the_contract_is_rejected(package, origin_app):
    handlers = json_http_handlers(package, origin_app)

    async def tampered(context, payload):
        return {"query": payload, "currency": "USD", "flights": "three cheap flights"}

    handlers["webair.search_flights"] = tampered
    error = failure(package, origin_app, HERO, handlers=handlers)
    assert error.code == "schema_validation" and error.node_id == "search"
    failed = [e for e in error.execution_report["audit"] if e["action"] == "tool.failed"]
    assert failed and failed[0]["reason"] == "tool_response_invalid"


# --- nothing here is WebAir-specific runtime code -----------------------------------------


def test_the_run_uses_only_the_generic_runtime(package, origin_app):
    workflow = Workflow(
        package,
        grants=all_grants(package),
        handlers=json_http_handlers(package, origin_app),
        router=fixture_router(package),
        approved_tools=sorted(package.tools),
    )
    assert type(workflow).__module__ == "agentpkg.workflow"
    assert type(workflow.runtime).__module__ == "agentpkg.runtime"
    report = asyncio.run(workflow.run(HERO))
    assert report["provenance"]["interpreter"] == "agentpkg.workflow.Workflow"
    node_types = {node["type"] for node in package.graph["nodes"]}
    node_types |= {s["type"] for n in package.graph["nodes"] for s in n.get("steps", [])}
    assert node_types <= CANONICAL_NODE_TYPES
    # Tools reached handlers only by their declared binding names.
    assert {e["binding"] for e in report["audit"] if e["action"] == "tool.called"} == {
        "webair.search_flights",
        "webair.get_fare_rules",
    }
    assert {e["model"] for e in report["audit"] if e["action"] == "model.called"} == {
        FixtureRouter.model_id
    }
