"""0.2.4: trusted bookkeeping and direct quotes are graph operations, never model copies."""

import asyncio
import copy
import json
from pathlib import Path

import pytest
from literature_scenarios import Scenario, ScriptedReview, run_scenario
from shipped_keys import LITERATURE_FINGERPRINT, LITERATURE_KEY

from agentpkg.fixtures import fixture_adapters
from agentpkg.package import load_package
from agentpkg.signing import verify_package
from agentpkg.workflow import WorkflowError, run_workflow

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "dist/literature-review-0.2.4.agent.pkg"


@pytest.fixture(scope="module")
def review():
    return load_package(ARCHIVE)


class NoPrepare(ScriptedReview):
    def prepare(self, data):
        pytest.fail("The model must never be asked to copy/drop resolved jobs")


@pytest.mark.parametrize("count", [0, 1, 3])
def test_every_resolved_record_yields_exactly_one_ordered_job(review, count):
    scenario = Scenario(papers=count, rich_metadata=True)
    router = NoPrepare(scenario)
    result = run_scenario(review, scenario, router=router)
    state = result["state"]
    records, jobs = state["citation_records"], state["evidence_jobs"]
    assert len(records) == len(jobs) == count
    assert [j["record"] for j in jobs] == records
    assert [j["paper"] for j in jobs] == [j["paper"] for j in state["resolved_jobs"]]
    assert "prepare" not in router.tasks
    for job, resolved in zip(jobs, state["resolved_jobs"], strict=True):
        assert job["record"]["metadata"] == resolved["response"]["best_match"]
    again = run_scenario(review, Scenario(papers=count, rich_metadata=True))
    assert again["state"]["evidence_jobs"] == jobs


@pytest.mark.parametrize(
    "scenario",
    [
        Scenario(include=False),
        Scenario(resolver_status="not_found"),
        Scenario(extract_empty=True),
        Scenario(synthesize_claims=False),
    ],
)
def test_genuine_zero_evidence_remains_honest(review, scenario):
    result = run_scenario(review, copy.deepcopy(scenario))
    assert result["status"] == "completed"
    assert result["output"]["claims"] == result["output"]["bibliography"] == []
    assert "No sufficiently grounded literature" in result["output"]["related_work"]


def test_mixed_resolution_retains_every_record_and_only_resolved_jobs(review):
    result = run_scenario(
        review, Scenario(resolver_status_by_paper={2: "ambiguous"}, candidate_on_failure=True)
    )
    state = result["state"]
    assert len(state["citation_records"]) == 3
    assert [j["paper"]["paper_id"] for j in state["evidence_jobs"]] == [
        "10.5555/scripted.1",
        "10.5555/scripted.3",
    ]
    assert state["citation_records"][1]["metadata"] is None
    assert len(state["unresolved"]) == 1


def test_exact_quotes_materialize_without_a_model_copy(review):
    result = run_scenario(review, Scenario(rich_metadata=True))
    state = result["state"]
    assert all(c["text"] is None for c in state["review"]["claims"])
    evidence = {e["evidence_id"]: e for e in state["evidence_items"]}
    for claim in result["output"]["claims"]:
        source = evidence[claim["evidence_ids"][0]]
        assert claim["text"] == source["quote"]
        assert claim["paper_ids"] == [source["paper_id"]]
    for row in result["output"]["bibliography"]:
        job = next(j for j in state["resolved_jobs"] if j["paper"]["paper_id"] == row["paper_id"])
        assert row["metadata"] == job["response"]["best_match"]


class BadVerifier(ScriptedReview):
    mode = "wrong_id"

    def verify(self, data):
        result = super().verify(data)
        c = result["claims"][0]
        if self.mode == "wrong_id":
            c["evidence_ids"] = [data["evidence_items"][-1]["evidence_id"]]
        elif self.mode == "missing_id":
            c["evidence_ids"] = ["absent"]
        elif self.mode == "empty_id":
            c["evidence_ids"] = []
        elif self.mode == "transcribed":
            c["text"] = "An LLM transcription is not an accepted direct quote"
        elif self.mode == "paraphrase":
            c.update(text="A supported paraphrase.", support_type="model_synthesis")
        return result


@pytest.mark.parametrize("mode", ["wrong_id", "missing_id", "empty_id", "transcribed"])
def test_invalid_direct_quotes_fail_closed(review, mode):
    scenario = Scenario()
    router = BadVerifier(scenario)
    router.mode = mode
    with pytest.raises(WorkflowError) as error:
        run_scenario(review, scenario, router=router)
    assert error.value.code == "schema_validation"


def test_paraphrase_text_is_unchanged(review):
    scenario = Scenario()
    router = BadVerifier(scenario)
    router.mode = "paraphrase"
    result = run_scenario(review, scenario, router=router)
    assert result["output"]["claims"][0]["text"] == "A supported paraphrase."


def modified(tmp_path, review, edit):
    for name, data in review.files.items():
        if name == "SIGNATURE":
            continue
        p = tmp_path / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    graph = json.loads((tmp_path / "graph.json").read_text())
    edit({n["id"]: n for n in graph["nodes"]})
    (tmp_path / "graph.json").write_text(json.dumps(graph))
    return load_package(tmp_path)


def test_tampered_materialized_quote_is_still_refused_by_final_validator(review, tmp_path):
    def edit(nodes):
        nodes["materialize-claims"]["steps"][1]["otherwise"]["object"]["text"] = {
            "literal": "tampered"
        }

    package = modified(tmp_path, review, edit)
    with pytest.raises(WorkflowError) as error:
        run_scenario(package, Scenario())
    assert error.value.node_id == "validate-output"


@pytest.mark.parametrize("mode", ["drop", "duplicate", "missing_source"])
def test_preparation_one_to_one_checks_reject_corruption(review, tmp_path, mode):
    def edit(nodes):
        prep = nodes["prepare-evidence"]
        if mode == "drop":
            prep["steps"][2]["otherwise"] = {"literal": []}
        elif mode == "duplicate":
            jobs = prep["steps"][2]["otherwise"]["array"]
            jobs.append(copy.deepcopy(jobs[0]))
        else:
            prep["steps"][1]["otherwise"]["object"]["metadata"] = {
                "from": "item",
                "path": "/response/nonexistent",
            }

    package = modified(tmp_path, review, edit)
    with pytest.raises(WorkflowError) as error:
        run_scenario(package, Scenario())
    assert error.value.code == "schema_validation"


def test_duplicate_evidence_ids_are_rejected(review):
    with pytest.raises(WorkflowError) as error:
        run_scenario(review, Scenario(evidence_ids="local"))
    assert error.value.node_id == "check-evidence"


def test_previous_strict_assertions_are_preserved(review):
    previous = load_package(ROOT / "dist/literature-review-0.2.3.agent.pkg")
    current = {n["id"]: n for n in review.graph["nodes"]}
    for node in previous.graph["nodes"]:
        before = node.get("assertions", [])
        assert current[node["id"]].get("assertions", [])[: len(before)] == before
    assert review.policy == previous.policy
    assert review.tools == previous.tools
    assert review.manifest["runtime"] == previous.manifest["runtime"]


def test_preserved_signed_archive_still_replays(review):
    # The source has moved on to 0.2.5 (test_literature_025); this archive is
    # the preserved 0.2.4 release, checked as published.
    checked = verify_package(ARCHIVE, LITERATURE_KEY)
    assert checked["valid"] and checked["key_fingerprint"] == LITERATURE_FINGERPRINT
    assert checked["version"] == "0.2.4"
    assert checked["digest"] == review.digest
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
    assert result["status"] == "completed" and "prepare" not in router.calls
