"""The smoke preset end to end (run_v2.py → analyze_v2.py), both runtimes: the full system holds,
every control is accepted, each family's primary ablation exposes its targeted cases, and the
production trees are untouched."""

from __future__ import annotations

import json

import run_v2


def test_smoke_preset(tmp_path):
    out = tmp_path / "smoke"
    assert run_v2.main(["--preset", "smoke", "--jobs", "4", "--out", str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text())
    run = json.loads((out / "run.json").read_text())
    summary = json.loads((out / "summary.json").read_text())
    assert run["production_untouched"] and run["executions"] == manifest["expected_executions"]
    assert manifest["git"]["commit"] and manifest["catalog_sha256"]
    for (runtime, profile), build in [
        (key.split("/"), value) for key, value in manifest["builds"].items()
    ]:
        assert build["key"] and build["source_sha256"] and build["patch_diff_sha256"]
        assert (out / "patches" / profile / f"{runtime}.diff").is_file()
    counts = summary["unexpected_counts"]
    assert counts["full_silent_violations"] == 0
    assert counts["full_false_rejects"] == 0
    assert counts["harness_errors"] == 0
    for row in summary["table"]:
        if row["profile"] == "full":
            assert row["SVR"]["k"] == 0 and row["VDR"]["rate"] == 1.0, row
        if row["controls"]:
            assert row["BAR"]["rate"] == 1.0, row
    for profile, per_runtime in summary["exposure"].items():
        for runtime, entry in per_runtime.items():
            if entry["targeted"]:
                assert entry["silent"] > 0, (profile, runtime)
    text = "\n".join(
        path.read_text() for path in out.rglob("*") if path.suffix in {".json", ".jsonl", ".md"}
    )
    assert "PRIVATE KEY" not in text
