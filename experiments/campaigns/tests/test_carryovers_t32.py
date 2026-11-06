"""T32's carry-overs from T31 reviews 1–3 and T31b reviews 1–2 (the spec's carry-over lists): one
test per item, each failing on the code before the change."""

from __future__ import annotations

import asyncio
import json
import socket

import pytest
from campaigns.baseline import ports, tools
from campaigns.driver import campaign, cr_driver, hostmap, py_driver, record
from campaigns.driver.responder import Responder
from campaigns.driver.routes import CampaignRouter, Rung
from campaigns.oracle import classify
from campaigns.origin import tls
from campaigns.origin.stack import CampaignStack
from campaigns.records import canaries
from campaigns.tasks import score

PACKAGE = ports.load("webair")
PUBLIC = "66.33.22.11"


def _closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]  # closed once the socket is: nothing listens there


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    with CampaignStack(tmp_path_factory.mktemp("stack")) as running:
        yield running


# -- T31 review 3, carry-over 1 (and T31b review 1, carry-over 1): `connected` on every seam -------
def test_py_a_dial_that_fails_to_connect_is_connected_false_and_no_boundary(stack, tmp_path):
    from agentpkg.network import async_request_json
    from agentpkg.tools import ToolError

    hosts = {**stack.hosts, tls.SINK_HOST: ("127.0.0.1", _closed_port())}
    table = hostmap.mapping(
        hosts,
        stack.ca,
        tmp_path / "dials.jsonl",
        fixture_hosts=py_driver.FIXTURE_HOSTS,
        dns_override={tls.SINK_HOST: PUBLIC},
    )
    with hostmap.install(table), pytest.raises(ToolError):
        asyncio.run(
            async_request_json(
                f"https://{tls.SINK_HOST}/collect",
                method="POST",
                payload={},
                timeout=10,
                allowed_domains={tls.SINK_HOST},
            )
        )
    lookup, dial = hostmap.read_dial_log(tmp_path / "dials.jsonl")
    assert lookup["kind"] == "lookup" and dial["dialed"] and dial["connected"] is False
    assert classify.boundary_a({"dials": [lookup, dial]}) == []


def test_py_a_dial_that_connects_is_connected_true(stack, tmp_path):
    from agentpkg.network import async_request_json

    table = hostmap.mapping(
        stack.hosts,
        stack.ca,
        tmp_path / "dials.jsonl",
        fixture_hosts=py_driver.FIXTURE_HOSTS,
        dns_override={tls.SINK_HOST: PUBLIC},
    )
    with hostmap.install(table):
        asyncio.run(
            async_request_json(
                f"https://{tls.SINK_HOST}/collect",
                method="POST",
                payload={},
                timeout=10,
                allowed_domains={tls.SINK_HOST},
            )
        )
    _lookup, dial = hostmap.read_dial_log(tmp_path / "dials.jsonl")
    assert dial["connected"] is True
    assert [b["host"] for b in classify.boundary_a({"dials": [dial]})] == [tls.SINK_HOST]


def test_cr_a_dial_that_fails_to_connect_is_connected_false(tmp_path):
    ca = tmp_path / "ca.pem"
    ca.write_text("not used: the TCP connection fails first\n")
    port = _closed_port()
    job = cr_driver.webair_job(
        turns=["hello"],
        rung=None,
        memory_dir=py_driver.prepare_memory(tmp_path, None),
        stack=None,
        responder=Responder("R-facts"),
        fixture_key=None,
    )
    job["mapping"] = {
        "hosts": {tls.SINK_HOST: ["127.0.0.1", port]},
        "ca": str(ca),
        "fixture_key": None,
        "fixture_hosts": [],
    }
    job["probe_dial"] = {"servername": tls.SINK_HOST, "host": PUBLIC, "port": 443}
    out = cr_driver.run_job(job, timeout=300)
    assert out["probe"] == "dial" and out["error"]
    (dial,) = out["dials"]
    assert dial["mapped"] is True and dial["dialed"] == ["127.0.0.1", port]
    assert dial["connected"] is False
    assert classify.boundary_a({"dials": out["dials"]}) == []


def _fw_layer(stack_hosts, ca):
    return tools.ToolLayer(
        specs=ports.function_tool_specs(PACKAGE),
        state=tools.RunState(),
        transport=tools.Transport(
            hosts=stack_hosts, ca=str(ca), fixture_key=None, fixture_hosts=py_driver.FIXTURE_HOSTS
        ),
        memory_handlers={},
        responder=Responder("R-deny"),
        budget=PACKAGE.policy["budget"],
        offered=set(PACKAGE.tools),
        files=PACKAGE.files,
    )


def _search_spec(layer):
    return next(s for s in layer.specs.values() if s["tool_id"] == "search-flights")


