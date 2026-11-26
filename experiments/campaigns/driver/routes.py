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

import asyncio
import contextvars
import copy
import json
import math
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
# The code `Py`'s route records for a call it could not complete for any reason but a read timeout
# (D-361's harness errors, `campaign.ROUTE_FAILURES`).
ROUTE_FAILED = "route_failed"


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


# D-361 as amended (T32 review 2, finding 3; the user's choice, 2026-11-19): on a hosted rung a
# 429 is waited out and the same call sent again, by one policy on every side (`Py`'s router
# below, the transport under `FW`'s OpenAI client, `Cr`'s Node transport, which receives these
# numbers in its job): the provider's `retry-after-ms` or `retry-after` (seconds) when given, else
# 2, 4, 8, 16, 32, 60 s (each wait capped at 60 s), at most 6 resends and 240 s of waiting per
# call; a 429 after that is the route's failure (a harness error). Every wait is recorded. A local
# rung never retries (its outage is `campaign.route_ready`'s, before the unit); no other status
# is retried.
RATE_LIMIT_RETRY = {
    "status": 429,
    "max_resends": 6,
    "max_total_seconds": 240.0,
    "base_seconds": 2.0,
    "max_wait_seconds": 60.0,
}


def rate_limit_final(headers, body: str | None) -> str | None:
    """Why a 429 must not be resent, or None (T32 review 3, carry-over 3; D-427): the provider marks
    it final (`x-should-retry: false`), or its error is a spent quota (`insufficient_quota`, which
    never clears by waiting). Such a 429 is the route's failure at once (a harness error)."""
    value = headers.get("x-should-retry") if headers is not None else None
    if isinstance(value, str) and value.strip().lower() == "false":
        return "x-should-retry: false"
    try:
        error = (json.loads(body or "") or {}).get("error") or {}
    except (ValueError, AttributeError):
        error = {}
    if isinstance(error, dict) and "insufficient_quota" in (error.get("code"), error.get("type")):
        return "insufficient_quota"
    return None


def rate_limit_wait(resends: int, headers, waited: float, body: str | None = None) -> float | None:
    """Seconds to wait before resend number `resends + 1` of a call answered 429, or None when the
    policy is spent (`waited`: the seconds this call already waited) or the 429 is final
    (`rate_limit_final`, read from the headers and the body)."""
    policy = RATE_LIMIT_RETRY
    if resends >= policy["max_resends"]:
        return None
    if rate_limit_final(headers, body) is not None:
        return None
    wait = None
    for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
        value = headers.get(name) if headers is not None else None
        try:
            parsed = float(value) * scale if value is not None else math.nan
        except ValueError:  # an HTTP date, or no number: the backoff
            parsed = math.nan
        if math.isfinite(parsed) and parsed >= 0:
            wait = parsed
            break
    if wait is None:
        wait = policy["base_seconds"] * 2**resends
    wait = min(wait, policy["max_wait_seconds"])
    if waited + wait > policy["max_total_seconds"]:
        return None
    return round(wait, 3)


# `FW`'s waits for the run in progress: each `FW` driver starts a fresh list (`rate_limit_log`)
# before its event loop, whose tasks inherit it, and records it as the run's `rate_limit_waits`.
RATE_LIMIT_WAITS: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    "campaign_rate_limit_waits", default=None
)


def rate_limit_log() -> list:
    waits: list = []
    RATE_LIMIT_WAITS.set(waits)
    return waits


def environment_proxy(host: str = "api.openai.com") -> str | None:
    """The proxy the environment names for an HTTPS request to `host`, read as httpx reads it for
    `Py`'s router (T32b review 1, nit 12): `HTTPS_PROXY`, else `ALL_PROXY`; `NO_PROXY` honoured; a
    proxy given without a scheme is `http://`."""
    import urllib.request

    proxies = urllib.request.getproxies()
    proxy = proxies.get("https") or proxies.get("all")
    if not proxy or urllib.request.proxy_bypass(host):
        return None
    return proxy if "://" in proxy else f"http://{proxy}"


