"""The conversation runner (conversation.v0 §4–§6): turn by turn over the interpreter, under one
Run Plan's grants, with the persisted state, the whole-turn reservation against the
conversation's budget, `once` spent once per conversation, the consent host and one audit chain.

Nothing here is package-specific. The host supplies, per turn, the model router, the tool
handlers and the run's memory; the runner supplies the turn context (`TurnContext`) the
interpreter and the mediator read.
"""

from __future__ import annotations

import copy
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import uuid4

from ..runtime import PolicyError, digest
from ..workflow import Workflow, failure_code
from ..workflow_values import evaluate
from .chain import AuditChain
from .declarations import conversation_of, persistent_keys
from .errors import ConversationError
from .host import TranscriptConsent
from .transcript import turn_decisions

PROFILE = "conversation.v0"
INTERPRETER = "agentpkg.conversation.Conversation"
#: Host limits of a conversation; like every host limit they only lower the package's (V-11).
HOST_KEYS = {
    "conversation_max_turns": "max_turns",
    "conversation_total_tokens": "hard_tokens",
    "conversation_max_remote_calls": "max_remote_calls",
}


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class TurnContext:
    """What one turn holds about its conversation; read by `Workflow` and `Runtime`."""

    conversation_id: str
    turn: int
    state: dict
    chain: AuditChain
    consent: object
    spent: set = field(default_factory=set)
    tool_caps: dict = field(default_factory=dict)


@dataclass(frozen=True)
class ConversationLimits:
    max_turns: int
    hard_tokens: int
    max_remote_calls: int
    max_calls_per_tool: dict

    def as_json(self) -> dict:
        return {
            "max_turns": self.max_turns,
            "hard_tokens": self.hard_tokens,
            "max_remote_calls": self.max_remote_calls,
            "max_calls_per_tool": dict(self.max_calls_per_tool),
        }


