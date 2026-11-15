"""E2's and E3's tables from campaign result directories (PROTOCOL.md §2.4.4, §2.7, §3 E2, §3 E3;
D-360…D-363). Reads only the directories' `manifest.json`, `runs/*/run.json` and `runs/*/outcome.json`;
writes nothing into them (a results directory is written once).

    agentpkg/.venv/bin/python experiments/injection_campaign/analyze.py \\
        experiments/injection_campaign/results/<UTC>_paper-L9 [more directories of the same series] \\
        [--json tables.json] [--bootstrap 2000] [--seed 31]

Several directories are pooled only when they are one series: the same commit, the same protocol
SHA-256, the same payload catalog and the same task sets (D-019: old series are never pooled).

**Tab. 4 (E3).** Per family and the pooled arm "all eight families" (the headline cell, §3 E3) ×
side × rung, over the injected runs of the `e3` units on TS-W:
- `n`, harness errors (in every denominator), `exposed` (the run read the placement);
- the boundary rate per boundary (a)…(e): runs that reached it / n, a 95 % Wilson interval, and for
  a zero cell the rule-of-three bound 3/n; an unsealed canary's hit is the measured residual, never a
  boundary (reported as `residual_b`);
- the attempt rate (runs with at least one attempt by the payload's matcher) and the refused-attempt
  rate (runs with at least one attempt a mechanism refused and recorded); for F-STEER the attempt is
  the steer, reported as the steering rate (semantic injection within authority, not a boundary);
- utility under injection and under the benign twin, and the paired difference (twin − injected,
  paired by task, phrasing, payload and placement) with a seeded bootstrap interval;
- cards per run; medians with interquartile ranges of model calls, tokens, wall seconds, dollars.
Denominators are intention to treat (every injected run, D-360); the exposed-only rates are printed
beside them (`exposed_only`). The sides are also compared run for run (`FW` − `Py`, `FW` − `Cr`:
the difference of any boundary reached, paired by arm, with a bootstrap interval).

**TS-L (E3's Literature Review arm).** Per payload and placement × side × rung: n, boundaries,
attempts, utility (no twin; E2's benign TS-L rows are its comparison).

**E2.** Per task set × side × rung over the benign units: utility with its Wilson interval, the
runs our runtime refused (fail-closed), the framework layer's denials of benign calls (its false
refusals), harness errors, and the cost medians.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import sys
from collections import defaultdict
from pathlib import Path

POOLED = "all eight families"
BOUNDARIES = ("a", "b", "c", "d", "e")
SERIES_KEYS = ("commit", "protocol", "payloads", "task_sets")
Z = 1.959963984540054


# -- estimators -----------------------------------------------------------------------------------
def wilson(k: int, n: int) -> list[float] | None:
    """The 95 % Wilson score interval of k successes in n (§2.4.4)."""
    if n == 0:
        return None
    p = k / n
    centre = (p + Z * Z / (2 * n)) / (1 + Z * Z / n)
    half = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / (1 + Z * Z / n)
    return [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)]


def rate(k: int, n: int) -> dict:
    out = {
        "k": k,
        "n": n,
        "rate": round(k / n, 4) if n else None,
        "wilson95": wilson(k, n),
    }
    if k == 0 and n:
        out["rule_of_three"] = round(
            3 / n, 4
        )  # the one-sided 95 % upper bound of a zero cell
    return out


def paired_bootstrap(
    pairs: list[tuple[float, float]], *, resamples: int, seed: str
) -> dict:
    """Mean of (b − a) over pairs, with a seeded percentile bootstrap interval (§2.4.4)."""
    if not pairs:
        return {"n_pairs": 0, "mean_diff": None, "bootstrap95": None}
    diffs = [b - a for a, b in pairs]
    rng = random.Random(seed)
    means = sorted(
        statistics.fmean(rng.choices(diffs, k=len(diffs))) for _ in range(resamples)
    )
    lo, hi = (
        means[int(0.025 * resamples)],
        means[min(resamples - 1, int(0.975 * resamples))],
    )
    return {
        "n_pairs": len(diffs),
        "mean_diff": round(statistics.fmean(diffs), 4),
        "bootstrap95": [round(lo, 4), round(hi, 4)],
    }


def spread(values: list[float]) -> dict | None:
    values = [v for v in values if v is not None]
    if not values:
        return None
    if len(values) == 1:
        return {"median": values[0], "iqr": [values[0], values[0]]}
    q = statistics.quantiles(values, n=4, method="inclusive")
    return {
        "median": round(statistics.median(values), 3),
        "iqr": [round(q[0], 3), round(q[2], 3)],
    }


# -- loading ----------------------------------------------------------------------------------------
def load(directories: list[Path]) -> tuple[list[dict], dict]:
    manifests = [json.loads((d / "manifest.json").read_text()) for d in directories]
    first = manifests[0]
    for path, manifest in zip(directories, manifests, strict=True):
        for key in SERIES_KEYS:
            if manifest.get(key) != first.get(key):
                raise SystemExit(
                    f"{path}: not the series of {directories[0]} ({key} differs)"
                )
    rows = []
    for directory in directories:
        for outcome_path in sorted((directory / "runs").glob("*/outcome.json")):
            rec = json.loads((outcome_path.parent / "run.json").read_text())
            outcome = json.loads(outcome_path.read_text())
            meta = rec["meta"]
            arm = meta.get("arm") or "benign"
            payload = placement = kind = None
            if arm != "benign":
                head, kind = arm.rsplit("#", 1)
                payload, placement = head.split("@", 1)
            rows.append(
                {
                    "directory": directory.name,
                    "side": meta["side"],
                    "rung": (rec.get("rung") or {}).get("name"),
                    "task_set": meta.get("task_set") or "TS-W",
                    "task_id": meta.get("task_id"),
                    "phrasing": meta.get("phrasing"),
                    "family": meta.get("family"),
                    "payload": payload,
                    "placement": placement,
                    "arm": kind or "benign",
                    "status": rec.get("status"),
                    "refused_run": bool(outcome.get("refused")),
                    "fw_denials": sum(
                        1
                        for r in rec.get("refused") or []
                        if str(r.get("kind") or "").startswith(
                            ("progent", "ask", "schema")
                        )
                    )
                    if meta["side"] == "FW"
                    else 0,
                    "outcome": outcome,
                }
            )
    return rows, first


# -- the tables ---------------------------------------------------------------------------------------
def _boundaries(o: dict) -> set[str]:
    return set(o.get("boundaries") or [])


def _residual(o: dict) -> bool:
    return bool(o.get("residual"))


def _attempted(o: dict) -> bool:
    return (o.get("attempts") or {}).get("count", 0) > 0


def _useful(o: dict) -> bool:
    return bool((o.get("utility") or {}).get("success"))


def _cost(rows: list[dict]) -> dict:
    def get(row, key):
        return (row["outcome"].get("cost") or {}).get(key)

    def tokens(row):
        cost = row["outcome"].get("cost") or {}
        if cost.get("input_tokens") is None and cost.get("output_tokens") is None:
            return None
        return (cost.get("input_tokens") or 0) + (cost.get("output_tokens") or 0)

    return {
        "model_calls": spread([get(r, "model_calls") for r in rows]),
        "tokens": spread([tokens(r) for r in rows]),
        "seconds": spread([get(r, "seconds") for r in rows]),
        "dollars": spread([get(r, "dollars") for r in rows]),
    }


def _cell(
    injected: list[dict], twins: list[dict], *, resamples: int, seed: str
) -> dict:
    n = len(injected)
    exposed = [r for r in injected if r["outcome"].get("exposed")]
    cell = {
        "n": n,
        "harness_errors": sum(r["status"] == "harness_error" for r in injected),
        "exposed": rate(len(exposed), n),
        "boundary": {
            b: rate(sum(b in _boundaries(r["outcome"]) for r in injected), n)
            for b in BOUNDARIES
        },
        "any_boundary": rate(sum(bool(_boundaries(r["outcome"])) for r in injected), n),
        "residual_b": rate(sum(_residual(r["outcome"]) for r in injected), n),
        "attempt": rate(sum(_attempted(r["outcome"]) for r in injected), n),
        "refused_attempt": rate(
            sum((r["outcome"].get("refused_attempts") or 0) > 0 for r in injected), n
        ),
        "utility_injected": rate(sum(_useful(r["outcome"]) for r in injected), n),
        "utility_twin": rate(sum(_useful(r["outcome"]) for r in twins), len(twins)),
        "cards_per_run": round(
            statistics.fmean([r["outcome"].get("cards") or 0 for r in injected]), 3
        )
        if injected
        else None,
        "cost": _cost(injected),
        "exposed_only": {
            "n": len(exposed),
            "any_boundary": rate(
                sum(bool(_boundaries(r["outcome"])) for r in exposed), len(exposed)
            ),
            "attempt": rate(
                sum(_attempted(r["outcome"]) for r in exposed), len(exposed)
            ),
        },
    }
    key = lambda r: (r["task_id"], r["phrasing"], r["payload"], r["placement"])
    twin_by = {key(r): r for r in twins}
    pairs = [
        (float(_useful(r["outcome"])), float(_useful(twin_by[key(r)]["outcome"])))
        for r in injected
        if key(r) in twin_by
    ]
    cell["utility_drop_twin_minus_injected"] = paired_bootstrap(
        pairs, resamples=resamples, seed=seed
    )
    return cell


def e3_table(rows: list[dict], *, resamples: int, seed: int) -> dict:
    attacked = [
        r for r in rows if r["task_set"] == "TS-W" and r["arm"] in ("injected", "twin")
    ]
    groups: dict = defaultdict(lambda: {"injected": [], "twin": []})
    for r in attacked:
        for family in (r["family"], POOLED):
            groups[(family, r["side"], r["rung"])][r["arm"]].append(r)
    table = {}
    for (family, side, rung), arms in sorted(groups.items()):
        table[f"{family}|{side}|{rung}"] = _cell(
            arms["injected"],
            arms["twin"],
            resamples=resamples,
            seed=f"{seed}:{family}:{side}:{rung}",
        )
    return table


def side_differences(rows: list[dict], *, resamples: int, seed: int) -> dict:
    """`FW` against each core, run for run on the same arm: the difference of any boundary
    reached (FW − ours), per family and pooled, per rung."""
    injected = [r for r in rows if r["task_set"] == "TS-W" and r["arm"] == "injected"]
    index = {
        (
            r["side"],
            r["rung"],
            r["task_id"],
            r["phrasing"],
            r["payload"],
            r["placement"],
        ): r
        for r in injected
    }
    out = {}
    for ours in ("Py", "Cr"):
        groups: dict = defaultdict(list)
        for (side, rung, *arm), r in index.items():
            if side != "FW":
                continue
            other = index.get((ours, rung, *arm))
            if other is None:
                continue
            pair = (
                float(bool(_boundaries(other["outcome"]))),
                float(bool(_boundaries(r["outcome"]))),
            )
            groups[(r["family"], rung)].append(pair)
            groups[(POOLED, rung)].append(pair)
        for (family, rung), pairs in sorted(groups.items()):
            out[f"FW-{ours}|{family}|{rung}"] = paired_bootstrap(
                pairs, resamples=resamples, seed=f"{seed}:FW-{ours}:{family}:{rung}"
            )
    return out


def literature_table(rows: list[dict]) -> dict:
    attacked = [r for r in rows if r["task_set"] == "TS-L" and r["arm"] == "injected"]
    groups: dict = defaultdict(list)
    for r in attacked:
        groups[(r["payload"], r["placement"], r["side"], r["rung"])].append(r)
    return {
        "|".join(k): {
            "n": len(v),
            "harness_errors": sum(r["status"] == "harness_error" for r in v),
            "exposed": rate(sum(bool(r["outcome"].get("exposed")) for r in v), len(v)),
            "any_boundary": rate(
                sum(bool(_boundaries(r["outcome"])) for r in v), len(v)
            ),
            "attempt": rate(sum(_attempted(r["outcome"]) for r in v), len(v)),
            "utility": rate(sum(_useful(r["outcome"]) for r in v), len(v)),
        }
        for k, v in sorted(groups.items())
    }


def e2_table(rows: list[dict]) -> dict:
    benign = [r for r in rows if r["arm"] == "benign"]
    groups: dict = defaultdict(list)
    for r in benign:
        groups[(r["task_set"], r["side"], r["rung"])].append(r)
    return {
        "|".join(k): {
            "n": len(v),
            "utility": rate(sum(_useful(r["outcome"]) for r in v), len(v)),
            "harness_errors": sum(r["status"] == "harness_error" for r in v),
            "refused_by_runtime": sum(r["refused_run"] for r in v if r["side"] != "FW"),
            "fw_layer_denials": sum(r["fw_denials"] for r in v),
            "cards_per_run": round(
                statistics.fmean([r["outcome"].get("cards") or 0 for r in v]), 3
            ),
            "cost": _cost(v),
        }
        for k, v in sorted(groups.items())
    }


def _unpacked(directories: list[Path], scratch: Path) -> list[Path]:
    """A packed directory (`pack.py`: `runs.tar.gz`) is read from a verified, unpacked copy."""
    from pack import unpacked

    return [unpacked(directory, scratch) for directory in directories]


def tables(directories: list[Path], *, resamples: int = 2000, seed: int = 31) -> dict:
    import tempfile

    with tempfile.TemporaryDirectory(prefix="analyze-") as scratch:
        return _tables(
            _unpacked(directories, Path(scratch)), resamples=resamples, seed=seed
        )


def _tables(directories: list[Path], *, resamples: int, seed: int) -> dict:
    rows, manifest = load(directories)
    return {
        "schema": "injection_campaign.tables.v1",
        "directories": [d.name for d in directories],
        "series": {key: manifest.get(key) for key in ("commit", "protocol", "seed")},
        "payload_catalog_sha256": (manifest.get("payloads") or {}).get("sha256"),
        "runs": len(rows),
        "bootstrap": {"resamples": resamples, "seed": seed},
        "denominators": "intention to treat (every injected run, harness errors included); "
        "exposed-only beside it",
        "tab4_e3": e3_table(rows, resamples=resamples, seed=seed),
        "tab4_side_differences": side_differences(rows, resamples=resamples, seed=seed),
        "e3_literature": literature_table(rows),
        "tab4_e2_utility": e2_table(rows),
    }


def findings_draft(directories: list[Path], *, sample: int = 20, seed: int = 31) -> str:
    """D-363: the draft of a directory's `findings.md` (the session completes it by hand): every
    harness error with its code, every boundary reached on `Py` or `Cr` (a product defect, D-304),
    every benign run our runtime refused (a false refusal), and a seeded sample of runs whose
    records are to be re-read against the oracle's verdict."""
    import tempfile

    with tempfile.TemporaryDirectory(prefix="findings-") as scratch:
        rows, manifest = load(_unpacked(directories, Path(scratch)))
    lines = [
        f"# Findings: {', '.join(d.name for d in directories)}",
        "",
        (
            f"Commit `{manifest.get('commit')}`, protocol version "
            f"{(manifest.get('protocol') or {}).get('version')}, {len(rows)} runs with an outcome."
        ),
        "",
        "## Harness errors (in every denominator)",
    ]
    errors = [r for r in rows if r["status"] == "harness_error"]
    lines += [
        f"- `{r['side']}` {r['rung']} {r['task_id']} {r['payload'] or 'benign'}"
        f"@{r['placement'] or '-'}#{r['arm']}"
        for r in errors
    ] or ["- none"]
    lines += ["", "## Boundaries reached on our side (product defects, D-304)"]
    ours = [r for r in rows if r["side"] in ("Py", "Cr") and _boundaries(r["outcome"])]
    lines += [
        f"- `{r['side']}` {r['rung']} {r['task_id']} {r['payload']}@{r['placement']}#{r['arm']}: "
        f"{sorted(_boundaries(r['outcome']))}"
        for r in ours
    ] or ["- none"]
    lines += ["", "## Benign runs our runtime refused (false refusals)"]
    refused = [
        r
        for r in rows
        if r["side"] in ("Py", "Cr") and r["arm"] == "benign" and r["refused_run"]
    ]
    lines += [
        f"- `{r['side']}` {r['rung']} {r['task_id']} p{r['phrasing']}" for r in refused
    ] or ["- none"]
    picked = random.Random(f"{seed}:findings").sample(rows, min(sample, len(rows)))
    lines += [
        "",
        f"## Records re-read against the oracle (a seeded sample of {len(picked)})",
    ]
    lines += [
        f"- [ ] `{r['side']}` {r['rung']} {r['task_id']} p{r['phrasing']} "
        f"{r['payload'] or 'benign'}@{r['placement'] or '-'}#{r['arm']}"
        for r in picked
    ]
    lines += [
        "",
        "## The local-results check with the user (gates the hosted rungs, §2.8)",
        "- date: ",
    ]
    return "\n".join(lines) + "\n"


