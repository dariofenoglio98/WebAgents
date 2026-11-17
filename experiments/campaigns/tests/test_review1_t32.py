"""T32 review 1's findings 4, 5, 13 and 14: D-361's classification through the drivers' own paths,
the manifest written atomically, TS-L never beside the other task sets on a local rung."""

from __future__ import annotations

import json

import httpx
import openai
import pytest
from campaigns.baseline import agent
from campaigns.driver import campaign
from campaigns.driver.responder import Responder
from campaigns.driver.routes import Rung
from campaigns.origin.stack import CampaignStack

L9 = Rung("L9", "ollama", "qwen3.5:9b", "http://127.0.0.1:11434")


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    with CampaignStack(tmp_path_factory.mktemp("stack")) as running:
        yield running


def _timeout(*_args, **_kwargs):
    raise openai.APITimeoutError(
        request=httpx.Request("POST", "http://127.0.0.1:11434/v1/chat/completions")
    )


def test_finding4_an_fw_model_call_timeout_is_the_runs_failure_not_a_harness_error(
    stack, tmp_path, monkeypatch
):
    """`openai.APITimeoutError` is an `APIConnectionError`, not a `TimeoutError`: the old
    `_error_code` returned its class name, outside `RUN_OUTCOMES`, and `run_webair` wrote a harness
    error, while `Py`'s `ReadTimeout` stays a run failure (D-361). Through the driver's own
    exception path, then the campaign's promotion."""
    assert issubclass(openai.APITimeoutError, openai.APIConnectionError)
    monkeypatch.setattr(agent.Runner, "run", _timeout)
    monkeypatch.setattr(agent, "ollama_context", lambda rung: None)  # no server in the tests
    rec = agent.run_webair(
        turns=["Find me the cheapest flight from Boston to London on 4 October 2027."],
        rung=L9,
        run_dir=tmp_path / "run",
        stack=stack,
        responder=Responder("R-deny"),
        fixture_key=None,
        meta={"run_id": "fw-timeout", "side": "FW", "task_set": "TS-W"},
    )
    assert rec["harness_error"] is None
    assert rec["turns"][0]["error_code"] == "model_call_timeout"
    promoted = campaign.promote_route_failure(json.loads(json.dumps(rec)))
    assert promoted["status"] != "harness_error"
    assert promoted["status"] == rec["status"] == "failed"


def test_finding4_every_fw_port_maps_the_timeout_alike():
    for exc in (openai.APITimeoutError(request=httpx.Request("POST", "http://x/v1")),):
        assert agent._error_code(exc) == "model_call_timeout"
        assert agent._error_code(exc) in agent.RUN_OUTCOMES
    connection = openai.APIConnectionError(request=httpx.Request("POST", "http://x/v1"))
    assert agent._error_code(connection) == "APIConnectionError"
    assert "APIConnectionError" in campaign.ROUTE_FAILURES


# -- finding 5: `Cr`'s route failures, from records the Node driver writes ------------------------
class _FakeOllama:
    """A loopback Ollama that lists one model and fails every chat as `mode` says: `drop` closes
    the connection without an answer, `500` and `429` answer that status."""

    def __init__(self, mode: str):
        import http.server
        import socketserver
        import threading

        outer = self
        self.mode = mode
        self.chats = 0

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, status, value):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/api/tags":
                    models = [{"name": "fake-model", "model": "fake-model"}]
                    return self._json(200, {"models": models})
                return self._json(404, {"error": "not found"})

            def do_POST(self):
                length = int(self.headers.get("content-length") or 0)
                self.rfile.read(length)
                if self.path == "/api/show":
                    return self._json(
                        200,
                        {
                            "model_info": {"fake.context_length": 32768},
                            "capabilities": ["completion", "thinking"],
                        },
                    )
                if self.path == "/api/chat":
                    outer.chats += 1
                    if outer.mode == "drop":
                        self.close_connection = True
                        self.connection.shutdown(2)
                        return None
                    status = int(outer.mode)
                    return self._json(status, {"error": f"fake {status}"})
                return self._json(404, {"error": "not found"})

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


