#!/usr/bin/env python3
"""The conformance report and the divergence log in figures (E8, `experiments/PROTOCOL.md` §3 E8; T38, D-306).

    agentpkg/.venv/bin/python experiments/conformance_report/report.py \\
        --conformance conformance/results/<UTC> --privileges PRIVILEGES.json \\
        [--check-pack CHECK_PACK.json] [--out experiments/conformance_report/results/<UTC>]

Reads, never edits: the conformance suite's `report.json` (`node conformance/run.mjs` at the
final commit), the JSON of `scripts/check_extension_privileges.py` and of `npm run check-pack`
at the same commit, and the table of `docs/conformance-divergences.md`. Writes one new directory
(it must not exist) with `summary.json` and `report.md` (Tab. 10's rows: cases per family, agreed,
documented differences; the divergence log counted by class, resolution, how it was found, the
runtime that differed and the task; P-19's two checks) and copies of the two JSON inputs. Every
number is computed here; nothing is typed in. Every case head must belong to a listed family (an
unknown head is an error). Prints one JSON line with `"passed"`: the suite passed at a clean
commit, every case that is not a documented difference agreed, the privileges check passed, the
conformance run and the privileges check each name a commit and it is the same one, check-pack's
extension version is the run's Chrome core, and the log's summary tables equal what its rows give.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DIVERGENCES = ROOT / "docs" / "conformance-divergences.md"

# A case's family, from its id's first segment. Every head is listed; an unknown head is an error,
# so a new case family must be named here before a report can count it.
FAMILIES = (
    ("Agent Memory", ("memory", "memory-probe")),
    ("Agent Compute", ("compute", "compute-test")),
    ("Agent Conversations", ("conversation", "conversation-test")),
    ("Agent Delegation", ("network", "network-test", "travel-network")),
    ("Control plane", ("control-plane",)),
    ("Package format and trust", ("tampered-bytes", "unpinned-key", "wrong-key")),
    (
        "Authorization and execution",
        (
            "missing-approval",
            "denied-permission",
            "once-overused",
            "budget-overrun",
            "schema-invalid-output",
            "answer-check-refused",
            "answer-checks",
        ),
    ),
)
SHIPPED = "Shipped packages (fixture parity)"
# A shipped package's cases are headed `<name>-<version>`.
SHIPPED_HEAD = re.compile(r"(webair|literature-review|meeting-agenda)-\d+\.\d+\.\d+")
CLASSES = ("behaviour", "wording", "timing", "platform")
RESOLUTIONS = ("fixed", "documented")
FOUND = ("suite", "test", "review", "live")
# The log's Wrong column, by its first token, and the label its summary table uses.
RUNTIMES = (
    ("Cr", "Cr (Chrome core)"),
    ("Py", "Py (Python reference)"),
    ("both", "both / neither alone"),
)


class UnknownFamily(ValueError):
    """A case id whose head no family lists."""


def family_of(case_id: str) -> str:
    head = case_id.split("/")[0]
    for name, heads in FAMILIES:
        if head in heads:
            return name
    if SHIPPED_HEAD.fullmatch(head):
        return SHIPPED
    raise UnknownFamily(f"no family lists the case head {head!r} ({case_id})")


def divergence_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("| DV-"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        rows.append(
            {
                "id": cells[0],
                "date": cells[1],
                "task": cells[2],
                "found_by": cells[4],
                "wrong": cells[5],
                "runtime": cells[5].split()[0] if cells[5] else "",
                "first_task": (re.findall(r"T\d+[a-z]?", cells[2]) or [""])[0],
                "class": cells[6],
                "resolution": cells[7],
                "commits": re.findall(r"`([0-9a-f]{7,40})`", cells[8]),
            }
        )
    return rows


def summary_tables(path: Path) -> dict[str, list[list[str]]]:
    """The tables under the log's `## Summary`, by their `###` heading, as rows of cells."""
    tables: dict[str, list[list[str]]] = {}
    heading = None
    in_summary = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            in_summary = line.strip() == "## Summary"
            heading = None
        elif in_summary and line.startswith("### "):
            heading = line[4:].strip()
            tables[heading] = []
        elif heading and line.startswith("|") and not line.startswith("|---"):
            tables[heading].append(
                [cell.strip() for cell in line.strip().strip("|").split("|")]
            )
    # Drop each table's header row.
    return {name: rows[1:] for name, rows in tables.items() if rows}


