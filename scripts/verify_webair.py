"""Offline acceptance of the signed WebAir package through the generic runtime only.

    agentpkg/.venv/bin/python scripts/verify_webair.py [--report PATH]

Verifies the signed 0.5.0 artifact against WebAir's pinned publisher key, checks that the
source tree rebuilds to the same payload and that the signed bytes carry no personal data,
then runs every search scenario in `examples/webair-scenarios.json` through
`agentpkg.workflow` with agentpkg's own fixture adapters (exact-input replay of the package's
fixture for both models and tools), with every personal permission denied. Nothing from
`demo/webair` is imported, and no network, model or origin server is used. Whether the
fixture's tool answers are WebAir's real answers is established separately by
`demo/webair/tests/test_package_contract.py`; the host-owned capability scenarios run on the
Agent Browser host (`scripts/verify_webair_capabilities.py`).

0.1.0, 0.2.0, 0.3.0 and 0.4.0 are checked to be unchanged: earlier evidence describes those exact
bytes, and the unversioned `dist/webair.agent.pkg` stays 0.1.0, which the v0.1.0 release's
runtime can read (0.2.0 and later declare the `personal.read` permission kind). The permission
ids, and so the grants file, are the same for 0.2.0 to 0.5.0. 0.4.0 adds only
publisher-declared profiles (`org.webagents:profiles-v0`), which agentpkg ignores; 0.5.0 answers
a request that names no departure airport instead of failing (T9).

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

from agentpkg.execution.report import audit_summary, verify_audit_chain
from agentpkg.fixtures import FixtureRouter, fixture_adapters
from agentpkg.package import build_package, load_package, sha256, write_new
from agentpkg.signing import verify_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "dist/webair-0.5.0.agent.pkg"
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
SCENARIOS = ROOT / "examples/webair-scenarios.json"
GRANTS = ROOT / "examples/webair-0.2.0-grants.json"
HOST_RESOURCES = ROOT / "demo/webair/host-resources.json"
CANONICAL_NODE_TYPES = {"llm", "tool", "map", "join", "validate", "output"}
# Generic code that must not know WebAir exists: the runtime, the browser control plane,
# the execution host, the tool and model bridges, and the Agent Browser plugin.
GENERIC_CODE = [ROOT / "agentpkg/src/agentpkg", ROOT / "openclaw-agent-browser/src"]
GENERIC_SUFFIXES = {".py", ".json", ".ts", ".tsx", ".js", ".css", ".html"}


def genericity_scan() -> dict:
    hits = []
    scanned = 0
    for base in GENERIC_CODE:
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.suffix not in GENERIC_SUFFIXES:
                continue
            scanned += 1
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


def personal_data_scan(package) -> dict:
    """Which of the demo host's personal values, if any, the signed bytes contain."""
    text = "\n".join(data.decode() for data in package.files.values())
    definitions = json.loads(HOST_RESOURCES.read_text())
    values = []
    for resource in definitions["resources"]:
        values += [resource["id"], resource["label"]]
        values += [
            value
            for field, value in resource["value"].items()
            if field in {"given_name", "family_name", "contact_email", "display"}
        ]
    found = sorted({value for value in values if value in text})
    emails = sorted(set(re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text)))
    return {
        "host_values_checked": len(values),
        "host_values_found": found,
        "email_addresses_found": emails,
        "card_like_digit_runs": bool(re.search(r"\b\d{13,19}\b", text)),
        "clean": not found and not emails,
    }


def rebuild_matches(package) -> bool:
    with tempfile.TemporaryDirectory() as directory:
        rebuilt = load_package(
            build_package(SOURCE, Path(directory).resolve() / "webair.agent.pkg")
        )
    return rebuilt.files == package.files and rebuilt.digest == package.digest