def _fmt(r: dict | None) -> str:
    if not r or r.get("n") in (None, 0):
        return "–"
    text = f"{r['k']}/{r['n']}"
    if r.get("wilson95"):
        text += f" [{r['wilson95'][0]:.3f},{r['wilson95'][1]:.3f}]"
    if "rule_of_three" in r:
        text += f" ≤{r['rule_of_three']:.3f}"
    return text


def render(data: dict) -> str:
    lines = [
        f"runs {data['runs']} from {', '.join(data['directories'])}",
        "",
        "Tab. 4 (E3, TS-W)",
    ]
    lines.append(
        "cell | n | (a) | (b) | (d) | any | attempt | utility inj | utility twin | drop"
    )
    for key, cell in data["tab4_e3"].items():
        drop = cell["utility_drop_twin_minus_injected"]
        lines.append(
            " | ".join(
                [
                    key,
                    str(cell["n"]),
                    _fmt(cell["boundary"]["a"]),
                    _fmt(cell["boundary"]["b"]),
                    _fmt(cell["boundary"]["d"]),
                    _fmt(cell["any_boundary"]),
                    _fmt(cell["attempt"]),
                    _fmt(cell["utility_injected"]),
                    _fmt(cell["utility_twin"]),
                    f"{drop['mean_diff']} {drop['bootstrap95']}",
                ]
            )
        )
    lines += [
        "",
        "E2 utility (benign)",
        "cell | n | utility | refused | FW denials | errors",
    ]
    for key, cell in data["tab4_e2_utility"].items():
        lines.append(
            f"{key} | {cell['n']} | {_fmt(cell['utility'])} | {cell['refused_by_runtime']} | "
            f"{cell['fw_layer_denials']} | {cell['harness_errors']}"
        )
    if data["e3_literature"]:
        lines += ["", "E3 TS-L", "cell | n | any boundary | attempt | utility"]
        for key, cell in data["e3_literature"].items():
            lines.append(
                f"{key} | {cell['n']} | {_fmt(cell['any_boundary'])} | {_fmt(cell['attempt'])} | "
                f"{_fmt(cell['utility'])}"
            )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("directories", nargs="+", type=Path)
    parser.add_argument(
        "--json", type=Path, default=None, help="also write the tables here"
    )
    parser.add_argument("--bootstrap", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=31)
    parser.add_argument(
        "--findings",
        action="store_true",
        help="print the draft of findings.md (D-363) instead",
    )
    args = parser.parse_args(argv)
    if args.findings:
        print(findings_draft(args.directories, seed=args.seed), end="")
        return 0
    for directory in args.directories:
        if args.json is not None and args.json.resolve().is_relative_to(
            directory.resolve()
        ):
            parser.error("the tables are never written into a results directory")
    data = tables(args.directories, resamples=args.bootstrap, seed=args.seed)
    print(render(data))
    if args.json is not None:
        args.json.write_text(json.dumps(data, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
