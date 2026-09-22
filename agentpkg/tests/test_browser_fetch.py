"""URL opening must never become an SSRF primitive.

Every case below drives the production policy function `fetch_https_package`.
Only the resolver and connector mechanics are stubbed, so the syntax gate, the
address classification and the transfer limits under test are the same code a
real download runs. No test contacts a network.
"""

from __future__ import annotations

import http.client
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.fetch import (
    FetchLimits,
    download_to_file,
    fetch_https_package,
    resolve_public_addresses,
    validate_package_url,
)
from agentpkg.netaddr import public_address_reason
from agentpkg.package import build_package

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = "93.184.216.34"
LIMITS = FetchLimits(max_bytes=64 * 1024, timeout_seconds=5)


def resolver_for(*addresses):
    def resolve(host, port, **kwargs):
        return [(2, 1, 6, "", (address, port)) for address in addresses]

    return resolve


def never_connect(*args, **kwargs):
    raise AssertionError("a refused destination must never reach the connector")


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/a.agent.pkg",
        "file:///etc/passwd",
        "ftp://example.com/a.agent.pkg",
        "gopher://example.com/a",
        "/etc/passwd",
        "https://user:secret@example.com/a.agent.pkg",
        "https://example.com:8443/a.agent.pkg",
        "https://example.com/a.agent.pkg#fragment",
        "https://example.com/a\n.agent.pkg",
        "https:///a.agent.pkg",
        "https://" + "a" * 300 + ".com/a.agent.pkg",
    ],
)
def test_unsafe_url_syntax_is_refused(url):
    with pytest.raises(ControlPlaneError) as error:
        validate_package_url(url)
    assert error.value.code == "url_rejected"


def test_accepted_url_syntax_keeps_the_query_string():
    host, target = validate_package_url("https://packages.example/a.agent.pkg?v=2")
    assert host == "packages.example"
    assert target == "/a.agent.pkg?v=2"


@pytest.mark.parametrize(
    "address,reason",
    [
        ("127.0.0.1", "loopback_address"),
        ("127.0.0.53", "loopback_address"),
        ("::1", "loopback_address"),
        ("10.1.2.3", "private_address"),
        ("172.16.5.4", "private_address"),
        ("192.168.0.9", "private_address"),
        ("100.64.0.1", "non_global_address"),
        ("169.254.10.10", "link_local_address"),
        ("fe80::1", "link_local_address"),
        ("fd00::1", "private_address"),
        ("169.254.169.254", "cloud_metadata_address"),
        ("100.100.100.200", "cloud_metadata_address"),
        ("fd00:ec2::254", "cloud_metadata_address"),
        ("224.0.0.1", "multicast_address"),
        ("ff02::1", "multicast_address"),
        ("240.0.0.1", "reserved_address"),
        ("0.0.0.0", "unspecified_address"),
        ("::", "unspecified_address"),
        ("::ffff:127.0.0.1", "loopback_address"),
        ("::ffff:10.0.0.1", "ipv4_mapped_address"),
        ("64:ff9b::7f00:1", "nat64_address"),
        ("2002:7f00:1::1", "sixtofour_address"),
        ("198.18.0.1", "private_address"),
    ],
)
def test_non_public_destinations_are_classified_and_refused(address, reason):
    assert public_address_reason(address) == reason
    with pytest.raises(ControlPlaneError) as error:
        resolve_public_addresses("packages.example", limits=LIMITS, resolver=resolver_for(address))
    assert error.value.code == "url_destination_denied"
    assert error.value.status == 403
    assert reason in str(error.value)


def test_public_destinations_are_allowed():
    assert public_address_reason(PUBLIC) is None
    assert resolve_public_addresses(
        "packages.example", limits=LIMITS, resolver=resolver_for(PUBLIC)
    ) == [PUBLIC]


def test_dns_rebinding_is_blocked_when_any_answer_is_private():
    """A public-looking host that also answers 127.0.0.1 is refused outright."""
    with pytest.raises(ControlPlaneError) as error:
        fetch_https_package(
            "https://packages.example/a.agent.pkg",
            limits=LIMITS,
            resolver=resolver_for(PUBLIC, "127.0.0.1"),
            connector=never_connect,
        )
    assert error.value.code == "url_destination_denied"


def test_localhost_names_are_refused_by_resolution(monkeypatch):
    for name in ("localhost", "127.0.0.1", "[::1]", "metadata.google.internal"):
        address = {"metadata.google.internal": "169.254.169.254"}.get(name, name.strip("[]"))
        with pytest.raises(ControlPlaneError) as error:
            fetch_https_package(
                f"https://{name}/a.agent.pkg",
                limits=LIMITS,
                resolver=resolver_for(address),
                connector=never_connect,
            )
        assert error.value.code == "url_destination_denied"


