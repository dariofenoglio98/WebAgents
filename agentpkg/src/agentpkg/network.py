"""Killable host HTTP transport with a deadline covering DNS and socket I/O.

Only host-installed process targets execute. Downloaded packages cannot name an
implementation. The response pipe carries bounded JSON, never pickled peer data.
"""

from __future__ import annotations

import asyncio
import json
import multiprocessing
from collections.abc import Callable
from typing import Any

# Slight framing allowance above the host transport's 4 MiB response limit.
MAX_PIPE_BYTES = 4 * 1024 * 1024 + 65536


def _http_child(url: str, kwargs: dict, sender) -> None:
    from .runtime import PolicyError
    from .tools import request_json

    try:
        status, body = request_json(url, **kwargs)
        message = {"ok": True, "status": status, "body": body}
    except PolicyError as exc:
        message = {"ok": False, "error": type(exc).__name__}
    except BaseException as exc:
        # Do not transport provider response bodies, URLs, or authorization headers.
        message = {"ok": False, "error": type(exc).__name__}
    try:
        data = json.dumps(message, ensure_ascii=False, allow_nan=False).encode()
        if len(data) > MAX_PIPE_BYTES:
            data = b'{"ok":false,"error":"ResponseTooLarge"}'
        sender.send_bytes(data)
    finally:
        sender.close()


async def _reap(process) -> None:
    """A child owns the sockets; terminate it before releasing the caller's slot."""
    if process.is_alive():
        process.terminate()
    await asyncio.to_thread(process.join, 0.5)
    if process.is_alive():
        process.kill()
        await asyncio.to_thread(process.join, 1.0)
    if process.is_alive():
        from .tools import ToolError

        raise ToolError("Network child could not be reaped after forced termination")
    process.close()


async def _call_in_process(
    target: Callable[..., None], args: tuple, *, timeout: float
) -> dict[str, Any]:
    """Internal trusted-target seam for deterministic process lifecycle tests."""
    from .tools import ToolError

    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ToolError("Network deadline must be positive")
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=target, args=(*args, sender), daemon=True)
    reader = None
    started = False
    cleanup_cancelled = False
    try:
        # Timeout begins before process startup, and therefore before DNS lookup.
        async with asyncio.timeout(timeout):
            process.start()
            started = True
            sender.close()
            reader = asyncio.create_task(asyncio.to_thread(receiver.recv_bytes, MAX_PIPE_BYTES))
            # Keep the receiver alive until child cleanup closes its sending end.
            raw = await asyncio.shield(reader)
            message = json.loads(raw)
            if not isinstance(message, dict):
                raise ToolError("Invalid network child response")
            return message
    except TimeoutError as exc:
        raise ToolError(
            "Remote whole-operation deadline exceeded; network child terminated"
        ) from exc
    except (EOFError, OSError, ValueError) as exc:
        raise ToolError(f"Network child failed: {type(exc).__name__}") from exc
    finally:
        sender.close()
        if started:
            cleanup = asyncio.create_task(_reap(process))
            # Even repeated cancellation cannot release a worker while its child
            # retains a socket. Cleanup is bounded and cancellation is propagated.
            while not cleanup.done():
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    cleanup_cancelled = True
            cleanup.result()
        else:
            process.close()
        if reader is not None:
            # Termination closed the only sender; a blocked receive now ends at EOF.
            while not reader.done():
                try:
                    await asyncio.shield(reader)
                except asyncio.CancelledError:
                    cleanup_cancelled = True
                except (EOFError, OSError):
                    break
            if reader.done() and not reader.cancelled():
                reader.exception()  # Retrieve any EOF/error, avoiding orphan-task warnings.
        receiver.close()
        if cleanup_cancelled:
            raise asyncio.CancelledError


async def async_request_json(url: str, **kwargs) -> tuple[int, Any]:
    """Run fixed host HTTP code; timeout/cancellation reaps sockets before return."""
    from .tools import ToolError

    message = await _call_in_process(_http_child, (url, kwargs), timeout=kwargs.get("timeout", 40))
    if message.get("ok") is not True:
        raise ToolError(f"Remote request failed: {message.get('error', 'InvalidResponse')}")
    status = message.get("status")
    if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
        raise ToolError("Invalid network child HTTP status")
    return status, message.get("body")
