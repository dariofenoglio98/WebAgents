"""The conversation-test package (examples/conversation/conversation-test.agent.pkg): the signed
archive verifies against its development key, is its committed source, and runs its fixture
transcript to the expected conversation: two turns, one accepted consent, one order, the end by
the package's own rule, one valid audit chain; the same conversation twice gives the same
transcript apart from ids and times."""

import hashlib
import json
from pathlib import Path

from agentpkg.cli import main
from agentpkg.conversation.declarations import validate_transcript_document
from agentpkg.execution.report import verify_audit_chain
from agentpkg.package import build_package, load_package
from agentpkg.signing import verify_package

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "examples" / "conversation"
ARCHIVE = EXAMPLES / "conversation-test.agent.pkg"
SOURCE = EXAMPLES / "conversation-test"
KEY = ROOT / "examples" / "keys" / "conversation-test-publisher.pub.pem"
GRANTS = EXAMPLES / "conversation-test-grants.json"


def test_the_signed_archive_is_the_source(tmp_path):
    verified = verify_package(ARCHIVE, trusted_key=KEY)
    assert verified["valid"] is True
    package = load_package(ARCHIVE)
    assert package.manifest["package_id"] == "org.webagents.conversation-test"
    # The signed bytes, pinned: a changed source is a new version and a new signature (D-003).
    assert package.digest == "cd9cfc7f5f819110cf8b39cd8c15b2133283f834c1f4c9ef6d183e481e9582ab"
    assert hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() == (
        "4b7c8eba80d62afcf0ad3d303f15ae9a736540230255ee4debaa083e60cbb230"
    )
    assert verified["key_fingerprint"] == (
        "sha256:8fd73c6495de3610c6bc41f9950abec90cee118e6932df8d9beef81176988e10"
    )
    assert package.manifest["runtime"]["minimum_version"] == "0.6.0"
    rebuilt = load_package(build_package(SOURCE, tmp_path / "rebuilt.agent.pkg"))
    assert rebuilt.digest == package.digest
    conversation = package.graph["conversation"]
    assert conversation["budget"] == {
        "max_turns": 4,
        "hard_tokens": 20000,
        "max_remote_calls": 0,
        "max_calls_per_tool": {"place-order": 1},
    }
    assert [n["id"] for n in package.graph["nodes"] if n["type"] == "consent"] == ["confirm-order"]
    assert package.tools["place-order"]["side_effects"] == "write"
    kinds = {p["id"]: p["kind"] for p in package.policy["permissions"]}
    assert kinds["orders.place"] == "payment"


def _converse(tmp_path, name, capsys):
    out = tmp_path / name
    status = main(
        [
            "converse",
            str(ARCHIVE),
            "--mode",
            "fixture",
            "--grants",
            str(GRANTS),
            "--approve-tool",
            "place-order",
            "--trust-key",
            str(KEY),
            "--out",
            str(out),
        ]
    )
    report = json.loads(capsys.readouterr().out)
    assert status == 0 and report["passed"] is True, report
    return report, json.loads((out / "transcript.json").read_text()), out


def test_the_fixture_conversation_runs_as_the_spec_says(tmp_path, capsys):
    report, transcript, out = _converse(tmp_path, "first", capsys)
    assert report["turns"] == [
        {"turn": 1, "status": "completed"},
        {"turn": 2, "status": "completed"},
    ]
    assert report["ended"]["reason"] == "package" and report["usage"]["tool_calls"] == {
        "place-order": 1
    }
    validate_transcript_document(transcript, form="output", label="transcript.json")
    first, second = transcript["turns"]
    assert first["decisions"] == [
        {
            **first["decisions"][0],
            "step": "confirm-order",
            "permissions": ["orders.place"],
            "accepted": True,
            "decided_by": "transcript",
            "reason": None,
            "text": "Place an order for two tickets to Friday's show?",
            "facts": {"show": "Friday's show", "quantity": 2},
        }
    ]
    order = {"order_id": "TD-0001", "show": "Friday's show", "quantity": 2, "total_usd": 90}
    assert first["reply"]["order"] == order and first["reply"]["intent"] == "order"
    assert second["decisions"] == [] and second["reply"]["intent"] == "done"
    assert transcript["state"] == {
        "history": [
            {"text": "Two tickets for Friday's show, please.", "intent": "order"},
            {"text": "That's all, thanks.", "intent": "done"},
        ],
        "orders": [order],
    }
    assert transcript["spent_permissions"] == []
    audit = json.loads((out / "audit.json").read_text())
    chain = verify_audit_chain(audit)
    assert chain["valid"] is True and [e["sequence"] for e in audit] == list(
        range(1, len(audit) + 1)
    )
    assert [e["action"] for e in audit if e["action"].startswith("consent.")] == [
        "consent.requested",
        "consent.decided",
    ]
    assert json.loads((out / "turn-001" / "reply.json").read_text()) == first["reply"]
    assert json.loads((out / "state.json").read_text()) == transcript["state"]
    # The same conversation again: the same transcript apart from ids and times.
    _, again, _ = _converse(tmp_path, "second", capsys)

    def stable(document):
        document = json.loads(json.dumps(document))
        document.pop("conversation_id")
        document.pop("started_at")
        document["ended"].pop("at")
        for turn in document["turns"]:
            for key in ("run_id", "started_at", "ended_at"):
                turn.pop(key)
            for decision in turn["decisions"]:
                decision.pop("decided_at")
        return document

    assert stable(again) == stable(transcript)
