"""Fixtures shared by the link.v0 tests."""

import pytest

from agentpkg.signing import keygen


@pytest.fixture(scope="session")
def keys(tmp_path_factory):
    """One publisher key per linked package: a denial is of a key (L-13)."""
    directory = tmp_path_factory.mktemp("link-keys")
    made = {}
    for name in ("default", "index", "scribe", "helper"):
        made[name] = (directory / f"{name}.private.pem", directory / f"{name}.pub.pem")
        keygen(*made[name])
    return made
