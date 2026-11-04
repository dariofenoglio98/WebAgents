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
