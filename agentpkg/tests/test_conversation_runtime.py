"""conversation.v0 in the reference (spec/conversation-v0.md): the turn and state model, the
consent step and the gate, budgets and reservation, `once` across turns, the transcript, the one
audit chain, the CLI, and what the control plane and `inspect` say about a conversational
package."""

import asyncio
import json
from pathlib import Path

import pytest
from conversation_probe import grants, message, transcript, write_probe

from agentpkg.cli import main
from agentpkg.conversation import Conversation
from agentpkg.conversation.chain import AuditChain
from agentpkg.conversation.declarations import (
    conversation_records,
    validate_transcript_document,
)
from agentpkg.conversation.host import TranscriptConsent, check_decision
from agentpkg.conversation.runner import TurnContext
from agentpkg.errors import ValidationError
from agentpkg.execution.report import verify_audit_chain
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import inspect_package, load_package
from agentpkg.runtime import PolicyError, Runtime
from agentpkg.workflow import Workflow

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "spec" / "conversation-v0"
COPY = ROOT / "agentpkg" / "src" / "agentpkg" / "schemas" / "conversation"


def _probe(tmp_path, **options):
    return load_package(write_probe(tmp_path / "probe", **options))


def _run(package, document, *, decisions=None, limits=None, consent=None, on_turn=None):
    router, handlers, _ = fixture_adapters(package)
    conversation = Conversation(
        package,
        grants=decisions or grants(),
        approved_tools=["place"],
        adapters=lambda turn: {"router": router, "handlers": handlers},
        limits=limits,
        consent=consent,
        on_turn=on_turn,
    )
    return asyncio.run(conversation.run(document))


def test_the_contract_copies_equal_the_spec_files():
    names = sorted(p.name for p in CONTRACTS.glob("*.schema.json") if "patch" not in p.name)
    assert names == [
        "consent-decision.schema.json",
        "transcript-input.schema.json",
        "transcript.schema.json",
    ]
    for name in names:
        assert (COPY / name).read_bytes() == (CONTRACTS / name).read_bytes()


def test_two_turns_persist_state_and_continue_one_chain(tmp_path):
    package = _probe(tmp_path)
    result = _run(package, transcript(("order A", {"confirm": True}), "done"))
    assert result["status"] == "completed"
    assert result["state"] == {
        "history": [{"text": "order A", "intent": "order"}, {"text": "done", "intent": "done"}],
        "orders": [{"order_id": "TD-0001", "show": "Show A", "quantity": 1, "total_usd": 40}],
    }
    audit = result["audit"]
    chain = verify_audit_chain(audit)
    assert chain["valid"] is True and chain["events"] == len(audit)
    assert [e["sequence"] for e in audit] == list(range(1, len(audit) + 1))
    # Every event names the conversation and its turn; the conversation-level ones the
    # conversation id as run_id, a turn's events the turn's own run id.
    assert {e["conversation_id"] for e in audit} == {result["provenance"]["conversation_id"]}
    level = [
        (e["turn"], e["action"])
        for e in audit
        if e["run_id"] == result["provenance"]["conversation_id"]
    ]
    assert level == [
        (0, "conversation.started"),
        (1, "turn.started"),
        (1, "turn.completed"),
        (2, "turn.started"),
        (2, "turn.completed"),
        (2, "conversation.ended"),
    ]
    turn_runs = {e["turn"]: e["run_id"] for e in audit if e["action"] == "runtime.started"}
    assert len(set(turn_runs.values())) == 2 and set(turn_runs) == {1, 2}
    # The consent step: requested with hashes, decided by the transcript, the tool after it.
    actions = [e["action"] for e in audit if e["turn"] == 1]
    assert (
        actions.index("consent.requested")
        < actions.index("consent.decided")
        < actions.index("tool.called")
    )
    requested = next(e for e in audit if e["action"] == "consent.requested")
    assert set(requested) >= {"step", "permissions", "text_sha256", "facts_hash", "timeout_seconds"}
    assert "Order one ticket" not in json.dumps(audit)
    decided = next(e for e in audit if e["action"] == "consent.decided")
    assert decided["accepted"] is True and decided["decided_by"] == "transcript"
    # The transcript carries the text and the facts, and validates against the output contract.
    record = result["transcript"]
    validate_transcript_document(record, form="output", label="transcript")
    decision = record["turns"][0]["decisions"][0]
    assert decision["text"] == "Order one ticket to Show A?"
    assert decision["facts"] == {"show": "Show A", "quantity": 1}
    assert record["turns"][1]["decisions"] == [] and record["turns"][1]["unused_consents"] == []
    assert record["ended"]["reason"] == "package" and record["budget"]["spent"]["turns"] == 2
    assert result["ended"]["turns_not_run"] == 0


