"""0.2.7: the same workflow, with the bookkeeping moved out of the models (T15, D-170…D-173).

The user's runs of 2026-10-09 (B-151) stopped or emptied 0.2.6 in steps where a model did
bookkeeping: ``normalize`` gave two candidates one ``paper_id`` (Luna, twice) or dropped all nine
(qwen3:30b), and ``select-included``, given nothing, invented a paper. 0.2.7 keeps every role but
lets the graph keep the records:

- ``join-search`` removes exact DOI/arXiv duplicates and ``identify`` names every paper by its DOI,
  else arXiv id, else URL, else title, before any model sees it;
- ``normalize`` is asked only when documents were selected, for ``{paper_id, file_id}`` per paper,
  and its answer must name every found paper exactly once;
- screening answers a verdict, ``select`` answers ids from the included papers, and the graph
  copies the records; extract, synthesize, write and verify carry answer checks;
- ``papers-found.json`` lists every found paper with its verdict, in every completed run;
- a selected document reaches screening as its first two pages and extraction as its first three.

agentpkg evaluates the answer checks but does not re-ask (D-154): a refused answer fails at once
here, as in replay; the Chrome runtime asks up to twice more (chrome-agent-browser
``literature-faults.test.ts``).
"""

import asyncio
import copy
import hashlib
import json
from pathlib import Path

import pytest
from literature_scenarios import (
    Scenario,
    ScriptedReview,
    grants_for,
    run_scenario,
    scripted_handlers,
)
from shipped_keys import LITERATURE_FINGERPRINT, LITERATURE_KEY

from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, load_package
from agentpkg.signing import verify_package
from agentpkg.workflow import WorkflowError, run_workflow

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "agents/literature-review"
ARCHIVE = ROOT / "dist/literature-review-0.2.7.agent.pkg"
PREVIOUS = ROOT / "dist/literature-review-0.2.6.agent.pkg"
PREVIOUS_SHA256 = "685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1"
NO_GROUNDED = "## No sufficiently grounded literature found"


@pytest.fixture(scope="module")
def review(tmp_path_factory):
    # The source tree, built as published (test_signed_artifact_matches_source ties the two).
    return load_package(build_package(SOURCE, tmp_path_factory.mktemp("lr") / "review.agent.pkg"))


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


def test_every_found_paper_is_screened_and_listed_with_its_verdict(review):
    router = ScriptedReview(Scenario(papers=3))
    result = run_scenario(review, router.scenario, router=router)
    assert result["status"] == "completed"
    state, output = result["state"], result["output"]
    ids = [paper["paper_id"] for paper in state["found_papers"]]
    assert ids == [f"10.5555/scripted.{n}" for n in (1, 2, 3)]  # named by DOI
    assert [row["paper_id"] for row in output["papers_found"]] == ids
    assert {row["screening_status"] for row in output["papers_found"]} == {"include"}
    # No documents were selected: normalize has nothing to judge and is not asked.
    assert "normalize" not in router.tasks
    assert state["candidate_refs"] == [{"paper_id": pid, "file_id": None} for pid in ids]
    # The screened records are the found records with the verdict attached, not a model's copy.
    for paper in state["included_papers"]:
        found = next(p for p in state["found_papers"] if p["paper_id"] == paper["paper_id"])
        assert {k: v for k, v in paper.items() if not k.startswith("screening_")} == {
            k: v for k, v in found.items() if not k.startswith("screening_")
        }


def test_nothing_included_still_lists_the_papers_and_asks_no_one_to_choose(review):
    router = ScriptedReview(Scenario(papers=3, include=False))
    result = run_scenario(review, router.scenario, router=router)
    assert result["status"] == "completed"
    output = result["output"]
    assert output["related_work"].startswith(NO_GROUNDED)
    assert "papers-found.json" in output["related_work"]
    assert [row["screening_status"] for row in output["papers_found"]] == ["exclude"] * 3
    # select-included is skipped on an empty list (0.2.6 asked it, and qwen invented a paper).
    assert "select" not in router.tasks
    assert output["bibliography"] == []


def test_exact_duplicates_are_removed_before_any_model_sees_them(review):
    scenario = Scenario(papers=2)
    handlers = scripted_handlers(scenario)
    search = handlers["scholarly.search"]

    async def twice(ctx, payload):
        answer = await search(ctx, payload)
        # Every query also finds paper 1 again, with its own provenance.
        again = copy.deepcopy(scenario.public(1))
        again["provenance"] = [{"source": "crossref", "query": payload["query"], "locator": None}]
        answer["papers"].append(again)
        return answer

    handlers["scholarly.search"] = twice
    router = ScriptedReview(scenario)
    result = asyncio.run(
        run_workflow(
            review,
            {"question": scenario.question, "seeds": [], "documents": {}, "mode": "live"},
            router=router,
            handlers=handlers,
            grants=grants_for(review),
            approved_tools=sorted(review.tools),
        )
    )
    state = result["state"]
    assert sum(len(batch["papers"]) for batch in state["search_batches"]) == 4
    assert [p["paper_id"] for p in state["found_papers"]] == [
        "10.5555/scripted.1",
        "10.5555/scripted.2",
    ]
    deduplicated = [e for e in result["audit"] if e["action"] == "node.deduplicated"]
    assert [(e["node_id"], e["original_count"], e["retained_count"]) for e in deduplicated] == [
        ("join-search", 4, 2)
    ]
    assert router.tasks.count("screen") == 2


