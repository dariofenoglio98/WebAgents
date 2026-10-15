"""The demo scenarios the WebAir package's fixture, tests and host-capability runs replay.

Each scenario is one task for the package plus a script of what a model would answer at
each of its model steps. Tool answers are never scripted: the fixture recorder and the tests
get them from this origin, so every price, rule, quote and confirmation below is WebAir's
own. The answer texts are hand-written to match those results, and a test checks every price
and identifier they quote against the run's evidence.

Two families:

* `scenarios()` — searches only, with no host resource involved. Their recorded model inputs
  and WebAir answers become the signed package's `fixtures/workflow.json`, which therefore
  contains no personal data at all.
* `capability_scenarios()` — the host-owned capability demo: a profile-assisted search, an
  explicit search with the profile denied, a booking quote for a granted passenger, a
  purchase with the payment permission denied, and a simulated purchase with a granted demo
  payment method. Each says which permissions the person grants and which host resource they
  pick; the resources themselves are the demo host's (`host-resources.json`), never the
  package's.

All identities and payment methods are fictional; only WebAir's demo payment methods exist.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from origin.models import PassengerName, PrepareBookingRequest
from origin.service import WebAirService

from .host import resource_value

HERO_REQUEST = "Find me a nonstop flight from Boston to Zurich on 9 October under $900."
NO_PURCHASE = {"quote_id": "", "fare_id": ""}

WA101_BASIC = "WA101-20261009-BASIC"
WA101_STANDARD = "WA101-20261009-STANDARD"
WA105_BASIC = "WA105-20261009-BASIC"
WA105_STANDARD = "WA105-20261009-STANDARD"
WA121_BUSINESS = "WA121-20261010-BUSINESS"


def _search(
    origin,
    destination,
    date,
    passengers=1,
    nonstop=False,
    max_price=None,
    cabin=None,
    *,
    profile=False,
):
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
        "needs_travel_profile": profile,
    }


def _task(request, *, booking=False, purchase=None):
    return {"request": request, "booking": booking, "purchase": purchase or dict(NO_PURCHASE)}


def _selection(outcome, fare_ids=(), selected=None):
    return {"outcome": outcome, "fare_ids": list(fare_ids), "selected_fare_id": selected}


def _answer(text, mentioned=()):
    return {"answer": text, "mentioned_fare_ids": list(mentioned)}


def demo_booking(passenger_id: str = "passenger_demo_alex", fare_id: str = None) -> dict:
    """The booking request WebAir receives for a granted passenger: built by the graph."""
    identity = resource_value(passenger_id)
    return {
        "fare_id": fare_id or WA101_STANDARD,
        "passengers": [
            {"given_name": identity["given_name"], "family_name": identity["family_name"]}
        ],
        "contact_email": identity["contact_email"],
    }


def demo_quote_id(passenger_id: str = "passenger_demo_alex") -> str:
    """The quote WebAir gives the granted passenger for WA101 Standard on 9 October."""
    booking = demo_booking(passenger_id)
    request = PrepareBookingRequest(
        fare_id=booking["fare_id"],
        passengers=[PassengerName(**p) for p in booking["passengers"]],
        contact_email=booking["contact_email"],
    )
    return WebAirService().prepare_booking(request).quote_id


@dataclass(frozen=True)
class Scenario:
    id: str
    summary: str
    input: dict
    # Model task -> outputs in call order. A task the workflow skips has no output.
    models: dict[str, list[dict]]
    expect: dict = field(default_factory=dict)
    # Host-capability scenarios only: the person's decision per permission (anything not
    # listed is granted for the session) and the host resource picked per permission.
    decisions: dict[str, str] = field(default_factory=dict)
    selections: dict[str, str] = field(default_factory=dict)


HERO_PLAN = _search("BOS", "ZRH", "2026-10-09", nonstop=True, max_price=900)
HERO_FARES = (WA101_BASIC, WA101_STANDARD, WA105_BASIC)


def scenarios() -> list[Scenario]:
    return [
        Scenario(
            id="hero",
            summary="BOS -> ZRH, 9 Oct 2026, nonstop, under $900",
            input=_task(HERO_REQUEST),
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
                "booking": False,
                "purchase": dict(NO_PURCHASE),
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
                "booking": False,
                "purchase": dict(NO_PURCHASE),
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
                "booking": False,
                "purchase": dict(NO_PURCHASE),
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
                "booking": False,
                "purchase": dict(NO_PURCHASE),
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
                "booking": False,
                "purchase": dict(NO_PURCHASE),
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
                "booking": False,
                "purchase": dict(NO_PURCHASE),
            },
            models={
                "interpret": [
                    {
                        "search": None,
                        "unsupported_reason": "WebAir does not serve Paris; it flies only "
                        "between Boston, New York JFK, Zurich, Geneva, London Heathrow and "
                        "Reykjavik.",
                        "needs_travel_profile": False,
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
            id="no-departure",
            summary="the request names no departure airport and no travel profile supplies one "
            "(0.5.0, B-124): nothing is searched and the answer asks where the trip starts",
            input=_task("Find me a flight to Zurich on 9 October under $900."),
            models={
                # The interpreter leaves the origin open without asking for the profile, as a
                # local model did in the 2026-10-08 rehearsal; 0.4.0 then failed its own check.
                "interpret": [_search(None, "ZRH", "2026-10-09", nonstop=None, max_price=900)],
                "answer": [
                    _answer(
                        "I did not search: your request does not say where you depart from. "
                        "Tell me your departure airport (Boston, New York JFK, Zurich, Geneva, "
                        "London Heathrow or Reykjavik), or use the agent in a way that lets it "
                        "read your travel profile. Nothing was booked."
                    )
                ],
            },
            expect={"status": "request_not_supported", "selected_fare_id": None},
        ),
    ]


def scenario(scenario_id: str) -> Scenario:
    return next(s for s in scenarios() if s.id == scenario_id)


# -- the host-owned capability demo ---------------------------------------------------------

PROFILE_REQUEST = "Find me a flight to Zurich on 9 October under $900."
BOOKING_REQUEST = "Prepare WA101 Standard for 9 October for me."
VISA_CONFIRMATION = "WA-DEMO-TYD4M"

# What every run needs: WebAir's API, a model and run-scoped state. Every personal
# permission is denied unless a scenario grants it, so each run asks for no more than it uses.
BASE_DECISIONS = {
    "network.webair": "session",
    "model.reasoning": "session",
    "memory.session": "session",
    "profile.travel": "deny",
    "identity.passenger": "deny",
    "wallet.payment": "deny",
    "booking.simulate_purchase": "deny",
}


def _decisions(**granted) -> dict[str, str]:
    renamed = {key.replace("__", "."): value for key, value in granted.items()}
    unknown = set(renamed) - set(BASE_DECISIONS)
    if unknown:
        raise KeyError(f"undeclared permissions: {sorted(unknown)}")
    return {**BASE_DECISIONS, **renamed}


def purchase_task(quote_id: str) -> dict:
    return _task(
        f"Simulate purchase of quote {quote_id}.",
        purchase={"quote_id": quote_id, "fare_id": WA101_STANDARD},
    )


def capability_scenarios() -> list[Scenario]:
    quote_id = demo_quote_id()
    return [
        Scenario(
            id="profile-search",
            summary="A: profile-assisted search; the granted travel profile supplies the home "
            "airport (BOS), the cabin (economy) and the nonstop preference",
            input=_task(PROFILE_REQUEST),
            decisions=_decisions(profile__travel="session"),
            selections={"profile.travel": "profile_demo_traveler"},
            models={
                "interpret": [
                    _search(None, "ZRH", "2026-10-09", nonstop=None, max_price=900, profile=True)
                ],
                "select": [_selection("options_found", HERO_FARES, WA101_BASIC)],
                "answer": [
                    _answer(
                        "From your travel profile I searched nonstop economy flights from "
                        "Boston. WebAir has three such fares to Zurich on Friday 9 October 2026 "
                        "under $900 per passenger:\n\n"
                        "- WA101, departs 18:05, arrives 07:40 the next day: Economy Basic $704 "
                        "or Economy Standard $858.\n"
                        "- WA105, departs 21:40, arrives 11:20 the next day: "
                        "Economy Basic $749.\n\n"
                        "The cheapest is WA101 Economy Basic at $704 (USD per passenger, taxes "
                        "included); it includes no checked bag and can be neither changed nor "
                        "refunded. Nothing has been booked.",
                        HERO_FARES,
                    )
                ],
            },
            expect={
                "status": "options_found",
                "selected_fare_id": WA101_BASIC,
                "search_query": {
                    "origin": "BOS",
                    "destination": "ZRH",
                    "date": "2026-10-09",
                    "passengers": 1,
                    "nonstop_only": True,
                    "max_price_usd": 900,
                    "cabin": "economy",
                },
                "offered_fare_ids": list(HERO_FARES),
            },
        ),
        Scenario(
            id="explicit-search-profile-denied",
            summary="B: the request states BOS -> ZRH, nonstop, under $900; the travel profile "
            "is denied and never read",
            input=_task(HERO_REQUEST),
            decisions=_decisions(),
            models={
                "interpret": [HERO_PLAN],
                "select": [_selection("options_found", HERO_FARES, WA101_BASIC)],
                "answer": [
                    _answer(
                        "I found three nonstop WebAir fares from Boston to Zurich on Friday "
                        "9 October 2026 under $900 per passenger: WA101 Economy Basic $704 and "
                        "Economy Standard $858 (departs 18:05, arrives 07:40 the next day), and "
                        "WA105 Economy Basic $749 (departs 21:40, arrives 11:20 the next day). "
                        "The cheapest is WA101 Economy Basic; it includes no checked bag and "
                        "can be neither changed nor refunded. Nothing has been booked.",
                        HERO_FARES,
                    )
                ],
            },
            expect={
                "status": "options_found",
                "selected_fare_id": WA101_BASIC,
                "search_query": {
                    "origin": "BOS",
                    "destination": "ZRH",
                    "date": "2026-10-09",
                    "passengers": 1,
                    "nonstop_only": True,
                    "max_price_usd": 900,
                    "cabin": None,
                },
                "offered_fare_ids": list(HERO_FARES),
            },
        ),
        Scenario(
            id="booking",
            summary="C: a booking quote of WA101 Standard for the passenger the person grants; "
            "the identity reaches only prepare_booking",
            input=_task(BOOKING_REQUEST, booking=True),
            decisions=_decisions(identity__passenger="session"),
            selections={"identity.passenger": "passenger_demo_alex"},
            models={
                "interpret": [_search("BOS", "ZRH", "2026-10-09", nonstop=None)],
                "select": [_selection("options_found", (WA101_STANDARD,), WA101_STANDARD)],
                "answer": [
                    _answer(
                        "WebAir quoted WA101 Economy Standard from Boston to Zurich on Friday 9 "
                        "October 2026 (departs 18:05, arrives 07:40 the next day) for the "
                        f"passenger you granted: quote {quote_id}, fare {WA101_STANDARD}, $858 "
                        "for one passenger. This is a quote, not a reservation: nothing is "
                        "reserved and nothing has been charged. Economy Standard includes one "
                        "23 kg checked bag, can be changed for $150 plus any fare difference, "
                        "and is non-refundable.",
                        (WA101_STANDARD,),
                    )
                ],
            },
            expect={
                "status": "options_found",
                "selected_fare_id": WA101_STANDARD,
                "quote_id": quote_id,
                "total_usd": 858,
                "passenger_count": 1,
            },
        ),
        Scenario(
            id="purchase-denied",
            summary="D: a purchase task from a trusted package with the payment method and the "
            "purchase permission denied: no payment resolution, no purchase call",
            input=purchase_task(quote_id),
            decisions=_decisions(identity__passenger="session"),
            selections={"identity.passenger": "passenger_demo_alex"},
            models={},
            expect={
                "status": "failed",
                "failed_node": "payment",
                "error_code": "permission_denied",
                "denied_permission": "wallet.payment",
            },
        ),
        Scenario(
            id="purchase-visa",
            summary="E: a simulated purchase of that exact quote with Demo Visa •••• 4242, "
            "the purchase permission granted once; nothing is charged",
            input=purchase_task(quote_id),
            decisions=_decisions(
                identity__passenger="session",
                wallet__payment="session",
                booking__simulate_purchase="once",
            ),
            selections={
                "identity.passenger": "passenger_demo_alex",
                "wallet.payment": "payment_demo_visa",
            },
            models={
                "answer": [
                    _answer(
                        f"Simulated purchase complete: confirmation {VISA_CONFIRMATION} for "
                        f"quote {quote_id}, WA101 Economy Standard ({WA101_STANDARD}) from "
                        "Boston to Zurich on Friday 9 October 2026, with the payment method you "
                        "chose. This was a simulation: no real transaction was performed and "
                        "the amount charged is $0 (the fare would have cost $858). No seat is "
                        "reserved and no ticket is issued.",
                        (WA101_STANDARD,),
                    )
                ]
            },
            expect={
                "status": "purchase_simulated",
                "quote_id": quote_id,
                "confirmation_id": VISA_CONFIRMATION,
                "payment_display": "Demo Visa •••• 4242",
                "real_transaction": False,
                "amount_charged_usd": 0,
                "total_usd": 858,
            },
        ),
    ]


def capability_scenario(scenario_id: str) -> Scenario:
    return next(s for s in capability_scenarios() if s.id == scenario_id)


# WebAir 0.6.0 (memory.v0, T20) reads the travel profile through `memory.read` under the
# permission `memory.travel_profile` and may propose one travel preference after a booking
# (`memory.remember`, the model task `remember`). The capability scenarios above keep 0.5.0's
# permission ids because their document is the OpenClaw host's acceptance on the signed 0.5.0
# archive (D-233); `source_scenario` is the same scenario for the 0.6.0 source.
SOURCE_RENAMES = {"profile.travel": "memory.travel_profile"}
NOTHING_TO_REMEMBER = {"proposals": []}


def source_scenario(scenario: Scenario, remember: list[dict] | None = None) -> Scenario:
    """`scenario` with 0.6.0's permission ids, `memory.remember` granted for the session, and
    the `remember` step's scripted answers (nothing to remember unless given)."""
    from dataclasses import replace

    decisions = {SOURCE_RENAMES.get(k, k): v for k, v in scenario.decisions.items()}
    if decisions:
        decisions["memory.remember"] = "session"
    selections = {SOURCE_RENAMES.get(k, k): v for k, v in scenario.selections.items()}
    models = {**scenario.models, "remember": remember or [NOTHING_TO_REMEMBER]}
    return replace(scenario, decisions=decisions, selections=selections, models=models)
