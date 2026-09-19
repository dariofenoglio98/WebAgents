import asyncio
from collections.abc import Awaitable, Callable

from app.bibtex import generate_bibtex
from app.config import MAX_ALTERNATIVES, PROVIDER_TIMEOUT_SECONDS
from app.identifiers import arxiv_base, detect_query
from app.matching import confident, conflicting_fields, normalize_title, rank_candidates
from app.models import Paper, ProviderName, ResolveRequest, ResolveResponse, SourceAttempt
from app.providers.arxiv import Arxiv
from app.providers.common import ProviderError
from app.providers.crossref import Crossref
from app.providers.openalex import OpenAlex


class Resolver:
    def __init__(self, crossref: Crossref, openalex: OpenAlex, arxiv: Arxiv):
        self.crossref, self.openalex, self.arxiv = crossref, openalex, arxiv

    async def _call(
        self,
        provider: ProviderName,
        operation: Callable[[], Awaitable[list[Paper]]],
        sources: list[SourceAttempt],
        expected: tuple[str, str] | None = None,
    ) -> list[Paper]:
        try:
            # Bound total time including waiting for the arXiv request gate.
            async with asyncio.timeout(PROVIDER_TIMEOUT_SECONDS + 4):
                papers = await operation()
            if expected and papers:
                kind, identifier = expected
                for paper in papers:
                    actual = paper.doi if kind == "doi" else paper.arxiv_id
                    if kind == "arxiv" and actual and identifier == arxiv_base(identifier):
                        actual = arxiv_base(actual)
                    if actual != identifier:
                        raise ProviderError("identifier_mismatch")
            sources.append(SourceAttempt(provider=provider, status="ok" if papers else "not_found"))
            return papers
        except (ProviderError, TimeoutError) as exc:
            code = exc.code if isinstance(exc, ProviderError) else "timeout"
            sources.append(SourceAttempt(provider=provider, status="error", error_code=code))
            return []

    async def resolve(self, request: ResolveRequest) -> ResolveResponse:
        kind, query = detect_query(request.query, request.query_type)
        sources: list[SourceAttempt] = []
        response = ResolveResponse(
            status="not_found",
            query=request.query,
            detected_type=kind,
            message="No credible work found in the queried providers.",
        )
        if kind == "title":
            if not normalize_title(query):
                raise ValueError("A title query must contain letters or digits.")
            # Normalize away provider query syntax as well as punctuation.
            search = normalize_title(query)
            papers = await self._call("openalex", lambda: self.openalex.search(search), sources)
            candidates, warnings = rank_candidates(query, papers)
            needs_confirmation = False
            leading = candidates[0].paper if candidates else None
            if (
                confident(query, candidates)
                and leading
                and leading.publication_type == "preprint"
                and leading.arxiv_id
            ):
                # An index can conflate later deposits with an arXiv original.
                # Prefer the complete authoritative record for an identified preprint.
                identifier = leading.arxiv_id
                verified = await self._call(
                    "arxiv",
                    lambda: self.arxiv.lookup_arxiv(identifier),
                    sources,
                    ("arxiv", identifier),
                )
                checked, _ = rank_candidates(query, verified)
                if confident(query, checked):
                    fields = conflicting_fields(leading, checked[0].paper)
                    if leading.doi and leading.doi != checked[0].paper.doi:
                        fields.append("doi")
                    if fields:
                        warnings.append(
                            f"OpenAlex/arXiv preprint metadata differ on {', '.join(fields)}; "
                            "using the complete arXiv record as authoritative for this preprint."
                        )
                    candidates[0] = checked[0]
                    candidates.sort(key=lambda candidate: -candidate.match_score)
                else:
                    needs_confirmation = True
                    warnings.append("Could not verify the indexed preprint against arXiv.")
            elif not confident(query, candidates) or (
                leading and (not leading.authors or not leading.year or not leading.venue)
            ):
                papers += await self._call(
                    "crossref", lambda: self.crossref.search(search), sources
                )
                candidates, warnings = rank_candidates(query, papers)
            response.warnings.extend(warnings)
            if candidates:
                response.status = (
                    "resolved"
                    if confident(query, candidates) and not needs_confirmation
                    else "ambiguous"
                )
                response.best_match = candidates[0].paper
                response.match_score = candidates[0].match_score
                response.alternatives = candidates[1 : MAX_ALTERNATIVES + 1]
                response.message = (
                    "Strong lexical title match within retrieved candidates; "
                    "score is not a probability."
                    if response.status == "resolved"
                    else "Title match is uncertain; confirm author, year, venue, "
                    "or exact identifier. "
                    "best_match is only the leading candidate."
                )
        else:
            if kind == "doi":
                papers = await self._call(
                    "crossref", lambda: self.crossref.lookup_doi(query), sources, (kind, query)
                )
                if not papers:
                    papers = await self._call(
                        "openalex", lambda: self.openalex.lookup_doi(query), sources, (kind, query)
                    )
            else:
                papers = await self._call(
                    "arxiv", lambda: self.arxiv.lookup_arxiv(query), sources, (kind, query)
                )
            if papers:
                response.status = "resolved"
                response.best_match = papers[0]
                response.match_score = 1.0
                response.message = "Exact identifier verified against the provider record."

        response.sources = sources
        failures = [s for s in sources if s.status == "error"]
        if failures:
            response.warnings.append("Some provider requests failed; coverage may be incomplete.")
            if response.status == "not_found":
                response.status = "provider_error"
                response.message = (
                    "Resolution could not complete because a provider failed. Retry later."
                )
        for paper in [response.best_match, *(c.paper for c in response.alternatives)]:
            if paper and paper.source == "openalex" and len(paper.authors) >= 100:
                response.warnings.append("OpenAlex may truncate author lists at 100 authors.")
        if request.format == "bibtex":
            # Copy before attaching generated fields; do not mutate the arXiv cache.
            if response.best_match:
                paper = response.best_match
                response.best_match = paper.model_copy(update={"bibtex": generate_bibtex(paper)})
            for candidate in response.alternatives:
                paper = candidate.paper
                candidate.paper = paper.model_copy(update={"bibtex": generate_bibtex(paper)})
        return response
