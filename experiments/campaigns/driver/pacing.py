"""Crossref's lane (PROTOCOL.md §2.1: Crossref is a live third-party service, one request per
second; the task's "Do not": never exceed it).

Crossref's public pool advertises a concurrency of 1 and one request per second
(`x-concurrency-limit: 1`, `x-rate-limit-limit: 1`, `x-rate-limit-interval: 1s`). The Chrome core's
`scholarly.search` binding already holds itself to that (`max_concurrent: 1`, `min_interval_ms:
1000`, its own pacer); agentpkg's `create_handlers` does not pace, and the Citation Resolver paces
arXiv only. So every Crossref request this process sends, whoever sends it, takes this one lane:
one request at a time, each starting at least `INTERVAL_SECONDS` after the previous one **ended**.
That is stricter than the Chrome binding's start-to-start interval, on purpose: agentpkg dials from
a spawned child whose start-up time varies, so starts 1 s apart let two sends fall 0.79 s apart
(the T31b smoke's `Py` run); measured from the end, no two sends are closer than the interval.
The lane delays a request; it never changes, drops or retries one, so it is a timing seam, not a
change of what any side sends (stated in the campaign README).

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
    """One request at a time, each starting at least `interval` seconds after the previous one
    ended. Thread-safe (the resolver
    serves from its own thread and event loop, the drivers from theirs) and cancellation-safe: the
    lock is only ever taken without blocking, from the coroutine that then holds it, so a run
    cancelled while it waits (a deadline) never leaves the lane held."""

    POLL_SECONDS = 0.02

    def __init__(self, interval: float = INTERVAL_SECONDS):
        self.interval = interval
        self._held = threading.Lock()
        self._last_end: float | None = None
        self.starts: list[float] = []  # monotonic start times, for the tests
        self.ends: list[float] = []

    async def run(self, coroutine_factory):
        """Await `coroutine_factory()` inside the lane."""
        while not self._held.acquire(blocking=False):
            await asyncio.sleep(self.POLL_SECONDS)
        try:
            if self._last_end is not None:
                wait = self._last_end + self.interval - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
            self.starts.append(time.monotonic())
            try:
                return await coroutine_factory()
            finally:
                self._last_end = time.monotonic()
                self.ends.append(self._last_end)
        finally:
            self._held.release()

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
