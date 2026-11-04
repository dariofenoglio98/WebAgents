"""The framework agent's tool layer (PROTOCOL.md §2.5, D-350), outermost first:

1. the **instrumented recorder**: every call the model proposes, with its arguments; a call that
   never reaches the executor is recorded in `refused` with the layer that stopped it and Progent's
   or the ask step's text, so the one oracle sees the baseline's refusals (rule 11);
2. **Progent's wrapper** (`secagent.tool.openai_agent_wrapper`, released code at `b02783b`),
   which runs `check_tool_call` against the committed hand-written policy (rule 7) and returns
   Progent's own error text to the model on a denial;
3. the **budget** (rule 9): our plan's per-tool call caps and remote-call cap;
4. **rule 8's ask step** before a consequential tool: the shared responder
   (`driver/responder.py`) decides on the facts of the quote this layer recorded for the call's
   `quote_id` (`call_facts`), as our consent host decides on the card's facts, which are that quote;
5. the **executor**: the declared endpoint over HTTPS, dialed to the campaign stack under the
   campaign CA (the same mapping our side's host mapping applies), the run's fixture key header on
   the campaign origin, no redirect following (httpx's default); memory and host-resource tools
   are answered by agentpkg's own memory handlers over the run's copy of the record set (rule 1).

Layers 3–5 are this module's `execute`; layer 1 is `record`; layer 2 is Progent's code, applied by
`secure` in between.
"""

from __future__ import annotations

import json
import socket
import ssl
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx
import secagent.tool as progent
from agents import Agent, FunctionTool

from campaigns.driver import responder as responders
from campaigns.driver.hostmap import HEADER

CONSEQUENTIAL = {"simulate-purchase"}
DATA_STATUSES = {200, 400, 404, 422, 502}  # as json_http (driver/json_http.py)
DECLINED = "The person declined this purchase when asked; nothing was bought."


@dataclass
class RunState:
    """Everything one run's tool layer records (the campaign run record's FW fields)."""

    turn: int = 1
    tool_calls: list = field(default_factory=list)
    refused: list = field(default_factory=list)
    consent: list = field(default_factory=list)
    dials: list = field(default_factory=list)
    memory_events: list = field(default_factory=list)
    quotes: dict = field(default_factory=dict)
    decoded: list = field(default_factory=list)
    counts: dict = field(default_factory=dict)
    remote_calls: int = 0  # the run's total
    turn_remote: int = 0  # this turn's, for the cap


@dataclass
class Transport:
    """The campaign stack as the executor dials it: the mapping, the CA and the fixture key."""

    hosts: dict
    ca: str
    fixture_key: str | None = None
    fixture_hosts: tuple = ()


class _EventSink:
    """The `ctx` agentpkg's memory handlers expect: they only report events."""

    def __init__(self, events: list):
        self.events = events

    def event(self, action: str, **facts) -> None:
        self.events.append({"at": time.time(), "action": action, **facts})


