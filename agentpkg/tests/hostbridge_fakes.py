"""A deterministic stand-in for the OpenClaw side of the host bridge.

Everything below is the *parent*: it speaks the same wire contract the plugin
backend speaks, answers `model.*` requests from a scripted table instead of a
provider, and never touches a network. Tests that need the real host use the
live probe script instead.
"""

from __future__ import annotations

import asyncio

from agentpkg.hostbridge import protocol
from agentpkg.hostbridge.peer import BridgePeer


class MemoryWriter:
    """A writer that feeds the reader on the other side of one direction."""

    def __init__(self, reader: asyncio.StreamReader):
        self._reader = reader
        self.closed = False
        self.chunks: list[bytes] = []

    def write(self, data: bytes) -> None:
        self.chunks.append(data)
        if not self.closed:
            self._reader.feed_data(data)

    async def drain(self) -> None:
        await asyncio.sleep(0)

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self._reader.feed_eof()


def duplex():
    """Two linked (reader, writer) pairs: one per direction."""
    to_child = asyncio.StreamReader(limit=protocol.MAX_FRAME_BYTES)
    to_parent = asyncio.StreamReader(limit=protocol.MAX_FRAME_BYTES)
    return (to_child, MemoryWriter(to_parent)), (to_parent, MemoryWriter(to_child))


BINDING = {
    "host_model_id": "acme/big",
    "provider_id": "acme",
    "model_id": "big",
    "display_name": "Big Model",
    "compatibility_status": "compatible",
    "evidence_strength": "derived",
    "capabilities": {
        "reasoning": {"value": True, "basis": "declared"},
        "structured_output": {"value": True, "basis": "derived"},
        "tool_use": {"value": True, "basis": "host_default"},
        "multimodal": {"value": True, "basis": "declared"},
    },
    "limits": {"context_tokens": 200000, "native_context_window": 400000},
    "properties": {"local": False},
}

PLAN = {
    "run_plan_id": "rp_" + "a" * 32,
    "run_plan_sha256": "b" * 64,
    "session_id": "session-testing1234",
    "package": {
        "package_id": "org.webagents.meeting-agenda",
        "name": "Meeting Agenda Agent",
        "version": "0.2.0",
        "digest": "c" * 64,
        "archive_sha256": "d" * 64,
        "execution_profile": "workflow.v0",
    },
    "execution": {
        "mode": "model",
        "profile": "workflow.v0",
        "required_permission_ids": ["model.reasoning"],
    },
    "model_binding": BINDING,
}


def usage(input_tokens=120, output_tokens=18, **extra):
    return {"input_tokens": input_tokens, "output_tokens": output_tokens, **extra}


class FakeHost:
    """The parent peer: scripted answers, recorded requests, no provider."""

    def __init__(
        self,
        reader,
        writer,
        *,
        text: str = '{"status":"ok","echo":"router probe"}',
        model_id: str = "acme/big",
        usage_report: dict | None = None,
        tokenizer: dict | None = None,
        on_complete=None,
        stop_reason: str | None = "stop",
    ):
        self.text = text
        self.stop_reason = stop_reason
        self.model_id = model_id
        self.usage = usage_report if usage_report is not None else usage()
        self.tokenizer = tokenizer or {
            "supported": False,
            "detail": "This test host exposes no tokenizer.",
        }
        self.on_complete = on_complete
        self.requests: list[tuple[str, dict]] = []
        self.peer = BridgePeer(
            reader,
            writer,
            outbound_methods=protocol.CHILD_METHODS,
            inbound_methods=protocol.HOST_METHODS,
            handler=self.handle,
            prefix="h",
        )

    async def handle(self, method: str, params: dict) -> dict:
        self.requests.append((method, params))
        if method == "model.count_tokens":
            return dict(self.tokenizer)
        if self.on_complete is not None:
            return await self.on_complete(params)
        return {
            "text": self.text,
            "model_id": self.model_id,
            "provider_id": self.model_id.split("/")[0],
            "response_model": f"{self.model_id.split('/')[-1]}-2026-09-01",
            "stop_reason": self.stop_reason,
            "execution": {"mode": "direct-provider", "owner": {"kind": "provider", "id": "acme"}},
            "constrained": True,
            "constraint_detail": "json_schema response format",
            "usage": dict(self.usage),
        }

    def completions(self) -> list[dict]:
        return [params for method, params in self.requests if method == "model.complete"]


__all__ = ["BINDING", "PLAN", "FakeHost", "MemoryWriter", "duplex", "usage"]
