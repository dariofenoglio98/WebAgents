"""T32 review 3's carry-overs (D-427), each with a test that fails on `main` as merged 5bee92b."""

from __future__ import annotations

import json

import pytest
from campaigns.driver import campaign, cr_driver
from campaigns.driver.routes import Rung

L30 = Rung("L30", "ollama", "qwen3:30b", "http://127.0.0.1:11434")


# -- carry-over 1: a throttled call that outlasts its step is a harness error on every side --------
def _rec(side, *, calls=(), waits=(), code="model_call_timeout", status="failed"):
    return {
        "meta": {"side": side},
        "status": status,
        "harness_error": None,
        "turns": [{"turn": 1, "status": "failed", "error_code": code}],
        "model_calls": list(calls),
        "rate_limit_waits": list(waits),
        "audit": [],
    }


@pytest.mark.parametrize("side", ["Py", "Cr"])
def test_an_unanswered_call_that_waited_on_429s_is_a_harness_error(side):
    """`Py`: a node timeout cancels the call while it waits; its entry has the waits, no answer."""
    rec = _rec(side, calls=[{"at": 1.0, "rate_limit_waits": [2, 4, 8]}], code=None)
    out = campaign.promote_throttled_timeout(rec)
    assert out["status"] == "harness_error"
    assert out["harness_error"].startswith("rate_limited_timeout: 14")


def test_fw_whose_run_waited_and_timed_out_is_a_harness_error():
    out = campaign.promote_throttled_timeout(_rec("FW-none", waits=[2, 4]))
    assert out["status"] == "harness_error"


def test_waits_on_answered_calls_or_a_completed_run_change_nothing():
    answered = {"rate_limit_waits": [2], "usage": {"input_tokens": 1}, "outcome": "ok"}
    rec = _rec("Py", calls=[answered], code="model_output_not_conforming")
    assert campaign.promote_throttled_timeout(rec)["status"] == "failed"
    done = _rec("FW", waits=[2], status="completed", code=None)
    assert campaign.promote_throttled_timeout(done)["status"] == "completed"
    plain_timeout = _rec("FW", waits=[])
    assert campaign.promote_throttled_timeout(plain_timeout)["status"] == "failed"


def test_run_unit_applies_the_promotion():
    import inspect

    source = inspect.getsource(campaign.run_unit)
    assert (
        source.index("promote_route_failure(rec)")
        < source.index("promote_throttled_timeout(rec)")
        < source.index("record.write(run_dir, rec)")
    )


# -- carry-over 2: `Cr`'s model seam keyed by the request ----------------------------------------
@pytest.mark.skipif(not cr_driver.TSC.is_file(), reason="needs `npm ci` in chrome-agent-browser")
def test_cr_writes_each_answer_on_its_own_request_when_calls_overlap():
    """Three requests observed in order and in flight at once, answered last first (Literature
    Review's maps): each entry gets its own status, usage and text. On `main` every answer was
    written on the last entry pushed, so two entries had none."""
    bodies = [json.dumps({"n": i}) for i in range(3)]
    answers = [
        {
            "delay_ms": 300 - 100 * i,
            "body": json.dumps(
                {
                    "message": {"content": f"answer {i}"},
                    "prompt_eval_count": 10 + i,
                    "eval_count": i,
                }
            ),
        }
        for i in range(3)
    ]
    job = {
        "mapping": None,
        "route": cr_driver.route_of(L30),
        "probe_concurrent": {"bodies": bodies, "answers": answers},
    }
    out = cr_driver.run_job(job, timeout=120)
    assert out["probe"] == "concurrent"
    calls = out["model_calls"]
    assert [c["text"] for c in calls] == ["answer 0", "answer 1", "answer 2"]
    assert [c["usage"]["input_tokens"] for c in calls] == [10, 11, 12]
    assert all(c["status"] == 200 for c in calls)


