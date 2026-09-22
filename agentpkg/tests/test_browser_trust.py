"""Publisher trust is operator state, never package state."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError, TrustStore
from agentpkg.browser.trust import public_key_from_pem, raw_base64, read_public_key_file
from agentpkg.package import build_package
from agentpkg.signing import fingerprint, keygen, sign_package

ROOT = Path(__file__).resolve().parents[2]
DEV_KEY = ROOT / "examples/keys/workflow-publisher.pub.pem"
DEV_FINGERPRINT = "sha256:c7549e614dac7070e6b5b5355e7c2407e1185f831d7fff15670981229dd85a70"


def plane(tmp_path, **overrides) -> ControlPlane:
    return ControlPlane(
        ControlPlaneConfig(
            cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json", **overrides
        )
    )


def signed(tmp_path, *, name="meeting-agenda", label="one"):
    source = tmp_path / f"src-{label}"
    shutil.copytree(ROOT / "agents" / name, source)
    artifact = build_package(source, tmp_path / f"{label}.agent.pkg")
    private, public = tmp_path / f"{label}-private.pem", tmp_path / f"{label}-public.pem"
    keygen(private, public)
    sign_package(artifact, private)
    return artifact, public


def test_add_list_and_remove_use_the_key_fingerprint_as_identity(tmp_path):
    store = TrustStore(tmp_path / "trust.json")
    assert store.entries() == []
    entry = store.add(
        read_public_key_file(DEV_KEY),
        display_name="WebAgents development key",
        publisher_id="webagents-research",
        package_id_prefix="org.webagents.",
        notes="milestone demo pin",
    )
    assert entry.fingerprint == DEV_FINGERPRINT
    assert store.path.stat().st_mode & 0o777 == 0o600
    document = json.loads(store.path.read_text())
    assert document["format"] == "agentpkg-trust-store-v0"
    assert "PRIVATE" not in store.path.read_text()
    assert [item.fingerprint for item in store.entries()] == [DEV_FINGERPRINT]
    with pytest.raises(ControlPlaneError) as duplicate:
        store.add(read_public_key_file(DEV_KEY), display_name="again")
    assert duplicate.value.code == "trust_entry_exists"
    assert store.add(read_public_key_file(DEV_KEY), display_name="again", replace=True)
    assert len(store.entries()) == 1
    assert store.remove(DEV_FINGERPRINT).fingerprint == DEV_FINGERPRINT
    assert store.entries() == []
    with pytest.raises(ControlPlaneError) as missing:
        store.remove(DEV_FINGERPRINT)
    assert missing.value.code == "trust_entry_unknown"


def test_private_keys_are_refused(tmp_path):
    private, public = tmp_path / "private.pem", tmp_path / "public.pem"
    keygen(private, public)
    with pytest.raises(ControlPlaneError) as error:
        public_key_from_pem(private.read_bytes())
    assert error.value.code == "trust_private_key_refused"
    with pytest.raises(ControlPlaneError):
        public_key_from_pem(b"-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n")


def test_valid_signature_from_an_unknown_key_is_not_trusted(tmp_path):
    control = plane(tmp_path)
    artifact, _ = signed(tmp_path)
    summary = control.open_file(str(artifact))
    assert summary["publisher"]["signature_status"] == "valid"
    assert summary["publisher"]["trust_status"] == "unknown"
    assert summary["publisher"]["trust_reason"] == "signer_key_not_pinned"


def test_claimed_publisher_pinned_to_another_key_is_a_mismatch(tmp_path):
    """The package is signed by key A while the operator pinned key B for it."""
    control = plane(tmp_path)
    artifact, _ = signed(tmp_path)
    other_private, other_public = tmp_path / "other-private.pem", tmp_path / "other.pem"
    keygen(other_private, other_public)
    control.trust_add(
        read_public_key_file(other_public),
        display_name="Pinned key for this publisher",
        publisher_id="webagents-research",
    )
    summary = control.open_file(str(artifact))
    assert summary["publisher"]["signature_status"] == "valid"
    assert summary["publisher"]["trust_status"] == "mismatch"
    assert summary["publisher"]["trust_reason"] == "claimed_publisher_pinned_to_other_key"
    assert summary["publisher"]["pinned_fingerprints_for_claimed_publisher"]
    assert "publisher_mismatch" in {item["code"] for item in summary["warnings"]}


def test_pinned_key_bound_to_a_different_publisher_is_a_mismatch(tmp_path):
    control = plane(tmp_path)
    artifact, public = signed(tmp_path)
    control.trust_add(
        read_public_key_file(public),
        display_name="Pinned for someone else",
        publisher_id="another-organisation",
    )
    summary = control.open_file(str(artifact))
    assert summary["publisher"]["trust_status"] == "mismatch"
    assert summary["publisher"]["trust_reason"] == "pinned_key_bound_to_other_publisher"


def test_pinned_prefix_scopes_which_packages_a_key_may_sign(tmp_path):
    control = plane(tmp_path)
    artifact, public = signed(tmp_path)
    control.trust_add(
        read_public_key_file(public),
        display_name="Narrow pin",
        publisher_id="webagents-research",
        package_id_prefix="com.other.",
    )
    summary = control.open_file(str(artifact))
    assert summary["publisher"]["trust_status"] == "mismatch"
    assert summary["publisher"]["trust_reason"] == "package_id_outside_pinned_prefix"


def test_unsigned_and_invalid_signatures_can_never_become_trusted(tmp_path):
    control = plane(tmp_path)
    source = tmp_path / "unsigned-src"
    shutil.copytree(ROOT / "agents/meeting-agenda", source)
    artifact = build_package(source, tmp_path / "unsigned.agent.pkg")
    control.trust_add(
        read_public_key_file(DEV_KEY),
        display_name="WebAgents development key",
        publisher_id="webagents-research",
    )
    summary = control.open_file(str(artifact))
    assert summary["publisher"]["signature_status"] == "absent"
    assert summary["publisher"]["trust_status"] == "unknown"
    assert summary["publisher"]["trust_reason"] == "no_valid_signature"


def test_opening_and_authorizing_never_touch_the_trust_store(tmp_path):
    """No package operation can add itself to, or alter, operator trust."""
    control = plane(tmp_path)
    control.trust_add(read_public_key_file(DEV_KEY), display_name="WebAgents development key")
    store_path = tmp_path / "trust.json"
    before = store_path.read_bytes()
    before_state = control.trust.state()
    summary = control.open_file(str(ROOT / "dist/literature-review.agent.pkg"))
    control.permissions(summary["session"]["id"])
    control.authorize(
        summary["session"]["id"],
        package_digest=summary["package"]["digest"],
        decisions={"memory.session": "session"},
    )
    assert store_path.read_bytes() == before
    assert control.trust.state() == before_state
    assert [entry.fingerprint for entry in control.trust.entries()] == [DEV_FINGERPRINT]


def test_trust_state_changes_are_visible_in_later_receipts(tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(ROOT / "dist/meeting-agenda.agent.pkg"))
    first = control.authorize(
        summary["session"]["id"], package_digest=summary["package"]["digest"], decisions={}
    )
    control.trust_add(
        read_public_key_file(DEV_KEY),
        display_name="WebAgents development key",
        publisher_id="webagents-research",
    )
    second = control.authorize(
        summary["session"]["id"], package_digest=summary["package"]["digest"], decisions={}
    )
    assert first["trust_store"]["state_sha256"] != second["trust_store"]["state_sha256"]
    assert first["trust_store"]["entry_count"] == 0
    assert second["trust_store"]["entry_count"] == 1


def test_a_corrupted_trust_store_fails_closed(tmp_path):
    store = TrustStore(tmp_path / "trust.json")
    store.add(read_public_key_file(DEV_KEY), display_name="WebAgents development key")
    document = json.loads(store.path.read_text())
    document["publishers"][0]["fingerprint"] = "sha256:" + "0" * 64
    store.path.write_text(json.dumps(document))
    with pytest.raises(ControlPlaneError, match="does not match its key"):
        store.entries()
    store.path.write_text(json.dumps({"format": "other", "publishers": []}))
    with pytest.raises(ControlPlaneError, match="format"):
        store.entries()


def test_generated_and_pinned_fingerprints_agree(tmp_path):
    private, public = tmp_path / "private.pem", tmp_path / "public.pem"
    report = keygen(private, public)
    key = read_public_key_file(public)
    assert fingerprint(key) == report["key_fingerprint"]
    store = TrustStore(tmp_path / "trust.json")
    entry = store.add(key, display_name="local")
    assert entry.fingerprint == report["key_fingerprint"]
    assert fingerprint(entry.key()) == report["key_fingerprint"]


# -- pinning the signer of an open session -----------------------------------
def test_session_publisher_pin_uses_the_key_already_under_review(tmp_path):
    """The operator pins what the control plane verified; no key material travels."""
    control = plane(tmp_path)
    artifact, public = signed(tmp_path)
    summary = control.open_file(str(artifact))
    session_id = summary["session"]["id"]
    assert summary["publisher"]["trust_status"] == "unknown"
    fingerprint_value = summary["publisher"]["signer_fingerprint"]

    result = control.trust_session_publisher(
        session_id, signer_fingerprint=fingerprint_value, scope="package"
    )
    assert result["added"]["fingerprint"] == fingerprint_value
    assert result["added"]["public_key"] == raw_base64(read_public_key_file(public))
    assert result["added"]["publisher_id"] == "webagents-research"
    # The narrow default scopes the pin to this exact package id.
    assert result["added"]["package_id_prefix"] == "org.webagents.meeting-agenda"
    assert result["publisher"]["trust_status"] == "trusted"
    # The already-open session reflects the new trust without reopening.
    assert control.summary(session_id)["publisher"]["trust_status"] == "trusted"
    assert "publisher_unknown" not in {
        item["code"] for item in control.summary(session_id)["warnings"]
    }


def test_publisher_scope_is_broader_and_explicit(tmp_path):
    control = plane(tmp_path)
    artifact, _ = signed(tmp_path)
    summary = control.open_file(str(artifact))
    result = control.trust_session_publisher(
        summary["session"]["id"],
        signer_fingerprint=summary["publisher"]["signer_fingerprint"],
        scope="publisher",
    )
    assert result["added"]["package_id_prefix"] is None
    assert result["added"]["publisher_id"] == "webagents-research"
    with pytest.raises(ControlPlaneError, match="scope"):
        control.trust_session_publisher(
            summary["session"]["id"],
            signer_fingerprint=summary["publisher"]["signer_fingerprint"],
            scope="everything",
        )


def test_session_pin_requires_the_displayed_fingerprint(tmp_path):
    control = plane(tmp_path)
    artifact, _ = signed(tmp_path)
    summary = control.open_file(str(artifact))
    with pytest.raises(ControlPlaneError) as error:
        control.trust_session_publisher(
            summary["session"]["id"], signer_fingerprint="sha256:" + "0" * 64
        )
    assert error.value.code == "fingerprint_mismatch"
    assert control.trust.entries() == []


def test_session_pin_refuses_an_unsigned_or_invalid_package(tmp_path):
    control = plane(tmp_path)
    source = tmp_path / "unsigned-src"
    shutil.copytree(ROOT / "agents/meeting-agenda", source)
    artifact = build_package(source, tmp_path / "unsigned.agent.pkg")
    summary = control.open_file(str(artifact))
    with pytest.raises(ControlPlaneError) as error:
        control.trust_session_publisher(
            summary["session"]["id"], signer_fingerprint="sha256:" + "0" * 64
        )
    assert error.value.code == "signature_not_valid"
    assert control.trust.entries() == []


def test_removing_a_pin_downgrades_open_sessions(tmp_path):
    control = plane(tmp_path)
    artifact, _ = signed(tmp_path)
    summary = control.open_file(str(artifact))
    session_id = summary["session"]["id"]
    fingerprint_value = summary["publisher"]["signer_fingerprint"]
    control.trust_session_publisher(session_id, signer_fingerprint=fingerprint_value)
    assert control.summary(session_id)["publisher"]["trust_status"] == "trusted"
    control.trust_remove(fingerprint_value)
    assert control.summary(session_id)["publisher"]["trust_status"] == "unknown"


def test_a_receipt_keeps_the_trust_state_it_was_issued_under(tmp_path):
    """Pinning later must not retroactively rewrite recorded consent."""
    control = plane(tmp_path)
    artifact, _ = signed(tmp_path)
    summary = control.open_file(str(artifact))
    session_id, digest = summary["session"]["id"], summary["package"]["digest"]
    before = control.authorize(session_id, package_digest=digest, decisions={})
    assert before["publisher"]["trust_status"] == "unknown"
    control.trust_session_publisher(
        session_id, signer_fingerprint=summary["publisher"]["signer_fingerprint"]
    )
    assert control.authorization(session_id)["publisher"]["trust_status"] == "unknown"
    after = control.authorize(session_id, package_digest=digest, decisions={})
    assert after["publisher"]["trust_status"] == "trusted"
    assert after["trust_store"]["state_sha256"] != before["trust_store"]["state_sha256"]
