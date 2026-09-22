"""A `ModelRouter` whose intelligence is the exact model a run plan bound.

This is the only place where the generic runtime contract in
`agentpkg.interfaces.ModelRouter` meets a concrete host. It stays completely
provider-neutral: it never names OpenAI, Anthropic, Meta or any other vendor,
holds no credential, and performs no network I/O. Everything provider-shaped —
authentication, the model route, the constrained-output request format, usage
reporting — happens on the other side of the bridge, inside OpenClaw.

Four obligations of the contract deserve their reasoning in one place.

**Exact model binding.** The router is constructed from one run plan's
`model_binding` and carries that host model id. The host is told nothing about
which model to use; it holds the same binding and refuses any other. After a
completion the router compares the provider/model the host reports with the
binding and fails closed with `selected_model_unavailable` rather than return
output from a model the person did not choose.

**Capabilities are what this adapter delivers, not what a catalog claims.**
`structured_output` is declared because this adapter obtains it: it asks for a
constrained response, then parses and schema-validates before returning, in one
bounded attempt. `reasoning` is declared only when the bound model's own host
descriptor declares it. `tool_use` and `multimodal` are never declared: this
adapter exposes no tools and sends no non-text content, so claiming either
would be false.

**`count_tokens` must be a safe upper bound**, because `Runtime.call_model`
reserves against it and treats `actual_input > bound` as a fatal router
contract violation. The host is asked first; OpenClaw 2026.9.5 answers that it
has no tokenizer surface (its own internal estimate is `chars / 4` and
documented as approximate, which is *not* an upper bound). The router then
falls back to a bound that is provable rather than fitted:

    tokens(text) <= utf8_bytes(text)

Every production subword tokenizer — byte-level BPE and SentencePiece alike —
has a vocabulary whose entries each decode to at least one byte, so N tokens
decode to at least N bytes and a text of B bytes cannot exceed B tokens. The
bound therefore counts the UTF-8 bytes of the exact system text, the exact user
text, and the output schema a second time for the provider's own copy of it in
the constrained-output request, plus a fixed allowance for chat-template
framing the provider adds around those messages. Nothing the adapter sends is
left out of the count.

**Usage must be actual and complete.** `input_tokens` is every billable prompt
token the host reports, cache reads and writes included, not the cache-adjusted
subset. `output_tokens` is raised to `total - prompt` when the host's aggregate
total exceeds its own breakdown, so unreported reasoning tokens are charged
rather than hidden. A host that reports no usable counts fails instead of
guessing, and `Runtime` then charges the full reservation.
"""

from __future__ import annotations

import json
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError as JsonValidationError

from .errors import BridgeError

ROUTER_ID = "openclaw.host-bridge.v0"

# Tokens allowed for everything the provider adds around the two messages this
# adapter sends: role markers, message and turn delimiters, BOS/EOS, and the
# envelope around a JSON-schema response format. Real chat templates spend
# single-digit tokens per message; this is deliberately orders of magnitude
# above that, because over-reserving rejects a request while under-reserving
# would corrupt the runtime's accounting invariant.
FRAMING_TOKEN_ALLOWANCE = 512

# Guards on what comes back from the host before it is parsed.
MAX_COMPLETION_TEXT_BYTES = 4 * 1024 * 1024
MAX_EXTRACTION_DEPTH = 256

CAPABILITY_STRUCTURED_OUTPUT = "structured_output"
CAPABILITY_REASONING = "reasoning"

_PREAMBLE = (
    "You are a bounded execution step inside a host agent runtime. You are given "
    "instructions and one JSON input document, and you return one JSON output "
    "document. You have no tools, no network access and no memory between calls."
)
_OUTPUT_CONTRACT = (
    "Return exactly one JSON document that validates against the JSON Schema "
    "below. Emit the JSON document alone: no prose before or after it, no "
    "explanation, no markdown code fence."
)


def _canonical(value: Any) -> str:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def _utf8(text: str) -> int:
    return len(text.encode("utf-8"))


def render(request: dict) -> dict:
    """The exact wire content this adapter will send, as a pure function.

    Purity is the point: `count_tokens` and `complete` render independently and
    are guaranteed to agree, so nothing the model sees escapes the count.
    """
    instructions = request.get("instructions") or []
    if not isinstance(instructions, list) or any(not isinstance(i, str) for i in instructions):
        raise BridgeError("model_request_invalid", "Request instructions must be strings")
    schema = request.get("output_schema")
    if not isinstance(schema, (dict, bool)):
        raise BridgeError("model_request_invalid", "Request output_schema must be a schema")
    schema_text = _canonical(schema)
    sections = [_PREAMBLE, f"## Task\n{request.get('task', '')}"]
    if instructions:
        sections.append("## Instructions\n" + "\n\n---\n\n".join(instructions))
    sections.append(f"## Output contract\n{_OUTPUT_CONTRACT}\n\n{schema_text}")
    return {
        "system": "\n\n".join(sections),
        "user": _canonical(request.get("data")),
        "output_schema": schema,
        "schema_text": schema_text,
    }


