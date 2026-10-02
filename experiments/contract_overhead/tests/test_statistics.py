"""The statistics and the analysis, on inputs whose answers are known by hand."""

from __future__ import annotations

import csv
import json
import math
import shutil

import analyze
import pytest


def test_percentile_type7_matches_hand_computed_values():
    assert analyze.percentile([1, 2, 3, 4], 50) == 2.5
    # h = (n - 1) p = 3 * 0.95 = 2.85 -> 3 + 0.85 * (4 - 3)
    assert analyze.percentile([4, 1, 3, 2], 95) == pytest.approx(3.85)
    # h = 4 * 0.4 = 1.6 -> 20 + 0.6 * (35 - 20)
    assert analyze.percentile([15, 20, 35, 40, 50], 40) == pytest.approx(29.0)
    values = list(range(1, 101))
    assert analyze.percentile(values, 50) == pytest.approx(50.5)
    assert analyze.percentile(values, 95) == pytest.approx(95.05)
    assert analyze.percentile(values, 0) == 1
    assert analyze.percentile(values, 100) == 100
    assert analyze.percentile([7], 95) == 7


def test_percentile_refuses_empty_and_out_of_range():
    with pytest.raises(ValueError):
        analyze.percentile([], 50)
    with pytest.raises(ValueError):
        analyze.percentile([1, 2], 101)


def test_describe_on_a_known_sample():
    stats = analyze.describe([2, 4, 4, 4, 5, 5, 7, 9])
    assert stats["n"] == 8
    assert stats["mean"] == pytest.approx(5.0)
    assert stats["std"] == pytest.approx(math.sqrt(32 / 7))  # sample std, ddof = 1
    assert stats["median"] == pytest.approx(4.5)
    assert stats["min"] == 2 and stats["max"] == 9
    assert stats["p95"] == pytest.approx(analyze.percentile([2, 4, 4, 4, 5, 5, 7, 9], 95))
    single = analyze.describe([3])
    assert single["std"] == 0.0 and single["median"] == 3


def test_scaled_keeps_n_and_divides_everything_else():
    stats = analyze.scaled({"n": 4, "median": 2_000_000.0, "p95": 3_000_000.0}, analyze.NS_PER_MS)
    assert stats == {"n": 4, "median": 2.0, "p95": 3.0}


def _synthetic(result_dir, smoke_dir):
    """Known samples written over a real metadata file, then analyzed."""
    metadata = json.loads((smoke_dir / "metadata.json").read_text())
    bench = metadata["benchmark"]
    stages = (
        [("stage", item["stage"]) for item in bench["stages"]]
        + [("group", item["group"]) for item in bench["groups"]]
        + [("total", bench["total"]["stage"]), ("secondary", bench["secondary"]["stage"])]
    )
    rows = []
    for package_index, key in enumerate(metadata["packages"]):
        identity = metadata["packages"][key]
        for batch in range(2):
            for iteration in range(10):
                for stage_index, (kind, stage) in enumerate(stages):
                    value = (package_index + 1) * (stage_index + 1) * 1_000_000 + (
                        batch * 10 + iteration
                    ) * 1_000
                    rows.append(
                        {
                            "package_key": key,
                            "package_id": identity["package_id"],
                            "package_version": identity["package_version"],
                            "batch": batch,
                            "iteration": iteration,
                            "position": iteration % 2,
                            "kind": kind,
                            "stage": stage,
                            "elapsed_ns": value,
                        }
                    )
    shutil.copy(smoke_dir / "metadata.json", result_dir / "metadata.json")
    with open(result_dir / "samples.csv", "w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    return metadata, stages


def test_analysis_of_synthetic_samples_returns_the_expected_statistics(tmp_path, smoke_result):
    metadata, stages = _synthetic(tmp_path, smoke_result)
    analyze.analyze(tmp_path)
    with open(tmp_path / "summary.csv", newline="") as stream:
        summary = {(row["package_key"], row["stage"]): row for row in csv.DictReader(stream)}
    for package_index, key in enumerate(metadata["packages"]):
        for stage_index, (_, stage) in enumerate(stages):
            base = (package_index + 1) * (stage_index + 1) * 1_000_000
            values = [base + offset * 1_000 for offset in range(20)]
            row = summary[(key, stage)]
            assert int(row["n"]) == 20
            # offsets 0..19 us: median 9.5 us, p95 at h = 19 * 0.95 = 18.05 us
            assert float(row["median_ms"]) == pytest.approx((base + 9_500) / 1e6, abs=1e-6)
            assert float(row["p95_ms"]) == pytest.approx((base + 18_050) / 1e6, abs=1e-6)
            assert float(row["mean_ms"]) == pytest.approx(sum(values) / 20 / 1e6, abs=1e-6)
            assert float(row["min_ms"]) == pytest.approx(base / 1e6)
            assert float(row["max_ms"]) == pytest.approx((base + 19_000) / 1e6)
            sample_std = math.sqrt(sum((v - sum(values) / 20) ** 2 for v in values) / 19)
            assert float(row["std_ms"]) == pytest.approx(sample_std / 1e6, abs=1e-6)
    document = json.loads((tmp_path / "summary.json").read_text())
    assert len(document["summary"]) == len(metadata["packages"]) * len(stages)
    table = (tmp_path / "paper_table.tex").read_text()
    total_index = [stage for _, stage in stages].index(metadata["benchmark"]["total"]["stage"])
    for package_index, _ in enumerate(metadata["packages"]):
        base = (package_index + 1) * (total_index + 1) * 1_000_000
        assert analyze.fmt((base + 9_500) / 1e6) in table
    batches = list(csv.DictReader(open(tmp_path / "batch_summary.csv", newline="")))
    first = next(r for r in batches if r["batch"] == "0" and r["kind"] == "total")
    assert int(first["n"]) == 10
