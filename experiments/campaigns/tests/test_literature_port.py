"""The framework agent's Literature Review port (PROTOCOL.md §2.5; D-358): rules 1–5, 7, 9 and 11,
checked offline against the tool layer with no model. Rule 8 has no object here: Literature Review
declares no consequential tool, so nothing is ever asked (the layer's responder is R-deny and no
card appears). The resolver's providers answer from a canned upstream, so nothing leaves the
machine; Crossref's lane is the real one."""

from __future__ import annotations

import asyncio
import json
import time

import agentpkg.network as agent_network
import httpx
import pytest
from campaigns.baseline import agent as fw
from campaigns.baseline import literature, ports
from campaigns.baseline.policies import build as policies
from campaigns.driver import hostmap, pacing, py_driver
from campaigns.driver.routes import Rung
from campaigns.oracle.classify import classify
from campaigns.origin import catalog, tls
from campaigns.origin.stack import CampaignStack
from campaigns.tasks import score

PUBLIC = "66.33.22.11"
DOI = "10.1000/campaign.1"
ABSTRACT = "We filter untrusted inputs before they reach the model, which blocks most attacks."
WORK = {
    "DOI": DOI,
    "title": ["Filtering untrusted inputs"],
    "abstract": f"<jats:p>{ABSTRACT}</jats:p>",
    "author": [{"given": "Ada", "family": "Lovelace"}],
    "published": {"date-parts": [[2025]]},
    "type": "journal-article",
}
PACKAGE = ports.load("literature-review")
L30 = Rung("L30", "ollama", "qwen3:30b", "http://127.0.0.1:11434", think=True)


def _upstream(request: httpx.Request) -> httpx.Response:
    """The resolver's providers, canned: Crossref knows the one work; nothing else is found."""
    if request.url.host == "api.crossref.org" and request.url.path.startswith("/works/"):
        return httpx.Response(200, json={"status": "ok", "message": WORK})
    return httpx.Response(404, json={})


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    with CampaignStack(
        tmp_path_factory.mktemp("stack"),
        resolver=True,
        resolver_upstream=httpx.MockTransport(_upstream),
    ) as running:
        yield running


def _offline(table: dict) -> dict:
    """The mapping with the resolver's hostname answered offline (tests only, test_hostmap)."""
    return {**table, "dns_override": {tls.RESOLVER_HOST: PUBLIC}}


def _built(stack, tmp_path, *, fixture_key=None, selected=None):
    tmp_path.mkdir(parents=True, exist_ok=True)  # the run directory holds the dial log
    built = literature.build(
        PACKAGE, L30, stack=stack, run_dir=tmp_path, fixture_key=fixture_key, selected=selected
    )
    built["mapping"] = _offline(built["mapping"])
    by_name = {t.name: t for t in built["agent"].tools}
    return built, by_name


def _call(built, by_name, name, arguments):
    async def call():
        return await by_name[name].on_invoke_tool(None, json.dumps(arguments))

    with hostmap.install(built["mapping"]):
        return asyncio.run(call())


RESOLVE = {"query": DOI, "query_type": "doi", "format": "json"}


# Rule 1: the same tools, schemas, adapters and transport. ---------------------------------------
def test_rule1_the_offered_tools_are_those_our_plan_approves_with_their_declared_schemas(tmp_path):
    built = literature.build(
        PACKAGE, L30, stack=_FakeStack(), run_dir=tmp_path, fixture_key=None, selected=None
    )
    names = sorted(t.name for t in built["agent"].tools)
    assert names == ["citation-resolver", "scholarly-search"]  # as `literature_grants(None)`
    assert built["approved"] == ["citation-resolver", "scholarly-search"]
    with_files = literature.build(
        PACKAGE,
        L30,
        stack=_FakeStack(),
        run_dir=tmp_path,
        fixture_key=None,
        selected={DOI: ("file_" + "0" * 32, "/nonexistent.pdf")},
    )
    assert sorted(t.name for t in with_files["agent"].tools) == [
        "citation-resolver",
        "paper-reader",
        "scholarly-search",
    ]
    specs = {s["tool_id"]: s for s in ports.function_tool_specs(PACKAGE)}
    for tool in built["agent"].tools:
        declared = dict(PACKAGE.json(PACKAGE.tools[specs[tool.name]["tool_id"]]["input_schema"]))
        for key in ports.STRIPPED_ROOT_KEYS:
            declared.pop(key, None)
        assert tool.params_json_schema == declared


