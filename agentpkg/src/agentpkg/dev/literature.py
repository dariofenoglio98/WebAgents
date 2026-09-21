"""Host-installed literature workflow; packages supply data, never executable code.

The extractive path is a transparent baseline, not an LLM impersonation. A host
router enables the six declared reasoning tasks. All scientific prose is rendered
from claims that survive the final structural and (where needed) semantic gate.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
from typing import Any

from ..errors import AgentPkgError
from ..runtime import Runtime
from ..tools import ToolError

ENTRYPOINT = "literature.review"
STAGES = (
    "planning",
    "seed-discovery",
    "search",
    "screening",
    "citations",
    "evidence",
    "synthesis",
    "writing",
    "verification",
)
ROLES = dict(
    zip(
        STAGES,
        (
            "PlanningWorker",
            "CitationWorker",
            "SearchWorker",
            "ScreeningWorker",
            "CitationWorker",
            "EvidenceWorker",
            "SynthesisWorker",
            "WritingWorker",
            "VerificationWorker",
        ),
    )
)
STOP_WORDS = set(
    "a an the on in of to for and or with by from work review concise related systems "
    "system approaches focus produce study studies paper language model models llm".split()
)


def _hash(value: Any) -> str:
    encoded = (
        value
        if isinstance(value, bytes)
        else json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    )
    return hashlib.sha256(encoded).hexdigest()


def _title(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.casefold()))


def _doi(value: str | None) -> str | None:
    if not value:
        return None
    return re.sub(r"^https?://(?:dx\.)?doi\.org/", "", value.strip(), flags=re.I).casefold()


def _tokens(value: str) -> set[str]:
    return {
        w.rstrip("s") for w in re.findall(r"[a-z]{3,}", value.casefold()) if w not in STOP_WORDS
    }


def normalize_paper(raw: dict, query: str | None = None) -> dict:
    doi = _doi(raw.get("doi"))
    arxiv_id = raw.get("arxiv_id")
    identity = (
        doi
        or arxiv_id
        or _hash(
            [
                _title(raw["title"]),
                raw.get("authors"),
                raw.get("year"),
                raw.get("venue"),
                raw.get("abstract"),
                raw.get("source"),
                raw.get("url"),
            ]
        )
    )
    provenance = copy.deepcopy(raw.get("provenance", []))
    entry = {
        "source": raw.get("source", "unknown"),
        "query": query,
        "locator": raw.get("url") or doi or arxiv_id,
        "synthetic": raw.get("source") == "synthetic-fixture",
    }
    if entry not in provenance:
        provenance.append(entry)
    return {
        "paper_id": "paper-" + _hash(identity)[:16],
        "title": raw["title"],
        "doi": doi,
        "arxiv_id": arxiv_id,
        "authors": copy.deepcopy(raw.get("authors", [])),
        "year": raw.get("year"),
        "venue": raw.get("venue"),
        "abstract": raw.get("abstract"),
        "url": raw.get("url"),
        "source": raw.get("source", "unknown"),
        "provenance": provenance,
        "full_text_available": False,
        "screening_status": "pending",
        "screening_rationale": "",
    }


def deduplicate_papers(papers: list[dict]) -> list[dict]:
    """Merge exact IDs or identical discovery records; never title alone.

    Never conflate identically named works with different DOIs. A DOI record is
    preferred to a title-only discovery record without inventing missing fields.
    """
    groups: list[dict] = []
    for paper in sorted(
        copy.deepcopy(papers),
        key=lambda p: (not bool(p.get("doi")), not bool(p.get("arxiv_id")), p["paper_id"]),
    ):
        match = None
        for existing in groups:
            same_doi = paper.get("doi") and paper["doi"] == existing.get("doi")
            same_arxiv = paper.get("arxiv_id") and paper["arxiv_id"] == existing.get("arxiv_id")
            conflicting = any(
                paper.get(k) and existing.get(k) and paper[k] != existing[k]
                for k in ("doi", "arxiv_id")
            )
            same_record = paper["paper_id"] == existing["paper_id"]
            if (same_doi or same_arxiv or same_record) and not conflicting:
                match = existing
                break
        if match is None:
            groups.append(paper)
            continue
        for field in ("abstract", "doi", "arxiv_id", "year", "venue", "url"):
            if not match.get(field) and paper.get(field):
                match[field] = paper[field]
        match["provenance"] = sorted(
            {_hash(p): p for p in match["provenance"] + paper["provenance"]}.values(),
            key=lambda p: json.dumps(p, sort_keys=True),
        )
    return sorted(groups, key=lambda p: p["paper_id"])


def make_fixture_handlers(fixture: dict) -> dict:
    """Offline API-shaped mocks; never claim these responses came from services."""

    async def search(ctx, payload):
        await asyncio.sleep(0)  # Exercise concurrent scheduling even with offline fixtures.
        return {
            "query": payload["query"],
            "source": "synthetic-fixture",
            "papers": copy.deepcopy(fixture["papers"][: payload["limit"]]),
        }

    async def resolve(ctx, payload):
        query = payload["query"]
        response = fixture["resolutions"].get(query)
        if response is None:
            for raw in fixture["papers"]:
                if query in (raw["title"], raw.get("doi"), raw.get("arxiv_id")):
                    response = fixture["resolutions"].get(raw.get("doi"))
                    break
        if response is None:
            response = {
                "status": "not_found",
                "query": query,
                "detected_type": "title",
                "best_match": None,
                "match_score": None,
                "alternatives": [],
                "sources": [],
                "warnings": ["Synthetic fixture only."],
                "message": "No synthetic fixture match.",
            }
        return {**copy.deepcopy(response), "query": query}

    async def read(ctx, payload):
        document = copy.deepcopy(fixture.get("documents", {}).get(payload["file_id"]))
        if document is None:
            raise AgentPkgError("Unknown selected fixture document")
        document["sha256"] = _hash(document["pages"])
        return document

    return {"scholarly.search": search, "citation.resolve": resolve, "paper.read": read}


def _record(paper: dict, response: dict, synthetic: bool) -> dict:
    status = response["status"]
    metadata = response.get("best_match") if status == "resolved" else None
    # Successful transport is insufficient. A resolved response needs metadata.
    if status == "resolved" and not metadata:
        raise AgentPkgError("Citation Resolver returned resolved without best_match")
    # Preserve the requested work's identity even if a misconfigured service lies.
    if metadata and paper.get("doi") and _doi(metadata.get("doi")) != paper["doi"]:
        raise AgentPkgError("Citation Resolver returned a different DOI for an exact DOI request")
    if metadata and paper.get("arxiv_id"):
        requested, actual = paper["arxiv_id"], metadata.get("arxiv_id") or ""
        if (
            actual != requested
            if re.search(r"v\d+$", requested)
            else re.sub(r"v\d+$", "", actual) != requested
        ):
            raise AgentPkgError(
                "Citation Resolver returned a different arXiv ID for an exact request"
            )
    return {
        "paper_id": paper["paper_id"],
        "query": response.get("query", paper.get("doi") or paper.get("arxiv_id") or paper["title"]),
        "status": status,
        "metadata": copy.deepcopy(metadata),
        "alternatives": copy.deepcopy(response.get("alternatives", [])),
        "sources": copy.deepcopy(response.get("sources", [])),
        "warnings": list(response.get("warnings", [])),
        "message": response.get("message", ""),
        "synthetic": synthetic,
    }


def _unresolved(paper_id: str, status: str, message: str, alternatives: list | None = None) -> dict:
    return {
        "paper_id": paper_id,
        "status": status,
        "message": message,
        "alternatives": alternatives or [],
    }


def verify_claims(
    claims: list[dict],
    evidence: list[dict],
    citations: list[dict],
    semantic_verdicts: dict[str, dict] | None = None,
) -> list[dict]:
    """Deterministic linkage gate plus separately labelled semantic judgments.

    The deterministic path certifies verbatim descriptive quotation only, not
    entailment of arbitrary generated prose. Model synthesis requires a separate
    supported verdict and remains a model judgment rather than objective proof.
    """
    ev = {e["evidence_id"]: e for e in evidence}
    records = {r["paper_id"]: r for r in citations}
    results = []
    seen = set()
    for claim in claims:
        reasons = []
        checks = ["claim_identity", "evidence_links", "citation_status", "source_scope"]
        if claim["claim_id"] in seen:
            reasons.append("Duplicate claim ID")
        seen.add(claim["claim_id"])
        support = [ev[eid] for eid in claim["evidence_ids"] if eid in ev]
        if not claim["evidence_ids"] or len(support) != len(claim["evidence_ids"]):
            reasons.append("Missing supporting evidence")
        if set(claim["paper_ids"]) != {e["paper_id"] for e in support}:
            reasons.append("Claim paper IDs do not match supporting evidence")
        if any(records.get(pid, {}).get("status") != "resolved" for pid in claim["paper_ids"]):
            reasons.append("Unresolved or nonexistent citation")
        if not claim["text"].strip():
            reasons.append("Empty scientific claim")
        if any(e["scope"] == "abstract" and e["location"].get("page") is not None for e in support):
            reasons.append("Abstract evidence cannot claim full-text page provenance")
        semantic = "not_needed"
        status = "unsupported" if reasons else "supported"
        if claim["support_type"] == "direct_quote":
            checks.append("verbatim_quote")
            if len(support) != 1 or claim["text"] != support[0]["quote"]:
                reasons.append("Claim is not the exact source quote")
                status = "unsupported"
        else:
            checks.append("model_entailment")
            semantic = "model" if semantic_verdicts is not None else "not_performed"
            verdict = (semantic_verdicts or {}).get(claim["claim_id"])
            if not verdict:
                reasons.append("No semantic verification available for synthesized claim")
                status = "unsupported"
            elif verdict["status"] != "supported":
                reasons.append(verdict["reason"])
                status = verdict["status"] if not reasons[:-1] else "unsupported"
            elif verdict.get("reason"):
                checks.append("model_reason:" + verdict["reason"])
        results.append(
            {
                "claim_id": claim["claim_id"],
                "status": status,
                "checks": checks,
                "reason": "; ".join(reasons)
                or "Passed applicable structural checks"
                + (
                    " and model entailment judgment"
                    if semantic == "model"
                    else " and verbatim quotation check"
                ),
                "semantic_judgment": semantic,
            }
        )
    return results


def _render(state: dict) -> tuple[str, list[dict], list[dict]]:
    resolved = {r["paper_id"]: r for r in state["citation_records"] if r["status"] == "resolved"}
    supported = [c for c in state["claims"] if c["verification_status"] == "supported"]
    used = sorted({pid for c in supported for pid in c["paper_ids"]})
    labels = {pid: i + 1 for i, pid in enumerate(used)}
    evidence = {e["evidence_id"]: e for e in state["evidence_items"]}
    lines = ["# Related Work", ""]
    if state["mode"] == "fixture":
        lines += [
            "**SYNTHETIC DEMONSTRATION — all bundled papers, identifiers, and findings "
            "are invented test data. Do not cite this as research.**",
            "",
        ]
    if state["reasoning_mode"] == "extractive":
        lines += [
            "This extractive baseline groups source quotations; it does not perform "
            "semantic method comparison or establish research gaps.",
            "",
        ]
    else:
        lines += [
            "Synthesis and entailment checks are host-router model judgments, "
            "with deterministic citation and evidence linkage checks.",
            "",
        ]
    for theme in state["themes"]:
        selected = [
            c
            for c in supported
            if c["theme_id"] == theme["theme_id"] and c["claim_id"] in state["draft"]["claim_ids"]
        ]
        if not selected:
            continue
        lines += [
            "## "
            + (
                theme["label"]
                if state["reasoning_mode"] == "extractive"
                else "Theme " + str(state["themes"].index(theme) + 1)
            ),
            "",
        ]
        sentences = []
        for claim in selected:
            refs = ", ".join(str(labels[pid]) for pid in claim["paper_ids"])
            support = [evidence[eid] for eid in claim["evidence_ids"]]
            abstract_only = all(e["scope"] == "abstract" for e in support)
            if claim["support_type"] == "direct_quote":
                prefix = "An abstract states" if abstract_only else "The supplied full text states"
                sentences.append(f"{prefix}: “{claim['text']}” [{refs}]")
            else:
                scope = " (abstract-level evidence)" if abstract_only else ""
                sentences.append(f"{claim['text']}{scope} [{refs}]")
        lines += [" ".join(sentences), ""]
    if not supported:
        lines += ["No scientific claims passed the evidence and citation checks.", ""]
    abstract_count = sum(e["scope"] == "abstract" for e in state["evidence_items"])
    full_count = len(state["evidence_items"]) - abstract_count
    lines += [
        f"Evidence coverage: {abstract_count} abstract-derived items and "
        f"{full_count} supplied full-text items. Search coverage is bounded; "
        "this is not a systematic or exhaustive review.",
        "",
    ]
    if state["unresolved"]:
        lines += [
            f"{len(state['unresolved'])} records require follow-up; "
            "ambiguous and failed citations are excluded from the prose.",
            "",
        ]
    bibliography = []
    for pid in used:
        record = resolved[pid]
        bibliography.append(
            {
                "reference": labels[pid],
                "paper_id": pid,
                "metadata": record["metadata"],
                "bibtex": record["metadata"].get("bibtex"),
                "sources": record["sources"],
                "warnings": record["warnings"],
                "synthetic": record["synthetic"],
            }
        )
    evidence_table = [
        {**copy.deepcopy(e), "reference": labels.get(e["paper_id"])}
        for e in state["evidence_items"]
    ]
    return "\n".join(lines).strip() + "\n", bibliography, evidence_table


async def _run_review(
    package,
    question: str,
    *,
    mode: str = "fixture",
    grants: dict | None = None,
    seeds: list | None = None,
    pdfs: dict | None = None,
    router=None,
    limits=None,
    handlers: dict | None = None,
    fixtures: dict | None = None,
    selected_files: dict | None = None,
    resolver_base_url: str | None = None,
    _diagnostics: dict | None = None,
) -> dict:
    if mode not in ("fixture", "live"):
        raise AgentPkgError("Review mode must be fixture or live")
    if not isinstance(question, str) or not question.strip() or len(question) > 2000:
        raise AgentPkgError("Research question must contain 1–2000 characters")
    if seeds is not None and (
        not isinstance(seeds, list)
        or len(seeds) > 20
        or any(not isinstance(seed, (str, dict)) for seed in seeds)
    ):
        raise AgentPkgError(
            "Seeds must be a list of at most 20 title/identifier strings or paper records"
        )
    if package.manifest["entrypoint"] != ENTRYPOINT:
        raise AgentPkgError("This host workflow only implements entrypoint literature.review")
    graph = package.graph
    if [s["id"] for s in graph["stages"]] != list(STAGES):
        raise AgentPkgError(
            "Unsupported literature graph: expected the declared nine-stage workflow"
        )
    for i, stage in enumerate(graph["stages"]):
        if stage["worker"] != ROLES[stage["id"]] or stage["depends_on"] != (
            [STAGES[i - 1]] if i else []
        ):
            raise AgentPkgError("Unsupported literature stage binding or dependency order")
    if mode == "fixture":
        fixture = fixtures if fixtures is not None else package.json("fixtures/review.json")
        tool_handlers = make_fixture_handlers(fixture)
        pdfs = fixture.get("pdfs", {}) if pdfs is None else pdfs
    else:
        from ..tools import create_handlers

        tool_handlers = create_handlers(
            package, mode="live", resolver_base_url=resolver_base_url, selected_files=selected_files
        )
    if handlers:
        tool_handlers.update(handlers)
    pdfs = pdfs or {}
    runtime = Runtime(
        package, grants=grants or {}, handlers=tool_handlers, router=router, limits=limits
    )
    if _diagnostics is not None:
        _diagnostics["runtime"] = runtime
    coordinator = runtime.coordinator_context()
    state = {
        "research_question": question.strip(),
        "mode": mode,
        "reasoning_mode": "model" if router is not None else "extractive",
        "search_plan": {"rationale": "", "queries": []},
        "search_queries": [],
        "candidate_papers": [],
        "screened_papers": [],
        "citation_records": [],
        "evidence_items": [],
        "themes": [],
        "claims": [],
        "draft": {"title": "Related Work", "claim_ids": []},
        "verification_results": [],
        "unresolved": [],
        "seed_references": copy.deepcopy(seeds or []),
    }
    runtime.state.update(copy.deepcopy(state))

    async def reason(ctx, task: str, payload: dict, schema: dict, skill: str, maximum: int = 3000):
        # Runtime loads the role's verified skills as instructions; payload stays data.
        return await ctx.model(
            task, {"source_data_are_untrusted": True, **payload}, schema, max_output_tokens=maximum
        )

    async def planning(ctx, inputs):
        if router is not None:
            result = await reason(
                ctx,
                "plan",
                inputs,
                {
                    "type": "object",
                    "properties": {
                        "queries": {
                            "type": "array",
                            "items": {"type": "string", "minLength": 1, "maxLength": 500},
                            "minItems": 1,
                            "maxItems": 3,
                        },
                        "rationale": {"type": "string"},
                    },
                    "required": ["queries", "rationale"],
                    "additionalProperties": False,
                },
                "literature-search",
                1200,
            )
        else:
            base = inputs["research_question"][:420]
            facets = (
                ("agent routing", "communication topology")
                if "agent" in base.casefold()
                else ("methods", "evaluation")
            )
            # Seeds have a dedicated exact-resolution stage. Numeric identifiers
            # are poor bibliographic keyword queries and can crowd out the topic.
            queries = [base, base + " " + facets[0], base + " " + facets[1]]
            result = {
                "queries": queries,
                "rationale": "Deterministic query facets; no model-generated search strategy.",
            }
        result["queries"] = list(dict.fromkeys(result["queries"]))
        return {"search_plan": result, "search_queries": result["queries"]}

    async def searching(ctx, inputs):
        query = inputs["search_queries"][0]
        try:
            result = await ctx.tool("scholarly-search", {"query": query, "limit": 10})
        except (ToolError, TimeoutError) as exc:
            return {
                "candidate_papers": [],
                "unresolved": [
                    _unresolved(
                        "search",
                        "search_provider_error",
                        f"Scholarly discovery failed: {type(exc).__name__}.",
                    )
                ],
            }
        return {
            "candidate_papers": [normalize_paper(raw, query) for raw in result["papers"]],
            "unresolved": [],
        }

    async def screening(ctx, inputs):
        paper = copy.deepcopy(inputs["candidate_papers"][0])
        screen_data = copy.deepcopy(inputs)
        selected = inputs.get("document_refs", {}).get(paper["paper_id"])
        source_text = paper.get("abstract")
        if selected:
            document = await ctx.tool("paper-reader", {"file_id": selected})
            source_text = "\n".join(page["text"] for page in document["pages"])
            screen_data["selected_full_text"] = document["pages"]
            paper["full_text_available"] = True
        if router is not None:
            answer = await reason(
                ctx,
                "screen",
                screen_data,
                {
                    "type": "object",
                    "properties": {
                        "decision": {"enum": ["include", "maybe", "exclude"]},
                        "rationale": {"type": "string", "minLength": 1},
                    },
                    "required": ["decision", "rationale"],
                    "additionalProperties": False,
                },
                "paper-screening",
                800,
            )
        elif not source_text:
            answer = {
                "decision": "maybe",
                "rationale": "Only title/metadata available; relevance cannot be established.",
            }
        else:
            overlap = _tokens(inputs["research_question"]) & _tokens(source_text)
            include = len(overlap) >= 2
            answer = {
                "decision": "include" if include else "exclude",
                "rationale": "Extractive baseline: available source text overlaps question terms ("
                + ", ".join(sorted(overlap))
                + "); lexical heuristic, not semantic relevance or a probability.",
            }
        # Metadata alone cannot justify scientific relevance even if a router says include.
        if (
            not paper.get("abstract")
            and not any(
                k in pdfs
                for k in (
                    paper["paper_id"],
                    paper.get("doi"),
                    paper.get("arxiv_id"),
                    paper["title"],
                )
            )
            and answer["decision"] == "include"
        ):
            answer = {
                "decision": "maybe",
                "rationale": "Inclusion withheld: no source text supports relevance.",
            }
        paper["screening_status"] = answer["decision"]
        paper["screening_rationale"] = answer["rationale"]
        return {"screened_papers": [paper]}

    async def citations(ctx, inputs):
        paper = inputs["candidate_papers"][0]
        query = paper.get("doi") or paper.get("arxiv_id") or paper["title"]
        try:
            response = await ctx.tool(
                "citation-resolver",
                {
                    "query": query,
                    "query_type": "doi"
                    if paper.get("doi")
                    else "arxiv"
                    if paper.get("arxiv_id")
                    else "auto",
                    "format": "bibtex",
                },
            )
        except (ToolError, TimeoutError) as exc:
            response = {
                "status": "provider_error",
                "query": query,
                "detected_type": "doi"
                if paper.get("doi")
                else "arxiv"
                if paper.get("arxiv_id")
                else "title",
                "best_match": None,
                "alternatives": [],
                "sources": [],
                "warnings": [],
                "message": f"Citation Resolver transport failed: {type(exc).__name__}.",
            }
        record = _record(paper, response, mode == "fixture")
        issues = (
            []
            if record["status"] == "resolved"
            else [
                _unresolved(
                    paper["paper_id"], record["status"], record["message"], record["alternatives"]
                )
            ]
        )
        return {"citation_records": [record], "unresolved": issues}

    async def seed_discovery(ctx, inputs):
        paper = inputs["candidate_papers"][0]
        result = await citations(ctx, inputs)
        record = result["citation_records"][0]
        if record["status"] == "resolved":
            canonical = normalize_paper(record["metadata"])
            canonical["provenance"] += paper["provenance"]
            record["paper_id"] = canonical["paper_id"]
            paper = canonical
        return {"candidate_papers": [paper], **result}

    async def extracting(ctx, inputs):
        paper = inputs["candidate_papers"][0]
        record = inputs["citation_records"][0]
        metadata = record["metadata"]
        file_id = inputs["document_refs"].get(paper["paper_id"])
        if file_id:
            document = await ctx.tool("paper-reader", {"file_id": file_id})
            pages = document["pages"]
            source_hash = document["sha256"]
            scope, source, locator = "full_text", "user_pdf", file_id
        else:
            # Search abstracts retain their own provenance; only attach them when
            # an exact identifier agrees or normalized titles are equal.
            same_work = bool(
                paper.get("doi") and paper["doi"] == _doi(metadata.get("doi"))
            ) or _title(paper["title"]) == _title(metadata["title"])
            abstract = metadata.get("abstract") or (paper.get("abstract") if same_work else None)
            if not abstract:
                return {
                    "evidence_items": [],
                    "unresolved": [
                        _unresolved(
                            paper["paper_id"],
                            "evidence_unavailable",
                            "Resolved metadata lacks a verified-work abstract or supplied PDF.",
                        )
                    ],
                }
            pages = [{"page": None, "text": abstract}]
            source_hash = _hash(abstract.encode())
            scope = "abstract"
            source = metadata["source"] if metadata.get("abstract") else paper["source"]
            locator = metadata.get("url") or metadata.get("doi") or metadata.get("arxiv_id")
        if router is not None:
            schema = {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "quote": {"type": "string", "minLength": 1},
                                "category": {"enum": ["method", "finding", "setup", "limitation"]},
                                "page": {"type": ["integer", "null"]},
                            },
                            "required": ["text", "quote", "category", "page"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["items"],
                "additionalProperties": False,
            }
            answer = await reason(
                ctx,
                "extract",
                {
                    "research_question": inputs["research_question"],
                    "paper_id": paper["paper_id"],
                    "scope": scope,
                    "pages": pages,
                },
                schema,
                "evidence-extraction",
            )
            items = answer["items"]
        else:
            items = []
            for page in pages:
                for sentence in re.split(r"(?<=[.!?])\s+", page["text"]):
                    sentence = sentence.strip()
                    if len(sentence) < 35:
                        continue
                    category = (
                        "limitation"
                        if any(
                            w in sentence.casefold()
                            for w in ("limitation", "not establish", "not report", "only", "beyond")
                        )
                        else "setup"
                        if any(
                            w in sentence.casefold() for w in ("setup", "evaluation", "compares")
                        )
                        else "method"
                    )
                    items.append(
                        {
                            "text": sentence,
                            "quote": sentence,
                            "category": category,
                            "page": page["page"],
                        }
                    )
            items = items[:6]
        evidence, issues = [], []
        for item in items:
            # Exact source-location guard applies even to model-generated items.
            matching_pages = [
                p for p in pages if p["page"] == item["page"] and item["quote"] in p["text"]
            ]
            if not matching_pages or not item["quote"].strip():
                issues.append(
                    _unresolved(
                        paper["paper_id"],
                        "extraction_rejected",
                        "An extracted quote or location was not found in its supplied source.",
                    )
                )
                continue
            eid = "evidence-" + _hash([paper["paper_id"], item["quote"], scope, item["page"]])[:16]
            evidence.append(
                {
                    "evidence_id": eid,
                    "paper_id": paper["paper_id"],
                    "text": item["text"],
                    "quote": item["quote"],
                    "category": item["category"],
                    "scope": scope,
                    "support_strength": "direct_quote"
                    if item["text"] == item["quote"]
                    else "model_interpretation",
                    "location": {
                        "page": item["page"],
                        "section": "abstract" if scope == "abstract" else "supplied PDF",
                    },
                    "extraction_worker": ctx.worker_id,
                    "provenance": {
                        "source": source,
                        "locator": locator,
                        "source_sha256": source_hash,
                        "synthetic": mode == "fixture",
                    },
                }
            )
        return {
            "evidence_items": list({e["evidence_id"]: e for e in evidence}.values()),
            "unresolved": issues,
        }

    async def synthesizing(ctx, inputs):
        if router is not None:
            schema = {
                "type": "object",
                "properties": {
                    "themes": {
                        "type": "array",
                        "maxItems": 6,
                        "items": package.json("schemas/theme.schema.json"),
                    },
                    "claims": {
                        "type": "array",
                        "maxItems": 30,
                        "items": package.json("schemas/claim.schema.json"),
                    },
                },
                "required": ["themes", "claims"],
                "additionalProperties": False,
            }
            result = await reason(ctx, "synthesize", inputs, schema, "evidence-synthesis", 5000)
            # A model cannot assign its own verification status.
            for claim in result["claims"]:
                claim["verification_status"] = "pending"
            return result
        groups: dict[str, list] = {}
        for e in inputs["evidence_items"]:
            text = e["quote"].casefold()
            label = (
                "Reported limitations"
                if e["category"] == "limitation"
                else "Communication structure"
                if any(w in text for w in ("topology", "communication", "graph"))
                else "Selection and evaluation"
            )
            groups.setdefault(label, []).append(e)
        themes, claims = [], []
        for n, (label, items) in enumerate(sorted(groups.items()), 1):
            tid = f"theme-{n}"
            themes.append(
                {
                    "theme_id": tid,
                    "label": label,
                    "evidence_ids": [e["evidence_id"] for e in items],
                    "method_comparison": (
                        "Extractive grouping; comparative reasoning requires the host model router."
                    ),
                    "limitations": ["Grouping is lexical and is not a scientific conclusion."],
                    "inference_level": "extractive_grouping",
                }
            )
            for e in items:
                claims.append(
                    {
                        "claim_id": "claim-" + e["evidence_id"].removeprefix("evidence-"),
                        "text": e["quote"],
                        "paper_ids": [e["paper_id"]],
                        "evidence_ids": [e["evidence_id"]],
                        "support_type": "direct_quote",
                        "strength": "descriptive",
                        "verification_status": "pending",
                        "theme_id": tid,
                    }
                )
        return {"themes": themes, "claims": claims}

    async def writing(ctx, inputs):
        claims = copy.deepcopy(inputs["claims"])
        if router is not None:
            schema = {
                "type": "object",
                "properties": {
                    "claims": {
                        "type": "array",
                        "maxItems": 30,
                        "items": package.json("schemas/claim.schema.json"),
                    }
                },
                "required": ["claims"],
                "additionalProperties": False,
            }
            result = await reason(ctx, "write", inputs, schema, "related-work-writing", 5000)
            claims = result["claims"]
        known_themes = {t["theme_id"] for t in inputs["themes"]}
        # Unknown themes cannot introduce unverified prose via rendering.
        claims = [c for c in claims if c["theme_id"] in known_themes]
        for claim in claims:
            claim["verification_status"] = "pending"
        return {
            "draft": {"title": "Related Work", "claim_ids": [c["claim_id"] for c in claims]},
            "claims": claims,
        }

    async def verifying(ctx, inputs):
        judgments = None
        synthesized = [c for c in inputs["claims"] if c["support_type"] != "direct_quote"]
        if synthesized and router is not None:
            schema = {
                "type": "object",
                "properties": {
                    "verdicts": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "claim_id": {"type": "string"},
                                "status": {"enum": ["supported", "unsupported", "overstated"]},
                                "reason": {"type": "string", "minLength": 1},
                            },
                            "required": ["claim_id", "status", "reason"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["verdicts"],
                "additionalProperties": False,
            }
            result = await reason(
                ctx,
                "verify",
                {**inputs, "claims": synthesized},
                schema,
                "claim-and-citation-verification",
                4000,
            )
            judgments = {v["claim_id"]: v for v in result["verdicts"]}
        results = verify_claims(
            inputs["claims"], inputs["evidence_items"], inputs["citation_records"], judgments
        )
        by_id = {r["claim_id"]: r["status"] for r in results}
        claims = [{**c, "verification_status": by_id[c["claim_id"]]} for c in inputs["claims"]]
        return {"claims": claims, "verification_results": results}

    operations = dict(
        zip(
            STAGES,
            (
                planning,
                seed_discovery,
                searching,
                screening,
                citations,
                extracting,
                synthesizing,
                writing,
                verifying,
            ),
        )
    )
    seed_papers = []
    for seed in seeds or []:
        if isinstance(seed, dict):
            raw = {**seed, "source": seed.get("source", "user-seed")}
        else:
            raw = {"title": seed, "source": "user-seed"}
            if re.match(r"^(?:https?://(?:dx\.)?doi\.org/)?10\.\d+/", seed, flags=re.I):
                raw["doi"] = _doi(seed)
            elif re.fullmatch(r"(?:arXiv:)?\d{4}\.\d{4,5}(?:v\d+)?", seed, flags=re.I):
                raw["arxiv_id"] = re.sub(r"^arxiv:", "", seed, flags=re.I)
        seed_papers.append(normalize_paper(raw))

    def document_refs(paper):
        selected = next(
            (
                pdfs[key]
                for key in (
                    paper["paper_id"],
                    paper.get("doi"),
                    paper.get("arxiv_id"),
                    paper["title"],
                )
                if key in pdfs
            ),
            None,
        )
        return {paper["paper_id"]: selected} if selected else {}

    for stage in graph["stages"]:
        sid = stage["id"]
        if sid == "planning":
            inputs = [
                {"research_question": question, "seed_references": copy.deepcopy(seeds or [])}
            ]
        elif sid == "seed-discovery":
            inputs = [{"candidate_papers": [paper]} for paper in seed_papers]
        elif sid == "search":
            inputs = [
                {"research_question": question, "search_queries": [query]}
                for query in state["search_queries"]
            ]
        elif sid == "screening":
            inputs = [
                {
                    "research_question": question,
                    "candidate_papers": [paper],
                    "document_refs": document_refs(paper),
                }
                for paper in state["candidate_papers"]
            ]
        elif sid == "citations":
            inputs = [
                {"candidate_papers": [paper]}
                for paper in state["screened_papers"]
                if paper["screening_status"] == "include"
                and paper["paper_id"] not in {r["paper_id"] for r in state["citation_records"]}
            ]
        elif sid == "evidence":
            candidates = {p["paper_id"]: p for p in state["screened_papers"]}
            inputs = []
            for record in state["citation_records"]:
                if (
                    record["status"] != "resolved"
                    or record["paper_id"] not in candidates
                    or candidates[record["paper_id"]]["screening_status"] != "include"
                ):
                    continue
                paper = candidates[record["paper_id"]]
                selected = next(
                    (
                        pdfs[key]
                        for key in (
                            paper["paper_id"],
                            paper.get("doi"),
                            paper.get("arxiv_id"),
                            paper["title"],
                        )
                        if key in pdfs
                    ),
                    None,
                )
                paper["full_text_available"] = bool(selected)
                inputs.append(
                    {
                        "research_question": question,
                        "candidate_papers": [paper],
                        "citation_records": [record],
                        "document_refs": {paper["paper_id"]: selected} if selected else {},
                    }
                )
        elif sid == "synthesis":
            inputs = [
                {k: state[k] for k in ("research_question", "evidence_items", "citation_records")}
            ]
        elif sid == "writing":
            inputs = [{k: state[k] for k in ("research_question", "themes", "claims")}]
        else:
            inputs = [
                {k: state[k] for k in ("claims", "evidence_items", "citation_records", "draft")}
            ]
        if stage["parallel"]:
            patches = await runtime.map_workers(
                stage["worker"], inputs, operations[sid], parent=coordinator
            )
        else:
            patches = [
                await runtime.run_worker(stage["worker"], item, operations[sid], parent=coordinator)
                for item in inputs
            ]
        combined: dict[str, Any] = {}
        runtime.record(
            "stage.completed",
            context=coordinator,
            stage=sid,
            merge=stage["merge"],
            worker_count=len(patches),
            synthetic=mode == "fixture",
        )
        for patch in patches:
            for key, value in patch.items():
                if stage["merge"] in ("append", "deduplicate"):
                    combined.setdefault(key, []).extend(value)
                else:
                    combined[key] = value
        if sid == "search":
            # Preserve user seeds first, then provider order within the ordered
            # query results. Hash order is deterministic but is not search rank.
            discovered = state["candidate_papers"] + combined.get("candidate_papers", [])
            ranks = {}
            for paper in discovered:
                ranks.setdefault(paper["paper_id"], len(ranks))
            combined["candidate_papers"] = sorted(
                deduplicate_papers(discovered), key=lambda paper: ranks[paper["paper_id"]]
            )
            # Package requests at most 20 citation calls, and overflow remains visible.
            if len(combined["candidate_papers"]) > 20:
                state["unresolved"].append(
                    _unresolved(
                        "search",
                        "candidate_limit",
                        "Candidate set bounded to 20 works before screening; supplied seeds "
                        "are retained before discovery results in query/provider order.",
                    )
                )
                combined["candidate_papers"] = combined["candidate_papers"][:20]
        if sid == "citations" and "citation_records" in combined:
            combined["citation_records"] = state["citation_records"] + combined["citation_records"]
        if "unresolved" in combined:
            combined["unresolved"] = state["unresolved"] + combined["unresolved"]
        state.update(combined)
        runtime.state.update(copy.deepcopy(state))
    # Keep uncertainty about title-only candidates visible in the final artifact.
    state["unresolved"].extend(
        _unresolved(p["paper_id"], "screening_maybe", p["screening_rationale"])
        for p in state["screened_papers"]
        if p["screening_status"] == "maybe"
    )
    from ..validation import validate_instance

    validate_instance(package.files, "schemas/research-state.schema.json", state, "research state")
    related_work, bibliography, evidence_table = _render(state)
    result = {
        "state": state,
        "related_work": related_work,
        "bibliography": bibliography,
        "evidence_table": evidence_table,
        "unresolved": state["unresolved"],
        "audit": runtime.audit,
        "usage": runtime.usage,
        "provenance": {
            "package_id": package.manifest["package_id"],
            "package_version": package.manifest["version"],
            "package_digest": package.digest,
            "mode": mode,
            "reasoning_mode": state["reasoning_mode"],
            "synthetic": mode == "fixture",
            "semantic_evaluation": "model-judged" if router else "not performed",
        },
    }
    from .literature_evals import evaluate_review

    result["evals"] = evaluate_review(result, package)
    runtime.clear()
    return result


async def run_review(package, question: str, **options) -> dict:
    """Execute with failure diagnostics retained for the host audit/export path."""
    diagnostics = {}
    try:
        return await _run_review(package, question, _diagnostics=diagnostics, **options)
    except Exception as exc:
        runtime = diagnostics.get("runtime")
        if runtime is not None:
            runtime.record("runtime.failed", error=type(exc).__name__, status="error")
            runtime.clear()
            exc.execution_report = {
                "status": "failed",
                "error_type": type(exc).__name__,
                "audit": runtime.audit,
                "usage": runtime.usage,
                "provenance": {
                    "package_id": package.manifest["package_id"],
                    "package_digest": package.digest,
                },
            }
        raise