def token_upper_bound(rendered: dict) -> int:
    """A provable ceiling on the prompt tokens this request can cost.

    See the module docstring for why `tokens <= utf8_bytes` holds for every
    production subword tokenizer, and what the fixed allowance covers.
    """
    return (
        _utf8(rendered["system"])
        + _utf8(rendered["user"])
        + _utf8(rendered["schema_text"])
        + FRAMING_TOKEN_ALLOWANCE
    )


def _balanced(text: str, start: int) -> str | None:
    """Return the first complete JSON value beginning at `start`, or None."""
    opening = text[start]
    closing = {"{": "}", "[": "]"}[opening]
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == opening:
            depth += 1
            if depth > MAX_EXTRACTION_DEPTH:
                return None
        elif char == closing:
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def parse_structured(text: str) -> tuple[Any, str]:
    """One bounded attempt to read the model's answer as a JSON document.

    Three readings, in decreasing order of how well the model followed the
    contract, and then failure. There is deliberately no repair loop: a second
    model call to fix the first one would spend tokens the runtime already
    reserved against a single completion.
    """
    if _utf8(text) > MAX_COMPLETION_TEXT_BYTES:
        raise BridgeError("model_output_too_large", "The model returned an oversized response")
    stripped = text.strip()
    if not stripped:
        raise BridgeError("model_output_not_conforming", "The model returned no output")
    try:
        return json.loads(stripped), "direct"
    except ValueError:
        pass
    if stripped.startswith("```"):
        body = stripped[3:]
        if body[:4].lower().startswith("json"):
            body = body[4:]
        end = body.rfind("```")
        if end > 0:
            try:
                return json.loads(body[:end].strip()), "fenced"
            except ValueError:
                pass
    for index, char in enumerate(stripped):
        if char in "{[":
            candidate = _balanced(stripped, index)
            if candidate is not None:
                try:
                    return json.loads(candidate), "extracted"
                except ValueError:
                    pass
            break
    raise BridgeError(
        "model_output_not_conforming", "The model did not return a single JSON document"
    )


