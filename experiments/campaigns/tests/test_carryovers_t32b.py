"""T32 review 3's carry-overs (D-427), each with a test that fails on `main` as merged 5bee92b."""

from __future__ import annotations

import json

import pytest
from campaigns.driver import campaign, cr_driver
from campaigns.driver.routes import Rung

L30 = Rung("L30", "ollama", "qwen3:30b", "http://127.0.0.1:11434")


# -- carry-over 1: a throttled call that outlasts its step is a harness error on every side --------
def _rec(side, *, calls=(), waits=(), code="model_call_timeout", status="failed"):
    return {
        "meta": {"side": side},
        "status": status,
        "harness_error": None,
        "turns": [{"turn": 1, "status": "failed", "error_code": code}],
        "model_calls": list(calls),
        "rate_limit_waits": list(waits),
        "audit": [],
    }


@pytest.mark.parametrize("side", ["Py", "Cr"])
def test_an_unanswered_call_that_waited_on_429s_is_a_harness_error(side):
    """`Py`: a node timeout cancels the call while it waits; its entry has the waits, no answer."""
    rec = _rec(side, calls=[{"at": 1.0, "rate_limit_waits": [2, 4, 8]}], code=None)
    out = campaign.promote_throttled_timeout(rec)
    assert out["status"] == "harness_error"
    assert out["harness_error"].startswith("rate_limited_timeout: 14")


def test_fw_whose_run_waited_and_timed_out_is_a_harness_error():
    out = campaign.promote_throttled_timeout(_rec("FW-none", waits=[2, 4]))
    assert out["status"] == "harness_error"


def test_waits_on_answered_calls_or_a_completed_run_change_nothing():
    answered = {"rate_limit_waits": [2], "usage": {"input_tokens": 1}, "outcome": "ok"}
    rec = _rec("Py", calls=[answered], code="model_output_not_conforming")
    assert campaign.promote_throttled_timeout(rec)["status"] == "failed"
    done = _rec("FW", waits=[2], status="completed", code=None)
    assert campaign.promote_throttled_timeout(done)["status"] == "completed"
    plain_timeout = _rec("FW", waits=[])
    assert campaign.promote_throttled_timeout(plain_timeout)["status"] == "failed"


def test_run_unit_applies_the_promotion():
    import inspect

    source = inspect.getsource(campaign.run_unit)
    assert (
        source.index("promote_route_failure(rec)")
        < source.index("promote_throttled_timeout(rec)")
        < source.index("record.write(run_dir, rec)")
    )


# -- carry-over 2: `Cr`'s model seam keyed by the request ----------------------------------------
@pytest.mark.skipif(not cr_driver.TSC.is_file(), reason="needs `npm ci` in chrome-agent-browser")
def test_cr_writes_each_answer_on_its_own_request_when_calls_overlap():
    """Three requests observed in order and in flight at once, answered last first (Literature
    Review's maps): each entry gets its own status, usage and text. On `main` every answer was
    written on the last entry pushed, so two entries had none."""
    bodies = [json.dumps({"n": i}) for i in range(3)]
    answers = [
        {
            "delay_ms": 300 - 100 * i,
            "body": json.dumps(
                {
                    "message": {"content": f"answer {i}"},
                    "prompt_eval_count": 10 + i,
                    "eval_count": i,
                }
            ),
        }
        for i in range(3)
    ]
    job = {
        "mapping": None,
        "route": cr_driver.route_of(L30),
        "probe_concurrent": {"bodies": bodies, "answers": answers},
    }
    out = cr_driver.run_job(job, timeout=120)
    assert out["probe"] == "concurrent"
    calls = out["model_calls"]
    assert [c["text"] for c in calls] == ["answer 0", "answer 1", "answer 2"]
    assert [c["usage"]["input_tokens"] for c in calls] == [10, 11, 12]
    assert all(c["status"] == 200 for c in calls)
