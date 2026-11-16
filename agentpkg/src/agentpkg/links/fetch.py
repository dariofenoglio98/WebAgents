"""A dependency's bytes from its locator (link.v0 L-10), under the package-URL policy unchanged:
HTTPS, a public address, a pinned connection, no redirect, a byte cap (`browser/fetch.py`). Kept
apart from `resolve` so that an execution host, which verifies archives and fetches nothing,
never imports a transport."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from ..errors import AgentPkgError
from .resolve import LinkRefusal


def fetch_dependency(record: dict, *, limits=None, transport=None) -> bytes:
    """The bytes at a record's locator, under the package-URL policy unchanged (HTTPS, a public
    address, a pinned connection, no redirect, a byte cap)."""
    from ..browser.fetch import FetchLimits, download_to_file

    handle, staging = tempfile.mkstemp(prefix="agentpkg-link-", suffix=".part")
    os.close(handle)
    os.unlink(staging)
    try:
        download_to_file(
            record["locator"], Path(staging), limits=limits or FetchLimits(), transport=transport
        )
        return Path(staging).read_bytes()
    except AgentPkgError as exc:
        raise LinkRefusal("link_fetch_failed", f"dependency {record['id']!r}: {exc}") from exc
    finally:
        if os.path.exists(staging):
            os.unlink(staging)


__all__ = ["fetch_dependency"]
