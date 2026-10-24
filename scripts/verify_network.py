"""network.v0 (agentpkg 0.7.0): offline checks of the contract, the example packages and the
enforcement cases, printing JSON with `"passed"`.

    agentpkg/.venv/bin/python scripts/verify_network.py

Checks: the live workflow schema carries the spec's RFC 6902 patch (applying it again changes
nothing); the test package's source validates, declares what the spec requires, is its archive
and runs its fixture walk to the expected activations with one valid audit chain; the travel
network's walks enumerate to the star's sixteen and its bound is attained (through the pytest
module that runs every walk); and every enforcement case ends at the stage with the code the
list expects, on the reference runtime.
"""

from __future__ import annotations

import asyncio
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "spec" / "network-v0"
SCHEMAS = ROOT / "agentpkg" / "src" / "agentpkg" / "schemas"
EXAMPLES = ROOT / "examples" / "network"
TESTS = ROOT / "agentpkg" / "tests"


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
    step and checks the result (as `verify_conversation.py` does)."""
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


def _pytest(report, name, *files):
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
                *[str(TESTS / f) for f in files],
            ],
            capture_output=True,
            text=True,
            cwd=ROOT,
            check=False,
        )
    summary = (
        run.stdout.strip().splitlines()[-1] if run.stdout.strip() else run.stderr[-300:]
    )
    _check(report, name, run.returncode == 0, summary)


def main() -> int:
    sys.path.insert(0, str(ROOT / "agentpkg" / "src"))
    from agentpkg.delegation.analysis import enumerate_walks
    from agentpkg.delegation.declarations import network_records
    from agentpkg.execution.report import verify_audit_chain
    from agentpkg.fixtures import fixture_adapters
    from agentpkg.package import build_package, load_package
    from agentpkg.workflow import run_workflow

    report = {"schema": "webagents-verify-network-v0", "checks": [], "passed": True}
    live = load_json(SCHEMAS / "workflow.schema.json")
    patch = load_json(CONTRACTS / "workflow.schema.patch.json")
    _check(
        report,
        "schema workflow carries workflow.schema.patch.json",
        apply_idempotent(live, patch) == live,
    )
    node_types = live["$defs"]["node"]["properties"]["type"]["enum"]
    _check(report, "node types include network", "network" in node_types)
    sources = live["$defs"]["value"]["oneOf"][1]["properties"]["from"]["enum"]
    _check(report, "value sources include message", "message" in sources)
    # The test package: its source validates and says what the spec requires of it.
    source = EXAMPLES / "network-test"
    package = load_package(source)
    records = network_records(package)
    _check(report, "network-test declares a network", records is not None)
    _check(
        report,
        "network-test's bound: four Desk activations at most, 11,000 tokens of a 24,000 budget",
        records is not None
        and records["worst_case"]["activations"]
        == {"Desk": 4, "Lookup": 2, "Writer": 1}
        and records["worst_case"]["tokens"] == 4 * 4000 + 2 * 0 + 4000
        and records["worst_case"]["max_hops"] == 6,
        records["worst_case"] if records else None,
    )
    archive = EXAMPLES / "network-test.agent.pkg"
    if archive.exists():
        with tempfile.TemporaryDirectory() as scratch:
            target = Path(scratch).resolve() / "rebuilt.agent.pkg"
            rebuilt = load_package(build_package(source, target))
        built = load_package(archive)
        _check(
            report,
            "network-test archive is its source",
            rebuilt.digest == built.digest,
            {"digest": built.digest, "signed": built.signature is not None},
        )
    grants = load_json(EXAMPLES / "network-test-grants.json")
    router, handlers, input_value = fixture_adapters(package)
    result = asyncio.run(
        run_workflow(
            package,
            input_value,
            grants=grants,
            handlers=handlers,
            router=router,
            approved_tools=["lookup"],
        )
    )
    activated = [
        e["role"] for e in result["audit"] if e["action"] == "network.activated"
    ]
    _check(
        report,
        "the fixture walk runs Desk, Lookup, Desk, Writer, Desk and ends",
        result["status"] == "completed"
        and activated == ["Desk", "Lookup", "Desk", "Writer", "Desk"]
        and result["usage"]["tool_calls"] == {"lookup": 1},
        {"activated": activated},
    )
    chain = verify_audit_chain(result["audit"])
    decided = [e for e in result["audit"] if e["action"] == "route.decided"]
    _check(
        report,
        "one valid audit chain with every handoff decided",
        chain["valid"] and len(decided) == 5 and all(e["allowed"] for e in decided),
        {"events": chain["events"], "decisions": len(decided)},
    )
    travel = load_package(EXAMPLES / "travel-network")
    walks = enumerate_walks(travel.graph["network"])
    _check(
        report, "the travel network admits sixteen walks", len(walks) == 16, len(walks)
    )
    _pytest(
        report,
        "the travel network's bound is attained over every walk",
        "test_network_travel.py",
    )
    listed = load_json(EXAMPLES / "cases" / "cases.json")
    _pytest(
        report,
        "every enforcement case asserted on the reference",
        "test_network_cases.py",
    )
    report["cases"] = len(listed["cases"])
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
