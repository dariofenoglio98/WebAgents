"""Reading a finished run's own audit, rather than narrating it separately.

`Runtime` already emits a hash-chained audit and settled usage. This module
does not create a second record: it verifies the chain it was given and counts
what is in it, so a report says "four model calls happened" because four
`model.completed` events exist, not because something incremented a counter
alongside them.

Everything here is a pure function of the execution report. No package word,
node name or task name is special-cased, and raw model output never appears.
"""

from __future__ import annotations

from collections import Counter

from ..runtime import digest

# Bounds on what a summary carries back over the wire. The full audit is written
# to the run's artifact directory; this is the part a host UI renders.
MAX_ACTION_KINDS = 64
MAX_WORKERS = 64
MAX_MODELS = 16


def verify_audit_chain(audit: list) -> dict:
    """Recompute every event hash and every previous-hash link.

    This is an integrity check on a local record, not an externally anchored
    tamper-proof log: anyone who can rewrite the file can rewrite the chain. It
    proves the report was not assembled from unrelated events.
    """
    previous = None
    broken: list[dict] = []
    for index, event in enumerate(audit):
        body = {key: value for key, value in event.items() if key != "event_hash"}
        expected = digest(body)
        if event.get("event_hash") != expected:
            broken.append({"sequence": event.get("sequence", index), "reason": "event_hash"})
        elif event.get("previous_hash") != previous:
            broken.append({"sequence": event.get("sequence", index), "reason": "previous_hash"})
        elif event.get("sequence") != index + 1:
            broken.append({"sequence": event.get("sequence", index), "reason": "sequence"})
        previous = event.get("event_hash")
    return {
        "events": len(audit),
        "valid": not broken,
        "broken": broken[:8],
        "final_hash": previous,
        "note": (
            "A local hash chain. It binds these events to each other; it is not an external "
            "tamper-proof audit service."
        ),
    }


def audit_summary(audit: list) -> dict:
    """Counts, identities and model evidence, read out of the chain itself."""
    actions = Counter(event["action"] for event in audit)
    workers = sorted({event["worker"] for event in audit if event.get("worker")})
    nodes = [event for event in audit if event.get("action") == "node.completed"]
    models = Counter(event["model"] for event in audit if event.get("action") == "model.completed")
    tasks = Counter(event["task"] for event in audit if event.get("action") == "model.completed")
    return {
        "chain": verify_audit_chain(audit),
        "actions": dict(sorted(actions.items())[:MAX_ACTION_KINDS]),
        "workers": workers[:MAX_WORKERS],
        "worker_count": len(workers),
        "workers_spawned": actions.get("worker.spawned", 0),
        "nodes_completed": len(nodes),
        "model_calls": actions.get("model.completed", 0),
        "model_count_calls": actions.get("model.count.called", 0),
        "tool_calls": actions.get("tool.called", 0),
        "models_used": dict(sorted(models.items())[:MAX_MODELS]),
        "tasks_called": dict(sorted(tasks.items())[:MAX_ACTION_KINDS]),
        "state_commits": actions.get("state.committed", 0),
        "permission_checks": actions.get("permission.checked", 0),
    }


def cost_summary(audit: list) -> dict:
    """Total real cost, or an explicit statement that it is not complete.

    Only costs the host actually reported are added. A missing number is never
    replaced with an estimate, and a partial total is labelled partial rather
    than presented as the cost of the run.
    """
    completions = [event for event in audit if event.get("action") == "model.completed"]
    reported = [event for event in completions if isinstance(event.get("cost_usd"), (int, float))]
    total = sum(float(event["cost_usd"]) for event in reported)
    complete = bool(completions) and len(reported) == len(completions)
    return {
        "calls": len(completions),
        "calls_with_reported_cost": len(reported),
        "complete": complete,
        "total_usd": round(total, 8) if reported else None,
        "status": "complete" if complete else ("partial" if reported else "unknown"),
        "note": (
            "Derived only from costs the host reported for individual calls. Missing values "
            "are never estimated."
        ),
    }


def failure_summary(audit: list) -> dict | None:
    """Where a run stopped, and which declared check or call refused it.

    Read from the chain: the node that failed (and its step, for a map), its
    stable error code, the declared check that refused it when a validation
    did, and the stable reason of the first failed model or tool call. Pointers,
    identifiers and codes only — never data, never a message.
    """
    failed = [event for event in audit if event.get("action") == "node.failed"]
    if not failed:
        return None
    attributed = [event for event in failed if isinstance(event.get("failed_check"), dict)]
    event = (attributed or failed)[0]
    node = event.get("node_id") if isinstance(event.get("node_id"), str) else None
    top, _, step = (node or "").partition("/")
    call = next(
        (
            item
            for item in audit
            if item.get("action") in {"model.failed", "tool.failed", "model.refused"}
        ),
        None,
    )
    return {
        "node_id": top or None,
        "step_id": step or None,
        "error_code": event.get("error_code"),
        "failed_check": event.get("failed_check") if attributed else None,
        "call": (
            {
                "kind": call["action"].split(".")[0],
                "action": call["action"],
                "tool": call.get("tool"),
                "task": call.get("task"),
                "reason": call.get("reason"),
                **({"failure_facts": call["failure_facts"]} if call.get("failure_facts") else {}),
            }
            if call
            else None
        ),
    }


def model_evidence(router, planned_model: str) -> dict:
    """Which model actually answered each call, straight from the adapter."""
    invocations = list(getattr(router, "invocations", ()) or ())
    invoked = sorted({item.get("model_id") for item in invocations if item.get("model_id")})
    return {
        "planned": planned_model,
        "invoked": invoked[:MAX_MODELS],
        "calls": len(invocations),
        "all_calls_used_planned_model": bool(invocations) and invoked == [planned_model],
        "providers": sorted(
            {item.get("provider_id") for item in invocations if item.get("provider_id")}
        )[:MAX_MODELS],
        "response_models": sorted(
            {item.get("response_model") for item in invocations if item.get("response_model")}
        )[:MAX_MODELS],
        "constrained_by_host": all(item.get("constrained_by_host") is True for item in invocations)
        if invocations
        else None,
        "token_bound_basis": sorted(
            {item.get("count_basis") for item in invocations if item.get("count_basis")}
        )[:MAX_MODELS],
    }


__all__ = [
    "audit_summary",
    "cost_summary",
    "failure_summary",
    "model_evidence",
    "verify_audit_chain",
]
