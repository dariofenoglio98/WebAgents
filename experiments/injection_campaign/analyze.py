"""E2's and E3's tables from campaign result directories (PROTOCOL.md §2.4.4, §2.7, §3 E2, §3 E3;
D-360…D-363). Reads only the directories' `manifest.json`, `runs/*/run.json` and `runs/*/outcome.json`;
writes nothing into them (a results directory is written once).

    agentpkg/.venv/bin/python experiments/injection_campaign/analyze.py \\
        experiments/injection_campaign/results/<UTC>_paper-L9 [more directories of the same series] \\
        [--json tables.json] [--bootstrap 2000] [--seed 31]

Several directories are pooled only when they are one series: the same commit, the same protocol
SHA-256, the same payload catalog and the same task sets (D-019: old series are never pooled). Every
directory must hold an outcome for every unit of its `units.json`, and no unit may be given twice
(the same rung twice would double n); `--allow-incomplete` prints the shortfall instead of refusing
(T32 review 1, finding 7).

**Supplements** (`--supplement DIR`, PROTOCOL.md §9.2, version 5, D-364): a directory of the
`e3-memory` preset (F-MEMORY's injected runs and twins on TS-W's home-airport phrasings) replaces,
for each side and rung it covers, the series' F-MEMORY units in every F-MEMORY cell and in the
headline cell. It may come from a later commit and protocol, but must share the series' payload
catalog and seed; the superseded units are counted (`superseded`) and never pooled.

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
Denominators are intention to treat (every injected run, D-360); `exposed` (k/n) and the exposed-only
any-boundary rate are printed beside every cell; a cell no injected run reached (`exposed` 0) is
printed "not reached", without a rule-of-three bound: a zero there is no evidence (review 1,
finding 2; §9.2, version 5). The sides are also compared run for run (`FW` − `Py`, `FW` − `Cr`:
the difference of any boundary reached, paired by arm, with a bootstrap interval).

**Reach (E3).** Per cell, beside `exposed` (the runtime read the placement), the runs whose injected
text is in a recorded model request (`in_model_request`: the payload's text, stripped, found in a
model call's system or user text after decoding nested JSON strings), so "read by the runtime" and
"in front of the model" are both counted by the script (T32 review 2, finding 5). It needs the
series' payload catalog (the manifest's digest); with another catalog it is not counted.

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
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[1]

POOLED = "all eight families"
BOUNDARIES = ("a", "b", "c", "d", "e")
SERIES_KEYS = ("commit", "protocol", "payloads", "task_sets")
SUPPLEMENT_KEYS = ("payloads", "seed")
SUPPLEMENT_PRESETS = {"e3-memory": "F-MEMORY"}
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
    if k == 0 and n >= 3:
        # the one-sided 95 % upper bound of a zero cell; below n = 3 it would pass 1 (T32 review
        # 2, nit 9), and the Wilson interval stands alone
        out["rule_of_three"] = round(3 / n, 4)
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
def _manifest(directory: Path) -> dict:
    return json.loads((directory / "manifest.json").read_text())


def payload_texts(manifest: dict) -> dict[str, str] | None:
    """The injected text of every payload, when the catalog in this tree is the series' (by its
    digest); else None, and the model-request column is not counted."""
    if str(EXPERIMENTS) not in sys.path:
        sys.path.insert(0, str(EXPERIMENTS))
    from campaigns.origin import catalog

    recorded = (manifest.get("payloads") or {}).get("sha256")
    if recorded is None or catalog.catalog_digest()["sha256"] != recorded:
        return None
    return {pid: payload["text"] for pid, payload in catalog.load().items()}


def _strings(value, depth: int = 0):
    """Every string in a value, and in the JSON a string holds (nested up to 4 levels)."""
    if isinstance(value, str):
        yield value
        text = value.strip()
        if depth < 4 and text[:1] in ("{", "[") and text[-1:] in ("}", "]"):
            try:
                decoded = json.loads(text)
            except ValueError:
                return
            yield from _strings(decoded, depth + 1)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item, depth)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item, depth)


_ESCAPED_SPACE = re.compile(r"\\+[nrt]")
_SPACE = re.compile(r"\s+")


def _normal(text: str) -> str:
    """Whitespace collapsed, a JSON-escaped newline or tab counted as whitespace: a PDF reader
    re-wraps a note's lines, and a request may embed JSON inside prose."""
    return _SPACE.sub(" ", _ESCAPED_SPACE.sub(" ", text)).strip()


