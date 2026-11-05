"""The campaign route (driver/routes.py): a route failure is the bridge's `model_unavailable`."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from agentpkg.hostbridge.errors import BridgeError
from campaigns.driver.routes import CampaignRouter, Rung

REQUEST = {
    "task": "Answer.",
    "data": {"q": 1},
    "output_schema": {"type": "object", "properties": {"a": {"type": "string"}}},
}


def test_a_200_that_is_not_json_is_model_unavailable(monkeypatch):
    """Review 1, nit 16: never a raw `ValueError` (a harness error), and the seam entry closed."""
    router = CampaignRouter(Rung("L9", "ollama", "qwen3.5:9b", "http://127.0.0.1:9"))
    page = httpx.Response(200, text="<html>a tunnel's login page</html>")
    transport = httpx.MockTransport(lambda request: page)
    monkeypatch.setattr(router, "_http", lambda: httpx.AsyncClient(transport=transport))
    with pytest.raises(BridgeError) as raised:
        asyncio.run(router.complete(REQUEST, max_output_tokens=64))
    assert raised.value.code == "model_unavailable"
    assert router.calls[-1]["error"] == "JSONDecodeError"


def test_aclose_closes_the_loops_client():
    """T31b review 1, finding 3: the per-loop client is closed by `aclose`, inside its loop."""
    router = CampaignRouter(Rung("L9", "ollama", "qwen3.5:9b", "http://127.0.0.1:9"))

    async def use():
        client = router._http()
        return client, await router.closing(asyncio.sleep(0, "done"))

    client, value = asyncio.run(use())
    assert value == "done" and client.is_closed and router._client is None


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    from campaigns.origin.stack import CampaignStack

    with CampaignStack(tmp_path_factory.mktemp("stack")) as running:
        yield running


@pytest.mark.parametrize("kind", ["run", "conversation"])
def test_a_py_run_or_conversation_leaves_its_client_closed(kind, stack, tmp_path, monkeypatch):
    """Each `Py` run (`_run_workflow`) and conversation closes the client its model calls opened,
    whether the run fails or not (here the route is dead: the first call fails)."""
    from campaigns.driver import py_driver
    from campaigns.driver.responder import Responder

    opened: list[httpx.AsyncClient] = []

    class Tracking(CampaignRouter):
        def _http(self):
            client = super()._http()
            if client not in opened:
                opened.append(client)
            return client

    monkeypatch.setattr(py_driver, "CampaignRouter", Tracking)
    dead = Rung("dead", "ollama", "dead-model", "http://127.0.0.1:9")
    meta = {"side": "Py"}
    if kind == "run":
        py_driver.run_travel_network(
            text="Plan a trip from Boston to Zurich, 9 to 12 March 2027.",
            rung=dead,
            run_dir=tmp_path / "run",
            stack=stack,
            fixture_key=None,
            meta=meta,
        )
    else:
        py_driver.run_webair(
            turns=["Find me a flight from Boston to Zurich on 9 March 2027."],
            rung=dead,
            run_dir=tmp_path / "run",
            stack=stack,
            responder=Responder("R-deny"),
            fixture_key=None,
            meta=meta,
        )
    assert opened, "the dead route was called"
    assert all(client.is_closed for client in opened)
