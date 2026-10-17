"""Literature Review 0.2.9: 0.2.8 with its bookkeeping as a WebAssembly module (compute.v0, T22).

The candidate deduplication moved from `join-search`'s exact `unique_by` into the bookkeeping
module's `assign_ids` (normalized DOI, arXiv id, URL or title), and the abstract quotes of the
evidence table are searched again by its `match_quotes`. No model call changed: the fixture's
answers, the exports and the tokens are 0.2.8's. The module runs for real in every mode.
"""

from __future__ import annotations

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
    scenario_input,
    scripted_handlers,
)

from agentpkg.compute.declarations import module_records
from agentpkg.fixtures import fixture_adapters
from agentpkg.memory.host import cli_memory
from agentpkg.package import build_package, load_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "agents/literature-review"
PREVIOUS = ROOT / "dist/literature-review-0.2.8.agent.pkg"
MEMORY_INPUT = ROOT / "examples/literature-review-0.2.8-memory-input.json"
BOOKKEEPING = ROOT / "examples/compute/bookkeeping-rs/dist/bookkeeping.wasm"
BOOKKEEPING_SHA256 = "5b9db688c2cf9c60c818ac7eaf748d98ee60b8ecc564d76c37199da68e13735e"
NEW_NODES = {
    "identity-rows",
    "dedup-candidates",
    "quote-parts",
    "join-quotes",
    "source-rows",
    "match-quotes",
    "check-quotes",
}


@pytest.fixture(scope="module")
def review(tmp_path_factory):
    return load_package(build_package(SOURCE, tmp_path_factory.mktemp("lr") / "review.agent.pkg"))


@pytest.fixture(scope="module")
def previous():
    return load_package(PREVIOUS)


def test_what_changed_from_0_2_8(review, previous):
    assert review.manifest["version"] == "0.2.9"
    assert review.manifest["runtime"]["minimum_version"] == "0.5.0"
    # The module is the committed example binary, declared by its hash.
    data = review.files["modules/bookkeeping.wasm"]
    assert data == BOOKKEEPING.read_bytes()
    assert hashlib.sha256(data).hexdigest() == BOOKKEEPING_SHA256
    assert review.graph["modules"] == [
        {"id": "bookkeeping", "path": "modules/bookkeeping.wasm", "sha256": BOOKKEEPING_SHA256}
    ]
    (record,) = module_records(review)
    assert record["functions"] == ["assign_ids", "match_quotes"]
    added = [p for p in review.policy["permissions"] if p not in previous.policy["permissions"]]
    assert [(p["id"], p["kind"], p["required"], p["resources"]) for p in added] == [
        ("compute.bookkeeping", "compute", True, ["bookkeeping"])
    ]
    nodes = {n["id"]: n for n in review.graph["nodes"]}
    before = {n["id"]: n for n in previous.graph["nodes"]}
    assert set(nodes) - set(before) == NEW_NODES
    assert set(before) - set(nodes) == set()
    assert "unique_by" not in nodes["join-search"] and before["join-search"]["unique_by"]
    for kept in ("join-found", "join-found-refs"):
        assert nodes[kept]["unique_by"] == before[kept]["unique_by"] == ["/paper_id"]
    # No model call, tool or budget changed.
    assert review.manifest["model_requirements"] == previous.manifest["model_requirements"]
    assert review.tools == previous.tools
    assert review.policy["budget"] == previous.policy["budget"]

    def models(package):
        return {
            n["id"]: {k: v for k, v in n.items() if k != "depends_on"}
            for n in package.graph["nodes"]
            if n["type"] == "llm"
        }

    assert models(review) == models(previous)
    # Synthesis waits for the quote check as well; nothing else about a model step moved.
    assert nodes["synthesis"]["depends_on"] == [*before["synthesis"]["depends_on"], "check-quotes"]
    assert [n["id"] for n in review.graph["nodes"] if n["type"] == "compute"] == [
        "dedup-candidates",
        "match-quotes",
    ]


