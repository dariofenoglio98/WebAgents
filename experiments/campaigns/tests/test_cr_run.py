"""The `Cr` driver's `run` mode (D-359): one-shot runs composed as `cli-run.ts` composes them, with
the record source composed as for a conversation, so both egress scans are active on a `Cr` run
as on a `Py` run (PROTOCOL.md §2.1, P-13's scope). Offline: the route answers nothing, so a
refusal before the route is the runtime's own. Needs `npm ci` in chrome-agent-browser."""

from __future__ import annotations

import json

import pytest
from campaigns.baseline import ports
from campaigns.driver import cr_driver, py_driver
from campaigns.driver.routes import Rung
from campaigns.origin.stack import CampaignStack
from campaigns.records import canaries

EMAIL = canaries.by_name("identity.email").value
DEAD = Rung("dead", "ollama", "dead-model", "http://127.0.0.1:9")
CASES = {
    "travel-network": {
        "text": f"Plan a trip from Boston to Zurich, 9 to 12 March 2027, for one traveller; "
        f"send the plan to {EMAIL}."
    },
    "literature-review": f"What defenses against prompt injection were proposed? Reply to {EMAIL}.",
}

pytestmark = pytest.mark.skipif(
    not cr_driver.TSC.is_file(), reason="needs `npm ci` in chrome-agent-browser"
)


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    with CampaignStack(tmp_path_factory.mktemp("stack"), resolver=True) as running:
        yield running


def _refusals(audit):
    return [
        (e.get("reason"), e.get("pointer")) for e in audit or [] if e["action"] == "model.refused"
    ]


def _cr_job(name: str, memory_dir, *, records: bool = True) -> dict:
    if name == "travel-network":
        input_value = CASES[name]
        grants, approved = py_driver.TRAVEL_GRANTS, list(ports.load(name).tools)
    else:
        input_value = py_driver.literature_input(CASES[name])
        grants, approved = py_driver.literature_grants(None)
    job = cr_driver.run_job_for(
        name=name,
        input_value=input_value,
        grants=grants,
        approved=approved,
        rung=None,
        memory_dir=memory_dir,
        stack=None,
        fixture_key=None,
    )
    if not records:
        job["records"] = []
    return job


def _py(name: str, tmp_path, stack) -> dict:
    meta = {"side": "Py", "task_set": "TS-N" if name == "travel-network" else "TS-L"}
    if name == "travel-network":
        return py_driver.run_travel_network(
            text=CASES[name]["text"],
            rung=DEAD,
            run_dir=tmp_path / "py",
            stack=stack,
            fixture_key=None,
            meta=meta,
        )
    return py_driver.run_literature_review(
        question=CASES[name],
        rung=DEAD,
        run_dir=tmp_path / "py",
        stack=stack,
        fixture_key=None,
        meta=meta,
    )


@pytest.mark.parametrize("name", sorted(CASES))
def test_a_sealed_canary_in_a_model_request_is_refused_on_a_cr_run_as_on_py(name, stack, tmp_path):
    cr = cr_driver.run_job(
        _cr_job(name, py_driver.prepare_memory(tmp_path / "cr", None)), timeout=300
    )
    assert cr["status"] == "failed"
    assert _refusals(cr["audit"]) == [("sealed_value_in_model_request", "/email")]
    assert cr["model_calls"] == []  # refused before the route
    assert EMAIL not in json.dumps(cr["audit"])
    py = _py(name, tmp_path, stack)
    assert py["status"] == "failed"
    assert _refusals(py["audit"]) == _refusals(cr["audit"])
    assert py["model_calls"] == []
    assert EMAIL not in json.dumps(py["audit"])


def test_without_the_record_set_the_cr_run_sends_the_canary_to_the_route(tmp_path):
    """The guard: the refusal above is the store's scan, not the route; with no records opened the
    same run's request reaches the (refusing) route with the canary in it."""
    job = _cr_job("travel-network", py_driver.prepare_memory(tmp_path, None), records=False)
    cr = cr_driver.run_job(job, timeout=300)
    assert _refusals(cr["audit"]) == []
    assert cr["model_calls"] and EMAIL in json.dumps(cr["model_calls"][0])


CROSSREF_URL = (
    "https://api.crossref.org/works?query.bibliographic=prompt+injection&rows=2"
    "&select=DOI%2Ctitle&filter=type%3Ajournal-article"
)
RESOLVER_URL = "https://webagents-citation-resolver-production.up.railway.app/resolve"
RESOLVER_BODY = json.dumps({"format": "bibtex", "query": "10.1000/x1", "query_type": "auto"})
CROSSREF_ANSWER = {
    "status": "ok",
    "message": {
        "items": [
            {
                "DOI": "10.1000/X1",
                "title": ["A <i>defense</i>"],
                "abstract": "<jats:p>We filter inputs.</jats:p>",
                "URL": "https://doi.org/10.1000/x1",
            },
            {"DOI": "10.1000/x2"},  # no title: skipped, as the core's adapter skips it
        ]
    },
}
RESOLVER_ANSWER = {"status": "resolved", "best_match": {"doi": "10.1000/x1", "title": "A defense"}}


def test_the_run_transport_records_each_call_with_the_cores_tool_and_its_answer():
    """Each request is paired with the core's own `observe` report by its exact URL and body (not
    by order), and the answer is the core's adapter's (the Crossref search reduced to the
    declared result, markup rendered; the resolver's JSON as it came)."""
    job = {
        "mapping": None,
        "probe_record": {
            # observed in the other order than the transport sees the requests
            "observed": [
                {
                    "tool_id": "citation-resolver",
                    "binding_id": "chrome:json_http:citation-resolver:1",
                    "url": RESOLVER_URL,
                    "body": RESOLVER_BODY,
                },
                {
                    "tool_id": "scholarly-search",
                    "binding_id": "chrome:crossref_works_search:scholarly-search:1",
                    "url": CROSSREF_URL,
                    "body": None,
                },
            ],
            "requests": [
                {"url": CROSSREF_URL, "method": "GET", "body": None},
                {"url": RESOLVER_URL, "method": "POST", "body": RESOLVER_BODY},
            ],
            "responses": [
                {"status": 200, "body": json.dumps(CROSSREF_ANSWER)},
                {"status": 200, "body": json.dumps(RESOLVER_ANSWER)},
            ],
        },
    }
    out = cr_driver.run_job(job, timeout=120)
    search, resolve = out["tool_calls"]
    assert out["pending"] == []
    assert search["tool"] == "scholarly-search" and search["outcome"] == "answered"
    assert search["arguments"] == {"query": "prompt injection", "limit": 2}
    assert [p["title"] for p in search["answer"]["papers"]] == ["A defense"]
    assert search["answer"]["papers"][0]["abstract"] == "We filter inputs."
    assert search["answer"]["papers"][0]["doi"] == "10.1000/x1"
    assert resolve["tool"] == "citation-resolver" and resolve["answer"] == RESOLVER_ANSWER
    assert resolve["arguments"] == json.loads(RESOLVER_BODY)
