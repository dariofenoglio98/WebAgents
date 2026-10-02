"""Deterministic stand-ins for everything a contract run touches but must not trust.

* `Corpus`: an invented scholarly literature — Crossref works, Citation
  Resolver records and one selected PDF — so Literature Review has something
  to search, resolve, read and cite.
* `SyntheticModel`: answers each declared model task of both packages from the
  request's own data, the way a well-behaved model following the package's
  skills would. It never reads a package file; it reads only what the
  production router sent (`system`, `user`), and checks its own answer against
  the schema the router sent before handing it back.
* `Services`: Crossref and the Citation Resolver behind the tool broker's HTTP
  transport seam, DNS behind `node:dns.lookup`, and the PDF parser behind the
  broker's `pdfReader` seam. Every request is recorded as a canary event.
* `Provider`: what OpenClaw's `api.runtime.llm.complete` would be: exact-model
  resolution with OpenClaw's documented fallback to the agent default when a
  requested model cannot be resolved, honest usage reports, and the case's
  fault-injection hooks.

Nothing here contacts anything; nothing here is production code.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlsplit

from jsonschema import Draft202012Validator


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


TOKEN = re.compile(r"[a-z0-9]+")
STOP = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "have",
    "how",
    "in",
    "into",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "this",
    "to",
    "what",
    "which",
    "with",
    "do",
    "does",
    "can",
    "we",
    "our",
    "they",
}


def tokens(text) -> set[str]:
    return {word for word in TOKEN.findall(str(text or "").lower()) if word not in STOP}


# -- the invented literature --------------------------------------------------------
@dataclass(frozen=True)
class Paper:
    number: int
    title: str
    sentences: tuple[str, ...]
    venue: str
    year: int
    relevant: bool
    resolver: str  # resolved | ambiguous | not_found
    authors: tuple[tuple[str, str], ...]
    pdf_pages: tuple[tuple[str, ...], ...] = ()

    @property
    def doi(self) -> str:
        return f"10.5555/wa.{self.number}"

    @property
    def abstract(self) -> str:
        return " ".join(self.sentences)

    @property
    def url(self) -> str:
        return f"https://doi.org/{self.doi}"


PAPERS = (
    Paper(
        1,
        "Signed Agent Packages for Portable Language-Model Workflows",
        (
            "Signed agent packages bind workflow graphs, skills and schemas to one publisher key.",
            "A host verifies package integrity before any instruction reaches a model.",
            "The evaluation compares signed packages with unsigned workflow scripts.",
            "A limitation is that a valid signature does not establish publisher trust.",
        ),
        "Proceedings of the Synthetic Workshop on Agent Runtimes",
        2026,
        True,
        "resolved",
        (("Ada", "Lovelace-Synth"), ("Alan", "Turing-Synth")),
        (
            (
                "SYNTHETIC FULL TEXT.",
                "Portable workflows are packaged as data rather than executable code.",
                "The runtime refuses any package whose content hashes disagree with its manifest.",
            ),
            (
                "Run plans freeze the selected model and the approved tools.",
                "A limitation is that the evaluation covers two reference packages only.",
            ),
        ),
    ),
    Paper(
        2,
        "Host-Mediated Tool Access for Language-Model Agent Workflows",
        (
            "Host-mediated tool access routes every agent tool call through a trusted broker.",
            "The broker resolves each call against bindings approved for the current run.",
            "Experiments measure refused calls under injected binding changes.",
            "The method does not address semantic misuse of an approved tool.",
        ),
        "Synthetic Journal of Agent Security",
        2025,
        True,
        "resolved",
        (("Grace", "Hopper-Synth"),),
    ),
    Paper(
        3,
        "Run Plans as Frozen Authorization Records for Agent Workflows",
        (
            "Run plans record the exact package digest, receipt and model binding of one run.",
            "A stale plan is refused rather than repaired.",
            "The prototype evaluates revalidation on a single host.",
        ),
        "Synthetic Systems Letters",
        2026,
        True,
        "ambiguous",
        (("Barbara", "Liskov-Synth"),),
    ),
    Paper(
        4,
        "Budgeted Execution of Multi-Agent Language-Model Graphs",
        (
            "Budgeted execution reserves tokens before every model call in an agent graph.",
            "Workers that exceed their declared budget are refused before dispatch.",
            "The evaluation reports refusals under synthetic overload.",
            "Token accounting depends on usage reported by the host.",
        ),
        "Synthetic Conference on Workflow Systems",
        2024,
        True,
        "resolved",
        (("Edsger", "Dijkstra-Synth"),),
    ),
    Paper(
        5,
        "A Survey of Prompt Formatting Conventions",
        (
            "This survey catalogues prompt formatting conventions across chat interfaces.",
            "It reports no execution or authorization mechanism.",
        ),
        "Synthetic Review of Interface Design",
        2023,
        False,
        "resolved",
        (("Donald", "Knuth-Synth"),),
    ),
    Paper(
        6,
        "Caching Strategies for Static Websites",
        (
            "Static websites benefit from aggressive content caching.",
            "The study measures cache hit rates for synthetic page loads.",
        ),
        "Synthetic Web Engineering Notes",
        2022,
        False,
        "not_found",
        (("Tim", "Berners-Synth"),),
    ),
)
BY_DOI = {paper.doi: paper for paper in PAPERS}

LR_QUESTION = (
    "How do signed agent packages, frozen run plans and host-mediated tool access constrain "
    "portable language-model agent workflows?"
)
PDF_PAPER = PAPERS[0]


def pdf_bytes(paper: Paper = PDF_PAPER) -> bytes:
    """A synthetic selected PDF. Only its bytes' identity matters: the parser is synthetic."""
    body = "\n".join(" ".join(page) for page in paper.pdf_pages)
    return (
        b"%PDF-1.4\n% contract_enforcement synthetic selected document\n"
        + body.encode("utf-8")
        + b"\n%%EOF\n"
    )