def _fixture_run(package, input_value=None):
    router, handlers, value = fixture_adapters(package)
    grants = {p["id"]: "session" for p in package.policy["permissions"]}
    memory, _, _ = cli_memory(package, mode="fixture", decisions=grants)
    return asyncio.run(
        run_workflow(
            package,
            input_value if input_value is not None else value,
            router=router,
            handlers=handlers,
            grants=grants,
            approved_tools=sorted(package.tools),
            memory=memory,
        )
    )


@pytest.mark.parametrize("memory_on", [False, True], ids=["memory-off", "memory-on"])
def test_the_fixture_gives_0_2_8s_review_with_two_module_calls(review, previous, memory_on):
    value = json.loads(MEMORY_INPUT.read_text()) if memory_on else None
    now, then = _fixture_run(review, value), _fixture_run(previous, value)
    assert now["status"] == then["status"] == "completed"
    assert now["output"] == then["output"]
    assert now["usage"]["tokens"] == then["usage"]["tokens"]
    assert now["usage"]["remote_calls"] == then["usage"]["remote_calls"]
    assert now["usage"]["compute_calls"] == 2 and "compute_calls" not in then["usage"]
    completed = [e for e in now["audit"] if e["action"] == "compute.completed"]
    assert [(e["node_id"], e["function"], e["module_sha256"]) for e in completed] == [
        ("dedup-candidates", "assign_ids", BOOKKEEPING_SHA256),
        ("match-quotes", "match_quotes", BOOKKEEPING_SHA256),
    ]
    assert not [e for e in now["audit"] if e["action"] == "compute.failed"]
    # 0.2.8 deduplicated in the join; 0.2.9 in the module, which drops the same record.
    assert [e["node_id"] for e in then["audit"] if e["action"] == "node.deduplicated"] == [
        "join-search"
    ]
    assert not [e for e in now["audit"] if e["action"] == "node.deduplicated"]
    assert now["state"]["quote_check"]["unmatched"] == []
    # 0.2.8's join kept 8 of the 9 searched records; 0.2.9 keeps all 9 and the module drops one.
    assert len(now["state"]["raw_candidates"]) == len(then["state"]["raw_candidates"]) + 1
    assert len(now["state"]["unique_candidates"]) == len(then["state"]["raw_candidates"])


def _run(package, scenario, handlers):
    return asyncio.run(
        run_workflow(
            package,
            scenario_input(scenario, package),
            router=ScriptedReview(scenario),
            handlers=handlers,
            grants=grants_for(package),
            approved_tools=sorted(package.tools),
        )
    )


def test_a_doi_spelled_two_ways_is_one_paper_now(review, previous):
    """The search returns paper 1 twice, the second time with its DOI upper-cased: 0.2.8's exact
    `unique_by` kept both and screened two papers; the module's normalized key keeps one."""
    scenario = Scenario(papers=3)

    def with_variant():
        handlers = scripted_handlers(scenario)
        search = handlers["scholarly.search"]

        async def doubled(ctx, payload):
            answer = await search(ctx, payload)
            if payload["query"].endswith(" 1"):
                variant = copy.deepcopy(answer["papers"][0])
                variant["doi"] = variant["doi"].upper()
                answer["papers"].append(variant)
            return answer

        return {**handlers, "scholarly.search": doubled}

    now = _run(review, scenario, with_variant())
    then = _run(previous, scenario, with_variant())
    assert now["status"] == then["status"] == "completed"
    assert len(then["output"]["papers_found"]) == 4
    assert len(now["output"]["papers_found"]) == 3
    assert {p["doi"] for p in now["output"]["papers_found"]} == {
        f"10.5555/scripted.{index}" for index in (1, 2, 3)
    }


def test_no_abstract_quote_means_no_quote_call(review):
    """Nothing included, so no evidence: `match-quotes` is skipped; only the deduplication runs."""
    scenario = Scenario(papers=3, include=False)
    result = _run(review, scenario, scripted_handlers(scenario))
    assert result["status"] == "completed"
    skipped = [e["node_id"] for e in result["audit"] if e["action"] == "node.skipped"]
    assert "match-quotes" in skipped
    assert result["usage"]["compute_calls"] == 1
