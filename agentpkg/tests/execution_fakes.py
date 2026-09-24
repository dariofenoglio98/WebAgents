"""A deterministic stand-in for the OpenClaw side of an execution run.

This is the *parent*: it speaks the execution wire contract, hands the child a
package descriptor and an artifact directory, and answers `model.*` from a
scripted table instead of a provider. No network, no provider, no tokens.

The scripted model deliberately reads the task out of the rendered system text
and the data out of the rendered user text, exactly as a real model would, so a
test exercises the real request the runtime built rather than a stub the test
wrote. Nothing here interprets a package: the responses are the shapes the
package's own schemas require, which is what makes an end-to-end assertion
meaningful.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

from hostbridge_fakes import MemoryWriter

from agentpkg.execution import protocol as execution_protocol
from agentpkg.execution.session import ExecutionSession
from agentpkg.hostbridge import protocol as bridge_protocol
from agentpkg.hostbridge.peer import BridgePeer

ROOT = Path(__file__).resolve().parents[2]
MEETING_AGENDA = ROOT / "dist/meeting-agenda.agent.pkg"
TASK = re.compile(r"^## Task\n(.+)$", re.MULTILINE)


def duplex():
    """Two linked (reader, writer) pairs: one per direction."""
    to_child = asyncio.StreamReader(limit=bridge_protocol.MAX_FRAME_BYTES)
    to_parent = asyncio.StreamReader(limit=bridge_protocol.MAX_FRAME_BYTES)
    return (to_child, MemoryWriter(to_parent)), (to_parent, MemoryWriter(to_child))


def plan_for(source, *, archive_sha256: str, signer_fingerprint: str, **overrides) -> dict:
    """The bounded run-plan facts a real preflight would hand the runner."""
    plan = {
        "run_plan_id": "rp_" + "a" * 32,
        "run_plan_sha256": "b" * 64,
        "session_id": "session-testing1234",
        "package": {
            "package_id": source.manifest["package_id"],
            "name": source.manifest["name"],
            "version": source.manifest["version"],
            "digest": source.digest,
            "archive_sha256": archive_sha256,
            "execution_profile": "workflow.v0",
        },
        "publisher": {
            "signer_fingerprint": signer_fingerprint,
            "signature_status": "valid",
            "trust_status": "trusted",
        },
        "execution": {
            "mode": "model",
            "profile": "workflow.v0",
            "required_permission_ids": ["model.reasoning"],
        },
        "model_binding": {
            "host_model_id": "acme/big",
            "provider_id": "acme",
            "model_id": "big",
            "display_name": "Big Model",
            "compatibility_status": "compatible",
            "evidence_strength": "derived",
            "capabilities": {
                "reasoning": {"value": True, "basis": "declared"},
                "structured_output": {"value": True, "basis": "derived"},
            },
            "limits": {"context_tokens": 272000},
            "properties": {"local": False},
        },
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(plan.get(key), dict):
            plan[key] = {**plan[key], **value}
        else:
            plan[key] = value
    return plan


def authorization(decisions=None) -> dict:
    return {
        "receipt_id": "receipt-1234",
        "receipt_sha256": "c" * 64,
        "expires_at": "2099-01-01T00:00:00+00:00",
        "decisions": decisions or {"model.reasoning": "session", "memory.session": "session"},
        "tool_approvals": {},
    }


MEETING_INPUT = {
    "goal": "Decide whether to adopt agent.pkg for the next research prototype",
    "participants": [
        {"name": "Ari", "role": "researcher"},
        {"name": "Blair", "role": "security reviewer"},
        {"name": "Casey", "role": "systems engineer"},
    ],
    "context": "A fixture meeting used by the deterministic execution tests.",
    "duration": 45,
}


def agenda_for(request: dict) -> dict:
    """An agenda that satisfies the package's own assertions, exactly."""
    participants = request["participants"] or [{"name": "Chair", "role": "chair"}]
    duration = request["duration"]
    share, remainder = divmod(duration, len(participants))
    items = []
    for index, participant in enumerate(participants):
        minutes = share + (remainder if index == 0 else 0)
        items.append(
            {
                "topic": f"Discuss {participant['role']} considerations",
                "minutes": minutes,
                "owner": participant["name"],
            }
        )
    return {
        "goal": request["goal"],
        "duration": duration,
        "agenda": items,
        "preparation_items": ["Read the proposal"],
        "decisions": ["Adopt or defer"],
        "questions": ["What is the rollback plan?"],
    }


