import socket

import pytest
from fastapi.testclient import TestClient

from origin.app import create_app
from origin.service import WebAirService


class NetworkBlocked(AssertionError):
    pass


def _blocked(*args, **kwargs):
    raise NetworkBlocked("WebAir tests must not open network connections")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Every test runs with outbound connections and DNS lookups refused.

    The TestClient drives the ASGI app in-process, so nothing legitimate needs a socket.
    """
    monkeypatch.setattr(socket.socket, "connect", _blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)
    monkeypatch.setattr(socket, "getaddrinfo", _blocked)
    monkeypatch.setattr(socket, "gethostbyname", _blocked)


@pytest.fixture
def service():
    return WebAirService()


@pytest.fixture
def app():
    return create_app()


@pytest.fixture
def client(app):
    with TestClient(app, base_url="http://webair.test") as test_client:
        yield test_client


@pytest.fixture
def package_bytes():
    # Opaque test bytes standing in for a published artifact. Not a real agent package.
    return b"WEBAIR-TEST-FIXTURE\x00\x01\x02 not an agent package\n"


@pytest.fixture
def package_file(tmp_path, package_bytes):
    path = tmp_path / "published" / "webair-fixture.agent.pkg"
    path.parent.mkdir()
    path.write_bytes(package_bytes)
    return path


@pytest.fixture
def package_client(package_file):
    with TestClient(create_app(package_file), base_url="http://webair.test") as test_client:
        yield test_client
