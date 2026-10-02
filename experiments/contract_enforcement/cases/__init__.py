"""The case catalog: every template, and the deterministic generation of its variants.

`generate(seed, preset, calibration)` returns the catalog for one experiment:
one entry per distinct violation and one per distinct matched control. It is a
pure function of its arguments (and of the shipped artifacts), so the same
seed, preset and calibration always produce byte-identical catalogs; the
catalog hash is recorded in `config.json` and checked on `--resume`.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from . import (
    f1_verification,
    f2_trust,
    f3_authorization,
    f4_compatibility,
    f5_revalidation,
    f6_mediation,
    f7_output,
    f8_resources,
)
from .base import FAMILIES, Env, Template, Variant, rng_for

TEMPLATES: tuple[Template, ...] = (
    *f1_verification.TEMPLATES,
    *f2_trust.TEMPLATES,
    *f3_authorization.TEMPLATES,
    *f4_compatibility.TEMPLATES,
    *f5_revalidation.TEMPLATES,
    *f6_mediation.TEMPLATES,
    *f7_output.TEMPLATES,
    *f8_resources.TEMPLATES,
)
BY_ID = {template.template_id: template for template in TEMPLATES}


@dataclass(frozen=True)
class Preset:
    name: str
    # Variants a parametric template generates per package.
    budget: int
    # At most this many variants per (template, package); None keeps all.
    limit: int | None
    profiles: tuple[str, ...]
    description: str


ALL_PROFILES = (
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
PRESETS = {
    "smoke": Preset(
        "smoke",
        budget=1,
        limit=1,
        profiles=("full",),
        description="One variant per template and package, full system only: does every path run?",
    ),
    "qualification": Preset(
        "qualification",
        budget=3,
        limit=3,
        profiles=ALL_PROFILES,
        description="Up to three variants per template and package, every profile.",
    ),
    "paper": Preset(
        "paper",
        budget=12,
        limit=None,
        profiles=ALL_PROFILES,
        description="Every finite variant and twelve parametric variants per template and package, "
        "every profile.",
    ),
}


class CatalogError(RuntimeError):
    pass


def _pick(variants: list[Variant], limit: int | None, rng) -> list[Variant]:
    """A deterministic, order-preserving sample (the whole list when it fits)."""
    if limit is None or len(variants) <= limit:
        return list(variants)
    keep = sorted(rng.sample(range(len(variants)), limit))
    return [variants[index] for index in keep]


def _variant_fields(variant: Variant) -> dict:
    return {
        "template_id": variant.template_id,
        "package": variant.package,
        "variant_id": variant.variant_id,
        "params": variant.params,
        "description": variant.description,
        "control_key": variant.control_key,
        "control_params": variant.control_params,
        "control_description": variant.control_description,
    }


def variant_of(fields: dict) -> Variant:
    return Variant(
        fields["template_id"],
        fields["package"],
        fields["variant_id"],
        fields["params"],
        fields["description"],
        fields["control_key"],
        fields["control_params"],
        fields["control_description"],
    )


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def generate(seed: int, preset: str | Preset, calibration: dict | None, *, templates=None) -> dict:
    preset = PRESETS[preset] if isinstance(preset, str) else preset
    env = Env(seed, calibration=calibration)
    templates = tuple(templates) if templates is not None else TEMPLATES
    violations: list[dict] = []
    controls: dict[str, dict] = {}
    seen_params: dict[tuple, str] = {}
    per_template: dict[str, dict] = {}
    for template in templates:
        row = template.catalog_row()
        counts = per_template.setdefault(
            template.template_id, {"violations": 0, "controls": set(), "generated": 0, **row}
        )
        for package in template.packages:
            rng = rng_for(seed, template.template_id, package)
            generated = template.variants(package, env, rng, preset.budget)
            counts["generated"] += len(generated)
            chosen = _pick(
                generated, preset.limit, rng_for(seed, template.template_id + "#pick", package)
            )
            for variant in chosen:
                identity = (template.template_id, package, _canonical(variant.params))
                if identity in seen_params:
                    raise CatalogError(f"{variant.case_id} duplicates {seen_params[identity]}")
                seen_params[identity] = variant.case_id
                violations.append(
                    {
                        "case_id": variant.case_id,
                        "kind": "violation",
                        "control_id": variant.control_id,
                        **_variant_fields(variant),
                    }
                )
                counts["violations"] += 1
                counts["controls"].add(variant.control_id)
                if variant.control_id not in controls:
                    controls[variant.control_id] = {
                        "case_id": variant.control_id,
                        "kind": "control",
                        "control_id": variant.control_id,
                        # The first violation that names this control; its plan builds the control.
                        "representative": variant.case_id,
                        **_variant_fields(variant),
                        "description": variant.control_description,
                    }
    ids = [entry["case_id"] for entry in violations] + list(controls)
    if len(ids) != len(set(ids)):
        raise CatalogError("case ids are not unique")
    templates_rows = []
    for template_id, counts in per_template.items():
        templates_rows.append(
            {
                **{key: value for key, value in counts.items() if key not in ("controls",)},
                "matched_controls": len(counts["controls"]),
            }
        )
    entries = violations + list(controls.values())
    body = {
        "seed": seed,
        "preset": preset.name,
        "calibration_sha256": (calibration or {}).get("sha256"),
        "templates": templates_rows,
        "cases": entries,
    }
    catalog = {
        **body,
        "counts": {
            "templates": len(templates_rows),
            "families": len({row["family"] for row in templates_rows}),
            "violations": len(violations),
            "controls": len(controls),
            "packages": sorted({entry["package"] for entry in entries}),
        },
        "sha256": hashlib.sha256(_canonical(body).encode()).hexdigest(),
    }
    return catalog


def entry_plan(entry: dict, env: Env):
    """(CasePlan, boundary) for one catalog entry."""
    template = BY_ID[entry["template_id"]]
    variant = variant_of(entry)
    return template.plan(variant, entry["kind"], env), template


CSV_FIELDS = (
    "case_id",
    "kind",
    "template_id",
    "family",
    "family_name",
    "package",
    "variant_id",
    "description",
    "violated_assumption",
    "expected_component",
    "expected_stage",
    "expected_codes",
    "forbidden_boundary",
    "matched_control",
    "control_id",
    "template_kind",
    "most_relevant_ablation",
    "params",
)


def csv_rows(catalog: dict):
    rows = {row["template_id"]: row for row in catalog["templates"]}
    for entry in catalog["cases"]:
        row = rows[entry["template_id"]]
        yield {
            "case_id": entry["case_id"],
            "kind": entry["kind"],
            "template_id": entry["template_id"],
            "family": row["family"],
            "family_name": FAMILIES[row["family"]],
            "package": entry["package"],
            "variant_id": entry["variant_id"],
            "description": entry["description"],
            "violated_assumption": row["violated_assumption"],
            "expected_component": row["expected_component"],
            "expected_stage": row["expected_stage"],
            "expected_codes": "|".join(row["expected_codes"]),
            "forbidden_boundary": row["forbidden_boundary"],
            "matched_control": entry.get("control_description") or row["matched_control"],
            "control_id": entry["control_id"],
            "template_kind": row["template_kind"],
            "most_relevant_ablation": row["most_relevant_ablation"],
            "params": _canonical(
                entry["params"] if entry["kind"] == "violation" else entry["control_params"]
            ),
        }


__all__ = [
    "BY_ID",
    "PRESETS",
    "TEMPLATES",
    "CatalogError",
    "csv_rows",
    "entry_plan",
    "generate",
    "variant_of",
]
