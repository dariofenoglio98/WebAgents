"""Offline signed-package acceptance: screening jobs are the candidates' own records, and abstract
evidence states no source hash (Literature Review 0.2.6, T10)."""

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
    archive = ROOT / "dist/literature-review-0.2.6.agent.pkg"
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
    refs = {r["paper_id"]: r["file_id"] for r in state["screening_refs"]}
    abstract = [e for e in evidence.values() if e["scope"] == "abstract"]
    full_text = [e for e in evidence.values() if e["scope"] == "full_text"]
    checks = {
        "completed": result["status"] == "completed",
        "signature_valid": signature["valid"],
        "jobs_are_the_candidates": [j["paper"] for j in state["screening_jobs"]]
        == state["candidate_papers"],
        "one_reference_per_candidate": sorted(refs)
        == sorted(p["paper_id"] for p in state["candidate_papers"])
        and len(refs) == len(state["screening_refs"]),
        "file_ids_from_the_references": all(
            j["file_id"] == refs[j["paper"]["paper_id"]]
            for j in state["screening_jobs"]
        ),
        "abstract_evidence_states_no_hash": bool(abstract)
        and all(e["provenance"]["source_sha256"] == "" for e in abstract),
        "full_text_evidence_keeps_its_hash": bool(full_text)
        and all(len(e["provenance"]["source_sha256"]) == 64 for e in full_text),
        "exact_evidence_table": bool(output["evidence_table"])
        and all(
            row == evidence[row["evidence_id"]] for row in output["evidence_table"]
        ),
        "strict_final_validation_completed": any(
            e["action"] == "node.completed" and e.get("node_id") == "validate-output"
            for e in result["audit"]
        ),
        "alias_stays_0_2_5": sha256(
            (ROOT / "dist/literature-review.agent.pkg").read_bytes()
        )
        == "1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571",
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
        "candidates": len(state["candidate_papers"]),
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
