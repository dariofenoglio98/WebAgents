import asyncio
import copy
import json
from pathlib import Path

import pytest

from agentpkg.models import HTTPRouter
from agentpkg.package import load_package
from agentpkg.runtime import PolicyError, Runtime
from agentpkg.tools import ToolError, create_handlers, request_json, validate_https_url

SOURCE = Path(__file__).parents[2] / "agents" / "literature-review-legacy"


@pytest.fixture
def package():
    return load_package(SOURCE)


def bind(package, **kwargs):
    handlers = create_handlers(package, **kwargs)
    return Runtime(
        package,
        handlers=handlers,
        grants={p["id"]: "session" for p in package.policy["permissions"]},
    )


def call(rt, role, tool, payload):
    async def work(ctx, inputs):
        return {"candidate_papers": [await ctx.tool(tool, payload)]}

    # Use direct context inside valid role to inspect tool return without patch shape drift.
    result = []

    async def operation(ctx, inputs):
        result.append(await ctx.tool(tool, payload))
        return {}

    asyncio.run(rt.run_worker(role, {}, operation))
    return result[0]


@pytest.mark.parametrize(
    "url",
    [
        "http://api.crossref.org/works",
        "https://api.crossref.org:444/works",
        "https://evil.example/works",
        "https://user:pw@api.crossref.org/works",
        "https://api.crossref.org/works#fragment",
        "https://api.crossref.org\n/works",
    ],
)
def test_url_boundary(url):
    with pytest.raises(PolicyError):
        validate_https_url(url, {"api.crossref.org"})


