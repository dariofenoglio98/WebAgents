"""The semantic JSON API: shape, schemas, success paths and refusals."""

import json
import re

import pytest

from origin.api import MAX_JSON_BYTES, OPERATIONS
from origin.models import (
    BookingQuote,
    FareRules,
    FlightOffer,
    SearchFlightsRequest,
    SearchFlightsResponse,
    SimulatedConfirmation,
)

SEARCH = {"origin": "BOS", "destination": "ZRH", "date": "2026-10-09"}
BOOKING = {
    "fare_id": "WA101-20261009-STANDARD",
    "passengers": [
        {"given_name": "Ada", "family_name": "Lovelace"},
        {"given_name": "Alan", "family_name": "Turing"},
    ],
    "contact_email": "ada@example.com",
}


def post(client, operation, payload):
    return client.post(f"/api/v1/{operation}", json=payload)


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert response.headers["content-type"] == "application/json"
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == code
    assert body["error"]["message"]
    return body["error"]


# --- schemas ----------------------------------------------------------------------------------


def test_schema_document_describes_every_operation(client):
    document = client.get("/api/v1/schemas").json()
    assert set(document["operations"]) == {
        "search_flights",
        "get_flight",
        "get_fare_rules",
        "prepare_booking",
        "simulate_purchase",
    }
    for name, operation in document["operations"].items():
        assert operation["method"] == "POST"
        assert operation["path"] == f"/api/v1/{name}"
        assert operation["request_schema"]["type"] == "object"
        assert operation["request_schema"]["additionalProperties"] is False, name
        assert operation["response_schema"]["type"] == "object"
    assert document["transport"]["max_request_bytes"] == MAX_JSON_BYTES
    assert set(document["error_statuses"]) == {"400", "404", "413", "415", "422"}
    search = document["operations"]["search_flights"]["request_schema"]
    assert search["required"] == ["origin", "destination", "date"]
    assert search["properties"]["origin"]["enum"] == ["BOS", "JFK", "ZRH", "GVA", "LHR", "KEF"]
    assert search["properties"]["passengers"]["maximum"] == 6
    purchase = document["operations"]["simulate_purchase"]["request_schema"]
    assert purchase["properties"]["payment_method_id"]["enum"] == [
        "demo-visa-4242",
        "demo-travel-1234",
    ]


def test_every_nested_request_object_is_closed(client):
    document = client.get("/api/v1/schemas").json()
    for operation in document["operations"].values():
        schema = operation["request_schema"]
        for definition in schema.get("$defs", {}).values():
            if definition.get("type") == "object":
                assert definition["additionalProperties"] is False


def test_published_patterns_are_portable(client):
    """Every schema pattern compiles in Python's `re` (as `jsonschema` uses), not only in Rust."""
    patterns = []

    def walk(node):
        if isinstance(node, dict):
            if isinstance(node.get("pattern"), str):
                patterns.append(node["pattern"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(client.get("/api/v1/schemas").json())
    assert len(patterns) >= 6
    for pattern in patterns:
        re.compile(pattern)
        assert "\\p{" not in pattern


def test_only_the_declared_operations_exist(client):
    assert set(OPERATIONS) == {
        "search_flights",
        "get_flight",
        "get_fare_rules",
        "prepare_booking",
        "simulate_purchase",
    }
    assert_error(post(client, "delete_booking", {}), 404, "not_found")
    # Dot segments are resolved before routing: this is /api/agent.pkg, which does not exist.
    assert post(client, "../agent.pkg", {}).status_code == 404
    assert_error(client.get("/api/v1/search_flights"), 405, "method_not_allowed")
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


# --- success paths ----------------------------------------------------------------------------


def test_search_flights(client, service):
    response = post(client, "search_flights", SEARCH | {"nonstop_only": True, "max_price_usd": 900})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    body = response.json()
    SearchFlightsResponse.model_validate(body)
    assert [f["flight_id"] for f in body["flights"]] == ["WA101-20261009", "WA105-20261009"]
    assert [[x["price_usd"] for x in f["fares"]] for f in body["flights"]] == [[704, 858], [749]]
    assert body["query"] == {
        **SEARCH,
        "passengers": 1,
        "nonstop_only": True,
        "max_price_usd": 900,
        "cabin": None,
    }
    expected = service.search_flights(SearchFlightsRequest(**body["query"]))
    assert body == expected.model_dump(mode="json"), "the API is a transport over the service"


def test_get_flight_and_fare_rules(client):
    flight = post(client, "get_flight", {"flight_id": "WA205-WA731-20261009", "passengers": 2})
    assert flight.status_code == 200
    offer = FlightOffer.model_validate(flight.json())
    assert (offer.stops, offer.via, len(offer.fares)) == (1, ["KEF"], 3)
    rules = post(
        client, "get_fare_rules", {"fare_id": "WA205-WA731-20261009-FLEX", "passengers": 2}
    )
    assert rules.status_code == 200
    fare = FareRules.model_validate(rules.json())
    assert (fare.total_usd, fare.refunds.refundable, fare.baggage.checked_bags) == (1724, True, 2)


def test_prepare_then_simulate_purchase(client):
    quoted = post(client, "prepare_booking", BOOKING)
    assert quoted.status_code == 200
    quote = BookingQuote.model_validate(quoted.json())
    assert quote.total_usd == 1716 and quote.simulated is True
    purchased = post(
        client,
        "simulate_purchase",
        {"booking": BOOKING, "quote_id": quote.quote_id, "payment_method_id": "demo-travel-1234"},
    )
    assert purchased.status_code == 200
    confirmation = SimulatedConfirmation.model_validate(purchased.json())
    assert confirmation.message == "No real transaction was performed."
    assert (confirmation.real_transaction, confirmation.amount_charged_usd) == (False, 0)
    assert confirmation.total_usd == 1716
    again = post(
        client,
        "simulate_purchase",
        {"booking": BOOKING, "quote_id": quote.quote_id, "payment_method_id": "demo-travel-1234"},
    )
    assert again.json() == purchased.json(), "deterministic and idempotent"


def test_responses_are_not_cached(client):
    assert post(client, "search_flights", SEARCH).headers["cache-control"] == "no-store"


# --- refusals ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        SEARCH | {"passengers": "2"},  # strict: no string-to-int coercion
        SEARCH | {"passengers": 2.0},
        SEARCH | {"passengers": 0},
        SEARCH | {"passengers": 7},
        SEARCH | {"nonstop_only": "yes"},
        SEARCH | {"origin": "bos"},
        SEARCH | {"origin": "XXX"},
        SEARCH | {"date": "09/10/2026"},
        SEARCH | {"date": "2026-10-09T00:00:00"},
        SEARCH | {"max_price_usd": -1},
        SEARCH | {"cabin": "first"},
        SEARCH | {"url": "https://example.com"},  # unknown fields are refused, not ignored
        {"origin": "BOS", "destination": "ZRH"},
        [],
        "BOS",
        None,
    ],
)
def test_search_schema_violations(client, payload):
    response = client.post(
        "/api/v1/search_flights",
        content=json.dumps(payload),
        headers={"content-type": "application/json"},
    )
    error = assert_error(response, 422, "invalid_request")
    assert error["details"]


