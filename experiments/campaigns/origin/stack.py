"""The campaign stack (PROTOCOL.md §2.1): WebAir's origin in its injection mode, the logging sink
and, when asked, the Citation Resolver in the same mode, each on `127.0.0.1` over TLS under the
campaign CA.

    with CampaignStack(run_dir) as stack:
        stack.hosts    # {public hostname: ("127.0.0.1", port)}: the host mapping the drivers dial
        stack.ca       # the campaign CA's PEM path: only the drivers trust it
        stack.origin_log, stack.sink.log

One stack serves every run of a campaign slot; the per-run fixture key travels in the request
header, so runs never share an insertion.
"""

from __future__ import annotations

import socket
import sys
import threading
import time
from pathlib import Path

import uvicorn

from campaigns.origin import catalog, tls
from campaigns.origin.sink import Sink

ROOT = Path(__file__).resolve().parents[3]
for path in (ROOT / "demo" / "webair",):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from origin.app import create_app  # noqa: E402
from origin.injection import campaign_app  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _Server:
    def __init__(self, app, port: int, certs: dict[str, Path]):
        self.port = port
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            ssl_certfile=str(certs["leaf"]),
            ssl_keyfile=str(certs["key"]),
            log_level="warning",
            lifespan="off",
            access_log=False,
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> None:
        self.thread.start()
        deadline = time.monotonic() + 20
        while not self.server.started:
            if time.monotonic() > deadline or not self.thread.is_alive():
                raise RuntimeError(f"campaign server on {self.port} did not start")
            time.sleep(0.02)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


class CampaignStack:
    def __init__(self, run_dir: Path, *, payloads: dict | None = None, resolver: bool = False):
        self.run_dir = Path(run_dir)
        self.payloads = catalog.load() if payloads is None else payloads
        self.with_resolver = resolver
        self.servers: list[_Server] = []
        self.hosts: dict[str, tuple[str, int]] = {}
        self.origin_log: list[dict] = []
        self.resolver_log: list[dict] = []
        self.sink = Sink()

    def __enter__(self) -> CampaignStack:
        certs = tls.make(self.run_dir / "campaign-ca")
        self.ca = certs["ca"]
        origin, self.origin_log = campaign_app(create_app(), self.payloads)
        services = [(tls.WEBAIR_HOST, origin), (tls.SINK_HOST, self.sink)]
        if self.with_resolver:
            services.append((tls.RESOLVER_HOST, self._resolver()))
        try:
            for host, app in services:
                server = _Server(app, _free_port(), certs)
                server.start()
                self.servers.append(server)
                self.hosts[host] = ("127.0.0.1", server.port)
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def _resolver(self):
        resolver_root = ROOT / "citation-resolver"
        if str(resolver_root) not in sys.path:
            sys.path.insert(0, str(resolver_root))
        from app.main import create_app as create_resolver  # noqa: PLC0415

        wrapped, self.resolver_log = campaign_app(create_resolver(), self.payloads)
        return wrapped

    def __exit__(self, *exc) -> None:
        for server in reversed(self.servers):
            server.stop()
        self.servers.clear()