@pytest.mark.skipif(
    not __import__("campaigns.driver.cr_driver", fromlist=["TSC"]).TSC.is_file(),
    reason="needs `npm ci` in chrome-agent-browser",
)
@pytest.mark.parametrize("mode", ["drop", "500", "429"])
def test_finding5_a_cr_route_that_does_not_answer_is_a_harness_error_as_on_py(
    mode, stack, tmp_path
):
    """D-361 rested on the turn code `model_unavailable`, which a WebAir conversation on the Chrome
    core never writes: it ends the turn `model_error` and names the adapter's code in the audit."""
    from campaigns.driver import cr_driver

    with _FakeOllama(mode) as fake:
        rung = Rung("fake", "ollama", "fake-model", fake.url, think=False)
        rec = cr_driver.run_webair(
            turns=["Find me the cheapest flight from Boston to London on 4 October 2027."],
            rung=rung,
            run_dir=tmp_path / "run",
            stack=stack,
            responder=Responder("R-deny"),
            fixture_key=None,
            meta={"run_id": f"cr-{mode}", "side": "Cr", "task_set": "TS-W"},
        )
    expected = {
        "drop": "model_transport_error",
        "500": "model_provider_error",
        "429": "model_rate_limited",
    }[mode]
    # What the core writes: the turn's generic code, the adapter's code in the audit only.
    assert rec["turns"][0]["error_code"] == "model_error" and rec["status"] == "failed"
    reasons = [e.get("reason") for e in rec["audit"] if e["action"] == "model.failed"]
    assert reasons == [expected]
    promoted = campaign.promote_route_failure(json.loads(json.dumps(rec)))
    assert promoted["status"] == "harness_error"
    assert promoted["harness_error"] == f"route_unavailable: {expected}"
    assert fake.chats >= 1


def test_finding5_a_cr_model_call_timeout_stays_the_runs_failure():
    rec = {
        "status": "failed",
        "meta": {"side": "Cr"},
        "turns": [{"turn": 1, "status": "failed", "error_code": "model_error"}],
        "audit": [{"action": "model.failed", "reason": "model_call_timeout"}],
        "model_calls": [{"url": "http://127.0.0.1:11434/api/chat"}],
    }
    assert campaign.promote_route_failure(rec)["status"] == "failed"
    rec["meta"]["side"] = "Py"  # the audit rule is the Chrome core's; `Py` records its calls' codes
    rec["audit"][0]["reason"] = "model_transport_error"
    assert campaign.promote_route_failure(rec)["status"] == "failed"


# -- nits 13 and 14 -------------------------------------------------------------------------------
def test_nit14_ts_l_never_shares_an_invocation_with_the_other_task_sets_on_a_local_rung(tmp_path):
    base = ["--preset", "smoke", "--rungs", "L30", "--sides", "Py", "--dry-run"]
    with pytest.raises(SystemExit):
        campaign.main([*base, "--out", str(tmp_path / "mixed")])
    assert not (tmp_path / "mixed").exists()
    assert campaign.main([*base, "--task-sets", "TS-L", "--out", str(tmp_path / "tsl")]) == 0
    assert campaign.main([*base, "--task-sets", "TS-W", "--out", str(tmp_path / "tsw")]) == 0
    assert not campaign.mixes_contexts(
        campaign.units_for("smoke", ["H"], ["Py"], campaign.catalog.load()), "http://x"
    )


def test_nit13_the_manifest_is_written_whole(tmp_path):
    campaign._write_atomic(tmp_path / "manifest.json", "{}\n")
    assert (tmp_path / "manifest.json").read_text() == "{}\n"
    assert [p.name for p in tmp_path.iterdir()] == ["manifest.json"]
