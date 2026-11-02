"""The drivers (D-302): identical with and without the recording wrappers on every probe
package; no state leaks from one case into the next; the full system as expected on a sample."""

from __future__ import annotations

import json

import pytest

from cases_v2 import finite_cases
from harness_v2.oracle import classify

PROBE_RUNS = [
    "M.fixture",
    "M.m36-granted-sealed-value",
    "M.n11-sealed-value-to-a-model",
    "C.echo",
    "C.with-start",
    "C.deadline",
    "V.two-turns-one-consent",
    "V.tool-after-denied-consent",
    "V.once-across-turns",
    "N.fixture-walk",
    "N.hops-exhausted",
]
# Per-run values: timings, the engine's own facts, random run ids and instants.
VARIABLE = {
    "elapsed_ms",
    "fuel_consumed",
    "at",
    "duration_ms",
    "engine",
    "elapsed",
    "run_id",
    "turn_run_id",
    "conversation_id",
    "decided_at",
}


def _normal(value):
    if isinstance(value, dict):
        return {k: _normal(v) for k, v in value.items() if k not in VARIABLE}
    if isinstance(value, list):
        return [_normal(v) for v in value]
    return value


def _comparable(record):
    return json.dumps(
        _normal({k: record.get(k) for k in ("refusal", "result", "audit", "exports", "memory")}),
        sort_keys=True,
    )


@pytest.fixture(scope="module")
def cases():
    by_id = {case.id: case for case in finite_cases()}
    return [by_id[cid] for cid in PROBE_RUNS]


@pytest.mark.parametrize("runtime", ["py", "ts"])
def test_driver_identity_with_and_without_wrappers(runner, cases, runtime):
    observed = runner.run(cases, runtime, observe=True)
    raw = runner.run(cases, runtime, observe=False)
    for case in cases:
        assert any(observed[case.id]["seams"].values()) or observed[case.id]["refusal"], case.id
        assert not any(raw[case.id]["seams"].values()), case.id
        assert _comparable(observed[case.id]) == _comparable(raw[case.id]), case.id


@pytest.mark.parametrize("runtime", ["py", "ts"])
def test_no_state_leaks_between_cases(runner, cases, runtime):
    together = runner.run(cases, runtime)
    reversed_order = runner.run(list(reversed(cases)), runtime)
    for case in cases:
        alone = runner.run([case], runtime)[case.id]
        assert _comparable(together[case.id]) == _comparable(alone), case.id
        assert _comparable(reversed_order[case.id]) == _comparable(alone), case.id


@pytest.mark.parametrize("runtime", ["py", "ts"])
def test_full_system_on_the_probe_sample(runner, cases, runtime):
    records = runner.run(cases, runtime)
    for case in cases:
        verdict = classify(case.to_json(), records[case.id], runtime)
        expected = "BENIGN_ACCEPT" if case.kind == "control" else "EXPLICIT_BLOCK"
        assert verdict["outcome"] == expected, (case.id, verdict)
