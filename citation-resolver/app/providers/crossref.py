from typing import Any
from urllib.parse import quote

from app.config import SEARCH_LIMIT
from app.identifiers import parse_doi
from app.models import Author, Paper
from app.providers.common import Provider, clean_text, payload_errors

BASE = "https://api.crossref.org/works"


def normalize(record: dict[str, Any]) -> Paper:
    doi = parse_doi(record["DOI"])
    if not doi:
        raise ValueError("Missing DOI")
    authors = []
    for author in record.get("author") or []:
        given, family = clean_text(author.get("given")), clean_text(author.get("family"))
        name = clean_text(author.get("name")) or " ".join(x for x in (given, family) if x)
        if name:
            authors.append(Author(name=name, given=given, family=family, orcid=author.get("ORCID")))
    year = None
    for field in ("published", "published-print", "published-online", "issued"):
        date = record.get(field) or {}
        parts = date.get("date-parts") or []
        if parts and parts[0] and parts[0][0]:
            year = parts[0][0]
            break
    titles = record.get("title") or []
    venues = record.get("container-title") or []
    return Paper(
        title=clean_text(titles[0]) if titles else "",
        authors=authors,
        year=year,
        venue=clean_text(venues[0]) if venues else None,
        publisher=clean_text(record.get("publisher")),
        doi=doi,
        url="https://doi.org/" + quote(doi, safe="/"),
        publication_type=record.get("type"),
        abstract=clean_text(record.get("abstract")),
        volume=record.get("volume"),
        issue=record.get("issue"),
        pages=record.get("page"),
        provider_ids={"crossref": doi},
        source="crossref",
    )


class Crossref(Provider):
    name = "crossref"

    def params(self) -> dict[str, str | int]:
        return {"mailto": self.settings.contact_email} if self.settings.contact_email else {}

    async def lookup_doi(self, doi: str) -> list[Paper]:
        data = await self.get_json(BASE + "/" + quote(doi, safe=""), self.params())
        if data is None:
            return []
        with payload_errors():
            return [normalize(data["message"])]

    async def search(self, title: str) -> list[Paper]:
        data = await self.get_json(
            BASE, self.params() | {"query.bibliographic": title, "rows": SEARCH_LIMIT}
        )
        with payload_errors():
            return [normalize(record) for record in data["message"]["items"]]
