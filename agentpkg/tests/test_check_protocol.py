"""`scripts/check_protocol.py` (T29): the pre-registered protocol's structure, citations, wording.

Each test feeds a mutated copy of the committed protocol to the checker and expects the named
problem.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check_protocol.py"
PROTOCOL = ROOT / "experiments" / "PROTOCOL.md"
MODEL = ROOT / "docs" / "security-and-privacy-model.md"


def _load():
    spec = importlib.util.spec_from_file_location("check_protocol", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def checker():
    return _load()


@pytest.fixture()
def protocol_text() -> str:
    return PROTOCOL.read_text(encoding="utf-8")


def _run(checker, tmp_path: Path, text: str) -> dict:
    path = tmp_path / "PROTOCOL.md"
    path.write_text(text, encoding="utf-8")
    return checker.check(path, MODEL)


def _problems(checker, tmp_path: Path, text: str) -> list[str]:
    return _run(checker, tmp_path, text)["problems"]


def _section_of(text: str, experiment: str) -> tuple[int, int]:
    start = text.index(f"### {experiment} · ")
    later = re.compile(r"^### (E\d+|EA) · |^## ", re.MULTILINE)
    match = later.search(text, start + 1)
    return start, match.start() if match else len(text)


def test_committed_protocol_passes(checker):
    report = checker.check(PROTOCOL, MODEL)
    assert report["passed"], report["problems"]
    assert report["experiments"] == 11
    assert re.fullmatch(r"[0-9a-f]{64}", report["sha256"])


def test_cli_prints_json_and_exits_zero():
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True, check=False, cwd=ROOT
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    report = json.loads(completed.stdout)
    assert report["passed"] is True
    assert report["protocol"] == "experiments/PROTOCOL.md"


def test_missing_field_fails(checker, tmp_path, protocol_text):
    start, end = _section_of(protocol_text, "E5")
    body = protocol_text[start:end].replace("**Ladder.**", "**Rungs.**", 1)
    problems = _problems(checker, tmp_path, protocol_text[:start] + body + protocol_text[end:])
    assert any("E5: field 'Ladder' is missing" in p for p in problems)


def test_missing_section_fails(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace("### E8 · ", "### E8 - ", 1)
    problems = _problems(checker, tmp_path, mutated)
    assert any("experiment section E8 is missing" in p for p in problems)


def test_duplicate_section_fails(checker, tmp_path, protocol_text):
    start, end = _section_of(protocol_text, "E2")
    mutated = protocol_text[:end] + protocol_text[start:end] + protocol_text[end:]
    problems = _problems(checker, tmp_path, mutated)
    assert any("E2 appears more than once" in p for p in problems)


def test_fields_out_of_order_fails(checker, tmp_path, protocol_text):
    start, end = _section_of(protocol_text, "E1")
    body = protocol_text[start:end]
    q = body.index("**Question.**")
    p = body.index("**Properties.**")
    c = body.index("**Claim.**")
    swapped = body[:q] + body[p:c] + body[q:p] + body[c:]
    problems = _problems(checker, tmp_path, protocol_text[:start] + swapped + protocol_text[end:])
    assert any("E1: fields are out of order" in p for p in problems)


def test_unknown_property_fails(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace("P-16, P-11 (CB-10)", "P-16, P-99 (CB-10)", 1)
    problems = _problems(checker, tmp_path, mutated)
    assert any("undefined P ids cited: P-99" in p for p in problems)


def test_unknown_dataflow_and_consent_ids_fail(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace("motivates DF-3", "motivates DF-11", 1)
    mutated = mutated.replace("CB-11 →", "CB-12 →", 1)
    problems = _problems(checker, tmp_path, mutated)
    assert any("undefined DF ids cited: DF-11" in p for p in problems)
    assert any("undefined CB ids cited: CB-12" in p for p in problems)


def test_unknown_experiment_id_fails(checker, tmp_path, protocol_text):
    problems = _problems(checker, tmp_path, protocol_text.replace("(E2 + E3)", "(E2 + E13)", 1))
    assert any("unknown experiment id cited: E13" in p for p in problems)


def test_build_map_must_name_every_task(checker, tmp_path, protocol_text):
    problems = _problems(checker, tmp_path, protocol_text.replace("| T34 E5 |", "| E5 |", 1))
    assert any("the build map does not name T34" in p for p in problems)


def test_build_map_must_name_every_experiment(checker, tmp_path, protocol_text):
    lines = protocol_text.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith("| T36 "))
    lines[index] = "| T36 the browser comparison | the browser agent runs | §6 |\n"
    problems = _problems(checker, tmp_path, "".join(lines))
    assert any("the build map does not name E9" in p for p in problems)


def test_built_by_must_name_a_task(checker, tmp_path, protocol_text):
    start, end = _section_of(protocol_text, "E7")
    body = protocol_text[start:end].replace(
        "**Built by.** T38 ", "**Built by.** the overhead task ", 1
    )
    assert body != protocol_text[start:end]
    problems = _problems(checker, tmp_path, protocol_text[:start] + body + protocol_text[end:])
    assert any("E7: 'Built by' names no task" in p for p in problems)


def test_amendments_table_required(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace("### 9.2 Amendments", "### 9.2 Changes", 1)
    problems = _problems(checker, tmp_path, mutated)
    assert any("amendments table" in p for p in problems)


def test_registration_section_required(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace("### 9.1 Registration", "### 9.1 Recording", 1)
    problems = _problems(checker, tmp_path, mutated)
    assert any("registration section" in p for p in problems)


def test_forbidden_phrase_fails(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace(
        "The runtime **bounds**", "The runtime **protects** against everything and **bounds**", 1
    )
    problems = _problems(checker, tmp_path, mutated)
    assert any("forbidden phrase present: 'protects against'" in p for p in problems)
