"""Does the benchmark measure the production path, and can it reach nothing else?"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import socket
import subprocess
from pathlib import Path

import benchmark
import pytest

ROOT = benchmark.ROOT


# -- the artifacts -------------------------------------------------------------
def _dist_hashes() -> dict[str, str]:
    """The release hashes published in dist/README.md."""
    text = (ROOT / "dist/README.md").read_text()
    return {name: digest for digest, name in re.findall(r"^([0-9a-f]{64})  (\S+)$", text, re.M)}


def test_the_benchmark_uses_the_current_signed_release_artifacts():
    published = _dist_hashes()
    keys = {spec.key for spec in benchmark.PACKAGES}
    assert keys == {"meeting-agenda", "literature-review"}
    for spec in benchmark.PACKAGES:
        assert spec.archive == ROOT / "dist" / f"{spec.key}.agent.pkg"
        assert benchmark._sha256_file(spec.archive) == published[spec.archive.name]
        assert spec.publisher_key.is_file()
        assert spec.task_input.is_file()


def test_package_identity_is_recorded_from_the_verified_bytes(pipeline):
    from agentpkg.package import load_package

    for spec in benchmark.PACKAGES:
        identity = pipeline.identity[spec.key]
        package = load_package(spec.archive)
        assert identity["archive_sha256"] == benchmark._sha256_file(spec.archive)
        assert identity["archive_bytes"] == spec.archive.stat().st_size
        assert identity["package_id"] == package.manifest["package_id"]
        assert identity["package_version"] == package.manifest["version"]
        assert identity["package_digest"] == package.digest
        assert identity["signature_status"] == "valid"
        assert identity["trust_status"] == "trusted"
        assert identity["graph_nodes"] == len(package.graph["nodes"])
        assert identity["declared_tools"] == sorted(package.tools)
    assert pipeline.identity["meeting-agenda"]["package_version"] == "0.2.2"
    assert pipeline.identity["literature-review"]["package_version"] == "0.2.5"
    assert pipeline.identity["meeting-agenda"]["signer_fingerprint"].endswith("c5c4")
    assert pipeline.identity["literature-review"]["signer_fingerprint"].endswith("5232")


def test_the_fixtures_are_what_the_plugin_code_generates():
    if shutil.which("node") is None or not (ROOT / "openclaw-agent-browser/dist").is_dir():
        pytest.skip("node or the built plugin is not available")
    completed = subprocess.run(
        ["node", str(benchmark.FIXTURES / "generate_fixtures.mjs"), "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0, completed.stderr


def test_fixtures_pass_production_validation_without_relaxed_policy(pipeline):
    from agentpkg.browser.authorization import BrowserPolicy
    from agentpkg.browser.hostmodels import normalize_catalog
    from agentpkg.browser.hosttools import normalize_registry

    assert pipeline.control.config.policy == BrowserPolicy()
    catalog = normalize_catalog(pipeline.fixtures.catalog)
    registry = normalize_registry(pipeline.fixtures.registry)
    assert [model["id"] for model in catalog["models"]] == [benchmark.MODEL_ID]
    assert {binding["tool_id"] for binding in registry["bindings"]} >= {
        "scholarly-search",
        "citation-resolver",
        "paper-reader",
    }


# -- one observation through the real path ---------------------------------------
@pytest.mark.parametrize("key", ["meeting-agenda", "literature-review"])
def test_one_observation_reaches_the_first_wave_and_nothing_further(pipeline, key):
    observation = pipeline.run_once(key)
    stamps = observation.stamps
    assert len(stamps) == 8
    assert all(later >= earlier for earlier, later in zip(stamps, stamps[1:], strict=False))
    assert stamps[7] > stamps[0]
    identity = pipeline.identity[key]
    assert observation.checks["first_wave"] == identity["root_nodes"]
    assert set(observation.checks["runner_frames"]) <= {"execution.progress", "$/cancel"}
    evidence = pipeline.evidence[key]
    assert "node.started" not in evidence["audit_actions_at_stop"]
    assert evidence["audit_actions_at_stop"][:2] == ["runtime.started", "workflow.started"]
    assert evidence["outcome_after_stop"]["model_calls"] == 0
    assert evidence["outcome_after_stop"]["tool_calls"] == 0
    assert len(evidence["runner_verified"]) == 9
    # The session, its snapshot and its lease are gone after the observation.
    assert pipeline.control.list_sessions()["sessions"] == []
    assert not any(pipeline.control.cache_dir.iterdir())


def test_the_runner_is_given_exactly_what_the_typescript_preflight_projects(pipeline):
    """The Python mirror of preflight.ts `binding` equals the real TypeScript output."""
    if shutil.which("node") is None or not (ROOT / "openclaw-agent-browser/dist").is_dir():
        pytest.skip("node or the built plugin is not available")
    control = pipeline.control
    fixtures = pipeline.fixtures
    for key in ("meeting-agenda", "literature-review"):
        spec = pipeline.packages[key]
        decided = fixtures.authorization[pipeline.identity[key]["package_id"]]
        data = spec.archive.read_bytes()
        summary = control._open_bytes(data, {"kind": "file", "display": str(spec.archive)})
        session_id = summary["session"]["id"]
        try:
            digest = summary["package"]["digest"]
            receipt = control.authorize(
                session_id,
                package_digest=digest,
                decisions=decided["decisions"],
                tool_approvals=decided["tool_approvals"],
            )
            control.prepare_run_plan(
                session_id,
                package_digest=digest,
                receipt_id=receipt["receipt_id"],
                model_id=benchmark.MODEL_ID,
                catalog=fixtures.catalog,
                tool_registry=fixtures.registry,
            )
            state = control.run_plan(session_id)
            held = control.authorization(session_id)
            tool_evaluation = control.evaluate_tools(
                session_id, package_digest=digest, tool_registry=fixtures.registry
            )
            payload = {
                "state": state,
                "summary": control.summary(session_id),
                "receipt": held,
                "tool_evaluation": tool_evaluation,
                "catalog": fixtures.catalog,
                "registry": fixtures.registry,
                "minimum_receipt_remaining_ms": (fixtures.policy["runTimeoutSeconds"] + 60) * 1000,
            }
            completed = subprocess.run(
                ["node", str(Path(__file__).with_name("ts_revalidate.mjs"))],
                input=json.dumps(payload, default=str),
                capture_output=True,
                text=True,
                timeout=60,
                cwd=ROOT,
            )
            assert completed.returncode == 0, completed.stderr
            typescript = json.loads(completed.stdout)
            binding, authorization = benchmark.project_for_runner(state["run_plan"], held)
            assert binding == typescript["binding"], key
            ts_auth = typescript["authorization"]
            assert authorization == {
                "receipt_id": ts_auth["receiptId"],
                "receipt_sha256": ts_auth["receiptSha256"],
                "issued_at": ts_auth["issuedAt"],
                "expires_at": ts_auth["expiresAt"],
                "decisions": ts_auth["decisions"],
                "tool_approvals": ts_auth["toolApprovals"],
            }
            # The benchmark issues the same control-plane reads, in the same order.
            expected_calls = ["getRunPlan", "getPackage", "getAuthorization"]
            if state["run_plan"]["tool_bindings"]:
                expected_calls.append("evaluateTools")
            assert typescript["calls"] == expected_calls
            assert "receipt_outlasts_run_deadline" in typescript["revalidated"]
        finally:
            control.close(session_id)


def test_the_benchmark_calls_the_runner_handler_production_installs():
    """Stages 6 and 7 go through `ExecutionSession.__call__`, the peer's handler."""
    source = Path(benchmark.__file__).read_text()
    assert 'runner("execution.begin", params)' in source
    assert 'holder["runner"]("execution.run", {})' in source
    assert "control._open_bytes(data" in source
    for name in (
        "authorize",
        "evaluate_models",
        "evaluate_tools",
        "prepare_run_plan",
        "validate_input",
        "run_plan",
        "summary",
        "authorization",
        "issue_execution_lease",
    ):
        assert f"control.{name}(" in source