def test_validation_errors_name_the_field(client):
    error = assert_error(
        post(client, "search_flights", SEARCH | {"passengers": 9}), 422, "invalid_request"
    )
    assert [d["field"] for d in error["details"]] == ["passengers"]


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        (SEARCH | {"destination": "BOS"}, "invalid_route"),
        (SEARCH | {"date": "2026-02-30"}, "invalid_date"),
        (SEARCH | {"date": "2025-10-09"}, "date_out_of_range"),
    ],
)
def test_search_domain_refusals(client, payload, code):
    error = assert_error(post(client, "search_flights", payload), 422, code)
    assert error["details"][0]["field"] in {"destination", "date"}


def test_unknown_flight_and_fare(client):
    assert_error(post(client, "get_flight", {"flight_id": "WA999-20261009"}), 404, "unknown_flight")
    assert_error(post(client, "get_flight", {"flight_id": "WA105-20261006"}), 404, "unknown_flight")
    assert_error(
        post(client, "get_fare_rules", {"fare_id": "WA213-20261009-BUSINESS"}), 404, "unknown_fare"
    )
    assert_error(
        post(client, "get_flight", {"flight_id": "../../etc/passwd"}), 422, "invalid_request"
    )


def test_booking_refusals(client):
    assert_error(
        post(client, "prepare_booking", BOOKING | {"passengers": []}), 422, "invalid_request"
    )
    assert_error(
        post(
            client,
            "prepare_booking",
            BOOKING
            | {"fare_id": "WA105-20261009-BUSINESS", "passengers": BOOKING["passengers"] * 2},
        ),
        422,
        "insufficient_seats",
    )
    quote_id = post(client, "prepare_booking", BOOKING).json()["quote_id"]
    tampered = BOOKING | {"fare_id": "WA101-20261009-BASIC"}
    assert_error(
        post(
            client,
            "simulate_purchase",
            {"booking": tampered, "quote_id": quote_id, "payment_method_id": "demo-visa-4242"},
        ),
        422,
        "quote_mismatch",
    )
    assert_error(
        post(
            client,
            "simulate_purchase",
            {"booking": BOOKING, "quote_id": quote_id, "payment_method_id": "visa"},
        ),
        422,
        "invalid_request",
    )


@pytest.mark.parametrize(
    "extra",
    [
        {"card_number": "4242424242424242"},
        {"cvc": "123"},
        {"payment_token": "tok_live_x"},
    ],
)
def test_purchase_accepts_no_payment_credentials(client, extra):
    quote_id = post(client, "prepare_booking", BOOKING).json()["quote_id"]
    payload = {"booking": BOOKING, "quote_id": quote_id, "payment_method_id": "demo-visa-4242"}
    assert_error(post(client, "simulate_purchase", payload | extra), 422, "invalid_request")


def test_errors_do_not_echo_submitted_values(client):
    secret = "Zzyzx-Unique-Value"
    payload = BOOKING | {
        "contact_email": f"{secret}@",
        "passengers": [{"given_name": f"{secret}<", "family_name": "X"}],
    }
    response = post(client, "prepare_booking", payload)
    assert response.status_code == 422
    assert secret not in response.text


def test_transport_refusals(client):
    assert_error(
        client.post(
            "/api/v1/search_flights",
            content=b"{not json",
            headers={"content-type": "application/json"},
        ),
        400,
        "invalid_json",
    )
    assert_error(
        client.post(
            "/api/v1/search_flights",
            content=json.dumps(SEARCH),
            headers={"content-type": "text/plain"},
        ),
        415,
        "unsupported_media_type",
    )
    assert_error(client.post("/api/v1/search_flights", data=SEARCH), 415, "unsupported_media_type")
    padded = json.dumps(SEARCH | {"padding": "x" * MAX_JSON_BYTES})
    assert_error(
        client.post(
            "/api/v1/search_flights", content=padded, headers={"content-type": "application/json"}
        ),
        413,
        "request_too_large",
    )


def test_body_limit_holds_without_a_content_length(client):
    def chunks():
        for _ in range(5):
            yield b" " * (MAX_JSON_BYTES // 4)

    response = client.post(
        "/api/v1/search_flights", content=chunks(), headers={"content-type": "application/json"}
    )
    assert_error(response, 413, "request_too_large")
