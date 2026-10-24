"""WebAir and the person's memory (memory.v0, T20; a turn of the 0.8.0 conversation), run by the
generic runtime.

The travel profile is read through `memory.read` from a memory folder with agentpkg's own memory
host (`agentpkg.memory.host`, the `--memory-dir` reference); after a quote the `remember` step
may propose one travel preference, which the runtime checks (M-40) before the run completes and
never writes. Every run here holds the demo host's sealed values in its scan set, so a model
request or a proposal that carried a passenger e-mail or a payment identifier would be refused
(M-37, M-40 step 7): the WebAir graph routes none to a model.
"""

import asyncio
import json
import shutil

import pytest
from agentpkg.artifacts import artifact_records
from agentpkg.memory.host import cli_memory, memory_handlers
from agentpkg.memory.run import MemoryRun
from agentpkg.package import load_package
from agentpkg.workflow import WorkflowError

from origin.app import create_app
from publisher.binding import json_http_handlers
from publisher.contract import PACKAGE_SOURCE, REPO_ROOT
from publisher.fixture import ScriptedRouter, converse_package, turn_failure
from publisher.host import host_resource_handlers, resource_value
from publisher.scenarios import WA101_STANDARD, conversation_scenario

MEMORY_EXAMPLE = REPO_ROOT / "spec/memory-v0/examples/webair-0.6.0/memory"
HEAD_PROFILE = "mem_9b8a7c6d5e4f30211203a4b5c6d7e8f9"
ALEX = resource_value("passenger_demo_alex")
VISA = resource_value("payment_demo_visa")
CABIN = {
    "action": "create",
    "type": "travel.preference",
    "title": "Standard fares on WebAir",
    "fields": {"kind": "other", "value": "Economy Standard", "applies_to": "WebAir"},
    "rationale": "You asked to prepare the Standard fare.",
}


@pytest.fixture(scope="module")
def package():
    return load_package(PACKAGE_SOURCE)


@pytest.fixture(scope="module")
def origin_app():
    return create_app()


def demo_scan():
    """The demo host's sealed values (the identity's e-mail, the card's payment id)."""
    return [
        {
            "record_id": "passenger_demo_alex",
            "pointer": "/contact_email",
            "value": ALEX["contact_email"],
        },
        {
            "record_id": "payment_demo_visa",
            "pointer": "/payment_method_id",
            "value": VISA["payment_method_id"],
        },
    ]


def quote_case(remember=None):
    """The quote turn of the capability demo, with the `remember` step's answer scripted."""
    case = conversation_scenario("quote")
    turn = case.turns[0]
    models = {**turn.models, "remember": [remember or {"proposals": []}]}
    return case, turn, models


def booking(package, origin_app, remember, *, grants=None):
    case, turn, models = quote_case(remember)
    grants = case.decisions if grants is None else grants
    grant_list = [
        {
            "permission_id": "identity.passenger",
            "resource_type": "personal.passenger_identity",
            "resource_id": "passenger_demo_alex",
        }
    ]
    memory = MemoryRun(package, grant_list, grants, scan=demo_scan())
    handlers = {
        **json_http_handlers(package, origin_app),
        **host_resource_handlers(package, case.selections),
    }
    return asyncio.run(_run(package, turn.input, ScriptedRouter(models), handlers, grants, memory))


async def _run(package, input_value, router, handlers, grants, memory):
    """One turn of the conversation with its own memory run (V-26); raises what it raised."""
    _, reports = await converse_package(
        package,
        [{"message": input_value}],
        routers=router,
        handlers=handlers,
        grants=grants,
        approved_tools=sorted(package.tools),
        memory=memory,
    )
    report = reports[0]
    if report["status"] != "completed":
        raise turn_failure(report)
    return report


def test_a_quote_proposes_one_preference_and_writes_nothing(package, origin_app):
    report = booking(package, origin_app, {"proposals": [CABIN]})
    assert report["output"]["booking"]["fare_id"] == WA101_STANDARD
    proposed = [e for e in report["audit"] if e["action"] == "memory.proposed"]
    assert [(e["count"], e["types"], e["offered"]) for e in proposed] == [
        (1, ["travel.preference"], 1)
    ]
    files = dict(artifact_records(report, package))
    assert json.loads(files["proposals.json"]) == {
        "schema": "memory.v0 proposals",
        "proposals": [CABIN],
    }
    # The remember step saw the booking summary, never the passenger or the payment method.
    remember = [
        e for e in report["audit"] if e["action"] == "model.called" and e["task"] == "remember"
    ]
    assert len(remember) == 1
    assert not [e for e in report["audit"] if e["action"] == "model.refused"]


def test_nothing_to_remember_is_an_empty_document(package, origin_app):
    report = booking(package, origin_app, {"proposals": []})
    files = dict(artifact_records(report, package))
    assert json.loads(files["proposals.json"])["proposals"] == []


def test_a_proposal_carrying_the_passenger_e_mail_never_leaves_the_run(package, origin_app):
    leaked = {**CABIN, "rationale": f"Booked for {ALEX['contact_email']}."}
    with pytest.raises(WorkflowError) as caught:
        booking(package, origin_app, {"proposals": [leaked]})
    report = caught.value.execution_report
    assert report["memory"]["refused"] == {
        "code": "permission_denied",
        "reason": "sealed_value_in_proposal",
        "index": None,
    }
    assert ALEX["contact_email"] not in json.dumps(report)


def test_a_denied_memory_write_offers_nothing(package, origin_app):
    case, _, _ = quote_case()
    grants = {**case.decisions, "memory.remember": "deny"}
    report = booking(package, origin_app, {"proposals": [CABIN]}, grants=grants)
    proposed = [e for e in report["audit"] if e["action"] == "memory.proposed"][0]
    assert (proposed["offered"], proposed["reason"]) == (0, "permission_denied")


def test_the_profile_is_read_from_a_memory_folder(package, origin_app, tmp_path):
    memory_dir = tmp_path / "memory"
    shutil.copytree(MEMORY_EXAMPLE, memory_dir)
    case = conversation_scenario("profile-search")
    memory, folder, handlers = cli_memory(
        package,
        mode="live",
        decisions=case.decisions,
        memory_dir=memory_dir,
        memory_grants=[f"memory.travel_profile={HEAD_PROFILE}"],
    )
    assert handlers.keys() == memory_handlers(package, folder, memory).keys()
    calls = []
    report = asyncio.run(
        _run(
            package,
            case.input,
            ScriptedRouter(case.turns[0].models),
            {**json_http_handlers(package, origin_app, record=calls), **handlers},
            case.decisions,
            memory,
        )
    )
    search = next(c for c in calls if c["tool"] == "search-flights")["input"]
    assert (search["origin"], search["cabin"], search["nonstop_only"]) == ("BOS", "economy", True)
    reads = [e for e in report["audit"] if e["action"] == "memory.read"]
    assert [(e["permission_id"], e["record_id"]) for e in reads] == [
        ("memory.travel_profile", HEAD_PROFILE)
    ]
    # The run's scan set is the folder's whole store: the demo card and identity included.
    assert {entry["record_id"] for entry in memory.scan} == {
        "mem_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        "mem_4e5f60718293a4b5c6d7e8f90a1b2c3d",
    }


def test_the_publisher_names_a_memory_read_type_it_cannot_copy():
    from publisher.host import host_schema_files, source_policy

    policy = source_policy()
    reads = [p for p in policy["permissions"] if p["kind"] == "memory.read"]
    reads[0]["resources"] = ["loyalty.card"]
    with pytest.raises(ValueError, match="memory.read names loyalty.card"):
        host_schema_files(policy=policy)
