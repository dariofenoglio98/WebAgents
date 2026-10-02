"""Results: checkpointing, resume, metrics, intervals and tables."""

from __future__ import annotations

import json

import pytest

import analyze
from harness import records


@pytest.mark.parametrize(
    ("k", "n", "low", "high"),
    [
        # Reference values for the 95% Wilson score interval.
        (0, 10, 0.0, 0.2775),
        (10, 10, 0.7225, 1.0),
        (5, 10, 0.2366, 0.7634),
        (97, 97, 0.9619, 1.0),
        (1, 3, 0.0615, 0.7923),
    ],
)
def test_wilson_interval(k, n, low, high):
    lo, hi = analyze.wilson(k, n)
    assert lo == pytest.approx(low, abs=1e-4)
    assert hi == pytest.approx(high, abs=1e-4)


def test_wilson_of_nothing():
    assert analyze.wilson(0, 0) == (None, None)


def test_append_is_one_line_per_record_and_survives_a_torn_write(tmp_path):
    path = tmp_path / "shard.jsonl"
    records.append(path, {"key": "a", "outcome": "EXPLICIT_BLOCK"})
    records.append(path, {"key": "b", "outcome": "BENIGN_ACCEPT"})
    with open(path, "a") as stream:
        stream.write('{"key": "c", "outc')  # interrupted mid-write
    records.repair(path)
    assert [r["key"] for r in records.read(path)] == ["a", "b"]
    records.append(path, {"key": "c", "outcome": "EXPLICIT_BLOCK"})
    assert [r["key"] for r in records.read(path)] == ["a", "b", "c"]


def test_scrub_removes_local_paths(tmp_path):
    from pathlib import Path

    text = f"{tmp_path}/x and {Path.home()}/secret and /private/var/folders/ab/T/y"
    out = records.scrub(text, str(tmp_path))
    assert str(Path.home()) not in out and str(tmp_path) not in out and "/private/var" not in out


def _record(
    profile,
    case_id,
    kind,
    outcome,
    template="T.one",
    family="F1",
    control_id=None,
    stage_match=True,
):
    return {
        "key": f"{profile}::{case_id}",
        "profile": profile,
        "case_id": case_id,
        "kind": kind,
        "template_id": template,
        "family": family,
        "package": "meeting-agenda",
        "variant_id": case_id,
        "control_id": control_id or f"{template}/meeting-agenda/control/baseline",
        "outcome": outcome,
        "stage_match": stage_match if outcome == "EXPLICIT_BLOCK" and kind == "violation" else None,
        "component_match": True if outcome == "EXPLICIT_BLOCK" and kind == "violation" else None,
        "code_match": True if outcome == "EXPLICIT_BLOCK" and kind == "violation" else None,
        "expected_stage": "verify",
        "elapsed_ms": 10.0,
    }


@pytest.fixture
def results_dir(tmp_path):
    control = "T.one/meeting-agenda/control/baseline"
    catalog = {
        "sha256": "0" * 64,
        "calibration_sha256": "1" * 64,
        "counts": {
            "templates": 1,
            "families": 1,
            "violations": 4,
            "controls": 1,
            "packages": ["meeting-agenda"],
        },
        "templates": [
            {
                "template_id": "T.one",
                "family": "F1",
                "expected_stage": "verify",
                "most_relevant_ablation": "minus_verification",
                "template_kind": "finite",
            }
        ],
        "cases": [
            *(
                {
                    "case_id": f"v{i}",
                    "kind": "violation",
                    "template_id": "T.one",
                    "package": "meeting-agenda",
                    "control_id": control,
                }
                for i in range(4)
            ),
            {
                "case_id": control,
                "kind": "control",
                "template_id": "T.one",
                "package": "meeting-agenda",
                "control_id": control,
            },
        ],
    }
    config = {
        "seed": 1,
        "preset": "smoke",
        "profiles": ["full", "minus_verification"],
        "builds": {},
    }
    (tmp_path / "case_catalog.json").write_text(json.dumps(catalog))
    (tmp_path / "config.json").write_text(json.dumps(config))
    raw = tmp_path / "raw"
    raw.mkdir()
    full = [
        _record("full", "v0", "violation", "EXPLICIT_BLOCK"),
        _record("full", "v1", "violation", "EXPLICIT_BLOCK", stage_match=False),
        _record("full", "v2", "violation", "EXPLICIT_BLOCK"),
        _record("full", "v3", "violation", "INCIDENTAL_FAILURE"),
        _record("full", control, "control", "BENIGN_ACCEPT"),
    ]
    ablated = [
        _record("minus_verification", "v0", "violation", "SILENT_VIOLATION"),
        _record("minus_verification", "v1", "violation", "SILENT_VIOLATION"),
        _record("minus_verification", "v2", "violation", "EXPLICIT_BLOCK"),
        _record("minus_verification", "v3", "violation", "SILENT_VIOLATION"),
        _record("minus_verification", control, "control", "BENIGN_ACCEPT"),
    ]
    for record in full[:3]:
        records.append(raw / "full-0.jsonl", record)
    for record in full[3:]:
        records.append(raw / "full-1.jsonl", record)
    for record in ablated:
        records.append(raw / "minus_verification-0.jsonl", record)
    return tmp_path


