"""`scripts/verify_network_run.py` (T26 review 1, nit 4; T31): re-entrant, and a failed report,
never a traceback, for an export or a harness report it cannot verify."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "verify_network_run.py"


def _load():
    spec = importlib.util.spec_from_file_location("verify_network_run", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _run(*args: str) -> tuple[int, dict]:
    done = subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False
    )
    assert "Traceback" not in done.stderr, done.stderr
    return done.returncode, json.loads(done.stdout)


def test_verify_is_re_entrant_and_reports_missing_files():
    module = _load()
    files = {"run.json": b"{}"}
    first = module.verify(files)
    second = module.verify(files)
    assert first["passed"] is False and second["passed"] is False
    assert first["checks"] == second["checks"]
    assert [c["check"] for c in first["checks"] if not c["passed"]] == [
        "the export holds run-plan.json",
        "the export holds audit.json",
        "the export holds usage.json",
    ]


def test_a_missing_export_is_a_failed_report(tmp_path):
    code, report = _run("--export", str(tmp_path / "absent"))
    assert code == 1 and report["passed"] is False


def test_an_export_without_its_files_is_a_failed_report(tmp_path):
    (tmp_path / "run.json").write_text("{}")
    code, report = _run("--export", str(tmp_path))
    assert code == 1 and report["passed"] is False


def test_a_harness_report_after_an_early_failure_is_a_failed_report(tmp_path):
    harness = tmp_path / "report.json"
    harness.write_text(json.dumps({"exportDirectory": None, "fakes": {"ollama": None}}))
    code, report = _run("--report", str(harness))
    assert code == 1 and report["passed"] is False
    rewritten = json.loads(harness.read_text())
    assert rewritten["passed_network"] is False


def test_a_fake_model_without_a_scheme_is_a_failed_report_not_a_traceback(tmp_path):
    """T31 review 1, nit 17: `fakes.ollama` without `//` names the host itself."""
    export = tmp_path / "export"
    export.mkdir()
    (export / "run.json").write_text("{}")
    harness = tmp_path / "report.json"
    harness.write_text(
        json.dumps(
            {
                "exportDirectory": str(export),
                "referenceDirectory": str(tmp_path),
                "fakes": {"ollama": "127.0.0.1:11434"},
            }
        )
    )
    code, report = _run("--report", str(harness))
    assert code == 1 and report["passed"] is False
