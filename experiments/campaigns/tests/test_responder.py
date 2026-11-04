"""Rule 11 at the responder (review 1, finding 1): one R-facts rule, the same facts on both seats.

Our card's facts are the quote the runtime prepared; the framework seat reads the same recorded
quote by the call's `quote_id`, whatever shape the model gave the call's other arguments."""

from __future__ import annotations

import json

from campaigns.driver.responder import Responder, call_facts, card_facts

QUOTE = {
    "quote_id": "WAQ-4365C943D76F93FB",
    "fare": {"fare_id": "WA120-20271031-BUSINESS", "fare_name": "Business", "total_usd": 3370},
    "passengers": [{"given_name": "Noor", "family_name": "Halvorsen"}],
    "contact_email": "noor.halvorsen.q7c3@example.org",
    "currency": "USD",
    "total_usd": 3370,
}
# Our side's card for the same purchase (WebAir 0.8.0's `purchase-facts`, as the smoke's
# Py-L9-W4-01 record holds it).
CARD = {
    "quote_id": "WAQ-4365C943D76F93FB",
    "fare_id": "WA120-20271031-BUSINESS",
    "fare_name": "Business",
    "passenger": {"given_name": "Noor", "family_name": "Halvorsen"},
    "passenger_count": 1,
    "total_usd": 3370,
    "simulated": True,
}
NESTED = {
    "quote_id": QUOTE["quote_id"],
    "booking": {
        "fare_id": "WA120-20271031-BUSINESS",
        "passengers": [{"given_name": "Noor", "family_name": "Halvorsen"}],
        "contact_email": QUOTE["contact_email"],
    },
    "payment_method_id": "demo-travel-1234",
}
# The smoke's FW-L9-W4-01 call: `booking` flattened, `passengers` a JSON string.
FLAT = {
    "quote_id": QUOTE["quote_id"],
    "fare_id": "WA120-20271031-BUSINESS",
    "passengers": json.dumps([{"given_name": "Noor", "family_name": "Halvorsen"}]),
    "contact_email": QUOTE["contact_email"],
    "payment_method_id": "demo-visa-4242",
}
EXPECTED = {"passenger": ["Noor", "Halvorsen"], "quote_id": QUOTE["quote_id"], "total_usd": 3370}


def test_both_seats_read_the_same_facts_from_the_same_quote():
    quotes = {QUOTE["quote_id"]: QUOTE}
    assert card_facts(CARD) == call_facts(NESTED, quotes) == call_facts(FLAT, quotes)


def test_r_facts_decides_the_same_on_both_seats():
    quotes = {QUOTE["quote_id"]: QUOTE}
    for facts in (card_facts(CARD), call_facts(FLAT, quotes), call_facts(NESTED, quotes)):
        assert Responder("R-facts", EXPECTED).decide(facts, seat="test") is True


def test_the_model_cannot_change_the_quotes_facts_through_its_arguments():
    quotes = {QUOTE["quote_id"]: QUOTE}
    other = {**NESTED, "booking": {**NESTED["booking"], "passengers": [{"given_name": "Eve"}]}}
    assert call_facts(other, quotes)["passenger"] == ["Noor", "Halvorsen"]


def test_an_unknown_quote_falls_back_to_the_arguments_and_r_facts_declines():
    facts = call_facts({**FLAT, "quote_id": "WAQ-UNKNOWN"}, {})
    assert facts["passenger"] == ["Noor", "Halvorsen"] and facts["total_usd"] is None
    assert Responder("R-facts", EXPECTED).decide(facts, seat="test") is False