def test_a_failed_turn_persists_nothing_and_the_conversation_goes_on(tmp_path):
    from conversation_probe import VARIANTS

    package = _probe(tmp_path, mutate=VARIANTS["consent-text-not-string"])
    result = _run(package, transcript(("order A", {"confirm": True}), "hello"))
    assert [t["status"] for t in result["transcript"]["turns"]] == ["failed", "completed"]
    assert result["transcript"]["turns"][0]["error_code"] == "schema_validation"
    assert result["state"]["history"] == [{"text": "hello", "intent": "chat"}]
    failed = [e for e in result["audit"] if e["action"] == "turn.failed"]
    assert failed and failed[0]["error_code"] == "schema_validation"
    assert result["status"] == "failed"


def test_the_end_reasons(tmp_path):
    package = _probe(tmp_path)
    person = _run(package, transcript("hello", end=True))
    assert person["ended"]["reason"] == "person"
    host = _run(package, transcript("hello"))
    assert host["ended"]["reason"] == "host"
    package_end = _run(package, transcript("done", "hello"))
    assert package_end["ended"] == {**package_end["ended"], "reason": "package", "turns_not_run": 1}
    assert len(package_end["transcript"]["turns"]) == 1
    cap = _run(package, transcript("hello", "hello", "hello", "hello"))
    assert cap["ended"]["reason"] == "max_turns" and cap["ended"]["turns_not_run"] == 0
    beyond = _run(package, transcript("hello", "hello", "hello", "hello", "hello"))
    assert [t["status"] for t in beyond["transcript"]["turns"]][-1] == "refused"
    assert beyond["ended"]["reason"] == "max_turns" and beyond["ended"]["turns_not_run"] == 1
    # V-30: a conversation ended at its bound completed; a refused turn is not a failure.
    assert cap["status"] == "completed" and beyond["status"] == "completed"
    nothing = _run(package, transcript("hello"), limits={"conversation_max_turns": 0})
    assert [t["status"] for t in nothing["transcript"]["turns"]] == ["refused"]
    assert nothing["status"] == "failed" and nothing["ended"]["reason"] == "max_turns"


def test_host_inputs_are_checked_before_the_chain_starts(tmp_path):
    """A grant value, an approval or a limit key the mediator would refuse is refused by the
    conversation before `conversation.started`, so a host creates nothing for it."""
    package = _probe(tmp_path)
    router, handlers, _ = fixture_adapters(package)

    def build(**options):
        options = {
            "grants": grants(),
            "approved_tools": ["place"],
            "adapters": lambda turn: {"router": router, "handlers": handlers},
            **options,
        }
        return Conversation(package, **options)

    for bad, expected in (
        ({"grants": grants(**{"orders.place": "forever"})}, "Grant must be"),
        ({"grants": {**grants(), "orders.other": "session"}}, "undeclared permission"),
        ({"approved_tools": ["place", "nope"]}, "does not declare"),
        ({"limits": {"conversation_max_turn": 1}}, "Unsupported host limit"),
        ({"limits": {"hard_tokens": -1}}, "nonnegative"),
        ({"limits": {"conversation_total_tokens": "many"}}, "nonnegative"),
    ):
        with pytest.raises(PolicyError, match=expected):
            build(**bad)
    assert build().chain.events == []


def test_host_limits_only_lower_the_conversation_budget(tmp_path):
    package = _probe(tmp_path)
    result = _run(
        package,
        transcript("hello", "hello"),
        limits={
            "conversation_max_turns": 9,
            "conversation_total_tokens": 7000,
            "hard_tokens": 3000,
        },
    )
    limits = result["transcript"]["budget"]["limits"]
    assert limits["max_turns"] == 4 and limits["hard_tokens"] == 7000
    # The turn's own ceiling (3,000) is what each turn reserves: two turns fit in 7,000.
    assert [t["status"] for t in result["transcript"]["turns"]] == ["completed", "completed"]
    with pytest.raises(PolicyError, match="conversation_max_turns"):
        _run(package, transcript("hello"), limits={"conversation_max_turns": -1})


