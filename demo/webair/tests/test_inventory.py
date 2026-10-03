"""The demo inventory is self-consistent, fictional and fixed."""

import re
import typing
from datetime import timedelta

from origin import inventory as inv
from origin.models import AirportCode, FareFamilyCode, PaymentMethodId
from origin.service import WebAirService


def test_schema_enums_match_the_inventory():
    assert set(typing.get_args(AirportCode)) == set(inv.AIRPORTS)
    assert set(typing.get_args(FareFamilyCode)) == set(inv.FARE_FAMILIES)
    assert set(typing.get_args(PaymentMethodId)) == set(inv.PAYMENT_METHODS)


def test_segments_and_itineraries_are_well_formed():
    for number, segment in inv.SEGMENTS.items():
        assert re.fullmatch(r"WA[0-9]{3}", number), "only fictional WebAir flight numbers"
        assert segment.flight_number == number
        assert segment.origin in inv.AIRPORTS and segment.destination in inv.AIRPORTS
        assert segment.origin != segment.destination
        assert re.fullmatch(r"([01][0-9]|2[0-3]):[0-5][0-9]", segment.departs)
        assert 30 <= segment.duration_minutes <= 16 * 60
        assert segment.days and segment.days <= inv.DAILY

    keys = [it.flight_numbers for it in inv.ITINERARIES]
    assert len(keys) == len(set(keys)), "itineraries are unique"
    for itinerary in inv.ITINERARIES:
        assert 1 <= len(itinerary.flight_numbers) <= 2
        legs = [inv.SEGMENTS[n] for n in itinerary.flight_numbers]
        for before, after in zip(legs, legs[1:]):
            assert before.destination == after.origin, "connections are contiguous"
        assert legs[0].origin != legs[-1].destination
        assert itinerary.base_price_usd > 0
        assert set(itinerary.seats) <= set(inv.FARE_FAMILIES)
        assert all(seats > 0 for seats in itinerary.seats.values())


def test_the_demo_window_is_explicit_and_contains_the_default_date():
    assert inv.FIRST_BOOKABLE_DATE < inv.DEFAULT_SEARCH_DATE < inv.LAST_BOOKABLE_DATE
    assert inv.DEFAULT_SEARCH_DATE.isoweekday() == 5, "the pre-filled demo date is a Friday"


def test_every_itinerary_operates_on_its_scheduled_days_across_the_whole_window():
    """Connections stay valid through both DST changes (US and Europe switch on different days)."""
    service = WebAirService()
    day = inv.FIRST_BOOKABLE_DATE
    while day <= inv.LAST_BOOKABLE_DATE:
        for itinerary in inv.ITINERARIES:
            first = inv.SEGMENTS[itinerary.flight_numbers[0]]
            offer = service._offer(itinerary, day, 1)
            assert (offer is not None) == (day.isoweekday() in first.days), (itinerary, day)
            if offer is not None:
                assert all(
                    inv.MIN_CONNECTION_MINUTES <= m <= inv.MAX_CONNECTION_MINUTES
                    for m in offer.layover_minutes
                )
                assert offer.duration_minutes == sum(
                    s.duration_minutes for s in offer.segments
                ) + sum(offer.layover_minutes)
        day += timedelta(days=1)


def test_payment_methods_are_labelled_demo_instruments_without_card_numbers():
    for method in inv.PAYMENT_METHODS.values():
        assert method.id.startswith("demo-")
        assert method.label.startswith("Demo ")
        assert not re.search(r"[0-9]{5,}", method.label), "at most the last four digits"
