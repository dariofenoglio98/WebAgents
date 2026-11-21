"""The defenses' own model calls (D-420, D-422): AgentDojo's tool filter and Progent's policy
generation, decision and update, sent to the rung's model over the rung's route (rule 2: Ollama's
OpenAI-compatible `/v1` at the rung's temperature, or the Responses API with D-361's 429 policy).

Each call is recorded in the run's `model_calls` with `"role": "defense"` and its `purpose`: its
tokens, seconds and dollars count as the side's cost, but it is not charged to the agent's budgets
(rule 9 bounds the agent loop) and stays outside boundary (e)'s envelope (D-422). The agent's own
calls are recorded by `agent.Recorder` as before.
"""

from __future__ import annotations

import json
import os
import time

import httpx
from openai import AsyncOpenAI

from campaigns.driver.routes import RateLimitRetryTransport, Rung

UNSET = object()


def chat_tools(specs: list[dict]) -> list[dict]:
    """Function tools in Chat Completions' shape (AgentDojo's `_function_to_openai`)."""
    return [
        {
            "type": "function",
            "function": {
                "name": s["name"],
                "description": s["description"],
                "parameters": s["schema"],
            },
        }
        for s in specs
    ]


def responses_tools(specs: list[dict]) -> list[dict]:
    return [
        {
            "type": "function",
            "name": s["name"],
            "description": s["description"],
            "parameters": s["schema"],
            "strict": False,
        }
        for s in specs
    ]


class DefenseRoute:
    """One run's route for defense calls; `calls` is the run's `model_calls` list and `turn` a
    callable returning the current turn (the record keys calls by turn)."""

    def __init__(self, rung: Rung, calls: list, turn=lambda: None):
        self.rung = rung
        self.calls = calls
        self.turn = turn

    def _client(self) -> AsyncOpenAI:
        if self.rung.provider == "ollama":
            return AsyncOpenAI(
                base_url=f"{self.rung.base_url.rstrip('/')}/v1",
                api_key="ollama",
                timeout=self.rung.timeout_seconds,
                max_retries=0,
            )
        if self.rung.provider == "openai":
            key = os.environ.get(self.rung.api_key_env or "")
            if not key:
                raise RuntimeError("the hosted rung's key variable is unset")
            return AsyncOpenAI(
                api_key=key,
                timeout=self.rung.timeout_seconds,
                max_retries=0,
                http_client=httpx.AsyncClient(transport=RateLimitRetryTransport()),
            )
        raise ValueError(f"unknown provider {self.rung.provider}")

    async def chat(
        self,
        *,
        purpose: str,
        system: str | None,
        messages: list[dict],
        tools: list[dict] | None = None,
        tool_choice: str | None = None,
        temperature=UNSET,
        seed: int | None = None,
    ) -> dict:
        """One defense call; returns `{"text", "tool_calls"}`. `messages` are chat messages
        (`role`, `content`); `tools` function-tool specs (`tools.ToolLayer.specs` values).
        `temperature` defaults to the rung's (rule 2); a hosted rung whose temperature is the
        provider's default (None) sends none, whatever the defense asks (Progent raises its
        temperature on a retry)."""
        if temperature is UNSET or self.rung.temperature is None:
            temperature = self.rung.temperature
        entry = {
            "at": time.time(),
            "turn": self.turn(),
            "role": "defense",
            "purpose": purpose,
            "system": system,
            "user": json.dumps(messages, ensure_ascii=False, default=str),
            "temperature": temperature,
        }
        self.calls.append(entry)
        client = self._client()
        try:
            if self.rung.provider == "ollama":
                body: dict = {
                    "model": self.rung.model,
                    "messages": ([{"role": "system", "content": system}] if system else [])
                    + messages,
                }
                if temperature is not None:
                    body["temperature"] = temperature
                if seed is not None:
                    body["seed"] = seed
                if tools:
                    body["tools"] = chat_tools(tools)
                    if tool_choice:
                        body["tool_choice"] = tool_choice
                completion = await client.chat.completions.create(**body)
                message = completion.choices[0].message
                text = message.content or ""
                called = [c.function.name for c in message.tool_calls or []]
                usage = completion.usage
                entry["usage"] = {
                    "input_tokens": getattr(usage, "prompt_tokens", None),
                    "output_tokens": getattr(usage, "completion_tokens", None),
                }
            else:
                body = {"model": self.rung.model, "input": messages}
                if system:
                    body["instructions"] = system
                if temperature is not None:
                    body["temperature"] = temperature
                if tools:
                    body["tools"] = responses_tools(tools)
                    if tool_choice:
                        body["tool_choice"] = tool_choice
                response = await client.responses.create(**body)
                text = response.output_text or ""
                called = [
                    item.name
                    for item in response.output or []
                    if getattr(item, "type", None) == "function_call"
                ]
                usage = response.usage
                entry["usage"] = {
                    "input_tokens": getattr(usage, "input_tokens", None),
                    "output_tokens": getattr(usage, "output_tokens", None),
                }
        except Exception as exc:
            entry["outcome"] = type(exc).__name__
            entry["error"] = str(exc)[:300]
            raise
        finally:
            await client.close()
        entry["outcome"] = "ok"
        entry["text"] = text
        entry["tool_calls"] = called
        entry["seconds"] = round(time.time() - entry["at"], 3)
        return {"text": text, "tool_calls": called}
