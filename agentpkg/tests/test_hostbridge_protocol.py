"""The wire contract: correlation, bounds, cancellation, and failing closed.

Nothing here involves a model. These are the properties that let package data
flow through the bridge later without the bridge becoming a general-purpose
remote-procedure surface.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from hostbridge_fakes import PLAN, FakeHost, duplex

from agentpkg.hostbridge import protocol
from agentpkg.hostbridge.errors import BridgeError, ProtocolError
from agentpkg.hostbridge.peer import BridgePeer
from agentpkg.hostbridge.session import BridgeSession


def wired(**host_options):
    """A bound child session and its scripted parent, both serving."""
    (child_reader, child_writer), (host_reader, host_writer) = duplex()
    host = FakeHost(host_reader, host_writer, **host_options)
    session: BridgeSession | None = None

    async def handler(method, params):
        return await session(method, params)

    child = BridgePeer(
        child_reader,
        child_writer,
        outbound_methods=protocol.HOST_METHODS,
        inbound_methods=protocol.CHILD_METHODS,
        handler=handler,
        prefix="c",
    )
    session = BridgeSession(child)
    return host, child, session


async def _serving(host, child):
    return asyncio.gather(
        asyncio.create_task(host.peer.serve()),
        asyncio.create_task(child.serve()),
        return_exceptions=True,
    )


def test_methods_are_disjoint_and_closed():
    assert protocol.HOST_METHODS.isdisjoint(protocol.CHILD_METHODS)
    assert protocol.HOST_METHODS == {"model.count_tokens", "model.complete"}
    assert protocol.CHILD_METHODS == {"session.begin", "probe.run", "session.end"}
    # No name in either set can address a file, a model or an OpenClaw method.
    for method in protocol.HOST_METHODS | protocol.CHILD_METHODS:
        assert "/" not in method and "\\" not in method


def test_a_request_and_its_answer_stay_correlated():
    async def main():
        host, child, session = wired()
        serving = await _serving(host, child)
        begin = await host.peer.call("session.begin", {"run_plan": PLAN})
        assert begin["run_plan_id"] == PLAN["run_plan_id"]
        # Two probes in flight would be refused by the session, so correlation
        # is shown with one probe and one end running concurrently.
        first, second = await asyncio.gather(
            host.peer.call("probe.run", {}),
            host.peer.call("session.end", {}),
        )
        assert first["schema"] == "agentpkg-router-probe-v0"
        assert second == {"ended": True, "probes": 1}
        await host.peer.close()
        await child.close()
        await serving

    asyncio.run(main())


def test_a_malformed_frame_ends_the_session():
    async def main():
        _, child_writer = duplex()[0]
        reader = asyncio.StreamReader()
        peer = BridgePeer(
            reader,
            child_writer,
            outbound_methods=protocol.HOST_METHODS,
            inbound_methods=protocol.CHILD_METHODS,
            handler=None,
        )
        reader.feed_data(b"not json at all\n")
        with pytest.raises(ProtocolError):
            await peer.serve()

    asyncio.run(main())


@pytest.mark.parametrize(
    "frame",
    [
        {"v": "wrong/version", "id": "x1", "method": "session.end", "params": {}},
        {"v": protocol.PROTOCOL_VERSION, "id": "x1", "method": "os.exec", "params": {}},
        {"v": protocol.PROTOCOL_VERSION, "id": "x1", "method": "model.complete", "params": {}},
        {"v": protocol.PROTOCOL_VERSION, "id": "x1", "method": "session.end"},
        {"v": protocol.PROTOCOL_VERSION, "id": "x1", "method": "session.end", "params": []},
        {"v": protocol.PROTOCOL_VERSION, "id": "bad id!", "method": "session.end", "params": {}},
        {"v": protocol.PROTOCOL_VERSION, "id": "x1", "ok": True},
        {"v": protocol.PROTOCOL_VERSION, "id": "x1", "ok": "yes", "result": {}},
        {"v": protocol.PROTOCOL_VERSION, "method": "$/cancel", "params": {"id": "a", "b": 1}},
        [1, 2, 3],
    ],
)
def test_every_ill_formed_frame_is_refused(frame):
    async def main():
        _, child_writer = duplex()[0]
        reader = asyncio.StreamReader()
        peer = BridgePeer(
            reader,
            child_writer,
            outbound_methods=protocol.HOST_METHODS,
            inbound_methods=protocol.CHILD_METHODS,
            handler=lambda method, params: asyncio.sleep(0, {}),
        )
        reader.feed_data(json.dumps(frame).encode() + b"\n")
        with pytest.raises(ProtocolError):
            await peer.serve()

    asyncio.run(main())


def test_an_oversized_frame_is_refused_in_both_directions():
    huge = "x" * (protocol.MAX_FRAME_BYTES + 10)
    with pytest.raises(ProtocolError, match="maximum size"):
        protocol.encode({"v": protocol.PROTOCOL_VERSION, "id": "a", "result": huge})
    with pytest.raises(ProtocolError, match="maximum size"):
        protocol.decode(huge.encode())

    async def main():
        reader = asyncio.StreamReader(limit=protocol.MAX_FRAME_BYTES)
        _, writer = duplex()[0]
        peer = BridgePeer(
            reader,
            writer,
            outbound_methods=protocol.HOST_METHODS,
            inbound_methods=protocol.CHILD_METHODS,
            handler=None,
        )
        reader.feed_data(b"{" + b"x" * (protocol.MAX_FRAME_BYTES + 64) + b"}\n")
        with pytest.raises(ProtocolError):
            await peer.serve()

    asyncio.run(main())


def test_a_duplicate_request_id_is_refused():
    """An id is spent once. Reuse means the peers disagree about what is open."""

    async def main():
        reader = asyncio.StreamReader()
        _, writer = duplex()[0]
        peer = BridgePeer(
            reader,
            writer,
            outbound_methods=protocol.HOST_METHODS,
            inbound_methods=protocol.CHILD_METHODS,
            handler=lambda method, params: asyncio.sleep(0, {}),
        )
        frame = protocol.encode(
            protocol.request("h1", "session.end", {}, allowed=protocol.CHILD_METHODS)
        )
        reader.feed_data(frame + frame)
        with pytest.raises(ProtocolError, match="Duplicate"):
            await peer.serve()

    asyncio.run(main())


def test_a_response_to_an_unknown_id_is_refused():
    async def main():
        reader = asyncio.StreamReader()
        _, writer = duplex()[0]
        peer = BridgePeer(
            reader,
            writer,
            outbound_methods=protocol.HOST_METHODS,
            inbound_methods=protocol.CHILD_METHODS,
            handler=None,
        )
        reader.feed_data(protocol.encode(protocol.ok("never-sent", {"a": 1})))
        with pytest.raises(ProtocolError, match="unknown or abandoned"):
            await peer.serve()

    asyncio.run(main())


def test_a_timeout_cancels_the_host_operation_and_frees_the_slot():
    started = asyncio.Event()

    async def never(params):
        started.set()
        await asyncio.sleep(30)
        return {}

    async def main():
        host, child, session = wired(on_complete=never)
        serving = await _serving(host, child)
        await host.peer.call("session.begin", {"run_plan": PLAN})
        session.router.timeout = 0.2
        with pytest.raises(BridgeError) as failure:
            await session.router.complete(
                {"task": "t", "instructions": [], "data": {}, "output_schema": {}},
                max_output_tokens=16,
            )
        assert failure.value.code == "bridge_timeout"
        assert started.is_set()
        await asyncio.sleep(0.05)
        # The host task was cancelled by the $/cancel notification, not left running.
        assert not host.peer._serving
        assert not child._pending
        await host.peer.close()
        await child.close()
        await serving

    asyncio.run(main())


def test_cancelling_the_caller_cancels_the_host_operation():
    cancelled = asyncio.Event()

    async def slow(params):
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return {}

    async def main():
        host, child, session = wired(on_complete=slow)
        serving = await _serving(host, child)
        await host.peer.call("session.begin", {"run_plan": PLAN})
        task = asyncio.create_task(
            session.router.complete(
                {"task": "t", "instructions": [], "data": {}, "output_schema": {}},
                max_output_tokens=16,
            )
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.05)
        assert cancelled.is_set()
        await host.peer.close()
        await child.close()
        await serving

    asyncio.run(main())


def test_closing_the_stream_fails_every_pending_call():
    async def main():
        host, child, session = wired(on_complete=lambda params: asyncio.sleep(30))
        serving = await _serving(host, child)
        await host.peer.call("session.begin", {"run_plan": PLAN})
        pending = asyncio.create_task(
            session.router.complete(
                {"task": "t", "instructions": [], "data": {}, "output_schema": {}},
                max_output_tokens=16,
            )
        )
        await asyncio.sleep(0.05)
        await child.close(BridgeError("bridge_closed", "peer gone"))
        with pytest.raises(BridgeError) as failure:
            await pending
        assert failure.value.code == "bridge_closed"
        await host.peer.close()
        await serving

    asyncio.run(main())


def test_outstanding_requests_are_bounded():
    async def main():
        host, child, session = wired(on_complete=lambda params: asyncio.sleep(30))
        serving = await _serving(host, child)
        await host.peer.call("session.begin", {"run_plan": PLAN})
        request = {"task": "t", "instructions": [], "data": {}, "output_schema": {}}
        tasks = [
            asyncio.create_task(session.router.complete(request, max_output_tokens=16))
            for _ in range(protocol.MAX_PENDING + 4)
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        saturated = [
            item
            for item in results
            if isinstance(item, BridgeError) and item.code == "bridge_saturated"
        ]
        assert saturated, "the pending bound must refuse the excess"
        for task in tasks:
            task.cancel()
        await host.peer.close()
        await child.close()
        await serving

    asyncio.run(main())


def test_concurrent_model_calls_keep_their_own_answers():
    """Two completions in flight must not be able to receive each other's text."""

    async def distinct(params):
        # Answer out of order, so correlation cannot succeed by accident.
        marker = params["user"]
        await asyncio.sleep(0.05 if "first" in marker else 0.01)
        return {
            "text": json.dumps({"seen": marker}),
            "model_id": "acme/big",
            "provider_id": "acme",
            "usage": {"input_tokens": 10, "output_tokens": 2},
        }

    async def main():
        host, child, session = wired(on_complete=distinct)
        serving = await _serving(host, child)
        await host.peer.call("session.begin", {"run_plan": PLAN})
        schema = {"type": "object", "required": ["seen"], "properties": {"seen": {}}}

        def request(name):
            return {"task": "t", "instructions": [], "data": name, "output_schema": schema}

        first, second = await asyncio.gather(
            session.router.complete(request("first"), max_output_tokens=16),
            session.router.complete(request("second"), max_output_tokens=16),
        )
        assert first["output"]["seen"] == '"first"'
        assert second["output"]["seen"] == '"second"'
        await host.peer.close()
        await child.close()
        await serving

    asyncio.run(main())
