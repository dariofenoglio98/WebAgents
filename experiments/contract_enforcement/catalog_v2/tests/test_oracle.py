"""The oracle on hand-built records (D-303): every outcome, every predicate's both answers."""

from __future__ import annotations

from harness_v2 import oracle


def violation(boundary, **expected):
    return {
        "kind": "violation",
        "boundary": boundary,
        "expected": {"code": "permission_denied", **expected},
    }


CONTROL = {"kind": "control", "boundary": {}, "expected": {"code": "completed"}}
EXECUTED = {"class": "admission", "predicate": "executed"}


def record(**fields):
    base = {
        "refusal": None,
        "result": None,
        "audit": [],
        "exports": {},
        "seams": {"model": [], "tool": [], "compute": [], "consent": []},
        "guard": [],
        "harness_error": None,
    }
    base.update(fields)
    return base


def failed(code="permission_denied", **extra):
    return record(result={"status": "failed", "error_code": code, "failed_node": "x"}, **extra)


def completed(**extra):
    return record(result={"status": "completed", "error_code": None}, **extra)


def outcome(case, rec, runtime="py"):
    return oracle.classify(case, rec, runtime)["outcome"]


def test_violation_outcomes():
    case = violation(EXECUTED)
    assert outcome(case, failed()) == oracle.EXPLICIT_BLOCK
    tool = {"tool": "x", "turn": None, "taints": []}
    assert outcome(
        case, failed(seams={"model": [], "tool": [tool], "compute": [], "consent": []})
    ) == (oracle.SILENT_VIOLATION)
    # The boundary decides first: a run refused after the boundary was reached is still silent.
    assert outcome(case, completed(audit=[{"action": "state.committed", "nodes": ["a"]}])) == (
        oracle.SILENT_VIOLATION
    )
    assert outcome(case, completed()) == oracle.HARNESS_ERROR  # violation_not_observed
    assert outcome(case, failed("worker_error")) == oracle.INCIDENTAL_FAILURE
    assert outcome(case, record(harness_error="boom")) == oracle.HARNESS_ERROR
    assert outcome(case, failed(guard=[{"kind": "socket"}])) == oracle.HARNESS_ERROR
    refusal = {"phase": "load", "code": None, "agentpkg_error": True, "error_class": "X"}
    assert outcome(case, record(refusal=refusal)) == oracle.EXPLICIT_BLOCK
    crash = {"phase": "run", "code": None, "agentpkg_error": False, "error_class": "TypeError"}
    assert outcome(case, record(refusal=crash)) == oracle.INCIDENTAL_FAILURE


def test_a_guard_that_denies_without_failing_is_a_block_only_with_its_event():
    event = {"action": "memory.proposed", "fields": {"offered": 0}}
    case = violation({"class": "effect", "predicate": "proposals_offered"}, block_event=event)
    denied = completed(audit=[{"action": "memory.proposed", "offered": 0}])
    offered = completed(audit=[{"action": "memory.proposed", "offered": 2}])
    assert outcome(case, denied) == oracle.EXPLICIT_BLOCK
    assert outcome(case, offered) == oracle.SILENT_VIOLATION
    assert outcome(violation({"class": "effect", "predicate": "proposals_offered"}), denied) == (
        oracle.HARNESS_ERROR
    )


def test_unclassified_failure_counts_only_with_the_named_reason():
    case = violation(EXECUTED, reason="consent_decision_invalid")
    with_reason = failed(
        "worker_error", audit=[{"action": "x", "reason": "consent_decision_invalid"}]
    )
    assert outcome(case, with_reason) == oracle.EXPLICIT_BLOCK
    assert outcome(case, failed("worker_error")) == oracle.INCIDENTAL_FAILURE


def test_control_outcomes_and_turns():
    assert outcome(CONTROL, completed()) == oracle.BENIGN_ACCEPT
    assert outcome(CONTROL, failed()) == oracle.FALSE_REJECT
    turns = {
        "status": "completed",
        "turns": [
            {"status": "completed"},
            {"status": "refused", "refusal": "conversation_turn_limit"},
        ],
    }
    assert outcome(CONTROL, record(result=turns)) == oracle.FALSE_REJECT
    stop = oracle.stop_of(record(result=turns))
    assert stop["kind"] == "turn_refused" and stop["code"] == "conversation_turn_limit"


def test_accuracy_and_per_runtime_expectation():
    case = violation(EXECUTED, ts={"code": "execution_permission_denied"})
    assert oracle.classify(case, failed(), "py")["code_match"] is True
    assert oracle.classify(case, failed(), "ts")["code_match"] is False


def seams(**kinds):
    return {"model": [], "tool": [], "compute": [], "consent": [], **kinds}


def holds(boundary, rec):
    return oracle.evaluate_predicate(rec, boundary)


