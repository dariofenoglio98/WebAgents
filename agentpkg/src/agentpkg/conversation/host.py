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


#: What a run may ask the person outside a conversation's consent steps (link.v0 §6, §7): to
#: join a package found during the run, and to raise their own run limit.
RUN_REQUEST_KINDS = ("link.join", "budget.raise")


@dataclass(frozen=True)
class RunRequest:
    """One card of a run: its kind, the run and the step that asks, and the facts the runtime
    computed (`schemas/link-join-card.schema.json`, `schemas/budget-raise-card.schema.json`).
    Nothing on it is a model's word except the member the facts mark as the agent's."""

    kind: str
    run_id: str
    node_id: str
    facts: Any
    timeout_seconds: float


class RunConsentHost(Protocol):
    async def ask(self, request: RunRequest) -> dict: ...


def check_run_decision(kind: str, value) -> dict:
    """A host's answer to a run's card against its contract: `accepted` a boolean, `provenance`
    a code naming where the answer came from (the host's surface, a fixture); for a join that
    is accepted, the joined package's own `grants` and `approved_tools` (the card is that
    package's authorization). Anything else is the host's failure, never a yes."""
    allowed = {"accepted", "provenance"} | (
        {"grants", "approved_tools"} if kind == "link.join" else set()
    )
    provenance = value.get("provenance") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("accepted"), bool)
        or not (isinstance(provenance, str) and REASON_CODE.match(provenance))
        or set(value) - allowed
    ):
        raise ConsentError(
            "consent_decision_invalid",
            f"the host answered a {kind} card outside the decision contract "
            "({accepted: bool, provenance: code, …})",
        )
    decision = {"accepted": value["accepted"], "provenance": provenance}
    if kind == "link.join":
        grants = value.get("grants", {})
        approved = value.get("approved_tools", [])
        if (
            not isinstance(grants, dict)
            or not all(isinstance(k, str) and isinstance(v, str) for k, v in grants.items())
            or not isinstance(approved, list)
            or not all(isinstance(tool, str) for tool in approved)
        ):
            raise ConsentError(
                "consent_decision_invalid",
                "a join decision's grants are a map of permission ids to scopes and its "
                "approved_tools a list of tool ids",
            )
        decision |= {"grants": dict(grants), "approved_tools": sorted(set(approved))}
    return decision


__all__ = [
    "DECIDED_BY",
    "NO_DECISION",
    "RUN_REQUEST_KINDS",
    "ConsentHost",
    "ConsentRequest",
    "RunConsentHost",
    "RunRequest",
    "TranscriptConsent",
    "check_decision",
    "check_run_decision",
]
