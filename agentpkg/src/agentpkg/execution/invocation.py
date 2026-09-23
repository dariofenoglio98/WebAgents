"""The Run Invocation: the immutable record of *what was asked*.

Three artifacts are deliberately distinct, and the vocabulary keeps them apart:

| Artifact | Binds | Written by | Mutable |
|---|---|---|---|
| **Run Plan** | bytes, signer, trust, consent, model | the control plane | never |
| **Run Invocation** | one plan and one task input | this module | never |
| **Run Record** | what a run did and how it ended | the run manager | the only one that changes |

A run plan says *what may run and with whose authority*. It deliberately does
not bind the task, because the same authorized package and model can be asked
different things. The invocation is the missing half: it names a plan by
identity and hash, and freezes exactly one input beside it.

Hashing is RFC 8785 canonical JSON, the same canonicalization a package's
integrity statement, an authorization receipt and a run plan already use, so
one comparison rule covers every artifact in this project.
"""

from __future__ import annotations

from datetime import UTC, datetime

from ..errors import ValidationError
from ..package import canonical_json, sha256
from .errors import INPUT_INVALID, ExecutionError, invalid

RUN_INVOCATION_SCHEMA = "agentpkg-run-invocation-v0"
RUN_INVOCATION_VERSION = "0.1"

# A workflow input is one task description, not a data transfer. The package's
# own input schema is the real bound; this stops a pathological document before
# it is canonicalized or schema-checked.
MAX_INPUT_BYTES = 256 * 1024


def canonical_input(value) -> bytes:
    """Canonicalize one workflow input, refusing anything oversized or unfinite."""
    try:
        data = canonical_json(value)
    except ValidationError as exc:
        raise ExecutionError(
            INPUT_INVALID, f"The workflow input is not finite canonical JSON: {exc}"
        ) from exc
    if len(data) > MAX_INPUT_BYTES:
        raise ExecutionError(
            INPUT_INVALID,
            f"The workflow input exceeds {MAX_INPUT_BYTES} canonical bytes",
            detail={"bytes": len(data), "limit": MAX_INPUT_BYTES},
        )
    return data


def build_invocation(*, run_id: str, plan: dict, input_value, created_at=None) -> dict:
    """Freeze one plan plus one input into a hashed, self-describing record."""
    if not isinstance(run_id, str) or not run_id:
        raise invalid("run_id must be a non-empty string")
    data = canonical_input(input_value)
    moment = created_at or datetime.now(UTC)
    record = {
        "schema": RUN_INVOCATION_SCHEMA,
        "run_invocation_version": RUN_INVOCATION_VERSION,
        "run_id": run_id,
        "run_plan_id": plan["run_plan_id"],
        "run_plan_sha256": plan["run_plan_sha256"],
        "session_id": plan.get("session_id"),
        "package": {
            "package_id": plan["package"]["package_id"],
            "version": plan["package"]["version"],
            "digest": plan["package"]["digest"],
            "archive_sha256": plan["package"]["archive_sha256"],
        },
        "input_sha256": sha256(data),
        "input_bytes": len(data),
        "created_at": moment.isoformat(),
        "note": (
            "A run plan binds authority. This binds the task that authority was used for. "
            "Neither is a record of what happened; that is the run record."
        ),
    }
    record["run_invocation_sha256"] = sha256(canonical_json(record))
    return record


__all__ = [
    "MAX_INPUT_BYTES",
    "RUN_INVOCATION_SCHEMA",
    "RUN_INVOCATION_VERSION",
    "build_invocation",
    "canonical_input",
]
