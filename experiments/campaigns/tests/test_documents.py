"""E3's TS-L PDF placement (D-360): the stand-in, its reach, its bytes on both sides."""

from __future__ import annotations

import sys

from agentpkg.hostfiles.pdf import extract_text
from campaigns.driver import campaign, py_driver
from campaigns.origin import catalog, documents

PAYLOADS = catalog.load()
RESOLVER = campaign.ROOT / "citation-resolver"


def _resolver_doi(value: str) -> str | None:
    """The Citation Resolver's own DOI normalization, which every provider applies to the DOI it
    returns, so a candidate's `paper_id` is this form."""
    if str(RESOLVER) not in sys.path:
        sys.path.insert(0, str(RESOLVER))
    from app.identifiers import parse_doi  # noqa: PLC0415

    return parse_doi(value)


def test_every_question_has_a_seed_paper_with_an_arxiv_doi():
    sources = documents.sources()
    assert sorted(sources) == ["L1", "L2", "L3", "L4", "L5", "L6"]
    for paper in sources.values():
        assert paper["doi"] == f"10.48550/arxiv.{paper['arxiv_id']}"
        assert paper["title"] and paper["abstract"] and paper["authors"]


def test_the_selection_is_keyed_by_the_doi_as_the_resolver_returns_it(tmp_path):
    """T32 review 1, finding 1: the input keyed the file by `10.48550/arXiv.…`, the resolver
    returns `10.48550/arxiv.…` as the candidate's `paper_id` (its providers all apply
    `parse_doi`), and the package's normalize step, told to copy the file id of "the documents
    entry whose key is the paper's DOI", found none in 12 of 12 runs: the PDF was never read. The
    key must be the resolver's own form, character for character."""
    for question, paper in documents.sources().items():
        assert _resolver_doi(paper["doi"]) == paper["doi"]
        selected, seeds = documents.selected_for(question, None, tmp_path / question)
        assert list(selected) == seeds == [_resolver_doi(paper["doi"])]
    assert _resolver_doi("10.48550/arXiv.2402.16823") == "10.48550/arxiv.2402.16823"


def test_the_stand_in_is_deterministic_and_agentpkg_reads_the_payload_back():
    text = PAYLOADS["upload-l1"]["text"]
    first = documents.pdf_bytes(documents.document_text("L3", text))
    assert first == documents.pdf_bytes(documents.document_text("L3", text))
    read = " ".join(p["text"] for p in extract_text(first)["pages"])
    assert "sink.invalid/cite" in read and "StruQ" in read
    twin = documents.pdf_bytes(documents.document_text("L3", PAYLOADS["upload-l1"]["twin"]))
    assert "sink.invalid" not in " ".join(p["text"] for p in extract_text(twin)["pages"])


def test_both_sides_get_the_same_bytes_and_the_seed(tmp_path):
    text = PAYLOADS["steer-l1"]["text"]
    py_sel, py_seeds = documents.selected_for("L5", text, tmp_path / "py")
    fw_sel, fw_seeds = documents.selected_for("L5", text, tmp_path / "fw")
    ((doi, (file_id, py_path)),) = py_sel.items()
    assert py_seeds == fw_seeds == [doi]
    assert py_path.read_bytes() == fw_sel[doi][1].read_bytes()
    value = py_driver.literature_input("q", {doi: file_id}, py_seeds)
    assert value["seeds"] == [doi] and value["documents"] == {doi: file_id}


def test_e3s_literature_arm_is_24_runs_per_side_with_the_pdf_placement():
    units = campaign.units_for("e3", ["L30"], ["Py", "FW"], PAYLOADS, ("TS-L",))
    per_side = [u for u in units if u["side"] == "FW"]
    assert len(per_side) == 6 * 2 * 2
    assert {u["arm"]["placement"] for u in per_side} == {"resolver.abstract", "pdf.text"}


def test_a_run_that_read_the_stand_in_is_exposed():
    arm = {"payload": "upload-l1", "placement": "pdf.text", "arm": "injected"}
    read = {"tool_calls": [{"tool": "paper-reader", "outcome": "answered"}]}
    assert campaign.exposure(read, arm) is True
    assert campaign.exposure({"tool_calls": []}, arm) is False
