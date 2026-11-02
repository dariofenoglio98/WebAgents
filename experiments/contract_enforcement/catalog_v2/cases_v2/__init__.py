"""Catalog v2: the four families and the parametric templates (D-300).

`finite_cases()` is every case of the four families, in family order; `parametric_cases(seed, n)`
draws `n` values per template from the seed (`parametric.py`); `catalog(preset, seed)` is what a
preset runs. Case ids are unique and stable; the catalog hash covers every field a case declares.
"""

from __future__ import annotations

from .base import FAMILIES, Case, catalog_hash

PRESETS = {
    # per family: the first N violations and the first control, in catalog order (a stratified,
    # deterministic subset); one parametric value per template.
    "smoke": {"per_template": 1, "subset": {"violations": 2, "controls": 1}},
    "qualification": {"per_template": 3, "subset": None},
    "paper": {"per_template": 6, "subset": None},
}


def finite_cases() -> list[Case]:
    from . import compute, conversation, memory, network

    out = [*memory.cases(), *compute.cases(), *conversation.cases(), *network.cases()]
    ids = [case.id for case in out]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate case ids")
    return out


def parametric_cases(seed: int, per_template: int) -> list[Case]:
    from .parametric import cases

    return cases(seed, per_template)


SMOKE_PICKS = {
    "M": ["M.n11-sealed-value-to-a-model", "M.m36-sealed-value-to-a-tool", "M.fixture"],
    "C": ["C.module-import", "C.deadline", "C.echo"],
    "V": ["V.tool-after-denied-consent", "V.turn-beyond-cap", "V.two-turns-one-consent"],
    "N": ["N.hops-exhausted", "N.reservation-refused", "N.fixture-walk"],
}


def catalog(preset: str, seed: int) -> list[Case]:
    spec = PRESETS[preset]
    finite = finite_cases()
    if spec["subset"] is not None:
        by_id = {case.id: case for case in finite}
        finite = [by_id[cid] for family in FAMILIES for cid in SMOKE_PICKS[family]]
    return [*finite, *parametric_cases(seed, spec["per_template"])]


__all__ = ["FAMILIES", "PRESETS", "Case", "catalog", "catalog_hash", "finite_cases"]