def pdf_text(paper: Paper = PDF_PAPER) -> dict:
    data = pdf_bytes(paper)
    return {
        "pages": [
            {"page": index, "text": " ".join(page)}
            for index, page in enumerate(paper.pdf_pages, start=1)
        ],
        "sha256": hashlib.sha256(data).hexdigest(),
        "source": "user_pdf",
    }


def crossref_item(paper: Paper) -> dict:
    """One raw Crossref /works item, as the Crossref adapter receives it."""
    return {
        "DOI": paper.doi,
        "title": [paper.title],
        "author": [{"given": given, "family": family} for given, family in paper.authors],
        "published": {"date-parts": [[paper.year]]},
        "container-title": [paper.venue],
        "abstract": paper.abstract,
        "URL": paper.url,
    }


def resolver_paper(paper: Paper) -> dict:
    """A Citation Resolver `Paper`, every optional field serialized as the service does."""
    return {
        "title": paper.title,
        "authors": [
            {"name": f"{given} {family}", "given": given, "family": family, "orcid": None}
            for given, family in paper.authors
        ],
        "year": paper.year,
        "venue": paper.venue,
        "publisher": None,
        "doi": paper.doi,
        "arxiv_id": None,
        "url": paper.url,
        "publication_type": "proceedings-article",
        "abstract": paper.abstract,
        "volume": None,
        "issue": None,
        "pages": None,
        "journal_reference": None,
        "provider_ids": {"crossref": paper.doi},
        "source": "crossref",
        "bibtex": (
            f"@inproceedings{{synthetic{paper.number},\n"
            f"  title = {{{paper.title}}},\n"
            f"  year = {{{paper.year}}},\n"
            f"  doi = {{{paper.doi}}},\n"
            "  note = {SYNTHETIC TEST DATA}\n"
            "}"
        ),
    }


# A facet word in a query shifts which ranked results it returns, so the three
# planned queries surface different papers (and so screening has something to
# exclude), deterministically.
FACET_OFFSETS = {"evaluation": 2, "limitations": 3}


