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
    keys = [spec.key for spec in benchmark.PACKAGES]
    assert keys == ["meeting-agenda", "literature-review", "webair"]
    archives = {spec.key: spec.archive for spec in benchmark.PACKAGES}
    assert archives["meeting-agenda"] == ROOT / "dist/meeting-agenda.agent.pkg"
    assert archives["literature-review"] == ROOT / "dist/literature-review.agent.pkg"
    # The versioned artifact: the `webair.agent.pkg` alias deliberately stays 0.1.0.
    assert archives["webair"] == ROOT / "dist/webair-0.3.0.agent.pkg"
    for spec in benchmark.PACKAGES:
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
    assert pipeline.identity["webair"]["package_version"] == "0.3.0"
    assert pipeline.identity["meeting-agenda"]["signer_fingerprint"].endswith("c5c4")
    assert pipeline.identity["literature-review"]["signer_fingerprint"].endswith("5232")
    assert pipeline.identity["webair"]["signer_fingerprint"] == (
        "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b"
    )
    webair = pipeline.identity["webair"]
    assert webair["package_id"] == "org.webagents.webair"
    assert webair["archive_sha256"] == (
        "b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887"
    )
    assert webair["package_digest"] == (
        "ffe8f5b344f97c631498bb6da3e17217ae7e5730721935b0e66c5d595b335e94"
    )
    assert webair["remote_tools"] == [
        "get-fare-rules",
        "prepare-booking",
        "search-flights",
        "simulate-purchase",
    ]
    assert webair["local_tools"] == [
        "personal.passenger_identity",
        "personal.travel_profile",
        "wallet.payment_method",
    ]
    assert {item["id"]: item["resource_types"] for item in webair["host_resource_permissions"]} == {
        "profile.travel": ["personal.travel_profile"],
        "identity.passenger": ["personal.passenger_identity"],
        "wallet.payment": ["wallet.payment_method"],
    }
    for key in ("meeting-agenda", "literature-review"):
        assert pipeline.identity[key]["host_resource_permissions"] == []


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
    from agentpkg.browser.hostresources import normalize_resource_registry
    from agentpkg.browser.hosttools import normalize_registry

    assert pipeline.control.config.policy == BrowserPolicy()
    catalog = normalize_catalog(pipeline.fixtures.catalog)
    registry = normalize_registry(pipeline.fixtures.registry)
    resources = normalize_resource_registry(pipeline.fixtures.resource_registry)
    assert [model["id"] for model in catalog["models"]] == [benchmark.MODEL_ID]
    bindings = {binding["tool_id"]: binding for binding in registry["bindings"]}
    assert set(bindings) >= {
        "scholarly-search",
        "citation-resolver",
        "paper-reader",
        *pipeline.identity["webair"]["declared_tools"],
    }
    # WebAir's four semantic tools: the operator bindings file's json_http entries,
    # each to one exact path on the public origin. The registry describes them;
    # nothing in the benchmark calls them.
    for tool_id in pipeline.identity["webair"]["remote_tools"]:
        assert bindings[tool_id]["implementation_id"] == "openclaw.tool.json_http"
        assert bindings[tool_id]["endpoint"]["origin"] == (
            "https://webagents-webair-production.up.railway.app"
        )
    # The three host-resource types: one host_resource binding each.
    for tool_id in pipeline.identity["webair"]["local_tools"]:
        assert bindings[tool_id]["implementation_kind"] == "host_resource"
        assert bindings[tool_id]["endpoint"] is None
    assert {item["id"] for item in resources["resources"]} >= {"profile_demo_traveler"}
    assert resources["type_count"] == 3


