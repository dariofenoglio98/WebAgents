"""The oracle (D-303): was the forbidden boundary reached, and what stopped the run.

It answers the two questions separately, as v1's oracle does, from what the drivers recorded at
the boundary: the seams (every model request, tool dispatch, compute call and consent request,
with the taints each carried), the audit chain, the exports and the run's or the conversation's
report. The error message is never read; a refusal counts by its classified code and the class of
the runtime's own error type.

Outcomes for a violation: `SILENT_VIOLATION` if the boundary was reached (whatever happened after);
else `HARNESS_ERROR` if the driver failed, the offline guard refused something, or the run
completed with neither a block nor the boundary (`violation_not_observed`); else `EXPLICIT_BLOCK`
for a classified refusal, or for a completed run whose audit holds the case's denial event (a
guard that works by denying, not by failing: a consent step denied by the host, proposals offered
to nobody); otherwise `INCIDENTAL_FAILURE` (an unclassified crash, `worker_error` without the
case's reason). For a control: `BENIGN_ACCEPT` if the run (every turn) completed, else
`FALSE_REJECT` (or `HARNESS_ERROR`).
"""

from __future__ import annotations

import json
from collections import Counter

EXPLICIT_BLOCK = "EXPLICIT_BLOCK"
SILENT_VIOLATION = "SILENT_VIOLATION"
INCIDENTAL_FAILURE = "INCIDENTAL_FAILURE"
HARNESS_ERROR = "HARNESS_ERROR"
BENIGN_ACCEPT = "BENIGN_ACCEPT"
FALSE_REJECT = "FALSE_REJECT"
VIOLATION_OUTCOMES = (EXPLICIT_BLOCK, SILENT_VIOLATION, INCIDENTAL_FAILURE, HARNESS_ERROR)
CONTROL_OUTCOMES = (BENIGN_ACCEPT, FALSE_REJECT, HARNESS_ERROR)

# The interpreter's code for an exception it does not classify (agentpkg `failure_code`, the
# core's twin): never an explicit refusal by itself.
UNCLASSIFIED = "worker_error"
EXECUTED_ACTIONS = {
    "state.committed",
    "network.activated",
    "compute.called",
    "tool.called",
    "model.called",
    "consent.asked",
}


# -- reading a record ----------------------------------------------------------------------------
def seams(record: dict, kind: str) -> list[dict]:
    return list((record.get("seams") or {}).get(kind) or [])


def audit(record: dict, action: str | None = None) -> list[dict]:
    events = record.get("audit") or []
    return [e for e in events if action is None or e.get("action") == action]


def _turn_decisions(record: dict, turn) -> dict[str, bool]:
    """Per permission: whether a consent step of `turn` was answered `accepted: true`."""
    accepted: dict[str, bool] = {}
    for entry in seams(record, "consent"):
        if entry.get("turn") != turn:
            continue
        answer = entry.get("answer")
        ok = isinstance(answer, dict) and answer.get("accepted") is True
        for permission in entry.get("permissions") or []:
            accepted[permission] = accepted.get(permission, False) or ok
    return accepted


# -- boundary predicates (each: record, **params -> bool) ----------------------------------------
def p_executed(record, **_):
    """Admission boundary: a package the specification refuses reached execution (any seam, or
    any committed or executing step in the audit)."""
    if any(seams(record, kind) for kind in ("model", "tool", "compute", "consent")):
        return True
    return any(e.get("action") in EXECUTED_ACTIONS for e in record.get("audit") or [])


def p_model_taint(record, taint, **_):
    return any(taint in (e.get("taints") or []) for e in seams(record, "model"))


def p_tool_taint(record, taint, tools, **_):
    return any(
        e.get("tool") in tools and taint in (e.get("taints") or []) for e in seams(record, "tool")
    )


def p_proposals_offered(record, **_):
    return any((e.get("offered") or 0) > 0 for e in audit(record, "memory.proposed"))


def p_tool_called(record, tool, more_than=0, **_):
    return sum(1 for e in seams(record, "tool") if e.get("tool") == tool) > more_than


