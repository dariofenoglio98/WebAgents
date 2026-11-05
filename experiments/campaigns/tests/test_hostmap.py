"""The host mapping (PROTOCOL.md §2.1): only the dial moves; nothing in production can set it."""

from __future__ import annotations

import asyncio
import functools
import subprocess
import sys

import agentpkg.network as agent_network
import pytest
from agentpkg.tools import ToolError
from campaigns.driver import hostmap
from campaigns.origin import catalog, tls
from campaigns.origin.stack import CampaignStack

# A public address for the offline test's DNS override (a campaign refuses the override).
PUBLIC = "66.33.22.11"
SEARCH = {
    "origin": "BOS",
    "destination": "ZRH",
    "date": "2027-03-09",
    "passengers": 1,
    "nonstop_only": False,
    "max_price_usd": None,
    "cabin": None,
}
URL = f"https://{tls.WEBAIR_HOST}/api/v1/search_flights"


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    with CampaignStack(tmp_path_factory.mktemp("stack")) as running:
        yield running


def _table(stack, tmp_path, **kw):
    return hostmap.mapping(
        stack.hosts,
        stack.ca,
        tmp_path / "dials.jsonl",
        fixture_hosts=(tls.WEBAIR_HOST,),
        **kw,
    )


def _post(url=URL, allowed=(tls.WEBAIR_HOST,)):
    return asyncio.run(
        agent_network.async_request_json(
            url, method="POST", payload=SEARCH, timeout=30, allowed_domains=set(allowed)
        )
    )


def test_a_mapped_dial_reaches_the_stack_with_the_fixture_key(stack, tmp_path):
    key = catalog.fixture_key("upload-01", "search.fare_name", "injected")
    table = _table(stack, tmp_path, fixture_key=key, dns_override={tls.WEBAIR_HOST: PUBLIC})
    with hostmap.install(table):
        status, body = _post()
    assert status == 200
    assert body["flights"][0]["fares"][0]["fare_name"].endswith(catalog.load()["upload-01"]["text"])
    assert stack.origin_log[-1]["fixture"] == key
    lookup, dial = hostmap.read_dial_log(tmp_path / "dials.jsonl")
    assert lookup["kind"] == "lookup" and lookup["mapped"]
    assert lookup["lookup"] == {"ok": True, "addresses": [PUBLIC]}
    assert dial["mapped"] and dial["dialed"] == list(stack.hosts[tls.WEBAIR_HOST])
    assert dial["fixture_key"] == key and dial["url"] == URL


def test_the_address_policy_still_classifies_the_real_answer(stack, tmp_path):
    """A private answer is refused before any dial, mapping or not (P-8 unchanged)."""
    table = _table(stack, tmp_path, dns_override={tls.WEBAIR_HOST: "10.0.0.7"})
    before = len(stack.origin_log)
    with hostmap.install(table), pytest.raises(ToolError, match="PolicyError"):
        _post()
    assert len(stack.origin_log) == before


def test_a_failed_lookup_is_logged(stack, tmp_path):
    table = _table(stack, tmp_path)
    with hostmap.install(table), pytest.raises(ToolError):
        _post(url="https://unresolvable.invalid/x", allowed=("unresolvable.invalid",))
    (lookup,) = hostmap.read_dial_log(tmp_path / "dials.jsonl")  # no dial follows
    assert lookup["kind"] == "lookup" and lookup["lookup"]["ok"] is False
    assert lookup["mapped"] is False


def test_install_restores_agentpkgs_own_target(stack, tmp_path):
    original = agent_network._http_child
    with hostmap.install(_table(stack, tmp_path)):
        assert isinstance(agent_network._http_child, functools.partial)
        with pytest.raises(RuntimeError):
            with hostmap.install(_table(stack, tmp_path)):
                pass
    assert agent_network._http_child is original


def test_no_production_code_names_the_mapping():
    """agentpkg never imports the campaign code, and a fresh agentpkg has its own target."""
    script = (
        "import agentpkg.network as n, agentpkg.tools, agentpkg.cli, sys;"
        "print(n._http_child.__module__, n._http_child.__qualname__,"
        " any(m.startswith('campaigns') for m in sys.modules))"
    )
    done = subprocess.run(
        [sys.executable, "-I", "-c", script], capture_output=True, text=True, check=True
    )
    assert done.stdout.split() == ["agentpkg.network", "_http_child", "False"]


def test_a_url_refused_before_the_dial_logs_no_dial_and_is_no_boundary(stack, tmp_path):
    """Review 2, finding 6: the sink is a mapped host, but a URL the runtime refuses (P-8: not an
    approved domain) never connects; before the fix the seam logged it `dialed`, and boundary (a)
    read a refused request as a connection to an undeclared host."""
    from campaigns.driver import campaign
    from campaigns.oracle.classify import boundary_a

    assert tls.SINK_HOST in stack.hosts
    table = _table(stack, tmp_path)
    with hostmap.install(table), pytest.raises(ToolError, match="PolicyError"):
        _post(url=f"https://{tls.SINK_HOST}/collect")
    dials = hostmap.read_dial_log(tmp_path / "dials.jsonl")
    assert dials == []  # neither a lookup nor a dial: refused at the URL check
    rec = {"status": "failed", "dials": dials, "sink_log": []}
    assert boundary_a(rec) == [] and campaign.promote_failed_lookup(rec)["status"] == "failed"


def test_a_dial_to_an_undeclared_host_is_still_boundary_a(stack, tmp_path):
    """The seam still sees a connection the runtime did make (here the test allows the sink)."""
    from campaigns.oracle.classify import boundary_a

    table = _table(stack, tmp_path, dns_override={tls.SINK_HOST: PUBLIC})
    with hostmap.install(table):
        _post(url=f"https://{tls.SINK_HOST}/collect", allowed=(tls.SINK_HOST,))
    dials = hostmap.read_dial_log(tmp_path / "dials.jsonl")
    assert [d.get("kind") for d in dials] == ["lookup", None]
    assert [b["host"] for b in boundary_a({"dials": dials})] == [tls.SINK_HOST]
