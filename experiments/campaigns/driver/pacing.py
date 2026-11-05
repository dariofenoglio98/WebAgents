"""Crossref's lane (PROTOCOL.md §2.1: Crossref is a live third-party service, one request per
second; the task's "Do not": never exceed it).

Crossref's public pool advertises a concurrency of 1 and one request per second
(`x-concurrency-limit: 1`, `x-rate-limit-limit: 1`, `x-rate-limit-interval: 1s`). The Chrome core's
`scholarly.search` binding already holds itself to that (`max_concurrent: 1`, `min_interval_ms:
1000`, its own pacer); agentpkg's `create_handlers` does not pace, and the Citation Resolver paces
arXiv only. So every Crossref request this process sends, whoever sends it, takes this one lane:
one request at a time, each start at least `INTERVAL_SECONDS` after the previous one's start, the
Chrome binding's figures. The lane delays a request; it never changes, drops or retries one, so it
is a timing seam, not a change of what any side sends (stated in the campaign README).

Who takes it: `Py`'s and `FW`'s `scholarly.search` handler (`lane.paced_handler`), and the campaign
stack's Citation Resolver through the transport its `create_app` accepts (`PacedTransport`). The
`Cr` driver's searches are paced by the core's own binding in its Node process; within one
Literature Review run its searches and its citation lookups are separate graph stages (`search`
before `citations`), so they never overlap.
"""

from __future__ import annotations

import asyncio
import threading
import time

import httpx

CROSSREF_HOST = "api.crossref.org"
INTERVAL_SECONDS = 1.0


class Lane:
    """One request at a time, starts at least `interval` seconds apart (thread-safe: the
    resolver serves from its own thread, the drivers from theirs)."""

    def __init__(self, interval: float = INTERVAL_SECONDS):
        self.interval = interval
        self._held = threading.Lock()
        self._last_start: float | None = None
        self.starts: list[float] = []  # monotonic start times, for the tests and the record

    def acquire(self) -> None:
        self._held.acquire()
        if self._last_start is not None:
            wait = self._last_start + self.interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
        self._last_start = time.monotonic()
        self.starts.append(self._last_start)

    def release(self) -> None:
        self._held.release()

    async def run(self, coroutine_factory):
        """Await `coroutine_factory()` inside the lane."""
        await asyncio.to_thread(self.acquire)
        try:
            return await coroutine_factory()
        finally:
            self.release()

    def paced_handler(self, handler):
        """An agentpkg tool handler `(ctx, payload)` taken through the lane."""

        async def paced(ctx, payload):
            return await self.run(lambda: handler(ctx, payload))

        return paced


class PacedTransport(httpx.AsyncBaseTransport):
    """The resolver's upstream transport: its Crossref requests take the lane, the rest pass."""

    def __init__(self, lane: Lane, inner: httpx.AsyncBaseTransport | None = None):
        self.lane = lane
        self.inner = inner or httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.host != CROSSREF_HOST:
            return await self.inner.handle_async_request(request)

        async def send():
            response = await self.inner.handle_async_request(request)
            await response.aread()  # the request is over when its body is read
            return response

        return await self.lane.run(send)

    async def aclose(self) -> None:
        await self.inner.aclose()


# The process's one lane: every Crossref request of a campaign process goes through it.
CROSSREF = Lane()
