"""The demo conversations the WebAir package's fixture, tests and host-capability runs replay.

Since 0.8.0 the package is conversational (conversation.v0, T24, D-274): each scenario is one
conversation of one or more turns, and each turn is one message for the package plus a script
of what a model would answer at each of the turn's model steps. Tool answers are never
scripted: the fixture recorder and the tests get them from this origin, so every price, rule,
quote and confirmation below is WebAir's own. The answer texts are hand-written to match those
results, and a test checks every price and identifier they quote against the run's evidence.

Three families:

* `scenarios()` — searches only, with no host resource involved. Their recorded model inputs
  and WebAir answers become the signed package's `fixtures/workflow.json`, and the first one
  is the package's conversation fixture (`fixtures/transcript.json`: a search, a refinement,
  goodbye), so the signed bytes contain no personal data at all.
* `conversation_scenarios()` — the host-owned capability demo on the 0.8.0 graph: a
  profile-assisted search, an explicit search with the profile denied, a quote, a quote of a
  fare an earlier turn offered, and a simulated purchase in a later turn (accepted on the
  card, declined on the card, and refused because the payment method is denied). Each says
  which permissions the person grants and which host resource they pick; the resources
  themselves are the demo host's (`host-resources.json`), never the package's.
* `capability_scenarios()` — the same demo as one-shot tasks of the 0.5.0 package, kept for the
  OpenClaw Agent Browser's acceptance document (`examples/webair-capability-scenarios.json`,
  D-233): that plugin is frozen and runs the signed 0.5.0 archive.

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
WA213_741_BASIC = "WA213-WA741-20261009-BASIC"
WA213_741_STANDARD = "WA213-WA741-20261009-STANDARD"
WA205_731_BASIC = "WA205-WA731-20261009-BASIC"
WA205_731_STANDARD = "WA205-WA731-20261009-STANDARD"

INTENTS = ("search", "quote", "purchase", "question", "done")


def _plan(intent, search=None, *, unsupported=None, profile=False, fare_id=None, note=None):
    """One interpreted message (`schemas/plan.schema.json`)."""
    return {
        "intent": intent,
        "search": search,
        "unsupported_reason": unsupported,
        "needs_travel_profile": profile,
        "fare_id": fare_id,
        "note": note,
    }


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
    intent="search",
):
    return _plan(
        intent,
        {
            "origin": origin,
            "destination": destination,
            "date": date,
            "passengers": passengers,
            "nonstop_only": nonstop,
            "max_price_usd": max_price,
            "cabin": cabin,
        },
        profile=profile,
    )


def _task(request, *, booking=False, purchase=None):
    """A 0.5.0 one-shot task (the frozen capability document)."""
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


# -- the 0.8.0 conversations ------------------------------------------------------------------


@dataclass(frozen=True)
class Turn:
    """One turn: the person's message, the model script of the turn (task -> outputs in call
    order; a task the turn skips has no output), the consent decisions the transcript supplies
    for the steps the turn may reach, and what the turn must yield."""

    message: str
    models: dict[str, list[dict]] = field(default_factory=dict)
    consents: dict[str, bool] = field(default_factory=dict)
    expect: dict = field(default_factory=dict)

    @property
    def input(self) -> dict:
        return {"message": self.message}

    def transcript_entry(self) -> dict:
        entry = {"message": self.input}
        if self.consents:
            entry["consents"] = dict(self.consents)
        return entry


@dataclass(frozen=True)
class Scenario:
    id: str
    summary: str
    turns: tuple[Turn, ...]
    # Host-capability scenarios only: the person's decision per permission (anything not
    # listed is granted for the session) and the host resource picked per permission.
    decisions: dict[str, str] = field(default_factory=dict)
    selections: dict[str, str] = field(default_factory=dict)
    # Whether the person closes the conversation after the last turn (`end` in the transcript).
    end: bool = False

    @property
    def input(self) -> dict:
        """The first message: the graph fixture's input."""
        return self.turns[0].input

    @property
    def expect(self) -> dict:
        """What the last turn must yield."""
        return self.turns[-1].expect

    def transcript(self) -> dict:
        document = {
            "schema": "conversation.transcript.v0",
            "turns": [turn.transcript_entry() for turn in self.turns],
        }
        if self.end:
            document["end"] = True
        return document


