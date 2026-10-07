"""Produce the Python control plane's receipt, run plan and evaluations for WebAir 0.4.0.

The Chrome core's tests compare their own output with these records (T3). Inputs are fixed
(timestamps, ids, a one-model catalog, a tool registry derived exactly as the Chrome host
derives its own, a resource registry with placeholder digests), so every hash is reproducible
from `inputs.json` with the Python reference. Written by the T3 session on
2026-10-06. Refresh after a reference change, from the repository root:

    agentpkg/.venv/bin/python chrome-agent-browser/scripts/make-authorization-fixtures.py [--out DIR]

Session and receipt ids and timestamps are new on every run; the Chrome tests rebuild every
record from the written `inputs.json`, so they compare like with like.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.serialization import load_pem_public_key

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))
from agentpkg.browser.authorization import BrowserPolicy
from agentpkg.browser.control import ControlPlane, ControlPlaneConfig
from agentpkg.browser.hosttools import tool_contract
from agentpkg.package import canonical_json, load_package, sha256

_args = argparse.ArgumentParser(description=__doc__.splitlines()[0])
_args.add_argument(
    "--out",
    type=Path,
    default=ROOT / "chrome-agent-browser" / "test" / "fixtures" / "authorization",
)
OUT = _args.parse_args().out.resolve()
OUT.mkdir(parents=True, exist_ok=True)
PKG = ROOT / "dist" / "webair-0.4.0.agent.pkg"
CAPTURED = "2026-10-06T12:00:00.000Z"

package = load_package(PKG)
host_resources = json.loads(
    (ROOT / "demo" / "webair" / "host-resources.json").read_text()
)
EMPTY_INPUT = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}
empty_sha = sha256(canonical_json(EMPTY_INPUT))
types = {}
for entry in host_resources["types"]:
    types[entry["id"]] = {
        "id": entry["id"],
        "display_name": entry["display_name"],
        "description": entry.get("description"),
        "permission_kind": entry["permission_kind"],
        "schema_sha256": sha256(canonical_json(entry["schema"])),
    }

# -- the tool registry exactly as chrome-agent-browser/src/core/hosttools.ts derives it (D-054)
SOURCE = (
    "chrome-agent-browser host tool registry (D-054): one generic HTTPS JSON binding per declared "
    "remote tool, derived from the signed declaration after the URL gate; one host-resource binding "
    "per vault type; other local tools unbound"
)
bindings = []
for tool_id in sorted(package.tools):
    contract = tool_contract(package, tool_id)
    if contract["remote"]:
        bindings.append(
            {
                "id": f"chrome:json_http:{tool_id}:1",
                "tool_id": tool_id,
                "binding": contract["binding"],
                "implementation_kind": "json_http",
                "implementation_id": "chrome.tool.json_http",
                "implementation_version": "0.1.0",
                "display_name": f"{tool_id}: one HTTPS {contract['method']} to {contract['endpoint_origin']}{contract['endpoint_path']}",
                "description": (
                    "This browser's generic JSON-over-HTTPS adapter, bound to exactly the origin, path, method and "
                    "schemas the package declares for this tool. No other request shape, path or destination is "
                    "reachable through it; no credential is attached."
                ),
                "remote": True,
                "available": True,
                "enabled": True,
                "endpoint": {
                    "origin": contract["endpoint_origin"],
                    "path": contract["endpoint_path"],
                    "method": contract["method"],
                },
                "contract": {
                    "input_schema_sha256": contract["input_schema_sha256"],
                    "output_schema_sha256": contract["output_schema_sha256"],
                    "permission_kinds": contract["permission_kinds"],
                    "side_effects": contract["side_effects"],
                },
                "limits": {
                    "timeout_seconds": min(max(contract["timeout_seconds"], 1), 120),
                    "max_request_bytes": 64 * 1024,
                    "max_response_bytes": 4 * 1024 * 1024,
                    "max_concurrent": 4,
                },
                "credentials": {"required": False, "configured": False},
            }
        )
    elif contract["binding"].startswith("host.resource."):
        type_ = types[tool_id]
        bindings.append(
            {
                "id": f"chrome:host-resource:{type_['id']}:1",
                "tool_id": type_["id"],
                "binding": f"host.resource.{type_['id']}",
                "implementation_kind": "host_resource",
                "implementation_id": "chrome.tool.host_resource",
                "implementation_version": "0.1.0",
                "display_name": f"{type_['display_name']} (held in this browser's vault)",
                "description": (
                    f"Returns the one {type_['display_name'].lower()} the person granted for this run. It takes no "
                    "arguments, so nothing a package sends can name another; it reaches no network and writes nothing."
                ),
                "remote": False,
                "available": True,
                "enabled": True,
                "contract": {
                    "input_schema_sha256": empty_sha,
                    "output_schema_sha256": type_["schema_sha256"],
                    "permission_kinds": [type_["permission_kind"]],
                    "side_effects": "read",
                },
                "limits": {
                    "timeout_seconds": 5,
                    "max_request_bytes": 64,
                    "max_response_bytes": 32 * 1024,
                    "max_concurrent": 4,
                },
                "credentials": {"required": False, "configured": False},
                "resource_type": type_["id"],
            }
        )
tool_registry = {
    "schema": "agentpkg-host-tool-registry-v0",
    "host": {
        "runtime": "chrome-agent-browser",
        "runtime_version": "0.1.0",
        "source": SOURCE,
        "captured_at": CAPTURED,
        "agent_id": None,
    },
    "bindings": bindings,
    "notes": [],
}

resource_registry = {
    "schema": "agentpkg-host-resource-registry-v0",
    "host": {
        "runtime": "chrome-agent-browser",
        "runtime_version": "0.1.0",
        "source": "chrome-agent-browser personal vault (chrome.storage.local, HMAC-SHA256 digests under a per-profile key, D-051)",
        "captured_at": CAPTURED,
    },
    "types": list(types.values()),
    # Placeholder digests: a vault's digests are keyed, so a fixture cannot carry real ones.
    "resources": [
        {
            "id": r["id"],
            "type": r["type"],
            "label": r["label"],
            "digest": sha256(("fixture:" + r["id"]).encode()),
        }
        for r in host_resources["resources"]
    ],
    "notes": [],
}

catalog = {
    "schema": "agentpkg-host-model-catalog-v0",
    "host": {
        "runtime": "chrome-agent-browser",
        "runtime_version": "0.1.0",
        "source": "fixture: one local model as Settings → Models would state it (STATE.md §5)",
        "captured_at": CAPTURED,
        "agent_id": None,
    },
    "models": [
        {
            "id": "ollama/qwen3:30b",
            "provider_id": "ollama",
            "model_id": "qwen3:30b",
            "display_name": "qwen3:30b",
            "available": True,
            "availability_reason": None,
            "selectable": True,
            "capabilities": {
                "structured_output": {
                    "value": True,
                    "basis": "derived",
                    "detail": "The adapter requests a constrained response and validates every answer against the schema, failing closed. This is the adapter's guarantee, not a provider declaration.",
                },
                "reasoning": {
                    "value": True,
                    "basis": "declared",
                    "detail": "Ollama /api/show capabilities: completion, tools, thinking.",
                },
                "tool_use": {
                    "value": True,
                    "basis": "declared",
                    "detail": "Ollama /api/show capabilities: completion, tools, thinking.",
                },
            },
            "limits": {
                "context_tokens": 65536,
                "native_context_window": 262144,
                "max_output_tokens": 16384,
            },
            "properties": {
                "local": True,
                "privacy_class": "local",
                "cost_class": "free",
                "status": None,
                "tags": ["local", "limits:settings", "context:capped"],
            },
        }
    ],
    "notes": [],
}

decisions = {
    "network.webair": "session",
    "profile.travel": "session",
    "identity.passenger": "session",
    "wallet.payment": "session",
    "booking.simulate_purchase": "once",
    "model.reasoning": "session",
    "memory.session": "session",
}
approvals = {tool_id: True for tool_id in package.tools}
selections = {
    "profile.travel": "profile_demo_traveler",
    "identity.passenger": "passenger_demo_alex",
    "wallet.payment": "payment_demo_visa",
}

with tempfile.TemporaryDirectory() as tmp:
    config = ControlPlaneConfig(
        cache_dir=Path(tmp) / "cache",
        trust_store_path=Path(tmp) / "trust.json",
        policy=BrowserPolicy(),
    )
    plane = ControlPlane(config)
    key = load_pem_public_key(
        (ROOT / "examples" / "keys" / "webair-publisher.pub.pem").read_bytes()
    )
    plane.trust_add(
        key, display_name="WebAir demo publisher", publisher_id="webair-demo"
    )
    # `open_file` records the absolute path of this checkout; the committed records must not
    # carry a home directory (T3 review 1, finding 7), so the same bytes are opened with a
    # repository-relative display. `_open_bytes` is what `open_file` calls after reading them.
    opened = plane._open_bytes(
        PKG.read_bytes(), {"kind": "file", "display": str(PKG.relative_to(ROOT))}
    )
    session_id = opened["session"]["id"]
    session = plane._session(session_id)  # fixture inputs
    permissions = plane.permissions(session_id)
    resource_evaluation = plane.evaluate_resources(
        session_id, package_digest=package.digest, resource_registry=resource_registry
    )
    receipt = plane.authorize(
        session_id,
        package_digest=package.digest,
        decisions=decisions,
        tool_approvals=approvals,
        resource_registry=resource_registry,
        resource_selections=selections,
    )
    tool_evaluation = plane.evaluate_tools(
        session_id, package_digest=package.digest, tool_registry=tool_registry
    )
    model_evaluation = plane.evaluate_models(
        session_id, package_digest=package.digest, catalog=catalog
    )
    prepared = plane.prepare_run_plan(
        session_id,
        package_digest=package.digest,
        receipt_id=receipt["receipt_id"],
        model_id="ollama/qwen3:30b",
        catalog=catalog,
        tool_registry=tool_registry,
        resource_registry=resource_registry,
    )
    inputs = {
        "note": __doc__.strip(),
        "package": str(PKG.relative_to(ROOT)),
        "session": {
            "session_id": session_id,
            "expires_at": session.expires_at,
            "archive_sha256": session.archive_sha256,
            "source": session.source,
            "instance_id": plane.instance_id,
            "evaluation": session.evaluation,
            "publisher": session.publisher,
            "trust_state": plane.trust.state(),
            "browser_policy": config.policy.as_json(),
        },
        "decisions": decisions,
        "tool_approvals": approvals,
        "resource_selections": selections,
        "tool_registry": tool_registry,
        "resource_registry": resource_registry,
        "catalog": catalog,
    }
    for name, value in {
        "inputs": inputs,
        "permissions": permissions,
        "resource_evaluation": resource_evaluation,
        "receipt": receipt,
        "tool_evaluation": tool_evaluation,
        "model_evaluation": model_evaluation,
        "run_plan": prepared["run_plan"],
        "preflight": prepared["preflight"],
    }.items():
        (OUT / f"{name}.json").write_text(
            json.dumps(value, indent=2, sort_keys=False) + "\n"
        )
    plane.shutdown()
print(
    json.dumps(
        {
            "written": sorted(p.name for p in OUT.iterdir()),
            "receipt_sha256": receipt["receipt_sha256"],
            "run_plan_sha256": prepared["run_plan"]["run_plan_sha256"],
            "ready": prepared["preflight"]["ready"],
        }
    )
)
