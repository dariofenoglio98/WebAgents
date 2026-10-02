"""A bidirectional JSON-lines RPC peer between this process and the Node host helper.

One JSON object per line in each direction:

    {"t": "req", "id": "py-1", "m": "method", "p": {...}}      request
    {"t": "res", "id": "py-1", "ok": true,  "r": {...}}        result
    {"t": "res", "id": "py-1", "ok": false, "e": {...}}        error
    {"t": "ntf", "m": "method", "p": {...}}                    notification

Both sides may call the other while one of their own calls is outstanding,
which is what lets the real plugin backend (Node) call the real control plane
(Python) in the middle of a Python-initiated `startExecution`. Requests are
served as concurrent tasks; notifications are handled inline, in arrival order,
because the runner's stdio stream is carried as notifications and must not be
reordered.

This is experiment transport, not a production protocol.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import traceback
from collections.abc import Awaitable, Callable
from itertools import count
from typing import Any

MAX_LINE_BYTES = 128 * 1024 * 1024


class RpcError(Exception):
    """A failure the other side reported, with its stable code."""

    def __init__(self, code: str, message: str, data: Any = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.data = data


class RpcClosed(RpcError):
    def __init__(self, message: str = "the RPC peer closed"):
        super().__init__("rpc_closed", message)


RequestHandler = Callable[[dict], Awaitable[Any]]
NotificationHandler = Callable[[dict], None]


class RpcPeer:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer,
        *,
        requests: dict[str, RequestHandler] | None = None,
        notifications: dict[str, NotificationHandler] | None = None,
        prefix: str = "py",
    ):
        self._reader = reader
        self._writer = writer
        self.requests: dict[str, RequestHandler] = dict(requests or {})
        self.notifications: dict[str, NotificationHandler] = dict(notifications or {})
        self._ids = count(1)
        self._prefix = prefix
        self._pending: dict[str, asyncio.Future] = {}
        self._serving: dict[str, asyncio.Task] = {}
        self._closed: RpcError | None = None
        self.handler_failures: list[dict] = []

    # -- sending -----------------------------------------------------------------
    def _write(self, message: dict) -> None:
        if self._closed is not None:
            raise self._closed
        line = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        self._writer.write(line.encode("utf-8") + b"\n")

    async def drain(self) -> None:
        with contextlib.suppress(ConnectionError):
            await self._writer.drain()

    def notify(self, method: str, params: dict | None = None) -> None:
        self._write({"t": "ntf", "m": method, "p": params or {}})

    async def call(self, method: str, params: dict | None = None, *, timeout: float | None = None):
        if self._closed is not None:
            raise self._closed
        identifier = f"{self._prefix}-{next(self._ids)}"
        future = asyncio.get_running_loop().create_future()
        self._pending[identifier] = future
        try:
            self._write({"t": "req", "id": identifier, "m": method, "p": params or {}})
            await self.drain()
            if timeout is None:
                return await future
            async with asyncio.timeout(timeout):
                return await future
        finally:
            self._pending.pop(identifier, None)

    # -- receiving ---------------------------------------------------------------
    async def serve(self) -> None:
        try:
            while True:
                try:
                    line = await self._reader.readline()
                except (asyncio.LimitOverrunError, ValueError) as exc:
                    raise RpcError("rpc_protocol", f"oversized line: {exc}") from exc
                if not line:
                    break
                if not line.strip():
                    continue
                message = json.loads(line.decode("utf-8"))
                kind = message.get("t")
                if kind == "res":
                    future = self._pending.get(message.get("id"))
                    if future is None or future.done():
                        continue
                    if message.get("ok") is True:
                        future.set_result(message.get("r"))
                    else:
                        error = message.get("e") or {}
                        future.set_exception(
                            RpcError(
                                str(error.get("code", "rpc_error")),
                                str(error.get("message", "")),
                                error.get("data"),
                            )
                        )
                elif kind == "req":
                    identifier = message.get("id")
                    task = asyncio.create_task(self._dispatch(identifier, message))
                    self._serving[identifier] = task
                elif kind == "ntf":
                    method = message.get("m")
                    if method == "rpc.cancel":
                        task = self._serving.get((message.get("p") or {}).get("id"))
                        if task is not None:
                            task.cancel()
                        continue
                    handler = self.notifications.get(method)
                    if handler is not None:
                        try:
                            handler(message.get("p") or {})
                        except Exception as exc:  # noqa: BLE001 - recorded, surfaced by caller
                            self.handler_failures.append(
                                {"method": method, "error": f"{type(exc).__name__}: {exc}"}
                            )
        finally:
            await self.close(RpcClosed())

    async def _dispatch(self, identifier, message) -> None:
        method = message.get("m")
        try:
            handler = self.requests.get(method)
            if handler is None:
                raise RpcError("rpc_unknown_method", f"no handler for {method!r}")
            result = await handler(message.get("p") or {})
            reply = {"t": "res", "id": identifier, "ok": True, "r": result}
        except asyncio.CancelledError:
            reply = {"t": "res", "id": identifier, "ok": False, "e": {"code": "cancelled"}}
        except RpcError as exc:
            reply = {
                "t": "res",
                "id": identifier,
                "ok": False,
                "e": {"code": exc.code, "message": exc.message, "data": exc.data},
            }
        except Exception as exc:  # noqa: BLE001 - every failure becomes an error reply
            self.handler_failures.append(
                {
                    "method": method,
                    "error": f"{type(exc).__name__}: {exc}",
                    "trace": traceback.format_exc(limit=8),
                }
            )
            reply = {
                "t": "res",
                "id": identifier,
                "ok": False,
                "e": {"code": "handler_error", "message": f"{type(exc).__name__}: {exc}"},
            }
        finally:
            self._serving.pop(identifier, None)
        with contextlib.suppress(RpcError, ConnectionError):
            self._write(reply)
            await self.drain()

    async def close(self, reason: RpcError | None = None) -> None:
        if self._closed is None:
            self._closed = reason or RpcClosed()
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(self._closed)
        self._pending.clear()
        for task in list(self._serving.values()):
            task.cancel()
        self._serving.clear()