class Answers(ScriptedReview):
    """A scripted reviewer whose answer for one task is changed by ``alter``."""

    def __init__(self, scenario, task, alter):
        super().__init__(scenario)
        self.task, self.alter = task, alter

    async def complete(self, request, *, max_output_tokens):
        answer = await super().complete(request, max_output_tokens=max_output_tokens)
        if request["task"] == self.task:
            answer["output"] = self.alter(answer["output"])
        return answer


@pytest.mark.parametrize(
    ("task", "alter", "node_id", "index"),
    [
        # qwen3:30b's invention, given nothing (B-151): now refused by name.
        ("select", lambda answer: {"paper_ids": ["paper-123"]}, "select-included", 0),
        # A verdict about another paper than the one asked about.
        ("screen", lambda answer: {**answer, "paper_id": "10.5555/scripted.9"}, "screening", 0),
        # A paraphrase where a verbatim quote was required.
        (
            "extract",
            lambda items: [{**items[0], "quote": "A paraphrase of the abstract."}],
            "evidence",
            2,
        ),
        # Evidence attributed to another paper.
        ("extract", lambda items: [{**items[0], "paper_id": "10.5555/x"}], "evidence", 0),
        # A claim citing evidence that does not exist.
        (
            "synthesize",
            lambda answer: {
                **answer,
                "claims": [{**answer["claims"][0], "evidence_ids": ["10.5555/x:e9"]}],
            },
            "synthesis",
            0,
        ),
        # A bibliography row naming a paper that was never resolved.
        (
            "verify",
            lambda answer: {
                **answer,
                "bibliography": [*answer["bibliography"], {"reference": 9, "paper_id": "x"}],
            },
            "verification",
            4,
        ),
    ],
)
def test_a_model_slip_is_refused_on_the_answer_by_a_named_check(
    review, task, alter, node_id, index
):
    scenario = Scenario(papers=3)
    with pytest.raises(WorkflowError) as caught:
        run_scenario(review, scenario, router=Answers(scenario, task, alter))
    # agentpkg asks once (D-154); a host that re-asks would name this check in its correction.
    assert caught.value.code == "model_error"
    assert caught.value.node_id == node_id
    failed = _failed(caught.value, node_id)
    assert failed["failed_check"]["check"] == "answer_check"
    assert failed["failed_check"]["index"] == index
    assert "paper-123" not in json.dumps(caught.value.execution_report["audit"])


def test_normalize_is_asked_with_documents_and_must_name_every_paper_once(review):
    scenario = Scenario(papers=3)
    documents = {"10.5555/scripted.2": "doc-2"}
    handlers = scripted_handlers(scenario)
    seen = {}

    async def read(ctx, payload):
        assert payload == {"file_id": "doc-2"}
        pages = [
            {"page": n, "text": f"Page {n}. " + scenario.paper(2)["abstract"]} for n in range(1, 6)
        ]
        return {"pages": pages, "sha256": "0" * 64, "source": "user_pdf"}

    handlers["paper.read"] = read

    class Watching(ScriptedReview):
        async def complete(self, request, *, max_output_tokens):
            seen.setdefault(request["task"], []).append(copy.deepcopy(request["data"]))
            return await super().complete(request, max_output_tokens=max_output_tokens)

    def run(router):
        return asyncio.run(
            run_workflow(
                review,
                {
                    "question": scenario.question,
                    "seeds": [],
                    "documents": documents,
                    "mode": "live",
                },
                router=router,
                handlers=handlers,
                grants={p["id"]: "session" for p in review.policy["permissions"]},
                approved_tools=sorted(review.tools),
            )
        )

    result = run(Watching(scenario))
    assert result["status"] == "completed"
    (asked,) = seen["normalize"]
    assert [p["paper_id"] for p in asked["candidates"]] == [
        p["paper_id"] for p in result["state"]["found_papers"]
    ]
    assert {r["paper_id"]: r["file_id"] for r in result["state"]["candidate_refs"]}[
        "10.5555/scripted.2"
    ] == "doc-2"
    # The selected document reaches screening as its first two pages, extraction as its first three.
    documents_seen = {
        task: [d["document"] for d in seen[task] if d["document"] is not None]
        for task in ("screen", "extract")
    }
    assert [[p["page"] for p in d["pages"]] for d in documents_seen["screen"]] == [[1, 2]]
    assert [[p["page"] for p in d["pages"]] for d in documents_seen["extract"]] == [[1, 2, 3]]
    truncated = [e for e in result["audit"] if e["action"] == "node.truncated"]
    assert sorted(e["node_id"] for e in truncated) == [
        "evidence/first-pages",
        "screening/first-pages",
    ]
    full_text = [
        r for r in result["output"]["papers_found"] if r["paper_id"] == "10.5555/scripted.2"
    ]
    assert full_text and result["state"]["included_papers"][1]["full_text_available"] is True

    # Two references to one paper, or one left out: refused on the answer, never a later lookup.
    for alter in (
        lambda refs: [*refs, refs[0]],
        lambda refs: refs[1:],
        lambda refs: [],
    ):
        router = Answers(
            scenario,
            "normalize",
            lambda answer, alter=alter: {"candidates": alter(answer["candidates"])},
        )
        with pytest.raises(WorkflowError) as caught:
            run(router)
        assert (caught.value.code, caught.value.node_id) == ("model_error", "normalize")
        assert _failed(caught.value, "normalize")["failed_check"]["index"] == 1


