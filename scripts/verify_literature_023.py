"""Offline acceptance of the Literature Review 0.2.3 correction on the signed bytes.

B1 — bibliographic metadata in the final result is the Citation Resolver's own
record, attached by the workflow, never reproduced by a model. The live 0.2.2
refusal (run_4077223351c9…: `validate-output` assertion 0, `/metadata` against
`/response/best_match`) is reproduced on the preserved 0.2.2 bytes; the same
scenario completes on 0.2.3 with metadata identical to the resolver's.

Every scenario executes a signed artifact through the real `Workflow`
interpreter and every check it declares. Only the model's answers and the three
tool handlers are scripted, by the `ScriptedReview` scenarios the test suite
uses; nothing here contacts a model or the network.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg/tests"))

from agentpkg.fixtures import fixture_adapters
from agentpkg.package import load_package, sha256, write_new
from agentpkg.runtime import digest
from agentpkg.signing import verify_package
from agentpkg.workflow import WorkflowError, run_workflow
from literature_scenarios import Scenario, run_scenario

from agentpkg import __version__

CURRENT = ROOT / "dist/literature-review.agent.pkg"
PREVIOUS = ROOT / "dist/literature-review-0.2.2.agent.pkg"
KEY = ROOT / "examples/keys/literature-review-publisher.pub.pem"
LIVE_FAILED_CHECK = {
    "check": "assertion",
    "index": 0,
    "kind": "relation",
    "failure": "fields_do_not_match",
    "compare": {"left": "/metadata", "right": "/response/best_match", "op": "eq"},
}


def refused(package, scenario):
    try:
        run_scenario(package, scenario)
    except WorkflowError as error:
        attributed = [
            e["failed_check"]
            for e in error.execution_report["audit"]
            if e["action"] == "node.failed" and "failed_check" in e
        ]
        return {
            "refused": True,
            "error_code": error.code,
            "node_id": error.node_id,
            "failed_check": attributed[-1] if attributed else None,
        }
    return {"refused": False}


def exact(result):
    records = {
        job["paper"]["paper_id"]: job["response"]["best_match"]
        for job in result["state"]["resolved_jobs"]
    }
    bibliography = result["output"]["bibliography"]
    return bool(bibliography) and all(
        entry["metadata"] == records[entry["paper_id"]] for entry in bibliography
    )


def artifact(path, package):
    signature = verify_package(path, KEY)
    return {
        "path": str(path.relative_to(ROOT)),
        "version": package.manifest["version"],
        "archive_sha256": sha256(path.read_bytes()),
        "digest": package.digest,
        "signature_valid": signature["valid"],
        "signer": signature["key_fingerprint"],
        "minimum_runtime": package.manifest["runtime"]["minimum_version"],
        "node_count": len(package.graph["nodes"]),
    }


def verify_all():
    current, previous = load_package(CURRENT), load_package(PREVIOUS)
    assert current.manifest["version"] == "0.2.3"
    assert previous.manifest["version"] == "0.2.2"

    live = Scenario(rich_metadata=True, verify_bibliography="reconstruct")
    old_refusal = refused(previous, live)
    assert old_refusal["node_id"] == "validate-output"
    assert old_refusal["failed_check"] == LIVE_FAILED_CHECK
    old_exact = run_scenario(
        previous, Scenario(rich_metadata=True, verify_bibliography="copy")
    )

    fixed = run_scenario(current, Scenario(rich_metadata=True))
    again = run_scenario(current, Scenario(rich_metadata=True))
    assert fixed["status"] == "completed" and exact(fixed)

    negatives = {
        "verifier_writes_exact_metadata": refused(
            current, Scenario(rich_metadata=True, verify_bibliography="copy")
        ),
        "verifier_writes_transcribed_metadata": refused(current, live),
        "fabricated_bibliography_paper": refused(
            current, Scenario(verify_extra_reference="10.5555/fabricated")
        ),
        "unresolved_paper_in_bibliography": refused(
            current,
            Scenario(
                resolver_status_by_paper={3: "not_found"},
                verify_extra_reference="10.5555/scripted.3",
            ),
        ),
        "ambiguous_candidate_in_bibliography": refused(
            current,
            Scenario(
                resolver_status_by_paper={3: "ambiguous"},
                candidate_on_failure=True,
                verify_extra_reference="10.5555/scripted.3",
            ),
        ),
        "ungrounded_claim": refused(
            current, Scenario(verify_cites_missing_evidence=True)
        ),
        "colliding_evidence_ids": refused(current, Scenario(evidence_ids="local")),
    }
    assert all(row["refused"] for row in negatives.values())

    honest = {}
    for name, scenario in {
        "nothing_included": Scenario(include=False),
        "nothing_resolved": Scenario(resolver_status="not_found"),
        "no_evidence_in_sources": Scenario(extract_empty=True),
    }.items():
        result = run_scenario(current, scenario)
        honest[name] = {
            "status": result["status"],
            "claims": len(result["output"]["claims"]),
            "bibliography": len(result["output"]["bibliography"]),
        }
    assert all(row["status"] == "completed" for row in honest.values())

    router, handlers, value = fixture_adapters(current)
    replay = asyncio.run(
        run_workflow(
            current,
            value,
            router=router,
            handlers=handlers,
            grants={p["id"]: "session" for p in current.policy["permissions"]},
            approved_tools=sorted(current.tools),
        )
    )
    assert replay["status"] == "completed" and exact(replay)

    return {
        "passed": True,
        "runtime": f"agentpkg {__version__}",
        "artifact": artifact(CURRENT, current),
        "previous_artifact_preserved": artifact(PREVIOUS, previous),
        "b1_live_failure_reproduced_on_0_2_2": {
            "transcribed_bibliography": old_refusal,
            "matches_live_run_failed_check": old_refusal["failed_check"]
            == LIVE_FAILED_CHECK,
            "exact_copy_status": old_exact["status"],
        },
        "b1_fixed_on_0_2_3": {
            "status": fixed["status"],
            "bibliography": len(fixed["output"]["bibliography"]),
            "metadata_equals_resolver_best_match": exact(fixed),
            "deterministic": digest(fixed["output"]) == digest(again["output"]),
            "verifier_rows": fixed["state"]["review"]["bibliography"],
        },
        "refusals_on_0_2_3": negatives,
        "honest_empty_results_on_0_2_3": honest,
        "fixture_replay": {
            "status": replay["status"],
            "bibliography": len(replay["output"]["bibliography"]),
            "metadata_equals_resolver_best_match": exact(replay),
        },
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