class Corpus:
    def search(self, query: str, rows: int) -> list[Paper]:
        wanted = tokens(query)
        ranked = sorted(
            PAPERS,
            key=lambda paper: (
                -len(wanted & tokens(paper.title + " " + paper.abstract)),
                _sha(query + paper.doi),
            ),
        )
        offset = max((FACET_OFFSETS.get(word, 0) for word in wanted), default=0)
        window = ranked[offset:] + ranked[:offset]
        return window[: max(0, rows)]

    def resolve(self, query: str) -> dict:
        text = str(query or "").strip()
        paper = BY_DOI.get(text.lower())
        if paper is None:
            for candidate in PAPERS:
                if candidate.title.lower() == text.lower():
                    paper = candidate
                    break
        base = {
            "query": text,
            "detected_type": "doi" if text.lower().startswith("10.") else "title",
            "sources": [{"provider": "crossref", "status": "ok", "error_code": None}],
            "warnings": ["SYNTHETIC: contract_enforcement experiment resolver."],
        }
        if paper is None or paper.resolver == "not_found":
            return {
                **base,
                "status": "not_found",
                "best_match": None,
                "match_score": None,
                "alternatives": [],
                "message": "No record matched this query.",
            }
        if paper.resolver == "ambiguous":
            others = [p for p in PAPERS if p.doi != paper.doi][:2]
            return {
                **base,
                "status": "ambiguous",
                "best_match": None,
                "match_score": 0.61,
                "alternatives": [
                    {"paper": resolver_paper(p), "match_score": 0.6} for p in [paper, *others]
                ],
                "message": "Several records matched; none was accepted.",
            }
        return {
            **base,
            "status": "resolved",
            "best_match": resolver_paper(paper),
            "match_score": 1.0,
            "alternatives": [],
            "message": "Resolved.",
        }


# -- the model -------------------------------------------------------------------------
TASK = re.compile(r"^## Task\n(.+)$", re.MULTILINE)
CATEGORIES = ("method", "setup", "finding", "limitation")


def parse_request(system: str, user: str) -> tuple[str, object, object]:
    """(task, data, output schema) from the exact text the production router rendered."""
    match = TASK.search(system)
    task = match.group(1).strip() if match else ""
    data = json.loads(user) if user else None
    schema = None
    for line in reversed(system.splitlines()):
        line = line.strip()
        if line.startswith("{") or line in ("true", "false"):
            try:
                schema = json.loads(line)
                break
            except ValueError:
                continue
    return task, data, schema


def item_key(package: str, task: str, data) -> str:
    """Which map item one model call is about ("" for a node-level call).

    Map steps run up to `max_parallel` items at once, so "the first call of a
    task" is not a stable identity; the item a call is about is.
    """
    if not isinstance(data, dict):
        return ""
    if package == "meeting-agenda" and task == "perspective":
        return str((data.get("participant") or {}).get("name", ""))
    if package == "literature-review" and task in ("screen", "extract"):
        paper = data.get("paper") or {}
        return str(paper.get("doi") or paper.get("title") or "")
    return ""


def paper_id_for(doi: str | None, title: str) -> str:
    return "paper-" + _sha((doi or "").lower() or title.lower())[:16]


def sentences_of(text: str) -> list[str]:
    parts = [part.strip() for part in re.split(r"(?<=\.)\s+", str(text or "")) if part.strip()]
    return [part for part in parts if part.endswith(".") and len(part) > 12]