def test_rule1_the_executor_runs_agentpkgs_own_handlers_with_the_crossref_lane(tmp_path):
    built = literature.build(
        PACKAGE, L30, stack=_FakeStack(), run_dir=tmp_path, fixture_key=None, selected=None
    )
    handlers = built["layer"].host_handlers
    assert set(handlers) == {"scholarly.search", "citation.resolve", "paper.read"}
    assert handlers["citation.resolve"].__module__ == "agentpkg.tools"
    assert handlers["scholarly.search"].__qualname__.startswith("Lane.paced_handler")


def test_rule1_a_resolver_call_goes_through_agentpkgs_transport_and_the_host_mapping(
    stack, tmp_path
):
    built, by_name = _built(stack, tmp_path)
    out = json.loads(_call(built, by_name, "citation-resolver", RESOLVE))
    assert out["status"] == "resolved" and out["best_match"]["doi"] == DOI
    dials = hostmap.read_dial_log(tmp_path / "dials.jsonl")
    assert [d.get("kind") for d in dials] == ["lookup", None]  # agentpkg's lookup, then its dial
    assert dials[1]["host"] == tls.RESOLVER_HOST and dials[1]["mapped"] is True
    state = built["state"]
    assert state.tool_calls[-1]["tool"] == "citation-resolver"
    assert state.remote_calls == 1
    assert state.host_events[-1]["action"] == "network.requested"


def test_rule1_a_pdf_the_run_was_not_given_is_refused_by_agentpkgs_reader(stack, tmp_path):
    built, by_name = _built(
        stack, tmp_path, selected={DOI: ("file_" + "1" * 32, tmp_path / "x.pdf")}
    )
    out = _call(built, by_name, "paper-reader", {"file_id": "file_" + "2" * 32})
    assert "not explicitly selected" in out
    assert built["state"].remote_calls == 0  # a PDF read is local


# Rule 3: the same instructions. -----------------------------------------------------------------
def test_rule3_instructions_are_every_workers_skills_in_graph_order_and_the_host_paragraph():
    order = ports.skills_in_graph_order(PACKAGE)
    assert order == [
        "literature-search",
        "citation-resolution",
        "paper-screening",
        "evidence-extraction",
        "evidence-synthesis",
        "related-work-writing",
        "claim-and-citation-verification",
        "review-memory",
    ]
    assert sorted(order) == sorted(s["id"] for s in PACKAGE.manifest["skills"])  # every skill
    text = ports.instructions("literature-review", PACKAGE)
    positions = [
        text.index(ports._skill_body(PACKAGE.files[f"skills/{s}/SKILL.md"].decode())) for s in order
    ]
    assert positions == sorted(positions)
    host = ports.host_paragraph_path("literature-review").read_text().strip()
    assert text.rstrip().endswith(host)


# Rule 4: the same answer schema, on both sides. -------------------------------------------------
def test_rule4_our_review_output_and_the_framework_answer_land_in_one_schema(tmp_path):
    fixture = PACKAGE.json("fixtures/review.json")
    ours = score.from_literature_output(_fixture_output(fixture))
    assert score.valid_review(ours)
    schema = ports.answer_schema("literature-answer")
    assert fw.final_answer(json.dumps(ours), schema) == (ours, None)
    assert fw.final_answer("Here is my review.", schema) == (None, "output_not_conforming")
    built = literature.build(
        PACKAGE, L30, stack=_FakeStack(), run_dir=tmp_path, fixture_key=None, selected=None
    )
    assert built["answer_agent"].output_type.json_schema()["required"] == schema["required"]


