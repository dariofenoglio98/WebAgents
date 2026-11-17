"""The services the Agent Links example packages call (T65, D-683, D-695): the named hotel's own
availability service, and the agreement between each package and the origin that answers it: a
package's tool names the service's path on its publisher's host, its schemas accept the
answers, and its fixture records exactly what the origin answers."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from origin.hotel import HOTEL_CITY, HOTEL_ID, HOTEL_NAME, HOTEL_PREFIX, ROOMS
from origin.travel import HOTELS, TRAVEL_PREFIX

AGENTS = Path(__file__).resolve().parents[3] / "agents"
WEBAIR = "webagents-webair-production.up.railway.app"
# Each package's remote tool: (package, tool, its publisher's host, the service's path).
TOOLS = [
    ("webair-flights", "search-flights", WEBAIR, f"{TRAVEL_PREFIX}/flights"),
    (
        "staymere-hotels",
        "search-hotels",
        "webagents-staymere-production.up.railway.app",
        f"{TRAVEL_PREFIX}/hotels",
    ),
    (
        "hotel-salitubam",
        "check-availability",
        "webagents-hotel-salitubam-production.up.railway.app",
        f"{HOTEL_PREFIX}/availability",
    ),
    ("travel-planner", "check-calendar", WEBAIR, f"{TRAVEL_PREFIX}/calendar"),
]


def stay(client, payload):
    return client.post(f"{HOTEL_PREFIX}/availability", json=payload)


def _domains(path):
    return json.loads(path.read_text(encoding="utf-8"))["domains"]


def _json(package, path):
    return json.loads((AGENTS / package / path).read_text(encoding="utf-8"))


def _validator(package, schema_path):
    registry = Registry()
    for path in (AGENTS / package / "schemas").glob("*.json"):
        registry = registry.with_resource(
            f"schemas/{path.name}", Resource.from_contents(json.loads(path.read_text()))
        )
    return Draft202012Validator(
        {"$ref": schema_path}, registry=registry, format_checker=FormatChecker()
    )


def test_one_offer_per_room_priced_per_room_and_night(client):
    response = stay(client, {"check_in": "2027-05-01", "check_out": "2027-05-04", "travellers": 3})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    answer = response.json()
    assert answer["hotel"] == {"id": HOTEL_ID, "name": HOTEL_NAME, "city": HOTEL_CITY}
    assert [
        (o["id"], o["room"], o["rooms"], o["nights"], o["price_usd"]) for o in answer["offers"]
    ] == [
        (f"{room_id}-20270501-3N", name, -(-3 // guests), 3, nightly * 3 * -(-3 // guests))
        for room_id, name, guests, nightly in ROOMS
    ]
    # Deterministic: the same request, the same answer.
    again = stay(client, {"check_in": "2027-05-01", "check_out": "2027-05-04", "travellers": 3})
    assert again.json() == answer


def test_the_hotel_is_not_one_the_aggregator_lists():
    listed = {(hotel_id, name) for hotels in HOTELS.values() for hotel_id, name, _ in hotels}
    assert HOTEL_ID not in {hotel_id for hotel_id, _ in listed}
    assert HOTEL_NAME not in {name for _, name in listed}
    assert HOTEL_CITY in HOTELS


@pytest.mark.parametrize(
    "payload,code",
    [
        ({"check_in": "2027-03-14", "check_out": "2027-03-09", "travellers": 1}, "invalid_stay"),
        ({"check_in": "2027-03-09", "check_out": "2027-03-09", "travellers": 1}, "invalid_stay"),
        ({"check_in": "2027-02-30", "check_out": "2027-03-09", "travellers": 1}, "invalid_date"),
        ({"check_in": "2027-03-09", "check_out": "2027-03-14", "travellers": 0}, "invalid_request"),
        ({"check_in": "2027-03-09", "check_out": "2027-03-14", "travellers": 7}, "invalid_request"),
        ({"check_in": "2027-03-09", "check_out": "2027-03-14"}, "invalid_request"),
        (
            {"check_in": "2027-03-09", "check_out": "2027-03-14", "travellers": 1, "notes": "x"},
            "invalid_request",
        ),
    ],
)
def test_refusals(client, payload, code):
    response = stay(client, payload)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == code


def test_a_non_json_body_is_refused(client):
    response = client.post(f"{HOTEL_PREFIX}/availability", content=b"check_in=2027-03-09")
    assert response.status_code == 415


@pytest.mark.parametrize("package,tool_id,host,path", TOOLS)
def test_each_package_tool_names_its_publishers_service(package, tool_id, host, path):
    tool = _json(package, f"tools/{tool_id}.tool.json")
    assert tool["execution"] == "remote" and tool["method"] == "POST"
    assert tool["endpoint"] == f"https://{host}{path}"
    assert tool["domains"] == [host] and tool["side_effects"] == "read"
    policy = _json(package, "policy/policy.json")
    # A package reaches exactly the hosts its tools name: the planner 0.2.0 also its own search
    # service (`web.search`, D-696), the others only the service above.
    domains = sorted(
        {d for path in (AGENTS / package / "tools").glob("*.tool.json") for d in _domains(path)}
    )
    assert host in domains and sorted(policy["network"]["allowed_domains"]) == domains


@pytest.mark.parametrize("package,tool_id,host,path", TOOLS)
def test_each_fixture_records_what_the_origin_answers(client, package, tool_id, host, path):
    """Fixture mode and a live run see the same data: every tool case of the package's fixture
    is this origin's answer, valid under the package's own schemas."""
    tool = _json(package, f"tools/{tool_id}.tool.json")
    cases = _json(package, "fixtures/workflow.json")["tools"][tool_id]
    assert cases
    for case in cases:
        _validator(package, tool["input_schema"]).validate(case["input"])
        response = client.post(path, json=case["input"])
        assert response.status_code == 200, response.text
        assert response.json() == case["output"]
        _validator(package, tool["output_schema"]).validate(response.json())
