"""Offline acceptance of the signed WebAir package through the generic runtime only.

    agentpkg/.venv/bin/python scripts/verify_webair.py [--report PATH]

Verifies the signed artifact against WebAir's pinned publisher key, checks that the source
tree rebuilds to the same payload, then runs every demo scenario in
`examples/webair-scenarios.json` through `agentpkg.workflow` with agentpkg's own fixture
adapters (exact-input replay of the package's fixture for both models and tools). Nothing
from `demo/webair` is imported, and no network, model or origin server is used. Whether the
fixture's tool answers are WebAir's real answers is established separately by
`demo/webair/tests/test_package_contract.py`.

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
ARCHIVE = ROOT / "dist/webair-0.1.0.agent.pkg"
ALIAS = ROOT / "dist/webair.agent.pkg"
SOURCE = ROOT / "agents/webair"
KEY = ROOT / "examples/keys/webair-publisher.pub.pem"
SCENARIOS = ROOT / "examples/webair-scenarios.json"
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
            if re.search(r"webair", path.read_text(errors="replace"), re.I):
                hits.append(path.relative_to(ROOT).as_posix())
    return {
        "files_scanned": scanned,
        "files_mentioning_webair": hits,
        "clean": not hits,
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
            grants={p["id"]: "session" for p in package.policy["permissions"]},
            approved_tools=sorted(package.tools),
        )
    )
    output, audit = result["output"], result["audit"]
    evidence = output["evidence"]
    quote = evidence["booking_quote"] or {}
    confirmation = evidence["simulated_confirmation"] or {}
    observed = {
        "status": output["status"],
        "selected_fare_id": output["selected_fare_id"],
        **({"quote_id": quote.get("quote_id")} if "quote_id" in case["expect"] else {}),
        **(
            {"confirmation_id": confirmation.get("confirmation_id")}
            if "confirmation_id" in case["expect"]
            else {}
        ),
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
        e["node_id"] for e in audit if e["action"] == "node.skipped" and e.get("node_id") in nodes
    )
    tools = [(e["tool"], e["binding"]) for e in audit if e["action"] == "tool.called"]
    summary = audit_summary(audit)
    checks = {
        "completed": result["status"] == "completed",
        "expected_outcome": observed == case["expect"],
        "ids_from_tool_evidence": set(output["mentioned_fare_ids"]) <= offered
        and (output["selected_fare_id"] is None or output["selected_fare_id"] in offered),
        "audit_chain_valid": verify_audit_chain(audit)["valid"],
        "no_real_transaction": not confirmation
        or (confirmation["real_transaction"] is False and confirmation["amount_charged_usd"] == 0),
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
    checks = {
        "signature_valid": signature["valid"] is True,
        "alias_is_this_release": ALIAS.read_bytes() == ARCHIVE.read_bytes(),
        "source_rebuilds_to_signed_payload": rebuild_matches(package),
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
            "node_types": dict(sorted(Counter(n["type"] for n in graph["nodes"]).items())),
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
        },
        "genericity": genericity,
        "scenarios": runs,
        "scope": "offline fixture replay through the generic interpreter; synthetic token "
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
