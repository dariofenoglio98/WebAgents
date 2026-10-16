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
    # Resolver records shaped like the real Citation Resolver's: every optional
    # field serialized, most of them null, full author objects, a URL,
    # provider ids and multi-line BibTeX.
    rich_metadata: bool = False
    # How the verifier writes bibliography rows. "auto" follows the output
    # schema it is given: {reference, paper_id, metadata} with metadata copied
    # exactly where the schema asks for metadata (0.2.2 and earlier), and
    # {reference, paper_id} where it does not (0.2.3). "reconstruct" writes
    # metadata the way a model transcribing it plausibly does — null fields
    # and BibTeX left out — and "copy" forces an exact copy regardless.
    verify_bibliography: str = "auto"
    # A paper id the verifier lists in its bibliography without citing it.
    verify_extra_reference: str | None = None
    # Per-paper resolver answers overriding `resolver_status`, e.g. {2: "ambiguous"}.
    # With `candidate_on_failure` the failed answer still carries a best_match
    # candidate, as an ambiguous resolution may.
    resolver_status_by_paper: dict = field(default_factory=dict)
    candidate_on_failure: bool = False
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
        if self.rich_metadata:
            return {
                "title": paper["title"],
                "authors": [
                    {"name": "Ada Author", "given": "Ada", "family": "Author", "orcid": None},
                    {"name": "Scripted Consortium", "given": None, "family": None, "orcid": None},
                ],
                "year": paper["year"],
                "venue": paper["venue"],
                "publisher": None,
                "doi": doi,
                "arxiv_id": None,
                "url": f"https://doi.org/{doi}",
                "publication_type": "journal-article",
                "abstract": paper["abstract"],
                "volume": None,
                "issue": None,
                "pages": None,
                "journal_reference": None,
                "provider_ids": {"crossref": doi},
                "source": "crossref",
                "bibtex": (
                    f"@article{{scripted{index},\n"
                    f"  title = {{{paper['title']}}},\n"
                    f"  author = {{Author, Ada and {{Scripted Consortium}}}},\n"
                    f"  year = {{{paper['year']}}},\n"
                    f"  doi = {{{doi}}}\n"
                    "}"
                ),
            }
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
        self.schemas: dict[str, dict] = {}
        self.active_extractions = 0
        self.abstract_hash_empty = False
        self.peak_extractions = 0
        self._barrier = asyncio.Event()

    async def count_tokens(self, request):
        return 10

    async def complete(self, request, *, max_output_tokens):
        task = request["task"]
        self.tasks.append(task)
        data = copy.deepcopy(request["data"])
        if task == "extract":
            # 0.2.6's evidence-extraction skill: abstract evidence states no source hash.
            self.abstract_hash_empty = any(
                'exactly the empty string ""' in text for text in request.get("instructions", [])
            )
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
            self.output_schema = request["output_schema"]
            self.schemas[task] = request["output_schema"]
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
        if _asks_for_candidate_refs(self.output_schema):
            # 0.2.7: the graph has named and deduplicated the papers; only file ids are asked for.
            documents = data["documents"]
            return {
                "candidates": [
                    {"paper_id": paper["paper_id"], "file_id": documents.get(paper["doi"])}
                    for paper in data["candidates"]
                ]
            }
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
        if _asks_for_screening_refs(self.output_schema):
            # 0.2.6: one reference per candidate; the graph builds the jobs.
            refs = [{"paper_id": paper["paper_id"], "file_id": None} for paper in candidates]
            return {"candidate_papers": candidates, "screening_refs": refs}
        return {
            "candidate_papers": candidates,
            "screening_jobs": [{"paper": paper, "file_id": None} for paper in candidates],
        }

    def screen(self, data):
        paper = data["paper"]
        include = self.scenario.include
        verdict = {
            "screening_status": "include" if include else "exclude",
            "screening_rationale": (
                "The abstract describes a defense." if include else "Unrelated to the question."
            ),
        }
        if _asks_for_verdict(self.output_schema):
            # 0.2.7: the verdict only; the graph keeps the paper's record.
            return {"paper_id": paper["paper_id"], **verdict}
        return {**paper, **verdict}

    def select(self, data):
        if "included_papers" in data:
            # 0.2.7: ids chosen from the included papers.
            return {"paper_ids": [paper["paper_id"] for paper in data["included_papers"]][:3]}
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
                        "source_sha256": "" if self.abstract_hash_empty else _sha(text),
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
                "text": (None if _draft_quotes(self.output_schema) else item["quote"]),
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
        listed = cited + (
            [self.scenario.verify_extra_reference] if self.scenario.verify_extra_reference else []
        )
        mode = self.scenario.verify_bibliography
        if mode == "auto":
            mode = "copy" if _asks_for_metadata(self.output_schema) else "references"
        bibliography = []
        for number, pid in enumerate(listed, start=1):
            row = {"reference": number, "paper_id": pid}
            if mode == "copy":
                row["metadata"] = copy.deepcopy(records[pid]["metadata"])
            elif mode == "reconstruct":
                row["metadata"] = _transcribed(records[pid]["metadata"])
            bibliography.append(row)
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


