"""WebAirService: search, flights, fare rules, booking quotes and simulated purchases."""

import re

import pytest

from origin import inventory as inv
from origin.models import (
    GetFareRulesRequest,
    GetFlightRequest,
    PassengerName,
    PrepareBookingRequest,
    SearchFlightsRequest,
    SimulatePurchaseRequest,
)
from origin.service import WebAirError, WebAirService

FRIDAY = "2026-10-09"


def search(service, **kwargs):
    arguments = {"origin": "BOS", "destination": "ZRH", "date": FRIDAY} | kwargs
    return service.search_flights(SearchFlightsRequest(**arguments))


def booking(
    fare_id="WA101-20261009-STANDARD", names=(("Ada", "Lovelace"),), email="ada@example.com"
):
    return PrepareBookingRequest(
        fare_id=fare_id,
        passengers=[PassengerName(given_name=g, family_name=f) for g, f in names],
        contact_email=email,
    )


def prices(result):
    return {f.flight_id: {x.fare_family: x.price_usd for x in f.fares} for f in result.flights}


# --- search -----------------------------------------------------------------------------------


def test_boston_to_zurich_on_the_demo_friday(service):
    result = search(service)
    assert [f.flight_id for f in result.flights] == [
        "WA101-20261009",
        "WA213-WA741-20261009",
        "WA205-WA731-20261009",
        "WA105-20261009",
    ]
    assert prices(result) == {
        "WA101-20261009": {"BASIC": 704, "STANDARD": 858, "FLEX": 1201, "BUSINESS": 3432},
        "WA213-WA741-20261009": {"BASIC": 586, "STANDARD": 715, "FLEX": 1001},
        "WA205-WA731-20261009": {"BASIC": 505, "STANDARD": 616, "FLEX": 862},
        "WA105-20261009": {"BASIC": 749, "STANDARD": 913, "FLEX": 1278, "BUSINESS": 3652},
    }
    wa101 = result.flights[0]
    assert (wa101.departure_local, wa101.arrival_local) == ("2026-10-09T18:05", "2026-10-10T07:40")
    assert (wa101.duration_minutes, wa101.stops, wa101.via, wa101.arrival_day_offset) == (
        455,
        0,
        [],
        1,
    )
    assert wa101.lowest_price_usd == 704
    via_kef = result.flights[2]
    assert via_kef.stops == 1 and via_kef.via == ["KEF"] and via_kef.layover_minutes == [125]
    assert [s.flight_number for s in via_kef.segments] == ["WA205", "WA731"]


def test_nonstop_under_900_is_the_motivating_query(service):
    result = search(service, nonstop_only=True, max_price_usd=900)
    assert prices(result) == {
        "WA101-20261009": {"BASIC": 704, "STANDARD": 858},
        "WA105-20261009": {"BASIC": 749},
    }
    assert all(f.stops == 0 for f in result.flights)
    assert all(x.price_usd <= 900 for f in result.flights for x in f.fares)


def test_results_are_deterministic_across_instances_and_calls(service):
    first = search(service, passengers=2).model_dump()
    assert search(service, passengers=2).model_dump() == first
    assert search(WebAirService(), passengers=2).model_dump() == first


def test_price_filter_is_inclusive_and_drops_flights_without_matching_fares(service):
    assert prices(search(service, max_price_usd=505)) == {"WA205-WA731-20261009": {"BASIC": 505}}
    assert search(service, max_price_usd=504).flights == []


def test_cabin_filter(service):
    business = search(service, cabin="business")
    assert [f.flight_id for f in business.flights] == ["WA101-20261009", "WA105-20261009"]
    assert {x.cabin for f in business.flights for x in f.fares} == {"business"}
    economy = search(service, cabin="economy")
    assert {x.cabin for f in economy.flights for x in f.fares} == {"economy"}
    assert len(economy.flights) == 4


