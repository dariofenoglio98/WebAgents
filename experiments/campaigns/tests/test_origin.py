"""The payload catalog, the sink and the campaign stack (PROTOCOL.md §2.1, §2.6; D-351)."""

from __future__ import annotations

import http.client
import json
import shutil
import socket
import ssl

import pytest
from campaigns.origin import catalog, tls
from campaigns.origin.stack import CampaignStack

SEARCH = {
    "origin": "BOS",
    "destination": "ZRH",
    "date": "2027-03-09",
    "passengers": 1,
    "nonstop_only": False,
    "max_price_usd": None,
    "cabin": None,
}


def test_every_family_has_a_payload_with_provenance():
    payloads = catalog.load()
    assert {p["family"] for p in payloads.values()} == set(catalog.FAMILIES)
    for payload in payloads.values():
        assert len(payload["twin"]) == len(payload["text"])
        assert payload["text"] != payload["twin"]


def test_a_payload_whose_twin_differs_in_length_is_refused(tmp_path):
    source = next(catalog.PAYLOADS.glob("F-UPLOAD/*.json"))
    target = tmp_path / "F-UPLOAD" / source.name
    target.parent.mkdir()
    payload = json.loads(source.read_text())
    payload["twin"] = payload["twin"][:-1]
    target.write_text(json.dumps(payload))
    with pytest.raises(catalog.CatalogError, match="twin"):
        catalog.load(tmp_path)


def test_an_unknown_placement_is_refused(tmp_path):
    shutil.copytree(catalog.PAYLOADS, tmp_path / "payloads")
    path = next((tmp_path / "payloads").glob("F-ACTION/*.json"))
    payload = json.loads(path.read_text())
    payload["placements"] = ["nowhere"]
    path.write_text(json.dumps(payload))
    with pytest.raises(catalog.CatalogError, match="placements"):
        catalog.load(tmp_path / "payloads")


def test_the_digest_covers_every_file():
    digest = catalog.catalog_digest()
    assert len(digest["files"]) == len(catalog.load())


def _mapped(stack, host):
    context = ssl.create_default_context(cafile=str(stack.ca))
    address = stack.hosts[host]

    class Mapped(http.client.HTTPSConnection):
        def connect(self):
            raw = socket.create_connection(address, timeout=10)
            self.sock = context.wrap_socket(raw, server_hostname=host)

    return Mapped(host, context=context)


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    with CampaignStack(tmp_path_factory.mktemp("stack")) as running:
        yield running


def test_the_stack_serves_the_public_hostname_over_the_campaign_ca(stack):
    connection = _mapped(stack, tls.WEBAIR_HOST)
    key = catalog.fixture_key("upload-01", "search.fare_name", "injected")
    connection.request(
        "POST",
        "/api/v1/search_flights",
        body=json.dumps(SEARCH),
        headers={"Content-Type": "application/json", "X-Campaign-Fixture": key},
    )
    answer = json.loads(connection.getresponse().read())
    text = catalog.load()["upload-01"]["text"]
    assert answer["flights"][0]["fares"][0]["fare_name"].endswith(text)
    assert stack.origin_log[-1]["fixture"] == key and stack.origin_log[-1]["inserted"]


def test_the_system_trust_store_does_not_trust_the_campaign_ca(stack):
    """Only a client given the campaign CA can talk to the stack: nothing else trusts it."""
    host = tls.WEBAIR_HOST
    raw = socket.create_connection(stack.hosts[host], timeout=10)
    with pytest.raises(ssl.SSLCertVerificationError):
        ssl.create_default_context().wrap_socket(raw, server_hostname=host)


def test_the_sink_records_what_it_receives(stack):
    before = len(stack.sink.log)
    connection = _mapped(stack, tls.SINK_HOST)
    connection.request(
        "POST", "/collect?d=1", body=b'{"e":"x"}', headers={"Content-Type": "application/json"}
    )
    assert connection.getresponse().status == 200
    entry = stack.sink.log[before]
    assert entry["path"] == "/collect" and entry["query"] == "d=1" and entry["body"] == '{"e":"x"}'
