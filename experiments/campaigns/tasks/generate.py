"""The campaign task sets with ground truth (PROTOCOL.md §2.3, D-340; T31 D-356).

    agentpkg/.venv/bin/python experiments/campaigns/tasks/generate.py          # write
    agentpkg/.venv/bin/python experiments/campaigns/tasks/generate.py --check  # compare, write
    nothing

Ground truth is never written by hand or by a model: it is computed here, in process, by WebAir's
own service code (`demo/webair/origin/service.py`, `travel.py`) for the campaign record set's
traveler. The phrasings are the hand-written templates of `phrasings.json`; this module only fills
their placeholders. Every sampled choice comes from SEED. The output files are canonical JSON with a
trailing newline, so a regeneration is byte-identical (tests/test_tasks.py).
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import date, timedelta
from pathlib import Path

import campaigns  # noqa: F401  (puts WebAir's origin on the path)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]

from origin.models import (  # noqa: E402
    GetFareRulesRequest,
    PassengerName,
    PrepareBookingRequest,
    SearchFlightsRequest,
    SimulatePurchaseRequest,
)
from origin.service import WebAirError, WebAirService  # noqa: E402
from origin.travel import CALENDAR, HOTELS, FlightsRequest, TravelPartners  # noqa: E402

from origin import inventory as inv  # noqa: E402

SEED = 31
PHRASINGS = HERE / "phrasings.json"
SCENARIOS = ROOT / "examples" / "webair-scenarios.json"
OUTPUTS = ("ts-w.json", "ts-c.json", "ts-l.json", "ts-n.json")

# The campaign record set's traveler (records/memory/person.identity, payment.card): the only party
# WebAir 0.8.0 quotes (PROTOCOL.md §2.3, W3). tests/test_tasks.py pins these to the folder.
TRAVELER = {"given_name": "Noor", "family_name": "Halvorsen"}
CONTACT_EMAIL = "noor.halvorsen.q7c3@example.org"
PAYMENT_METHOD_ID = "demo-travel-1234"

FAMILY_WORDS = {"BASIC": "Basic", "STANDARD": "Standard", "FLEX": "Flex", "BUSINESS": "Business"}
WINDOW = (date(2027, 1, 4), date(2027, 11, 26))  # inside the bookable window, after the campaigns


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=1, sort_keys=False) + "\n"


def spellings(day: date) -> dict[str, str]:
    return {
        "date_a": f"{day.day} {day.strftime('%B')} {day.year}",
        "date_b": f"{day.strftime('%B')} {day.day}, {day.year}",
        "date_c": day.isoformat(),
    }


def city(code: str) -> str:
    return {"JFK": "New York JFK"}.get(code, inv.AIRPORTS[code].city)


def routes() -> list[tuple[str, str]]:
    found = set()
    for itinerary in inv.ITINERARIES:
        first = inv.SEGMENTS[itinerary.flight_numbers[0]]
        last = inv.SEGMENTS[itinerary.flight_numbers[-1]]
        found.add((first.origin, last.destination))
    return sorted(found)


def random_day(rng: random.Random) -> date:
    span = (WINDOW[1] - WINDOW[0]).days
    return WINDOW[0] + timedelta(days=rng.randrange(span))


def phrased(templates: list[str], params: dict) -> list[str]:
    return [template.format(**params) for template in templates]


class Truth:
    """Ground truth from WebAir's own service, in process."""

    def __init__(self) -> None:
        self.service = WebAirService()
        self.partners = TravelPartners(self.service)

    def search(self, origin, destination, day, **criteria):
        request = SearchFlightsRequest(
            origin=origin, destination=destination, date=day.isoformat(), passengers=1, **criteria
        )
        return self.service.search_flights(request)

    def fares(self, origin, destination, day, **criteria) -> list:
        found = self.search(origin, destination, day, **criteria)
        return [(flight, fare) for flight in found.flights for fare in flight.fares]

    def rules(self, fare_id: str):
        return self.service.get_fare_rules(GetFareRulesRequest(fare_id=fare_id, passengers=1))

    def quote(self, fare_id: str):
        return self.service.prepare_booking(
            PrepareBookingRequest(
                fare_id=fare_id,
                passengers=[PassengerName(**TRAVELER)],
                contact_email=CONTACT_EMAIL,
            )
        )

    def purchase(self, fare_id: str):
        quote = self.quote(fare_id)
        booking = PrepareBookingRequest(
            fare_id=fare_id, passengers=[PassengerName(**TRAVELER)], contact_email=CONTACT_EMAIL
        )
        return quote, self.service.simulate_purchase(
            SimulatePurchaseRequest(
                booking=booking, quote_id=quote.quote_id, payment_method_id=PAYMENT_METHOD_ID
            )
        )


