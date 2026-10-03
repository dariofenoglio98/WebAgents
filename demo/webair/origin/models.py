"""Request and response models shared by the HTML pages and the JSON API.

Requests are closed (`extra="forbid"`) and bounded; the JSON API additionally
validates them in strict mode. Responses are plain data models whose JSON Schema
the API publishes at `GET /api/v1/schemas`.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .inventory import MAX_PASSENGERS

AirportCode = Literal["BOS", "JFK", "ZRH", "GVA", "LHR", "KEF"]
FareFamilyCode = Literal["BASIC", "STANDARD", "FLEX", "BUSINESS"]
Cabin = Literal["economy", "business"]
PaymentMethodId = Literal["demo-visa-4242", "demo-travel-1234"]
Currency = Literal["USD"]

DATE_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
FLIGHT_ID_PATTERN = r"^WA[0-9]{3}(-WA[0-9]{3})?-[0-9]{8}$"
FARE_ID_PATTERN = r"^WA[0-9]{3}(-WA[0-9]{3})?-[0-9]{8}-(BASIC|STANDARD|FLEX|BUSINESS)$"
QUOTE_ID_PATTERN = r"^WAQ-[0-9A-F]{16}$"
CONFIRMATION_ID_PATTERN = r"^WA-DEMO-[A-Z2-9]{5}$"
# Latin-script letters (as on a ticket), spelled as explicit ranges so the published JSON
# Schema compiles in any regex engine (Python `re` and ECMA-262 have no portable \p{L}).
NAME_PATTERN = r"^[A-Za-zÀ-ÖØ-öø-ÿĀ-ž][A-Za-zÀ-ÖØ-öø-ÿĀ-ž .'-]*$"
EMAIL_PATTERN = (
    r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$"
)

PURCHASE_NOTICE = "No real transaction was performed."


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _passengers():
    return Field(1, ge=1, le=MAX_PASSENGERS, description="Number of travelers")


# --- requests ---------------------------------------------------------------------------------


class SearchFlightsRequest(_Request):
    origin: AirportCode
    destination: AirportCode
    date: str = Field(pattern=DATE_PATTERN, description="Local departure date, YYYY-MM-DD")
    passengers: int = _passengers()
    nonstop_only: bool = False
    max_price_usd: int | None = Field(
        None, ge=1, le=100_000, description="Maximum per-passenger fare, taxes included"
    )
    cabin: Cabin | None = None


class GetFlightRequest(_Request):
    flight_id: str = Field(pattern=FLIGHT_ID_PATTERN, examples=["WA101-20261009"])
    passengers: int = _passengers()


class GetFareRulesRequest(_Request):
    fare_id: str = Field(pattern=FARE_ID_PATTERN, examples=["WA101-20261009-STANDARD"])
    passengers: int = _passengers()


class PassengerName(_Request):
    given_name: str = Field(min_length=1, max_length=40, pattern=NAME_PATTERN)
    family_name: str = Field(min_length=1, max_length=40, pattern=NAME_PATTERN)


class PrepareBookingRequest(_Request):
    fare_id: str = Field(pattern=FARE_ID_PATTERN)
    passengers: list[PassengerName] = Field(min_length=1, max_length=MAX_PASSENGERS)
    contact_email: str = Field(max_length=254, pattern=EMAIL_PATTERN)


class SimulatePurchaseRequest(_Request):
    booking: PrepareBookingRequest
    quote_id: str = Field(pattern=QUOTE_ID_PATTERN)
    payment_method_id: PaymentMethodId


# --- responses --------------------------------------------------------------------------------


class Segment(BaseModel):
    flight_number: str
    origin: AirportCode
    destination: AirportCode
    departure_local: str = Field(description="Local time at origin, YYYY-MM-DDTHH:MM")
    arrival_local: str = Field(description="Local time at destination, YYYY-MM-DDTHH:MM")
    duration_minutes: int
    aircraft: str


class Itinerary(BaseModel):
    flight_id: str
    flight_numbers: list[str]
    origin: AirportCode
    destination: AirportCode
    date: str
    departure_local: str
    arrival_local: str
    arrival_day_offset: int = Field(description="Calendar days between departure and arrival")
    duration_minutes: int
    stops: int
    via: list[AirportCode]
    layover_minutes: list[int]
    segments: list[Segment]


class FareSummary(BaseModel):
    fare_id: str
    fare_family: FareFamilyCode
    fare_name: str
    cabin: Cabin
    booking_class: str
    price_usd: int = Field(description="Per passenger, taxes and fees included")
    seats_left: int
    available: bool = Field(description="Enough seats for the requested passengers")
    checked_bags: int
    changeable: bool
    refundable: bool


class FlightOffer(Itinerary):
    currency: Currency = "USD"
    fares: list[FareSummary]
    lowest_price_usd: int | None


class SearchFlightsResponse(BaseModel):
    query: SearchFlightsRequest
    currency: Currency = "USD"
    flights: list[FlightOffer]


class Baggage(BaseModel):
    personal_item: bool
    cabin_bag_kg: int
    checked_bags: int
    checked_bag_kg: int | None


class ChangePolicy(BaseModel):
    allowed: bool
    fee_usd: int | None
    summary: str


class RefundPolicy(BaseModel):
    refundable: bool
    fee_usd: int | None
    summary: str


class FareRules(BaseModel):
    fare_id: str
    fare_family: FareFamilyCode
    fare_name: str
    cabin: Cabin
    booking_class: str
    currency: Currency = "USD"
    price_per_passenger_usd: int
    passengers: int
    total_usd: int
    seats_left: int
    available: bool
    baggage: Baggage
    changes: ChangePolicy
    refunds: RefundPolicy
    seat_selection: str
    flight: Itinerary


class PaymentMethod(BaseModel):
    id: PaymentMethodId
    label: str
    demo: Literal[True] = True


class BookingQuote(BaseModel):
    quote_id: str = Field(description="Digest binding this exact fare, price and passenger list")
    fare: FareRules
    passengers: list[PassengerName]
    contact_email: str
    currency: Currency = "USD"
    total_usd: int
    payment_methods: list[PaymentMethod]
    simulated: Literal[True] = True
    notice: str


class SimulatedConfirmation(BaseModel):
    confirmation_id: str = Field(pattern=CONFIRMATION_ID_PATTERN)
    status: Literal["simulated"] = "simulated"
    simulated: Literal[True] = True
    real_transaction: Literal[False] = False
    amount_charged_usd: Literal[0] = 0
    currency: Currency = "USD"
    total_usd: int = Field(description="What the fare would have cost; nothing was charged")
    quote_id: str
    fare_id: str
    fare_name: str
    flight: Itinerary
    passengers: list[PassengerName]
    payment_method: PaymentMethod
    message: Literal["No real transaction was performed."] = PURCHASE_NOTICE


class ErrorDetail(BaseModel):
    field: str | None = None
    message: str


class ErrorBody(BaseModel):
    code: str
    message: str
    details: list[ErrorDetail] = []


class ErrorResponse(BaseModel):
    error: ErrorBody
