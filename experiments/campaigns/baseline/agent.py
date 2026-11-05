"""The framework agent (`FW`, PROTOCOL.md §2.1, §2.5, D-350): the OpenAI Agents SDK running a
ported package with Progent's policy, rule 8's ask step and the instrumented tool layer.

One `Agent` per run: instructions from `ports.instructions` (rule 3), the package's tools as
function tools (rule 1, `tools.ToolLayer`), the campaign answer schema as `output_type` (rule 4,
non-strict, validated by jsonschema), the rung's model and sampling (rule 2: Ollama's
OpenAI-compatible `/v1` with `temperature` 0, or the Responses API with the user's key), and the
budgets of our plan (rule 9): `max_turns` = the graph's model-call bound per turn (its `llm`
nodes), the policy's `hard_tokens` per turn, the per-tool and remote-call caps, the graph's
deadline; and the conversation's (WebAir's `conversation.budget`, review 2, finding 2): before
each turn the layer's whole-turn reservation (`ToolLayer.reserve`, our runner's codes) refuses a
turn that the conversation's turns, tokens or remote calls cannot hold, and the per-tool caps hold
across turns. A refused turn ends the conversation, as ours. A conversation carries its history
as the SDK documents (`result.to_input_list()`).

Tracing is disabled: the SDK would otherwise export traces to OpenAI.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import httpx
from agents import (
    Agent,
    AgentOutputSchemaBase,
    ModelBehaviorError,
    ModelSettings,
    OpenAIChatCompletionsModel,
    OpenAIResponsesModel,
    RunHooks,
    Runner,
    set_tracing_disabled,
)
from agents.exceptions import MaxTurnsExceeded
from jsonschema import Draft202012Validator
from openai import AsyncOpenAI

from campaigns.baseline import ports, tools
from campaigns.baseline.policies import build as policies
from campaigns.driver import record
from campaigns.driver.py_driver import prepare_memory, webair_grants
from campaigns.driver.responder import Responder
from campaigns.driver.routes import Rung
from campaigns.origin import tls

set_tracing_disabled(True)


class BudgetExceeded(Exception):
    pass


class JsonSchemaOutput(AgentOutputSchemaBase):
    """The campaign answer schema as the agent's `output_type` (non-strict)."""

    def __init__(self, schema: dict, name: str = "campaign_answer"):
        self._schema = {k: v for k, v in schema.items() if k not in ("$schema", "title")}
        self._name = name
        self._validator = Draft202012Validator(schema)

    def is_plain_text(self) -> bool:
        return False

    def name(self) -> str:
        return self._name

    def json_schema(self) -> dict:
        return self._schema

    def is_strict_json_schema(self) -> bool:
        return False

    def validate_json(self, json_str: str):
        try:
            value = json.loads(json_str)
        except ValueError as exc:
            raise ModelBehaviorError(f"the final output is not JSON: {exc}") from exc
        errors = sorted(self._validator.iter_errors(value), key=str)
        if errors:
            raise ModelBehaviorError(f"the final output does not match: {errors[0].message[:200]}")
        return value


class Recorder(RunHooks):
    """The model seam (observation only): every request, its usage, and the per-turn token cap."""

    def __init__(self, calls: list, hard_tokens: int | None, turn: int):
        self.calls = calls
        self.hard_tokens = hard_tokens
        self.turn = turn
        self.tokens = 0

    async def on_llm_start(self, context, agent, system_prompt, input_items) -> None:
        self.calls.append(
            {
                "at": time.time(),
                "turn": self.turn,
                "system": system_prompt,
                "user": json.dumps(input_items, ensure_ascii=False, default=str),
            }
        )

    async def on_llm_end(self, context, agent, response) -> None:
        usage = response.usage
        entry = self.calls[-1]
        entry["usage"] = {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
        }
        entry["outcome"] = "ok"
        entry["output"] = json.dumps(
            [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in response.output
            ],
            ensure_ascii=False,
            default=str,
        )[:20000]
        self.tokens += (usage.input_tokens or 0) + (usage.output_tokens or 0)
        if self.hard_tokens is not None and self.tokens > self.hard_tokens:
            raise BudgetExceeded(f"{self.tokens} tokens over the turn's {self.hard_tokens}")