def _lookup(host: str) -> dict:
    try:
        answers = sorted({a[4][0] for a in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        return {"ok": True, "addresses": answers}
    except OSError as exc:
        return {"ok": False, "error": type(exc).__name__}


def decode_nested(arguments, schema: dict):
    """TUNING.md T-3 (rule 10, a parse fix): a top-level argument the declared schema types as an
    object or an array, sent by the model as a string holding that JSON (Qwen on Ollama's `/v1`
    does this for nested arguments), is decoded before Progent's check. Nothing else changes; the
    raw call is kept in the record (`decoded`). Returns `arguments` itself when nothing applies."""
    if not isinstance(arguments, dict):
        return arguments
    properties = schema.get("properties") or {}
    defs = schema.get("$defs") or {}
    changed = {}
    for name, value in arguments.items():
        prop = properties.get(name) or {}
        ref = prop.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            prop = defs.get(ref.removeprefix("#/$defs/"), {})
        declared = prop.get("type")
        if declared not in ("object", "array") or not isinstance(value, str):
            continue
        try:
            parsed = json.loads(value)
        except ValueError:
            continue
        if isinstance(parsed, dict if declared == "object" else list):
            changed[name] = parsed
    return {**arguments, **changed} if changed else arguments


class ToolLayer:
    def __init__(
        self,
        *,
        specs: list[dict],
        state: RunState,
        transport: Transport,
        memory_handlers: dict,
        responder: responders.Responder,
        budget: dict,
        offered: set[str],
    ):
        self.specs = {s["name"]: s for s in specs if s["tool_id"] in offered}
        self.state = state
        self.transport = transport
        self.memory_handlers = memory_handlers
        self.responder = responder
        self.budget = budget

    # Layer 1: the recorder. --------------------------------------------------------------------
    def record(self, invoke, spec: dict):
        async def recorded(ctx, input_json, *rest, **kw):
            try:
                arguments = json.loads(input_json) if input_json else {}
            except ValueError:
                arguments = {"_unparsed": input_json}
            decoded = decode_nested(arguments, spec["schema"])
            if decoded is not arguments:  # TUNING.md T-3
                self.state.decoded.append(
                    {"turn": self.state.turn, "tool": spec["tool_id"], "raw": arguments}
                )
                arguments = decoded
                input_json = json.dumps(decoded, ensure_ascii=False)
            marker = {"reached": False}
            result = await invoke(ctx, input_json, *rest, _marker=marker, **kw)
            if not marker["reached"]:
                self.state.refused.append(
                    {
                        "at": time.time(),
                        "turn": self.state.turn,
                        "kind": "progent.denied",
                        "reason": str(result)[:500],
                        "tool": spec["tool_id"],
                        "arguments": arguments,
                    }
                )
            return result

        return recorded

    # Layers 3-5: budget, ask step, executor. -----------------------------------------------------
    def executor(self, spec: dict):
        async def execute(ctx, input_json, *_, _marker=None, **__):
            if _marker is not None:
                _marker["reached"] = True
            arguments = json.loads(input_json) if input_json else {}
            tool_id = spec["tool_id"]
            refusal = self._over_budget(spec)
            if refusal is not None:
                self._refuse("budget", refusal, tool_id, arguments)
                return f"The host refused this call: {refusal}."
            if tool_id in CONSEQUENTIAL:
                facts = responders.call_facts(arguments, self.state.quotes)
                accepted = self.responder.decide(facts, seat="ask_step", step=tool_id)
                self.state.consent.append(
                    {
                        "at": time.time(),
                        "turn": self.state.turn,
                        "step": f"ask:{tool_id}",
                        "facts": facts,
                        "accepted": accepted,
                    }
                )
                if not accepted:
                    self._refuse("ask.denied", "the person declined", tool_id, arguments)
                    return DECLINED
            self.state.counts[tool_id] = self.state.counts.get(tool_id, 0) + 1
            entry = {
                "at": time.time(),
                "turn": self.state.turn,
                "tool": tool_id,
                "binding": spec["binding"],
                "role": None,
                "arguments": arguments,
            }
            self.state.tool_calls.append(entry)
            try:
                if spec["kind"] == "memory":
                    handler = self.memory_handlers[spec["binding"]]
                    status, answer = (
                        200,
                        await handler(_EventSink(self.state.memory_events), arguments),
                    )
                else:
                    self.state.remote_calls += 1
                    self.state.turn_remote += 1
                    status, answer = await self._http(spec, arguments)
            except Exception as exc:
                entry["outcome"] = "threw"
                entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
                return f"Tool error: {type(exc).__name__}: {exc}"[:500]
            entry["status"] = status
            if status not in DATA_STATUSES:
                entry["outcome"] = "threw"
                entry["error"] = f"HTTP {status}"
                return f"Tool error: the tool host answered HTTP {status}."
            entry["outcome"] = "answered"
            entry["answer"] = answer
            if tool_id == "prepare-booking" and isinstance(answer, dict) and answer.get("quote_id"):
                self.state.quotes[answer["quote_id"]] = answer
            return json.dumps(answer, ensure_ascii=False)

        return execute

    def _refuse(self, kind: str, reason: str, tool_id: str, arguments) -> None:
        self.state.refused.append(
            {
                "at": time.time(),
                "turn": self.state.turn,
                "kind": kind,
                "reason": reason,
                "tool": tool_id,
                "arguments": arguments,
            }
        )

    def _over_budget(self, spec: dict) -> str | None:
        caps = self.budget.get("max_calls_per_tool") or {}
        cap = caps.get(spec["tool_id"])
        if cap is not None and self.state.counts.get(spec["tool_id"], 0) >= cap:
            return f"at most {cap} call(s) to {spec['tool_id']} per run"
        limit = self.budget.get("max_remote_calls")
        if spec["kind"] == "http" and limit is not None and self.state.turn_remote >= limit:
            return f"at most {limit} remote calls per run"
        return None

    async def _http(self, spec: dict, arguments) -> tuple[int, object]:
        url = spec["endpoint"]
        parts = urlsplit(url)
        host = parts.hostname
        dial = {"at": time.time(), "url": url, "host": host, "mapped": host in self.transport.hosts}
        dial["lookup"] = _lookup(host)
        self.state.dials.append(dial)
        if host not in self.transport.hosts:
            raise RuntimeError(f"no campaign mapping for {host}")
        address, port = self.transport.hosts[host]
        dial["dialed"] = [address, port]
        headers = {"Host": host, "Accept": "application/json"}
        if self.transport.fixture_key and host in self.transport.fixture_hosts:
            headers[HEADER] = self.transport.fixture_key
            dial["fixture_key"] = self.transport.fixture_key
        context = ssl.create_default_context(cafile=self.transport.ca)
        async with httpx.AsyncClient(
            verify=context, follow_redirects=False, timeout=spec["timeout_seconds"] or 20
        ) as client:
            response = await client.request(
                spec["method"] or "POST",
                f"https://{address}:{port}{parts.path}"
                + (f"?{parts.query}" if parts.query else ""),
                json=arguments,
                headers=headers,
                extensions={"sni_hostname": host},
            )
        dial["status"] = response.status_code
        try:
            body = response.json()
        except ValueError:
            body = None
        return response.status_code, body

    # Assembly. ---------------------------------------------------------------------------------
    def function_tools(self) -> list[FunctionTool]:
        return [
            FunctionTool(
                name=spec["name"],
                description=spec["description"],
                params_json_schema=spec["schema"],
                on_invoke_tool=self.executor(spec),
                strict_json_schema=False,
            )
            for spec in self.specs.values()
        ]

    def secure(self, agent: Agent, policy_rules: dict) -> Agent:
        """Progent's wrapper around the executor, then the recorder around Progent (D-350)."""
        progent.update_security_policy(policy_rules)
        progent.openai_agent_wrapper(agent)
        for tool in agent.tools:
            if isinstance(tool, FunctionTool):
                tool.on_invoke_tool = self.record(tool.on_invoke_tool, self.specs[tool.name])
        return agent
