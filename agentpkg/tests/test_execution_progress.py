"""Live progress: counts of audit events, sent while a run is still running.

Progress is observation only. These tests hold three properties separately:
the snapshot is a pure function of the audit events it has seen; it carries
identifiers and counts and nothing a package or model produced; and neither a
slow nor a refusing parent can affect the run it is watching.
"""

from __future__ import annotations

import asyncio
import json

from execution_fakes import MEETING_INPUT, Harness
from test_execution_session import begin_params

from agentpkg.execution.progress import ProgressTracker
from agentpkg.execution.protocol import PROGRESS_METHOD, RUNNER_OUTBOUND_METHODS
from agentpkg.runtime import Runtime

ALLOWED_KEYS = {
    "events",
    "last_action",
    "active_nodes",
    "completed_nodes",
    "failed_nodes",
    "nodes_completed",
    "steps_completed",
    "workers_spawned",
    "workers_active",
    "peak_parallel_workers",
    "active_workers",
    "model_calls_started",
    "model_calls_completed",
    "tool_calls_started",
    "tool_calls_completed",
    "tokens",
    "remote_calls",
    "skipped_nodes",
    "workers",
}
# One row per spawned worker: identity, where it ran, how it ended, how many
# calls it made. Nothing it received or produced.
WORKER_KEYS = {"id", "role", "node", "state", "model_calls", "tool_calls", "duration_ms"}


class RecordingPeer:
    def __init__(self, *, fail=False, delay=0.0):
        self.sent: list[dict] = []
        self.fail = fail
        self.delay = delay

    async def call(self, method, params, *, timeout=None):
        assert method == PROGRESS_METHOD
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError("parent refused")
        self.sent.append(json.loads(json.dumps(params)))
        return {"accepted": True}


def event(action, **fields):
    return {"action": action, **fields}


def test_the_snapshot_is_a_pure_count_of_audit_events():
    async def main():
        peer = RecordingPeer()
        tracker = ProgressTracker(peer, interval=0.0)
        for item in [
            event("node.started", node_id="plan"),
            event("worker.spawned", worker="Planner:1", role="Planner", node_id="plan"),
            event("worker.started", worker="Planner:1"),
            event("model.called", node_id="plan", worker="Planner:1"),
            event("budget.updated", tokens=120, remote_calls=0),
            event("model.completed", node_id="plan", worker="Planner:1"),
            event("worker.completed", worker="Planner:1"),
            event("node.completed", node_id="plan"),
            event("node.started", node_id="gate"),
            event("node.skipped", node_id="gate"),
            event("node.completed", node_id="gate"),
            event("node.started", node_id="map"),
            event("worker.spawned", worker="W:2", role="W", node_id="map"),
            event("worker.spawned", worker="W:3", role="W", node_id="map"),
            event("worker.started", worker="W:2"),
            event("worker.started", worker="W:3"),
            event("node.skipped", node_id="map/optional-step"),
            event("tool.called", node_id="map/step", worker="W:2"),
            event("tool.completed", node_id="map/step", worker="W:2"),
            event("node.completed", node_id="map/step"),
            event("worker.failed", worker="W:3", error="ValueError"),
            event("node.failed", node_id="map"),
        ]:
            tracker.observe(item)
        await asyncio.sleep(0.05)
        await tracker.close()
        return tracker.snapshot(), peer.sent

    snapshot, sent = asyncio.run(main())
    assert set(snapshot) == ALLOWED_KEYS
    assert snapshot["completed_nodes"] == ["plan", "gate"]
    # A top-level node whose condition was false is reported as skipped; a
    # skipped map step is not a top-level node and is not listed.
    assert snapshot["skipped_nodes"] == ["gate"]
    assert snapshot["failed_nodes"] == ["map"]
    assert snapshot["active_nodes"] == []
    assert snapshot["nodes_completed"] == 2
    assert snapshot["steps_completed"] == 1
    assert snapshot["workers_spawned"] == 3
    assert snapshot["active_workers"] == ["W:2"]
    assert snapshot["peak_parallel_workers"] == 2
    rows = {row["id"]: row for row in snapshot["workers"]}
    assert all(set(row) == WORKER_KEYS for row in rows.values())
    assert rows["Planner:1"] == {
        **rows["Planner:1"],
        "role": "Planner",
        "node": "plan",
        "state": "completed",
        "model_calls": 1,
        "tool_calls": 0,
    }
    assert rows["Planner:1"]["duration_ms"] is not None
    assert (rows["W:2"]["node"], rows["W:2"]["state"], rows["W:2"]["tool_calls"]) == (
        "map",
        "active",
        1,
    )
    assert rows["W:3"]["state"] == "failed"
    assert (snapshot["model_calls_started"], snapshot["model_calls_completed"]) == (1, 1)
    assert (snapshot["tool_calls_started"], snapshot["tool_calls_completed"]) == (1, 1)
    assert snapshot["tokens"] == 120
    assert sent and set(sent[-1]) == ALLOWED_KEYS


