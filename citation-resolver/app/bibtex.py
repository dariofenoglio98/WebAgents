import hashlib
import re
import unicodedata

from app.models import Author, Paper

ESCAPES = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}
ENTRY_TYPES = {
    "journal-article": "article",
    "article": "article",
    "proceedings-article": "inproceedings",
    "conference-paper": "inproceedings",
    "book-chapter": "incollection",
    "book": "book",
    "monograph": "book",
    "edited-book": "book",
}


def escape(value: str) -> str:
    return "".join(ESCAPES.get(c, c) for c in " ".join(value.split()))


def author_value(author: Author) -> str:
    if author.family:
        value = escape(author.family)
        if author.given:
            value += ", " + escape(author.given)
        return value
    # Literal names preserve collaborations and avoid guessing a name's structure.
    return "{" + escape(author.name) + "}"


def citation_key(paper: Paper) -> str:
    first = paper.authors[0] if paper.authors else None
    author = (first.family or first.name) if first else "anon"
    title = "".join(paper.title.split()[:3])
    raw = f"{author}{paper.year or 'nd'}{title}"
    ascii_key = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode()
    key = re.sub(r"[^A-Za-z0-9]", "", ascii_key).lower()[:70] or "paper"
    identity = paper.doi or paper.arxiv_id or next(iter(paper.provider_ids.values()), raw)
    # A short identifier digest avoids same-author/year/title-prefix collisions.
    digest = hashlib.sha256(identity.encode()).hexdigest()[:8]
    return key + digest


def generate_bibtex(paper: Paper) -> str:
    entry_type = ENTRY_TYPES.get(paper.publication_type or "", "misc")
    fields: dict[str, str] = {"title": "{" + escape(paper.title) + "}"}
    if paper.authors:
        fields["author"] = " and ".join(author_value(a) for a in paper.authors)
    for name, value in (
        ("year", str(paper.year) if paper.year else None),
        ("publisher", paper.publisher),
        ("volume", paper.volume),
        ("number", paper.issue),
        ("pages", paper.pages),
        ("doi", paper.doi),
        ("url", paper.url),
    ):
        if value:
            fields[name] = escape(value)
    if paper.venue:
        venue_field = {
            "article": "journal",
            "inproceedings": "booktitle",
            "incollection": "booktitle",
        }.get(entry_type, "howpublished")
        fields[venue_field] = escape(paper.venue)
    if paper.arxiv_id:
        fields["eprint"] = escape(paper.arxiv_id)
        fields["archivePrefix"] = "arXiv"
    if paper.journal_reference:
        fields["note"] = escape(paper.journal_reference)
    body = ",\n".join(f"  {name} = {{{value}}}" for name, value in fields.items())
    return f"@{entry_type}{{{citation_key(paper)},\n{body}\n}}"