def test_no_host_resource_value_is_in_any_fixture():
    """The resource registry carries ids, labels and digests; values stay on the host."""
    definitions = json.loads((ROOT / "demo/webair/host-resources.json").read_text())
    pointers = {item["id"]: item.get("sealed_fields") or [] for item in definitions["types"]}
    sealed = []
    for resource in definitions["resources"]:
        for pointer in pointers[resource["type"]]:
            value = resource["value"]
            for part in pointer.strip("/").split("/"):
                value = value[part]
            sealed.append(value)
    assert sealed
    registry = json.loads((benchmark.FIXTURES / "host-resource-registry.json").read_text())
    assert all(set(item) == {"id", "type", "label", "digest"} for item in registry["resources"])
    for path in benchmark.FIXTURES.glob("*.json"):
        text = path.read_text()
        for value in sealed:
            assert value not in text, (path.name, "sealed host value")


def test_the_authorization_fixture_decides_every_declared_permission_and_tool(pipeline):
    """No decision is left to a default, and WebAir's search grants no booking authority."""
    for spec in benchmark.PACKAGES:
        identity = pipeline.identity[spec.key]
        decided = pipeline.fixtures.authorization[identity["package_id"]]
        assert set(decided["decisions"]) == {
            item["id"] for item in identity["declared_permissions"]
        }
        assert decided["tool_approvals"] == {tool: True for tool in identity["declared_tools"]}
        resource_permissions = {item["id"] for item in identity["host_resource_permissions"]}
        assert set(decided["resource_selections"]) == {
            pid for pid in resource_permissions if decided["decisions"][pid] != "deny"
        }
    webair = pipeline.fixtures.authorization["org.webagents.webair"]
    assert webair["resource_selections"] == {"profile.travel": "profile_demo_traveler"}
    assert sorted(pid for pid, d in webair["decisions"].items() if d == "deny") == [
        "booking.simulate_purchase",
        "identity.passenger",
        "wallet.payment",
    ]
    task = pipeline.fixtures.inputs["webair"]
    assert task == {
        "request": "Find me a flight to Zurich on 9 October under $900.",
        "booking": False,
        "purchase": {"quote_id": "", "fare_id": ""},
    }


def test_webair_resource_authorization_goes_through_production_validation(pipeline):
    """The travel-profile grant is made, frozen and re-checked by the real control plane,
    and the same calls refuse what a valid search must not have."""
    from agentpkg.browser.errors import ControlPlaneError

    control = pipeline.control
    fixtures = pipeline.fixtures
    spec = pipeline.packages["webair"]
    decided = fixtures.authorization["org.webagents.webair"]
    summary = control._open_bytes(spec.archive.read_bytes(), {"kind": "file", "display": "webair"})
    session_id = summary["session"]["id"]
    digest = summary["package"]["digest"]
    try:
        # What the page shows before the decision (`packages.permissions`).
        offered = control.evaluate_resources(
            session_id, package_digest=digest, resource_registry=fixtures.resource_registry
        )
        statuses = {item["permission_id"]: item["status"] for item in offered["requests"]}
        assert statuses == {
            "profile.travel": "offered",
            "identity.passenger": "offered",
            "wallet.payment": "offered",
        }
        # A denied permission carries no resource, and an allowed one needs a pick.
        with pytest.raises(ControlPlaneError) as denied:
            control.authorize(
                session_id,
                package_digest=digest,
                decisions=decided["decisions"],
                tool_approvals=decided["tool_approvals"],
                resource_registry=fixtures.resource_registry,
                resource_selections={
                    **decided["resource_selections"],
                    "identity.passenger": "passenger_demo_alex",
                },
            )
        assert denied.value.code == "resource_selection_denied"
        with pytest.raises(ControlPlaneError) as missing:
            control.authorize(
                session_id,
                package_digest=digest,
                decisions=decided["decisions"],
                tool_approvals=decided["tool_approvals"],
                resource_registry=fixtures.resource_registry,
                resource_selections={},
            )
        assert missing.value.code == "resource_selection_required"
        receipt = control.authorize(
            session_id,
            package_digest=digest,
            decisions=decided["decisions"],
            tool_approvals=decided["tool_approvals"],
            resource_registry=fixtures.resource_registry,
            resource_selections=decided["resource_selections"],
        )
        profile = next(
            item
            for item in fixtures.resource_registry["resources"]
            if item["id"] == "profile_demo_traveler"
        )
        assert receipt["runnable"] is True
        assert receipt["resource_grants"] == [
            {
                "permission_id": "profile.travel",
                "resource_type": "personal.travel_profile",
                "resource_id": "profile_demo_traveler",
                "resource_digest": profile["digest"],
            }
        ]
        tools = control.evaluate_tools(
            session_id, package_digest=digest, tool_registry=fixtures.registry
        )
        assert {t["tool_id"]: t["status"] for t in tools["tools"]} == {
            tool: "bound" for tool in pipeline.identity["webair"]["declared_tools"]
        }
        prepared = control.prepare_run_plan(
            session_id,
            package_digest=digest,
            receipt_id=receipt["receipt_id"],
            model_id=benchmark.MODEL_ID,
            catalog=fixtures.catalog,
            tool_registry=fixtures.registry,
            resource_registry=fixtures.resource_registry,
        )
        plan = prepared["run_plan"]
        assert plan["readiness"]["ready"] is True
        assert plan["resource_grants"] == receipt["resource_grants"]
        assert len(plan["tool_bindings"]) == 7
        assert prepared["preflight"]["ready"] is True and not prepared["preflight"]["stale"]
    finally:
        control.close(session_id)


