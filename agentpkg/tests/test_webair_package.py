"""The signed WebAir demo packages, as the generic runtime sees them.

WebAir is a fictional airline origin (`demo/webair/`) that publishes this package next to
its HTML. These tests pin the shipped artifacts and show they are ordinary workflow.v0
packages: they verify with the standard tooling, run through the unchanged CLI and
interpreter with the package's own fixture, ask for nothing they do not declare, and no
generic code knows they exist.

0.3.0 is the live demo's package: 0.2.0 with WebAir's public deployment as its declared host.
Like 0.2.0 it asks the person's host for a travel profile, a passenger identity and a payment
method it does not own (`personal.read` permissions with argument-free host-resource tools)
and for a separate, `once`-grantable purchase authority. These tests also pin what that
means for the signed bytes: no name, email, host resource id or label is in them. That the
host resolves, binds and withholds those resources correctly is tested on the host side
(`openclaw-agent-browser/test/webair-capabilities.test.ts`); that the tool contracts equal
WebAir's published API is tested on the origin side (`demo/webair/tests/`).

0.1.0 and 0.2.0 stay here unchanged and verifiable: earlier evidence describes those exact bytes.
"""

from __future__ import annotations

import asyncio
import json
import re
import zipfile
from pathlib import Path

import pytest

from agentpkg.browser.hostresources import RESOURCE_PERMISSION_KINDS
from agentpkg.browser.hosttools import empty_registry, evaluate_registry, tool_contract
from agentpkg.cli import main
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, canonical_json, load_package, sha256
from agentpkg.signing import verify_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "agents/webair"
ARCHIVE = ROOT / "dist/webair-0.3.0.agent.pkg"
ARCHIVE_020 = ROOT / "dist/webair-0.2.0.agent.pkg"
ARCHIVE_010 = ROOT / "dist/webair-0.1.0.agent.pkg"
ALIAS = ROOT / "dist/webair.agent.pkg"
KEY = ROOT / "examples/keys/webair-publisher.pub.pem"
GRANTS = ROOT / "examples/webair-0.2.0-grants.json"
HOST_RESOURCES = json.loads((ROOT / "demo/webair/host-resources.json").read_text())
SCENARIOS = json.loads((ROOT / "examples/webair-scenarios.json").read_text())["scenarios"]

PACKAGE_ID = "org.webagents.webair"
VERSION = "0.3.0"
DIGEST = "ffe8f5b344f97c631498bb6da3e17217ae7e5730721935b0e66c5d595b335e94"
ARCHIVE_SHA256 = "b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887"
# WebAir's public demo deployment: the one host 0.3.0 declares for its API.
PUBLIC_HOST = "webagents-webair-production.up.railway.app"
DIGEST_020 = "74f05a8d98b6ed7436ac6297bfd6e5b16cd625839405180cddfc31965ccab9e1"
ARCHIVE_SHA256_020 = "3f135be80c2ac43b93f42acbcb648a3460b1ab39a831c251122331c99107a616"
DIGEST_010 = "3b7c61a7bd9584e0217dda802065248c86dd135d210b8a06ab25239835cc2fb6"
ARCHIVE_SHA256_010 = "73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c"
FINGERPRINT = "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b"
OPERATIONS = {
    "search-flights": "search_flights",
    "get-fare-rules": "get_fare_rules",
    "prepare-booking": "prepare_booking",
    "simulate-purchase": "simulate_purchase",
}
HOST_TOOLS = {
    "personal.travel_profile": "profile.travel",
    "personal.passenger_identity": "identity.passenger",
    "wallet.payment_method": "wallet.payment",
}


@pytest.fixture(scope="module")
def package():
    return load_package(ARCHIVE)


# --- the artifacts --------------------------------------------------------------------------


def test_shipped_artifact_identity_and_signature(package):
    assert (package.manifest["package_id"], package.manifest["version"]) == (PACKAGE_ID, VERSION)
    assert package.manifest["publisher"]["id"] == "webair-demo"
    assert package.digest == DIGEST
    assert sha256(ARCHIVE.read_bytes()) == ARCHIVE_SHA256
    report = verify_package(ARCHIVE, KEY)
    assert report["valid"] is True
    assert report["key_fingerprint"] == FINGERPRINT == package.signature["key_fingerprint"]
    # The unversioned name stays the newest version the released 0.2.2 runtime can read:
    # 0.2.0 and 0.3.0 declare the `personal.read` permission kind, which only this branch
    # accepts.
    assert ALIAS.read_bytes() == ARCHIVE_010.read_bytes()