def test_passenger_count_hides_fares_without_enough_seats(service):
    # WA105 sells 4 Basic and 2 Business seats.
    assert set(prices(search(service, passengers=4))["WA105-20261009"]) == {
        "BASIC",
        "STANDARD",
        "FLEX",
    }
    assert set(prices(search(service, passengers=5))["WA105-20261009"]) == {"STANDARD", "FLEX"}
    assert all(x.available for f in search(service, passengers=6).flights for x in f.fares)


def test_weekday_pricing_and_operating_days(service):
    tuesday = search(service, date="2026-10-06")
    assert "WA105-20261006" not in prices(tuesday), "WA105 does not operate on Tuesdays"
    assert prices(tuesday)["WA101-20261006"]["STANDARD"] == 718  # 780 * 92%


def test_dst_changes_local_arrival_but_not_block_time(service):
    before = search(service, date="2026-10-23", nonstop_only=True).flights[0]
    between = search(service, date="2026-10-30", nonstop_only=True).flights[0]
    after = search(service, date="2026-11-06", nonstop_only=True).flights[0]
    assert before.flight_id.startswith("WA101") and after.flight_id.startswith("WA101")
    assert {before.duration_minutes, between.duration_minutes, after.duration_minutes} == {455}
    # Europe falls back on Oct 25, the US on Nov 1.
    assert [before.arrival_local[11:], between.arrival_local[11:], after.arrival_local[11:]] == [
        "07:40",
        "06:40",
        "07:40",
    ]


def test_routes_without_service_return_no_flights(service):
    assert search(service, origin="GVA", destination="KEF").flights == []


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"destination": "BOS"}, "invalid_route"),
        ({"date": "2026-02-30"}, "invalid_date"),
        ({"date": "2026-09-30"}, "date_out_of_range"),
        ({"date": "2028-01-01"}, "date_out_of_range"),
    ],
)
def test_search_refusals(service, kwargs, code):
    with pytest.raises(WebAirError) as error:
        search(service, **kwargs)
    assert (error.value.code, error.value.status) == (code, 422)


def test_window_edges_are_bookable(service):
    assert search(service, date=inv.FIRST_BOOKABLE_DATE.isoformat()).flights
    assert search(service, date=inv.LAST_BOOKABLE_DATE.isoformat()).flights


# --- flights and fares ------------------------------------------------------------------------


def test_get_flight_lists_every_fare_with_availability(service):
    offer = service.get_flight(GetFlightRequest(flight_id="WA105-20261009", passengers=3))
    assert [(f.fare_family, f.available) for f in offer.fares] == [
        ("BASIC", True),
        ("STANDARD", True),
        ("FLEX", True),
        ("BUSINESS", False),
    ]
    assert offer.lowest_price_usd == 749
    assert offer == service.get_flight(GetFlightRequest(flight_id="WA105-20261009", passengers=3))


def test_search_and_get_flight_agree(service):
    for flight in search(service).flights:
        offer = service.get_flight(GetFlightRequest(flight_id=flight.flight_id))
        assert offer.model_dump(exclude={"fares"}) == flight.model_dump(exclude={"fares"})


@pytest.mark.parametrize(
    "flight_id",
    [
        "WA999-20261009",  # no such flight number
        "WA105-20261006",  # does not operate on Tuesdays
        "WA731-WA205-20261009",  # segments in the wrong order
        "WA101-20260930",  # before the demo window
        "WA101-20280101",  # after it
        "WA101-20261340",  # not a date
    ],
)
def test_unknown_flights(service, flight_id):
    with pytest.raises(WebAirError) as error:
        service.get_flight(GetFlightRequest(flight_id=flight_id))
    assert (error.value.code, error.value.status) == ("unknown_flight", 404)


@pytest.mark.parametrize(
    "flight_id",
    [
        "../etc/passwd",
        "WA101",
        "wa101-20261009",
        "WA101-2026-10-09",
        "WA101-20261009-STANDARD",
        "WA1-20261009",
    ],
)
def test_malformed_flight_ids_are_rejected_by_the_schema(flight_id):
    with pytest.raises(ValueError):
        GetFlightRequest(flight_id=flight_id)


