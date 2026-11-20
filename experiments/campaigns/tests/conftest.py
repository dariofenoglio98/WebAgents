"""The campaign infrastructure's tests (T31): offline, credential-free, no model.

`experiments/` goes first on sys.path so that `campaigns.*` imports; WebAir's origin is imported
from `demo/webair/` (its requirements are installed beside agentpkg's,
`experiments/campaigns/requirements.txt`).
"""

from __future__ import annotations

import sys
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[2]
ROOT = EXPERIMENTS.parent
for path in (EXPERIMENTS, ROOT / "demo" / "webair"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import pytest  # noqa: E402

OLLAMA_PORT = 11434


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "route_probe: the test exercises `campaign.route_ready` itself (unguarded)"
    )


@pytest.fixture(autouse=True)
def _no_model_service(request, monkeypatch):
    """The tests see what CI sees: no model service (T32 review 2, finding 1). The Mac runs
    Ollama on 127.0.0.1:11434, which once let a test pass that would stall 30 minutes and fail on
    CI. Here every `httpx.get` (the drivers' Ollama probes) and every connection to port 11434 is
    refused, as on a machine with no server; and `campaign.route_ready` reached without a stub
    fails the test at once instead of polling (a test of the probe itself carries
    `@pytest.mark.route_probe`)."""
    import socket

    import httpx

    def refused(url, *args, **kwargs):
        raise httpx.ConnectError(f"no model service in the tests: {url}")

    monkeypatch.setattr(httpx, "get", refused)
    connect = socket.socket.connect

    def guarded(sock, address):
        if isinstance(address, tuple) and len(address) >= 2 and address[1] == OLLAMA_PORT:
            raise ConnectionRefusedError(f"no model service in the tests: {address}")
        return connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", guarded)
    if request.node.get_closest_marker("route_probe") is None:
        from campaigns.driver import campaign

        def unstubbed(rung, **kwargs):
            pytest.fail(f"campaign.route_ready reached unstubbed for {rung.name}: stub it")

        monkeypatch.setattr(campaign, "route_ready", unstubbed)


class FakeStack:
    """A stack that is never dialed: its hosts are a closed port, its CA a missing file. For a test
    whose run fails before any tool call (T31b review 2, nit 7)."""

    from campaigns.origin import tls as _tls

    hosts = {_tls.RESOLVER_HOST: ("127.0.0.1", 9), _tls.WEBAIR_HOST: ("127.0.0.1", 9)}
    ca = "/nonexistent-ca.pem"

    def __init__(self):
        from types import SimpleNamespace

        self.origin_log: list = []
        self.resolver_log: list = []
        self.sink = SimpleNamespace(log=[])
