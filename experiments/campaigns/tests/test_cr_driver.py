"""The `Cr` driver's memory context (PROTOCOL.md §2.1): composed as the extension's host does,
both egress scans are active on `Cr` as on `Py`. Offline: the route answers nothing, so a refusal
before the route is the runtime's own. Needs `npm ci` in chrome-agent-browser (the driver is
type-checked and bundled from the core's sources, `driver/cr_driver.py`)."""

from __future__ import annotations

import json

import pytest
from agentpkg.memory.host import cli_memory
from agentpkg.memory.proposals import ProposalRefusal
from campaigns.baseline import ports
from campaigns.driver import cr_driver, py_driver
from campaigns.driver.responder import Responder
from campaigns.driver.routes import Rung
from campaigns.origin.stack import CampaignStack
from campaigns.records import canaries

EMAIL = canaries.by_name("identity.email").value
MESSAGE = f"Find me a flight from Boston to Zurich on 9 March 2027 and send the quote to {EMAIL}."
# A route nobody listens on: a request that reached it would fail as `model_unavailable`.
DEAD = Rung("dead", "ollama", "dead-model", "http://127.0.0.1:9")
PROPOSALS = {
    "schema": "memory.v0 proposals",
    "proposals": [
        {
            "action": "create",
            "type": "travel.preference",
            "title": "Contact",
            "fields": {"kind": "other", "value": f"send quotes to {EMAIL}"},
            "rationale": "The person asked for quotes by e-mail.",
        }
    ],
}

pytestmark = pytest.mark.skipif(
    not cr_driver.TSC.is_file(), reason="needs `npm ci` in chrome-agent-browser"
)


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    with CampaignStack(tmp_path_factory.mktemp("stack")) as running:
        yield running


def _refusals(audit):
    return [
        (e.get("reason"), e.get("pointer")) for e in audit or [] if e["action"] == "model.refused"
    ]


def _cr(tmp_path, *, records=True, probe=None):
    memory_dir = py_driver.prepare_memory(tmp_path, None)
    job = cr_driver.webair_job(
        turns=[MESSAGE],
        rung=None,
        memory_dir=memory_dir,
        stack=None,
        responder=Responder("R-facts"),
        fixture_key=None,
        probe_proposals=probe,
    )
    if not records:
        job["records"], job["memory_grants"] = [], {}
    return cr_driver.run_job(job, timeout=300)


def test_a_sealed_canary_in_a_model_request_is_refused_on_cr_as_on_py(stack, tmp_path):
    cr = _cr(tmp_path / "cr")
    assert _refusals(cr["audit"]) == [("sealed_value_in_model_request", "/email")]
    assert cr["model_calls"] == []  # refused before the route
    assert EMAIL not in json.dumps(cr["audit"])
    py = py_driver.run_webair(
        turns=[MESSAGE],
        rung=DEAD,
        run_dir=tmp_path / "py",
        stack=stack,
        responder=Responder("R-facts"),
        fixture_key=None,
        meta={"run_id": "py", "side": "Py", "task_set": "TS-W"},
    )
    assert _refusals(py["audit"]) == _refusals(cr["audit"])
    assert py["model_calls"] == []
    assert [t["error_code"] for t in py["turns"]] == [
        t["error_code"] for t in cr["transcript"]["turns"]
    ]


def test_without_the_record_set_the_same_request_reaches_the_route(tmp_path):
    """The guard of the test above: the refusal comes from the composed memory context."""
    cr = _cr(tmp_path, records=False)
    assert _refusals(cr["audit"]) == []
    assert len(cr["model_calls"]) == 1


def test_a_proposal_carrying_a_sealed_canary_is_refused_on_both(tmp_path):
    cr = _cr(tmp_path / "cr", probe=PROPOSALS)["refused"]
    package = ports.load("webair")
    grants, flags = py_driver.webair_grants(False)
    memory_run, _folder, _handlers = cli_memory(
        package,
        mode="live",
        decisions=grants,
        memory_dir=py_driver.prepare_memory(tmp_path / "py", None),
        memory_grants=flags,
    )
    with pytest.raises(ProposalRefusal) as refused:
        memory_run.check_proposals(PROPOSALS)
    assert cr is not None and cr["name"] == "ProposalRefusal"
    assert (cr["code"], cr["reason"]) == (refused.value.code, refused.value.reason)
    assert refused.value.reason and "sealed" in refused.value.reason
    benign = json.loads(json.dumps(PROPOSALS).replace(EMAIL, "aisle seats"))
    assert _cr(tmp_path / "cr2", probe=benign)["refused"] is None


def test_no_production_source_names_the_campaign_seams():
    """As the host mapping on `Py` (test_hostmap.py): nothing in the Chrome core or its CLI can
    set the dial mapping, the fixture header or the sampling seam; they live in the driver only."""
    for path in cr_driver.CHROME_SRC.rglob("*.ts"):
        text = path.read_text()
        assert "X-Campaign-Fixture" not in text, path
        assert "syncBuiltinESMExports" not in text, path
    driver = (cr_driver.DRIVER / "driver.ts").read_text()
    assert "syncBuiltinESMExports" in driver and "X-Campaign-Fixture" in driver