def unique_cheapest(pairs) -> str | None:
    if not pairs:
        return None
    pairs = sorted(pairs, key=lambda p: p[1].price_usd)
    if len(pairs) > 1 and pairs[0][1].price_usd == pairs[1][1].price_usd:
        return None
    return pairs[0][1].fare_id


def flight_label(fare_id: str) -> str:
    """`WA213-WA741-20270309-FLEX` → `WA213/WA741`."""
    return "/".join(part for part in fare_id.split("-") if part.startswith("WA"))


# --- TS-W ---------------------------------------------------------------------------------------


def w1_candidate(truth: Truth, rng: random.Random, kind: str):
    origin, destination = rng.choice(routes())
    day = random_day(rng)
    params = {"origin": origin, "destination": destination}
    criteria: dict = {}
    if kind == "nonstop":
        criteria["nonstop_only"] = True
    elif kind == "business":
        criteria["cabin"] = "business"
    pairs = truth.fares(origin, destination, day, **criteria)
    if kind == "bag":
        pairs = [(f, fare) for f, fare in pairs if inv.FARE_FAMILIES[fare.fare_family].checked_bags]
    if kind == "under":
        prices = sorted({fare.price_usd for _, fare in pairs})
        if len(prices) < 3:
            return None
        # A threshold that excludes some fares and keeps the cheapest: a round figure.
        limit = ((prices[1] + prices[-1]) // 2 // 50) * 50
        if limit <= prices[0]:
            return None
        params["max_price"] = limit
        pairs = [(f, fare) for f, fare in pairs if fare.price_usd <= limit]
    if kind == "cheapest" and len({fare.price_usd for _, fare in pairs}) < 2:
        return None
    selected = unique_cheapest(pairs)
    if selected is None:
        return None
    return day, params, {"status": "options_found", "selected_fare_id": selected}


def build_ts_w(truth: Truth, rng: random.Random, templates: dict, scenarios: dict) -> list[dict]:
    tasks: list[dict] = []

    def add(cls, shape, day, params, truth_value, texts, source):
        tasks.append(
            {
                "id": f"{cls}-{sum(1 for t in tasks if t['class'] == cls) + 1:02d}",
                "class": cls,
                "shape": shape,
                "source": source,
                "params": {
                    k: v
                    for k, v in params.items()
                    if not k.startswith(("date_", "origin_c", "destination_c"))
                }
                | ({"date": day.isoformat()} if day else {}),
                "phrasings": texts,
                "truth": truth_value,
            }
        )

    scenario = {s["id"]: s for s in scenarios["scenarios"]}
    # W1's first three are examples/webair-scenarios.json's searches; W2's first is its fare-rules
    # scenario; W5 is its four negatives (D-356; PROTOCOL.md §9.2, 2026-11-04).
    for name in ("hero", "checked-bag", "other-route"):
        expect = scenario[name]["expect"]
        add(
            "W1",
            name,
            None,
            {},
            {"status": expect["status"], "selected_fare_id": expect["selected_fare_id"]},
            templates["scenario"][name],
            "examples/webair-scenarios.json",
        )
    kinds = ["cheapest", "nonstop", "under", "business", "bag"]
    seen: set[str] = {t["truth"]["selected_fare_id"] for t in tasks}
    index = 0
    while sum(1 for t in tasks if t["class"] == "W1") < 16:
        kind = kinds[index % len(kinds)]
        candidate = w1_candidate(truth, rng, kind)
        if candidate is None or candidate[2]["selected_fare_id"] in seen:
            continue
        index += 1
        day, params, value = candidate
        seen.add(value["selected_fare_id"])
        full = (
            params
            | spellings(day)
            | {
                "origin_city": city(params["origin"]),
                "destination_city": city(params["destination"]),
            }
        )
        add("W1", kind, day, params, value, phrased(templates["W1"][kind], full), "generated")

    # W2: a fact of one fare, from the service's fare rules.
    fare_rules = truth.rules(scenario["fare-rules"]["expect"]["selected_fare_id"])
    add(
        "W2",
        "fare-rules",
        None,
        {},
        {
            "status": "options_found",
            "selected_fare_id": fare_rules.fare_id,
            "facts": {
                "change_fee_usd": fare_rules.changes.fee_usd,
                "changes_allowed": fare_rules.changes.allowed,
                "refundable": fare_rules.refunds.refundable,
            },
        },
        templates["scenario"]["fare-rules"],
        "examples/webair-scenarios.json",
    )
    w2_kinds = ["change_fee", "refundable"]
    index = 0
    while sum(1 for t in tasks if t["class"] == "W2") < 8:
        kind = w2_kinds[index % 2]
        origin, destination = rng.choice(routes())
        day = random_day(rng)
        pairs = truth.fares(origin, destination, day)
        if not pairs:
            continue
        _, fare = rng.choice(pairs)
        if fare.fare_id in seen:
            continue
        index += 1
        seen.add(fare.fare_id)
        rules = truth.rules(fare.fare_id)
        facts = (
            {"change_fee_usd": rules.changes.fee_usd, "changes_allowed": rules.changes.allowed}
            if kind == "change_fee"
            else {"refundable": rules.refunds.refundable}
        )
        params = {
            "origin": origin,
            "destination": destination,
            "fare_id": fare.fare_id,
            "flight_label": flight_label(fare.fare_id),
            "family_name": FAMILY_WORDS[fare.fare_family],
        }
        full = (
            params
            | spellings(day)
            | {
                "origin_city": city(origin),
                "destination_city": city(destination),
            }
        )
        add(
            "W2",
            kind,
            day,
            params,
            {"status": "options_found", "selected_fare_id": fare.fare_id, "facts": facts},
            phrased(templates["W2"][kind], full),
            "generated",
        )

    # W3: a quote of a named fare for the record set's traveler; W4: the same, then "buy it".
    for cls, count in (("W3", 8), ("W4", 4)):
        while sum(1 for t in tasks if t["class"] == cls) < count:
            origin, destination = rng.choice(routes())
            day = random_day(rng)
            pairs = truth.fares(origin, destination, day)
            if not pairs:
                continue
            _, fare = rng.choice(pairs)
            if fare.fare_id in seen:
                continue
            seen.add(fare.fare_id)
            params = {
                "origin": origin,
                "destination": destination,
                "fare_id": fare.fare_id,
                "flight_label": flight_label(fare.fare_id),
                "family_name": FAMILY_WORDS[fare.fare_family],
            }
            full = (
                params
                | spellings(day)
                | {
                    "origin_city": city(origin),
                    "destination_city": city(destination),
                }
            )
            texts = phrased(templates["W3"]["quote"], full)
            if cls == "W3":
                quote = truth.quote(fare.fare_id)
                value = {
                    "status": "quoted",
                    "selected_fare_id": fare.fare_id,
                    "quote_id": quote.quote_id,
                    "total_usd": quote.total_usd,
                    "passengers": 1,
                }
                add(cls, "quote", day, params, value, texts, "generated")
            else:
                quote, confirmation = truth.purchase(fare.fare_id)
                value = {
                    "status": "purchase_simulated",
                    "quote_id": quote.quote_id,
                    "total_usd": quote.total_usd,
                    "confirmation_id": confirmation.confirmation_id,
                    "consent_cards": 1,
                    "purchases": 1,
                }
                turns = [
                    [text, buy] for text, buy in zip(texts, templates["W4"]["buy"], strict=True)
                ]
                add(cls, "quote-then-buy", day, params, value, turns, "generated")

    for name, status in (
        ("no-results", "no_matching_flights"),
        ("refused", "request_refused"),
        ("unsupported", "request_not_supported"),
        ("no-departure", "request_not_supported"),
    ):
        assert scenario[name]["expect"]["status"] == status, name
        add(
            "W5",
            name,
            None,
            {},
            {"status": status, "selected_fare_id": None},
            templates["scenario"][name],
            "examples/webair-scenarios.json",
        )
    return tasks


# --- TS-C ---------------------------------------------------------------------------------------


def nonstop_fares(truth: Truth, rng: random.Random):
    while True:
        origin, destination = rng.choice(routes())
        day = random_day(rng)
        pairs = truth.fares(origin, destination, day, nonstop_only=True)
        everything = truth.fares(origin, destination, day)
        cheapest_all = unique_cheapest(everything)
        cheapest_nonstop = unique_cheapest(pairs)
        if pairs and cheapest_all and cheapest_nonstop and cheapest_all != cheapest_nonstop:
            return origin, destination, day, pairs, cheapest_all, cheapest_nonstop


def build_ts_c(truth: Truth, rng: random.Random, templates: dict) -> list[dict]:
    transcripts: list[dict] = []
    plan = [("refine", 3), ("history", 3), ("book", 4), ("rebuy", 2)]
    for shape, count in plan:
        for index in range(count):
            origin, destination, day, pairs, cheapest_all, cheapest_nonstop = nonstop_fares(
                truth, rng
            )
            variant = index % 3
            params = {"origin": origin, "destination": destination}
            expected: list[dict]
            consent = {"cards": 0, "purchases": 0}
            if shape == "refine":
                expected = [
                    {
                        "status": "options_found",
                        "intent": "search",
                        "selected_fare_id": cheapest_all,
                    },
                    {
                        "status": "options_found",
                        "intent": "search",
                        "selected_fare_id": cheapest_nonstop,
                    },
                    {"status": "done", "intent": "done"},
                ]
            elif shape == "history":
                expected = [
                    {
                        "status": "options_found",
                        "intent": "search",
                        "selected_fare_id": cheapest_nonstop,
                    },
                    {"mentions_fare_id": cheapest_nonstop},
                    {"status": "done", "intent": "done"},
                ]
            else:
                _, fare = rng.choice(pairs)
                params |= {
                    "fare_id": fare.fare_id,
                    "flight_label": flight_label(fare.fare_id),
                    "family_name": FAMILY_WORDS[fare.fare_family],
                }
                quote, confirmation = truth.purchase(fare.fare_id)
                quoted = {
                    "status": "quoted",
                    "intent": "quote",
                    "quote_id": quote.quote_id,
                    "total_usd": quote.total_usd,
                }
                bought = {
                    "status": "purchase_simulated",
                    "intent": "purchase",
                    "quote_id": quote.quote_id,
                    "confirmation_id": confirmation.confirmation_id,
                }
                consent = {"cards": 1, "purchases": 1}
                if shape == "book":
                    expected = [
                        {
                            "status": "options_found",
                            "intent": "search",
                            "selected_fare_id": cheapest_nonstop,
                        },
                        quoted,
                        bought,
                        {"status": "done", "intent": "done"},
                    ]
                else:
                    # A second "buy it" after the purchase: no second card, no second purchase.
                    expected = [quoted, bought, {"no_new_purchase": True}]
            full = (
                params
                | spellings(day)
                | {
                    "origin_city": city(origin),
                    "destination_city": city(destination),
                }
            )
            transcripts.append(
                {
                    "id": f"C-{len(transcripts) + 1:02d}",
                    "shape": shape,
                    "params": params | {"date": day.isoformat()},
                    "variant": variant,
                    "turns": [t.format(**full) for t in templates[shape][variant]],
                    "expect": expected,
                    "consent": consent,
                }
            )
    return transcripts


# --- TS-L ---------------------------------------------------------------------------------------


def build_ts_l(templates: dict) -> list[dict]:
    fixture = json.loads((ROOT / "agents/literature-review/fixtures/workflow.json").read_text())
    tasks = [
        {
            "id": "L1",
            "source": "agents/literature-review/fixtures/workflow.json",
            "question": fixture["input"]["question"],
        }
    ]
    for index, name in enumerate(
        (
            "examples/literature-review-live-input.json",
            "examples/literature-review-live-input-prompt-injection.json",
            "examples/literature-review-live-input-prompt-injection-recent.json",
        ),
        start=2,
    ):
        tasks.append(
            {
                "id": f"L{index}",
                "source": name,
                "question": json.loads((ROOT / name).read_text())["question"],
            }
        )
    for extra in templates["extra"]:
        tasks.append({"id": extra["id"], "source": "phrasings.json", "question": extra["question"]})
    for task in tasks:
        # Structural ground truth (§2.3): completes, at least one grounded claim, every declared
        # check passed. The literature changes, so no answer is fixed.
        task["truth"] = {"structural": True, "min_grounded_claims": 1, "all_checks_passed": True}
    return tasks


# --- TS-N ---------------------------------------------------------------------------------------

TRAVELLER_WORDS = {
    1: "one traveller",
    2: "two travellers",
    3: "three travellers",
    4: "four travellers",
    5: "five travellers",
    6: "six travellers",
}


def build_ts_n(truth: Truth, rng: random.Random, templates: dict) -> list[dict]:
    requests: list[dict] = []
    conflicts_wanted = 10
    while len(requests) < 20:
        origin, destination = rng.choice([r for r in routes() if r[1] in HOTELS])
        want_conflict = sum(1 for r in requests if r["truth"]["conflict"]) < conflicts_wanted and (
            len(requests) % 2 == 0
        )
        if want_conflict:
            anchor = date.fromisoformat(rng.choice(CALENDAR)[0])
            out = anchor - timedelta(days=rng.randrange(0, 4))
        else:
            out = random_day(rng)
        back = out + timedelta(days=rng.randrange(2, 8))
        travellers = rng.randrange(1, inv.MAX_PASSENGERS + 1)
        try:
            flights = truth.partners.flights(
                FlightsRequest(
                    origin=origin,
                    destination=destination,
                    date=out.isoformat(),
                    travellers=travellers,
                )
            )
        except WebAirError:
            continue
        options = sorted(flights.options, key=lambda row: row.price_usd)
        if not options or (len(options) > 1 and options[0].price_usd == options[1].price_usd):
            continue
        entries = [(d, t) for d, t in CALENDAR if out <= date.fromisoformat(d) <= back]
        if want_conflict and not entries:
            continue
        if not want_conflict and entries:
            continue
        params = {
            "origin": origin,
            "destination": destination,
            "date_out": out.isoformat(),
            "date_back": back.isoformat(),
            "travellers": travellers,
        }
        out_s, back_s = spellings(out), spellings(back)
        full = params | {
            "origin_city": city(origin),
            "destination_city": city(destination),
            "travellers_words": TRAVELLER_WORDS[travellers],
            "date_out_a": out_s["date_a"],
            "date_out_b": out_s["date_b"],
            "date_out_c": out_s["date_c"],
            "date_back_a": back_s["date_a"],
            "date_back_b": back_s["date_b"],
            "date_back_c": back_s["date_c"],
        }
        requests.append(
            {
                "id": f"N-{len(requests) + 1:02d}",
                "params": params,
                "phrasings": phrased(templates["trip"], full),
                "truth": {
                    "cheapest_flight_id": options[0].id,
                    "hotel_ids": [hotel_id for hotel_id, _, _ in HOTELS[destination]],
                    "hotel_names": [name for _, name, _ in HOTELS[destination]],
                    "nights": (back - out).days,
                    "conflict": bool(entries),
                    "conflict_entries": [{"date": d, "title": t} for d, t in entries],
                },
            }
        )
    return requests


def build() -> dict[str, str]:
    templates = json.loads(PHRASINGS.read_text())
    scenarios = json.loads(SCENARIOS.read_text())
    truth = Truth()
    rng = random.Random(SEED)
    header = {
        "generator": "experiments/campaigns/tasks/generate.py",
        "seed": SEED,
        "protocol": "experiments/PROTOCOL.md §2.3",
    }
    ts_w = build_ts_w(truth, random.Random(f"{SEED}-W"), templates["ts-w"], scenarios)
    ts_c = build_ts_c(truth, random.Random(f"{SEED}-C"), templates["ts-c"])
    ts_l = build_ts_l(templates["ts-l"])
    ts_n = build_ts_n(truth, random.Random(f"{SEED}-N"), templates["ts-n"])
    del rng
    return {
        "ts-w.json": canonical(header | {"task_set": "TS-W", "tasks": ts_w}),
        "ts-c.json": canonical(header | {"task_set": "TS-C", "transcripts": ts_c}),
        "ts-l.json": canonical(header | {"task_set": "TS-L", "questions": ts_l}),
        "ts-n.json": canonical(header | {"task_set": "TS-N", "requests": ts_n}),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare with the committed files")
    args = parser.parse_args(argv)
    files = build()
    stale = [
        name
        for name, text in files.items()
        if not (HERE / name).exists() or (HERE / name).read_text() != text
    ]
    if args.check:
        print(json.dumps({"stale": stale, "passed": not stale}))
        return 1 if stale else 0
    for name, text in files.items():
        (HERE / name).write_text(text)
    print(json.dumps({"written": sorted(files)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
