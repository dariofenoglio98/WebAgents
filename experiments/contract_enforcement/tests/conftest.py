"""Shared fixtures: the experiment on `sys.path`, the full-system build, and one calibration.

Tests that execute cases use the real production path (the plugin compiled
from its own sources, agentpkg from `agentpkg/src`), offline. The first run
compiles the plugin into `.cache/builds/` (about half a minute); later runs
reuse it.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

EXPERIMENT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENT))

SEED = 20261002


@pytest.fixture(scope="session")
def full_build() -> Path:
    from harness.build import ts_build

    return ts_build("full", [])


class Host:
    """One helper, probe and event loop shared by the tests that run cases."""

    def __init__(self, build: Path, log: Path):
        from harness.guards import StateProbe
        from harness.host import HostHelper

        self.loop = asyncio.new_event_loop()
        self.helper = HostHelper(build, log_path=log)
        self.loop.run_until_complete(self.helper.start())
        self.probe = StateProbe()
        self.probe.install()

    def run(self, coroutine):
        return self.loop.run_until_complete(coroutine)

    def close(self):
        self.probe.uninstall()
        self.loop.run_until_complete(self.helper.stop())
        self.loop.close()


@pytest.fixture(scope="session")
def host(full_build, tmp_path_factory):
    instance = Host(full_build, tmp_path_factory.mktemp("logs") / "helper.log")
    yield instance
    instance.close()


@pytest.fixture(scope="session")
def env(host):
    from cases.base import Env

    return Env(SEED, built_in_bindings=host.helper.hello["built_in_bindings"])


@pytest.fixture(scope="session")
def calibration(host, env, tmp_path_factory):
    from cases.calibration import calibrate

    result = host.run(
        calibrate(host.helper, env, tmp_path_factory.mktemp("calibration"), probe=host.probe)
    )
    env.calibration = result
    return result


@pytest.fixture
def run_entry(host, env, calibration, tmp_path):
    """Plan, run and judge one catalog entry on the full system."""
    from cases import entry_plan
    from harness import oracle
    from harness.pipeline import run_case

    counter = {"n": 0}

    def run(entry):
        counter["n"] += 1
        case_dir = tmp_path / f"case-{counter['n']}"
        (plan, boundary), template = entry_plan(entry, env.at(case_dir))
        obs = host.run(run_case(plan, host.helper, case_dir, probe=host.probe))
        return obs, oracle.judge(
            entry["kind"], obs, boundary, requires_fault=template.requires_fault
        )

    return run
