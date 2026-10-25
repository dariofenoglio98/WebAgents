"""Three fictional partner services beside WebAir's own API, for the travel network (T26, D-290).

`org.webagents.travel-network` is a network.v0 package: a front man consults a flights, a hotel
and a calendar role, each of which calls one tool. In a live run those tools are remote POST
tools bound by the host's generic HTTPS JSON binding, so they need an origin to answer them; this
module is that origin, at `POST /api/v1/travel/{flights,hotels,calendar}`, with the request and
answer shapes of the package's own tool schemas.

- `flights` answers from WebAir's own inventory (`WebAirService.search_flights`), one row per
  flight with its lowest available fare, so the network and the airline agree.
- `hotels` answers from a fixed table of two fictional hotels per WebAir city, priced per night.
- `calendar` answers from one fixed, fictional traveller's calendar.

Everything is fictional and deterministic: the same request gets the same answer, nothing is
reserved, and nothing is stored. The package's fixture records exactly these answers for its
fixture walk (`test_travel.py` checks it).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from .api import MAX_JSON_BYTES, _validation_details, error_response
from .bodies import BodyTooLarge, media_type, read_bounded_body
from .models import DATE_PATTERN, AirportCode, SearchFlightsRequest, _Request, _Response
from .service import WebAirError, WebAirService

TRAVEL_PREFIX = "/api/v1/travel"
MAX_NIGHTS = 30
MAX_CALENDAR_DAYS = 62

# Two fictional hotels per city, by the WebAir airport that serves it: (id, name, nightly USD).
HOTELS: dict[str, tuple[tuple[str, str, int], ...]] = {
    "BOS": (
        ("H-BAY", "Back Bay Rooms (fictional)", 210),
        ("H-HAR", "Harborview Hotel (fictional)", 265),
    ),
    "JFK": (
        ("H-MID", "Midtown Stay (fictional)", 240),
        ("H-PRK", "Parkside Hotel (fictional)", 310),
    ),
    "ZRH": (
        ("H-ALT", "Hotel Altstadt (fictional)", 190),
        ("H-SEE", "Seeblick Inn (fictional)", 224),
    ),
    "GVA": (("H-LAC", "Hôtel du Lac (fictional)", 205), ("H-RHO", "Rhône Rooms (fictional)", 238)),
    "LHR": (
        ("H-KEN", "Kensington Rooms (fictional)", 230),
        ("H-RIV", "Riverside Hotel (fictional)", 275),
    ),
    "KEF": (
        ("H-HAF", "Harbour Guesthouse (fictional)", 170),
        ("H-AUR", "Aurora Hotel (fictional)", 215),
    ),
}
# One fictional traveller's calendar.
CALENDAR: tuple[tuple[str, str], ...] = (
    ("2027-01-18", "Project review (fixed)"),
    ("2027-02-04", "Dentist (movable)"),
    ("2027-03-11", "Group meeting (movable)"),
    ("2027-03-23", "Seminar talk (fixed)"),
    ("2027-04-15", "Thesis committee (fixed)"),
    ("2027-06-02", "Conference travel (fixed)"),
)


class FlightsRequest(_Request):
    origin: AirportCode
    destination: AirportCode
    date: str = Field(pattern=DATE_PATTERN, description="Local departure date, YYYY-MM-DD")
    travellers: int = Field(ge=1, le=9)


class FlightRow(_Response):
    id: str
    carrier: str
    depart: str
    stops: int
    price_usd: int


class FlightsResponse(_Response):
    options: list[FlightRow]


class HotelsRequest(_Request):
    city: AirportCode
    check_in: str = Field(pattern=DATE_PATTERN)
    check_out: str = Field(pattern=DATE_PATTERN)


class HotelRow(_Response):
    id: str
    name: str
    nights: int
    price_usd: int


class HotelsResponse(_Response):
    options: list[HotelRow]


class CalendarRequest(_Request):
    from_: str = Field(alias="from", pattern=DATE_PATTERN)
    to: str = Field(pattern=DATE_PATTERN)


class CalendarEntry(_Response):
    date: str
    title: str


class CalendarResponse(_Response):
    entries: list[CalendarEntry]


def _day(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise WebAirError("invalid_date", f"{field} is not a calendar date.", field=field) from exc


class TravelPartners:
    """The three services over WebAir's own inventory and two fixed tables."""

    def __init__(self, airline: WebAirService) -> None:
        self._airline = airline

    def flights(self, request: FlightsRequest) -> FlightsResponse:
        found = self._airline.search_flights(
            SearchFlightsRequest(
                origin=request.origin,
                destination=request.destination,
                date=request.date,
                passengers=request.travellers,
            )
        )
        return FlightsResponse(
            options=[
                FlightRow(
                    id=flight.flight_id,
                    carrier="WebAir",
                    depart=flight.departure_local,
                    stops=flight.stops,
                    price_usd=flight.lowest_price_usd,
                )
                for flight in found.flights
                if flight.lowest_price_usd is not None
            ]
        )

    def hotels(self, request: HotelsRequest) -> HotelsResponse:
        check_in = _day(request.check_in, "check_in")
        nights = (_day(request.check_out, "check_out") - check_in).days
        if not 1 <= nights <= MAX_NIGHTS:
            raise WebAirError(
                "invalid_stay", f"A stay is 1 to {MAX_NIGHTS} nights.", field="check_out"
            )
        return HotelsResponse(
            options=[
                HotelRow(id=hotel_id, name=name, nights=nights, price_usd=nightly * nights)
                for hotel_id, name, nightly in HOTELS[request.city]
            ]
        )

    def calendar(self, request: CalendarRequest) -> CalendarResponse:
        start, end = _day(request.from_, "from"), _day(request.to, "to")
        if not 0 <= (end - start).days <= MAX_CALENDAR_DAYS:
            raise WebAirError(
                "invalid_range", f"A range is 0 to {MAX_CALENDAR_DAYS} days.", field="to"
            )
        return CalendarResponse(
            entries=[
                CalendarEntry(date=day, title=title)
                for day, title in CALENDAR
                if start <= date.fromisoformat(day) <= end
            ]
        )


