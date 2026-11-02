"""The ten profiles (D-301): every site matches exactly once, in both runtimes, and removes its
mechanism only in a private copy."""

from __future__ import annotations

import pytest

from harness_v2.ablations import ABLATIONS, BY_NAME, FULL, PROFILES
from harness_v2.paths import AGENTPKG_PACKAGE, CHROME_SRC

# Sites with no twin in the other runtime: V8 meters no fuel and the core's engine has no store
# page limit (a Worker's memory is bounded by the module's own maximum).
PY_ONLY = {"L.fuel", "L.store_pages"}
NAMES = [
    "full",
    "decl_validation",
    "egress_scan",
    "proposal_check",
    "module_gate",
    "compute_limits",
    "consent_gate",
    "conversation_bounds",
    "transition_check",
    "envelope_reservation",
]


def test_the_ten_profiles():
    assert [p.name for p in PROFILES] == NAMES
    assert FULL.py == () and FULL.ts == ()


@pytest.mark.parametrize("profile", ABLATIONS, ids=lambda p: p.name)
def test_every_ablation_has_twin_sites_in_both_runtimes(profile):
    py = {patch.site for patch in profile.py}
    ts = {patch.site for patch in profile.ts}
    assert py and ts
    assert py - PY_ONLY == ts


@pytest.mark.parametrize("profile", ABLATIONS, ids=lambda p: p.name)
def test_every_site_matches_exactly_once_in_production(profile):
    for root, patches in ((AGENTPKG_PACKAGE, profile.py), (CHROME_SRC, profile.ts)):
        for patch in patches:
            text = (root / patch.file).read_text(encoding="utf-8")
            assert text.count(patch.find) == 1, (patch.site, patch.file)
            assert patch.replace != patch.find


def test_sites_are_unique_across_profiles():
    seen = {}
    for profile in ABLATIONS:
        for runtime, patches in (("py", profile.py), ("ts", profile.ts)):
            for patch in patches:
                key = (runtime, patch.file, patch.find)
                assert key not in seen, (profile.name, seen.get(key))
                seen[key] = profile.name


@pytest.mark.parametrize("name", NAMES)
def test_builds_patch_only_their_sites(name):
    from conftest import build_for

    profile = BY_NAME[name]
    for runtime, patches in (("py", profile.py), ("ts", profile.ts)):
        directory, _key = build_for(runtime, name)
        diff = (directory / "patch.diff").read_text()
        if not patches:
            assert diff == ""
            continue
        touched = {line[6:] for line in diff.splitlines() if line.startswith("+++ b/")}
        assert touched == {patch.file for patch in patches}
        for patch in patches:
            assert patch.site in diff, patch.site