def test_fw_the_dial_log_has_hostmaps_shape_and_connected(stack, monkeypatch):
    monkeypatch.setattr(tools, "_lookup", lambda host: {"ok": True, "addresses": [PUBLIC]})
    layer = _fw_layer(stack.hosts, stack.ca)
    status, _body = asyncio.run(layer._http(_search_spec(layer), {"origin": "BOS"}))
    lookup, dial = layer.state.dials
    assert lookup == {
        "at": lookup["at"],
        "kind": "lookup",
        "host": tls.WEBAIR_HOST,
        "mapped": True,
        "lookup": {"ok": True, "addresses": [PUBLIC]},
    }
    assert "lookup" not in dial and dial["dialed"] and dial["connected"] is True
    assert dial["status"] == status


def test_fw_a_dial_that_fails_to_connect_is_connected_false(stack, monkeypatch):
    import httpx

    monkeypatch.setattr(tools, "_lookup", lambda host: {"ok": True, "addresses": [PUBLIC]})
    hosts = {**stack.hosts, tls.WEBAIR_HOST: ("127.0.0.1", _closed_port())}
    layer = _fw_layer(hosts, stack.ca)
    with pytest.raises(httpx.ConnectError):
        asyncio.run(layer._http(_search_spec(layer), {"origin": "BOS"}))
    _lookup, dial = layer.state.dials
    assert dial["connected"] is False and dial["error"] == "ConnectError"


def test_fw_a_failed_lookup_dials_nothing_and_is_a_harness_error(stack, monkeypatch):
    monkeypatch.setattr(tools, "_lookup", lambda host: {"ok": False, "error": "gaierror"})
    layer = _fw_layer(stack.hosts, stack.ca)
    before = len(stack.origin_log)
    with pytest.raises(RuntimeError, match="lookup"):
        asyncio.run(layer._http(_search_spec(layer), {"origin": "BOS"}))
    (lookup,) = layer.state.dials
    assert lookup["kind"] == "lookup" and len(stack.origin_log) == before
    rec = campaign.promote_failed_lookup({"status": "failed", "dials": layer.state.dials})
    assert rec["status"] == "harness_error"


# -- T31 review 3, carry-over 2: non-object arguments on `FW` --------------------------------------
@pytest.mark.parametrize("raw", ["null", "5", "[]"])
def test_fw_a_non_object_payload_is_recorded_as_unparsed_not_a_type_error(stack, raw):
    layer = _fw_layer(stack.hosts, stack.ca)
    spec = _search_spec(layer)

    async def failing(ctx, input_json, *rest, _marker=None, **kw):
        raise ValueError("Progent could not parse the call")

    wrapped = layer.record(failing, spec)
    with pytest.raises(ValueError, match="Progent"):
        asyncio.run(wrapped(None, raw))
    (entry,) = layer.state.unparsed
    assert entry["arguments"] == {"_unparsed": raw} and entry["outcome"] == "unparsed"


# -- T31 review 3, carry-over 3: a record the oracle cannot classify -------------------------------
def test_an_oracle_failure_does_not_stop_the_campaign(tmp_path, monkeypatch):
    units = [
        {
            "id": f"u{i}",
            "task_id": "W1-01",
            "task_set": "TS-W",
            "rung": "L9",
            "side": "Py",
            "arm": None,
        }
        for i in (1, 2)
    ]
    out = tmp_path / "out"
    calls = []

    def fake_run_unit(unit, *, out, **kw):
        run_dir = out / "runs" / unit["id"]
        run_dir.mkdir(parents=True)
        (run_dir / "run.json").write_text("{}")
        calls.append(unit["id"])
        if unit["id"] == "u1":
            raise KeyError("the oracle cannot read this record")
        (run_dir / "outcome.json").write_text(
            json.dumps({"harness_error": False, "boundaries": [], "exposed": None})
        )
        return {"harness_error": False, "boundaries": [], "exposed": None, "utility": {}}

    class Stack:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    import campaigns.origin.stack as stack_module

    monkeypatch.setattr(campaign, "units_for", lambda *a, **k: units)
    monkeypatch.setattr(campaign, "ordered", lambda u, *a: u)
    monkeypatch.setattr(campaign, "manifest", lambda **k: {"envelopes": {}, "units": len(units)})
    monkeypatch.setattr(campaign, "run_unit", fake_run_unit)
    monkeypatch.setattr(
        campaign, "summarize", lambda o, u: {"cells": {}, "complete": False, "missing": ["u1"]}
    )
    monkeypatch.setattr(stack_module, "CampaignStack", Stack)
    monkeypatch.setattr(campaign, "route_ready", lambda rung: True)
    code = campaign.main(["--preset", "smoke", "--rungs", "L9", "--sides", "Py", "--out", str(out)])
    assert code == 1 and calls == ["u1", "u2"]
    lines = [json.loads(x) for x in (out / "progress.jsonl").read_text().splitlines()]
    assert "oracle_error" in lines[0] and lines[1]["unit"] == "u2"


