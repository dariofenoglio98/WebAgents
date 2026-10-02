"""Killable transport lifecycle tests without external network access."""

import asyncio
import json
import multiprocessing
import os
import time
from pathlib import Path

import pytest

from agentpkg.network import MAX_PIPE_BYTES, _call_in_process, async_request_json
from agentpkg.tools import ToolError


def _respond(sender):
    sender.send_bytes(json.dumps({"ok": True, "status": 200, "body": {"value": "done"}}).encode())
    sender.close()


def _stall(pid_file, sender):
    Path(pid_file).write_text(str(os.getpid()))
    time.sleep(30)
    sender.send_bytes(b'{"ok":true}')


def _oversized(sender):
    try:
        sender.send_bytes(b"x" * (MAX_PIPE_BYTES + 1))
    finally:
        sender.close()


def _fail_without_response(sender):
    sender.close()


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_process_response_is_received_and_child_reaped():
    before = {process.pid for process in multiprocessing.active_children()}
    result = asyncio.run(_call_in_process(_respond, (), timeout=5))
    assert result == {"ok": True, "status": 200, "body": {"value": "done"}}
    assert {process.pid for process in multiprocessing.active_children()} == before


def test_deadline_kills_stalled_operation_and_reaps_child(tmp_path):
    pid_file = tmp_path / "child.pid"
    began = time.monotonic()
    # The deadline must outlast a cold spawn-start child on a slow CI runner, which
    # re-imports this module before it writes its pid; the stall itself is 30 s.
    with pytest.raises(ToolError, match="deadline"):
        asyncio.run(_call_in_process(_stall, (str(pid_file),), timeout=3.0))
    assert time.monotonic() - began < 10
    assert pid_file.exists(), "Child must have started so termination is exercised"
    assert not _alive(int(pid_file.read_text()))


def test_cancellation_kills_child_before_releasing_caller(tmp_path):
    pid_file = tmp_path / "child.pid"

    async def run():
        task = asyncio.create_task(_call_in_process(_stall, (str(pid_file),), timeout=10))
        async with asyncio.timeout(5):
            while not pid_file.exists():
                await asyncio.sleep(0.01)
        pid = int(pid_file.read_text())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not _alive(pid)

    asyncio.run(run())


def test_oversized_pipe_message_is_rejected_without_leaking_child():
    with pytest.raises(ToolError, match="failed"):
        asyncio.run(_call_in_process(_oversized, (), timeout=5))
    assert not multiprocessing.active_children()


def test_child_exit_without_response_is_explicit_error():
    with pytest.raises(ToolError, match="EOFError"):
        asyncio.run(_call_in_process(_fail_without_response, (), timeout=5))


def test_public_wrapper_rejects_private_destination_before_network():
    with pytest.raises(ToolError, match="PolicyError"):
        asyncio.run(
            async_request_json(
                "http://127.0.0.1/private", method="GET", allowed_domains={"127.0.0.1"}, timeout=5
            )
        )