def test_once_is_spent_once_per_conversation_and_the_plan_is_never_widened(tmp_path):
    package = _probe(tmp_path)
    result = _run(
        package,
        transcript(("order A", {"confirm": True}), ("order B", {"confirm": True})),
        decisions=grants(**{"orders.place": "once"}),
    )
    # V-13 with V-12: the second turn starts with the grant spent, so its consent step is not
    # put to the person (the plan's denial, `permission_consumed`), the transcript's yes for it
    # stays unused, the graph takes its no-order path and the turn completes.
    assert [t["status"] for t in result["transcript"]["turns"]] == ["completed", "completed"]
    assert result["status"] == "completed"
    assert result["transcript"]["spent_permissions"] == ["orders.place"]
    started = [e for e in result["audit"] if e["action"] == "runtime.started"]
    assert started[1]["spent_permissions"] == ["orders.place"]
    decided = [e for e in result["audit"] if e["action"] == "consent.decided"]
    assert [(e["turn"], e["accepted"], e["decided_by"], e["reason"]) for e in decided] == [
        (1, True, "transcript", None),
        (2, False, "plan", "permission_consumed"),
    ]
    second = result["transcript"]["turns"][1]
    assert second["unused_consents"] == ["confirm"] and second["reply"]["order"] is None
    assert len([e for e in result["audit"] if e["action"] == "tool.called"]) == 1
    assert len(result["state"]["orders"]) == 1
    # A denied permission: the step is not asked, the decision is the plan's, the tool never runs.
    denied = _run(
        package,
        transcript(("order A", {"confirm": False}), "done"),
        decisions=grants(**{"orders.place": "deny"}),
    )
    decided = next(e for e in denied["audit"] if e["action"] == "consent.decided")
    assert decided["decided_by"] == "plan" and decided["reason"] == "permission_denied"
    assert not [e for e in denied["audit"] if e["action"] == "tool.called"]
    assert denied["transcript"]["turns"][0]["unused_consents"] == ["confirm"]


def test_a_denied_step_is_never_asked_and_a_host_answer_is_checked(tmp_path):
    """V-12: `call_consent` never asks for a permission the plan denies (the decision is the
    plan's), and a host's answer must be within the decision contract."""
    package = _probe(tmp_path)
    conversation_id = "00000000-0000-4000-8000-000000000000"
    asked = []

    class Eager:
        used = set()

        async def decide(self, request):
            asked.append(request.step)
            return {"accepted": True, "decided_by": "person", "reason": None}

    context = TurnContext(
        conversation_id, 1, {"history": [], "orders": []}, AuditChain(conversation_id), Eager()
    )
    runtime = Runtime(package, grants=grants(**{"orders.place": "deny"}), turn=context)
    node = next(n for n in package.graph["nodes"] if n["type"] == "consent")
    decision = asyncio.run(
        runtime.call_consent(runtime.coordinator_context(), node, {"show": "A"}, "Order?")
    )
    assert decision == {"accepted": False} and asked == []
    decided = next(e for e in runtime.audit if e["action"] == "consent.decided")
    assert decided["decided_by"] == "plan" and decided["reason"] == "permission_denied"
    # A `once` grant an earlier turn spent (V-13): not asked either, `permission_consumed`.
    spent = TurnContext(
        conversation_id,
        2,
        {"history": [], "orders": []},
        AuditChain(conversation_id),
        Eager(),
        spent={"orders.place"},
    )
    runtime = Runtime(package, grants=grants(**{"orders.place": "once"}), turn=spent)
    decision = asyncio.run(
        runtime.call_consent(runtime.coordinator_context(), node, {"show": "A"}, "Order?")
    )
    assert decision == {"accepted": False} and asked == []
    decided = next(e for e in runtime.audit if e["action"] == "consent.decided")
    assert decided["decided_by"] == "plan" and decided["reason"] == "permission_consumed"
    # Unspent, the same step is put to the host.
    runtime = Runtime(
        package,
        grants=grants(**{"orders.place": "once"}),
        turn=TurnContext(
            conversation_id, 2, {"history": [], "orders": []}, AuditChain(conversation_id), Eager()
        ),
    )
    asyncio.run(runtime.call_consent(runtime.coordinator_context(), node, {"show": "A"}, "Order?"))
    assert asked == ["confirm"]
    assert check_decision({"accepted": True, "decided_by": "person"}) == {
        "accepted": True,
        "decided_by": "person",
        "reason": None,
    }
    for bad in (
        {"accepted": "yes", "decided_by": "person"},
        {"accepted": True, "decided_by": "nobody"},
        {"accepted": True, "decided_by": "person", "reason": "not a code"},
        {"accepted": True, "decided_by": "person", "extra": 1},
    ):
        with pytest.raises(Exception, match="consent_decision_invalid"):
            check_decision(bad)


