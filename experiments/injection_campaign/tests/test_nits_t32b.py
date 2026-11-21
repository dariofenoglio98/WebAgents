"""T32 review 3's analysis nits (a), (b), (e) and (g) (D-427)."""

from __future__ import annotations

import json

import analyze
import pytest
from test_analyze import MANIFEST, _memory_runs, _run, _supplement, _units


def _redirect_and_search(root):
    for i in range(3):
        for placement in ("redirect.search_302", "search.fare_name"):
            common = {
                "task": f"W1-{i:02d}",
                "phrasing": 0,
                "family": "F-REDIRECT"
                if placement.startswith("redirect")
                else "F-UPLOAD",
                "payload": "redirect-01"
                if placement.startswith("redirect")
                else "upload-01",
                "placement": placement,
            }
            _run(root, side="Py", arm="injected", exposed=True, **common)
            _run(root, side="Py", arm="twin", exposed=True, **common)


def test_nit_a_a_placement_that_serves_no_text_is_na_in_the_reach_and_out_of_the_pooled_rate(
    tmp_path, monkeypatch
):
    root = tmp_path / "2026-11-06T00-00-00Z_paper-L9"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps(MANIFEST))
    _redirect_and_search(root)
    _units(root)
    monkeypatch.setattr(
        analyze, "payload_texts", lambda m: {"upload-01": "UPLOAD", "redirect-01": "R"}
    )
    monkeypatch.setattr(analyze, "in_model_request", lambda rec, text: True)
    data = analyze.tables([root], resamples=20)
    assert data["tab4_e3"]["F-REDIRECT|Py|L9"]["in_model_request"] == "n/a"
    pooled = data["tab4_e3"]["all eight families|Py|L9"]["in_model_request"]
    assert (pooled["k"], pooled["n"]) == (3, 3)  # the three redirect runs left out
    reach = [
        x
        for x in analyze.render(data).splitlines()
        if x.startswith("F-REDIRECT|Py|L9 |") and len(x.split(" | ")) == 4
    ]
    assert reach and reach[0].endswith("| n/a")


def test_nit_b_a_shortfall_elsewhere_does_not_skip_a_supplements_check(tmp_path):
    root = tmp_path / "2026-11-06T00-00-00Z_paper-L9"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps(MANIFEST))
    _memory_runs(root, exposed=False)
    _units(root)
    other = tmp_path / "2026-11-06T00-00-00Z_paper-L4"
    other.mkdir()
    (other / "manifest.json").write_text(json.dumps(MANIFEST))
    _run(other, side="Py", task="W1-01", phrasing=0, rung="L4")
    _run(other, side="Py", task="W1-02", phrasing=0, rung="L4")
    _units(other)
    (
        min((other / "runs").iterdir()) / "outcome.json"
    ).unlink()  # a shortfall on L4 only
    with pytest.raises(SystemExit, match="the series has 4"):
        analyze.tables(
            [root, other],
            supplements=[_supplement(tmp_path / "s", count=3)],
            allow_incomplete=True,
        )


def test_nit_e_seconds_leave_out_the_waits_on_429s_and_the_runs_that_waited_are_counted(
    tmp_path,
):
    root = tmp_path / "2026-11-06T00-00-00Z_paper-L9"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps(MANIFEST))
    _run(
        root,
        side="Py",
        task="W1-01",
        phrasing=0,
        model_calls=[{"rate_limit_waits": [2.0]}],
    )
    _run(root, side="FW", task="W1-01", phrasing=0)
    path = next((root / "runs").glob("FW-*")) / "run.json"
    rec = json.loads(path.read_text())
    rec["rate_limit_waits"] = [1.0, 1.5]
    path.write_text(json.dumps(rec))
    _units(root)
    e2 = analyze.tables([root], resamples=20)["tab4_e2_utility"]
    assert (
        e2["TS-W|Py|L9"]["cost"]["seconds"]["median"] == 3.0
    )  # 5.0 recorded, 2.0 waited
    assert e2["TS-W|FW|L9"]["cost"]["seconds"]["median"] == 2.5
    assert e2["TS-W|Py|L9"]["cost"]["runs_that_waited_on_429s"] == 1


def test_nit_g_findings_with_a_supplement_through_main(tmp_path, capsys):
    root = tmp_path / "2026-11-06T00-00-00Z_paper-L9"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps(MANIFEST))
    _memory_runs(root, exposed=False)
    _units(root)
    supplement = _supplement(tmp_path / "s")
    assert analyze.main([str(root), "--supplement", str(supplement), "--findings"]) == 0
    out = capsys.readouterr().out
    assert f"Supplement `{supplement.name}`." in out and "Superseded 16 units" in out