@dataclass(frozen=True)
class Task:
    """A one-shot task of the 0.5.0 package (the frozen capability document)."""

    id: str
    summary: str
    input: dict
    models: dict[str, list[dict]]
    expect: dict = field(default_factory=dict)
    decisions: dict[str, str] = field(default_factory=dict)
    selections: dict[str, str] = field(default_factory=dict)


HERO_PLAN = _search("BOS", "ZRH", "2026-10-09", nonstop=True, max_price=900)
HERO_FARES = (WA101_BASIC, WA101_STANDARD, WA105_BASIC)
BROAD_REQUEST = "Find me a flight from Boston to Zurich on 9 October under $900."
BROAD_PLAN = _search("BOS", "ZRH", "2026-10-09", nonstop=None, max_price=900)
# The six cheapest of the eight fares WebAir offers under $900 with stops allowed.
BROAD_FARES = (
    WA205_731_BASIC,
    WA213_741_BASIC,
    WA205_731_STANDARD,
    WA101_BASIC,
    WA213_741_STANDARD,
    WA105_BASIC,
)
GOODBYE = (
    "Glad to help. Nothing has been booked or charged; come back when you want to quote or "
    "book one of these fares."
)
HERO_ANSWER = _answer(
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


def hero_turn(message=HERO_REQUEST, plan=HERO_PLAN, answer=HERO_ANSWER) -> Turn:
    return Turn(
        message=message,
        models={
            "interpret": [plan],
            "select": [_selection("options_found", HERO_FARES, WA101_BASIC)],
            "answer": [answer],
        },
        expect={"status": "options_found", "intent": "search", "selected_fare_id": WA101_BASIC},
    )


def goodbye_turn(message="That's all, thanks.") -> Turn:
    """The person ends the conversation: the interpreter's note is the reply, no other model
    runs, and the package's end rule closes the conversation (`intent == done`)."""
    return Turn(
        message=message,
        models={"interpret": [_plan("done", note=GOODBYE)]},
        expect={"status": "done", "intent": "done", "selected_fare_id": None},
    )


def scenarios() -> list[Scenario]:
    """The fixture's conversations: searches only. The first is the conversation fixture."""
    return [
        Scenario(
            id="fixture",
            summary="the conversation fixture: BOS -> ZRH, 9 Oct 2026, under $900 with stops "
            "allowed; then nonstop and the cheapest; then goodbye",
            turns=(
                Turn(
                    message=BROAD_REQUEST,
                    models={
                        "interpret": [BROAD_PLAN],
                        "select": [_selection("options_found", BROAD_FARES, WA205_731_BASIC)],
                        "answer": [
                            _answer(
                                "WebAir has six fares from Boston to Zurich on Friday 9 October "
                                "2026 under $900 per passenger, two of them nonstop:\n\n"
                                "- WA205 + WA731 via Reykjavik, departs 20:30, arrives 13:15 the "
                                "next day: Economy Basic $505 or Economy Standard $616.\n"
                                "- WA213 + WA741 via London Heathrow, departs 19:10, arrives "
                                "11:25 the next day: Economy Basic $586 or Economy Standard "
                                "$715.\n"
                                "- WA101 nonstop, departs 18:05, arrives 07:40 the next day: "
                                "Economy Basic $704.\n"
                                "- WA105 nonstop, departs 21:40, arrives 11:20 the next day: "
                                "Economy Basic $749.\n\n"
                                "The cheapest is WA205 + WA731 Economy Basic at $505 (USD per "
                                "passenger, taxes included), with one stop in Reykjavik. Every "
                                "Basic fare includes no checked bag and can be neither changed "
                                "nor refunded; the Standard fares add one 23 kg checked bag and "
                                "allow changes for $150 per passenger plus any fare difference. "
                                "Nothing has been booked.",
                                BROAD_FARES,
                            )
                        ],
                    },
                    expect={
                        "status": "options_found",
                        "intent": "search",
                        "selected_fare_id": WA205_731_BASIC,
                    },
                ),
                hero_turn(
                    "Only nonstop, and the cheapest one.",
                    HERO_PLAN,
                    _answer(
                        "Nonstop, the cheapest is WA101 Economy Basic at $704 per passenger: "
                        "departs Boston 18:05 on Friday 9 October 2026, arrives Zurich 07:40 the "
                        "next day. It includes a personal item and an 8 kg cabin bag but no "
                        "checked bag, and can be neither changed nor refunded. The other nonstop "
                        "options under $900 are WA101 Economy Standard at $858 (one 23 kg checked "
                        "bag, changes for $150 per passenger plus any fare difference) and WA105 "
                        "Economy Basic at $749 (departs 21:40, arrives 11:20 the next day). "
                        "Nothing has been booked.",
                        HERO_FARES,
                    ),
                ),
                goodbye_turn(),
            ),
        ),
        Scenario(
            id="hero",
            summary="BOS -> ZRH, 9 Oct 2026, nonstop, under $900",
            turns=(hero_turn(),),
        ),
        Scenario(
            id="checked-bag",
            summary="the hero search, asking which fare includes a checked bag",
            turns=(
                Turn(
                    message=HERO_REQUEST + " Which of those fares includes a checked bag?",
                    models={
                        "interpret": [HERO_PLAN],
                        "select": [_selection("options_found", HERO_FARES, WA101_STANDARD)],
                        "answer": [
                            _answer(
                                "Of the three nonstop WebAir fares from Boston to Zurich on Friday "
                                "9 October 2026 under $900, only WA101 Economy Standard ($858 per "
                                "passenger) includes a checked bag: one bag of up to 23 kg. WA101 "
                                "Economy Basic ($704) and WA105 Economy Basic ($749) include a "
                                "personal item and an 8 kg cabin bag but no checked bag. WA101 "
                                "departs Boston at 18:05 and arrives in Zurich at 07:40 the next "
                                "day. The Standard fare can be changed for $150 per passenger "
                                "plus any fare difference and is non-refundable. Nothing has "
                                "been booked.",
                                HERO_FARES,
                            )
                        ],
                    },
                    expect={
                        "status": "options_found",
                        "intent": "search",
                        "selected_fare_id": WA101_STANDARD,
                    },
                ),
            ),
        ),
        Scenario(
            id="fare-rules",
            summary="change and refund rules of the Standard fare, BOS -> ZRH nonstop",
            turns=(
                Turn(
                    message="What are the change and refund rules for the Standard fare on the "
                    "nonstop flights from Boston to Zurich on 9 October?",
                    models={
                        "interpret": [_search("BOS", "ZRH", "2026-10-09", nonstop=True)],
                        "select": [
                            _selection(
                                "options_found", (WA101_STANDARD, WA105_STANDARD), WA101_STANDARD
                            )
                        ],
                        "answer": [
                            _answer(
                                "Two nonstop WebAir flights from Boston to Zurich on Friday 9 "
                                "October 2026 sell Economy Standard: WA101 (departs 18:05, arrives "
                                "07:40 the next day) at $858 per passenger and WA105 (departs "
                                "21:40, arrives 11:20 the next day) at $913. On both, Economy "
                                "Standard can be changed for $150 per passenger plus any fare "
                                "difference, and it is non-refundable. It includes one 23 kg "
                                "checked bag and standard seat selection. The cheaper of the two "
                                "is WA101 at $858.",
                                (WA101_STANDARD, WA105_STANDARD),
                            )
                        ],
                    },
                    expect={
                        "status": "options_found",
                        "intent": "search",
                        "selected_fare_id": WA101_STANDARD,
                    },
                ),
            ),
        ),
        Scenario(
            id="other-route",
            summary="JFK -> GVA, Saturday 10 Oct 2026, business class",
            turns=(
                Turn(
                    message="One traveler from New York JFK to Geneva on Saturday 10 October "
                    "2026, business class.",
                    models={
                        "interpret": [_search("JFK", "GVA", "2026-10-10", cabin="business")],
                        "select": [_selection("options_found", (WA121_BUSINESS,), WA121_BUSINESS)],
                        "answer": [
                            _answer(
                                "WebAir has one business-class option from New York JFK to Geneva "
                                "on Saturday 10 October 2026: WA121, nonstop, departing 18:45 and "
                                "arriving 08:40 the next day, in Business at $3,034 per passenger "
                                "(USD, taxes included). It includes two checked bags of up to 32 "
                                "kg each, free changes (a fare difference may apply), and it is "
                                "fully refundable before departure. Nothing has been booked.",
                                (WA121_BUSINESS,),
                            )
                        ],
                    },
                    expect={
                        "status": "options_found",
                        "intent": "search",
                        "selected_fare_id": WA121_BUSINESS,
                    },
                ),
            ),
        ),
        Scenario(
            id="no-results",
            summary="BOS -> GVA: two WebAir airports, but no WebAir route",
            turns=(
                Turn(
                    message="I need a flight from Boston to Geneva on 9 October.",
                    models={
                        "interpret": [_search("BOS", "GVA", "2026-10-09")],
                        "select": [_selection("no_matching_flights")],
                        "answer": [
                            _answer(
                                "WebAir returned no flights from Boston (BOS) to Geneva (GVA) on "
                                "Friday 9 October 2026, so there is nothing to book for this "
                                "search."
                            )
                        ],
                    },
                    expect={
                        "status": "no_matching_flights",
                        "intent": "search",
                        "selected_fare_id": None,
                    },
                ),
            ),
        ),
        Scenario(
            id="refused",
            summary="a date outside WebAir's schedule; WebAir refuses the search",
            turns=(
                Turn(
                    message="Find me a nonstop flight from Boston to Zurich on 9 October 2028 "
                    "under $900.",
                    models={
                        "interpret": [
                            _search("BOS", "ZRH", "2028-10-09", nonstop=True, max_price=900)
                        ],
                        "select": [_selection("request_refused")],
                        "answer": [
                            _answer(
                                "WebAir refused this search: its demo schedule covers 2026-10-01 "
                                "to 2027-12-31, so it cannot search Boston to Zurich on 9 October "
                                "2028. Nothing was found and nothing was booked."
                            )
                        ],
                    },
                    expect={
                        "status": "request_refused",
                        "intent": "search",
                        "selected_fare_id": None,
                    },
                ),
            ),
        ),
        Scenario(
            id="unsupported",
            summary="a destination WebAir does not serve; nothing is searched",
            turns=(
                Turn(
                    message="Book me a flight from Boston to Paris next Friday.",
                    models={
                        "interpret": [
                            _plan(
                                "search",
                                unsupported="WebAir does not serve Paris; it flies only between "
                                "Boston, New York JFK, Zurich, Geneva, London Heathrow and "
                                "Reykjavik.",
                            )
                        ],
                        "answer": [
                            _answer(
                                "I did not search: WebAir does not serve Paris. Its network is "
                                "Boston, New York JFK, Zurich, Geneva, London Heathrow and "
                                "Reykjavik. Nothing was booked."
                            )
                        ],
                    },
                    expect={
                        "status": "request_not_supported",
                        "intent": "search",
                        "selected_fare_id": None,
                    },
                ),
            ),
        ),
        Scenario(
            id="no-departure",
            summary="the request names no departure airport and no travel profile supplies one "
            "(0.5.0, B-124): nothing is searched and the answer asks where the trip starts",
            turns=(
                Turn(
                    message="Find me a flight to Zurich on 9 October under $900.",
                    models={
                        # The interpreter leaves the origin open without asking for the profile,
                        # as a local model did in the 2026-10-08 rehearsal; 0.4.0 then failed
                        # its own check.
                        "interpret": [
                            _search(None, "ZRH", "2026-10-09", nonstop=None, max_price=900)
                        ],
                        "answer": [
                            _answer(
                                "I did not search: your request does not say where you depart "
                                "from. Tell me your departure airport (Boston, New York JFK, "
                                "Zurich, Geneva, London Heathrow or Reykjavik), or use the agent "
                                "in a way that lets it read your travel profile. Nothing was "
                                "booked."
                            )
                        ],
                    },
                    expect={
                        "status": "request_not_supported",
                        "intent": "search",
                        "selected_fare_id": None,
                    },
                ),
            ),
        ),
    ]


def scenario(scenario_id: str) -> Scenario:
    return next(s for s in scenarios() if s.id == scenario_id)


# -- the host-owned capability demo, as a conversation (0.8.0) ---------------------------------

PROFILE_REQUEST = "Find me a flight to Zurich on 9 October under $900."
BOOKING_REQUEST = "Prepare WA101 Standard for 9 October for me."
PURCHASE_REQUEST = "Buy it."
VISA_CONFIRMATION = "WA-DEMO-TYD4M"
NOTHING_TO_REMEMBER = {"proposals": []}

# What every turn needs: WebAir's API, a model, run-scoped state and the fares module. Every
# personal permission is denied unless a scenario grants it, so each conversation asks for no
# more than it uses.
BASE_DECISIONS = {
    "network.webair": "session",
    "model.reasoning": "session",
    "memory.session": "session",
    "compute.fares": "session",
    "memory.travel_profile": "deny",
    "identity.passenger": "deny",
    "wallet.payment": "deny",
    "booking.simulate_purchase": "deny",
    "memory.remember": "deny",
}


def _decisions(**granted) -> dict[str, str]:
    renamed = {key.replace("__", "."): value for key, value in granted.items()}
    unknown = set(renamed) - set(BASE_DECISIONS)
    if unknown:
        raise KeyError(f"undeclared permissions: {sorted(unknown)}")
    return {**BASE_DECISIONS, **renamed}


def purchase_note(quote_id: str) -> str:
    """The sentence the interpreter writes for the card before the simulated purchase."""
    return (
        f"Simulate buying quote {quote_id}: WA101 Economy Standard, Boston to Zurich on Friday 9 "
        "October 2026, $858 for one passenger, with the payment method you chose?"
    )


def quote_turn(remember=None, *, quote_id: str) -> Turn:
    """The quote of WA101 Standard for the granted passenger, searched and quoted in one turn."""
    return Turn(
        message=BOOKING_REQUEST,
        models={
            "interpret": [_search("BOS", "ZRH", "2026-10-09", nonstop=None, intent="quote")],
            "select": [_selection("options_found", (WA101_STANDARD,), WA101_STANDARD)],
            "answer": [
                _answer(
                    "WebAir quoted WA101 Economy Standard from Boston to Zurich on Friday 9 "
                    "October 2026 (departs 18:05, arrives 07:40 the next day) for the "
                    f"passenger you granted: quote {quote_id}, fare {WA101_STANDARD}, $858 "
                    "for one passenger. This is a quote, not a reservation: nothing is "
                    "reserved and nothing has been charged. Economy Standard includes one "
                    "23 kg checked bag, can be changed for $150 plus any fare difference, "
                    'and is non-refundable. Say "buy it" to simulate the purchase; I will '
                    "ask you to confirm first.",
                    (WA101_STANDARD,),
                )
            ],
            "remember": [remember or NOTHING_TO_REMEMBER],
        },
        expect={
            "status": "quoted",
            "intent": "quote",
            "selected_fare_id": WA101_STANDARD,
            "quote_id": quote_id,
            "total_usd": 858,
            "passenger_count": 1,
        },
    )


def purchase_turn(accepted: bool | None, *, quote_id: str) -> Turn:
    """\"Buy it.\": the card is shown with the quote's facts; `accepted` is the person's
    decision (None: the turn never reaches the card)."""
    if accepted:
        answer = _answer(
            f"Simulated purchase complete: confirmation {VISA_CONFIRMATION} for quote "
            f"{quote_id}, WA101 Economy Standard ({WA101_STANDARD}) from Boston to Zurich on "
            "Friday 9 October 2026, with the payment method you chose. This was a simulation: "
            "no real transaction was performed and the amount charged is $0 (the fare would "
            "have cost $858). No seat is reserved and no ticket is issued.",
            (WA101_STANDARD,),
        )
        expect = {
            "status": "purchase_simulated",
            "intent": "purchase",
            "quote_id": quote_id,
            "confirmation_id": VISA_CONFIRMATION,
            "payment_display": "Demo Visa •••• 4242",
            "real_transaction": False,
            "amount_charged_usd": 0,
            "total_usd": 858,
        }
    else:
        answer = _answer(
            f"Understood, I did not buy anything. Quote {quote_id} for WA101 Economy Standard "
            f"({WA101_STANDARD}, $858 for one passenger) stays open; nothing is reserved and "
            "nothing has been charged.",
            (WA101_STANDARD,),
        )
        expect = {"status": "purchase_declined", "intent": "purchase", "quote_id": quote_id}
    return Turn(
        message=PURCHASE_REQUEST,
        models={
            "interpret": [_plan("purchase", note=purchase_note(quote_id))],
            **(
                {"answer": [answer], "remember": [NOTHING_TO_REMEMBER]}
                if accepted is not None
                else {}
            ),
        },
        consents={} if accepted is None else {"confirm-purchase": accepted},
        expect=expect,
    )


def conversation_scenarios() -> list[Scenario]:
    quote_id = demo_quote_id()
    passenger = {"identity.passenger": "passenger_demo_alex"}
    card = {**passenger, "wallet.payment": "payment_demo_visa"}
    return [
        Scenario(
            id="profile-search",
            summary="A: profile-assisted search; the granted travel profile supplies the home "
            "airport (BOS), the cabin (economy) and the nonstop preference",
            decisions=_decisions(memory__travel_profile="session"),
            selections={"memory.travel_profile": "profile_demo_traveler"},
            turns=(
                Turn(
                    message=PROFILE_REQUEST,
                    models={
                        "interpret": [
                            _search(
                                None, "ZRH", "2026-10-09", nonstop=None, max_price=900, profile=True
                            )
                        ],
                        "select": [_selection("options_found", HERO_FARES, WA101_BASIC)],
                        "answer": [
                            _answer(
                                "From your travel profile I searched nonstop economy flights from "
                                "Boston. WebAir has three such fares to Zurich on Friday 9 October "
                                "2026 under $900 per passenger:\n\n"
                                "- WA101, departs 18:05, arrives 07:40 the next day: Economy Basic "
                                "$704 or Economy Standard $858.\n"
                                "- WA105, departs 21:40, arrives 11:20 the next day: "
                                "Economy Basic $749.\n\n"
                                "The cheapest is WA101 Economy Basic at $704 (USD per passenger, "
                                "taxes included); it includes no checked bag and can be neither "
                                "changed nor refunded. Nothing has been booked.",
                                HERO_FARES,
                            )
                        ],
                    },
                    expect={
                        "status": "options_found",
                        "intent": "search",
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
            ),
        ),
        Scenario(
            id="explicit-search-profile-denied",
            summary="B: the request states BOS -> ZRH, nonstop, under $900; the travel profile "
            "is denied and never read",
            decisions=_decisions(),
            turns=(
                Turn(
                    message=HERO_REQUEST,
                    models={
                        "interpret": [HERO_PLAN],
                        "select": [_selection("options_found", HERO_FARES, WA101_BASIC)],
                        "answer": [
                            _answer(
                                "I found three nonstop WebAir fares from Boston to Zurich on "
                                "Friday 9 October 2026 under $900 per passenger: WA101 Economy "
                                "Basic $704 "
                                "and Economy Standard $858 (departs 18:05, arrives 07:40 the next "
                                "day), and WA105 Economy Basic $749 (departs 21:40, arrives 11:20 "
                                "the next day). The cheapest is WA101 Economy Basic; it includes "
                                "no checked bag and can be neither changed nor refunded. Nothing "
                                "has been booked.",
                                HERO_FARES,
                            )
                        ],
                    },
                    expect={
                        "status": "options_found",
                        "intent": "search",
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
            ),
        ),
        Scenario(
            id="quote",
            summary="C: a booking quote of WA101 Standard for the passenger the person grants, "
            "searched and quoted in one turn; the identity reaches only prepare_booking",
            decisions=_decisions(identity__passenger="session", memory__remember="session"),
            selections=passenger,
            turns=(quote_turn(quote_id=quote_id),),
        ),
        Scenario(
            id="quote-known-fare",
            summary="C': the hero search, then a quote of a fare that turn offered, by its id "
            "and without a new search",
            decisions=_decisions(identity__passenger="session", memory__remember="session"),
            selections=passenger,
            turns=(
                hero_turn(),
                Turn(
                    message="Quote WA101 Standard for me.",
                    models={
                        "interpret": [_plan("quote", fare_id=WA101_STANDARD)],
                        "answer": [
                            _answer(
                                "WebAir quoted WA101 Economy Standard from Boston to Zurich on "
                                "Friday 9 October 2026 for the passenger you granted: quote "
                                f"{quote_id}, fare {WA101_STANDARD}, $858 for one passenger. "
                                "This is a quote, not a reservation: nothing is reserved and "
                                'nothing has been charged. Say "buy it" to simulate the '
                                "purchase; I will ask you to confirm first.",
                                (WA101_STANDARD,),
                            )
                        ],
                        "remember": [NOTHING_TO_REMEMBER],
                    },
                    expect={
                        "status": "quoted",
                        "intent": "quote",
                        "selected_fare_id": None,
                        "quote_id": quote_id,
                        "total_usd": 858,
                        "passenger_count": 1,
                    },
                ),
            ),
        ),
        Scenario(
            id="purchase-denied",
            summary='D: "buy it" with the payment method and the purchase permission denied: '
            "the turn stops at the payment read, before any identity is read or any card shown",
            decisions=_decisions(identity__passenger="session", memory__remember="session"),
            selections=passenger,
            turns=(
                quote_turn(quote_id=quote_id),
                Turn(
                    message=PURCHASE_REQUEST,
                    models={"interpret": [_plan("purchase", note=purchase_note(quote_id))]},
                    expect={
                        "status": "failed",
                        "failed_node": "payment",
                        "error_code": "permission_denied",
                        "denied_permission": "wallet.payment",
                    },
                ),
            ),
        ),
        Scenario(
            id="purchase-declined",
            summary='E\': "buy it" with Demo Visa •••• 4242 granted; the person says no on the '
            "card, so nothing is purchased and the quote stays open",
            decisions=_decisions(
                identity__passenger="session",
                wallet__payment="session",
                booking__simulate_purchase="once",
                memory__remember="session",
            ),
            selections=card,
            turns=(quote_turn(quote_id=quote_id), purchase_turn(False, quote_id=quote_id)),
        ),
        Scenario(
            id="purchase",
            summary="E: a simulated purchase of the open quote with Demo Visa •••• 4242, the "
            "purchase permission granted once and the card accepted; nothing is charged; then "
            "goodbye",
            decisions=_decisions(
                identity__passenger="session",
                wallet__payment="session",
                booking__simulate_purchase="once",
                memory__remember="session",
            ),
            selections=card,
            turns=(
                quote_turn(quote_id=quote_id),
                purchase_turn(True, quote_id=quote_id),
                goodbye_turn(),
            ),
        ),
    ]


def conversation_scenario(scenario_id: str) -> Scenario:
    return next(s for s in conversation_scenarios() if s.id == scenario_id)


# -- the host-owned capability demo, as 0.5.0 one-shot tasks (frozen) --------------------------

# The 0.5.0 package's permission ids: the OpenClaw host's acceptance runs the signed 0.5.0
# archive (D-233), whose travel profile is a host resource, not a memory record.
TASK_DECISIONS = {
    "network.webair": "session",
    "model.reasoning": "session",
    "memory.session": "session",
    "profile.travel": "deny",
    "identity.passenger": "deny",
    "wallet.payment": "deny",
    "booking.simulate_purchase": "deny",
}


def _task_decisions(**granted) -> dict[str, str]:
    renamed = {key.replace("__", "."): value for key, value in granted.items()}
    unknown = set(renamed) - set(TASK_DECISIONS)
    if unknown:
        raise KeyError(f"undeclared permissions: {sorted(unknown)}")
    return {**TASK_DECISIONS, **renamed}


def _task_plan(plan: dict) -> dict:
    """A 0.8.0 plan as the 0.5.0 interpreter answered it (no intent, fare or note)."""
    return {k: plan[k] for k in ("search", "unsupported_reason", "needs_travel_profile")}


def purchase_task(quote_id: str) -> dict:
    return _task(
        f"Simulate purchase of quote {quote_id}.",
        purchase={"quote_id": quote_id, "fare_id": WA101_STANDARD},
    )


def capability_scenarios() -> list[Task]:
    quote_id = demo_quote_id()
    profile = conversation_scenario("profile-search").turns[0]
    explicit = conversation_scenario("explicit-search-profile-denied").turns[0]
    quote = conversation_scenario("quote").turns[0]
    return [
        Task(
            id="profile-search",
            summary="A: profile-assisted search; the granted travel profile supplies the home "
            "airport (BOS), the cabin (economy) and the nonstop preference",
            input=_task(PROFILE_REQUEST),
            decisions=_task_decisions(profile__travel="session"),
            selections={"profile.travel": "profile_demo_traveler"},
            models={
                "interpret": [_task_plan(profile.models["interpret"][0])],
                "select": profile.models["select"],
                "answer": profile.models["answer"],
            },
            expect={k: v for k, v in profile.expect.items() if k != "intent"},
        ),
        Task(
            id="explicit-search-profile-denied",
            summary="B: the request states BOS -> ZRH, nonstop, under $900; the travel profile "
            "is denied and never read",
            input=_task(HERO_REQUEST),
            decisions=_task_decisions(),
            models={
                "interpret": [_task_plan(explicit.models["interpret"][0])],
                "select": explicit.models["select"],
                "answer": explicit.models["answer"],
            },
            expect={k: v for k, v in explicit.expect.items() if k != "intent"},
        ),
        Task(
            id="booking",
            summary="C: a booking quote of WA101 Standard for the passenger the person grants; "
            "the identity reaches only prepare_booking",
            input=_task(BOOKING_REQUEST, booking=True),
            decisions=_task_decisions(identity__passenger="session"),
            selections={"identity.passenger": "passenger_demo_alex"},
            models={
                "interpret": [_task_plan(quote.models["interpret"][0])],
                "select": quote.models["select"],
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
        Task(
            id="purchase-denied",
            summary="D: a purchase task from a trusted package with the payment method and the "
            "purchase permission denied: no payment resolution, no purchase call",
            input=purchase_task(quote_id),
            decisions=_task_decisions(identity__passenger="session"),
            selections={"identity.passenger": "passenger_demo_alex"},
            models={},
            expect={
                "status": "failed",
                "failed_node": "payment",
                "error_code": "permission_denied",
                "denied_permission": "wallet.payment",
            },
        ),
        Task(
            id="purchase-visa",
            summary="E: a simulated purchase of that exact quote with Demo Visa •••• 4242, "
            "the purchase permission granted once; nothing is charged",
            input=purchase_task(quote_id),
            decisions=_task_decisions(
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


def capability_scenario(scenario_id: str) -> Task:
    return next(s for s in capability_scenarios() if s.id == scenario_id)