def _row(label: str, counts: Counter) -> list[str]:
    fixed, documented = counts.get("fixed", 0), counts.get("documented", 0)
    return [label, str(fixed), str(documented), str(fixed + documented)]


def _task_key(task: str) -> tuple[int, str]:
    match = re.fullmatch(r"T(\d+)([a-z]?)", task)
    return (int(match.group(1)), match.group(2)) if match else (10**6, task)


def expected_tables(divergences: list[dict]) -> dict[str, list[list[str]]]:
    """The summary tables the log's rows imply, in the log's own layout."""

    def by(key: str, value: str) -> Counter:
        return Counter(r["resolution"] for r in divergences if r[key] == value)

    total = Counter(r["resolution"] for r in divergences)
    tasks = []
    for task in sorted({r["first_task"] for r in divergences}, key=_task_key):
        rows = [r for r in divergences if r["first_task"] == task]
        classes = Counter(r["class"] for r in rows)
        resolutions = Counter(r["resolution"] for r in rows)
        tasks.append(
            [
                task,
                *(str(classes.get(k, 0)) for k in CLASSES),
                str(resolutions.get("fixed", 0)),
                str(resolutions.get("documented", 0)),
                str(len(rows)),
            ]
        )
    return {
        "By class and resolution": [
            *(_row(k, by("class", k)) for k in CLASSES),
            _row("**all**", total),
        ],
        "By how it was found": [_row(k, by("found_by", k)) for k in FOUND],
        "By runtime that differed": [
            _row(label, by("runtime", key)) for key, label in RUNTIMES
        ],
        "By task": tasks,
    }


def check_log_tables(path: Path, divergences: list[dict]) -> list[str]:
    """Each summary table of the log against its rows; one problem per table that differs."""
    found = summary_tables(path)
    problems = []
    for name, rows in expected_tables(divergences).items():
        if found.get(name) != rows:
            problems.append(
                f"the divergence log's table {name!r} differs from its rows: "
                f"the rows give {rows}, the file has {found.get(name)}"
            )
    fixed = sum(r["resolution"] == "fixed" for r in divergences)
    headline = (
        f"**{len(divergences)} divergences**, {fixed} fixed and "
        f"{len(divergences) - fixed} documented."
    )
    if headline not in path.read_text(encoding="utf-8"):
        problems.append(f"the divergence log's summary does not read {headline!r}")
    return problems


