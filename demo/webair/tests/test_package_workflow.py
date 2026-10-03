"""The WebAir package, run by the generic WebAgents runtime against this origin.

Every run uses `agentpkg.workflow` (the domain-independent workflow.v0 interpreter), a
`ModelRouter` (agentpkg's exact-input `FixtureRouter` over the package's own fixture, or a
script for the failure cases) and one `ToolHandler` per declared binding that calls this
origin's JSON API in-process. Tool answers therefore come from WebAirService itself, never
from the fixture. Nothing touches a network, a model provider or the HTTP server.
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
from publisher.scenarios import (
    DEMO_BOOKING,
    HERO_FARES,
    HERO_REQUEST,
    WA101_BASIC,
    WA101_STANDARD,
    WA105_BASIC,
    scenario,
    scenarios,
)

CANONICAL_NODE_TYPES = {"llm", "tool", "map", "join", "validate", "output"}
HERO = {"request": HERO_REQUEST, "booking": None, "purchase": None}


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
    assert result["evidence"]["booking_quote"] is None
    assert result["evidence"]["simulated_confirmation"] is None
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
    quote = result["evidence"]["booking_quote"]
    confirmation = result["evidence"]["simulated_confirmation"]
    assert (quote or {}).get("quote_id") == case.expect.get("quote_id")
    assert (confirmation or {}).get("confirmation_id") == case.expect.get("confirmation_id")
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


def test_booking_quote_is_webairs_quote_for_the_selected_fare(package, origin_app):
    report = run(package, origin_app, scenario("booking").input)
    result = report["output"]
    quote = result["evidence"]["booking_quote"]
    assert quote["fare"]["fare_id"] == result["selected_fare_id"] == WA101_STANDARD
    assert quote["passengers"] == DEMO_BOOKING["passengers"]
    assert (quote["fare"]["price_per_passenger_usd"], quote["total_usd"]) == (858, 1716)
    assert quote["simulated"] is True and result["evidence"]["simulated_confirmation"] is None
    assert "simulate-purchase" not in tools_called(report)


def test_simulated_purchase_is_only_ever_simulated(package, origin_app):
    report = run(package, origin_app, scenario("purchase").input)
    result = report["output"]
    confirmation = result["evidence"]["simulated_confirmation"]
    assert confirmation["real_transaction"] is False
    assert confirmation["amount_charged_usd"] == 0
    assert confirmation["status"] == "simulated"
    assert confirmation["message"] == "No real transaction was performed."
    assert confirmation["quote_id"] == result["evidence"]["booking_quote"]["quote_id"]
    assert confirmation["payment_method"]["id"] == "demo-visa-4242"
    assert result["notice"] == "Fictional WebAir demo: no real booking, payment or ticket."


# --- authority stays with the host ---------------------------------------------------------


def test_search_runs_without_the_optional_booking_permission(package, origin_app):
    grants = {**all_grants(package), "network.webair.booking": "deny"}
    approved = ["get-fare-rules", "search-flights"]
    report = run(package, origin_app, HERO, grants=grants, approved_tools=approved)
    assert report["output"]["status"] == "options_found"


def test_booking_needs_the_booking_permission(package, origin_app):
    grants = {**all_grants(package), "network.webair.booking": "deny"}
    error = failure(package, origin_app, scenario("booking").input, grants=grants)
    assert error.code == "permission_denied" and error.node_id == "prepare"


def test_booking_needs_the_tool_approval(package, origin_app):
    approved = ["get-fare-rules", "search-flights"]
    error = failure(package, origin_app, scenario("booking").input, approved_tools=approved)
    assert error.code == "permission_denied" and error.node_id == "prepare"


def test_search_needs_its_permission(package, origin_app):
    grants = {**all_grants(package), "network.webair": "deny"}
    assert failure(package, origin_app, HERO, grants=grants).code == "permission_denied"


def test_a_stale_purchase_authorization_sends_nothing(package, origin_app):
    stale = copy.deepcopy(scenario("purchase").input)
    stale["purchase"]["quote_id"] = "WAQ-0000000000000000"
    calls = []
    error = failure(package, origin_app, stale, record=calls)
    assert error.code == "schema_validation" and error.node_id == "check-purchase"
    assert [c["tool"] for c in calls if c["tool"] == "simulate-purchase"] == []
    report = error.execution_report
    assert "simulate-purchase" not in tools_called(report)


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
    for model_role in ("Interpreter", "Selector", "Writer"):
        assert roles[model_role]["tools"] == []
    assert "request" not in roles["Booker"]["state_read"]


# --- malformed input ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_input",
    [
        {"request": HERO_REQUEST},
        {"request": "", "booking": None, "purchase": None},
        {**HERO, "url": "https://elsewhere.example/"},
        {
            **HERO,
            "purchase": {"quote_id": "WAQ-0000000000000000", "payment_method_id": "demo-visa-4242"},
        },
        {**HERO, "booking": {**DEMO_BOOKING, "contact_email": "not an email"}},
        {**HERO, "booking": {**DEMO_BOOKING, "passengers": []}},
        {**HERO, "booking": {**DEMO_BOOKING, "card_number": "4242424242424242"}},
        {
            **HERO,
            "booking": DEMO_BOOKING,
            "purchase": {"quote_id": "WAQ-0000000000000000", "payment_method_id": "real-card"},
        },
    ],
    ids=[
        "missing-fields",
        "empty-request",
        "extra-field",
        "purchase-without-booking",
        "bad-email",
        "no-passengers",
        "card-number",
        "unknown-payment-method",
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
    plan = copy.deepcopy(scenario("booking").models["interpret"][0])
    plan["search"]["passengers"] = 1
    error = failure(
        package, origin_app, scenario("booking").input, router=scripted("booking", interpret=plan)
    )
    assert error.code == "schema_validation" and error.node_id == "check-quote"


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
