"""The trusted bridge between the agentpkg runtime and a host's tools.

    agentpkg runtime                    (Runtime.call_tool — the authority)
            |  ToolHandler protocol
            v
    agentpkg.toolbridge                 <- this package
            |  tool.call over the private JSONL execution protocol
            v
    OpenClaw plugin tool broker
            |  the one implementation the run plan bound
            v
    the exact approved tool

This namespace is the sibling of `agentpkg.hostbridge`, and it is separate for
the same reason that one is separate from `agentpkg.browser`: the control plane
decides *whether* a capability may be used and must stay structurally unable to
be the thing that uses one. `agentpkg.execution` is the only namespace allowed
to hold both this and an interpreter.

It contains no HTTP client, no socket, no URL, no credential, no provider name
and no service vocabulary of any kind. What it contains is one `ToolHandler`,
the bounded binding record that parameterizes it, and the stable error codes
both sides of the boundary share.
"""

from __future__ import annotations

from .binding import describe, normalize_tool_binding, normalize_tool_bindings
from .errors import TOOL_ERROR_CODES, ToolBridgeError
from .handler import (
    MAX_ARGS_BYTES,
    MAX_OUTPUT_BYTES,
    TOOL_CALL_METHOD,
    HostBridgeToolHandler,
    tool_handlers,
)

__all__ = [
    "MAX_ARGS_BYTES",
    "MAX_OUTPUT_BYTES",
    "TOOL_CALL_METHOD",
    "TOOL_ERROR_CODES",
    "HostBridgeToolHandler",
    "ToolBridgeError",
    "describe",
    "normalize_tool_binding",
    "normalize_tool_bindings",
    "tool_handlers",
]
