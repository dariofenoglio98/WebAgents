"""The rung's model route for `Py` (PROTOCOL.md §2.2): a `ModelRouter` over Ollama's `/api/chat` or
OpenAI's Responses API, bound to one model.

agentpkg's live routes go through a host (the OpenClaw bridge, or the vendor-neutral `HTTPRouter`
protocol); neither reaches Ollama or the Responses API directly. This router is the campaign host's
adapter, built from agentpkg's own pieces so that the model sees what the bridge would send and the
answer is judged as the bridge judges it: `hostbridge.router.render` (the wire text, byte-identical
to the Chrome core's `render.ts`), `token_upper_bound` (the count), `parse_structured` and
validation against the node's schema, and `BridgeError` codes for a refused or non-conforming
answer, so the runtime's re-ask and its audit treat it exactly as a bridge answer.

The Ollama body is the Chrome core's (`src/core/models/adapters/ollama.ts`): the schema as `format`
(the root `$ref` inlined, root annotations stripped, at most 64 KiB), `stream: false`,
`options.num_ctx` = the rung's context, `options.num_predict` = the node's cap, plus the campaign's
sampling (`temperature: 0`) and the rung's thinking setting (§2.2: the model's default unless the
rung states one; recorded). The Responses body is the Chrome core's non-strict form (`instructions`,
`input`, `max_output_tokens`, `store: false`, `text.format` json_schema with `strict: false`);
before the hosted rungs run, T32 compares it with the core's strict-first request (an open item).
"""

from __future__ import annotations

import copy
import json
import os
import time
from dataclasses import dataclass, field

import httpx
from agentpkg.hostbridge.errors import BridgeError
from agentpkg.hostbridge.router import (
    classify_termination,
    parse_structured,
    render,
    token_upper_bound,
)
from jsonschema import Draft202012Validator
from jsonschema import ValidationError as JsonValidationError

MAX_RESPONSE_FORMAT_BYTES = 64 * 1024
STRIPPED_ROOT_KEYS = ("$schema", "$id", "$anchor", "title", "description")
RESPONSE_FORMAT_NAME = "agentpkg_node_output"


@dataclass(frozen=True)
class Rung:
    """One rung of the ladder bound to one route (PROTOCOL.md §2.2); every field is recorded."""

    name: str  # L4, L9, L30, H, H2
    provider: str  # "ollama" or "openai"
    model: str  # the provider's model id (`qwen3.5:9b`, `gpt-5.6-luna`)
    base_url: str  # http://127.0.0.1:11434, the server tunnel, https://api.openai.com
    context_window: int = 32768
    temperature: float | None = 0.0  # None: the provider's default (Luna), recorded
    think: bool | None = None  # None: the model's default thinking setting
    api_key_env: str | None = None  # the user's key, by environment variable name only
    timeout_seconds: float = 600.0
    extra: dict = field(default_factory=dict)

    @property
    def remote(self) -> bool:
        return not any(h in self.base_url for h in ("127.0.0.1", "localhost", "[::1]"))

    def describe(self) -> dict:
        data = {k: v for k, v in self.__dict__.items() if k != "extra"}
        data["remote"] = self.remote
        return data


def _inline_root_ref(schema: dict) -> dict:
    ref = schema.get("$ref")
    if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
        return schema
    name = ref.removeprefix("#/$defs/")
    target = (schema.get("$defs") or {}).get(name)
    if not isinstance(target, dict) or isinstance(target.get("$ref"), str):
        return schema
    rest = {k: v for k, v in schema.items() if k != "$ref"}
    return {**target, **rest}


def ollama_format(schema) -> dict | None:
    """The Chrome core's `constraintSchema(schema, OLLAMA_RULES)`."""
    if not isinstance(schema, dict):
        return None
    rooted = _inline_root_ref(copy.deepcopy(schema))
    if rooted.get("type") not in ("object", "array"):
        return None
    for key in STRIPPED_ROOT_KEYS:
        rooted.pop(key, None)
    if len(json.dumps(rooted, separators=(",", ":")).encode()) > MAX_RESPONSE_FORMAT_BYTES:
        return None
    return rooted


