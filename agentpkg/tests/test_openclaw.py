"""Adapter boundary tests; installed OpenClaw discovery is optional and offline."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from agentpkg.errors import AgentPkgError
from agentpkg.openclaw import stage_openclaw
from agentpkg.package import build_package
from agentpkg.signing import keygen, sign_package, verify_package


@pytest.fixture
def staged_inputs(tmp_path):
    source = Path(__file__).resolve().parents[2] / "agents" / "literature-review-legacy"
    archive = build_package(source, tmp_path / "literature-review.agent.pkg")
    private_key, public_key = tmp_path / "private.pem", tmp_path / "publisher.pem"
    keygen(private_key, public_key)
    sign_package(archive, private_key)
    return archive, public_key


def test_stage_verified_payload_and_real_skill_wrappers(staged_inputs, tmp_path):
    archive, key = staged_inputs
    workspace = tmp_path / "workspace"
    receipt = stage_openclaw(archive, workspace, trusted_key_path=key)
    snapshot = workspace / receipt["package_root"]
    assert (snapshot / "package.agent.pkg").read_bytes() == archive.read_bytes()
    checked = verify_package(snapshot / "package.agent.pkg", trusted_key=key)
    assert checked["digest"] == receipt["digest"]
    assert receipt["grants"] == {}
    assert receipt["native_openclaw_policy_enforcement"] is False
    assert json.loads((workspace / "agentpkg-installation.json").read_text()) == receipt
    for name, digest in receipt["materialized_sha256"].items():
        path = workspace / name
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
        assert path.stat().st_mode & 0o222 == 0
        assert path.stat().st_mode & 0o111 == 0
    for item in receipt["skills"]:
        wrapper = workspace / "skills" / item["openclaw_name"] / "SKILL.md"
        assert wrapper.is_file()
        assert f"name: {item['openclaw_name']}\n" in wrapper.read_text()
        assert (snapshot / "payload" / item["path"]).is_file()
    assert (workspace / "skills" / receipt["coordinator_skill"] / "SKILL.md").is_file()
    config = json.loads((snapshot / "adapter.json").read_text())
    assert (snapshot / config["graph"]).is_file()
    assert all((snapshot / item["path"]).is_file() for item in config["tools"])


def test_external_key_pin_required_before_any_staging(staged_inputs, tmp_path):
    archive, _ = staged_inputs
    other_private, other_public = tmp_path / "other-private.pem", tmp_path / "other.pem"
    keygen(other_private, other_public)
    workspace = tmp_path / "workspace"
    with pytest.raises(AgentPkgError):
        stage_openclaw(archive, workspace, trusted_key_path=other_public)
    assert not workspace.exists()


def test_unsigned_package_does_not_stage(tmp_path):
    source = Path(__file__).resolve().parents[2] / "agents" / "literature-review-legacy"
    archive = build_package(source, tmp_path / "unsigned.agent.pkg")
    private_key, public_key = tmp_path / "private.pem", tmp_path / "public.pem"
    keygen(private_key, public_key)
    workspace = tmp_path / "workspace"
    with pytest.raises(AgentPkgError):
        stage_openclaw(archive, workspace, trusted_key_path=public_key)
    assert not workspace.exists()


def test_existing_workspace_is_never_overwritten(staged_inputs, tmp_path):
    archive, key = staged_inputs
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    sentinel = workspace / "personal.txt"
    sentinel.write_text("preserve me")
    with pytest.raises(AgentPkgError, match="already exists"):
        stage_openclaw(archive, workspace, trusted_key_path=key)
    assert list(workspace.iterdir()) == [sentinel]
    assert sentinel.read_text() == "preserve me"


def test_symlink_workspace_or_parent_never_followed(staged_inputs, tmp_path):
    archive, key = staged_inputs
    outside = tmp_path / "outside"
    outside.mkdir()
    link = tmp_path / "link"
    link.symlink_to(outside, target_is_directory=True)
    for destination in (link, link / "new"):
        with pytest.raises(AgentPkgError):
            stage_openclaw(archive, destination, trusted_key_path=key)
    assert not list(outside.iterdir())


def test_input_symlink_rejected(staged_inputs, tmp_path):
    archive, key = staged_inputs
    link = tmp_path / "redirect.agent.pkg"
    link.symlink_to(archive)
    with pytest.raises(AgentPkgError, match="regular file"):
        stage_openclaw(link, tmp_path / "workspace", trusted_key_path=key)


def test_artifact_changed_after_verification_cannot_replace_snapshot(
    staged_inputs, tmp_path, monkeypatch
):
    archive, key = staged_inputs
    original = archive.read_bytes()
    from agentpkg import openclaw

    verify = openclaw.verify_package

    def mutate_original_after_verification(path, *, trusted_key):
        result = verify(path, trusted_key=trusted_key)
        archive.write_bytes(b"attacker changed the input path")
        return result

    monkeypatch.setattr(openclaw, "verify_package", mutate_original_after_verification)
    workspace = tmp_path / "workspace"
    receipt = stage_openclaw(archive, workspace, trusted_key_path=key)
    assert (workspace / receipt["package_root"] / "package.agent.pkg").read_bytes() == original


@pytest.mark.skipif(
    not shutil.which("openclaw") or os.environ.get("AGENTPKG_TEST_OPENCLAW") != "1",
    reason="Installed OpenClaw discovery is opt-in: AGENTPKG_TEST_OPENCLAW=1",
)
def test_installed_openclaw_discovers_staged_skills(staged_inputs, tmp_path):
    """Only `skills list`; no inference, auth resolution, personal config, or gateway."""
    archive, key = staged_inputs
    workspace = tmp_path / "workspace"
    receipt = stage_openclaw(archive, workspace, trusted_key_path=key)
    state = tmp_path / "isolated-state"
    state.mkdir()
    config = state / "openclaw.json"
    config.write_text(
        json.dumps(
            {
                "agents": {"defaults": {"workspace": str(workspace)}},
                "plugins": {"enabled": False},
                "gateway": {"port": 1},
            }
        )
    )
    env = {
        name: os.environ[name] for name in ("PATH", "TMPDIR", "SYSTEMROOT") if name in os.environ
    }
    env.update(
        {
            "OPENCLAW_STATE_DIR": str(state),
            "OPENCLAW_CONFIG_PATH": str(config),
            "OPENCLAW_WORKSPACE_DIR": str(workspace),
            "OPENCLAW_HOME": str(state),
            "NO_COLOR": "1",
        }
    )
    result = subprocess.run(
        [shutil.which("openclaw"), "skills", "list", "--json"],
        cwd=workspace,
        env=env,
        capture_output=True,
        text=True,
        timeout=55,
        check=True,
    )
    inventory = json.loads(result.stdout)
    names = {item["name"] for item in inventory["skills"]}
    assert receipt["coordinator_skill"] in names
    assert {item["openclaw_name"] for item in receipt["skills"]} <= names