class SyntheticModel:
    """One deterministic answer per (package, task, data)."""

    def answer(self, package: str, task: str, data):
        method = getattr(self, f"{package.replace('-', '_')}__{task}", None)
        if method is None:
            raise KeyError(f"no synthetic answer for {package}/{task}")
        return method(copy.deepcopy(data))

    # Meeting Agenda ------------------------------------------------------------------
    def meeting_agenda__plan(self, data):
        goal = str(data.get("goal", ""))
        return {
            "focus": [
                f"Decide: {goal[:80]}",
                "Risks and dependencies",
                "Owners, deadlines and next steps",
            ]
        }

    def meeting_agenda__perspective(self, data):
        participant = data["participant"]
        goal = str(data["request"].get("goal", ""))
        return [
            {
                "role": participant["role"],
                "priorities": [f"What {participant['role']} needs from: {goal[:60]}"],
                "questions": [f"Which decision must {participant['name']} leave with?"],
            }
        ]

    def meeting_agenda__write(self, data):
        request = data["request"]
        participants = request.get("participants") or [{"name": "Chair", "role": "chair"}]
        rows = participants[:10]
        duration = int(request.get("duration", 30))
        share, remainder = divmod(duration, len(rows))
        share = max(share, 1)
        agenda = []
        for index, participant in enumerate(rows):
            agenda.append(
                {
                    "topic": f"{participant['role']} priorities and decisions",
                    "minutes": share + (remainder if index == 0 else 0),
                    "owner": participant["name"],
                }
            )
        return {
            "agenda": agenda,
            "preparation_items": ["Read the current draft and the open-issues list"],
            "decisions": ["Approve the final experiment list"],
            "questions": ["What is still blocking submission?"],
        }

    # Literature Review --------------------------------------------------------------
    def literature_review__plan(self, data):
        question = str(data.get("research_question", ""))[:430]
        return {
            "queries": [question, f"{question} evaluation", f"{question} limitations"],
            "rationale": "Three facets of the question: the question itself, evaluation, limits.",
            "seed_queries": [str(item)[:500] for item in data.get("seed_references", [])][:20],
        }

    def literature_review__normalize(self, data):
        documents = data.get("documents") or {}
        found: dict[str, dict] = {}
        order: list[str] = []
        candidates = list(data.get("candidates") or [])
        for result in data.get("seed_results") or []:
            if isinstance(result, dict) and result.get("status") == "resolved":
                match = result.get("best_match") or {}
                candidates.append(
                    {
                        "title": match.get("title", ""),
                        "doi": match.get("doi"),
                        "arxiv_id": match.get("arxiv_id"),
                        "authors": [{"name": a.get("name", "")} for a in match.get("authors", [])],
                        "year": match.get("year"),
                        "venue": match.get("venue"),
                        "abstract": match.get("abstract"),
                        "url": match.get("url"),
                        "source": "citation-resolver",
                        "provenance": [
                            {"source": "citation-resolver", "query": result.get("query")}
                        ],
                    }
                )
        for raw in candidates:
            doi = (raw.get("doi") or "").lower() or None
            key = doi or str(raw.get("title", "")).lower()
            provenance = [
                {
                    key2: item[key2]
                    for key2 in ("source", "query", "locator", "synthetic", "retrieved_at")
                    if key2 in item
                }
                for item in raw.get("provenance") or []
                if isinstance(item, dict) and "source" in item
            ]
            if key in found:
                found[key]["provenance"].extend(provenance)
                continue
            order.append(key)
            found[key] = {
                "paper_id": paper_id_for(doi, str(raw.get("title", ""))),
                "title": str(raw.get("title", "")),
                "doi": doi,
                "arxiv_id": raw.get("arxiv_id"),
                "authors": [
                    {"name": str(author.get("name", ""))}
                    for author in raw.get("authors") or []
                    if isinstance(author, dict)
                ],
                "year": raw.get("year"),
                "venue": raw.get("venue"),
                "abstract": raw.get("abstract"),
                "url": raw.get("url"),
                "source": str(raw.get("source", "crossref")),
                "provenance": provenance,
                "full_text_available": doi in documents,
                "screening_status": "pending",
                "screening_rationale": "",
            }
        papers = [found[key] for key in order][:20]
        return {
            "candidate_papers": papers,
            "screening_jobs": [
                {"paper": paper, "file_id": documents.get(paper["doi"]) if paper["doi"] else None}
                for paper in papers
            ],
        }

    def literature_review__screen(self, data):
        paper = data["paper"]
        known = BY_DOI.get(str(paper.get("doi") or "").lower())
        include = (
            known.relevant
            if known is not None
            else bool(tokens(data.get("research_question")) & tokens(paper.get("title")))
        )
        return {
            **paper,
            "full_text_available": data.get("document") is not None,
            "screening_status": "include" if include else "exclude",
            "screening_rationale": (
                "The source addresses package verification, authorization or mediation."
                if include
                else "The source does not address the question."
            ),
        }

    def literature_review__select(self, data):
        included = [
            paper
            for paper in data.get("screened_papers") or []
            if paper.get("screening_status") == "include"
        ]
        return included[:3]

    def literature_review__extract(self, data):
        paper = data["paper"]
        record = data.get("record") or {}
        document = data.get("document")
        pid = paper["paper_id"]
        items = []
        if isinstance(document, dict) and document.get("pages"):
            for page in document["pages"]:
                for sentence in sentences_of(page.get("text", "")):
                    if sentence.startswith("SYNTHETIC"):
                        continue
                    items.append((sentence, "full_text", page.get("page"), "supplied PDF"))
            source = {
                "source": "user_pdf",
                "locator": paper.get("doi"),
                "source_sha256": str(document.get("sha256", "")),
                "synthetic": False,
            }
        else:
            text = (record.get("metadata") or {}).get("abstract") or paper.get("abstract") or ""
            for sentence in sentences_of(text):
                items.append((sentence, "abstract", None, "abstract"))
            source = {
                "source": "crossref",
                "locator": paper.get("doi"),
                "source_sha256": _sha(text),
                "synthetic": False,
            }
        evidence = []
        for number, (quote, scope, page, section) in enumerate(items[:4], start=1):
            evidence.append(
                {
                    "evidence_id": f"{pid}:e{number}",
                    "paper_id": pid,
                    "text": quote,
                    "quote": quote,
                    "category": CATEGORIES[(number - 1) % len(CATEGORIES)],
                    "scope": scope,
                    "support_strength": "direct_quote",
                    "location": {"page": page, "section": section},
                    "extraction_worker": "synthetic-model",
                    "provenance": dict(source),
                }
            )
        return evidence

    def literature_review__synthesize(self, data):
        evidence = list(data.get("evidence_items") or [])
        resolved = {
            record.get("paper_id")
            for record in data.get("citation_records") or []
            if record.get("status") == "resolved"
        }
        usable = [item for item in evidence if item.get("paper_id") in resolved]
        claims = []
        for item in usable:
            claims.append(
                {
                    "claim_id": "claim-" + _sha(item["evidence_id"])[:16],
                    "text": None,
                    "paper_ids": [item["paper_id"]],
                    "evidence_ids": [item["evidence_id"]],
                    "support_type": "direct_quote",
                    "strength": "descriptive",
                    "verification_status": "pending",
                    "theme_id": "theme-1",
                }
            )
        papers = []
        for item in usable:
            if item["paper_id"] not in papers:
                papers.append(item["paper_id"])
        if len(papers) >= 2:
            first = [item for item in usable if item["paper_id"] == papers[0]][0]
            second = [item for item in usable if item["paper_id"] == papers[1]][0]
            claims.append(
                {
                    "claim_id": "claim-" + _sha(first["evidence_id"] + second["evidence_id"])[:16],
                    "text": (
                        "Both reviewed lines of work enforce workflow constraints in the host "
                        "rather than in the model."
                    ),
                    "paper_ids": [papers[0], papers[1]],
                    "evidence_ids": [first["evidence_id"], second["evidence_id"]],
                    "support_type": "model_synthesis",
                    "strength": "tentative",
                    "verification_status": "pending",
                    "theme_id": "theme-1",
                }
            )
        themes = (
            [
                {
                    "theme_id": "theme-1",
                    "label": "Host-side enforcement of agent workflows",
                    "evidence_ids": [item["evidence_id"] for item in usable],
                    "method_comparison": "The sources enforce constraints before dispatch.",
                    "limitations": ["Evidence is limited to abstracts and one supplied document."],
                    "inference_level": "extractive_grouping",
                }
            ]
            if usable
            else []
        )
        return {"themes": themes, "claims": claims}

    def literature_review__write(self, data):
        claims = list(data.get("claims") or [])
        return {
            "draft": {
                "title": "Related Work",
                "claim_ids": [claim.get("claim_id") for claim in claims],
            },
            "claims": claims,
        }

    def literature_review__verify(self, data):
        evidence = {item.get("evidence_id"): item for item in data.get("evidence_items") or []}
        records = {record.get("paper_id"): record for record in data.get("citation_records") or []}
        claims = [
            dict(claim, verification_status="supported") for claim in data.get("claims") or []
        ]
        cited: list[str] = []
        for claim in claims:
            for pid in claim.get("paper_ids") or []:
                if pid not in cited and (records.get(pid) or {}).get("status") == "resolved":
                    cited.append(pid)
        bibliography = [
            {"reference": index, "paper_id": pid} for index, pid in enumerate(cited, start=1)
        ]
        table: list[dict] = []
        seen = set()
        for claim in claims:
            for eid in claim.get("evidence_ids") or []:
                if eid in evidence and eid not in seen:
                    seen.add(eid)
                    table.append(copy.deepcopy(evidence[eid]))
        lines = ["## Host-side enforcement of agent workflows", ""]
        for claim in claims:
            refs = [cited.index(pid) + 1 for pid in claim.get("paper_ids") or [] if pid in cited]
            marker = "".join(f"[{ref}]" for ref in refs)
            if claim.get("support_type") == "direct_quote":
                quote = (evidence.get((claim.get("evidence_ids") or [None])[0]) or {}).get(
                    "quote", ""
                )
                lines.append(f"A source states: “{quote}” {marker}".rstrip())
            else:
                lines.append(f"{claim.get('text')} {marker}".rstrip())
        return {
            "related_work": "\n".join(lines) + "\n",
            "bibliography": bibliography,
            "evidence_table": table,
            "unresolved": list(data.get("unresolved") or []),
            "verification_results": [
                {
                    "claim_id": claim.get("claim_id"),
                    "status": "supported",
                    "checks": ["evidence_exists", "paper_resolved"],
                    "reason": "Every cited evidence item exists and its paper resolved.",
                    "semantic_judgment": "not_needed"
                    if claim.get("support_type") == "direct_quote"
                    else "model",
                }
                for claim in claims
            ],
            "claims": claims,
        }