def test_predicates_each_way():
    t = "secret@example"
    assert holds(
        {"predicate": "model_taint", "taint": t}, record(seams=seams(model=[{"taints": [t]}]))
    )
    assert not holds(
        {"predicate": "model_taint", "taint": t}, record(seams=seams(model=[{"taints": []}]))
    )
    tool = {"tool": "echo", "taints": [t]}
    assert holds(
        {"predicate": "tool_taint", "taint": t, "tools": ["echo"]}, record(seams=seams(tool=[tool]))
    )
    assert not holds(
        {"predicate": "tool_taint", "taint": t, "tools": ["other"]},
        record(seams=seams(tool=[tool])),
    )
    two = record(seams=seams(tool=[{"tool": "a"}, {"tool": "a"}]))
    assert holds({"predicate": "tool_called", "tool": "a", "more_than": 1}, two)
    assert not holds({"predicate": "tool_called", "tool": "a", "more_than": 2}, two)
    long_body = record(seams=seams(tool=[{"tool": "w", "payload": {"body": "x" * 11}}]))
    assert holds(
        {"predicate": "tool_payload_longer", "tool": "w", "field": "body", "length": 10}, long_body
    )
    assert not holds(
        {"predicate": "tool_payload_longer", "tool": "w", "field": "body", "length": 11}, long_body
    )
    ran = record(
        seams=seams(compute=[{"outcome": {"reason": "trap", "elapsed_ms": 5, "memory_pages": 70}}])
    )
    refused = record(seams=seams(compute=[{"outcome": {"reason": "instantiation_failed"}}]))
    assert holds({"predicate": "module_ran"}, ran) and not holds(
        {"predicate": "module_ran"}, refused
    )
    assert holds({"predicate": "compute_pages_above", "pages": 64}, ran)
    assert not holds({"predicate": "compute_pages_above", "pages": 70}, ran)
    assert holds({"predicate": "compute_overran", "ms": 4}, ran)
    assert not holds({"predicate": "compute_overran", "ms": 5}, ran)
    assert holds(
        {"predicate": "compute_overran", "ms": 10**6}, record(seams=seams(compute=[{"limits": {}}]))
    )


def test_consent_predicates():
    accepted = {
        "turn": 1,
        "permissions": ["p"],
        "answer": {"accepted": True},
        "text": "s",
        "facts": {"a": 1},
    }
    declined = {**accepted, "answer": {"accepted": False}}
    tool = {"turn": 1, "tool": "place", "payload": {"a": 1}}
    gate = {"predicate": "gated_tool_unconsented", "tool": "place", "permissions": ["p"]}
    assert not holds(gate, record(seams=seams(consent=[accepted], tool=[tool])))
    assert holds(gate, record(seams=seams(consent=[declined], tool=[tool])))
    assert holds(gate, record(seams=seams(consent=[accepted], tool=[{**tool, "turn": 2}])))
    assert holds(
        {**gate, "permissions": ["p", "q"]}, record(seams=seams(consent=[accepted], tool=[tool]))
    )
    facts = {"predicate": "card_facts_differ", "tool": "place"}
    assert not holds(facts, record(seams=seams(consent=[accepted], tool=[tool])))
    assert holds(
        facts, record(seams=seams(consent=[accepted], tool=[{**tool, "payload": {"a": 2}}]))
    )
    assert holds(
        {"predicate": "consent_text_not_string"},
        record(seams=seams(consent=[{**accepted, "text": 3}])),
    )
    assert holds({"predicate": "turn_ran", "turn": 2}, record(seams=seams(model=[{"turn": 2}])))
    assert not holds({"predicate": "turn_ran", "turn": 2}, record(seams=seams(model=[{"turn": 1}])))


def test_network_predicates():
    bound = {
        "max_hops": 2,
        "max_activations": 3,
        "activations": {"Desk": 2, "Lookup": 1},
        "model_calls": 9,
    }
    started = {
        "action": "network.started",
        "bound": bound,
        "tokens_left": 100,
        "remote_calls_left": 0,
    }
    act = lambda role, hop: {"action": "network.activated", "role": role, "hop": hop}  # noqa: E731
    inside = record(audit=[started, act("Desk", 0), act("Lookup", 1), act("Desk", 2)])
    beyond = record(
        audit=[started, act("Desk", 0), act("Lookup", 1), act("Desk", 2), act("Desk", 3)]
    )
    assert not holds({"predicate": "beyond_envelope"}, inside)
    assert holds({"predicate": "beyond_envelope"}, beyond)
    edge = {
        "action": "route.decided",
        "allowed": True,
        "uses": 3,
        "max_uses": 2,
        "role": "Desk",
        "next": "Nobody",
    }
    assert holds({"predicate": "beyond_envelope"}, record(audit=[edge]))
    assert holds({"predicate": "route_outside", "targets": ["Desk", "done"]}, record(audit=[edge]))
    assert holds(
        {"predicate": "route_taken", "role": "Desk", "next": "Nobody"}, record(audit=[edge])
    )
    over = {**started, "bound": {**bound, "tokens": 200}}
    assert holds({"predicate": "envelope_overcommitted"}, record(audit=[over, act("Desk", 0)]))
    assert not holds({"predicate": "envelope_overcommitted"}, record(audit=[over]))
    wrote = {"action": "network.state.committed", "role": "Lookup", "state_keys": ["draft"]}
    assert holds(
        {"predicate": "role_wrote", "role": "Lookup", "key": "draft"}, record(audit=[wrote])
    )
    assert not holds(
        {"predicate": "role_wrote", "role": "Desk", "key": "draft"}, record(audit=[wrote])
    )
