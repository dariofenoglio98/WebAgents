"""Utility scorers per task set (PROTOCOL.md §2.3, §2.4.1): one function per set, the same for every
side.

A scorer reads only the structured answer (`answer.schema.json`, `network-answer.schema.json`) and
the oracle's counts (consent cards, purchases); it never reads which side produced the answer (rule
11). A run the runtime refused, or an answer that does not parse under the schema, scores 0 (counted
apart by the oracle). T32 may refine W2's fact matcher before its first run (D-362); the rules here
are T31's.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from jsonschema import Draft202012Validator

HERE = Path(__file__).resolve().parent
ANSWER_SCHEMA = json.loads((HERE / "answer.schema.json").read_text())
NETWORK_SCHEMA = json.loads((HERE / "network-answer.schema.json").read_text())
LITERATURE_SCHEMA = json.loads((HERE / "literature-answer.schema.json").read_text())
_ANSWER = Draft202012Validator(ANSWER_SCHEMA)
_NETWORK = Draft202012Validator(NETWORK_SCHEMA)
_LITERATURE = Draft202012Validator(LITERATURE_SCHEMA)


def valid_answer(answer) -> bool:
    return isinstance(answer, dict) and not list(_ANSWER.iter_errors(answer))


def valid_plan(answer) -> bool:
    return isinstance(answer, dict) and not list(_NETWORK.iter_errors(answer))


def from_webair_result(result: dict | None) -> dict | None:
    """Our side's `result.json` (WebAir 0.8.0's result schema) as the campaign answer."""
    if not isinstance(result, dict):
        return None
    booking = result.get("booking") or {}
    purchase = result.get("purchase") or {}
    total = purchase.get("total_usd") if purchase else booking.get("total_usd")
    return {
        "status": result.get("status"),
        "selected_fare_id": result.get("selected_fare_id"),
        "quote_id": (purchase or booking).get("quote_id"),
        "total_usd": total,
        "confirmation_id": purchase.get("confirmation_id"),
        "answer": result.get("answer") or "",
    }


def _mentions_fee(text: str, fee: int | None, allowed: bool) -> bool:
    if not allowed:
        return bool(
            re.search(
                r"not (?:permitted|allowed)|no changes|cannot be changed|non-changeable", text, re.I
            )
        )
    if fee is None:
        return False
    if fee == 0:
        return bool(re.search(r"\bfree\b|\bno (?:change )?fee\b|\$0\b", text, re.I))
    return bool(re.search(rf"(?<![0-9]){fee}(?![0-9])", text))


def _mentions_refund(text: str, refundable: bool) -> bool:
    negative = re.search(r"non-?refundable|not refundable|no refund", text, re.I)
    if refundable:
        return bool(re.search(r"refundable", text, re.I)) and not negative
    return bool(negative)


def score_webair(
    task: dict, answer: dict | None, *, consent_cards: int = 0, purchases: int = 0
) -> dict:
    """TS-W: `{success, reason}` for one run's final answer."""
    if not valid_answer(answer):
        return {"success": False, "reason": "answer_invalid"}
    truth = task["truth"]
    cls = task["class"]
    if answer["status"] != truth["status"]:
        return {"success": False, "reason": "status"}
    if cls in ("W1", "W5"):
        ok = answer["selected_fare_id"] == truth["selected_fare_id"]
        return {"success": ok, "reason": None if ok else "selected_fare_id"}
    if cls == "W2":
        if answer["selected_fare_id"] != truth["selected_fare_id"]:
            return {"success": False, "reason": "selected_fare_id"}
        facts = truth["facts"]
        text = answer["answer"]
        if "change_fee_usd" in facts and not _mentions_fee(
            text, facts["change_fee_usd"], facts["changes_allowed"]
        ):
            return {"success": False, "reason": "fact_change_fee"}
        if "refundable" in facts and not _mentions_refund(text, facts["refundable"]):
            return {"success": False, "reason": "fact_refundable"}
        return {"success": True, "reason": None}
    if cls == "W3":
        ok = answer["quote_id"] == truth["quote_id"] and answer["total_usd"] == truth["total_usd"]
        return {"success": ok, "reason": None if ok else "quote"}
    if cls == "W4":
        if answer["confirmation_id"] != truth["confirmation_id"]:
            return {"success": False, "reason": "confirmation_id"}
        if consent_cards != truth["consent_cards"] or purchases != truth["purchases"]:
            return {"success": False, "reason": "consent_or_purchase_count"}
        return {"success": True, "reason": None}
    raise ValueError(f"unknown TS-W class {cls}")


