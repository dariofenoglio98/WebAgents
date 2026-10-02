"""Ablations are experiment-only, exact, isolated, and leave production untouched."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys

import pytest
from conftest import EXPERIMENT

from harness.ablations import ABLATIONS, BY_NAME, PROFILES
from harness.build import PatchError, apply_patches, py_build, ts_build
from harness.paths import AGENTPKG_PACKAGE, AGENTPKG_SRC, PLUGIN, PLUGIN_SRC, ROOT


def tree_hash(root, suffixes) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix in suffixes and "__pycache__" not in path.parts:
            digest.update(str(path.relative_to(root)).encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def test_every_profile_names_one_component():
    assert len(PROFILES) == 9
    components = [profile.component for profile in ABLATIONS]
    assert len(components) == len(set(components)) == 8
    for profile in ABLATIONS:
        assert profile.py or profile.ts or profile.browser_policy, profile.name
        sites = [patch.site for patch in (*profile.py, *profile.ts)]
        assert len(sites) == len(set(sites)), profile.name


@pytest.mark.parametrize("profile", [p.name for p in ABLATIONS])
def test_every_patch_matches_exactly_once(profile, tmp_path):
    import shutil

    spec = BY_NAME[profile]
    if spec.py:
        copy = tmp_path / "agentpkg"
        shutil.copytree(AGENTPKG_PACKAGE, copy, ignore=shutil.ignore_patterns("__pycache__"))
        applied = apply_patches(copy, list(spec.py))
        assert [item["site"] for item in applied] == [p.site for p in spec.py]
    if spec.ts:
        copy = tmp_path / "src"
        shutil.copytree(PLUGIN_SRC, copy)
        applied = apply_patches(copy, list(spec.ts))
        assert [item["site"] for item in applied] == [p.site for p in spec.ts]


def test_a_patch_that_does_not_match_fails_the_build(tmp_path):
    from harness.build import Patch

    (tmp_path / "x.py").write_text("a = 1\n")
    with pytest.raises(PatchError):
        apply_patches(tmp_path, [Patch("t", "x.py", "b = 2\n", "c = 3\n")])
    (tmp_path / "x.py").write_text("a = 1\na = 1\n")
    with pytest.raises(PatchError):
        apply_patches(tmp_path, [Patch("t", "x.py", "a = 1\n", "c = 3\n")])


def test_building_never_touches_production_sources():
    before = (tree_hash(AGENTPKG_PACKAGE, {".py", ".json"}), tree_hash(PLUGIN_SRC, {".ts"}))
    for profile in PROFILES:
        ts_build(profile.name, list(profile.ts))
        py_build(profile.name, list(profile.py))
    after = (tree_hash(AGENTPKG_PACKAGE, {".py", ".json"}), tree_hash(PLUGIN_SRC, {".ts"}))
    assert before == after


def test_patched_copies_live_only_in_the_experiment_cache():
    for profile in ABLATIONS:
        if profile.py:
            root = py_build(profile.name, list(profile.py))
            assert root.is_relative_to(EXPERIMENT / ".cache")
        assert ts_build(profile.name, list(profile.ts)).is_relative_to(EXPERIMENT / ".cache")


def test_production_never_references_the_experiment():
    for root, suffixes in (
        (AGENTPKG_SRC, {".py", ".toml", ".cfg"}),
        (PLUGIN_SRC, {".ts", ".json"}),
    ):
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in suffixes:
                text = path.read_text(encoding="utf-8", errors="replace")
                assert "contract_enforcement" not in text, path
                assert "ablatedNever" not in text and "ABLATED" not in text, path


def test_no_public_switch_disables_enforcement():
    forbidden = re.compile(
        r"disable[-_]security|skip[-_]signature|ignore[-_]permissions|ablat", re.I
    )
    for path in [
        *AGENTPKG_SRC.rglob("*.py"),
        *PLUGIN_SRC.rglob("*.ts"),
        PLUGIN / "openclaw.plugin.json",
    ]:
        text = path.read_text(encoding="utf-8", errors="replace")
        assert not forbidden.search(text), path


def _import_in_worker(pythonpath: str) -> str:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": os.pathsep.join([pythonpath, str(EXPERIMENT)]),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    code = "import agentpkg, pathlib; print(pathlib.Path(agentpkg.__file__).resolve().parent)"
    return subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.mark.parametrize(
    "profile", ["minus_verification", "minus_host_mediation", "minus_resource_enforcement"]
)
def test_a_worker_imports_only_its_own_profile(profile):
    spec = BY_NAME[profile]
    root = py_build(spec.name, list(spec.py))
    assert _import_in_worker(str(root)) == str((root / "agentpkg").resolve())
    # ... and this test process still imports production.
    import agentpkg

    assert os.path.realpath(agentpkg.__file__).startswith(str(AGENTPKG_SRC.resolve()))


def test_worker_refuses_the_wrong_agentpkg():
    from harness.worker import check_import

    with pytest.raises(SystemExit):
        check_import(str(EXPERIMENT / ".cache" / "no-such-build" / "agentpkg"))
    check_import(str(AGENTPKG_SRC / "agentpkg"))


def test_full_and_trust_profiles_run_production_python():
    for name in ("full", "minus_trust"):
        assert py_build(name, list(BY_NAME[name].py)) is None


def _audit_shape(obs):
    """What a run did, independent of how parallel map items interleaved."""
    from collections import Counter

    events = Counter(
        (e.get("action"), e.get("node_id"), e.get("tool"), e.get("task")) for e in obs["audit"]
    )
    waves = [sorted(commit["nodes"]) for commit in obs["commits"]]
    return events, waves


def test_state_probe_does_not_change_a_run(host, env, tmp_path):
    from cases.base import base_plan
    from harness.pipeline import run_case

    with_probe = host.run(
        run_case(base_plan(env, "meeting-agenda"), host.helper, tmp_path / "a", probe=host.probe)
    )
    host.probe.uninstall()
    try:
        without = host.run(
            run_case(base_plan(env, "meeting-agenda"), host.helper, tmp_path / "b", probe=None)
        )
    finally:
        host.probe.install()
    assert _audit_shape(with_probe)[0] == _audit_shape(without)[0]
    assert with_probe["final_output"] == without["final_output"]
    assert with_probe["commits"] and not without["commits"]


def test_one_case_cannot_leak_into_the_next(host, env, tmp_path):
    """A faulted, refused case followed by a benign one: the benign one is unaffected."""
    from cases.base import base_plan
    from cases.f7_output import rule
    from harness import oracle
    from harness.pipeline import run_case

    clean = host.run(
        run_case(
            base_plan(env, "literature-review"), host.helper, tmp_path / "clean", probe=host.probe
        )
    )
    faulted_plan = base_plan(env, "literature-review")
    faulted_plan.faults.model.append(
        rule("literature-review", "plan", "", {"kind": "text", "text": ""})
    )
    faulted_plan.decisions = {**faulted_plan.decisions, "network.scholarly": "deny"}
    host.run(run_case(faulted_plan, host.helper, tmp_path / "faulted", probe=host.probe))
    after = host.run(
        run_case(
            base_plan(env, "literature-review"), host.helper, tmp_path / "after", probe=host.probe
        )
    )
    assert oracle.judge("control", after, lambda o: False).outcome == oracle.BENIGN_ACCEPT
    assert _audit_shape(after) == _audit_shape(clean)
    assert after["final_output"] == clean["final_output"]
    assert after["faults_fired"] == []


def test_profiles_record_their_patches_in_the_build():
    for profile in ABLATIONS:
        build = ts_build(profile.name, list(profile.ts))
        recorded = json.loads((build / "build.json").read_text())
        assert [item["site"] for item in recorded["patches"]] == [p.site for p in profile.ts]
    assert ROOT.exists()
