"""The shared campaign infrastructure of the mechanism paper's evaluation (T31;
experiments/PROTOCOL.md).

Importing `campaigns` puts WebAir's origin package (`demo/webair/origin`, imported as `origin`) on
the path: the task generator, the campaign stack and the baseline's tools use the origin's own code.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_WEBAIR = str(ROOT / "demo" / "webair")
if _WEBAIR not in sys.path:
    sys.path.insert(0, _WEBAIR)
