"""The demo scenarios the WebAir package's fixture and tests replay.

Each scenario is one task for the package plus a script of what a model would answer at
each of its three model steps. Tool answers are never scripted: the fixture recorder and
the tests get them from this origin, so every price, rule, quote and confirmation below is
WebAir's own. The answer texts are hand-written to match those results, and a test checks
every price and identifier they quote against the run's evidence.

All passenger details are made up, and only WebAir's demo payment methods exist.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from origin.models import PassengerName, PrepareBookingRequest
from origin.service import WebAirService

HERO_REQUEST = "Find me a nonstop flight from Boston to Zurich on 9 October under $900."

DEMO_BOOKING = {
    "passengers": [
        {"given_name": "Alex", "family_name": "Example"},
        {"given_name": "Sam", "family_name": "Example"},
    ],
    "contact_email": "alex.example@example.com",
}
DEMO_PAYMENT_METHOD = "demo-visa-4242"

WA101_BASIC = "WA101-20261009-BASIC"
WA101_STANDARD = "WA101-20261009-STANDARD"
WA105_BASIC = "WA105-20261009-BASIC"
WA105_STANDARD = "WA105-20261009-STANDARD"
WA121_BUSINESS = "WA121-20261010-BUSINESS"


def _search(origin, destination, date, passengers=1, nonstop=False, max_price=None, cabin=None):
    return {
        "search": {
            "origin": origin,
            "destination": destination,
            "date": date,
            "passengers": passengers,
            "nonstop_only": nonstop,
            "max_price_usd": max_price,
            "cabin": cabin,
        },
        "unsupported_reason": None,
    }


def _selection(outcome, fare_ids=(), selected=None):
    return {"outcome": outcome, "fare_ids": list(fare_ids), "selected_fare_id": selected}


def _answer(text, mentioned=()):
    return {"answer": text, "mentioned_fare_ids": list(mentioned)}


def demo_quote_id() -> str:
    """The quote WebAir gives the demo booking, as the purchase scenario's authorization."""
    booking = PrepareBookingRequest(
        fare_id=WA101_STANDARD,
        passengers=[PassengerName(**p) for p in DEMO_BOOKING["passengers"]],
        contact_email=DEMO_BOOKING["contact_email"],
    )
    return WebAirService().prepare_booking(booking).quote_id


@dataclass(frozen=True)
class Scenario:
    id: str
    summary: str
    input: dict
    # Model task -> outputs in call order. A task the workflow skips has no output.
    models: dict[str, list[dict]]
    expect: dict = field(default_factory=dict)


HERO_PLAN = _search("BOS", "ZRH", "2026-10-09", nonstop=True, max_price=900)
HERO_FARES = (WA101_BASIC, WA101_STANDARD, WA105_BASIC)


