"""WebAir needs no network, credentials, files or payment processor to serve a request."""

import ast
import builtins
import io
import os
import pathlib
import socket
from pathlib import Path

import pytest
from conftest import NetworkBlocked
from fastapi.testclient import TestClient
from htmltools import Page

from origin.app import create_app

ORIGIN = Path(__file__).resolve().parents[1] / "origin"
SOURCES = sorted(ORIGIN.glob("*.py"))
BOOKING = {
    "fare_id": "WA105-20261009-BASIC",
    "passengers": [{"given_name": "Grace", "family_name": "Hopper"}],
    "contact_email": "grace@example.com",
}


def exercise(client):
    """Every API operation and the whole human journey."""
    assert (
        client.post(
            "/api/v1/search_flights",
            json={"origin": "BOS", "destination": "ZRH", "date": "2026-10-09"},
        ).status_code
        == 200
    )
    assert (
        client.post("/api/v1/get_flight", json={"flight_id": "WA105-20261009"}).status_code == 200
    )
    assert (
        client.post("/api/v1/get_fare_rules", json={"fare_id": "WA105-20261009-BASIC"}).status_code
        == 200
    )
    quote = client.post("/api/v1/prepare_booking", json=BOOKING).json()
    purchase = client.post(
        "/api/v1/simulate_purchase",
        json={
            "booking": BOOKING,
            "quote_id": quote["quote_id"],
            "payment_method_id": "demo-visa-4242",
        },
    )
    assert purchase.status_code == 200
    for url in (
        "/",
        "/flights",
        "/results?origin=BOS&destination=ZRH&date=2026-10-09",
        "/flight/WA105-20261009",
        "/fare/WA105-20261009-BASIC",
        "/passenger?fare_id=WA105-20261009-BASIC&passengers=1",
        "/static/webair.css",
        "/agent.pkg",
        "/api/v1/schemas",
        "/health",
        "/missing",
    ):
        assert client.get(url).status_code in (200, 404)
    payment = client.post(
        "/payment",
        data={
            "fare_id": "WA105-20261009-BASIC",
            "passengers": "1",
            "given_name_1": "Grace",
            "family_name_1": "Hopper",
            "contact_email": "grace@example.com",
        },
    )
    assert payment.status_code == 200
    confirmation = client.post(
        "/confirmation", data=Page(payment.text).form("/confirmation").values()
    )
    assert "No real transaction was performed." in confirmation.text
    return purchase.json()


