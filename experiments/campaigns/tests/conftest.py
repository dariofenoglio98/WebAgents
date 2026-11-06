"""The campaign infrastructure's tests (T31): offline, credential-free, no model.

`experiments/` goes first on sys.path so that `campaigns.*` imports; WebAir's origin is imported
from `demo/webair/` (its requirements are installed beside agentpkg's,
`experiments/campaigns/requirements.txt`).
"""

from __future__ import annotations

import sys
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[2]
ROOT = EXPERIMENTS.parent
for path in (EXPERIMENTS, ROOT / "demo" / "webair"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))


class FakeStack:
    """A stack that is never dialed: its hosts are a closed port, its CA a missing file. For a test
    whose run fails before any tool call (T31b review 2, nit 7)."""

    from campaigns.origin import tls as _tls

    hosts = {_tls.RESOLVER_HOST: ("127.0.0.1", 9), _tls.WEBAIR_HOST: ("127.0.0.1", 9)}
    ca = "/nonexistent-ca.pem"

    def __init__(self):
        from types import SimpleNamespace

        self.origin_log: list = []
        self.resolver_log: list = []
        self.sink = SimpleNamespace(log=[])