def test_the_first_wave_stop_is_installed_only_while_running_and_restored(pipeline):
    from agentpkg.workflow import Workflow

    original = Workflow.__dict__["_gather"]
    pipeline.run_once("meeting-agenda")
    assert Workflow.__dict__["_gather"] is original


# -- guards -------------------------------------------------------------------
def test_without_the_stop_the_first_model_call_is_refused_at_the_wire(pipeline, monkeypatch):
    """Proves the guard: if the benchmark ever ran past the first wave, the model
    request would be refused at the runner's writer and the observation would fail."""
    wires = []

    class RecordingWire(benchmark.RunnerWire):
        def __init__(self):
            super().__init__()
            wires.append(self)

    class NoStop:
        at_ns = None
        nodes = None
        audit_actions = None
        hits = 0

        def reset(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(benchmark, "RunnerWire", RecordingWire)
    monkeypatch.setattr(pipeline, "stop", NoStop())
    with pytest.raises(AssertionError, match="never reached its first wave"):
        pipeline.run_once("meeting-agenda")
    refused = b"".join(wires[-1].refused)
    assert b'"method":"model.' in refused
    assert pipeline.control.list_sessions()["sessions"] == []


def test_the_runner_wire_refuses_a_tool_call_frame():
    from agentpkg.execution import protocol as execution_protocol
    from agentpkg.hostbridge import protocol as bridge_protocol

    wire = benchmark.RunnerWire()
    frame = bridge_protocol.encode(
        bridge_protocol.request(
            "x9",
            execution_protocol.TOOL_CALL_METHOD,
            {"tool_id": "scholarly-search"},
            allowed=execution_protocol.RUNNER_OUTBOUND_METHODS,
            version=execution_protocol.EXECUTION_PROTOCOL_VERSION,
        )
    )
    with pytest.raises(benchmark.ForbiddenDispatch):
        wire.write(frame)
    assert wire.refused and not wire.frames


def test_the_offline_guard_refuses_and_counts_network_and_processes():
    connect = socket.socket.connect
    with benchmark.OfflineGuard() as guard:
        with pytest.raises(benchmark.OfflineViolation):
            socket.create_connection(("192.0.2.1", 443), timeout=0.1)
        with pytest.raises(benchmark.OfflineViolation):
            socket.getaddrinfo("example.com", 443)
        with pytest.raises(benchmark.OfflineViolation):
            subprocess.run(["true"], check=False)
        with socket.socket() as sock, pytest.raises(benchmark.OfflineViolation):
            sock.connect(("192.0.2.1", 443))
    assert guard.violations == [
        "socket.create_connection",
        "socket.getaddrinfo",
        "subprocess.Popen",
        "socket.connect",
    ]
    assert socket.socket.connect is connect


def test_the_pipeline_needs_no_event_loop_outside_its_own(pipeline):
    pipeline.run_once("literature-review")
    with pytest.raises(RuntimeError):
        asyncio.get_running_loop()
