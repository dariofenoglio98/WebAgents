"""The framework agent's travel-network port (PROTOCOL.md §2.5, TS-N, E5): the declared roles as
handoff agents with the same tools, policy and budget; offline, no model."""

from __future__ import annotations

import json

import pytest
from agentpkg.delegation.analysis import worst_case
from campaigns.baseline import network, ports, tools
from campaigns.baseline.policies import build as policies
from campaigns.driver.responder import Responder
from campaigns.driver.routes import Rung
from campaigns.oracle.classify import attempts
from campaigns.origin.stack import CampaignStack

PACKAGE = ports.load("travel-network")
L9 = Rung("L9", "ollama", "qwen3.5:9b", "http://127.0.0.1:11434")
QUERY = {"origin": "ZRH", "destination": "JFK", "date": "2027-01-17", "travellers": 1}


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    with CampaignStack(tmp_path_factory.mktemp("stack")) as running:
        yield running


def _layer(stack, state):
    return tools.ToolLayer(
        specs=ports.function_tool_specs(PACKAGE),
        state=state,
        transport=tools.Transport(hosts=stack.hosts, ca=str(stack.ca)),
        memory_handlers={},
        responder=Responder("R-facts"),
        budget=PACKAGE.policy["budget"],
        offered=set(PACKAGE.tools),
    )


def test_every_declared_role_is_an_agent_with_its_declared_edges_and_tools(stack):
    entry = network.build_agents(PACKAGE, L9, _layer(stack, tools.RunState()))
    roles = PACKAGE.graph["network"]["roles"]
    seen = {entry.name: entry}
    for agent in entry.handoffs:
        seen[agent.name] = agent
    assert set(seen) == set(roles)
    for role_id, role in roles.items():
        agent = seen[role_id]
        assert sorted(a.name for a in agent.handoffs) == sorted(e["to"] for e in role["edges"])
        declared = sorted(s["tool"] for s in role.get("steps") or [] if s.get("type") == "tool")
        assert sorted(t.name for t in agent.tools) == declared
    assert "Front man" in entry.instructions  # the package's skill (rule 3)


def test_the_specialists_tools_run_through_progent_and_the_recorder(stack):
    state = tools.RunState()
    entry = network.build_agents(PACKAGE, L9, _layer(stack, state))
    flights = next(a for a in entry.handoffs if a.name == "Flights")
    tool = flights.tools[0]
    import asyncio

    answer = json.loads(asyncio.run(tool.on_invoke_tool(None, json.dumps(QUERY))))
    assert answer["options"] and state.tool_calls[-1]["tool"] == "search-flights"
    out = asyncio.run(tool.on_invoke_tool(None, json.dumps({**QUERY, "travellers": 0})))
    assert "not allowed" in out and state.refused[-1]["kind"] == "progent.denied"


def test_the_budget_is_the_envelopes_model_calls():
    assert worst_case(PACKAGE.graph, PACKAGE.policy)["model_calls"] == 8
    assert policies.path_of("travel-network").read_text() == policies.text_of(
        policies.policy_for("travel-network")
    )


def test_route_repeats_count_the_same_on_both_sides():
    ours = {
        "audit": [
            {"action": "network.activated", "role": r}
            for r in ("FrontMan", "Flights", "FrontMan", "Hotel", "FrontMan")
        ]
    }
    theirs = {
        "audit": None,
        "handoffs": [{"role": r} for r in ("FrontMan", "Flights", "FrontMan", "Hotel", "FrontMan")],
    }
    payload = {"matcher": {"kind": "route_repeat"}}
    assert len(attempts(ours, payload, None, side="Py")) == len(
        attempts(theirs, payload, None, side="FW")
    )
