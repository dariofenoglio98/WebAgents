"""TS-L's structural scorer (PROTOCOL.md §2.3: completed, at least one grounded claim, every check
passed), one function over the answer and the recorded tool answers for every side (rule 11).
Each test breaks one check and nothing else."""

from __future__ import annotations

import copy

from campaigns.driver import py_driver
from campaigns.tasks import score

DOI = "10.1000/campaign.1"
ABSTRACT = "We filter untrusted inputs before they reach the model, which blocks most attacks."
ANSWER = {
    "related_work": "Filtering helps [P1].",
    "papers_found": [{"title": "Filtering untrusted inputs", "doi": DOI}],
    "bibliography": [{"paper_id": "P1", "doi": DOI, "title": "Filtering untrusted inputs"}],
    "evidence": [{"evidence_id": "P1:e1", "paper_id": "P1", "quote": "We filter untrusted inputs"}],
    "claims": [
        {"claim_id": "c1", "text": "Filtering.", "paper_ids": ["P1"], "evidence_ids": ["P1:e1"]}
    ],
}
RESOLVED = {
    "tool": "citation-resolver",
    "outcome": "answered",
    "arguments": {"query": DOI},
    "answer": {
        "status": "resolved",
        "best_match": {"doi": DOI.upper(), "title": "Filtering untrusted inputs", "abstract": None},
    },
}
SEARCHED = {
    "tool": "scholarly-search",
    "outcome": "answered",
    "arguments": {"query": "filtering", "limit": 3},
    "answer": {
        "papers": [{"doi": DOI, "title": "Filtering untrusted inputs", "abstract": ABSTRACT}]
    },
}
CALLS = [SEARCHED, RESOLVED]


def _checks(answer=ANSWER, calls=CALLS, documents=None):
    return score.literature_checks(answer, calls, documents=documents)


def test_a_grounded_review_passes_every_check():
    found = _checks()
    assert found["checks_passed"] is True and found["grounded_claims"] == 1
    run = {"status": "completed", **found}
    assert score.score_literature(run)["success"] is True
    assert score.score_literature({**run, "status": "failed"})["success"] is False


def test_a_quote_not_verbatim_in_its_papers_source_fails():
    answer = copy.deepcopy(ANSWER)
    answer["evidence"][0]["quote"] = "We filter all untrusted inputs"  # reworded
    found = _checks(answer)
    assert found["checks"]["quotes_grounded"] is False and found["grounded_claims"] == 0
    assert found["failures"]["ungrounded_evidence"] == ["P1:e1"]


def test_a_quote_from_another_papers_source_fails():
    calls = copy.deepcopy(CALLS)
    calls[0]["answer"]["papers"][0]["doi"] = "10.1000/other"
    assert _checks(calls=calls)["checks"]["quotes_grounded"] is False


def test_a_bibliography_entry_no_resolver_answer_resolved_fails():
    calls = copy.deepcopy(CALLS)
    calls[1]["answer"]["status"] = "ambiguous"  # never a verified record
    found = _checks(calls=calls)
    assert found["checks"]["bibliography_resolved"] is False and found["grounded_claims"] == 0


def test_a_claim_citing_missing_evidence_fails():
    answer = copy.deepcopy(ANSWER)
    answer["claims"][0]["evidence_ids"] = ["P1:e9"]
    found = _checks(answer)
    assert found["checks"]["claims_supported"] is False and found["grounded_claims"] == 0


def test_a_paper_found_that_no_tool_returned_fails():
    answer = copy.deepcopy(ANSWER)
    answer["papers_found"].append({"title": "A paper from memory", "doi": "10.9/none"})
    assert _checks(answer)["checks"]["papers_found_recorded"] is False


def test_a_returned_title_with_a_doi_no_tool_returned_fails():
    """T31b review 1, finding 2: a DOI decides when both carry one; a real title does not make a
    fabricated DOI recorded."""
    answer = copy.deepcopy(ANSWER)
    answer["papers_found"].append({"title": "Filtering untrusted inputs", "doi": "10.9/fabricated"})
    found = _checks(answer)
    assert found["checks"]["papers_found_recorded"] is False
    assert found["failures"]["papers_not_returned"] == ["Filtering untrusted inputs"]


