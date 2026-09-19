from typing import Any
from urllib.parse import quote

from app.config import SEARCH_LIMIT
from app.identifiers import arxiv_base, parse_arxiv, parse_doi
from app.models import Author, Paper
from app.providers.common import Provider, clean_text, payload_errors, safe_url

BASE = "https://api.openalex.org/works"


def normalize(record: dict[str, Any]) -> Paper:
    authors = []
    for authorship in record.get("authorships") or []:
        author = authorship.get("author") or {}
        name = clean_text(author.get("display_name"))
        if name:
            # Display names are not safely splittable into given/family names.
            authors.append(Author(name=name, orcid=author.get("orcid")))
    location = record.get("primary_location") or {}
    source = location.get("source") or {}
    doi = parse_doi(record.get("doi") or "")
    arxiv_ids = {
        arxiv_base(identifier)
        for item in record.get("locations") or []
        if (identifier := parse_arxiv(item.get("landing_page_url") or ""))
    }
    biblio = record.get("biblio") or {}
    pages = biblio.get("first_page")
    if pages and biblio.get("last_page") and biblio["last_page"] != pages:
        pages += "-" + biblio["last_page"]
    index = record.get("abstract_inverted_index") or {}
    words = sorted((position, word) for word, positions in index.items() for position in positions)
    abstract = " ".join(word for _, word in words) if words else None
    provider_ids = {str(k): str(v) for k, v in (record.get("ids") or {}).items() if v is not None}
    provider_ids["openalex"] = record["id"]
    publication_type = record.get("type")
    if publication_type == "article" and source.get("type") == "conference":
        publication_type = "proceedings-article"
    return Paper(
        title=clean_text(record.get("title") or record.get("display_name")) or "",
        authors=authors,
        year=record.get("publication_year"),
        venue=clean_text(source.get("display_name") or location.get("raw_source_name")),
        doi=doi,
        arxiv_id=next(iter(arxiv_ids)) if len(arxiv_ids) == 1 else None,
        url=("https://doi.org/" + quote(doi, safe="/"))
        if doi
        else safe_url(location.get("landing_page_url")),
        publication_type=publication_type,
        abstract=abstract,
        volume=biblio.get("volume"),
        issue=biblio.get("issue"),
        pages=pages,
        provider_ids=provider_ids,
        source="openalex",
    )


class OpenAlex(Provider):
    name = "openalex"

    async def lookup_doi(self, doi: str) -> list[Paper]:
        data = await self.get_json(BASE + "/https://doi.org/" + quote(doi, safe=""))
        if data is None:
            return []
        with payload_errors():
            return [normalize(data)]

    async def search(self, title: str) -> list[Paper]:
        data = await self.get_json(BASE, {"search": title, "per_page": SEARCH_LIMIT})
        with payload_errors():
            return [normalize(record) for record in data["results"]]
