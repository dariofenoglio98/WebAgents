"""Offline signed-package acceptance: every exported evidence row is its extraction record."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from agentpkg.fixtures import fixture_adapters
from agentpkg.package import load_package, sha256, write_new
from agentpkg.signing import verify_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[1]


def verify():
    archive = ROOT / "dist/literature-review-0.2.5.agent.pkg"
    package = load_package(archive)
    signature = verify_package(
        archive, ROOT / "examples/keys/literature-review-publisher.pub.pem"
    )
    router, handlers, value = fixture_adapters(package)
    result = asyncio.run(
        run_workflow(
            package,
            value,
            router=router,
            handlers=handlers,
            grants={p["id"]: "session" for p in package.policy["permissions"]},
            approved_tools=sorted(package.tools),
        )
    )
    state, output = result["state"], result["output"]
    evidence = {e["evidence_id"]: e for e in state["evidence_items"]}
    source = {
        j["paper"]["paper_id"]: j["response"]["best_match"]
        for j in state["resolved_jobs"]
    }
    cited = [row["evidence_id"] for row in state["review"]["evidence_table"]]
    checks = {
        "completed": result["status"] == "completed",
        "signature_valid": signature["valid"],
        "exact_evidence_table": bool(output["evidence_table"])
        and all(
            row == evidence[row["evidence_id"]] for row in output["evidence_table"]
        ),
        "verifier_selection_and_order_kept": [
            row["evidence_id"] for row in output["evidence_table"]
        ]
        == cited,
        "exact_final_quotes": all(
            c["text"] == evidence[c["evidence_ids"][0]]["quote"]
            for c in output["claims"]
            if c["support_type"] == "direct_quote"
        ),
        "exact_bibliography": all(
            r["metadata"] == source[r["paper_id"]] for r in output["bibliography"]
        ),
        "strict_final_validation_completed": any(
            e["action"] == "node.completed" and e.get("node_id") == "validate-output"
            for e in result["audit"]
        ),
        "alias_is_this_release": (
            ROOT / "dist/literature-review.agent.pkg"
        ).read_bytes()
        == archive.read_bytes(),
        "previous_archive_preserved": sha256(
            (ROOT / "dist/literature-review-0.2.4.agent.pkg").read_bytes()
        )
        == "f513e68ea23e045ed3665d8d71e46531147f017f0da80f999fb343afc3e1fe24",
    }
    assert all(checks.values()), checks
    return {
        "passed": True,
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "package_digest": package.digest,
        "archive_sha256": sha256(archive.read_bytes()),
        "signer_fingerprint": signature["key_fingerprint"],
        "checks": checks,
        "evidence_items": len(evidence),
        "evidence_table_rows": len(output["evidence_table"]),
        "model_tasks": router.calls,
        "usage": result["usage"],
        "scope": "offline fixture; does not establish live cross-provider acceptance",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report")
    args = parser.parse_args()
    report = verify()
    encoded = (json.dumps(report, indent=2) + "\n").encode()
    if args.report:
        write_new(args.report, encoded)
    print(encoded.decode(), end="")


if __name__ == "__main__":
    main()
