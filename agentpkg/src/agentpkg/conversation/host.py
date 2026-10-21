"""The consent host of a conversation (conversation.v0 §3): what a turn asks when it reaches a
consent step, and the one host the Python reference ships, which answers from a transcript.

A host answers `accepted` or `denied` with its provenance. A host that cannot ask a person
answers `denied` with the reason `no_decision_available`, never `accepted` (V-12): the absence
of a yes is a no.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Protocol

from .errors import ConsentError

DECIDED_BY = ("person", "transcript", "plan", "host", "preset", "policy")
NO_DECISION = "no_decision_available"


@dataclass(frozen=True)
class ConsentRequest:
    """What the person sees: the step, the permissions it decides, the sentence and the facts."""

    conversation_id: str
    turn: int
    step: str
    permissions: tuple[str, ...]
    text: str
    facts: Any
    timeout_seconds: int


class ConsentHost(Protocol):
    async def decide(self, request: ConsentRequest) -> dict: ...


REASON_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def check_decision(value) -> dict:
    """A host's answer against the decision contract: `accepted` a boolean, `decided_by` one of
    the provenance words a host may claim (never `plan`, which only the runtime writes for a step
    it did not ask), an optional `reason` code by the transcript's pattern. Anything else is the
    host's failure."""
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("accepted"), bool)
        or value.get("decided_by") not in DECIDED_BY
        or value.get("decided_by") == "plan"
        or set(value) - {"accepted", "decided_by", "reason"}
    ):
        raise ConsentError(
            "consent_decision_invalid",
            "the consent host answered outside the decision contract "
            "({accepted: bool, decided_by (not plan), reason?})",
        )
    reason = value.get("reason")
    if reason is not None and not (isinstance(reason, str) and REASON_CODE.match(reason)):
        raise ConsentError("consent_decision_invalid", "the consent host's reason is not a code")
    return {"accepted": value["accepted"], "decided_by": value["decided_by"], "reason": reason}


class TranscriptConsent:
    """Decisions replayed from one turn of a transcript, by consent step id; a step the
    transcript does not decide is denied by the host (V-12)."""

    def __init__(self, decisions: dict[str, bool] | None):
        self.decisions = {step: bool(value) for step, value in (decisions or {}).items()}
        self.used: set[str] = set()

    async def decide(self, request: ConsentRequest) -> dict:
        await asyncio.sleep(0)
        if request.step in self.decisions:
            self.used.add(request.step)
            return {
                "accepted": self.decisions[request.step],
                "decided_by": "transcript",
                "reason": None,
            }
        return {"accepted": False, "decided_by": "host", "reason": NO_DECISION}


__all__ = [
    "DECIDED_BY",
    "NO_DECISION",
    "ConsentHost",
    "ConsentRequest",
    "TranscriptConsent",
    "check_decision",
]