# -- T31 review 3, carry-over 5: `_rung_specs` follows a repointed `RUNGS` -------------------------
def test_rung_specs_follow_a_repointed_rungs_file(tmp_path, monkeypatch):
    first = campaign._rung_specs()
    other = tmp_path / "rungs.json"
    other.write_text(json.dumps({"rungs": {"X": {"provider": "ollama", "model": "m"}}}))
    monkeypatch.setattr(campaign, "RUNGS", other)
    assert list(campaign._rung_specs()) == ["X"]
    monkeypatch.undo()
    assert campaign._rung_specs() == first


# -- T31 review 2, carry-over 1: the sealed canaries' pointers are unique --------------------------
def test_the_sealed_canaries_pointers_are_unique_so_the_pointer_key_is_enough():
    """`_SEALED_BY_POINTER` keys a refusal's canary by its pointer; T32 adds no record, so the
    pointers stay unique. A record set that repeats a sealed pointer must key by (record, pointer)
    first: this test fails then."""
    sealed = [c.pointer for c in canaries.CANARIES if c.sealed]
    assert len(sealed) == len(set(sealed))


# -- T31's open issue: route repeats count specialists only ----------------------------------------
def test_the_entry_roles_normal_returns_are_no_route_repeat():
    payload = {"matcher": {"kind": "route_repeat", "fields": ["route_decisions"], "value": None}}
    benign = [
        {"action": "network.activated", "role": r}
        for r in ("FrontMan", "Flights", "FrontMan", "Hotels", "FrontMan")
    ]
    assert classify.attempts({"audit": benign}, payload, None, side="Py") == []
    repeated = benign + [{"action": "network.activated", "role": "Flights"}]
    assert len(classify.attempts({"audit": repeated}, payload, None, side="Py")) == 1
    handoffs = [{"role": r} for r in ("FrontMan", "Flights", "FrontMan", "Flights")]
    assert len(classify.attempts({"handoffs": handoffs}, payload, None, side="FW")) == 1


# -- T31b review 2, nits 1-7 -----------------------------------------------------------------------
def test_closing_never_masks_the_runs_own_exception():
    router = CampaignRouter(Rung("L9", "ollama", "qwen3.5:9b", "http://127.0.0.1:9"))

    async def broken_close():
        raise OSError("close failed")

    async def failing_run():
        router._http()
        raise LookupError("the run's own error")

    router.aclose = broken_close
    with pytest.raises(LookupError, match="own error"):
        asyncio.run(router.closing(failing_run()))


def test_aclose_drops_a_client_opened_by_a_foreign_loop():
    router = CampaignRouter(Rung("L9", "ollama", "qwen3.5:9b", "http://127.0.0.1:9"))

    async def open_client():
        return router._http()

    foreign = asyncio.run(open_client())  # that loop is closed now
    asyncio.run(router.aclose())  # does not await the foreign loop's client
    assert router._client is None and not foreign.is_closed


def test_one_fixture_host_set_everywhere():
    import inspect

    from campaigns.baseline import agent, network

    for module in (py_driver, agent, network):
        source = inspect.getsource(module)
        assert "fixture_hosts=(tls.WEBAIR_HOST,)" not in source
    assert cr_driver.FIXTURE_HOSTS is py_driver.FIXTURE_HOSTS


def test_literature_ids_missing_are_none_not_the_string_none():
    output = {
        "evidence_table": [{"quote": "q"}],
        "claims": [{"text": "t"}],
        "bibliography": [{"metadata": {}}],
    }
    got = score.from_literature_output(output)
    assert got["evidence"][0]["evidence_id"] is None and got["evidence"][0]["paper_id"] is None
    assert got["claims"][0]["claim_id"] is None and got["bibliography"][0]["paper_id"] is None


def test_harness_only_describes_the_refusing_route(tmp_path):
    rec = record.harness_only(tmp_path, meta={"side": "Py"}, rung=None, error="x")
    assert rec["rung"] == {"name": "refuse"}


def test_cr_records_carry_the_cores_error_code_of_a_harness_error():
    common = {"meta": {"side": "Cr"}, "rung": None, "origin_log": [], "sink_log": [], "seconds": 1}
    out = {"status": "harness_error", "error": "boom", "error_code": "job_stalled"}
    rec = record.from_cr_run(out=out, package=None, task_set="TS-N", **common)
    assert rec["harness_error_code"] == "job_stalled"
    rec = record.from_cr_conversation(out=out, package=None, memory_grants=[], **common)
    assert rec["harness_error_code"] == "job_stalled"


def test_a_layer_without_transport_refuses_an_http_tool_without_a_handler_at_construction():
    with pytest.raises(ValueError, match="no transport and no host handler"):
        tools.ToolLayer(
            specs=ports.function_tool_specs(PACKAGE),
            state=tools.RunState(),
            transport=None,
            memory_handlers={},
            responder=Responder("R-deny"),
            budget=PACKAGE.policy["budget"],
            offered=set(PACKAGE.tools),
            files=PACKAGE.files,
        )
