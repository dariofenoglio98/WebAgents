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
import re
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
# Per-call evidence a report can carry back. A run bounded by token budgets
# cannot approach this; it exists so the list cannot grow without a bound.
MAX_RECORDED_INVOCATIONS = 512
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
# Said in words when the answer is a closed object, because the schema cannot
# always be relied on to constrain decoding. A host may drop the constrained
# response format without saying so — OpenClaw 2026.9.5 does on its native
# Codex Responses backend — and a model then sees the schema only as text.
# Measured there on the Literature Review screen node, the one recurring
# failure was an extra top-level property (an input field copied into the
# answer); naming the closed top-level set removed it. It says nothing about
# nested objects on purpose: a stronger "anywhere" warning did no better on
# screen and was not better on a copy-heavy node either. Validation is
# unchanged: this is a clearer request, not a looser check.
_CLOSED_ROOT_CONTRACT = (
    "It is one JSON object with exactly these top-level properties and no others: {names}."
)
# Only schema-declared names that read as plain identifiers are listed, and only
# a bounded number; anything else keeps the generic contract alone.
_LISTABLE_PROPERTY = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}")
MAX_LISTED_PROPERTIES = 64
_LOCAL_DEFS_REF = re.compile(r"#/\$defs/([^/]+)")


def closed_root_properties(schema) -> list[str] | None:
    """The exact top-level property names of a closed object root, or None.

    Follows one local `#/$defs/<name>` root reference, which is the shape
    `Workflow._model_schema` bundles every node schema into. A root that is not
    an object, is open (`additionalProperties` not `false`), or declares names
    that are not plain identifiers is left to the schema alone.
    """
    root = schema
    if isinstance(schema, dict) and isinstance(schema.get("$ref"), str):
        match = _LOCAL_DEFS_REF.fullmatch(schema["$ref"])
        defs = schema.get("$defs")
        if not match or not isinstance(defs, dict):
            return None
        root = defs.get(match.group(1))
    if not isinstance(root, dict) or root.get("type") != "object":
        return None
    if root.get("additionalProperties") is not False:
        return None
    properties = root.get("properties")
    if not isinstance(properties, dict) or not 0 < len(properties) <= MAX_LISTED_PROPERTIES:
        return None
    names = list(properties)
    if not all(isinstance(name, str) and _LISTABLE_PROPERTY.fullmatch(name) for name in names):
        return None
    return names


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
    contract = _OUTPUT_CONTRACT
    names = closed_root_properties(schema)
    if names:
        contract += " " + _CLOSED_ROOT_CONTRACT.format(names=", ".join(names))
    sections.append(f"## Output contract\n{contract}\n\n{schema_text}")
    feedback = request.get("feedback")
    if feedback is not None:
        # A host's re-ask (spec section 7): one line naming why the previous answer was not
        # accepted. It is part of the system text, so the count below includes it.
        if not isinstance(feedback, str) or not feedback:
            raise BridgeError("model_request_invalid", "Request feedback must be a nonempty string")
        sections.append(f"## Correction\n{feedback}")
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


# How the host's normalized stop reason reads. `stop` — or no stop reason at
# all, from a host that does not report one — is a turn the provider finished,
# and only such a turn's text is parsed. Everything else is a turn it did not
# finish, and is classified here rather than handed to the parser, where a cut
# or empty answer would be indistinguishable from a model ignoring the schema.
STOP_COMPLETE = "stop"
STOP_LENGTH = "length"
MAX_SCHEMA_LOCATION_PARTS = 8


def classify_termination(stop_reason) -> tuple[str, str] | None:
    """The failure a non-finished turn is, or None for a finished one.

    `length` is an answer cut off at the output limit. Any other reason is a
    turn the provider did not complete: OpenClaw 2026.9.5 reports `error` for a
    provider error, a refusal and a content filter alike (it does not tell them
    apart to a plugin), `aborted` for an abort, and `toolUse` would mean a tool
    call this adapter never offered. None of these is retried here or anywhere
    else, and none is reported as non-conforming output.
    """
    if stop_reason is None or stop_reason == STOP_COMPLETE:
        return None
    if stop_reason == STOP_LENGTH:
        return (
            "model_output_truncated",
            "The model stopped at its output limit before the answer was complete",
        )
    return (
        "model_turn_failed",
        "The provider did not complete this turn (an error, a refusal or a content filter)",
    )


def _reported_counts(report) -> dict:
    """The host's usage report as audit facts, or nothing if it is unusable."""
    try:
        usage = project_usage(report)
    except BridgeError:
        return {}
    return {
        "reported_input_tokens": usage["input_tokens"],
        "reported_output_tokens": usage["output_tokens"],
    }


