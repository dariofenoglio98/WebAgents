"""The experimental rel="agent-package" hint and the /agent.pkg route."""

import hashlib
from urllib.parse import urljoin

import pytest
from fastapi.testclient import TestClient
from htmltools import Page

from origin import __main__ as cli
from origin.agent_package import MAX_PACKAGE_BYTES, MEDIA_TYPE, AgentPackageConfigError
from origin.app import create_app

EXPECTED_LINK = {"rel": "agent-package", "type": MEDIA_TYPE, "href": "/agent.pkg"}
BOOKING_FORM = {
    "fare_id": "WA101-20261009-STANDARD",
    "passengers": "1",
    "given_name_1": "Ada",
    "family_name_1": "Lovelace",
    "contact_email": "ada@example.com",
}

GET_PAGES = [
    ("/", 200),
    ("/flights", 200),
    ("/results?origin=BOS&destination=ZRH&date=2026-10-09&passengers=1", 200),
    ("/results?origin=BOS&destination=BOS&date=2026-10-09", 422),
    ("/flight/WA101-20261009?passengers=1", 200),
    ("/fare/WA101-20261009-STANDARD?passengers=1", 200),
    ("/passenger?fare_id=WA101-20261009-STANDARD&passengers=1", 200),
    ("/flight/WA999-20261009", 404),
    ("/no-such-page", 404),
]


def every_page(client):
    """(url, html) for every kind of page the site renders, including error pages."""
    pages = []
    for url, status in GET_PAGES:
        response = client.get(url)
        assert response.status_code == status, url
        pages.append((url, response.text))
    payment = client.post("/payment", data=BOOKING_FORM)
    assert payment.status_code == 200
    pages.append(("/payment", payment.text))
    form = Page(payment.text).form("/confirmation").values()
    confirmation = client.post("/confirmation", data=form)
    assert confirmation.status_code == 200
    pages.append(("/confirmation", confirmation.text))
    invalid = client.post("/payment", data=BOOKING_FORM | {"contact_email": "x"})
    assert invalid.status_code == 422
    pages.append(("/payment", invalid.text))
    return pages


# --- the <link> hint --------------------------------------------------------------------------


def test_every_page_advertises_exactly_one_agent_package_link_in_head(client):
    pages = every_page(client)
    assert len(pages) == len(GET_PAGES) + 3
    for url, html in pages:
        page = Page(html)
        links = page.agent_package_links()
        assert len(links) == 1, url
        attributes, in_head = links[0]
        assert in_head, url
        assert attributes == EXPECTED_LINK, url
        assert html.count('rel="agent-package"') == 2, "the link itself plus the footer mention"
        others = [a for a, _ in page.link_elements if a not in (attributes,)]
        assert others == [{"rel": "stylesheet", "href": "/static/webair.css"}], url
        assert page.bases == [], "no <base> element may redirect the relative href"


@pytest.mark.parametrize(
    "page_url",
    [
        "http://webair.test/",
        "http://webair.test/results?origin=BOS&destination=ZRH&date=2026-10-09",
        "http://webair.test/flight/WA101-20261009?passengers=1",
        "http://webair.test/fare/WA101-20261009-STANDARD",
        "https://webair.example/fare/WA101-20261009-STANDARD?passengers=2",
        "http://127.0.0.1:8040/passenger?fare_id=WA101-20261009-STANDARD",
    ],
)
def test_relative_href_resolves_to_the_pages_own_origin(page_url):
    scheme_host = page_url.split("/", 3)[:3]
    assert urljoin(page_url, EXPECTED_LINK["href"]) == "/".join(scheme_host) + "/agent.pkg"


def test_hint_is_presented_as_an_experimental_demo_convention(client):
    text = Page(client.get("/").text).text
    assert "experimental agent-native interface" in text
    assert "a WebAgents demo convention" in text
    assert 'rel="agent-package"' in text


def test_csp_pins_base_uri(client):
    assert "base-uri 'none'" in client.get("/").headers["content-security-policy"]


# --- /agent.pkg before a package exists -------------------------------------------------------


def test_agent_pkg_is_unavailable_until_a_package_is_configured(client):
    response = client.get("/agent.pkg")
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/json"
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["error"]["code"] == "agent_package_unavailable"
    assert "experimental" in response.json()["error"]["message"]
    head = client.head("/agent.pkg")
    assert head.status_code == 404
    assert client.app.state.agent_package is None


def test_no_package_artifact_ships_with_the_origin():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    shipped = [p for p in root.rglob("*") if p.suffix == ".pkg" and ".venv" not in p.parts]
    assert shipped == []


# --- /agent.pkg with an explicitly configured artifact ----------------------------------------


def test_configured_package_is_served_byte_for_byte(package_client, package_bytes):
    response = package_client.get("/agent.pkg")
    assert response.status_code == 200
    assert response.content == package_bytes
    digest = hashlib.sha256(package_bytes).hexdigest()
    assert response.headers["content-type"] == MEDIA_TYPE
    assert response.headers["content-length"] == str(len(package_bytes))
    assert response.headers["x-agent-package-sha256"] == digest
    assert response.headers["etag"] == f'"sha256:{digest}"'
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-disposition"] == 'attachment; filename="webair.agent.pkg"'


