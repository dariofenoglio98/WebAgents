"""Control-plane behavior: one generic path for two unrelated packages.

Both shipped artifacts are opened through identical code. No assertion below
depends on what "literature" or "agenda" mean; the summaries differ only
because the packages declare different structure.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import pytest
from shipped_keys import DIST, ORIGINAL_KEY, SIGNER_KEY

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.authorization import BrowserPolicy
from agentpkg.browser.evaluation import evaluate_snapshot
from agentpkg.browser.trust import read_public_key_file
from agentpkg.package import archive_bytes, build_package, load_package
from agentpkg.signing import keygen, sign_package

ROOT = Path(__file__).resolve().parents[2]
DEV_KEY = ORIGINAL_KEY


def plane(tmp_path, **overrides) -> ControlPlane:
    config = ControlPlaneConfig(
        cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json", **overrides
    )
    return ControlPlane(config)


def pin_dev_key(control: ControlPlane, *, key=DEV_KEY, **overrides):
    options = {
        "display_name": "WebAgents development key",
        "publisher_id": "webagents-research",
        **overrides,
    }
    return control.trust_add(read_public_key_file(key), **options)


def pin_review_key(control: ControlPlane):
    """Literature Review 0.2.1 has its own signer, pinned only for its own id."""
    return pin_dev_key(
        control,
        key=SIGNER_KEY["literature-review"],
        display_name="WebAgents Literature Review signing key",
        package_id_prefix="org.webagents.literature-review",
    )


def signed_copy(tmp_path, name="meeting-agenda"):
    """A locally built and locally signed artifact with a throwaway key."""
    source = tmp_path / f"src-{name}"
    shutil.copytree(ROOT / "agents" / name, source)
    artifact = build_package(source, tmp_path / f"{name}.agent.pkg")
    private, public = tmp_path / "private.pem", tmp_path / "public.pem"
    keygen(private, public)
    sign_package(artifact, private)
    return artifact, public


def grant_required(control, session_id, summary, value="session"):
    request = control.permissions(session_id)
    decisions = {item["id"]: value for item in request["permissions"] if item["required"]}
    return control.authorize(
        session_id, package_digest=summary["package"]["digest"], decisions=decisions
    )


# -- opening both shipped packages through one path --------------------------
@pytest.mark.parametrize("name", sorted(DIST))
def test_both_packages_open_and_report_every_layer(name, tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST[name]))
    validation = summary["validation"]
    assert validation["container_status"] == "valid"
    assert validation["integrity_status"] == "valid"
    assert validation["schema_status"] == "valid"
    assert validation["runtime_status"] == "compatible"
    assert summary["publisher"]["signature_status"] == "valid"
    # A self-consistent signature from an unpinned key is NOT trust.
    assert summary["publisher"]["trust_status"] == "unknown"
    assert summary["execution"] == {
        "performed": False,
        "note": "Opening and inspecting a package never executes it.",
    }
    assert summary["snapshot"]["captured_once"] is True


@pytest.mark.parametrize("name", sorted(DIST))
def test_pinned_development_key_upgrades_trust(name, tmp_path):
    control = plane(tmp_path)
    pin_dev_key(control, key=SIGNER_KEY[name], package_id_prefix="org.webagents.")
    summary = control.open_file(str(DIST[name]))
    assert summary["publisher"]["trust_status"] == "trusted"
    assert summary["publisher"]["trust_reason"] == "operator_pinned_key"
    assert summary["publisher"]["signer_fingerprint"].startswith("sha256:")
    assert "publisher_unknown" not in {item["code"] for item in summary["warnings"]}


def test_unrelated_packages_yield_structurally_different_summaries(tmp_path):
    control = plane(tmp_path)
    review = control.open_file(str(DIST["literature-review"]))
    agenda = control.open_file(str(DIST["meeting-agenda"]))
    assert review["capabilities"] != agenda["capabilities"]
    assert len(review["skills"]) == 7 and len(agenda["skills"]) == 3
    assert len(review["tools"]) == 3 and agenda["tools"] == []
    assert len(review["workers"]) == 9 and len(agenda["workers"]) == 4
    # 0.2.2 added `check-evidence`, which refuses colliding evidence ids; 0.2.3
    # added `bibliography` and `assemble-output`, which attach resolver metadata.
    assert review["workflow"]["node_count"] == 24
    assert agenda["workflow"]["node_count"] == 7
    assert review["policy"]["network"]["allowed_domains"]
    assert agenda["policy"]["network"]["allowed_domains"] == []
    assert review["policy"]["budget"] != agenda["policy"]["budget"]
    assert {p["id"] for p in review["policy"]["permissions"]} != {
        p["id"] for p in agenda["policy"]["permissions"]
    }
    # Identical machinery, identical shape.
    assert review["schema"] == agenda["schema"]
    assert set(review) == set(agenda)


def test_summary_describes_tools_workers_and_graph_generically(tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST["literature-review"]))
    remote = {tool["id"]: tool for tool in summary["tools"] if tool["execution"] == "remote"}
    assert set(remote) == {"scholarly-search", "citation-resolver"}
    assert remote["scholarly-search"]["endpoint_origin"] == "https://api.crossref.org"
    assert remote["scholarly-search"]["side_effects"] == "read"
    assert all("input_schema" in tool for tool in summary["tools"])
    coordinator = [w for w in summary["workers"] if w["is_coordinator"]]
    assert len(coordinator) == 1 and coordinator[0]["max_instances"] == 1
    assert all({"state_read", "state_write", "budget"} <= set(w) for w in summary["workers"])
    workflow = summary["workflow"]
    assert workflow["entry_nodes"] == ["planning"]
    assert workflow["output_nodes"] == ["outputs"]
    assert sum(workflow["node_types"].values()) == workflow["node_count"]
    assert len(workflow["edges"]) == sum(len(n["depends_on"]) for n in workflow["nodes"])
    assert any(node["type"] == "map" and node["step_count"] for node in workflow["nodes"])
    assert summary["model_requirements"]["routing"] == "host"


def test_summary_excludes_raw_payload_content(tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST["literature-review"]))
    serialized = json.dumps(summary)
    skill_body = load_package(DIST["literature-review"]).files["skills/literature-search/SKILL.md"]
    assert skill_body.decode()[:80] not in serialized
    assert all({"path", "bytes", "sha256"} <= set(item) for item in summary["payload"]["files"])
    assert summary["payload"]["file_count"] == len(summary["payload"]["files"])


# -- snapshot semantics ------------------------------------------------------
def test_snapshot_is_captured_once_and_source_changes_are_ignored(tmp_path):
    control = plane(tmp_path)
    artifact = tmp_path / "copy.agent.pkg"
    artifact.write_bytes(DIST["meeting-agenda"].read_bytes())
    summary = control.open_file(str(artifact))
    session = control._session(summary["session"]["id"])
    artifact.write_bytes(b"replaced after opening")
    assert control.summary(summary["session"]["id"])["snapshot"] == summary["snapshot"]
    assert session.snapshot_path.read_bytes() == DIST["meeting-agenda"].read_bytes()
    # Only the snapshot and its marker exist; the payload is never extracted.
    assert sorted(p.name for p in session.directory.iterdir()) == [
        ".agentpkg-browser-session",
        "package.agent.pkg",
    ]


def test_source_directory_is_not_a_package_source(tmp_path):
    control = plane(tmp_path)
    with pytest.raises(ControlPlaneError, match="not source directories") as error:
        control.open_file(str(ROOT / "agents/meeting-agenda"))
    assert error.value.code == "source_rejected"


def test_oversized_package_is_refused(tmp_path):
    control = plane(tmp_path, max_package_bytes=1024)
    with pytest.raises(ControlPlaneError) as error:
        control.open_file(str(DIST["meeting-agenda"]))
    assert error.value.code in {"package_too_large", "source_rejected"}
    assert control.list_sessions()["sessions"] == []


# -- rejected packages -------------------------------------------------------
def test_malformed_archive_is_rejected_at_the_container_layer(tmp_path):
    control = plane(tmp_path)
    broken = tmp_path / "broken.agent.pkg"
    broken.write_bytes(b"PK\x03\x04 not really a zip")
    with pytest.raises(ControlPlaneError) as error:
        control.open_file(str(broken))
    assert error.value.code == "package_rejected"
    assert error.value.details["validation"]["container_status"] == "invalid"
    assert error.value.details["validation"]["integrity_status"] == "not_evaluated"
    assert control.list_sessions()["sessions"] == []


def test_corrupted_payload_is_rejected_at_the_integrity_layer(tmp_path):
    control = plane(tmp_path)
    original = DIST["meeting-agenda"]
    with zipfile.ZipFile(original) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    members["skills/planning/SKILL.md"] = b"# Replaced instructions\n"
    corrupted = tmp_path / "corrupted.agent.pkg"
    with zipfile.ZipFile(corrupted, "w", zipfile.ZIP_STORED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    with pytest.raises(ControlPlaneError) as error:
        control.open_file(str(corrupted))
    validation = error.value.details["validation"]
    assert validation["container_status"] == "valid"
    assert validation["integrity_status"] == "invalid"
    assert validation["schema_status"] == "not_evaluated"


def test_tampered_after_signing_loads_but_reports_an_invalid_signature(tmp_path):
    """Payload rehashed so integrity passes; the old signature cannot follow."""
    control = plane(tmp_path)
    artifact, _ = signed_copy(tmp_path)
    package = load_package(artifact)
    files = dict(package.files)
    files["skills/planning/SKILL.md"] = b"# Tampered but rehashed\n"
    tampered = tmp_path / "tampered.agent.pkg"
    tampered.write_bytes(archive_bytes(files, package.signature))
    summary = control.open_file(str(tampered))
    assert summary["validation"]["integrity_status"] == "valid"
    assert summary["publisher"]["signature_status"] == "invalid"
    assert summary["publisher"]["signed_digest_matches"] is False
    assert summary["publisher"]["trust_status"] == "unknown"
    assert "signature_invalid" in {item["code"] for item in summary["warnings"]}


def test_unsigned_package_opens_but_is_never_runnable(tmp_path):
    control = plane(tmp_path)
    source = tmp_path / "src"
    shutil.copytree(ROOT / "agents/meeting-agenda", source)
    artifact = build_package(source, tmp_path / "unsigned.agent.pkg")
    summary = control.open_file(str(artifact))
    assert summary["publisher"]["signature_status"] == "absent"
    assert summary["publisher"]["signer_fingerprint"] is None
    assert summary["publisher"]["trust_status"] == "unknown"
    receipt = grant_required(control, summary["session"]["id"], summary)
    assert receipt["runnable"] is False
    assert {item["code"] for item in receipt["blocking_reasons"]} == {
        "signature_not_valid",
        "publisher_not_trusted",
    }


def test_unsupported_execution_profile_stays_inspectable(tmp_path):
    """An archival profile is describable but not authorizable for execution."""
    control = plane(tmp_path)
    summary = control.open_file(str(ROOT / "dist/literature-review-legacy.agent.pkg"))
    assert summary["validation"]["schema_status"] == "valid"
    assert summary["validation"]["runtime_status"] == "incompatible"
    assert summary["workflow"]["stage_count"] == 9
    receipt = grant_required(control, summary["session"]["id"], summary)
    assert receipt["runnable"] is False
    assert "execution_profile_unsupported" in {i["code"] for i in receipt["blocking_reasons"]}


def test_evaluation_layers_are_independent(tmp_path):
    report = evaluate_snapshot(DIST["meeting-agenda"])
    assert report.structurally_valid and report.package is not None
    assert report.as_json()["supported_execution_profiles"] == ["workflow.v0"]


# -- authorization -----------------------------------------------------------
@pytest.mark.parametrize("name", sorted(DIST))
def test_every_permission_defaults_to_deny(name, tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST[name]))
    request = control.permissions(summary["session"]["id"])
    assert request["permissions"]
    assert {item["decision"] for item in request["permissions"]} == {"deny"}
    assert request["decision_model"]["default"] == "deny"
    assert "always" in request["decision_model"]["unsupported"]
    assert "always" not in request["decision_model"]["supported"]


def test_explicit_grants_produce_a_digest_bound_runnable_receipt(tmp_path):
    control = plane(tmp_path)
    pin_review_key(control)
    summary = control.open_file(str(DIST["literature-review"]))
    receipt = grant_required(control, summary["session"]["id"], summary)
    assert receipt["runnable"] is True
    assert receipt["blocking_reasons"] == []
    assert receipt["package"]["digest"] == summary["package"]["digest"]
    assert receipt["package"]["archive_sha256"] == summary["snapshot"]["archive_sha256"]
    assert receipt["publisher"]["signer_fingerprint"] == summary["publisher"]["signer_fingerprint"]
    assert receipt["trust_store"]["entry_count"] == 1
    assert len(receipt["trust_store"]["state_sha256"]) == 64
    assert receipt["execution"]["performed"] is False
    assert len(receipt["receipt_sha256"]) == 64
    # Optional permissions stay denied unless explicitly granted.
    assert receipt["decisions"]["files.pdfs"] == "deny"
    assert control.authorization(summary["session"]["id"]) == receipt
    assert control.summary(summary["session"]["id"])["authorization"]["runnable"] is True


def test_denying_a_required_permission_makes_the_package_not_runnable(tmp_path):
    control = plane(tmp_path)
    pin_review_key(control)
    summary = control.open_file(str(DIST["literature-review"]))
    request = control.permissions(summary["session"]["id"])
    required = sorted(item["id"] for item in request["permissions"] if item["required"])
    decisions = {pid: "session" for pid in required[1:]}
    receipt = control.authorize(
        summary["session"]["id"],
        package_digest=summary["package"]["digest"],
        decisions=decisions,
    )
    assert receipt["runnable"] is False
    denied = [i for i in receipt["blocking_reasons"] if i["code"] == "required_permission_denied"]
    assert [item["subject"] for item in denied] == [required[0]]


def test_omitting_decisions_entirely_denies_everything(tmp_path):
    control = plane(tmp_path)
    pin_dev_key(control)
    summary = control.open_file(str(DIST["meeting-agenda"]))
    receipt = control.authorize(
        summary["session"]["id"], package_digest=summary["package"]["digest"], decisions=None
    )
    assert set(receipt["decisions"].values()) == {"deny"}
    assert receipt["granted_permission_ids"] == []
    assert receipt["runnable"] is False


def test_once_grants_are_accepted_and_always_is_refused(tmp_path):
    control = plane(tmp_path)
    pin_dev_key(control, key=SIGNER_KEY["meeting-agenda"])
    summary = control.open_file(str(DIST["meeting-agenda"]))
    session_id, digest = summary["session"]["id"], summary["package"]["digest"]
    receipt = control.authorize(
        session_id,
        package_digest=digest,
        decisions={"model.reasoning": "once", "memory.session": "session"},
    )
    assert receipt["decisions"]["model.reasoning"] == "once"
    assert receipt["runnable"] is True
    with pytest.raises(ControlPlaneError) as error:
        control.authorize(session_id, package_digest=digest, decisions={"memory.session": "always"})
    assert error.value.code == "unsupported_decision"
    assert "persistent" in str(error.value)


def test_authorization_rejects_a_foreign_or_missing_digest(tmp_path):
    control = plane(tmp_path)
    pin_review_key(control)
    agenda = control.open_file(str(DIST["meeting-agenda"]))
    review = control.open_file(str(DIST["literature-review"]))
    with pytest.raises(ControlPlaneError) as error:
        control.authorize(
            agenda["session"]["id"],
            package_digest=review["package"]["digest"],
            decisions={"memory.session": "session"},
        )
    assert error.value.code == "digest_mismatch"
    with pytest.raises(ControlPlaneError, match="package_digest is required"):
        control.authorize(agenda["session"]["id"], package_digest=None, decisions={})


def test_receipt_of_one_package_never_matches_another_with_equal_identity(tmp_path):
    """Same package ID and version, different bytes: the receipts cannot be swapped."""
    control = plane(tmp_path)
    first_source, second_source = tmp_path / "a", tmp_path / "b"
    shutil.copytree(ROOT / "agents/meeting-agenda", first_source)
    shutil.copytree(ROOT / "agents/meeting-agenda", second_source)
    (second_source / "skills/planning/SKILL.md").write_text("# Different instructions\n")
    receipts = []
    for index, source in enumerate((first_source, second_source)):
        artifact = build_package(source, tmp_path / f"pkg{index}.agent.pkg")
        summary = control.open_file(str(artifact))
        receipts.append(grant_required(control, summary["session"]["id"], summary))
    assert receipts[0]["package"]["package_id"] == receipts[1]["package"]["package_id"]
    assert receipts[0]["package"]["version"] == receipts[1]["package"]["version"]
    assert receipts[0]["package"]["digest"] != receipts[1]["package"]["digest"]
    assert receipts[0]["package"]["archive_sha256"] != receipts[1]["package"]["archive_sha256"]
    assert receipts[0]["receipt_sha256"] != receipts[1]["receipt_sha256"]


def test_unknown_permission_or_decision_is_refused(tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST["meeting-agenda"]))
    session_id, digest = summary["session"]["id"], summary["package"]["digest"]
    with pytest.raises(ControlPlaneError) as unknown:
        control.authorize(session_id, package_digest=digest, decisions={"invented": "session"})
    assert unknown.value.code == "unknown_permission"
    with pytest.raises(ControlPlaneError) as invalid:
        control.authorize(session_id, package_digest=digest, decisions={"memory.session": "yes"})
    assert invalid.value.code == "invalid_decision"


def test_research_policy_can_lower_trust_requirements_explicitly(tmp_path):
    control = plane(
        tmp_path,
        policy=BrowserPolicy(require_valid_signature=True, require_trusted_publisher=False),
    )
    summary = control.open_file(str(DIST["meeting-agenda"]))
    receipt = grant_required(control, summary["session"]["id"], summary)
    assert receipt["runnable"] is True
    # The receipt still records that nobody vouched for this publisher.
    assert receipt["publisher"]["trust_status"] == "unknown"
    assert receipt["browser_policy"]["require_trusted_publisher"] is False


# -- lifetime ----------------------------------------------------------------
def test_expired_sessions_disappear_with_their_snapshots(tmp_path):
    control = plane(tmp_path, session_ttl_seconds=0)
    summary = control.open_file(str(DIST["meeting-agenda"]))
    directory = tmp_path / "cache" / f"session-{summary['session']['id']}"
    assert directory.is_dir()
    with pytest.raises(ControlPlaneError) as error:
        control.summary(summary["session"]["id"])
    assert error.value.code == "session_unknown"
    assert not directory.exists()
    assert control.list_sessions()["sessions"] == []


def test_session_and_cache_limits_are_enforced(tmp_path):
    control = plane(tmp_path, max_sessions=1)
    control.open_file(str(DIST["meeting-agenda"]))
    with pytest.raises(ControlPlaneError) as error:
        control.open_file(str(DIST["meeting-agenda"]))
    assert error.value.code == "session_limit_reached"
    capped = plane(tmp_path / "other", max_cache_bytes=1024)
    with pytest.raises(ControlPlaneError) as cache_error:
        capped.open_file(str(DIST["meeting-agenda"]))
    assert cache_error.value.code == "cache_limit_reached"


def test_closing_a_session_removes_its_snapshot_and_receipt(tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST["meeting-agenda"]))
    session_id = summary["session"]["id"]
    grant_required(control, session_id, summary)
    directory = tmp_path / "cache" / f"session-{session_id}"
    assert control.close(session_id)["receipt_retained"] is False
    assert not directory.exists()
    with pytest.raises(ControlPlaneError):
        control.authorization(session_id)


def test_startup_cleans_only_its_own_stale_snapshots(tmp_path):
    first = plane(tmp_path)
    summary = first.open_file(str(DIST["meeting-agenda"]))
    stale = tmp_path / "cache" / f"session-{summary['session']['id']}"
    unrelated = tmp_path / "cache" / "operator-notes.txt"
    unrelated.write_text("not ours")
    second = plane(tmp_path)
    assert second.removed_stale_snapshots == 1
    assert not stale.exists()
    assert unrelated.read_text() == "not ours"
    assert second.status()["open_sessions"] == 0


def test_status_reports_limits_and_a_disabled_executor(tmp_path):
    control = plane(tmp_path)
    status = control.status()
    assert status["execution"] == "disabled"
    assert status["capabilities"]["execute"] is False
    assert status["limits"]["max_sessions"] == 8
    assert status["trust_store"]["entry_count"] == 0


def test_unusual_declared_authority_is_surfaced_generically(tmp_path):
    """A package declaring write/shell authority is flagged from its declaration."""
    source = tmp_path / "src"
    shutil.copytree(ROOT / "agents/meeting-agenda", source)
    policy_path = source / "policy/policy.json"
    policy = json.loads(policy_path.read_text())
    policy["permissions"].extend(
        [
            {
                "id": "files.exports",
                "kind": "files.write",
                "description": "Write agenda exports",
                "required": False,
                "resources": ["user-selected-directory"],
            },
            {
                "id": "shell.local",
                "kind": "shell",
                "description": "Run a local command",
                "required": False,
                "resources": ["host-shell"],
            },
        ]
    )
    policy_path.write_text(json.dumps(policy))
    artifact = build_package(source, tmp_path / "extra.agent.pkg")
    control = plane(tmp_path)
    summary = control.open_file(str(artifact))
    codes = {item["code"] for item in summary["warnings"]}
    assert "requests_file_write_permission" in codes
    assert "requests_shell_permission" in codes
    # Unusual authority is still only a request: it defaults to deny like any other.
    request = control.permissions(summary["session"]["id"])
    assert {item["decision"] for item in request["permissions"]} == {"deny"}


def test_concurrent_opens_cannot_exceed_the_session_limit(tmp_path):
    import threading

    control = plane(tmp_path, max_sessions=2)
    errors: list[str] = []

    def open_one():
        try:
            control.open_file(str(DIST["meeting-agenda"]))
        except ControlPlaneError as exc:
            errors.append(exc.code)

    threads = [threading.Thread(target=open_one) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    sessions = control.list_sessions()["sessions"]
    assert len(sessions) <= 2
    assert len(sessions) + len(errors) == 6
    assert set(errors) == {"session_limit_reached"}
    assert len(list((tmp_path / "cache").glob("session-*"))) == len(sessions)
