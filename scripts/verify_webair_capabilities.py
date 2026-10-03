"""Acceptance of host-owned capabilities, with WebAir 0.3.0 as the package.

    agentpkg/.venv/bin/python scripts/verify_webair_capabilities.py [--report PATH]
        [--private-key PATH]

Three parts, one report:

1. The signed artifact: `dist/webair-0.3.0.agent.pkg` verifies against WebAir's pinned
   publisher key, the source rebuilds to its exact payload (and, given `--private-key`,
   re-signs to its exact bytes), its signed bytes hold no personal data, and the
   host-resource requests and action authority it declares.
2. Discovery: the production control plane, over its HTTP API, discovers WebAir's package
   link on WebAir's own pages (`examples/webair-site.json`) and inspects the exact 0.3.0
   bytes served there, through the offline fixture web of `agentpkg/tests/web_fixtures.py`.
3. The host: `openclaw-agent-browser/test/webair-capabilities.test.ts`, run with vitest,
   drives scenarios A-H through the real control plane, authorization with host-resource
   picks, run plan, preflight, lease, runner and broker, with WebAir's four tools bound by the
   demo host's shipped operator bindings file (`demo/webair/host-bindings.json`, loaded through
   `tools.bindingsFile`) to the public origin, WebAir's recorded answers at
   the broker's transport and a scripted model, and writes what it observed: grants by
   opaque id and digest, every model call and whether its input held a personal value,
   every request bound for WebAir and what it carried, resolutions, audit validity, and
   each refused attack.

Needs Node and the plugin's dependencies (`npm ci` in openclaw-agent-browser). Nothing
contacts a network, a model provider, an origin server or a person's real data: every
person, card and booking is fictional. Prints a JSON report; `passed` is false if any check
fails.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))

from agentpkg.browser import BrowserService, ControlPlane, ControlPlaneConfig  # noqa: E402
from agentpkg.package import build_package, load_package, sha256, write_new  # noqa: E402
from agentpkg.signing import sign_package, verify_package  # noqa: E402
from web_fixtures import FixtureWeb, publish_webair  # noqa: E402

ARCHIVE = ROOT / "dist/webair-0.3.0.agent.pkg"
PUBLIC_ORIGIN = "https://webagents-webair-production.up.railway.app"
SOURCE = ROOT / "agents/webair"
KEY = ROOT / "examples/keys/webair-publisher.pub.pem"
HOST_RESOURCES = ROOT / "demo/webair/host-resources.json"
SCENARIOS = ROOT / "examples/webair-capability-scenarios.json"
PLUGIN = ROOT / "openclaw-agent-browser"
EXPECTED_FINGERPRINT = "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b"


def artifact_facts(private_key: str | None) -> dict:
    package = load_package(ARCHIVE)
    signature = verify_package(ARCHIVE, KEY)
    with tempfile.TemporaryDirectory() as directory:
        scratch = Path(directory).resolve()
        rebuilt_path = build_package(SOURCE, scratch / "rebuilt.agent.pkg")
        rebuilt = load_package(rebuilt_path)
        resigned = None
        if private_key:
            signed = sign_package(rebuilt_path, Path(private_key), scratch / "resigned.agent.pkg")
            resigned = signed.read_bytes() == ARCHIVE.read_bytes()
    text = "\n".join(data.decode() for data in package.files.values())
    definitions = json.loads(HOST_RESOURCES.read_text())
    personal = [
        value
        for resource in definitions["resources"]
        for value in [
            resource["id"],
            resource["label"],
            *(
                v
                for k, v in resource["value"].items()
                if k in {"given_name", "family_name", "contact_email", "display"}
            ),
        ]
        if value in text
    ]
    permissions = package.policy["permissions"]
    return {
        "artifact": ARCHIVE.relative_to(ROOT).as_posix(),
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "archive_sha256": sha256(ARCHIVE.read_bytes()),
        "package_digest": package.digest,
        "signer_fingerprint": signature["key_fingerprint"],
        "signature": {
            "valid": signature["valid"],
            "trust_scope": signature["trust_scope"],
        },
        "source_rebuilds_to_signed_payload": rebuilt.files == package.files
        and rebuilt.digest == package.digest,
        "resigned_bytes_identical": resigned,
        "graph_nodes": len(package.graph["nodes"]),
        "node_types": dict(sorted(Counter(n["type"] for n in package.graph["nodes"]).items())),
        "tools": {
            tool_id: {
                "execution": tool["execution"],
                "binding": tool["binding"],
                "permissions": tool["permissions"],
                "side_effects": tool["side_effects"],
            }
            for tool_id, tool in sorted(package.tools.items())
        },
        "permissions": {
            p["id"]: {
                "kind": p["kind"],
                "required": p["required"],
                "resources": p["resources"],
            }
            for p in permissions
        },
        "host_resource_requests": {
            p["id"]: p["resources"][0] for p in permissions if p["kind"] == "personal.read"
        },
        "action_authorities": [p["id"] for p in permissions if p["kind"] == "payment"],
        "personal_data_in_signed_bytes": personal,
        "email_addresses_in_signed_bytes": sorted(
            set(re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text))
        ),
    }


def discovery() -> dict:
    """WebAir's page, discovered by the production control plane, leads to the 0.3.0 bytes."""
    import urllib.request

    with tempfile.TemporaryDirectory(prefix="webair-capabilities-") as directory:
        scratch = Path(directory).resolve()
        web = FixtureWeb()
        publish_webair(web, archive=ARCHIVE.read_bytes())
        control = ControlPlane(
            ControlPlaneConfig(cache_dir=scratch / "cache", trust_store_path=scratch / "t.json"),
            transport=web.package_transport,
            discovery_network=web.network,
        )
        service = BrowserService(control, host="127.0.0.1", port=0)
        service.start_background()

        def call(method, path, body=None):
            data = json.dumps(body).encode() if body is not None else None
            request = urllib.request.Request(service.url + path, data=data, method=method)
            request.add_header("Authorization", "Bearer " + service.token)
            if data is not None:
                request.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read())

        try:
            found = call("POST", "/v0/websites/discover", {"url": "https://webair.example/"})
            (candidate,) = found["candidates"]
            summary = call("POST", "/v0/packages/open-url", {"url": candidate["resolved_url"]})
        finally:
            service.shutdown()
            service.server_close()
            web.close()
    validation = summary["validation"]
    return {
        "website": "https://webair.example/",
        "advertised": candidate["resolved_url"],
        "same_origin": candidate["same_origin"],
        "discovery_status": found["discovery_status"],
        "package_fetched_by_discovery": found["execution"]["package_fetched"],
        "inspected": {
            "version": summary["package"]["version"],
            "digest": summary["package"]["digest"],
            "archive_sha256": summary["snapshot"]["archive_sha256"],
            "validation": {
                layer: validation[layer]
                for layer in ("container_status", "integrity_status", "schema_status")
            },
            "runtime_status": validation["runtime_status"],
            "signature_status": summary["publisher"]["signature_status"],
            "trust_status_before_pin": summary["publisher"]["trust_status"],
        },
    }


