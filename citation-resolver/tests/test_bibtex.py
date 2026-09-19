import re

from app.bibtex import citation_key, generate_bibtex
from app.models import Author, Paper


def test_bibtex_verified_fields_and_stable_key():
    paper = Paper(
        title="A Study of Reliable Citations",
        source="crossref",
        year=2020,
        authors=[Author(name="Ada Researcher", given="Ada", family="Researcher")],
        doi="10.1234/example",
        venue="Example Journal",
        publication_type="journal-article",
    )
    bibtex = generate_bibtex(paper)
    assert bibtex.startswith("@article{researcher2020astudyof")
    assert "author = {Researcher, Ada}" in bibtex
    assert "journal = {Example Journal}" in bibtex
    assert "doi = {10.1234/example}" in bibtex
    assert "title = {{A Study of Reliable Citations}}" in bibtex
    assert re.fullmatch(r"[a-z0-9]+", citation_key(paper))
    assert generate_bibtex(paper) == bibtex


def test_missing_metadata_is_not_invented():
    bibtex = generate_bibtex(Paper(title="Only a title", source="crossref"))
    assert bibtex.startswith("@misc{")
    for missing in ("author =", "year =", "doi =", "journal =", "publisher ="):
        assert missing not in bibtex


def test_escaping_and_literal_collaboration_name():
    paper = Paper(
        title=r"A & B: 50% $x_1$ {test} \input{evil} #~^",
        source="arxiv",
        authors=[Author(name="Research and Development Collaboration")],
    )
    bibtex = generate_bibtex(paper)
    for escaped in (r"\&", r"\%", r"\$", r"\_", r"\{", r"\textbackslash{}", r"\#"):
        assert escaped in bibtex
    assert r"\input{" not in bibtex
    assert "author = {{Research and Development Collaboration}}" in bibtex


def test_arxiv_bibtex_preserves_version_and_does_not_infer_journal():
    paper = Paper(
        title="An example preprint",
        source="arxiv",
        arxiv_id="1706.03762v2",
        publication_type="preprint",
        journal_reference="Example Journal (2018)",
    )
    bibtex = generate_bibtex(paper)
    assert bibtex.startswith("@misc{")
    assert "eprint = {1706.03762v2}" in bibtex
    assert "archivePrefix = {arXiv}" in bibtex
    assert "note = {Example Journal (2018)}" in bibtex
    assert "journal =" not in bibtex


def test_conference_and_key_collision():
    a = Paper(
        title="Study of Citations",
        doi="10.1234/a",
        source="crossref",
        publication_type="proceedings-article",
        venue="Example Conference",
    )
    b = a.model_copy(update={"doi": "10.1234/b"})
    assert generate_bibtex(a).startswith("@inproceedings{")
    assert "booktitle = {Example Conference}" in generate_bibtex(a)
    assert citation_key(a) != citation_key(b)