def summarize(
    conformance: dict,
    privileges: dict,
    check_pack: dict | None,
    divergences: list[dict],
    log_problems: list[str] | None = None,
) -> dict:
    families: dict[str, dict] = {}
    for case in conformance["cases"]:
        record = families.setdefault(
            family_of(case["id"]),
            {
                "cases": 0,
                "agreed": 0,
                "documented_differences": 0,
                "pending": 0,
                "kinds": Counter(),
            },
        )
        record["cases"] += 1
        record["kinds"][case["kind"]] += 1
        documented = case["kind"] == "documented difference"
        record["documented_differences"] += documented
        record["pending"] += bool(case.get("pending"))
        record["agreed"] += bool(case["passed"]) and not documented
    for record in families.values():
        record["kinds"] = dict(sorted(record["kinds"].items()))
    disagreeing = [
        c["id"]
        for c in conformance["cases"]
        if not c["passed"] and c["kind"] != "documented difference"
    ]
    log = {
        "items": len(divergences),
        "by_class": {
            k: Counter(r["resolution"] for r in divergences if r["class"] == k)
            for k in CLASSES
        },
        "by_found": {
            k: Counter(r["resolution"] for r in divergences if r["found_by"] == k)
            for k in FOUND
        },
        "by_resolution": Counter(r["resolution"] for r in divergences),
        "by_runtime": {
            key: dict(
                Counter(r["resolution"] for r in divergences if r["runtime"] == key)
            )
            for key, _ in RUNTIMES
        },
        "by_task": {
            task: dict(
                Counter(r["resolution"] for r in divergences if r["first_task"] == task)
            )
            for task in sorted({r["first_task"] for r in divergences}, key=_task_key)
        },
        "unclassified": [
            r["id"]
            for r in divergences
            if r["class"] not in CLASSES
            or r["resolution"] not in RESOLUTIONS
            or r["found_by"] not in FOUND
            or r["runtime"] not in dict(RUNTIMES)
            or not r["first_task"]
        ],
        "without_commit": [r["id"] for r in divergences if not r["commits"]],
    }
    log["by_class"] = {k: dict(v) for k, v in log["by_class"].items()}
    log["by_found"] = {k: dict(v) for k, v in log["by_found"].items()}
    log["by_resolution"] = dict(log["by_resolution"])
    environment = conformance["environment"]
    commits = {
        "conformance": environment.get("commit"),
        "privileges": privileges.get("commit"),
    }
    problems = []
    if not conformance.get("passed"):
        problems.append("the conformance suite did not pass")
    if environment.get("dirty"):
        problems.append("the conformance run was made on a dirty tree")
    if disagreeing:
        problems.append(
            f"cases that disagree and are not documented differences: {disagreeing}"
        )
    if not privileges.get("passed"):
        problems.append(
            f"check_extension_privileges failed: {privileges.get('failed')}"
        )
    if check_pack is not None and not check_pack.get("passed"):
        problems.append("npm run check-pack failed")
    if check_pack is not None:
        # check-pack's line names no commit; when it carries one, it must be the same. Its
        # extension version must be the one the conformance run's Chrome core names.
        if "commit" in check_pack:
            commits["check_pack"] = check_pack["commit"]
        core = str(environment.get("chrome_core") or "")
        if f"chrome-agent-browser {check_pack.get('version')} " not in core + " ":
            problems.append(
                f"check-pack's version {check_pack.get('version')!r} is not the conformance "
                f"run's Chrome core ({core!r})"
            )
    if None in commits.values() or "" in commits.values():
        problems.append(f"an input names no commit: {commits}")
    elif len(set(commits.values())) != 1:
        problems.append(f"the inputs name different commits: {commits}")
    if log["unclassified"] or log["without_commit"]:
        problems.append("a divergence row is unclassified or names no commit")
    problems.extend(log_problems or [])
    return {
        "conformance": {
            "generated_at": conformance["generated_at"],
            "environment": environment,
            "summary": conformance["summary"],
            "families": families,
            "disagreeing": disagreeing,
        },
        "privileges": {
            "passed": privileges.get("passed"),
            "failed": privileges.get("failed"),
            "manifest_sha256": privileges.get("manifest_sha256"),
        },
        "check_pack": None
        if check_pack is None
        else {
            "passed": check_pack.get("passed"),
            "problems": check_pack.get("problems"),
        },
        "divergence_log": log,
        "commits": commits,
        "problems": problems,
        "passed": not problems,
    }


def report(summary: dict, sources: dict) -> str:
    conformance = summary["conformance"]
    environment = conformance["environment"]
    lines = [
        "# Conformance report (E8, Tab. 10)",
        "",
        "Every number below is computed by `experiments/conformance_report/report.py` from the files it names.",
        "",
        *[f"- {name}: `{path}`" for name, path in sources.items()],
        f"- Commit `{environment.get('commit')}` (dirty: {environment.get('dirty')}); {environment.get('agentpkg')}; {environment.get('chrome_core')}; {environment.get('python')}; Node {environment.get('node')}; {environment.get('platform')}.",
        "",
        "## Cases per family",
        "",
        "| Family | Cases | Agreed | Documented differences | Kinds |",
        "|---|---:|---:|---:|---|",
    ]
    totals = Counter()
    for name, record in sorted(conformance["families"].items()):
        kinds = ", ".join(f"{k} {v}" for k, v in record["kinds"].items())
        lines.append(
            f"| {name} | {record['cases']} | {record['agreed']} | {record['documented_differences']} | {kinds} |"
        )
        totals.update(
            {k: record[k] for k in ("cases", "agreed", "documented_differences")}
        )
    lines += [
        f"| **All** | {totals['cases']} | {totals['agreed']} | {totals['documented_differences']} | |",
        "",
        (
            f"The suite: {conformance['summary']['passed']}/{conformance['summary']['cases']} cases and "
            f"{conformance['summary']['checks_passed']}/{conformance['summary']['checks']} checks passed; a documented difference passes when "
            "each runtime matches its own documented behaviour (D-063, D-090). Disagreeing cases that are not documented differences: "
            f"{len(conformance['disagreeing'])}."
        ),
        "",
        "## The divergence log (`docs/conformance-divergences.md`)",
        "",
        "| Class | fixed | documented | total |",
        "|---|---:|---:|---:|",
    ]
    log = summary["divergence_log"]
    for name in CLASSES:
        counts = log["by_class"][name]
        lines.append(
            f"| {name} | {counts.get('fixed', 0)} | {counts.get('documented', 0)} | {sum(counts.values())} |"
        )
    lines += [
        f"| **all** | {log['by_resolution'].get('fixed', 0)} | {log['by_resolution'].get('documented', 0)} | {log['items']} |",
        "",
        "| Found by | fixed | documented | total |",
        "|---|---:|---:|---:|",
    ]
    for name in FOUND:
        counts = log["by_found"][name]
        lines.append(
            f"| {name} | {counts.get('fixed', 0)} | {counts.get('documented', 0)} | {sum(counts.values())} |"
        )
    lines += [
        "",
        "| Runtime that differed | fixed | documented | total |",
        "|---|---:|---:|---:|",
    ]
    for key, label in RUNTIMES:
        counts = log["by_runtime"][key]
        lines.append(
            f"| {label} | {counts.get('fixed', 0)} | {counts.get('documented', 0)} | {sum(counts.values())} |"
        )
    lines += [
        "",
        "| Task (first named) | fixed | documented | total |",
        "|---|---:|---:|---:|",
    ]
    for task, counts in log["by_task"].items():
        lines.append(
            f"| {task} | {counts.get('fixed', 0)} | {counts.get('documented', 0)} | {sum(counts.values())} |"
        )
    privileges = summary["privileges"]
    pack = summary["check_pack"]
    lines += [
        "",
        "## P-19's reviewable path",
        "",
        f"- `scripts/check_extension_privileges.py`: passed {privileges['passed']} (manifest sha256 `{privileges['manifest_sha256']}`); `privileges.json` here.",
        "- `npm run check-pack`: "
        + (
            "not run."
            if pack is None
            else f"passed {pack['passed']}; `check-pack.json` here."
        ),
        "",
        f"**Passed: {summary['passed']}.**"
        + ("" if summary["passed"] else " Problems: " + "; ".join(summary["problems"])),
        "",
    ]
    return "\n".join(lines)