def host_acceptance() -> dict:
    npx = shutil.which("npx")
    if npx is None:
        return {"ran": False, "reason": "npx is not available"}
    with tempfile.TemporaryDirectory() as directory:
        evidence = Path(directory) / "evidence.json"
        results = Path(directory) / "vitest.json"
        completed = subprocess.run(
            [
                npx,
                "vitest",
                "run",
                "test/webair-capabilities.test.ts",
                "--reporter=json",
                f"--outputFile={results}",
            ],
            cwd=PLUGIN,
            env={
                **os.environ,
                "WEBAIR_CAPABILITIES_EVIDENCE": str(evidence),
                "NO_COLOR": "1",
            },
            capture_output=True,
            text=True,
            timeout=1800,
            check=False,
        )
        report = json.loads(results.read_text()) if results.is_file() else {}
        observed = json.loads(evidence.read_text()) if evidence.is_file() else {}
    return {
        "ran": True,
        "suite": "openclaw-agent-browser/test/webair-capabilities.test.ts",
        "tests": report.get("numTotalTests"),
        "passed_tests": report.get("numPassedTests"),
        "failed_tests": report.get("numFailedTests"),
        "success": completed.returncode == 0 and report.get("success") is True,
        "observed": observed,
    }


def genericity() -> dict:
    words = re.compile(r"webair|airline|passenger_demo|payment_demo|profile_demo", re.IGNORECASE)
    hits = sorted(
        path.relative_to(ROOT).as_posix()
        for base in (
            ROOT / "agentpkg/src/agentpkg",
            ROOT / "openclaw-agent-browser/src",
        )
        for path in base.rglob("*")
        if path.is_file()
        and path.suffix in {".py", ".json", ".ts", ".js", ".css"}
        and words.search(path.read_text(errors="replace"))
    )
    return {"pattern": words.pattern, "files_matching": hits, "clean": not hits}


