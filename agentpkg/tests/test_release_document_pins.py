"""scripts/check_release.py compares package-origin/server.py's document pins with examples/ (T9).

T8 review 1, nit 4: the two SHA-256 pins were literals no release check read, so a re-signed
document would pass the release check and fail only when the container starts.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _check_release():
    spec = importlib.util.spec_from_file_location(
        "check_release", ROOT / "scripts" / "check_release.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DOCUMENTS = {
    "agent-index.json": "examples/agent-index.json",
    "policies/webagents-research.json": "examples/policies/webagents-research.json",
    # T41: the signed curated in-browser model list.
    "model-catalog.json": "examples/model-catalog.json",
}


def test_the_shipped_pins_are_the_documents_own():
    module = _check_release()
    pins = module.document_pins((ROOT / "package-origin" / "server.py").read_text(encoding="utf-8"))
    assert sorted(pins) == [
        "/agent-index.json",
        "/model-catalog.json",
        "/policies/webagents-research.json",
    ]
    assert module.pin_mismatches(pins, DOCUMENTS) == {
        "pins": pins,
        "mismatched": [],
        "passed": True,
    }
    assert module.check_packages()["package_origin_document_pins"]["passed"] is True


def test_a_stale_pin_or_a_missing_one_fails():
    module = _check_release()
    source = (ROOT / "package-origin" / "server.py").read_text(encoding="utf-8")
    pins = module.document_pins(source)
    stale = module.document_pins(source.replace(pins["/agent-index.json"], "0" * 64))
    assert module.pin_mismatches(stale, DOCUMENTS)["mismatched"] == ["/agent-index.json"]
    missing = {"/agent-index.json": pins["/agent-index.json"]}
    assert module.pin_mismatches(missing, DOCUMENTS)["mismatched"] == [
        "/model-catalog.json",
        "/policies/webagents-research.json",
    ]


def test_a_documents_value_that_is_not_a_dict_is_named_as_such():
    """T9 review 1, nit 9: a non-dict DOCUMENTS read as "defines no DOCUMENTS dict"."""
    module = _check_release()
    with pytest.raises(ValueError, match="DOCUMENTS must be a dict literal"):
        module.document_pins("DOCUMENTS = [1]\n")
    with pytest.raises(ValueError, match="defines no DOCUMENTS dict"):
        module.document_pins("OTHER = {}\n")
