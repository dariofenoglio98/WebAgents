"""The WebAir agent package's tool contracts are WebAir's published API contract.

Fails when either side changes without the other: the origin's models or routes, or the
package's tool declarations and schemas. The package is read from its source tree as
plain JSON and through agentpkg; nothing here imports package code (it has none).
"""

import json
import re

import pytest
from agentpkg.package import load_package
from agentpkg.validation import schema_validator
from pydantic import TypeAdapter

from origin import inventory
from origin.api import API_PREFIX, OPERATIONS
from origin.models import (
    CONFIRMATION_ID_PATTERN,
    DATE_PATTERN,
    FARE_ID_PATTERN,
    QUOTE_ID_PATTERN,
    ErrorResponse,
)
from publisher import __main__ as publisher_cli
from publisher.contract import (
    DECLARED_HOST,
    PACKAGE_SOURCE,
    PACKAGE_TOOLS,
    endpoint_operation,
    input_schema_path,
    output_schema_path,
    tool_output_schema,
)

TOOL_IDS = {
    "search-flights",
    "get-fare-rules",
    "prepare-booking",
    "simulate-purchase",
}


@pytest.fixture(scope="module")
def package():
    return load_package(PACKAGE_SOURCE)


@pytest.fixture
def published(client):
    """The contract exactly as the origin serves it over HTTP."""
    return client.get("/api/v1/schemas").json()


def source_json(path):
    return json.loads((PACKAGE_SOURCE / path).read_text())


def without_draft(schema):
    schema = dict(schema)
    assert schema.pop("$schema") == "https://json-schema.org/draft/2020-12/schema"
    return schema


# --- operations ---------------------------------------------------------------------------


def test_the_package_declares_exactly_the_four_semantic_operations(package):
    assert set(package.tools) == TOOL_IDS
    assert {tool["binding"] for tool in package.tools.values()} == {
        f"webair.{operation}" for operation in PACKAGE_TOOLS
    }


def test_every_declared_tool_names_one_published_operation(package, published):
    for tool_id, tool in package.tools.items():
        operation = tool["binding"].removeprefix("webair.")
        assert PACKAGE_TOOLS[operation] == tool_id
        assert operation in published["operations"], operation
        route = published["operations"][operation]
        host, path = endpoint_operation(tool["endpoint"])
        assert host == DECLARED_HOST
        assert path == route["path"] == f"{API_PREFIX}/{operation}"
        assert tool["method"] == route["method"] == "POST"
        assert tool["input_schema"] == input_schema_path(operation)
        assert tool["output_schema"] == output_schema_path(operation)
        assert tool["execution"] == "remote" and tool["retries"] == 0
        assert tool["domains"] == [DECLARED_HOST]


def test_get_flight_stays_an_origin_only_operation(package, published):
    # Every declared tool must be bound and approved before a package can run, and the
    # workflow never needs get_flight, so the package does not ask for it.
    assert "get_flight" in published["operations"]
    assert "get_flight" in OPERATIONS
    assert all(tool["binding"] != "webair.get_flight" for tool in package.tools.values())


# --- schemas ------------------------------------------------------------------------------


@pytest.mark.parametrize("operation", sorted(PACKAGE_TOOLS))
def test_tool_input_schema_is_the_published_request_schema(operation, published):
    package_schema = without_draft(source_json(input_schema_path(operation)))
    assert package_schema == published["operations"][operation]["request_schema"]
    assert package_schema == OPERATIONS[operation][0].model_json_schema()


@pytest.mark.parametrize("operation", sorted(PACKAGE_TOOLS))
def test_tool_output_schema_is_the_published_answer_or_refusal(operation, published):
    package_schema = source_json(output_schema_path(operation))
    # Composed from the HTTP document...
    assert package_schema == tool_output_schema(published, operation)
    # ...and equal to an independent derivation from the origin's models.
    response_model = OPERATIONS[operation][1]
    union = TypeAdapter(response_model | ErrorResponse).json_schema(mode="serialization")
    assert without_draft(package_schema) == union
    definitions = package_schema["$defs"]
    response = published["operations"][operation]["response_schema"]
    assert definitions[response["title"]] == {k: v for k, v in response.items() if k != "$defs"}
    error = published["error_schema"]
    assert definitions["ErrorResponse"] == {k: v for k, v in error.items() if k != "$defs"}


def test_generated_package_files_match_the_origin_now():
    """`python -m publisher check`: schemas and the recorded fixture are current."""
    assert publisher_cli.drift() == []


