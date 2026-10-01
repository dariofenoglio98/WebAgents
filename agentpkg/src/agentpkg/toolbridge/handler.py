"""A `ToolHandler` whose implementation is the exact binding a run plan froze.

This is the only place where the generic runtime contract in
`agentpkg.interfaces.ToolHandler` meets a concrete host. It stays completely
service-neutral: it never names a provider, a service, an index, a domain or
an API shape, holds no credential, and performs no I/O of its own.
Everything service-shaped — the request, the transport, authentication, the
response contract — happens on the other side of the bridge, inside the
trusted host.

What the handler sends is deliberately small:

    {"tool_id": "<declared id>", "binding_id": "<the plan's binding>",
     "binding_sha256": "<the plan's digest>", "args": {…}}

There is no URL, no method, no header, no command and no host method name in
that frame, because there is nowhere for one to go. The host resolves the
triple against the bindings *it* holds for *this* run, and refuses anything
else. A package that could name its own destination would not be a package
declaring a capability; it would be a package holding one.

Four obligations deserve their reasoning in one place.

**The runtime remains the authority.** `Runtime.call_tool` has already checked
the role allowlist, the permission grants, the explicit tool approval, the
per-tool and remote-call budgets, and the package's own input schema before
this handler is reached, and it validates the result against the package's own
output schema afterwards. This handler adds defence in depth on the way out and
the way back; it replaces none of it.

**Nothing unbounded leaves.** Arguments are canonicalized and size-checked
before a frame is written, so a package that constructs a pathological document
fails locally rather than at someone else's server.

**The answer is checked before it is believed.** The host's envelope is a
closed field set, its binding identity must echo the one this handler holds,
and its payload must be finite JSON. The package's own output schema is then
applied by `Runtime`, which is a second, independent check against a service
that may be wrong, changed, or lying.

**Cancellation reaches the request.** An awaited call that is cancelled sends
`$/cancel` for that exact id, which the host turns into an `AbortSignal` on the
in-flight request. A workflow that stops does not leave a paid request running.
"""

from __future__ import annotations

import json
import time
from typing import Any

from .binding import describe, normalize_tool_bindings
from .errors import (
    TOOL_BROKER_UNAVAILABLE,
    TOOL_RESPONSE_INVALID,
    TOOL_TIMEOUT,
    ToolBridgeError,
    invalid,
)
from .facts import safe_tool_facts

TOOL_CALL_METHOD = "tool.call"

# One tool call's arguments are a request, not a data transfer. The package's
# own input schema is the real bound; this stops a pathological document before
# it is canonicalized into a frame.
MAX_ARGS_BYTES = 64 * 1024
# The host bounds its own response too; this is the frame-side ceiling.
MAX_OUTPUT_BYTES = 512 * 1024
# Added to the tool's own deadline when waiting for the host's answer, so the
# runtime's `asyncio.timeout` around the handler is what fires first and the
# failure is attributed to the tool rather than to the bridge.
BRIDGE_GRACE_SECONDS = 15.0
DEFAULT_TIMEOUT_SECONDS = 60.0


def _canonical(value: Any) -> str:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
    except (TypeError, ValueError) as exc:
        raise invalid(f"Tool arguments are not finite JSON: {exc}") from exc


