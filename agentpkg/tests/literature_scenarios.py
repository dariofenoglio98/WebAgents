"""A scripted stand-in for the model and the three tools of the Literature Review graph.

The package's replay fixture answers one recorded scenario by exact input. The
correctness properties of 0.2.2 need *other* scenarios — three papers whose
extraction workers number their evidence the same way, a search in which
nothing is included, sources that yield no evidence — and a recorded fixture
cannot answer an input it has never seen.

`ScriptedReview` computes every answer from the request's own data, the way a
well-behaved model following the package's skills would, so each scenario runs
through the real signed graph, the real `Workflow` interpreter and every one of
the package's declared checks. Nothing here weakens a check: a scenario that
breaks the package's contract is refused exactly as a live run would be.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
from dataclasses import dataclass, field

from agentpkg.workflow import run_workflow


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


@dataclass
class Scenario:
    """What the scripted sources and model do. Defaults: a clean three-paper review."""

    papers: int = 3
    evidence_per_paper: int = 2
    # "namespaced" follows the 0.2.2 contract (<paper_id>:e<n>); "local" is
    # the 0.2.1 behaviour the real run exhibited (every worker writes e1, e2...).
    evidence_ids: str = "namespaced"
    include: bool = True
    resolver_status: str = "resolved"
    extract_empty: bool = False
    synthesize_claims: bool = True
    # Make the verifier cite evidence that does not exist, to prove the final
    # checks still run on a result with claims.
    verify_cites_missing_evidence: bool = False
    # Hold every extraction call until this many are in flight, so concurrency
    # is proved rather than assumed.
    extraction_barrier: int = 0
    question: str = "Which scripted defenses does this synthetic corpus describe?"
    calls: list = field(default_factory=list)

    # -- the synthetic corpus -------------------------------------------------
    def paper(self, index: int) -> dict:
        doi = f"10.5555/scripted.{index}"
        sentences = [
            f"Scripted method {index} isolates untrusted text before it reaches the model.",
            f"Scripted method {index} reduces attack success in its own evaluation.",
            f"A limitation of scripted method {index} is its narrow benchmark.",
            f"Scripted method {index} is deployed at the application boundary.",
        ]
        return {
            "title": f"Scripted Defense {index}",
            "doi": doi,
            "arxiv_id": None,
            "authors": [{"name": f"Author {index}"}],
            "year": 2026,
            "venue": "Scripted Proceedings",
            "abstract": " ".join(sentences),
            "url": None,
            "source": "crossref",
            "provenance": [{"source": "crossref", "query": None, "locator": doi}],
            "_sentences": sentences,
        }

    def public(self, index: int) -> dict:
        record = self.paper(index)
        record.pop("_sentences")
        return record

    def best_match(self, doi: str) -> dict:
        index = int(doi.rsplit(".", 1)[1])
        paper = self.public(index)
        return {
            "title": paper["title"],
            "authors": [{"name": author["name"]} for author in paper["authors"]],
            "year": paper["year"],
            "venue": paper["venue"],
            "doi": doi,
            "abstract": paper["abstract"],
            "source": "crossref",
            "bibtex": f"@article{{scripted{index}, title={{{paper['title']}}}}}",
        }

    def evidence_id(self, paper_id: str, number: int) -> str:
        local = f"e{number}"
        return f"{paper_id}:{local}" if self.evidence_ids == "namespaced" else local


class ScriptedReview:
    """A deterministic `ModelRouter` answering each Literature Review task from its data."""

    remote = False
    synthetic = True
    capabilities = frozenset({"reasoning", "structured_output"})
    context_window = 1_000_000
    model_id = "scripted-review"
    router_id = "scripted-review-router"

    def __init__(self, scenario: Scenario):
        self.scenario = scenario
        self.tasks: list[str] = []
        self.active_extractions = 0
        self.peak_extractions = 0
        self._barrier = asyncio.Event()

    async def count_tokens(self, request):
        return 10

    async def complete(self, request, *, max_output_tokens):
        task = request["task"]
        self.tasks.append(task)
        data = copy.deepcopy(request["data"])
        if task == "extract":
            self.active_extractions += 1
            self.peak_extractions = max(self.peak_extractions, self.active_extractions)
            try:
                if self.scenario.extraction_barrier:
                    if self.active_extractions >= self.scenario.extraction_barrier:
                        self._barrier.set()
                    await asyncio.wait_for(self._barrier.wait(), timeout=5)
                output = self.extract(data)
            finally:
                self.active_extractions -= 1
        else:
            await asyncio.sleep(0)
            output = getattr(self, task)(data)
        return {"output": output, "input_tokens": 10, "output_tokens": 10, "cost_usd": 0}

    # -- one method per declared model task -----------------------------------
    def plan(self, data):
        count = self.scenario.papers
        return {
            "queries": [f"scripted query {index}" for index in range(1, max(count, 1) + 1)][:3],
            "rationale": "One query per scripted facet.",
            "seed_queries": [],
        }

    def normalize(self, data):
        candidates, seen = [], set()
        for raw in data["candidates"]:
            if raw["doi"] in seen:
                continue
            seen.add(raw["doi"])
            candidates.append(
                {
                    "paper_id": raw["doi"],
                    "title": raw["title"],
                    "doi": raw["doi"],
                    "arxiv_id": raw.get("arxiv_id"),
                    "authors": [{"name": author["name"]} for author in raw["authors"]],
                    "year": raw["year"],
                    "venue": raw["venue"],
                    "abstract": raw["abstract"],
                    "url": raw["url"],
                    "source": raw["source"],
                    "provenance": [
                        {
                            "source": item["source"],
                            "query": item.get("query"),
                            "locator": raw["doi"],
                        }
                        for item in raw["provenance"]
                    ],
                    "full_text_available": False,
                    "screening_status": "pending",
                    "screening_rationale": "",
                }
            )
        return {
            "candidate_papers": candidates,
            "screening_jobs": [{"paper": paper, "file_id": None} for paper in candidates],
        }

    def screen(self, data):
        paper = data["paper"]
        include = self.scenario.include
        return {
            **paper,
            "screening_status": "include" if include else "exclude",
            "screening_rationale": (
                "The abstract describes a defense." if include else "Unrelated to the question."
            ),
        }

    def select(self, data):
        return [
            paper for paper in data["screened_papers"] if paper["screening_status"] == "include"
        ][:3]

    def prepare(self, data):
        records, jobs, unresolved = [], [], []
        for job in data["resolved_jobs"]:
            response = job["response"]
            resolved = response["status"] == "resolved"
            record = {
                "paper_id": job["paper"]["paper_id"],
                "query": response["query"],
                "status": response["status"],
                "metadata": copy.deepcopy(response["best_match"]) if resolved else None,
                "alternatives": response.get("alternatives", []),
                "sources": response.get("sources", []),
                "warnings": response.get("warnings", []),
                "message": response.get("message", ""),
                "synthetic": True,
            }
            records.append(record)
            if resolved:
                jobs.append({"paper": job["paper"], "record": record, "file_id": None})
            else:
                unresolved.append(
                    {
                        "paper_id": record["paper_id"],
                        "status": record["status"],
                        "message": record["message"],
                        "alternatives": record["alternatives"],
                    }
                )
        return {"citation_records": records, "evidence_jobs": jobs, "unresolved": unresolved}

    def extract(self, data):
        if self.scenario.extract_empty:
            return []
        paper, record = data["paper"], data["record"]
        text = record["metadata"]["abstract"]
        sentences = [part if part.endswith(".") else part + "." for part in text.split(". ")]
        items = []
        for number, sentence in enumerate(sentences[: self.scenario.evidence_per_paper], start=1):
            sentence = sentence.rstrip(".") + "."
            assert sentence in text, sentence
            items.append(
                {
                    "evidence_id": self.scenario.evidence_id(paper["paper_id"], number),
                    "paper_id": paper["paper_id"],
                    "text": sentence,
                    "quote": sentence,
                    "category": "method" if number == 1 else "finding",
                    "scope": "abstract",
                    "support_strength": "direct_quote",
                    "location": {"page": None, "section": "abstract"},
                    "extraction_worker": "scripted",
                    "provenance": {
                        "source": "crossref",
                        "locator": paper["doi"],
                        "source_sha256": _sha(text),
                        "synthetic": True,
                    },
                }
            )
        return items

    def synthesize(self, data):
        evidence = data["evidence_items"]
        if not self.scenario.synthesize_claims:
            return {"themes": [], "claims": []}
        claims = [
            {
                "claim_id": f"claim-{index}",
                "text": item["quote"],
                "paper_ids": [item["paper_id"]],
                "evidence_ids": [item["evidence_id"]],
                "support_type": "direct_quote",
                "strength": "descriptive",
                "verification_status": "pending",
                "theme_id": "theme-1",
            }
            for index, item in enumerate(evidence, start=1)
        ]
        theme = {
            "theme_id": "theme-1",
            "label": "Scripted defenses",
            "evidence_ids": [item["evidence_id"] for item in evidence],
            "method_comparison": "Each scripted method isolates untrusted text.",
            "limitations": [],
            "inference_level": "extractive_grouping",
        }
        return {"themes": [theme], "claims": claims}

    def write(self, data):
        return {
            "draft": {
                "title": "Related Work",
                "claim_ids": [c["claim_id"] for c in data["claims"]],
            },
            "claims": data["claims"],
        }

    def verify(self, data):
        evidence = {item["evidence_id"]: item for item in data["evidence_items"]}
        records = {record["paper_id"]: record for record in data["citation_records"]}
        claims = [dict(claim, verification_status="supported") for claim in data["claims"]]
        if self.scenario.verify_cites_missing_evidence and claims:
            claims[0]["evidence_ids"] = ["no-such-evidence"]
        cited = sorted({pid for claim in claims for pid in claim["paper_ids"]})
        bibliography = [
            {
                "reference": number,
                "paper_id": pid,
                "metadata": copy.deepcopy(records[pid]["metadata"]),
            }
            for number, pid in enumerate(cited, start=1)
        ]
        table = [
            copy.deepcopy(evidence[eid])
            for claim in claims
            for eid in claim["evidence_ids"]
            if eid in evidence
        ]
        lines = ["## Scripted defenses", ""]
        for claim in claims:
            lines.append(f"- {claim['text']} [{cited.index(claim['paper_ids'][0]) + 1}]")
        return {
            "related_work": "\n".join(lines) + "\n",
            "bibliography": bibliography,
            "evidence_table": table,
            "unresolved": data["unresolved"],
            "verification_results": [
                {
                    "claim_id": claim["claim_id"],
                    "status": "supported",
                    "checks": ["evidence_match", "paper_match", "quote_match"],
                    "reason": "Direct quote matches its evidence item.",
                    "semantic_judgment": "not_needed",
                }
                for claim in claims
            ],
            "claims": claims,
        }


def scripted_handlers(scenario: Scenario) -> dict:
    """Host tool handlers keyed by the package's abstract binding names."""

    async def search(ctx, payload):
        await asyncio.sleep(0)
        scenario.calls.append(("scholarly-search", payload["query"]))
        index = int(payload["query"].rsplit(" ", 1)[1])
        papers = [scenario.public(index)] if index <= scenario.papers else []
        for paper in papers:
            paper["provenance"] = [
                {"source": "crossref", "query": payload["query"], "locator": paper["doi"]}
            ]
        return {"papers": papers, "query": payload["query"], "source": "crossref"}

    async def resolve(ctx, payload):
        await asyncio.sleep(0)
        scenario.calls.append(("citation-resolver", payload["query"]))
        status = scenario.resolver_status
        return {
            "status": status,
            "query": payload["query"],
            "detected_type": "doi",
            "best_match": scenario.best_match(payload["query"]) if status == "resolved" else None,
            "match_score": 1.0 if status == "resolved" else 0.0,
            "alternatives": [],
            "sources": [{"provider": "crossref", "status": "ok"}],
            "warnings": [],
            "message": "Scripted resolver answer.",
        }

    async def read(ctx, payload):  # pragma: no cover - a scenario never selects a document
        raise AssertionError("no scenario supplies a document, so nothing may be read")

    return {"scholarly.search": search, "citation.resolve": resolve, "paper.read": read}


def scenario_input(scenario: Scenario) -> dict:
    return {"question": scenario.question, "seeds": [], "documents": {}, "mode": "live"}


def grants_for(package) -> dict:
    """Session grants, with the selected-file permission denied: no scenario has a document."""
    return {
        permission["id"]: ("deny" if permission["kind"] == "files.read" else "session")
        for permission in package.policy["permissions"]
    }


def run_scenario(package, scenario: Scenario, router: ScriptedReview | None = None, **options):
    """Run the package's own graph against one scripted scenario.

    Returns the workflow report; a refused run raises exactly as a live one
    would, with its `execution_report` attached. Pass `router` to inspect the
    calls afterwards either way.
    """
    router = router or ScriptedReview(scenario)
    return asyncio.run(
        run_workflow(
            package,
            scenario_input(scenario),
            router=router,
            handlers=scripted_handlers(scenario),
            grants=grants_for(package),
            approved_tools=sorted(package.tools),
            **options,
        )
    )


__all__ = [
    "Scenario",
    "ScriptedReview",
    "grants_for",
    "run_scenario",
    "scenario_input",
    "scripted_handlers",
]
