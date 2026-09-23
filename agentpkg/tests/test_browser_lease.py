"""How immutable package bytes leave the control plane, and when they may not.

A lease is the one operation that lets a snapshot out. Everything here is about
the conditions attached to it: it exists only while a run plan is ready, there
is at most one at a time, it is a private copy rather than the snapshot itself,
and it disappears the moment the decision behind it changes.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from agentpkg.browser import ControlPlane, ControlPlaneConfig
from agentpkg.browser.errors import ControlPlaneError
from agentpkg.browser.lease import LEASE_PREFIX
from agentpkg.browser.trust import read_public_key_file
from agentpkg.package import sha256

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "dist/meeting-agenda.agent.pkg"
PUBLIC_KEY = ROOT / "examples/keys/workflow-publisher.pub.pem"

CATALOG = {
    "schema": "agentpkg-host-model-catalog-v0",
    "host": {"runtime": "test", "source": "test", "captured_at": "2026-09-22T10:00:00+00:00"},
    "models": [
        {
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
    ],
    "notes": [],
}


@pytest.fixture
def ready(tmp_path):
    """An open, trusted, authorized session with a ready run plan."""
    control = ControlPlane(
        ControlPlaneConfig(
            cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json"
        )
    )
    control.trust_add(
        read_public_key_file(PUBLIC_KEY),
        display_name="development key",
        publisher_id="webagents-research",
    )
    summary = control.open_file(str(ARTIFACT))
    session_id = summary["session"]["id"]
    digest = summary["package"]["digest"]
    receipt = control.authorize(
        session_id,
        package_digest=digest,
        decisions={"model.reasoning": "session", "memory.session": "session"},
    )
    state = control.prepare_run_plan(
        session_id,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id="host/alpha",
        catalog=CATALOG,
    )
    plan = state["run_plan"]
    assert plan["readiness"]["ready"]
    return control, session_id, digest, receipt, plan


def issue(control, session_id, digest, plan):
    return control.issue_execution_lease(
        session_id,
        package_digest=digest,
        run_plan_id=plan["run_plan_id"],
        run_plan_sha256=plan["run_plan_sha256"],
    )


def test_a_lease_is_a_private_copy_of_the_exact_snapshot(ready):
    control, session_id, digest, _, plan = ready
    result = issue(control, session_id, digest, plan)
    lease = result["lease"]
    path = Path(lease["path"])

    assert path.is_file() and not path.is_symlink()
    assert os.stat(path).st_mode & 0o777 == 0o400
    assert os.stat(path.parent).st_mode & 0o777 == 0o700
    assert path.parent.name.startswith(LEASE_PREFIX)
    assert sha256(path.read_bytes()) == lease["archive_sha256"]
    assert lease["archive_sha256"] == sha256(ARTIFACT.read_bytes())
    assert lease["package_digest"] == digest
    assert lease["run_plan_sha256"] == plan["run_plan_sha256"]
    assert result["execution"]["performed"] is False

    # It is a copy: the snapshot the control plane answers from still exists.
    snapshot = path.parent.parent / "package.agent.pkg"
    assert snapshot.is_file() and snapshot.read_bytes() == path.read_bytes()
    assert snapshot != path


def test_a_lease_needs_the_plan_the_caller_read(ready):
    control, session_id, digest, _, plan = ready
    with pytest.raises(ControlPlaneError) as wrong_hash:
        control.issue_execution_lease(
            session_id,
            package_digest=digest,
            run_plan_id=plan["run_plan_id"],
            run_plan_sha256="0" * 64,
        )
    assert wrong_hash.value.code == "run_plan_mismatch"

    with pytest.raises(ControlPlaneError) as wrong_id:
        control.issue_execution_lease(
            session_id,
            package_digest=digest,
            run_plan_id="rp_other",
            run_plan_sha256=plan["run_plan_sha256"],
        )
    assert wrong_id.value.code == "run_plan_mismatch"


def test_a_lease_needs_the_digest_the_caller_showed(ready):
    control, session_id, _, _, plan = ready
    with pytest.raises(ControlPlaneError) as error:
        control.issue_execution_lease(
            session_id,
            package_digest="0" * 64,
            run_plan_id=plan["run_plan_id"],
            run_plan_sha256=plan["run_plan_sha256"],
        )
    assert error.value.code == "digest_mismatch"


def test_no_plan_means_no_lease(tmp_path):
    control = ControlPlane(
        ControlPlaneConfig(
            cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json"
        )
    )
    summary = control.open_file(str(ARTIFACT))
    with pytest.raises(ControlPlaneError) as error:
        control.issue_execution_lease(
            summary["session"]["id"],
            package_digest=summary["package"]["digest"],
            run_plan_id="rp_none",
            run_plan_sha256="0" * 64,
        )
    assert error.value.code == "run_plan_absent"


def test_only_one_lease_is_outstanding_at_a_time(ready):
    control, session_id, digest, _, plan = ready
    first = issue(control, session_id, digest, plan)
    with pytest.raises(ControlPlaneError) as error:
        issue(control, session_id, digest, plan)
    assert error.value.code == "execution_lease_active"
    assert error.value.details["lease_id"] == first["lease"]["lease_id"]

    control.release_execution_lease(session_id, first["lease"]["lease_id"])
    second = issue(control, session_id, digest, plan)
    assert second["lease"]["lease_id"] != first["lease"]["lease_id"]


def test_releasing_a_lease_deletes_its_copy(ready):
    control, session_id, digest, _, plan = ready
    lease = issue(control, session_id, digest, plan)["lease"]
    path = Path(lease["path"])
    assert path.is_file()

    released = control.release_execution_lease(session_id, lease["lease_id"])
    assert released["released"] is True
    assert not path.exists() and not path.parent.exists()

    # Releasing twice is not an error; it is the same end state.
    assert control.release_execution_lease(session_id, lease["lease_id"])["released"] is False


def test_a_stale_plan_cannot_be_leased(ready):
    """Trust withdrawn after preparation: the plan is stale, so nothing leaves."""
    control, session_id, digest, _, plan = ready
    fingerprint = control.trust_list()["publishers"][0]["fingerprint"]
    control.trust_remove(fingerprint)
    with pytest.raises(ControlPlaneError) as error:
        issue(control, session_id, digest, plan)
    assert error.value.code == "run_plan_stale"


def test_re_authorizing_discards_an_outstanding_lease(ready):
    control, session_id, digest, _, plan = ready
    lease = issue(control, session_id, digest, plan)["lease"]
    path = Path(lease["path"])
    assert path.is_file()

    control.authorize(
        session_id,
        package_digest=digest,
        decisions={"model.reasoning": "session", "memory.session": "deny"},
    )
    assert not path.exists(), "a lease survived the consent it was issued under"


def test_clearing_the_run_plan_discards_an_outstanding_lease(ready):
    control, session_id, digest, _, plan = ready
    path = Path(issue(control, session_id, digest, plan)["lease"]["path"])
    control.clear_run_plan(session_id)
    assert not path.exists()


def test_closing_a_session_discards_its_leases(ready):
    control, session_id, digest, _, plan = ready
    path = Path(issue(control, session_id, digest, plan)["lease"]["path"])
    control.close(session_id)
    assert not path.exists()


def test_an_expired_lease_is_swept(ready, monkeypatch):
    control, session_id, digest, _, plan = ready
    path = Path(issue(control, session_id, digest, plan)["lease"]["path"])
    session = control._sessions[session_id]
    lease = next(iter(session.leases.values()))
    lease.expires_monotonic = 0.0
    control.purge_expired()
    assert not path.exists()
    assert session.leases == {}
    # And a new one can then be issued.
    assert issue(control, session_id, digest, plan)["lease"]["lease_id"] != lease.lease_id


def test_the_lease_ttl_never_outlives_the_session(tmp_path):
    control = ControlPlane(
        ControlPlaneConfig(
            cache_dir=tmp_path / "cache",
            trust_store_path=tmp_path / "trust.json",
            session_ttl_seconds=60,
            execution_lease_ttl_seconds=9000,
        )
    )
    control.trust_add(
        read_public_key_file(PUBLIC_KEY),
        display_name="development key",
        publisher_id="webagents-research",
    )
    summary = control.open_file(str(ARTIFACT))
    session_id = summary["session"]["id"]
    digest = summary["package"]["digest"]
    receipt = control.authorize(
        session_id,
        package_digest=digest,
        decisions={"model.reasoning": "session", "memory.session": "session"},
    )
    plan = control.prepare_run_plan(
        session_id,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id="host/alpha",
        catalog=CATALOG,
    )["run_plan"]
    issue(control, session_id, digest, plan)
    lease = next(iter(control._sessions[session_id].leases.values()))
    session = control._sessions[session_id]
    assert lease.expires_monotonic <= session.expires_monotonic + 1


def test_the_control_plane_still_reports_that_it_executes_nothing(ready):
    control, session_id, digest, _, plan = ready
    issue(control, session_id, digest, plan)
    status = control.status()
    assert status["execution"] == "disabled"
    assert status["capabilities"]["execute"] is False
    assert status["capabilities"]["issue_execution_lease"] is True
    assert status["open_execution_leases"] == 1
