#!/usr/bin/env python3
"""Summarize one contract-enforcement results directory.

    agentpkg/.venv/bin/python experiments/contract_enforcement/analyze.py <results-dir>

Reads `case_catalog.json` and the append-only `raw/*.jsonl` shards and writes
every derived file (re-running it is always safe and gives identical output):

    raw_results.jsonl / raw_results.csv   one record per (profile, case), merged
    summary.json / summary.csv            metrics per profile
    family_summary.csv                    per profile x family (and package)
    template_summary.csv                  per profile x template
    ablation_matrix.csv                   template x profile (outcome counts, rates)
    stage_summary.csv                     expected x observed stage (explicit blocks)
    unexpected_cases.json                 everything that is not the expected outcome
    report.md                             with a "Paper-ready interpretation" section
    paper_main_table.tex / paper_ablation_table.tex / paper_case_table.tex
    ablation_heatmap.svg                  detection rate, profile x family
    paper_manifest.json                   what a paper number can be traced back to
    timing_summary.json                   wall-clock statistics (not part of the summary)

Rates (all with 95% Wilson score intervals; denominators include harness
errors, so a harness error can only lower a detection or acceptance rate):

    VDR  violation detection rate   EXPLICIT_BLOCK / violations
    SVR  silent violation rate      SILENT_VIOLATION / violations
    IFR  incidental failure rate    INCIDENTAL_FAILURE / violations
    BAR  benign acceptance rate     BENIGN_ACCEPT / controls
    PCC  paired contract correctness: a violation explicitly blocked AND its
         matched control accepted, in the same profile, / violations
"""

from __future__ import annotations

import csv
import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from harness import records as R  # noqa: E402
from harness.paths import EXPERIMENT_VERSION, THREAT_MODEL_VERSION  # noqa: E402

EB, IF, SV, BA, FR, HE = (
    "EXPLICIT_BLOCK",
    "INCIDENTAL_FAILURE",
    "SILENT_VIOLATION",
    "BENIGN_ACCEPT",
    "FALSE_REJECT",
    "HARNESS_ERROR",
)
PROFILE_ORDER = (
    "full",
    "minus_verification",
    "minus_trust",
    "minus_authorization",
    "minus_compatibility",
    "minus_plan_revalidation",
    "minus_host_mediation",
    "minus_output_validation",
    "minus_resource_enforcement",
)
LABELS = {
    "full": "Full",
    "minus_verification": "-Verification",
    "minus_trust": "-Trust",
    "minus_authorization": "-Authorization",
    "minus_compatibility": "-Compatibility",
    "minus_plan_revalidation": "-Plan revalidation",
    "minus_host_mediation": "-Host mediation",
    "minus_output_validation": "-Output validation",
    "minus_resource_enforcement": "-Resource enforcement",
}
FAMILY_NAMES = {
    "F1": "Package verification",
    "F2": "Publisher trust",
    "F3": "Authorization",
    "F4": "Requirements / compatibility",
    "F5": "Plan binding / TOCTOU",
    "F6": "Host mediation",
    "F7": "Output / state integrity",
    "F8": "Resource governance",
}


def wilson(
    successes: int, total: int, z: float = 1.959963984540054
) -> tuple[float | None, float | None]:
    if total == 0:
        return None, None
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return max(0.0, centre - half), min(1.0, centre + half)


def rate(successes: int, total: int) -> dict:
    low, high = wilson(successes, total)
    return {
        "k": successes,
        "n": total,
        "rate": (successes / total) if total else None,
        "ci_low": low,
        "ci_high": high,
    }


def load(results: Path):
    catalog = json.loads((results / "case_catalog.json").read_text())
    config = json.loads((results / "config.json").read_text())
    merged: dict[str, dict] = {}
    duplicates = []
    for path in sorted((results / "raw").glob("*.jsonl")) if (results / "raw").exists() else []:
        for record in R.read(path):
            if record["key"] in merged:
                duplicates.append(record["key"])
                continue
            merged[record["key"]] = record
    return catalog, config, merged, duplicates


def ordered(profiles):
    return [p for p in PROFILE_ORDER if p in profiles] + sorted(
        p for p in profiles if p not in PROFILE_ORDER
    )


