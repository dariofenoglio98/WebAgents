"""A slice of the real catalog through the production path: one case per family and package."""

from __future__ import annotations

import pytest
from conftest import SEED

# One template per family whose first variant is unaffected by any known product finding.
SLICE = (
    "F1.payload_edit_integrity",
    "F2.signer_not_pinned",
    "F3.required_permission_denied",
    "F4.model_not_offered",
    "F5.reauthorized_after_plan",
    "F6.provider_substitutes_model",
    "F7.model_output_schema",
    "F8.output_cap_ceiling",
)


@pytest.fixture(scope="module")
def smoke(calibration):
    import cases

    return cases.generate(SEED, "smoke", calibration)


def _first(catalog, template_id, package):
    violation = next(
        (
            e
            for e in catalog["cases"]
            if e["template_id"] == template_id
            and e["package"] == package
            and e["kind"] == "violation"
        ),
        None,
    )
    if violation is None:
        return None, None
    control = next(e for e in catalog["cases"] if e["case_id"] == violation["control_id"])
    return violation, control


@pytest.mark.parametrize("template_id", SLICE)
@pytest.mark.parametrize("package", ["meeting-agenda", "literature-review"])
def test_violation_blocked_and_control_accepted(smoke, run_entry, template_id, package):
    violation, control = _first(smoke, template_id, package)
    if violation is None:
        pytest.skip(f"{template_id} has no {package} variant")
    obs, verdict = run_entry(violation)
    assert verdict.outcome == "EXPLICIT_BLOCK", verdict.as_json()
    assert not verdict.boundary_reached
    _, control_verdict = run_entry(control)
    assert control_verdict.outcome == "BENIGN_ACCEPT", control_verdict.as_json()
