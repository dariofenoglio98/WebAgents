import asyncio
import time
from collections import OrderedDict

import httpx
from defusedxml import ElementTree

from app.config import (
    ARXIV_CACHE_SECONDS,
    ARXIV_CACHE_SIZE,
    ARXIV_INTERVAL_SECONDS,
    Settings,
)
from app.identifiers import parse_arxiv, parse_doi
from app.models import Author, Paper
from app.providers.common import Provider, ProviderError, payload_errors

BASE = "https://export.arxiv.org/api/query"
NS = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def normalize_feed(xml: bytes) -> list[Paper]:
    root = ElementTree.fromstring(xml)
    if root.tag != "{" + NS["atom"] + "}feed":
        raise ValueError("Not an Atom feed")
    papers = []
    for entry in root.findall("atom:entry", NS):

        def value(path: str) -> str | None:
            text = entry.findtext(path, namespaces=NS)
            return " ".join(text.split()) if text and text.strip() else None

        identifier = parse_arxiv(value("atom:id") or "")
        if not identifier:
            # arXiv also reports errors as HTTP-200 Atom entries.
            raise ProviderError("invalid_response")
        published = value("atom:published")
        authors = [
            Author(name=" ".join(name.split()))
            for author in entry.findall("atom:author", NS)
            if (name := author.findtext("atom:name", namespaces=NS)) and name.strip()
        ]
        papers.append(
            Paper(
                title=value("atom:title") or "",
                authors=authors,
                year=int(published[:4]) if published else None,
                arxiv_id=identifier,
                doi=parse_doi(value("arxiv:doi") or ""),
                url="https://arxiv.org/abs/" + identifier,
                publication_type="preprint",
                abstract=value("atom:summary"),
                journal_reference=value("arxiv:journal_ref"),
                provider_ids={"arxiv": identifier},
                source="arxiv",
            )
        )
    return papers


class Arxiv(Provider):
    name = "arxiv"

    def __init__(self, client: httpx.AsyncClient, settings: Settings):
        super().__init__(client, settings)
        self._lock = asyncio.Lock()
        self._last_request = float("-inf")
        self._cache: OrderedDict[str, tuple[float, list[Paper]]] = OrderedDict()

    async def lookup_arxiv(self, identifier: str) -> list[Paper]:
        # One process/replica: serialize requests and reuse daily metadata per arXiv guidance.
        async with self._lock:
            cached = self._cache.get(identifier)
            if cached and time.monotonic() - cached[0] < ARXIV_CACHE_SECONDS:
                self._cache.move_to_end(identifier)
                return cached[1]
            wait = ARXIV_INTERVAL_SECONDS - (time.monotonic() - self._last_request)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request = time.monotonic()
            response = await self.get(BASE, {"id_list": identifier, "max_results": 1})
            with payload_errors():
                papers = normalize_feed(response.content) if response is not None else []
            self._cache[identifier] = (time.monotonic(), papers)
            self._cache.move_to_end(identifier)
            while len(self._cache) > ARXIV_CACHE_SIZE:
                self._cache.popitem(last=False)
            return papers
