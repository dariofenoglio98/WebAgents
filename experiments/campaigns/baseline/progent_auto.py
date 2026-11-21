"""Progent's autonomous mode on the framework agent (`FW-progent`, D-366 (1), D-420).

Progent's released code (`secagent`, `github.com/sunblaze-ucb/progent` at `b02783b`, MIT; Shi et
al., arXiv 2504.11703) as its authors run it on AgentDojo (`agentdojo/run.sh`): the policy model is
the agent's model (`SECAGENT_POLICY_MODEL` = `model`; the paper's §8.1: "the underlying LLM of the
agent and the LLM for policy generation"), the policy is generated from the user's query before the
agent runs (`InitQuery` → `generate_security_policy`) and updated after every tool execution
(`SECAGENT_UPDATE=True` → `generate_update_security_policy(calls, str(results))`), update errors
ignored (`SECAGENT_IGNORE_UPDATE_ERROR=True`), no narrowing-only check (`SECAGENT_ONLY_ALLOW_NARROW`
commented out), a denial returned to the model as Progent's error text (fallback 0), and the
suite's read-only tools always allowed (`init_policies` → `update_always_allowed_tools`, priority 1,
which the generated policy's priority-100 rules never replace). For WebAir the read-only tools are
those its declaration marks `side_effects: read` (`ports.function_tool_specs`), as the authors'
travel suite lists every `get_*` tool and none of its `reserve_*` tools. No ask step (D-421).

Our adaptations, stated (D-420):
1. **The route.** Progent's `api_request` sends Chat Completions with `temperature` and `seed` to
   OpenAI (or to `127.0.0.1:8000` for a `Qwen/` name); it is replaced, for the run, by one function
   sending the same system and user messages to the rung's model over the rung's route
   (`defense_route.DefenseRoute`: Ollama `/v1`, or the Responses API with D-361's 429 policy and no
   temperature for a provider-default rung), each call recorded as a defense call. Progent's
   prompts, its JSON extraction, its retries (temperature + 0.2, at most five) and its checker run
   unchanged.
2. **Its state** is module-wide (`security_policy`, `available_tools`, `init_user_query`): it is
   reset before every run, and a shard runs one unit at a time.
3. **Multi-turn** (the user's choice, 2026-11-20): Progent defines one query; before each turn the
   policy is generated again from the user's messages so far, joined by blank lines, so a later
   turn's request can be allowed (`generate_security_policy` itself deletes the previous generated
   rules; the always-allowed rules stay).
4. Generation and update are synchronous in Progent; they run in a worker thread so that the
   turn's deadline (`asyncio.wait_for`) still applies.
5. **Route failures** (rule 12, D-361): Progent's retry loop catches every exception, and with
   update errors ignored it would turn our route's failure into a run without generated rules. A
   failure of the route itself (any `openai` client error: a refused connection, a 5xx, a 429 past
   D-361's waits, a timeout) is kept and raised after Progent returns, so the driver classifies it
   as it classifies the agent's own calls (a harness error; a timeout the run's failure). A reply
   Progent cannot parse is Progent's to retry, as released.
"""

from __future__ import annotations

import asyncio
import json

import openai
import secagent.tool as progent

from campaigns.baseline.defense_route import DefenseRoute

# Progent's `generate_security_policy` and `generate_update_security_policy` call these by name.
_ORIGINAL_API_REQUEST = progent.api_request


def joined_query(user_turns: list[str]) -> str:
    """The query Progent generates from before a turn: the user's messages so far."""
    return "\n\n".join(user_turns)


class ProgentAuto:
    """One run's autonomous Progent: installs the route, resets the state, generates and updates."""

    def __init__(self, route: DefenseRoute, specs: list[dict], policy_model: str):
        self.route = route
        self.specs = specs  # the offered function-tool specs (`ToolLayer.specs` values)
        self.policy_model = policy_model
        self.read_only = sorted(s["name"] for s in specs if s.get("side_effects") == "read")
        self.events: list[dict] = []
        self.route_failure: BaseException | None = None

    # -- installation --------------------------------------------------------------------------
    def install(self) -> None:
        progent.security_policy = None
        progent.available_tools = []
        progent.init_user_query = None
        progent.policy_model = self.policy_model
        progent.generate_policy = True  # SECAGENT_GENERATE's default
        progent.ignore_update_error = True  # SECAGENT_IGNORE_UPDATE_ERROR=True
        progent.api_request = self._api_request

    def uninstall(self) -> None:
        progent.api_request = _ORIGINAL_API_REQUEST

    def always_allow(self) -> None:
        """`init_policies()` for this suite: the declared read-only tools (after the wrapper has
        registered the tools, as their SDK example calls it after `get_all_tools`)."""
        progent.update_always_allowed_tools(self.read_only)

    def _api_request(self, sys_prompt, user_prompt, temperature=0.0):
        """Progent's `api_request(sys_prompt, user_prompt, temperature)` over the rung's route."""
        purpose = self._purpose
        try:
            result = asyncio.run(
                self.route.chat(
                    purpose=purpose,
                    system=sys_prompt,
                    messages=[{"role": "user", "content": user_prompt}],
                    temperature=temperature,
                    seed=0,
                )
            )
        except openai.OpenAIError as exc:
            if self.route_failure is None:
                self.route_failure = exc
            raise
        return result["text"]

    _purpose = "progent.generate"

    # -- the run -------------------------------------------------------------------------------
    def _policy_snapshot(self) -> dict:
        policy = progent.security_policy or {}
        return json.loads(json.dumps(policy, default=str))

    def _generate(self, query: str) -> None:
        self._purpose = "progent.generate"
        error = None
        try:
            progent.generate_security_policy(query)
        except Exception as exc:  # Progent raises after its five retries: no generated rules
            error = f"{type(exc).__name__}: {exc}"[:300]
        self.events.append(
            {
                "turn": self.route.turn(),
                "event": "generate",
                "error": error,
                "policy": self._policy_snapshot(),
            }
        )

    def _update(self, calls: list[dict], results: str) -> None:
        # Progent's own split: a decision call (`decide_whether_to_update`), then the update call;
        # both go through `api_request`, so the purpose names the pair.
        self._purpose = "progent.update"
        error = None
        try:
            progent.generate_update_security_policy(calls, results, manual_check=False)
        except Exception as exc:  # with errors ignored Progent returns; anything else is recorded
            error = f"{type(exc).__name__}: {exc}"[:300]
        self.events.append(
            {
                "turn": self.route.turn(),
                "event": "update",
                "calls": calls,
                "error": error,
                "policy": self._policy_snapshot(),
            }
        )

    def _raise_route_failure(self) -> None:
        failure, self.route_failure = self.route_failure, None
        if failure is not None:
            raise failure

    async def generate(self, user_turns: list[str]) -> None:
        await asyncio.to_thread(self._generate, joined_query(user_turns))
        self._raise_route_failure()

    async def update(self, tool_name: str, arguments: dict, result_text: str) -> None:
        """After a tool execution: `generate_update_security_policy([call], str(result))`, as the
        authors' SDK example passes each tool output."""
        await asyncio.to_thread(
            self._update, [{"name": tool_name, "args": arguments}], str(result_text)
        )
        self._raise_route_failure()