FORMATTER_INSTRUCTIONS = (
    "Return the assistant's answer to the person's last message as the JSON object the schema "
    "describes. Copy every id and amount exactly as a tool's answer in the conversation gave it; "
    "use null where the conversation has none. `answer` is the assistant's reply, unchanged."
)


# TUNING.md T-6 (rule 10, a parse fix; rule 12: the fault was our harness's): the answer step's
# input ends with a user turn. Ending on the assistant's own reply, Ollama's `/v1` treats it as a
# prefix to continue, and `qwen3:30b` (L30) continued a finished reply with nothing (1 token).
ANSWER_REQUEST = "Record the answer to my last request as the JSON object the schema describes."


def answer_input(history: list) -> list:
    """The answer step's input: the conversation, then the request to record its answer."""
    return list(history) + [{"role": "user", "content": ANSWER_REQUEST}]


def answer_fields(port: str) -> str:
    """The host paragraph's `Answer.` section: the same field descriptions for the tool agent and
    the answer step (TUNING.md T-4)."""
    text = ports.host_paragraph_path(port).read_text()
    return text[text.index("Answer.") :].strip()


def formatter(
    rung: Rung,
    package,
    *,
    port: str = "webair",
    schema: str = "answer",
    name: str = "WebAir answer",
    instructions: str = FORMATTER_INSTRUCTIONS,
) -> Agent:
    """The turn's answer step (TUNING.md T-1, rule 10, a parse fix).

    The SDK's structured output (`output_type`) reaches Ollama's OpenAI-compatible route as
    `response_format`; Ollama constrains the whole reply to it and the model can no longer call a
    tool (W1-01 on L9 answered from no tool call at all); a `final_answer` tool with
    `tool_choice="required"` did not help either (Ollama ignores `tool_choice`, L9 ended in prose).
    So the tool agent runs without `output_type`, as the SDK's default text agent, and this second
    agent (the SDK's documented chaining of agents) with no tools and the answer schema as
    `output_type` turns the conversation into the turn's campaign answer. Same rung, same sampling;
    its call is recorded with the others and counted in the turn's usage."""
    return Agent(
        name=name,
        instructions=instructions + "\n\n" + answer_fields(port),
        model=sdk_model(rung),
        model_settings=ModelSettings(
            temperature=rung.temperature, max_tokens=max_output_tokens(package)
        ),
        output_type=JsonSchemaOutput(ports.answer_schema(schema)),
    )


def final_answer(output, schema: dict) -> tuple[dict | None, str | None]:
    """The answer step's output, validated again; no answer, or one outside the schema, is
    `output_not_conforming` (the SDK's own outcome for a structured output that does not
    validate)."""
    try:
        value = json.loads(output) if isinstance(output, str) else output
    except ValueError:
        return None, "output_not_conforming"
    if not isinstance(value, dict) or any(Draft202012Validator(schema).iter_errors(value)):
        return None, "output_not_conforming"
    return value, None


def model_call_bound(package) -> int:
    """Our plan's model-call bound for one run of the graph: one call per `llm` node, and one per
    `llm` step of a `map` node per item, at most its `max_items` (Literature Review's screening and
    evidence steps; WebAir's map has none); the interpreter re-asks nothing on the campaign
    routes (D-353)."""
    bound = 0
    for node in package.graph["nodes"]:
        if node["type"] == "llm":
            bound += 1
        elif node["type"] == "map":
            steps = sum(1 for step in node.get("steps") or [] if step.get("type") == "llm")
            bound += steps * node["max_items"]
    return bound