def test_a_cancelled_worker_is_reported_as_cancelled_not_failed():
    tracker = ProgressTracker(RecordingPeer(), interval=10.0)
    tracker.observe(event("worker.spawned", worker="W:1", role="W", node_id="map"))
    tracker.observe(event("worker.started", worker="W:1"))
    tracker.observe(event("worker.failed", worker="W:1", error="CancelledError"))
    (row,) = tracker.snapshot()["workers"]
    assert row["state"] == "cancelled"


def test_worker_rows_are_bounded():
    from agentpkg.execution.progress import MAX_WORKERS

    tracker = ProgressTracker(RecordingPeer(), interval=10.0)
    for index in range(MAX_WORKERS + 10):
        tracker.observe(event("worker.spawned", worker=f"W:{index}", role="W", node_id="map"))
    snapshot = tracker.snapshot()
    assert len(snapshot["workers"]) == MAX_WORKERS
    # The totals keep counting past the rows.
    assert snapshot["workers_spawned"] == MAX_WORKERS + 10


def test_sends_are_coalesced_and_one_at_a_time():
    async def main():
        peer = RecordingPeer(delay=0.05)
        tracker = ProgressTracker(peer, interval=10.0)
        for index in range(200):
            tracker.observe(event("budget.updated", tokens=index, remote_calls=0))
        await asyncio.sleep(0.2)
        await tracker.close()
        return peer.sent

    sent = asyncio.run(main())
    # Two hundred events inside one interval produce one send, not two hundred.
    assert len(sent) == 1


def test_a_refusing_parent_changes_nothing():
    async def main():
        tracker = ProgressTracker(RecordingPeer(fail=True), interval=0.0)
        tracker.observe(event("node.started", node_id="plan"))
        tracker.observe(event("node.completed", node_id="plan"))
        await asyncio.sleep(0.05)
        await tracker.close()
        return tracker

    tracker = asyncio.run(main())
    assert tracker.sent == 0
    assert tracker.snapshot()["nodes_completed"] == 1


def test_an_observer_that_raises_cannot_fail_the_runtime():
    from execution_fakes import MEETING_AGENDA

    from agentpkg.package import load_package

    calls = []

    def observer(item):
        calls.append(item["action"])
        item["action"] = "tampered"
        raise RuntimeError("observer bug")

    runtime = Runtime(
        load_package(MEETING_AGENDA),
        grants={"memory.session": "session", "model.reasoning": "session"},
        observer=observer,
    )
    runtime.record("state.committed", nodes=["x"])
    assert calls == ["runtime.started", "state.committed"]
    # The observer received a copy: the chained record is untouched.
    assert [item["action"] for item in runtime.audit] == ["runtime.started", "state.committed"]


def test_progress_is_a_runner_to_parent_method_only():
    assert PROGRESS_METHOD in RUNNER_OUTBOUND_METHODS


def test_a_real_run_reports_progress_that_agrees_with_its_audit(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            await harness.call("execution.begin", begin_params())
            result = await harness.call("execution.run", {}, timeout=60)
            await harness.call("execution.end", {})
            return harness.host.progress, result

    progress, result = asyncio.run(main())
    assert result["status"] == "completed"
    assert progress, "a real run sent no progress"
    # The final record carries an exact snapshot taken after the run settled.
    final = result["progress"]
    assert set(final) == ALLOWED_KEYS
    assert final["completed_nodes"] == [
        "plan",
        "perspectives",
        "join",
        "write",
        "validate",
        "output",
    ]
    assert final["active_nodes"] == [] and final["workers_active"] == 0
    assert final["model_calls_completed"] == result["audit"]["model_calls"]
    assert {row["state"] for row in final["workers"]} == {"completed"}
    assert sum(row["model_calls"] for row in final["workers"]) == result["audit"]["model_calls"]
    assert result["failure"] is None
    for snapshot in progress:
        assert set(snapshot) == ALLOWED_KEYS
    last = progress[-1]
    audit = result["audit"]
    # Every number is a count of events the final audit also contains.
    assert last["model_calls_completed"] <= audit["model_calls"]
    assert last["workers_spawned"] <= audit["workers_spawned"]
    assert last["peak_parallel_workers"] <= result["usage"]["peak_parallel_workers"]
    assert set(last["completed_nodes"]) <= {
        "plan",
        "perspectives",
        "join",
        "write",
        "validate",
        "output",
    }
    # Monotone: progress never goes backwards.
    counts = [snapshot["events"] for snapshot in progress]
    assert counts == sorted(counts)
    # Identifiers and counts only: nothing the task, a model or a tool said.
    text = json.dumps(progress)
    for secret in (MEETING_INPUT["goal"], MEETING_INPUT["context"], "priority", "rollback"):
        assert secret not in text