def split_limits(limits) -> tuple[dict, dict]:
    """The host's `--limits`: the conversation's keys apart from the turn's (which `Runtime`
    checks as it always did)."""
    limits = dict(limits or {})
    conversation = {}
    for key, name in HOST_KEYS.items():
        if key in limits:
            value = limits.pop(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise PolicyError(f"Host limit {key} must be a nonnegative integer")
            conversation[name] = value
    return conversation, limits


def effective_limits(package, host: dict) -> ConversationLimits:
    declared = conversation_of(package.graph)["budget"]
    caps = dict(declared.get("max_calls_per_tool", {}))
    return ConversationLimits(
        max_turns=min(declared["max_turns"], host.get("max_turns", declared["max_turns"])),
        hard_tokens=min(declared["hard_tokens"], host.get("hard_tokens", declared["hard_tokens"])),
        max_remote_calls=min(
            declared["max_remote_calls"],
            host.get("max_remote_calls", declared["max_remote_calls"]),
        ),
        max_calls_per_tool=caps,
    )


class Conversation:
    """One conversation of one package under one set of grants. `adapters(turn)` is the host's
    per-turn factory: `{"router", "handlers", "memory"}`; `consent(turn, decisions)` makes the
    turn's consent host (the transcript's by default); `on_turn(index, report, status)` lets a
    host write a turn's artifacts as soon as the turn ends."""

    def __init__(
        self,
        package,
        *,
        grants,
        approved_tools,
        adapters,
        limits=None,
        consent=None,
        observer=None,
        on_turn=None,
    ):
        if conversation_of(package.graph) is None:
            raise ConversationError(
                "conversation_profile_required", "this package declares no conversation"
            )
        self.package = package
        self.grants = dict(grants)
        self.approved_tools = list(approved_tools)
        self.adapters = adapters
        host, turn_limits = split_limits(limits)
        self.limits = effective_limits(package, host)
        self.turn_limits = turn_limits
        self.consent = consent or (lambda turn, decisions: TranscriptConsent(decisions))
        self.observer = observer
        self.on_turn = on_turn
        self.conversation_id = str(uuid4())
        self.chain = AuditChain(self.conversation_id, observer=observer)
        self.spent: set[str] = set()
        self.tokens = 0
        self.remote_calls = 0
        self.tool_calls: Counter = Counter()
        self.turns: list[dict] = []
        self.state = copy.deepcopy(evaluate(conversation_of(package.graph)["initial"], {}))
        self.started_at = _now()
        self.ended: dict | None = None

    # -- the loop -------------------------------------------------------------------------

    async def run(self, transcript: dict) -> dict:
        package = self.package
        conversation = conversation_of(package.graph)
        turns = transcript["turns"]
        self.chain.record(
            "conversation.started",
            package_id=package.manifest["package_id"],
            package_version=package.manifest["version"],
            package_digest=package.digest,
            limits=self.limits.as_json(),
            grant_scopes=dict(self.grants),
            turns_supplied=len(turns),
            state_hash=digest(self.state),
        )
        for index, turn_in in enumerate(turns, start=1):
            self.chain.turn = index
            refusal = self._reserve(index)
            if refusal is not None:
                self._refuse_turn(index, turn_in, refusal)
                self.ended = {
                    "reason": "max_turns" if refusal == "conversation_turn_limit" else "budget",
                    "at": _now(),
                    "turns_not_run": len(turns) - index + 1,
                }
                break
            status = await self._turn(index, turn_in)
            if self.ended is not None:
                self.ended["turns_not_run"] = len(turns) - index
                break
            if status == "completed" and conversation.get("end") is not None:
                when = conversation["end"]["when"]
                env = {"result": self.turns[-1]["reply"], "state": self.state}
                equal = evaluate(when["left"], env) == evaluate(when["right"], env)
                if equal == (when["op"] == "eq"):
                    self.ended = {
                        "reason": "package",
                        "at": _now(),
                        "turns_not_run": len(turns) - index,
                    }
                    break
        if self.ended is None:
            # The input is exhausted: at the cap the conversation is over by the package's own
            # bound; else the person closed it (`end`) or the host simply sent nothing more.
            run = len([t for t in self.turns if t["status"] != "refused"])
            reason = (
                "max_turns"
                if run >= self.limits.max_turns
                else "person"
                if transcript.get("end")
                else "host"
            )
            self.ended = {"reason": reason, "at": _now(), "turns_not_run": 0}
        self.chain.record(
            "conversation.ended",
            reason=self.ended["reason"],
            turns=len([t for t in self.turns if t["status"] != "refused"]),
            tokens=self.tokens,
            remote_calls=self.remote_calls,
            spent_permissions=sorted(self.spent),
            state_hash=digest(self.state),
        )
        return self._report()

    def _reserve(self, index: int) -> str | None:
        """Whole-turn reservation (V-10): the turn's own hard budgets must fit in what the
        conversation has left, else the turn is refused before any node runs."""
        turn = self.package.policy["budget"]
        if index > self.limits.max_turns:
            return "conversation_turn_limit"
        hard_tokens = min(
            turn["hard_tokens"], self.turn_limits.get("hard_tokens", turn["hard_tokens"])
        )
        remote = min(
            turn["max_remote_calls"],
            self.turn_limits.get("max_remote_calls", turn["max_remote_calls"]),
        )
        if self.tokens + hard_tokens > self.limits.hard_tokens:
            return "conversation_budget_exhausted"
        if self.remote_calls + remote > self.limits.max_remote_calls:
            return "conversation_budget_exhausted"
        return None

    def _refuse_turn(self, index: int, turn_in: dict, reason: str) -> None:
        now = _now()
        self.chain.record(
            "turn.refused",
            reason=reason,
            message_hash=digest(turn_in["message"]),
            spent_tokens=self.tokens,
            spent_remote_calls=self.remote_calls,
            limits=self.limits.as_json(),
        )
        self.turns.append(
            {
                "turn": index,
                "status": "refused",
                "error_code": "budget_exhausted",
                "refusal": reason,
                "message": copy.deepcopy(turn_in["message"]),
                "consents": turn_decisions(turn_in),
                "decisions": [],
                "unused_consents": sorted(turn_decisions(turn_in)),
                "reply": None,
                "usage": {"tokens": 0, "remote_calls": 0, "tool_calls": {}},
                "started_at": now,
                "ended_at": now,
            }
        )

    async def _turn(self, index: int, turn_in: dict) -> str:
        package = self.package
        message = turn_in["message"]
        decisions = turn_decisions(turn_in)
        started = _now()
        self.chain.record(
            "turn.started",
            message_hash=digest(message),
            consents_supplied=sorted(decisions),
            state_hash=digest(self.state),
            spent_tokens=self.tokens,
            spent_remote_calls=self.remote_calls,
        )
        caps = {
            tool_id: max(0, cap - self.tool_calls[tool_id])
            for tool_id, cap in self.limits.max_calls_per_tool.items()
        }
        host = self.consent(index, decisions)
        context = TurnContext(
            conversation_id=self.conversation_id,
            turn=index,
            state=copy.deepcopy(self.state),
            chain=self.chain,
            consent=host,
            spent=set(self.spent),
            tool_caps=caps,
        )
        parts = self.adapters(index)
        workflow = Workflow(
            package,
            grants=self.grants,
            handlers=parts.get("handlers"),
            router=parts.get("router"),
            limits=self.turn_limits or None,
            approved_tools=self.approved_tools,
            observer=self.observer,
            memory=parts.get("memory"),
            turn=context,
        )
        error_code = None
        try:
            report = await workflow.run(message)
            status = "completed"
        except Exception as exc:  # a classified failure carries its report; anything else is
            report = getattr(exc, "execution_report", None)  # the host's and is raised
            if report is None:
                raise
            status = report["status"]
            error_code = failure_code(exc)
        usage = report["usage"]
        self.tokens += usage["tokens"]
        self.remote_calls += usage["remote_calls"]
        self.tool_calls.update(usage["tool_calls"])
        self.spent |= workflow.runtime.spent_permissions
        if status == "completed":
            self.state = copy.deepcopy(report["conversation_state"])
        used = getattr(host, "used", set())
        self.chain.record(
            "turn.completed" if status == "completed" else "turn.failed",
            turn_run_id=workflow.runtime.run_id,
            status=status,
            error_code=error_code,
            tokens=usage["tokens"],
            remote_calls=usage["remote_calls"],
            spent_tokens=self.tokens,
            spent_remote_calls=self.remote_calls,
            state_hash=digest(self.state),
            consents_decided=[d["step"] for d in workflow.runtime.consent_decisions],
        )
        entry = {
            "turn": index,
            "run_id": workflow.runtime.run_id,
            "status": status,
            "error_code": error_code,
            "refusal": None,
            "message": copy.deepcopy(message),
            "consents": decisions,
            "decisions": copy.deepcopy(workflow.runtime.consent_decisions),
            "unused_consents": sorted(set(decisions) - set(used)),
            "reply": copy.deepcopy(report.get("output")) if status == "completed" else None,
            "usage": {
                "tokens": usage["tokens"],
                "remote_calls": usage["remote_calls"],
                "tool_calls": dict(usage["tool_calls"]),
            },
            "started_at": started,
            "ended_at": _now(),
        }
        self.turns.append(entry)
        if self.on_turn is not None:
            self.on_turn(index, report, status)
        return status

    # -- the record -----------------------------------------------------------------------

    def transcript(self) -> dict:
        package = self.package
        return {
            "schema": "conversation.transcript.v0",
            "conversation_id": self.conversation_id,
            "package": {
                "package_id": package.manifest["package_id"],
                "version": package.manifest["version"],
                "digest": package.digest,
            },
            "started_at": self.started_at,
            "turns": copy.deepcopy(self.turns),
            "state": copy.deepcopy(self.state),
            "budget": {
                "limits": self.limits.as_json(),
                "spent": {
                    "turns": len([t for t in self.turns if t["status"] != "refused"]),
                    "tokens": self.tokens,
                    "remote_calls": self.remote_calls,
                    "tool_calls": dict(self.tool_calls),
                },
            },
            "spent_permissions": sorted(self.spent),
            "ended": dict(self.ended),
        }

    def _report(self) -> dict:
        completed = all(t["status"] == "completed" for t in self.turns) and bool(self.turns)
        return {
            "status": "completed" if completed else "failed",
            "profile": PROFILE,
            "transcript": self.transcript(),
            "state": copy.deepcopy(self.state),
            "audit": list(self.chain.events),
            "usage": {
                "turns": len([t for t in self.turns if t["status"] != "refused"]),
                "tokens": self.tokens,
                "remote_calls": self.remote_calls,
                "tool_calls": dict(self.tool_calls),
                "limits": self.limits.as_json(),
                "per_turn": [
                    {"turn": t["turn"], "status": t["status"], **t["usage"]} for t in self.turns
                ],
            },
            "provenance": {
                "profile": PROFILE,
                "interpreter": INTERPRETER,
                "package_id": self.package.manifest["package_id"],
                "package_digest": self.package.digest,
                "conversation_id": self.conversation_id,
                "persistent_keys": persistent_keys(self.package),
            },
            "ended": dict(self.ended),
        }


__all__ = [
    "HOST_KEYS",
    "INTERPRETER",
    "PROFILE",
    "Conversation",
    "ConversationLimits",
    "TurnContext",
    "effective_limits",
    "split_limits",
]
