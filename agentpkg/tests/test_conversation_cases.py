"""conversation.v0 enforcement cases (examples/conversation/cases/cases.json): every case ends at
the stage with the code the list expects, on the reference runtime. The same list is the catalog
v2's conversation family and the conformance suite's input (T24, T27)."""

import asyncio
import json

import pytest
from conversation_probe import CASES, VARIANTS, grants, transcript, write_probe

from agentpkg.cli import main
from agentpkg.conversation import Conversation
from agentpkg.conversation.transcript import check_transcript
from agentpkg.errors import ValidationError
from agentpkg.execution.errors import ExecutionError
from agentpkg.execution.policy import HostExecutionLimits, check_capabilities
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import load_package

CASE_LIST = json.loads((CASES / "cases.json").read_text())


class SilentConsent:
    """A host whose person never answers."""

    def __init__(self):
        self.used = set()

    async def decide(self, request):
        await asyncio.sleep(3600)


class InvalidConsent:
    def __init__(self):
        self.used = set()

    async def decide(self, request):
        return {"accepted": "yes", "decided_by": "nobody"}


def _build(tmp_path, case):
    options = {}
    if case.get("remote_tool"):
        options["remote_tool"] = True
    mutate = VARIANTS[case["variant"]] if case.get("variant") else None
    return write_probe(tmp_path / "probe", mutate=mutate, **options)


def _transcript(case):
    if "transcript_raw" in case:
        return case["transcript_raw"]
    turns = [tuple(t) if isinstance(t, list) else t for t in case.get("transcript", [])]
    return transcript(*turns)


def _converse(package, case):
    decisions = grants(**case.get("grants", {}))
    document = _transcript(case)
    check_transcript(document, package, decisions)
    router, handlers, _ = fixture_adapters(package)
    hosts = {"silent": SilentConsent, "invalid": InvalidConsent}
    consent = None
    if case.get("host"):
        consent = lambda turn, decisions, cls=hosts[case["host"]]: cls()  # noqa: E731
    if case.get("host") == "silent":
        # The node's timeout bounds the wait: one second here, so the case runs quickly.
        for node in package.graph["nodes"]:
            if node["type"] == "consent":
                node["timeout_seconds"] = 1
    conversation = Conversation(
        package,
        grants=decisions,
        approved_tools=["place"],
        adapters=lambda turn: {"router": router, "handlers": handlers},
        limits=case.get("limits"),
        consent=consent,
    )
    return asyncio.run(conversation.run(document))


@pytest.mark.parametrize("case", CASE_LIST["cases"], ids=lambda c: c["id"])
def test_enforcement_case(case, tmp_path, capsys):
    source = _build(tmp_path, case)
    stage = case["stage"]
    if stage == "validation":
        with pytest.raises(ValidationError, match=f"^{case['code']}: "):
            load_package(source)
        return
    package = load_package(source)
    if stage == "start":
        if case.get("path") == "run":
            status = main(
                [
                    "run",
                    str(source),
                    "--grants",
                    str(_grants_file(tmp_path)),
                    "--approve-tool",
                    "place",
                    "--out",
                    str(tmp_path / "out"),
                ]
            )
            assert status == 2
            assert case["code"] in capsys.readouterr().err
            return
        with pytest.raises(ValidationError, match=f"^{case['code']}: "):
            check_transcript(_transcript(case), package, grants(**case.get("grants", {})))
        return
    if stage == "host":
        with pytest.raises(ExecutionError) as caught:
            check_capabilities(package, HostExecutionLimits())
        assert caught.value.code == case["code"]
        return
    result = _converse(package, case)
    record = result["transcript"]
    expect = case.get("expect", {})
    statuses = [turn["status"] for turn in record["turns"]]
    if stage == "turn":
        refused = [turn for turn in record["turns"] if turn["status"] == "refused"]
        assert refused and refused[0]["refusal"] == case["reason"]
        events = [e for e in result["audit"] if e["action"] == "turn.refused"]
        assert [e["reason"] for e in events] == [case["reason"]]
    else:
        if case["code"] == "completed":
            assert result["status"] == "completed", statuses
        else:
            failed = [turn for turn in record["turns"] if turn["status"] == "failed"]
            assert failed, statuses
            assert failed[0]["error_code"] == case["code"]
            node_failures = [
                e
                for e in result["audit"]
                if e["action"] == "node.failed" and e.get("node_id") == expect.get("node")
            ]
            if expect.get("node"):
                assert node_failures and node_failures[0]["error_code"] == case["code"]
        if case.get("reason"):
            checks = [
                e
                for e in result["audit"]
                if e["action"] == "permission.checked" and e.get("reason") == case["reason"]
            ]
            assert checks and checks[0]["allowed"] is False
    if "turns" in expect:
        assert statuses == expect["turns"]
    tool_calls = len([e for e in result["audit"] if e["action"] == "tool.called"])
    if expect.get("tool_called") is False:
        assert tool_calls == 0
    if "tool_calls" in expect:
        assert tool_calls == expect["tool_calls"]
    if "ended" in expect:
        assert result["ended"]["reason"] == expect["ended"]
    if "decided_by" in expect:
        decided = [e for e in result["audit"] if e["action"] == "consent.decided"]
        assert decided and decided[0]["decided_by"] == expect["decided_by"]
        assert decided[0]["reason"] == expect.get("reason")
    if "decided" in expect:
        # Every decision of the conversation, in order, as the chain and the transcript hold it.
        keys = ("step", "accepted", "decided_by", "reason")
        decided = [e for e in result["audit"] if e["action"] == "consent.decided"]
        assert [{k: e[k] for k in keys} for e in decided] == expect["decided"]
        taken = [d for turn in record["turns"] for d in turn["decisions"]]
        assert [{k: d[k] for k in keys} for d in taken] == expect["decided"]
    for turn_number, unused in expect.get("unused_consents", {}).items():
        assert record["turns"][int(turn_number) - 1]["unused_consents"] == unused
    if "history_after" in expect:
        assert result["state"]["history"] == expect["history_after"]
    if "orders_after" in expect:
        assert len(result["state"]["orders"]) == expect["orders_after"]


def _grants_file(tmp_path):
    path = tmp_path / "grants.json"
    path.write_text(json.dumps(grants()))
    return path