def read_check_pack(path: Path) -> dict:
    """`npm run check-pack`'s JSON: the whole file when it is one document (the pretty-printed
    copy a results directory keeps), else its last line (the npm output piped through `tail`)."""
    text = path.read_text(encoding="utf-8").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(text.splitlines()[-1])


def _rel(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--conformance", type=Path, required=True, help="conformance/results/<UTC>"
    )
    parser.add_argument(
        "--privileges",
        type=Path,
        required=True,
        help="scripts/check_extension_privileges.py's JSON",
    )
    parser.add_argument(
        "--check-pack", type=Path, help="npm run check-pack's JSON line"
    )
    parser.add_argument("--divergences", type=Path, default=DIVERGENCES)
    parser.add_argument(
        "--out", type=Path, help="New directory (default results/<UTC>)"
    )
    args = parser.parse_args(argv)
    conformance = json.loads(
        (args.conformance / "report.json").read_text(encoding="utf-8")
    )
    privileges = json.loads(args.privileges.read_text(encoding="utf-8"))
    check_pack = read_check_pack(args.check_pack) if args.check_pack else None
    rows = divergence_rows(args.divergences)
    summary = summarize(
        conformance,
        privileges,
        check_pack,
        rows,
        check_log_tables(args.divergences, rows),
    )
    sources = {
        "Conformance run": _rel(args.conformance),
        "Divergence log": _rel(args.divergences),
    }
    summary["sources"] = {
        **sources,
        "divergence_log_sha256": hashlib.sha256(
            args.divergences.read_bytes()
        ).hexdigest(),
        "conformance_report_sha256": hashlib.sha256(
            (args.conformance / "report.json").read_bytes()
        ).hexdigest(),
    }
    out = args.out or HERE / "results" / datetime.now(UTC).strftime(
        "%Y-%m-%dT%H-%M-%SZ"
    )
    out.mkdir(parents=True, exist_ok=False)
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (out / "report.md").write_text(report(summary, sources))
    (out / "privileges.json").write_text(json.dumps(privileges, indent=2) + "\n")
    if check_pack is not None:
        # The packed zip by its repository path (the line carries the absolute one).
        if isinstance(check_pack.get("zip"), str):
            check_pack["zip"] = _rel(Path(check_pack["zip"]))
        (out / "check-pack.json").write_text(json.dumps(check_pack, indent=2) + "\n")
    print(
        json.dumps(
            {
                "report": _rel(out),
                "passed": summary["passed"],
                "problems": summary["problems"],
            }
        )
    )
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
