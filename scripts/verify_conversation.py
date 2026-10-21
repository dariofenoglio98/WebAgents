"""conversation.v0 (agentpkg 0.6.0): offline checks of the contracts, the test package and the
enforcement cases, printing JSON with `"passed"`.

    agentpkg/.venv/bin/python scripts/verify_conversation.py

Checks: the live workflow schema carries the spec's RFC 6902 patch (applying it again changes
nothing); the contract copies under agentpkg equal the spec's files; the test package's source
validates, declares what the spec requires and runs its fixture transcript to the expected
transcript with one valid audit chain across both turns; and every enforcement case ends at the
stage with the code the list expects, on the reference runtime.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "spec" / "conversation-v0"
SCHEMAS = ROOT / "agentpkg" / "src" / "agentpkg" / "schemas"
EXAMPLES = ROOT / "examples" / "conversation"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _pointer(document, path: str):
    tokens = [t.replace("~1", "/").replace("~0", "~") for t in path.split("/")[1:]]
    current = document
    for token in tokens[:-1]:
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current, tokens[-1]


def apply_idempotent(document, patch: list[dict]):
    """RFC 6902 `add` only, skipping an addition already in place, so the same file describes the
    step and checks the result (as `verify_compute.py` does)."""
    result = copy.deepcopy(document)
    for operation in patch:
        assert operation["op"] == "add", operation
        parent, token = _pointer(result, operation["path"])
        value = copy.deepcopy(operation["value"])
        if isinstance(parent, list):
            if token == "-":
                if value not in parent:
                    parent.append(value)
            else:
                parent.insert(int(token), value)
        elif not (token in parent and parent[token] == value):
            parent[token] = value
    return result


def _check(report, name, passed, detail=None):
    report["checks"].append(
        {"name": name, "passed": bool(passed), **({"detail": detail} if detail else {})}
    )
    if not passed:
        report["passed"] = False


def main() -> int:
    sys.path.insert(0, str(ROOT / "agentpkg" / "src"))
    from agentpkg.conversation import Conversation
    from agentpkg.conversation.declarations import (
        conversation_records,
        validate_transcript_document,
    )
    from agentpkg.execution.report import verify_audit_chain
    from agentpkg.fixtures import fixture_adapters
    from agentpkg.package import load_package

    report = {"schema": "webagents-verify-conversation-v0", "checks": [], "passed": True}
    live = load_json(SCHEMAS / "workflow.schema.json")
    patch = load_json(CONTRACTS / "workflow.schema.patch.json")
    _check(
        report,
        "schema workflow carries workflow.schema.patch.json",
        apply_idempotent(live, patch) == live,
    )
    node_types = live["$defs"]["node"]["properties"]["type"]["enum"]
    _check(report, "node types include consent", "consent" in node_types)
    sources = live["$defs"]["value"]["oneOf"][1]["properties"]["from"]["enum"]
    _check(report, "value sources include conversation", "conversation" in sources)
    for name in (
        "consent-decision.schema.json",
        "transcript-input.schema.json",
        "transcript.schema.json",
    ):
        same = (SCHEMAS / "conversation" / name).read_bytes() == (CONTRACTS / name).read_bytes()
        _check(report, f"contract copy {name} equals the spec file", same)
    # The test package: its source validates and says what the spec requires of it.
    source = EXAMPLES / "conversation-test"
    package = load_package(source)
    records = conversation_records(package)
    _check(report, "conversation-test declares a conversation", records is not None, records)
    _check(
        report,
        "conversation-test gates its write tool behind one consent step",
        records is not None and records["gated_permissions"] == {"orders.place": ["confirm-order"]},
    )
    archive = EXAMPLES / "conversation-test.agent.pkg"
    if archive.exists():
        from agentpkg.package import build_package

        # The builder canonicalizes JSON, so the source's digest is compared through a rebuild.
        with tempfile.TemporaryDirectory() as scratch:
            target = Path(scratch).resolve() / "rebuilt.agent.pkg"  # no symlinked /var
            rebuilt = load_package(build_package(source, target))
        signed = load_package(archive)
        _check(
            report,
            "conversation-test archive is its source",
            rebuilt.digest == signed.digest and signed.signature is not None,
            signed.digest,
        )
    grants = load_json(EXAMPLES / "conversation-test-grants.json")
    router, handlers, _ = fixture_adapters(package)
    import asyncio

    conversation = Conversation(
        package,
        grants=grants,
        approved_tools=["place-order"],
        adapters=lambda turn: {"router": router, "handlers": handlers},
    )
    result = asyncio.run(conversation.run(package.json(package.graph["conversation"]["fixture"])))
    transcript = result["transcript"]
    _check(
        report, "fixture conversation completed", result["status"] == "completed", result["ended"]
    )
    _check(
        report,
        "two turns, one accepted consent, one order",
        (
            [t["status"] for t in transcript["turns"]] == ["completed", "completed"]
            and [d["accepted"] for d in transcript["turns"][0]["decisions"]] == [True]
            and transcript["turns"][1]["decisions"] == []
            and len(transcript["state"]["orders"]) == 1
            and transcript["ended"]["reason"] == "package"
        ),
    )
    chain = verify_audit_chain(result["audit"])
    _check(
        report,
        "one valid audit chain across both turns",
        chain["valid"]
        and [e["sequence"] for e in result["audit"]] == list(range(1, len(result["audit"]) + 1)),
        {"events": chain["events"]},
    )
    try:
        validate_transcript_document(transcript, form="output", label="transcript")
        _check(report, "the transcript validates against the output contract", True)
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        _check(report, "the transcript validates against the output contract", False, str(exc))
    listed = load_json(EXAMPLES / "cases" / "cases.json")
    with tempfile.TemporaryDirectory() as scratch:
        run = subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-q",
                "-o",
                "addopts=",
                "-p",
                "no:cacheprovider",
                "--basetemp",
                scratch,
                str(ROOT / "agentpkg" / "tests" / "test_conversation_cases.py"),
            ],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
    summary = run.stdout.strip().splitlines()[-1] if run.stdout.strip() else run.stderr[-300:]
    _check(report, "every enforcement case asserted on the reference", run.returncode == 0, summary)
    report["cases"] = len(listed["cases"])
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
