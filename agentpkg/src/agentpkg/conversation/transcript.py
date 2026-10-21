"""The transcript (conversation.v0 §5, V-14…V-16): the input form a host replays, the output
form a conversation leaves behind, and the checks of an input transcript against the package
and the plan's grants before anything runs.
"""

from __future__ import annotations

from pathlib import Path

from ..errors import ValidationError
from ..package import read_regular_bytes
from ..validation import parse_json, validate_instance
from .declarations import consent_nodes, conversation_of, validate_transcript_document

MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024


def read_input_transcript(path) -> dict:
    data = read_regular_bytes(Path(path), MAX_TRANSCRIPT_BYTES)
    return validate_transcript_document(parse_json(data, str(path)), form="input", label=str(path))


def turn_decisions(turn: dict) -> dict[str, bool]:
    return {step: bool(value) for step, value in (turn.get("consents") or {}).items()}


def check_transcript(transcript: dict, package, grants: dict) -> None:
    """Refuse before the conversation starts what the transcript may not ask (V-15): a decision
    for a step the graph does not declare (`consent_step_unknown`), an `accepted` for a step
    whose permission the plan denies (`consent_not_authorized`: a transcript cannot widen the
    plan), and a message the package's input schema refuses (`conversation_message_invalid`).
    """
    conversation = conversation_of(package.graph)
    if conversation is None:
        raise ValidationError(
            "conversation_profile_required: this package declares no conversation"
        )
    steps = {node["id"]: node for node in consent_nodes(package.graph)}
    for index, turn in enumerate(transcript["turns"], start=1):
        try:
            validate_instance(
                package.files, package.graph["input_schema"], turn["message"], "message"
            )
        except ValidationError as exc:
            raise ValidationError(f"conversation_message_invalid: turn {index}: {exc}") from exc
        for step, accepted in turn_decisions(turn).items():
            node = steps.get(step)
            if node is None:
                raise ValidationError(
                    f"consent_step_unknown: turn {index} decides {step!r}, which is not a "
                    "consent step of this package"
                )
            denied = [p for p in node["permissions"] if grants.get(p, "deny") == "deny"]
            if accepted and denied:
                raise ValidationError(
                    f"consent_not_authorized: turn {index} accepts consent step {step!r}, whose "
                    f"permission(s) {denied} the plan denies; a transcript cannot widen a plan"
                )


__all__ = ["MAX_TRANSCRIPT_BYTES", "check_transcript", "read_input_transcript", "turn_decisions"]
