from contextlib import ExitStack
from copy import deepcopy

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture(autouse=True)
def block_live_network(monkeypatch):
    async def blocked(*args, **kwargs):
        raise AssertionError("Tests must use MockTransport; live network is disabled")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


@pytest.fixture
def crossref_record():
    # Synthetic metadata, shaped after the documented provider schema.
    return {
        "DOI": "10.1234/example",
        "title": ["A Study of Reliable Citations"],
        "author": [{"given": "Ada", "family": "Researcher", "ORCID": "https://orcid.org/example"}],
        "published": {"date-parts": [[2020, 2, 1]]},
        "container-title": ["Example Journal"],
        "publisher": "Example Press",
        "type": "journal-article",
        "volume": "4",
        "issue": "2",
        "page": "1-9",
        "abstract": "<jats:p>Verified &amp; structured.</jats:p>",
    }


@pytest.fixture
def openalex_record():
    return {
        "id": "https://openalex.org/W123",
        "doi": "https://doi.org/10.1234/example",
        "title": "A Study of Reliable Citations",
        "publication_year": 2020,
        "type": "article",
        "authorships": [{"author": {"display_name": "Ada Researcher", "orcid": None}}],
        "ids": {"openalex": "https://openalex.org/W123", "doi": "https://doi.org/10.1234/example"},
        "primary_location": {
            "source": {"display_name": "Example Journal", "type": "journal"},
            "landing_page_url": "https://doi.org/10.1234/example",
        },
        "locations": [{"landing_page_url": "https://arxiv.org/abs/1706.03762"}],
        "biblio": {"volume": "4", "issue": "2", "first_page": "1", "last_page": "9"},
        "abstract_inverted_index": {"structured.": [2], "Verified": [0], "and": [1]},
    }


@pytest.fixture
def arxiv_feed():
    return b"""<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <id>http://arxiv.org/abs/1706.03762v2</id>
        <title>A Study of Reliable Citations</title>
        <published>2017-06-12T00:00:00Z</published>
        <updated>2018-01-01T00:00:00Z</updated>
        <author><name>Ada Researcher</name></author>
        <summary>An example abstract.</summary>
        <arxiv:doi>10.1234/example</arxiv:doi>
        <arxiv:journal_ref>Example Journal 4 (2018) 1-9</arxiv:journal_ref>
      </entry>
    </feed>"""


@pytest.fixture
def client_factory():
    with ExitStack() as stack:

        def factory(handler, settings=None):
            settings = settings or Settings(allowed_hosts=("testserver",))
            app = create_app(settings, httpx.MockTransport(handler))
            return stack.enter_context(TestClient(app))

        yield factory


@pytest.fixture
def changed_record():
    def change(record, **updates):
        return deepcopy(record) | updates

    return change
