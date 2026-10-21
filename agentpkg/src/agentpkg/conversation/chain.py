"""One audit chain across the turns of a conversation (conversation.v0 §6, V-17).

Each turn's `Runtime` continues the chain it is given: its first event's `previous_hash` is the
last hash before it and `sequence` keeps counting, so `verify_audit_chain` reads the whole
conversation's `audit.json` as one record. The conversation-level events between turns are
written here with the same event shape and the same digest.
"""

from __future__ import annotations

import copy
from datetime import UTC, datetime

from ..runtime import digest


class AuditChain:
    def __init__(self, conversation_id: str, *, observer=None):
        self.conversation_id = conversation_id
        self.turn = 0
        self.previous_hash: str | None = None
        self.sequence = 0
        self.events: list[dict] = []
        self._observer = observer

    def fields(self) -> dict:
        """What every event of the conversation carries beside the audit.v0 fields."""
        return {"conversation_id": self.conversation_id, "turn": self.turn}

    def advance(self, event: dict) -> None:
        """A `Runtime` hands over each event it chained; the chain keeps the tail."""
        self.previous_hash = event["event_hash"]
        self.sequence = event["sequence"]
        self.events.append(event)

    def record(self, action: str, **metadata) -> dict:
        """A conversation-level event (`conversation.started`, `turn.*`, `conversation.ended`):
        the conversation's id as `run_id`, no worker, depth 0."""
        event = {
            "schema_version": "audit.v0",
            "run_id": self.conversation_id,
            "sequence": self.sequence + 1,
            "timestamp": datetime.now(UTC).isoformat(),
            "action": action,
            "worker": None,
            "role": None,
            "parent": None,
            "depth": 0,
            "node_id": None,
            "previous_hash": self.previous_hash,
            **self.fields(),
            **metadata,
        }
        event["event_hash"] = digest(event)
        self.advance(event)
        if self._observer is not None:
            try:
                self._observer(copy.deepcopy(event))
            except Exception:  # noqa: BLE001 - observation must never affect a conversation
                pass
        return event


__all__ = ["AuditChain"]
