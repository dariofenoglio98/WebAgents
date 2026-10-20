"""Offline acceptance check for both portable packages; no persistent private keys."""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
from pathlib import Path

from agentpkg.fixtures import fixture_adapters
from agentpkg.openclaw import stage_openclaw
from agentpkg.package import build_package, load_package, unpack_package, write_new
from agentpkg.signing import keygen, sign_package, verify_package
from agentpkg.validation import SCHEMAS
from agentpkg.workflow import run_workflow
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]

# The shipped artifacts no longer share one signer: `meeting-agenda` 0.2.1 and
# `literature-review` 0.2.1 each carry a package-specific development key.
SHIPPED_SIGNER_KEY = {
    "literature-review": ROOT / "examples/keys/literature-review-publisher.pub.pem",
    "meeting-agenda": ROOT / "examples/keys/meeting-agenda-publisher.pub.pem",
}
SHIPPED_ARTIFACT = {"literature-review": "literature-review-0.2.9.agent.pkg"}


async def execute(package):
    router, handlers, value = fixture_adapters(package)
    result = await run_workflow(
        package,
        value,
        router=router,
        handlers=handlers,
        grants={p["id"]: "session" for p in package.policy["permissions"]},
        # A declared tool needs an explicit approval as well as its permission.
        # This script is the operator, and it approves exactly what the package
        # declares; nothing is approved implicitly by the grants above.
        approved_tools=sorted(package.tools),
    )
    validator = Draft202012Validator(
        json.loads((SCHEMAS / "audit-event.schema.json").read_text()),
        format_checker=FormatChecker(),
    )
    for event in result["audit"]:
        validator.validate(event)
    assert result["status"] == "completed"
    assert result["provenance"]["interpreter"] == "agentpkg.workflow.Workflow"
    return result


def verify_all():
    reports = {}
    with tempfile.TemporaryDirectory(prefix="agentpkg-workflow-verify-") as scratch:
        temporary = Path(scratch).resolve()
        private, public = (
            temporary / "publisher.private.pem",
            temporary / "publisher.pem",
        )
        keygen(private, public)
        for name in ("literature-review", "meeting-agenda"):
            first = build_package(
                ROOT / "agents" / name, temporary / f"{name}.agent.pkg"
            )
            second = build_package(
                ROOT / "agents" / name, temporary / f"{name}-again.agent.pkg"
            )
            assert first.read_bytes() == second.read_bytes(), "Nondeterministic build"
            sign_package(first, private)
            sign_package(second, private)
            assert first.read_bytes() == second.read_bytes(), (
                "Nondeterministic signature"
            )
            verify_package(first, public)
            package = load_package(first)
            unpacked = unpack_package(first, temporary / f"{name}-source")
            rebuilt = build_package(unpacked, temporary / f"{name}-rebuilt.agent.pkg")
            assert load_package(rebuilt).digest == package.digest
            staged = stage_openclaw(
                first, temporary / f"{name}-workspace", trusted_key_path=public
            )
            assert staged["digest"] == package.digest
            a = asyncio.run(execute(package))
            b = asyncio.run(execute(package))
            assert a["output"] == b["output"] and a["state"] == b["state"]
            assert a["usage"] == b["usage"], "Nondeterministic fixture accounting"
            # The signed release of the current source. Literature Review's unversioned alias
            # stays 0.2.5 (dist/README.md, T10), so its current release is named by version.
            shipped = ROOT / "dist" / SHIPPED_ARTIFACT.get(name, f"{name}.agent.pkg")
            shipped_verification = verify_package(shipped, SHIPPED_SIGNER_KEY[name])
            assert shipped_verification["digest"] == package.digest, (
                "Stale distribution artifact"
            )
            reports[name] = {
                "passed": True,
                "digest": package.digest,
                "profile": a["provenance"]["profile"],
                "interpreter": a["provenance"]["interpreter"],
                "deterministic_build_sign_unpack": True,
                "shipped_signature_verified": True,
                "staged": staged["status"],
                "deterministic_output_and_usage": True,
                "node_count": len(package.graph["nodes"]),
                "audit_events": len(a["audit"]),
                "synthetic_token_units": a["usage"]["tokens"],
                "declared_remote_dispatches": a["usage"]["remote_calls"],
                "tool_calls": a["usage"]["tool_calls"],
                "peak_parallel_workers": a["usage"]["peak_parallel_workers"],
            }
    legacy = verify_package(
        ROOT / "dist/literature-review-legacy.agent.pkg",
        ROOT / "examples/keys/publisher.pub.pem",
    )
    return {
        "passed": True,
        "packages": reports,
        "legacy_signature_preserved": legacy["valid"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report", help="Optional new JSON report file; refuses overwrites"
    )
    args = parser.parse_args()
    report = verify_all()
    data = json.dumps(report, indent=2) + "\n"
    if args.report:
        write_new(args.report, data.encode())
    print(data, end="")


if __name__ == "__main__":
    main()
