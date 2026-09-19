from copy import deepcopy

from app.bibtex import generate_bibtex
from app.providers.crossref import normalize as crossref_normalize
from app.providers.openalex import normalize as openalex_normalize


def test_openalex_conference_raw_venue(openalex_record):
    openalex_record["type"] = "conference-paper"
    openalex_record["primary_location"] = {
        "source": None,
        "raw_source_name": "Example Research Conference",
    }
    paper = openalex_normalize(openalex_record)
    assert paper.venue == "Example Research Conference"
    assert generate_bibtex(paper).startswith("@inproceedings{")


def test_arxiv_location_versions_collapse_but_distinct_works_do_not(openalex_record):
    openalex_record["locations"].append({"landing_page_url": "https://arxiv.org/abs/1706.03762v5"})
    assert openalex_normalize(openalex_record).arxiv_id == "1706.03762"
    openalex_record["locations"].append({"landing_page_url": "https://arxiv.org/abs/1706.03763"})
    assert openalex_normalize(openalex_record).arxiv_id is None


def test_optional_metadata_is_not_filled_from_memory(crossref_record, openalex_record):
    crossref = crossref_normalize(
        {"DOI": crossref_record["DOI"], "title": crossref_record["title"]}
    )
    openalex = openalex_normalize({"id": openalex_record["id"], "title": openalex_record["title"]})
    for paper in (crossref, openalex):
        assert paper.authors == []
        assert paper.year is None and paper.venue is None and paper.publisher is None
        assert paper.abstract is None and paper.arxiv_id is None


def test_crossref_does_not_use_record_creation_date_as_publication_year(crossref_record):
    record = deepcopy(crossref_record)
    record.pop("published")
    record["created"] = {"date-parts": [[2025]]}
    assert crossref_normalize(record).year is None
    record["issued"] = {"date-parts": [[2017]]}
    assert crossref_normalize(record).year == 2017
