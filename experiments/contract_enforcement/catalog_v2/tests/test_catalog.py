"""The catalog itself (D-300): counts, ids, declarations, matched controls, determinism."""

from __future__ import annotations

from collections import Counter

from cases_v2 import PRESETS, catalog, catalog_hash, finite_cases, parametric_cases
from cases_v2.base import BOUNDARY_CLASSES, FAMILIES
from harness_v2.ablations import BY_NAME
from harness_v2.oracle import PREDICATES


def test_family_counts_are_the_probes_plus_the_new_cases():
    counts = Counter((case.family, case.kind) for case in finite_cases())
    assert counts == {
        # memory: the probe's 23 negative variants + N3 by grants + the denied memory.write case
        ("M", "violation"): 25,
        ("M", "control"): 4,
        # compute: examples/compute/cases/cases.json, engine-unavailable kept
        ("C", "violation"): 39,
        ("C", "control"): 2,
        # conversation: the list's 38 negative cases, its two "completed" rows that are guards
        # working by denial (consent-undecided, once-across-turns), and the T24
        # sentence-vs-facts case; its three named controls
        ("V", "violation"): 41,
        ("V", "control"): 3,
        # network: examples/network/cases/cases.json
        ("N", "violation"): 42,
        ("N", "control"): 4,
    }


def test_every_case_declares_what_the_oracle_needs():
    for case in finite_cases() + parametric_cases(1, 6):
        assert case.family in FAMILIES
        if case.kind == "violation":
            assert case.boundary["class"] in BOUNDARY_CLASSES, case.id
            assert case.boundary["predicate"] in PREDICATES, case.id
            assert case.guard and case.guard != "none", case.id
            assert case.expected.get("code"), case.id
            assert case.primary_ablation is None or case.primary_ablation in BY_NAME, case.id
        assert case.to_json()["property"] is None  # filled from T28's list when it lands


def test_matched_controls_exist_and_are_controls():
    cases = {case.id: case for case in finite_cases()}
    for case in finite_cases() + parametric_cases(1, 6):
        if case.kind == "violation":
            control = cases[case.matched_control]
            assert control.kind == "control" and control.family == case.family, case.id


def test_ids_are_unique_and_the_catalog_is_deterministic():
    for preset in PRESETS:
        first, second = catalog(preset, 20261101), catalog(preset, 20261101)
        assert len({case.id for case in first}) == len(first)
        assert catalog_hash(first) == catalog_hash(second)
    assert catalog_hash(catalog("paper", 1)) != catalog_hash(catalog("paper", 2))


def test_parametric_templates_cover_both_sides_of_each_threshold():
    cases = parametric_cases(20261101, 6)
    by_template = {}
    for case in cases:
        by_template.setdefault(case.parametric["template"], set()).add(case.kind)
    assert set(by_template) == {
        "compute-pages",
        "compute-time",
        "conversation-tokens",
        "conversation-turns",
        "network-cap",
        "agent-write",
    }
    for template, kinds in by_template.items():
        assert kinds == {"violation", "control"}, template
