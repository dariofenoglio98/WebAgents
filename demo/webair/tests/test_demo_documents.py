"""The WebAgents demo documents beside the airline (T8, `origin/demo_documents.py`).

Configured with a directory, the origin serves exactly nine files read once at startup, each
at one fixed path with its media type and SHA-256; without one those paths answer 404; a missing
file or a link refuses to start; nothing else in the directory is reachable.
"""

import hashlib
import shutil

import pytest
from fastapi.testclient import TestClient

from origin.agent_package import MEDIA_TYPE
from origin.app import create_app
from origin.demo_documents import DOCUMENTS, DemoDocumentsConfigError
from publisher.contract import REPO_ROOT

SOURCES = {
    "agent-index.json": REPO_ROOT / "examples" / "agent-index.json",
    "model-catalog.json": REPO_ROOT / "examples" / "model-catalog.json",
    "policies/webagents-research.json": REPO_ROOT
    / "examples"
    / "policies"
    / "webagents-research.json",
    "packages/literature-review-0.2.9.agent.pkg": REPO_ROOT
    / "dist"
    / "literature-review-0.2.9.agent.pkg",
    "packages/literature-review-0.2.8.agent.pkg": REPO_ROOT
    / "dist"
    / "literature-review-0.2.8.agent.pkg",
    "packages/literature-review-0.2.7.agent.pkg": REPO_ROOT
    / "dist"
    / "literature-review-0.2.7.agent.pkg",
    "packages/literature-review-0.2.6.agent.pkg": REPO_ROOT
    / "dist"
    / "literature-review-0.2.6.agent.pkg",
    "packages/literature-review-0.2.5.agent.pkg": REPO_ROOT
    / "dist"
    / "literature-review-0.2.5.agent.pkg",
    "packages/travel-network-0.1.0.agent.pkg": REPO_ROOT
    / "dist"
    / "travel-network-0.1.0.agent.pkg",
}


@pytest.fixture
def directory(tmp_path):
    for name, source in SOURCES.items():
        target = tmp_path / "demo" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    (tmp_path / "demo" / "secret.txt").write_text("not served")
    return tmp_path / "demo"


def test_serves_exactly_the_nine_documents_with_their_media_types(directory):
    client = TestClient(create_app(None, directory))
    for path, (name, media_type, _limit) in DOCUMENTS.items():
        data = SOURCES[name].read_bytes()
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.content == data
        assert response.headers["content-type"].split(";")[0] == media_type
        assert response.headers["x-content-sha256"] == hashlib.sha256(data).hexdigest()
        assert response.headers["x-content-type-options"] == "nosniff"
    for package in ("0.2.9", "0.2.8", "0.2.7", "0.2.6", "0.2.5"):
        assert DOCUMENTS[f"/packages/literature-review-{package}.agent.pkg"][1] == MEDIA_TYPE
    assert DOCUMENTS["/packages/travel-network-0.1.0.agent.pkg"][1] == MEDIA_TYPE
    assert len(DOCUMENTS) == 9
    for path in (
        "/secret.txt",
        "/policies/",
        "/agent-index.json/",
        "/packages/../secret.txt",
        "/demo/agent-index.json",
    ):
        assert client.get(path).status_code == 404, path
    health = client.get("/health").json()
    assert (
        health["demo_documents"]["/agent-index.json"]
        == hashlib.sha256(SOURCES["agent-index.json"].read_bytes()).hexdigest()
    )


def test_without_a_directory_the_paths_answer_404():
    client = TestClient(create_app())
    for path in DOCUMENTS:
        response = client.get(path)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_published"
    assert client.get("/health").json()["demo_documents"] is None


def test_a_missing_file_or_a_link_refuses_to_start(directory, tmp_path):
    (directory / "agent-index.json").unlink()
    with pytest.raises(DemoDocumentsConfigError, match="missing"):
        create_app(None, directory)
    (directory / "agent-index.json").symlink_to(SOURCES["agent-index.json"])
    with pytest.raises(DemoDocumentsConfigError, match="not a regular file"):
        create_app(None, directory)
    with pytest.raises(DemoDocumentsConfigError, match="not found"):
        create_app(None, tmp_path / "nowhere")
