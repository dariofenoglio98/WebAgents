"""The conformance suite's driver for the Python control plane (agentpkg.browser).

Runs one named scenario against `ControlPlane` in this process and prints one JSON document:
the steps it took and what each returned, in the vocabulary `drivers/control-plane.ts` uses for
the Chrome core, so the runner can compare the two step by step. It never executes a package:
the control plane cannot, and a lease is only bytes plus permission to read them once.

The world is the T3 authorization fixture's (`chrome-agent-browser/test/fixtures/authorization/
inputs.json`, written by `scripts/make-authorization-fixtures.py` from this same control plane):
WebAir 0.4.0, its tool and resource registries and a one-model catalog.

    agentpkg/.venv/bin/python conformance/drivers/control_plane.py <scenario>
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from cryptography.hazmat.primitives.serialization import load_pem_public_key  # noqa: E402

from agentpkg.browser.control import ControlPlane, ControlPlaneConfig  # noqa: E402
from agentpkg.browser.errors import ControlPlaneError  # noqa: E402
from agentpkg.signing import fingerprint  # noqa: E402

WORLD = json.loads(
    (ROOT / "chrome-agent-browser/test/fixtures/authorization/inputs.json").read_text()
)
SCENARIOS = json.loads((Path(__file__).with_name("scenarios.json")).read_text())
KEY = load_pem_public_key((ROOT / "examples/keys/webair-publisher.pub.pem").read_bytes())


def codes(reasons) -> list[str]:
    return [reason["code"] for reason in reasons or []]


def changed_registry(registry: dict, tool_id: str) -> dict:
    """The same registry with one implementation's version moved: a different implementation."""
    copy = json.loads(json.dumps(registry))
    for binding in copy["bindings"]:
        if binding["tool_id"] == tool_id:
            binding["implementation_version"] = "0.1.1"
    return copy


def main(name: str) -> dict:
    scenario = SCENARIOS[name]
    steps: list[dict] = []
    plane = ControlPlane(
        ControlPlaneConfig(cache_dir=Path("cache"), trust_store_path=Path("trust.json"))
    )
    entry = plane.trust_add(KEY, display_name="WebAir demo publisher", publisher_id="webair-demo")
    package_path = ROOT / WORLD["package"]
    opened = plane._open_bytes(package_path.read_bytes(), {"kind": "file", "display": "pkg"})
    session = opened["session"]["id"]
    digest = opened["package"]["digest"]
    decisions = {**WORLD["decisions"], **scenario.get("decisions", {})}
    approvals = {**WORLD["tool_approvals"], **scenario.get("tool_approvals", {})}
    selections = {
        pid: rid
        for pid, rid in WORLD["resource_selections"].items()
        if decisions.get(pid, "deny") != "deny"
    }
    receipt = plane.authorize(
        session,
        package_digest=digest,
        decisions=decisions,
        tool_approvals=approvals,
        resource_registry=WORLD["resource_registry"],
        resource_selections=selections,
        profile_id=scenario.get("profile_id"),
    )
    steps.append(
        {
            "step": "authorize",
            "runnable": receipt["runnable"],
            "blocking_reasons": codes(receipt["blocking_reasons"]),
            "granted_permission_ids": receipt["granted_permission_ids"],
        }
    )
    registry = WORLD["tool_registry"]
    if scenario.get("registry_only"):
        registry = {
            **registry,
            "bindings": [
                binding
                for binding in registry["bindings"]
                if binding["tool_id"] in scenario["registry_only"]
            ],
        }
    try:
        prepared = plane.prepare_run_plan(
            session,
            package_digest=digest,
            receipt_id=receipt["receipt_id"],
            model_id=WORLD["catalog"]["models"][0]["id"],
            catalog=WORLD["catalog"],
            tool_registry=registry,
            resource_registry=WORLD["resource_registry"],
        )
    except ControlPlaneError as error:
        steps.append(
            {
                "step": "prepare",
                "outcome": "refused",
                "code": error.code,
                "reasons": sorted(codes(error.details.get("blocking_reasons"))),
            }
        )
        return {"runtime": "agentpkg", "scenario": name, "steps": steps}
    plan = prepared["run_plan"]
    steps.append(
        {
            "step": "prepare",
            "outcome": "ready" if prepared["preflight"]["ready"] else "not_ready",
            "required_tool_ids": plan["execution"]["required_tool_ids"],
            "denied_tool_ids": plan["execution"].get("denied_tool_ids", []),
            "bound_tool_ids": sorted(binding["tool_id"] for binding in plan["tool_bindings"]),
        }
    )
    for action in scenario["then"]:
        if action == "lease":
            state = plane.run_plan(session)["preflight"]
            step = {
                "step": "lease",
                "preflight_ready": state["ready"],
                "stale_reasons": codes(state["stale_reasons"]),
            }
            try:
                lease = plane.issue_execution_lease(
                    session,
                    package_digest=digest,
                    run_plan_id=plan["run_plan_id"],
                    run_plan_sha256=plan["run_plan_sha256"],
                )
                step["outcome"] = "issued"
                plane.release_execution_lease(session, lease["lease"]["lease_id"])
            except ControlPlaneError as error:
                step["outcome"] = "refused"
                step["code"] = error.code
            steps.append(step)
        elif action == "revoke_trust":
            plane.trust_remove(entry["added"]["fingerprint"])
            steps.append({"step": "revoke_trust"})
        elif action.startswith("change_tool:"):
            tool_id = action.split(":", 1)[1]
            plane.evaluate_tools(
                session, package_digest=digest, tool_registry=changed_registry(registry, tool_id)
            )
            steps.append({"step": action})
        else:
            raise SystemExit(f"unknown action {action!r}")
    plane.shutdown()
    return {"runtime": "agentpkg", "scenario": name, "steps": steps}


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in SCENARIOS:
        raise SystemExit(f"usage: control_plane.py <{'|'.join(SCENARIOS)}>")
    assert fingerprint(KEY).startswith("sha256:")
    with tempfile.TemporaryDirectory() as tmp:
        os.chdir(tmp)
        print(json.dumps(main(sys.argv[1]), indent=2))