def test_the_earlier_release_is_unchanged_and_still_verifies():
    earlier = load_package(ARCHIVE_010)
    assert earlier.manifest["version"] == "0.1.0"
    assert earlier.digest == DIGEST_010
    assert sha256(ARCHIVE_010.read_bytes()) == ARCHIVE_SHA256_010
    assert verify_package(ARCHIVE_010, KEY)["key_fingerprint"] == FINGERPRINT
    # Its own fixture still replays its default task through today's interpreter.
    router, handlers, _ = fixture_adapters(earlier)
    result = asyncio.run(
        run_workflow(
            earlier,
            earlier.json(earlier.graph["fixture"])["input"],
            router=router,
            handlers=handlers,
            grants={p["id"]: "session" for p in earlier.policy["permissions"]},
            approved_tools=sorted(earlier.tools),
        )
    )
    assert result["output"]["status"] == "options_found"


def test_0_2_0_is_unchanged_and_still_verifies():
    earlier = load_package(ARCHIVE_020)
    assert earlier.manifest["version"] == "0.2.0"
    assert earlier.digest == DIGEST_020
    assert sha256(ARCHIVE_020.read_bytes()) == ARCHIVE_SHA256_020
    assert verify_package(ARCHIVE_020, KEY)["key_fingerprint"] == FINGERPRINT


def test_0_3_0_differs_from_0_2_0_only_for_the_live_host(package):
    """The live version changes where WebAir is declared to be, and nothing it does."""
    earlier = load_package(ARCHIVE_020)
    changed = sorted(
        name
        for name in set(earlier.files) | set(package.files)
        if earlier.files.get(name) != package.files.get(name)
    )
    remote = [f"tools/{name}.tool.json" for name in OPERATIONS]
    assert changed == sorted(["MANIFEST.agent", "README.md", "policy/policy.json", *remote])
    # Policy and tool declarations: the host, swapped back, gives 0.2.0's bytes exactly.
    for name in ["policy/policy.json", *remote]:
        swapped = package.files[name].replace(PUBLIC_HOST.encode(), b"webair.example")
        assert swapped == earlier.files[name], name
    # The manifest: version, date and the informational origin; nothing else.
    now = json.loads(package.files["MANIFEST.agent"])
    then = json.loads(earlier.files["MANIFEST.agent"])
    assert (then["version"], now["version"]) == ("0.2.0", "0.3.0")
    origin = now["extensions"]["org.webagents.webair:origin"]
    assert origin.pop("origin") == f"https://{PUBLIC_HOST}"
    for key in ("version", "created_at"):
        now.pop(key)
        then.pop(key)
    assert now == then
    # No trace of the placeholder anywhere in the live package.
    assert all(b"webair.example" not in data for data in package.files.values())


def test_another_publishers_key_is_refused():
    with pytest.raises(Exception, match="host-pinned"):
        verify_package(ARCHIVE, ROOT / "examples/keys/meeting-agenda-publisher.pub.pem")


def test_source_rebuilds_to_the_signed_payload(tmp_path, package):
    first = load_package(build_package(SOURCE, tmp_path / "first.agent.pkg"))
    second = build_package(SOURCE, tmp_path / "second.agent.pkg")
    assert first.files == package.files and first.digest == package.digest
    assert second.read_bytes() == (tmp_path / "first.agent.pkg").read_bytes()


def test_archive_holds_only_declared_data_and_no_personal_data(package):
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
    assert "••••" not in text
    # No email address at all: the passenger's comes from the host, at run time.
    assert re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text) == []
    # Nothing the demo host holds: ids, labels, names, emails.
    for resource in HOST_RESOURCES["resources"]:
        assert resource["id"] not in text
        assert resource["label"] not in text
        for field, value in resource["value"].items():
            if field in {"given_name", "family_name", "contact_email", "display"}:
                assert value not in text, (resource["id"], field)
    # WebAir's API contract names the demo payment methods it accepts; nothing else does.
    for name, data in package.files.items():
        if "demo-visa-4242" in data.decode() or "demo-travel-1234" in data.decode():
            assert name.startswith("schemas/api/"), name


