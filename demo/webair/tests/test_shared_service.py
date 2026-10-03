"""Both interfaces are transports over one WebAirService instance, with no logic of their own."""

import ast
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from htmltools import Page

from origin.app import create_app
from origin.service import WebAirService

OPERATIONS = (
    "search_flights",
    "get_flight",
    "get_fare_rules",
    "prepare_booking",
    "simulate_purchase",
)
ORIGIN = Path(__file__).resolve().parents[1] / "origin"


class RecordingService(WebAirService):
    def __init__(self):
        super().__init__()
        self.calls = []

    def __getattribute__(self, name):
        attribute = super().__getattribute__(name)
        if name in OPERATIONS:

            def recorded(*args, **kwargs):
                self.calls.append(name)
                return attribute(*args, **kwargs)

            return recorded
        return attribute


@pytest.fixture
def recording():
    app = create_app()
    app.state.service = RecordingService()
    with TestClient(app) as client:
        yield client, app.state.service


def test_human_pages_call_the_shared_service(recording):
    client, service = recording
    client.get("/results?origin=BOS&destination=ZRH&date=2026-10-09")
    client.get("/flight/WA101-20261009")
    client.get("/fare/WA101-20261009-FLEX")
    client.get("/passenger?fare_id=WA101-20261009-FLEX&passengers=1")
    payment = client.post(
        "/payment",
        data={
            "fare_id": "WA101-20261009-FLEX",
            "passengers": "1",
            "given_name_1": "Ada",
            "family_name_1": "Lovelace",
            "contact_email": "ada@example.com",
        },
    )
    client.post("/confirmation", data=Page(payment.text).form("/confirmation").values())
    assert set(service.calls) == set(OPERATIONS)


def test_api_calls_the_shared_service(recording):
    client, service = recording
    booking = {
        "fare_id": "WA101-20261009-FLEX",
        "passengers": [{"given_name": "Ada", "family_name": "Lovelace"}],
        "contact_email": "ada@example.com",
    }
    client.post(
        "/api/v1/search_flights", json={"origin": "BOS", "destination": "ZRH", "date": "2026-10-09"}
    )
    client.post("/api/v1/get_flight", json={"flight_id": "WA101-20261009"})
    client.post("/api/v1/get_fare_rules", json={"fare_id": "WA101-20261009-FLEX"})
    quote = client.post("/api/v1/prepare_booking", json=booking).json()
    client.post(
        "/api/v1/simulate_purchase",
        json={
            "booking": booking,
            "quote_id": quote["quote_id"],
            "payment_method_id": "demo-visa-4242",
        },
    )
    assert set(service.calls) == set(OPERATIONS)


def test_interfaces_hold_no_pricing_or_inventory_logic():
    """Only the service reads schedules, itineraries, fare families or weekday prices."""
    business_data = {
        "SEGMENTS",
        "ITINERARIES",
        "FARE_FAMILIES",
        "WEEKDAY_PRICE_PERCENT",
        "PAYMENT_METHODS",
    }
    for name in ("web.py", "api.py", "app.py", "agent_package.py"):
        tree = ast.parse((ORIGIN / name).read_text(encoding="utf-8"))
        used = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
        used |= {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        assert not used & business_data, name