class CampaignRouter:
    """`ModelRouter` for one rung; `calls` is the recording seam's list (one entry per call)."""

    router_id = "campaign-route"
    domains = ()

    def __init__(self, rung: Rung, *, capabilities=("reasoning", "structured_output")):
        self.rung = rung
        self.model_id = f"{rung.provider}/{rung.model}"
        self.remote = rung.remote
        self.capabilities = frozenset(capabilities)
        self.context_window = rung.context_window
        self.calls: list[dict] = []
        self._client: httpx.AsyncClient | None = None
        self._client_loop = None

    def describe(self) -> dict:
        return {
            "router_id": self.router_id,
            "model_id": self.model_id,
            "rung": self.rung.describe(),
        }

    async def count_tokens(self, request: dict) -> int:
        return token_upper_bound(render(request))

    async def complete(self, request: dict, *, max_output_tokens: int) -> dict:
        rendered = render(request)
        entry = {
            "at": time.time(),
            "system": rendered["system"],
            "user": rendered["user"],
            "schema_sha256": _sha(rendered["schema_text"]),
            "max_output_tokens": max_output_tokens,
        }
        self.calls.append(entry)
        started = time.monotonic()
        try:
            if self.rung.provider == "ollama":
                text, stop, usage, response_model = await self._ollama(
                    rendered, max_output_tokens, entry
                )
            elif self.rung.provider == "openai":
                text, stop, usage, response_model = await self._openai(
                    rendered, max_output_tokens, entry
                )
            else:
                raise BridgeError("model_unavailable", f"unknown provider {self.rung.provider}")
        except BridgeError as exc:
            entry["error"] = getattr(exc, "code", None) or type(exc).__name__
            raise
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            # A transport failure, or a 200 that is not the provider's JSON (a tunnel's HTML
            # page): the route is unavailable, as the bridge records it (review 1, nit 16).
            entry["error"] = type(exc).__name__
            raise BridgeError("model_unavailable", f"route failed: {type(exc).__name__}") from exc
        entry.update(
            seconds=round(time.monotonic() - started, 3),
            stop_reason=stop,
            usage=usage,
            response_model=response_model,
            text=text,
        )
        facts = {"stop_reason": stop or "unreported"}
        termination = classify_termination(stop)
        if termination is not None:
            entry["outcome"] = termination[0]
            raise BridgeError(*termination, audit_facts=facts)
        if not isinstance(text, str):
            entry["outcome"] = "no_text"
            raise BridgeError(
                "model_output_not_conforming",
                "The route returned no text",
                audit_facts={**facts, "output_failure": "no_text"},
            )
        try:
            output, _mode = parse_structured(text)
        except BridgeError as exc:
            entry["outcome"] = "not_json"
            exc.audit_facts = {**facts, "output_failure": "not_json"}
            raise
        validator = Draft202012Validator(rendered["output_schema"])
        try:
            validator.validate(output)
        except JsonValidationError as exc:
            entry["outcome"] = "schema"
            raise BridgeError(
                "model_output_not_conforming",
                f"The model output does not satisfy the requested schema: {exc.message[:200]}",
                audit_facts={**facts, "output_failure": "schema"},
            ) from exc
        entry["outcome"] = "ok"
        return {
            "output": output,
            "input_tokens": usage.get("input_tokens") or 0,
            "output_tokens": usage.get("output_tokens") or 0,
        }

    def _http(self) -> httpx.AsyncClient:
        """One client per event loop, reused across the loop's calls (T31 review 2, nit 14): a
        client is bound to the loop that opened it, and a run or a conversation is one loop."""
        import asyncio

        loop = asyncio.get_running_loop()
        if self._client is None or self._client_loop is not loop:
            self._client = httpx.AsyncClient(timeout=self.rung.timeout_seconds)
            self._client_loop = loop
        return self._client

    async def _ollama(self, rendered: dict, max_output_tokens: int, entry: dict):
        options = {"num_ctx": self.rung.context_window, "num_predict": max_output_tokens}
        if self.rung.temperature is not None:
            options["temperature"] = self.rung.temperature
        body = {
            "model": self.rung.model,
            "messages": [
                {"role": "system", "content": rendered["system"]},
                {"role": "user", "content": rendered["user"]},
            ],
            "stream": False,
            "options": options,
        }
        if self.rung.think is not None:
            body["think"] = self.rung.think
        constraint = ollama_format(rendered["output_schema"])
        if constraint is not None:
            body["format"] = constraint
        entry["think"] = body.get("think")  # as sent: absent is null (review 2, nit 12)
        response = await self._http().post(f"{self.rung.base_url.rstrip('/')}/api/chat", json=body)
        if response.status_code != 200:
            raise BridgeError("model_unavailable", f"Ollama answered HTTP {response.status_code}")
        data = response.json()
        message = data.get("message") or {}
        stop = data.get("done_reason") or ("stop" if data.get("done") else None)
        usage = {
            "input_tokens": data.get("prompt_eval_count"),
            "output_tokens": data.get("eval_count"),
        }
        return message.get("content"), stop, usage, data.get("model")

    async def _openai(self, rendered: dict, max_output_tokens: int, entry: dict):
        key = os.environ.get(self.rung.api_key_env or "")
        if not key:
            raise BridgeError("model_unavailable", "the hosted rung's key variable is unset")
        body = {
            "model": self.rung.model,
            "instructions": rendered["system"],
            "input": rendered["user"],
            "max_output_tokens": max_output_tokens,
            "store": False,
        }
        if self.rung.temperature is not None:
            body["temperature"] = self.rung.temperature
        schema = rendered["output_schema"]
        if isinstance(schema, dict) and schema.get("type") == "object":
            body["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": RESPONSE_FORMAT_NAME,
                    "schema": ollama_format(schema) or schema,
                    "strict": False,
                }
            }
        entry["think"] = None  # the Responses API takes no `think`
        response = await self._http().post(
            f"{self.rung.base_url.rstrip('/')}/v1/responses",
            json=body,
            headers={"Authorization": f"Bearer {key}"},
        )
        if response.status_code != 200:
            raise BridgeError("model_unavailable", f"OpenAI answered HTTP {response.status_code}")
        data = response.json()
        texts, refusal = [], False
        for item in data.get("output") or []:
            if item.get("type") != "message":
                continue
            for part in item.get("content") or []:
                if part.get("type") == "output_text":
                    texts.append(part.get("text") or "")
                elif part.get("type") == "refusal":
                    refusal = True
        status = data.get("status")
        incomplete = (data.get("incomplete_details") or {}).get("reason")
        stop = (
            "refusal"
            if refusal
            else "stop"
            if status == "completed"
            else ("length" if incomplete == "max_output_tokens" else incomplete or "incomplete")
        )
        usage_in = data.get("usage") or {}
        usage = {
            "input_tokens": usage_in.get("input_tokens"),
            "output_tokens": usage_in.get("output_tokens"),
        }
        return ("".join(texts) if texts else None), stop, usage, data.get("model")


def _sha(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode()).hexdigest()
