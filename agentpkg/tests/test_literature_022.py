"""Literature Review 0.2.2: the two package-level corrections, proved on the signed bytes.

A1 — evidence ids are globally unique within a run. In the accepted 0.2.1 run
each extraction worker numbered its own paper's evidence `e1`, `e2`, … and the
join kept the first record per id, so three genuine evidence items were lost.
0.2.2 makes the id `<paper_id>:e<n>`, joins without deduplicating, and refuses
a run whose evidence ids collide instead of dropping evidence.

A2 — no grounded evidence terminates honestly. 0.2.1 asked the writer and the
verifier for a review even when nothing survived, and relied on the final
checks to refuse the unsupported result. 0.2.2 skips the model steps that
have nothing to work on and returns a valid, claim-free review whose prose is
the package's own fixed statement — while every final check still runs.

Every scenario goes through the real `Workflow` interpreter and every check the
package declares; `ScriptedReview` only answers the model's tasks. Each test runs
on the preserved 0.2.2 bytes and on the current artifact, so a later version
cannot lose either correction unnoticed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from literature_scenarios import Scenario, ScriptedReview, run_scenario
from shipped_keys import LITERATURE_FINGERPRINT, LITERATURE_KEY

from agentpkg.artifacts import artifact_records
from agentpkg.package import load_package
from agentpkg.runtime import digest
from agentpkg.signing import verify_package
from agentpkg.validation import validate_instance
from agentpkg.workflow import WorkflowError

ROOT = Path(__file__).resolve().parents[2]
PREVIOUS = ROOT / "dist/literature-review-0.2.1.agent.pkg"
# The artifact that introduced both corrections, and every version since.
ARTIFACTS = {
    "0.2.2": ROOT / "dist/literature-review-0.2.2.agent.pkg",
    "0.2.3": ROOT / "dist/literature-review-0.2.3.agent.pkg",
}
MODEL_STEPS_AFTER_EVIDENCE = {"synthesize", "write", "verify"}


@pytest.fixture(scope="module", params=sorted(ARTIFACTS))
def review(request):
    package = load_package(ARTIFACTS[request.param])
    assert package.manifest["version"] == request.param
    return package


@pytest.fixture(scope="module")
def previous():
    package = load_package(PREVIOUS)
    assert package.manifest["version"] == "0.2.1"
    return package


def _nodes(package):
    return {node["id"]: node for node in package.graph["nodes"]}


def _events(report, action):
    return [event for event in report["audit"] if event["action"] == action]


def _no_result_text(package):
    return _nodes(package)["verification"]["otherwise"]["object"]["related_work"]["literal"]


# -- the signed artifact ------------------------------------------------------
def test_the_corrections_ship_in_the_signed_artifact(review):
    version = review.manifest["version"]
    verified = verify_package(ARTIFACTS[version], LITERATURE_KEY)
    assert verified["valid"] and verified["version"] == version
    assert verified["key_fingerprint"] == LITERATURE_FINGERPRINT
    nodes = _nodes(review)
    assert "unique_by" not in nodes["join-evidence"]
    check = nodes["check-evidence"]
    assert check["type"] == "validate" and check["depends_on"] == ["join-evidence"]
    assert check["assertions"] == [
        {
            "kind": "relation",
            "rows": {"from": "state", "path": "/evidence_items"},
            "targets": {"from": "state", "path": "/evidence_items"},
            "row_key": "/evidence_id",
            "target_key": "/evidence_id",
        }
    ]
    assert nodes["synthesis"]["depends_on"] == ["check-evidence"]
    for node_id, pointer in (
        ("prepare-evidence", "/resolved_jobs"),
        ("synthesis", "/evidence_items"),
        ("writing", "/claims"),
        ("verification", "/claims"),
    ):
        assert nodes[node_id]["when"] == {
            "left": {"from": "state", "path": pointer},
            "op": "ne",
            "right": {"literal": []},
        }, node_id
    # The empty review is a constant in the signed graph, not model output.
    assert _no_result_text(review).startswith("## No sufficiently grounded literature found")


# -- A1: globally unique evidence ids ----------------------------------------
def test_three_workers_numbering_e1_e2_keep_six_distinct_evidence_items(review):
    scenario = Scenario(papers=3, evidence_per_paper=2, extraction_barrier=3)
    router = ScriptedReview(scenario)
    result = run_scenario(review, scenario, router=router)
    assert result["status"] == "completed"
    # The three extraction workers were genuinely concurrent...
    assert router.peak_extractions == 3
    items = result["state"]["evidence_items"]
    ids = [item["evidence_id"] for item in items]
    # ...each numbered its own evidence e1, e2, and all six survived.
    assert len(items) == 6 and len(set(ids)) == 6
    for item in items:
        paper_id, local = item["evidence_id"].rsplit(":", 1)
        assert paper_id == item["paper_id"]
        assert local in {"e1", "e2"}
    assert sorted(i.rsplit(":", 1)[1] for i in ids) == ["e1", "e1", "e1", "e2", "e2", "e2"]
    # Nothing was deduplicated, and every item reached the final evidence table.
    assert _events(result, "node.deduplicated") == []
    assert [row["evidence_id"] for row in result["output"]["evidence_table"]] == ids
    assert len(result["output"]["claims"]) == 6
    assert len(result["output"]["bibliography"]) == 3


def test_colliding_worker_local_ids_are_refused_rather_than_dropped(review):
    """0.2.1's failure mode, on 0.2.2: the run stops; no evidence disappears quietly."""
    scenario = Scenario(evidence_ids="local")
    router = ScriptedReview(scenario)
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario, router=router)
    assert caught.value.code == "schema_validation"
    assert caught.value.node_id == "check-evidence"
    report = caught.value.execution_report
    (failed,) = [
        event
        for event in _events(report, "node.failed")
        if event.get("node_id") == "check-evidence" and "failed_check" in event
    ]
    assert failed["failed_check"] == {
        "check": "assertion",
        "index": 0,
        "kind": "relation",
        "failure": "duplicate_target_key",
        "target_key": "/evidence_id",
    }
    # Refused before any claim could be written on a partial evidence set.
    assert not MODEL_STEPS_AFTER_EVIDENCE & set(router.tasks)
    assert _events(report, "node.deduplicated") == []
    # Identifiers and pointers only: no quote reached the audit.
    assert "Scripted method" not in json.dumps(report["audit"])