def imported_modules(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            yield node.module


# --- what the origin serves ---------------------------------------------------------------------


def served_routes(app) -> set[tuple[str, str]]:
    """(path, method) of every route, including those of included routers.

    The pinned FastAPI wraps an included router in an object holding `original_router`; a
    mount (a static directory, a sub-application) has no methods and shows up as MOUNT.
    """
    found = set()

    def walk(routes, prefix=""):
        for route in routes:
            nested = getattr(route, "original_router", None)
            if nested is not None:
                walk(nested.routes, prefix + route.include_context.prefix)
            elif getattr(route, "methods", None):
                found.update((prefix + route.path, method) for method in route.methods)
            else:
                found.add((prefix + getattr(route, "path", "?"), "MOUNT"))

    walk(app.routes)
    return found


def test_the_origin_serves_exactly_its_routes(client):
    """Fixed paths only: no static directory, no docs, no debug or admin route."""
    routes = served_routes(create_app())
    pages = {"/", "/flights", "/results", "/flight/{flight_id}", "/fare/{fare_id}", "/passenger"}
    operations = {
        "search_flights",
        "get_flight",
        "get_fare_rules",
        "prepare_booking",
        "simulate_purchase",
    }
    assert routes == (
        {(path, "GET") for path in pages}
        | {("/payment", "POST"), ("/confirmation", "POST")}
        | {(f"/api/v1/{name}", "POST") for name in operations}
        | {("/api/v1/schemas", "GET")}
        | {("/static/webair.css", "GET"), ("/health", "GET")}
        | {("/agent.pkg", "GET"), ("/agent.pkg", "HEAD")}
        # T8: the WebAgents demo documents, fixed paths read from one configured directory
        # (T11: Literature Review 0.2.6 beside 0.2.5; T15: 0.2.7 beside both; T20: 0.2.8).
        | {
            (path, method)
            for path in (
                "/agent-index.json",
                "/policies/webagents-research.json",
                "/packages/literature-review-0.2.8.agent.pkg",
                "/packages/literature-review-0.2.7.agent.pkg",
                "/packages/literature-review-0.2.6.agent.pkg",
                "/packages/literature-review-0.2.5.agent.pkg",
            )
            for method in ("GET", "HEAD")
        }
    )
    # And by behaviour: nothing that would expose source, configuration or a listing.
    for path in (
        "/docs",
        "/redoc",
        "/openapi.json",
        "/static/",
        "/static",
        "/static/../origin/app.py",
        "/origin/app.py",
        "/templates/base.html",
        "/host-resources.json",
        "/host-bindings.json",
        "/.env",
        "/.git/config",
        "/admin",
        "/debug",
        "/health/",
        "/agent.pkg/",
        "/api/v1/",
        "/api/v1",
    ):
        assert client.get(path).status_code in (404, 405), path


def test_health_states_only_public_facts(package_file, package_bytes):
    import hashlib

    with TestClient(create_app()) as client:
        unpublished = client.get("/health")
    with TestClient(create_app(package_file)) as client:
        published = client.get("/health")
    assert unpublished.json() == {
        "status": "ok",
        "service": "webair-origin",
        "fictional": True,
        "agent_package_sha256": None,
        "demo_documents": None,
    }
    assert published.json()["agent_package_sha256"] == hashlib.sha256(package_bytes).hexdigest()
    assert published.headers["cache-control"] == "no-store"
    # No path, environment, version or host detail.
    assert str(package_file.parent) not in published.text
    assert "access-control-allow-origin" not in published.headers


# --- network ----------------------------------------------------------------------------------


def test_the_network_guard_is_active():
    with pytest.raises(NetworkBlocked):
        socket.create_connection(("example.com", 443))
    with pytest.raises(NetworkBlocked):
        socket.getaddrinfo("example.com", 443)
    with pytest.raises(NetworkBlocked):
        socket.socket().connect(("192.0.2.1", 443))


def test_every_operation_runs_with_the_network_blocked(client):
    confirmation = exercise(client)
    assert confirmation["real_transaction"] is False


def test_origin_code_imports_no_network_or_process_modules():
    forbidden = {
        "socket",
        "ssl",
        "http",
        "urllib.request",
        "requests",
        "httpx",
        "httpx2",
        "aiohttp",
        "subprocess",
        "smtplib",
        "ftplib",
        "multiprocessing",
        "ctypes",
        "pickle",
        "shelve",
        "sqlite3",
    }
    for path in SOURCES:
        for module in imported_modules(path):
            root = module.split(".")[0]
            assert module not in forbidden and root not in forbidden, (path.name, module)


def test_only_the_launcher_imports_the_server():
    importers = {p.name for p in SOURCES if "uvicorn" in set(imported_modules(p))}
    assert importers == {"__main__.py"}


def test_origin_code_names_no_payment_processor_or_wallet():
    for path in [*SOURCES, *ORIGIN.glob("templates/*.html")]:
        text = path.read_text(encoding="utf-8").lower()
        for word in (
            "stripe",
            "braintree",
            "adyen",
            "paypal",
            "apple pay",
            "applepay",
            "google pay",
            "wallet",
            "api_key",
            "secret_key",
            "sk_live",
            "pk_live",
        ):
            assert word not in text, (path.name, word)


# --- files ------------------------------------------------------------------------------------


def test_requests_never_touch_the_filesystem(monkeypatch, package_file):
    """After startup, serving every page and operation opens, stats and lists nothing.

    One exception is FastAPI's, not WebAir's: the first call of each endpoint looks up that
    endpoint function's own source file (an origin .py) for error context, then caches it.
    """
    app = create_app(package_file)
    own_sources = {str(p) for p in SOURCES}
    touched = []

    def guard(name, real):
        def guarded(*args, **kwargs):
            target = str(args[0]) if args else ""
            touched.append((name, target))
            if target in own_sources:
                return real(*args, **kwargs)
            raise PermissionError(f"filesystem access during a request: {name} {target}")

        return guarded

    with TestClient(app) as client:
        for target, name in [
            (builtins, "open"),
            (io, "open"),
            (os, "open"),
            (os, "stat"),
            (os, "lstat"),
            (os, "listdir"),
            (os, "scandir"),
        ]:
            monkeypatch.setattr(
                target, name, guard(f"{target.__name__}.{name}", getattr(target, name))
            )
        for name in (
            "open",
            "read_bytes",
            "read_text",
            "write_bytes",
            "write_text",
            "stat",
            "iterdir",
            "exists",
            "is_file",
            "resolve",
        ):
            monkeypatch.setattr(
                pathlib.Path, name, guard(f"Path.{name}", getattr(pathlib.Path, name))
            )
        exercise(client)
        first_pass = list(touched)
        touched.clear()
        exercise(client)
        second_pass = list(touched)
        monkeypatch.undo()
    assert {target for _, target in first_pass} <= own_sources
    assert second_pass == []


def test_requests_write_no_files(tmp_path, monkeypatch, client):
    monkeypatch.chdir(tmp_path)
    exercise(client)
    assert list(tmp_path.iterdir()) == []


# --- credentials ------------------------------------------------------------------------------


def test_the_origin_needs_no_environment(monkeypatch):
    for name in list(os.environ):
        monkeypatch.delenv(name)
    with TestClient(create_app()) as client:
        exercise(client)


def test_the_only_environment_variables_read_are_the_package_path_and_the_port():
    """The launcher reads where the package is, where the WebAgents demo documents are (T8)
    and, on a hosting platform, which port to use.

    None is a credential, and nothing a request does depends on any of them.
    """
    names = set()
    for path in SOURCES:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("get", "getenv")
                and ast.unparse(node.func.value) in ("os.environ", "os")
            ):
                names.add((path.name, node.args[0].value))
            elif isinstance(node, ast.Subscript) and ast.unparse(node.value) == "os.environ":
                names.add((path.name, ast.unparse(node.slice)))
    assert names == {
        ("__main__.py", "WEBAIR_AGENT_PACKAGE"),
        ("__main__.py", "WEBAIR_DEMO_DOCUMENTS"),
        ("__main__.py", "PORT"),
    }
