import unicodedata

from rapidfuzz.fuzz import ratio, token_sort_ratio

from app.config import (
    TITLE_AMBIGUITY_MARGIN,
    TITLE_CREDIBLE_THRESHOLD,
    TITLE_MIN_RESOLVED_WORDS,
    TITLE_RESOLVED_THRESHOLD,
)
from app.identifiers import arxiv_base
from app.models import Candidate, Paper


def normalize_title(title: str) -> str:
    title = unicodedata.normalize("NFKC", title).casefold()
    return " ".join("".join(c if c.isalnum() else " " for c in title).split())


def title_score(query: str, title: str) -> float:
    left, right = normalize_title(query), normalize_title(title)
    if not left or not right:
        return 0.0
    # Full-string comparison penalizes missing words; avoid partial/token-set matching.
    return (0.7 * ratio(left, right) + 0.3 * token_sort_ratio(left, right)) / 100


def record_key(paper: Paper) -> str:
    if paper.doi:
        return "doi:" + paper.doi
    if paper.arxiv_id:
        return "arxiv:" + arxiv_base(paper.arxiv_id)
    return paper.source + ":" + next(iter(paper.provider_ids.values()), paper.title)


def conflicting_fields(left: Paper, right: Paper) -> list[str]:
    conflicts = []
    for field in ("title", "year", "venue", "publisher", "volume", "issue", "pages"):
        a, b = getattr(left, field), getattr(right, field)
        if a and b and normalize_title(str(a)) != normalize_title(str(b)):
            conflicts.append(field)
    if left.authors and right.authors:
        a = [normalize_title(x.name) for x in left.authors]
        b = [normalize_title(x.name) for x in right.authors]
        if a != b:
            conflicts.append("authors")
    return conflicts


def rank_candidates(query: str, papers: list[Paper]) -> tuple[list[Candidate], list[str]]:
    unique: dict[str, Paper] = {}
    conflicts: list[Paper] = []
    warnings = []
    for paper in papers:
        key = record_key(paper)
        previous = unique.get(key)
        if previous is None:
            unique[key] = paper
        elif fields := conflicting_fields(previous, paper):
            conflicts.append(paper)
            warnings.append(
                f"Conflicting {', '.join(fields)} for {key} from "
                f"{previous.source}/{paper.source}; records retained separately."
            )
        elif paper.source == "crossref":
            # Select the registrant's whole record; never fill fields from another provider.
            unique[key] = paper
    candidates = [
        Candidate(paper=paper, match_score=title_score(query, paper.title))
        for paper in [*unique.values(), *conflicts]
    ]
    candidates.sort(key=lambda c: (-c.match_score, record_key(c.paper), c.paper.source))
    return [c for c in candidates if c.match_score >= TITLE_CREDIBLE_THRESHOLD], warnings


def confident(query: str, candidates: list[Candidate]) -> bool:
    return bool(
        candidates
        and candidates[0].match_score >= TITLE_RESOLVED_THRESHOLD
        and len(normalize_title(query).split()) >= TITLE_MIN_RESOLVED_WORDS
        and (
            len(candidates) == 1
            or candidates[0].match_score - candidates[1].match_score > TITLE_AMBIGUITY_MARGIN
        )
    )
