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


def test_a_range_cites_every_id_between_its_endpoints(checker, tmp_path, protocol_text):
    assert {f"P-{n}" for n in range(12, 18)} <= checker.cited_ids("P-12…P-17")["P"]
    assert checker.cited_ids("CB-2...CB-4")["CB"] == {"CB-2", "CB-3", "CB-4"}
    assert checker.cited_ids("P-1–P-3")["P"] == {"P-1", "P-2", "P-3"}
    # The model defines P-1…P-19: in "P-90…P-92" the endpoints are cited directly, P-91 only by the
    # range, so the problem names P-91 only if the range is expanded.
    assert "P-91" not in protocol_text
    for dash in ("…", "–"):
        mutated = protocol_text + f"\nP-90{dash}P-92\n"
        problems = _problems(checker, tmp_path, mutated)
        undefined = [p for p in problems if p.startswith("undefined P ids cited:")]
        assert any("P-91," in p for p in undefined), (dash, problems)


def test_a_number_after_an_ellipsis_is_not_a_range_endpoint(checker, tmp_path, protocol_text):
    assert checker.cited_ids("P-4… 300 runs")["P"] == {"P-4"}
    assert checker.cited_ids("CB-1…11")["CB"] == {"CB-1"}
    report = _run(checker, tmp_path, protocol_text + "\nP-4… 300 runs\n")
    assert report["passed"], report["problems"]


def test_defined_ids_are_check_security_models(checker, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    import check_security_model

    text = MODEL.read_text(encoding="utf-8")
    theirs = check_security_model.defined_ids(text, check_security_model.properties(text))
    ours = checker.defined_ids(text)
    for kind, numbers in theirs.items():
        assert ours[kind] == {f"{kind}-{n}" for n in numbers}
    assert ours["CB"] == {f"CB-{n}" for n in range(1, 12)}


def test_unknown_experiment_id_fails(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace("Shared with E3:", "Shared with E13:", 1)
    assert mutated != protocol_text
    problems = _problems(checker, tmp_path, mutated)
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


def test_lettered_id_in_the_from_cell_is_not_read(checker, tmp_path, protocol_text):
    lines = protocol_text.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith("| T36 "))
    cells = lines[index].rstrip("\n").rstrip("|").rstrip()
    lines[index] = cells + " (no EU resident) |\n"
    report = _run(checker, tmp_path, "".join(lines))
    assert report["passed"], report["problems"]


def test_build_map_ignores_the_from_cell(checker, tmp_path, protocol_text):
    lines = protocol_text.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith("| T36 "))
    lines[index] = "| T36 the browser comparison | the browser agent runs | §6, §3 E9 |\n"
    problems = _problems(checker, tmp_path, "".join(lines))
    assert any("the build map does not name E9" in p for p in problems)


def test_build_map_names_each_experiment_in_a_builders_row(checker, tmp_path, protocol_text):
    # Deleting T34's row leaves E5 named in T39's Builds cell ("the E5 claim's wording"),
    # which is not E5's builder per the scope table.
    lines = protocol_text.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith("| T34 "))
    del lines[index]
    problems = _problems(checker, tmp_path, "".join(lines))
    assert any("the build map does not name T34" in p for p in problems)
    assert any("names E5 only outside its builders' rows (T34" in p for p in problems), problems


def test_builders_come_from_the_scope_table(checker, protocol_text):
    builders = checker._builders(protocol_text)
    assert builders["E5"] == {"T34"}
    assert builders["E2"] == {"T31", "T32"}
    assert builders["EL"] == {"T64"}


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


def test_planned_experiment_needs_question_and_status(checker, tmp_path, protocol_text):
    start = protocol_text.index("### EL · ")
    mutated = protocol_text[:start] + protocol_text[start:].replace("**Status.**", "**State.**", 1)
    problems = _problems(checker, tmp_path, mutated)
    assert any("EL (planned): field 'Status' is missing" in p for p in problems)


def test_missing_planned_section_fails(checker, tmp_path, protocol_text):
    start = protocol_text.index("### EL · ")
    end = protocol_text.index("## 4. ")
    problems = _problems(checker, tmp_path, protocol_text[:start] + protocol_text[end:])
    assert any("experiment section EL (planned) is missing" in p for p in problems), problems


def test_duplicated_field_fails(checker, tmp_path, protocol_text):
    start, end = _section_of(protocol_text, "E7")
    body = protocol_text[start:end]
    budget = body.index("**Budget.**")
    body = body[:budget] + "**Budget.** $500.\n" + body[budget:]
    problems = _problems(checker, tmp_path, protocol_text[:start] + body + protocol_text[end:])
    assert any("E7: field 'Budget' appears more than once" in p for p in problems), problems


def test_duplicated_planned_field_fails(checker, tmp_path, protocol_text):
    start = protocol_text.index("### EL · ")
    status = protocol_text.index("**Status.**", start)
    mutated = protocol_text[:status] + "**Status.** registered.\n" + protocol_text[status:]
    problems = _problems(checker, tmp_path, mutated)
    assert any("EL (planned): field 'Status' appears more than once" in p for p in problems)


def test_a_marker_inside_prose_is_not_a_field(checker, tmp_path, protocol_text):
    start, end = _section_of(protocol_text, "E7")
    body = protocol_text[start:end]
    question = body.index("**Question.**")
    body = body[:question] + "Prose that names a **Budget.** marker mid-line.\n" + body[question:]
    report = _run(checker, tmp_path, protocol_text[:start] + body + protocol_text[end:])
    assert report["passed"], report["problems"]