def test_request_objects_are_closed_at_every_level(package):
    """No URL, header, path or command can be smuggled into a tool call as an extra field."""

    def objects(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                yield node
            for value in node.values():
                yield from objects(value)
        elif isinstance(node, list):
            for value in node:
                yield from objects(value)

    for operation in PACKAGE_TOOLS:
        schema = source_json(input_schema_path(operation))
        found = list(objects(schema))
        assert found, operation
        assert all(node.get("additionalProperties") is False for node in found), operation


def test_answers_are_closed_and_state_their_constant_fields(package):
    purchase = source_json(output_schema_path("simulate_purchase"))["$defs"]
    confirmation = purchase["SimulatedConfirmation"]
    assert confirmation["additionalProperties"] is False
    for name, value in {
        "real_transaction": False,
        "amount_charged_usd": 0,
        "simulated": True,
        "status": "simulated",
        "message": "No real transaction was performed.",
    }.items():
        assert name in confirmation["required"], name
        assert confirmation["properties"][name]["const"] == value, name
    quote = source_json(output_schema_path("prepare_booking"))["$defs"]["BookingQuote"]
    assert "simulated" in quote["required"] and quote["properties"]["simulated"]["const"] is True
    assert purchase["PaymentMethod"]["properties"]["demo"]["const"] is True


# --- semantic identity of the package's own schemas ---------------------------------------


def test_the_model_facing_search_plan_is_the_origin_request_made_explicit(published):
    origin = published["operations"]["search_flights"]["request_schema"]
    plan = source_json("schemas/plan.schema.json")["properties"]["search"]
    assert set(plan["properties"]) == set(origin["properties"])
    # Every argument is required, so a projection of it can never fail at run time.
    assert set(plan["required"]) == set(origin["properties"]) >= set(origin["required"])
    assert plan["additionalProperties"] is False
    fields, origin_fields = plan["properties"], origin["properties"]
    for name in ("origin", "destination"):
        assert fields[name]["enum"] == origin_fields[name]["enum"] == list(inventory.AIRPORTS)
    assert fields["date"]["pattern"] == origin_fields["date"]["pattern"] == DATE_PATTERN
    for name in ("passengers",):
        assert (fields[name]["minimum"], fields[name]["maximum"]) == (
            origin_fields[name]["minimum"],
            origin_fields[name]["maximum"],
        )
    price = next(b for b in origin_fields["max_price_usd"]["anyOf"] if b.get("type") == "integer")
    assert (fields["max_price_usd"]["minimum"], fields["max_price_usd"]["maximum"]) == (
        price["minimum"],
        price["maximum"],
    )
    cabins = next(b for b in origin_fields["cabin"]["anyOf"] if "enum" in b)["enum"]
    assert fields["cabin"]["enum"] == [*cabins, None]


def test_model_facing_fare_ids_use_the_origin_id_format():
    selection = source_json("schemas/selection.schema.json")["properties"]
    answer = source_json("schemas/answer.schema.json")["properties"]
    assert selection["fare_ids"]["items"]["pattern"] == FARE_ID_PATTERN
    assert selection["selected_fare_id"]["pattern"] == FARE_ID_PATTERN
    assert answer["mentioned_fare_ids"]["items"]["pattern"] == FARE_ID_PATTERN


def test_task_inputs_reuse_the_origin_definitions(package, published):
    task = source_json("schemas/input.schema.json")["$defs"]
    booking, purchase = task["Booking"]["properties"], task["Purchase"]["properties"]
    assert booking["passengers"]["$ref"].endswith(
        "prepare_booking.input.schema.json#/properties/passengers"
    )
    assert purchase["quote_id"]["$ref"].endswith(
        "simulate_purchase.input.schema.json#/properties/quote_id"
    )
    request = published["operations"]["simulate_purchase"]["request_schema"]["properties"]
    assert request["quote_id"]["pattern"] == QUOTE_ID_PATTERN
    assert request["payment_method_id"]["enum"] == list(inventory.PAYMENT_METHODS)
    confirmation = published["operations"]["simulate_purchase"]["response_schema"]
    assert confirmation["properties"]["confirmation_id"]["pattern"] == CONFIRMATION_ID_PATTERN


def test_manifest_names_the_published_api(package, published):
    origin = package.manifest["extensions"]["org.webagents.webair:origin"]
    assert (origin["semantic_api"], origin["semantic_api_version"]) == (
        published["api"],
        published["version"],
    )
    assert origin["fictional"] is True


def test_domain_skill_states_the_inventory_it_describes(package):
    skill = package.files["skills/webair-domain/SKILL.md"].decode()
    for code in inventory.AIRPORTS:
        assert f"({code})" in skill, code
    assert "1 October 2026" in skill and "31 December 2027" in skill
    assert (
        inventory.FIRST_BOOKABLE_DATE.isoformat(),
        inventory.LAST_BOOKABLE_DATE.isoformat(),
    ) == (
        "2026-10-01",
        "2027-12-31",
    )
    for family in inventory.FARE_FAMILIES.values():
        assert family.name in skill, family.name


# --- the real API's answers satisfy the package's contracts -------------------------------

SEARCH = {"origin": "BOS", "destination": "ZRH", "date": "2026-10-09"}
BOOKING = {
    "fare_id": "WA101-20261009-STANDARD",
    "passengers": [{"given_name": "Alex", "family_name": "Example"}],
    "contact_email": "alex.example@example.com",
}
REFUSALS = [
    # (operation, arguments, status, error code): one of each refusal a package can see
    ("search_flights", {**SEARCH, "destination": "BOS"}, 422, "invalid_route"),
    ("search_flights", {**SEARCH, "date": "2026-02-30"}, 422, "invalid_date"),
    ("search_flights", {**SEARCH, "date": "2028-10-09"}, 422, "date_out_of_range"),
    ("search_flights", {**SEARCH, "url": "https://elsewhere.example"}, 422, "invalid_request"),
    ("get_fare_rules", {"fare_id": "WA999-20261009-BASIC"}, 404, "unknown_flight"),
    ("get_fare_rules", {"fare_id": "WA105-20261010-BASIC"}, 404, "unknown_flight"),
    ("prepare_booking", {**BOOKING, "fare_id": "WA213-20261009-BUSINESS"}, 404, "unknown_fare"),
    (
        "prepare_booking",
        {**BOOKING, "fare_id": "WA105-20261009-BUSINESS", "passengers": BOOKING["passengers"] * 3},
        422,
        "insufficient_seats",
    ),
    (
        "simulate_purchase",
        {
            "booking": BOOKING,
            "quote_id": "WAQ-0000000000000000",
            "payment_method_id": "demo-visa-4242",
        },
        422,
        "quote_mismatch",
    ),
]


def validates(package, path, value):
    errors = list(schema_validator(package.files, path).iter_errors(value))
    return not errors


def test_successful_answers_satisfy_the_package_output_schemas(client, package):
    search = client.post("/api/v1/search_flights", json=SEARCH)
    rules = client.post("/api/v1/get_fare_rules", json={"fare_id": BOOKING["fare_id"]})
    quote = client.post("/api/v1/prepare_booking", json=BOOKING)
    purchase = client.post(
        "/api/v1/simulate_purchase",
        json={
            "booking": BOOKING,
            "quote_id": quote.json()["quote_id"],
            "payment_method_id": "demo-travel-1234",
        },
    )
    for operation, response in [
        ("search_flights", search),
        ("get_fare_rules", rules),
        ("prepare_booking", quote),
        ("simulate_purchase", purchase),
    ]:
        assert response.status_code == 200, operation
        assert validates(package, output_schema_path(operation), response.json()), operation
        # It is the answer branch, not the refusal branch, that accepts it.
        body = response.json()
        assert "error" not in body
    assert validates(package, "schemas/fare-rule.schema.json", rules.json())
    assert validates(package, "schemas/booking-quote.schema.json", quote.json())
    assert validates(package, "schemas/simulated-confirmation.schema.json", purchase.json())


@pytest.mark.parametrize("operation,arguments,status,code", REFUSALS)
def test_refusals_satisfy_the_package_output_schemas(
    client, package, operation, arguments, status, code
):
    response = client.post(f"/api/v1/{operation}", json=arguments)
    assert response.status_code == status and response.json()["error"]["code"] == code
    # A json_http binding hands 400/404/422 bodies to the package as data.
    assert validates(package, output_schema_path(operation), response.json())
    assert validates(package, "schemas/refusal.schema.json", response.json()["error"])


def test_package_input_validation_refuses_what_the_origin_refuses(package):
    """Malformed tool arguments are stopped before dispatch by the same schema."""
    for operation, arguments, status, code in REFUSALS:
        accepted = validates(package, input_schema_path(operation), arguments)
        assert accepted is (code != "invalid_request"), (operation, code)


def test_published_patterns_match_their_constants(published):
    text = json.dumps(published)
    for pattern in (FARE_ID_PATTERN, QUOTE_ID_PATTERN, DATE_PATTERN):
        assert json.dumps(pattern)[1:-1] in text
        re.compile(pattern)