class HostBridgeToolHandler:
    """`ToolHandler` backed by the exact implementation one run plan bound."""

    def __init__(self, peer, binding: dict, *, timeout_seconds: float | None = None):
        self._peer = peer
        self.binding = binding
        self.tool_id = binding["tool_id"]
        self.remote = binding["remote"]
        declared = binding.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS
        self.timeout = float(timeout_seconds or declared)
        # Evidence for a probe or run report; never used to decide anything.
        self.calls: list[dict] = []

    def describe(self) -> dict:
        return describe(self.binding)

    async def __call__(self, context, payload):
        args = _canonical(payload)
        if len(args.encode("utf-8")) > MAX_ARGS_BYTES:
            raise invalid(
                f"Tool arguments exceed {MAX_ARGS_BYTES} canonical bytes",
                tool_id=self.tool_id,
            )
        started = time.monotonic()
        # Operational provenance, in the runtime's own hash-chained audit. The
        # binding identity is the fact that matters: it says which of the host's
        # implementations this call was attributed to.
        context.event(
            "tool.dispatched",
            tool=self.tool_id,
            binding_id=self.binding["binding_id"],
            binding_sha256=self.binding["binding_sha256"],
            implementation_kind=self.binding["implementation_kind"],
            implementation_version=self.binding["implementation_version"],
            remote=self.remote,
            endpoint_origin=self.binding["endpoint_origin"],
            method=self.binding["method"],
        )
        try:
            answer = await self._peer.call(
                TOOL_CALL_METHOD,
                {
                    "tool_id": self.tool_id,
                    "binding_id": self.binding["binding_id"],
                    "binding_sha256": self.binding["binding_sha256"],
                    "args": payload,
                },
                timeout=self.timeout + BRIDGE_GRACE_SECONDS,
            )
        except ToolBridgeError:
            raise
        except TimeoutError as exc:
            raise ToolBridgeError(
                TOOL_TIMEOUT,
                "The host did not answer this tool call in time",
                audit_facts={"stage": "timeout", "timeout": True},
            ) from exc
        except Exception as exc:
            code = getattr(exc, "code", None)
            detail = getattr(exc, "detail", None)
            # A stable refusal from the host keeps its own code; anything else
            # is a broken bridge rather than a refused tool.
            raise ToolBridgeError(
                code
                if isinstance(code, str) and code.startswith("tool_")
                else TOOL_BROKER_UNAVAILABLE,
                "The host refused or failed this tool call",
                audit_facts=safe_tool_facts(
                    detail.get("failure_facts") if isinstance(detail, dict) else None
                ),
            ) from exc
        output = self._settle(answer)
        duration = round((time.monotonic() - started) * 1000, 3)
        context.event(
            "tool.settled",
            tool=self.tool_id,
            binding_id=self.binding["binding_id"],
            remote=self.remote,
            status="ok",
            duration_ms=duration,
            transport_status=answer.get("transport_status"),
        )
        if len(self.calls) < 512:
            self.calls.append(
                {
                    "tool_id": self.tool_id,
                    "binding_id": self.binding["binding_id"],
                    "binding_sha256": self.binding["binding_sha256"],
                    "remote": self.remote,
                    "duration_ms": duration,
                    "transport_status": answer.get("transport_status"),
                    "host_duration_ms": answer.get("duration_ms"),
                }
            )
        return output

    def _settle(self, answer: dict):
        """Check the host's envelope before anything downstream believes it."""
        if not isinstance(answer, dict):
            raise ToolBridgeError(TOOL_RESPONSE_INVALID, "The host returned no tool result")
        allowed = {
            "status",
            "output",
            "tool_id",
            "binding_id",
            "binding_sha256",
            "remote",
            "duration_ms",
            "transport_status",
        }
        unknown = sorted(set(answer) - allowed)
        if unknown:
            raise ToolBridgeError(
                TOOL_RESPONSE_INVALID, f"The host tool result carries unknown fields: {unknown}"
            )
        if answer.get("status") != "ok":
            raise ToolBridgeError(
                TOOL_RESPONSE_INVALID, "The host tool result is not a completed call"
            )
        if (
            answer.get("tool_id") != self.tool_id
            or answer.get("binding_id") != self.binding["binding_id"]
            or answer.get("binding_sha256") != self.binding["binding_sha256"]
        ):
            # A result attributed to a different implementation is not a
            # degraded answer, it is a different decision.
            raise ToolBridgeError(
                "tool_binding_stale",
                "The host answered from an implementation other than the one this plan bound",
                detail={"expected_binding_id": self.binding["binding_id"]},
            )
        if answer.get("remote") is not self.remote:
            raise ToolBridgeError(
                "tool_contract_mismatch",
                "The host reports a different execution locality than the plan bound",
            )
        if "output" not in answer:
            raise ToolBridgeError(TOOL_RESPONSE_INVALID, "The host tool result carries no output")
        output = answer["output"]
        try:
            encoded = json.dumps(output, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ToolBridgeError(
                TOOL_RESPONSE_INVALID, "The host tool result is not finite JSON"
            ) from exc
        if len(encoded.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise ToolBridgeError(
                TOOL_RESPONSE_INVALID,
                f"The host tool result exceeds {MAX_OUTPUT_BYTES} bytes",
            )
        return output


def tool_handlers(peer, bindings, *, timeout_seconds: float | None = None) -> dict:
    """Build one handler per bound tool, keyed the way `Runtime` looks them up.

    `Runtime.handlers` is keyed by the package tool's own `binding` name, which
    is the abstract capability the package asked for. The value is the host's
    answer to that request. Keeping the key abstract is what stops a package
    name from selecting an implementation.
    """
    normalized = normalize_tool_bindings(bindings)
    handlers: dict[str, HostBridgeToolHandler] = {}
    for binding in normalized:
        name = binding["binding_name"]
        if name in handlers:
            raise ToolBridgeError(
                "tool_binding_ambiguous", "Two tools may not share one binding name"
            )
        handlers[name] = HostBridgeToolHandler(peer, binding, timeout_seconds=timeout_seconds)
    return handlers


__all__ = [
    "BRIDGE_GRACE_SECONDS",
    "MAX_ARGS_BYTES",
    "MAX_OUTPUT_BYTES",
    "TOOL_CALL_METHOD",
    "HostBridgeToolHandler",
    "tool_handlers",
]
