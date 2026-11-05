"""The framework agent's port of Literature Review 0.2.9 (PROTOCOL.md §2.5, E2's and E3's TS-L,
D-358): one Agents SDK agent with the package's tools, policy, budgets and the TS-L answer step.

- **Tools** (rule 1): the tools our plan grants on the same run, as function tools with their
  declared schemas (`scholarly-search`, `citation-resolver`, and `paper-reader` only when the run
  is given selected files); the profile and notes tools are not granted on our side
  (`use_profile`, `keep_notes` false), so not offered. Each call runs **agentpkg's own handler**
  (`py_driver.literature_handlers`: `create_handlers` as `agentpkg run` binds it, the search in
  the process's Crossref lane) under the same host mapping as `Py` (`driver/hostmap.py`): the same
  adapters, the same URL and address policy before any dial, the resolver dialed at the campaign
  stack, Crossref live, the same dial log (T31 review 2, carry-over 3: no Literature Review tool
  takes a URL; `paper-reader` takes an opaque file id the host maps).
- **Instructions** (rule 3): the skills of the graph's workers in node order and
  `HOST-literature-review.md`.
- **Budgets** (rule 9): `max_turns` = our plan's model-call bound (7 `llm` nodes, and the
  screening and evidence maps' `llm` steps at 20 items each: 47), the policy's `hard_tokens`, the
  per-tool and remote-call caps, the graph's deadline.
- **Answer** (rule 4): the answer step (TUNING.md T-1) with `tasks/literature-answer.schema.json`.
- **Policy** (rule 7): Progent's released code with `policies/literature-review.json`.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from agents import Agent, Runner

from campaigns.baseline import ports, tools
from campaigns.baseline.agent import (
    RUN_OUTCOMES,
    Recorder,
    _error_code,
    final_answer,
    formatter,
    max_output_tokens,
    model_call_bound,
    model_settings,
    ollama_context,
    sdk_model,
)
from campaigns.baseline.policies import build as policies
from campaigns.driver import hostmap, py_driver, record
from campaigns.driver.responder import Responder
from campaigns.driver.routes import Rung

PORT = "literature-review"
FORMATTER = (
    "Return the review in the conversation as the JSON object the schema describes. Copy every "
    "DOI, title and quote exactly as a tool's answer in the conversation gave it; a list the "
    "conversation has nothing for is empty."
)


def build(
    package, rung: Rung, *, stack, run_dir: Path, fixture_key: str | None, selected: dict | None
):
    """The run's tool layer and agents (no model is called here)."""
    grants, approved = py_driver.literature_grants(selected)
    state = tools.RunState()
    layer = tools.ToolLayer(
        specs=ports.function_tool_specs(package),
        state=state,
        transport=tools.Transport(hosts=stack.hosts, ca=str(stack.ca)),
        memory_handlers={},
        responder=Responder("R-deny"),  # no consequential tool: never asked
        budget=package.policy["budget"],
        offered=set(approved),
        files=package.files,
        host_handlers=py_driver.literature_handlers(package, selected),
    )
    agent = Agent(
        name="Literature Review",
        instructions=ports.instructions(PORT, package),
        tools=layer.function_tools(),
        model=sdk_model(rung),
        model_settings=model_settings(rung, package),
    )
    layer.secure(agent, policies.progent_rules(policies.load(PORT)))
    answer_agent = formatter(
        rung,
        package,
        port=PORT,
        schema="literature-answer",
        name="Literature Review answer",
        instructions=FORMATTER,
    )
    table = hostmap.mapping(
        stack.hosts,
        stack.ca,
        run_dir / "dials.jsonl",
        fixture_key=fixture_key,
        fixture_hosts=py_driver.FIXTURE_HOSTS,
    )
    return {
        "grants": grants,
        "approved": approved,
        "state": state,
        "layer": layer,
        "agent": agent,
        "answer_agent": answer_agent,
        "mapping": table,
    }


def run_literature_review(
    *,
    question: str,
    rung: Rung,
    run_dir: Path,
    stack,
    fixture_key: str | None,
    meta: dict,
    selected: dict | None = None,
) -> dict:
    """One Literature Review run (TS-L) on `FW`; returns the campaign run record. The task text is
    the question, as the person types it on our side (rule 4)."""
    run_dir.mkdir(parents=True, exist_ok=False)
    package = ports.load(PORT)
    built = build(
        package, rung, stack=stack, run_dir=run_dir, fixture_key=fixture_key, selected=selected
    )
    state = built["state"]
    documents = {doi: file_id for doi, (file_id, _path) in (selected or {}).items()}
    input_value = py_driver.literature_input(question, documents)
    text = question
    if documents:  # the selected files' opaque ids, as our side's input carries them
        text += "\n\nSelected PDFs (DOI: file id): " + ", ".join(
            f"{doi}: {file_id}" for doi, file_id in sorted(documents.items())
        )
    bound = model_call_bound(package)
    hard_tokens = package.policy["budget"].get("hard_tokens")
    deadline = package.graph.get("deadline_seconds")
    model_calls: list[dict] = []
    turns: list[dict] = []
    outcome = {"harness_error": None}
    origin_start, sink_start = len(stack.origin_log), len(stack.sink.log)
    resolver_start = len(stack.resolver_log)
    started = time.monotonic()

    async def run() -> None:
        hooks = Recorder(model_calls, hard_tokens, 1)
        try:
            result = await asyncio.wait_for(
                Runner.run(built["agent"], text, max_turns=bound, hooks=hooks), timeout=deadline
            )
        except Exception as exc:
            state.tokens += hooks.tokens
            code = _error_code(exc)
            if code not in RUN_OUTCOMES:
                outcome["harness_error"] = f"{type(exc).__name__}: {exc}"[:500]
            if model_calls and "outcome" not in model_calls[-1]:
                model_calls[-1]["outcome"] = code
            turns.append({"turn": 1, "status": "failed", "error_code": code, "answer": None})
            return
        answer_error = None
        try:
            formatted = (
                await Runner.run(
                    built["answer_agent"], result.to_input_list(), max_turns=1, hooks=hooks
                )
            ).final_output
        except Exception as exc:
            formatted = None
            if model_calls and "outcome" not in model_calls[-1]:
                model_calls[-1]["outcome"] = _error_code(exc)
            if _error_code(exc) == "budget_exhausted":
                answer_error = "budget_exhausted"
        state.tokens += hooks.tokens
        answer, code = final_answer(formatted, ports.answer_schema("literature-answer"))
        code = answer_error or code
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
        with hostmap.install(built["mapping"]):
            asyncio.run(run())
    except Exception as exc:
        outcome["harness_error"] = f"{type(exc).__name__}: {exc}"[:500]
    seconds = time.monotonic() - started
    context = ollama_context(rung) if rung.provider == "ollama" else None
    harness_error = outcome["harness_error"]
    if context is not None and context != rung.context_window:
        harness_error = harness_error or (
            f"the Ollama server loaded {rung.model} with context {context}, "
            f"not the rung's {rung.context_window}"
        )
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
        origin_log=stack.origin_log[origin_start:] + stack.resolver_log[resolver_start:],
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
        offered=sorted(built["approved"]),
        memory_grants={},
    )
    # agentpkg's own lookups and dials under the host mapping, as on `Py`.
    rec["dials"] = hostmap.read_dial_log(run_dir / "dials.jsonl")
    rec["host_events"] = state.host_events
    rec["input"] = input_value
    rec["grants"] = built["grants"]
    return record.write(run_dir, rec)