def test_the_same_collision_silently_lost_evidence_in_0_2_1(previous):
    """The defect this version fixes, reproduced on the preserved 0.2.1 artifact."""
    scenario = Scenario(evidence_ids="local")
    result = run_scenario(previous, scenario)
    # 0.2.1 completed: six extracted items became two, and only the audit said so.
    assert result["status"] == "completed"
    assert len(result["state"]["evidence_items"]) == 2
    (event,) = _events(result, "node.deduplicated")
    assert event["node_id"] == "join-evidence"
    assert event["original_count"] == 6 and event["retained_count"] == 2
    assert event["conflicting_duplicates"] == 4
    assert len(result["output"]["bibliography"]) == 1  # two of three papers vanished


def test_evidence_ids_are_deterministic_across_runs(review):
    first = run_scenario(review, Scenario())
    second = run_scenario(review, Scenario())
    assert [item["evidence_id"] for item in first["state"]["evidence_items"]] == [
        item["evidence_id"] for item in second["state"]["evidence_items"]
    ]
    assert digest(first["output"]) == digest(second["output"])


def test_the_replay_fixture_follows_the_id_contract(review):
    fixture = review.json(review.graph["fixture"])
    for case in fixture["models"]["extract"]:
        for number, item in enumerate(case["output"], start=1):
            assert item["evidence_id"] == f"{item['paper_id']}:e{number}"


# -- A2: an honest empty result ------------------------------------------------
@pytest.mark.parametrize(
    ("name", "scenario", "expected_tasks", "unresolved"),
    [
        (
            "nothing_included",
            Scenario(include=False),
            ["plan", "normalize", "screen", "screen", "screen", "select"],
            0,
        ),
        (
            "nothing_resolved",
            Scenario(resolver_status="not_found"),
            ["plan", "normalize", "screen", "screen", "screen", "select", "prepare"],
            3,
        ),
        (
            "no_evidence_in_sources",
            Scenario(extract_empty=True),
            ["plan", "normalize", "screen", "screen", "screen", "select", "prepare"]
            + ["extract"] * 3,
            0,
        ),
        (
            "evidence_supports_no_claim",
            Scenario(synthesize_claims=False),
            ["plan", "normalize", "screen", "screen", "screen", "select", "prepare"]
            + ["extract"] * 3
            + ["synthesize"],
            0,
        ),
    ],
)
def test_no_grounded_evidence_yields_a_valid_honest_result(
    review, name, scenario, expected_tasks, unresolved
):
    router = ScriptedReview(scenario)
    result = run_scenario(review, scenario, router=router)
    assert result["status"] == "completed", name
    output = result["output"]
    # Zero claims, zero bibliography, zero evidence table, zero verification.
    assert output["claims"] == []
    assert output["bibliography"] == []
    assert output["evidence_table"] == []
    assert output["verification_results"] == []
    assert len(output["unresolved"]) == unresolved
    # No unsupported prose: the review text is the signed constant, and neither
    # the writer nor the verifier was ever asked for one.
    assert output["related_work"] == _no_result_text(review)
    assert router.tasks == expected_tasks
    assert not {"write", "verify"} & set(router.tasks)
    skipped = {event["node_id"] for event in _events(result, "node.skipped")}
    assert {"writing", "verification"} <= skipped
    # The final checks were not bypassed: they ran, on the honest result.
    completed = [event["node_id"] for event in _events(result, "node.completed")]
    assert "validate-output" in completed and "outputs" in completed
    validate_instance(review.files, review.graph["output_schema"], output, "honest result")


