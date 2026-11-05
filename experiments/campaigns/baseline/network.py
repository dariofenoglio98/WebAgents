"""The framework agent's port of the travel network (PROTOCOL.md §2.5, E2's TS-N, E5): the Agents
SDK's handoffs between one agent per declared role, with the same tools, policy, budget and answer
step as the WebAir port (`agent.py`, D-350).

- **Roles.** One `Agent` per role of the signed network declaration: the entry role (`FrontMan`)
  with the package's skills and the host paragraph (rule 3), no tools; each specialist with the
  tools its declared steps call, its declared description and the host paragraph. The handoffs
  are the declared edges, both ways as declared (specialists hand back to `FrontMan`).
- **Budget** (rule 9): `max_turns` = the envelope's `model_calls` (`agentpkg.delegation.analysis.
  worst_case`), the policy's caps per tool and remote calls, `hard_tokens`, the deadline. The SDK
  runs every role as a model; our side's specialists are tool steps without a model call, so the
  same bound is tighter for `FW` by construction (E5 also runs `FW` at the SDK's default 10).
- **Answer** (rule 4): the answer step of T-1 with the TS-N schema (`{"plan"}`).
- **Records**: the tool layer's calls and refusals, every model call and every handoff
  (`handoffs`, the route the oracle's route-repeat matcher reads on this side).
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from agentpkg.delegation.analysis import worst_case
from agents import Agent, Runner

from campaigns.baseline import ports, tools
from campaigns.baseline.agent import (
    RUN_OUTCOMES,
    JsonSchemaOutput,
    Recorder,
    _error_code,
    final_answer,
    model_settings,
    ollama_context,
    sdk_model,
)
from campaigns.baseline.policies import build as policies
from campaigns.driver import record
from campaigns.driver.responder import Responder
from campaigns.driver.routes import Rung
from campaigns.origin import tls

PORT = "travel-network"


class NetworkRecorder(Recorder):
    def __init__(self, calls: list, hard_tokens, turn: int, handoffs: list):
        super().__init__(calls, hard_tokens, turn)
        self.handoffs = handoffs

    async def on_handoff(self, context, from_agent, to_agent) -> None:
        self.handoffs.append({"at": time.time(), "from": from_agent.name, "role": to_agent.name})


def build_agents(package, rung: Rung, layer: tools.ToolLayer) -> Agent:
    network = package.graph["network"]
    roles = network["roles"]
    host = ports.host_paragraph_path(PORT).read_text().strip()
    function_tools = {tool.name: tool for tool in layer.function_tools()}
    rules = policies.progent_rules(policies.load(PORT))
    agents = {}
    for role_id, role in roles.items():
        tool_ids = [s["tool"] for s in role.get("steps") or [] if s.get("type") == "tool"]
        if role_id == network["entry"]:
            instructions = ports.instructions(PORT, package)
        else:
            instructions = f"You are {role_id}. {role['description']}\n\n{host}\n"
        agents[role_id] = Agent(
            name=role_id,
            handoff_description=role["description"],
            instructions=instructions,
            tools=[function_tools[ports.tool_name(t)] for t in tool_ids],
            model=sdk_model(rung),
            model_settings=model_settings(rung, package),
        )
    for role_id, role in roles.items():
        agents[role_id].handoffs = [agents[edge["to"]] for edge in role.get("edges") or []]
    for agent in agents.values():
        if agent.tools:
            layer.secure(agent, rules)
    return agents[network["entry"]]


def run_travel_network(
    *,
    text: str,
    rung: Rung,
    run_dir: Path,
    stack,
    fixture_key: str | None,
    meta: dict,
    responder: Responder | None = None,
    max_turns: int | None = None,
) -> dict:
    """One travel-network run (TS-N) on `FW`; returns the campaign run record."""
    run_dir.mkdir(parents=True, exist_ok=False)
    package = ports.load(PORT)
    envelope = worst_case(package.graph, package.policy)
    state = tools.RunState()
    layer = tools.ToolLayer(
        specs=ports.function_tool_specs(package),
        state=state,
        transport=tools.Transport(
            hosts=stack.hosts,
            ca=str(stack.ca),
            fixture_key=fixture_key,
            fixture_hosts=(tls.WEBAIR_HOST,),
        ),
        memory_handlers={},
        responder=responder or Responder("R-facts"),
        budget=package.policy["budget"],
        offered=set(package.tools),
        files=package.files,
    )
    entry = build_agents(package, rung, layer)
    answer_agent = Agent(
        name="Travel plan",
        instructions=(
            "Return the travel service's final plan for the traveller as the JSON object the "
            "schema describes: `plan` is FrontMan's last message, unchanged."
        ),
        model=sdk_model(rung),
        model_settings=model_settings(rung, package),
        output_type=JsonSchemaOutput(ports.answer_schema("network-answer")),
    )
    bound = max_turns if max_turns is not None else envelope["model_calls"]
    hard_tokens = package.policy["budget"].get("hard_tokens")
    deadline = package.graph.get("deadline_seconds")
    model_calls: list[dict] = []
    handoffs: list[dict] = []
    turns: list[dict] = []
    outcome = {"harness_error": None}
    origin_start, sink_start = len(stack.origin_log), len(stack.sink.log)
    started = time.monotonic()

    async def run() -> None:
        # The entry's first activation, as our side's audit records it (`network.activated`).
        handoffs.append({"at": time.time(), "from": None, "role": entry.name})
        hooks = NetworkRecorder(model_calls, hard_tokens, 1, handoffs)
        try:
            result = await asyncio.wait_for(
                Runner.run(entry, text, max_turns=bound, hooks=hooks), timeout=deadline
            )
        except Exception as exc:
            code = _error_code(exc)
            if code not in RUN_OUTCOMES:
                outcome["harness_error"] = f"{type(exc).__name__}: {exc}"[:500]
            if model_calls and "outcome" not in model_calls[-1]:
                model_calls[-1]["outcome"] = code
            turns.append({"turn": 1, "status": "failed", "error_code": code, "answer": None})
            return
        try:
            formatted = (
                await Runner.run(answer_agent, result.to_input_list(), max_turns=1, hooks=hooks)
            ).final_output
        except Exception as exc:
            formatted = None
            if model_calls and "outcome" not in model_calls[-1]:
                model_calls[-1]["outcome"] = _error_code(exc)
        answer, code = final_answer(formatted, ports.answer_schema("network-answer"))
        turns.append(
            {
                "turn": 1,
                "status": "completed" if code is None else "failed",
                "error_code": code,
                "answer": answer,
                "reply": result.final_output,
            }
        )

    try:
        asyncio.run(run())
    except Exception as exc:
        outcome["harness_error"] = f"{type(exc).__name__}: {exc}"[:500]
    seconds = time.monotonic() - started
    context = ollama_context(rung) if rung.provider == "ollama" else None
    harness_error = outcome["harness_error"]
    if context is not None and context != rung.context_window:
        harness_error = harness_error or f"served context {context} != {rung.context_window}"
    rec = record.from_fw(
        meta=meta,
        rung=rung,
        port=PORT,
        package=package,
        harness_error=harness_error,
        turns=turns,
        state=state,
        model_calls=model_calls,
        responder=[],
        origin_log=stack.origin_log[origin_start:],
        sink_log=stack.sink.log[sink_start:],
        seconds=seconds,
        limits={
            "max_turns": bound,
            "envelope": {k: envelope[k] for k in ("model_calls", "remote_calls", "tokens")},
            "hard_tokens": hard_tokens,
            "deadline_seconds": deadline,
            "budget": package.policy["budget"],
            "served_context": context,
        },
        offered=sorted(package.tools),
        memory_grants={},
    )
    rec["handoffs"] = handoffs
    return record.write(run_dir, rec)