def _follow(schema: dict, root: dict) -> dict:
    """Follow a bundled request schema's local `$ref`s."""
    while isinstance(schema, dict) and "$ref" in schema:
        target = root
        for part in schema["$ref"].removeprefix("#/").split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        schema = target
    return schema


def _asks_for_candidate_refs(schema):
    return "candidates" in _follow(schema, schema).get("properties", {})


def _asks_for_verdict(schema):
    return "title" not in _follow(schema, schema).get("properties", {})


def _asks_for_screening_refs(schema):
    return "screening_refs" in _follow(schema, schema).get("properties", {})


def _draft_quotes(schema):
    root = _follow(schema, schema)
    claims = _follow(root.get("properties", {}).get("claims", {}), schema)
    item = _follow(claims.get("items", {}), schema)
    return item.get("properties", {}).get("text", {}).get("type") == ["string", "null"]


def _asks_for_metadata(output_schema: dict) -> bool:
    """Whether the verifier's output schema lets a bibliography row carry metadata."""
    review = _follow(output_schema, output_schema)
    items = _follow(
        _follow(review["properties"]["bibliography"], output_schema)["items"], output_schema
    )
    properties = items.get("properties")
    return properties is None or "metadata" in properties


def _transcribed(metadata):
    """A model's plausible copy: tidier than the original, so not identical to it.

    Null fields are dropped (in authors too) and the long BibTeX string is left
    out, which is what qwen3:30b was recorded doing when asked to copy resolver
    records (examples/verification/literature-review-copy-diffs-qwen3-30b.json).
    """
    if isinstance(metadata, dict):
        return {
            key: _transcribed(value)
            for key, value in metadata.items()
            if value is not None and key != "bibtex"
        }
    if isinstance(metadata, list):
        return [_transcribed(value) for value in metadata]
    return metadata


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
        index = int(payload["query"].rsplit(".", 1)[1])
        status = scenario.resolver_status_by_paper.get(index, scenario.resolver_status)
        candidate = status == "resolved" or scenario.candidate_on_failure
        return {
            "status": status,
            "query": payload["query"],
            "detected_type": "doi",
            "best_match": scenario.best_match(payload["query"]) if candidate else None,
            "match_score": 1.0 if status == "resolved" else 0.0,
            "alternatives": [],
            "sources": [{"provider": "crossref", "status": "ok"}],
            "warnings": [],
            "message": "Scripted resolver answer.",
        }

    async def read(ctx, payload):  # pragma: no cover - a scenario never selects a document
        raise AssertionError("no scenario supplies a document, so nothing may be read")

    return {"scholarly.search": search, "citation.resolve": resolve, "paper.read": read}


# 0.2.8 (memory.v0, T20) adds three switches, all off by default: the run reads no profile,
# keeps no notes and proposes nothing, and is otherwise 0.2.7's.
MEMORY_OFF = {"use_profile": False, "keep_notes": False, "reviewed_on": None}


def scenario_input(scenario: Scenario, package=None) -> dict:
    value = {"question": scenario.question, "seeds": [], "documents": {}, "mode": "live"}
    if package is not None:
        properties = package.json(package.graph["input_schema"]).get("properties", {})
        value.update({key: off for key, off in MEMORY_OFF.items() if key in properties})
    return value


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
            scenario_input(scenario, package),
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
