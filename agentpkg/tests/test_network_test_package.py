"""The network-test package (examples/network/network-test.agent.pkg): the signed archive verifies
against its development key, is its committed source, declares what the spec requires, and runs
its fixture walk through the CLI to the expected activations with a valid audit chain; the same
run twice gives the same result apart from ids and times."""

import hashlib
import json
from pathlib import Path

from agentpkg.cli import main
from agentpkg.execution.report import verify_audit_chain
from agentpkg.package import build_package, load_package
from agentpkg.signing import verify_package

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "examples" / "network"
ARCHIVE = EXAMPLES / "network-test.agent.pkg"
SOURCE = EXAMPLES / "network-test"
KEY = ROOT / "examples" / "keys" / "network-test-publisher.pub.pem"
GRANTS = EXAMPLES / "network-test-grants.json"


def test_the_signed_archive_is_the_source(tmp_path):
    verified = verify_package(ARCHIVE, trusted_key=KEY)
    assert verified["valid"] is True
    package = load_package(ARCHIVE)
    assert package.manifest["package_id"] == "org.webagents.network-test"
    # The signed bytes, pinned: a changed source is a new version and a new signature (D-003).
    assert package.digest == "9d1f2c95803ab06f47af63a442d9716ee72b41676adee5cbee03e81bac3a6976"
    assert hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() == (
        "b60b80bff72c6d87c8e61ffa4cd903265272868c8209e18b20bc810ca360be78"
    )
    assert ARCHIVE.stat().st_size == 19513
    assert verified["key_fingerprint"] == (
        "sha256:f081f81d9f71207ba8fdeb5d3f142c8c1e1ebb839c71e2b799916ddeb387ea00"
    )
    assert package.manifest["runtime"]["minimum_version"] == "0.7.0"
    rebuilt = load_package(build_package(SOURCE, tmp_path / "rebuilt.agent.pkg"))
    assert rebuilt.digest == package.digest
    network = package.graph["network"]
    assert network["entry"] == "Desk" and network["max_hops"] == 6
    assert sorted(network["roles"]) == ["Desk", "Lookup", "Writer"]
    assert [n["id"] for n in package.graph["nodes"] if n["type"] == "network"] == ["delegate"]
    assert network["roles"]["Desk"]["edges"] == [
        {"to": "Lookup", "max_uses": 2},
        {"to": "Writer", "max_uses": 1},
    ]
    assert "task" in network["roles"]["Desk"]["route"]
    assert network["roles"]["Lookup"]["route"]["next"] == "Desk"


def _run(tmp_path, name, capsys):
    out = tmp_path / name
    status = main(
        [
            "run",
            str(ARCHIVE),
            "--mode",
            "fixture",
            "--grants",
            str(GRANTS),
            "--approve-tool",
            "lookup",
            "--trust-key",
            str(KEY),
            "--out",
            str(out),
        ]
    )
    report = json.loads(capsys.readouterr().out)
    assert status == 0 and report["passed"] is True, report
    return report, out


def test_the_fixture_walk_runs_as_the_spec_says(tmp_path, capsys):
    report, out = _run(tmp_path, "first", capsys)
    assert report["status"] == "completed"
    assert report["usage"]["tool_calls"] == {"lookup": 1}
    assert list(report["usage"]["workers"]) == [
        "coordinator",
        "Desk:1",
        "Lookup:2",
        "Desk:3",
        "Writer:4",
        "Desk:5",
    ]
    result = json.loads((out / "result.json").read_text())
    assert result["output"]["draft"].startswith("Draft: An agent package")
    assert len(result["output"]["answers"]) == 1
    audit = json.loads((out / "audit.json").read_text())
    chain = verify_audit_chain(audit)
    assert chain["valid"] is True and chain["events"] == len(audit)
    activated = [e["role"] for e in audit if e["action"] == "network.activated"]
    assert activated == ["Desk", "Lookup", "Desk", "Writer", "Desk"]
    decided = [
        (e["role"], e["next"], e["allowed"]) for e in audit if e["action"] == "route.decided"
    ]
    assert decided == [
        ("Desk", "Lookup", True),
        ("Lookup", "Desk", True),
        ("Desk", "Writer", True),
        ("Writer", "Desk", True),
        ("Desk", "done", True),
    ]
    started = next(e for e in audit if e["action"] == "network.started")
    assert started["bound"]["tokens"] == 20000 and started["bound"]["activations"] == {
        "Desk": 4,
        "Lookup": 2,
        "Writer": 1,
    }
    assert (out / "answer.json").is_file() and (out / "reply.txt").is_file()
    # Deterministic apart from ids and times: the same walk, the same result, the same usage.
    report2, out2 = _run(tmp_path, "second", capsys)
    assert json.loads((out2 / "result.json").read_text())["output"] == result["output"]
    assert report2["usage"]["tokens"] == report["usage"]["tokens"]
    audit2 = json.loads((out2 / "audit.json").read_text())
    assert [e["action"] for e in audit2] == [e["action"] for e in audit]
