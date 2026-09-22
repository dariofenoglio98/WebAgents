"""Acceptance check for the agent browser control plane. No network, no execution.

Runs the full operator sequence against a real loopback service: health, open
both shipped artifacts, observe unknown trust, pin the development key, inspect
permissions, authorize, and prove a denied required permission blocks the run.
A mock origin exercises the URL path without contacting anything.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agentpkg.browser import (
    BrowserService,
    ControlPlane,
    ControlPlaneConfig,
    ControlPlaneError,
)
from agentpkg.browser.fetch import FetchLimits, fetch_https_package
from agentpkg.netaddr import public_address_reason
from agentpkg.package import write_new

ROOT = Path(__file__).resolve().parents[1]
DEV_KEY = ROOT / "examples/keys/workflow-publisher.pub.pem"
PACKAGES = ("literature-review", "meeting-agenda")
BLOCKED_DESTINATIONS = (
    "127.0.0.1",
    "::1",
    "10.0.0.5",
    "172.16.0.5",
    "192.168.1.5",
    "169.254.169.254",
    "100.100.100.200",
    "224.0.0.1",
    "240.0.0.1",
    "0.0.0.0",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
)
REFUSED_URLS = (
    "http://packages.example/a.agent.pkg",
    "file:///etc/passwd",
    "https://user:secret@packages.example/a.agent.pkg",
    "https://packages.example:8443/a.agent.pkg",
)


class _Client:
    def __init__(self, service: BrowserService):
        self.base = service.url
        self.token = service.token

    def __call__(self, method, path, body=None, *, token=True):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if token:
            request.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())


def _mock_origin(payload: bytes):
    """A local origin used only through the connector seam; never a real fetch."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):  # stdlib handler contract
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _url_policy(payload: bytes) -> dict:
    import http.client

    refused = {}
    for url in REFUSED_URLS:
        try:
            fetch_https_package(
                url, limits=FetchLimits(), resolver=None, connector=None
            )
        except ControlPlaneError as exc:
            refused[url] = exc.code
        else:
            raise AssertionError(f"URL should have been refused: {url}")
    destinations = {}
    for address in BLOCKED_DESTINATIONS:
        reason = public_address_reason(address)
        assert reason, f"{address} must be refused"
        destinations[address] = reason
    assert public_address_reason("93.184.216.34") is None

    server = _mock_origin(payload)
    port = server.server_address[1]
    try:
        data = fetch_https_package(
            "https://packages.example/hosted.agent.pkg",
            limits=FetchLimits(max_bytes=4 * 1024 * 1024, timeout_seconds=10),
            resolver=lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))],
            connector=lambda host, address, timeout: http.client.HTTPConnection(
                "127.0.0.1", port, timeout=timeout
            ),
        )
    finally:
        server.shutdown()
        server.server_close()
    assert data == payload, "Mock origin download mismatch"
    return {
        "refused_urls": refused,
        "refused_destinations": destinations,
        "public_destination_allowed": True,
        "mock_origin_download_bytes": len(data),
    }