def test_the_honest_result_is_exported_like_any_other(review):
    result = run_scenario(review, Scenario(include=False))
    records = dict(artifact_records(result, review))
    assert records["related-work.md"].decode() == _no_result_text(review)
    for name in ("bibliography.json", "evidence-table.json", "verification.json"):
        assert json.loads(records[name]) == [], name
    assert json.loads(records["unresolved.json"]) == []
    assert {"result.json", "audit.json", "usage.json", "provenance.json"} <= set(records)


def test_unresolved_citations_remain_visible_in_an_empty_review(review):
    result = run_scenario(review, Scenario(resolver_status="not_found"))
    statuses = [item["status"] for item in result["output"]["unresolved"]]
    assert statuses == ["not_found"] * 3
    assert {item["paper_id"] for item in result["output"]["unresolved"]} == {
        f"10.5555/scripted.{index}" for index in (1, 2, 3)
    }


def test_0_2_1_asked_the_writer_and_verifier_to_review_nothing(previous):
    """The behaviour A2 removes, reproduced on the preserved 0.2.1 artifact."""
    scenario = Scenario(include=False)
    router = ScriptedReview(scenario)
    run_scenario(previous, scenario, router=router)
    assert {"prepare", "synthesize", "write", "verify"} <= set(router.tasks)


# -- the verifier is not bypassed when there is something to verify ----------
def test_a_review_with_claims_still_goes_through_the_verifier(review):
    scenario = Scenario()
    router = ScriptedReview(scenario)
    result = run_scenario(review, scenario, router=router)
    assert router.tasks.count("synthesize") == 1
    assert router.tasks.count("write") == 1
    assert router.tasks.count("verify") == 1
    skipped = {event["node_id"] for event in _events(result, "node.skipped")}
    assert not {"prepare-evidence", "synthesis", "writing", "verification"} & skipped
    assert all(claim["verification_status"] == "supported" for claim in result["output"]["claims"])
    assert result["output"]["related_work"] != _no_result_text(review)


def test_final_validation_still_refuses_an_ungrounded_claim(review):
    scenario = Scenario(verify_cites_missing_evidence=True)
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario)
    assert caught.value.node_id == "validate-output"
    assert caught.value.code == "schema_validation"
    (failed,) = [
        event
        for event in _events(caught.value.execution_report, "node.failed")
        if event.get("node_id") == "validate-output" and "failed_check" in event
    ]
    assert failed["failed_check"]["index"] == 2
    assert failed["failed_check"]["failure"] == "missing_target_key"


def test_a_skipped_step_cannot_smuggle_claims_past_the_final_checks(review, tmp_path):
    """The honest branch is data like any other: altered, it is refused.

    If a publisher (or an attacker who re-signed the bytes) made the empty
    branch claim something, `validate-output` still relates every claim to real
    evidence and refuses it. The branch adds a path; it removes no check.
    """
    import shutil

    from agentpkg.package import load_package as load

    source = tmp_path / "literature-review"
    shutil.copytree(ROOT / "agents/literature-review", source)
    graph = json.loads((source / "graph.json").read_text())
    verification = next(node for node in graph["nodes"] if node["id"] == "verification")
    verification["otherwise"]["object"]["claims"] = {
        "literal": [
            {
                "claim_id": "claim-invented",
                "text": "An invented finding.",
                "paper_ids": ["10.5555/none"],
                "evidence_ids": ["10.5555/none:e1"],
                "support_type": "model_synthesis",
                "strength": "tentative",
                "verification_status": "supported",
                "theme_id": "theme-none",
            }
        ]
    }
    (source / "graph.json").write_text(json.dumps(graph))
    with pytest.raises(WorkflowError) as caught:
        run_scenario(load(source), Scenario(include=False))
    assert caught.value.node_id == "validate-output"
    assert caught.value.code == "schema_validation"