def verify(private_key: str | None) -> dict:
    artifact = artifact_facts(private_key)
    found = discovery()
    host = host_acceptance()
    generic = genericity()
    observed = host.get("observed", {})
    scenarios = observed.get("scenarios", {})
    attacks = observed.get("attacks", {})

    def model_clean(key):
        checked = scenarios.get(key, {}).get("model_inputs_checked", {})
        return (
            checked.get("personal_values_found") == [] and checked.get("card_like_found") is False
        )

    expected = json.loads(SCENARIOS.read_text())
    expect = {item["id"]: item["expect"] for item in expected["scenarios"]}
    checks = {
        "signature_valid_under_pinned_key": artifact["signature"]["valid"] is True
        and artifact["signer_fingerprint"] == EXPECTED_FINGERPRINT,
        "source_rebuilds_to_signed_payload": artifact["source_rebuilds_to_signed_payload"],
        "resigned_bytes_identical_when_checked": artifact["resigned_bytes_identical"]
        in (None, True),
        "no_personal_data_in_signed_bytes": not artifact["personal_data_in_signed_bytes"]
        and not artifact["email_addresses_in_signed_bytes"],
        "discovery_leads_to_the_0_3_0_bytes": found["advertised"]
        == "https://webair.example/agent.pkg"
        and found["inspected"]["archive_sha256"] == artifact["archive_sha256"]
        and found["inspected"]["digest"] == artifact["package_digest"]
        and set(found["inspected"]["validation"].values()) == {"valid"}
        and found["inspected"]["signature_status"] == "valid"
        and found["package_fetched_by_discovery"] is False,
        "host_suite_passed": host.get("success") is True,
        "webair_tools_bound_by_the_operator_file_to_the_public_origin": sorted(
            (b["tool_id"], b["binding_id"], b["endpoint_origin"])
            for b in (observed.get("offered") or {}).get("tool_bindings", [])
            if b["implementation_kind"] == "json_http"
        )
        == sorted(
            (tool, f"demo:webair.{operation}:1", PUBLIC_ORIGIN)
            for tool, operation in (
                ("search-flights", "search_flights"),
                ("get-fare-rules", "get_fare_rules"),
                ("prepare-booking", "prepare_booking"),
                ("simulate-purchase", "simulate_purchase"),
            )
        ),
        "A_profile_search": scenarios.get("A", {}).get("run", {}).get("status") == "completed"
        and scenarios["A"]["output"]["selected_fare_id"]
        == expect["profile-search"]["selected_fare_id"],
        "B_explicit_search_profile_denied": scenarios.get("B", {}).get("run", {}).get("status")
        == "completed"
        and scenarios["B"]["host_resource_resolutions"] == [],
        "C_booking": scenarios.get("C", {}).get("output", {}).get("booking", {}).get("quote_id")
        == expect["booking"]["quote_id"],
        "D_purchase_denied": scenarios.get("D", {}).get("run", {}).get("failed_node") == "payment"
        and scenarios["D"]["host_resource_resolutions"] == []
        and scenarios["D"]["webair_requests"] == [],
        "E_purchase_with_visa": (scenarios.get("E", {}).get("output") or {})
        .get("purchase", {})
        .get("confirmation_id")
        == expect["purchase-visa"]["confirmation_id"]
        and scenarios["E"]["output"]["purchase"]["real_transaction"] is False
        and scenarios["E"]["output"]["purchase"]["amount_charged_usd"] == 0,
        "models_never_saw_personal_data": all(model_clean(k) for k in "ABCE"),
        "identity_only_to_booking_calls": all(
            request["path"] in {"/api/v1/prepare_booking", "/api/v1/simulate_purchase"}
            for key in "ABCE"
            for request in scenarios.get(key, {}).get("webair_requests", [])
            if request["carries_identity"]
        ),
        "payment_identifier_only_to_purchase": all(
            request["path"] == "/api/v1/simulate_purchase"
            for key in "ABCE"
            for request in scenarios.get(key, {}).get("webair_requests", [])
            if request["carries_payment_identifier"]
        ),
        "audit_chains_valid": all(
            scenarios.get(k, {}).get("run", {}).get("audit_chain_valid") is True for k in "ABCDE"
        ),
        "F_substitution_refused": attacks.get("substitute_card", {}).get("purchase_requests_sent")
        == 0
        and attacks.get("substitute_card", {}).get("requests_carrying_the_substituted_identifier")
        == 0
        and attacks.get("substitute_passenger", {}).get("prepare_booking_sent") is False,
        "G_stale_resource_refused": all(
            attacks.get("stale_resource", {}).get(k, {}).get("refused") is True
            for k in ("changed", "removed")
        ),
        "H_replayed_or_invalid_grant_refused": attacks.get("replayed_once_grant", {}).get("refused")
        is True
        and len(attacks.get("invalid_grants", {})) == 4,
        "no_webair_or_demo_resource_in_generic_code": generic["clean"],
    }
    return {
        "schema": "webair-host-capabilities-verification-v0",
        "passed": all(checks.values()),
        "checks": checks,
        "artifact": artifact,
        "discovery": found,
        "host": {key: value for key, value in host.items() if key != "observed"},
        "offered": observed.get("offered"),
        "scenarios": scenarios,
        "attacks": attacks,
        "genericity": generic,
        "scope": "offline: the production control plane, runner and broker with the demo "
        "host's fictional resources; WebAir's recorded answers at the broker's transport; a "
        "scripted model. No network, provider, origin server or real personal data.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--report")
    parser.add_argument("--private-key", help="also check that re-signing reproduces the bytes")
    args = parser.parse_args()
    report = verify(args.private_key)
    encoded = (json.dumps(report, indent=2, ensure_ascii=False) + "\n").encode()
    if args.report:
        write_new(args.report, encoded)
    print(encoded.decode(), end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
