"""Live progress: the audit, read while it is being written.

A run can take many minutes, and until now the host learned what happened only
when `execution.run` returned. This module watches the runtime's own
hash-chained audit as events are appended and turns it into a small snapshot —
which nodes are running, which finished, how many workers, model calls and
tool calls there have been — and sends it to the parent as
`execution.progress`.

It adds no second record of anything. Every number is a count of audit events
that already exist, so progress and the final report cannot disagree about
what happened. A snapshot carries identifiers and counts only: no prompt, no
input, no model output, no tool payload and no error text.

Observation never steers execution. Sends are coalesced to at most one per
interval (plus one on each node transition), one at a time, and a failed or
refused send is dropped: the run neither waits for the parent's answer nor
depends on it.
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import time

from .protocol import PROGRESS_METHOD

MIN_INTERVAL_SECONDS = 1.0
SEND_TIMEOUT_SECONDS = 10.0
MAX_COMPLETED = 128
MAX_LISTED = 64
# Per-worker rows a run surface can render. A run that spawns more keeps
# counting in the totals; only the rows stop growing.
MAX_WORKERS = 64
# Node transitions are worth an immediate snapshot; everything else waits for
# the interval.
URGENT = frozenset({"node.started", "node.completed", "node.failed", "node.skipped"})


class ProgressTracker:
    """Counts audit events and reports them, throttled, to the parent."""

    def __init__(self, peer, *, interval: float = MIN_INTERVAL_SECONDS, clock=time.monotonic):
        self._peer = peer
        self._interval = interval
        self._clock = clock
        self._task: asyncio.Task | None = None
        self._dirty = False
        self._urgent = False
        self._closed = False
        self._last_sent = float("-inf")
        self._warned = False
        self.sent = 0
        self.events = 0
        self.last_action: str | None = None
        self.active_nodes: dict[str, None] = {}
        self.completed_nodes: list[str] = []
        self.failed_nodes: list[str] = []
        # Top-level nodes whose declared condition was false: they complete
        # with their declared `otherwise` value, and a person should see that
        # the step was skipped rather than performed.
        self.skipped_nodes: list[str] = []
        self.workers: dict[str, dict] = {}
        self.nodes_completed = 0
        self.steps_completed = 0
        self.workers_spawned = 0
        self.active_workers: dict[str, None] = {}
        self.peak = 0
        self.model_started = 0
        self.model_completed = 0
        self.tool_started = 0
        self.tool_completed = 0
        self.tokens = 0
        self.remote_calls = 0

    # -- observation ---------------------------------------------------------
    def observe(self, event: dict) -> None:
        """Called by the runtime for each chained event. Never raises."""
        action = event.get("action")
        if not isinstance(action, str):
            return
        self.events += 1
        self.last_action = action
        node = event.get("node_id")
        top_level = isinstance(node, str) and "/" not in node
        if action == "node.started" and top_level:
            self.active_nodes[node] = None
        elif action in {"node.completed", "node.skipped"} and isinstance(node, str):
            if top_level:
                self.active_nodes.pop(node, None)
                if action == "node.completed":
                    self.nodes_completed += 1
                    if len(self.completed_nodes) < MAX_COMPLETED:
                        self.completed_nodes.append(node)
                elif node not in self.skipped_nodes and len(self.skipped_nodes) < MAX_COMPLETED:
                    self.skipped_nodes.append(node)
            elif action == "node.completed":
                self.steps_completed += 1
        elif action == "node.failed" and top_level:
            self.active_nodes.pop(node, None)
            if len(self.failed_nodes) < MAX_LISTED:
                self.failed_nodes.append(node)
        elif action == "worker.spawned":
            self.workers_spawned += 1
            worker = event.get("worker")
            if isinstance(worker, str) and len(self.workers) < MAX_WORKERS:
                self.workers[worker] = {
                    "id": worker,
                    "role": event.get("role") if isinstance(event.get("role"), str) else None,
                    "node": node.split("/", 1)[0] if isinstance(node, str) else None,
                    "state": "queued",
                    "model_calls": 0,
                    "tool_calls": 0,
                    "_started": None,
                    "duration_ms": None,
                }
        elif action == "worker.started" and event.get("worker"):
            self.active_workers[event["worker"]] = None
            self.peak = max(self.peak, len(self.active_workers))
            row = self.workers.get(event["worker"])
            if row is not None:
                row["state"] = "active"
                row["_started"] = self._clock()
        elif action in {"worker.completed", "worker.failed"} and event.get("worker"):
            self.active_workers.pop(event["worker"], None)
            row = self.workers.get(event["worker"])
            if row is not None:
                if action == "worker.completed":
                    row["state"] = "completed"
                else:
                    row["state"] = (
                        "cancelled" if event.get("error") == "CancelledError" else "failed"
                    )
                if row["_started"] is not None:
                    row["duration_ms"] = round((self._clock() - row["_started"]) * 1000, 1)
        elif action == "model.called":
            self.model_started += 1
        elif action == "model.completed":
            self.model_completed += 1
            row = self.workers.get(event.get("worker") or "")
            if row is not None:
                row["model_calls"] += 1
        elif action == "tool.called":
            self.tool_started += 1
            row = self.workers.get(event.get("worker") or "")
            if row is not None:
                row["tool_calls"] += 1
        elif action == "tool.completed":
            self.tool_completed += 1
        if action == "budget.updated":
            if isinstance(event.get("tokens"), int):
                self.tokens = event["tokens"]
            if isinstance(event.get("remote_calls"), int):
                self.remote_calls = event["remote_calls"]
        self._dirty = True
        if action in URGENT:
            self._urgent = True
        self._schedule()

    def snapshot(self) -> dict:
        return {
            "events": self.events,
            "last_action": self.last_action,
            "active_nodes": list(self.active_nodes)[:MAX_LISTED],
            "completed_nodes": list(self.completed_nodes),
            "failed_nodes": list(self.failed_nodes),
            "skipped_nodes": list(self.skipped_nodes),
            "nodes_completed": self.nodes_completed,
            "steps_completed": self.steps_completed,
            "workers_spawned": self.workers_spawned,
            "workers_active": len(self.active_workers),
            "peak_parallel_workers": self.peak,
            "active_workers": sorted(self.active_workers)[:MAX_LISTED],
            "model_calls_started": self.model_started,
            "model_calls_completed": self.model_completed,
            "tool_calls_started": self.tool_started,
            "tool_calls_completed": self.tool_completed,
            "tokens": self.tokens,
            "remote_calls": self.remote_calls,
            "workers": [
                {key: value for key, value in row.items() if not key.startswith("_")}
                for row in self.workers.values()
            ],
        }

    # -- sending -------------------------------------------------------------
    def _schedule(self) -> None:
        if self._closed or self._task is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._task = loop.create_task(self._send_loop())

    async def _send_loop(self) -> None:
        try:
            while self._dirty and not self._closed:
                if not self._urgent:
                    wait = self._interval - (self._clock() - self._last_sent)
                    if wait > 0:
                        await asyncio.sleep(wait)
                self._dirty = False
                self._urgent = False
                try:
                    await self._peer.call(
                        PROGRESS_METHOD, self.snapshot(), timeout=SEND_TIMEOUT_SECONDS
                    )
                    self.sent += 1
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - progress is best effort
                    if not self._warned:
                        self._warned = True
                        print(
                            f"agentpkg-execution: progress not delivered ({type(exc).__name__})",
                            file=sys.stderr,
                        )
                self._last_sent = self._clock()
        finally:
            self._task = None

    async def close(self) -> None:
        """Stop sending. Called before the run's result is returned."""
        self._closed = True
        task = self._task
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


__all__ = ["MIN_INTERVAL_SECONDS", "ProgressTracker"]
