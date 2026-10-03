"""WebAir's fictional, deterministic inventory: pure data, no logic.

Every flight number, schedule, aircraft assignment and price here is invented for
the demo. Nothing is derived from a real airline's timetable or fares, and nothing
depends on the current date: schedules are weekly patterns valid inside an explicit
demo window, and prices are a fixed function of route, fare family and weekday.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

CURRENCY = "USD"

# Bookable departure dates. Explicit, so results never depend on "today".
FIRST_BOOKABLE_DATE = date(2026, 10, 1)
LAST_BOOKABLE_DATE = date(2027, 12, 31)
# Pre-filled in the human search form: a Friday, for "BOS -> ZRH next Friday".
DEFAULT_SEARCH_DATE = date(2026, 10, 9)

MAX_PASSENGERS = 6
# A connection is offered only if the layover falls inside this window (minutes).
MIN_CONNECTION_MINUTES = 60
MAX_CONNECTION_MINUTES = 8 * 60

DAILY = frozenset(range(1, 8))  # ISO weekdays, Monday = 1


@dataclass(frozen=True)
class Airport:
    code: str
    city: str
    name: str
    country: str
    timezone: str


@dataclass(frozen=True)
class SegmentSchedule:
    """One flight number: a fixed local departure time and block time, on given weekdays."""

    flight_number: str
    origin: str
    destination: str
    departs: str  # local time at origin, "HH:MM"
    duration_minutes: int
    aircraft: str
    days: frozenset[int] = DAILY


@dataclass(frozen=True)
class Itinerary:
    """A sellable product: one segment (nonstop) or two (one connection)."""

    flight_numbers: tuple[str, ...]
    # Economy Standard price on a weekday with a 100% factor; other prices derive from it.
    base_price_usd: int
    # Seats offered per fare family. Bookings are simulated, so this never decreases.
    seats: dict[str, int]


@dataclass(frozen=True)
class FareFamily:
    code: str
    name: str
    cabin: str
    booking_class: str
    price_percent: int  # of the itinerary's Economy Standard base price
    personal_item: bool
    cabin_bag_kg: int
    checked_bags: int
    checked_bag_kg: int | None
    change_allowed: bool
    change_fee_usd: int | None
    refundable: bool
    refund_fee_usd: int | None
    seat_selection: str


@dataclass(frozen=True)
class PaymentMethod:
    """A fake, pre-filled demo instrument. No card number exists anywhere."""

    id: str
    label: str


AIRPORTS: dict[str, Airport] = {
    a.code: a
    for a in (
        Airport("BOS", "Boston", "Boston Logan International", "United States", "America/New_York"),
        Airport(
            "JFK", "New York", "John F. Kennedy International", "United States", "America/New_York"
        ),
        Airport("ZRH", "Zurich", "Zurich Airport", "Switzerland", "Europe/Zurich"),
        Airport("GVA", "Geneva", "Geneva Airport", "Switzerland", "Europe/Zurich"),
        Airport("LHR", "London", "London Heathrow", "United Kingdom", "Europe/London"),
        Airport("KEF", "Reykjavik", "Keflavik International", "Iceland", "Atlantic/Reykjavik"),
    )
}

SEGMENTS: dict[str, SegmentSchedule] = {
    s.flight_number: s
    for s in (
        # Boston <-> Zurich nonstop
        SegmentSchedule("WA101", "BOS", "ZRH", "18:05", 455, "Airbus A330-300"),
        SegmentSchedule(
            "WA105", "BOS", "ZRH", "21:40", 460, "Boeing 787-9", frozenset({1, 3, 5, 7})
        ),
        SegmentSchedule("WA100", "ZRH", "BOS", "13:20", 525, "Airbus A330-300"),
        SegmentSchedule(
            "WA104", "ZRH", "BOS", "10:05", 520, "Boeing 787-9", frozenset({1, 3, 5, 7})
        ),
        # New York <-> Zurich / Geneva nonstop
        SegmentSchedule("WA115", "JFK", "ZRH", "19:30", 485, "Airbus A330-300"),
        SegmentSchedule("WA114", "ZRH", "JFK", "12:40", 550, "Airbus A330-300"),
        SegmentSchedule(
            "WA121", "JFK", "GVA", "18:45", 475, "Boeing 787-9", frozenset({2, 4, 6, 7})
        ),
        SegmentSchedule(
            "WA120", "GVA", "JFK", "11:30", 530, "Boeing 787-9", frozenset({2, 4, 6, 7})
        ),
        # Boston <-> London, London <-> Zurich
        SegmentSchedule("WA213", "BOS", "LHR", "19:10", 395, "Airbus A321neo"),
        SegmentSchedule("WA212", "LHR", "BOS", "15:05", 455, "Airbus A321neo"),
        SegmentSchedule("WA741", "LHR", "ZRH", "08:40", 105, "Airbus A220-300"),
        SegmentSchedule("WA740", "ZRH", "LHR", "11:50", 110, "Airbus A220-300"),
        # Boston <-> Reykjavik, Reykjavik <-> Zurich
        SegmentSchedule("WA205", "BOS", "KEF", "20:30", 305, "Airbus A321neo"),
        SegmentSchedule("WA204", "KEF", "BOS", "18:30", 340, "Airbus A321neo"),
        SegmentSchedule("WA731", "KEF", "ZRH", "07:40", 215, "Airbus A220-300"),
        SegmentSchedule("WA730", "ZRH", "KEF", "14:30", 230, "Airbus A220-300"),
    )
}

_WIDEBODY = {"BASIC": 9, "STANDARD": 24, "FLEX": 12, "BUSINESS": 6}
_NARROWBODY = {"BASIC": 6, "STANDARD": 18, "FLEX": 8}

ITINERARIES: tuple[Itinerary, ...] = (
    # BOS -> ZRH
    Itinerary(("WA101",), 780, _WIDEBODY),
    Itinerary(("WA105",), 830, {"BASIC": 4, "STANDARD": 20, "FLEX": 10, "BUSINESS": 2}),
    Itinerary(("WA205", "WA731"), 560, _NARROWBODY),
    Itinerary(("WA213", "WA741"), 650, _NARROWBODY),
    # ZRH -> BOS
    Itinerary(("WA100",), 760, _WIDEBODY),
    Itinerary(("WA104",), 800, _WIDEBODY),
    Itinerary(("WA730", "WA204"), 540, _NARROWBODY),
    Itinerary(("WA740", "WA212"), 630, _NARROWBODY),
    # JFK <-> ZRH, JFK <-> GVA
    Itinerary(("WA115",), 820, _WIDEBODY),
    Itinerary(("WA114",), 800, _WIDEBODY),
    Itinerary(("WA121",), 790, _WIDEBODY),
    Itinerary(("WA120",), 780, _WIDEBODY),
    # Single legs that are also sold on their own
    Itinerary(("WA213",), 520, _NARROWBODY),
    Itinerary(("WA212",), 510, _NARROWBODY),
    Itinerary(("WA741",), 160, _NARROWBODY),
    Itinerary(("WA740",), 150, _NARROWBODY),
    Itinerary(("WA205",), 380, _NARROWBODY),
    Itinerary(("WA204",), 370, _NARROWBODY),
    Itinerary(("WA731",), 260, _NARROWBODY),
    Itinerary(("WA730",), 250, _NARROWBODY),
)

FARE_FAMILIES: dict[str, FareFamily] = {
    f.code: f
    for f in (
        FareFamily(
            code="BASIC",
            name="Economy Basic",
            cabin="economy",
            booking_class="V",
            price_percent=82,
            personal_item=True,
            cabin_bag_kg=8,
            checked_bags=0,
            checked_bag_kg=None,
            change_allowed=False,
            change_fee_usd=None,
            refundable=False,
            refund_fee_usd=None,
            seat_selection="Seat assigned at check-in",
        ),
        FareFamily(
            code="STANDARD",
            name="Economy Standard",
            cabin="economy",
            booking_class="M",
            price_percent=100,
            personal_item=True,
            cabin_bag_kg=8,
            checked_bags=1,
            checked_bag_kg=23,
            change_allowed=True,
            change_fee_usd=150,
            refundable=False,
            refund_fee_usd=None,
            seat_selection="Standard seat selection included",
        ),
        FareFamily(
            code="FLEX",
            name="Economy Flex",
            cabin="economy",
            booking_class="Y",
            price_percent=140,
            personal_item=True,
            cabin_bag_kg=8,
            checked_bags=2,
            checked_bag_kg=23,
            change_allowed=True,
            change_fee_usd=0,
            refundable=True,
            refund_fee_usd=0,
            seat_selection="Any economy seat, including extra legroom",
        ),
        FareFamily(
            code="BUSINESS",
            name="Business",
            cabin="business",
            booking_class="J",
            price_percent=400,
            personal_item=True,
            cabin_bag_kg=12,
            checked_bags=2,
            checked_bag_kg=32,
            change_allowed=True,
            change_fee_usd=0,
            refundable=True,
            refund_fee_usd=0,
            seat_selection="Lie-flat seat with direct aisle access; lounge access",
        ),
    )
}

# Demand-based weekday adjustment, in percent (ISO weekday -> factor).
WEEKDAY_PRICE_PERCENT: dict[int, int] = {1: 100, 2: 92, 3: 92, 4: 100, 5: 110, 6: 96, 7: 108}

PAYMENT_METHODS: dict[str, PaymentMethod] = {
    m.id: m
    for m in (
        PaymentMethod("demo-visa-4242", "Demo Visa •••• 4242"),
        PaymentMethod("demo-travel-1234", "Demo Travel Card •••• 1234"),
    )
}