def test_host_resource_schemas_are_exactly_the_hosts(package):
    for resource_type in HOST_RESOURCES["types"]:
        path = f"schemas/host/{resource_type['id']}.schema.json"
        assert canonical_json(package.json(path)) == canonical_json(resource_type["schema"])


# --- what the package asks for --------------------------------------------------------------


def test_tools_are_webair_operations_and_host_resource_requests(package):
    assert set(package.tools) == set(OPERATIONS) | set(HOST_TOOLS)
    for tool_id, operation in OPERATIONS.items():
        tool = package.tools[tool_id]
        assert tool["binding"] == f"webair.{operation}"
        assert tool["execution"] == "remote" and tool["method"] == "POST"
        assert tool["endpoint"] == f"https://{PUBLIC_HOST}/api/v1/{operation}"
        assert tool["domains"] == [PUBLIC_HOST]
        assert tool["retries"] == 0 and tool["extensions"] == {}
        assert tool["input_schema"] == f"schemas/api/{operation}.input.schema.json"
    for tool_id, permission in HOST_TOOLS.items():
        tool = package.tools[tool_id]
        assert tool["binding"] == f"host.resource.{tool_id}"
        assert tool["execution"] == "local" and tool["endpoint"] is None and tool["domains"] == []
        assert tool["permissions"] == [permission]
        assert tool["input_schema"] == "schemas/host/empty-input.schema.json"
        assert package.json(tool["input_schema"])["additionalProperties"] is False
        assert package.json(tool["input_schema"])["properties"] == {}
        assert tool["output_schema"] == f"schemas/host/{tool_id}.schema.json"
        assert tool["side_effects"] == "read" and tool["approval_required"] is True
    # Who may carry what: the identity to the two booking calls, the payment method to the
    # purchase only, and neither to search or fare rules.
    assert package.tools["search-flights"]["permissions"] == ["network.webair"]
    assert package.tools["get-fare-rules"]["permissions"] == ["network.webair"]
    assert package.tools["prepare-booking"]["permissions"] == [
        "network.webair",
        "identity.passenger",
    ]
    assert set(package.tools["simulate-purchase"]["permissions"]) == {
        "network.webair",
        "booking.simulate_purchase",
        "identity.passenger",
        "wallet.payment",
    }
    assert package.tools["simulate-purchase"]["side_effects"] == "write"


def test_permissions_request_resources_and_a_separate_purchase_authority(package):
    permissions = {p["id"]: p for p in package.policy["permissions"]}
    assert {p["kind"] for p in permissions.values()} == {
        "network",
        "model",
        "memory",
        "personal.read",
        "payment",
    }
    for required in ("network.webair", "model.reasoning", "memory.session"):
        assert permissions[required]["required"] is True
    for tool_id, permission in HOST_TOOLS.items():
        assert permissions[permission]["kind"] in RESOURCE_PERMISSION_KINDS
        assert permissions[permission]["required"] is False
        assert permissions[permission]["resources"] == [tool_id]
    purchase = permissions["booking.simulate_purchase"]
    assert (purchase["kind"], purchase["required"]) == ("payment", False)
    # The only payment-kind permission, consumed by one call: `once` is honourable.
    assert [p for p in permissions.values() if p["kind"] == "payment"] == [purchase]
    assert package.policy["network"] == {
        "allowed_domains": [PUBLIC_HOST],
        "https_only": True,
        "allow_redirects": False,
    }
    requirements = package.manifest["model_requirements"]
    assert requirements["routing"] == "host" and requirements["fallback_policy"] == "deny"
    assert {task["id"] for task in requirements["tasks"]} == {"interpret", "select", "answer"}
    declared = json.dumps(package.manifest)
    for vendor in ("openai", "ollama", "anthropic", "gpt-", "qwen", "api_key"):
        assert vendor not in declared.lower()


