"""The signed WebAir demo package, as the generic runtime sees it.

WebAir is a fictional airline origin (`demo/webair/`) that publishes this package next to
its HTML. These tests pin the shipped artifact and show it is an ordinary workflow.v0
package: it verifies with the standard tooling, runs through the unchanged CLI and
interpreter with the package's own fixture, asks for nothing it does not declare, and no
generic code knows it exists. That its tool contracts equal WebAir's published API, and
that its fixture's tool answers are WebAir's real answers, is tested on the origin side
(`demo/webair/tests/test_package_contract.py`), where the origin's code is importable.
"""

from __future__ import annotations

import asyncio
import json
import re
import zipfile
from pathlib import Path

import pytest

from agentpkg.browser.hosttools import empty_registry, evaluate_registry, tool_contract
from agentpkg.cli import main
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, load_package, sha256
from agentpkg.signing import verify_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "agents/webair"
ARCHIVE = ROOT / "dist/webair-0.1.0.agent.pkg"
ALIAS = ROOT / "dist/webair.agent.pkg"
KEY = ROOT / "examples/keys/webair-publisher.pub.pem"
GRANTS = ROOT / "examples/webair-grants.json"
SCENARIOS = json.loads((ROOT / "examples/webair-scenarios.json").read_text())["scenarios"]

PACKAGE_ID = "org.webagents.webair"
VERSION = "0.1.0"
DIGEST = "3b7c61a7bd9584e0217dda802065248c86dd135d210b8a06ab25239835cc2fb6"
ARCHIVE_SHA256 = "73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c"
FINGERPRINT = "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b"
OPERATIONS = {
    "search-flights": "search_flights",
    "get-fare-rules": "get_fare_rules",
    "prepare-booking": "prepare_booking",
    "simulate-purchase": "simulate_purchase",
}


@pytest.fixture(scope="module")
def package():
    return load_package(ARCHIVE)


# --- the artifact -------------------------------------------------------------------------


def test_shipped_artifact_identity_and_signature(package):
    assert (package.manifest["package_id"], package.manifest["version"]) == (PACKAGE_ID, VERSION)
    assert package.manifest["publisher"]["id"] == "webair-demo"
    assert package.digest == DIGEST
    assert sha256(ARCHIVE.read_bytes()) == ARCHIVE_SHA256
    report = verify_package(ARCHIVE, KEY)
    assert report["valid"] is True
    assert report["key_fingerprint"] == FINGERPRINT == package.signature["key_fingerprint"]
    assert ALIAS.read_bytes() == ARCHIVE.read_bytes()


def test_another_publishers_key_is_refused():
    with pytest.raises(Exception, match="host-pinned"):
        verify_package(ARCHIVE, ROOT / "examples/keys/meeting-agenda-publisher.pub.pem")


def test_source_rebuilds_to_the_signed_payload(tmp_path, package):
    first = load_package(build_package(SOURCE, tmp_path / "first.agent.pkg"))
    second = build_package(SOURCE, tmp_path / "second.agent.pkg")
    assert first.files == package.files and first.digest == package.digest
    assert second.read_bytes() == (tmp_path / "first.agent.pkg").read_bytes()


def test_archive_holds_only_declared_data(package):
    with zipfile.ZipFile(ARCHIVE) as archive:
        names = archive.namelist()
    assert set(names) == set(package.files) | {"integrity.json", "signatures/publisher.json"}
    assert all(
        name == "MANIFEST.agent" or Path(name).suffix in {".json", ".md"} for name in package.files
    )
    text = "\n".join(data.decode() for data in package.files.values())
    assert "PRIVATE KEY" not in text
    assert not re.search(r"\b(?:sk-|ghp_|xox[bp]-)[A-Za-z0-9_-]{8,}", text)
    assert not re.search(r"\b\d{13,19}\b", text), "a card-number-like digit run"
    emails = set(re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text))
    assert emails and all(email.endswith("@example.com") for email in emails)
    payment_ids = set(re.findall(r'"payment_method_id":\s*"([^"]+)"', text))
    assert payment_ids <= {"demo-visa-4242", "demo-travel-1234"}


# --- what the package asks for --------------------------------------------------------------


def test_tools_are_semantic_webair_operations(package):
    assert set(package.tools) == set(OPERATIONS)
    for tool_id, operation in OPERATIONS.items():
        tool = package.tools[tool_id]
        assert tool["binding"] == f"webair.{operation}"
        assert tool["execution"] == "remote" and tool["method"] == "POST"
        assert tool["endpoint"] == f"https://webair.example/api/v1/{operation}"
        assert tool["domains"] == ["webair.example"]
        assert tool["retries"] == 0 and tool["extensions"] == {}
        assert tool["input_schema"] == f"schemas/api/{operation}.input.schema.json"
    assert package.tools["simulate-purchase"]["side_effects"] == "write"
    assert package.tools["simulate-purchase"]["approval_required"] is True
    assert package.tools["prepare-booking"]["approval_required"] is True