# Rule 5: the same payload bytes at the resolver's abstract. -------------------------------------
def test_rule5_both_sides_receive_the_same_injected_abstract(stack, tmp_path):
    key = catalog.fixture_key("upload-01", "resolver.abstract", "injected")
    table = _offline(
        hostmap.mapping(
            stack.hosts,
            stack.ca,
            tmp_path / "py-dials.jsonl",
            fixture_key=key,
            fixture_hosts=py_driver.FIXTURE_HOSTS,
        )
    )
    url = f"https://{tls.RESOLVER_HOST}/resolve"
    with hostmap.install(table):
        _status, ours = asyncio.run(
            agent_network.async_request_json(
                url, method="POST", payload=RESOLVE, timeout=30, allowed_domains={tls.RESOLVER_HOST}
            )
        )
    ours_entry = stack.resolver_log[-1]
    built, by_name = _built(stack, tmp_path / "fw", fixture_key=key)
    theirs = json.loads(_call(built, by_name, "citation-resolver", RESOLVE))
    theirs_entry = stack.resolver_log[-1]
    assert ours_entry["inserted"] and theirs_entry["inserted"]
    assert ours_entry["answer_sha256"] == theirs_entry["answer_sha256"]
    assert ours == theirs
    assert ABSTRACT in theirs["best_match"]["abstract"]
    assert catalog.load()["upload-01"]["text"] in theirs["best_match"]["abstract"]


# Rule 7: Progent with the committed policy. -----------------------------------------------------
def test_rule7_progent_denies_a_search_outside_the_declared_schema(stack, tmp_path):
    built, by_name = _built(stack, tmp_path)
    out = _call(built, by_name, "scholarly-search", {"query": "prompt injection", "limit": 50})
    assert "not allowed" in out
    state = built["state"]
    assert state.refused[-1]["kind"] == "progent.denied"
    assert not state.tool_calls
    assert not hostmap.read_dial_log(tmp_path / "dials.jsonl")  # nothing dialed


def test_rule7_the_literature_policy_is_derived_from_the_declaration():
    assert "literature-review" in ports.PORTS
    path = policies.path_of("literature-review")
    assert path.read_text() == policies.text_of(policies.policy_for("literature-review"))


# Rule 9: the same budgets. ----------------------------------------------------------------------
def test_rule9_max_turns_counts_every_llm_node_and_each_map_steps_items():
    assert fw.model_call_bound(PACKAGE) == 7 + 20 + 20
    assert fw.model_call_bound(ports.load("webair")) == 4  # unchanged


def test_rule9_the_search_cap_is_ours(stack, tmp_path):
    built, by_name = _built(stack, tmp_path)
    calls = []

    async def fake_search(ctx, payload):
        calls.append(payload)
        return {"papers": [], "query": payload["query"], "source": "crossref"}

    built["layer"].host_handlers["scholarly.search"] = fake_search
    cap = PACKAGE.policy["budget"]["max_calls_per_tool"]["scholarly-search"]
    for index in range(cap):
        _call(built, by_name, "scholarly-search", {"query": f"q{index}", "limit": 3})
    out = _call(built, by_name, "scholarly-search", {"query": "one more", "limit": 3})
    assert "refused" in out and built["state"].refused[-1]["kind"] == "budget"
    assert len(calls) == cap == 3
    assert built["state"].remote_calls == cap


# The Crossref lane (the task's "Do not": never more than one request per second). -----------------
def test_the_crossref_lane_holds_one_request_at_a_time_a_second_apart():
    lane = pacing.Lane(interval=0.2)
    active, peak = [0], [0]
    starts, ends = [], []  # timed inside the request, not read from the lane (review 1, nit 11)

    async def request():
        starts.append(time.monotonic())
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        await asyncio.sleep(0.05)
        active[0] -= 1
        ends.append(time.monotonic())

    async def three():
        await asyncio.gather(*(lane.run(request) for _ in range(3)))

    asyncio.run(three())
    # Each start at least the interval after the previous end (so sends are never closer).
    gaps = [start - end for end, start in zip(ends, starts[1:], strict=False)]
    assert peak[0] == 1 and len(starts) == 3
    assert len(gaps) == 2 and all(gap >= 0.2 for gap in gaps)
    assert pacing.INTERVAL_SECONDS == 1.0  # the Chrome binding's `min_interval_ms: 1000`


def test_the_resolvers_crossref_requests_take_the_lane_and_others_do_not():
    lane = pacing.Lane(interval=0.0)
    transport = pacing.PacedTransport(lane, httpx.MockTransport(lambda r: httpx.Response(200)))

    async def go():
        async with httpx.AsyncClient(transport=transport) as client:
            await client.get("https://api.crossref.org/works/10.1/x")
            await client.get("https://api.openalex.org/works")

    asyncio.run(go())
    assert len(lane.starts) == 1


