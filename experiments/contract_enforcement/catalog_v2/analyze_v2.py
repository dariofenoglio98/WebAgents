"""Analyse a catalog v2 results directory (E1, T30, D-303).

    agentpkg/.venv/bin/python \\
        experiments/contract_enforcement/catalog_v2/analyze_v2.py <results-dir>

Reads `catalog.json`, `manifest.json` and `raw/*.jsonl` (each line: one execution with its oracle
verdict) and writes, beside them: `summary.json` (every rate with its 95 % Wilson interval),
`table.md` and `table.csv` (family × profile × runtime: VDR, SVR, IFR, BAR; the effect-only VDR
and SVR; paired contract correctness), and `unexpected.json` (every full-profile silent violation,
false reject, incidental failure and harness error anywhere, and per ablated profile the cases it
targets that a backstop still blocked, with the code that blocked them). It prints the table. It
never rewrites the manifest or the raw records. The paper reads these files by path; no number is
copied by hand.

VDR = explicit blocks / violations; SVR = silent violations / violations; IFR = incidental
failures / violations; BAR = accepted controls / controls. Denominators include harness errors,
so a harness error can only lower a rate.
"""

from __future__ import annotations

import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

FAMILY_ORDER = ("M", "C", "V", "N")
RUNTIME_ORDER = ("py", "ts")


