"""Nothing production can select a patched copy; a run leaves production untouched (D-301)."""

from __future__ import annotations

import re

from harness_v2.ablations import ABLATIONS, PROFILES
from harness_v2.build import BUILDS
from harness_v2.paths import AGENTPKG_SRC, CATALOG, CHROME, CHROME_SRC
from run_v2 import production_hashes


def test_production_never_references_the_experiment():
    for root, suffixes in (
        (AGENTPKG_SRC, {".py", ".toml", ".cfg"}),
        (CHROME_SRC, {".ts", ".json"}),
    ):
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in suffixes:
                text = path.read_text(encoding="utf-8", errors="replace")
                assert "catalog_v2" not in text and "contract_enforcement" not in text, path
                assert "ablatedNever" not in text and "ABLATED" not in text, path


def test_no_public_switch_disables_enforcement():
    forbidden = re.compile(
        r"disable[-_]security|skip[-_]signature|ignore[-_]permissions|ablat", re.I
    )
    for path in [*CHROME_SRC.rglob("*.ts"), CHROME / "package.json"]:
        assert not forbidden.search(path.read_text(encoding="utf-8", errors="replace")), path


def test_private_copies_live_in_the_cache_and_the_driver_names_its_build(runner):
    from conftest import build_for

    for profile in PROFILES:
        for runtime in ("py", "ts"):
            directory, key = build_for(runtime, profile.name)
            assert directory.is_relative_to(BUILDS) and BUILDS.is_relative_to(CATALOG / ".cache")
            assert key in directory.name


def test_a_worker_refuses_a_build_it_was_not_given():
    import pytest
    from conftest import build_for

    from harness_v2.pool import Worker, WorkerError

    directory, _key = build_for("py", "full")
    with pytest.raises(WorkerError):
        Worker("py", directory, "not-this-build").start()
    directory, _key = build_for("ts", "full")
    with pytest.raises(WorkerError):
        Worker("ts", directory, "not-this-build").start()


def test_building_and_running_leave_production_untouched(runner):
    from cases_v2 import finite_cases

    before = production_hashes()
    cases = [c for c in finite_cases() if c.id in ("M.fixture", "C.echo")]
    for profile in [p.name for p in ABLATIONS[:1]] or ["full"]:
        for runtime in ("py", "ts"):
            runner.run(cases, runtime, profile)
    assert production_hashes() == before