def test_a_plain_run_refuses_a_conversational_package_and_a_turn_needs_one(tmp_path):
    package = _probe(tmp_path)
    with pytest.raises(PolicyError, match="conversation_turn_required"):
        Workflow(package, grants=grants())
    from conversation_probe import VARIANTS

    plain = _probe(tmp_path / "plain", mutate=VARIANTS["plain"])
    chain = AuditChain("00000000-0000-4000-8000-000000000000")
    context = TurnContext(
        "00000000-0000-4000-8000-000000000000", 1, {}, chain, TranscriptConsent({})
    )
    with pytest.raises(PolicyError, match="conversation_turn_unexpected"):
        Workflow(plain, grants=grants(), turn=context)


def test_inspect_and_the_control_plane_summary_describe_the_conversation(tmp_path):
    package = _probe(tmp_path)
    records = conversation_records(package)
    assert records["persistent_keys"] == ["history", "orders"]
    assert records["consent_steps"] == [
        {
            "id": "confirm",
            "permissions": ["orders.place"],
            "timeout_seconds": 30,
            "conditional": True,
            "depends_on": ["interpret"],
        }
    ]
    assert records["gated_permissions"] == {"orders.place": ["confirm"]}
    assert inspect_package(package)["conversation"] == records
    from agentpkg.browser.evaluation import evaluate_snapshot, signature_report
    from agentpkg.browser.summary import build_summary
    from agentpkg.package import build_package

    archive = build_package(package.source, tmp_path / "probe.agent.pkg")
    evaluation = evaluate_snapshot(archive)
    summary = build_summary(
        package,
        evaluation=evaluation.as_json(),
        publisher={
            **signature_report(package),
            "trust_status": "unknown",
            "trust_reason": "no_pin",
        },
    )
    assert summary["workflow"]["conversation"] == records
    words = next(w for w in summary["warnings"] if w["code"] == "conversational_package")
    assert (
        "at most 4 turns" in words["message"]
        and "confirm (before orders.place)" in words["message"]
    )
    consent_node = next(n for n in summary["workflow"]["nodes"] if n["type"] == "consent")
    assert consent_node["permissions"] == ["orders.place"]


