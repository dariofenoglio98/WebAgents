"""The ten enforcement profiles of catalog v2 (D-301; T27 §2): the full system and nine
single-mechanism removals, each in both runtimes.

A profile removes **one mechanism everywhere it is enforced** in the Python reference and in the
Chrome core, and nothing else. A site is an exact single-line source patch on a private copy
(`build.py`) that must match exactly once: a refusing `if CONDITION:` becomes `if False:`, an
`if (COND)` becomes `if (ablatedNever() && (COND))` (v1's `py_if` / `ts_if`, imported), and a few
sites replace a validation call or a bound by its no-op. The diff of every profile is stored with
each run's results (`patches/<profile>/{py,ts}.diff`). No production module, CLI flag,
configuration key or environment variable can select a patched copy (`tests/test_isolation.py`).

Mechanisms some cases depend on that no profile removes (the permission mediator, per-tool and
per-role budgets, schema validation of answers, engine traps, the container rules) are kept by
every profile; a case whose primary guard is one of them names no primary ablation, and its row
shows which profiles leave it blocked.
"""

from __future__ import annotations

from dataclasses import dataclass

from .paths import ensure_v1_on_path

ensure_v1_on_path()

from harness.ablations import py_if, sub, ts_if  # noqa: E402,F401
from harness.build import Patch  # noqa: E402


@dataclass(frozen=True)
class Profile:
    name: str
    label: str
    description: str
    py: tuple[Patch, ...] = ()
    ts: tuple[Patch, ...] = ()

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "description": self.description,
            "sites": {
                "py": [p.as_json() for p in self.py],
                "ts": [p.as_json() for p in self.ts],
            },
        }


FULL = Profile("full", "Full system", "Every mechanism in place; no patch.")

PROFILES: tuple[Profile, ...] = (FULL,)
BY_NAME = {profile.name: profile for profile in PROFILES}
ABLATIONS = tuple(profile for profile in PROFILES if profile.name != "full")
# The smoke preset runs the full system and each family's primary ablation.
SMOKE_PROFILES = ("full",)