def metrics(violations: list[dict], controls_by_id: dict[str, dict]) -> dict:
    outcomes = Counter(record["outcome"] for record in violations)
    n = len(violations)
    # The matched controls of exactly these violations (each counted once).
    matched = [
        controls_by_id[cid]
        for cid in sorted({r["control_id"] for r in violations})
        if cid in controls_by_id
    ]
    accepted = sum(1 for record in matched if record["outcome"] == BA)
    explicit = [record for record in violations if record["outcome"] == EB]
    stage_ok = sum(1 for record in explicit if record.get("stage_match"))
    component_ok = sum(1 for record in explicit if record.get("component_match"))
    code_ok = sum(1 for record in explicit if record.get("code_match"))
    return {
        "violations": n,
        "violation_outcomes": {key: outcomes.get(key, 0) for key in (EB, IF, SV, HE)},
        "VDR": rate(outcomes.get(EB, 0), n),
        "SVR": rate(outcomes.get(SV, 0), n),
        "IFR": rate(outcomes.get(IF, 0), n),
        "harness_errors": outcomes.get(HE, 0),
        # (explicitly blocked violations + accepted matched controls)
        #   / (violations + matched controls)
        "PCC": rate(outcomes.get(EB, 0) + accepted, n + len(matched)),
        "matched_controls": len(matched),
        "stage_accuracy": rate(stage_ok, len(explicit)),
        "component_accuracy": rate(component_ok, len(explicit)),
        "code_accuracy": rate(code_ok, len(explicit)),
        "detected_after_boundary": sum(
            1 for record in violations if record.get("detected_after_boundary")
        ),
    }


def control_metrics(controls: list[dict]) -> dict:
    outcomes = Counter(record["outcome"] for record in controls)
    n = len(controls)
    return {
        "controls": n,
        "control_outcomes": {key: outcomes.get(key, 0) for key in (BA, FR, HE)},
        "BAR": rate(outcomes.get(BA, 0), n),
        "FRR": rate(outcomes.get(FR, 0), n),
        "harness_errors": outcomes.get(HE, 0),
    }


def fmt(entry: dict | None, digits: int = 1) -> str:
    if not entry or entry.get("rate") is None:
        return "--"
    return f"{100 * entry['rate']:.{digits}f}"


def fmt_ci(entry: dict | None) -> str:
    if not entry or entry.get("rate") is None:
        return "--"
    return f"{100 * entry['rate']:.1f} [{100 * entry['ci_low']:.1f}, {100 * entry['ci_high']:.1f}]"


def tex(text: str) -> str:
    return (
        str(text)
        .replace("\\", "\\textbackslash{}")
        .replace("&", "\\&")
        .replace("%", "\\%")
        .replace("_", "\\_")
        .replace("#", "\\#")
    )


