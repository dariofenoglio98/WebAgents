"""Literature Review 0.2.8: 0.2.7's review with the person's memory (memory.v0, T20, D-233).

Three switches in the task, all off by default: `use_profile` reads the research profile the
person chose (`memory.read` of `research.profile`) into the planning step; `keep_notes` reads the
agent's own notes before planning and stages new ones at the end (`memory` with scope
`agent-scoped`); `reviewed_on`, the person's date, makes the run propose one `research.review`
(`memory.write`) derived from the profile. Off, the run is 0.2.7's and proposes nothing.

Since T22 the source tree is 0.2.9, which keeps this memory behaviour unchanged: the tests that
build from `SOURCE` check it on 0.2.9, the others on the signed 0.2.8 artifact.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

import pytest
from literature_scenarios import Scenario, ScriptedReview, grants_for, scripted_handlers

from agentpkg.cli import main
from agentpkg.fixtures import fixture_adapters
from agentpkg.memory.host import cli_memory
from agentpkg.memory.model import agent_document_id
from agentpkg.package import load_package
from agentpkg.workflow import WorkflowError, run_workflow

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "agents/literature-review"
ARCHIVE = ROOT / "dist/literature-review-0.2.8.agent.pkg"
PREVIOUS = ROOT / "dist/literature-review-0.2.7.agent.pkg"
MEMORY_INPUT = ROOT / "examples/literature-review-0.2.8-memory-input.json"
EXAMPLE_MEMORY = ROOT / "spec/memory-v0/examples/literature-review-0.2.8/memory"
PROFILE_ID = "mem_60718293a4b5c6d7e8f90a1b2c3d4e5f"
MEMORY_TOOLS = {"research.profile", "agent-notes.read", "agent-notes.write"}
NEW_NODES = {
    "profile",
    "notes-read",
    "gate-review",
    "gate-notes",
    "review-links",
    "review-papers",
    "remember",
    "notes-write",
    "review-proposal",
}


@pytest.fixture(scope="module")
def review():
    # The source is 0.2.9 since T22 (compute.v0); 0.2.8 is its signed artifact.
    return load_package(ARCHIVE)


@pytest.fixture(scope="module")
def previous():
    return load_package(PREVIOUS)


def test_what_changed_from_0_2_7(review, previous):
    assert review.manifest["version"] == "0.2.8"
    assert review.manifest["runtime"]["minimum_version"] == "0.4.0"
    assert {k: v for k, v in review.tools.items() if k not in MEMORY_TOOLS} == previous.tools
    assert {review.tools[t]["binding"] for t in MEMORY_TOOLS} == {
        "host.memory.research.profile",
        "host.memory.agent.read",
        "host.memory.agent.write",
    }
    kinds = {p["id"]: p["kind"] for p in review.policy["permissions"]}
    assert {
        pid: kinds[pid]
        for pid in kinds
        if pid not in {p["id"] for p in previous.policy["permissions"]}
    } == {
        "memory.research_profile": "memory.read",
        "memory.remember": "memory.write",
        "memory.agent": "memory",
    }
    assert not any(
        p["required"] for p in review.policy["permissions"] if p["kind"].startswith("memory.")
    )
    assert review.policy["memory"]["scope"] == "agent-scoped"
    assert {n["id"] for n in review.graph["nodes"]} - {
        n["id"] for n in previous.graph["nodes"]
    } == NEW_NODES
    budget, before = review.policy["budget"], previous.policy["budget"]
    assert (budget["hard_tokens"], budget["max_remote_calls"]) == (
        before["hard_tokens"],
        before["max_remote_calls"],
    )
    assert [e["path"] for e in review.graph["exports"]][-1] == "proposals.json"
    tasks = [t["id"] for t in review.manifest["model_requirements"]["tasks"]]
    assert tasks[-1] == "remember"


def _fixture_run(review, input_value=None, grants=None):
    router, handlers, value = fixture_adapters(review)
    grants = grants or {p["id"]: "session" for p in review.policy["permissions"]}
    from agentpkg.memory.host import cli_memory as build

    memory, _, _ = build(review, mode="fixture", decisions=grants)
    return asyncio.run(
        run_workflow(
            review,
            input_value if input_value is not None else value,
            router=router,
            handlers=handlers,
            grants=grants,
            approved_tools=sorted(review.tools),
            memory=memory,
        )
    )


def test_memory_off_is_0_2_7_and_proposes_nothing(review):
    result = _fixture_run(review)
    assert result["status"] == "completed"
    assert result["output"]["memory_proposals"] == {
        "schema": "memory.v0 proposals",
        "proposals": [],
    }
    called = {e["tool"] for e in result["audit"] if e["action"] == "tool.called"}
    assert not called & MEMORY_TOOLS
    assert not [
        e for e in result["audit"] if e["action"] == "model.called" and e["task"] == "remember"
    ]
    assert len(result["output"]["papers_found"]) == 8


def test_memory_on_proposes_a_review_derived_from_the_profile(review):
    result = _fixture_run(review, json.loads(MEMORY_INPUT.read_text()))
    assert result["status"] == "completed"
    (proposal,) = result["output"]["memory_proposals"]["proposals"]
    assert proposal["type"] == "research.review"
    assert proposal["links"] == [{"to": PROFILE_ID, "rel": "derived_from"}]
    fields = proposal["fields"]
    assert fields["reviewed_on"] == "2026-10-14"
    assert fields["question"] == result["state"]["research_question"]
    titles = [entry["metadata"]["title"] for entry in result["output"]["bibliography"]]
    assert fields["papers"] == [{"title": title} for title in titles]
    # The profile shaped the plan; the planning model saw its fields and nothing else of it.
    plan = [e for e in result["audit"] if e["action"] == "model.called" and e["task"] == "plan"]
    assert len(plan) == 1
    assert result["memory"]["proposals"]["count"] == 1


def test_the_cli_derives_the_grant_from_the_fixture_and_writes_proposals_json(tmp_path, capsys):
    grants = tmp_path / "grants.json"
    package = load_package(SOURCE)
    grants.write_text(json.dumps({p["id"]: "session" for p in package.policy["permissions"]}))
    approvals = [arg for tool in sorted(package.tools) for arg in ("--approve-tool", tool)]
    code = main(
        [
            "run",
            str(SOURCE),
            "--grants",
            str(grants),
            *approvals,
            "--input",
            str(MEMORY_INPUT),
            "--out",
            str(tmp_path / "out"),
        ]
    )
    capsys.readouterr()
    assert code == 0
    written = json.loads((tmp_path / "out/proposals.json").read_text())
    assert written["proposals"][0]["links"] == [{"to": PROFILE_ID, "rel": "derived_from"}]


def test_a_profile_asked_for_but_not_granted_stops_the_run(review):
    grants = {p["id"]: "session" for p in review.policy["permissions"]}
    grants["memory.research_profile"] = "deny"
    with pytest.raises(WorkflowError) as caught:
        _fixture_run(review, json.loads(MEMORY_INPUT.read_text()), grants)
    assert (caught.value.code, caught.value.node_id) == ("permission_denied", "profile")


class RememberingReview(ScriptedReview):
    """The scripted review, plus a `remember` answer that keeps its notes and names a review."""

    notes = (
        "# Notes\n- [[Research profile]] and [[mem_60718293a4b5c6d7e8f90a1b2c3d4e5f]] stay text."
    )

    def remember(self, data):
        self.remember_input = data
        return {
            "notes": self.notes,
            "review": {
                "title": "Scripted topic, 14 October 2026",
                "body": "A scripted body.",
                "rationale": "Keeps this review.",
            },
        }


def test_a_live_run_over_a_memory_folder_reads_the_profile_and_commits_the_notes(tmp_path):
    memory_dir = tmp_path / "memory"
    shutil.copytree(EXAMPLE_MEMORY, memory_dir)
    package = load_package(SOURCE)
    grants = grants_for(package)
    memory, folder, handlers = cli_memory(
        package,
        mode="live",
        decisions=grants,
        memory_dir=memory_dir,
        memory_grants=[f"memory.research_profile={PROFILE_ID}"],
    )
    before = folder.agent_document(package.manifest["package_id"])
    scenario = Scenario(papers=3)
    router = RememberingReview(scenario)
    value = {
        "question": scenario.question,
        "seeds": [],
        "documents": {},
        "mode": "live",
        "use_profile": True,
        "keep_notes": True,
        "reviewed_on": "2026-10-14",
    }
    result = asyncio.run(
        run_workflow(
            package,
            value,
            router=router,
            handlers={**scripted_handlers(scenario), **handlers},
            grants=grants,
            approved_tools=sorted(package.tools),
            memory=memory,
        )
    )
    assert result["status"] == "completed"
    assert router.remember_input["agent_notes"] == before["body"]
    reads = [e for e in result["audit"] if e["action"] == "memory.read"]
    assert [(e["permission_id"], e["record_id"]) for e in reads] == [
        ("memory.research_profile", PROFILE_ID)
    ]
    committed = [e for e in result["audit"] if e["action"] == "memory.agent.committed"]
    assert committed and result["memory"]["agent"]["committed"]["bytes"] == len(
        RememberingReview.notes.encode()
    )
    again = cli_memory(package, mode="live", decisions=grants, memory_dir=memory_dir)[1]
    # N20: the notes come back exactly as written; no title or id in them was resolved.
    assert again.agent_document(package.manifest["package_id"])["body"] == RememberingReview.notes
    assert agent_document_id(package.manifest["package_id"]) in again.records
    (proposal,) = result["output"]["memory_proposals"]["proposals"]
    assert proposal["links"] == [{"to": PROFILE_ID, "rel": "derived_from"}]