def scenarios() -> list[Scenario]:
    quote_id = demo_quote_id()
    return [
        Scenario(
            id="hero",
            summary="BOS -> ZRH, 9 Oct 2026, nonstop, under $900",
            input={"request": HERO_REQUEST, "booking": None, "purchase": None},
            models={
                "interpret": [HERO_PLAN],
                "select": [_selection("options_found", HERO_FARES, WA101_BASIC)],
                "answer": [
                    _answer(
                        "I found three nonstop WebAir fares from Boston to Zurich on Friday "
                        "9 October 2026 under $900 per passenger:\n\n"
                        "- WA101, departs 18:05, arrives 07:40 the next day: Economy Basic $704 "
                        "or Economy Standard $858.\n"
                        "- WA105, departs 21:40, arrives 11:20 the next day: "
                        "Economy Basic $749.\n\n"
                        "The cheapest is WA101 Economy Basic at $704 (USD per passenger, taxes "
                        "included). Both Basic fares include no checked bag and can be neither "
                        "changed nor refunded. WA101 Economy Standard adds one 23 kg checked bag "
                        "and allows changes for $150 per passenger plus any fare difference; it "
                        "is also non-refundable. Nothing has been booked.",
                        HERO_FARES,
                    )
                ],
            },
            expect={"status": "options_found", "selected_fare_id": WA101_BASIC},
        ),
        Scenario(
            id="checked-bag",
            summary="the hero search, asking which fare includes a checked bag",
            input={
                "request": HERO_REQUEST + " Which of those fares includes a checked bag?",
                "booking": None,
                "purchase": None,
            },
            models={
                "interpret": [HERO_PLAN],
                "select": [_selection("options_found", HERO_FARES, WA101_STANDARD)],
                "answer": [
                    _answer(
                        "Of the three nonstop WebAir fares from Boston to Zurich on Friday "
                        "9 October 2026 under $900, only WA101 Economy Standard ($858 per "
                        "passenger) includes a checked bag: one bag of up to 23 kg. WA101 "
                        "Economy Basic ($704) and WA105 Economy Basic ($749) include a personal "
                        "item and an 8 kg cabin bag but no checked bag. WA101 departs Boston at "
                        "18:05 and arrives in Zurich at 07:40 the next day. The Standard fare "
                        "can be changed for $150 per passenger plus any fare difference and is "
                        "non-refundable. Nothing has been booked.",
                        HERO_FARES,
                    )
                ],
            },
            expect={"status": "options_found", "selected_fare_id": WA101_STANDARD},
        ),
        Scenario(
            id="fare-rules",
            summary="change and refund rules of the Standard fare, BOS -> ZRH nonstop",
            input={
                "request": "What are the change and refund rules for the Standard fare on the "
                "nonstop flights from Boston to Zurich on 9 October?",
                "booking": None,
                "purchase": None,
            },
            models={
                "interpret": [_search("BOS", "ZRH", "2026-10-09", nonstop=True)],
                "select": [
                    _selection("options_found", (WA101_STANDARD, WA105_STANDARD), WA101_STANDARD)
                ],
                "answer": [
                    _answer(
                        "Two nonstop WebAir flights from Boston to Zurich on Friday 9 October "
                        "2026 sell Economy Standard: WA101 (departs 18:05, arrives 07:40 the "
                        "next day) at $858 per passenger and WA105 (departs 21:40, arrives 11:20 "
                        "the next day) at $913. On both, Economy Standard can be changed for "
                        "$150 per passenger plus any fare difference, and it is non-refundable. "
                        "It includes one 23 kg checked bag and standard seat selection. The "
                        "cheaper of the two is WA101 at $858.",
                        (WA101_STANDARD, WA105_STANDARD),
                    )
                ],
            },
            expect={"status": "options_found", "selected_fare_id": WA101_STANDARD},
        ),
        Scenario(
            id="other-route",
            summary="JFK -> GVA, Saturday 10 Oct 2026, business class",
            input={
                "request": "One traveler from New York JFK to Geneva on Saturday 10 October "
                "2026, business class.",
                "booking": None,
                "purchase": None,
            },
            models={
                "interpret": [_search("JFK", "GVA", "2026-10-10", cabin="business")],
                "select": [_selection("options_found", (WA121_BUSINESS,), WA121_BUSINESS)],
                "answer": [
                    _answer(
                        "WebAir has one business-class option from New York JFK to Geneva on "
                        "Saturday 10 October 2026: WA121, nonstop, departing 18:45 and arriving "
                        "08:40 the next day, in Business at $3,034 per passenger (USD, taxes "
                        "included). It includes two checked bags of up to 32 kg each, free "
                        "changes (a fare difference may apply), and it is fully refundable "
                        "before departure. Nothing has been booked.",
                        (WA121_BUSINESS,),
                    )
                ],
            },
            expect={"status": "options_found", "selected_fare_id": WA121_BUSINESS},
        ),
        Scenario(
            id="no-results",
            summary="BOS -> GVA: two WebAir airports, but no WebAir route",
            input={
                "request": "I need a flight from Boston to Geneva on 9 October.",
                "booking": None,
                "purchase": None,
            },
            models={
                "interpret": [_search("BOS", "GVA", "2026-10-09")],
                "select": [_selection("no_matching_flights")],
                "answer": [
                    _answer(
                        "WebAir returned no flights from Boston (BOS) to Geneva (GVA) on "
                        "Friday 9 October 2026, so there is nothing to book for this search."
                    )
                ],
            },
            expect={"status": "no_matching_flights", "selected_fare_id": None},
        ),
        Scenario(
            id="refused",
            summary="a date outside WebAir's schedule; WebAir refuses the search",
            input={
                "request": "Find me a nonstop flight from Boston to Zurich on 9 October 2028 "
                "under $900.",
                "booking": None,
                "purchase": None,
            },
            models={
                "interpret": [_search("BOS", "ZRH", "2028-10-09", nonstop=True, max_price=900)],
                "select": [_selection("request_refused")],
                "answer": [
                    _answer(
                        "WebAir refused this search: its demo schedule covers 2026-10-01 to "
                        "2027-12-31, so it cannot search Boston to Zurich on 9 October 2028. "
                        "Nothing was found and nothing was booked."
                    )
                ],
            },
            expect={"status": "request_refused", "selected_fare_id": None},
        ),
        Scenario(
            id="unsupported",
            summary="a destination WebAir does not serve; nothing is searched",
            input={
                "request": "Book me a flight from Boston to Paris next Friday.",
                "booking": None,
                "purchase": None,
            },
            models={
                "interpret": [
                    {
                        "search": None,
                        "unsupported_reason": "WebAir does not serve Paris; it flies only "
                        "between Boston, New York JFK, Zurich, Geneva, London Heathrow and "
                        "Reykjavik.",
                    }
                ],
                "answer": [
                    _answer(
                        "I did not search: WebAir does not serve Paris. Its network is Boston, "
                        "New York JFK, Zurich, Geneva, London Heathrow and Reykjavik. Nothing "
                        "was booked."
                    )
                ],
            },
            expect={"status": "request_not_supported", "selected_fare_id": None},
        ),
        Scenario(
            id="booking",
            summary="the checked-bag fare, quoted for two demo passengers",
            input={
                "request": "Prepare a booking quote for two travelers on the nonstop flight "
                "from Boston to Zurich on 9 October under $900 that includes a checked bag.",
                "booking": DEMO_BOOKING,
                "purchase": None,
            },
            models={
                "interpret": [
                    _search("BOS", "ZRH", "2026-10-09", passengers=2, nonstop=True, max_price=900)
                ],
                "select": [_selection("options_found", HERO_FARES, WA101_STANDARD)],
                "answer": [
                    _answer(
                        "The only nonstop WebAir fare from Boston to Zurich on Friday 9 October "
                        "2026 under $900 that includes a checked bag is WA101 Economy Standard "
                        "at $858 per passenger, with one 23 kg checked bag each. WA101 departs "
                        "18:05 and arrives 07:40 the next day. WebAir quoted it for Alex "
                        f"Example and Sam Example: quote {quote_id}, total $1,716 for both "
                        "passengers. This is a quote, not a reservation: nothing is reserved "
                        "and nothing has been charged. The fare can be changed for $150 per "
                        "passenger plus any fare difference and is non-refundable.",
                        (WA101_STANDARD,),
                    )
                ],
            },
            expect={
                "status": "options_found",
                "selected_fare_id": WA101_STANDARD,
                "quote_id": quote_id,
            },
        ),
        Scenario(
            id="purchase",
            summary="the person authorizes that exact quote; WebAir simulates the purchase",
            input={
                "request": "Book the nonstop flight from Boston to Zurich on 9 October under "
                "$900 that includes a checked bag for two travelers, and simulate the purchase "
                "of the quote I approved.",
                "booking": DEMO_BOOKING,
                "purchase": {"quote_id": quote_id, "payment_method_id": DEMO_PAYMENT_METHOD},
            },
            models={
                "interpret": [
                    _search("BOS", "ZRH", "2026-10-09", passengers=2, nonstop=True, max_price=900)
                ],
                "select": [_selection("options_found", HERO_FARES, WA101_STANDARD)],
                "answer": [
                    _answer(
                        "Simulated purchase complete for WA101 Economy Standard from Boston to "
                        "Zurich on Friday 9 October 2026 (departs 18:05, arrives 07:40 the next "
                        "day) for Alex Example and Sam Example. Demo confirmation WA-DEMO-5KNBQ "
                        f"for quote {quote_id}, with Demo Visa •••• 4242. No real transaction "
                        "was performed: nothing was charged (the fare would have cost $1,716 for "
                        "both passengers), no seat is reserved and no ticket is issued. The "
                        "fare includes one 23 kg checked bag per passenger, changes for $150 "
                        "per passenger plus any fare difference, and is non-refundable.",
                        (WA101_STANDARD,),
                    )
                ],
            },
            expect={
                "status": "options_found",
                "selected_fare_id": WA101_STANDARD,
                "quote_id": quote_id,
                "confirmation_id": "WA-DEMO-5KNBQ",
            },
        ),
    ]


def scenario(scenario_id: str) -> Scenario:
    return next(s for s in scenarios() if s.id == scenario_id)
