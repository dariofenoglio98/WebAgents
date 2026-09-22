"""The trusted bridge between the agentpkg runtime and a host's intelligence.

    agentpkg runtime                    (workflow.v0; a later milestone)
            |  ModelRouter protocol
            v
    agentpkg.hostbridge                 <- this package
            |  private JSONL over the stdio of a spawned child
            v
    OpenClaw plugin backend
            |  api.runtime.llm.complete
            v
    the exact model a run plan bound

This namespace is deliberately separate from `agentpkg.browser`. The control
plane opens, inspects and authorizes packages and must remain structurally
incapable of running one, so it never imports anything here. This package is
the other half of that boundary: it may spend model tokens, and therefore it
may only be reached with a run plan that a person already authorized.

It contains no workflow interpreter, no tool handler and no package execution
of any kind. What it contains is one `ModelRouter`, the wire contract that
carries it, and a single host-owned probe that proves the contract before any
package depends on it.
"""

from __future__ import annotations

from .errors import BridgeError, ProtocolError
from .peer import BridgePeer
from .probe import PROBE_OUTPUT_SCHEMA, PROBE_SCHEMA, build_request, run_probe
from .protocol import CHILD_METHODS, HOST_METHODS, PROTOCOL_VERSION
from .router import FRAMING_TOKEN_ALLOWANCE, ROUTER_ID, HostBridgeModelRouter
from .session import BridgeSession, serve

__all__ = [
    "CHILD_METHODS",
    "FRAMING_TOKEN_ALLOWANCE",
    "HOST_METHODS",
    "PROBE_OUTPUT_SCHEMA",
    "PROBE_SCHEMA",
    "PROTOCOL_VERSION",
    "ROUTER_ID",
    "BridgeError",
    "BridgePeer",
    "BridgeSession",
    "HostBridgeModelRouter",
    "ProtocolError",
    "build_request",
    "run_probe",
    "serve",
]