def test_head_reports_the_package_without_a_body(package_client, package_bytes):
    response = package_client.head("/agent.pkg")
    assert response.status_code == 200
    assert response.content == b""
    assert response.headers["content-length"] == str(len(package_bytes))
    assert response.headers["content-type"] == MEDIA_TYPE


def test_package_bytes_are_snapshotted_at_startup(package_file, package_bytes):
    app = create_app(package_file)
    package_file.write_bytes(b"swapped after startup")
    with TestClient(app) as client:
        assert client.get("/agent.pkg").content == package_bytes
    package_file.unlink()
    with TestClient(app) as client:
        assert client.get("/agent.pkg").content == package_bytes


@pytest.mark.parametrize(
    "path",
    [
        "/agent.pkg/",
        "/agent.pkg/x",
        "/webair-fixture.agent.pkg",
        "/published/webair-fixture.agent.pkg",
        "/agent.pkg.bak",
        "/AGENT.PKG",
        "/static/",
        "/static",
        "/static/app.py",
        "/static/%2e%2e/app.py",
        "/static/..%2fapp.py",
        "/static/%2e%2e%2f%2e%2e%2fpyproject.toml",
        "/static/webair.css/../../origin/service.py",
        "/templates/base.html",
        "/origin/service.py",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/..%2f..%2fetc%2fpasswd",
        "/etc/passwd",
    ],
)
def test_no_other_file_is_reachable(package_client, package_file, path):
    sibling = package_file.parent / "secret.txt"
    sibling.write_text("must never be served")
    response = package_client.get(path)
    assert response.status_code == 404, path
    assert b"must never be served" not in response.content
    assert b"WEBAIR-TEST-FIXTURE" not in response.content
    assert b"import" not in response.content


@pytest.mark.parametrize(
    "query", ["?path=/etc/passwd", "?file=../../pyproject.toml", "?name=secret.txt"]
)
def test_query_parameters_cannot_select_another_file(package_client, package_bytes, query):
    response = package_client.get("/agent.pkg" + query)
    assert response.status_code == 200
    assert response.content == package_bytes


def test_agent_pkg_accepts_only_get_and_head(package_client):
    assert package_client.post("/agent.pkg", content=b"x").status_code == 405
    assert package_client.put("/agent.pkg", content=b"x").status_code == 405
    assert package_client.delete("/agent.pkg").status_code == 405


def test_misconfigured_packages_refuse_to_start(tmp_path):
    with pytest.raises(AgentPackageConfigError, match="not found"):
        create_app(tmp_path / "missing.agent.pkg")
    with pytest.raises(AgentPackageConfigError, match="regular file"):
        create_app(tmp_path)
    empty = tmp_path / "empty.agent.pkg"
    empty.write_bytes(b"")
    with pytest.raises(AgentPackageConfigError, match="bytes"):
        create_app(empty)
    huge = tmp_path / "huge.agent.pkg"
    with huge.open("wb") as stream:
        stream.truncate(MAX_PACKAGE_BYTES + 1)
    with pytest.raises(AgentPackageConfigError, match="bytes"):
        create_app(huge)


# --- command line configuration ---------------------------------------------------------------


@pytest.fixture
def captured_run(monkeypatch):
    calls = []
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, **kwargs: calls.append((app, kwargs)))
    return calls


def test_cli_without_a_package(monkeypatch, captured_run):
    monkeypatch.delenv("WEBAIR_AGENT_PACKAGE", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    assert cli.main([]) == 0
    app, options = captured_run[0]
    assert app.state.agent_package is None
    assert (options["host"], options["port"]) == ("127.0.0.1", 8040)
    # One bounded process, behind no trusted proxy.
    assert options["limit_concurrency"] == 64 and options["proxy_headers"] is False


def test_cli_takes_a_platform_assigned_port(monkeypatch, captured_run):
    monkeypatch.delenv("WEBAIR_AGENT_PACKAGE", raising=False)
    monkeypatch.setenv("PORT", "9123")
    assert cli.main(["--host", "0.0.0.0"]) == 0
    assert (captured_run[0][1]["host"], captured_run[0][1]["port"]) == ("0.0.0.0", 9123)
    assert cli.main(["--port", "9001"]) == 0
    assert captured_run[1][1]["port"] == 9001


def test_cli_publishes_the_configured_package(
    monkeypatch, captured_run, package_file, package_bytes
):
    monkeypatch.setenv("WEBAIR_AGENT_PACKAGE", str(package_file))
    assert cli.main([]) == 0
    assert captured_run[0][0].state.agent_package.data == package_bytes
    assert cli.main(["--agent-package", str(package_file), "--port", "9001"]) == 0
    assert captured_run[1][1]["port"] == 9001


def test_cli_refuses_a_bad_package_path(monkeypatch, captured_run, tmp_path, capsys):
    monkeypatch.delenv("WEBAIR_AGENT_PACKAGE", raising=False)
    assert cli.main(["--agent-package", str(tmp_path / "nope.agent.pkg")]) == 2
    assert captured_run == []
    assert "not found" in capsys.readouterr().err
