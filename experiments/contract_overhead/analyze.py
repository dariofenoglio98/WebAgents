#!/usr/bin/env python3
"""Summarize one contract-overhead result directory.

Reads `samples.csv`, `metadata.json` and (if present) `audit_samples.csv`, and
writes `summary.csv`, `summary.json`, `batch_summary.csv`, `report.md`,
`paper_table.tex` and `paper_table_detailed.tex` next to them. Every number in
those files is computed here from the raw samples; nothing is typed in.

    agentpkg/.venv/bin/python experiments/contract_overhead/analyze.py <result-dir>
"""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

NS_PER_MS = 1_000_000
NS_PER_US = 1_000
PERCENTILES = (5, 10, 25, 75, 90, 95, 99)

# Recorded live runs of the *same* Meeting Agenda version the benchmark opens,
# kept in this repository. Read at analysis time, never typed in. Literature
# Review 0.2.5 has no recorded live run (README, "Recorded results").
CONTEXT_RUNS = (
    ("meeting-agenda", ROOT / "examples/meeting-agenda-022-qwen/run.json"),
    ("meeting-agenda", ROOT / "examples/meeting-agenda-022-luna/run.json"),
)


# -- statistics ----------------------------------------------------------------
def percentile(values, p: float) -> float:
    """Linear-interpolation percentile (Hyndman–Fan type 7, numpy's default)."""
    if not values:
        raise ValueError("percentile of an empty sample")
    if not 0 <= p <= 100:
        raise ValueError("p must be within [0, 100]")
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    h = (len(ordered) - 1) * (p / 100.0)
    lower = math.floor(h)
    upper = min(lower + 1, len(ordered) - 1)
    return float(ordered[lower] + (h - lower) * (ordered[upper] - ordered[lower]))


def describe(values) -> dict:
    """n, median, p95, mean, sample std (ddof=1), min, max, and a few more quantiles."""
    if not values:
        raise ValueError("describe of an empty sample")
    n = len(values)
    mean = math.fsum(values) / n
    variance = math.fsum((value - mean) ** 2 for value in values) / (n - 1) if n > 1 else 0.0
    record = {
        "n": n,
        "median": percentile(values, 50),
        "p95": percentile(values, 95),
        "mean": mean,
        "std": math.sqrt(variance),
        "min": float(min(values)),
        "max": float(max(values)),
    }
    for p in PERCENTILES:
        record[f"p{p}"] = percentile(values, p)
    return record


def scaled(stats: dict, divisor: float) -> dict:
    return {key: (value if key == "n" else value / divisor) for key, value in stats.items()}


