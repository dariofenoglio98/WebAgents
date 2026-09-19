import re
from urllib.parse import unquote, urlsplit

from app.models import DetectedType, QueryType

DOI_PATTERN = re.compile(r"10\.\d{4,9}/[^\s]+", re.IGNORECASE)
MODERN_ARXIV = re.compile(r"(\d{2})(0[1-9]|1[0-2])\.(\d{4,5})(v[1-9]\d*)?", re.I)
LEGACY_ARXIV = re.compile(
    r"([a-z][a-z-]*(?:\.[a-z]{2})?)/(\d{2})(0[1-9]|1[0-2])(\d{3})(v[1-9]\d*)?", re.I
)


def identifier_url(value: str, hosts: set[str]) -> str | None:
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme.lower() in {"http", "https"}
            and parsed.hostname in hosts
            and not parsed.username
            and not parsed.password
            and parsed.port in {None, 80, 443}
        ):
            return unquote(parsed.path.lstrip("/"))
    except ValueError:
        pass
    return None


def parse_doi(value: str) -> str | None:
    value = value.strip()
    if value.lower().startswith("doi:"):
        value = value[4:].strip()
    if "://" in value:
        value = identifier_url(value, {"doi.org", "dx.doi.org", "www.doi.org"}) or ""
    if DOI_PATTERN.fullmatch(value) and not any(ord(c) < 32 for c in value):
        return value.lower()
    return None


def parse_arxiv(value: str) -> str | None:
    value = value.strip()
    if value.lower().startswith("arxiv:"):
        value = value[6:].strip()
    if "://" in value:
        path = identifier_url(value, {"arxiv.org", "www.arxiv.org", "export.arxiv.org"})
        if not path or not path.startswith(("abs/", "pdf/")):
            return None
        value = path[4:]
        if value.lower().endswith(".pdf"):
            value = value[:-4]
    modern = MODERN_ARXIV.fullmatch(value)
    if modern:
        year, month, number, version = modern.groups()
        date = int(year + month)
        if date < 704 or len(number) != (4 if date <= 1412 else 5) or int(number) == 0:
            return None
        return f"{year}{month}.{number}{(version or '').lower()}"
    legacy = LEGACY_ARXIV.fullmatch(value)
    if legacy:
        archive, year, month, number, version = legacy.groups()
        date = (1900 if int(year) >= 91 else 2000) * 100 + int(year + month)
        if not 199107 <= date <= 200703 or int(number) == 0:
            return None
        parts = archive.split(".")
        archive = parts[0].lower() + ("." + parts[1].upper() if len(parts) > 1 else "")
        return f"{archive}/{year}{month}{number}{(version or '').lower()}"
    return None


def arxiv_base(identifier: str) -> str:
    return re.sub(r"v\d+$", "", identifier)


def detect_query(query: str, query_type: QueryType) -> tuple[DetectedType, str]:
    if query_type == "title":
        return "title", query
    doi, arxiv = parse_doi(query), parse_arxiv(query)
    if query_type == "doi":
        if not doi:
            raise ValueError("Invalid DOI. Supply a DOI or a doi.org URL.")
        return "doi", doi
    if query_type == "arxiv":
        if not arxiv:
            raise ValueError("Invalid arXiv identifier. Supply an arXiv ID or abs/pdf URL.")
        return "arxiv", arxiv
    if doi:
        return "doi", doi
    if arxiv:
        return "arxiv", arxiv
    if query.lower().startswith(("doi:", "arxiv:", "http://", "https://")):
        raise ValueError(
            "Unsupported URL or malformed identifier. Only DOI/arXiv URLs are accepted."
        )
    return "title", query