def analyze(results: Path) -> dict:
    results = Path(results)
    catalog, config, merged, duplicates = load(results)
    profiles = ordered(config["profiles"])
    entries = {entry["case_id"]: entry for entry in catalog["cases"]}
    templates = {row["template_id"]: row for row in catalog["templates"]}
    expected_keys = [f"{profile}::{case_id}" for profile in profiles for case_id in entries]
    missing = [key for key in expected_keys if key not in merged]
    unknown = sorted(set(merged) - set(expected_keys))

    by_profile: dict[str, list[dict]] = defaultdict(list)
    for key in expected_keys:
        if key in merged:
            by_profile[merged[key]["profile"]].append(merged[key])

    # -- merged raw files ----------------------------------------------------------
    with open(results / "raw_results.jsonl", "w", encoding="utf-8") as stream:
        for key in expected_keys:
            if key in merged:
                stream.write(json.dumps(merged[key], sort_keys=True, ensure_ascii=False) + "\n")
    raw_fields = (
        "profile",
        "case_id",
        "kind",
        "template_id",
        "family",
        "package",
        "variant_id",
        "control_id",
        "outcome",
        "forbidden_boundary_reached",
        "completed",
        "fault_fired",
        "harness_problems",
        "refusal_source",
        "refusal_code",
        "refusal_check",
        "observed_component",
        "observed_stage",
        "expected_component",
        "expected_stage",
        "stage_match",
        "component_match",
        "code_match",
        "archive_sha256",
        "elapsed_ms",
    )
    with open(results / "raw_results.csv", "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(raw_fields))
        writer.writeheader()
        for key in expected_keys:
            record = merged.get(key)
            if record is None:
                continue
            refusal = record.get("refusal") or {}
            writer.writerow(
                {
                    **{field: record.get(field) for field in raw_fields},
                    "harness_problems": "|".join(record.get("harness_problems") or []),
                    "refusal_source": refusal.get("source"),
                    "refusal_code": refusal.get("code"),
                    "refusal_check": refusal.get("check"),
                }
            )

    # -- per profile -------------------------------------------------------------------
    summary_profiles = {}
    family_rows, template_rows = [], []
    for profile in profiles:
        rows = by_profile.get(profile, [])
        violations = [r for r in rows if r["kind"] == "violation"]
        controls = [r for r in rows if r["kind"] == "control"]
        controls_by_id = {r["case_id"]: r for r in controls}
        summary_profiles[profile] = {
            "label": LABELS.get(profile, profile),
            **metrics(violations, controls_by_id),
            **control_metrics(controls),
        }
        for family in sorted({r["family"] for r in rows}):
            for package in ("all", "meeting-agenda", "literature-review"):
                v = [
                    r
                    for r in violations
                    if r["family"] == family and package in ("all", r["package"])
                ]
                c = [
                    r
                    for r in controls
                    if r["family"] == family and package in ("all", r["package"])
                ]
                if not v and not c:
                    continue
                m, cm = metrics(v, controls_by_id), control_metrics(c)
                family_rows.append(
                    _row(
                        profile,
                        {"family": family, "family_name": FAMILY_NAMES[family], "package": package},
                        m,
                        cm,
                    )
                )
        for template_id in templates:
            v = [r for r in violations if r["template_id"] == template_id]
            c = [r for r in controls if r["template_id"] == template_id]
            if not v and not c:
                continue
            m, cm = metrics(v, controls_by_id), control_metrics(c)
            template_rows.append(
                _row(
                    profile,
                    {"template_id": template_id, "family": templates[template_id]["family"]},
                    m,
                    cm,
                )
            )

    summary = {
        "experiment_version": EXPERIMENT_VERSION,
        "threat_model_version": THREAT_MODEL_VERSION,
        "seed": config["seed"],
        "preset": config["preset"],
        "catalog_sha256": catalog["sha256"],
        "calibration_sha256": catalog.get("calibration_sha256"),
        "counts": {
            **catalog["counts"],
            "profiles": len(profiles),
            "expected_executions": len(expected_keys),
            "recorded_executions": len(expected_keys) - len(missing),
            "missing_executions": len(missing),
            "duplicate_records": len(duplicates),
            "unknown_records": len(unknown),
            "distinct_archives": len(
                {r.get("archive_sha256") for r in merged.values() if r.get("archive_sha256")}
            ),
        },
        "profiles": summary_profiles,
    }
    full_records = by_profile.get("full", [])
    summary["status"] = {
        "complete": not missing and not duplicates and not unknown,
        "full_silent_violations": sum(
            1 for r in full_records if r["kind"] == "violation" and r["outcome"] == SV
        ),
        "full_incidental_failures": sum(
            1 for r in full_records if r["kind"] == "violation" and r["outcome"] == IF
        ),
        "full_false_rejects": sum(
            1 for r in full_records if r["kind"] == "control" and r["outcome"] == FR
        ),
        "harness_errors_any_profile": sum(1 for r in merged.values() if r["outcome"] == HE),
    }

    # -- ablation effect on the guard each template names -----------------------------------
    effects = []
    for template_id, row in templates.items():
        ablation = row["most_relevant_ablation"]
        if ablation not in by_profile:
            continue
        base = Counter(
            r["outcome"]
            for r in by_profile.get("full", [])
            if r["template_id"] == template_id and r["kind"] == "violation"
        )
        ablated = Counter(
            r["outcome"]
            for r in by_profile[ablation]
            if r["template_id"] == template_id and r["kind"] == "violation"
        )
        effects.append(
            {
                "template_id": template_id,
                "ablation": ablation,
                "ablation_removes_guard": row.get("ablation_removes_guard", True),
                "full": dict(base),
                "ablated": dict(ablated),
                "silent_under_ablation": ablated.get(SV, 0),
                "blocked_under_ablation": ablated.get(EB, 0),
                "violations": sum(ablated.values()),
            }
        )
    summary["ablation_effects"] = effects

    _write_csv(results / "summary.csv", _summary_rows(summary_profiles))
    _write_csv(results / "family_summary.csv", family_rows)
    _write_csv(results / "template_summary.csv", template_rows)
    _write_csv(
        results / "ablation_matrix.csv",
        _family_matrix_rows(family_rows, summary_profiles, profiles),
    )
    _write_csv(results / "stage_summary.csv", _stage_rows(by_profile.get("full", [])))
    unexpected = _unexpected(by_profile, profiles, templates)
    unexpected["missing_executions"] = missing[:500]
    unexpected["duplicate_records"] = duplicates[:500]
    (results / "unexpected_cases.json").write_text(
        json.dumps(unexpected, indent=1, sort_keys=True) + "\n"
    )
    summary["unexpected_counts"] = {key: len(value) for key, value in unexpected.items()}

    _write_tables(results, summary, family_rows, template_rows, templates, profiles, by_profile)
    _write_csv(
        results / "template_ablation_matrix.csv", _ablation_rows(templates, by_profile, profiles)
    )
    _write_heatmap(results, family_rows, profiles)
    _write_manifest(results, summary, config, catalog)
    _write_timing(results, merged)
    summary["_full_explicit"] = [
        r for r in full_records if r["kind"] == "violation" and r["outcome"] == EB
    ]
    _write_report(results, summary, family_rows, templates, profiles, unexpected, effects)
    summary.pop("_full_explicit")
    (results / "summary.json").write_text(json.dumps(summary, indent=1, sort_keys=True) + "\n")
    return summary


def _row(profile, keys, m, cm) -> dict:
    return {
        "profile": profile,
        **keys,
        "violations": m["violations"],
        "explicit_block": m["violation_outcomes"][EB],
        "incidental_failure": m["violation_outcomes"][IF],
        "silent_violation": m["violation_outcomes"][SV],
        "violation_harness_error": m["violation_outcomes"][HE],
        "VDR": m["VDR"]["rate"],
        "VDR_ci_low": m["VDR"]["ci_low"],
        "VDR_ci_high": m["VDR"]["ci_high"],
        "SVR": m["SVR"]["rate"],
        "SVR_ci_low": m["SVR"]["ci_low"],
        "SVR_ci_high": m["SVR"]["ci_high"],
        "IFR": m["IFR"]["rate"],
        "PCC": m["PCC"]["rate"],
        "stage_accuracy": m["stage_accuracy"]["rate"],
        "controls": cm["controls"],
        "benign_accept": cm["control_outcomes"][BA],
        "false_reject": cm["control_outcomes"][FR],
        "control_harness_error": cm["control_outcomes"][HE],
        "BAR": cm["BAR"]["rate"],
        "BAR_ci_low": cm["BAR"]["ci_low"],
        "BAR_ci_high": cm["BAR"]["ci_high"],
    }


def _summary_rows(summary_profiles):
    rows = []
    base = (summary_profiles.get("full") or {}).get("VDR", {}).get("rate")
    for profile, m in summary_profiles.items():
        change = None if base is None or m["VDR"]["rate"] is None else m["VDR"]["rate"] - base
        rows.append(
            {
                "profile": profile,
                "label": m["label"],
                "VDR_change_vs_full": change,
                "violations": m["violations"],
                **{f"violations_{k.lower()}": v for k, v in m["violation_outcomes"].items()},
                "VDR": m["VDR"]["rate"],
                "VDR_ci_low": m["VDR"]["ci_low"],
                "VDR_ci_high": m["VDR"]["ci_high"],
                "SVR": m["SVR"]["rate"],
                "SVR_ci_low": m["SVR"]["ci_low"],
                "SVR_ci_high": m["SVR"]["ci_high"],
                "IFR": m["IFR"]["rate"],
                "IFR_ci_low": m["IFR"]["ci_low"],
                "IFR_ci_high": m["IFR"]["ci_high"],
                "PCC": m["PCC"]["rate"],
                "PCC_ci_low": m["PCC"]["ci_low"],
                "PCC_ci_high": m["PCC"]["ci_high"],
                "stage_accuracy": m["stage_accuracy"]["rate"],
                "component_accuracy": m["component_accuracy"]["rate"],
                "controls": m["controls"],
                "BAR": m["BAR"]["rate"],
                "BAR_ci_low": m["BAR"]["ci_low"],
                "BAR_ci_high": m["BAR"]["ci_high"],
                **{f"controls_{k.lower()}": v for k, v in m["control_outcomes"].items()},
            }
        )
    return rows


def _ablation_rows(templates, by_profile, profiles):
    """Template x profile outcome counts (template_ablation_matrix.csv)."""
    rows = []
    for template_id, row in templates.items():
        out = {
            "template_id": template_id,
            "family": row["family"],
            "most_relevant_ablation": row["most_relevant_ablation"],
            "ablation_removes_guard": row.get("ablation_removes_guard", True),
        }
        for profile in profiles:
            v = [
                r
                for r in by_profile.get(profile, [])
                if r["template_id"] == template_id and r["kind"] == "violation"
            ]
            counts = Counter(r["outcome"] for r in v)
            out[f"{profile}:n"] = len(v)
            out[f"{profile}:EB"] = counts.get(EB, 0)
            out[f"{profile}:IF"] = counts.get(IF, 0)
            out[f"{profile}:SV"] = counts.get(SV, 0)
            out[f"{profile}:HE"] = counts.get(HE, 0)
        rows.append(out)
    return rows


def _family_matrix_rows(family_rows, summary_profiles, profiles):
    """Family x profile VDR / SVR / IFR (ablation_matrix.csv): the central ablation result."""
    rows = []
    families = sorted({r["family"] for r in family_rows})
    for family in [*families, "All"]:
        out = {"family": family, "family_name": FAMILY_NAMES.get(family, "Overall")}
        for profile in profiles:
            if family == "All":
                m = summary_profiles.get(profile)
                values = (
                    (m["violations"], m["VDR"]["rate"], m["SVR"]["rate"], m["IFR"]["rate"])
                    if m
                    else (0, None, None, None)
                )
            else:
                row = next(
                    (
                        r
                        for r in family_rows
                        if r["profile"] == profile
                        and r["family"] == family
                        and r["package"] == "all"
                    ),
                    None,
                )
                values = (
                    (row["violations"], row["VDR"], row["SVR"], row["IFR"])
                    if row
                    else (0, None, None, None)
                )
            (
                out[f"{profile}:n"],
                out[f"{profile}:VDR"],
                out[f"{profile}:SVR"],
                out[f"{profile}:IFR"],
            ) = values
        rows.append(out)
    return rows


def _stage_rows(full_records):
    counts = Counter(
        (r["expected_stage"], r.get("observed_stage") or "none")
        for r in full_records
        if r["kind"] == "violation" and r["outcome"] == EB
    )
    return [
        {"expected_stage": e, "observed_stage": o, "count": n}
        for (e, o), n in sorted(counts.items())
    ]


def _brief(record: dict) -> dict:
    refusal = record.get("refusal") or {}
    return {
        "key": record["key"],
        "outcome": record["outcome"],
        "template_id": record["template_id"],
        "package": record["package"],
        "boundary_reached": record.get("forbidden_boundary_reached"),
        "refusal": {
            k: refusal.get(k) for k in ("source", "code", "component", "stage", "check", "step")
        },
        "expected_stage": record.get("expected_stage"),
        "harness_problems": record.get("harness_problems"),
        "evidence": record.get("evidence"),
    }


def _unexpected(by_profile, profiles, templates) -> dict:
    out = {
        "full_not_explicitly_blocked": [],
        "full_stage_mismatch": [],
        "controls_not_accepted": [],
        "harness_errors": [],
        "ablation_silent_violations": [],
    }
    for profile in profiles:
        for record in by_profile.get(profile, []):
            if record["outcome"] == HE:
                out["harness_errors"].append(_brief(record))
            elif record["kind"] == "control" and record["outcome"] != BA:
                out["controls_not_accepted"].append(_brief(record))
            elif record["kind"] == "violation" and profile == "full":
                if record["outcome"] != EB:
                    out["full_not_explicitly_blocked"].append(_brief(record))
                elif record.get("stage_match") is False:
                    out["full_stage_mismatch"].append(_brief(record))
            elif record["kind"] == "violation" and record["outcome"] == SV:
                brief = _brief(record)
                brief.pop("evidence", None)
                out["ablation_silent_violations"].append(brief)
    return out


def _write_csv(path: Path, rows: list[dict]) -> None:
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with open(path, "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields or ["empty"])
        writer.writeheader()
        writer.writerows(rows)


def _write_tables(results, summary, family_rows, template_rows, templates, profiles, by_profile):
    header = [
        "% Generated by experiments/contract_enforcement/analyze.py -- do not edit by hand.",
        f"% catalog {summary['catalog_sha256'][:16]}, seed {summary['seed']}, preset "
        f"{summary['preset']}",
    ]
    full_family = [r for r in family_rows if r["profile"] == "full" and r["package"] == "all"]
    full = summary["profiles"].get("full")
    lines = [
        *header,
        "\\begin{tabular}{lrrrr}",
        "\\toprule",
        "Violation family & \\#viol. & VDR (\\%) & BAR (\\%) & SVR (\\%) \\\\",
        "\\midrule",
    ]
    for row in full_family:
        lines.append(
            f"{tex(row['family_name'])} & {row['violations']} & {_pct(row['VDR'])} & "
            f"{_pct(row['BAR'])} & {_pct(row['SVR'])} \\\\"
        )
    if full:
        lines += [
            "\\midrule",
            f"Overall & {full['violations']} & {_pct(full['VDR']['rate'])} & "
            f"{_pct(full['BAR']['rate'])} & {_pct(full['SVR']['rate'])} \\\\",
        ]
    lines += ["\\bottomrule", "\\end{tabular}", ""]
    (results / "paper_main_table.tex").write_text("\n".join(lines))

    families = sorted({r["family"] for r in family_rows})
    columns = "l" + "r" * len(profiles)
    lines = [
        *header,
        "% (a) Explicit-block rate (VDR, %) of each family's violations under each profile.",
        f"\\begin{{tabular}}{{{columns}}}",
        "\\toprule",
        "Family & " + " & ".join(tex(LABELS.get(p, p)) for p in profiles) + " \\\\",
        "\\midrule",
    ]
    for family in families:
        cells = []
        for profile in profiles:
            row = next(
                (
                    r
                    for r in family_rows
                    if r["profile"] == profile and r["family"] == family and r["package"] == "all"
                ),
                None,
            )
            cells.append(_pct(row["VDR"]) if row else "--")
        lines.append(f"{tex(FAMILY_NAMES[family])} & " + " & ".join(cells) + " \\\\")
    lines.append("\\midrule")
    lines.append(
        "Overall & "
        + " & ".join(
            _pct((summary["profiles"].get(p) or {}).get("VDR", {}).get("rate")) for p in profiles
        )
        + " \\\\"
    )
    lines += [
        "\\bottomrule",
        "\\end{tabular}",
        "",
        "% (b) Component summary.",
        "\\begin{tabular}{lrrrr}",
        "\\toprule",
        "Removed component & VDR (\\%) & $\\Delta$ vs Full (pp) & SVR (\\%) & BAR (\\%) \\\\",
        "\\midrule",
    ]
    base = (full or {}).get("VDR", {}).get("rate")
    for profile in profiles:
        m = summary["profiles"].get(profile)
        if not m:
            continue
        delta = (
            "--"
            if base is None or m["VDR"]["rate"] is None or profile == "full"
            else f"{100 * (m['VDR']['rate'] - base):+.1f}"
        )
        name = (
            "None (full system)" if profile == "full" else LABELS.get(profile, profile).lstrip("-")
        )
        lines.append(
            f"{tex(name)} & {_pct(m['VDR']['rate'])} & {delta} & {_pct(m['SVR']['rate'])} & "
            f"{_pct(m['BAR']['rate'])} \\\\"
        )
    lines += ["\\bottomrule", "\\end{tabular}", ""]
    (results / "paper_ablation_table.tex").write_text("\n".join(lines))

    lines = [
        *header,
        "\\begin{tabular}{lllr}",
        "\\toprule",
        "Family & Perturbation & Primary guard & \\#viol. \\\\",
        "\\midrule",
    ]
    for template_id, row in templates.items():
        full_rows = [
            r for r in template_rows if r["profile"] == "full" and r["template_id"] == template_id
        ]
        count = full_rows[0]["violations"] if full_rows else 0
        lines.append(
            f"{tex(FAMILY_NAMES[row['family']])} & {tex(row.get('perturbation', template_id))} & "
            f"{tex(row.get('primary_guard', ''))} & {count} \\\\"
        )
    lines += ["\\bottomrule", "\\end{tabular}", ""]
    (results / "paper_case_table.tex").write_text("\n".join(lines))


def _pct(value) -> str:
    return "--" if value is None else f"{100 * value:.1f}"


def _pct_ci(row, key) -> str:
    if row[key] is None:
        return "--"
    low, high = row[key + "_ci_low"], row[key + "_ci_high"]
    return f"{100 * row[key]:.1f} [{100 * low:.1f}, {100 * high:.1f}]"


def _pct_ci_entry(entry) -> str:
    if entry["rate"] is None:
        return "--"
    return f"{100 * entry['rate']:.1f} [{100 * entry['ci_low']:.1f}, {100 * entry['ci_high']:.1f}]"


def _write_heatmap(results, family_rows, profiles):
    families = sorted({r["family"] for r in family_rows})
    if not families:
        return
    cell, left, top = 64, 190, 40
    width, height = left + cell * len(families) + 20, top + cell * len(profiles) + 40
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        'font-family="Helvetica, Arial, sans-serif" font-size="12">',
        f'<text x="{left}" y="20">'
        "Explicit-block rate of each family's violations, per profile</text>",
    ]
    for j, family in enumerate(families):
        parts.append(
            f'<text x="{left + j * cell + cell / 2}" y="{top - 6}" '
            f'text-anchor="middle">{family}</text>'
        )
    for i, profile in enumerate(profiles):
        y = top + i * cell
        parts.append(
            f'<text x="{left - 8}" y="{y + cell / 2 + 4}" '
            f'text-anchor="end">{LABELS.get(profile, profile)}</text>'
        )
        for j, family in enumerate(families):
            row = next(
                (
                    r
                    for r in family_rows
                    if r["profile"] == profile and r["family"] == family and r["package"] == "all"
                ),
                None,
            )
            value = row["VDR"] if row else None
            if value is None:
                color, label = "#eeeeee", "--"
            else:
                shade = int(255 * value)
                color, label = (
                    f"rgb({255 - shade // 2},{80 + int(175 * value)},{255 - shade})",
                    f"{100 * value:.0f}",
                )
            parts.append(
                f'<rect x="{left + j * cell}" y="{y}" width="{cell - 2}" '
                f'height="{cell - 2}" fill="{color}"/>'
            )
            parts.append(
                f'<text x="{left + j * cell + cell / 2 - 1}" y="{y + cell / 2 + 4}" '
                f'text-anchor="middle">{label}</text>'
            )
    parts.append("</svg>")
    (results / "ablation_heatmap.svg").write_text("\n".join(parts) + "\n")


def _write_manifest(results, summary, config, catalog):
    """Verify the manifest frozen before execution; write one only if none exists (e.g. tests)."""
    import hashlib

    path = results / "paper_manifest.json"
    if path.exists():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        expected = config.get("manifest_sha256")
        summary["manifest"] = {
            "sha256": digest,
            "verified": expected is not None and digest == expected,
        }
        return
    manifest = {
        "experiment": "contract_enforcement",
        "experiment_version": EXPERIMENT_VERSION,
        "threat_model_version": THREAT_MODEL_VERSION,
        "seed": config["seed"],
        "preset": config["preset"],
        "profiles": config["profiles"],
        "catalog_sha256": catalog["sha256"],
        "calibration_sha256": catalog.get("calibration_sha256"),
        "expected_executions": summary["counts"]["expected_executions"],
        "written_by": "analyze (no frozen manifest was present)",
    }
    data = (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode()
    path.write_bytes(data)
    summary["manifest"] = {"sha256": hashlib.sha256(data).hexdigest(), "verified": False}


def _write_timing(results, merged):
    by_profile = defaultdict(list)
    for record in merged.values():
        if isinstance(record.get("elapsed_ms"), (int, float)):
            by_profile[record["profile"]].append(record["elapsed_ms"])
    timing = {
        profile: {
            "n": len(values),
            "median_ms": statistics.median(values),
            "p95_ms": sorted(values)[max(0, math.ceil(0.95 * len(values)) - 1)],
            "max_ms": max(values),
            "total_s": sum(values) / 1000,
        }
        for profile, values in by_profile.items()
        if values
    }
    (results / "timing_summary.json").write_text(
        json.dumps(timing, indent=1, sort_keys=True) + "\n"
    )


def headline(summary: dict) -> str:
    full = summary["profiles"].get("full")
    if not full:
        return "no full-profile records"
    v, c = full["violation_outcomes"], full["control_outcomes"]
    return (
        f"full system: {v[EB]}/{full['violations']} violations explicitly blocked (VDR "
        f"{fmt_ci(full['VDR'])}%), "
        f"{v[SV]} silent, {v[IF]} incidental, {v[HE]} harness errors; controls "
        f"{c[BA]}/{full['controls']} "
        f"accepted (BAR {fmt_ci(full['BAR'])}%), {c[FR]} false rejects, {c[HE]} harness errors"
    )


def _write_report(results, summary, family_rows, templates, profiles, unexpected, effects):
    full = summary["profiles"].get("full", {})
    counts = summary["counts"]
    lines = [
        "# Contract-enforcement experiment",
        "",
        f"Preset `{summary['preset']}`, seed `{summary['seed']}`, experiment "
        f"{summary['experiment_version']}, "
        f"threat model {summary['threat_model_version']}. Catalog "
        f"`{summary['catalog_sha256'][:16]}`, "
        f"calibration `{(summary['calibration_sha256'] or '')[:16]}`.",
        "",
        f"* {counts['templates']} templates in {counts['families']} families, "
        f"{counts['violations']} distinct violations, {counts['controls']} matched benign "
        "controls, "
        f"{counts['profiles']} enforcement profiles.",
        f"* Executions: {counts['recorded_executions']} recorded of "
        f"{counts['expected_executions']} expected "
        f"({counts['missing_executions']} missing, {counts['duplicate_records']} duplicate "
        "records).",
        "",
        "## Full system",
        "",
    ]
    if full:
        lines += [
            "| Metric | Value (95% Wilson CI) |",
            "|---|---|",
            f"| Violation detection rate (explicit block) | {fmt_ci(full['VDR'])}% "
            f"({full['VDR']['k']}/{full['VDR']['n']}) |",
            f"| Silent violation rate | {fmt_ci(full['SVR'])}% "
            f"({full['SVR']['k']}/{full['SVR']['n']}) |",
            f"| Incidental failure rate | {fmt_ci(full['IFR'])}% "
            f"({full['IFR']['k']}/{full['IFR']['n']}) |",
            f"| Benign acceptance rate | {fmt_ci(full['BAR'])}% "
            f"({full['BAR']['k']}/{full['BAR']['n']}) |",
            f"| Paired contract correctness | {fmt_ci(full['PCC'])}% "
            f"({full['PCC']['k']}/{full['PCC']['n']}) |",
            f"| Stage accuracy (explicit blocks) | {fmt_ci(full['stage_accuracy'])}% |",
            f"| Harness errors | {full['violation_outcomes'][HE]} violations, "
            f"{full['control_outcomes'][HE]} controls |",
            "",
            "| Family | Violations | Blocked | Incidental | Silent | VDR % [CI] | Controls | BAR "
            "% |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for row in family_rows:
            if row["profile"] == "full" and row["package"] == "all":
                lines.append(
                    f"| {row['family']} {row['family_name']} | {row['violations']} | "
                    f"{row['explicit_block']} | "
                    f"{row['incidental_failure']} | {row['silent_violation']} | "
                    f"{_pct_ci(row, 'VDR')} | {row['controls']} | {_pct(row['BAR'])} |"
                )
    lines += [
        "",
        "## Ablations",
        "",
        "| Profile | VDR % [CI] | SVR % [CI] | IFR % | BAR % | False rejects |",
        "|---|---|---|---|---|---|",
    ]
    for profile in profiles:
        m = summary["profiles"].get(profile)
        if not m:
            continue
        lines.append(
            f"| {m['label']} | {fmt_ci(m['VDR'])} | {fmt_ci(m['SVR'])} | {fmt(m['IFR'])} | "
            f"{fmt(m['BAR'])} | {m['control_outcomes'][FR]} |"
        )
    lines += [
        "",
        "### Effect of each template's most relevant ablation",
        "",
        "| Template | Ablation | Full outcomes | Ablated outcomes |",
        "|---|---|---|---|",
    ]
    for effect in effects:
        lines.append(
            f"| {effect['template_id']} | {LABELS.get(effect['ablation'], effect['ablation'])} | "
            f"{_counts(effect['full'])} | {_counts(effect['ablated'])} |"
        )
    lines += ["", "## Unexpected outcomes", ""]
    for key, value in unexpected.items():
        lines.append(f"* `{key}`: {len(value)}")
    lines += ["", "See `unexpected_cases.json` for each one, with its evidence.", ""]
    lines += ["## Paper-ready interpretation", ""]
    lines += _interpretation(summary, family_rows, effects)
    (results / "report.md").write_text("\n".join(lines) + "\n")


def _counts(counter: dict) -> str:
    return (
        ", ".join(f"{key.split('_')[0].lower()} {value}" for key, value in sorted(counter.items()))
        or "--"
    )


def _interpretation(summary, family_rows, effects) -> list[str]:
    """The nine questions the paper's RQ1 section asks, answered from the records only."""
    full = summary["profiles"].get("full")
    status = summary["status"]
    counts = summary["counts"]
    if not full:
        return ["No full-profile records; nothing can be interpreted."]
    lines = []
    if not status["complete"]:
        lines.append(
            f"**Incomplete run** ({counts['missing_executions']} executions missing): every "
            "number below is "
            "provisional and must not be reported."
        )
    if status["harness_errors_any_profile"]:
        lines.append(
            f"**{status['harness_errors_any_profile']} harness errors** were recorded; a paper "
            "run requires "
            "zero. They are not counted as detections."
        )
    v, c = full["violation_outcomes"], full["control_outcomes"]
    stages = Counter(
        row["observed_stage"]
        for row in summary.get("_full_explicit", [])
        if row.get("observed_stage")
    )
    stage_text = ", ".join(f"{stage} ({n})" for stage, n in stages.most_common()) or "none"
    base = full["VDR"]["rate"] or 0.0
    drops = []
    for profile, m in summary["profiles"].items():
        if profile != "full" and m["VDR"]["rate"] is not None:
            drops.append((base - m["VDR"]["rate"], profile, m))
    drops.sort(reverse=True)
    largest = "; ".join(
        f"{m['label']}: VDR {fmt(m['VDR'])}% ({-100 * drop:+.1f} pp vs full), SVR {fmt(m['SVR'])}%"
        for drop, profile, m in drops[:3]
    )
    retained = [e for e in effects if e["violations"] and e["blocked_under_ablation"]]
    by_design = [e["template_id"] for e in retained if e.get("ablation_removes_guard") is False]
    layered = [
        f"{e['template_id']} ({e['blocked_under_ablation']}/{e['violations']} under "
        f"{LABELS.get(e['ablation'], e['ablation'])})"
        for e in retained
        if e.get("ablation_removes_guard") is not False
    ]
    lines += [
        f"1. **Templates.** {counts['templates']} violation templates in {counts['families']} "
        "families.",
        f"2. **Distinct violations.** {counts['violations']}.",
        f"3. **Matched benign controls.** {counts['controls']}.",
        f"4. **Full system.** VDR {fmt_ci(full['VDR'])}% ({v[EB]}/{full['violations']}), BAR "
        f"{fmt_ci(full['BAR'])}% ({c[BA]}/{full['controls']}), SVR {fmt_ci(full['SVR'])}% "
        f"({v[SV]}/{full['violations']}); paired contract correctness {fmt_ci(full['PCC'])}%.",
        f"5. **Where violations were blocked.** {stage_text}; {fmt(full['stage_accuracy'])}% of "
        "explicit blocks "
        "happened at the stage the catalog predicted before the run.",
        f"6. **Largest reductions in protection.** {largest or 'no ablation profile was run'}.",
        "7. **Defense in depth.** "
        + (
            "Violations still explicitly blocked under their own most relevant ablation: "
            f"{', '.join(layered)}."
            if layered
            else (
                "No template stayed blocked under its own most relevant ablation "
                "through another layer."
            )
        )
        + (
            " Guards no profile removes by design (container parsing, static workflow "
            "validation, JSON "
            f"parsing): {', '.join(by_design)}."
            if by_design
            else ""
        ),
        f"8. **Incidental failures.** {v[IF]} full-system violations stopped without an explicit "
        "contract refusal.",
        f"9. **Full-system silent violations.** {v[SV]}"
        + (
            " — each is listed in `unexpected_cases.json` and must be classified before any "
            "number is reported."
            if v[SV]
            else "."
        ),
        "",
        f"Finite claim: in this controlled suite, WebAgents explicitly blocked {v[EB]} of the "
        f"{full['violations']} injected violations and accepted {c[BA]} of the {full['controls']} "
        "matched "
        "benign controls. This is not a measure of security against an arbitrary attacker, of "
        "model reasoning "
        "quality, or of behaviour on other hosts.",
    ]
    return lines


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: analyze.py <results-dir>")
    out = analyze(Path(sys.argv[1]))
    print(headline(out))