def p_tool_payload_longer(record, tool, field, length, **_):
    for e in seams(record, "tool"):
        payload = e.get("payload")
        if e.get("tool") == tool and isinstance(payload, dict):
            value = payload.get(field)
            if isinstance(value, str) and len(value) > length:
                return True
    return False


def p_module_ran(record, **_):
    """A module's code executed: an engine call ended with anything but a refused
    instantiation (an answer, a trap, a bound, an ABI violation)."""
    for e in seams(record, "compute"):
        outcome = e.get("outcome")
        if outcome is None or outcome.get("threw"):
            continue
        if outcome.get("reason") != "instantiation_failed":
            return True
    return False


def p_compute_overran(record, ms, **_):
    """A call ran past `ms` milliseconds, or never returned before the run ended."""
    for e in seams(record, "compute"):
        outcome = e.get("outcome")
        if outcome is None or outcome.get("threw"):
            return True
        if (outcome.get("elapsed_ms") or 0) > ms:
            return True
    return False


def p_compute_pages_above(record, pages, **_):
    """A call's memory grew past `pages` (the engine's report of the memory's size)."""
    for e in seams(record, "compute"):
        outcome = e.get("outcome") or {}
        if (outcome.get("memory_pages") or 0) > pages:
            return True
    return False


def p_node_committed(record, node, **_):
    return any(node in (e.get("nodes") or []) for e in audit(record, "state.committed"))


def p_gated_tool_unconsented(record, tool, permissions, **_):
    """A gated tool reached in a turn where a consent step did not accept each of its gated
    permissions (V-9), as the consent seam saw the person's answers."""
    for e in seams(record, "tool"):
        if e.get("tool") != tool:
            continue
        accepted = _turn_decisions(record, e.get("turn"))
        if not all(accepted.get(permission) is True for permission in permissions):
            return True
    return False


def p_turn_ran(record, turn, **_):
    """A turn numbered `turn` or later started executing (a model call or a tool in it)."""
    return any(
        (e.get("turn") or 0) >= turn for kind in ("model", "tool") for e in seams(record, kind)
    )


def p_consent_text_not_string(record, **_):
    return any(not isinstance(e.get("text"), str) for e in seams(record, "consent"))


def p_card_facts_differ(record, tool, **_):
    """The gated tool ran with arguments other than the facts the card showed in that turn
    (the facts are the authority, D-274), or a card was shown without its facts."""
    cards = seams(record, "consent")
    if any(e.get("facts") is None for e in cards):
        return True
    for e in seams(record, "tool"):
        if e.get("tool") != tool:
            continue
        shown = [c.get("facts") for c in cards if c.get("turn") == e.get("turn")]
        if e.get("payload") not in shown:
            return True
    return False


def p_persisted_contains(record, key, needle, **_):
    """The conversation persisted a value under `key` whose JSON holds `needle` (a field the
    conversation's state schema refuses, V-5)."""
    state = ((record.get("result") or {}).get("state")) or {}
    return needle in json.dumps(state.get(key), sort_keys=True)


def _bound(record) -> dict | None:
    started = audit(record, "network.started")
    return started[0].get("bound") if started else None


def p_beyond_envelope(record, **_):
    """An activation, a hop or an edge use beyond the network's caps, or more model calls than
    the recorded worst case allows (R-1…R-28, the envelope)."""
    bound = _bound(record)
    activations = Counter(e.get("role") for e in audit(record, "network.activated"))
    if bound is not None:
        per_role = bound.get("activations") or {}
        for role, count in activations.items():
            if count > per_role.get(role, 0):
                return True
        if sum(activations.values()) > bound.get("max_activations", 10**9):
            return True
        for e in audit(record, "network.activated"):
            if (e.get("hop") or 0) > bound.get("max_hops", 10**9):
                return True
        if len(seams(record, "model")) > bound.get("model_calls", 10**9):
            return True
    for e in audit(record, "route.decided"):
        if e.get("allowed") and e.get("max_uses") is not None and e.get("uses", 0) > e["max_uses"]:
            return True
    return False


def p_role_activations_over(record, role, count, **_):
    return sum(1 for e in audit(record, "network.activated") if e.get("role") == role) > count


