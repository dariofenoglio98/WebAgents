"""The public deployment's bundle: an allowlist that carries the origin and one signed package.

`deploy/bundle.py` assembles what Railway runs. These tests pin that it holds exactly the
origin's code, its runtime requirements, the platform configuration and the published package,
byte for byte; that it is reproducible; that the demo host's own configuration (its passengers,
payment methods and tool bindings) can never be part of it; and that the start command the
platform runs is the origin's own launcher on the published file.
"""

import hashlib
import importlib.util
import json
import tomllib
from pathlib import Path

import pytest

from publisher.contract import REPO_ROOT

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"
ARTIFACT = REPO_ROOT / "dist" / "webair-0.8.0.agent.pkg"
START = "python -m origin --host 0.0.0.0 --agent-package agent.pkg --demo-documents demo"
DEMO_DOCUMENTS = {
    "demo/agent-index.json",
    "demo/model-catalog.json",
    "demo/policies/webagents-research.json",
    "demo/packages/literature-review-0.2.9.agent.pkg",
    "demo/packages/literature-review-0.2.8.agent.pkg",
    "demo/packages/literature-review-0.2.7.agent.pkg",
    "demo/packages/literature-review-0.2.6.agent.pkg",
    "demo/packages/literature-review-0.2.5.agent.pkg",
    "demo/packages/travel-network-0.1.0.agent.pkg",
}


@pytest.fixture(scope="module")
def bundler():
    spec = importlib.util.spec_from_file_location("webair_bundle", DEPLOY / "bundle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_bundle_is_exactly_the_allowlist(bundler, tmp_path):
    manifest = bundler.assemble(ARTIFACT, tmp_path / "bundle")
    files = {entry["path"] for entry in manifest["files"]}
    origin = {
        f"origin/{path.relative_to(DEPLOY.parent / 'origin').as_posix()}"
        for path in (DEPLOY.parent / "origin").rglob("*")
        if path.is_file()
        and path.suffix in {".py", ".html", ".css"}
        and "__pycache__" not in path.parts
    }
    assert (
        files
        == {"railway.toml", "railpack.json", ".python-version", "requirements.txt", "agent.pkg"}
        | origin
        | DEMO_DOCUMENTS
    )
    written = {
        path.relative_to(tmp_path / "bundle").as_posix()
        for path in (tmp_path / "bundle").rglob("*")
        if path.is_file()
    }
    assert written == files | {"BUNDLE.json"}
    for name in ("host-resources.json", "host-bindings.json"):
        assert not any(Path(path).name == name for path in written)


def test_the_bundle_publishes_the_signed_artifact_byte_for_byte(bundler, tmp_path):
    manifest = bundler.assemble(ARTIFACT, tmp_path / "bundle")
    data = ARTIFACT.read_bytes()
    assert (tmp_path / "bundle" / "agent.pkg").read_bytes() == data
    assert manifest["agent_package"] == {
        "source": "webair-0.8.0.agent.pkg",
        "package_id": "org.webagents.webair",
        "version": "0.8.0",
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    with pytest.raises(SystemExit, match="SHA-256"):
        bundler.assemble(ARTIFACT, tmp_path / "other", expect_sha256="0" * 64)


def test_the_bundle_is_reproducible_and_never_overwrites(bundler, tmp_path):
    first = bundler.assemble(ARTIFACT, tmp_path / "a")
    second = bundler.assemble(ARTIFACT, tmp_path / "b")
    assert first == second
    assert (tmp_path / "a" / "BUNDLE.json").read_bytes() == (
        tmp_path / "b" / "BUNDLE.json"
    ).read_bytes()
    with pytest.raises(SystemExit, match="not empty"):
        bundler.assemble(ARTIFACT, tmp_path / "a")


def test_host_data_in_the_origin_tree_stops_the_bundle(bundler, tmp_path, monkeypatch):
    """A resource id, name, email or label of the demo host anywhere in the bundle refuses it."""
    origin = tmp_path / "origin"
    origin.mkdir()
    definitions = json.loads(bundler.HOST_RESOURCES.read_text())
    passenger = next(r for r in definitions["resources"] if "contact_email" in r["value"])
    (origin / "leak.py").write_text(f"CONTACT = {passenger['value']['contact_email']!r}\n")
    monkeypatch.setattr(bundler, "ORIGIN", origin)
    with pytest.raises(SystemExit, match="refusing to write host data"):
        bundler.assemble(ARTIFACT, tmp_path / "bundle")
    assert not (tmp_path / "bundle").exists()


def test_the_platform_starts_the_origin_on_the_published_file():
    railway = tomllib.loads((DEPLOY / "railway.toml").read_text())
    railpack = json.loads((DEPLOY / "railpack.json").read_text())
    assert railway["deploy"]["startCommand"] == START == railpack["deploy"]["startCommand"]
    assert railway["deploy"]["healthcheckPath"] == "/health"
    assert railway["build"]["builder"] == "RAILPACK"
    assert (DEPLOY / ".python-version").read_text().strip() == "3.13"
    # No secret, token or credential in the deployment configuration.
    for name in ("railway.toml", "railpack.json"):
        text = (DEPLOY / name).read_text().lower()
        assert not any(word in text for word in ("token", "secret", "password", "key"))


def test_the_bundle_carries_the_signed_demo_documents_and_the_bundled_origin_serves_them(
    bundler, tmp_path
):
    """T8: the index, the policy and the package it lists, verbatim, at their fixed paths."""
    from fastapi.testclient import TestClient

    from origin.app import create_app

    bundler.assemble(ARTIFACT, tmp_path / "bundle")
    sources = {
        "demo/agent-index.json": REPO_ROOT / "examples" / "agent-index.json",
        "demo/model-catalog.json": REPO_ROOT / "examples" / "model-catalog.json",
        "demo/policies/webagents-research.json": REPO_ROOT
        / "examples"
        / "policies"
        / "webagents-research.json",
        "demo/packages/literature-review-0.2.9.agent.pkg": REPO_ROOT
        / "dist"
        / "literature-review-0.2.9.agent.pkg",
        "demo/packages/literature-review-0.2.8.agent.pkg": REPO_ROOT
        / "dist"
        / "literature-review-0.2.8.agent.pkg",
        "demo/packages/literature-review-0.2.7.agent.pkg": REPO_ROOT
        / "dist"
        / "literature-review-0.2.7.agent.pkg",
        "demo/packages/literature-review-0.2.6.agent.pkg": REPO_ROOT
        / "dist"
        / "literature-review-0.2.6.agent.pkg",
        "demo/packages/literature-review-0.2.5.agent.pkg": REPO_ROOT
        / "dist"
        / "literature-review-0.2.5.agent.pkg",
        "demo/packages/travel-network-0.1.0.agent.pkg": REPO_ROOT
        / "dist"
        / "travel-network-0.1.0.agent.pkg",
    }
    for name, source in sources.items():
        assert (tmp_path / "bundle" / name).read_bytes() == source.read_bytes()
    client = TestClient(create_app(tmp_path / "bundle" / "agent.pkg", tmp_path / "bundle" / "demo"))
    for name, source in sources.items():
        response = client.get("/" + name.removeprefix("demo/"))
        assert response.status_code == 200
        assert response.content == source.read_bytes()