def test_the_cli_converse_writes_the_conversation_and_every_turn(tmp_path, capsys):
    source = write_probe(tmp_path / "probe")
    grants_file = tmp_path / "grants.json"
    grants_file.write_text(json.dumps(grants()))
    out = tmp_path / "out"
    status = main(
        [
            "converse",
            str(source),
            "--mode",
            "fixture",
            "--grants",
            str(grants_file),
            "--approve-tool",
            "place",
            "--out",
            str(out),
        ]
    )
    report = json.loads(capsys.readouterr().out)
    assert status == 0 and report["passed"] is True and report["profile"] == "conversation.v0"
    assert sorted(p.name for p in out.iterdir()) == [
        "audit.json",
        "provenance.json",
        "state.json",
        "transcript.json",
        "turn-001",
        "turn-002",
        "usage.json",
    ]
    assert sorted(p.name for p in (out / "turn-001").iterdir()) == [
        "audit.json",
        "provenance.json",
        "reply.json",
        "result.json",
        "usage.json",
    ]
    audit = json.loads((out / "audit.json").read_text())
    assert verify_audit_chain(audit)["valid"] is True
    turn_audit = json.loads((out / "turn-002" / "audit.json").read_text())
    assert turn_audit[0]["previous_hash"] == next(
        e["event_hash"] for e in audit if e["action"] == "turn.started" and e["turn"] == 2
    )
    record = json.loads((out / "transcript.json").read_text())
    validate_transcript_document(record, form="output", label="transcript.json")
    assert json.loads((out / "state.json").read_text()) == record["state"]
    # An explicit transcript, and a refused one.
    other = tmp_path / "other.json"
    other.write_text(json.dumps(transcript(("order A", {"other": True}))))
    status = main(
        [
            "converse",
            str(source),
            "--grants",
            str(grants_file),
            "--transcript",
            str(other),
            "--out",
            str(tmp_path / "out2"),
        ]
    )
    assert status == 2 and "consent_step_unknown" in capsys.readouterr().err
    assert not (tmp_path / "out2").exists()
    # A grant value the mediator refuses: refused before --out exists, so a retry can reuse it.
    bad_grants = tmp_path / "bad-grants.json"
    bad_grants.write_text(json.dumps(grants(**{"orders.place": "forever"})))
    status = main(
        [
            "converse",
            str(source),
            "--grants",
            str(bad_grants),
            "--out",
            str(tmp_path / "out2"),
        ]
    )
    assert status == 2 and "Grant must be" in capsys.readouterr().err
    assert not (tmp_path / "out2").exists()
    # A conversation ended at its bound passes (V-30): five messages against max_turns 4.
    long = tmp_path / "long.json"
    long.write_text(json.dumps(transcript(*(["hello"] * 5))))
    status = main(
        [
            "converse",
            str(source),
            "--grants",
            str(grants_file),
            "--transcript",
            str(long),
            "--out",
            str(tmp_path / "out-long"),
        ]
    )
    report = json.loads(capsys.readouterr().out)
    assert status == 0 and report["passed"] is True and report["ended"]["reason"] == "max_turns"
    assert [t["status"] for t in report["turns"]] == ["completed"] * 4 + ["refused"]
    # `run` and `eval` send a conversational package to `converse`.
    assert (
        main(["run", str(source), "--grants", str(grants_file), "--out", str(tmp_path / "out3")])
        == 2
    )
    assert "conversation_profile" in capsys.readouterr().err
    assert main(["eval", str(source)]) == 2
    assert "conversation_profile" in capsys.readouterr().err


def test_a_tampered_chain_is_found(tmp_path):
    package = _probe(tmp_path)
    result = _run(package, transcript(("order A", {"confirm": True}), "done"))
    audit = json.loads(json.dumps(result["audit"]))
    decided = next(e for e in audit if e["action"] == "consent.decided")
    decided["accepted"] = False
    report = verify_audit_chain(audit)
    assert report["valid"] is False and report["broken"][0]["reason"] == "event_hash"
    # Dropping the consent events breaks the links around them.
    cut = [e for e in result["audit"] if not e["action"].startswith("consent.")]
    assert verify_audit_chain(cut)["valid"] is False


def test_the_input_transcript_reader_refuses_an_output_transcript(tmp_path):
    from agentpkg.conversation.transcript import read_input_transcript

    package = _probe(tmp_path)
    result = _run(package, transcript("hello"))
    path = tmp_path / "out.json"
    path.write_text(json.dumps(result["transcript"]))
    with pytest.raises(ValidationError):
        read_input_transcript(path)
    good = tmp_path / "in.json"
    good.write_text(json.dumps(transcript("hello", end=True)))
    assert read_input_transcript(good)["end"] is True
    assert message("x") == {"text": "x"}


def test_the_cli_converse_reports_a_refused_agent_document_per_turn(tmp_path, capsys, monkeypatch):
    """M-50 per turn: when a turn's folder refuses the agent document (`store_failed` in the
    turn's Run Record), `converse` says so on stderr for that turn, as `run` does for a run."""
    from agentpkg.memory import host as memory_host

    real = memory_host.cli_memory

    def refusing(package, **options):
        memory_run, folder, handlers = real(package, **options)
        memory_run.commit_error = "FileExistsError: a file where the folder should be"
        return memory_run, folder, handlers

    monkeypatch.setattr(memory_host, "cli_memory", refusing)
    source = write_probe(tmp_path / "probe")
    grants_file = tmp_path / "grants.json"
    grants_file.write_text(json.dumps(grants()))
    status = main(
        [
            "converse",
            str(source),
            "--mode",
            "fixture",
            "--grants",
            str(grants_file),
            "--approve-tool",
            "place",
            "--out",
            str(tmp_path / "out"),
        ]
    )
    captured = capsys.readouterr()
    assert status == 0 and json.loads(captured.out)["passed"] is True
    assert "turn 1: the agent document was not committed: FileExistsError" in captured.err
    assert "turn 2: the agent document was not committed: FileExistsError" in captured.err