# -- canaries -------------------------------------------------------------------------
@dataclass
class Canaries:
    """Everything that crossed out of the trusted boundary during one case."""

    model_calls: list[dict] = field(default_factory=list)
    transports: list[dict] = field(default_factory=list)
    dns: list[dict] = field(default_factory=list)
    pdf_parses: list[dict] = field(default_factory=list)
    anomalies: list[dict] = field(default_factory=list)

    def summary(self) -> dict:
        return {
            "model_dispatches": len(self.model_calls),
            "model_dispatches_unplanned_model": sum(
                1 for call in self.model_calls if call.get("unplanned_model")
            ),
            "model_answers_by_other_model": sum(
                1
                for call in self.model_calls
                if call.get("reported_model") != call.get("requested_model")
            ),
            "tool_transports": len(self.transports),
            "tool_transports_unauthorized": sum(1 for t in self.transports if not t["authorized"]),
            "tool_transports_nonpublic_address": sum(
                1 for t in self.transports if not t.get("address_public", True)
            ),
            "dns_lookups": len(self.dns),
            "dns_lookups_unauthorized": sum(1 for d in self.dns if not d["authorized"]),
            "pdf_parses": len(self.pdf_parses),
            "harness_anomalies": len(self.anomalies),
        }


# -- services behind the broker's seams ------------------------------------------------
PUBLIC_ADDRESS = "104.16.24.7"


