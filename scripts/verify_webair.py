"""Offline acceptance of the signed WebAir package through the generic runtime only.

    agentpkg/.venv/bin/python scripts/verify_webair.py [--report PATH]

Verifies the signed 0.8.0 artifact against WebAir's pinned publisher key, checks that the
source tree rebuilds to the same payload and that the signed bytes carry no personal data,
then runs every conversation of the fixture family in
`examples/webair-0.8.0-conversations.json` (the three-turn fixture conversation and the
single-turn search scenarios) through the generic conversation runner
(`agentpkg.conversation.Conversation` over `agentpkg.workflow`) with agentpkg's own fixture
adapters (exact-input replay of the package's fixture for both models and tools), with every
personal permission denied. Nothing from `demo/webair` is imported, and no network, model or
origin server is used. Whether the fixture's tool answers are WebAir's real answers is
established separately by `demo/webair/tests/test_package_contract.py`; the host-owned
capability conversations (quote, the card, the purchase) run in `demo/webair/tests/` on the
demo host's data and on the Agent Browsers.

0.1.0 to 0.7.0 are checked to be unchanged: earlier evidence describes those exact bytes, and
the unversioned `dist/webair.agent.pkg` stays 0.1.0, which the v0.1.0 release's runtime can read
(0.2.0 and later declare the `personal.read` permission kind). The permission ids, and so the
grants file `webair-0.2.0-grants.json`, are the same for 0.2.0 to 0.5.0. 0.4.0 adds only
publisher-declared profiles (`org.webagents:profiles-v0`), which agentpkg ignores; 0.5.0 answers
a request that names no departure airport instead of failing (T9); 0.6.0 reads the travel profile
from the person's memory and may propose one preference after a quote (memory.v0, T20), so its
grants file is `webair-0.6.0-grants.json`; 0.7.0 recomputes WebAir's fare totals in a WebAssembly
module (compute.v0, T22) under a required `compute.fares` permission, so its grants file is
`webair-0.7.0-grants.json`; 0.8.0 is a conversation (conversation.v0, T24): one message per
turn, a declared persistent state and a consent step before the simulated purchase, with the
same permission ids (`webair-0.8.0-grants.json`), and its module runs for real here.

Prints a JSON report; `passed` is false if any check fails.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import tempfile
from collections import Counter
from pathlib import Path

from agentpkg.conversation import Conversation
from agentpkg.execution.report import audit_summary, verify_audit_chain
from agentpkg.fixtures import FixtureRouter, fixture_adapters
from agentpkg.package import build_package, load_package, sha256, write_new
from agentpkg.signing import verify_package

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "dist/webair-0.8.0.agent.pkg"
ARCHIVE_070 = ROOT / "dist/webair-0.7.0.agent.pkg"
ARCHIVE_070_SHA256 = "c0265a283d0b2edd5c919e1bb7cb3a95e6ccfc449d76590d62b1a47ff3fbd808"
ARCHIVE_060 = ROOT / "dist/webair-0.6.0.agent.pkg"
ARCHIVE_060_SHA256 = "3055dd93a9f4e5f81f3ccddac77ccc9ce2c10b1e10dec35d9864fddf6fb58862"
ARCHIVE_050 = ROOT / "dist/webair-0.5.0.agent.pkg"
ARCHIVE_050_SHA256 = "4b087557cbd2b0ff186391dfd00f9068739f9a727ab2fd916a6512da1fde101b"
ARCHIVE_040 = ROOT / "dist/webair-0.4.0.agent.pkg"
ARCHIVE_040_SHA256 = "c12f9db3bd7b3b4b6721c67e1d0b8143ebd94381df0e5e57c196357b7ca77f63"
ARCHIVE_030 = ROOT / "dist/webair-0.3.0.agent.pkg"
ARCHIVE_030_SHA256 = "b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887"
ARCHIVE_020 = ROOT / "dist/webair-0.2.0.agent.pkg"
ARCHIVE_020_SHA256 = "3f135be80c2ac43b93f42acbcb648a3460b1ab39a831c251122331c99107a616"
ARCHIVE_010 = ROOT / "dist/webair-0.1.0.agent.pkg"
ARCHIVE_010_SHA256 = "73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c"
ALIAS = ROOT / "dist/webair.agent.pkg"
SOURCE = ROOT / "agents/webair"
KEY = ROOT / "examples/keys/webair-publisher.pub.pem"
CONVERSATIONS = ROOT / "examples/webair-0.8.0-conversations.json"
GRANTS = ROOT / "examples/webair-0.8.0-grants.json"
HOST_RESOURCES = ROOT / "demo/webair/host-resources.json"
CANONICAL_NODE_TYPES = {
    "llm",
    "tool",
    "map",
    "join",
    "validate",
    "output",
    "compute",
    "consent",
}
# Generic code that must not know WebAir exists: the runtime, the browser control plane,
# the execution host, the tool and model bridges, and the Agent Browser plugin.
GENERIC_CODE = [ROOT / "agentpkg/src/agentpkg", ROOT / "openclaw-agent-browser/src"]
GENERIC_SUFFIXES = {".py", ".json", ".ts", ".tsx", ".js", ".css", ".html"}
# 2^53 - 1, the fare-total schemas' integer bound (0.7.0), is the one long digit run allowed.
INTEGER_BOUND = "9007199254740991"
STRING_ENCODINGS = ("utf-8", "utf-16-le")


def genericity_scan() -> dict:
    hits = []
    scanned = 0
    for base in GENERIC_CODE:
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.suffix not in GENERIC_SUFFIXES:
                continue
            scanned += 1
            if "schemas/memory/" in path.as_posix():
                # The memory.v0 contracts are the specification's data, copied byte for byte
                # (its taxonomy names "airline" as a kind of travel preference).
                continue
            text = path.read_text(errors="replace")
            if re.search(
                r"webair|airline|passenger_demo|payment_demo|profile_demo",
                text,
                re.IGNORECASE,
            ):
                hits.append(path.relative_to(ROOT).as_posix())
    return {
        "files_scanned": scanned,
        "files_mentioning_webair": hits,
        "clean": not hits,
    }


def string_runs(data: bytes, *, minimum: int = 4) -> list[str]:
    """The printable string runs a compiled module stores, decoded as UTF-8 and as the UTF-16LE
    a compiler such as AssemblyScript keeps its strings in, so that an e-mail address or a card
    number compiled into a data segment is found by the same patterns as in the text members
    (T22 review nit 3)."""
    runs = [
        run.decode("ascii") for run in re.findall(rb"[\x20-\x7e]{%d,}" % minimum, data)
    ]
    wide = re.findall(rb"(?:[\x20-\x7e]\x00){%d,}" % minimum, data)
    runs += [run.decode("utf-16-le") for run in wide]
    return runs


def personal_data_scan(package, *, files: dict[str, bytes] | None = None) -> dict:
    """Which of the demo host's personal values, if any, the signed bytes contain.

    A WebAssembly module (0.7.0) is bytes, not text: its string runs (UTF-8 and UTF-16LE) are
    scanned with the same patterns as the text members, and each host value is also looked for
    as its encoded bytes anywhere in the module. `files` lets a test scan a synthetic payload.
    """
    files = package.files if files is None else files
    modules = {module["path"] for module in package.graph.get("modules", [])}
    text = "\n".join(
        data.decode("utf-8") for name, data in files.items() if name not in modules
    )
    code = [data for name, data in files.items() if name in modules]
    module_text = "\n".join(run for data in code for run in string_runs(data))
    definitions = json.loads(HOST_RESOURCES.read_text())
    values = []
    for resource in definitions["resources"]:
        values += [resource["id"], resource["label"]]
        values += [
            value
            for field, value in resource["value"].items()
            if field in {"given_name", "family_name", "contact_email", "display"}
        ]
    found = sorted(
        {
            value
            for value in values
            if value in text
            or value in module_text
            or any(
                value.encode(encoding) in data
                for data in code
                for encoding in STRING_ENCODINGS
            )
        }
    )
    scanned = text + "\n" + module_text
    emails = sorted(set(re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", scanned)))
    card_like = bool(re.search(r"\b\d{13,19}\b", scanned.replace(INTEGER_BOUND, "")))
    return {
        "host_values_checked": len(values),
        "modules_scanned": len(code),
        "module_string_runs": sum(len(string_runs(data)) for data in code),
        "host_values_found": found,
        "email_addresses_found": emails,
        "card_like_digit_runs": card_like,
        "clean": not found and not emails and not card_like,
    }


def rebuild_matches(package) -> bool:
    with tempfile.TemporaryDirectory() as directory:
        rebuilt = load_package(
            build_package(SOURCE, Path(directory).resolve() / "webair.agent.pkg")
        )
    return rebuilt.files == package.files and rebuilt.digest == package.digest


def transcript_of(case: dict) -> dict:
    document = {
        "schema": "conversation.transcript.v0",
        "turns": [
            {
                "message": turn["message"],
                **({"consents": turn["consents"]} if turn["consents"] else {}),
            }
            for turn in case["turns"]
        ],
    }
    if case.get("end"):
        document["end"] = True
    return document


def run_conversation(package, case: dict) -> dict:
    router, handlers, _ = fixture_adapters(package)
    reports: dict[int, dict] = {}
    conversation = Conversation(
        package,
        # Every personal permission denied: a search needs none of them.
        grants=json.loads(GRANTS.read_text()),
        approved_tools=sorted(package.tools),
        adapters=lambda turn: {"router": router, "handlers": handlers, "memory": None},
        on_turn=lambda index, report, status: reports.__setitem__(index, report),
    )
    result = asyncio.run(conversation.run(transcript_of(case)))
    nodes = {node["id"]: node for node in package.graph["nodes"]}
    turns = []
    expected = True
    ids_ok = True
    known: set[str] = set()
    for turn_in, entry in zip(
        case["turns"], result["transcript"]["turns"], strict=True
    ):
        report = reports.get(entry["turn"], {})
        output = entry["reply"] or {}
        evidence = output.get("evidence") or {}
        observed = {
            "status": output.get("status"),
            "intent": output.get("intent"),
            "selected_fare_id": output.get("selected_fare_id"),
        }
        want = {key: turn_in["expect"].get(key) for key in observed}
        expected = expected and entry["status"] == "completed" and observed == want
        offered = {
            fare["fare_id"]
            for flight in (evidence.get("search") or {}).get("flights", [])
            for fare in flight["fares"]
        }
        known |= offered
        ids_ok = ids_ok and set(output.get("mentioned_fare_ids", [])) <= known
        ids_ok = ids_ok and (
            output.get("selected_fare_id") is None
            or output["selected_fare_id"] in offered
        )
        audit = report.get("audit", [])
        turns.append(
            {
                "turn": entry["turn"],
                "status": entry["status"],
                "message": entry["message"],
                "observed": observed,
                "expected": want,
                "no_booking_or_purchase": output.get("booking") is None
                and output.get("purchase") is None,
                "node_types_completed": dict(
                    sorted(
                        Counter(
                            nodes[e["node_id"]]["type"]
                            for e in audit
                            if e["action"] == "node.completed"
                            and e.get("node_id") in nodes
                        ).items()
                    )
                ),
                "nodes_skipped": sorted(
                    e["node_id"]
                    for e in audit
                    if e["action"] == "node.skipped" and e.get("node_id") in nodes
                ),
                "tool_calls": [
                    {"tool": e["tool"], "binding": e["binding"]}
                    for e in audit
                    if e["action"] == "tool.called"
                ],
                "model_tasks": [
                    e["task"] for e in audit if e["action"] == "model.called"
                ],
                "consents": entry["decisions"],
                "usage": entry["usage"],
            }
        )
    audit = result["audit"]
    summary = audit_summary(audit)
    checks = {
        "completed": result["status"] == "completed",
        "every_turn_as_expected": expected,
        "ids_from_tool_evidence": ids_ok,
        "audit_chain_valid": verify_audit_chain(audit)["valid"],
        "one_chain_across_turns": [e["sequence"] for e in audit]
        == list(range(1, len(audit) + 1)),
        "no_booking_or_purchase": all(t["no_booking_or_purchase"] for t in turns),
        "no_host_resource_read": not any(
            e["action"] == "tool.called" and "." in e.get("tool", "") for e in audit
        ),
        "no_consent_asked": not any(e["action"] == "consent.requested" for e in audit),
        "ended_as_declared": result["ended"]["reason"] in {"package", "host", "person"},
        "replay_router": isinstance(router, FixtureRouter) and router.synthetic,
    }
    return {
        "id": case["id"],
        "summary": case["summary"],
        "passed": all(checks.values()),
        "checks": checks,
        "turns": turns,
        "ended": result["ended"],
        "state": result["state"],
        "audit": {
            "events": summary["chain"]["events"],
            "chain_valid": summary["chain"]["valid"],
            "final_hash": summary["chain"]["final_hash"],
            "workers_spawned": summary["workers_spawned"],
        },
        "usage": result["usage"],
        "provenance": result["provenance"],
        "result": reports[1]["output"]
        if case["id"] == "hero" and 1 in reports
        else None,
    }


def verify() -> dict:
    package = load_package(ARCHIVE)
    signature = verify_package(ARCHIVE, KEY)
    graph = package.graph
    node_types = {node["type"] for node in graph["nodes"]} | {
        step["type"] for node in graph["nodes"] for step in node.get("steps", [])
    }
    document = json.loads(CONVERSATIONS.read_text())
    runs = [run_conversation(package, case) for case in document["fixture"]]
    genericity = genericity_scan()
    personal = personal_data_scan(package)
    earlier = verify_package(ARCHIVE_010, KEY)
    conversation = graph["conversation"]
    consents = [n for n in graph["nodes"] if n["type"] == "consent"]
    checks = {
        "signature_valid": signature["valid"] is True,
        "earlier_release_unchanged": sha256(ARCHIVE_010.read_bytes())
        == ARCHIVE_010_SHA256
        and earlier["valid"] is True
        and earlier["key_fingerprint"] == signature["key_fingerprint"],
        "release_0_2_0_unchanged": sha256(ARCHIVE_020.read_bytes())
        == ARCHIVE_020_SHA256
        and verify_package(ARCHIVE_020, KEY)["valid"] is True,
        "release_0_3_0_unchanged": sha256(ARCHIVE_030.read_bytes())
        == ARCHIVE_030_SHA256
        and verify_package(ARCHIVE_030, KEY)["valid"] is True,
        "release_0_4_0_unchanged": sha256(ARCHIVE_040.read_bytes())
        == ARCHIVE_040_SHA256
        and verify_package(ARCHIVE_040, KEY)["valid"] is True,
        "release_0_5_0_unchanged": sha256(ARCHIVE_050.read_bytes())
        == ARCHIVE_050_SHA256
        and verify_package(ARCHIVE_050, KEY)["valid"] is True,
        "release_0_6_0_unchanged": sha256(ARCHIVE_060.read_bytes())
        == ARCHIVE_060_SHA256
        and verify_package(ARCHIVE_060, KEY)["valid"] is True,
        "release_0_7_0_unchanged": sha256(ARCHIVE_070.read_bytes())
        == ARCHIVE_070_SHA256
        and verify_package(ARCHIVE_070, KEY)["valid"] is True,
        "alias_is_newest_release_runtime_compatible": ALIAS.read_bytes()
        == ARCHIVE_010.read_bytes(),
        "source_rebuilds_to_signed_payload": rebuild_matches(package),
        "no_personal_data_in_signed_bytes": personal["clean"],
        "profile_workflow_v0": graph["profile"] == "workflow.v0"
        and package.manifest["entrypoint"] == "workflow.v0",
        "canonical_operators_only": node_types <= CANONICAL_NODE_TYPES,
        "conversation_declared": conversation["budget"]["max_turns"] == 8
        and conversation.get("fixture") == "fixtures/transcript.json"
        and [n["id"] for n in consents] == ["confirm-purchase"]
        and consents[0]["permissions"] == ["booking.simulate_purchase"],
        "purchase_gated": set(package.tools["simulate-purchase"]["permissions"])
        >= {"booking.simulate_purchase"}
        and package.tools["simulate-purchase"]["side_effects"] == "write",
        "no_webair_code_in_generic_runtime_or_browser": genericity["clean"],
        "every_conversation_passed": all(run["passed"] for run in runs),
    }
    tools = package.tools
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "package": {
            "package_id": package.manifest["package_id"],
            "version": package.manifest["version"],
            "publisher": package.manifest["publisher"],
            "package_digest": package.digest,
            "archive": ARCHIVE.relative_to(ROOT).as_posix(),
            "archive_sha256": sha256(ARCHIVE.read_bytes()),
            "archive_bytes": ARCHIVE.stat().st_size,
            "payload_files": len(package.files),
            "signer_fingerprint": signature["key_fingerprint"],
            "verification": signature,
            "runtime_minimum_version": package.manifest["runtime"]["minimum_version"],
            "workflow_nodes": len(graph["nodes"]),
            "node_types": dict(
                sorted(Counter(n["type"] for n in graph["nodes"]).items())
            ),
            "conversation": {
                "state_schema": conversation["state_schema"],
                "persistent_keys": sorted(
                    package.json(conversation["state_schema"])["properties"]
                ),
                "budget": conversation["budget"],
                "end": conversation.get("end"),
                "consent_steps": [
                    {
                        "id": n["id"],
                        "permissions": n["permissions"],
                        "timeout_seconds": n["timeout_seconds"],
                    }
                    for n in consents
                ],
            },
            "tools": {
                tool_id: {
                    "binding": tool["binding"],
                    "execution": tool["execution"],
                    "method": tool["method"],
                    "endpoint": tool["endpoint"],
                    "permissions": tool["permissions"],
                    "side_effects": tool["side_effects"],
                    "approval_required": tool["approval_required"],
                }
                for tool_id, tool in sorted(tools.items())
            },
            "permissions": {
                p["id"]: {
                    "kind": p["kind"],
                    "required": p["required"],
                    "resources": p["resources"],
                }
                for p in package.policy["permissions"]
            },
            "model_requirements": package.manifest["model_requirements"],
            "host_resource_requests": {
                p["id"]: {"kind": p["kind"], "resource_types": p["resources"]}
                for p in package.policy["permissions"]
                if p["kind"] == "personal.read"
            },
            "action_authorities": [
                p["id"] for p in package.policy["permissions"] if p["kind"] == "payment"
            ],
        },
        "earlier_release": {
            "archive": ARCHIVE_010.relative_to(ROOT).as_posix(),
            "archive_sha256": sha256(ARCHIVE_010.read_bytes()),
            "signer_fingerprint": earlier["key_fingerprint"],
        },
        "personal_data": personal,
        "genericity": genericity,
        "conversations": runs,
        "scope": "offline fixture replay of the fixture conversations through the generic "
        "conversation runner and interpreter, every personal permission denied; synthetic token "
        "accounting; no live model, network, origin server or Agent Browser",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--report")
    args = parser.parse_args()
    report = verify()
    encoded = (json.dumps(report, indent=2, ensure_ascii=False) + "\n").encode()
    if args.report:
        write_new(args.report, encoded)
    print(encoded.decode(), end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
