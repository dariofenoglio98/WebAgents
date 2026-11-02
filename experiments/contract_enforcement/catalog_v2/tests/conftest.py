"""Catalog v2's tests (T30). Run in their own pytest process:

    agentpkg/.venv/bin/python -m pytest experiments/contract_enforcement/catalog_v2/tests

They build private copies of both runtimes under `catalog_v2/.cache/` (once; content-addressed)
and run cases in worker processes exactly as `run_v2.py` does. They need `npm ci` in
`chrome-agent-browser` (esbuild and TypeScript) and agentpkg with its `compute` extra.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

CATALOG = Path(__file__).resolve().parents[1]
if str(CATALOG) not in sys.path:
    sys.path.insert(0, str(CATALOG))

from harness_v2 import packages  # noqa: E402
from harness_v2.ablations import BY_NAME  # noqa: E402
from harness_v2.build import node_build, py_build  # noqa: E402
from harness_v2.pool import Worker  # noqa: E402


def build_for(runtime: str, profile: str) -> tuple[Path, str]:
    spec = BY_NAME[profile]
    directory = (
        py_build(profile, list(spec.py)) if runtime == "py" else node_build(profile, list(spec.ts))
    )
    return directory, json.loads((directory / "build.json").read_text())["key"]


class Runner:
    """Runs cases on one (runtime, profile) build, archives built once per test session."""

    def __init__(self, workdir: Path):
        self.workdir = workdir
        self.private, self.public = packages.generate_key(workdir / "key")
        self.archives: dict[str, str] = {}

    def archive(self, case) -> str:
        if case.id not in self.archives:
            self.archives[case.id] = packages.build_archive(case, self.workdir, self.private)[
                "archive"
            ]
        return self.archives[case.id]

    def run(self, cases, runtime: str, profile: str = "full", *, observe=True) -> dict:
        directory, key = build_for(runtime, profile)
        out = {}
        with Worker(runtime, directory, key) as worker:
            for case in cases:
                out[case.id] = worker.run(
                    case.driver_input(self.archive(case), str(self.public), observe=observe)
                )
        return out


@pytest.fixture(scope="session")
def runner(tmp_path_factory) -> Runner:
    return Runner(tmp_path_factory.mktemp("catalog-v2"))
