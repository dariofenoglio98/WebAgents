"""Re-record Literature Review's synthetic replay fixture for 0.2.7 (T15, D-170).

0.2.7 asks its models for different answers than 0.2.6 (ids, verdicts and choices instead of copied
records), so the 0.2.6 fixture cannot answer it. This script runs the 0.2.7 source graph once against
a router that gives 0.2.6's recorded synthetic judgements in 0.2.7's answer shapes, with 0.2.6's
recorded tool answers, and writes every request it was asked, with its answer, as the new fixture:

- plan: 0.2.6's answer for the same input;
- normalize: every supplied paper once, with the file_id the documents map gives its DOI;
- screen: 0.2.6's verdict and rationale for the paper with the same DOI;
- select: 0.2.6's chosen papers, by their new ids;
- extract, synthesize, write, verify: 0.2.6's answers with every 0.2.6 paper id replaced by the
  handle 0.2.7 gives the chosen paper (P1, P2, P3 in selection order), so evidence ids read
  ``P1:e1`` and so on.

Nothing here is live inference: every judgement is 0.2.6's synthetic one. The tools are 0.2.6's
recorded fixture tools (same inputs, same outputs). Run from the repository root:

    agentpkg/.venv/bin/python scripts/make_literature_fixture_027.py [--check]

``--check`` rebuilds the fixture in memory and exits non-zero unless it equals the file on disk.
"""

from __future__ import annotations

import asyncio
import copy
import json
import sys
import tempfile
from pathlib import Path

from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, load_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "agents/literature-review"
PREVIOUS = ROOT / "dist/literature-review-0.2.6.agent.pkg"
FIXTURE = SOURCE / "fixtures/workflow.json"


def _replace_ids(value, ids: dict[str, str]):
    if isinstance(value, str):
        for old, new in ids.items():
            value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [_replace_ids(item, ids) for item in value]
    if isinstance(value, dict):
        return {key: _replace_ids(item, ids) for key, item in value.items()}
    return value


class Recorder:
    """A local, synthetic router answering 0.2.7's requests with 0.2.6's judgements."""

    remote = False
    synthetic = True
    capabilities = frozenset({"reasoning", "structured_output"})
    context_window = 1_000_000
    model_id = "fixture-recorder"
    router_id = "fixture-recorder"

    def __init__(self, previous: dict):
        self.previous = previous["models"]
        normalized = self.previous["normalize"][0]["output"]["candidate_papers"]
        # 0.2.6 named papers by an opaque hash; 0.2.7 names them by DOI until selection, and
        # the chosen ones by their handle (P1, P2, P3, in the order select chose them) after it.
        self.ids = {paper["paper_id"]: paper["doi"] for paper in normalized}
        (chosen,) = self.previous["select"]
        self.handles = {
            paper["paper_id"]: f"P{n}" for n, paper in enumerate(chosen["output"], start=1)
        }
        self.recorded: dict[str, list] = {}

    async def count_tokens(self, request):
        return len(json.dumps(request["data"]).encode()) // 4 + 1

    def _by_doi(self, task: str, doi: str) -> dict:
        (entry,) = [e for e in self.previous[task] if e["input"]["paper"]["doi"] == doi]
        return entry["output"]

    def answer(self, task: str, data: dict):
        if task == "plan":
            (entry,) = [e for e in self.previous["plan"] if e["input"] == data]
            return copy.deepcopy(entry["output"])
        if task == "normalize":
            documents = data["documents"]
            return {
                "candidates": [
                    {
                        "paper_id": paper["paper_id"],
                        "file_id": documents.get(paper["doi"]),
                    }
                    for paper in data["candidates"]
                ]
            }
        if task == "screen":
            verdict = self._by_doi("screen", data["paper"]["doi"])
            return {
                "paper_id": data["paper"]["paper_id"],
                "screening_status": verdict["screening_status"],
                "screening_rationale": verdict["screening_rationale"],
            }
        if task == "select":
            (entry,) = self.previous["select"]
            chosen = [self.ids[paper["paper_id"]] for paper in entry["output"]]
            included = {paper["paper_id"] for paper in data["included_papers"]}
            assert set(chosen) <= included, (chosen, included)
            return {"paper_ids": chosen}
        if task == "extract":
            return _replace_ids(self._by_doi("extract", data["paper"]["doi"]), self.handles)
        (entry,) = self.previous[task]
        return _replace_ids(copy.deepcopy(entry["output"]), self.handles)

    async def complete(self, request, *, max_output_tokens):
        task, data = request["task"], copy.deepcopy(request["data"])
        output = self.answer(task, data)
        self.recorded.setdefault(task, []).append(
            {"input": data, "output": copy.deepcopy(output)}
        )
        size = len(json.dumps(output).encode()) // 4 + 1
        return {
            "output": output,
            "input_tokens": 1,
            "output_tokens": size,
            "cost_usd": 0,
        }


def record() -> dict:
    previous_package = load_package(PREVIOUS)
    previous = json.loads(previous_package.files["fixtures/workflow.json"])
    with tempfile.TemporaryDirectory() as scratch:
        package = load_package(
            build_package(SOURCE, Path(scratch).resolve() / "review.agent.pkg")
        )
    _, handlers, value = fixture_adapters(previous_package)
    recorder = Recorder(previous)
    result = asyncio.run(
        run_workflow(
            package,
            value,
            router=recorder,
            handlers=handlers,
            grants={p["id"]: "session" for p in package.policy["permissions"]},
            approved_tools=sorted(package.tools),
        )
    )
    assert result["status"] == "completed", result["status"]
    order = [
        "plan",
        "normalize",
        "screen",
        "select",
        "extract",
        "synthesize",
        "write",
        "verify",
    ]
    assert set(recorder.recorded) == set(order), sorted(recorder.recorded)
    # Concurrent map items finish in any order; the fixture lists them in a stable one.
    models = {
        task: sorted(
            recorder.recorded[task],
            key=lambda e: json.dumps(e["input"], sort_keys=True),
        )
        for task in order
    }
    return {
        "profile": previous["profile"],
        "input": previous["input"],
        "models": models,
        "tools": previous["tools"],
    }


def main() -> int:
    fixture = record()
    text = json.dumps(fixture, indent=2, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        same = FIXTURE.read_text() == text
        print(json.dumps({"fixture_current": same}))
        return 0 if same else 1
    FIXTURE.write_text(text)
    print(
        json.dumps({task: len(entries) for task, entries in fixture["models"].items()})
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