class Services:
    """Crossref, the Citation Resolver, DNS and the PDF parser, all recording."""

    def __init__(self, corpus: Corpus, canaries: Canaries, *, endpoints, faults=None, files=None):
        self.corpus = corpus
        self.canaries = canaries
        # (hostname, path, method) triples the host bindings are configured for.
        self.endpoints = {tuple(item) for item in endpoints}
        self.hostnames = {item[0] for item in self.endpoints}
        self.faults = faults
        self.files = files or {}

    def set_endpoints(self, endpoints) -> None:
        self.endpoints = {tuple(item) for item in endpoints}
        self.hostnames = {item[0] for item in self.endpoints}

    def resolve(self, hostname: str) -> dict:
        authorized = hostname in self.hostnames
        addresses = [PUBLIC_ADDRESS]
        if self.faults is not None:
            addresses = self.faults.dns_answer(hostname, addresses)
        self.canaries.dns.append(
            {"hostname": hostname, "authorized": authorized, "addresses": addresses}
        )
        return {"addresses": addresses}

    async def transport(self, params: dict) -> dict:
        await asyncio.sleep(0)
        hostname = str(params.get("hostname", ""))
        target = str(params.get("path", ""))
        method = str(params.get("method", ""))
        parts = urlsplit(target)
        query = parse_qsl(parts.query, keep_blank_values=True)
        authorized = (hostname, parts.path, method) in self.endpoints
        address = str(params.get("address", ""))
        record = {
            "hostname": hostname,
            "address": address,
            "address_public": address == PUBLIC_ADDRESS,
            "path": parts.path,
            "method": method,
            "query_names": [name for name, _ in query],
            "header_names": sorted((params.get("headers") or {}).keys()),
            "body_keys": None,
            "authorized": authorized,
        }
        body = params.get("body")
        payload = None
        if body:
            try:
                payload = json.loads(body)
                record["body_keys"] = sorted(payload) if isinstance(payload, dict) else None
            except ValueError:
                record["body_keys"] = None
        self.canaries.transports.append(record)
        if not authorized:
            return {
                "status": 404,
                "content_type": "application/json",
                "body": json.dumps({"error": "unknown"}),
            }
        if method == "GET" and parts.path == "/works":
            values = dict(query)
            rows = int(values.get("rows", "0") or 0)
            items = [
                crossref_item(paper)
                for paper in self.corpus.search(values.get("query.bibliographic", ""), rows)
            ]
            answer = {"status": "ok", "message-type": "work-list", "message": {"items": items}}
            tool, request = (
                "scholarly-search",
                {"query": values.get("query.bibliographic"), "limit": rows},
            )
        elif method == "POST" and parts.path == "/resolve":
            request = payload if isinstance(payload, dict) else {}
            answer = self.corpus.resolve(request.get("query", ""))
            tool = "citation-resolver"
        else:
            return {"status": 404, "content_type": "application/json", "body": "{}"}
        status, content_type = 200, "application/json"
        if self.faults is not None:
            delay = self.faults.tool_delay(tool, request)
            if delay:
                await asyncio.sleep(delay)
            status, content_type, answer = self.faults.tool_answer(
                tool, request, status, content_type, answer
            )
        text = answer if isinstance(answer, str) else json.dumps(answer)
        return {"status": status, "content_type": content_type, "body": text}

    def parse_pdf(self, params: dict) -> dict:
        sha256 = str(params.get("sha256", ""))
        known = self.files.get(sha256)
        self.canaries.pdf_parses.append({"sha256": sha256, "known": known is not None})
        if known is None:
            from .rpc import RpcError

            raise RpcError(
                "pdf_unreadable", "the synthetic parser knows no document with these bytes"
            )
        answer = copy.deepcopy(known)
        if self.faults is not None:
            answer = self.faults.pdf_answer(answer)
        return answer


