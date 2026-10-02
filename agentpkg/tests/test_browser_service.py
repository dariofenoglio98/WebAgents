"""The loopback HTTP boundary: binding, authentication and bounded JSON."""

from __future__ import annotations

import http.client
import json
import socket
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from shipped_keys import AGENDA_KEY, DIST

from agentpkg.browser import (
    BrowserService,
    ControlPlane,
    ControlPlaneConfig,
    ControlPlaneError,
)
from agentpkg.browser.server import MAX_REQUEST_BYTES

ROOT = Path(__file__).resolve().parents[2]
AGENDA = DIST["meeting-agenda"]
DEV_KEY = AGENDA_KEY


@pytest.fixture
def service(tmp_path):
    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    server = BrowserService(control, host="127.0.0.1", port=0)
    server.start_background()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def call(service, method, path, body=None, *, token=True, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    request = urllib.request.Request(service.url + path, data=data, method=method)
    if token:
        request.add_header("Authorization", "Bearer " + service.token)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


# -- binding and authentication ---------------------------------------------
def test_only_loopback_addresses_can_be_bound(tmp_path):
    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    for host in ("0.0.0.0", "::", "192.168.1.10", "example.com"):
        with pytest.raises(ControlPlaneError) as error:
            BrowserService(control, host=host, port=0)
        assert error.value.code == "bind_rejected"
    server = BrowserService(control, host="127.0.0.1", port=0)
    try:
        assert server.server_address[0] == "127.0.0.1"
    finally:
        server.server_close()


def _local_routable_address():
    """This machine's own non-loopback address, if it has one. No packets are sent."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))  # TEST-NET-1: unrouted, connectionless.
        address = probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()
    return None if address.startswith("127.") else address


def test_binding_makes_no_reverse_dns_lookup(tmp_path, monkeypatch):
    """HTTPServer would call socket.getfqdn(); where the host's own name does not
    resolve (GitHub's macOS runners) that takes ~35 s, longer than the plugin waits."""

    def refuse(*_):
        raise AssertionError("reverse DNS lookup while binding the control plane")

    monkeypatch.setattr(socket, "getfqdn", refuse)
    monkeypatch.setattr(socket, "gethostbyaddr", refuse)
    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    server = BrowserService(control, host="127.0.0.1", port=0)
    try:
        assert server.server_name == "127.0.0.1"
        assert server.server_port == server.server_address[1] > 0
    finally:
        server.server_close()


def test_the_service_is_not_reachable_off_loopback(service):
    assert service.socket.getsockname()[0] == "127.0.0.1"
    external = _local_routable_address()
    if external is None:
        return  # Nothing else to probe on an isolated machine.
    probe = socket.socket()
    probe.settimeout(2)
    with pytest.raises(OSError):
        probe.connect((external, service.server_address[1]))
    probe.close()


def test_health_is_open_and_everything_else_needs_the_token(service):
    status, body = call(service, "GET", "/v0/health", token=False)
    assert status == 200
    assert body["service"] == "agentpkg-browser-control-plane"
    assert body["execution"] == "disabled"
    assert call(service, "GET", "/v0/status", token=False)[0] == 401
    assert call(service, "GET", "/v0/packages", token=False)[0] == 401
    assert call(service, "GET", "/v0/trust", token=False)[0] == 401
    wrong = call(
        service, "GET", "/v0/status", token=False, headers={"Authorization": "Bearer wrong"}
    )
    assert wrong[0] == 401
    basic = call(
        service,
        "GET",
        "/v0/status",
        token=False,
        headers={"Authorization": "Basic " + service.token},
    )
    assert basic[0] == 401
    assert call(service, "GET", "/v0/status")[0] == 200


def test_tokens_are_unguessable_and_per_process(tmp_path):
    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    first = BrowserService(control, host="127.0.0.1", port=0)
    second = BrowserService(control, host="127.0.0.1", port=0)
    try:
        assert first.token != second.token
        assert len(first.token) >= 32
    finally:
        first.server_close()
        second.server_close()


@pytest.mark.parametrize(
    "header", [{"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}]
)
def test_requests_from_a_real_browser_page_are_refused(service, header):
    status, body = call(service, "GET", "/v0/health", token=False, headers=header)
    assert status == 403
    assert body["error"]["code"] == "browser_request_refused"


def test_foreign_host_headers_are_refused(service):
    status, body = call(service, "GET", "/v0/status", headers={"Host": "attacker.example"})
    assert status == 403
    assert body["error"]["code"] == "host_header_rejected"


def test_no_cors_headers_are_ever_sent(service):
    request = urllib.request.Request(service.url + "/v0/health")
    with urllib.request.urlopen(request, timeout=15) as response:
        headers = {name.lower() for name in response.headers}
    assert not any(name.startswith("access-control-") for name in headers)
    assert "no-store" in response.headers["Cache-Control"]


# -- request handling --------------------------------------------------------
def test_request_bodies_are_bounded_and_strict(service):
    # The service refuses an over-limit body from its Content-Length, without
    # reading it. A client that is still writing when that happens may see the
    # connection go away before it can read the 413; both outcomes prove the
    # bound is enforced without the bytes ever being accepted.
    try:
        assert call(service, "POST", "/v0/packages/open-file", raw=b"x" * (MAX_REQUEST_BYTES + 1))[
            0
        ] in (413, 431)
    except (ConnectionError, urllib.error.URLError, http.client.HTTPException):
        pass
    assert call(service, "POST", "/v0/packages/open-file", raw=b"{not json")[0] == 400
    assert call(service, "POST", "/v0/packages/open-file", body=[1, 2])[0] == 400
    missing = call(service, "POST", "/v0/packages/open-file", body={})
    assert missing[0] == 400
    unknown = call(
        service,
        "POST",
        "/v0/packages/open-file",
        body={"path": str(AGENDA), "require_trusted_publisher": False},
    )
    assert unknown[0] == 400
    assert unknown[1]["error"]["code"] == "unknown_field"
    assert call(service, "GET", "/v0/packages")[1]["sessions"] == []


def test_unknown_routes_and_methods_are_refused(service):
    assert call(service, "GET", "/v0/nope")[0] == 404
    assert call(service, "GET", "/nope")[0] == 404
    assert call(service, "GET", "/v0/packages/open-file")[0] == 405
    assert call(service, "PUT", "/v0/trust", body={})[0] == 405
    assert call(service, "GET", "/v0/packages/not-a-real-session")[0] == 404


# -- full operator flow over HTTP -------------------------------------------
def test_open_inspect_pin_and_authorize_over_http(service):
    opened = call(service, "POST", "/v0/packages/open-file", {"path": str(AGENDA)})
    assert opened[0] == 201
    summary = opened[1]
    session_id = summary["session"]["id"]
    assert summary["publisher"]["trust_status"] == "unknown"

    permissions = call(service, "GET", f"/v0/packages/{session_id}/permissions")[1]
    assert {item["decision"] for item in permissions["permissions"]} == {"deny"}
    granted = {item["id"]: "session" for item in permissions["permissions"]}

    untrusted = call(
        service,
        "POST",
        f"/v0/packages/{session_id}/authorize",
        {"package_digest": summary["package"]["digest"], "decisions": granted},
    )
    assert untrusted[0] == 201
    assert untrusted[1]["runnable"] is False
    assert [item["code"] for item in untrusted[1]["blocking_reasons"]] == ["publisher_not_trusted"]

    pinned = call(
        service,
        "POST",
        "/v0/trust",
        {
            "public_key_pem": DEV_KEY.read_text(),
            "display_name": "WebAgents development key",
            "publisher_id": "webagents-research",
        },
    )
    assert pinned[0] == 201
    assert call(service, "GET", "/v0/trust")[1]["publishers"][0]["fingerprint"].startswith(
        "sha256:"
    )

    # Trust is evaluated when a package is opened, so reopen to observe it.
    reopened = call(service, "POST", "/v0/packages/open-file", {"path": str(AGENDA)})[1]
    assert reopened["publisher"]["trust_status"] == "trusted"
    trusted_id = reopened["session"]["id"]
    receipt = call(
        service,
        "POST",
        f"/v0/packages/{trusted_id}/authorize",
        {"package_digest": reopened["package"]["digest"], "decisions": granted},
    )[1]
    assert receipt["runnable"] is True
    assert receipt["blocking_reasons"] == []
    assert call(service, "GET", f"/v0/packages/{trusted_id}/authorization")[1] == receipt

    denied = call(
        service,
        "POST",
        f"/v0/packages/{trusted_id}/authorize",
        {
            "package_digest": reopened["package"]["digest"],
            "decisions": {**granted, "memory.session": "deny"},
        },
    )[1]
    assert denied["runnable"] is False
    assert [item["subject"] for item in denied["blocking_reasons"]] == ["memory.session"]

    assert call(service, "DELETE", f"/v0/packages/{trusted_id}")[1]["closed"] is True
    assert call(service, "GET", f"/v0/packages/{trusted_id}")[0] == 404


def test_trust_mutation_requires_the_host_token(service, tmp_path):
    store = tmp_path / "trust.json"
    payload = {"public_key_pem": DEV_KEY.read_text(), "display_name": "sneaky"}
    assert call(service, "POST", "/v0/trust", payload, token=False)[0] == 401
    assert not store.exists()
    fingerprint = "sha256:" + "c" * 64
    assert call(service, "DELETE", f"/v0/trust/{fingerprint}", token=False)[0] == 401
    assert call(service, "DELETE", "/v0/trust/not-a-fingerprint")[0] == 404
    assert call(service, "POST", "/v0/trust", payload)[0] == 201
    assert store.exists() and store.stat().st_mode & 0o777 == 0o600
    listed = call(service, "GET", "/v0/trust")[1]["publishers"]
    assert len(listed) == 1
    removed = call(service, "DELETE", f"/v0/trust/{listed[0]['fingerprint']}")
    assert removed[0] == 200
    assert call(service, "GET", "/v0/trust")[1]["publishers"] == []


def test_private_signing_keys_are_never_accepted_by_the_trust_api(service, tmp_path):
    from agentpkg.signing import keygen

    private, public = tmp_path / "private.pem", tmp_path / "public.pem"
    keygen(private, public)
    status, body = call(
        service,
        "POST",
        "/v0/trust",
        {"public_key_pem": private.read_text(), "display_name": "oops"},
    )
    assert status == 400
    assert body["error"]["code"] == "trust_private_key_refused"


def test_rejected_packages_report_layers_without_opening_a_session(service):
    status, body = call(service, "POST", "/v0/packages/open-file", {"path": "/no/such/file.pkg"})
    assert status == 400
    assert body["error"]["code"] == "source_rejected"
    assert call(service, "GET", "/v0/packages")[1]["sessions"] == []


def test_pinning_a_session_publisher_over_http(service):
    summary = call(service, "POST", "/v0/packages/open-file", {"path": str(AGENDA)})[1]
    session_id = summary["session"]["id"]
    fingerprint = summary["publisher"]["signer_fingerprint"]
    assert summary["publisher"]["trust_status"] == "unknown"

    assert (
        call(service, "POST", f"/v0/packages/{session_id}/trust-publisher", {}, token=False)[0]
        == 401
    )
    wrong = call(
        service,
        "POST",
        f"/v0/packages/{session_id}/trust-publisher",
        {"signer_fingerprint": "sha256:" + "0" * 64},
    )
    assert wrong[0] == 409
    assert wrong[1]["error"]["code"] == "fingerprint_mismatch"
    unknown_field = call(
        service,
        "POST",
        f"/v0/packages/{session_id}/trust-publisher",
        {"signer_fingerprint": fingerprint, "public_key_pem": "x"},
    )
    assert unknown_field[0] == 400

    pinned = call(
        service,
        "POST",
        f"/v0/packages/{session_id}/trust-publisher",
        {"signer_fingerprint": fingerprint, "scope": "package"},
    )
    assert pinned[0] == 201
    assert pinned[1]["publisher"]["trust_status"] == "trusted"
    assert pinned[1]["added"]["package_id_prefix"] == "org.webagents.meeting-agenda"
    assert call(service, "GET", f"/v0/packages/{session_id}")[1]["publisher"]["trust_status"] == (
        "trusted"
    )
    listed = call(service, "GET", "/v0/trust")[1]["publishers"]
    assert [entry["fingerprint"] for entry in listed] == [fingerprint]


def test_quiet_serve_keeps_the_token_out_of_stdout(tmp_path):
    """The contract a supervising host relies on: token only in a 0600 file."""
    import os
    import subprocess
    import sys
    import time

    token_file = tmp_path / "token"
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "agentpkg",
            "browser-serve",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--quiet",
            "--token-file",
            str(token_file),
            "--cache-dir",
            str(tmp_path / "cache"),
            "--trust-store",
            str(tmp_path / "trust.json"),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        startup = json.loads(process.stdout.readline())
        assert startup["status"] == "listening"
        assert "token" not in startup
        assert startup["url"].startswith("http://127.0.0.1:")
        deadline = time.monotonic() + 10
        while not token_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert token_file.stat().st_mode & 0o777 == 0o600
        token = token_file.read_text().strip()
        assert token and token not in json.dumps(startup)

        request = urllib.request.Request(startup["url"] + "/v0/status")
        request.add_header("Authorization", "Bearer " + token)
        with urllib.request.urlopen(request, timeout=15) as response:
            assert json.loads(response.read())["execution"] == "disabled"
        # Quiet mode also suppresses per-request logging.
        os.kill(process.pid, 15)
        stdout, _ = process.communicate(timeout=20)
        assert '"method"' not in stdout
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=10)


def test_quiet_serve_requires_a_way_to_obtain_the_token(tmp_path):
    from agentpkg.cli import main

    assert (
        main(["browser-serve", "--port", "0", "--quiet", "--cache-dir", str(tmp_path / "c")]) == 2
    )


# -- model and run-plan routes ----------------------------------------------
def _catalog(**overrides):
    model = {
        "id": "host/alpha",
        "provider_id": "host",
        "model_id": "alpha",
        "display_name": "Alpha",
        "available": True,
        "selectable": True,
        "capabilities": {
            "reasoning": {"value": True, "basis": "declared"},
            "structured_output": {"value": True, "basis": "declared"},
        },
        "limits": {"context_tokens": 200000},
        "properties": {"local": False, "tags": []},
    }
    model.update(overrides)
    return {
        "schema": "agentpkg-host-model-catalog-v0",
        "host": {
            "runtime": "test-host",
            "source": "test",
            "captured_at": "2026-09-21T22:00:00+00:00",
        },
        "models": [model],
        "notes": [],
    }


def _authorized_session(service):
    from agentpkg.browser.trust import read_public_key_file

    service.control.trust_add(
        read_public_key_file(DEV_KEY),
        display_name="dev key",
        publisher_id="webagents-research",
    )
    status, summary = call(service, "POST", "/v0/packages/open-file", {"path": str(AGENDA)})
    assert status == 201
    session = summary["session"]["id"]
    digest = summary["package"]["digest"]
    _, request = call(service, "GET", f"/v0/packages/{session}/permissions")
    decisions = {item["id"]: "session" for item in request["permissions"]}
    status, receipt = call(
        service,
        "POST",
        f"/v0/packages/{session}/authorize",
        {"package_digest": digest, "decisions": decisions},
    )
    assert status == 201
    return session, digest, receipt


def test_the_model_routes_evaluate_a_host_catalog(service):
    session, digest, _ = _authorized_session(service)
    status, requirements = call(service, "GET", f"/v0/packages/{session}/models")
    assert status == 200
    # A model-backed run, and the strictly smaller authority to make one
    # mediated tool call. Neither can stand in for the other.
    assert requirements["execution_modes"] == ["model", "tool_probe"]
    assert requirements["mode_required_permission_ids"]["model"] == ["model.reasoning"]

    status, evaluation = call(
        service,
        "POST",
        f"/v0/packages/{session}/models/evaluate",
        {"package_digest": digest, "catalog": _catalog()},
    )
    assert status == 200
    assert evaluation["models"][0]["status"] == "compatible"
    assert evaluation["execution"]["performed"] is False


def test_the_run_plan_routes_prepare_read_and_clear_one_plan(service):
    session, digest, receipt = _authorized_session(service)
    status, missing = call(service, "GET", f"/v0/packages/{session}/run-plan")
    assert status == 404
    assert missing["error"]["code"] == "run_plan_absent"

    status, created = call(
        service,
        "POST",
        f"/v0/packages/{session}/run-plan",
        {
            "package_digest": digest,
            "receipt_id": receipt["receipt_id"],
            "model_id": "host/alpha",
            "catalog": _catalog(),
        },
    )
    assert status == 201
    assert created["run_plan"]["readiness"]["ready"] is True
    assert created["preflight"]["state"] == "ready"

    status, read_back = call(service, "GET", f"/v0/packages/{session}/run-plan")
    assert status == 200
    assert read_back["run_plan"]["run_plan_id"] == created["run_plan"]["run_plan_id"]

    status, cleared = call(service, "DELETE", f"/v0/packages/{session}/run-plan")
    assert status == 200 and cleared["cleared"] is True
    assert call(service, "GET", f"/v0/packages/{session}/run-plan")[0] == 404


def test_run_plan_routes_refuse_unknown_request_fields(service):
    session, digest, receipt = _authorized_session(service)
    status, body = call(
        service,
        "POST",
        f"/v0/packages/{session}/run-plan",
        {
            "package_digest": digest,
            "receipt_id": receipt["receipt_id"],
            "model_id": "host/alpha",
            "catalog": _catalog(),
            "router_api_key": "sk-nope",
        },
    )
    assert status == 400
    assert body["error"]["code"] == "unknown_field"


def test_the_service_never_grows_an_execution_route(service):
    for path in (
        "/v0/packages/run",
        "/v0/run",
        "/v0/execute",
    ):
        status, body = call(service, "POST", path, {})
        # `/v0/packages/run` parses as a (nonexistent) session id, which is why
        # `session_unknown` is an acceptable refusal: either way, nothing runs.
        assert status in (404, 405), path
        assert body["error"]["code"] in ("not_found", "method_not_allowed", "session_unknown")
    status, health = call(service, "GET", "/v0/health", token=False)
    assert health["execution"] == "disabled"
