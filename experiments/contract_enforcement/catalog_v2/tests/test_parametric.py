"""The parametric templates' thresholds (D-300): on both runtimes, under the full system, the value
at the need completes and the value below it is refused (two draws per template: one each side)."""

from __future__ import annotations

import pytest

from cases_v2 import parametric_cases
from harness_v2.oracle import classify


@pytest.mark.parametrize("runtime", ["py", "ts"])
def test_each_template_on_both_sides_of_its_threshold(runner, runtime):
    cases = parametric_cases(20261101, 2)
    records = runner.run(cases, runtime)
    for case in cases:
        verdict = classify(case.to_json(), records[case.id], runtime)
        if case.kind == "control":
            assert verdict["outcome"] == "BENIGN_ACCEPT", (case.id, verdict)
        else:
            assert verdict["outcome"] == "EXPLICIT_BLOCK", (case.id, verdict)
            assert verdict["code_match"] and verdict["reason_match"], (case.id, verdict)