def test_private_dns_denied_before_socket(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(PolicyError, match="not public"):
        request_json(
            "https://api.crossref.org/works", method="GET", allowed_domains={"api.crossref.org"}
        )


def test_crossref_search_contract_and_query_escaping(package):
    captured = []

    def transport(url, **kwargs):
        captured.append((url, kwargs))
        return 200, {
            "message": {
                "items": [
                    {
                        "DOI": "10.1234/example",
                        "title": ["A &amp; B"],
                        "abstract": "<jats:p>An abstract.</jats:p>",
                        "author": [{"given": "Ada", "family": "Researcher"}],
                        "published": {"date-parts": [[2025]]},
                        "container-title": ["Venue"],
                    }
                ]
            }
        }

    rt = bind(package, transport=transport)
    result = call(rt, "SearchWorker", "scholarly-search", {"query": "agents & q=?", "limit": 2})
    assert result["papers"][0]["title"] == "A & B"
    assert result["papers"][0]["abstract"] == "An abstract."
    assert "query.bibliographic=agents+%26+q%3D%3F&rows=2" in captured[0][0]
    assert captured[0][1]["method"] == "GET"
    assert result["papers"][0]["provenance"][0]["synthetic"] is False


@pytest.mark.parametrize(
    "status,http", [("ambiguous", 200), ("not_found", 404), ("provider_error", 502)]
)
def test_resolver_non_success_metadata_semantics_preserved(package, status, http):
    response = {
        "status": status,
        "query": "ambiguous title",
        "detected_type": "title",
        "best_match": None,
        "match_score": None,
        "alternatives": [],
        "sources": [],
        "warnings": [],
        "message": "honest uncertainty",
    }

    def transport(url, **kwargs):
        assert url.endswith("/resolve") and kwargs["method"] == "POST"
        assert kwargs["timeout"] >= 40
        return http, response

    result = call(
        bind(package, transport=transport),
        "CitationWorker",
        "citation-resolver",
        {"query": "ambiguous title", "format": "bibtex"},
    )
    assert result == response


def test_resolver_base_override_cannot_expand_domains(package):
    called = []

    def transport(*args, **kwargs):
        called.append(args)

    rt = bind(package, transport=transport, resolver_base_url="https://attacker.example")
    with pytest.raises(PolicyError, match="approved domain"):
        call(rt, "CitationWorker", "citation-resolver", {"query": "title"})
    assert called == []


def test_resolver_http_status_mismatch_rejected(package):
    def transport(*args, **kwargs):
        return 404, {"status": "resolved"}

    with pytest.raises(ToolError, match="mismatch"):
        call(
            bind(package, transport=transport),
            "CitationWorker",
            "citation-resolver",
            {"query": "title"},
        )


def test_duplicate_and_permission_confused_builtin_bindings_denied(package):
    changed = copy.deepcopy(package)
    duplicate = copy.deepcopy(changed.tools["scholarly-search"])
    duplicate["id"] = "evil"
    changed.tools["evil"] = duplicate
    with pytest.raises(PolicyError, match="unique"):
        create_handlers(changed)
    changed = copy.deepcopy(package)
    changed.tools["paper-reader"]["permissions"] = ["network.scholarly"]
    with pytest.raises(PolicyError, match="permission contract"):
        create_handlers(changed)


def test_selected_pdf_ids_only_and_symlinks_rejected(package, tmp_path):
    rt = bind(package, selected_files={})
    with pytest.raises(PolicyError, match="selected"):
        call(rt, "EvidenceWorker", "paper-reader", {"file_id": "/etc/passwd"})
    path = tmp_path / "paper.pdf"
    path.write_bytes(b"%PDF-1.4\n")
    link = tmp_path / "link.pdf"
    link.symlink_to(path)
    rt = bind(package, selected_files={"picked": link})
    with pytest.raises(PolicyError, match="symlinks"):
        call(rt, "EvidenceWorker", "paper-reader", {"file_id": "picked"})


def test_real_pdf_read_local_no_network(package, tmp_path):
    from pypdf import PdfWriter

    path = tmp_path / "paper.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=300)
    with path.open("wb") as stream:
        writer.write(stream)
    result = call(
        bind(package, selected_files={"picked": path}),
        "EvidenceWorker",
        "paper-reader",
        {"file_id": "picked"},
    )
    assert result["pages"] == [{"page": 1, "text": ""}]
    assert result["source"] == "user_pdf" and len(result["sha256"]) == 64


def config():
    return {
        "spec_version": "0.1",
        "url": "https://router.example.org",
        "model_id": "local-choice",
        "router_id": "test",
        "capabilities": ["reasoning", "structured_output"],
        "context_window": 128000,
        "enforces_output_cap": True,
        "counts_all_tokens": True,
    }


def test_router_wire_contract_and_secret_stays_host_side(monkeypatch):
    requests = []
    monkeypatch.setenv("TEST_ROUTER_KEY", "secret-test-value")

    def transport(url, **kwargs):
        requests.append((url, kwargs))
        return 200, (
            {"input_tokens": 15}
            if url.endswith("/count")
            else {"output": {"answer": "ok"}, "input_tokens": 15, "output_tokens": 2}
        )

    router = HTTPRouter(config() | {"api_key_env": "TEST_ROUTER_KEY"}, transport=transport)
    assert router.domains == ("router.example.org",)

    async def run():
        assert await router.count_tokens({"data": "x"}) == 15
        result = await router.complete({"data": "x"}, max_output_tokens=20)
        assert result["output"]["answer"] == "ok"

    asyncio.run(run())
    assert requests[1][1]["payload"]["max_output_tokens"] == 20
    assert requests[1][1]["headers"]["Authorization"] == "Bearer secret-test-value"
    assert "secret-test-value" not in json.dumps(requests[1][1]["payload"])
    for field in ["enforces_output_cap", "counts_all_tokens"]:
        with pytest.raises(PolicyError):
            HTTPRouter(config() | {field: False})


def test_cancelled_pdf_read_drains_bounded_parser_thread(package, monkeypatch):
    import threading
    import time

    entered, finished = threading.Event(), threading.Event()

    def bounded_parser(path):
        entered.set()
        time.sleep(0.04)
        finished.set()
        return {"pages": [], "sha256": "0" * 64, "source": "user_pdf"}

    monkeypatch.setattr("agentpkg.tools._read_pdf", bounded_parser)
    rt = bind(package, selected_files={"chosen": "/host-selected/test.pdf"})

    async def check():
        async def operation(ctx, inputs):
            await ctx.tool("paper-reader", {"file_id": "chosen"})
            return {}

        task = asyncio.create_task(rt.run_worker("EvidenceWorker", {}, operation))
        while not entered.is_set():
            await asyncio.sleep(0.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set(), "Worker returned before parser thread cleanup"
        assert rt._active == 0

    asyncio.run(check())
