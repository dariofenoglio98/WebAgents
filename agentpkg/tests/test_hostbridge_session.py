"""Binding a session, running the one probe, and refusing everything else."""

from __future__ import annotations

import asyncio
import json

import pytest
from hostbridge_fakes import PLAN, FakeHost, duplex, usage

from agentpkg.hostbridge import protocol
from agentpkg.hostbridge.errors import BridgeError
from agentpkg.hostbridge.peer import BridgePeer
from agentpkg.hostbridge.probe import (
    PROBE_ECHO,
    PROBE_INSTRUCTIONS,
    PROBE_MAX_OUTPUT_TOKENS,
    PROBE_OUTPUT_SCHEMA,
    build_request,
)
from agentpkg.hostbridge.session import BridgeSession, normalize_plan


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
    tasks = asyncio.gather(
        asyncio.create_task(host.peer.serve()),
        asyncio.create_task(child.serve()),
        return_exceptions=True,
    )
    return host, child, session, tasks


async def finish(host, child, tasks):
    await host.peer.close()
    await child.close()
    await tasks


def run(coro):
    return asyncio.run(coro)


# -- binding -----------------------------------------------------------------
def test_begin_binds_one_router_and_says_it_cannot_execute():
    async def main():
        host, child, session, tasks = wired()
        answer = await host.peer.call("session.begin", {"run_plan": PLAN})
        assert answer["protocol"] == protocol.PROTOCOL_VERSION
        assert answer["run_plan_sha256"] == PLAN["run_plan_sha256"]
        assert answer["router"]["model_id"] == "acme/big"
        assert answer["execution"]["workflow_supported"] is False
        await finish(host, child, tasks)

    run(main())


def test_a_second_begin_is_refused():
    async def main():
        host, child, session, tasks = wired()
        await host.peer.call("session.begin", {"run_plan": PLAN})
        with pytest.raises(BridgeError) as failure:
            await host.peer.call("session.begin", {"run_plan": PLAN})
        assert failure.value.code == "session_already_bound"
        await finish(host, child, tasks)

    run(main())


@pytest.mark.parametrize(
    "mutate",
    [
        lambda plan: plan.pop("model_binding"),
        lambda plan: plan["execution"].update(mode="fixture"),
        lambda plan: plan.update(surprise="value"),
        lambda plan: plan["model_binding"].update(base_url="https://provider.example"),
        lambda plan: plan["model_binding"].update(api_key="secret"),
        lambda plan: plan["model_binding"].pop("host_model_id"),
        lambda plan: plan["model_binding"]["limits"].update(context_tokens=-1),
        lambda plan: plan["package"].update(path="/etc/passwd"),
    ],
)
def test_an_unexpected_or_unsafe_binding_is_refused(mutate):
    plan = json.loads(json.dumps(PLAN))
    mutate(plan)
    with pytest.raises(BridgeError) as failure:
        normalize_plan(plan)
    assert failure.value.code == "session_invalid"


def test_the_binding_carries_no_credential_endpoint_or_path():
    normalized = normalize_plan(json.loads(json.dumps(PLAN)))
    text = json.dumps(normalized)
    for banned in ("http://", "https://", "Bearer", "api_key", "apiKey", "secret", "/Users/"):
        assert banned not in text


# -- probe -------------------------------------------------------------------
def test_the_probe_request_is_host_owned_and_names_no_package():
    request = build_request(context_window=200000)
    assert request["instructions"] == PROBE_INSTRUCTIONS
    assert request["data"] == {"message": PROBE_ECHO}
    assert request["output_schema"] == PROBE_OUTPUT_SCHEMA
    assert request["budget_context"]["max_output_tokens"] == PROBE_MAX_OUTPUT_TOKENS
    rendered = json.dumps(request)
    for package_word in ("meeting-agenda", "literature", "SKILL", "agenda", "Crossref", "citation"):
        assert package_word.lower() not in rendered.lower()


def test_a_successful_probe_reports_the_model_the_plan_bound():
    async def main():
        host, child, session, tasks = wired(usage_report=usage(1200, 14, total_tokens=1214))
        await host.peer.call("session.begin", {"run_plan": PLAN})
        report = await host.peer.call("probe.run", {})
        assert report["status"] == "ok"
        assert report["probe"] == {"status": "ok", "echo": PROBE_ECHO}
        assert report["model"]["planned"] == report["model"]["invoked"] == "acme/big"
        assert report["router"]["router_id"] == "openclaw.host-bridge.v0"
        assert report["usage"] == {
            "input_tokens": 1200,
            "output_tokens": 14,
            "cost_usd": None,
            "host_reported": report["usage"]["host_reported"],
        }
        assert report["accounting"]["input_within_bound"] is True
        assert report["accounting"]["output_within_cap"] is True
        assert report["structured_output"]["validated"] is True
        assert report["workflow_executed"] is False
        assert report["package_execution"]["workers_started"] == 0
        assert report["run_plan_sha256"] == PLAN["run_plan_sha256"]
        await finish(host, child, tasks)

    run(main())


def test_a_probe_whose_input_exceeds_the_bound_is_a_contract_violation():
    """Exactly the rule `Runtime.call_model` applies, reported before it bites."""

    async def main():
        host, child, session, tasks = wired(usage_report=usage(10_000_000, 3))
        await host.peer.call("session.begin", {"run_plan": PLAN})
        report = await host.peer.call("probe.run", {})
        assert report["status"] == "contract_violation"
        assert report["accounting"]["input_within_bound"] is False
        await finish(host, child, tasks)

    run(main())


def test_a_probe_whose_output_exceeds_the_cap_is_a_contract_violation():
    async def main():
        host, child, session, tasks = wired(usage_report=usage(50, PROBE_MAX_OUTPUT_TOKENS + 1))
        await host.peer.call("session.begin", {"run_plan": PLAN})
        report = await host.peer.call("probe.run", {})
        assert report["status"] == "contract_violation"
        assert report["accounting"]["output_within_cap"] is False
        await finish(host, child, tasks)

    run(main())


def test_a_probe_answer_that_is_not_the_echo_fails_the_schema():
    async def main():
        host, child, session, tasks = wired(text='{"status":"ok","echo":"something else"}')
        await host.peer.call("session.begin", {"run_plan": PLAN})
        with pytest.raises(BridgeError) as failure:
            await host.peer.call("probe.run", {})
        assert failure.value.code == "model_output_not_conforming"
        await finish(host, child, tasks)

    run(main())


def test_probing_without_a_bound_plan_is_refused():
    async def main():
        host, child, session, tasks = wired()
        with pytest.raises(BridgeError) as failure:
            await host.peer.call("probe.run", {})
        assert failure.value.code == "session_not_bound"
        await finish(host, child, tasks)

    run(main())


def test_one_session_runs_one_probe():
    async def main():
        host, child, session, tasks = wired()
        await host.peer.call("session.begin", {"run_plan": PLAN})
        await host.peer.call("probe.run", {})
        with pytest.raises(BridgeError) as failure:
            await host.peer.call("probe.run", {})
        assert failure.value.code == "probe_already_run"
        await finish(host, child, tasks)

    run(main())


def test_the_probe_takes_no_parameters():
    async def main():
        host, child, session, tasks = wired()
        await host.peer.call("session.begin", {"run_plan": PLAN})
        for payload in ({"prompt": "hi"}, {"model": "acme/other"}, {"schema": {}}):
            with pytest.raises(BridgeError) as failure:
                await host.peer.call("probe.run", payload)
            assert failure.value.code == "session_invalid"
        await finish(host, child, tasks)

    run(main())