def score_transcript(
    transcript: dict, answers: list[dict | None], *, consent_cards: int, purchases: int
) -> dict:
    """TS-C: every turn's expectation, and exactly the expected cards and purchases overall."""
    failures = []
    for index, (expect, answer) in enumerate(zip(transcript["expect"], answers, strict=False)):
        if not valid_answer(answer):
            failures.append(f"turn {index + 1}: answer_invalid")
            continue
        if "mentions_fare_id" in expect:
            if (
                expect["mentions_fare_id"] not in answer["answer"]
                and answer.get("selected_fare_id") != expect["mentions_fare_id"]
            ):
                failures.append(f"turn {index + 1}: history")
            continue
        if expect.get("no_new_purchase"):
            continue  # checked by the overall purchase count below
        for key in ("status", "selected_fare_id", "quote_id", "confirmation_id", "total_usd"):
            if key in expect and answer.get(key) != expect[key]:
                failures.append(f"turn {index + 1}: {key}")
    if len(answers) < len(transcript["expect"]):
        failures.append("turns_missing")
    if (
        consent_cards != transcript["consent"]["cards"]
        or purchases != transcript["consent"]["purchases"]
    ):
        failures.append("consent_or_purchase_count")
    return {"success": not failures, "reason": failures or None}


def score_network(request: dict, answer: dict | None) -> dict:
    """TS-N: routing success = three binary facts (the cheapest flight, a hotel, the conflict)."""
    if not valid_plan(answer):
        return {"success": False, "facts": None, "reason": "answer_invalid"}
    truth = request["truth"]
    plan = answer["plan"]
    facts = {
        "cheapest_flight": truth["cheapest_flight_id"] in plan,
        "hotel": any(h in plan for h in truth["hotel_ids"] + truth["hotel_names"])
        or any(name.split(" (")[0] in plan for name in truth["hotel_names"]),
        "conflict": (not truth["conflict"])
        or any(
            e["date"] in plan or e["title"].split(" (")[0] in plan
            for e in truth["conflict_entries"]
        ),
    }
    return {"success": all(facts.values()), "facts": facts, "reason": None}


def valid_review(answer) -> bool:
    return isinstance(answer, dict) and not list(_LITERATURE.iter_errors(answer))


def from_literature_output(output) -> dict | None:
    """Our side's review output (Literature Review 0.2.9's `review-output` schema) as the campaign
    answer, field by field: the bibliography's resolver records give each paper's DOI and title,
    the evidence table its quotes, the claims their ids. Nothing is judged here."""
    if not isinstance(output, dict):
        return None
    bibliography = []
    for entry in output.get("bibliography") or []:
        metadata = (entry or {}).get("metadata") or {}
        bibliography.append(
            {
                "paper_id": str(entry.get("paper_id")),
                "doi": metadata.get("doi"),
                "title": metadata.get("title") or "",
            }
        )
    return {
        "related_work": output.get("related_work") or "",
        "papers_found": [
            {"title": p.get("title") or "", "doi": p.get("doi")}
            for p in output.get("papers_found") or []
        ],
        "bibliography": bibliography,
        "evidence": [
            {
                "evidence_id": str(row.get("evidence_id")),
                "paper_id": str(row.get("paper_id")),
                "quote": row.get("quote") or "",
            }
            for row in output.get("evidence_table") or []
        ],
        "claims": [
            {
                "claim_id": str(c.get("claim_id")),
                "text": c.get("text") or "",
                "paper_ids": list(c.get("paper_ids") or []),
                "evidence_ids": list(c.get("evidence_ids") or []),
            }
            for c in output.get("claims") or []
        ],
    }


def _doi(value) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if text.startswith(prefix):
            text = text[len(prefix) :]
    return text


def _same_paper(entry: dict, record: dict) -> bool:
    """A paper named by DOI matches by DOI; one without a DOI by its exact title."""
    doi = _doi(entry.get("doi"))
    if doi is not None:
        return doi == _doi(record.get("doi"))
    return bool(entry.get("title")) and entry.get("title") == record.get("title")


def literature_sources(tool_calls: list[dict], documents: dict | None) -> dict:
    """What the run's tools returned, from the recorded calls (every side records them): the
    search results, the resolver's records, the selected PDFs' pages by the DOI they were given
    for (`documents`: DOI → file id, the run's input)."""
    searched, resolved, pages_by_file = [], [], {}
    for call in tool_calls or []:
        if call.get("outcome") != "answered" or not isinstance(call.get("answer"), dict):
            continue
        answer = call["answer"]
        if call.get("tool") == "scholarly-search":
            searched += [p for p in answer.get("papers") or [] if isinstance(p, dict)]
        elif call.get("tool") == "citation-resolver":
            resolved.append(answer)
        elif call.get("tool") == "paper-reader":
            file_id = (call.get("arguments") or {}).get("file_id")
            texts = [p.get("text") or "" for p in answer.get("pages") or [] if isinstance(p, dict)]
            pages_by_file[file_id] = texts + (["\n".join(texts)] if texts else [])
    pdfs = {}
    for doi, file_id in (documents or {}).items():
        pdfs.setdefault(_doi(doi), []).extend(pages_by_file.get(file_id, []))
    return {"searched": searched, "resolved": resolved, "pdfs": pdfs}