def wilson(successes: int, total: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if total == 0:
        return (math.nan, math.nan)
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return (max(0.0, centre - half), min(1.0, centre + half))


def rate(successes: int, total: int) -> dict:
    low, high = wilson(successes, total)
    return {
        "k": successes,
        "n": total,
        "rate": None if total == 0 else successes / total,
        "ci95": None if total == 0 else [low, high],
    }


def load(results: Path):
    catalog = json.loads((results / "catalog.json").read_text())
    manifest = json.loads((results / "manifest.json").read_text())
    rows = []
    for path in sorted((results / "raw").glob("*.jsonl")):
        with open(path, encoding="utf-8") as stream:
            for line in stream:
                entry = json.loads(line)
                record = entry.pop("record", {}) or {}
                entry["elapsed_ms"] = record.get("elapsed_ms")
                rows.append(entry)
    return catalog, manifest, rows


def _cell(rows: list[dict], cases: dict) -> dict:
    violations = [r for r in rows if r["kind"] == "violation"]
    controls = [r for r in rows if r["kind"] == "control"]
    effect = [r for r in violations if cases[r["case"]]["boundary"].get("class") == "effect"]
    count = lambda items, outcome: sum(1 for r in items if r["outcome"] == outcome)  # noqa: E731
    return {
        "violations": len(violations),
        "controls": len(controls),
        "VDR": rate(count(violations, "EXPLICIT_BLOCK"), len(violations)),
        "SVR": rate(count(violations, "SILENT_VIOLATION"), len(violations)),
        "IFR": rate(count(violations, "INCIDENTAL_FAILURE"), len(violations)),
        "HER": rate(
            count(violations, "HARNESS_ERROR") + count(controls, "HARNESS_ERROR"), len(rows)
        ),
        "BAR": rate(count(controls, "BENIGN_ACCEPT"), len(controls)),
        "VDR_effect": rate(count(effect, "EXPLICIT_BLOCK"), len(effect)),
        "SVR_effect": rate(count(effect, "SILENT_VIOLATION"), len(effect)),
    }


def _paired(rows: list[dict], all_rows_by_key: dict, cases: dict) -> dict:
    """(explicitly blocked violations + accepted matched controls) / (violations + matched
    controls), each matched control counted once (v1's paired contract correctness)."""
    violations = [r for r in rows if r["kind"] == "violation"]
    blocked = sum(1 for r in violations if r["outcome"] == "EXPLICIT_BLOCK")
    matched = sorted({cases[r["case"]]["matched_control"] for r in violations} - {None})
    accepted = 0
    for control in matched:
        hits = [all_rows_by_key.get((control, r["runtime"], r["profile"])) for r in violations[:1]]
        hit = hits[0] if hits else None
        if hit is not None and hit["outcome"] == "BENIGN_ACCEPT":
            accepted += 1
    return rate(blocked + accepted, len(violations) + len(matched))


def analyze(results: Path) -> dict:
    results = Path(results)
    catalog, manifest, rows = load(results)
    cases = {case["id"]: case for case in catalog["cases"]}
    profiles = [p["name"] for p in manifest["profiles"]]
    by_key = {(r["case"], r["runtime"], r["profile"]): r for r in rows}
    groups = defaultdict(list)
    for r in rows:
        groups[(r["family"], r["profile"], r["runtime"])].append(r)
        groups[("all", r["profile"], r["runtime"])].append(r)
    table = []
    for family in (*FAMILY_ORDER, "all"):
        for profile in profiles:
            for runtime in RUNTIME_ORDER:
                cell_rows = groups.get((family, profile, runtime), [])
                if not cell_rows:
                    continue
                cell = _cell(cell_rows, cases)
                if family == "all":
                    cell["paired"] = rate(0, 0)
                else:
                    cell["paired"] = _paired(cell_rows, by_key, cases)
                table.append({"family": family, "profile": profile, "runtime": runtime, **cell})

    full = [r for r in rows if r["profile"] == "full"]
    explicit_full = [r for r in full if r["outcome"] == "EXPLICIT_BLOCK"]
    accuracy = {
        runtime: rate(
            sum(1 for r in explicit_full if r["runtime"] == runtime and r.get("code_match")),
            sum(1 for r in explicit_full if r["runtime"] == runtime),
        )
        for runtime in RUNTIME_ORDER
    }

    def brief(r):
        stop = r.get("stop") or {}
        return {
            "case": r["case"],
            "runtime": r["runtime"],
            "profile": r["profile"],
            "outcome": r["outcome"],
            "stop": f"{stop.get('kind')}:{stop.get('code')}@{stop.get('phase')}",
            "reason": r.get("reason"),
        }

    unexpected = {
        "full_silent_violations": [brief(r) for r in full if r["outcome"] == "SILENT_VIOLATION"],
        "full_false_rejects": [brief(r) for r in full if r["outcome"] == "FALSE_REJECT"],
        "full_incidental_failures": [
            brief(r) for r in full if r["outcome"] == "INCIDENTAL_FAILURE"
        ],
        "full_unexpected_code": [
            brief(r) for r in explicit_full if not (r.get("code_match") and r.get("reason_match"))
        ],
        "harness_errors": [brief(r) for r in rows if r["outcome"] == "HARNESS_ERROR"],
        "false_rejects_any_profile": [brief(r) for r in rows if r["outcome"] == "FALSE_REJECT"],
    }
    # Per ablated profile: the cases whose primary guard it removes, and what became of them.
    exposure = {}
    for profile in profiles:
        if profile == "full":
            continue
        targeted = [
            r
            for r in rows
            if r["profile"] == profile
            and r["kind"] == "violation"
            and cases[r["case"]]["primary_ablation"] == profile
            and cases[r["case"]]["ablation_removes_guard"]
        ]
        per_runtime = {}
        for runtime in RUNTIME_ORDER:
            mine = [r for r in targeted if r["runtime"] == runtime]
            per_runtime[runtime] = {
                "targeted": len(mine),
                "silent": sum(1 for r in mine if r["outcome"] == "SILENT_VIOLATION"),
                "backstops": [
                    {**brief(r), "code": (r.get("stop") or {}).get("code")}
                    for r in mine
                    if r["outcome"] == "EXPLICIT_BLOCK"
                ],
                "other": [
                    brief(r)
                    for r in mine
                    if r["outcome"] not in ("SILENT_VIOLATION", "EXPLICIT_BLOCK")
                ],
            }
        exposure[profile] = per_runtime
    summary = {
        "results": results.name,
        "commit": manifest["git"]["commit"],
        "preset": manifest["preset"],
        "seed": manifest["seed"],
        "catalog_sha256": manifest["catalog_sha256"],
        "executions": len(rows),
        "expected_executions": manifest["expected_executions"],
        "profiles": profiles,
        "table": table,
        "code_accuracy_full": accuracy,
        "exposure": exposure,
        "unexpected_counts": {k: len(v) for k, v in unexpected.items()},
    }
    (results / "summary.json").write_text(json.dumps(summary, indent=1))
    (results / "unexpected.json").write_text(json.dumps(unexpected, indent=1))
    _write_tables(results, summary)
    return summary


def _pct(entry: dict) -> str:
    if not entry or entry["n"] == 0:
        return "—"
    low, high = entry["ci95"]
    return f"{100 * entry['rate']:.1f} [{100 * low:.1f}, {100 * high:.1f}]"


def _short(entry: dict) -> str:
    if not entry or entry["n"] == 0:
        return "—"
    return f"{100 * entry['rate']:.1f}"


def _write_tables(results: Path, summary: dict) -> None:
    header = [
        "family",
        "profile",
        "runtime",
        "violations",
        "controls",
        "VDR",
        "SVR",
        "IFR",
        "BAR",
        "VDR_effect",
        "SVR_effect",
        "paired",
        "HER",
    ]
    with open(results / "table.csv", "w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        for row in summary["table"]:
            writer.writerow(
                [row["family"], row["profile"], row["runtime"], row["violations"], row["controls"]]
                + ["" if row[key]["n"] == 0 else f"{row[key]['rate']:.4f}" for key in header[5:]]
            )
    lines = [
        f"# Catalog v2 · {summary['results']}",
        "",
        f"Commit `{summary['commit']}` · preset `{summary['preset']}` · seed {summary['seed']} · "
        f"{summary['executions']} executions (expected {summary['expected_executions']}) · "
        f"catalog `{summary['catalog_sha256'][:16]}…`",
        "",
        "Rates in % with 95 % Wilson intervals. VDR explicit blocks, SVR silent violations, IFR "
        "incidental failures (of violations); BAR accepted controls; `effect` counts only cases "
        "whose boundary is a forbidden effect (not admission).",
        "",
        "| Family | Profile | Runtime | Viol. | Ctrl | VDR | SVR | IFR | BAR "
        "| VDR (effect) | SVR (effect) |",
        "|---|---|---|---:|---:|---|---|---|---|---|---|",
    ]
    for row in summary["table"]:
        lines.append(
            f"| {row['family']} | {row['profile']} | {row['runtime']} | {row['violations']} | "
            f"{row['controls']} | {_pct(row['VDR'])} | {_pct(row['SVR'])} | {_short(row['IFR'])} | "
            f"{_pct(row['BAR'])} | {_short(row['VDR_effect'])} | {_short(row['SVR_effect'])} |"
        )
    lines += ["", "## Ablated profiles: the cases each targets", ""]
    lines += [
        "| Profile | Runtime | Targeted | Silent | Blocked by a backstop | Other |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for profile, per_runtime in summary["exposure"].items():
        for runtime, entry in per_runtime.items():
            lines.append(
                f"| {profile} | {runtime} | {entry['targeted']} | {entry['silent']} | "
                f"{len(entry['backstops'])} | {len(entry['other'])} |"
            )
    lines += ["", "## Unexpected", ""]
    for key, value in summary["unexpected_counts"].items():
        lines.append(f"- {key}: {value}")
    (results / "table.md").write_text("\n".join(lines) + "\n")


def print_table(summary: dict) -> None:
    print(
        f"\ncatalog v2 · {summary['results']} · commit {summary['commit'][:10]} · "
        f"{summary['executions']}/{summary['expected_executions']} executions"
    )
    print(
        f"{'family':6} {'profile':22} {'rt':3} {'viol':>4} {'ctrl':>4}  "
        f"{'VDR':>6} {'SVR':>6} {'IFR':>6} {'BAR':>6}  {'VDR_eff':>7} {'SVR_eff':>7}"
    )
    for row in summary["table"]:
        print(
            f"{row['family']:6} {row['profile']:22} {row['runtime']:3} {row['violations']:4} "
            f"{row['controls']:4}  {_short(row['VDR']):>6} {_short(row['SVR']):>6} "
            f"{_short(row['IFR']):>6} {_short(row['BAR']):>6}  {_short(row['VDR_effect']):>7} "
            f"{_short(row['SVR_effect']):>7}"
        )
    print("unexpected:", summary["unexpected_counts"])


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    summary = analyze(Path(argv[1]))
    print_table(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
