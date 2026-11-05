"""Benchmark v2 (E7, T38): the two runtimes' pipelines, the inputs, the pooling rules, rule 2.

The smoke run is a complete benchmark run (both runtimes, both arms) at the smallest preset, in a
child process with no credentials, into a temporary directory.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

EXPERIMENT = Path(__file__).resolve().parents[1]
ROOT = EXPERIMENT.parents[1]
if str(EXPERIMENT) not in sys.path:
    sys.path.insert(0, str(EXPERIMENT))

import aggregate_v2
import benchmark_v2

# The v1 scripts' SHA-256 as the RQ2 results record them (rule 2: never edited).
RQ2_RUN = EXPERIMENT / "results/2026-10-03T15-08-48Z_paper-webair-run1/metadata.json"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_v1_scripts_are_the_recorded_ones():
    recorded = json.loads(RQ2_RUN.read_text())["benchmark"]
    assert _sha(EXPERIMENT / "benchmark.py") == recorded["script_sha256"]
    assert _sha(EXPERIMENT / "analyze.py") == recorded["analysis_script_sha256"]


@pytest.fixture(scope="session")
def bundle():
    path, info = benchmark_v2.node_build()
    return path, info


def test_fixtures_are_reproducible(bundle):
    assert benchmark_v2.check_fixtures(bundle[0]) == []


def test_python_registries_hold_only_what_the_reference_shell_binds():
    for spec in benchmark_v2.PACKAGES:
        registry = json.loads(
            (benchmark_v2.FIXTURES / f"host-tool-registry.{spec.key}.json").read_text()
        )
        for binding in registry["bindings"]:
            assert (
                binding["implementation_kind"] in benchmark_v2.PY_IMPLEMENTATION_KINDS
            )
            assert set(binding) <= benchmark_v2.PY_BINDING_FIELDS


def test_the_bundle_exposes_only_the_transition_check(bundle):
    path, info = bundle
    assert benchmark_v2.EXPOSE_SUFFIX == "\nexport { checkTransition };\n"
    assert info["exposed"]["appended"] == benchmark_v2.EXPOSE_SUFFIX
    hello = subprocess.run(
        ["node", str(path / "bench.js"), "hello"],
        capture_output=True,
        text=True,
        check=True,
    )
    answer = json.loads(hello.stdout.strip().splitlines()[-1])
    assert answer["check_transition_exposed"] is True
    # The production file is untouched; the appended export names a function it defines.
    source = (ROOT / "chrome-agent-browser/src/core/network/runner.ts").read_text()
    assert "\nfunction checkTransition(" in source
    assert "export { checkTransition }" not in source


def test_synthetic_star_network_matches_the_travel_network():
    """The 4-role star is the Travel Network's own shape, so its worst case is the package's."""
    from agentpkg.delegation.analysis import enumerate_walks, worst_case
    from agentpkg.package import load_package

    travel = load_package(benchmark_v2.SPECS["travel-network"].archive)
    synthetic = benchmark_v2.network_graph(4, "star")
    own, ours = (
        worst_case(travel.graph, travel.policy),
        worst_case(synthetic, travel.policy),
    )
    for field in (
        "max_hops",
        "max_activations",
        "model_calls",
        "remote_calls",
        "tokens",
        "seconds",
    ):
        assert ours[field] == own[field], field
    assert len(enumerate_walks(synthetic["network"])) == len(
        enumerate_walks(travel.graph["network"])
    )


def test_mesh_networks_grow_until_the_enumerator_cap():
    from agentpkg.delegation.analysis import EffortExceeded, enumerate_walks

    counts = []
    for roles in benchmark_v2.NETWORK_ROLES:
        try:
            counts.append(
                len(
                    enumerate_walks(
                        benchmark_v2.network_graph(roles, "mesh")["network"]
                    )
                )
            )
        except EffortExceeded:
            counts.append(None)
    known = [c for c in counts if c is not None]
    assert known == sorted(known) and len(set(known)) == len(known)
    assert counts[-1] is None, "the largest mesh is expected to reach the effort cap"


@pytest.mark.parametrize("kib", [1, 16])
def test_scan_documents_hold_no_sealed_value(kib):
    from agentpkg.memory.scan import find_all_sealed

    document = benchmark_v2.scan_document(kib, 1)
    size = len(json.dumps(document))
    assert kib * 1024 <= size < kib * 1024 + 2048
    assert find_all_sealed(document, benchmark_v2.scan_set(100, 1)) == []
    # A value of the set placed in the document is found (the arm times a real scan).
    planted = {**document, "extra": benchmark_v2.scan_set(100, 1)[42]["value"]}
    assert (
        find_all_sealed(planted, benchmark_v2.scan_set(100, 1))[0]["record_id"]
        == "rec-0042"
    )


@pytest.fixture(scope="session")
def smoke(tmp_path_factory, bundle):
    out = tmp_path_factory.mktemp("results")
    home = tmp_path_factory.mktemp("home")
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "TMPDIR": str(tmp_path_factory.mktemp("tmp")),
    }
    completed = subprocess.run(
        [
            sys.executable,
            str(EXPERIMENT / "benchmark_v2.py"),
            "--preset",
            "smoke",
            "--out",
            str(out),
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr[-4000:]
    answer = json.loads(completed.stdout.strip().splitlines()[-1])
    directory = (
        ROOT / answer["result_directory"]
        if not Path(answer["result_directory"]).is_absolute()
        else Path(answer["result_directory"])
    )
    return directory, answer


def _rows(path: Path) -> list[dict]:
    with open(path, newline="") as stream:
        return list(csv.DictReader(stream))


def test_smoke_run_passes_on_both_runtimes(smoke):
    directory, answer = smoke
    assert answer["passed"] is True
    metadata = json.loads((directory / "metadata.json").read_text())
    assert (directory / "manifest.json").is_file()
    assert metadata["guards"] == {"offline_violations": [], "node_violations": []}
    assert metadata["package_file_sha256_before_after_equal"] is True
    assert metadata["micro_facts_agree"] is True
    rows = _rows(directory / "samples.csv")
    config = metadata["benchmark"]["config"]
    per = config["batches"] * config["iterations"]
    counts: dict[tuple, int] = {}
    for row in rows:
        if row["stage"] == "total_pre_execution":
            counts[(row["runtime"], row["package_key"])] = (
                counts.get((row["runtime"], row["package_key"]), 0) + 1
            )
    # Node: all four packages; Python: all but the one its control plane prepares no plan for.
    assert {key for (runtime, key) in counts if runtime == "ts"} == set(
        benchmark_v2.SPECS
    )
    assert {key for (runtime, key) in counts if runtime == "py"} == set(
        benchmark_v2.SPECS
    ) - {"literature-review"}
    assert set(counts.values()) == {per}


def test_python_records_why_it_cannot_plan_literature_review(smoke):
    metadata = json.loads((smoke[0] / "metadata.json").read_text())
    refusal = metadata["py_unrunnable"]["literature-review"]
    assert refusal["code"] == "run_plan_refused"
    assert {(r["code"], r["subject"]) for r in refusal["blocking_reasons"]} >= {
        ("tool_not_bound", "agent-notes.read"),
        ("tool_not_bound", "agent-notes.write"),
    }


def test_each_observation_is_a_contiguous_interval(smoke):
    rows = _rows(smoke[0] / "samples.csv")
    per: dict[tuple, dict] = {}
    for row in rows:
        per.setdefault(
            (row["runtime"], row["package_key"], row["batch"], row["iteration"]), {}
        )[row["stage"]] = int(row["elapsed_ns"])
    for stages in per.values():
        assert stages["total_pre_execution"] == sum(
            stages[s] for s in benchmark_v2.STAGES
        )
        assert all(value > 0 for value in stages.values())


def test_runner_stages_stop_before_any_node(smoke):
    metadata = json.loads((smoke[0] / "metadata.json").read_text())
    for runtime in ("py", "ts"):
        for key, evidence in metadata["evidence"][runtime].items():
            actions = evidence["audit_actions_at_stop"]
            assert "node.started" not in actions, (runtime, key)
            assert not any(a.startswith(("model.", "tool.")) for a in actions), (
                runtime,
                key,
            )
    assert metadata["evidence"]["py"]["webair"]["runner"].startswith("conversation")


def test_micro_arms_cover_every_cell_on_both_runtimes(smoke):
    directory, _ = smoke
    metadata = json.loads((directory / "metadata.json").read_text())
    rows = _rows(directory / "micro_samples.csv")
    seen = {(r["runtime"], r["arm"], r["cell"]) for r in rows}
    cells = metadata["micro_inputs"]["cells"]
    for runtime in ("py", "ts"):
        for cell in cells["scans"]:
            assert (runtime, "scan_model_request", cell) in seen
            assert (runtime, "scan_tool_arguments", cell) in seen
        for cell in cells["networks"]:
            for arm in (
                "network_worst_case",
                "network_enumerate",
                "network_route_data",
            ):
                assert (runtime, arm, cell) in seen
        for arm, cell in (
            ("compute_cold", "fares"),
            ("compute_warm", "fares"),
            ("transition_check", "travel-network"),
            ("consent_gate", "gated_accepted"),
            ("consent_gate", "not_gated"),
        ):
            assert (runtime, arm, cell) in seen


def test_analysis_files_and_pooling_rules(smoke, tmp_path):
    directory, _ = smoke
    for name in ("summary.json", "summary.csv", "micro_summary.csv", "report.md"):
        assert (directory / name).is_file()
    summary = json.loads((directory / "summary.json").read_text())
    assert {r["kind"] for r in summary["pre"]} == {"stage", "group", "total"}
    # Two copies of one run cannot be pooled (a run listed twice); a dirty tree needs the test flag.
    with pytest.raises(SystemExit):
        aggregate_v2.pool(
            [directory, directory], tmp_path / "twice", require_clean=False
        )
    other = tmp_path / directory.name.replace("smoke", "smoke-copy")
    other.mkdir()
    for name in ("samples.csv", "micro_samples.csv"):
        (other / name).write_bytes((directory / name).read_bytes())
    metadata = json.loads((directory / "metadata.json").read_text())
    (other / "metadata.json").write_text(json.dumps(metadata))
    pooled = aggregate_v2.pool(
        [directory, other], tmp_path / "pooled", require_clean=False
    )
    total = next(
        r
        for r in pooled["pre"]
        if r["runtime"] == "ts"
        and r["package_key"] == "webair"
        and r["quantity"] == "total_pre_execution"
    )
    assert (
        total["n"]
        == 2
        * metadata["benchmark"]["config"]["batches"]
        * metadata["benchmark"]["config"]["iterations"]
    )
    assert len(total["run_medians"]) == 2
    # A run from another commit is refused.
    metadata["software"]["git_commit"] = "0" * 40
    (other / "metadata.json").write_text(json.dumps(metadata))
    with pytest.raises(SystemExit):
        aggregate_v2.pool([directory, other], tmp_path / "mixed", require_clean=False)
    # Another Node toolchain, or an untracked file under a production path, is refused too.
    metadata["software"]["git_commit"] = json.loads(
        (directory / "metadata.json").read_text()
    )["software"]["git_commit"]
    problems = aggregate_v2.check_series(
        [
            (directory, json.loads((directory / "metadata.json").read_text())),
            (other, metadata),
        ],
        require_clean=False,
    )
    assert problems == []
    metadata["software"]["node_build"]["tools"]["esbuild"] = "0.0.0"
    metadata["software"]["git_untracked"] = ["agentpkg/src/agentpkg/extra.py"]
    problems = aggregate_v2.check_series(
        [
            (directory, json.loads((directory / "metadata.json").read_text())),
            (other, metadata),
        ],
        require_clean=False,
    )
    assert any("node_build.tools differs" in p for p in problems)
    assert any("untracked files under production paths" in p for p in problems)
