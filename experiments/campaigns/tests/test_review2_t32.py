"""T32 review 2's findings 3 and 4: D-361's rate-limit policy, the same on every side, and `Py`'s
route failures outside the old allowlist."""

from __future__ import annotations

import asyncio
import json

import httpx
import openai
import pytest
from agentpkg.hostbridge.errors import BridgeError
from campaigns.baseline import agent
from campaigns.driver import campaign, cr_driver, record, routes
from campaigns.driver.routes import (
    RATE_LIMIT_RETRY,
    CampaignRouter,
    RateLimitRetryTransport,
    Rung,
    rate_limit_wait,
)

KEY_ENV = "T32_REVIEW2_TEST_KEY"
H = Rung("H", "openai", "gpt-test", "https://api.openai.com", temperature=None, api_key_env=KEY_ENV)
L9 = Rung("L9", "ollama", "qwen3.5:9b", "http://127.0.0.1:9")
REQUEST = {
    "task": "Answer.",
    "data": {"q": 1},
    "output_schema": {"type": "object", "properties": {"a": {"type": "string"}}},
}
RESPONSES_OK = {
    "status": "completed",
    "model": "gpt-test",
    "output": [{"type": "message", "content": [{"type": "output_text", "text": '{"a": "x"}'}]}],
    "usage": {"input_tokens": 3, "output_tokens": 2},
}
# A policy fast enough for a test; the same numbers go to every side (`Cr` reads them in its job).
FAST = {"base_seconds": 0.001, "max_wait_seconds": 0.05, "max_total_seconds": 0.1}
# (status, headers) sequences and the waits every side must record for them.
SEQUENCES = {
    # the provider's headers, then the backoff (0.001 * 2**2); the call then answered
    "recovers": (
        [(429, {"retry-after-ms": "20"}), (429, {"retry-after": "0.01"}), (429, {}), (200, None)],
        [0.02, 0.01, 0.004],
        200,
    ),
    # six resends, then the route's failure
    "resends_spent": ([(429, {})] * 7, [0.001, 0.002, 0.004, 0.008, 0.016, 0.032], 429),
    # each wait capped at 0.05; a third would pass the call's 0.1 s
    "time_spent": ([(429, {"retry-after": "1"})] * 3, [0.05, 0.05], 429),
}


@pytest.fixture
def fast(monkeypatch):
    for name, value in FAST.items():
        monkeypatch.setitem(RATE_LIMIT_RETRY, name, value)
    monkeypatch.setenv(KEY_ENV, "test-key")


def _answers(sequence):
    queue = list(sequence)
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.content)
        status, headers = queue.pop(0)
        body = RESPONSES_OK if status == 200 else {"error": {"message": "rate limited"}}
        return httpx.Response(status, json=body, headers=headers or {})

    return handler, sent