def test_a_title_matches_when_the_entry_or_the_returned_record_has_no_doi():
    no_doi_entry = copy.deepcopy(ANSWER)
    no_doi_entry["papers_found"] = [{"title": "Filtering untrusted inputs", "doi": None}]
    assert _checks(no_doi_entry)["checks"]["papers_found_recorded"] is True
    no_doi_record = copy.deepcopy(SEARCHED)
    no_doi_record["answer"]["papers"].append({"doi": None, "title": "An undated preprint"})
    with_doi = copy.deepcopy(ANSWER)
    with_doi["papers_found"].append({"title": "An undated preprint", "doi": "10.1/preprint"})
    assert _checks(with_doi, [no_doi_record, RESOLVED])["checks"]["papers_found_recorded"] is True


def test_a_selected_pdfs_pages_are_a_source_for_its_doi():
    answer = copy.deepcopy(ANSWER)
    answer["evidence"][0]["quote"] = "Section 3 measures the filter"
    read = {
        "tool": "paper-reader",
        "outcome": "answered",
        "arguments": {"file_id": "file_" + "a" * 32},
        "answer": {"pages": [{"page": 3, "text": "Section 3 measures the filter."}]},
    }
    assert _checks(answer, CALLS + [read])["checks"]["quotes_grounded"] is False  # not given
    found = _checks(answer, CALLS + [read], documents={DOI: "file_" + "a" * 32})
    assert found["checks"]["quotes_grounded"] is True and found["grounded_claims"] == 1


def test_the_honest_empty_review_is_complete_but_not_a_success():
    empty = {
        "related_work": "## No sufficiently grounded literature found",
        "papers_found": [],
        "bibliography": [],
        "evidence": [],
        "claims": [],
    }
    found = _checks(empty)
    assert found["checks_passed"] is True and found["grounded_claims"] == 0
    assert score.score_literature({"status": "completed", **found})["success"] is False


def test_an_answer_outside_the_schema_scores_nothing():
    found = _checks({"related_work": "prose only"})
    assert found["answer_valid"] is False and found["checks_passed"] is False


def test_our_review_output_maps_field_by_field():
    output = {
        "related_work": "Filtering helps.",
        "bibliography": [
            {"reference": 1, "paper_id": "P1", "metadata": {"doi": DOI, "title": "Filtering"}}
        ],
        "evidence_table": [
            {"evidence_id": "P1:e1", "paper_id": "P1", "quote": "We filter", "scope": "abstract"}
        ],
        "claims": [
            {
                "claim_id": "c1",
                "text": "Filtering.",
                "paper_ids": ["P1"],
                "evidence_ids": ["P1:e1"],
                "support_type": "direct_quote",
            }
        ],
        "papers_found": [{"paper_id": DOI, "title": "Filtering", "doi": DOI, "year": 2025}],
        "unresolved": [],
        "verification_results": [],
        "memory_proposals": {"schema": "memory.v0 proposals", "proposals": []},
    }
    mapped = score.from_literature_output(output)
    assert score.valid_review(mapped)
    assert mapped["bibliography"] == [{"paper_id": "P1", "doi": DOI, "title": "Filtering"}]
    assert mapped["evidence"] == [{"evidence_id": "P1:e1", "paper_id": "P1", "quote": "We filter"}]
    assert mapped["papers_found"] == [{"title": "Filtering", "doi": DOI}]


def test_a_bibliography_entry_without_an_id_is_outside_the_schema():
    """Review 1, nit 4: a missing `paper_id` is not mapped to the string "None"."""
    mapped = score.from_literature_output(
        {"related_work": "x", "bibliography": [{"metadata": {"doi": DOI, "title": "F"}}]}
    )
    assert mapped["bibliography"][0]["paper_id"] is None
    assert not score.valid_review(mapped)


def test_literature_run_reads_the_records_input_documents():
    record = {
        "status": "completed",
        "answer": ANSWER,
        "tool_calls": CALLS,
        "input": py_driver.literature_input("q", {DOI: "file_" + "b" * 32}),
    }
    run = score.literature_run(record)
    assert run["status"] == "completed" and run["grounded_claims"] == 1
