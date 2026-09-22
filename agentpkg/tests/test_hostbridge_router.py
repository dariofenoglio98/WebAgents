"""The ModelRouter contract, adversarially.

`Runtime.call_model` trusts a router for three things it cannot verify itself:
that the model it names is the model that answered, that the token bound it
returns is an upper bound, and that the usage it reports is real. Every test
here is about one of those three.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from hostbridge_fakes import BINDING, PLAN, FakeHost, duplex, usage

from agentpkg.hostbridge import protocol
from agentpkg.hostbridge.errors import BridgeError
from agentpkg.hostbridge.peer import BridgePeer
from agentpkg.hostbridge.router import (
    FRAMING_TOKEN_ALLOWANCE,
    ROUTER_ID,
    HostBridgeModelRouter,
    capabilities_for,
    context_window_for,
    parse_structured,
    project_usage,
    render,
    token_upper_bound,
)
from agentpkg.hostbridge.session import BridgeSession

REQUEST = {
    "task": "plan",
    "instructions": ["Follow the brief.", "Stay inside the budget."],
    "data": {"goal": "ship the milestone", "minutes": 45},
    "output_schema": {
        "type": "object",
        "required": ["title"],
        "properties": {"title": {"type": "string"}},
        "additionalProperties": False,
    },
}


def wired(**host_options):
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
    serving = [host.peer.serve(), child.serve()]
    return host, child, session, serving


async def bound(host_options=None, plan=None):
    host, child, session, serving = wired(**(host_options or {}))
    tasks = asyncio.gather(*[asyncio.create_task(item) for item in serving], return_exceptions=True)
    await host.peer.call("session.begin", {"run_plan": plan or PLAN})
    return host, child, session, tasks


async def teardown(host, child, tasks):
    await host.peer.close()
    await child.close()
    await tasks


# -- declaration -------------------------------------------------------------
def test_the_router_declares_the_bound_model_and_what_it_can_deliver():
    router = HostBridgeModelRouter(None, BINDING)
    assert router.router_id == ROUTER_ID
    assert router.model_id == "acme/big"
    assert router.context_window == 200000
    assert router.remote is True
    # structured_output because this adapter enforces it; reasoning because the
    # bound model's own host descriptor declares it.
    assert router.capabilities == frozenset({"structured_output", "reasoning"})
    # Never claimed: the adapter exposes no tools and sends only text, however
    # capable the raw model is.
    assert "tool_use" not in router.capabilities
    assert "multimodal" not in router.capabilities
    assert router.describe()["not_declared"] == ["multimodal", "tool_use"]


def test_reasoning_is_only_declared_when_the_host_declared_it():
    for value, expected in [(True, True), (False, False), (None, False)]:
        binding = json.loads(json.dumps(BINDING))
        binding["capabilities"]["reasoning"]["value"] = value
        assert ("reasoning" in capabilities_for(binding)) is expected
    binding = json.loads(json.dumps(BINDING))
    del binding["capabilities"]["reasoning"]
    assert capabilities_for(binding) == frozenset({"structured_output"})


def test_an_unknown_context_window_refuses_to_build_a_router():
    binding = json.loads(json.dumps(BINDING))
    binding["limits"] = {"context_tokens": None, "native_context_window": None}
    with pytest.raises(BridgeError) as failure:
        context_window_for(binding)
    assert failure.value.code == "model_context_window_unknown"


def test_a_model_the_host_calls_local_is_not_remote():
    binding = json.loads(json.dumps(BINDING))
    binding["properties"]["local"] = True
    assert HostBridgeModelRouter(None, binding).remote is False
    binding["properties"]["local"] = None
    assert HostBridgeModelRouter(None, binding).remote is True


# -- token counting ----------------------------------------------------------
def test_the_counted_content_is_exactly_the_content_that_is_sent():
    first, second = render(REQUEST), render(REQUEST)
    assert first == second, "rendering must be a pure function of the request"
    for instruction in REQUEST["instructions"]:
        assert instruction in first["system"]
    assert "ship the milestone" in first["user"]
    assert '"title"' in first["system"], "the output schema travels in the prompt"
    # Nothing is added that the count would not see.
    assert first["schema_text"] == json.dumps(
        REQUEST["output_schema"], sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def test_the_bound_covers_every_byte_plus_framing():
    rendered = render(REQUEST)
    total = sum(len(rendered[key].encode()) for key in ("system", "user", "schema_text"))
    assert token_upper_bound(rendered) == total + FRAMING_TOKEN_ALLOWANCE


@pytest.mark.parametrize(
    "text",
    ["ascii only", "unicode: café — naïve", "日本語のテキスト", "emoji 🧪🔬", "a" * 5000],
)
def test_the_bound_is_never_below_a_byte_level_tokenization(text):
    """Every subword token decodes to at least one byte, so bytes bound tokens.

    The strictest tokenizer imaginable emits one token per UTF-8 byte; the
    bound must still hold for it.
    """
    request = dict(REQUEST, data={"text": text})
    rendered = render(request)
    worst_case = sum(len(rendered[key].encode()) for key in ("system", "user", "schema_text"))
    assert token_upper_bound(rendered) >= worst_case


def test_an_exact_host_tokenizer_is_preferred_when_one_exists():
    async def main():
        host, child, session, tasks = await bound(
            {"tokenizer": {"supported": True, "input_tokens": 77, "exact": True}}
        )
        assert await session.router.count_tokens(REQUEST) == 77
        assert session.router.last_count["basis"] == "host_tokenizer"
        await teardown(host, child, tasks)

    asyncio.run(main())


def test_an_invalid_host_token_count_is_refused():
    async def main():
        host, child, session, tasks = await bound(
            {"tokenizer": {"supported": True, "input_tokens": -1}}
        )
        with pytest.raises(BridgeError) as failure:
            await session.router.count_tokens(REQUEST)
        assert failure.value.code == "model_usage_invalid"
        await teardown(host, child, tasks)

    asyncio.run(main())


def test_without_a_host_tokenizer_the_provable_bound_is_used_and_recorded():
    async def main():
        host, child, session, tasks = await bound()
        value = await session.router.count_tokens(REQUEST)
        assert value == token_upper_bound(render(REQUEST))
        record = session.router.last_count
        assert record["basis"] == "utf8_upper_bound"
        assert record["host_tokenizer"] is False
        assert record["framing_allowance"] == FRAMING_TOKEN_ALLOWANCE
        assert set(record["counted_bytes"]) == {"system", "user", "output_schema"}
        await teardown(host, child, tasks)

    asyncio.run(main())


# -- exact model binding -----------------------------------------------------
def test_a_completion_from_another_model_is_refused_after_the_fact():
    async def main():
        host, child, session, tasks = await bound({"model_id": "acme/small"})
        with pytest.raises(BridgeError) as failure:
            await session.router.complete(REQUEST, max_output_tokens=64)
        assert failure.value.code == "selected_model_unavailable"
        assert failure.value.detail == {"expected": "acme/big", "invoked": "acme/small"}
        await teardown(host, child, tasks)

    asyncio.run(main())


def test_the_router_never_names_a_model_on_the_wire():
    """The host holds the binding; the child cannot ask for a different one."""

    async def main():
        host, child, session, tasks = await bound({"text": '{"title":"ok"}'})
        await session.router.count_tokens(REQUEST)
        await session.router.complete(REQUEST, max_output_tokens=64)
        for method, params in host.requests:
            assert "model" not in params and "model_id" not in params, method
            assert "provider" not in params and "provider_id" not in params, method
        await teardown(host, child, tasks)

    asyncio.run(main())


def test_the_output_cap_is_sent_to_the_host_unchanged():
    async def main():
        host, child, session, tasks = await bound({"text": '{"title":"ok"}'})
        await session.router.complete(REQUEST, max_output_tokens=123)
        assert host.completions()[0]["max_output_tokens"] == 123
        assert host.completions()[0]["output_schema"] == REQUEST["output_schema"]
        await teardown(host, child, tasks)

    asyncio.run(main())


@pytest.mark.parametrize("value", [0, -5, 2.5, True, "64"])
def test_an_invalid_output_cap_is_refused_before_dispatch(value):
    async def main():
        host, child, session, tasks = await bound()
        with pytest.raises(BridgeError) as failure:
            await session.router.complete(REQUEST, max_output_tokens=value)
        assert failure.value.code == "model_request_invalid"
        assert host.completions() == []
        await teardown(host, child, tasks)

    asyncio.run(main())


# -- structured output -------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "mode"),
    [
        ('{"title":"a"}', "direct"),
        ('  {"title":"a"}\n', "direct"),
        ('```json\n{"title":"a"}\n```', "fenced"),
        ('```\n{"title":"a"}\n```', "fenced"),
        ('Here you go: {"title":"a"} — done.', "extracted"),
    ],
)
def test_structured_output_is_recovered_in_one_bounded_attempt(text, mode):
    value, actual = parse_structured(text)
    assert value == {"title": "a"} and actual == mode


@pytest.mark.parametrize("text", ["", "   ", "no json here", "{unclosed", '{"a": }'])
def test_unparseable_output_fails_rather_than_looping(text):
    with pytest.raises(BridgeError) as failure:
        parse_structured(text)
    assert failure.value.code == "model_output_not_conforming"


def test_output_that_parses_but_violates_the_schema_is_refused():
    async def main():
        host, child, session, tasks = await bound({"text": '{"title": 12}'})
        with pytest.raises(BridgeError) as failure:
            await session.router.complete(REQUEST, max_output_tokens=64)
        assert failure.value.code == "model_output_not_conforming"
        assert host.completions(), "the failure is post-dispatch, so usage is already spent"
        await teardown(host, child, tasks)

    asyncio.run(main())


def test_a_conforming_completion_returns_the_runtime_result_shape():
    async def main():
        host, child, session, tasks = await bound(
            {"text": '{"title":"ok"}', "usage_report": usage(200, 20, cost_usd=0.0012)}
        )
        result = await session.router.complete(REQUEST, max_output_tokens=64)
        assert result == {
            "output": {"title": "ok"},
            "input_tokens": 200,
            "output_tokens": 20,
            "cost_usd": 0.0012,
        }
        assert session.router.last_completion["parse"] == "direct"
        assert session.router.last_completion["constrained_by_host"] is True
        await teardown(host, child, tasks)

    asyncio.run(main())


# -- usage -------------------------------------------------------------------
def test_billable_prompt_tokens_include_cache_reads_and_writes():
    projected = project_usage(
        {
            "input_tokens": 100,
            "output_tokens": 10,
            "cache_read_tokens": 40,
            "cache_write_tokens": 5,
            "total_tokens": 155,
        }
    )
    assert projected["input_tokens"] == 145
    assert projected["output_tokens"] == 10


def test_an_aggregate_total_above_the_breakdown_is_charged_to_output():
    """Unreported reasoning tokens must be paid for, not rounded away."""
    projected = project_usage({"input_tokens": 100, "output_tokens": 10, "total_tokens": 900})
    assert projected["input_tokens"] == 100
    assert projected["output_tokens"] == 800


def test_a_host_that_reports_nothing_fails_instead_of_estimating():
    for report in ({}, {"input_tokens": 0, "output_tokens": 0}, None):
        with pytest.raises(BridgeError) as failure:
            project_usage(report)
        assert failure.value.code in {"model_usage_unavailable", "model_usage_invalid"}


@pytest.mark.parametrize(
    "report",
    [
        {"input_tokens": -1, "output_tokens": 1},
        {"input_tokens": 1, "output_tokens": "many"},
        {"input_tokens": 1, "output_tokens": 1, "cache_read_tokens": True},
        {"input_tokens": 1, "output_tokens": 1, "cost_usd": "free"},
    ],
)
def test_invalid_usage_is_refused(report):
    with pytest.raises(BridgeError) as failure:
        project_usage(report)
    assert failure.value.code == "model_usage_invalid"


def test_an_overrun_is_reported_honestly_rather_than_hidden():
    """Runtime halts on an overrun; the router must let it see one."""

    async def main():
        host, child, session, tasks = await bound(
            {"text": '{"title":"ok"}', "usage_report": usage(10, 5000)}
        )
        result = await session.router.complete(REQUEST, max_output_tokens=64)
        assert result["output_tokens"] == 5000
        await teardown(host, child, tasks)

    asyncio.run(main())
