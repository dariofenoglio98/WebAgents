"""E8's report generator (T38): families, documented differences, the log's counts, the refusals."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import report

# A kept run of the suite (224/224 at a clean commit), read only.
KEPT = ROOT / "conformance/results/2026-11-03T03-58-02-915Z/report.json"


@pytest.fixture
def conformance():
    return json.loads(KEPT.read_text())


@pytest.fixture
def privileges(conformance):
    return {
        "passed": True,
        "failed": [],
        "manifest_sha256": "0" * 64,
        "commit": conformance["environment"]["commit"],
    }


def test_every_case_has_one_family(conformance):
    families = {report.family_of(case["id"]) for case in conformance["cases"]}
    assert families <= {name for name, _ in report.FAMILIES} | {
        "Shipped packages (fixture parity)",
        "Package-format refusals",
    }


def test_a_passing_run_passes_and_counts_add_up(conformance, privileges):
    rows = report.divergence_rows(report.DIVERGENCES)
    summary = report.summarize(conformance, privileges, None, rows)
    assert summary["passed"] is True, summary["problems"]
    families = summary["conformance"]["families"].values()
    assert sum(f["cases"] for f in families) == len(conformance["cases"])
    documented = sum(f["documented_differences"] for f in families)
    assert documented == sum(
        1 for c in conformance["cases"] if c["kind"] == "documented difference"
    )
    assert sum(f["agreed"] for f in families) + documented == len(conformance["cases"])
    log = summary["divergence_log"]
    assert (
        log["items"]
        == len(rows)
        == sum(sum(v.values()) for v in log["by_class"].values())
    )
    assert not log["unclassified"] and not log["without_commit"]


def test_a_disagreeing_case_fails(conformance, privileges):
    broken = copy.deepcopy(conformance)
    case = next(c for c in broken["cases"] if c["kind"] == "fixture parity")
    case["passed"] = False
    summary = report.summarize(
        broken, privileges, None, report.divergence_rows(report.DIVERGENCES)
    )
    assert summary["passed"] is False
    assert summary["conformance"]["disagreeing"] == [case["id"]]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda c, p: c["environment"].update(dirty=True),
        lambda c, p: p.update(commit="0" * 40),
        lambda c, p: p.update(passed=False, failed=["permissions"]),
    ],
)
def test_a_dirty_tree_another_commit_or_a_failed_check_fails(
    conformance, privileges, mutate
):
    mutate(conformance, privileges)
    assert (
        report.summarize(
            conformance, privileges, None, report.divergence_rows(report.DIVERGENCES)
        )["passed"]
        is False
    )


def test_the_cli_writes_a_new_directory_only(tmp_path, conformance, privileges):
    source = tmp_path / "run"
    source.mkdir()
    (source / "report.json").write_text(json.dumps(conformance))
    priv = tmp_path / "privileges.json"
    priv.write_text(json.dumps(privileges))
    out = tmp_path / "out"
    assert (
        report.main(
            ["--conformance", str(source), "--privileges", str(priv), "--out", str(out)]
        )
        == 0
    )
    assert {p.name for p in out.iterdir()} == {
        "summary.json",
        "report.md",
        "privileges.json",
    }
    with pytest.raises(FileExistsError):
        report.main(
            ["--conformance", str(source), "--privileges", str(priv), "--out", str(out)]
        )
