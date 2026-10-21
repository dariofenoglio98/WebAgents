"""A conversation in the Chrome Agent Browser, headless (T24, conversation.v0): recompute the checks.

    agentpkg/.venv/bin/python scripts/verify_chrome_conversation.py \\
        [--report examples/verification/chrome-conversation-e2e-t24.json]

`chrome-agent-browser/scripts/e2e-conversation.mjs` held a two-turn conversation with the
ticket-desk probe in a real, headless Chrome: a turn that reached its consent card and was
answered Yes, the order placed, a second turn that ended the conversation by the package's rule,
and the export (D-272) written beside each turn's recorded requests. This script reads the
harness's report and the exported directory and recomputes, with agentpkg's own code, what the
harness only observed:

* the transcript validates against the output contract (`spec/conversation-v0/transcript.schema.json`,
  V-16) and its turns agree with the harness's record;
* `audit.json` is one hash chain across the turns (V-17), each turn's `turn-NNN/audit.json` is
  its slice of it, and `sequence` counts on;
* every `consent.decided` event is matched by a transcript decision (step, permissions, accepted,
  decided_by), `consent.requested` precedes it, and the hashes the chain carries are the hashes of
  what the person saw: `text_sha256` of the decision's text and `facts_hash` of its facts (V-23);
* the card was recorded before the person decided (the pending card's `requested_at` precedes the
  harness's decision), and the order tool was called after it;
* the privacy observer (recording on) saw, per turn, exactly the requests the harness's fakes
  answered: the scripted Ollama and the desk origin, nowhere else; no request body carries the
  extension's own secrets (no `Authorization` header is recorded, no key);
* the state and the spent `once` permission match: the persisted state is the transcript's,
  `spent_permissions` is the order's permission, the usage sums the turns;
* the reference (`agentpkg converse --mode fixture` on the same signed probe, which the harness
  ran) gives the same replies and the same final state turn for turn.

The report is rewritten in place with a `conversation_verification` section; `passed_conversation`
is false if any check fails.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.execution.report import verify_audit_chain
from agentpkg.runtime import digest
from jsonschema import Draft202012Validator

TRANSCRIPT_SCHEMA = ROOT / "spec/conversation-v0/transcript.schema.json"
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail=None) -> None:
    CHECKS.append(
        {
            "check": name,
            "passed": bool(ok),
            **({} if detail is None else {"detail": detail}),
        }
    )


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def verify(report_path: Path) -> dict:
    report = load(report_path)
    export = ROOT / report["exportDirectory"]
    transcript = load(export / "transcript.json")
    audit = load(export / "audit.json")
    state = load(export / "state.json")
    usage = load(export / "usage.json")
    record = load(export / "conversation.json")

    # 1. The transcript against the contract, and against the harness's record.
    errors = sorted(
        Draft202012Validator(load(TRANSCRIPT_SCHEMA)).iter_errors(transcript),
        key=lambda e: list(map(str, e.absolute_path)),
    )
    check(
        "transcript validates against the output contract (V-16)",
        not errors,
        [e.message for e in errors[:3]],
    )
    turns = transcript["turns"]
    check(
        "two completed turns, as the harness recorded them",
        [t["status"] for t in turns] == ["completed", "completed"]
        and [t["turn"] for t in report["turns"]] == [1, 2]
        and all(
            t["run_id"] == r["run_id"]
            for t, r in zip(turns, report["turns"], strict=True)
        ),
        [t["status"] for t in turns],
    )
    check(
        "the conversation ended by the package's rule and completed (V-8, V-30)",
        transcript["ended"]["reason"] == "package"
        and record["status"] == "ended"
        and record["outcome"] == "completed"
        and transcript["ended"]["turns_not_run"] == 0,
        {
            "ended": transcript["ended"],
            "record": {k: record.get(k) for k in ("status", "outcome")},
        },
    )

    # 2. One chain across the turns; each turn's slice.
    chain = verify_audit_chain(audit)
    check(
        "audit.json is one valid hash chain across the turns (V-17)",
        chain["valid"] is True,
        chain,
    )
    check(
        "sequence counts on from 1 and every event names the conversation",
        [e["sequence"] for e in audit] == list(range(1, len(audit) + 1))
        and {e.get("conversation_id") for e in audit}
        == {transcript["conversation_id"]},
        {"events": len(audit)},
    )
    frame = [e["action"] for e in audit if e["run_id"] == transcript["conversation_id"]]
    check(
        "the conversation-level events frame the turns (run_id = the conversation id)",
        frame[0] == "conversation.started"
        and frame[-1] == "conversation.ended"
        and set(frame)
        <= {
            "conversation.started",
            "turn.started",
            "turn.completed",
            "turn.failed",
            "turn.refused",
            "conversation.ended",
        },
        frame,
    )
    for turn in turns:
        prefix = export / f"turn-{turn['turn']:03d}"
        slice_ = load(prefix / "audit.json")
        slice_events = slice_ if isinstance(slice_, list) else slice_.get("events", [])
        # The turn's events carry the interpreter's run id, not the host's (`run_…`): its slice is
        # the chain's events of that turn that are not the conversation's own.
        inside = [
            e
            for e in audit
            if e["turn"] == turn["turn"]
            and e["run_id"] != transcript["conversation_id"]
        ]
        check(
            f"turn {turn['turn']}: its audit.json is its slice of the chain",
            [e["event_hash"] for e in slice_events] == [e["event_hash"] for e in inside]
            and len(inside) > 0,
            {"slice": len(slice_events), "in_chain": len(inside)},
        )
        result = load(prefix / "result.json")
        check(
            f"turn {turn['turn']}: result.json is the reply and names the conversation",
            result["output"] == turn["reply"]
            and result["provenance"]["conversation"]
            == {"conversation_id": transcript["conversation_id"], "turn": turn["turn"]},
            result.get("provenance", {}).get("conversation"),
        )

    # 3. Every decision hashed in the chain: the text and the facts the person saw (V-23).
    decided = [e for e in audit if e["action"] == "consent.decided"]
    requested = [e for e in audit if e["action"] == "consent.requested"]
    decisions = [(t["turn"], d) for t in turns for d in t["decisions"]]
    check(
        "every consent.decided is matched by a transcript decision (step, permissions, accepted, decided_by)",
        len(decided) == len(decisions) == 1
        and all(
            e["step"] == d["step"]
            and e["permissions"] == d["permissions"]
            and e["accepted"] == d["accepted"]
            and e["decided_by"] == d["decided_by"]
            and e["turn"] == turn
            for e, (turn, d) in zip(decided, decisions, strict=True)
        ),
        {"decided": len(decided), "decisions": len(decisions)},
    )
    for e, (turn, d) in zip(decided, decisions, strict=True):
        req = next(
            (r for r in requested if r["step"] == e["step"] and r["turn"] == e["turn"]),
            None,
        )
        check(
            f"turn {turn}: consent.requested precedes consent.decided and hashes what the person saw",
            req is not None
            and req["sequence"] < e["sequence"]
            and req["text_sha256"]
            == hashlib.sha256(d["text"].encode("utf-8")).hexdigest()
            and req["facts_hash"] == digest(d["facts"])
            and e["decided_by"] == "person"
            and e["accepted"] is True,
            {"requested": req and req["sequence"], "decided": e["sequence"]},
        )
        # The gate: the tool ran after the decision, under the permission the step decided.
        tool_calls = [
            c for c in audit if c["action"] == "tool.called" and c["turn"] == turn
        ]
        check(
            f"turn {turn}: the gated tool was called once, after the decision",
            len(tool_calls) == 1
            and tool_calls[0]["sequence"] > e["sequence"]
            and tool_calls[0]["tool"] == "place",
            [(c["tool"], c["sequence"]) for c in tool_calls],
        )

    # 4. The card before the decision, the desk after it (the harness's clock, one process).
    card = report["card"]
    decision = report["decision"]
    desk = report["requests"]["desk"]
    check(
        "the card was pending before the person decided; the desk was called after",
        card["requested_at"] <= card["seen_at"] <= decision["decided_at"]
        and card["desk_requests_before"] == 0
        and len(desk) == 1
        and desk[0]["at"] > decision["decided_at"],
        {
            "card": card["requested_at"],
            "seen": card["seen_at"],
            "decided": decision["decided_at"],
            "desk": [d["at"] for d in desk],
        },
    )
    check(
        "the second turn asked nothing and bought nothing",
        turns[1]["decisions"] == []
        and not [c for c in audit if c["action"] == "tool.called" and c["turn"] == 2],
    )

    # 5. The privacy observer: every request to the two fakes, nowhere else, no credential.
    ollama = report["fakes"]["ollama"]
    allowed_hosts = {ollama.split("//")[1], "desk.example.org"}
    for turn in turns:
        prefix = export / f"turn-{turn['turn']:03d}"
        observed = load(prefix / "observations.json")
        hosts = [o["url"].split("/")[2] for o in observed["observations"]]
        kinds = [o["kind"] for o in observed["observations"]]
        expected = ["model", "tool"] if turn["turn"] == 1 else ["model"]
        check(
            f"turn {turn['turn']}: the observer, recording, saw the model request{' and the order' if turn['turn'] == 1 else ''} and nothing else",
            observed["recording"] is True
            and kinds == expected
            and set(hosts) <= allowed_hosts,
            {"kinds": kinds, "hosts": hosts},
        )
        bodies = "\n".join(o["body"] for o in observed["observations"])
        check(
            f"turn {turn['turn']}: no recorded request body carries a credential",
            "Authorization" not in bodies
            and "api_key" not in bodies.lower()
            and not re.search(r"\b(?:sk-|ghp_|xox[bp]-)[A-Za-z0-9_-]{8,}", bodies),
        )
        model_bodies = [
            json.loads(o["body"])
            for o in observed["observations"]
            if o["kind"] == "model"
        ]
        check(
            f"turn {turn['turn']}: the model saw the message under the interpret task with a schema constraint",
            all(
                "format" in b
                and any(
                    m["role"] == "user" and turn["message"]["text"] in m["content"]
                    for m in b["messages"]
                )
                for b in model_bodies
            ),
        )

    # 6. The state, the once grant, the usage.
    check(
        "state.json is the transcript's persisted state (V-5)",
        state == transcript["state"],
        state,
    )
    check(
        "the persisted state holds the order and the history of both turns",
        [h["intent"] for h in state["history"]] == ["order", "done"]
        and state["orders"] == [turns[0]["reply"]["order"]],
        state,
    )
    check(
        "the once grant was spent by the order (V-13)",
        transcript["spent_permissions"] == ["orders.place"]
        and usage["tool_calls"] == {"place": 1},
        {"spent": transcript["spent_permissions"], "tool_calls": usage["tool_calls"]},
    )
    check(
        "the usage sums the turns",
        usage["turns"] == 2
        and usage["tokens"] == sum(t["usage"]["tokens"] for t in turns)
        and usage["remote_calls"] == sum(t["usage"]["remote_calls"] for t in turns),
        usage,
    )

    # 7. The reference's fixture replay of the same transcript: the same replies, the same state.
    reference = ROOT / report["reference"]["directory"]
    ref_transcript = load(reference / "transcript.json")
    check(
        "the reference's replies equal Chrome's, turn for turn",
        [t["reply"] for t in ref_transcript["turns"]] == [t["reply"] for t in turns]
        and [t["message"] for t in ref_transcript["turns"]]
        == [t["message"] for t in turns],
        {"reference": [t["status"] for t in ref_transcript["turns"]]},
    )
    check(
        "the reference's final state and end equal Chrome's",
        ref_transcript["state"] == state
        and ref_transcript["ended"]["reason"] == transcript["ended"]["reason"]
        and ref_transcript["spent_permissions"] == transcript["spent_permissions"],
        {"reference_state": ref_transcript["state"]},
    )
    check(
        "the reference's decision was the transcript's; Chrome's was the person's",
        [d["decided_by"] for t in ref_transcript["turns"] for d in t["decisions"]]
        == ["transcript"]
        and [d["decided_by"] for _, d in decisions] == ["person"],
    )

    passed = all(c["passed"] for c in CHECKS)
    report["conversation_verification"] = {
        "script": "scripts/verify_chrome_conversation.py",
        "export": report["exportDirectory"],
        "chain": {
            "events": len(audit),
            "valid": chain["valid"],
            "final_hash": audit[-1]["event_hash"] if audit else None,
        },
        "checks": CHECKS,
        "passed": passed,
    }
    report["passed_conversation"] = passed
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--report",
        default=str(ROOT / "examples/verification/chrome-conversation-e2e-t24.json"),
    )
    args = parser.parse_args()
    report = verify(Path(args.report))
    summary = {
        "report": args.report,
        "passed_conversation": report["passed_conversation"],
        "checks": len(CHECKS),
        "failed": [c["check"] for c in CHECKS if not c["passed"]],
    }
    print(json.dumps(summary, indent=2))
    return 0 if report["passed_conversation"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