def test_permissions_grant_nothing_beyond_webair_and_the_host_router(package):
    permissions = {p["id"]: p for p in package.policy["permissions"]}
    assert {p["kind"] for p in permissions.values()} == {"network", "model", "memory"}
    assert permissions["network.webair"]["required"] is True
    assert permissions["network.webair.booking"]["required"] is False
    for network in ("network.webair", "network.webair.booking"):
        assert permissions[network]["resources"] == ["webair.example"]
    assert package.policy["network"] == {
        "allowed_domains": ["webair.example"],
        "https_only": True,
        "allow_redirects": False,
    }
    requirements = package.manifest["model_requirements"]
    assert requirements["routing"] == "host" and requirements["fallback_policy"] == "deny"
    assert {task["id"] for task in requirements["tasks"]} == {"interpret", "select", "answer"}
    declared = json.dumps(package.manifest)
    for vendor in ("openai", "ollama", "anthropic", "gpt-", "qwen", "api_key"):
        assert vendor not in declared.lower()


def test_the_control_plane_derives_its_contracts_generically(package):
    contract = tool_contract(package, "search-flights")
    assert contract["endpoint_origin"] == "https://webair.example"
    assert contract["endpoint_path"] == "/api/v1/search_flights"
    assert contract["required_permission_ids"] == ["network.webair"]
    booking = tool_contract(package, "simulate-purchase")
    assert booking["optional_permission_ids"] == ["network.webair.booking"]
    # No host implements WebAir's tools yet: binding them is a host decision for a later
    # milestone, and no package text can create one.
    statuses = {
        t["tool_id"]: t["status"] for t in evaluate_registry(package, empty_registry())["tools"]
    }
    assert statuses == dict.fromkeys(OPERATIONS, "unbound")


# --- it runs through the unchanged generic runtime ----------------------------------------


@pytest.mark.parametrize("case", SCENARIOS, ids=lambda case: case["id"])
def test_every_scenario_replays_through_the_generic_interpreter(case, package):
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
    output = result["output"]
    assert output["status"] == case["expect"]["status"]
    assert output["selected_fare_id"] == case["expect"]["selected_fare_id"]
    assert result["provenance"]["interpreter"] == "agentpkg.workflow.Workflow"


def test_hero_cli_run_needs_only_the_read_tools(tmp_path, capsys):
    out = tmp_path / "hero"
    code = main(
        [
            "run",
            str(ARCHIVE),
            "--mode",
            "fixture",
            "--trust-key",
            str(KEY),
            "--grants",
            str(GRANTS),
            "--approve-tool",
            "search-flights",
            "--approve-tool",
            "get-fare-rules",
            "--out",
            str(out),
        ]
    )
    report = json.loads(capsys.readouterr().out)
    assert code == 0 and report["passed"] is True
    assert report["usage"]["tool_calls"] == {"search-flights": 1, "get-fare-rules": 3}
    result = json.loads((out / "result.json").read_text())["output"]
    fares = {
        fare["fare_id"]: fare["price_usd"]
        for flight in result["evidence"]["search"]["flights"]
        for fare in flight["fares"]
    }
    assert fares == {
        "WA101-20261009-BASIC": 704,
        "WA101-20261009-STANDARD": 858,
        "WA105-20261009-BASIC": 749,
    }
    assert (out / "answer.md").read_text().startswith("I found three nonstop WebAir fares")
    for name in ("audit.json", "usage.json", "provenance.json", "search.json", "fare-rules.json"):
        assert (out / name).is_file(), name


def test_purchase_cli_run_needs_every_approval(tmp_path, capsys):
    base = [
        "run",
        str(ARCHIVE),
        "--mode",
        "fixture",
        "--grants",
        str(GRANTS),
        "--input",
        str(ROOT / "examples/webair-purchase-input.json"),
    ]
    read_only = ["--approve-tool", "search-flights", "--approve-tool", "get-fare-rules"]
    assert main([*base, *read_only, "--out", str(tmp_path / "refused")]) == 2
    failed = json.loads((tmp_path / "refused/result.json").read_text())
    assert (failed["status"], failed["error_code"]) == ("failed", "permission_denied")
    capsys.readouterr()
    approvals = [arg for tool in OPERATIONS for arg in ("--approve-tool", tool)]
    assert main([*base, *approvals, "--out", str(tmp_path / "bought")]) == 0
    capsys.readouterr()
    result = json.loads((tmp_path / "bought/result.json").read_text())["output"]
    confirmation = result["evidence"]["simulated_confirmation"]
    assert confirmation["confirmation_id"] == "WA-DEMO-5KNBQ"
    assert (confirmation["real_transaction"], confirmation["amount_charged_usd"]) == (False, 0)


def test_workflow_uses_only_canonical_operators(package):
    nodes = package.graph["nodes"]
    types = {node["type"] for node in nodes} | {
        s["type"] for n in nodes for s in n.get("steps", [])
    }
    assert types <= {"llm", "tool", "map", "join", "validate", "output"}
    assert len(nodes) == 21


def test_no_generic_code_knows_webair():
    generic = [ROOT / "agentpkg/src/agentpkg", ROOT / "openclaw-agent-browser/src"]
    offenders = [
        path.relative_to(ROOT).as_posix()
        for base in generic
        for path in base.rglob("*")
        if path.is_file()
        and path.suffix in {".py", ".json", ".ts", ".js"}
        and re.search(r"webair", path.read_text(errors="replace"), re.IGNORECASE)
    ]
    assert offenders == []
