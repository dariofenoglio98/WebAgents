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
_ANSWER = Draft202012Validator(ANSWER_SCHEMA)
_NETWORK = Draft202012Validator(NETWORK_SCHEMA)


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


def score_literature(run: dict) -> dict:
    """TS-L, structural: completed, at least one grounded claim, every declared check passed."""
    ok = (
        run.get("status") == "completed"
        and (run.get("grounded_claims") or 0) >= 1
        and run.get("checks_passed") is True
    )
    return {"success": ok, "reason": None if ok else "structural"}