# -- the provider -------------------------------------------------------------------------
class Provider:
    """OpenClaw's completion surface as the plugin's HostLlm sees it."""

    def __init__(self, package: str, model: SyntheticModel, canaries: Canaries, host, faults=None):
        self.package = package
        self.model = model
        self.canaries = canaries
        self.host = host  # the case's live model-host spec (rows, routable, default, plugin_llm)
        self.faults = faults
        self.planned_model: str | None = None
        # Calibration only: keep each well-behaved answer (never the request).
        self.record_answers = False
        self._tasks: dict[str, asyncio.Task] = {}
        self.index = 0

    def abort(self, identifier: str) -> None:
        task = self._tasks.get(identifier)
        if task is not None and not task.done():
            task.cancel()

    def _executes(self, requested: str) -> tuple[str | None, str | None]:
        """Which model OpenClaw would run for an explicit-model request, or an error code."""
        spec = self.host()
        policy = spec.get("plugin_llm") or {}
        if policy.get("allowModelOverride") is not True:
            return None, "LLM_COMPLETION_NOT_AUTHORIZED"
        allowed = policy.get("allowedModels")
        if (
            isinstance(allowed, list)
            and allowed
            and requested not in allowed
            and "*" not in allowed
        ):
            return None, "LLM_COMPLETION_NOT_AUTHORIZED"
        routable = {
            f"{provider}/{model}"
            for provider, models in (spec.get("routable") or {}).items()
            for model in models
        }
        disabled = {
            f"{row.get('provider')}/{row.get('id')}"
            for row in spec.get("rows") or []
            if row.get("status") in ("disabled", "deprecated")
        }
        if requested in routable and requested not in disabled:
            return requested, None
        # resolveSimpleCompletionSelectionRequest falls back to the agent's
        # default when it cannot resolve the requested ref (host-llm.ts).
        return spec.get("default"), None

    def _check_expectation(self, call, action, schema, output, task) -> None:
        """A mutation declares whether its answer must break the schema or keep it.

        A schema-breaking fault that happens to validate (or a relational one
        that happens not to) would make the case vacuous, so it is recorded as
        a harness anomaly and the case cannot count as detection.
        """
        expect = action.get("expect")
        if expect is None or schema is None:
            return
        valid = not any(True for _ in Draft202012Validator(schema).iter_errors(output))
        call["mutation_schema_valid"] = valid
        if (expect == "invalid" and valid) or (expect == "valid" and not valid):
            self.canaries.anomalies.append(
                {
                    "where": "mutation_expectation",
                    "task": task,
                    "expect": expect,
                    "schema_valid": valid,
                }
            )

    async def complete(self, params: dict) -> dict:
        identifier = str(params.get("id"))
        task = asyncio.current_task()
        self._tasks[identifier] = task
        try:
            return await self._complete(params)
        except asyncio.CancelledError:
            return {"error_code": "LLM_COMPLETION_ABORTED", "message": "aborted"}
        finally:
            self._tasks.pop(identifier, None)

    async def _complete(self, params: dict) -> dict:
        self.index += 1
        index = self.index
        requested = str(params.get("model") or "")
        system, user = str(params.get("system", "")), str(params.get("user", ""))
        task, data, schema = parse_request(system, user)
        executed, error = self._executes(requested)
        call = {
            "index": index,
            "task": task,
            "requested_model": requested,
            "executed_model": executed,
            "reported_model": executed,
            "max_tokens": params.get("max_tokens"),
            "input_bytes": len((system + user).encode("utf-8")),
            "item": item_key(self.package, task, data),
            "fault": None,
            "unplanned_model": False,
            "completed": False,
        }
        self.canaries.model_calls.append(call)
        action = self.faults.model_action(task, data, index) if self.faults is not None else None
        if action is not None:
            call["fault"] = action.get("kind")
            if action.get("kind") == "substitute":
                executed = action["model"]
                call["executed_model"] = executed
                call["reported_model"] = executed
        if self.planned_model is not None and executed != self.planned_model:
            call["unplanned_model"] = True
        if error is not None:
            call["error"] = error
            return {"error_code": error, "message": "The host refused this model call."}
        if action is not None and action.get("kind") == "delay":
            await asyncio.sleep(float(action.get("seconds", 0)))
        if action is not None and action.get("kind") == "error":
            call["error"] = action.get("code")
            return {"error_code": action.get("code"), "message": "Injected provider failure."}
        try:
            output = self.model.answer(self.package, task, data)
        except Exception as exc:  # noqa: BLE001 - recorded as a harness anomaly
            self.canaries.anomalies.append(
                {"where": "model", "task": task, "error": f"{type(exc).__name__}: {exc}"[:300]}
            )
            output = {}
        if schema is not None:
            # The well-behaved answer must conform before any fault touches it,
            # or the case would be testing the harness instead of the host.
            errors = list(Draft202012Validator(schema).iter_errors(output))
            if errors:
                self.canaries.anomalies.append(
                    {
                        "where": "model_self_check",
                        "task": task,
                        "error": errors[0].message[:300],
                    }
                )
        if self.record_answers:
            call["answer"] = copy.deepcopy(output)
            call["schema"] = copy.deepcopy(schema)
        text = json.dumps(output, ensure_ascii=False)
        stop = "stop"
        response_model = None
        if action is not None:
            kind = action.get("kind")
            if kind in ("mutate", "substitute") and action.get("apply") is not None:
                output = action["apply"](copy.deepcopy(output), schema)
                text = json.dumps(output, ensure_ascii=False)
                self._check_expectation(call, action, schema, output, task)
            elif kind == "text":
                text = action["text"](text) if callable(action["text"]) else action["text"]
            elif kind == "stop_reason":
                stop = action["value"]
            elif kind == "response_model":
                response_model = action["value"]
        output_tokens = max(1, (len(text.encode("utf-8")) + 3) // 4)
        input_tokens = max(1, call["input_bytes"] // 4)
        usage = {"inputTokens": input_tokens, "outputTokens": output_tokens}
        call["honest_tokens"] = input_tokens + output_tokens
        if action is not None and action.get("kind") == "usage":
            usage = action["apply"](usage, params)
        # A total consistent with the breakdown, unless the fault omits it (a host
        # that reports only the breakdown) or the breakdown is not numeric.
        if not usage.pop("_omit_total", False) and "totalTokens" not in usage:
            try:
                usage["totalTokens"] = int(usage.get("inputTokens", 0)) + int(
                    usage.get("outputTokens", 0)
                )
            except (TypeError, ValueError):
                pass
        provider, _, model = str(executed or "").partition("/")
        call["completed"] = True
        call["output_bytes"] = len(text.encode("utf-8"))
        call["usage"] = dict(usage)
        return {
            "text": text,
            "provider": provider,
            "model": model,
            "responseModel": response_model or f"{model}-synthetic",
            "stopReason": stop,
            "usage": usage,
            "execution": {"mode": "direct-provider", "owner": {"kind": "provider", "id": provider}},
        }