def verify_all() -> dict:
    report: dict = {"passed": True, "service": {}, "packages": {}}
    with tempfile.TemporaryDirectory(prefix="agentpkg-browser-verify-") as scratch:
        root = Path(scratch).resolve()
        config = ControlPlaneConfig(
            cache_dir=root / "cache", trust_store_path=root / "trust.json"
        )
        service = BrowserService(ControlPlane(config), host="127.0.0.1", port=0)
        service.start_background()
        call = _Client(service)
        try:
            status, health = call("GET", "/v0/health", token=False)
            assert status == 200 and health["execution"] == "disabled"
            assert call("GET", "/v0/status", token=False)[0] == 401
            assert call("GET", "/v0/packages")[0] == 200
            report["service"] = {
                "url": service.url,
                "loopback_only": service.socket.getsockname()[0] == "127.0.0.1",
                "health": health,
                "unauthenticated_access_refused": True,
            }

            untrusted = {}
            for name in PACKAGES:
                code, summary = call(
                    "POST",
                    "/v0/packages/open-file",
                    {"path": str(ROOT / "dist" / f"{name}.agent.pkg")},
                )
                assert code == 201
                assert summary["publisher"]["signature_status"] == "valid"
                assert summary["publisher"]["trust_status"] == "unknown"
                untrusted[name] = summary["session"]["id"]

            code, pinned = call(
                "POST",
                "/v0/trust",
                {
                    "public_key_pem": DEV_KEY.read_text(),
                    "display_name": "WebAgents development key",
                    "publisher_id": "webagents-research",
                    "package_id_prefix": "org.webagents.",
                },
            )
            assert code == 201
            trust_state = pinned["trust_store"]

            for name in PACKAGES:
                path = str(ROOT / "dist" / f"{name}.agent.pkg")
                summary = call("POST", "/v0/packages/open-file", {"path": path})[1]
                session_id = summary["session"]["id"]
                digest = summary["package"]["digest"]
                assert summary["publisher"]["trust_status"] == "trusted"

                request = call("GET", f"/v0/packages/{session_id}/permissions")[1]
                assert {item["decision"] for item in request["permissions"]} == {"deny"}
                required = sorted(
                    item["id"] for item in request["permissions"] if item["required"]
                )
                granted = {item["id"]: "session" for item in request["permissions"]}
                receipt = call(
                    "POST",
                    f"/v0/packages/{session_id}/authorize",
                    {"package_digest": digest, "decisions": granted},
                )[1]
                assert receipt["runnable"] is True and receipt["blocking_reasons"] == []

                partial = {**granted, required[0]: "deny"}
                denied = call(
                    "POST",
                    f"/v0/packages/{session_id}/authorize",
                    {"package_digest": digest, "decisions": partial},
                )[1]
                assert denied["runnable"] is False
                assert [item["subject"] for item in denied["blocking_reasons"]] == [
                    required[0]
                ]

                other = next(n for n in PACKAGES if n != name)
                foreign = call("GET", f"/v0/packages/{untrusted[other]}")[1]["package"][
                    "digest"
                ]
                mismatch = call(
                    "POST",
                    f"/v0/packages/{session_id}/authorize",
                    {"package_digest": foreign, "decisions": {}},
                )
                assert mismatch[0] == 409

                report["packages"][name] = {
                    "passed": True,
                    "digest": digest,
                    "archive_sha256": summary["snapshot"]["archive_sha256"],
                    "layers": summary["validation"],
                    "signature_status": summary["publisher"]["signature_status"],
                    "trust_before_pin": "unknown",
                    "trust_after_pin": summary["publisher"]["trust_status"],
                    "capabilities": summary["capabilities"],
                    "skills": len(summary["skills"]),
                    "tools": [tool["id"] for tool in summary["tools"]],
                    "workers": len(summary["workers"]),
                    "workflow_nodes": summary["workflow"].get("node_count"),
                    "permissions_default_deny": True,
                    "required_permissions": required,
                    "runnable_when_granted": True,
                    "runnable_when_required_denied": False,
                    "foreign_digest_refused": True,
                    "execution_performed": receipt["execution"]["performed"],
                }

            sessions = call("GET", "/v0/packages")[1]
            assert len(sessions["sessions"]) == 4
            for session in sessions["sessions"]:
                assert call("DELETE", f"/v0/packages/{session['session_id']}")[0] == 200
            assert call("GET", "/v0/packages")[1]["sessions"] == []
            assert not [
                p for p in (root / "cache").iterdir() if p.name.startswith("session-")
            ]

            payload = (ROOT / "dist/meeting-agenda.agent.pkg").read_bytes()
            report["url_policy"] = _url_policy(payload)
            report["trust_store"] = trust_state
            report["snapshots_removed_on_close"] = True
        finally:
            service.shutdown()
            service.server_close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report", help="Optional new JSON report file; refuses overwrites"
    )
    args = parser.parse_args()
    report = verify_all()
    data = json.dumps(report, indent=2) + "\n"
    if args.report:
        write_new(args.report, data.encode())
    print(data, end="")


if __name__ == "__main__":
    main()