def test_the_wait_follows_the_providers_header_then_the_backoff_within_the_caps():
    assert rate_limit_wait(0, {"retry-after-ms": "1500"}, 0) == 1.5
    assert rate_limit_wait(0, {"retry-after": "7"}, 0) == 7.0
    assert rate_limit_wait(0, {"retry-after-ms": "x", "retry-after": "3"}, 0) == 3.0
    assert rate_limit_wait(2, {"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}, 0) == 8.0
    assert rate_limit_wait(0, {"retry-after": "nan"}, 0) == 2.0
    assert rate_limit_wait(0, {"retry-after": "600"}, 0) == 60.0  # one wait's cap
    assert rate_limit_wait(4, {}, 0) == 32.0 and rate_limit_wait(5, {}, 0) == 60.0
    assert rate_limit_wait(6, {}, 0) is None  # six resends at most
    assert rate_limit_wait(0, {"retry-after": "60"}, 200) is None  # 240 s per call at most


@pytest.mark.parametrize("name", sorted(SEQUENCES))
def test_py_waits_out_a_429_on_a_hosted_rung(name, fast, monkeypatch):
    sequence, waits, final = SEQUENCES[name]
    handler, sent = _answers(sequence)
    router = CampaignRouter(H)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(router, "_http", lambda: client)
    if final == 200:
        out = asyncio.run(router.complete(REQUEST, max_output_tokens=64))
        assert out["output"] == {"a": "x"}
    else:
        with pytest.raises(BridgeError) as raised:
            asyncio.run(router.complete(REQUEST, max_output_tokens=64))
        assert raised.value.code == "model_unavailable"
        assert router.calls[-1]["status"] == 429
        rec = {"status": "failed", "meta": {"side": "Py"}, "model_calls": router.calls}
        assert campaign.promote_route_failure(rec)["status"] == "harness_error"
    assert router.calls[-1].get("rate_limit_waits", []) == waits
    assert len(sent) == len(waits) + 1 and len(set(sent)) == 1  # the same call, resent


@pytest.mark.parametrize("name", sorted(SEQUENCES))
def test_fw_waits_out_a_429_by_the_same_policy(name, fast):
    sequence, waits, final = SEQUENCES[name]
    handler, sent = _answers(sequence)
    log: list = []
    http = httpx.AsyncClient(
        transport=RateLimitRetryTransport(httpx.MockTransport(handler), waits=log)
    )
    client = openai.AsyncOpenAI(api_key="k", max_retries=0, http_client=http)

    async def call():
        return await client.responses.create(model="gpt-test", input="x")

    if final == 200:
        assert asyncio.run(call()).status == "completed"
    else:
        with pytest.raises(openai.RateLimitError) as raised:
            asyncio.run(call())
        assert agent._error_code(raised.value) in campaign.ROUTE_FAILURES
    assert log == waits and len(sent) == len(waits) + 1


def test_fw_on_a_hosted_rung_gets_the_retrying_transport_and_records_the_runs_waits(fast):
    model = agent.sdk_model(H)
    assert isinstance(model._client._client._transport, RateLimitRetryTransport)
    local = agent.sdk_model(L9)
    assert not isinstance(local._client._client._transport, RateLimitRetryTransport)
    waits = routes.rate_limit_log()  # what each `FW` driver does before its event loop

    async def wait_once():
        handler, _ = _answers([(429, {"retry-after-ms": "1"}), (200, None)])
        transport = RateLimitRetryTransport(httpx.MockTransport(handler))
        async with httpx.AsyncClient(transport=transport) as http:
            await http.post("https://api.openai.com/v1/responses", json={})

    asyncio.run(wait_once())  # the loop's task inherits the run's list
    assert waits == [0.001]

    class State:
        tool_calls, refused, unparsed, consent, memory_events, decoded, dials = ([],) * 7
        remote_calls = 0

    rec = record.from_fw(
        meta={},
        rung=H,
        port="webair",
        package=None,
        harness_error=None,
        turns=[],
        state=State(),
        model_calls=[],
        responder=[],
        origin_log=[],
        sink_log=[],
        seconds=0.0,
        limits={},
        offered=[],
        memory_grants={},
        rate_limit_waits=waits,
    )
    assert rec["rate_limit_waits"] == [0.001]


def test_only_a_hosted_rung_carries_the_policy_to_cr():
    assert cr_driver.route_of(H)["rate_limit"] == RATE_LIMIT_RETRY
    assert cr_driver.route_of(L9)["rate_limit"] is None


@pytest.mark.skipif(not cr_driver.TSC.is_file(), reason="needs `npm ci` in chrome-agent-browser")
@pytest.mark.parametrize("name", sorted(SEQUENCES))
def test_cr_waits_out_a_429_by_the_same_policy(name, fast):
    """The Node transport's `rateLimitWait` against the Python policy, through the driver's own
    `modelTransport` over canned answers (`probe_rate_limit`)."""
    sequence, waits, final = SEQUENCES[name]
    responses = [
        {
            "status": status,
            "headers": headers or {},
            "body": json.dumps(RESPONSES_OK if status == 200 else {"error": {}}),
        }
        for status, headers in sequence
    ]
    job = {
        "mapping": None,
        "route": cr_driver.route_of(H),
        "probe_rate_limit": {"responses": responses},
    }
    out = cr_driver.run_job(job, timeout=120)
    assert out["probe"] == "rate_limit" and out["status"] == final
    assert out["model_calls"][-1].get("rate_limit_waits", []) == waits
    assert out["sent"] == len(waits) + 1


# -- finding 4: `Py`'s route failures outside the old allowlist ---------------------------------
def _raise(exc):
    def handler(request):
        raise exc

    return handler


@pytest.mark.parametrize(
    ("answer", "exception"),
    [
        (lambda r: httpx.Response(200, text="<html>a tunnel's page</html>"), "JSONDecodeError"),
        (lambda r: httpx.Response(200, json=["not", "an", "object"]), "AttributeError"),
        (lambda r: httpx.Response(200, json={"done": True, "message": {}}), None),  # no text
        (_raise(httpx.ProxyError("proxy")), "ProxyError"),
        (_raise(httpx.LocalProtocolError("bad")), "LocalProtocolError"),
        (_raise(httpx.DecodingError("gzip")), "DecodingError"),
    ],
)
def test_finding4_a_broken_py_route_is_a_harness_error(answer, exception, monkeypatch):
    router = CampaignRouter(L9)
    client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    monkeypatch.setattr(router, "_http", lambda: client)
    with pytest.raises(BridgeError):
        asyncio.run(router.complete(REQUEST, max_output_tokens=64))
    entry = router.calls[-1]
    if exception is None:  # Ollama answered with no text: the model's failure, not the route's
        assert entry["outcome"] == "no_text" and "error" not in entry
        return
    assert entry["error"] == routes.ROUTE_FAILED and entry["exception"] == exception
    rec = {"status": "failed", "meta": {"side": "Py"}, "model_calls": router.calls, "turns": []}
    promoted = campaign.promote_route_failure(rec)
    assert promoted["status"] == "harness_error"
    assert promoted["harness_error"] == "route_unavailable: route_failed"


def test_finding4_a_read_timeout_stays_the_runs_failure(monkeypatch):
    router = CampaignRouter(L9)
    client = httpx.AsyncClient(transport=httpx.MockTransport(_raise(httpx.ReadTimeout("slow"))))
    monkeypatch.setattr(router, "_http", lambda: client)
    with pytest.raises(BridgeError):
        asyncio.run(router.complete(REQUEST, max_output_tokens=64))
    assert router.calls[-1]["error"] == "ReadTimeout"
    rec = {"status": "failed", "meta": {"side": "Py"}, "model_calls": router.calls, "turns": []}
    assert campaign.promote_route_failure(rec)["status"] == "failed"