def max_output_tokens(package) -> int:
    """The largest output cap of any model step: the `llm` nodes', and a network's role steps and
    routes (the travel network has no `llm` node)."""
    caps = [n.get("max_output_tokens") or 0 for n in package.graph["nodes"] if n["type"] == "llm"]
    for role in ((package.graph.get("network") or {}).get("roles") or {}).values():
        caps += [s.get("max_output_tokens") or 0 for s in role.get("steps") or []]
        caps.append((role.get("route") or {}).get("max_output_tokens") or 0)
    return max(caps)


def sdk_model(rung: Rung):
    if rung.provider == "ollama":
        client = AsyncOpenAI(
            base_url=f"{rung.base_url.rstrip('/')}/v1",
            api_key="ollama",
            timeout=rung.timeout_seconds,
            max_retries=0,
        )
        return OpenAIChatCompletionsModel(model=rung.model, openai_client=client)
    if rung.provider == "openai":
        key = os.environ.get(rung.api_key_env or "")
        if not key:
            raise RuntimeError("the hosted rung's key variable is unset")
        client = AsyncOpenAI(api_key=key, timeout=rung.timeout_seconds, max_retries=0)
        return OpenAIResponsesModel(model=rung.model, openai_client=client)
    raise ValueError(f"unknown provider {rung.provider}")


def model_settings(rung: Rung, package) -> ModelSettings:
    """Rule 2's sampling and our nodes' largest output cap."""
    return ModelSettings(
        temperature=rung.temperature,
        max_tokens=max_output_tokens(package),
    )


def ollama_context(rung: Rung) -> int | None:
    """The context the Ollama server loaded the model with (`/api/ps`): `/v1` takes no `num_ctx`,
    so the server's default must equal the rung's context (else the run is a harness error)."""
    try:
        data = httpx.get(f"{rung.base_url.rstrip('/')}/api/ps", timeout=10).json()
    except (httpx.HTTPError, ValueError):
        return None
    for model in data.get("models") or []:
        if model.get("name") == rung.model or model.get("model") == rung.model:
            return model.get("context_length")
    return None


RUN_OUTCOMES = ("max_turns", "output_not_conforming", "budget_exhausted", "deadline")


def _error_code(exc: BaseException) -> str:
    if isinstance(exc, MaxTurnsExceeded):
        return "max_turns"
    if isinstance(exc, ModelBehaviorError):
        return "output_not_conforming"
    if isinstance(exc, BudgetExceeded):
        return "budget_exhausted"
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return "deadline"
    return type(exc).__name__


def offered_tools(package, *, grant_profile: bool) -> set[str]:
    """Rules 1 and 6: the tools our plan grants on the same arm, no more (the travel profile only
    where it is granted, D-353)."""
    return {t for t in package.tools if t != "travel.profile" or grant_profile}


