"""Reading a run's own record, and refusing to read one that was edited.

The report is derived from the audit rather than kept alongside it, so these
tests are mostly about that derivation being faithful: a claim in a report is
only there because an event in the chain put it there.
"""

from __future__ import annotations

import pytest
from execution_fakes import MEETING_AGENDA

from agentpkg.execution.report import (
    audit_summary,
    cost_summary,
    failure_summary,
    model_evidence,
    verify_audit_chain,
)
from agentpkg.package import load_package
from agentpkg.runtime import Runtime, digest


def chain(events: list[dict]) -> list[dict]:
    """Build a well-formed hash chain the way `Runtime.record` does."""
    built: list[dict] = []
    previous = None
    for index, event in enumerate(events, start=1):
        body = {"sequence": index, "previous_hash": previous, **event}
        body["event_hash"] = digest(body)
        previous = body["event_hash"]
        built.append(body)
    return built


def test_a_well_formed_chain_verifies():
    audit = chain([{"action": "runtime.started"}, {"action": "workflow.completed"}])
    report = verify_audit_chain(audit)
    assert report["valid"] is True
    assert report["events"] == 2
    assert report["final_hash"] == audit[-1]["event_hash"]
    assert report["broken"] == []


def test_an_edited_event_breaks_the_chain():
    audit = chain([{"action": "model.completed", "tokens": 100}])
    audit[0]["tokens"] = 1  # The kind of edit a flattering report would make.
    report = verify_audit_chain(audit)
    assert report["valid"] is False
    assert report["broken"][0]["reason"] == "event_hash"


def test_a_removed_event_breaks_the_chain():
    audit = chain(
        [{"action": "runtime.started"}, {"action": "model.failed"}, {"action": "workflow.failed"}]
    )
    report = verify_audit_chain(audit[:1] + audit[2:])
    assert report["valid"] is False
    assert report["broken"][0]["reason"] in {"previous_hash", "sequence"}


def test_a_summary_counts_only_what_the_chain_contains():
    audit = chain(
        [
            {"action": "runtime.started"},
            {"action": "worker.spawned", "worker": "Planner:1"},
            {
                "action": "model.completed",
                "worker": "Planner:1",
                "model": "acme/big",
                "task": "plan",
                "cost_usd": 0.001,
            },
            {
                "action": "model.completed",
                "worker": "Writer:2",
                "model": "acme/big",
                "task": "write",
                "cost_usd": 0.002,
            },
            {"action": "node.completed"},
            {"action": "workflow.completed"},
        ]
    )
    summary = audit_summary(audit)
    assert summary["model_calls"] == 2
    assert summary["tool_calls"] == 0
    assert summary["models_used"] == {"acme/big": 2}
    assert summary["tasks_called"] == {"plan": 1, "write": 1}
    assert summary["workers"] == ["Planner:1", "Writer:2"]
    assert summary["chain"]["valid"] is True


def test_cost_is_complete_partial_or_unknown_but_never_invented():
    complete = chain(
        [
            {"action": "model.completed", "cost_usd": 0.5},
            {"action": "model.completed", "cost_usd": 0.25},
        ]
    )
    assert cost_summary(complete)["total_usd"] == pytest.approx(0.75)
    assert cost_summary(complete)["status"] == "complete"

    partial = chain([{"action": "model.completed", "cost_usd": 0.5}, {"action": "model.completed"}])
    report = cost_summary(partial)
    assert report["status"] == "partial"
    assert report["total_usd"] == pytest.approx(0.5)
    assert report["calls"] == 2 and report["calls_with_reported_cost"] == 1

    unknown = cost_summary(chain([{"action": "model.completed"}]))
    assert unknown["status"] == "unknown" and unknown["total_usd"] is None


def test_model_evidence_reports_what_answered_rather_than_what_was_planned():
    class Router:
        invocations = [
            {
                "model_id": "acme/big",
                "provider_id": "acme",
                "response_model": "big-2026",
                "constrained_by_host": True,
                "count_basis": "utf8_upper_bound",
            },
            {
                "model_id": "acme/big",
                "provider_id": "acme",
                "response_model": "big-2026",
                "constrained_by_host": True,
                "count_basis": "utf8_upper_bound",
            },
        ]

    evidence = model_evidence(Router(), "acme/big")
    assert evidence["invoked"] == ["acme/big"]
    assert evidence["calls"] == 2
    assert evidence["all_calls_used_planned_model"] is True
    assert evidence["token_bound_basis"] == ["utf8_upper_bound"]

    class Drifted:
        invocations = [{"model_id": "acme/small"}]

    drifted = model_evidence(Drifted(), "acme/big")
    assert drifted["all_calls_used_planned_model"] is False


def test_a_real_runtime_chain_verifies_end_to_end():
    """The verifier agrees with the audit `Runtime` actually produces."""
    package = load_package(MEETING_AGENDA)
    runtime = Runtime(package, grants={"model.reasoning": "session", "memory.session": "session"})
    runtime.record("state.committed", nodes=["plan"])
    runtime.clear()
    assert verify_audit_chain(runtime.audit)["valid"] is True
    assert audit_summary(runtime.audit)["actions"]["runtime.started"] == 1


def test_a_failure_summary_names_the_node_the_check_and_the_call_never_data():
    audit = chain(
        [
            {"action": "node.started", "node_id": "evidence"},
            {"action": "tool.failed", "tool": "paper-reader", "reason": "tool_unavailable"},
            {
                "action": "node.failed",
                "node_id": "evidence/read-source",
                "error_code": "tool_error",
            },
            {
                "action": "node.failed",
                "node_id": "check-evidence",
                "error_code": "schema_validation",
                "failed_check": {
                    "check": "assertion",
                    "index": 0,
                    "kind": "relation",
                    "failure": "duplicate_target_key",
                    "target_key": "/evidence_id",
                },
            },
            {"action": "workflow.failed", "error_code": "schema_validation"},
        ]
    )
    summary = failure_summary(audit)
    # The attributed refusal wins over an earlier unattributed failure.
    assert summary["node_id"] == "check-evidence" and summary["step_id"] is None
    assert summary["error_code"] == "schema_validation"
    assert summary["failed_check"]["failure"] == "duplicate_target_key"
    assert summary["call"] == {
        "kind": "tool",
        "action": "tool.failed",
        "tool": "paper-reader",
        "task": None,
        "reason": "tool_unavailable",
    }


def test_a_step_failure_is_attributed_to_its_map_and_step():
    audit = chain(
        [
            {"action": "node.failed", "node_id": "screening/read-source", "error_code": "x"},
            {"action": "node.failed", "node_id": "screening", "error_code": "permission_denied"},
        ]
    )
    summary = failure_summary(audit)
    assert (summary["node_id"], summary["step_id"]) == ("screening", "read-source")
    assert summary["failed_check"] is None and summary["call"] is None


def test_a_completed_run_has_no_failure_summary():
    assert failure_summary(chain([{"action": "workflow.completed"}])) is None
