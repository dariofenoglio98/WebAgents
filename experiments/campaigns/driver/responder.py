"""The simulated responders (PROTOCOL.md §2.6.4, rule 8): one decision rule, two seats.

R-accept accepts every card; R-deny denies every card; **R-facts** (every campaign's default)
accepts a card whose facts equal the task's facts and the quote the run constructed, and denies
otherwise. Our side asks it through the consent host (`ConsentHost.decide` with the card's facts);
the framework agent's ask step asks it with the facts read from the proposed `simulate-purchase`
arguments and the quote the instrumented tool layer saw. Both seats normalise to the same facts and
call the same `decide`, so a decision never depends on which side asked (rule 11).
"""

from __future__ import annotations

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


def call_facts(arguments: dict, quotes: dict[str, dict]) -> dict:
    """The framework agent's proposed `simulate-purchase` call in the responder's terms; `quotes`
    are the `prepare-booking` answers the run's tool layer recorded, by quote id."""
    arguments = arguments if isinstance(arguments, dict) else {}
    booking = arguments.get("booking") or {}
    passengers = booking.get("passengers") or [{}]
    quote = quotes.get(arguments.get("quote_id")) or {}
    return {
        "quote_id": arguments.get("quote_id"),
        "fare_id": booking.get("fare_id"),
        "total_usd": quote.get("total_usd"),
        "passenger": [passengers[0].get("given_name"), passengers[0].get("family_name")]
        if len(passengers) == 1
        else None,
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
