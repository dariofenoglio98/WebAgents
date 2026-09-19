from collections.abc import Iterator
from contextlib import contextmanager
from html import unescape
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlsplit
from xml.etree.ElementTree import ParseError

import httpx
from defusedxml.common import DefusedXmlException

from app.config import Settings
from app.models import ProviderName

PROVIDER_HOSTS = {"api.crossref.org", "api.openalex.org", "export.arxiv.org"}


class ProviderError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@contextmanager
def payload_errors() -> Iterator[None]:
    try:
        yield
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        AttributeError,
        ParseError,
        DefusedXmlException,
    ) as exc:
        raise ProviderError("invalid_response") from exc


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    parser = _Text()
    parser.feed(value)
    return " ".join(unescape("".join(parser.parts)).split()) or None


def safe_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username:
        return value
    return None


class Provider:
    name: ProviderName

    def __init__(self, client: httpx.AsyncClient, settings: Settings):
        self.client = client
        self.settings = settings

    async def get(
        self, url: str, params: dict[str, str | int] | None = None
    ) -> httpx.Response | None:
        # Neither supplied identifiers nor upstream redirects may change the destination host.
        target = httpx.URL(url)
        if target.scheme != "https" or target.host not in PROVIDER_HOSTS:
            raise ValueError("Unexpected provider destination")
        try:
            response = await self.client.get(
                url,
                params=params,
                follow_redirects=False,
                headers={"User-Agent": self.settings.user_agent},
            )
            if response.status_code == 404:
                return None
            if response.status_code == 429:
                raise ProviderError("rate_limited")
            if response.status_code in {401, 403}:
                raise ProviderError("access_denied")
            if response.is_redirect:
                raise ProviderError("unexpected_redirect")
            response.raise_for_status()
            return response
        except httpx.TimeoutException as exc:
            raise ProviderError("timeout") from exc
        except httpx.HTTPError as exc:
            raise ProviderError("upstream_unavailable") from exc

    async def get_json(self, url: str, params: dict[str, str | int] | None = None) -> Any:
        response = await self.get(url, params)
        if response is None:
            return None
        with payload_errors():
            return response.json()
