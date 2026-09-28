"""Offline acceptance of the Literature Review 0.2.2 corrections on the signed bytes.

A1 — evidence ids are globally unique within a run; colliding ids are refused,
never silently merged. A2 — a run with no grounded evidence completes with a
valid, claim-free result whose prose is the package's own fixed statement,
while every final check still runs.

Every scenario executes the preserved `dist/literature-review-0.2.2.agent.pkg` graph
through the real `Workflow` interpreter and every check it declares. Only the
model's answers and the three tool handlers are scripted, deterministically,
by the same `ScriptedReview` scenarios the test suite uses
(`agentpkg/tests/literature_scenarios.py`); nothing here contacts a model or
the network. The preserved 0.2.1 artifact is run on the same scenarios to show
the defects the corrections remove.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg/tests"))

from agentpkg.package import load_package, write_new
from agentpkg.runtime import digest
from agentpkg.signing import verify_package
from agentpkg.validation import validate_instance
from agentpkg.workflow import WorkflowError
from literature_scenarios import Scenario, ScriptedReview, run_scenario

CURRENT = ROOT / "dist/literature-review-0.2.2.agent.pkg"  # preserved; 0.2.3 is current
PREVIOUS = ROOT / "dist/literature-review-0.2.1.agent.pkg"
KEY = ROOT / "examples/keys/literature-review-publisher.pub.pem"


def events(report, action):
    return [event for event in report["audit"] if event["action"] == action]


def refused(package, scenario):
    router = ScriptedReview(scenario)
    try:
        run_scenario(package, scenario, router=router)
    except WorkflowError as error:
        report = error.execution_report
        failed = [
            event
            for event in events(report, "node.failed")
            if event.get("node_id") == error.node_id and "failed_check" in event
        ]
        return {
            "refused": True,
            "code": error.code,
            "node_id": error.node_id,
            "failed_check": failed[0]["failed_check"] if failed else None,
            "model_tasks": router.tasks,
            "deduplicated_events": len(events(report, "node.deduplicated")),
        }
    return {"refused": False, "model_tasks": router.tasks}


def honest(package, name, scenario):
    router = ScriptedReview(scenario)
    result = run_scenario(package, scenario, router=router)
    output = result["output"]
    validate_instance(
        package.files, package.graph["output_schema"], output, "honest result"
    )
    completed = [event["node_id"] for event in events(result, "node.completed")]
    return {
        "scenario": name,
        "status": result["status"],
        "related_work_first_line": output["related_work"].splitlines()[0],
        "claims": len(output["claims"]),
        "bibliography": len(output["bibliography"]),
        "evidence_table": len(output["evidence_table"]),
        "verification_results": len(output["verification_results"]),
        "unresolved": len(output["unresolved"]),
        "writer_or_verifier_called": bool({"write", "verify"} & set(router.tasks)),
        "skipped_nodes": sorted(
            {event["node_id"] for event in events(result, "node.skipped")}
        ),
        "final_checks_ran": "validate-output" in completed and "outputs" in completed,
        "output_schema_valid": True,
    }


def verify_all():
    current = load_package(CURRENT)
    previous = load_package(PREVIOUS)
    signature = verify_package(CURRENT, KEY)
    previous_signature = verify_package(PREVIOUS, KEY)
    assert current.manifest["version"] == "0.2.2"
    assert previous.manifest["version"] == "0.2.1"

    # A1: three concurrent workers, each numbering its own evidence e1, e2.
    scenario = Scenario(papers=3, evidence_per_paper=2, extraction_barrier=3)
    router = ScriptedReview(scenario)
    six = run_scenario(current, scenario, router=router)
    ids = [item["evidence_id"] for item in six["state"]["evidence_items"]]
    assert six["status"] == "completed" and len(ids) == 6 == len(set(ids))
    first, second = run_scenario(current, Scenario()), run_scenario(current, Scenario())
    collision = refused(current, Scenario(evidence_ids="local"))
    assert collision["refused"] and collision["node_id"] == "check-evidence"
    old = run_scenario(previous, Scenario(evidence_ids="local"))
    (dedup,) = events(old, "node.deduplicated")

    # A2: every way a bounded search can end with nothing grounded.
    empty = [
        honest(current, "nothing_included", Scenario(include=False)),
        honest(current, "nothing_resolved", Scenario(resolver_status="not_found")),
        honest(current, "no_evidence_in_sources", Scenario(extract_empty=True)),
        honest(
            current, "evidence_supports_no_claim", Scenario(synthesize_claims=False)
        ),
    ]
    assert all(row["status"] == "completed" and row["claims"] == 0 for row in empty)
    old_router = ScriptedReview(Scenario(include=False))
    run_scenario(previous, Scenario(include=False), router=old_router)

    # Grounding: an ungrounded claim is still refused by the final checks.
    grounding = refused(current, Scenario(verify_cites_missing_evidence=True))
    assert grounding["refused"] and grounding["node_id"] == "validate-output"

    return {
        "passed": True,
        "artifact": {
            "path": "dist/literature-review-0.2.2.agent.pkg",
            "version": current.manifest["version"],
            "digest": current.digest,
            "signature_valid": signature["valid"],
            "signer": signature["key_fingerprint"],
            "node_count": len(current.graph["nodes"]),
        },
        "previous_artifact_preserved": {
            "path": "dist/literature-review-0.2.1.agent.pkg",
            "version": previous.manifest["version"],
            "digest": previous.digest,
            "signature_valid": previous_signature["valid"],
            "signer": previous_signature["key_fingerprint"],
        },
        "a1_unique_evidence_ids": {
            "three_workers_e1_e2": {
                "status": six["status"],
                "peak_concurrent_extractions": router.peak_extractions,
                "evidence_ids": ids,
                "distinct": len(set(ids)),
                "evidence_table_rows": len(six["output"]["evidence_table"]),
                "claims": len(six["output"]["claims"]),
                "bibliography": len(six["output"]["bibliography"]),
                "deduplicated_events": len(events(six, "node.deduplicated")),
            },
            "deterministic_ids_and_output": [
                i["evidence_id"] for i in first["state"]["evidence_items"]
            ]
            == [i["evidence_id"] for i in second["state"]["evidence_items"]]
            and digest(first["output"]) == digest(second["output"]),
            "colliding_local_ids_on_0_2_2": collision,
            "same_collision_on_0_2_1": {
                "status": old["status"],
                "evidence_items_kept": len(old["state"]["evidence_items"]),
                "original_count": dedup["original_count"],
                "retained_count": dedup["retained_count"],
                "conflicting_duplicates": dedup["conflicting_duplicates"],
                "bibliography": len(old["output"]["bibliography"]),
            },
        },
        "a2_honest_empty_result": {
            "scenarios": empty,
            "0_2_1_model_tasks_for_nothing_included": old_router.tasks,
        },
        "grounding_still_enforced": grounding,
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
