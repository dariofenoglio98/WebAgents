import httpx
import pytest

from app.config import Settings


def no_network(request):
    raise AssertionError(f"Unexpected upstream call: {request.url.host}")


def test_health(client_factory):
    client = client_factory(no_network)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "citation-resolver"}


def test_skill_local_origin_and_frontmatter(client_factory):
    client = client_factory(no_network)
    response = client.get("/SKILL.md")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    assert response.text.startswith("---\nname: citation-resolver\ndescription:")
    assert "{{BASE_URL}}" not in response.text
    assert "http://testserver/resolve" in response.text
    for term in ("10.1038/nphys1170", "1706.03762", "Attention Is All You Need", "ambiguous"):
        assert term in response.text


def test_skill_public_origin_ignores_forwarded_headers(client_factory):
    settings = Settings(public_base_url="https://resolver.example", allowed_hosts=("testserver",))
    client = client_factory(no_network, settings)
    response = client.get(
        "/SKILL.md",
        headers={
            "X-Forwarded-Host": "evil.test",
            "X-Forwarded-Proto": "ftp",
            "Forwarded": "host=evil.test;proto=ftp",
        },
    )
    assert "https://resolver.example/resolve" in response.text
    assert "evil.test" not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_untrusted_host_rejected(client_factory):
    client = client_factory(no_network)
    assert client.get("/SKILL.md", headers={"Host": "evil.test"}).status_code == 400


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"query": ""},
        {"query": "   "},
        {"query": 123},
        {"query": "a" * 501},
        {"query": "a", "query_type": "bad"},
        {"query": "a", "format": "apa"},
        {"query": "a", "unexpected": "field"},
        {"query": "bad", "query_type": "doi"},
        {"query": "12345", "query_type": "arxiv"},
        {"query": "https://127.0.0.1/private"},
        {"query": "\x00"},
        {"query": "!!!", "query_type": "title"},
    ],
)
def test_invalid_requests_are_agent_readable_400(client_factory, body):
    response = client_factory(no_network).post("/resolve", json=body)
    assert response.status_code == 400
    assert response.json()["status"] == "invalid_request"
    assert response.json()["message"]


