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
    assert families == {name for name, _ in report.FAMILIES} | {report.SHIPPED}


@pytest.mark.parametrize(
    ("case_id", "family"),
    [
        ("tampered-bytes/crc", "Package format and trust"),
        ("wrong-key", "Package format and trust"),
        ("denied-permission/required", "Authorization and execution"),
        ("budget-overrun", "Authorization and execution"),
        ("answer-checks/fixture", "Authorization and execution"),
        ("webair-0.8.0/conversation-hero", report.SHIPPED),
        ("literature-review-0.2.9/memory", report.SHIPPED),
    ],
)
def test_families_are_named_for_their_heads(case_id, family):
    assert report.family_of(case_id) == family


@pytest.mark.parametrize("case_id", ["memory-v1/probe", "webair/fixture", "new-family"])
def test_an_unknown_head_is_an_error(case_id):
    with pytest.raises(report.UnknownFamily):
        report.family_of(case_id)


def test_the_logs_summary_tables_equal_its_rows(tmp_path):
    rows = report.divergence_rows(report.DIVERGENCES)
    assert report.check_log_tables(report.DIVERGENCES, rows) == []
    text = report.DIVERGENCES.read_text()
    edited = tmp_path / "log.md"
    # One row moved from Cr to Py: the runtime table no longer matches.
    line = next(x for x in text.splitlines() if x.startswith("| DV-2 "))
    edited.write_text(text.replace(line, line.replace("| Cr |", "| Py |", 1)))
    problems = report.check_log_tables(edited, report.divergence_rows(edited))
    assert len(problems) == 1 and "By runtime that differed" in problems[0]
    # One task row's total typed wrong.
    edited.write_text(
        text.replace(
            "| T2 | 0 | 0 | 0 | 1 | 1 | 0 | 1 |", "| T2 | 0 | 0 | 0 | 1 | 1 | 0 | 2 |"
        )
    )
    problems = report.check_log_tables(edited, rows)
    assert len(problems) == 1 and "By task" in problems[0]


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
        lambda c, p: (c["environment"].pop("commit"), p.pop("commit")),
        lambda c, p: (c["environment"].update(commit=None), p.update(commit=None)),
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


def test_check_pack_reads_its_line_or_a_kept_copy(tmp_path, conformance, privileges):
    record = {"version": "0.5.0", "passed": True, "problems": []}
    line = tmp_path / "line.json"
    line.write_text("> npm output\n" + json.dumps(record) + "\n")
    kept = tmp_path / "kept.json"
    kept.write_text(json.dumps(record, indent=2) + "\n")
    assert report.read_check_pack(line) == report.read_check_pack(kept) == record
    rows = report.divergence_rows(report.DIVERGENCES)
    assert report.summarize(conformance, privileges, record, rows)["passed"] is True
    other = {**record, "version": "0.4.0"}
    assert report.summarize(conformance, privileges, other, rows)["passed"] is False
    stale = {**record, "commit": "0" * 40}
    assert report.summarize(conformance, privileges, stale, rows)["passed"] is False