def test_no_model_role_can_read_a_host_resource(package):
    sensitive = {"profile", "passenger", "payment", "booking_request", "purchase_request"}
    sensitive |= {"quote", "confirmation", "purchase_result"}
    roles = {worker["id"]: worker for worker in package.graph["workers"]}
    model_roles = {node["worker"] for node in package.graph["nodes"] if node["type"] == "llm"}
    assert model_roles == {"Interpreter", "Selector", "Writer"}
    for role in model_roles:
        assert not sensitive & set(roles[role]["state_read"]), role
    assert roles["Personal"]["tools"] == sorted(HOST_TOOLS, key=list(HOST_TOOLS).index)
    assert roles["Personal"]["skills"] == []


def test_the_control_plane_derives_its_contracts_generically(package):
    contract = tool_contract(package, "search-flights")
    assert contract["endpoint_origin"] == f"https://{PUBLIC_HOST}"
    assert contract["endpoint_path"] == "/api/v1/search_flights"
    assert contract["required_permission_ids"] == ["network.webair"]
    purchase = tool_contract(package, "simulate-purchase")
    assert purchase["optional_permission_ids"] == [
        "booking.simulate_purchase",
        "identity.passenger",
        "wallet.payment",
    ]
    assert purchase["permission_kinds"] == ["network", "payment", "personal.read"]
    # A host with no implementations binds nothing: no package text can create a binding.
    statuses = {
        t["tool_id"]: t["status"] for t in evaluate_registry(package, empty_registry())["tools"]
    }
    assert statuses == dict.fromkeys([*OPERATIONS, *HOST_TOOLS], "unbound")


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
            grants=json.loads(GRANTS.read_text()),
            approved_tools=sorted(package.tools),
        )
    )
    output = result["output"]
    assert output["status"] == case["expect"]["status"]
    assert output["selected_fare_id"] == case["expect"]["selected_fare_id"]
    assert (output["booking"], output["purchase"]) == (None, None)
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


def test_a_purchase_without_host_resources_stops_before_any_is_read(tmp_path, capsys):
    """The generic CLI holds no host resources: a purchase stops at the first one it needs.

    The payment method is read first, so nothing else is read and WebAir is never called.
    (On the Agent Browser host the same task with the permission denied stops at the same
    node on the permission check; `webair-capabilities.test.ts` proves that path.)
    """
    approvals = [arg for tool in [*OPERATIONS, *HOST_TOOLS] for arg in ("--approve-tool", tool)]
    code = main(
        [
            "run",
            str(ARCHIVE),
            "--mode",
            "fixture",
            "--grants",
            str(GRANTS),
            "--input",
            str(ROOT / "examples/webair-purchase-input.json"),
            *approvals,
            "--out",
            str(tmp_path / "refused"),
        ]
    )
    capsys.readouterr()
    assert code == 2
    failed = json.loads((tmp_path / "refused/result.json").read_text())
    assert (failed["status"], failed["error_code"]) == ("failed", "permission_denied")
    audit = failed["audit"]
    assert [e for e in audit if e["action"] == "tool.called"] == []
    stopped = [e for e in audit if e["action"] == "tool.failed"]
    assert [(e["node_id"], e["tool"]) for e in stopped] == [("payment", "wallet.payment_method")]
    assert [e["node_id"] for e in audit if e["action"] == "node.failed"] == ["payment"]


def test_workflow_uses_only_canonical_operators(package):
    nodes = package.graph["nodes"]
    types = {node["type"] for node in nodes} | {
        s["type"] for n in nodes for s in n.get("steps", [])
    }
    assert types <= {"llm", "tool", "map", "join", "validate", "output"}
    assert len(nodes) == 34


def test_no_generic_code_knows_webair_or_its_demo_resources():
    generic = [ROOT / "agentpkg/src/agentpkg", ROOT / "openclaw-agent-browser/src"]
    words = r"webair|airline|passenger_demo|payment_demo|profile_demo|alex\.traveler"
    offenders = [
        path.relative_to(ROOT).as_posix()
        for base in generic
        for path in base.rglob("*")
        if path.is_file()
        and path.suffix in {".py", ".json", ".ts", ".js", ".css"}
        and re.search(words, path.read_text(errors="replace"), re.IGNORECASE)
    ]
    assert offenders == []
