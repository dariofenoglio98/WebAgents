#!/usr/bin/env python3
"""Pool several contract-overhead result directories into one paper result.

    agentpkg/.venv/bin/python experiments/contract_overhead/aggregate.py \\
        --out experiments/contract_overhead/results/<UTC>_<label> \\
        [--reference OLD_RUN ...] RUN [RUN ...]

The paper reports, per package and operation, the median and 95th percentile of
the measured observations of several independent runs pooled together (each run
one process, README "Protocol"), and how far the run medians spread. This script
computes exactly that from each run's raw `samples.csv`, with the estimators of
`analyze.py`; nothing is typed in. Before pooling, it refuses runs that do not
share the commit, the benchmark and analysis scripts, the protocol, the fixtures
and the package artifacts, or that were measured with modified production code,
so one pooled number never mixes two implementations.

`--reference` names earlier runs (pooled the same way, checked the same way among
themselves) to compare with, package by package, for the packages both series
measured.

Writes into `--out`, which must not exist yet: `pooled_summary.csv`,
`pooled_summary.json`, `paper_table.tex` (the four paper groups and the total,
"median (p95)" per package), `paper_table_detailed.tex` (the seven operations),
`report.md` and `sources.json`. Input directories are only read.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import analyze  # noqa: E402

NS_PER_MS = analyze.NS_PER_MS
# The paper's wording for the four groups and the total (Table III).
PAPER_LABELS = {
    "verification": "Package verification",
    "authorization_and_binding": "Authorization / binding",
    "run_plan": "Run Plan preparation",
    "revalidation": "Pre-execution revalidation",
}
# Facts every pooled run must share. Paths into metadata.json.
MUST_MATCH = (
    ("software", "git_commit"),
    ("benchmark", "name"),
    ("benchmark", "version"),
    ("benchmark", "script_sha256"),
    ("benchmark", "analysis_script_sha256"),
    ("benchmark", "config"),
    ("benchmark", "stages"),
    ("benchmark", "groups"),
    ("fixtures",),
    ("machine", "cpu_model"),
    ("machine", "os_version"),
    ("machine", "python_version"),
    ("software", "agentpkg_version"),
    ("software", "dependencies"),
)


def _get(document: dict, path: tuple) -> object:
    for part in path:
        document = document[part]
    return document


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _rel(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return Path(path).name


def load_run(directory: Path) -> dict:
    directory = Path(directory)
    metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    return {
        "directory": directory,
        "metadata": metadata,
        "rows": analyze.load_samples(directory / "samples.csv"),
    }


def check_series(runs: list[dict], *, require_clean: bool) -> list[str]:
    """Reasons these runs may not be pooled; empty when they may."""
    problems = []
    first = runs[0]["metadata"]
    for run in runs[1:]:
        for path in MUST_MATCH:
            if _get(run["metadata"], path) != _get(first, path):
                problems.append(f"{run['directory'].name}: {'.'.join(path)} differs")
        identities = {
            key: (value["archive_sha256"], value["package_digest"])
            for key, value in run["metadata"]["packages"].items()
        }
        reference = {
            key: (value["archive_sha256"], value["package_digest"])
            for key, value in first["packages"].items()
        }
        if identities != reference:
            problems.append(f"{run['directory'].name}: package artifacts differ")
    for run in runs:
        software = run["metadata"]["software"]
        if software["git_production_paths_modified"]:
            problems.append(f"{run['directory'].name}: production paths modified")
        if require_clean and software["git_tracked_changes"]:
            problems.append(f"{run['directory'].name}: tracked changes in the working tree")
        if run["metadata"]["guards"]["offline_violations"]:
            problems.append(f"{run['directory'].name}: offline guard violations")
        if not run["metadata"].get("package_file_sha256_before_after_equal", False):
            problems.append(f"{run['directory'].name}: package files changed during the run")
    return problems


def pool(runs: list[dict]) -> list[dict]:
    """Per package x stage: pooled statistics plus per-run and per-batch medians."""
    metadata = runs[0]["metadata"]
    order = analyze.stage_order(metadata)
    packages = list(metadata["packages"])
    pooled: dict[tuple, list[int]] = {}
    per_run: dict[tuple, list[list[int]]] = {}
    per_batch: dict[tuple, list[float]] = {}
    for index, run in enumerate(runs):
        for (package_key, kind, stage), items in analyze.group_by(
            run["rows"], "package_key", "kind", "stage"
        ).items():
            values = [item["elapsed_ns"] for item in items]
            key = (package_key, kind, stage)
            pooled.setdefault(key, []).extend(values)
            per_run.setdefault(key, [[] for _ in runs])[index] = values
            for (batch,), group in sorted(analyze.group_by(items, "batch").items()):
                per_batch.setdefault(key, []).append(
                    analyze.percentile([g["elapsed_ns"] for g in group], 50) / NS_PER_MS
                )
    records = []
    for key, values in pooled.items():
        package_key, kind, stage = key
        stats = analyze.describe(values)
        medians = [analyze.percentile(v, 50) / NS_PER_MS for v in per_run[key]]
        p95s = [analyze.percentile(v, 95) / NS_PER_MS for v in per_run[key]]
        mean_of_medians = math.fsum(medians) / len(medians)
        sd = (
            math.sqrt(math.fsum((m - mean_of_medians) ** 2 for m in medians) / (len(medians) - 1))
            if len(medians) > 1
            else 0.0
        )
        batches = per_batch[key]
        records.append(
            {
                "package_key": package_key,
                "kind": kind,
                "stage": stage,
                "label": analyze.label_for(metadata, stage),
                "n": stats["n"],
                "n_per_run": [len(v) for v in per_run[key]],
                "ms": analyze.scaled(stats, NS_PER_MS),
                "run_medians_ms": medians,
                "run_p95s_ms": p95s,
                "run_median_sd_ms": sd,
                "run_median_cv_pct": sd / mean_of_medians * 100 if mean_of_medians else None,
                "run_median_range_ms": [min(medians), max(medians)],
                "batch_medians_ms": batches,
                "batch_median_spread_pct": (max(batches) - min(batches))
                / (stats["median"] / NS_PER_MS)
                * 100
                if stats["median"]
                else None,
            }
        )
    records.sort(
        key=lambda r: (packages.index(r["package_key"]), order.index((r["kind"], r["stage"])))
    )
    return records


def find(records, package_key, stage):
    return next(r for r in records if r["package_key"] == package_key and r["stage"] == stage)


def _cell(record) -> str:
    return f"{analyze.fmt(record['ms']['median'])} ({analyze.fmt(record['ms']['p95'])})"


def _column(label: str) -> str:
    words = label.split(" ", 1)
    return f"\\shortstack{{{words[0]}\\\\{words[1]}}}" if len(words) == 2 else label


def paper_table(records, metadata, *, detailed: bool, count: int) -> str:
    packages = list(metadata["packages"])
    bench = metadata["benchmark"]
    rows = (
        [(item["stage"], item["label"]) for item in bench["stages"]]
        if detailed
        else [
            (item["group"], PAPER_LABELS.get(item["group"], item["label"]))
            for item in bench["groups"]
        ]
    )
    total = bench["total"]["stage"]
    lines = [
        "% Generated by experiments/contract_overhead/aggregate.py from the pooled raw samples "
        "of the result directories listed in sources.json. Do not edit by hand.",
        "% Requires \\usepackage{booktabs}.",
        "\\begin{table}[t]",
        "\\caption{Pre-execution overhead: automated processing in milliseconds: pooled median "
        f"(95th percentile), {count:,} observations per package. Download, human decisions, "
        "inference, tools, HTTP hops, and process startup are excluded.}",
        "\\label{tab:overhead" + ("-detailed" if detailed else "") + "}",
        "\\centering",
        "\\small",
        "\\setlength{\\tabcolsep}{3pt}",
        "\\begin{tabular}{@{}l" + "r" * len(packages) + "@{}}",
        "\\toprule",
        "Operation & "
        + " & ".join(
            analyze.latex_escape(_column(metadata["packages"][k]["label"])) for k in packages
        )
        + " \\\\",
        "\\midrule",
    ]
    for stage, label in rows:
        lines.append(
            f"{analyze.latex_escape(label)} & "
            + " & ".join(_cell(find(records, k, stage)) for k in packages)
            + " \\\\"
        )
    lines += [
        "\\midrule",
        "\\textbf{Total} & "
        + " & ".join(f"\\textbf{{{_cell(find(records, k, total))}}}" for k in packages)
        + " \\\\",
        "\\bottomrule",
        "\\end{tabular}",
        "\\end{table}",
        "",
    ]
    return "\n".join(lines)


def compare(records, reference_records, metadata, reference_metadata) -> list[dict]:
    """New against reference, for the packages and groups both series measured."""
    bench = metadata["benchmark"]
    stages = [item["group"] for item in bench["groups"]] + [bench["total"]["stage"]]
    out = []
    for key in metadata["packages"]:
        if key not in reference_metadata["packages"]:
            continue
        for stage in stages:
            new, old = find(records, key, stage), find(reference_records, key, stage)
            difference = new["ms"]["median"] - old["ms"]["median"]
            spread = max(
                new["run_median_range_ms"][1] - new["run_median_range_ms"][0],
                old["run_median_range_ms"][1] - old["run_median_range_ms"][0],
            )
            out.append(
                {
                    "package_key": key,
                    "stage": stage,
                    "reference_version": reference_metadata["packages"][key]["package_version"],
                    "version": metadata["packages"][key]["package_version"],
                    "same_archive": reference_metadata["packages"][key]["archive_sha256"]
                    == metadata["packages"][key]["archive_sha256"],
                    "reference_median_ms": old["ms"]["median"],
                    "reference_p95_ms": old["ms"]["p95"],
                    "median_ms": new["ms"]["median"],
                    "p95_ms": new["ms"]["p95"],
                    "difference_ms": difference,
                    "difference_pct": difference / old["ms"]["median"] * 100,
                    "p95_difference_ms": new["ms"]["p95"] - old["ms"]["p95"],
                    "p95_difference_pct": (new["ms"]["p95"] - old["ms"]["p95"])
                    / old["ms"]["p95"]
                    * 100,
                    "reference_run_medians_ms": old["run_medians_ms"],
                    "run_medians_ms": new["run_medians_ms"],
                    "reference_run_median_sd_ms": old["run_median_sd_ms"],
                    "run_median_sd_ms": new["run_median_sd_ms"],
                    "run_median_ranges_overlap": not (
                        new["run_median_range_ms"][0] > old["run_median_range_ms"][1]
                        or old["run_median_range_ms"][0] > new["run_median_range_ms"][1]
                    ),
                    "difference_over_largest_run_median_range": abs(difference) / spread
                    if spread
                    else None,
                }
            )
    return out


def report(records, metadata, runs, comparison, reference_runs) -> str:
    packages = list(metadata["packages"])
    bench = metadata["benchmark"]
    total = bench["total"]["stage"]
    software = metadata["software"]
    labels = {k: metadata["packages"][k]["label"] for k in packages}
    lines = [
        "# Contract overhead: pooled result",
        "",
        f"{len(runs)} independent runs at commit `{(software['git_commit'] or '')[:12]}`, "
        f"benchmark {bench['name']} {bench['version']}, pooled per package and operation. "
        "Statistics are computed from the raw samples of every run; medians of different rows "
        "do not add up and are not meant to.",
        "",
        "## Runs",
        "",
        "| Run | Started (UTC) | Wall (s) | Tracked changes "
        "| Load avg at start | Load avg at end |",
        "|---|---|---:|---|---|---|",
    ]
    for run in runs:
        m = run["metadata"]
        load = m["machine"].get("load_average_1_5_15") or {}
        lines.append(
            f"| `{run['directory'].name}` | {m['benchmark']['started_at_utc']} | "
            f"{m['benchmark']['wall_seconds']:.1f} | "
            f"{len(m['software']['git_tracked_changes'])} | "
            f"{load.get('start')} | {load.get('end')} |"
        )
    lines += [
        "",
        "## Paper table (pooled median (p95), ms)",
        "",
        "| Operation | " + " | ".join(labels[k] for k in packages) + " |",
        "|---|" + "---:|" * len(packages),
    ]
    for item in bench["groups"]:
        lines.append(
            f"| {PAPER_LABELS.get(item['group'], item['label'])} | "
            + " | ".join(_cell(find(records, k, item["group"])) for k in packages)
            + " |"
        )
    lines.append(
        "| **Total** | "
        + " | ".join(f"**{_cell(find(records, k, total))}**" for k in packages)
        + " |"
    )
    lines += [
        "",
        "## All operations (pooled)",
        "",
        "| Package | Kind | Stage | n | median | p95 | mean | std "
        "| run medians | run SD | run CV % | batch spread % |",
        "|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|",
    ]
    for record in records:
        if record["kind"] == "secondary":
            continue
        ms = record["ms"]
        lines.append(
            f"| {labels[record['package_key']]} | {record['kind']} | `{record['stage']}` | "
            f"{record['n']:,} | {analyze.fmt(ms['median'], 3)} | {analyze.fmt(ms['p95'], 3)} | "
            f"{analyze.fmt(ms['mean'], 3)} | "
            f"{analyze.fmt(ms['std'], 3)} | "
            + ", ".join(analyze.fmt(m, 2) for m in record["run_medians_ms"])
            + f" | {analyze.fmt(record['run_median_sd_ms'], 3)} | "
            f"{analyze.fmt(record['run_median_cv_pct'], 2)} | "
            f"{analyze.fmt(record['batch_median_spread_pct'], 1)} |"
        )
    stage_records = [r for r in records if r["kind"] in {"stage", "group", "total"}]
    worst = max(stage_records, key=lambda r: r["run_median_cv_pct"] or 0)
    lines += [
        "",
        "## Run-to-run variability",
        "",
        "Coefficient of variation of the run medians (sample SD over mean): at most "
        f"{analyze.fmt(worst['run_median_cv_pct'], 2)}% over every stage, group and total "
        f"(`{worst['stage']}`, {labels[worst['package_key']]}). Totals: "
        + "; ".join(
            f"{labels[k]} {analyze.fmt(find(records, k, total)['run_median_cv_pct'], 2)}% "
            "(run medians "
            + ", ".join(analyze.fmt(m, 2) for m in find(records, k, total)["run_medians_ms"])
            + " ms)"
            for k in packages
        )
        + ".",
        "",
    ]
    if comparison:
        lines += [
            "## Comparison with the reference runs",
            "",
            "Reference: "
            + ", ".join(f"`{run['directory'].name}`" for run in reference_runs)
            + " (commit "
            + f"`{(reference_runs[0]['metadata']['software']['git_commit'] or '')[:12]}`).",
            "",
            "| Package | Stage | Reference median (p95) | New median (p95) | Difference | % "
            "| Reference run medians | New run medians | Ranges overlap |",
            "|---|---|---:|---:|---:|---:|---|---|---|",
        ]
        for item in comparison:
            lines.append(
                f"| {labels[item['package_key']]} | `{item['stage']}` | "
                f"{analyze.fmt(item['reference_median_ms'])} "
                f"({analyze.fmt(item['reference_p95_ms'])}) | "
                f"{analyze.fmt(item['median_ms'])} ({analyze.fmt(item['p95_ms'])}) | "
                f"{item['difference_ms']:+.2f} | {item['difference_pct']:+.1f} | "
                + ", ".join(analyze.fmt(m) for m in item["reference_run_medians_ms"])
                + " | "
                + ", ".join(analyze.fmt(m) for m in item["run_medians_ms"])
                + f" | {'yes' if item['run_median_ranges_overlap'] else 'no'} |"
            )
        lines.append("")
    lines += [
        "## Sources",
        "",
        "See `sources.json` for every input directory's commit, script hashes and the SHA-256 of "
        "the files read.",
        "",
    ]
    return "\n".join(lines)


SUMMARY_FIELDS = (
    "package_key",
    "package_version",
    "kind",
    "stage",
    "label",
    "n",
    "median_ms",
    "p95_ms",
    "mean_ms",
    "std_ms",
    "min_ms",
    "max_ms",
    "run_medians_ms",
    "run_median_sd_ms",
    "run_median_cv_pct",
    "batch_median_spread_pct",
)


def sources(runs) -> list[dict]:
    return [
        {
            "directory": _rel(run["directory"]),
            "git_commit": run["metadata"]["software"]["git_commit"],
            "git_tracked_changes": run["metadata"]["software"]["git_tracked_changes"],
            "git_untracked": run["metadata"]["software"]["git_untracked"],
            "script_sha256": run["metadata"]["benchmark"]["script_sha256"],
            "analysis_script_sha256": run["metadata"]["benchmark"]["analysis_script_sha256"],
            "started_at_utc": run["metadata"]["benchmark"]["started_at_utc"],
            "files_sha256": {
                name: _sha256(run["directory"] / name)
                for name in ("metadata.json", "samples.csv", "summary.csv", "paper_table.tex")
                if (run["directory"] / name).exists()
            },
        }
        for run in runs
    ]


def aggregate(directories, out: Path, *, references=(), require_clean: bool = True) -> dict:
    runs = [load_run(Path(d)) for d in directories]
    problems = check_series(runs, require_clean=require_clean)
    reference_runs = [load_run(Path(d)) for d in references]
    if reference_runs:
        problems += [f"reference {p}" for p in check_series(reference_runs, require_clean=False)]
    if problems:
        raise SystemExit("refusing to pool:\n  " + "\n  ".join(problems))
    metadata = runs[0]["metadata"]
    records = pool(runs)
    reference_records = pool(reference_runs) if reference_runs else []
    comparison = (
        compare(records, reference_records, metadata, reference_runs[0]["metadata"])
        if reference_runs
        else []
    )
    counts = {
        find(records, k, metadata["benchmark"]["total"]["stage"])["n"] for k in metadata["packages"]
    }
    if len(counts) != 1:
        raise SystemExit(f"unequal pooled observation counts per package: {sorted(counts)}")
    count = counts.pop()

    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)  # Never overwrite a prior result.
    with open(out / "pooled_summary.csv", "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(SUMMARY_FIELDS))
        writer.writeheader()
        for record in records:
            ms = record["ms"]
            writer.writerow(
                {
                    "package_key": record["package_key"],
                    "package_version": metadata["packages"][record["package_key"]][
                        "package_version"
                    ],
                    "kind": record["kind"],
                    "stage": record["stage"],
                    "label": record["label"],
                    "n": record["n"],
                    **{
                        f"{k}_ms": f"{ms[k]:.6f}"
                        for k in ("median", "p95", "mean", "std", "min", "max")
                    },
                    "run_medians_ms": ";".join(f"{m:.6f}" for m in record["run_medians_ms"]),
                    "run_median_sd_ms": f"{record['run_median_sd_ms']:.6f}",
                    "run_median_cv_pct": f"{record['run_median_cv_pct']:.4f}",
                    "batch_median_spread_pct": f"{record['batch_median_spread_pct']:.4f}",
                }
            )
    document = {
        "statistics": {
            "pooling": "all measured observations of every run concatenated per package x stage",
            "percentile_method": "linear interpolation (Hyndman-Fan type 7)",
            "std": "sample standard deviation (ddof = 1)",
            "run_median_cv": "sample SD (ddof = 1) of the run medians over their mean",
            "units": "milliseconds",
        },
        "observations_per_package": count,
        "runs": len(runs),
        "packages": metadata["packages"],
        "benchmark": {k: metadata["benchmark"][k] for k in ("name", "version", "config")},
        "machine": {k: v for k, v in metadata["machine"].items() if k != "load_average_1_5_15"},
        "software": {
            k: metadata["software"][k]
            for k in (
                "git_commit",
                "agentpkg_version",
                "dependencies",
                "agent_browser_plugin_version",
            )
        },
        "summary": records,
        "comparison_with_reference": comparison,
        "sources": sources(runs),
        "reference_sources": sources(reference_runs),
    }
    (out / "pooled_summary.json").write_text(
        json.dumps(document, indent=2) + "\n", encoding="utf-8"
    )
    (out / "sources.json").write_text(
        json.dumps(
            {"runs": document["sources"], "reference": document["reference_sources"]}, indent=2
        )
        + "\n",
        encoding="utf-8",
    )
    (out / "paper_table.tex").write_text(
        paper_table(records, metadata, detailed=False, count=count), encoding="utf-8"
    )
    (out / "paper_table_detailed.tex").write_text(
        paper_table(records, metadata, detailed=True, count=count), encoding="utf-8"
    )
    (out / "report.md").write_text(
        report(records, metadata, runs, comparison, reference_runs), encoding="utf-8"
    )
    return document


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("runs", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--reference", nargs="*", type=Path, default=[])
    parser.add_argument(
        "--allow-tracked-changes",
        action="store_true",
        help="pool runs measured with uncommitted tracked changes outside production paths",
    )
    args = parser.parse_args(argv)
    aggregate(
        args.runs,
        args.out,
        references=args.reference,
        require_clean=not args.allow_tracked_changes,
    )
    print(args.out / "report.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
