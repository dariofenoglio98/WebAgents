"""WebAir's origin-side business logic.

The human HTML pages and the JSON API both call this one service, so a search,
a fare quote or a simulated purchase cannot give different answers depending on
which interface asked. It performs no I/O: no network, no files, no persistence.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime, timedelta
from functools import cache
from zoneinfo import ZoneInfo

from . import inventory as inv
from .models import (
    Baggage,
    BookingQuote,
    ChangePolicy,
    FareRules,
    FareSummary,
    FlightOffer,
    GetFareRulesRequest,
    GetFlightRequest,
    Itinerary,
    PaymentMethod,
    PrepareBookingRequest,
    RefundPolicy,
    SearchFlightsRequest,
    SearchFlightsResponse,
    Segment,
    SimulatedConfirmation,
    SimulatePurchaseRequest,
)

# Base32 without 0/O/1/I, so a confirmation code can be read aloud.
_CONFIRMATION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class WebAirError(Exception):
    """A request WebAir refuses. `status` follows the HTTP meaning of the refusal."""

    def __init__(self, code: str, message: str, *, status: int = 422, field: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.field = field


def _canonical_digest(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


@cache
def _zone(name: str) -> ZoneInfo:
    return ZoneInfo(name)


def _local(day: date, hhmm: str, airport: str) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime(
        day.year, day.month, day.day, hour, minute, tzinfo=_zone(inv.AIRPORTS[airport].timezone)
    )


def _minutes(start: datetime, end: datetime) -> int:
    # Compare in UTC: subtracting two datetimes that share a tzinfo ignores DST changes.
    return int((end.astimezone(UTC) - start.astimezone(UTC)).total_seconds() // 60)


def _fmt(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M")


class WebAirService:
    """Search, fare rules, booking quotes and simulated purchases over the demo inventory."""

    def __init__(self) -> None:
        self._itineraries = {it.flight_numbers: it for it in inv.ITINERARIES}
        # Load time zone rules now, so no request ever reads the time zone database.
        for airport in inv.AIRPORTS.values():
            _zone(airport.timezone)

    # --- reference data -----------------------------------------------------------------------

    @staticmethod
    def airports() -> list[inv.Airport]:
        return list(inv.AIRPORTS.values())

    @staticmethod
    def payment_methods() -> list[PaymentMethod]:
        return [PaymentMethod(id=m.id, label=m.label) for m in inv.PAYMENT_METHODS.values()]

    # --- operations ---------------------------------------------------------------------------

    def search_flights(self, request: SearchFlightsRequest) -> SearchFlightsResponse:
        if request.origin == request.destination:
            raise WebAirError(
                "invalid_route", "Origin and destination must differ.", field="destination"
            )
        day = self._bookable_date(request.date, field="date")
        flights = []
        for itinerary in inv.ITINERARIES:
            first = inv.SEGMENTS[itinerary.flight_numbers[0]]
            last = inv.SEGMENTS[itinerary.flight_numbers[-1]]
            if (first.origin, last.destination) != (request.origin, request.destination):
                continue
            offer = self._offer(itinerary, day, request.passengers)
            if offer is None or (request.nonstop_only and offer.stops):
                continue
            fares = [
                fare
                for fare in offer.fares
                if fare.available
                and (request.cabin is None or fare.cabin == request.cabin)
                and (request.max_price_usd is None or fare.price_usd <= request.max_price_usd)
            ]
            if fares:
                flights.append(
                    offer.model_copy(
                        update={"fares": fares, "lowest_price_usd": min(f.price_usd for f in fares)}
                    )
                )
        flights.sort(key=lambda f: (f.departure_local, f.duration_minutes, f.flight_id))
        return SearchFlightsResponse(query=request, flights=flights)

    def get_flight(self, request: GetFlightRequest) -> FlightOffer:
        return self._flight(request.flight_id, request.passengers)

    def get_fare_rules(self, request: GetFareRulesRequest) -> FareRules:
        flight_id, family_code = request.fare_id.rsplit("-", 1)
        offer = self._flight(flight_id, request.passengers, field="fare_id")
        fare = next((f for f in offer.fares if f.fare_family == family_code), None)
        if fare is None:
            raise WebAirError(
                "unknown_fare", f"Fare {request.fare_id} is not sold.", status=404, field="fare_id"
            )
        family = inv.FARE_FAMILIES[family_code]
        return FareRules(
            fare_id=fare.fare_id,
            fare_family=fare.fare_family,
            fare_name=fare.fare_name,
            cabin=fare.cabin,
            booking_class=fare.booking_class,
            price_per_passenger_usd=fare.price_usd,
            passengers=request.passengers,
            total_usd=fare.price_usd * request.passengers,
            seats_left=fare.seats_left,
            available=fare.available,
            baggage=Baggage(
                personal_item=family.personal_item,
                cabin_bag_kg=family.cabin_bag_kg,
                checked_bags=family.checked_bags,
                checked_bag_kg=family.checked_bag_kg,
            ),
            changes=ChangePolicy(
                allowed=family.change_allowed,
                fee_usd=family.change_fee_usd,
                summary=(
                    "Changes not permitted"
                    if not family.change_allowed
                    else "Free changes (fare difference may apply)"
                    if family.change_fee_usd == 0
                    else f"Changes for ${family.change_fee_usd} per passenger plus fare difference"
                ),
            ),
            refunds=RefundPolicy(
                refundable=family.refundable,
                fee_usd=family.refund_fee_usd,
                summary=(
                    "Fully refundable before departure" if family.refundable else "Non-refundable"
                ),
            ),
            seat_selection=family.seat_selection,
            flight=Itinerary.model_validate(offer.model_dump(include=set(Itinerary.model_fields))),
        )

    def prepare_booking(self, request: PrepareBookingRequest) -> BookingQuote:
        fare = self.get_fare_rules(
            GetFareRulesRequest(fare_id=request.fare_id, passengers=len(request.passengers))
        )
        if not fare.available:
            raise WebAirError(
                "insufficient_seats",
                f"Only {fare.seats_left} seat(s) left in {fare.fare_name} "
                f"on {fare.flight.flight_id}.",
                field="passengers",
            )
        quote_id = (
            "WAQ-"
            + _canonical_digest(
                {
                    "v": 1,
                    "fare_id": fare.fare_id,
                    "passengers": [[p.given_name, p.family_name] for p in request.passengers],
                    "contact_email": request.contact_email,
                    "price_per_passenger_usd": fare.price_per_passenger_usd,
                    "total_usd": fare.total_usd,
                    "currency": inv.CURRENCY,
                }
            )[:16].upper()
        )
        return BookingQuote(
            quote_id=quote_id,
            fare=fare,
            passengers=request.passengers,
            contact_email=request.contact_email,
            total_usd=fare.total_usd,
            payment_methods=self.payment_methods(),
            notice="Demo quote. Nothing is reserved and nothing will be charged.",
        )

    def simulate_purchase(self, request: SimulatePurchaseRequest) -> SimulatedConfirmation:
        quote = self.prepare_booking(request.booking)
        if quote.quote_id != request.quote_id:
            raise WebAirError(
                "quote_mismatch",
                "The booking does not match the quote; prepare the booking again.",
                field="quote_id",
            )
        method = inv.PAYMENT_METHODS[request.payment_method_id]
        digest = int(
            _canonical_digest({"v": 1, "quote_id": quote.quote_id, "payment_method_id": method.id}),
            16,
        )
        code = "".join(_CONFIRMATION_ALPHABET[(digest >> (5 * i)) & 31] for i in range(5))
        return SimulatedConfirmation(
            confirmation_id=f"WA-DEMO-{code}",
            total_usd=quote.total_usd,
            quote_id=quote.quote_id,
            fare_id=quote.fare.fare_id,
            fare_name=quote.fare.fare_name,
            flight=quote.fare.flight,
            passengers=quote.passengers,
            payment_method=PaymentMethod(id=method.id, label=method.label),
        )

    # --- internals ----------------------------------------------------------------------------

    @staticmethod
    def _bookable_date(value: str, *, field: str) -> date:
        try:
            day = date.fromisoformat(value)
        except ValueError:
            raise WebAirError(
                "invalid_date", f"{value!r} is not a calendar date.", field=field
            ) from None
        if not inv.FIRST_BOOKABLE_DATE <= day <= inv.LAST_BOOKABLE_DATE:
            raise WebAirError(
                "date_out_of_range",
                f"WebAir's demo schedule covers {inv.FIRST_BOOKABLE_DATE} to "
                f"{inv.LAST_BOOKABLE_DATE}.",
                field=field,
            )
        return day

    def _flight(self, flight_id: str, passengers: int, *, field: str = "flight_id") -> FlightOffer:
        key, stamp = flight_id.rsplit("-", 1)
        itinerary = self._itineraries.get(tuple(key.split("-")))
        try:
            day = datetime.strptime(stamp, "%Y%m%d").date()
        except ValueError:
            day = None
        offer = None
        if itinerary and day and inv.FIRST_BOOKABLE_DATE <= day <= inv.LAST_BOOKABLE_DATE:
            offer = self._offer(itinerary, day, passengers)
        if offer is None:
            raise WebAirError(
                "unknown_flight", f"Flight {flight_id} does not exist.", status=404, field=field
            )
        return offer

    def _offer(self, itinerary: inv.Itinerary, day: date, passengers: int) -> FlightOffer | None:
        """The itinerary as operated on `day`, or None if it does not operate that day."""
        segments: list[tuple[inv.SegmentSchedule, datetime, datetime]] = []
        layovers: list[int] = []
        for number in itinerary.flight_numbers:
            schedule = inv.SEGMENTS[number]
            if not segments:
                candidates = [day]
            else:
                arrived = segments[-1][2]
                candidates = [arrived.date(), arrived.date() + timedelta(days=1)]
            departure = None
            for candidate in candidates:
                if candidate.isoweekday() not in schedule.days:
                    continue
                moment = _local(candidate, schedule.departs, schedule.origin)
                if segments:
                    layover = _minutes(segments[-1][2], moment)
                    if not inv.MIN_CONNECTION_MINUTES <= layover <= inv.MAX_CONNECTION_MINUTES:
                        continue
                    layovers.append(layover)
                departure = moment
                break
            if departure is None:
                return None
            arrival = (
                departure.astimezone(UTC) + timedelta(minutes=schedule.duration_minutes)
            ).astimezone(_zone(inv.AIRPORTS[schedule.destination].timezone))
            segments.append((schedule, departure, arrival))

        first_departure, last_arrival = segments[0][1], segments[-1][2]
        flight_id = "-".join(itinerary.flight_numbers) + "-" + day.strftime("%Y%m%d")
        weekday_percent = inv.WEEKDAY_PRICE_PERCENT[day.isoweekday()]
        fares = []
        for code, family in inv.FARE_FAMILIES.items():
            if code not in itinerary.seats:
                continue
            price = itinerary.base_price_usd * family.price_percent * weekday_percent + 5000
            seats = itinerary.seats[code]
            fares.append(
                FareSummary(
                    fare_id=f"{flight_id}-{code}",
                    fare_family=code,
                    fare_name=family.name,
                    cabin=family.cabin,
                    booking_class=family.booking_class,
                    price_usd=price // 10000,
                    seats_left=seats,
                    available=seats >= passengers,
                    checked_bags=family.checked_bags,
                    changeable=family.change_allowed,
                    refundable=family.refundable,
                )
            )
        available = [f.price_usd for f in fares if f.available]
        return FlightOffer(
            flight_id=flight_id,
            flight_numbers=list(itinerary.flight_numbers),
            origin=segments[0][0].origin,
            destination=segments[-1][0].destination,
            date=day.isoformat(),
            departure_local=_fmt(first_departure),
            arrival_local=_fmt(last_arrival),
            arrival_day_offset=(last_arrival.date() - day).days,
            duration_minutes=_minutes(first_departure, last_arrival),
            stops=len(segments) - 1,
            via=[schedule.destination for schedule, _, _ in segments[:-1]],
            layover_minutes=layovers,
            segments=[
                Segment(
                    flight_number=schedule.flight_number,
                    origin=schedule.origin,
                    destination=schedule.destination,
                    departure_local=_fmt(departure),
                    arrival_local=_fmt(arrival),
                    duration_minutes=schedule.duration_minutes,
                    aircraft=schedule.aircraft,
                )
                for schedule, departure, arrival in segments
            ],
            fares=fares,
            lowest_price_usd=min(available) if available else None,
        )
