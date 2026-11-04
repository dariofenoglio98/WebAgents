#!/usr/bin/env python3
"""Summarize one benchmark v2 run, or pool several into the paper's directory (E7, Tab. 9).

    agentpkg/.venv/bin/python experiments/contract_overhead/aggregate_v2.py analyze RUN
    agentpkg/.venv/bin/python experiments/contract_overhead/aggregate_v2.py pool \\
        --out experiments/contract_overhead/results/<UTC>_v2-pooled RUN RUN RUN

Every number is computed here from the raw `samples.csv` and `micro_samples.csv`, with v1's
estimators (`analyze.percentile`, `analyze.describe`, imported and never edited); nothing is typed
in. Per runtime x package: each of the seven stages, the four paper groups and the total, each a
per-observation interval (a group is the sum of its contiguous stages of one observation); per
runtime x arm x cell: the per-operation costs. `analyze` writes `summary.json`, `summary.csv`,
`micro_summary.csv` and `report.md` into the run's directory (once, after the run); `pool`
refuses runs that do not share the commit, a clean tree, the benchmark, the protocol, the
fixtures, the configuration, the machine and the package artifacts (a pooled directory that mixes
commits is E7's defect), and writes a new directory. v1's series are cited beside, never pooled
(D-019).
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import analyze

NS_PER_MS = 1_000_000
GROUP_LABELS = {
    "verification": "Package verification",
    "authorization_and_binding": "Authorization / binding",
    "run_plan": "Run Plan preparation",
    "revalidation": "Pre-execution revalidation",
}
RUNTIME_LABELS = {"py": "Python reference", "ts": "Chrome core (Node)"}
# Facts every pooled run must share (paths into metadata.json).
MUST_MATCH = (
    ("software", "git_commit"),
    ("software", "chrome_core_version"),
    ("software", "agentpkg_version"),
    ("software", "dependencies"),
    ("benchmark", "name"),
    ("benchmark", "version"),
    ("benchmark", "script_sha256"),
    ("benchmark", "node_source_sha256"),
    ("benchmark", "config"),
    ("benchmark", "stages"),
    ("benchmark", "groups"),
    ("protocol", "sha256"),
    ("fixtures",),
    ("machine", "cpu_model"),
    ("machine", "os_version"),
    ("machine", "python_version"),
)


def _get(document: dict, path: tuple):
    for part in path:
        document = document[part]
    return document


def load_csv(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    with open(path, newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    for row in rows:
        for key in ("batch", "iteration", "position", "elapsed_ns"):
            if key in row:
                row[key] = int(row[key])
    return rows


def observations(rows: list[dict], metadata: dict) -> dict:
    """(runtime, package, quantity) -> per-observation values in ns: stages, groups, total."""
    groups = metadata["benchmark"]["groups"]
    per: dict[tuple, dict] = {}
    for row in rows:
        key = (
            row["runtime"],
            row["package_key"],
            row.get("run", ""),
            row["batch"],
            row["iteration"],
        )
        per.setdefault(key, {})[row["stage"]] = row["elapsed_ns"]
    out: dict[tuple, list[int]] = {}
    for (runtime, package, *_rest), stages in per.items():
        for name, value in stages.items():
            out.setdefault(
                (
                    runtime,
                    package,
                    "stage" if name != "total_pre_execution" else "total",
                    name,
                ),
                [],
            ).append(value)
        for group, members in groups.items():
            out.setdefault((runtime, package, "group", group), []).append(
                sum(stages[m] for m in members)
            )
        total = stages.get("total_pre_execution")
        if total is not None and total != sum(
            stages[s] for s in metadata["benchmark"]["stages"]
        ):
            raise ValueError(
                f"{runtime}/{package}: an observation's stages do not sum to its total"
            )
    return out


def summarize(rows: list[dict], micro: list[dict], metadata: dict) -> dict:
    records = []
    for (runtime, package, kind, name), values in sorted(
        observations(rows, metadata).items()
    ):
        stats = analyze.scaled(analyze.describe(values), NS_PER_MS)
        records.append(
            {
                "runtime": runtime,
                "package_key": package,
                "kind": kind,
                "quantity": name,
                **stats,
            }
        )
    micro_records = []
    grouped: dict[tuple, list[int]] = {}
    for row in micro:
        grouped.setdefault((row["runtime"], row["arm"], row["cell"]), []).append(
            row["elapsed_ns"]
        )
    for (runtime, arm, cell), values in sorted(grouped.items()):
        stats = analyze.scaled(analyze.describe(values), NS_PER_MS)
        micro_records.append({"runtime": runtime, "arm": arm, "cell": cell, **stats})
    return {"pre": records, "micro": micro_records}


FIELDS = ("n", "median", "p95", "mean", "std", "min", "max", "p5", "p25", "p75", "p99")


def _write(path: Path, rows: list[dict], head: tuple) -> None:
    with open(path, "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(
            stream, fieldnames=list(head + FIELDS), extrasaction="ignore"
        )
        writer.writeheader()
        writer.writerows(rows)


def fmt(value: float) -> str:
    if value >= 100:
        return f"{value:.0f}"
    if value >= 10:
        return f"{value:.1f}"
    if value >= 0.1:
        return f"{value:.2f}"
    return f"{value:.4f}"


def report(summary: dict, metadata: dict, title: str, sources: list[str]) -> str:
    packages = list(metadata["benchmark"]["config"]["packages"])
    runtimes = [
        r
        for r in ("py", "ts")
        if any(rec["runtime"] == r for rec in summary["pre"] + summary["micro"])
    ]
    lines = [
        f"# {title}",
        "",
        "Median (p95) in milliseconds; every number computed by `aggregate_v2.py` from the raw samples.",
        "",
    ]
    lines += [f"- Source: `{s}`" for s in sources] + [""]
    lines += [
        f"- Commit `{metadata['software']['git_commit']}`; benchmark {metadata['benchmark']['version']}; protocol sha256 `{metadata['protocol']['sha256'][:12]}…`.",
        "",
    ]
    index = {(r["runtime"], r["package_key"], r["quantity"]): r for r in summary["pre"]}
    if summary["pre"]:
        for detail, names in (
            ("Groups and total (Tab. 9)", list(GROUP_LABELS) + ["total_pre_execution"]),
            ("Stages", list(metadata["benchmark"]["stages"])),
        ):
            lines += [
                f"## {detail}",
                "",
                "| Runtime | Quantity | " + " | ".join(packages) + " |",
                "|---|---|" + "---|" * len(packages),
            ]
            for runtime in runtimes:
                for name in names:
                    cells = []
                    for package in packages:
                        record = index.get((runtime, package, name))
                        cells.append(
                            ""
                            if record is None
                            else f"{fmt(record['median'])} ({fmt(record['p95'])})"
                        )
                    lines.append(
                        f"| {RUNTIME_LABELS[runtime]} | {GROUP_LABELS.get(name, name)} | "
                        + " | ".join(cells)
                        + " |"
                    )
            lines.append("")
    if summary["micro"]:
        lines += [
            "## Per-operation costs",
            "",
            "| Arm | Cell | " + " | ".join(RUNTIME_LABELS[r] for r in runtimes) + " |",
            "|---|---|" + "---|" * len(runtimes),
        ]
        micro_index = {(r["runtime"], r["arm"], r["cell"]): r for r in summary["micro"]}
        seen = []
        for record in summary["micro"]:
            if (record["arm"], record["cell"]) not in seen:
                seen.append((record["arm"], record["cell"]))
        for arm, cell in seen:
            cells = []
            for runtime in runtimes:
                record = micro_index.get((runtime, arm, cell))
                cells.append(
                    ""
                    if record is None
                    else f"{fmt(record['median'])} ({fmt(record['p95'])})"
                )
            lines.append(f"| {arm} | {cell} | " + " | ".join(cells) + " |")
        lines.append("")
    facts = metadata.get("micro_facts") or {}
    if facts:
        lines += [
            "## Facts of the per-operation inputs",
            "",
            "```json",
            json.dumps(facts, indent=2, sort_keys=True),
            "```",
            "",
        ]
    lines += [
        "v1's RQ2 series (`results/2026-10-03T16-14-20Z_paper-webair-pooled`) is a different implementation, host and package set: cited beside, never pooled (D-019).",
        "",
    ]
    return "\n".join(lines)


def analyze_run(directory: Path) -> dict:
    directory = Path(directory)
    metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    summary = summarize(
        load_csv(directory / "samples.csv"),
        load_csv(directory / "micro_samples.csv"),
        metadata,
    )
    (directory / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    _write(
        directory / "summary.csv",
        summary["pre"],
        ("runtime", "package_key", "kind", "quantity"),
    )
    _write(
        directory / "micro_summary.csv", summary["micro"], ("runtime", "arm", "cell")
    )
    (directory / "report.md").write_text(
        report(
            summary,
            metadata,
            f"Contract overhead v2: {directory.name}",
            [_rel(directory)],
        )
    )
    return summary


def _rel(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def check_series(runs: list[tuple[Path, dict]], *, require_clean: bool) -> list[str]:
    problems = []
    first = runs[0][1]
    for directory, metadata in runs:
        for path in MUST_MATCH:
            if _get(metadata, path) != _get(first, path):
                problems.append(f"{directory.name}: {'.'.join(path)} differs")
        ids = {
            k: (v["archive_sha256"], v["package_digest"])
            for k, v in metadata["identity"].items()
        }
        if ids != {
            k: (v["archive_sha256"], v["package_digest"])
            for k, v in first["identity"].items()
        }:
            problems.append(f"{directory.name}: package artifacts differ")
        software = metadata["software"]
        if software["git_production_paths_modified"]:
            problems.append(f"{directory.name}: production paths modified")
        if require_clean and software["git_tracked_changes"]:
            problems.append(f"{directory.name}: tracked changes in the working tree")
        if (
            metadata["guards"]["offline_violations"]
            or metadata["guards"]["node_violations"]
        ):
            problems.append(f"{directory.name}: guard violations")
        if not metadata.get("package_file_sha256_before_after_equal", False):
            problems.append(f"{directory.name}: package files changed during the run")
    if len({d.name for d, _ in runs}) != len(runs):
        problems.append("a run is listed twice")
    return problems


def pool(directories: list[Path], out: Path, *, require_clean: bool = True) -> dict:
    runs = [
        (Path(d), json.loads((Path(d) / "metadata.json").read_text(encoding="utf-8")))
        for d in directories
    ]
    problems = check_series(runs, require_clean=require_clean)
    if problems:
        raise SystemExit("refusing to pool:\n  " + "\n  ".join(problems))
    rows, micro = [], []
    per_run_medians: dict[tuple, list[float]] = {}
    for directory, metadata in runs:
        run_rows = load_csv(directory / "samples.csv")
        run_micro = load_csv(directory / "micro_samples.csv")
        for row in run_rows:
            row["run"] = directory.name
        rows += run_rows
        micro += run_micro
        single = summarize(run_rows, run_micro, metadata)
        for record in single["pre"]:
            per_run_medians.setdefault(
                (record["runtime"], record["package_key"], record["quantity"]), []
            ).append(record["median"])
        for record in single["micro"]:
            per_run_medians.setdefault(
                (record["runtime"], record["arm"], record["cell"]), []
            ).append(record["median"])
    metadata = runs[0][1]
    summary = summarize(rows, micro, metadata)
    for record in summary["pre"]:
        medians = per_run_medians[
            (record["runtime"], record["package_key"], record["quantity"])
        ]
        record["run_medians"] = medians
        record["run_median_spread"] = max(medians) - min(medians)
    for record in summary["micro"]:
        medians = per_run_medians[(record["runtime"], record["arm"], record["cell"])]
        record["run_medians"] = medians
        record["run_median_spread"] = max(medians) - min(medians)
    out.mkdir(parents=True, exist_ok=False)
    sources = [
        {
            "directory": _rel(d),
            "commit": m["software"]["git_commit"],
            "started_at": m["started_at"],
            "observations": m["observations"],
        }
        for d, m in runs
    ]
    (out / "sources.json").write_text(json.dumps(sources, indent=2) + "\n")
    (out / "pooled_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    _write(
        out / "pooled_summary.csv",
        summary["pre"],
        ("runtime", "package_key", "kind", "quantity"),
    )
    _write(
        out / "pooled_micro_summary.csv", summary["micro"], ("runtime", "arm", "cell")
    )
    pooled_meta = {**metadata, "micro_facts": metadata.get("micro_facts")}
    (out / "report.md").write_text(
        report(
            summary,
            pooled_meta,
            f"Contract overhead v2, pooled: {out.name}",
            [s["directory"] for s in sources],
        )
    )
    return summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("analyze")
    one.add_argument("run", type=Path)
    many = commands.add_parser("pool")
    many.add_argument("--out", type=Path, required=True)
    many.add_argument(
        "--allow-dirty",
        action="store_true",
        help="Only for tests: pool runs made on a dirty tree",
    )
    many.add_argument("runs", type=Path, nargs="+")
    args = parser.parse_args(argv)
    if args.command == "analyze":
        analyze_run(args.run)
        print(json.dumps({"analyzed": _rel(args.run)}))
    else:
        pool(args.runs, args.out, require_clean=not args.allow_dirty)
        print(
            json.dumps(
                {"pooled": _rel(args.out), "runs": len(args.runs), "passed": True}
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