def test_metrics_from_records(results_dir):
    summary = analyze.analyze(results_dir)
    full = summary["profiles"]["full"]
    assert full["VDR"]["k"] == 3 and full["VDR"]["n"] == 4
    assert full["IFR"]["k"] == 1 and full["SVR"]["k"] == 0
    assert full["BAR"]["k"] == 1 and full["BAR"]["n"] == 1
    # (explicit blocks + accepted controls) / (violations + matched controls) = (3 + 1) / (4 + 1)
    assert (full["PCC"]["k"], full["PCC"]["n"]) == (4, 5)
    assert full["stage_accuracy"]["k"] == 2 and full["stage_accuracy"]["n"] == 3
    ablated = summary["profiles"]["minus_verification"]
    assert ablated["SVR"]["k"] == 3
    assert summary["status"]["complete"] is True
    assert summary["status"]["full_silent_violations"] == 0
    effect = next(e for e in summary["ablation_effects"] if e["template_id"] == "T.one")
    assert effect["silent_under_ablation"] == 3


def test_frozen_manifest_is_verified_not_rewritten(results_dir):
    import hashlib

    frozen = b'{"frozen": true}\n'
    (results_dir / "paper_manifest.json").write_bytes(frozen)
    config = json.loads((results_dir / "config.json").read_text())
    config["manifest_sha256"] = hashlib.sha256(frozen).hexdigest()
    (results_dir / "config.json").write_text(json.dumps(config))
    summary = analyze.analyze(results_dir)
    assert summary["manifest"]["verified"] is True
    assert (results_dir / "paper_manifest.json").read_bytes() == frozen
    (results_dir / "paper_manifest.json").write_bytes(b'{"frozen": false}\n')
    assert analyze.analyze(results_dir)["manifest"]["verified"] is False


def test_family_ablation_matrix_and_component_summary(results_dir):
    import csv

    analyze.analyze(results_dir)
    with open(results_dir / "ablation_matrix.csv") as stream:
        rows = list(csv.DictReader(stream))
    family = next(row for row in rows if row["family"] == "F1")
    assert float(family["full:VDR"]) == 0.75
    assert float(family["minus_verification:SVR"]) == 0.75
    table = (results_dir / "paper_ablation_table.tex").read_text()
    assert "Removed component" in table and "-50.0" in table
    with open(results_dir / "summary.csv") as stream:
        summary = list(csv.DictReader(stream))
    ablated = next(row for row in summary if row["profile"] == "minus_verification")
    assert float(ablated["VDR_change_vs_full"]) == pytest.approx(-0.5)


def test_analysis_is_deterministic_and_writes_every_file(results_dir):
    analyze.analyze(results_dir)
    first = {
        name: (results_dir / name).read_text()
        for name in ("summary.json", "summary.csv", "ablation_matrix.csv", "paper_main_table.tex")
    }
    analyze.analyze(results_dir)
    for name, text in first.items():
        assert (results_dir / name).read_text() == text, name
    for name in (
        "raw_results.jsonl",
        "raw_results.csv",
        "family_summary.csv",
        "template_summary.csv",
        "template_ablation_matrix.csv",
        "stage_summary.csv",
        "unexpected_cases.json",
        "report.md",
        "paper_ablation_table.tex",
        "paper_case_table.tex",
        "ablation_heatmap.svg",
        "paper_manifest.json",
    ):
        assert (results_dir / name).exists(), name
    report = (results_dir / "report.md").read_text()
    assert "## Paper-ready interpretation" in report


def test_duplicates_and_missing_records_are_reported(results_dir):
    records.append(
        results_dir / "raw" / "full-9.jsonl", _record("full", "v0", "violation", "SILENT_VIOLATION")
    )
    (results_dir / "raw" / "minus_verification-0.jsonl").unlink()
    summary = analyze.analyze(results_dir)
    assert summary["counts"]["duplicate_records"] == 1
    assert summary["counts"]["missing_executions"] == 5
    # The first record of a key wins; a duplicate never changes a metric.
    assert summary["profiles"]["full"]["violation_outcomes"]["SILENT_VIOLATION"] == 0
    assert summary["status"]["complete"] is False
    merged = [
        json.loads(line) for line in (results_dir / "raw_results.jsonl").read_text().splitlines()
    ]
    assert len(merged) == len({r["key"] for r in merged})


def test_resume_skips_recorded_keys(tmp_path):
    """The worker's skip rule: a key in any shard of the profile is done."""
    raw = tmp_path / "raw"
    raw.mkdir()
    records.append(raw / "full-0.jsonl", {"key": "full::a"})
    records.append(raw / "full-3.jsonl", {"key": "full::b"})
    done = set()
    for path in raw.glob("full-*.jsonl"):
        done.update(r["key"] for r in records.read(path))
    assert done == {"full::a", "full::b"}
