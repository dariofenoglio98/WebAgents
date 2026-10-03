"""WebAir's human interface: server-rendered pages over the shared `WebAirService`.

Handlers translate query strings and forms into the same request models the JSON
API uses, call the service, and render a template. Prices, availability, quotes
and confirmations all come from the service; templates only format them.

The booking journey is stateless. Passenger details travel in the forms of the
journey's own pages and are never written anywhere by the origin.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

from fastapi import APIRouter, Request, Response
from fastapi.responses import HTMLResponse
from jinja2 import DictLoader, Environment, StrictUndefined, select_autoescape
from pydantic import ValidationError

from . import inventory as inv
from .agent_package import DISCOVERY_REL, MEDIA_TYPE, PACKAGE_PATH
from .bodies import BodyTooLarge, media_type, read_bounded_body
from .models import (
    GetFareRulesRequest,
    GetFlightRequest,
    PrepareBookingRequest,
    SearchFlightsRequest,
    SimulatePurchaseRequest,
)
from .service import WebAirError, WebAirService

HERE = Path(__file__).parent
MAX_FORM_BYTES = 16 * 1024
MAX_FORM_FIELDS = 64

_FIELD_HINTS = {
    "origin": "Choose a departure airport.",
    "destination": "Choose a destination airport.",
    "date": "Enter a departure date (YYYY-MM-DD).",
    "passengers": f"Choose between 1 and {inv.MAX_PASSENGERS} passengers.",
    "max_price_usd": "Enter a maximum price as a whole number of dollars.",
    "cabin": "Choose a cabin.",
    "nonstop_only": "Nonstop must be on or off.",
    "fare_id": "The selected fare is not valid. Please start a new search.",
    "contact_email": "Enter an email address. A made-up one such as traveler@example.com is fine.",
    "quote_id": "Your quote is no longer valid. Please review the booking again.",
    "payment_method_id": "Choose one of the demo payment methods.",
}


class FormError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def load_templates() -> Environment:
    """All templates are read once, here, so no request touches the filesystem."""
    sources = {p.name: p.read_text(encoding="utf-8") for p in (HERE / "templates").glob("*.html")}
    env = Environment(
        loader=DictLoader(sources),
        autoescape=select_autoescape(default=True),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters.update(usd=_usd, duration=_duration, clock=_clock, longdate=_longdate)
    env.globals.update(
        airports=inv.AIRPORTS,
        agent_package={"rel": DISCOVERY_REL, "type": MEDIA_TYPE, "href": PACKAGE_PATH},
        first_date=inv.FIRST_BOOKABLE_DATE.isoformat(),
        last_date=inv.LAST_BOOKABLE_DATE.isoformat(),
        max_passengers=inv.MAX_PASSENGERS,
    )
    return env


def _usd(amount: int) -> str:
    return f"${amount:,}"


def _duration(minutes: int) -> str:
    return f"{minutes // 60}h {minutes % 60:02d}m"


def _clock(local: str) -> str:
    return local[11:16]


def _longdate(value: str) -> str:
    day = date.fromisoformat(value[:10])
    return f"{day:%a} {day.day} {day:%b %Y}"


def _messages(exc: ValidationError | WebAirError) -> list[str]:
    if isinstance(exc, WebAirError):
        return [exc.message]
    messages = []
    for err in exc.errors(include_input=False, include_url=False):
        loc = err["loc"]
        if len(loc) >= 3 and loc[0] == "passengers" and isinstance(loc[1], int):
            label = "given name" if loc[2] == "given_name" else "family name"
            message = (
                f"Passenger {loc[1] + 1}: enter a {label} using letters, spaces, "
                "hyphens or apostrophes (up to 40 characters)."
            )
        elif loc and loc[0] == "booking":
            message = _FIELD_HINTS["fare_id"]
        else:
            message = _FIELD_HINTS.get(str(loc[0]) if loc else "", "Please check the form.")
        if message not in messages:
            messages.append(message)
    return messages


def _passenger_count(value: str | None) -> int:
    if value is None or value == "":
        return 1
    if not value.isdigit() or not 1 <= int(value) <= inv.MAX_PASSENGERS:
        raise FormError(422, _FIELD_HINTS["passengers"])
    return int(value)


def _search_arguments(params: dict[str, str]) -> dict:
    fields = (
        "origin",
        "destination",
        "date",
        "passengers",
        "nonstop_only",
        "max_price_usd",
        "cabin",
    )
    arguments = {k: params[k].strip() for k in fields if params.get(k, "").strip()}
    arguments["nonstop_only"] = "nonstop_only" in arguments
    return arguments


def _booking(form: dict[str, str]) -> PrepareBookingRequest:
    count = _passenger_count(form.get("passengers"))
    return PrepareBookingRequest.model_validate(
        {
            "fare_id": form.get("fare_id", ""),
            "passengers": [
                {
                    "given_name": form.get(f"given_name_{i}", "").strip(),
                    "family_name": form.get(f"family_name_{i}", "").strip(),
                }
                for i in range(1, count + 1)
            ],
            "contact_email": form.get("contact_email", "").strip(),
        }
    )


async def _read_form(request: Request) -> dict[str, str]:
    if media_type(request) != "application/x-www-form-urlencoded":
        raise FormError(415, "Unsupported form submission.")
    try:
        body = await read_bounded_body(request, MAX_FORM_BYTES)
        pairs = parse_qsl(
            body.decode("utf-8"),
            keep_blank_values=True,
            strict_parsing=False,
            max_num_fields=MAX_FORM_FIELDS,
        )
    except BodyTooLarge:
        raise FormError(413, "The form submission is too large.") from None
    except (UnicodeDecodeError, ValueError):
        raise FormError(400, "The form submission could not be read.") from None
    form: dict[str, str] = {}
    for key, value in pairs:
        if key in form:
            raise FormError(400, "The form submission repeats a field.")
        form[key] = value
    return form


def router(templates: Environment) -> APIRouter:
    routes = APIRouter()

    def render(name: str, status: int = 200, **context) -> HTMLResponse:
        return HTMLResponse(templates.get_template(name).render(**context), status_code=status)

    def error_page(status: int, title: str, message: str) -> HTMLResponse:
        return render("error.html", status, title=title, message=message)

    def service(request: Request) -> WebAirService:
        return request.app.state.service

    @routes.get("/", response_class=HTMLResponse)
    def home() -> HTMLResponse:
        return render("home.html", form=_default_search(), errors=[])

    @routes.get("/flights", response_class=HTMLResponse)
    def flights(request: Request) -> HTMLResponse:
        form = _default_search() | {k: v for k, v in request.query_params.items() if v}
        return render("flights.html", form=form, errors=[])

    @routes.get("/results", response_class=HTMLResponse)
    def results(request: Request) -> HTMLResponse:
        params = dict(request.query_params)
        try:
            query = SearchFlightsRequest.model_validate(_search_arguments(params))
            found = service(request).search_flights(query)
        except (ValidationError, WebAirError) as exc:
            return render(
                "flights.html", 422, form=_default_search() | params, errors=_messages(exc)
            )
        change = urlencode({k: v for k, v in query.model_dump().items() if v not in (None, False)})
        return render("results.html", query=query, flights=found.flights, change_search=change)

    @routes.get("/flight/{flight_id}", response_class=HTMLResponse)
    def flight(request: Request, flight_id: str) -> HTMLResponse:
        try:
            passengers = _passenger_count(request.query_params.get("passengers"))
            offer = service(request).get_flight(
                GetFlightRequest(flight_id=flight_id, passengers=passengers)
            )
        except (ValidationError, WebAirError, FormError):
            return error_page(
                404, "Flight not found", "We could not find that flight. Please search again."
            )
        return render("flight.html", flight=offer, passengers=passengers)

    @routes.get("/fare/{fare_id}", response_class=HTMLResponse)
    def fare(request: Request, fare_id: str) -> HTMLResponse:
        try:
            passengers = _passenger_count(request.query_params.get("passengers"))
            rules = service(request).get_fare_rules(
                GetFareRulesRequest(fare_id=fare_id, passengers=passengers)
            )
        except (ValidationError, WebAirError, FormError):
            return error_page(
                404, "Fare not found", "We could not find that fare. Please search again."
            )
        return render("fare.html", fare=rules)

    @routes.get("/passenger", response_class=HTMLResponse)
    def passenger(request: Request) -> HTMLResponse:
        try:
            passengers = _passenger_count(request.query_params.get("passengers"))
            rules = service(request).get_fare_rules(
                GetFareRulesRequest(
                    fare_id=request.query_params.get("fare_id", ""), passengers=passengers
                )
            )
        except (ValidationError, WebAirError, FormError):
            return error_page(
                404, "Fare not found", "We could not find that fare. Please search again."
            )
        if not rules.available:
            return error_page(
                422, "Not enough seats", f"Only {rules.seats_left} seat(s) are left in this fare."
            )
        return render("passenger.html", fare=rules, form={}, errors=[])

    @routes.post("/payment", response_class=HTMLResponse)
    async def payment(request: Request) -> HTMLResponse:
        try:
            form = await _read_form(request)
            booking = _booking(form)
        except FormError as exc:
            return error_page(exc.status, "Something went wrong", exc.message)
        except ValidationError as exc:
            return _passenger_again(request, form, _messages(exc))
        try:
            quote = service(request).prepare_booking(booking)
        except WebAirError as exc:
            return _passenger_again(request, form, _messages(exc))
        return render("payment.html", quote=quote, booking=booking, errors=[])

    @routes.post("/confirmation", response_class=HTMLResponse)
    async def confirmation(request: Request) -> HTMLResponse:
        try:
            form = await _read_form(request)
            booking = _booking(form)
            quote = service(request).prepare_booking(booking)
        except FormError as exc:
            return error_page(exc.status, "Something went wrong", exc.message)
        except (ValidationError, WebAirError) as exc:
            return error_page(422, "Booking details changed", " ".join(_messages(exc)))
        try:
            purchase = SimulatePurchaseRequest.model_validate(
                {
                    "booking": booking,
                    "quote_id": form.get("quote_id", ""),
                    "payment_method_id": form.get("payment_method_id", ""),
                }
            )
            confirmed = service(request).simulate_purchase(purchase)
        except (ValidationError, WebAirError) as exc:
            return render("payment.html", 422, quote=quote, booking=booking, errors=_messages(exc))
        return render("confirmation.html", confirmation=confirmed)

    def _passenger_again(request: Request, form: dict[str, str], errors: list[str]) -> Response:
        try:
            rules = service(request).get_fare_rules(
                GetFareRulesRequest(
                    fare_id=form.get("fare_id", ""),
                    passengers=_passenger_count(form.get("passengers")),
                )
            )
        except (ValidationError, WebAirError, FormError):
            return error_page(
                422, "Fare not found", "We could not find that fare. Please search again."
            )
        return render("passenger.html", 422, fare=rules, form=form, errors=errors)

    return routes


def _default_search() -> dict[str, str]:
    return {
        "origin": "BOS",
        "destination": "ZRH",
        "date": inv.DEFAULT_SEARCH_DATE.isoformat(),
        "passengers": "1",
    }