def _schema_location(error: JsonValidationError) -> str:
    """Where in the *schema* validation failed — never where in the output."""
    parts = [str(part) for part in error.schema_path][-MAX_SCHEMA_LOCATION_PARTS:]
    return "/".join(parts) or "#"


def _count(value, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise BridgeError("model_usage_invalid", f"Host reported an invalid {field}")
    return value


def _reported(usage: dict, field: str) -> int | None:
    """A count the host reported (validated), or None when it reported none."""
    value = usage.get(field)
    return None if value is None else _count(value, field)


def project_usage(usage: dict) -> dict:
    """Map the host's usage report onto the two numbers the contract requires.

    `input_tokens` is every billable prompt token, including cache reads and
    writes, because the runtime's reservation covers what the call costs rather
    than what a provider discounts. `output_tokens` absorbs any difference
    between the host's aggregate total and its own breakdown, which is where an
    unreported reasoning charge would otherwise disappear.

    A count the host did not report is not a count of zero. The charge must be
    established by the report itself: by an aggregate total, or by both the
    input and the output count. A report that establishes neither is refused
    (`model_usage_unavailable`), so `Runtime.call_model` charges the call's
    whole reservation instead of an undercount.
    """
    if not isinstance(usage, dict):
        raise BridgeError("model_usage_unavailable", "The host reported no usage")
    read = _reported(usage, "cache_read_tokens") or 0
    write = _reported(usage, "cache_write_tokens") or 0
    reported_input = _reported(usage, "input_tokens")
    reported_output = _reported(usage, "output_tokens")
    total = _reported(usage, "total_tokens")
    if total is None and (reported_input is None or reported_output is None):
        raise BridgeError(
            "model_usage_unavailable",
            "The host reported neither a total nor both input and output tokens for this "
            "completion, so it cannot be accounted for",
        )
    prompt = (reported_input or 0) + read + write
    output = reported_output or 0
    if total is not None and total > prompt + output:
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
        # Evidence for a probe or run report; never used to decide anything.
        self.last_count: dict | None = None
        self.last_completion: dict | None = None
        # One entry per completed call, so a multi-call run can show which model
        # answered each time rather than asserting it once.
        self.invocations: list[dict] = []

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
        stop_reason = answer.get("stop_reason")
        # Structural facts only: what the host said about how the turn ended and
        # what it cost. They reach the audit so a failure can be classified from
        # the record instead of reproduced; no text the model wrote is among them.
        facts = {
            **(
                {"stop_reason": stop_reason}
                if isinstance(stop_reason, str)
                else {"stop_reason": "unreported"}
            ),
            **_reported_counts(answer.get("usage")),
        }
        termination = classify_termination(stop_reason)
        if termination is not None:
            raise BridgeError(*termination, audit_facts=facts)
        text = answer.get("text")
        if not isinstance(text, str):
            raise BridgeError(
                "model_output_not_conforming",
                "The host returned no text",
                audit_facts={**facts, "output_failure": "no_text"},
            )
        usage = project_usage(answer.get("usage"))
        try:
            output, parse_mode = parse_structured(text)
        except BridgeError as exc:
            exc.audit_facts = {**facts, "output_failure": "not_json"}
            raise
        validator = Draft202012Validator(rendered["output_schema"])
        try:
            validator.validate(output)
        except JsonValidationError as exc:
            raise BridgeError(
                "model_output_not_conforming",
                f"The model output does not satisfy the requested schema: {exc.message[:200]}",
                audit_facts={
                    **facts,
                    "output_failure": "schema",
                    "schema_keyword": str(exc.validator),
                    "schema_location": _schema_location(exc),
                    "schema_violations": sum(1 for _ in validator.iter_errors(output)),
                },
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
        if len(self.invocations) < MAX_RECORDED_INVOCATIONS:
            self.invocations.append(
                {
                    "model_id": invoked,
                    "provider_id": answer.get("provider_id"),
                    "response_model": answer.get("response_model"),
                    "constrained_by_host": answer.get("constrained") is True,
                    "count_basis": (self.last_count or {}).get("basis"),
                    "input_tokens": usage["input_tokens"],
                    "output_tokens": usage["output_tokens"],
                    "cost_usd": usage["cost_usd"],
                }
            )
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
    "classify_termination",
    "closed_root_properties",
    "context_window_for",
    "parse_structured",
    "project_usage",
    "render",
    "token_upper_bound",
]
