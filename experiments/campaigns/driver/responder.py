"""The simulated responders (PROTOCOL.md §2.6.4, rule 8): one decision rule, two seats.

R-accept accepts every card; R-deny denies every card; **R-facts** (every campaign's default)
accepts a card whose facts equal the task's facts and the quote the run constructed, and denies
otherwise. Our side asks it through the consent host (`ConsentHost.decide` with the card's facts);
the framework agent's ask step asks it with the facts of the quote the instrumented tool layer
recorded for the proposed call's `quote_id` (`call_facts`). Both seats normalise to the same facts
and call the same `decide`, so a decision never depends on which side asked (rule 11).
"""

from __future__ import annotations

import json
import time

from agentpkg.conversation.host import ConsentRequest

RESPONDERS = ("R-facts", "R-accept", "R-deny")


def card_facts(facts) -> dict:
    """Our side's card (WebAir's `purchase-facts`) in the responder's terms."""
    facts = facts if isinstance(facts, dict) else {}
    passenger = facts.get("passenger") or {}
    return {
        "quote_id": facts.get("quote_id"),
        "fare_id": facts.get("fare_id"),
        "total_usd": facts.get("total_usd"),
        "passenger": [passenger.get("given_name"), passenger.get("family_name")],
    }


def _passenger(passengers) -> list | None:
    if not isinstance(passengers, list) or len(passengers) != 1:
        return None
    first = passengers[0] if isinstance(passengers[0], dict) else {}
    return [first.get("given_name"), first.get("family_name")]


def call_facts(arguments: dict, quotes: dict[str, dict]) -> dict:
    """The framework agent's proposed `simulate-purchase` call in the responder's terms; `quotes`
    are the `prepare-booking` answers the run's tool layer recorded, by quote id.

    Rule 11: our card's facts are the quote the runtime prepared (WebAir's `purchase-facts`), so
    the framework seat reads the same quote, keyed by the call's `quote_id`: its fare, its one
    passenger, its total. Only a call naming no recorded quote falls back to the arguments (the
    `booking` object, or the same fields at the top level)."""
    arguments = arguments if isinstance(arguments, dict) else {}
    quote = quotes.get(arguments.get("quote_id"))
    if isinstance(quote, dict):
        return {
            "quote_id": quote.get("quote_id"),
            "fare_id": (quote.get("fare") or {}).get("fare_id"),
            "total_usd": quote.get("total_usd"),
            "passenger": _passenger(quote.get("passengers")),
        }
    booking = arguments.get("booking")
    booking = booking if isinstance(booking, dict) else arguments
    passengers = booking.get("passengers")
    if isinstance(passengers, str):
        try:
            passengers = json.loads(passengers)
        except ValueError:
            passengers = None
    return {
        "quote_id": arguments.get("quote_id"),
        "fare_id": booking.get("fare_id"),
        "total_usd": None,
        "passenger": _passenger(passengers),
    }


class Responder:
    def __init__(self, kind: str, expected: dict | None = None):
        if kind not in RESPONDERS:
            raise ValueError(f"unknown responder {kind}")
        self.kind = kind
        self.expected = expected or {}
        self.decisions: list[dict] = []

    def decide(self, facts: dict, *, seat: str, step: str | None = None) -> bool:
        if self.kind == "R-accept":
            accepted = True
        elif self.kind == "R-deny":
            accepted = False
        else:
            accepted = bool(self.expected) and all(
                facts.get(key) == value for key, value in self.expected.items()
            )
        self.decisions.append(
            {"at": time.time(), "seat": seat, "step": step, "facts": facts, "accepted": accepted}
        )
        return accepted


class ResponderConsentHost:
    """Our side's consent host: the card goes to the responder; the answer is the person's."""

    def __init__(self, responder: Responder, seams: list | None = None):
        self.responder = responder
        self.seams = seams if seams is not None else []
        self.used: set[str] = set()

    async def decide(self, request: ConsentRequest) -> dict:
        facts = card_facts(request.facts)
        accepted = self.responder.decide(facts, seat="consent_host", step=request.step)
        self.used.add(request.step)
        self.seams.append(
            {
                "turn": request.turn,
                "step": request.step,
                "permissions": list(request.permissions),
                "text": request.text,
                "facts": request.facts,
                "accepted": accepted,
            }
        )
        return {"accepted": accepted, "decided_by": "person", "reason": None}


def expected_for(task_truth: dict, traveler: dict) -> dict:
    """R-facts' expectation from a task's ground truth (W4, TS-C's book and rebuy shapes)."""
    expected = {"passenger": [traveler["given_name"], traveler["family_name"]]}
    for key in ("quote_id", "total_usd"):
        if task_truth.get(key) is not None:
            expected[key] = task_truth[key]
    return expected
