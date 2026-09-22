"""One side of the host bridge: a bounded, correlated JSONL peer.

The same class serves both directions; only the two method allowlists differ.
It owns exactly four things and nothing else:

* framing and correlation, including duplicate and unknown ids;
* bounded concurrency in both directions;
* cancellation, propagated as a notification and honoured as a task cancel;
* fail-closed termination, so a desynchronized peer stops rather than guesses.

It knows nothing about models, packages, run plans or OpenClaw.
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
from itertools import count

from . import protocol
from .errors import BridgeError, ProtocolError


async def stdio_streams(loop=None):
    """Bind this process's stdin/stdout as asyncio streams.

    stdout is the protocol channel and nothing else writes to it; stderr stays
    the ordinary place for logs, so a diagnostic can never be read as a frame.
    """
    loop = loop or asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=protocol.MAX_FRAME_BYTES)
    try:
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        transport, proto = await loop.connect_write_pipe(
            asyncio.streams.FlowControlMixin, sys.stdout.buffer
        )
    except (OSError, ValueError) as exc:
        raise BridgeError(
            "bridge_stdio_unavailable",
            "The host bridge speaks a private protocol over piped stdin/stdout. It is spawned "
            "by a trusted host, not run interactively or with redirected files.",
        ) from exc
    writer = asyncio.StreamWriter(transport, proto, None, loop)
    return reader, writer


class BridgePeer:
    """A request/response peer over one duplex byte stream pair."""

    def __init__(
        self,
        reader,
        writer,
        *,
        outbound_methods: frozenset[str],
        inbound_methods: frozenset[str],
        handler=None,
        prefix: str = "r",
    ):
        self._reader = reader
        self._writer = writer
        self._outbound = outbound_methods
        self._inbound = inbound_methods
        self._handler = handler
        self._ids = count(1)
        self._prefix = prefix
        self._pending: dict[str, asyncio.Future] = {}
        self._serving: dict[str, asyncio.Task] = {}
        self._seen: set[str] = set()
        self._write_lock = asyncio.Lock()
        self._closed: BridgeError | None = None
        self.frames_sent = 0
        self.frames_received = 0

    # -- writing -------------------------------------------------------------
    async def _send(self, frame: dict) -> None:
        data = protocol.encode(frame)
        async with self._write_lock:
            if self._closed is not None:
                raise self._closed
            self._writer.write(data)
            await self._writer.drain()
        self.frames_sent += 1

    async def call(self, method: str, params: dict, *, timeout: float | None = None) -> dict:
        """Send one request and await its response, honouring cancellation."""
        if self._closed is not None:
            raise self._closed
        if len(self._pending) >= protocol.MAX_PENDING:
            raise BridgeError("bridge_saturated", "Too many outstanding bridge requests")
        identifier = f"{self._prefix}{next(self._ids)}"
        frame = protocol.request(identifier, method, params, allowed=self._outbound)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[identifier] = future
        try:
            await self._send(frame)
            if timeout is None:
                return await future
            async with asyncio.timeout(timeout):
                return await future
        except TimeoutError as exc:
            await self._abandon(identifier)
            raise BridgeError(
                "bridge_timeout", f"The host did not answer {method} within {timeout:g}s"
            ) from exc
        except asyncio.CancelledError:
            await self._abandon(identifier)
            raise
        finally:
            self._pending.pop(identifier, None)

    async def _abandon(self, identifier: str) -> None:
        """Tell the peer to stop work we no longer await."""
        if self._closed is not None:
            return
        with contextlib.suppress(Exception):
            await self._send(protocol.cancel(identifier))

    # -- reading -------------------------------------------------------------
    async def serve(self) -> None:
        """Read frames until clean EOF, or until the contract is violated."""
        try:
            while True:
                try:
                    line = await self._reader.readuntil(b"\n")
                except asyncio.IncompleteReadError as exc:
                    if exc.partial:
                        raise protocol.ProtocolError(
                            "protocol_violation", "The peer closed mid-frame"
                        ) from exc
                    break  # Clean EOF.
                except (asyncio.LimitOverrunError, ValueError) as exc:
                    raise protocol.ProtocolError(
                        "protocol_violation", "The peer sent an oversized frame"
                    ) from exc
                self.frames_received += 1
                kind, frame = protocol.classify(
                    protocol.decode(line), inbound_methods=self._inbound
                )
                if kind == "response":
                    self._settle(frame)
                elif kind == "cancel":
                    task = self._serving.get(frame["params"]["id"])
                    if task is not None:
                        task.cancel()
                else:
                    self._accept(frame)
        except ProtocolError as exc:
            await self.close(exc)
            raise
        else:
            await self.close(BridgeError("bridge_closed", "The host bridge closed the stream"))

    def _settle(self, frame: dict) -> None:
        future = self._pending.pop(frame["id"], None)
        if future is None:
            # An answer to a request we never sent, or already abandoned, means
            # the streams no longer agree about what is outstanding.
            raise protocol.ProtocolError(
                "protocol_violation", "Response for an unknown or abandoned request id"
            )
        if future.done():
            return
        if frame["ok"] is True:
            future.set_result(frame["result"])
        else:
            error = frame["error"]
            future.set_exception(
                BridgeError(
                    str(error["code"])[:128],
                    str(error.get("message", "The host refused this request"))[:2048],
                    detail=error.get("detail"),
                )
            )

    def _accept(self, frame: dict) -> None:
        identifier = frame["id"]
        if identifier in self._seen:
            raise protocol.ProtocolError("protocol_violation", "Duplicate inbound request id")
        if len(self._serving) >= protocol.MAX_PENDING:
            raise protocol.ProtocolError("protocol_violation", "Too many inbound requests")
        self._seen.add(identifier)
        if self._handler is None:
            raise protocol.ProtocolError("protocol_violation", "This peer accepts no requests")
        self._serving[identifier] = asyncio.create_task(self._dispatch(frame))

    async def _dispatch(self, frame: dict) -> None:
        identifier, method = frame["id"], frame["method"]
        try:
            result = await self._handler(method, frame["params"])
            reply = protocol.ok(identifier, result)
        except asyncio.CancelledError:
            reply = protocol.err(identifier, "cancelled", f"{method} was cancelled")
        except BridgeError as exc:
            reply = protocol.err(identifier, exc.code, str(exc), exc.detail or None)
        except Exception as exc:  # Never leak a traceback onto the wire.
            print(f"host-bridge: {method} failed: {type(exc).__name__}", file=sys.stderr)
            reply = protocol.err(identifier, "internal_error", f"{method} failed")
        finally:
            self._serving.pop(identifier, None)
        with contextlib.suppress(Exception):
            await self._send(reply)

    # -- shutdown ------------------------------------------------------------
    async def close(self, reason: BridgeError | None = None) -> None:
        if self._closed is None:
            self._closed = reason or BridgeError("bridge_closed", "The host bridge was closed")
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(self._closed)
        self._pending.clear()
        for task in list(self._serving.values()):
            task.cancel()
        self._serving.clear()
        with contextlib.suppress(Exception):
            self._writer.close()


__all__ = ["BridgePeer", "stdio_streams"]