OPERATIONS: dict[str, type[BaseModel]] = {
    "flights": FlightsRequest,
    "hotels": HotelsRequest,
    "calendar": CalendarRequest,
}


def _endpoint(name: str, request_model: type[BaseModel]) -> Callable:
    async def endpoint(request: Request) -> JSONResponse:
        if media_type(request) != "application/json":
            return error_response(
                415, "unsupported_media_type", "Send the arguments as an application/json body."
            )
        try:
            body = await read_bounded_body(request, MAX_JSON_BYTES)
        except BodyTooLarge:
            return error_response(
                413, "request_too_large", f"Request bodies are limited to {MAX_JSON_BYTES} bytes."
            )
        try:
            arguments = request_model.model_validate_json(body, strict=True)
        except ValidationError as exc:
            if any(err["type"] == "json_invalid" for err in exc.errors()):
                return error_response(400, "invalid_json", "The request body is not valid JSON.")
            return error_response(
                422,
                "invalid_request",
                f"The travel {name} arguments do not match the schema.",
                _validation_details(exc),
            )
        partners = TravelPartners(request.app.state.service)
        try:
            result = getattr(partners, name)(arguments)
        except WebAirError as exc:
            return error_response(
                exc.status, exc.code, exc.message, [{"field": exc.field, "message": exc.message}]
            )
        return JSONResponse(
            result.model_dump(mode="json", by_alias=True), headers={"Cache-Control": "no-store"}
        )

    endpoint.__name__ = f"travel_{name}"
    return endpoint


def router() -> APIRouter:
    routes = APIRouter(prefix=TRAVEL_PREFIX)
    for name, request_model in OPERATIONS.items():
        routes.add_api_route(
            f"/{name}", _endpoint(name, request_model), methods=["POST"], include_in_schema=False
        )
    return routes
