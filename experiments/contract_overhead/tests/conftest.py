"""Shared fixtures for the contract-overhead benchmark's own tests.

Run from the repository root with the agentpkg virtualenv:

    agentpkg/.venv/bin/python -m pytest experiments/contract_overhead/tests
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

EXPERIMENT = Path(__file__).resolve().parents[1]
if str(EXPERIMENT) not in sys.path:
    sys.path.insert(0, str(EXPERIMENT))

import benchmark  # noqa: E402


@pytest.fixture(scope="module")
def pipeline(tmp_path_factory):
    """One production control plane with the two shipped publisher keys pinned."""
    workdir = tmp_path_factory.mktemp("pipeline")
    instance = benchmark.ContractPipeline(workdir, benchmark.Fixtures.load())
    yield instance
    instance.close()


SMOKE_ARGS = [
    "--warmup",
    "2",
    "--batches",
    "2",
    "--iterations",
    "3",
    "--audit-warmup",
    "5",
    "--audit-batches",
    "1",
    "--audit-repeats",
    "1",
    "--component-warmup",
    "1",
    "--component-iterations",
    "2",
    "--label",
    "smoke",
    "--quiet",
]


@pytest.fixture(scope="session")
def smoke_result(tmp_path_factory):
    """A tiny but complete benchmark run, in a child with no credentials at all.

    The child gets PATH and TMPDIR only, and a fresh empty HOME, so nothing it
    does can depend on an API key, a provider login, an OpenClaw config or a
    trust store the operator already has.
    """
    import os
    import subprocess

    results = tmp_path_factory.mktemp("results")
    home = tmp_path_factory.mktemp("home")
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home)}
    if os.environ.get("TMPDIR"):
        env["TMPDIR"] = os.environ["TMPDIR"]
    completed = subprocess.run(
        [
            sys.executable,
            str(EXPERIMENT / "benchmark.py"),
            *SMOKE_ARGS,
            "--results-dir",
            str(results),
        ],
        cwd=EXPERIMENT.parents[1],
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    directories = [path for path in results.iterdir() if path.is_dir()]
    assert len(directories) == 1
    assert completed.stdout.strip().endswith(directories[0].name)
    return directories[0]