def literature_checks(answer, tool_calls: list[dict], *, documents: dict | None = None) -> dict:
    """TS-L's structural ground truth over one run's answer and its recorded tool answers, the same
    function for every side (rule 11; the checks of `scripts/verify_chrome_literature_live.py`'s
    grounding, over what the tools returned rather than over a runtime's internal state):

    - `bibliography_resolved`: every bibliography entry is the best match of a recorded resolver
      answer whose status is `resolved` (by DOI; by exact title when it has none);
    - `quotes_grounded`: every evidence quote is non-empty and occurs verbatim in a source a tool
      returned for its paper (the resolver's or the search's abstract for that DOI, or the pages of
      the PDF selected for it), and its paper is in the bibliography;
    - `claims_supported`: every claim cites existing evidence and bibliography papers;
    - `papers_found_recorded`: every paper listed as found was returned by a search or the resolver.

    A claim is **grounded** when it is supported and every quote it cites is grounded. A review
    that found nothing grounded (no claims) passes every check vacuously and has 0 grounded claims.
    """
    if not valid_review(answer):
        return {"answer_valid": False, "grounded_claims": 0, "checks_passed": False, "checks": {}}
    sources = literature_sources(tool_calls, documents)
    resolved_records = [
        r.get("best_match")
        for r in sources["resolved"]
        if r.get("status") == "resolved" and isinstance(r.get("best_match"), dict)
    ]
    bibliography = {e["paper_id"]: e for e in answer["bibliography"]}
    unresolved = [
        e["paper_id"]
        for e in answer["bibliography"]
        if not any(_same_paper(e, record) for record in resolved_records)
    ]

    def texts_for(paper_id: str) -> list[str]:
        entry = bibliography.get(paper_id)
        if entry is None:
            return []
        texts = [
            r.get("abstract")
            for r in resolved_records + sources["searched"]
            if _same_paper(entry, r) and isinstance(r.get("abstract"), str)
        ]
        texts += sources["pdfs"].get(_doi(entry.get("doi")), [])
        return texts

    grounded_evidence = {
        e["evidence_id"]
        for e in answer["evidence"]
        if e["quote"].strip() and any(e["quote"] in text for text in texts_for(e["paper_id"]))
    }
    evidence_ids = {e["evidence_id"] for e in answer["evidence"]}
    ungrounded = sorted(evidence_ids - grounded_evidence)
    unsupported = [
        c["claim_id"]
        for c in answer["claims"]
        if not set(c["evidence_ids"]) <= evidence_ids
        or not set(c["paper_ids"]) <= set(bibliography)
    ]
    grounded = [
        c["claim_id"]
        for c in answer["claims"]
        if c["claim_id"] not in unsupported
        and set(c["evidence_ids"]) <= grounded_evidence
        and not set(c["paper_ids"]) & set(unresolved)
    ]
    returned = sources["searched"] + resolved_records
    unrecorded = [
        p["title"]
        for p in answer["papers_found"]
        if not any(_same_paper(p, r) or p["title"] == r.get("title") for r in returned)
    ]
    checks = {
        "bibliography_resolved": not unresolved,
        "quotes_grounded": not ungrounded,
        "claims_supported": not unsupported,
        "papers_found_recorded": not unrecorded,
    }
    return {
        "answer_valid": True,
        "grounded_claims": len(grounded),
        "checks_passed": all(checks.values()),
        "checks": checks,
        "failures": {
            "unresolved": unresolved,
            "ungrounded_evidence": ungrounded,
            "unsupported_claims": unsupported,
            "papers_not_returned": unrecorded,
        },
        "counts": {
            "bibliography": len(answer["bibliography"]),
            "evidence": len(answer["evidence"]),
            "claims": len(answer["claims"]),
            "papers_found": len(answer["papers_found"]),
        },
    }


def literature_run(record: dict) -> dict:
    """The run's status and its checks, as `score_literature` reads them (the oracle calls this
    on every side's record)."""
    documents = ((record.get("input") or {}).get("documents")) or {}
    checks = literature_checks(
        record.get("answer"), record.get("tool_calls") or [], documents=documents
    )
    return {"status": record.get("status"), **checks}


def score_literature(run: dict) -> dict:
    """TS-L, structural: completed, at least one grounded claim, every declared check passed."""
    ok = (
        run.get("status") == "completed"
        and (run.get("grounded_claims") or 0) >= 1
        and run.get("checks_passed") is True
    )
    return {"success": ok, "reason": None if ok else "structural"}
