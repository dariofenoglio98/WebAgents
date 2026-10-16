"""The origin publishes the real signed WebAir package next to its HTML.

`create_app(<signed artifact>)` is exactly what `python -m origin --agent-package PATH`
runs. The test drives it in-process, for each signed version: the advertised link resolves
to `/agent.pkg`, which serves the artifact's exact bytes, and those bytes verify against
WebAir's pinned key. Choosing another version needs no origin change, only a different path;
the public deployment's bundle carries 0.6.0 (see `test_deploy_bundle.py`).
"""

import hashlib
from urllib.parse import urljoin

import pytest
from agentpkg.package import load_package_bytes
from agentpkg.signing import verify_package
from fastapi.testclient import TestClient
from htmltools import Page

from origin.agent_package import MEDIA_TYPE
from origin.app import create_app
from publisher.contract import REPO_ROOT

ARTIFACTS = {
    version: REPO_ROOT / "dist" / f"webair-{version}.agent.pkg"
    for version in ("0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0")
}
PUBLIC_KEY = REPO_ROOT / "examples" / "keys" / "webair-publisher.pub.pem"
FINGERPRINT = "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b"
ORIGIN = "http://webair.test"


@pytest.fixture(params=sorted(ARTIFACTS))
def version(request):
    return request.param


@pytest.fixture
def artifact_bytes(version):
    return ARTIFACTS[version].read_bytes()


@pytest.fixture
def publishing_client(version):
    with TestClient(create_app(ARTIFACTS[version]), base_url=ORIGIN) as client:
        yield client


def advertised(page_html):
    links = [
        attributes
        for attributes, in_head in Page(page_html).link_elements
        if attributes.get("rel") == "agent-package" and in_head
    ]
    assert len(links) == 1
    return links[0]


def test_every_page_advertises_the_package(publishing_client):
    for path in (
        "/",
        "/flights",
        "/results?origin=BOS&destination=ZRH&date=2026-10-09&passengers=1",
    ):
        response = publishing_client.get(path)
        assert response.status_code == 200, path
        link = advertised(response.text)
        assert link["type"] == MEDIA_TYPE
        assert urljoin(ORIGIN + path, link["href"]) == ORIGIN + "/agent.pkg"


def test_agent_pkg_serves_the_exact_signed_artifact(publishing_client, artifact_bytes):
    page = publishing_client.get("/")
    href = urljoin(ORIGIN + "/", advertised(page.text)["href"])
    response = publishing_client.get(href)
    digest = hashlib.sha256(artifact_bytes).hexdigest()
    assert response.status_code == 200
    assert response.content == artifact_bytes
    assert response.headers["content-type"] == MEDIA_TYPE
    assert response.headers["x-agent-package-sha256"] == digest
    assert response.headers["etag"] == f'"sha256:{digest}"'
    assert response.headers["content-length"] == str(len(artifact_bytes))
    head = publishing_client.head(href)
    assert head.status_code == 200 and head.content == b""
    assert head.headers["etag"] == response.headers["etag"]


def test_fetched_bytes_verify_against_the_pinned_webair_key(publishing_client, version, tmp_path):
    fetched = publishing_client.get("/agent.pkg").content
    copy = tmp_path / "fetched.agent.pkg"
    copy.write_bytes(fetched)
    report = verify_package(copy, PUBLIC_KEY)
    assert report["valid"] is True
    assert report["key_fingerprint"] == FINGERPRINT
    assert (report["package_id"], report["version"]) == ("org.webagents.webair", version)
    package = load_package_bytes(fetched)
    assert package.manifest["publisher"] == {
        "id": "webair-demo",
        "name": "WebAir (fictional demo airline)",
    }
    assert package.digest == report["digest"]


def test_the_human_site_still_works_while_publishing(publishing_client):
    results = publishing_client.get(
        "/results?origin=BOS&destination=ZRH&date=2026-10-09&passengers=1"
        "&nonstop_only=on&max_price_usd=900"
    )
    assert results.status_code == 200
    for price in ("704", "858", "749"):
        assert price in results.text
    fare = publishing_client.get("/fare/WA101-20261009-STANDARD")
    assert fare.status_code == 200 and "23" in fare.text


def test_no_package_means_404_not_a_fallback():
    with TestClient(create_app(), base_url=ORIGIN) as client:
        response = client.get("/agent.pkg")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "agent_package_unavailable"
