"""`scripts/check_security_model.py` against mutated copies of the model: each check fails on the
defect it exists for (T28 review 1, finding 19d), and the committed model passes."""

from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check_security_model.py"


@pytest.fixture(scope="module")
def checker():
    spec = importlib.util.spec_from_file_location("check_security_model", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def model_text(checker):
    return checker.read(checker.MODEL)


def run(checker, tmp_path, text, **kwargs):
    path = tmp_path / "model.md"
    path.write_text(text, encoding="utf-8")
    return checker.run_checks(path, **kwargs)


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, old
    return text.replace(old, new)


def test_committed_model_passes(checker):
    report = checker.run_checks()
    assert report["passed"], {
        k: v for k, v in report.items() if isinstance(v, dict) and not v.get("passed")
    }
    assert report["properties"]["count"] == 19
    assert report["case_ids"]["report"].startswith("conformance/results/")
    assert report["citations"]["defined"] == {"P": 19, "DF": 10, "UC": 7}
    assert report["threat_model_map"]["mismatches"] == []


def test_missing_field(checker, model_text, tmp_path):
    text = replace_once(
        model_text,
        "**Residual.** The JSON Schema validator runs in process",
        "**Residue.** The JSON Schema validator runs in process",
    )
    report = run(checker, tmp_path, text)
    assert report["properties"]["incomplete"] == {"P-3": ["Residual"]}
    assert not report["passed"]


def test_gap_in_ids(checker, model_text, tmp_path):
    text = replace_once(model_text, "### P-19 · ", "### P-20 · ")
    report = run(checker, tmp_path, text)
    assert report["properties"]["gaps"] == ["P-19"]
    assert not report["passed"]


def test_pointer_to_missing_file(checker, model_text, tmp_path):
    text = replace_once(
        model_text,
        "`agentpkg/src/agentpkg/package.py:integrity_statement`",
        "`agentpkg/src/agentpkg/packag.py:integrity_statement`",
    )
    report = run(checker, tmp_path, text)
    assert report["pointers"]["missing_files"] == ["agentpkg/src/agentpkg/packag.py"]
    assert not report["passed"]


def test_pointer_to_missing_symbol(checker, model_text, tmp_path):
    text = replace_once(
        model_text,
        "`agentpkg/src/agentpkg/package.py:integrity_statement`",
        "`agentpkg/src/agentpkg/package.py:integrity_statment`",
    )
    report = run(checker, tmp_path, text)
    assert report["pointers"]["missing_symbols"] == [
        "agentpkg/src/agentpkg/package.py:integrity_statment"
    ]
    assert not report["passed"]


def test_unknown_case_id(checker, model_text, tmp_path):
    text = model_text.replace("`memory/n3-read-denied`", "`memory/n99-read-denied`", 1)
    report = run(checker, tmp_path, text)
    assert report["case_ids"]["unknown"] == ["memory/n99-read-denied"]
    assert "P-4: memory/n99-read-denied" in report["case_ids"]["unknown_tokens"]
    assert not report["passed"]


def test_misspelt_family_in_a_conformance_field(checker, model_text, tmp_path):
    text = model_text.replace("`memory/n3-read-denied`", "`memroy/n3-read-denied`", 1)
    report = run(checker, tmp_path, text)
    assert report["case_ids"]["unknown"] == []  # the family is unknown to the whole-text check
    assert report["case_ids"]["unknown_tokens"] == ["P-4: memroy/n3-read-denied"]
    assert not report["passed"]


def test_bare_case_id(checker, model_text, tmp_path):
    text = replace_once(model_text, "`unpinned-key`", "`unpinned-kye`")
    report = run(checker, tmp_path, text)
    assert report["case_ids"]["unknown_tokens"] == ["P-2: unpinned-kye"]
    assert not report["passed"]


def test_cited_report_must_exist(checker, model_text, tmp_path):
    text = replace_once(
        model_text,
        "conformance/results/2026-10-25T02-53-07-223Z/",
        "conformance/results/1999-01-01T00-00-00-000Z/",
    )
    report = run(checker, tmp_path, text)
    assert "does not exist" in report["case_ids"]["report"]
    assert not report["case_ids"]["passed"]


def test_spec_numbered_case_out_of_range(checker, model_text, tmp_path):
    text = model_text.replace("memory N3", "memory N23", 1)
    report = run(checker, tmp_path, text)
    assert report["case_ids"]["spec_numbered_out_of_range"] == ["memory N-23"]
    assert not report["passed"]


def test_unknown_experiment(checker, model_text, tmp_path):
    text = replace_once(
        model_text,
        "E7 (the cost of hashing and verification)",
        "E11 (the cost of hashing and verification)",
    )
    report = run(checker, tmp_path, text)
    assert report["experiments"]["unknown"] == ["E11"]
    assert not report["passed"]


@pytest.mark.parametrize(
    "sentence, phrase",
    [
        ("The runtime protects\nagainst nothing here.", "protects\nagainst"),
        ("Nothing is protected against.", "protected against"),
        ("It prevents\nall attacks.", "prevents\nall"),
        ("It guarantees security.", "guarantees security"),
    ],
)
def test_forbidden_phrase_across_a_line_wrap(checker, model_text, tmp_path, sentence, phrase):
    report = run(checker, tmp_path, model_text + "\n\n" + sentence + "\n")
    hits = [h for h in report["wording"]["forbidden"] if h["file"] == str(tmp_path / "model.md")]
    assert [h["phrase"] for h in hits] == [" ".join(phrase.split())]
    assert hits[0]["line"] > 1000
    assert not report["passed"]


def test_prevent_in_the_model(checker, model_text, tmp_path):
    report = run(checker, tmp_path, model_text + "\n\nThis prevents a thing.\n")
    assert [h["phrase"] for h in report["wording"]["prevent_in_model"]] == ["prevent"]
    assert not report["passed"]


def test_citation_of_an_undefined_property(checker, model_text, tmp_path):
    other = tmp_path / "spec.md"
    other.write_text("See P-99, DF-11 and UC-8; P-1 is fine.\n", encoding="utf-8")
    report = run(checker, tmp_path, model_text, documents=[other])
    assert report["citations"]["unknown"] == [
        f"{other}: DF-11",
        f"{other}: P-99",
        f"{other}: UC-8",
    ]
    assert not report["passed"]


def test_threat_model_map_against_section_lines(checker, model_text, tmp_path):
    copy = tmp_path / "threat-model.md"
    shutil.copy(checker.THREAT_MODEL, copy)
    text = replace_once(
        copy.read_text(encoding="utf-8"), "*Properties: P-3, P-15 (", "*Properties: P-3 ("
    )
    copy.write_text(text, encoding="utf-8")
    report = run(checker, tmp_path, model_text, threat_model=copy)
    assert report["threat_model_map"]["mismatches"] == [
        {"property": "P-15", "only_in_map": ["code in packages"], "only_in_sections": []}
    ]
    assert not report["passed"]


def test_gap_list_names_every_unmeasured_property(checker, model_text, tmp_path):
    matrix = tmp_path / "evidence-matrix.md"
    matrix.write_text("# Matrix\n\n## 2. Gaps\n\nnothing here\n\n## 3. More\n", encoding="utf-8")
    report = run(checker, tmp_path, model_text, evidence_matrix=matrix)
    assert report["evidence_matrix"]["missing_from_gap_list"] == ["P-19"]
    assert not report["passed"]
