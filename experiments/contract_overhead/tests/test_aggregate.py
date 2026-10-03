"""Pooling several runs: the published result is reproduced, and mixed series are refused."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess

import aggregate
import analyze
import benchmark
import pytest

ROOT = benchmark.ROOT
# The two-package paper runs at commit 23eac90 (the current paper's Table III).
PAPER_RUNS = [
    benchmark.RESULTS / "2026-10-02T12-53-19Z_paper-run1",
    benchmark.RESULTS / "2026-10-02T13-03-41Z_paper-run2",
    benchmark.RESULTS / "2026-10-02T13-14-02Z_paper-run3",
]
EARLIER_RESULTS = [
    benchmark.RESULTS / "2026-10-02T02-38-58Z_smoke",
    benchmark.RESULTS / "2026-10-02T02-39-10Z_candidate",
    *PAPER_RUNS,
]


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True, timeout=30
    ).stdout


def test_the_earlier_result_directories_are_committed_and_unmodified():
    if shutil.which("git") is None or not (ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    for directory in EARLIER_RESULTS:
        relative = str(directory.relative_to(ROOT))
        tracked = _git("ls-files", relative).split()
        assert len(tracked) >= 12, relative
        assert _git("status", "--porcelain", "--", relative) == "", relative


def test_pooling_the_paper_runs_reproduces_the_published_table(tmp_path):
    document = aggregate.aggregate(PAPER_RUNS, tmp_path / "pooled")
    summary = {(r["package_key"], r["stage"]): r for r in document["summary"]}
    published = {
        # Table III of the two-package paper: pooled median (p95), ms.
        ("meeting-agenda", "verification"): (18.91, 19.49),
        ("meeting-agenda", "authorization_and_binding"): (0.89, 0.94),
        ("meeting-agenda", "run_plan"): (1.28, 1.33),
        ("meeting-agenda", "revalidation"): (34.96, 36.01),
        ("meeting-agenda", "total_pre_execution"): (56.05, 57.71),
        ("literature-review", "verification"): (148.85, 154.81),
        ("literature-review", "authorization_and_binding"): (1.87, 1.93),
        ("literature-review", "run_plan"): (3.05, 3.12),
        ("literature-review", "revalidation"): (281.20, 287.81),
        ("literature-review", "total_pre_execution"): (436.08, 444.38),
    }
    for key, (median, p95) in published.items():
        record = summary[key]
        assert record["n"] == 3000
        assert round(record["ms"]["median"], 2) == median, key
        assert round(record["ms"]["p95"], 2) == p95, key
    # "The three run medians ranged from 55.83 to 56.36 ms and from 434.23 to 438.57 ms."
    ma = summary[("meeting-agenda", "total_pre_execution")]
    lr = summary[("literature-review", "total_pre_execution")]
    assert [round(v, 2) for v in ma["run_median_range_ms"]] == [55.83, 56.36]
    assert [round(v, 2) for v in lr["run_median_range_ms"]] == [434.23, 438.57]
    # "total medians have coefficients of variation of 0.48% and 0.50%", and "at most 0.64%".
    assert round(ma["run_median_cv_pct"], 2) == 0.48
    assert round(lr["run_median_cv_pct"], 2) == 0.50
    worst = max(
        r["run_median_cv_pct"] for r in document["summary"] if r["kind"] in {"stage", "group"}
    )
    assert round(worst, 2) == 0.64
    table = (tmp_path / "pooled" / "paper_table.tex").read_text()
    assert "\\begin{tabular}{@{}lrr@{}}" in table
    assert "\\textbf{56.05 (57.71)} & \\textbf{436.08 (444.38)}" in table
    # Reading never writes into an input directory.
    test_the_earlier_result_directories_are_committed_and_unmodified()


def _synthetic_run(directory, smoke_dir, *, offset_ns: int, commit: str | None = None):
    """A complete run directory with known samples over a real three-package metadata file."""
    directory.mkdir()
    metadata = json.loads((smoke_dir / "metadata.json").read_text())
    metadata["software"]["git_tracked_changes"] = []
    if commit is not None:
        metadata["software"]["git_commit"] = commit
    (directory / "metadata.json").write_text(json.dumps(metadata))
    order = analyze.stage_order(metadata)
    rows = []
    for package_index, key in enumerate(metadata["packages"]):
        identity = metadata["packages"][key]
        for batch in range(2):
            for iteration in range(5):
                for stage_index, (kind, stage) in enumerate(order):
                    rows.append(
                        {
                            "package_key": key,
                            "package_id": identity["package_id"],
                            "package_version": identity["package_version"],
                            "batch": batch,
                            "iteration": iteration,
                            "position": iteration % 3,
                            "kind": kind,
                            "stage": stage,
                            "elapsed_ns": (package_index + 1) * (stage_index + 1) * 1_000_000
                            + (batch * 5 + iteration) * 1_000
                            + offset_ns,
                        }
                    )
    with open(directory / "samples.csv", "w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    return metadata


def test_three_runs_of_three_packages_pool_into_a_three_column_table(tmp_path, smoke_result):
    runs = [tmp_path / f"run{i}" for i in range(3)]
    for index, directory in enumerate(runs):
        metadata = _synthetic_run(directory, smoke_result, offset_ns=index * 10_000)
    assert list(metadata["packages"]) == ["meeting-agenda", "literature-review", "webair"]
    document = aggregate.aggregate(runs, tmp_path / "pooled")
    assert document["observations_per_package"] == 30
    total = metadata["benchmark"]["total"]["stage"]
    total_index = [stage for _, stage in analyze.stage_order(metadata)].index(total)
    for package_index, key in enumerate(metadata["packages"]):
        base = (package_index + 1) * (total_index + 1) * 1_000_000
        values = [base + i * 1_000 + r * 10_000 for r in range(3) for i in range(10)]
        record = next(
            r for r in document["summary"] if r["package_key"] == key and r["stage"] == total
        )
        assert record["n"] == 30
        assert record["ms"]["median"] == pytest.approx(analyze.percentile(values, 50) / 1e6)
        assert record["ms"]["p95"] == pytest.approx(analyze.percentile(values, 95) / 1e6)
        assert record["run_medians_ms"] == pytest.approx(
            [(base + 4_500 + r * 10_000) / 1e6 for r in range(3)]
        )
    table = (tmp_path / "pooled" / "paper_table.tex").read_text()
    assert "\\begin{tabular}{@{}lrrr@{}}" in table
    assert (
        "Operation & \\shortstack{Meeting\\\\Agenda} & \\shortstack{Literature\\\\Review} & WebAir"
        in table
    )
    assert table.count("(") >= 15  # five rows x three packages, "median (p95)"
    with pytest.raises(FileExistsError):
        aggregate.aggregate(runs, tmp_path / "pooled")


def test_runs_from_different_commits_are_not_pooled(tmp_path, smoke_result):
    first, second = tmp_path / "a", tmp_path / "b"
    _synthetic_run(first, smoke_result, offset_ns=0)
    _synthetic_run(second, smoke_result, offset_ns=0, commit="0" * 40)
    with pytest.raises(SystemExit, match="git_commit differs"):
        aggregate.aggregate([first, second], tmp_path / "pooled")
    assert not (tmp_path / "pooled").exists()


def test_runs_with_tracked_changes_are_not_pooled(tmp_path, smoke_result):
    first, second = tmp_path / "a", tmp_path / "b"
    _synthetic_run(first, smoke_result, offset_ns=0)
    metadata = _synthetic_run(second, smoke_result, offset_ns=0)
    metadata["software"]["git_tracked_changes"] = ["experiments/contract_overhead/benchmark.py"]
    (second / "metadata.json").write_text(json.dumps(metadata))
    with pytest.raises(SystemExit, match="tracked changes"):
        aggregate.aggregate([first, second], tmp_path / "pooled")