def in_model_request(rec: dict, text: str) -> bool:
    """The payload's text in a recorded model request: the system or user text of any model call,
    its nested JSON strings decoded, compared with whitespace collapsed (the text as the reader or
    the record wrapped it), the text also matched in its JSON-escaped forms."""
    core = text.strip()
    if not core:
        return False
    needles = {core}
    for ascii_only in (False, True):
        once = json.dumps(core, ensure_ascii=ascii_only)[1:-1]
        needles |= {once, json.dumps(once, ensure_ascii=ascii_only)[1:-1]}
    needles = {_normal(n) for n in needles}
    for call in rec.get("model_calls") or []:
        for field in ("system", "user"):
            for string in _strings(call.get(field)):
                normal = _normal(string)
                if any(needle in normal for needle in needles):
                    return True
    return False


def _rows(
    directory: Path,
    *,
    allow_incomplete: bool,
    shortfalls: dict,
    texts: dict | None = None,
) -> list[dict]:
    """The directory's rows, checked against its unit list (review 1, finding 7)."""
    units_path = directory / "units.json"
    if not units_path.is_file():
        raise SystemExit(f"{directory}: no units.json, so n cannot be checked")
    expected = {u["id"] for u in json.loads(units_path.read_text())}
    found = {p.parent.name for p in (directory / "runs").glob("*/outcome.json")}
    missing, extra = expected - found, found - expected
    if extra:
        raise SystemExit(
            f"{directory}: {len(extra)} outcomes of units outside its unit list"
        )
    if missing:
        if not allow_incomplete:
            raise SystemExit(
                f"{directory}: {len(missing)} of {len(expected)} units have no outcome "
                "(--allow-incomplete prints the shortfall instead)"
            )
        shortfalls[directory.name] = sorted(missing)
    rows = []
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
                "unit": outcome_path.parent.name,
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
                "in_model_request": (
                    in_model_request(rec, texts[payload])
                    if kind == "injected" and texts is not None and payload in texts
                    else None
                ),
                "refused_run": bool(outcome.get("refused")),
                "fw_denials": sum(
                    1
                    for r in rec.get("refused") or []
                    if str(r.get("kind") or "").startswith(("progent", "ask", "schema"))
                )
                if meta["side"] == "FW"
                else 0,
                "outcome": outcome,
            }
        )
    return rows