def scripted_model(request_input=None):
    """Answer one rendered request the way the package's schemas require."""
    default = request_input or MEETING_INPUT

    def respond(params: dict) -> str:
        match = TASK.search(params["system"])
        task = match.group(1).strip() if match else ""
        data = json.loads(params["user"])
        if task == "plan":
            return json.dumps(
                {
                    "focus": ["Scope", "Risks"],
                    "perspectives": [
                        {"name": p["name"], "role": p["role"]} for p in data["participants"]
                    ],
                }
            )
        if task == "perspective":
            participant = data["participant"]
            return json.dumps(
                [
                    {
                        "role": participant["role"],
                        "priorities": [f"{participant['role']} priority"],
                        "questions": [f"What matters to {participant['role']}?"],
                    }
                ]
            )
        if task == "write":
            return json.dumps(agenda_for(data.get("request", default)))
        raise AssertionError(f"unscripted task {task!r}")

    return respond


class FakeExecutionHost:
    """The parent peer: scripted answers, recorded requests, no provider."""

    def __init__(
        self,
        reader,
        writer,
        *,
        respond=None,
        model_id: str = "acme/big",
        usage=None,
        delay: float = 0.0,
        fail_with: Exception | None = None,
    ):
        self.respond = respond or scripted_model()
        self.model_id = model_id
        self.usage = usage or {"input_tokens": 900, "output_tokens": 180, "cost_usd": 0.0012}
        self.delay = delay
        self.fail_with = fail_with
        self.requests: list[tuple[str, dict]] = []
        # Live progress snapshots, kept apart from the model/tool requests a
        # test counts: observation is not a request for work.
        self.progress: list[dict] = []
        self.peer = BridgePeer(
            reader,
            writer,
            outbound_methods=execution_protocol.EXECUTION_METHODS,
            inbound_methods=execution_protocol.RUNNER_OUTBOUND_METHODS,
            handler=self.handle,
            prefix="h",
            version=execution_protocol.EXECUTION_PROTOCOL_VERSION,
        )

    async def handle(self, method: str, params: dict) -> dict:
        if method == execution_protocol.PROGRESS_METHOD:
            self.progress.append(params)
            return {"accepted": True}
        self.requests.append((method, params))
        if method == "model.count_tokens":
            return {"supported": False, "detail": "This test host exposes no tokenizer."}
        if self.fail_with is not None:
            raise self.fail_with
        if self.delay:
            await asyncio.sleep(self.delay)
        return {
            "text": self.respond(params),
            "model_id": self.model_id,
            "provider_id": self.model_id.split("/")[0],
            "response_model": f"{self.model_id.split('/')[-1]}-2026-09-01",
            "stop_reason": "stop",
            "execution": {"mode": "direct-provider", "owner": {"kind": "provider", "id": "acme"}},
            "constrained": True,
            "constraint_detail": "json_schema response format",
            "usage": dict(self.usage),
        }

    def completions(self) -> list[dict]:
        return [params for method, params in self.requests if method == "model.complete"]


class Harness:
    """One in-process runner plus the fake parent that drives it."""

    def __init__(self, tmp_path: Path, *, archive: Path = MEETING_AGENDA, host_options=None):
        self.tmp_path = Path(tmp_path)
        self.artifacts = self.tmp_path / "artifacts"
        self.artifacts.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.package_fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
        self.artifacts_fd = os.open(self.artifacts, os.O_RDONLY | os.O_DIRECTORY)
        (child_pair, parent_pair) = duplex()
        self.host = FakeExecutionHost(*parent_pair, **(host_options or {}))
        self.session = ExecutionSession(
            BridgePeer(
                *child_pair,
                outbound_methods=execution_protocol.RUNNER_OUTBOUND_METHODS,
                inbound_methods=execution_protocol.EXECUTION_METHODS,
                handler=self._handler,
                prefix="x",
                version=execution_protocol.EXECUTION_PROTOCOL_VERSION,
            ),
            package_fd=self.package_fd,
            artifacts_fd=self.artifacts_fd,
        )
        self._child_peer = self.session._peer
        self._tasks: list[asyncio.Task] = []

    async def _handler(self, method: str, params: dict) -> dict:
        return await self.session(method, params)

    async def __aenter__(self):
        self._tasks = [
            asyncio.create_task(self._child_peer.serve()),
            asyncio.create_task(self.host.peer.serve()),
        ]
        return self

    async def __aexit__(self, *exc):
        await self.host.peer.close()
        await self._child_peer.close()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for fd in (self.package_fd, self.artifacts_fd):
            try:
                os.close(fd)
            except OSError:
                pass
        return False

    def call(self, method: str, params: dict, *, timeout: float = 30.0):
        return self.host.peer.call(method, params, timeout=timeout)

    def artifact(self, name: str):
        return json.loads((self.artifacts / name).read_text())


__all__ = [
    "MEETING_AGENDA",
    "MEETING_INPUT",
    "FakeExecutionHost",
    "Harness",
    "agenda_for",
    "authorization",
    "duplex",
    "plan_for",
    "scripted_model",
]
