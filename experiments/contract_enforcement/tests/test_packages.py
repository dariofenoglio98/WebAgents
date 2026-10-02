"""The two packages: the exact shipped bytes, and artifacts rebuilt the way agentpkg builds them."""

from __future__ import annotations

import hashlib
import json
import re

import pytest

from harness import artifacts
from harness.paths import PACKAGES, ROOT


def published_hashes() -> dict[str, str]:
    text = (ROOT / "dist" / "README.md").read_text()
    block = text.split("## SHA-256", 1)[1]
    return {name: digest for digest, name in re.findall(r"^([0-9a-f]{64})\s+(\S+)$", block, re.M)}


@pytest.mark.parametrize("package", list(PACKAGES))
def test_archive_is_the_published_release(package):
    spec = PACKAGES[package]
    data = spec["archive"].read_bytes()
    manifest = json.loads(artifacts.read_members(data)["MANIFEST.agent"])
    assert manifest["package_id"] == spec["package_id"]
    assert manifest["version"] == spec["version"]
    versioned = f"{package}-{spec['version']}.agent.pkg"
    assert data == (ROOT / "dist" / versioned).read_bytes()
    hashes = published_hashes()
    if versioned in hashes:
        assert hashlib.sha256(data).hexdigest() == hashes[versioned]


@pytest.mark.parametrize("package", list(PACKAGES))
def test_signer_is_the_published_publisher_key(package):
    from agentpkg.browser.trust import public_key_from_pem
    from agentpkg.signing import fingerprint

    spec = PACKAGES[package]
    signature = json.loads(
        artifacts.read_members(spec["archive"].read_bytes())["signatures/publisher.json"]
    )
    key = public_key_from_pem(spec["publisher_key"].read_bytes())
    assert signature["key_fingerprint"] == fingerprint(key)


@pytest.mark.parametrize("package", list(PACKAGES))
def test_container_round_trip_is_byte_identical(package):
    raw = PACKAGES[package]["archive"].read_bytes()
    assert artifacts.zip_bytes(artifacts.canonical_members(raw)) == raw


@pytest.mark.parametrize("package", list(PACKAGES))
def test_rebuild_matches_agentpkg_sign_byte_for_byte(package, tmp_path):
    """`artifacts.build(payload, key)` is what `agentpkg sign` makes of the unsigned build."""
    from agentpkg.signing import sign_package
    from cryptography.hazmat.primitives import serialization

    from harness.world import experiment_key

    key = experiment_key(7, "trusted-publisher")
    payload = artifacts.payload_of(PACKAGES[package]["archive"].read_bytes())
    unsigned = tmp_path / "unsigned.agent.pkg"
    unsigned.write_bytes(artifacts.build(payload, None))
    # An ephemeral test key, in pytest's temporary directory only.
    key_path = tmp_path / "experiment.pem"
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)  # agentpkg refuses a private key others can read
    signed = sign_package(unsigned, key_path, tmp_path / "signed.agent.pkg")
    assert signed.read_bytes() == artifacts.build(payload, key)


@pytest.mark.parametrize("package", list(PACKAGES))
def test_shipped_payload_is_already_canonical(package):
    """Rebuilding the shipped payload with its own signature reproduces the shipped bytes."""
    from agentpkg.package import archive_bytes

    raw = PACKAGES[package]["archive"].read_bytes()
    members = artifacts.read_members(raw)
    signature = json.loads(members[artifacts.SIGNATURE])
    payload = artifacts.payload_of(raw)
    assert {name: artifacts.canonical(name, data) for name, data in payload.items()} == payload
    assert archive_bytes(payload, signature) == raw


def test_resigned_artifact_loads_and_names_the_experiment_signer():
    from agentpkg.package import load_package_bytes

    from harness.world import experiment_key

    key = experiment_key(7, "trusted-publisher")
    archive = artifacts.build(
        artifacts.payload_of(PACKAGES["meeting-agenda"]["archive"].read_bytes()), key
    )
    package = load_package_bytes(archive)
    assert package.signature["key_fingerprint"] == artifacts.fingerprint_of(key)