# -- loading -------------------------------------------------------------------
def load_samples(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    for row in rows:
        row["batch"] = int(row["batch"])
        row["iteration"] = int(row["iteration"])
        row["position"] = int(row["position"])
        row["elapsed_ns"] = int(row["elapsed_ns"])
    return rows


def group_by(rows, *keys):
    groups: dict[tuple, list] = {}
    for row in rows:
        groups.setdefault(tuple(row[key] for key in keys), []).append(row)
    return groups


# -- analysis ------------------------------------------------------------------
def summarize(rows: list[dict], metadata: dict) -> list[dict]:
    """One record per package x stage (stages, groups, total, secondary)."""
    order = stage_order(metadata)
    records = []
    for (package_key, kind, stage), items in group_by(rows, "package_key", "kind", "stage").items():
        values = [item["elapsed_ns"] for item in items]
        stats = describe(values)
        records.append(
            {
                "package_key": package_key,
                "package_id": items[0]["package_id"],
                "package_version": items[0]["package_version"],
                "kind": kind,
                "stage": stage,
                "label": label_for(metadata, stage),
                "ns": stats,
                "ms": scaled(stats, NS_PER_MS),
                "negative": sum(1 for value in values if value < 0),
                "zero": sum(1 for value in values if value == 0),
            }
        )
    packages = list(metadata["packages"])
    records.sort(
        key=lambda r: (packages.index(r["package_key"]), order.index((r["kind"], r["stage"])))
    )
    return records


def stage_order(metadata: dict) -> list[tuple[str, str]]:
    bench = metadata["benchmark"]
    return (
        [("stage", item["stage"]) for item in bench["stages"]]
        + [("group", item["group"]) for item in bench["groups"]]
        + [("total", bench["total"]["stage"]), ("secondary", bench["secondary"]["stage"])]
    )


def label_for(metadata: dict, stage: str) -> str:
    bench = metadata["benchmark"]
    for item in bench["stages"]:
        if item["stage"] == stage:
            return item["label"]
    for item in bench["groups"]:
        if item["group"] == stage:
            return item["label"]
    if stage == bench["total"]["stage"]:
        return "Total pre-execution"
    if stage == bench["secondary"]["stage"]:
        return "Local file read (secondary, not in total)"
    return stage


def batch_summary(rows: list[dict]) -> list[dict]:
    """Per package x stage x batch medians, for drift and stability checks."""
    records = []
    for (package_key, kind, stage, batch), items in sorted(
        group_by(rows, "package_key", "kind", "stage", "batch").items()
    ):
        values = [item["elapsed_ns"] for item in items]
        records.append(
            {
                "package_key": package_key,
                "kind": kind,
                "stage": stage,
                "batch": batch,
                "n": len(values),
                "median_ms": percentile(values, 50) / NS_PER_MS,
                "p95_ms": percentile(values, 95) / NS_PER_MS,
                "mean_ms": math.fsum(values) / len(values) / NS_PER_MS,
            }
        )
    return records


def stability(rows: list[dict], batches: list[dict]) -> dict:
    """Simple, reported-not-acted-on diagnostics. No observation is ever dropped."""
    report: dict = {"batch_median_spread": [], "position_effect": [], "half_drift": [], "tail": []}
    by_stage = group_by(batches, "package_key", "kind", "stage")
    for (package_key, kind, stage), items in by_stage.items():
        if kind not in {"total", "stage", "group"}:
            continue
        medians = [item["median_ms"] for item in items]
        overall = (
            percentile(
                [
                    row["elapsed_ns"]
                    for row in rows
                    if row["package_key"] == package_key and row["stage"] == stage
                ],
                50,
            )
            / NS_PER_MS
        )
        report["batch_median_spread"].append(
            {
                "package_key": package_key,
                "kind": kind,
                "stage": stage,
                "batch_medians_ms": medians,
                "min_ms": min(medians),
                "max_ms": max(medians),
                "spread_pct_of_median": (max(medians) - min(medians)) / overall * 100
                if overall
                else None,
            }
        )
    for (package_key, stage), items in group_by(
        [row for row in rows if row["kind"] == "total"], "package_key", "stage"
    ).items():
        positions = group_by(items, "position")
        report["position_effect"].append(
            {
                "package_key": package_key,
                "stage": stage,
                "median_ms_by_position": {
                    str(position): percentile([r["elapsed_ns"] for r in group], 50) / NS_PER_MS
                    for (position,), group in sorted(positions.items())
                },
                "n_by_position": {
                    str(position): len(group) for (position,), group in sorted(positions.items())
                },
            }
        )
        drift = {}
        for (batch,), group in sorted(group_by(items, "batch").items()):
            ordered = sorted(group, key=lambda r: r["iteration"])
            half = len(ordered) // 2
            if half:
                first = percentile([r["elapsed_ns"] for r in ordered[:half]], 50) / NS_PER_MS
                second = percentile([r["elapsed_ns"] for r in ordered[half:]], 50) / NS_PER_MS
                drift[str(batch)] = {"first_half_median_ms": first, "second_half_median_ms": second}
        report["half_drift"].append({"package_key": package_key, "stage": stage, "by_batch": drift})
        values = sorted(r["elapsed_ns"] for r in items)
        median = percentile(values, 50)
        report["tail"].append(
            {
                "package_key": package_key,
                "stage": stage,
                "max_over_median": values[-1] / median if median else None,
                "p99_over_median": percentile(values, 99) / median if median else None,
                "above_2x_median": sum(1 for v in values if v > 2 * median),
                "above_5x_median": sum(1 for v in values if v > 5 * median),
                "n": len(values),
            }
        )
    return report


def audit_summary(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    records = []
    for (variant, stream_key), items in sorted(group_by(rows, "variant", "stream").items()):
        values = [int(item["elapsed_ns"]) for item in items]
        stats = describe(values)
        us = scaled(stats, NS_PER_US)
        records.append(
            {
                "variant": variant,
                "stream": stream_key,
                "ns": stats,
                "us": us,
                "events_per_second_at_median": 1e9 / stats["median"] if stats["median"] else None,
                "events_per_second_at_mean": 1e9 / stats["mean"] if stats["mean"] else None,
                "max_chain_length": max(int(item["chain_length"]) for item in items) + 1,
            }
        )
    return records


def component_summary(path: Path, metadata: dict) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    order = [item["component"] for item in metadata["benchmark"].get("components", [])]
    packages = list(metadata["packages"])
    records = []
    for (package_key, component), items in group_by(rows, "package_key", "component").items():
        stats = describe([int(item["elapsed_ns"]) for item in items])
        records.append(
            {
                "package_key": package_key,
                "component": component,
                "ns": stats,
                "ms": scaled(stats, NS_PER_MS),
            }
        )
    records.sort(
        key=lambda r: (
            packages.index(r["package_key"]),
            order.index(r["component"]) if r["component"] in order else len(order),
        )
    )
    return records


def context_runs() -> list[dict]:
    found = []
    for package_key, path in CONTEXT_RUNS:
        if not path.exists():
            continue
        record = json.loads(path.read_text(encoding="utf-8"))
        duration = record.get("durationMs")
        if not isinstance(duration, (int, float)) or record.get("status") != "completed":
            continue
        found.append(
            {
                "package_key": package_key,
                "source": str(path.relative_to(ROOT)),
                "run_id": record.get("runId"),
                "package_version": (record.get("package") or {}).get("version"),
                "model": (record.get("selectedModel") or {}).get("hostModelId"),
                "duration_ms": float(duration),
            }
        )
    return found


# -- rendering -------------------------------------------------------------------
def fmt(value: float, digits: int = 2) -> str:
    return f"{value:,.{digits}f}"


def find(summary, package_key, stage):
    return next(r for r in summary if r["package_key"] == package_key and r["stage"] == stage)


def latex_escape(text: str) -> str:
    return text.replace("&", r"\&").replace("%", r"\%").replace("_", r"\_")


def paper_table(summary, metadata, *, detailed: bool) -> str:
    packages = list(metadata["packages"])
    bench = metadata["benchmark"]
    rows = (
        [(item["stage"], item["label"]) for item in bench["stages"]]
        if detailed
        else [(item["group"], item["label"]) for item in bench["groups"]]
    )
    n = {key: find(summary, key, bench["total"]["stage"])["ns"]["n"] for key in packages}
    counts = sorted(set(n.values()))
    count = str(counts[0]) if len(counts) == 1 else "/".join(str(n[key]) for key in packages)
    names = [
        f"{metadata['packages'][key]['label']} {metadata['packages'][key]['package_version']}"
        for key in packages
    ]
    lines = [
        "% Generated by experiments/contract_overhead/analyze.py from "
        f"{metadata['benchmark']['started_at_utc']} samples. Do not edit by hand.",
        "% Requires \\usepackage{booktabs}.",
        "\\begin{table}[t]",
        "\\centering",
        "\\caption{Local latency of the package-to-execution contract, from in-memory package "
        "bytes to the first workflow-node dispatch, in milliseconds "
        f"(median and 95th percentile of {count} observations per package). Excludes package "
        "acquisition, human authorization time, model inference and external tool calls.}",
        "\\label{tab:contract-overhead" + ("-detailed" if detailed else "") + "}",
        "\\begin{tabular}{l" + "rr" * len(packages) + "}",
        "\\toprule",
        " & "
        + " & ".join(f"\\multicolumn{{2}}{{c}}{{{latex_escape(name)}}}" for name in names)
        + " \\\\",
        "".join(f"\\cmidrule(lr){{{2 + 2 * i}-{3 + 2 * i}}}" for i in range(len(packages))),
        "Operation & " + " & ".join("Median & p95" for _ in packages) + " \\\\",
        "\\midrule",
    ]
    for stage, label in rows:
        cells = []
        for key in packages:
            record = find(summary, key, stage)
            cells += [fmt(record["ms"]["median"]), fmt(record["ms"]["p95"])]
        lines.append(f"{latex_escape(label)} & " + " & ".join(cells) + " \\\\")
    lines.append("\\midrule")
    cells = []
    for key in packages:
        record = find(summary, key, bench["total"]["stage"])
        cells += [fmt(record["ms"]["median"]), fmt(record["ms"]["p95"])]
    lines.append("Total & " + " & ".join(cells) + " \\\\")
    lines += ["\\bottomrule", "\\end{tabular}", "\\end{table}", ""]
    return "\n".join(lines)


def markdown_table(summary, metadata, stages, *, extra=()) -> list[str]:
    packages = list(metadata["packages"])
    head = (
        "| Operation | "
        + " | ".join(f"{metadata['packages'][k]['label']} median | p95" for k in packages)
        + " |"
    )
    lines = [head, "|---|" + "---:|---:|" * len(packages)]
    for stage, label in list(stages) + list(extra):
        cells = []
        for key in packages:
            record = find(summary, key, stage)
            cells += [fmt(record["ms"]["median"]), fmt(record["ms"]["p95"])]
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    return lines


def full_table(summary, metadata) -> list[str]:
    lines = [
        "| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for record in summary:
        ms = record["ms"]
        lines.append(
            f"| {metadata['packages'][record['package_key']]['label']} | {record['kind']} | "
            f"`{record['stage']}` | {ms['n']} | {fmt(ms['median'], 3)} | {fmt(ms['p95'], 3)} | "
            f"{fmt(ms['mean'], 3)} | {fmt(ms['std'], 3)} | {fmt(ms['min'], 3)} | "
            f"{fmt(ms['max'], 3)} | {fmt(ms['p99'], 3)} |"
        )
    return lines


def interpretation(summary, metadata, audit) -> list[str]:
    """Statements that follow directly from the numbers above, and nothing more."""
    bench = metadata["benchmark"]
    total = bench["total"]["stage"]
    packages = list(metadata["packages"])
    out = []
    sentences = []
    for key in packages:
        identity = metadata["packages"][key]
        record = find(summary, key, total)
        sentences.append(
            f"For {identity['label']} {identity['package_version']}, the automated contract "
            f"processing from in-memory package bytes to the first workflow-node dispatch "
            f"required a median of {fmt(record['ms']['median'])} ms "
            f"(p95 {fmt(record['ms']['p95'])} ms; n = {record['ms']['n']})."
        )
    out.append(" ".join(sentences))
    out.append("")
    for key in packages:
        identity = metadata["packages"][key]
        total_median = find(summary, key, total)["ms"]["median"]
        stages = [find(summary, key, item["stage"]) for item in bench["stages"]]
        stages.sort(key=lambda r: r["ms"]["median"], reverse=True)
        top, second = stages[0], stages[1]
        groups = [find(summary, key, item["group"]) for item in bench["groups"]]
        groups.sort(key=lambda r: r["ms"]["median"], reverse=True)
        out.append(
            f"- {identity['label']}: the largest single operation by median was "
            f"*{top['label']}* ({fmt(top['ms']['median'])} ms, "
            f"{fmt(top['ms']['median'] / total_median * 100, 0)}% of the median total), followed "
            f"by *{second['label']}* ({fmt(second['ms']['median'])} ms). Of the four paper "
            f"groups, *{groups[0]['label']}* had the largest median ({fmt(groups[0]['ms']['median'])} ms)."
        )
    if len(packages) == 2:
        a, b = packages
        ra, rb = find(summary, a, total)["ms"]["median"], find(summary, b, total)["ms"]["median"]
        ia, ib = metadata["packages"][a], metadata["packages"][b]
        out.append(
            f"- The median total for {ib['label']} was {fmt(rb / ra, 1)}x that of {ia['label']}. "
            f"The two artifacts differ in several respects at once ({ia['archive_bytes']:,} vs "
            f"{ib['archive_bytes']:,} archive bytes, {ia['payload_files']} vs {ib['payload_files']} "
            f"payload files, {ia['graph_nodes']} vs {ib['graph_nodes']} graph nodes, "
            f"{len(ia['declared_tools'])} vs {len(ib['declared_tools'])} declared tools), so two "
            "packages do not identify which property drives the difference and do not establish "
            "a scaling relation."
        )
    out.append(
        "- Each measured observation re-verifies the package three times, as production does: "
        "when the control plane opens the snapshot, when the runner verifies the leased "
        "artifact, and when the interpreter re-checks integrity and re-validates the payload. "
        "No verification result is cached between them."
    )
    if audit:
        primary = [r for r in audit if r["variant"] == "no_observer"]
        parts = [
            f"{metadata['packages'][r['stream']]['label']} stream: median "
            f"{fmt(r['us']['median'], 1)} us (p95 {fmt(r['us']['p95'], 1)} us, "
            f"about {fmt(r['events_per_second_at_median'], 0)} events/s at the median)"
            for r in primary
        ]
        out.append(
            "- Audit bookkeeping (reported separately, not part of the totals above): appending "
            "and hash-linking one recorded audit event through `Runtime.record`, without an "
            "observer, took " + "; ".join(parts) + "."
        )
    out.append("")
    out.append(
        "Scope sentence: these figures measure only local automated contract processing in one "
        "Python process, and exclude package acquisition, human authorization time, model "
        "inference, external tool latency, loopback HTTP transport between plugin and control "
        "plane, and runner process start-up."
    )
    return out


def context_section(summary, metadata) -> list[str]:
    runs = context_runs()
    total = metadata["benchmark"]["total"]["stage"]
    lines = [
        "## Optional context (not a paper claim)",
        "",
        "Recorded live runs of the same Meeting Agenda version, read from run records in this "
        "repository at analysis time. They were recorded on a host session, not in this "
        "benchmark, and are shown only to place the measured magnitude next to a workflow "
        "duration. Literature Review 0.2.5 has no recorded live run in the repository, so no "
        "ratio is computed for it.",
        "",
    ]
    rows = []
    for run in runs:
        if run["package_key"] not in metadata["packages"]:
            continue
        identity = metadata["packages"][run["package_key"]]
        if run["package_version"] != identity["package_version"]:
            continue
        record = find(summary, run["package_key"], total)
        rows.append(
            f"| `{run['source']}` | `{run['run_id']}` | {run['model']} | "
            f"{fmt(run['duration_ms'] / 1000, 1)} s | {fmt(record['ms']['median'])} ms | "
            f"{record['ms']['median'] / run['duration_ms'] * 100:.3f}% |"
        )
    if not rows:
        return lines + ["No matching recorded run was found.", ""]
    return lines + [
        "| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |",
        "|---|---|---|---:|---:|---:|",
        *rows,
        "",
    ]


def report(summary, batches, diagnostics, audit, metadata, components=()) -> str:
    bench = metadata["benchmark"]
    config = bench["config"]
    machine = metadata["machine"]
    software = metadata["software"]
    packages = list(metadata["packages"])
    lines = [
        "# Contract overhead: results",
        "",
        f"Run started {bench['started_at_utc']} (UTC), benchmark {bench['name']} "
        f"{bench['version']}, git `{(software['git_commit'] or '')[:12]}`"
        f"{' (working tree has changes, none in production paths)' if software['git_dirty'] and not software['git_production_paths_modified'] else ''}"
        f"{' (PRODUCTION PATHS MODIFIED)' if software['git_production_paths_modified'] else ''}.",
        "",
        "## Question and metric",
        "",
        "What local latency does the package-to-execution contract add before workflow "
        "execution? The metric is the wall-clock time (`time.perf_counter_ns`) from the moment "
        "the signed package bytes are in memory to the moment the workflow interpreter hands "
        "its first ready wave of nodes to its scheduler, through the production operations "
        "below, in one Python process. No node runs; no model, tool or network is reached.",
        "",
        "## Packages",
        "",
        "| | " + " | ".join(metadata["packages"][k]["label"] for k in packages) + " |",
        "|---|" + "---|" * len(packages),
    ]
    facts = [
        ("Package id", "package_id"),
        ("Version", "package_version"),
        ("Archive", "archive"),
        ("Archive SHA-256", "archive_sha256"),
        ("Package digest", "package_digest"),
        ("Signer fingerprint", "signer_fingerprint"),
        ("Archive bytes", "archive_bytes"),
        ("Archive entries", "archive_entries"),
        ("Payload files", "payload_files"),
        ("Graph nodes", "graph_nodes"),
        ("Node types", "graph_node_types"),
        ("Worker roles", "worker_roles"),
        ("First-wave (root) nodes", "root_nodes"),
        ("Declared tools", "declared_tools"),
        ("Model tasks", "model_tasks"),
        ("Required model capabilities", "model_capabilities_required"),
        ("Required context window", "model_context_window_required"),
    ]
    for title, key in facts:
        cells = []
        for package_key in packages:
            value = metadata["packages"][package_key][key]
            if isinstance(value, list):
                value = ", ".join(value) if value else "none"
            elif isinstance(value, int):
                value = f"{value:,}"
            cells.append(
                f"`{value}`"
                if key
                in {
                    "archive_sha256",
                    "package_digest",
                    "signer_fingerprint",
                    "package_id",
                    "archive",
                }
                else str(value)
            )
        lines.append(f"| {title} | " + " | ".join(cells) + " |")
    lines.append(
        "| Declared permissions | "
        + " | ".join(
            ", ".join(
                f"{p['id']} ({p['kind']}{', required' if p['required'] else ''})"
                for p in metadata["packages"][k]["declared_permissions"]
            )
            for k in packages
        )
        + " |"
    )
    lines += [
        "",
        "## Stages (production operations)",
        "",
        "| Stage | Production operation | Interval |",
        "|---|---|---|",
    ]
    for item in bench["stages"]:
        lines.append(
            f"| {item['label']} (`{item['stage']}`) | `{item['production_operation']}` | {'–'.join(item['interval'])} |"
        )
    lines += [
        f"| Total (`{bench['total']['stage']}`) | the whole sequence, one direct interval | t0–t7 |",
        f"| Secondary (`{bench['secondary']['stage']}`) | `{bench['secondary']['operation']}`, not in the total | before t0 |",
        "",
        "## Protocol",
        "",
        f"- Warmup: {config['warmup_iterations_per_package']} iterations per package, discarded (kept in `warmup_samples.csv`).",
        f"- Measured: {config['batches']} batches x {config['iterations_per_batch']} iterations = "
        f"{config['measured_observations_per_package']} observations per package.",
        f"- Order: {config['order']}; seed {config['seed']}.",
        f"- Garbage collector: {config['gc']}. No observation was removed.",
        f"- Wall time of the measurement: {bench['wall_seconds']:.1f} s.",
        "",
        "## Main result (paper groups)",
        "",
        "All values in milliseconds.",
        "",
        *markdown_table(
            summary,
            metadata,
            [(item["group"], item["label"]) for item in bench["groups"]],
            extra=[(bench["total"]["stage"], "**Total**")],
        ),
        "",
        "## Per-operation breakdown",
        "",
        *markdown_table(
            summary,
            metadata,
            [(item["stage"], item["label"]) for item in bench["stages"]],
            extra=[
                (bench["total"]["stage"], "**Total**"),
                (bench["secondary"]["stage"], "Local file read (secondary, not in total)"),
            ],
        ),
        "",
        "Medians of the stages do not add up to the median total; each row is summarized on its own.",
        "",
        "## Paper-ready interpretation",
        "",
        *interpretation(summary, metadata, audit),
        "",
        "## Full statistics",
        "",
        "Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear "
        "interpolation (Hyndman–Fan type 7).",
        "",
        *full_table(summary, metadata),
        "",
        "## Stability",
        "",
        "Batch medians of the total, per package (ms):",
        "",
        "| Package | "
        + " | ".join(f"batch {i}" for i in range(config["batches"]))
        + " | spread (% of median) |",
        "|---|" + "---:|" * (config["batches"] + 1),
    ]
    for item in diagnostics["batch_median_spread"]:
        if item["kind"] != "total":
            continue
        lines.append(
            f"| {metadata['packages'][item['package_key']]['label']} | "
            + " | ".join(fmt(value, 3) for value in item["batch_medians_ms"])
            + f" | {fmt(item['spread_pct_of_median'], 1)} |"
        )
    worst = max(
        (item for item in diagnostics["batch_median_spread"] if item["kind"] == "stage"),
        key=lambda item: item["spread_pct_of_median"] or 0,
    )
    lines += [
        "",
        f"Largest batch-median spread among single operations: `{worst['stage']}` for "
        f"{metadata['packages'][worst['package_key']]['label']}, "
        f"{fmt(worst['spread_pct_of_median'], 1)}% of its median.",
        "",
        "Order position (0 = ran first within its iteration) and tail of the total:",
        "",
        "| Package | median at position 0 | median at position 1 | p99 / median | max / median | > 2x median | > 5x median |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for effect, tail in zip(diagnostics["position_effect"], diagnostics["tail"], strict=True):
        by = effect["median_ms_by_position"]
        lines.append(
            f"| {metadata['packages'][effect['package_key']]['label']} | {fmt(by.get('0', float('nan')), 3)} | "
            f"{fmt(by.get('1', float('nan')), 3)} | {fmt(tail['p99_over_median'], 2)} | "
            f"{fmt(tail['max_over_median'], 2)} | {tail['above_2x_median']} | {tail['above_5x_median']} |"
        )
    negatives = sum(record["negative"] for record in summary)
    zeros = sum(record["zero"] for record in summary)
    lines += [
        "",
        f"Negative values: {negatives}. Exact zeros: {zeros}.",
        "",
    ]
    if components:
        functions = {
            item["component"]: item["production_function"]
            for item in metadata["benchmark"].get("components", [])
        }
        lines += [
            "## Component decomposition (diagnostic, separate from the totals)",
            "",
            "The production functions inside package open, each called on its own with its own "
            "timer on the same in-memory bytes (milliseconds). The open stage runs all five once; "
            "the runner re-runs the first three; the interpreter re-runs the first two "
            "(integrity statement and payload validation). These calls are not part of the "
            "pipeline observations above and do not add up to them exactly.",
            "",
            "| Package | Component | Production function | n | median | p95 | mean | std |",
            "|---|---|---|---:|---:|---:|---:|---:|",
        ]
        for record in components:
            ms = record["ms"]
            lines.append(
                f"| {metadata['packages'][record['package_key']]['label']} | {record['component']} | "
                f"`{functions.get(record['component'], '')}` | {ms['n']} | {fmt(ms['median'], 3)} | "
                f"{fmt(ms['p95'], 3)} | {fmt(ms['mean'], 3)} | {fmt(ms['std'], 3)} |"
            )
        lines.append("")
    if audit:
        lines += [
            "## Audit-event microbenchmark (separate from the totals)",
            "",
            "`Runtime.record` replaying each recorded run's audit stream event by event into a "
            "fresh production `Runtime` per batch (microseconds per event). `no_observer` is the "
            "bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to "
            "the previous hash, append. `progress_observer` adds the runner's live-progress "
            "observer.",
            "",
            "| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for record in audit:
            us = record["us"]
            lines.append(
                f"| {record['variant']} | {record['stream']} | {us['n']} | {fmt(us['median'], 2)} | "
                f"{fmt(us['p95'], 2)} | {fmt(us['mean'], 2)} | {fmt(us['std'], 2)} | "
                f"{fmt(us['min'], 2)} | {fmt(us['max'], 2)} | {fmt(record['events_per_second_at_median'], 0)} |"
            )
        streams = (metadata.get("audit") or {}).get("streams") or {}
        lines += [
            "",
            "Streams: "
            + "; ".join(f"{k}: `{v['path']}` ({v['events']} events)" for k, v in streams.items())
            + "",
            "",
        ]
    lines += context_section(summary, metadata)
    lines += [
        "## Environment",
        "",
        f"- {machine['os']} {machine['os_version']} ({machine['architecture']}), CPU "
        f"{machine['cpu_model']}, {machine['logical_cpus']} logical CPUs"
        + (
            f" ({machine['performance_logical_cpus']} performance + {machine['efficiency_logical_cpus']} efficiency)"
            if machine.get("performance_logical_cpus")
            else ""
        )
        + (
            f", {machine['memory_bytes'] / 2**30:.0f} GiB memory"
            if machine.get("memory_bytes")
            else ""
        )
        + ".",
        f"- Python {machine['python_version']} ({machine['python_implementation']}); timer "
        f"`{machine['timer']['implementation']}`, resolution {machine['timer']['resolution_s']} s.",
        f"- agentpkg {software['agentpkg_version']} (source in repository: "
        f"{software['agentpkg_source_in_repository']}); dependencies "
        + ", ".join(f"{k} {v}" for k, v in software["dependencies"].items())
        + ".",
        f"- Agent Browser plugin {software['agent_browser_plugin_version']}; OpenClaw "
        f"{software['openclaw_version_pinned_by_plugin']} named by the fixtures; Node "
        f"{software['node_version']} (fixture generation only). Neither Node nor OpenClaw runs in "
        "the measured process.",
        f"- System load average (1/5/15 min) at start {machine.get('load_average_1_5_15', {}).get('start')}, "
        f"at end {machine.get('load_average_1_5_15', {}).get('end')}.",
        f"- Offline guard violations: {len(metadata['guards']['offline_violations'])}.",
        "",
        "## Exclusions and limitations",
        "",
        "- Excluded by construction: package download, human decision time, model inference, "
        "tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the "
        "control plane (JSON serialization, `node:http`), the plugin-side field comparisons in "
        "`preflight.ts`, spawning the runner process, and the bridge framing of the inbound "
        "`execution.begin` request.",
        "- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it "
        "equals the real TypeScript output.",
        "- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; "
        "everything before it is unmodified production code.",
        "- One machine, one Python process, two packages. Absolute values depend on the machine "
        "and on the trust store contents (two pinned keys here); they are not a scaling law.",
        "",
        "## Files",
        "",
        "`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` "
        "(t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, "
        "`batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, "
        "`paper_table.tex`, "
        "`paper_table_detailed.tex`, `command.txt`.",
        "",
    ]
    return "\n".join(lines)


SUMMARY_FIELDS = (
    "package_key",
    "package_id",
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
    "p5_ms",
    "p25_ms",
    "p75_ms",
    "p99_ms",
    "median_ns",
    "p95_ns",
)


def analyze(directory) -> dict:
    out = Path(directory)
    metadata = json.loads((out / "metadata.json").read_text(encoding="utf-8"))
    rows = load_samples(out / "samples.csv")
    summary = summarize(rows, metadata)
    batches = batch_summary(rows)
    diagnostics = stability(rows, batches)
    audit = audit_summary(out / "audit_samples.csv") if (out / "audit_samples.csv").exists() else []
    components = (
        component_summary(out / "component_samples.csv", metadata)
        if (out / "component_samples.csv").exists()
        else []
    )

    with open(out / "summary.csv", "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(SUMMARY_FIELDS))
        writer.writeheader()
        for record in summary:
            ms, ns = record["ms"], record["ns"]
            writer.writerow(
                {
                    "package_key": record["package_key"],
                    "package_id": record["package_id"],
                    "package_version": record["package_version"],
                    "kind": record["kind"],
                    "stage": record["stage"],
                    "label": record["label"],
                    "n": ms["n"],
                    **{
                        f"{key}_ms": f"{ms[key]:.6f}"
                        for key in (
                            "median",
                            "p95",
                            "mean",
                            "std",
                            "min",
                            "max",
                            "p5",
                            "p25",
                            "p75",
                            "p99",
                        )
                    },
                    "median_ns": f"{ns['median']:.1f}",
                    "p95_ns": f"{ns['p95']:.1f}",
                }
            )
    with open(out / "batch_summary.csv", "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(
            stream,
            fieldnames=[
                "package_key",
                "kind",
                "stage",
                "batch",
                "n",
                "median_ms",
                "p95_ms",
                "mean_ms",
            ],
        )
        writer.writeheader()
        for record in batches:
            writer.writerow(
                {**record, **{k: f"{record[k]:.6f}" for k in ("median_ms", "p95_ms", "mean_ms")}}
            )
    document = {
        "benchmark": {
            k: metadata["benchmark"][k] for k in ("name", "version", "started_at_utc", "config")
        },
        "statistics": {
            "percentile_method": "linear interpolation (Hyndman-Fan type 7)",
            "std": "sample standard deviation (ddof = 1)",
            "units": "milliseconds in `ms`, nanoseconds in `ns`; audit in microseconds",
        },
        "packages": metadata["packages"],
        "summary": summary,
        "stability": diagnostics,
        "audit": audit,
        "components": components,
        "context_runs": context_runs(),
    }
    (out / "summary.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    (out / "paper_table.tex").write_text(
        paper_table(summary, metadata, detailed=False), encoding="utf-8"
    )
    (out / "paper_table_detailed.tex").write_text(
        paper_table(summary, metadata, detailed=True), encoding="utf-8"
    )
    (out / "report.md").write_text(
        report(summary, batches, diagnostics, audit, metadata, components), encoding="utf-8"
    )
    return document


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    analyze(Path(sys.argv[1]))
    print(Path(sys.argv[1]) / "report.md")
