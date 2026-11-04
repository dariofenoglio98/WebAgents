#!/usr/bin/env python3
"""The conformance report and the divergence log in figures (E8, `experiments/PROTOCOL.md` §3 E8; T38, D-306).

    agentpkg/.venv/bin/python experiments/conformance_report/report.py \\
        --conformance conformance/results/<UTC> --privileges PRIVILEGES.json \\
        [--check-pack CHECK_PACK.json] [--out experiments/conformance_report/results/<UTC>]

Reads, never edits: the conformance suite's `report.json` (`node conformance/run.mjs` at the
final commit), the JSON of `scripts/check_extension_privileges.py` and of `npm run check-pack`
at the same commit, and the table of `docs/conformance-divergences.md`. Writes one new directory
(it must not exist) with `summary.json` and `report.md` (Tab. 10's rows: cases per family, agreed,
documented differences; the divergence log counted by class, resolution and how it was found;
P-19's two checks) and copies of the two JSON inputs. Every number is computed here; nothing is
typed in. Prints one JSON line with `"passed"`: the suite passed at a clean commit, every case
that is not a documented difference agreed, the privileges check passed, and every input names
the same commit.
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

# A case's family, from its id's first segment (conformance/README.md's sections).
FAMILIES = (
    ("Agent Memory", ("memory", "memory-probe")),
    ("Agent Compute", ("compute", "compute-test")),
    ("Agent Conversations", ("conversation", "conversation-test")),
    ("Agent Delegation", ("network", "network-test", "travel-network")),
    ("Control plane", ("control-plane",)),
)
PACKAGE_PREFIXES = ("webair-", "literature-review-", "meeting-agenda-")
CLASSES = ("behaviour", "wording", "timing", "platform")
RESOLUTIONS = ("fixed", "documented")
FOUND = ("suite", "test", "review", "live")


def family_of(case_id: str) -> str:
    head = case_id.split("/")[0]
    for name, prefixes in FAMILIES:
        if head in prefixes:
            return name
    if head.startswith(PACKAGE_PREFIXES):
        return "Shipped packages (fixture parity)"
    return "Package-format refusals"


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
                "class": cells[6],
                "resolution": cells[7],
                "commits": re.findall(r"`([0-9a-f]{7,40})`", cells[8]),
            }
        )
    return rows


def summarize(
    conformance: dict,
    privileges: dict,
    check_pack: dict | None,
    divergences: list[dict],
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
        "unclassified": [
            r["id"]
            for r in divergences
            if r["class"] not in CLASSES
            or r["resolution"] not in RESOLUTIONS
            or r["found_by"] not in FOUND
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
    if len(set(commits.values())) != 1:
        problems.append(f"the inputs name different commits: {commits}")
    if log["unclassified"] or log["without_commit"]:
        problems.append("a divergence row is unclassified or names no commit")
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
    check_pack = (
        json.loads(args.check_pack.read_text(encoding="utf-8").strip().splitlines()[-1])
        if args.check_pack
        else None
    )
    summary = summarize(
        conformance, privileges, check_pack, divergence_rows(args.divergences)
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
