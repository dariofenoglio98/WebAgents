"""D-360: the frozen payload set (PROTOCOL.md §2.6, §3 E3)."""

from __future__ import annotations

import collections

from campaigns.driver import campaign
from campaigns.origin import catalog

PAYLOADS = catalog.load()


def test_every_e3_family_has_three_frozen_payloads_and_ts_l_its_two():
    families = collections.Counter(
        p["family"] for p in PAYLOADS.values() if p["id"] not in campaign.LITERATURE_PAYLOADS
    )
    for family in catalog.E3_FAMILIES:
        assert families[family] == 3, family
    for payload in PAYLOADS.values():
        if payload["family"] in catalog.E3_FAMILIES:
            assert payload["status"].startswith("frozen"), payload["id"]
    assert {PAYLOADS[p]["family"] for p in campaign.LITERATURE_PAYLOADS} == {"F-UPLOAD", "F-STEER"}


def test_a_familys_payloads_share_placements_matcher_and_boundary():
    by_family = collections.defaultdict(list)
    for payload in PAYLOADS.values():
        if payload["family"] in catalog.E3_FAMILIES and payload["id"] not in (
            campaign.LITERATURE_PAYLOADS
        ):
            by_family[payload["family"]].append(payload)
    for family, payloads in by_family.items():
        shapes = {(tuple(p["placements"]), repr(p["matcher"]), p["boundary"]) for p in payloads}
        assert len(shapes) == 1, family


def test_every_substring_target_is_in_its_text_and_never_in_its_twin():
    import re

    for payload in PAYLOADS.values():
        matcher = payload["matcher"]
        assert len(payload["twin"]) == len(payload["text"])
        if matcher["kind"] == "substring":
            pattern = re.compile(matcher["value"], re.I)
            assert pattern.search(payload["text"]), payload["id"]
            assert not pattern.search(payload["twin"]), payload["id"]
            if payload["boundary"] == "a" and payload["family"] in catalog.E3_FAMILIES:
                assert "model_output" in matcher["fields"], payload["id"]


def test_the_webair_payloads_never_sit_at_the_literature_placements():
    for payload in PAYLOADS.values():
        if payload["id"] in campaign.LITERATURE_PAYLOADS:
            assert payload["placements"] == ["resolver.abstract", "pdf.text"]
        else:
            assert not {"resolver.abstract", "pdf.text"} & set(payload["placements"])


# -- D-362: the status vocabulary ---------------------------------------------------------------
def test_answered_meets_options_found_and_nothing_else_moves():
    from campaigns.tasks import score

    assert score.status_matches("options_found", "answered")
    assert score.status_matches("options_found", "options_found")
    assert not score.status_matches("quoted", "answered")
    assert not score.status_matches("no_matching_flights", "answered")
    assert not score.status_matches("options_found", "done")


def test_a_w2_answer_labelled_answered_is_scored_on_its_facts():
    from campaigns.driver import campaign
    from campaigns.tasks import score

    task = campaign.load_tasks()["W2-01"]
    answer = {
        "status": "answered",
        "selected_fare_id": task["truth"]["selected_fare_id"],
        "quote_id": None,
        "total_usd": None,
        "confirmation_id": None,
        "answer": "Changes cost $150; the fare is not refundable.",
    }
    assert score.score_webair(task, answer) == {"success": True, "reason": None}
    wrong = {**answer, "answer": "Changes are free."}
    assert score.score_webair(task, wrong)["success"] is False


# -- D-361: route failures and timeouts ------------------------------------------------------------
def _rec(**kw):
    return {"status": "failed", "harness_error": None, "turns": [], "model_calls": [], **kw}


def test_a_route_that_never_answered_is_a_harness_error_on_every_side():
    from campaigns.driver import campaign

    py = _rec(model_calls=[{"error": "ConnectError"}])
    fw = _rec(model_calls=[{"outcome": "APIConnectionError"}])
    cr = _rec(
        model_calls=[{"url": "http://127.0.0.1:23079/api/chat"}],
        turns=[{"error_code": "model_unavailable"}],
    )
    for rec in (py, fw, cr):
        assert campaign.promote_route_failure(rec)["status"] == "harness_error"
        assert rec["harness_error"].startswith("route_unavailable")


def test_a_timeout_is_the_runs_own_failure_on_every_side():
    from campaigns.driver import campaign

    for rec in (
        _rec(model_calls=[{"error": "ReadTimeout"}]),
        _rec(model_calls=[{"outcome": "APITimeoutError"}]),
        _rec(model_calls=[{"outcome": "deadline"}]),
        _rec(
            model_calls=[{"url": "u", "status": 200}], turns=[{"error_code": "model_call_timeout"}]
        ),
    ):
        assert campaign.promote_route_failure(rec)["status"] == "failed"


def test_an_outage_delays_the_unit_instead_of_spending_it(monkeypatch):
    import httpx
    from campaigns.driver import campaign
    from campaigns.driver.routes import Rung

    answers = iter([httpx.ConnectError("down"), httpx.ConnectError("down"), None])

    def get(url, timeout):
        outcome = next(answers)
        if outcome is not None:
            raise outcome
        return httpx.Response(200, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", get)
    rung = Rung("L9", "ollama", "qwen3.5:9b", "http://127.0.0.1:9")
    assert campaign.route_ready(rung, wait_seconds=5, poll=0) is True
    monkeypatch.setattr(
        httpx, "get", lambda url, timeout: (_ for _ in ()).throw(httpx.ConnectError("down"))
    )
    assert campaign.route_ready(rung, wait_seconds=0, poll=0) is False
    hosted = Rung("H", "openai", "gpt-5.6-luna", "https://api.openai.com")
    assert campaign.route_ready(hosted) is True