def test_unknown_lettered_experiment_fails(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace("| T37 EA |", "| T37 EZ |", 1)
    assert mutated != protocol_text
    problems = _problems(checker, tmp_path, mutated)
    assert any("unknown experiment id cited: EZ" in p for p in problems)


def test_lettered_word_in_prose_is_not_an_experiment(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace(
        "Every datum is invented;", "Every datum is invented (no EU or ES resident);", 1
    )
    assert mutated != protocol_text
    report = _run(checker, tmp_path, mutated)
    assert report["passed"], report["problems"]


def test_duplicate_planned_section_is_reported_as_duplicate(checker, tmp_path, protocol_text):
    start = protocol_text.index("### EL · ")
    end = protocol_text.index("## 4. ")
    mutated = protocol_text[:end] + protocol_text[start:end] + protocol_text[end:]
    problems = _problems(checker, tmp_path, mutated)
    assert any("EL appears more than once" in p for p in problems)
    assert not any("EL (planned): field" in p for p in problems)


@pytest.mark.parametrize("task", ["T30", "T39", "T64"])
def test_build_map_requires_t30_t39_and_t64(checker, tmp_path, protocol_text, task):
    lines = protocol_text.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith(f"| {task} "))
    del lines[index]
    problems = _problems(checker, tmp_path, "".join(lines))
    assert any(f"the build map does not name {task}" in p for p in problems)


def test_build_map_reads_only_the_first_cell(checker, tmp_path, protocol_text):
    # The first cell starts with "T" but names no task; T35 appears only in the Builds cell.
    lines = protocol_text.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith("| T35 "))
    lines[index] = "| The compromised model | E10 as T35 says | §4 |\n"
    problems = _problems(checker, tmp_path, "".join(lines))
    assert any("the build map does not name T35" in p for p in problems), problems
    assert any(
        "a build map row names no task in its first cell: 'The compromised model'" in p
        for p in problems
    ), problems


def test_build_map_row_without_a_task_is_reported_not_skipped(checker, tmp_path, protocol_text):
    lines = protocol_text.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith("| T35 "))
    lines[index] = "| the compromised model | as T35 says | §4 E10 |\n"
    problems = _problems(checker, tmp_path, "".join(lines))
    assert any("the build map does not name T35" in p for p in problems)
    assert any("a build map row names no task in its first cell" in p for p in problems), problems


def test_scope_table_without_built_by_column_fails(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace("| Paper table | Built by |", "| Paper table | Owner |", 1)
    assert mutated != protocol_text
    lines = mutated.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith("| T34 "))
    del lines[index]
    problems = _problems(checker, tmp_path, "".join(lines))
    assert any("the scope table (§1) has no 'Built by' column" in p for p in problems), problems
    assert any("the build map does not name T34" in p for p in problems)


def test_scope_table_row_missing_fails(checker, tmp_path, protocol_text):
    lines = protocol_text.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if line.startswith("| E5 "))
    del lines[index]
    problems = _problems(checker, tmp_path, "".join(lines))
    assert any("the scope table (§1) names no builder for E5" in p for p in problems), problems


def test_built_by_must_name_a_builder_from_the_scope_table(checker, tmp_path, protocol_text):
    start, end = _section_of(protocol_text, "E7")
    body = protocol_text[start:end].replace("**Built by.** T38 ", "**Built by.** T37 ", 1)
    assert body != protocol_text[start:end]
    problems = _problems(checker, tmp_path, protocol_text[:start] + body + protocol_text[end:])
    assert any(
        "E7: 'Built by' names none of its builders in the scope table (T38)" in p for p in problems
    ), problems


def test_built_by_must_name_known_tasks(checker, tmp_path, protocol_text):
    start, end = _section_of(protocol_text, "E7")
    body = protocol_text[start:end].replace("**Built by.** T38 ", "**Built by.** T38 and T99 ", 1)
    assert body != protocol_text[start:end]
    problems = _problems(checker, tmp_path, protocol_text[:start] + body + protocol_text[end:])
    assert any("E7: 'Built by' names unknown tasks: T99" in p for p in problems), problems


def test_sha256_is_over_the_bytes(checker, tmp_path, protocol_text):
    import hashlib

    path = tmp_path / "PROTOCOL.md"
    path.write_bytes(protocol_text.replace("\n", "\r\n").encode("utf-8"))
    report = checker.check(path, MODEL)
    assert report["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    committed = checker.check(PROTOCOL, MODEL)["sha256"]
    assert committed == hashlib.sha256(PROTOCOL.read_bytes()).hexdigest()


def test_forbidden_phrase_fails(checker, tmp_path, protocol_text):
    mutated = protocol_text.replace(
        "The runtime **bounds**", "The runtime **protects** against everything and **bounds**", 1
    )
    problems = _problems(checker, tmp_path, mutated)
    assert any("forbidden phrase present: 'protects against'" in p for p in problems)


@pytest.mark.parametrize(
    "wording",
    [
        "The runtime is **protected** against everything and **bounds**",
        "The runtime `protects` against everything and **bounds**",
        "The runtime is protecting\nagainst everything and **bounds**",
        "The runtime prevents all leaks and **bounds**",
    ],
)
def test_forbidden_wording_matches_check_security_model(checker, tmp_path, protocol_text, wording):
    mutated = protocol_text.replace("The runtime **bounds**", wording, 1)
    assert mutated != protocol_text
    problems = _problems(checker, tmp_path, mutated)
    assert any("forbidden phrase present" in p for p in problems), problems


def test_forbidden_patterns_are_check_security_models(checker, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    import check_security_model

    assert checker.FORBIDDEN is check_security_model.FORBIDDEN