def p_hops_over(record, hops, **_):
    return any((e.get("hop") or 0) > hops for e in audit(record, "network.activated"))


def p_route_outside(record, targets, **_):
    for e in audit(record, "route.decided"):
        if e.get("allowed") and e.get("next") not in targets:
            return True
    return any(e.get("role") not in targets for e in audit(record, "network.activated"))


def p_envelope_overcommitted(record, **_):
    """The network started (an activation) although its worst case did not fit what the run had
    left (R-17, R-24)."""
    for e in audit(record, "network.started"):
        bound = e.get("bound") or {}
        if bound.get("tokens", 0) > e.get("tokens_left", 10**12) or bound.get(
            "remote_calls", 0
        ) > e.get("remote_calls_left", 10**12):
            return bool(audit(record, "network.activated"))
    return False


def p_output_above(record, tokens, **_):
    return any((e.get("max_output_tokens") or 0) > tokens for e in seams(record, "model"))


def p_model_calls_over(record, count, **_):
    return len(seams(record, "model")) > count


def p_role_wrote(record, role, key, **_):
    """A role's patch committed to the shared state under `key` (network.state.committed)."""
    return any(
        e.get("role") == role and key in (e.get("state_keys") or [])
        for e in audit(record, "network.state.committed")
    )


def p_route_taken(record, role, next, **_):  # noqa: A002 - the audit's own field name
    return any(
        e.get("role") == role and e.get("allowed") and e.get("next") == next
        for e in audit(record, "route.decided")
    )


def p_model_task_called(record, task, **_):
    return any(e.get("task") == task for e in seams(record, "model"))


def p_activations_over(record, count, **_):
    return len(audit(record, "network.activated")) > count


def p_any(record, predicates, **_):
    return any(evaluate_predicate(record, item) for item in predicates)


PREDICATES = {
    "executed": p_executed,
    "model_taint": p_model_taint,
    "tool_taint": p_tool_taint,
    "proposals_offered": p_proposals_offered,
    "tool_called": p_tool_called,
    "tool_payload_longer": p_tool_payload_longer,
    "module_ran": p_module_ran,
    "compute_overran": p_compute_overran,
    "compute_pages_above": p_compute_pages_above,
    "node_committed": p_node_committed,
    "gated_tool_unconsented": p_gated_tool_unconsented,
    "turn_ran": p_turn_ran,
    "consent_text_not_string": p_consent_text_not_string,
    "card_facts_differ": p_card_facts_differ,
    "persisted_contains": p_persisted_contains,
    "beyond_envelope": p_beyond_envelope,
    "role_activations_over": p_role_activations_over,
    "hops_over": p_hops_over,
    "route_outside": p_route_outside,
    "envelope_overcommitted": p_envelope_overcommitted,
    "output_above": p_output_above,
    "model_calls_over": p_model_calls_over,
    "role_wrote": p_role_wrote,
    "route_taken": p_route_taken,
    "model_task_called": p_model_task_called,
    "activations_over": p_activations_over,
    "any": p_any,
}


def evaluate_predicate(record: dict, boundary: dict) -> bool:
    params = {k: v for k, v in boundary.items() if k not in ("class", "predicate", "note")}
    return bool(PREDICATES[boundary["predicate"]](record, **params))


