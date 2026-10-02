"""A complete tiny run: files, invariants, metadata, and nothing else touched."""

from __future__ import annotations

import csv
import getpass
import hashlib
import json
import os
import re
import socket
import tempfile
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

import analyze
import benchmark
import pytest

EXPECTED_FILES = {
    "metadata.json",
    "samples.csv",
    "warmup_samples.csv",
    "timestamps.csv",
    "summary.csv",
    "summary.json",
    "batch_summary.csv",
    "audit_samples.csv",
    "component_samples.csv",
    "report.md",
    "paper_table.tex",
    "paper_table_detailed.tex",
    "command.txt",
}
BATCHES, ITERATIONS, WARMUP = 2, 3, 2  # conftest.SMOKE_ARGS


def _rows(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def test_a_run_writes_every_result_file_and_they_parse(smoke_result):
    assert {path.name for path in smoke_result.iterdir()} == EXPECTED_FILES
    json.loads((smoke_result / "metadata.json").read_text())
    json.loads((smoke_result / "summary.json").read_text())
    for name in EXPECTED_FILES:
        if name.endswith(".csv"):
            assert _rows(smoke_result / name), name
    table = (smoke_result / "paper_table.tex").read_text()
    assert table.count("\\begin{tabular}") == 1 and "\\bottomrule" in table
    assert "Paper-ready interpretation" in (smoke_result / "report.md").read_text()
    assert "benchmark.py" in (smoke_result / "command.txt").read_text()


def test_every_iteration_has_every_stage_and_times_are_positive(smoke_result):
    rows = _rows(smoke_result / "samples.csv")
    per_observation = defaultdict(Counter)
    for row in rows:
        per_observation[(row["package_key"], row["batch"], row["iteration"])][row["stage"]] += 1
        assert int(row["elapsed_ns"]) > 0, row
    expected = (
        set(benchmark.STAGES) | set(benchmark.GROUPS) | {benchmark.TOTAL, benchmark.SECONDARY}
    )
    keys = {spec.key for spec in benchmark.PACKAGES}
    assert len(per_observation) == len(keys) * BATCHES * ITERATIONS
    for counts in per_observation.values():
        assert set(counts) == expected
        assert set(counts.values()) == {1}
    warmup = _rows(smoke_result / "warmup_samples.csv")
    assert {row["batch"] for row in warmup} == {"-1"}
    assert len({(r["package_key"], r["iteration"]) for r in warmup}) == len(keys) * WARMUP


def test_the_total_is_a_direct_interval_equal_to_its_contiguous_stages(smoke_result):
    rows = _rows(smoke_result / "samples.csv")
    stamps = _rows(smoke_result / "timestamps.csv")
    by_observation = defaultdict(dict)
    for row in rows:
        by_observation[(row["package_key"], row["batch"], row["iteration"])][row["stage"]] = int(
            row["elapsed_ns"]
        )
    for stamp in stamps:
        values = by_observation[(stamp["package_key"], stamp["batch"], stamp["iteration"])]
        offsets = [int(stamp[f"t{i}_ns"]) for i in range(8)]
        assert offsets[0] == 0
        assert values[benchmark.TOTAL] == offsets[7]
        assert values[benchmark.TOTAL] == sum(values[stage] for stage in benchmark.STAGES)
        for group, (start, end) in benchmark.GROUPS.items():
            assert values[group] == offsets[end] - offsets[start]
        assert values[benchmark.SECONDARY] == int(stamp["read_ns"])


def test_the_summary_is_recomputable_from_the_raw_samples(smoke_result):
    rows = _rows(smoke_result / "samples.csv")
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["package_key"], row["stage"])].append(int(row["elapsed_ns"]))
    summary = _rows(smoke_result / "summary.csv")
    assert len(summary) == len(grouped)
    for record in summary:
        values = grouped[(record["package_key"], record["stage"])]
        assert int(record["n"]) == len(values) == BATCHES * ITERATIONS
        assert float(record["median_ms"]) == pytest.approx(
            analyze.percentile(values, 50) / 1e6, abs=1e-6
        )
        assert float(record["p95_ms"]) == pytest.approx(
            analyze.percentile(values, 95) / 1e6, abs=1e-6
        )
        assert float(record["min_ms"]) == pytest.approx(min(values) / 1e6, abs=1e-6)
        assert float(record["max_ms"]) == pytest.approx(max(values) / 1e6, abs=1e-6)
    table = (smoke_result / "paper_table.tex").read_text()
    for record in summary:
        if record["stage"] == benchmark.TOTAL:
            assert analyze.fmt(float(record["median_ms"])) in table
            assert analyze.fmt(float(record["p95_ms"])) in table