def test_what_changed_from_0_2_6(review, previous):
    assert review.manifest["version"] == "0.2.7"
    assert review.manifest["runtime"]["minimum_version"] == "0.3.0"
    # The citation fallback (D-153): the resolver tool and its permission name Crossref.
    tools = {k: copy.deepcopy(v) for k, v in review.tools.items()}
    resolver = tools["citation-resolver"]
    assert resolver["domains"] == [
        *previous.tools["citation-resolver"]["domains"],
        "api.crossref.org",
    ]
    for name in ("domains", "description"):
        resolver[name] = previous.tools["citation-resolver"][name]
    assert tools == previous.tools
    policy = copy.deepcopy(review.policy)
    (citations,) = [p for p in policy["permissions"] if p["id"] == "network.citations"]
    assert citations["resources"][-1] == "api.crossref.org"
    citations["resources"].pop()
    citations["description"] = next(
        p for p in previous.policy["permissions"] if p["id"] == "network.citations"
    )["description"]
    assert policy == previous.policy
    assert review.graph["deadline_seconds"] == previous.graph["deadline_seconds"] == 4500
    old = {n["id"] for n in previous.graph["nodes"]}
    new = {n["id"] for n in review.graph["nodes"]}
    assert old - new == {"check-screening-refs", "screening-jobs"}
    assert new - old == {
        "join-batches",
        "identify",
        "join-found",
        "join-found-refs",
        "normalize-gate",
        "join-included",
        "papers-found",
        "join-selection",
    }

    # Every model role stays, with the same tasks.
    def tasks(graph):
        found = set()
        for node in graph["nodes"]:
            for step in [node, *node.get("steps", [])]:
                if step.get("type") == "llm":
                    found.add((node["worker"], step["task"]))
        return found

    assert tasks(review.graph) == tasks(previous.graph)
    # Budgets (D-173): two re-asks of each role's largest step fit; the run bounds are unchanged.
    budgets = {w["id"]: w["budget"] for w in review.graph["workers"]}
    assert {k: v["tokens"] for k, v in budgets.items()} == {
        "LiteratureReviewCoordinator": 30000,
        "PlanningWorker": 75000,
        "SearchWorker": 30000,
        "ScreeningWorker": 64000,
        "CitationWorker": 50000,
        "EvidenceWorker": 76000,
        "SynthesisWorker": 56000,
        "WritingWorker": 36000,
        "VerificationWorker": 80000,
    }
    assert {v["remote_calls"] for v in budgets.values()} == {15}
    assert review.policy["budget"] == previous.policy["budget"]
    timeouts = {n["id"]: n["timeout_seconds"] for n in review.graph["nodes"]}
    assert (timeouts["normalize"], timeouts["screening"], timeouts["evidence"]) == (
        1200,
        1800,
        1500,
    )


def test_signed_artifact_matches_source_and_replays(review):
    checked = verify_package(ARCHIVE, LITERATURE_KEY)
    assert checked["valid"] and checked["key_fingerprint"] == LITERATURE_FINGERPRINT
    assert checked["version"] == "0.2.7"
    assert checked["digest"] == review.digest
    published = load_package(ARCHIVE)
    router, handlers, value = fixture_adapters(published)
    result = asyncio.run(
        run_workflow(
            published,
            value,
            router=router,
            handlers=handlers,
            grants={p["id"]: "session" for p in published.policy["permissions"]},
            approved_tools=sorted(published.tools),
        )
    )
    assert result["status"] == "completed"
    assert len(result["output"]["papers_found"]) == len(result["state"]["found_papers"]) == 8
    by_scope = {item["provenance"]["source_sha256"] for item in result["state"]["evidence_items"]}
    assert "" in by_scope and len(by_scope) == 2  # abstract "" and the selected document's hash
    fixture = json.loads(published.files["fixtures/workflow.json"])
    assert fixture["models"]["normalize"][0]["output"].keys() == {"candidates"}


def test_the_0_2_6_archive_is_preserved_byte_for_byte():
    assert hashlib.sha256(PREVIOUS.read_bytes()).hexdigest() == PREVIOUS_SHA256
    assert verify_package(PREVIOUS, LITERATURE_KEY)["version"] == "0.2.6"
