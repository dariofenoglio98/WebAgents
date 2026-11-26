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
4. Generation and update are synchronous in Progent; they run in the run's own worker thread so
   that the turn's deadline (`asyncio.wait_for`) still applies. The deadline cancels the wait, not
   the thread (T32b review 1, finding 1, rule 12), so the run's end **closes** its Progent
   (`close`): no further policy call is sent, the call in flight is cancelled on the worker's loop,
   queued updates are dropped, and the worker is joined before the record is written and before
   the next run installs. A policy call from any thread but the installed run's own worker is
   refused (`StaleCall`), and `install` refuses while an earlier run's worker is alive. Updates
   run one after another, in the order the tools answer (one worker): when the model returns
   several tool calls at once the SDK runs them concurrently, and two overlapping updates would
   each read the same `CURRENT_RESTRICTIONS` and the later would discard the earlier (finding 2);
   the authors update once per batch (their AgentDojo executor) or one output after another
   (their SDK example), never in parallel.
5. **Route failures** (rule 12, D-361): Progent's retry loop catches every exception, and with
   update errors ignored it would turn our route's failure into a run without generated rules. A
   failure of the route itself (an `openai` client error: a refused connection, a 5xx, a 429 past
   D-361's waits) is kept and raised after Progent returns, so the driver makes it a harness error
   as it does for the agent's own calls. A call that timed out is the model's slowness, not the
   route's failure: Progent retries it as released (the T32b smoke, TUNING T-9), and the turn's
   deadline bounds the whole. A reply Progent cannot parse is Progent's to retry, as released.
6. **A generation that fails after Progent's retries** (six failed attempts) raises in the
   released code and ends the authors' task; here the error is recorded on the `generate` event
   and the turn runs on with the rules in place (the always-allowed read tools, and on a later
   turn the previous generated rules, which Progent deletes only on a successful generation), so
   a purchase no rule allows stays denied (finding 13; no occurrence in T32b's paper directories).
7. **The policy model's name** (TUNING T-9, rule 10): Progent picks its prompt's output-format
   line by the model name, and names Qwen models `Qwen/…` (its vLLM route); a local Qwen rung is
   given that name (`policy_model_name`), so Progent sends a Qwen model the prompt it wrote for one.
   The route is ours whatever the name (the replaced `api_request`).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import threading

import openai
import secagent.tool as progent

from campaigns.baseline.defense_route import DefenseRoute

# Progent's `generate_security_policy` and `generate_update_security_policy` call these by name.
_ORIGINAL_API_REQUEST = progent.api_request

# How long a run's end waits for its worker after cancelling the call in flight. Parsing a reply is
# quick; a worker still alive after this is a harness error of the run (rule 12).
JOIN_SECONDS = 30.0

# The run whose generation or update the current worker thread is executing.
_owner = threading.local()
# The installed run: the one whose `_api_request` is Progent's `api_request`.
_installed: ProgentAuto | None = None
# Runs closed without their worker ending in time: the next `install` refuses while one is alive.
_unjoined: list[ProgentAuto] = []


class StaleCall(BaseException):
    """A policy call refused because its run has ended or is not the installed one (finding 1).
    A `BaseException`, so Progent's retry loops (`except Exception`) let it through: the worker
    ends at once and writes nothing into Progent's state."""


class WorkerAlive(RuntimeError):
    """A run's Progent worker outlived its run's end (a harness error, rule 12)."""


def policy_model_name(model: str) -> str:
    """The name Progent's prompt branches read (D-420, TUNING T-9): `Qwen/<model>` for a Qwen model
    (its `Qwen/` branches add the output-format line), the provider's id otherwise."""
    return f"Qwen/{model}" if model.lower().startswith("qwen") else model


def joined_query(user_turns: list[str]) -> str:
    """The query Progent generates from before a turn: the user's messages so far."""
    return "\n\n".join(user_turns)


class ProgentAuto:
    """One run's autonomous Progent: installs the route, resets the state, generates and updates."""

    def __init__(self, route: DefenseRoute, specs: list[dict], policy_model: str):
        self.route = route
        self.specs = specs  # the offered function-tool specs (`ToolLayer.specs` values)
        self.policy_model = policy_model_name(policy_model)
        self.read_only = sorted(s["name"] for s in specs if s.get("side_effects") == "read")
        self.events: list[dict] = []
        self.route_failure: BaseException | None = None
        self.closed = False
        self._worker = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="progent"
        )
        self._futures: list[concurrent.futures.Future] = []
        self._inflight: tuple[asyncio.AbstractEventLoop, asyncio.Task] | None = None
        self._lock = threading.Lock()

    # -- installation --------------------------------------------------------------------------
    def install(self) -> None:
        global _installed
        for earlier in list(_unjoined):
            if earlier.alive():
                raise WorkerAlive("an earlier run's Progent worker is still alive")
            _unjoined.remove(earlier)
        _installed = self
        progent.security_policy = None
        progent.available_tools = []
        progent.init_user_query = None
        progent.policy_model = self.policy_model
        progent.generate_policy = True  # SECAGENT_GENERATE's default
        progent.ignore_update_error = True  # SECAGENT_IGNORE_UPDATE_ERROR=True
        progent.api_request = self._api_request

    def uninstall(self) -> None:
        """Closes the run (joining its worker), then restores Progent's own `api_request`."""
        global _installed
        try:
            self.close()
        finally:
            progent.api_request = _ORIGINAL_API_REQUEST
            if _installed is self:
                _installed = None

    def alive(self) -> bool:
        return any(not f.done() for f in self._futures)

    def close(self) -> None:
        """The run's end: refuse further policy calls, cancel the call in flight and the queued
        updates, join the worker. Raises `WorkerAlive` if the worker outlives `JOIN_SECONDS`.
        Idempotent."""
        with self._lock:
            already, self.closed = self.closed, True
            inflight = self._inflight
        if not already:
            if inflight is not None:
                loop, task = inflight
                try:
                    loop.call_soon_threadsafe(task.cancel)
                except RuntimeError:  # the worker's loop has just closed
                    pass
            self._worker.shutdown(wait=False, cancel_futures=True)
        pending = [f for f in self._futures if not f.done()]
        if pending:
            concurrent.futures.wait(pending, timeout=JOIN_SECONDS)
        if self.alive():
            if self not in _unjoined:
                _unjoined.append(self)
            raise WorkerAlive(f"a Progent policy call outlived its run by {JOIN_SECONDS:.0f} s")

    def always_allow(self) -> None:
        """`init_policies()` for this suite: the declared read-only tools (after the wrapper has
        registered the tools, as their SDK example calls it after `get_all_tools`)."""
        progent.update_always_allowed_tools(self.read_only)

    def _refuse_stale(self) -> None:
        if self.closed or getattr(_owner, "run", None) is not self or _installed is not self:
            raise StaleCall("a policy call from a run that has ended or is not installed")

    async def _chat(self, **kwargs) -> dict:
        with self._lock:
            if self.closed:
                raise StaleCall("the run ended before the policy call was sent")
            self._inflight = (asyncio.get_running_loop(), asyncio.current_task())
        try:
            return await self.route.chat(**kwargs)
        finally:
            with self._lock:
                self._inflight = None

    def _api_request(self, sys_prompt, user_prompt, temperature=0.0):
        """Progent's `api_request(sys_prompt, user_prompt, temperature)` over the rung's route.
        Progent calls it by module name, so an earlier run's worker would reach the installed
        run's route: only the installed run's own worker, before its run's end, is served."""
        self._refuse_stale()
        purpose = self._purpose
        try:
            result = asyncio.run(
                self._chat(
                    purpose=purpose,
                    system=sys_prompt,
                    messages=[{"role": "user", "content": user_prompt}],
                    temperature=temperature,
                    seed=0,
                )
            )
        except asyncio.CancelledError:
            raise StaleCall("the policy call in flight was cancelled at the run's end") from None
        except openai.APITimeoutError:  # the model's slowness: Progent retries it (point 5)
            raise
        except openai.OpenAIError as exc:
            if self.route_failure is None:
                self.route_failure = exc
            raise
        self._refuse_stale()  # the run ended while the reply was on its way: never applied
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
        except StaleCall as exc:  # the run's end (point 4): Progent's state is left as it was
            error = f"StaleCall: {exc}"
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
        except StaleCall as exc:  # the run's end (point 4): Progent's state is left as it was
            error = f"StaleCall: {exc}"
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

    def _owned(self, work, *args) -> None:
        """Runs in the worker: marks the thread as this run's, so `_api_request` serves it."""
        _owner.run = self
        try:
            if not self.closed:
                work(*args)
        finally:
            _owner.run = None

    async def _submit(self, work, *args) -> None:
        if self.closed:
            raise StaleCall("the run has ended")
        future = self._worker.submit(self._owned, work, *args)
        self._futures.append(future)
        await asyncio.wrap_future(future)

    async def generate(self, user_turns: list[str]) -> None:
        await self._submit(self._generate, joined_query(user_turns))
        self._raise_route_failure()

    async def update(self, tool_name: str, arguments: dict, result_text: str) -> None:
        """After a tool execution: `generate_update_security_policy([call], str(result))`, as the
        authors' SDK example passes each tool output; one update at a time (point 4)."""
        await self._submit(self._update, [{"name": tool_name, "args": arguments}], str(result_text))
        self._raise_route_failure()