def _count(value, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise BridgeError("model_usage_invalid", f"Host reported an invalid {field}")
    return value


def project_usage(usage: dict) -> dict:
    """Map the host's usage report onto the two numbers the contract requires.

    `input_tokens` is every billable prompt token, including cache reads and
    writes, because the runtime's reservation covers what the call costs rather
    than what a provider discounts. `output_tokens` absorbs any difference
    between the host's aggregate total and its own breakdown, which is where an
    unreported reasoning charge would otherwise disappear.
    """
    if not isinstance(usage, dict):
        raise BridgeError("model_usage_unavailable", "The host reported no usage")
    read = _count(usage.get("cache_read_tokens", 0) or 0, "cache_read_tokens")
    write = _count(usage.get("cache_write_tokens", 0) or 0, "cache_write_tokens")
    prompt = _count(usage.get("input_tokens", 0) or 0, "input_tokens") + read + write
    output = _count(usage.get("output_tokens", 0) or 0, "output_tokens")
    total = usage.get("total_tokens")
    if total is not None:
        total = _count(total, "total_tokens")
        if total > prompt + output:
            output = total - prompt
    if prompt == 0 and output == 0:
        raise BridgeError(
            "model_usage_unavailable",
            "The host reported no token usage for this completion, so it cannot be accounted for",
        )
    cost = usage.get("cost_usd")
    if cost is not None and (isinstance(cost, bool) or not isinstance(cost, (int, float))):
        raise BridgeError("model_usage_invalid", "Host reported an invalid cost_usd")
    return {
        "input_tokens": prompt,
        "output_tokens": output,
        "cost_usd": float(cost) if cost is not None else None,
        "reported": {
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "cache_read_tokens": usage.get("cache_read_tokens"),
            "cache_write_tokens": usage.get("cache_write_tokens"),
            "total_tokens": usage.get("total_tokens"),
            "cost_usd": cost,
        },
    }


def capabilities_for(binding: dict) -> frozenset[str]:
    """What this adapter can actually deliver for one bound model."""
    declared = {CAPABILITY_STRUCTURED_OUTPUT}
    answer = (binding.get("capabilities") or {}).get(CAPABILITY_REASONING) or {}
    if answer.get("value") is True:
        declared.add(CAPABILITY_REASONING)
    return frozenset(declared)


def context_window_for(binding: dict) -> int:
    limits = binding.get("limits") or {}
    for field in ("context_tokens", "native_context_window"):
        value = limits.get(field)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    raise BridgeError(
        "model_context_window_unknown",
        "The host reports no context window for the selected model, so no request can be "
        "bounded against it",
    )


class HostBridgeModelRouter:
    """`ModelRouter` backed by the exact model one run plan bound."""

    router_id = ROUTER_ID
    domains = ()

    def __init__(self, peer, binding: dict, *, request_timeout_seconds: float = 120.0):
        self._peer = peer
        self._binding = binding
        self.model_id = binding["host_model_id"]
        self.provider_id = binding.get("provider_id")
        # Unknown locality is treated as remote: a package that demands a
        # local-only router must not be satisfied by a host that never said so.
        self.remote = (binding.get("properties") or {}).get("local") is not True
        self.capabilities = capabilities_for(binding)
        self.context_window = context_window_for(binding)
        self.timeout = request_timeout_seconds
        # Evidence for the probe report; never used to decide anything.
        self.last_count: dict | None = None
        self.last_completion: dict | None = None

    def describe(self) -> dict:
        return {
            "router_id": self.router_id,
            "model_id": self.model_id,
            "provider_id": self.provider_id,
            "remote": self.remote,
            "capabilities": sorted(self.capabilities),
            "context_window": self.context_window,
            "not_declared": ["multimodal", "tool_use"],
            "note": (
                "Capabilities describe what this adapter delivers. tool_use is withheld "
                "because the adapter exposes no tools to the model, and multimodal because "
                "it sends text only."
            ),
        }

    async def count_tokens(self, request: dict) -> int:
        rendered = render(request)
        answer = await self._peer.call(
            "model.count_tokens",
            {
                "system": rendered["system"],
                "user": rendered["user"],
                "output_schema": rendered["output_schema"],
            },
            timeout=self.timeout,
        )
        if answer.get("supported") is True:
            exact = answer.get("input_tokens")
            if isinstance(exact, bool) or not isinstance(exact, int) or exact < 0:
                raise BridgeError("model_usage_invalid", "Host returned an invalid token count")
            basis = "host_tokenizer"
            bound = exact
        else:
            basis = "utf8_upper_bound"
            bound = token_upper_bound(rendered)
        self.last_count = {
            "bound": bound,
            "basis": basis,
            "host_tokenizer": answer.get("supported") is True,
            "host_detail": answer.get("detail"),
            "framing_allowance": FRAMING_TOKEN_ALLOWANCE if basis == "utf8_upper_bound" else 0,
            "counted_bytes": {
                "system": _utf8(rendered["system"]),
                "user": _utf8(rendered["user"]),
                "output_schema": _utf8(rendered["schema_text"]),
            },
        }
        return bound

    async def complete(self, request: dict, *, max_output_tokens: int) -> dict:
        if isinstance(max_output_tokens, bool) or not isinstance(max_output_tokens, int):
            raise BridgeError("model_request_invalid", "max_output_tokens must be an integer")
        if max_output_tokens <= 0:
            raise BridgeError("model_request_invalid", "max_output_tokens must be positive")
        rendered = render(request)
        params = {
            "system": rendered["system"],
            "user": rendered["user"],
            "output_schema": rendered["output_schema"],
            "max_output_tokens": max_output_tokens,
        }
        if CAPABILITY_REASONING in self.capabilities:
            params["reasoning"] = "low"
        answer = await self._peer.call("model.complete", params, timeout=self.timeout)
        invoked = answer.get("model_id")
        if invoked != self.model_id:
            # The plan bound one model. Anything else is not a degraded result,
            # it is a different decision, and it is refused after the fact just
            # as it would have been before.
            raise BridgeError(
                "selected_model_unavailable",
                "The host completed with a model other than the one the run plan bound",
                detail={"expected": self.model_id, "invoked": invoked},
            )
        text = answer.get("text")
        if not isinstance(text, str):
            raise BridgeError("model_output_not_conforming", "The host returned no text")
        usage = project_usage(answer.get("usage"))
        output, parse_mode = parse_structured(text)
        try:
            Draft202012Validator(rendered["output_schema"]).validate(output)
        except JsonValidationError as exc:
            raise BridgeError(
                "model_output_not_conforming",
                f"The model output does not satisfy the requested schema: {exc.message[:200]}",
            ) from exc
        self.last_completion = {
            "model_id": invoked,
            "provider_id": answer.get("provider_id"),
            "response_model": answer.get("response_model"),
            "stop_reason": answer.get("stop_reason"),
            "execution": answer.get("execution"),
            "constrained_by_host": answer.get("constrained") is True,
            "constraint_detail": answer.get("constraint_detail"),
            "parse": parse_mode,
            "max_output_tokens": max_output_tokens,
            "usage": usage,
        }
        result = {
            "output": output,
            "input_tokens": usage["input_tokens"],
            "output_tokens": usage["output_tokens"],
        }
        if usage["cost_usd"] is not None:
            result["cost_usd"] = usage["cost_usd"]
        return result


__all__ = [
    "FRAMING_TOKEN_ALLOWANCE",
    "ROUTER_ID",
    "HostBridgeModelRouter",
    "capabilities_for",
    "context_window_for",
    "parse_structured",
    "project_usage",
    "render",
    "token_upper_bound",
]
