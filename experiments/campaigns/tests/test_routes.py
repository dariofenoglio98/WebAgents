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
