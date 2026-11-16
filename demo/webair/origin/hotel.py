"""One fictional small hotel's availability service, for Agent Links (T65, D-683, D-695).

`org.webagents.hotel-salitubam` is the package a travel planner may find while it runs: the
hotel a person named, which the aggregator does not list. Its one tool is a remote POST tool on
the hotel's own service; in a live run that tool needs an origin to answer it, and this module
is that origin, at `POST /api/v1/hotel/availability`, with the request and answer shapes of the
package's own tool schemas. The hotel has its own hostname; a stack that serves it maps that
hostname here.

Everything is fictional and deterministic: the same request gets the same answer, nothing is
reserved, and nothing is stored. The package's fixture records exactly these answers
(`test_hotel.py` checks it).
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Request
from pydantic import Field

from .api import json_endpoint
from .inventory import MAX_PASSENGERS
from .models import DATE_PATTERN, _Request, _Response
from .service import WebAirError

HOTEL_PREFIX = "/api/v1/hotel"
MAX_NIGHTS = 30
HOTEL_ID = "SALITUBAM"
HOTEL_NAME = "Hotel Salitubam (fictional)"
#: The WebAir airport that serves the hotel's city (Reykjavik).
HOTEL_CITY = "KEF"
# The hotel's rooms, cheapest first: (id, name, guests per room, nightly USD).
ROOMS: tuple[tuple[str, str, int, int], ...] = (
    ("SAL-STD", "Standard double", 2, 182),
    ("SAL-FAM", "Family room", 4, 246),
    ("SAL-HRB", "Harbour suite", 2, 318),
)


class AvailabilityRequest(_Request):
    check_in: str = Field(pattern=DATE_PATTERN)
    check_out: str = Field(pattern=DATE_PATTERN)
    travellers: int = Field(ge=1, le=MAX_PASSENGERS)


class Hotel(_Response):
    id: str
    name: str
    city: str


class Offer(_Response):
    id: str
    room: str
    rooms: int
    nights: int
    price_usd: int


class AvailabilityResponse(_Response):
    hotel: Hotel
    offers: list[Offer]


def _day(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise WebAirError("invalid_date", f"{field} is not a calendar date.", field=field) from exc


def availability(request: AvailabilityRequest) -> AvailabilityResponse:
    """One offer per room type for the stay: as many rooms as the party needs, priced per room
    and night. The offer's id names the room, the first night and the number of nights."""
    check_in = _day(request.check_in, "check_in")
    nights = (_day(request.check_out, "check_out") - check_in).days
    if not 1 <= nights <= MAX_NIGHTS:
        raise WebAirError(
            "invalid_stay", f"A stay is 1 to {MAX_NIGHTS} nights.", field="check_out"
        )
    offers = []
    for room_id, name, guests, nightly in ROOMS:
        rooms = -(-request.travellers // guests)
        offers.append(
            Offer(
                id=f"{room_id}-{check_in.strftime('%Y%m%d')}-{nights}N",
                room=name,
                rooms=rooms,
                nights=nights,
                price_usd=nightly * nights * rooms,
            )
        )
    return AvailabilityResponse(
        hotel=Hotel(id=HOTEL_ID, name=HOTEL_NAME, city=HOTEL_CITY), offers=offers
    )


def router() -> APIRouter:
    routes = APIRouter(prefix=HOTEL_PREFIX)

    def call(request: Request, arguments: AvailabilityRequest) -> AvailabilityResponse:
        return availability(arguments)

    endpoint = json_endpoint(
        "availability", AvailabilityRequest, call, label="hotel availability"
    )
    endpoint.__name__ = "hotel_availability"
    routes.add_api_route("/availability", endpoint, methods=["POST"], include_in_schema=False)
    return routes