def test_malformed_json(client_factory):
    response = client_factory(no_network).post(
        "/resolve", content="{broken", headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 400
    assert response.json()["status"] == "invalid_request"


def test_exact_doi_uses_one_request_and_contact(client_factory, crossref_record):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.host == "api.crossref.org"
        assert request.url.params["mailto"] == "operator@example.invalid"
        assert "mailto:operator@example.invalid" in request.headers["User-Agent"]
        return httpx.Response(200, json={"message": crossref_record})

    settings = Settings(contact_email="operator@example.invalid", allowed_hosts=("testserver",))
    response = client_factory(handler, settings).post(
        "/resolve",
        json={
            "query": "https://doi.org/10.1234/EXAMPLE",
            "format": "bibtex",
        },
    )
    data = response.json()
    assert response.status_code == 200
    assert len(calls) == 1
    assert data["status"] == "resolved" and data["match_score"] == 1
    assert data["detected_type"] == "doi"
    paper = data["best_match"]
    assert paper["doi"] == "10.1234/example"
    assert paper["authors"][0]["family"] == "Researcher"
    assert paper["year"] == 2020 and paper["source"] == "crossref"
    assert paper["abstract"] == "Verified & structured."
    assert "@article" in paper["bibtex"]


@pytest.mark.parametrize("primary_status", [404, 429, 503, 403])
def test_doi_fallback(client_factory, openalex_record, primary_status):
    calls = []

    def handler(request):
        calls.append(request.url.host)
        if request.url.host == "api.crossref.org":
            return httpx.Response(primary_status)
        return httpx.Response(200, json=openalex_record)

    response = client_factory(handler).post("/resolve", json={"query": "10.1234/example"})
    data = response.json()
    assert response.status_code == 200
    assert data["best_match"]["source"] == "openalex"
    assert data["best_match"]["abstract"] == "Verified and structured."
    assert data["best_match"]["publisher"] is None
    assert calls == ["api.crossref.org", "api.openalex.org"]
    assert bool(data["warnings"]) == (primary_status != 404)


def test_identifier_mismatch_never_resolves_wrong_record(client_factory, crossref_record):
    def handler(request):
        if request.url.host == "api.crossref.org":
            return httpx.Response(200, json={"message": crossref_record})
        return httpx.Response(404)

    response = client_factory(handler).post("/resolve", json={"query": "10.1234/different"})
    assert response.status_code == 502
    assert response.json()["sources"][0]["error_code"] == "identifier_mismatch"
    assert response.json()["best_match"] is None


def test_exact_arxiv_and_cache_do_not_leak_bibtex(client_factory, arxiv_feed):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.host == "export.arxiv.org"
        assert request.url.params["id_list"] == "1706.03762"
        return httpx.Response(200, content=arxiv_feed)

    client = client_factory(handler)
    response = client.post("/resolve", json={"query": "1706.03762", "format": "bibtex"})
    paper = response.json()["best_match"]
    assert response.status_code == 200
    assert response.json()["match_score"] == 1
    assert paper["arxiv_id"] == "1706.03762v2"
    assert paper["year"] == 2017
    assert paper["venue"] is None
    assert paper["journal_reference"] == "Example Journal 4 (2018) 1-9"
    assert paper["authors"][0]["family"] is None
    assert "eprint = {1706.03762v2}" in paper["bibtex"]
    second = client.post("/resolve", json={"query": "1706.03762"})
    assert second.json()["best_match"]["bibtex"] is None
    assert len(calls) == 1


def test_arxiv_explicit_version_must_match(client_factory, arxiv_feed):
    client = client_factory(lambda r: httpx.Response(200, content=arxiv_feed))
    response = client.post("/resolve", json={"query": "1706.03762v1"})
    assert response.status_code == 502
    assert response.json()["sources"][0]["error_code"] == "identifier_mismatch"


def test_strong_title_avoids_extra_requests(client_factory, openalex_record):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.host == "api.openalex.org"
        assert request.url.params["search"] == "a study of reliable citations"
        return httpx.Response(200, json={"results": [openalex_record]})

    response = client_factory(handler).post(
        "/resolve",
        json={
            "query": "A STUDY of Reliable Citations!",
            "format": "bibtex",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "resolved"
    assert response.json()["match_score"] == 1
    assert len(calls) == 1
    assert response.json()["best_match"]["bibtex"]


def test_ambiguous_response_and_alternative_bibtex(
    client_factory,
    openalex_record,
    changed_record,
):
    records = [
        changed_record(
            openalex_record, doi=f"https://doi.org/10.1234/c{i}", id=f"https://openalex.org/W{i}"
        )
        for i in range(5)
    ]

    def handler(request):
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json={"results": records})
        return httpx.Response(200, json={"message": {"items": []}})

    response = client_factory(handler).post(
        "/resolve",
        json={
            "query": "A Study of Reliable Citations",
            "format": "bibtex",
        },
    )
    data = response.json()
    assert response.status_code == 200 and data["status"] == "ambiguous"
    assert len(data["alternatives"]) == 3
    assert data["alternatives"][0]["paper"]["bibtex"]
    assert data["match_score"] == 1
    assert len(data["sources"]) == 2


def test_single_uncertain_candidate_is_ambiguous(client_factory, openalex_record):
    def handler(request):
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json={"results": [openalex_record]})
        return httpx.Response(200, json={"message": {"items": []}})

    response = client_factory(handler).post("/resolve", json={"query": "Study Reliable Citations"})
    assert response.json()["status"] == "ambiguous"
    assert response.json()["alternatives"] == []


def test_title_fallback_after_primary_failure(client_factory, crossref_record):
    def handler(request):
        if request.url.host == "api.openalex.org":
            raise httpx.ReadTimeout("private diagnostic")
        return httpx.Response(200, json={"message": {"items": [crossref_record]}})

    response = client_factory(handler).post("/resolve", json={"query": crossref_record["title"][0]})
    assert response.status_code == 200
    assert response.json()["status"] == "resolved"
    assert response.json()["warnings"]
    assert "private diagnostic" not in response.text


@pytest.mark.parametrize("query", ["10.1234/missing", "1706.99999", "unknown work title"])
def test_not_found(client_factory, query):
    def handler(request):
        if request.url.host == "export.arxiv.org":
            return httpx.Response(200, content=b'<feed xmlns="http://www.w3.org/2005/Atom"/>')
        if request.url.path == "/works":
            if request.url.host == "api.openalex.org":
                return httpx.Response(200, json={"results": []})
            return httpx.Response(200, json={"message": {"items": []}})
        return httpx.Response(404)

    response = client_factory(handler).post("/resolve", json={"query": query})
    assert response.status_code == 404
    assert response.json()["status"] == "not_found"
    assert response.json()["best_match"] is None


@pytest.mark.parametrize("query", ["10.1234/example", "1706.03762", "A Study of Citations"])
def test_provider_outage_is_502(client_factory, query):
    client = client_factory(lambda r: httpx.Response(503, text="upstream private details"))
    response = client.post("/resolve", json={"query": query})
    assert response.status_code == 502
    assert response.json()["status"] == "provider_error"
    assert "upstream private details" not in response.text


def test_partial_outage_is_not_reported_as_not_found(client_factory):
    def handler(request):
        return httpx.Response(404 if request.url.host == "api.crossref.org" else 503)

    response = client_factory(handler).post("/resolve", json={"query": "10.1234/missing"})
    assert response.status_code == 502
    assert response.json()["status"] == "provider_error"


@pytest.mark.parametrize(
    "payload", ["not JSON", "{}", '{"message":null}', '{"message":{"DOI":"bad"}}']
)
def test_malformed_crossref_falls_back(client_factory, openalex_record, payload):
    def handler(request):
        if request.url.host == "api.crossref.org":
            return httpx.Response(200, content=payload)
        return httpx.Response(200, json=openalex_record)

    response = client_factory(handler).post("/resolve", json={"query": "10.1234/example"})
    assert response.status_code == 200
    assert response.json()["sources"][0]["error_code"] == "invalid_response"


@pytest.mark.parametrize(
    "payload",
    [
        b"broken XML",
        b"<html/>",
        b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors</id></entry></feed>',
        b'<!DOCTYPE feed [<!ENTITY exploit SYSTEM "file:///etc/passwd">]><feed>&exploit;</feed>',
    ],
)
def test_invalid_arxiv_xml_and_error_feeds(client_factory, payload):
    response = client_factory(lambda r: httpx.Response(200, content=payload)).post(
        "/resolve", json={"query": "1706.03762"}
    )
    assert response.status_code == 502
    assert response.json()["sources"][0]["error_code"] == "invalid_response"


def test_redirect_is_not_followed(client_factory):
    hosts = []

    def handler(request):
        hosts.append(request.url.host)
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data"})

    response = client_factory(handler).post("/resolve", json={"query": "10.1234/example"})
    assert response.status_code == 502
    assert hosts == ["api.crossref.org", "api.openalex.org"]
    assert all(s["error_code"] == "unexpected_redirect" for s in response.json()["sources"])


def test_doi_suffix_cannot_inject_query_or_host(client_factory):
    urls = []

    def handler(request):
        urls.append(request.url)
        assert request.url.host in {"api.crossref.org", "api.openalex.org"}
        assert "mailto" not in request.url.params
        assert request.url.fragment == ""
        return httpx.Response(404)

    response = client_factory(handler).post(
        "/resolve",
        json={
            "query": "10.1234/a?mailto=attacker@example.invalid#fragment",
            "query_type": "doi",
        },
    )
    assert response.status_code == 404
    assert len(urls) == 2


def test_openapi_documents_statuses(client_factory):
    data = client_factory(no_network).get("/openapi.json").json()
    responses = data["paths"]["/resolve"]["post"]["responses"]
    assert {"200", "400", "404", "502"} <= responses.keys()


def test_indexed_preprint_uses_authoritative_arxiv_record(
    client_factory,
    openalex_record,
    arxiv_feed,
):
    openalex_record.update(type="preprint", publication_year=2025)
    openalex_record["locations"].append({"landing_page_url": "https://arxiv.org/abs/1706.03762v2"})
    calls = []

    def handler(request):
        calls.append(request.url.host)
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json={"results": [openalex_record]})
        assert request.url.host == "export.arxiv.org"
        return httpx.Response(200, content=arxiv_feed)

    response = client_factory(handler).post(
        "/resolve",
        json={
            "query": openalex_record["title"],
            "format": "bibtex",
        },
    )
    data = response.json()
    assert data["status"] == "resolved"
    assert data["best_match"]["source"] == "arxiv"
    assert data["best_match"]["year"] == 2017
    assert data["best_match"]["venue"] is None
    assert "year" in data["warnings"][0] and "authoritative" in data["warnings"][0]
    assert calls == ["api.openalex.org", "export.arxiv.org"]