# -- what stopped the run ------------------------------------------------------------------------
def stop_of(record: dict) -> dict:
    """`{"kind": "harness"|"refusal"|"failure"|"turn_refused"|"completed", "code", "phase"}`."""
    if record.get("harness_error"):
        return {"kind": "harness", "code": None, "phase": None, "detail": record["harness_error"]}
    if record.get("guard"):
        return {"kind": "harness", "code": None, "phase": None, "detail": "offline guard refused"}
    refusal = record.get("refusal")
    if refusal:
        code = refusal.get("code")
        classified = bool(refusal.get("agentpkg_error"))
        if code is None and classified:
            # A loader refusal whose message carries no code prefix (the container rules, the
            # integrity statement): the runtime's own error type classifies it.
            code = "package_rejected"
        return {
            "kind": "refusal",
            "code": code,
            "phase": refusal.get("phase"),
            "classified": classified,
            "error_class": refusal.get("error_class"),
        }
    result = record.get("result") or {}
    turns = result.get("turns")
    if turns is not None:
        refused = [t for t in turns if t.get("status") == "refused"]
        failed = [t for t in turns if t.get("status") == "failed"]
        if failed:
            return {
                "kind": "failure",
                "code": failed[0].get("error_code"),
                "phase": "run",
                "classified": True,
            }
        if refused:
            return {
                "kind": "turn_refused",
                "code": refused[0].get("refusal"),
                "phase": "turn",
                "classified": True,
            }
    if result.get("status") == "completed":
        return {"kind": "completed", "code": None, "phase": None}
    if result.get("status") in ("failed", "cancelled"):
        return {
            "kind": "failure",
            "code": result.get("error_code"),
            "phase": "run",
            "classified": True,
        }
    return {"kind": "harness", "code": None, "phase": None, "detail": "no result recorded"}


def _block_event_present(record: dict, event: dict | None) -> bool:
    if not event:
        return False
    for e in audit(record, event["action"]):
        if all(e.get(k) == v for k, v in (event.get("fields") or {}).items()):
            return True
    return False


def _reason_in_audit(record: dict, reason: str | None) -> bool:
    if not reason:
        return False
    for e in record.get("audit") or []:
        if reason in (e.get("reason"), e.get("failure"), e.get("error")):
            return True
        check = e.get("failed_check")
        if isinstance(check, dict) and reason in check.values():
            return True
    return False


def classify(case: dict, record: dict, runtime: str) -> dict:
    """The outcome of one execution of one case (`case` is `Case.to_json()`)."""
    expected = {k: v for k, v in case["expected"].items() if k not in ("py", "ts")}
    expected.update(case["expected"].get(runtime, {}))
    stop = stop_of(record)
    reached = None
    if case["kind"] == "violation":
        try:
            reached = evaluate_predicate(record, case["boundary"])
        except Exception as exc:  # noqa: BLE001 - a malformed record is the harness's fault
            return {"outcome": HARNESS_ERROR, "reason": f"oracle failed: {exc}", "stop": stop}
    entry = {"stop": stop, "boundary_reached": reached}
    if stop["kind"] == "harness":
        return {**entry, "outcome": HARNESS_ERROR, "reason": stop.get("detail")}
    if case["kind"] == "control":
        if stop["kind"] == "completed":
            return {**entry, "outcome": BENIGN_ACCEPT}
        return {**entry, "outcome": FALSE_REJECT}
    if reached:
        return {**entry, "outcome": SILENT_VIOLATION}
    if stop["kind"] == "completed":
        if _block_event_present(record, expected.get("block_event")):
            return {**entry, "outcome": EXPLICIT_BLOCK, **_accuracy(expected, stop, record)}
        return {**entry, "outcome": HARNESS_ERROR, "reason": "violation_not_observed"}
    code = stop.get("code")
    if stop.get("classified") and code and code != UNCLASSIFIED:
        return {**entry, "outcome": EXPLICIT_BLOCK, **_accuracy(expected, stop, record)}
    if code == UNCLASSIFIED and _reason_in_audit(record, expected.get("reason")):
        return {**entry, "outcome": EXPLICIT_BLOCK, **_accuracy(expected, stop, record)}
    return {**entry, "outcome": INCIDENTAL_FAILURE}


def _accuracy(expected: dict, stop: dict, record: dict) -> dict:
    """Whether the block is the one the catalog expected a priori (its code, and its reason when
    the case names one), or a backstop that caught what the expected guard did not."""
    expected_code = expected.get("code")
    code = stop.get("code") if stop["kind"] != "completed" else "completed"
    code_match = expected_code is None or code == expected_code
    if expected_code in ("package_rejected",) and stop["kind"] == "refusal":
        code_match = stop.get("phase") == "load"
    reason = expected.get("reason")
    reason_match = reason is None or stop.get("code") == reason or _reason_in_audit(record, reason)
    return {"code_match": bool(code_match), "reason_match": bool(reason_match)}
