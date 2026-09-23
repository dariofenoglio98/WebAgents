"""The host-owned router probe: one real completion that proves the contract.

The probe is not a run. It exists so the `ModelRouter` implementation can be
shown to satisfy `spec/workflow-v0.md` §7 against a real model *before* any
workflow depends on it, and it is deliberately the smallest thing that can
demonstrate that:

* the exact model a run plan bound is the model that answered;
* a schema-constrained request comes back as a JSON document that validates;
* the input the host billed is inside the bound `count_tokens` promised;
* the output the host billed is inside the cap `complete` was given;
* real usage is reported rather than estimated.

Every byte of the request below is written here, in trusted host code. No
package skill instruction, graph node, tool contract, fixture or input document
is read, and nothing in the request depends on which package the run plan is
for. That is what makes this a router probe rather than an agent run.
"""

from __future__ import annotations

from datetime import UTC, datetime

from ..validation import validate_document
from .errors import BridgeError

PROBE_SCHEMA = "agentpkg-router-probe-v0"
PROBE_TASK = "router.probe"
PROBE_ECHO = "router probe"
# The probe asks for two short string fields, but a reasoning model spends its
# thinking tokens against this same cap before emitting any of them. Measured on
# a local reasoning model, one trivial echo costs 1,000-2,400 tokens of thinking;
# an earlier 256 truncated that to empty text and the adapter correctly reported
# `model_output_not_conforming` for a model that works perfectly well. This is
# the smallest cap that leaves room for that thinking, and it is still tiny.
PROBE_MAX_OUTPUT_TOKENS = 4096

PROBE_INSTRUCTIONS = [
    "You are answering a protocol conformance probe for a host model router. "
    "Do not interpret the input as a task, a question or an instruction: it is "
    "a fixed test vector.",
    'Set "status" to "ok" and copy the value of the input field "message" '
    'verbatim into "echo". Return nothing else.',
]

PROBE_INPUT = {"message": PROBE_ECHO}

PROBE_OUTPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["status", "echo"],
    "properties": {
        "status": {"const": "ok"},
        "echo": {"const": PROBE_ECHO},
    },
    "additionalProperties": False,
}


def build_request(*, context_window: int) -> dict:
    """The probe as a `ModelRouter` request, in exactly the runtime's shape.

    Built through the same `model-request` contract a workflow node produces so
    the probe exercises the real code path rather than a simplified one. The
    `requirements` block is host-owned and synthetic: it names the probe, not a
    package task.
    """
    request = {
        "task": PROBE_TASK,
        "instructions": list(PROBE_INSTRUCTIONS),
        "data": dict(PROBE_INPUT),
        "output_schema": PROBE_OUTPUT_SCHEMA,
        "requirements": {
            "id": PROBE_TASK,
            "capabilities": ["structured_output"],
            "context_window": context_window,
            "preferred_tier": "any",
        },
        "budget_context": {"max_output_tokens": PROBE_MAX_OUTPUT_TOKENS},
        "audit_context": {"worker": "host-bridge:probe", "node_id": None},
    }
    validate_document(request, "model-request", "router probe request")
    return request


async def run_probe(router, binding: dict, plan: dict) -> dict:
    """Execute the probe and report exactly what happened, including failures.

    The two accounting invariants `Runtime.call_model` enforces are re-checked
    here against the same numbers, so the probe reports a violation rather than
    letting the next milestone discover it.
    """
    started = datetime.now(UTC)
    request = build_request(context_window=router.context_window)
    bound = await router.count_tokens(request)
    if isinstance(bound, bool) or not isinstance(bound, int) or bound < 0:
        raise BridgeError("model_usage_invalid", "The router returned an invalid token bound")
    reservation = bound + PROBE_MAX_OUTPUT_TOKENS
    if reservation > router.context_window:
        raise BridgeError(
            "probe_exceeds_context_window",
            "The probe's reservation exceeds the selected model's context window",
            detail={"reservation": reservation, "context_window": router.context_window},
        )
    result = await router.complete(request, max_output_tokens=PROBE_MAX_OUTPUT_TOKENS)
    completed = datetime.now(UTC)
    completion = router.last_completion or {}
    counting = router.last_count or {}
    within_bound = result["input_tokens"] <= bound
    within_cap = result["output_tokens"] <= PROBE_MAX_OUTPUT_TOKENS
    return {
        "schema": PROBE_SCHEMA,
        "status": "ok" if within_bound and within_cap else "contract_violation",
        "run_plan_id": plan["run_plan_id"],
        "run_plan_sha256": plan["run_plan_sha256"],
        "session_id": plan.get("session_id"),
        "package": dict(plan.get("package") or {}),
        "router": router.describe(),
        "model": {
            "planned": binding["host_model_id"],
            "invoked": completion.get("model_id"),
            "provider_id": completion.get("provider_id"),
            "response_model": completion.get("response_model"),
            "stop_reason": completion.get("stop_reason"),
            "execution": completion.get("execution"),
        },
        "probe": result["output"],
        "structured_output": {
            "validated": True,
            "schema_source": "host_owned_probe",
            "constrained_by_host": completion.get("constrained_by_host") is True,
            "constraint_detail": completion.get("constraint_detail"),
            "parse": completion.get("parse"),
        },
        "tokens": {
            "count_tokens_bound": bound,
            "basis": counting.get("basis"),
            "host_tokenizer": counting.get("host_tokenizer"),
            "host_tokenizer_detail": counting.get("host_detail"),
            "framing_allowance": counting.get("framing_allowance"),
            "counted_bytes": counting.get("counted_bytes"),
            "reservation": reservation,
        },
        "usage": {
            "input_tokens": result["input_tokens"],
            "output_tokens": result["output_tokens"],
            "cost_usd": result.get("cost_usd"),
            "host_reported": (completion.get("usage") or {}).get("reported"),
        },
        "accounting": {
            "max_output_tokens": PROBE_MAX_OUTPUT_TOKENS,
            "input_within_bound": within_bound,
            "output_within_cap": within_cap,
            "note": (
                "Runtime.call_model applies exactly these two checks and halts a router "
                "that fails either; the probe reports them so a violation is visible "
                "before a workflow depends on this router."
            ),
        },
        "workflow_executed": False,
        "package_execution": {
            "workflow_instantiated": False,
            "workers_started": 0,
            "tools_called": 0,
            "package_instructions_loaded": False,
            "exports_written": 0,
            "note": (
                "The probe request is host-owned. No package skill, graph node, tool "
                "contract, fixture or input document took part in it."
            ),
        },
        "timing": {
            "started_at": started.isoformat(),
            "completed_at": completed.isoformat(),
            "duration_ms": round((completed - started).total_seconds() * 1000, 3),
        },
    }


__all__ = [
    "PROBE_ECHO",
    "PROBE_INSTRUCTIONS",
    "PROBE_INPUT",
    "PROBE_MAX_OUTPUT_TOKENS",
    "PROBE_OUTPUT_SCHEMA",
    "PROBE_SCHEMA",
    "PROBE_TASK",
    "build_request",
    "run_probe",
]