@pytest.mark.parametrize("arxiv_result", ["outage", "wrong_title", "not_found"])
def test_unverified_preprint_requires_confirmation(
    client_factory,
    openalex_record,
    arxiv_feed,
    arxiv_result,
):
    openalex_record["type"] = "preprint"

    def handler(request):
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json={"results": [openalex_record]})
        assert request.url.host == "export.arxiv.org"
        if arxiv_result == "outage":
            return httpx.Response(503)
        if arxiv_result == "not_found":
            return httpx.Response(200, content=b'<feed xmlns="http://www.w3.org/2005/Atom"/>')
        return httpx.Response(
            200,
            content=arxiv_feed.replace(
                b"A Study of Reliable Citations", b"A Different Research Topic"
            ),
        )

    response = client_factory(handler).post("/resolve", json={"query": openalex_record["title"]})
    assert response.status_code == 200
    assert response.json()["status"] == "ambiguous"
    assert "Could not verify" in response.json()["warnings"][0]


def test_incomplete_primary_title_checks_crossref(client_factory, openalex_record):
    openalex_record["authorships"] = []
    calls = []

    def handler(request):
        calls.append(request.url.host)
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json={"results": [openalex_record]})
        return httpx.Response(200, json={"message": {"items": []}})

    response = client_factory(handler).post("/resolve", json={"query": openalex_record["title"]})
    assert response.json()["best_match"]["authors"] == []
    assert calls == ["api.openalex.org", "api.crossref.org"]
