"""Literature Review 0.2.3: bibliographic metadata comes from the resolver, not the model.

A live 0.2.2 run on qwen3:30b completed every stage and was refused by
`validate-output` assertion 0 — the final bibliography's `/metadata` did not
equal its resolved job's `/response/best_match`. 0.2.2 asked the verifier to
reproduce each cited paper's complete resolver record, then required the
reproduction to be identical: a model's tidy transcription (a null field left
out, the BibTeX string dropped) is scientifically harmless and still fails.

0.2.3 keeps the model's decisions — which papers are cited, under which
reference — and attaches the metadata deterministically: a `bibliography` map
selects each row's `best_match` from `resolved_jobs` by paper id with the
generic `lookup` constructor, and `assemble-output` builds the final result.
`validate-output` is unchanged, so the provenance check still runs, now on data
that satisfies it by construction.

Every scenario runs the real signed graph through the real `Workflow`
interpreter; `ScriptedReview` only answers the model's tasks.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from literature_scenarios import Scenario, ScriptedReview, run_scenario
from shipped_keys import LITERATURE_FINGERPRINT, LITERATURE_KEY

from agentpkg.package import load_package
from agentpkg.runtime import digest
from agentpkg.signing import verify_package
from agentpkg.workflow import WorkflowError

ROOT = Path(__file__).resolve().parents[2]
PREVIOUS = ROOT / "dist/literature-review-0.2.2.agent.pkg"

# What the live refusal recorded (run_4077223351c9…, errorCode schema_validation).
LIVE_FAILED_CHECK = {
    "check": "assertion",
    "index": 0,
    "kind": "relation",
    "failure": "fields_do_not_match",
    "compare": {"left": "/metadata", "right": "/response/best_match", "op": "eq"},
}


@pytest.fixture(scope="module")
def review():
    package = load_package(ROOT / "dist/literature-review-0.2.3.agent.pkg")
    assert package.manifest["version"] == "0.2.3"
    return package


@pytest.fixture(scope="module")
def previous():
    package = load_package(PREVIOUS)
    assert package.manifest["version"] == "0.2.2"
    return package


def _failures(error):
    return [
        event
        for event in error.execution_report["audit"]
        if event["action"] == "node.failed" and "failed_check" in event
    ]


def _resolver_records(result):
    return {
        job["paper"]["paper_id"]: job["response"]["best_match"]
        for job in result["state"]["resolved_jobs"]
    }


def _source(tmp_path):
    source = tmp_path / "literature-review"
    source.mkdir()
    package = load_package(ROOT / "dist/literature-review-0.2.3.agent.pkg")
    for name, data in package.files.items():
        if name == "SIGNATURE":
            continue
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return source


def _edit_attach_metadata(source, metadata_expression):
    graph = json.loads((source / "graph.json").read_text())
    (node,) = [node for node in graph["nodes"] if node["id"] == "bibliography"]
    node["steps"][0]["input"]["object"]["metadata"] = metadata_expression
    (source / "graph.json").write_text(json.dumps(graph))
    return load_package(source)


# -- the defect, reproduced on the preserved 0.2.2 bytes ---------------------
def test_0_2_2_refused_a_transcribed_bibliography_exactly_as_the_live_run(previous):
    scenario = Scenario(rich_metadata=True, verify_bibliography="reconstruct")
    with pytest.raises(WorkflowError) as caught:
        run_scenario(previous, scenario)
    assert caught.value.code == "schema_validation"
    assert caught.value.node_id == "validate-output"
    (failed,) = [e for e in _failures(caught.value) if e["node_id"] == "validate-output"]
    assert failed["failed_check"] == LIVE_FAILED_CHECK
    # Every earlier stage passed, including check-records' own equality check.
    completed = {
        e["node_id"]
        for e in caught.value.execution_report["audit"]
        if e["action"] == "node.completed"
    }
    assert {"check-records", "check-evidence", "verification"} <= completed


def test_0_2_2_passed_only_when_the_model_copied_every_field_exactly(previous):
    """The same run succeeds on 0.2.2 only if the transcription is perfect: brittle."""
    result = run_scenario(previous, Scenario(rich_metadata=True, verify_bibliography="copy"))
    assert result["status"] == "completed"


# -- the fix, on the signed 0.2.3 bytes --------------------------------------
def test_0_2_3_is_signed_by_the_same_literature_review_key(review):
    verified = verify_package(ROOT / "dist/literature-review-0.2.3.agent.pkg", LITERATURE_KEY)
    assert verified["valid"] and verified["version"] == "0.2.3"
    assert verified["key_fingerprint"] == LITERATURE_FINGERPRINT
    assert review.manifest["runtime"]["minimum_version"] == "0.2.1"


def test_final_metadata_is_the_resolver_record_exactly(review):
    """The live scenario on 0.2.3: rich records, and a verifier that writes no metadata."""
    scenario = Scenario(rich_metadata=True)
    router = ScriptedReview(scenario)
    result = run_scenario(review, scenario, router=router)
    assert result["status"] == "completed"
    records = _resolver_records(result)
    bibliography = result["output"]["bibliography"]
    assert len(bibliography) == 3
    for entry in bibliography:
        assert set(entry) == {"reference", "paper_id", "metadata"}
        # Structurally identical, including every null, author object and BibTeX.
        assert entry["metadata"] == records[entry["paper_id"]]
        assert digest(entry["metadata"]) == digest(records[entry["paper_id"]])
        assert entry["metadata"]["publisher"] is None
        assert entry["metadata"]["authors"][1]["given"] is None
        assert entry["metadata"]["bibtex"].count("\n") == 5
    # The model decided which papers and which references; the workflow did the rest.
    draft = result["state"]["review"]["bibliography"]
    assert draft == [{"reference": e["reference"], "paper_id": e["paper_id"]} for e in bibliography]
    assert router.tasks.count("verify") == 1
    # validate-output still ran, and passed, on the assembled result.
    completed = [e["node_id"] for e in result["audit"] if e["action"] == "node.completed"]
    for node in ("bibliography", "assemble-output", "validate-output", "outputs"):
        assert node in completed, node
    assert result["state"]["final"] == result["output"]


def test_the_verifier_is_never_asked_for_metadata(review, previous):
    """The output schema sent with the verify request has no place for metadata."""
    from literature_scenarios import _asks_for_metadata

    for package, asked in ((previous, True), (review, False)):
        router = ScriptedReview(Scenario(rich_metadata=True))
        run_scenario(package, router.scenario, router=router)
        assert _asks_for_metadata(router.schemas["verify"]) is asked
    ref = review.json("schemas/bibliography-ref.schema.json")
    assert set(ref["properties"]) == {"reference", "paper_id"}
    assert ref["additionalProperties"] is False


def test_metadata_is_deterministic_however_the_model_would_have_transcribed_it(review):
    first = run_scenario(review, Scenario(rich_metadata=True))
    second = run_scenario(review, Scenario(rich_metadata=True))
    assert digest(first["output"]["bibliography"]) == digest(second["output"]["bibliography"])


# -- nothing the model writes can become metadata -----------------------------
@pytest.mark.parametrize("mode", ["copy", "reconstruct"])
def test_a_verifier_that_writes_metadata_is_refused(review, mode):
    scenario = Scenario(rich_metadata=True, verify_bibliography=mode)
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario)
    assert caught.value.code == "schema_validation"
    assert caught.value.node_id == "verification"


def test_a_fabricated_bibliography_paper_is_refused_by_the_lookup(review):
    scenario = Scenario(verify_extra_reference="10.5555/fabricated")
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario)
    assert caught.value.code == "schema_validation"
    assert caught.value.node_id == "bibliography"
    failed = [e for e in _failures(caught.value) if e["node_id"] == "bibliography"]
    assert failed[0]["failed_check"] == {
        "check": "lookup",
        "failure": "no_match",
        "key": "/paper/paper_id",
        "path": "/response/best_match",
    }
    assert "fabricated" not in json.dumps(caught.value.execution_report["audit"])


def test_an_unresolved_paper_without_a_record_cannot_enter_the_bibliography(review):
    """A listed paper whose resolution failed has no resolver record to attach."""
    scenario = Scenario(
        resolver_status_by_paper={3: "not_found"}, verify_extra_reference="10.5555/scripted.3"
    )
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario)
    assert caught.value.node_id == "bibliography"
    failed = [e for e in _failures(caught.value) if e["node_id"] == "bibliography/attach-metadata"]
    assert failed[0]["failed_check"] == {
        "check": "output_schema",
        "schema": "schemas/bibliography-entry.schema.json",
    }


def test_an_ambiguous_candidate_cannot_enter_the_bibliography(review):
    """An ambiguous answer may carry a candidate record; only a resolved one may be cited.

    The candidate is a well-formed resolver Paper, so the projection accepts it;
    validate-output's unchanged `target_values` requirement refuses it.
    """
    scenario = Scenario(
        resolver_status_by_paper={3: "ambiguous"},
        candidate_on_failure=True,
        verify_extra_reference="10.5555/scripted.3",
    )
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario)
    assert caught.value.node_id == "validate-output"
    (failed,) = [e for e in _failures(caught.value) if e["node_id"] == "validate-output"]
    assert failed["failed_check"] == {
        "check": "assertion",
        "index": 0,
        "kind": "relation",
        "failure": "target_value_mismatch",
        "path": "/response/status",
    }


# -- validation was not weakened ----------------------------------------------
@pytest.mark.parametrize(
    "name",
    ["search record instead of resolver record", "a transcribed copy of the resolver record"],
)
def test_metadata_from_any_other_source_is_still_refused_by_validate_output(tmp_path, review, name):
    """If the projection ever yielded anything but the resolver record, assertion 0 refuses it.

    Two tampered graphs: one attaches the search-time paper record (a real,
    schema-valid, different record), the other a literal "tidied" copy of a
    resolver record. Both reach validate-output, which rejects them exactly as
    it rejected the live 0.2.2 run.
    """
    scenario = Scenario(rich_metadata=True)
    if name.startswith("search"):
        expression = {
            "lookup": {
                "in": {"from": "state", "path": "/resolved_jobs"},
                "key": "/paper/paper_id",
                "equals": {"from": "item", "path": "/paper_id"},
                "path": "/paper",
            }
        }
    else:
        from literature_scenarios import _transcribed

        expression = {"literal": _transcribed(scenario.best_match("10.5555/scripted.1"))}
    package = _edit_attach_metadata(_source(tmp_path), expression)
    with pytest.raises(WorkflowError) as caught:
        run_scenario(package, scenario)
    assert caught.value.node_id == "validate-output"
    (failed,) = [e for e in _failures(caught.value) if e["node_id"] == "validate-output"]
    assert failed["failed_check"] == LIVE_FAILED_CHECK


def test_every_0_2_2_assertion_survives_unchanged(review, previous):
    def assertions(package):
        ops = {}
        for node in package.graph["nodes"]:
            ops[node["id"]] = node.get("assertions")
            for step in node.get("steps", []):
                ops[f"{node['id']}/{step['id']}"] = step.get("assertions")
        return ops

    before, after = assertions(previous), assertions(review)
    for name, rules in before.items():
        assert after[name] == rules, name
    added = set(after) - set(before)
    assert added == {"bibliography", "bibliography/attach-metadata", "assemble-output"}
    assert all(after[name] is None for name in added)


def test_no_model_step_can_write_the_final_result_or_the_bibliography(review):
    workers = {worker["id"]: worker for worker in review.graph["workers"]}
    writers = {
        key: sorted(role for role, worker in workers.items() if key in worker["state_write"])
        for key in ("final", "bibliography", "review")
    }
    assert writers == {
        "final": ["LiteratureReviewCoordinator"],
        "bibliography": ["CitationWorker"],
        "review": ["VerificationWorker"],
    }
    nodes = {node["id"]: node for node in review.graph["nodes"]}
    for node in nodes.values():
        if node["type"] == "llm":
            assert not {"/final", "/bibliography"} & set(node["writes"]), node["id"]
    # The only writers are the two structural nodes, and neither calls a model or tool.
    assert nodes["bibliography"]["type"] == "map"
    assert [step["type"] for step in nodes["bibliography"]["steps"]] == ["validate"]
    assert nodes["assemble-output"]["type"] == "validate"
    assert nodes["validate-output"]["depends_on"] == ["assemble-output"]


# -- the other invariants still hold on 0.2.3 --------------------------------
def test_claims_evidence_and_papers_are_still_related_on_0_2_3(review):
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, Scenario(verify_cites_missing_evidence=True))
    assert caught.value.node_id == "validate-output"
    (failed,) = [e for e in _failures(caught.value) if e["node_id"] == "validate-output"]
    assert failed["failed_check"]["index"] == 2
    assert failed["failed_check"]["failure"] == "missing_target_key"


def test_the_replay_fixture_completes_with_resolver_metadata(review):
    import asyncio

    from agentpkg.fixtures import fixture_adapters
    from agentpkg.workflow import run_workflow

    router, handlers, value = fixture_adapters(review)
    result = asyncio.run(
        run_workflow(
            review,
            value,
            router=router,
            handlers=handlers,
            grants={p["id"]: "session" for p in review.policy["permissions"]},
            approved_tools=sorted(review.tools),
        )
    )
    assert result["status"] == "completed"
    records = _resolver_records(result)
    assert len(result["output"]["bibliography"]) == 2
    for entry in result["output"]["bibliography"]:
        assert entry["metadata"] == records[entry["paper_id"]]
    fixture = review.json(review.graph["fixture"])
    for case in fixture["models"]["verify"]:
        for row in case["output"]["bibliography"]:
            assert set(row) == {"reference", "paper_id"}
    assert copy.deepcopy(result["output"]) == result["state"]["final"]
