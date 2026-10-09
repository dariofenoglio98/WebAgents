"""0.2.6: screening jobs are built from the candidates; an abstract has no source hash (T10).

Running 0.2.5 on hosted OpenAI models found two package faults that let a review complete with
less literature than the search returned, without saying so:

- ``normalize`` returned every candidate twice (in ``candidate_papers`` and inside each screening
  job) and nothing compared the copies: one model wrote a single job for seven candidates, another
  blanked every abstract in the job copies, and screening then excluded what it could not read.
  0.2.6 asks only for ``{paper_id, file_id}`` references and builds each job from the candidate's
  own record with ``lookup``; every candidate needs exactly one reference, every reference exactly
  one candidate.
- ``evidence.provenance.source_sha256`` is required and nothing supplies it for an abstract, so a
  careful model returned no evidence rather than invent one. 0.2.6 states the value (``""``) and
  ``check-abstract`` asserts it.
"""

import asyncio
import copy
import hashlib
import json
from pathlib import Path

import pytest
from literature_scenarios import Scenario, ScriptedReview, run_scenario
from shipped_keys import LITERATURE_FINGERPRINT, LITERATURE_KEY

from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, load_package
from agentpkg.signing import verify_package
from agentpkg.workflow import WorkflowError, run_workflow

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "dist/literature-review-0.2.6.agent.pkg"
PREVIOUS = ROOT / "dist/literature-review-0.2.5.agent.pkg"
PREVIOUS_SHA256 = "1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571"


@pytest.fixture(scope="module")
def review():
    return load_package(ARCHIVE)


@pytest.fixture(scope="module")
def previous():
    return load_package(PREVIOUS)


def _failed(error: WorkflowError, node_id: str) -> dict:
    (event,) = [
        item
        for item in error.execution_report["audit"]
        if item.get("action") == "node.failed" and item.get("node_id") == node_id
    ]
    return event


class References(ScriptedReview):
    """A normalize answer whose references are changed by ``alter``."""

    def __init__(self, scenario, alter):
        super().__init__(scenario)
        self.alter = alter

    def normalize(self, data):
        result = super().normalize(data)
        result["screening_refs"] = self.alter(result["screening_refs"])
        return result


def test_the_jobs_are_the_candidates_own_records(review):
    result = run_scenario(review, Scenario(rich_metadata=True))
    assert result["status"] == "completed"
    state = result["state"]
    assert [job["paper"] for job in state["screening_jobs"]] == state["candidate_papers"]
    assert [job["file_id"] for job in state["screening_jobs"]] == [
        ref["file_id"] for ref in state["screening_refs"]
    ]
    assert state["evidence_items"]
    assert all(item["provenance"]["source_sha256"] == "" for item in state["evidence_items"])


@pytest.mark.parametrize(
    ("alter", "node_id", "check"),
    [
        # A candidate with no reference: the job builder's lookup finds none.
        (lambda refs: refs[1:], "screening-jobs", "no_match"),
        # Two references for one candidate (one shortcut seen live wrote one job for seven).
        (lambda refs: [*refs, copy.deepcopy(refs[0])], "screening-jobs", "duplicate_key"),
        # A reference that names no candidate.
        (
            lambda refs: [*refs, {"paper_id": "10.5555/not-a-candidate", "file_id": None}],
            "check-screening-refs",
            None,
        ),
    ],
)
def test_references_must_match_the_candidates_one_to_one(review, alter, node_id, check):
    scenario = Scenario()
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario, router=References(scenario, alter))
    assert caught.value.code == "schema_validation"
    assert caught.value.node_id == node_id
    failed = _failed(caught.value, node_id)
    if check is not None:
        assert failed["failed_check"]["check"] == "lookup"
        assert failed["failed_check"]["failure"] == check


class HashesTheAbstract(ScriptedReview):
    """0.2.5's fixture behaviour: an abstract item carrying the SHA-256 of the abstract."""

    def extract(self, data):
        items = super().extract(data)
        text = data["record"]["metadata"]["abstract"]
        for item in items:
            item["provenance"]["source_sha256"] = hashlib.sha256(text.encode()).hexdigest()
        return items


def test_an_abstract_item_with_a_source_hash_is_refused(review, previous):
    scenario = Scenario()
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario, router=HashesTheAbstract(scenario))
    assert caught.value.code == "schema_validation"
    assert caught.value.node_id == "evidence"
    # 0.2.5 accepted the same answer, as it accepted any string there.
    assert run_scenario(previous, scenario, router=HashesTheAbstract(scenario))["status"] == (
        "completed"
    )


def test_what_changed_from_0_2_5(review, previous):
    assert review.policy == previous.policy
    assert review.tools == previous.tools
    assert review.manifest["runtime"] == previous.manifest["runtime"]
    assert review.manifest["model_requirements"] == previous.manifest["model_requirements"]
    assert review.graph["deadline_seconds"] == previous.graph["deadline_seconds"]
    old = {n["id"]: n for n in previous.graph["nodes"]}
    new = {n["id"]: n for n in review.graph["nodes"]}
    assert set(new) - set(old) == {"check-screening-refs", "screening-jobs"}
    assert set(old) - set(new) == set()
    changed = {node_id for node_id in old if new[node_id] != old[node_id]}
    assert changed == {"normalize", "screening", "evidence"}
    assert new["screening"] == {**old["screening"], "depends_on": ["screening-jobs"]}
    for name, data in previous.files.items():
        if name.startswith(("tools/", "policy/")) or (
            name.startswith("skills/")
            and not name.startswith(("skills/literature-search/", "skills/evidence-extraction/"))
        ):
            assert review.files[name] == data, name

    # Roles gained only the access the new nodes need; budgets and limits are as they were.
    def limits(worker):
        return {k: v for k, v in worker.items() if k not in ("state_read", "state_write")}

    workers = {w["id"]: w for w in review.graph["workers"]}
    for worker in previous.graph["workers"]:
        assert limits(workers[worker["id"]]) == limits(worker)
    planning = workers["PlanningWorker"]
    assert {"candidate_papers", "screening_refs"} <= set(planning["state_read"])
    assert "screening_refs" in planning["state_write"]


def test_signed_artifact_matches_source_and_replays(review, tmp_path):
    checked = verify_package(ARCHIVE, LITERATURE_KEY)
    assert checked["valid"] and checked["key_fingerprint"] == LITERATURE_FINGERPRINT
    assert checked["version"] == "0.2.6"
    rebuilt = build_package(ROOT / "agents/literature-review", tmp_path / "rebuilt.agent.pkg")
    assert load_package(rebuilt).digest == review.digest
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
    state = result["state"]
    assert [job["paper"] for job in state["screening_jobs"]] == state["candidate_papers"]
    by_scope = {item["provenance"]["source_sha256"] for item in state["evidence_items"]}
    assert "" in by_scope and len(by_scope) == 2  # abstract "" and the supplied document's hash
    fixture = json.loads(review.files["fixtures/workflow.json"])
    assert "screening_refs" in fixture["models"]["normalize"][0]["output"]


def test_the_0_2_5_archive_and_alias_are_preserved_byte_for_byte():
    assert hashlib.sha256(PREVIOUS.read_bytes()).hexdigest() == PREVIOUS_SHA256
    assert (ROOT / "dist/literature-review.agent.pkg").read_bytes() == PREVIOUS.read_bytes()
    assert verify_package(PREVIOUS, LITERATURE_KEY)["version"] == "0.2.5"