def test_unresolvable_host_is_reported_without_connecting():
    def failing(*args, **kwargs):
        raise OSError("no such host")

    with pytest.raises(ControlPlaneError) as error:
        resolve_public_addresses("packages.example", limits=LIMITS, resolver=failing)
    assert error.value.code == "url_unresolvable"


# -- transfer policy against a controlled local server -----------------------
class _MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    routes: dict = {}

    def do_GET(self):  # noqa: N802 - stdlib handler contract
        entry = self.routes.get(self.path)
        if entry is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        status, headers, body = entry
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        if "Content-Length" not in headers:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        return


@pytest.fixture
def mock_origin(tmp_path):
    """A local package origin reached through the connector seam only."""
    source = tmp_path / "src"
    shutil.copytree(ROOT / "agents/meeting-agenda", source)
    artifact = build_package(source, tmp_path / "hosted.agent.pkg")
    payload = artifact.read_bytes()
    handler = type(
        "Routes",
        (_MockHandler,),
        {
            "routes": {
                "/hosted.agent.pkg": (200, {"Content-Type": "application/octet-stream"}, payload),
                "/moved.agent.pkg": (302, {"Location": "https://elsewhere.example/x"}, b""),
                "/missing.agent.pkg": (404, {}, b"nope"),
                "/huge.agent.pkg": (200, {}, b"x" * 200_000),
                "/lying.agent.pkg": (200, {"Content-Length": "999999999"}, b"x"),
            }
        },
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    # A refused transfer closes the socket mid-response on purpose; stay quiet.
    server.handle_error = lambda *args: None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    def connector(hostname, address, timeout):
        # Plaintext locally; the TLS-pinned connector is exercised against real hosts.
        return http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)

    try:
        yield artifact, payload, connector
    finally:
        server.shutdown()
        server.server_close()


def test_download_succeeds_through_the_full_policy_path(mock_origin):
    _, payload, connector = mock_origin
    data = fetch_https_package(
        "https://packages.example/hosted.agent.pkg",
        limits=FetchLimits(max_bytes=1024 * 1024, timeout_seconds=10),
        resolver=resolver_for(PUBLIC),
        connector=connector,
    )
    assert data == payload


@pytest.mark.parametrize(
    "path,code",
    [
        ("/moved.agent.pkg", "download_redirect_denied"),
        ("/missing.agent.pkg", "download_failed"),
        ("/huge.agent.pkg", "download_too_large"),
        ("/lying.agent.pkg", "download_too_large"),
    ],
)
def test_transfer_failures_are_classified(mock_origin, path, code):
    _, _, connector = mock_origin
    with pytest.raises(ControlPlaneError) as error:
        fetch_https_package(
            f"https://packages.example{path}",
            limits=FetchLimits(max_bytes=100_000, timeout_seconds=10),
            resolver=resolver_for(PUBLIC),
            connector=connector,
        )
    assert error.value.code == code


def test_open_url_snapshots_a_hosted_package(mock_origin, tmp_path):
    """End-to-end URL open through the control plane using the transport seam."""
    _, payload, _ = mock_origin

    def transport(url, limits):
        assert url == "https://packages.example/hosted.agent.pkg"
        return payload

    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json"),
        transport=transport,
    )
    summary = control.open_url("https://packages.example/hosted.agent.pkg")
    assert summary["source"]["kind"] == "url"
    assert summary["source"]["display"] == "https://packages.example/hosted.agent.pkg"
    assert summary["snapshot"]["archive_bytes"] == len(payload)
    assert summary["validation"]["integrity_status"] == "valid"
    assert summary["publisher"]["signature_status"] == "absent"
    session = control._session(summary["session"]["id"])
    assert session.snapshot_path.read_bytes() == payload
    assert not list(control.cache_dir.glob("*.part"))


def test_open_url_refuses_unsafe_urls_before_any_transport(tmp_path):
    def transport(url, limits):
        raise AssertionError("policy must run before the transport")

    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json"),
        transport=transport,
    )
    for url in ("http://packages.example/a.agent.pkg", "file:///etc/passwd"):
        with pytest.raises(ControlPlaneError) as error:
            control.open_url(url)
        assert error.value.code == "url_rejected"
    assert not list(control.cache_dir.glob("*.part"))


def test_injected_transport_still_obeys_the_size_limit(tmp_path):
    destination = tmp_path / "out.bin"
    destination.touch()
    with pytest.raises(ControlPlaneError) as error:
        download_to_file(
            "https://packages.example/a.agent.pkg",
            destination,
            limits=FetchLimits(max_bytes=16, timeout_seconds=5),
            transport=lambda url, limits: b"x" * 1024,
        )
    assert error.value.code == "download_too_large"


def test_killable_child_path_rejects_bad_syntax_without_spawning(tmp_path):
    destination = tmp_path / "out.bin"
    destination.touch()
    with pytest.raises(ControlPlaneError) as error:
        download_to_file("http://packages.example/a.agent.pkg", destination, limits=LIMITS)
    assert error.value.code == "url_rejected"
    assert destination.read_bytes() == b""
