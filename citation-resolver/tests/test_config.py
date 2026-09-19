import pytest

from app.config import Settings, validate_origin


@pytest.fixture
def clean_env(monkeypatch):
    for name in ("PUBLIC_BASE_URL", "RAILWAY_PUBLIC_DOMAIN", "CONTACT_EMAIL", "ALLOWED_HOSTS"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_railway_origin_and_explicit_override(clean_env):
    clean_env.setenv("RAILWAY_PUBLIC_DOMAIN", "citation.up.railway.app")
    assert Settings.from_env().public_base_url == "https://citation.up.railway.app"
    assert "citation.up.railway.app" in Settings.from_env().allowed_hosts
    clean_env.setenv("PUBLIC_BASE_URL", "https://papers.example/")
    assert Settings.from_env().public_base_url == "https://papers.example"


@pytest.mark.parametrize(
    "origin",
    [
        "javascript:alert(1)",
        "https://user:pass@host.test",
        "https://host.test/path",
        "https://host.test?query=1",
        "https://host.test/#hash",
        "https://host.test:bad",
        "https://host.test\nINJECT",
        "https://host.test/';echo bad;#",
    ],
)
def test_unsafe_origins_rejected(origin):
    with pytest.raises(ValueError):
        validate_origin(origin)


def test_email_cannot_inject_headers(clean_env):
    clean_env.setenv("CONTACT_EMAIL", "email@example.test\nInjected: value")
    with pytest.raises(ValueError):
        Settings.from_env()


def test_default_hosts_are_local_or_healthcheck(clean_env):
    settings = Settings.from_env()
    assert "*" not in settings.allowed_hosts
    assert "localhost" in settings.allowed_hosts
    assert "healthcheck.railway.app" in settings.allowed_hosts


def test_extra_hosts_require_explicit_hostnames(clean_env):
    clean_env.setenv("ALLOWED_HOSTS", "custom.example,alternate.example")
    assert "custom.example" in Settings.from_env().allowed_hosts
    clean_env.setenv("ALLOWED_HOSTS", "*")
    with pytest.raises(ValueError):
        Settings.from_env()
