"""Offline signed-package acceptance with deterministic bookkeeping and exact quotes."""

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
    archive = ROOT / "dist/literature-review-0.2.4.agent.pkg"
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
    eligible = [r for r in state["citation_records"] if r["status"] == "resolved"]
    jobs = state["evidence_jobs"]
    evidence = {e["evidence_id"]: e for e in state["evidence_items"]}
    source = {
        j["paper"]["paper_id"]: j["response"]["best_match"]
        for j in state["resolved_jobs"]
    }
    checks = {
        "completed": result["status"] == "completed",
        "signature_valid": signature["valid"],
        "prepare_model_task_absent": "prepare" not in router.calls,
        "one_job_per_resolved_record": [j["record"] for j in jobs] == eligible,
        "unique_jobs": len({j["record"]["paper_id"] for j in jobs}) == len(jobs),
        "direct_drafts_contain_no_quote": all(
            c["text"] is None
            for c in state["review"]["claims"]
            if c["support_type"] == "direct_quote"
        ),
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
        "previous_archive_preserved": sha256(
            (ROOT / "dist/literature-review-0.2.3.agent.pkg").read_bytes()
        )
        == "32304cad852d162084a3bdd9a444e04e31423f1e660f7cefdaeee442c1520dff",
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
        "resolved_records": len(eligible),
        "evidence_jobs": len(jobs),
        "evidence_items": len(evidence),
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