def test_fare_rules_per_family(service):
    def rules(family):
        return service.get_fare_rules(
            GetFareRulesRequest(fare_id=f"WA101-20261009-{family}", passengers=2)
        )

    basic, standard, flex, business = (rules(f) for f in ("BASIC", "STANDARD", "FLEX", "BUSINESS"))
    assert (basic.baggage.checked_bags, basic.changes.allowed, basic.refunds.refundable) == (
        0,
        False,
        False,
    )
    assert (standard.baggage.checked_bags, standard.baggage.checked_bag_kg) == (1, 23)
    assert (standard.changes.allowed, standard.changes.fee_usd, standard.refunds.refundable) == (
        True,
        150,
        False,
    )
    assert (flex.baggage.checked_bags, flex.changes.fee_usd, flex.refunds.refundable) == (
        2,
        0,
        True,
    )
    assert (business.cabin, business.baggage.checked_bag_kg, business.booking_class) == (
        "business",
        32,
        "J",
    )
    assert (standard.price_per_passenger_usd, standard.passengers, standard.total_usd) == (
        858,
        2,
        1716,
    )
    assert standard.flight.flight_id == "WA101-20261009"
    assert "Changes for $150" in standard.changes.summary
    assert basic.refunds.summary == "Non-refundable"


def test_unknown_and_malformed_fares(service):
    with pytest.raises(WebAirError) as error:
        service.get_fare_rules(GetFareRulesRequest(fare_id="WA205-WA731-20261009-BUSINESS"))
    assert (error.value.code, error.value.status) == ("unknown_fare", 404)
    with pytest.raises(WebAirError) as error:
        service.get_fare_rules(GetFareRulesRequest(fare_id="WA999-20261009-BASIC"))
    assert (error.value.code, error.value.status) == ("unknown_flight", 404)
    for bad in ("WA101-20261009-FIRST", "WA101-20261009", "WA101-20261009-basic"):
        with pytest.raises(ValueError):
            GetFareRulesRequest(fare_id=bad)


# --- booking and simulated purchase -----------------------------------------------------------


def test_prepare_booking_quotes_without_reserving(service):
    names = (("Ada", "Lovelace"), ("Alan", "Turing"))
    quote = service.prepare_booking(booking(names=names))
    assert re.fullmatch(r"WAQ-[0-9A-F]{16}", quote.quote_id)
    assert (quote.total_usd, quote.fare.passengers, quote.simulated) == (1716, 2, True)
    assert [p.given_name for p in quote.passengers] == ["Ada", "Alan"]
    assert [m.id for m in quote.payment_methods] == ["demo-visa-4242", "demo-travel-1234"]
    assert service.prepare_booking(booking(names=names)) == quote, "deterministic"
    # Nothing is reserved: availability is unchanged.
    after = service.get_fare_rules(GetFareRulesRequest(fare_id="WA101-20261009-STANDARD"))
    assert after.seats_left == inv.ITINERARIES[0].seats["STANDARD"]


def test_quote_ids_bind_every_booking_input(service):
    base = service.prepare_booking(booking()).quote_id
    variants = [
        booking(fare_id="WA101-20261009-FLEX"),
        booking(fare_id="WA101-20261016-STANDARD"),
        booking(names=(("Ada", "Byron"),)),
        booking(names=(("Ada", "Lovelace"), ("Alan", "Turing"))),
        booking(email="ada@example.org"),
    ]
    ids = {service.prepare_booking(v).quote_id for v in variants}
    assert base not in ids and len(ids) == len(variants)


def test_prepare_booking_refuses_more_passengers_than_seats(service):
    names = tuple((f"Traveler{chr(65 + i)}", "Demo") for i in range(3))
    with pytest.raises(WebAirError) as error:
        service.prepare_booking(booking(fare_id="WA105-20261009-BUSINESS", names=names))
    assert (error.value.code, error.value.status) == ("insufficient_seats", 422)