def run_scenario(package, case: dict) -> dict:
    router, handlers, _ = fixture_adapters(package)
    result = asyncio.run(
        run_workflow(
            package,
            case["input"],
            router=router,
            handlers=handlers,
            # Every personal permission denied: a search needs none of them.
            grants=json.loads(GRANTS.read_text()),
            approved_tools=sorted(package.tools),
        )
    )
    output, audit = result["output"], result["audit"]
    evidence = output["evidence"]
    observed = {
        "status": output["status"],
        "selected_fare_id": output["selected_fare_id"],
    }
    offered = {
        fare["fare_id"]
        for flight in (evidence["search"] or {}).get("flights", [])
        for fare in flight["fares"]
    }
    nodes = {node["id"]: node for node in package.graph["nodes"]}
    completed = Counter(
        nodes[e["node_id"]]["type"]
        for e in audit
        if e["action"] == "node.completed" and e.get("node_id") in nodes
    )
    skipped = sorted(
        e["node_id"]
        for e in audit
        if e["action"] == "node.skipped" and e.get("node_id") in nodes
    )
    tools = [(e["tool"], e["binding"]) for e in audit if e["action"] == "tool.called"]
    summary = audit_summary(audit)
    checks = {
        "completed": result["status"] == "completed",
        "expected_outcome": observed == case["expect"],
        "ids_from_tool_evidence": set(output["mentioned_fare_ids"]) <= offered
        and (
            output["selected_fare_id"] is None or output["selected_fare_id"] in offered
        ),
        "audit_chain_valid": verify_audit_chain(audit)["valid"],
        "no_booking_or_purchase": output["booking"] is None
        and output["purchase"] is None,
        "no_host_resource_read": not any(
            e["action"] == "tool.called" and "." in e.get("tool", "") for e in audit
        ),
        "replay_router": isinstance(router, FixtureRouter) and router.synthetic,
    }
    return {
        "id": case["id"],
        "summary": case["summary"],
        "passed": all(checks.values()),
        "checks": checks,
        "observed": observed,
        "model_calls": router.calls,
        "tool_calls": [{"tool": tool, "binding": binding} for tool, binding in tools],
        "node_types_completed": dict(sorted(completed.items())),
        "nodes_skipped": skipped,
        "audit": {
            "events": summary["chain"]["events"],
            "chain_valid": summary["chain"]["valid"],
            "final_hash": summary["chain"]["final_hash"],
            "workers_spawned": summary["workers_spawned"],
        },
        "usage": {
            "synthetic_tokens": result["usage"]["tokens"],
            "remote_calls": result["usage"]["remote_calls"],
            "tool_calls": result["usage"]["tool_calls"],
            "peak_parallel_workers": result["usage"]["peak_parallel_workers"],
        },
        "provenance": result["provenance"],
        "result": output if case["id"] == "hero" else None,
    }


def verify() -> dict:
    package = load_package(ARCHIVE)
    signature = verify_package(ARCHIVE, KEY)
    graph = package.graph
    node_types = {node["type"] for node in graph["nodes"]} | {
        step["type"] for node in graph["nodes"] for step in node.get("steps", [])
    }
    scenarios = json.loads(SCENARIOS.read_text())["scenarios"]
    runs = [run_scenario(package, case) for case in scenarios]
    genericity = genericity_scan()
    personal = personal_data_scan(package)
    earlier = verify_package(ARCHIVE_010, KEY)
    checks = {
        "signature_valid": signature["valid"] is True,
        "earlier_release_unchanged": sha256(ARCHIVE_010.read_bytes())
        == ARCHIVE_010_SHA256
        and earlier["valid"] is True
        and earlier["key_fingerprint"] == signature["key_fingerprint"],
        "release_0_2_0_unchanged": sha256(ARCHIVE_020.read_bytes()) == ARCHIVE_020_SHA256
        and verify_package(ARCHIVE_020, KEY)["valid"] is True,
        "release_0_3_0_unchanged": sha256(ARCHIVE_030.read_bytes()) == ARCHIVE_030_SHA256
        and verify_package(ARCHIVE_030, KEY)["valid"] is True,
        "release_0_4_0_unchanged": sha256(ARCHIVE_040.read_bytes()) == ARCHIVE_040_SHA256
        and verify_package(ARCHIVE_040, KEY)["valid"] is True,
        "alias_is_newest_release_runtime_compatible": ALIAS.read_bytes()
        == ARCHIVE_010.read_bytes(),
        "source_rebuilds_to_signed_payload": rebuild_matches(package),
        "no_personal_data_in_signed_bytes": personal["clean"],
        "profile_workflow_v0": graph["profile"] == "workflow.v0"
        and package.manifest["entrypoint"] == "workflow.v0",
        "canonical_operators_only": node_types <= CANONICAL_NODE_TYPES,
        "no_webair_code_in_generic_runtime_or_browser": genericity["clean"],
        "every_scenario_passed": all(run["passed"] for run in runs),
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
        "scenarios": runs,
        "scope": "offline fixture replay of the search scenarios through the generic "
        "interpreter, every personal permission denied; synthetic token accounting; no live "
        "model, network, origin server or Agent Browser",
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
