"""The travel network's partner services (T26, D-290): shape, refusals, and agreement with the
package that calls them (`agents/travel-network`): its tools name these endpoints, its schemas
accept these answers, and its fixture records exactly what the origin answers for its walk."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from origin.travel import CALENDAR, HOTELS, OPERATIONS, TRAVEL_PREFIX

PACKAGE = Path(__file__).resolve().parents[3] / "agents" / "travel-network"
HOST = "webagents-webair-production.up.railway.app"
TOOLS = {"search-flights": "flights", "search-hotels": "hotels", "check-calendar": "calendar"}


def post(client, operation, payload):
    return client.post(f"{TRAVEL_PREFIX}/{operation}", json=payload)


def _json(path):
    return json.loads((PACKAGE / path).read_text(encoding="utf-8"))


def _validator(schema_path):
    """The package's own schema, its relative references resolved inside the package."""
    registry = Registry()
    for path in (PACKAGE / "schemas").glob("*.json"):
        registry = registry.with_resource(
            f"schemas/{path.name}", Resource.from_contents(json.loads(path.read_text()))
        )
    return Draft202012Validator(
        {"$ref": schema_path}, registry=registry, format_checker=FormatChecker()
    )


def test_flights_come_from_webair_inventory(client, service):
    from origin.models import SearchFlightsRequest

    response = post(
        client,
        "flights",
        {"origin": "BOS", "destination": "ZRH", "date": "2027-03-09", "travellers": 2},
    )
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    options = response.json()["options"]
    found = service.search_flights(
        SearchFlightsRequest(origin="BOS", destination="ZRH", date="2027-03-09", passengers=2)
    )
    assert [o["id"] for o in options] == [f.flight_id for f in found.flights]
    assert [o["price_usd"] for o in options] == [f.lowest_price_usd for f in found.flights]
    assert all(o["carrier"] == "WebAir" for o in options)


def test_hotels_are_priced_per_night_and_calendar_filters_by_range(client):
    hotels = post(
        client, "hotels", {"city": "GVA", "check_in": "2027-05-01", "check_out": "2027-05-04"}
    ).json()["options"]
    assert [(h["id"], h["nights"], h["price_usd"]) for h in hotels] == [
        (hotel_id, 3, nightly * 3) for hotel_id, _, nightly in HOTELS["GVA"]
    ]
    entries = post(client, "calendar", {"from": "2027-01-01", "to": "2027-02-28"}).json()
    assert entries == {"entries": [{"date": d, "title": t} for d, t in CALENDAR[:2]]}
    assert post(client, "calendar", {"from": "2027-07-01", "to": "2027-07-01"}).json() == {
        "entries": []
    }


@pytest.mark.parametrize(
    "operation,payload,status,code",
    [
        (
            "flights",
            {"origin": "BOS", "destination": "BOS", "date": "2027-03-09", "travellers": 1},
            422,
            "invalid_route",
        ),
        (
            "flights",
            {"origin": "BOS", "destination": "ZRH", "date": "2027-03-09"},
            422,
            "invalid_request",
        ),
        (
            "hotels",
            {"city": "ZRH", "check_in": "2027-03-14", "check_out": "2027-03-09"},
            422,
            "invalid_stay",
        ),
        (
            "hotels",
            {"city": "ZRH", "check_in": "2027-02-30", "check_out": "2027-03-09"},
            422,
            "invalid_date",
        ),
        (
            "hotels",
            {"city": "PAR", "check_in": "2027-03-09", "check_out": "2027-03-14"},
            422,
            "invalid_request",
        ),
        ("calendar", {"from": "2027-01-01", "to": "2027-12-31"}, 422, "invalid_range"),
        (
            "calendar",
            {"from": "2027-01-01", "to": "2027-01-02", "extra": 1},
            422,
            "invalid_request",
        ),
    ],
)
def test_refusals(client, operation, payload, status, code):
    response = post(client, operation, payload)
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code


def test_a_non_json_body_is_refused(client):
    response = client.post(f"{TRAVEL_PREFIX}/hotels", content=b"city=ZRH")
    assert response.status_code == 415


def test_the_package_tools_name_these_endpoints():
    for tool_id, operation in TOOLS.items():
        tool = _json(f"tools/{tool_id}.tool.json")
        assert operation in OPERATIONS
        assert tool["execution"] == "remote" and tool["method"] == "POST"
        assert tool["endpoint"] == f"https://{HOST}{TRAVEL_PREFIX}/{operation}"
        assert tool["domains"] == [HOST] and tool["side_effects"] == "read"


def test_the_fixture_records_what_the_origin_answers(client):
    """The package's fixture walk replays exactly this origin's answers, and each answer is valid
    under the package's own output schema: fixture mode and a live run see the same data."""
    fixture = _json("fixtures/workflow.json")
    for tool_id, operation in TOOLS.items():
        tool = _json(f"tools/{tool_id}.tool.json")
        cases = fixture["tools"][tool_id]
        assert cases, tool_id
        for case in cases:
            _validator(tool["input_schema"]).validate(case["input"])
            response = post(client, operation, case["input"])
            assert response.status_code == 200, response.text
            assert response.json() == case["output"], tool_id
            _validator(tool["output_schema"]).validate(response.json())