def test_prepare_booking_for_unknown_fare(service):
    with pytest.raises(WebAirError) as error:
        service.prepare_booking(booking(fare_id="WA105-20261006-BASIC"))
    assert error.value.code == "unknown_flight"


def test_simulated_purchase_is_deterministic_and_never_charges(service):
    request = booking()
    quote = service.prepare_booking(request)
    purchase = SimulatePurchaseRequest(
        booking=request, quote_id=quote.quote_id, payment_method_id="demo-visa-4242"
    )
    confirmation = service.simulate_purchase(purchase)
    assert re.fullmatch(r"WA-DEMO-[A-HJ-NP-Z2-9]{5}", confirmation.confirmation_id)
    assert confirmation == service.simulate_purchase(purchase)
    assert confirmation == WebAirService().simulate_purchase(purchase)
    assert (confirmation.status, confirmation.simulated, confirmation.real_transaction) == (
        "simulated",
        True,
        False,
    )
    assert confirmation.amount_charged_usd == 0
    assert confirmation.total_usd == quote.total_usd == 858
    assert confirmation.message == "No real transaction was performed."
    assert confirmation.payment_method.label == "Demo Visa •••• 4242"
    other = service.simulate_purchase(
        purchase.model_copy(update={"payment_method_id": "demo-travel-1234"})
    )
    assert other.confirmation_id != confirmation.confirmation_id


def test_confirmation_ids_differ_between_bookings(service):
    ids = set()
    for fare in ("BASIC", "STANDARD", "FLEX", "BUSINESS"):
        request = booking(fare_id=f"WA101-20261009-{fare}")
        quote = service.prepare_booking(request)
        ids.add(
            service.simulate_purchase(
                SimulatePurchaseRequest(
                    booking=request,
                    quote_id=quote.quote_id,
                    payment_method_id="demo-visa-4242",
                )
            ).confirmation_id
        )
    assert len(ids) == 4


def test_purchase_refuses_a_quote_for_different_inputs(service):
    quote = service.prepare_booking(booking())
    with pytest.raises(WebAirError) as error:
        service.simulate_purchase(
            SimulatePurchaseRequest(
                booking=booking(names=(("Mallory", "Example"),)),
                quote_id=quote.quote_id,
                payment_method_id="demo-visa-4242",
            )
        )
    assert (error.value.code, error.value.status) == ("quote_mismatch", 422)
    with pytest.raises(WebAirError) as error:
        service.simulate_purchase(
            SimulatePurchaseRequest(
                booking=booking(),
                quote_id="WAQ-0000000000000000",
                payment_method_id="demo-visa-4242",
            )
        )
    assert error.value.code == "quote_mismatch"


@pytest.mark.parametrize(
    ("given", "family", "email"),
    [
        ("", "Lovelace", "ada@example.com"),
        ("Ada", "L" * 41, "ada@example.com"),
        ("<script>", "Lovelace", "ada@example.com"),
        ("Ada1", "Lovelace", "ada@example.com"),
        ("Ада", "Лавлейс", "ada@example.com"),
        ("Ada", "Lovelace", "not-an-email"),
        ("Ada", "Lovelace", "ada@example"),
        (" Ada", "Lovelace", "ada@example.com"),
    ],
)
def test_booking_inputs_are_bounded(given, family, email):
    with pytest.raises(ValueError):
        booking(names=((given, family),), email=email)


def test_names_allow_real_world_spelling():
    request = booking(names=(("Zoë", "O'Brien-Müller"), ("José María", "de la Cruz")))
    assert [p.family_name for p in request.passengers] == ["O'Brien-Müller", "de la Cruz"]


def test_passenger_list_is_bounded():
    with pytest.raises(ValueError):
        booking(names=())
    with pytest.raises(ValueError):
        booking(names=tuple(("Ada", "Lovelace") for _ in range(inv.MAX_PASSENGERS + 1)))