# -- one observation through the real path ---------------------------------------
@pytest.mark.parametrize("key", ["meeting-agenda", "literature-review", "webair"])
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
    assert (
        observation.checks["first_wave"]
        == {
            "meeting-agenda": ["plan"],
            "literature-review": ["planning"],
            "webair": ["interpret"],
        }[key]
    )
    if key == "webair":
        # Stopped before the profile is read, before any tool or model: the only
        # grant is the travel profile, and the booking authorities reached the
        # runner denied.
        assert evidence["resource_grants"] == [
            {
                "permission_id": "profile.travel",
                "resource_type": "personal.travel_profile",
                "resource_id": "profile_demo_traveler",
            }
        ]
        assert evidence["runner_denied_permission_ids"] == [
            "booking.simulate_purchase",
            "identity.passenger",
            "wallet.payment",
        ]
        assert not any(a.startswith(("tool.", "model.")) for a in evidence["audit_actions_at_stop"])
    # The session, its snapshot and its lease are gone after the observation.
    assert pipeline.control.list_sessions()["sessions"] == []
    assert not any(pipeline.control.cache_dir.iterdir())


def test_the_runner_is_given_exactly_what_the_typescript_preflight_projects(pipeline):
    """The Python mirror of preflight.ts `binding` equals the real TypeScript output."""
    if shutil.which("node") is None or not (ROOT / "openclaw-agent-browser/dist").is_dir():
        pytest.skip("node or the built plugin is not available")
    control = pipeline.control
    fixtures = pipeline.fixtures
    for spec in benchmark.PACKAGES:
        key = spec.key
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
                resource_registry=fixtures.resource_registry,
                resource_selections=decided["resource_selections"],
            )
            control.prepare_run_plan(
                session_id,
                package_digest=digest,
                receipt_id=receipt["receipt_id"],
                model_id=benchmark.MODEL_ID,
                catalog=fixtures.catalog,
                tool_registry=fixtures.registry,
                resource_registry=fixtures.resource_registry,
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
            # Host-resource grants travel by reference, and only when there are any.
            if decided["resource_selections"]:
                assert "resource_grants" in typescript["revalidated"]
                assert (
                    typescript["binding"]["resource_grants"] == state["run_plan"]["resource_grants"]
                )
                assert binding["resource_grants"] == typescript["resources"]
            else:
                assert "resource_grants" not in typescript["binding"]
                assert "resource_grants" not in binding
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