def environment_transport() -> httpx.AsyncBaseTransport:
    """The inner transport of `FW`'s hosted client with the proxy the environment names, as an
    httpx client with its own transport would otherwise ignore it (T32 review 3, nit (f); `Py`'s
    router uses an httpx client that reads it)."""
    proxy = environment_proxy()
    return httpx.AsyncHTTPTransport(proxy=proxy) if proxy else httpx.AsyncHTTPTransport()


class RateLimitRetryTransport(httpx.AsyncBaseTransport):
    """`FW`'s side of the policy: under the OpenAI client (`max_retries=0`), a 429 is waited out and
    the same request sent again; every wait (seconds) goes to `waits` when given, else to the run's
    `RATE_LIMIT_WAITS`."""

    def __init__(self, inner: httpx.AsyncBaseTransport | None = None, *, waits=None, sleep=None):
        self.inner = inner or environment_transport()
        self._waits = waits
        self._sleep = sleep or asyncio.sleep

    def _record(self, wait: float) -> None:
        log = self._waits if self._waits is not None else RATE_LIMIT_WAITS.get()
        if log is None:  # T32 review 3, nit (c): a driver that never opened the run's log
            raise RuntimeError(
                "a 429 wait with no rate-limit log: the driver must call rate_limit_log() "
                "before its event loop"
            )
        log.append(wait)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        resends, waited = 0, 0.0
        while True:
            response = await self.inner.handle_async_request(request)
            if response.status_code != RATE_LIMIT_RETRY["status"]:
                return response
            body = (await response.aread()).decode("utf-8", "replace")
            wait = rate_limit_wait(resends, response.headers, waited, body)
            if wait is None:
                return response
            await response.aclose()
            self._record(wait)
            await self._sleep(wait)
            resends, waited = resends + 1, waited + wait

    async def aclose(self) -> None:
        await self.inner.aclose()


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
        except httpx.ReadTimeout as exc:
            # A model too slow for the shared deadline: the run's own failure (D-361).
            entry["error"] = "ReadTimeout"
            raise BridgeError("model_unavailable", "route failed: ReadTimeout") from exc
        except Exception as exc:  # noqa: BLE001 - every other failure of the route is the route's
            # A transport failure, or a 200 that is not the provider's JSON (a tunnel's HTML
            # page, a shape this router does not read): the route is unavailable, as the bridge
            # records it (review 1, nit 16). The route's own code, which D-361's rule lists, and
            # the exception's class for the reader (T32 review 2, finding 4).
            entry["error"] = ROUTE_FAILED
            entry["exception"] = type(exc).__name__
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

    async def aclose(self) -> None:
        """Close the running loop's client and its keep-alive connections; called by the driver at
        the end of the run or conversation, inside its loop (T31b review 1, finding 3). A client a
        foreign loop opened is dropped, never awaited here (T31b review 2, nit 1)."""
        import asyncio

        client, loop = self._client, self._client_loop
        self._client, self._client_loop = None, None
        if client is not None and loop is asyncio.get_running_loop():
            await client.aclose()

    async def closing(self, work):
        """Await `work` (a run or a conversation), then close the client in the same loop; a close
        error never masks the run's own exception (T31b review 2, nit 1)."""
        try:
            result = await work
        except BaseException:
            try:
                await self.aclose()
            except Exception:  # noqa: BLE001 - the run's own exception is the one to report
                pass
            raise
        await self.aclose()
        return result

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
            entry["status"] = response.status_code
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
        resends, waited = 0, 0.0
        while True:
            response = await self._http().post(
                f"{self.rung.base_url.rstrip('/')}/v1/responses",
                json=body,
                headers={"Authorization": f"Bearer {key}"},
            )
            if response.status_code != RATE_LIMIT_RETRY["status"]:
                break
            wait = rate_limit_wait(resends, response.headers, waited, response.text)
            if wait is None:
                final = rate_limit_final(response.headers, response.text)
                if final is not None:
                    entry["rate_limit_final"] = final
                break
            entry.setdefault("rate_limit_waits", []).append(wait)
            await asyncio.sleep(wait)
            resends, waited = resends + 1, waited + wait
        if response.status_code != 200:
            entry["status"] = response.status_code
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