# -- carry-over 3: a hosted campaign whose route is gone stops; a final 429 is never resent -------
H = Rung("H", "openai", "gpt-5.6-luna", "https://api.openai.com", temperature=None)


def test_a_final_429_is_never_resent_by_the_policy():
    from campaigns.driver.routes import rate_limit_final, rate_limit_wait

    quota = json.dumps({"error": {"code": "insufficient_quota", "type": "insufficient_quota"}})
    assert rate_limit_final({}, quota) == "insufficient_quota"
    assert rate_limit_final({"x-should-retry": "false"}, "{}") == "x-should-retry: false"
    assert rate_limit_final({"x-should-retry": "true"}, "{}") is None
    assert rate_limit_wait(0, {}, 0.0, quota) is None
    assert rate_limit_wait(0, {"x-should-retry": "false"}, 0.0, "") is None
    assert rate_limit_wait(0, {}, 0.0, json.dumps({"error": {"code": "rate_limit_exceeded"}})) == 2


def test_fws_transport_does_not_resend_a_final_429():
    import asyncio

    import httpx
    from campaigns.driver.routes import RateLimitRetryTransport

    sent = []

    class Inner(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            sent.append(request)
            body = {"error": {"code": "insufficient_quota"}}
            return httpx.Response(429, json=body)

    waits: list = []
    transport = RateLimitRetryTransport(Inner(), waits=waits, sleep=lambda s: asyncio.sleep(0))
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    response = asyncio.run(transport.handle_async_request(request))
    assert response.status_code == 429 and len(sent) == 1 and waits == []


@pytest.mark.skipif(not cr_driver.TSC.is_file(), reason="needs `npm ci` in chrome-agent-browser")
def test_cr_does_not_resend_a_final_429():
    quota = json.dumps({"error": {"code": "insufficient_quota"}})
    job = {
        "mapping": None,
        "route": cr_driver.route_of(H),
        "probe_rate_limit": {"responses": [{"status": 429, "headers": {}, "body": quota}] * 3},
    }
    out = cr_driver.run_job(job, timeout=120)
    assert out["sent"] == 1 and out["status"] == 429
    assert out["model_calls"][-1]["rate_limit_final"] == "insufficient_quota"


def test_the_route_watch_stops_a_hosted_shard_after_three_consecutive_route_failures():
    watch = campaign.RouteWatch()
    assert campaign.is_route_failure("route_unavailable: model_unavailable")
    assert campaign.is_route_failure("RateLimitError: Error code: 429")
    assert not campaign.is_route_failure("dns_lookup_failed: example")
    assert not campaign.is_route_failure(None)
    assert not watch.observe(H, "route_unavailable: x")
    assert not watch.observe(H, None)  # an answered unit resets the count
    assert not watch.observe(H, "route_unavailable: x")
    assert not watch.observe(H, "APIConnectionError: Connection error.")
    assert watch.observe(H, "rate_limited_timeout: 240 s")
    assert not campaign.RouteWatch().observe(L30, "route_unavailable: x")  # local: never


def test_main_stops_the_shard_and_leaves_the_rest_unrecorded(tmp_path, monkeypatch):
    calls = []

    def fake_run_unit(unit, *, out, **kw):
        calls.append(unit["id"])
        run_dir = out / "runs" / unit["id"]
        run_dir.mkdir(parents=True)
        meta = {
            "run_id": unit["id"],
            "side": unit["side"],
            "task_set": unit["task_set"],
            "task_id": unit["task_id"],
            "phrasing": unit["phrasing"],
            "arm": campaign.arm_id(unit["arm"]),
            "family": None,
        }
        rec = {
            "meta": meta,
            "rung": {"name": unit["rung"]},
            "status": "harness_error",
            "harness_error": "route_unavailable: x",
        }
        (run_dir / "run.json").write_text(json.dumps(rec))
        outcome = {"harness_error": True, "utility": None, "boundaries": [], "exposed": None}
        (run_dir / "outcome.json").write_text(json.dumps(outcome))
        return {"harness_error": True, "utility": None, "boundaries": [], "exposed": None}

    monkeypatch.setattr(campaign, "run_unit", fake_run_unit)
    monkeypatch.setattr(campaign, "route_ready", lambda rung, **kw: True)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    code = campaign.main(
        [
            "--preset",
            "smoke",
            "--rungs",
            "H",
            "--sides",
            "FW",
            "--task-sets",
            "TS-W",
            "--out",
            str(tmp_path / "out"),
        ]
    )
    assert code == 2 and len(calls) == 3
    summary = json.loads((tmp_path / "out" / "summary.json").read_text())
    assert summary["complete"] is False and len(summary["missing"]) > 0


# -- nits (c), (d), (f), (g) ---------------------------------------------------------------------
def test_nit_c_a_wait_with_no_runs_log_fails_loudly():
    import asyncio
    import contextvars

    import httpx
    from campaigns.driver import routes

    class Inner(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            return httpx.Response(429, headers={"retry-after": "0"})

    def run():
        routes.RATE_LIMIT_WAITS.set(None)
        transport = routes.RateLimitRetryTransport(Inner(), sleep=lambda s: asyncio.sleep(0))
        request = httpx.Request("POST", "https://api.openai.com/v1/responses")
        return asyncio.run(transport.handle_async_request(request))

    with pytest.raises(RuntimeError, match="rate_limit_log"):
        contextvars.Context().run(run)


def test_nit_d_the_summary_lock_is_a_file_opened_for_writing(tmp_path, monkeypatch):
    import fcntl
    import os

    out = tmp_path / "out"
    (out / "runs").mkdir(parents=True)
    (out / "progress.jsonl").write_text("")
    locked = []
    monkeypatch.setattr(fcntl, "flock", lambda fd, op: locked.append(os.fstat(fd).st_ino))
    campaign.write_summary(out, [])
    assert locked == [(out / "progress.jsonl").stat().st_ino]  # a file, opened for writing
    assert (out / "summary.json").is_file()

    def refuse(fd, op):
        raise OSError(37, "no locks available")

    monkeypatch.setattr(fcntl, "flock", refuse)
    (out / "summary.json").unlink()
    campaign.write_summary(out, [])  # an NFS without locks: written unlocked
    assert (out / "summary.json").is_file()


def test_nit_f_fws_hosted_transport_reads_the_proxy_environment(monkeypatch):
    from campaigns.driver import routes

    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setenv("https_proxy", "http://proxy.invalid:3128")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    inner = routes.RateLimitRetryTransport().inner
    assert inner._pool._proxy_url is not None  # httpcore's proxy pool
    monkeypatch.setenv("NO_PROXY", "api.openai.com")
    monkeypatch.setenv("no_proxy", "api.openai.com")
    assert not hasattr(routes.RateLimitRetryTransport().inner._pool, "_proxy_url")


@pytest.mark.skipif(not cr_driver.TSC.is_file(), reason="needs `npm ci` in chrome-agent-browser")
def test_nit_g_retry_after_ms_wins_over_retry_after_on_cr_as_on_py():
    from campaigns.driver.routes import rate_limit_wait

    headers = {"retry-after-ms": "1500", "retry-after": "7"}
    assert rate_limit_wait(0, headers, 0.0) == 1.5
    ok = json.dumps({"output": [], "usage": {}})
    job = {
        "mapping": None,
        "route": {**cr_driver.route_of(H), "rate_limit": {**cr_driver.route_of(H)["rate_limit"]}},
        "probe_rate_limit": {
            "responses": [
                {"status": 429, "headers": headers, "body": "{}"},
                {"status": 200, "headers": {}, "body": ok},
            ]
        },
    }
    out = cr_driver.run_job(job, timeout=120)
    assert out["model_calls"][-1]["rate_limit_waits"] == [1.5]