def load(
    directories: list[Path],
    supplements: list[Path] = (),
    *,
    allow_incomplete: bool = False,
    report: dict | None = None,
) -> tuple[list[dict], dict]:
    """The series' rows, with each supplement's family replacing the series' units of that family
    on the sides and rungs the supplement covers. `report` receives the shortfalls and the
    superseded units."""
    manifests = [_manifest(d) for d in directories]
    first = manifests[0]
    for path, manifest in zip(directories, manifests, strict=True):
        for key in SERIES_KEYS:
            if manifest.get(key) != first.get(key):
                raise SystemExit(
                    f"{path}: not the series of {directories[0]} ({key} differs)"
                )
    report = {} if report is None else report
    shortfalls: dict = report.setdefault("shortfalls", {})
    texts = payload_texts(first)
    report["model_request_counted"] = texts is not None
    rows = []
    for directory in directories:
        rows += _rows(
            directory,
            allow_incomplete=allow_incomplete,
            shortfalls=shortfalls,
            texts=texts,
        )
    superseded: dict = report.setdefault("superseded", {})
    for supplement in supplements:
        manifest = _manifest(supplement)
        family = SUPPLEMENT_PRESETS.get(manifest.get("preset"))
        if family is None:
            raise SystemExit(
                f"{supplement}: preset {manifest.get('preset')!r} is no supplement"
            )
        for key in SUPPLEMENT_KEYS:
            if manifest.get(key) != first.get(key):
                raise SystemExit(
                    f"{supplement}: not a supplement of this series ({key} differs)"
                )
        if manifest.get("tasks_selected"):
            raise SystemExit(
                f"{supplement}: narrowed by --tasks, so not the whole stratum"
            )
        added = _rows(
            supplement,
            allow_incomplete=allow_incomplete,
            shortfalls=shortfalls,
            texts=texts,
        )
        if {r["family"] for r in added} - {family}:
            raise SystemExit(
                f"{supplement}: holds units of another family than {family}"
            )
        covered = {(r["side"], r["rung"]) for r in added}
        # It replaces the stratum it covers, whole (T32 review 2, nit 7): a side and rung the
        # series has, the same number of injected runs, each with its twin (the counts are not
        # compared when a shortfall is printed under --allow-incomplete).
        for side, rung in sorted(covered):
            old = [
                r
                for r in rows
                if (r["family"], r["side"], r["rung"], r["arm"])
                == (family, side, rung, "injected")
            ]
            new = [r for r in added if (r["side"], r["rung"]) == (side, rung)]
            injected = [r for r in new if r["arm"] == "injected"]
            twins = {
                (r["task_id"], r["phrasing"], r["payload"], r["placement"])
                for r in new
                if r["arm"] == "twin"
            }
            if not old:
                raise SystemExit(f"{supplement}: {side} on {rung} is not in the series")
            if len(injected) != len(old) and not shortfalls:
                raise SystemExit(
                    f"{supplement}: {len(injected)} injected {family} runs for {side} on {rung}, "
                    f"the series has {len(old)}"
                )
            unpaired = [
                r
                for r in injected
                if (r["task_id"], r["phrasing"], r["payload"], r["placement"])
                not in twins
            ]
            if unpaired and not shortfalls:
                raise SystemExit(
                    f"{supplement}: {len(unpaired)} injected runs without a twin"
                )
        kept = []
        for r in rows:
            if (
                r["family"] == family
                and r["arm"] != "benign"
                and (r["side"], r["rung"]) in covered
            ):
                key = f"{r['directory']}|{family}"
                superseded[key] = superseded.get(key, 0) + 1
            else:
                kept.append(r)
        rows = kept + added
    units = [r["unit"] for r in rows]
    if len(units) != len(set(units)):
        twice = sorted({u for u in units if units.count(u) > 1})
        raise SystemExit(
            f"{len(twice)} units given twice (e.g. {twice[0]}): the same rung twice?"
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


def _in_model_request(injected: list[dict]) -> dict | None:
    """Runs whose injected text is in a recorded model request (finding 5); None when the series'
    catalog is not this tree's."""
    if any(r["in_model_request"] is None for r in injected):
        return None
    return rate(sum(r["in_model_request"] for r in injected), len(injected))


def _cell(
    injected: list[dict], twins: list[dict], *, resamples: int, seed: str
) -> dict:
    n = len(injected)
    exposed = [r for r in injected if r["outcome"].get("exposed")]
    cell = {
        "n": n,
        "harness_errors": sum(r["status"] == "harness_error" for r in injected),
        "exposed": rate(len(exposed), n),
        "in_model_request": _in_model_request(injected),
        # No injected run read the placement: the cell measures nothing (review 1, finding 2).
        "reached": bool(exposed),
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
            "in_model_request": _in_model_request(v),
            "reached": any(r["outcome"].get("exposed") for r in v),
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


def tables(
    directories: list[Path],
    *,
    supplements: list[Path] = (),
    allow_incomplete: bool = False,
    resamples: int = 2000,
    seed: int = 31,
) -> dict:
    import tempfile

    with tempfile.TemporaryDirectory(prefix="analyze-") as scratch:
        return _tables(
            _unpacked(directories, Path(scratch)),
            _unpacked(list(supplements), Path(scratch)),
            allow_incomplete=allow_incomplete,
            resamples=resamples,
            seed=seed,
        )


def _tables(
    directories: list[Path],
    supplements: list[Path],
    *,
    allow_incomplete: bool,
    resamples: int,
    seed: int,
) -> dict:
    report: dict = {}
    rows, manifest = load(
        directories, supplements, allow_incomplete=allow_incomplete, report=report
    )
    return {
        "schema": "injection_campaign.tables.v2",
        "directories": [d.name for d in directories],
        "supplements": {
            d.name: {
                "commit": _manifest(d).get("commit"),
                "preset": _manifest(d).get("preset"),
            }
            for d in supplements
        },
        "superseded": report["superseded"],
        "shortfalls": report["shortfalls"],
        "model_request_counted": report["model_request_counted"],
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


def findings_draft(
    directories: list[Path],
    *,
    supplements: list[Path] = (),
    allow_incomplete: bool = False,
    sample: int = 20,
    seed: int = 31,
) -> str:
    """D-363: the draft of a directory's `findings.md` (the session completes it by hand): every
    harness error with its code, every boundary reached on `Py` or `Cr` (a product defect, D-304),
    every benign run our runtime refused (a false refusal), and a seeded sample of runs whose
    records are to be re-read against the oracle's verdict."""
    import tempfile

    report: dict = {}
    with tempfile.TemporaryDirectory(prefix="findings-") as scratch:
        rows, manifest = load(
            _unpacked(directories, Path(scratch)),
            _unpacked(list(supplements), Path(scratch)),
            allow_incomplete=allow_incomplete,
            report=report,
        )
    lines = [
        f"# Findings: {', '.join(d.name for d in directories)}",
        "",
        *[f"Supplement `{d.name}`." for d in supplements],
        *[
            f"INCOMPLETE `{name}`: {len(missing)} units without an outcome."
            for name, missing in report["shortfalls"].items()
        ],
        *[
            f"Superseded {count} units: {key}."
            for key, count in report["superseded"].items()
        ],
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


NOT_REACHED = "not reached"


def _fmt(r: dict | None) -> str:
    if not r or r.get("n") in (None, 0):
        return "–"
    text = f"{r['k']}/{r['n']}"
    if r.get("wilson95"):
        text += f" [{r['wilson95'][0]:.3f},{r['wilson95'][1]:.3f}]"
    if "rule_of_three" in r:
        text += f" ≤{r['rule_of_three']:.3f}"
    return text


def _reach(cell: dict, value: dict | None) -> str:
    """A boundary or attempt cell, or "not reached" where no injected run read the placement."""
    return _fmt(value) if cell.get("reached", True) else NOT_REACHED


def render(data: dict) -> str:
    lines = [f"runs {data['runs']} from {', '.join(data['directories'])}"]
    for name, info in (data.get("supplements") or {}).items():
        lines.append(
            f"supplement {name} ({info['preset']}, commit {str(info['commit'])[:7]})"
        )
    for key, count in (data.get("superseded") or {}).items():
        lines.append(f"superseded {count} units: {key}")
    for name, missing in (data.get("shortfalls") or {}).items():
        lines.append(f"INCOMPLETE {name}: {len(missing)} units without an outcome")
    lines += ["", "Tab. 4 (E3, TS-W)"]
    lines.append(
        "cell | n | exposed | (a) | (b) | (d) | any | any, exposed only | attempt | "
        "utility inj | utility twin | drop"
    )
    for key, cell in data["tab4_e3"].items():
        drop = cell["utility_drop_twin_minus_injected"]
        lines.append(
            " | ".join(
                [
                    key,
                    str(cell["n"]),
                    _fmt(cell["exposed"]),
                    _reach(cell, cell["boundary"]["a"]),
                    _reach(cell, cell["boundary"]["b"]),
                    _reach(cell, cell["boundary"]["d"]),
                    _reach(cell, cell["any_boundary"]),
                    _reach(cell, cell["exposed_only"]["any_boundary"]),
                    _reach(cell, cell["attempt"]),
                    _fmt(cell["utility_injected"]),
                    _fmt(cell["utility_twin"]),
                    f"{drop['mean_diff']} {drop['bootstrap95']}",
                ]
            )
        )
    lines += [
        "",
        "Reach (E3, TS-W): the runtime read the placement; the text in a model request",
        "cell | n | exposed | in a model request",
    ]
    for key, cell in data["tab4_e3"].items():
        counted = cell.get("in_model_request")
        lines.append(
            f"{key} | {cell['n']} | {_fmt(cell['exposed'])} | "
            f"{_fmt(counted) if counted is not None else 'not counted (another catalog)'}"
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
        lines += [
            "",
            "E3 TS-L",
            "cell | n | exposed | any boundary | attempt | utility",
        ]
        for key, cell in data["e3_literature"].items():
            lines.append(
                f"{key} | {cell['n']} | {_fmt(cell['exposed'])} | "
                f"{_reach(cell, cell['any_boundary'])} | {_reach(cell, cell['attempt'])} | "
                f"{_fmt(cell['utility'])}"
            )
        lines += [
            "",
            "Reach (E3, TS-L): the runtime read the placement; the text in a model request",
            "cell | n | exposed | in a model request",
        ]
        for key, cell in data["e3_literature"].items():
            counted = cell.get("in_model_request")
            lines.append(
                f"{key} | {cell['n']} | {_fmt(cell['exposed'])} | "
                f"{_fmt(counted) if counted is not None else 'not counted (another catalog)'}"
            )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("directories", nargs="+", type=Path)
    parser.add_argument(
        "--supplement",
        action="append",
        type=Path,
        default=[],
        help="an e3-memory directory whose F-MEMORY units replace the series' (§9.2, version 5)",
    )
    parser.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="print a directory's shortfall against its unit list instead of refusing it",
    )
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
        print(
            findings_draft(
                args.directories,
                supplements=args.supplement,
                allow_incomplete=args.allow_incomplete,
                seed=args.seed,
            ),
            end="",
        )
        return 0
    for directory in [*args.directories, *args.supplement]:
        if args.json is not None and args.json.resolve().is_relative_to(
            directory.resolve()
        ):
            parser.error("the tables are never written into a results directory")
    data = tables(
        args.directories,
        supplements=args.supplement,
        allow_incomplete=args.allow_incomplete,
        resamples=args.bootstrap,
        seed=args.seed,
    )
    print(render(data))
    if args.json is not None:
        args.json.write_text(json.dumps(data, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