def test_metadata_records_what_is_needed_and_nothing_private(smoke_result):
    text = (smoke_result / "metadata.json").read_text()
    metadata = json.loads(text)
    machine, software, bench = metadata["machine"], metadata["software"], metadata["benchmark"]
    for key in (
        "os",
        "os_version",
        "architecture",
        "cpu_model",
        "logical_cpus",
        "python_version",
        "timer",
    ):
        assert machine.get(key) not in (None, ""), key
    for key in ("git_commit", "git_dirty", "agentpkg_version", "agent_browser_plugin_version"):
        assert key in software, key
    assert software["git_production_paths_modified"] == []
    assert bench["config"]["warmup_iterations_per_package"] == WARMUP
    assert bench["config"]["batches"] == BATCHES
    assert bench["config"]["iterations_per_batch"] == ITERATIONS
    assert bench["config"]["seed"] == benchmark.DEFAULT_SEED
    assert (
        bench["script_sha256"] == hashlib.sha256(Path(benchmark.__file__).read_bytes()).hexdigest()
    )
    datetime.fromisoformat(bench["started_at_utc"]).astimezone(UTC)
    assert metadata["guards"]["offline_violations"] == []
    for key, identity in metadata["packages"].items():
        for field in (
            "package_id",
            "package_version",
            "archive_sha256",
            "package_digest",
            "signer_fingerprint",
            "archive_bytes",
            "archive_entries",
            "graph_nodes",
            "declared_tools",
        ):
            assert field in identity, (key, field)
    # No private identifiers anywhere in the file.
    for private in {str(Path.home()), socket.gethostname().split(".")[0]}:
        if len(private) >= 4:
            assert private not in text, private
    # The user name is looked for where a user name leaks: as a path segment or as a
    # whole JSON string. A substring test would flag the CI user `runner` on the
    # benchmark's own vocabulary (`runner_verification`, "runner outbound frames").
    user = getpass.getuser()
    if len(user) >= 4:
        assert not re.search(rf'[/\\"]{re.escape(user)}[/\\"]', text), user
    # Paths are repository-relative: no absolute user, temp or volume path.
    assert not re.search(r'"/(Users|home|private|var|tmp|Volumes)/', text)


def test_the_audit_and_component_samples_are_complete(smoke_result):
    audit = _rows(smoke_result / "audit_samples.csv")
    assert {row["variant"] for row in audit} == {"no_observer", "progress_observer"}
    assert all(int(row["elapsed_ns"]) > 0 for row in audit)
    components = _rows(smoke_result / "component_samples.csv")
    assert {row["component"] for row in components} == set(benchmark.COMPONENTS)
    assert len(components) == len(benchmark.PACKAGES) * len(benchmark.COMPONENTS) * BATCHES * 2


def test_a_result_directory_is_never_overwritten(tmp_path):
    stamp = datetime(2026, 10, 1, tzinfo=UTC)
    benchmark.result_directory(tmp_path, stamp, None)
    with pytest.raises(FileExistsError):
        benchmark.result_directory(tmp_path, stamp, None)


def _state():
    """Everything outside the result directory a run could plausibly touch."""
    paths = {
        "dist": sorted((benchmark.ROOT / "dist").glob("*.agent.pkg")),
        "fixtures": sorted(benchmark.FIXTURES.iterdir()),
    }
    digests = {
        str(path): hashlib.sha256(path.read_bytes()).hexdigest()
        for group in paths.values()
        for path in group
        if path.is_file()
    }
    home = Path.home()
    trust = Path(
        os.environ.get("AGENTPKG_TRUST_STORE")
        or Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config") / "agentpkg/trust.json"
    )
    digests["trust_store"] = (
        hashlib.sha256(trust.read_bytes()).hexdigest() if trust.exists() else None
    )
    cache = Path(tempfile.gettempdir()) / "agentpkg-browser-cache"
    digests["default_cache"] = sorted(p.name for p in cache.iterdir()) if cache.is_dir() else None
    runs = home / ".openclaw/agent-browser/runs"
    digests["openclaw_runs"] = sorted(p.name for p in runs.iterdir()) if runs.is_dir() else None
    return digests


def test_running_the_pipeline_mutates_no_package_or_runtime_state(tmp_path):
    before = _state()
    pipeline = benchmark.ContractPipeline(tmp_path / "work", benchmark.Fixtures.load())
    try:
        with benchmark.OfflineGuard() as guard:
            for key in ("meeting-agenda", "literature-review"):
                pipeline.run_once(key)
        assert guard.violations == []
    finally:
        pipeline.close()
    assert _state() == before