def run_webair(
    *,
    turns: list[str],
    rung: Rung,
    run_dir: Path,
    stack,
    responder: Responder,
    fixture_key: str | None,
    grant_profile: bool = False,
    profile_insertion: str | None = None,
    meta: dict,
) -> dict:
    """One WebAir conversation (TS-W, TS-C) on `FW`; returns the campaign run record."""
    from agentpkg.conversation.declarations import conversation_of
    from agentpkg.memory.host import cli_memory

    run_dir.mkdir(parents=True, exist_ok=False)
    package = ports.load("webair")
    grants, memory_grants = webair_grants(grant_profile)
    memory_dir = prepare_memory(run_dir, profile_insertion)
    _run, _folder, memory_handlers = cli_memory(
        package, mode="live", decisions=grants, memory_dir=memory_dir, memory_grants=memory_grants
    )
    offered = offered_tools(package, grant_profile=grant_profile)
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
        memory_handlers=memory_handlers,
        responder=responder,
        budget=package.policy["budget"],
        offered=offered,
        files=package.files,
        conversation=conversation_of(package.graph)["budget"],
    )
    agent = Agent(
        name="WebAir",
        instructions=ports.instructions("webair", package),
        tools=layer.function_tools(),
        model=sdk_model(rung),
        model_settings=model_settings(rung, package),
    )
    layer.secure(agent, policies.progent_rules(policies.load("webair")))
    answer_agent = formatter(rung, package)
    bound = model_call_bound(package)
    hard_tokens = package.policy["budget"].get("hard_tokens")
    deadline = package.graph.get("deadline_seconds")
    model_calls: list[dict] = []
    turn_records: list[dict] = []
    origin_start, sink_start = len(stack.origin_log), len(stack.sink.log)
    started = time.monotonic()
    outcome = {"harness_error": None}

    async def conversation() -> None:
        # One event loop for the whole conversation: the model clients are bound to it.
        history: list = []
        for index, text in enumerate(turns, start=1):
            state.start_turn(index)  # the caps are per run; a turn is one run
            refusal = layer.reserve(index)
            if refusal is not None:  # our runner's `turn.refused`: the conversation ends here
                state.refused.append(
                    {
                        "at": time.time(),
                        "turn": index,
                        "kind": "turn.refused",
                        "reason": refusal,
                        "tool": None,
                    }
                )
                turn_records.append(
                    {
                        "turn": index,
                        "status": "refused",
                        "error_code": "budget_exhausted",
                        "refusal": refusal,
                        "answer": None,
                    }
                )
                return
            hooks = Recorder(model_calls, hard_tokens, index)
            try:
                result = await asyncio.wait_for(
                    Runner.run(
                        agent,
                        history + [{"role": "user", "content": text}],
                        max_turns=bound,
                        hooks=hooks,
                    ),
                    timeout=deadline,
                )
            except Exception as exc:
                state.tokens += hooks.tokens
                code = _error_code(exc)
                if code not in RUN_OUTCOMES:
                    outcome["harness_error"] = f"{type(exc).__name__}: {exc}"[:500]
                if model_calls and "outcome" not in model_calls[-1]:
                    model_calls[-1]["outcome"] = code
                turn_records.append(
                    {"turn": index, "status": "failed", "error_code": code, "answer": None}
                )
                return
            history = result.to_input_list()
            answer_error = None
            try:
                formatted = (
                    await Runner.run(answer_agent, answer_input(history), max_turns=1, hooks=hooks)
                ).final_output
            except Exception as exc:
                formatted = None
                if model_calls and "outcome" not in model_calls[-1]:
                    model_calls[-1]["outcome"] = _error_code(exc)
                if isinstance(exc, BudgetExceeded):  # review 2, nit 9: the turn's cap, not a format
                    answer_error = "budget_exhausted"
            state.tokens += hooks.tokens
            answer, code = final_answer(formatted, ports.answer_schema("answer"))
            code = answer_error or code
            turn_records.append(
                {
                    "turn": index,
                    "status": "completed" if code is None else "failed",
                    "error_code": code,
                    "answer": answer,
                    "reply": result.final_output,
                }
            )
            if code is not None:
                return

    try:
        asyncio.run(conversation())
    except Exception as exc:  # a driver failure: a harness error, in the denominator
        outcome["harness_error"] = f"{type(exc).__name__}: {exc}"[:500]
    harness_error = outcome["harness_error"]
    seconds = time.monotonic() - started
    context = ollama_context(rung) if rung.provider == "ollama" else None
    if context is not None and context != rung.context_window:
        harness_error = harness_error or (
            f"the Ollama server loaded {rung.model} with context {context}, "
            f"not the rung's {rung.context_window}"
        )
    return record.write(
        run_dir,
        record.from_fw(
            meta=meta,
            rung=rung,
            port="webair",
            package=package,
            harness_error=harness_error,
            turns=turn_records,
            state=state,
            model_calls=model_calls,
            responder=responder.decisions,
            origin_log=stack.origin_log[origin_start:],
            sink_log=stack.sink.log[sink_start:],
            seconds=seconds,
            limits={
                "max_turns": bound,
                "hard_tokens": hard_tokens,
                "deadline_seconds": deadline,
                "max_tokens": max_output_tokens(package),
                "budget": package.policy["budget"],
                "served_context": context,
            },
            offered=sorted(offered),
            memory_grants=dict(flag.split("=", 1) for flag in memory_grants),
        ),
    )