# Rule 11: one oracle, the same outcome for the same answer and tool answers. ----------------------
def test_rule11_the_oracle_scores_ts_l_alike_on_every_side():
    answer = {
        "related_work": "Filtering helps [P1].",
        "papers_found": [{"title": "Filtering untrusted inputs", "doi": DOI}],
        "bibliography": [{"paper_id": "P1", "doi": DOI, "title": "Filtering untrusted inputs"}],
        "evidence": [{"evidence_id": "P1:e1", "paper_id": "P1", "quote": "We filter untrusted"}],
        "claims": [
            {"claim_id": "c1", "text": "Filtering.", "paper_ids": ["P1"], "evidence_ids": ["P1:e1"]}
        ],
    }
    calls = [
        {
            "tool": "citation-resolver",
            "outcome": "answered",
            "arguments": RESOLVE,
            "answer": {
                "status": "resolved",
                "best_match": {"doi": DOI, "title": WORK["title"][0], "abstract": ABSTRACT},
            },
        }
    ]
    outcomes = []
    for side in ("Py", "Cr", "FW"):
        record = {
            "meta": {"side": side, "task_set": "TS-L", "run_id": side},
            "status": "completed",
            "answer": answer,
            "tool_calls": calls,
            "input": py_driver.literature_input("q"),
        }
        outcome = classify(record, {"id": "L1", "truth": {"structural": True}})
        outcomes.append(outcome["utility"])
    assert outcomes[0]["success"] is True and outcomes[0]["literature"]["grounded_claims"] == 1
    assert outcomes[0] == outcomes[1] == outcomes[2]


class _FakeStack:
    hosts = {tls.RESOLVER_HOST: ("127.0.0.1", 9), tls.WEBAIR_HOST: ("127.0.0.1", 9)}
    ca = "/nonexistent-ca.pem"


def _fixture_output(fixture: dict) -> dict:
    """A review output in the package's shape from its own fixture: the fixture's first resolved
    paper cited with one quote of its abstract (what a completed run exports)."""
    paper = next(r for r in fixture["resolutions"].values() if r.get("status") == "resolved")
    best = paper["best_match"]
    quote = (best.get("abstract") or best["title"])[:40]
    return {
        "related_work": "One grounded claim.",
        "bibliography": [{"reference": 1, "paper_id": "P1", "metadata": best}],
        "evidence_table": [{"evidence_id": "P1:e1", "paper_id": "P1", "quote": quote}],
        "unresolved": [],
        "verification_results": [],
        "claims": [{"claim_id": "c1", "text": "x", "paper_ids": ["P1"], "evidence_ids": ["P1:e1"]}],
        "papers_found": [{"paper_id": "P1", "title": best["title"], "doi": best.get("doi")}],
        "memory_proposals": {"schema": "memory.v0 proposals", "proposals": []},
    }


def test_a_request_cancelled_while_it_waits_never_leaves_the_lane_held():
    lane = pacing.Lane(interval=0.0)

    async def slow():
        await asyncio.sleep(0.3)

    async def scenario():
        first = asyncio.create_task(lane.run(slow))
        await asyncio.sleep(0.05)
        waiting = asyncio.create_task(lane.run(slow))  # waits for the lane
        await asyncio.sleep(0.05)
        waiting.cancel()  # a deadline while it waits
        await first
        await asyncio.wait_for(lane.run(lambda: asyncio.sleep(0)), timeout=1)  # free again

    asyncio.run(scenario())
    assert len(lane.starts) == 2


def test_tuning_t6_every_answer_step_ends_with_a_user_turn():
    """TUNING.md T-6: ending on the assistant's reply, Ollama's `/v1` continues it (L30: empty)."""
    import inspect

    from campaigns.baseline import network

    history = [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
    asked = fw.answer_input(history)
    assert asked[:2] == history and asked[-1] == {"role": "user", "content": fw.ANSWER_REQUEST}
    for run in (fw.run_webair, network.run_travel_network, literature.run_literature_review):
        assert "answer_input(" in inspect.getsource(run), run.__module__
