"""Case generation: deterministic, distinct, complete, and declared before any run."""

from __future__ import annotations

import json

import pytest
from conftest import SEED


@pytest.fixture(scope="module")
def catalogs(calibration):
    import cases

    return {
        name: cases.generate(SEED, name, calibration)
        for name in ("smoke", "qualification", "paper")
    }


def test_calibration_is_reproducible(host, env, calibration, tmp_path):
    """A second, independent calibration run measures exactly the same thing."""
    from cases.calibration import calibrate

    again = host.run(calibrate(host.helper, env, tmp_path, probe=host.probe))
    assert again["sha256"] == calibration["sha256"]


def test_same_seed_same_catalog(calibration, catalogs):
    import cases

    again = cases.generate(SEED, "paper", calibration)
    assert again["sha256"] == catalogs["paper"]["sha256"]
    assert json.dumps(again, sort_keys=True) == json.dumps(catalogs["paper"], sort_keys=True)


def test_seed_changes_parametric_variants(calibration, catalogs):
    import cases

    other = cases.generate(SEED + 1, "paper", calibration)
    assert other["sha256"] != catalogs["paper"]["sha256"]
    # Finite templates do not depend on the seed's sampling.
    finite = {row["template_id"] for row in other["templates"] if row["template_kind"] == "finite"}
    ours = {
        e["case_id"]
        for e in catalogs["paper"]["cases"]
        if e["template_id"] in finite and e["kind"] == "violation"
    }
    theirs = {
        e["case_id"]
        for e in other["cases"]
        if e["template_id"] in finite and e["kind"] == "violation"
    }
    assert ours == theirs


def test_ids_and_perturbations_are_distinct(catalogs):
    for catalog in catalogs.values():
        ids = [entry["case_id"] for entry in catalog["cases"]]
        assert len(ids) == len(set(ids))
        seen = set()
        for entry in catalog["cases"]:
            if entry["kind"] != "violation":
                continue
            key = (
                entry["template_id"],
                entry["package"],
                json.dumps(entry["params"], sort_keys=True),
            )
            assert key not in seen, entry["case_id"]
            seen.add(key)


def test_every_violation_has_a_matched_control(catalogs):
    for catalog in catalogs.values():
        controls = {
            entry["case_id"]: entry for entry in catalog["cases"] if entry["kind"] == "control"
        }
        violations = [entry for entry in catalog["cases"] if entry["kind"] == "violation"]
        assert violations
        for entry in violations:
            control = controls[entry["control_id"]]
            assert control["template_id"] == entry["template_id"]
            assert control["package"] == entry["package"]
        referenced = {entry["control_id"] for entry in violations}
        assert referenced == set(controls)


def test_templates_declare_everything_before_running(catalogs):
    from cases.base import FAMILIES
    from harness.codes import COMPONENTS, STAGES

    rows = catalogs["paper"]["templates"]
    assert {row["family"] for row in rows} == set(FAMILIES)
    for row in rows:
        for field in (
            "violated_assumption",
            "expected_component",
            "expected_stage",
            "expected_codes",
            "forbidden_boundary",
            "matched_control",
            "template_kind",
            "most_relevant_ablation",
            "primary_guard",
        ):
            assert row[field], (row["template_id"], field)
        assert row["expected_component"] in COMPONENTS, row["template_id"]
        assert row["expected_stage"] in STAGES, row["template_id"]
        assert row["template_kind"] in ("finite", "parametric")
        # A catalog never carries a result.
        assert not {"outcome", "observed_stage", "result"} & set(row)
    for entry in catalogs["paper"]["cases"]:
        assert "outcome" not in entry


def test_presets_are_nested_in_size(catalogs):
    sizes = [catalogs[name]["counts"]["violations"] for name in ("smoke", "qualification", "paper")]
    assert sizes == sorted(sizes)
    assert catalogs["paper"]["counts"]["violations"] >= 300


def test_both_packages_are_used(catalogs):
    by_family: dict[str, set] = {}
    for entry in catalogs["paper"]["cases"]:
        family = entry["template_id"].split(".")[0]
        by_family.setdefault(family, set()).add(entry["package"])
    for family, packages in by_family.items():
        assert "literature-review" in packages, family
    both = [family for family, packages in by_family.items() if len(packages) == 2]
    assert len(both) >= 6


def test_ablation_named_by_every_template_exists(catalogs):
    from harness.ablations import BY_NAME

    for row in catalogs["paper"]["templates"]:
        assert row["most_relevant_ablation"] in BY_NAME, row["template_id"]


def test_schema_violations_are_checked_against_the_router_schema(calibration, catalogs):
    """Every generated schema mutation must break, and every control keep, the router's schema."""
    from cases import mutations
    from cases.f7_output import schema_valid

    entries = [
        e for e in catalogs["paper"]["cases"] if e["template_id"] == "F7.model_output_schema"
    ]
    assert entries
    for entry in entries:
        params = entry["params"] if entry["kind"] == "violation" else entry["control_params"]
        if not params:
            continue
        task = calibration["packages"][entry["package"]]["tasks"][params["task"]]
        answer = task["answers"][params["item"]]
        if entry["kind"] == "violation":
            mutated, where = mutations.apply(answer, params["site"], "TAINT-test")
            assert where is not None and not schema_valid(task["schema"], mutated), entry["case_id"]
        else:
            changed, where = mutations.valid_perturbation(answer, params["site"], "TAINT-test")
            assert where is not None and schema_valid(task["schema"], changed), entry["case_id"]


def test_calibration_records_answers_not_prompts(calibration):
    """Answers and schemas only: no instruction text, no skill, no rendered request."""
    import zipfile

    from harness.paths import PACKAGES

    text = json.dumps(calibration)
    # The router's fixed framing sentence is part of every rendered system prompt.
    assert "no markdown code fence" not in text
    for spec in PACKAGES.values():
        with zipfile.ZipFile(spec["archive"]) as archive:
            for name in archive.namelist():
                if name.endswith("SKILL.md"):
                    body = archive.read(name).decode("utf-8")
                    line = next(line for line in body.splitlines() if len(line) > 40)
                    assert line not in text, name
    for package in calibration["packages"].values():
        for task in package["tasks"].values():
            assert set(task) == {"node", "schema_path", "map", "schema", "answers", "items"}
