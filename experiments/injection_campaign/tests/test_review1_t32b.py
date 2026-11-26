"""T32b review 1: finding 3 (`--sides-from` on a pooled series of several rungs) and nits 6-8 (the
arm check scoped to its own pairing, a `--supersede-side` that names nothing, the catalog compared
file by file, the tree's task sets checked)."""

from __future__ import annotations

import json

import analyze
import pytest
from test_analyze import MANIFEST, _run, _units

RUNGS = {
    "L4": {"model": "qwen3.5:4b", "ollama_digest": "d4"},
    "L9": {"model": "qwen3.5:9b", "ollama_digest": "d9"},
}
FILES = {
    "F-ACTION/action-01.json": "h-action",
    "F-TERMINATE/terminate-01.json": "h-terminate",
}
SERIES = {
    **MANIFEST,
    "rungs": RUNGS,
    "preset": "paper",
    "payloads": {"sha256": "whole-1", "files": FILES},
}
LATER = {**SERIES, "commit": "later", "protocol": {"sha256": "q", "version": 6}}


def _arms(root, side, rung, *, tasks=range(1, 5)):
    for i in tasks:
        common = {
            "task": f"W1-{i:02d}",
            "phrasing": 0,
            "family": "F-ACTION",
            "payload": "action-01",
            "placement": "search.fare_name",
            "rung": rung,
        }
        _run(root, side=side, arm="injected", exposed=True, **common)
        _run(root, side=side, arm="twin", exposed=True, **common)
    _run(root, side=side, task="W1-01", phrasing=1, rung=rung)


def _directory(path, manifest, sides, rung, **kw):
    path.mkdir()
    (path / "manifest.json").write_text(json.dumps(manifest))
    for side in sides:
        _arms(path, side, rung, **kw)
    _units(path)
    return path


@pytest.fixture
def pooled(tmp_path):
    """A series of two rungs, one directory each, as T32's L4 and L9."""
    return [
        _directory(
            tmp_path / f"2026-11-15T00-00-00Z_paper-{r}", SERIES, ("Py", "Cr", "FW"), r
        )
        for r in ("L4", "L9")
    ]


def _sides(tmp_path, rung, name="sides", manifest=LATER, sides=("FW-none",), **kw):
    return _directory(
        tmp_path / f"2026-11-22T00-00-00Z_{name}-{rung}", manifest, sides, rung, **kw
    )


def test_f3_the_same_sides_join_every_rung_of_a_pooled_series(pooled, tmp_path):
    l9, l4 = _sides(tmp_path, "L9"), _sides(tmp_path, "L4")
    data = analyze.tables(pooled, sides_from=[l9, l4], resamples=50)
    assert data["tab4_e3"]["F-ACTION|FW-none|L4"]["n"] == 4
    assert data["tab4_e3"]["F-ACTION|FW-none|L9"]["n"] == 4
    again = _sides(tmp_path, "L9", name="again")  # the same side on the same rung twice
    with pytest.raises(SystemExit, match="already in the series"):
        analyze.tables(pooled, sides_from=[l9, l4, again], resamples=50)


def test_nit6_a_short_directory_elsewhere_does_not_skip_this_rungs_arm_check(tmp_path):
    l4 = _directory(
        tmp_path / "2026-11-15T00-00-00Z_paper-L4", SERIES, ("Py", "Cr", "FW"), "L4"
    )
    l9 = _directory(
        tmp_path / "2026-11-15T00-00-00Z_paper-L9", SERIES, ("Py", "Cr", "FW"), "L9"
    )
    units = json.loads((l4 / "units.json").read_text())
    (l4 / "units.json").write_text(
        json.dumps(units + [{"id": "never-ran"}])
    )  # L4 is short
    fewer = _sides(tmp_path, "L9", tasks=range(1, 4))  # L9's sides miss one arm pair
    with pytest.raises(SystemExit, match="holds 7 arms, not the series' 9"):
        analyze.tables(
            [l4, l9], sides_from=[fewer], allow_incomplete=True, resamples=20
        )


def test_nit7_a_supersede_side_that_removes_no_unit_is_refused(pooled, tmp_path):
    l9 = _sides(tmp_path, "L9")
    with pytest.raises(SystemExit, match="removed no unit"):
        analyze.tables(
            pooled,
            sides_from=[l9],
            supersede_sides=[f"{l9}:FW-detector"],  # no such side in that directory
            resamples=20,
        )
    with pytest.raises(SystemExit, match="removed no unit"):
        analyze.tables(
            pooled, sides_from=[l9], supersede_sides=["typo-dir:FW-none"], resamples=20
        )


def test_nit8_the_catalog_pairs_by_the_files_the_runs_used(pooled, tmp_path):
    grown = {  # another family's payload changed and one was added: the whole digest differs
        **LATER,
        "payloads": {
            "sha256": "whole-2",
            "files": {
                **FILES,
                "F-TERMINATE/terminate-01.json": "h-new",
                "F-PEER/p.json": "z",
            },
        },
    }
    l9 = _sides(tmp_path, "L9", manifest=grown)
    data = analyze.tables(pooled, sides_from=[l9], resamples=20)
    assert data["tab4_e3"]["F-ACTION|FW-none|L9"]["n"] == 4
    changed = {
        **LATER,
        "payloads": {
            "sha256": "whole-3",
            "files": {**FILES, "F-ACTION/action-01.json": "edited"},
        },
    }
    other = _sides(tmp_path, "L9", name="edited", manifest=changed)
    with pytest.raises(
        SystemExit, match="payload files differ: F-ACTION/action-01.json"
    ):
        analyze.tables(pooled, sides_from=[other], resamples=20)


def test_nit8_the_trees_task_sets_must_be_the_series(tmp_path):
    old = {**SERIES, "task_sets": {"ts-w.json": "an-earlier-ts-w"}}
    series = _directory(tmp_path / "2026-11-15T00-00-00Z_paper-L9", old, ("Py",), "L9")
    with pytest.raises(SystemExit, match="ts-w.json is not the series'"):
        analyze.tables([series], resamples=20)
