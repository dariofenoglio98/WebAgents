"""Stable, machine-readable tool-broker failures.

Codes are the contract. A caller branches on `code`, never on prose, and no
message ever carries a credential, a header, a URL the caller did not already
know, a provider body or a package payload.

The same vocabulary is used on both sides of the boundary — by the trusted host
when it refuses to dispatch, and by the execution runner when it refuses to
ask — so an operator reading either one sees the same word for the same fact.
"""

from __future__ import annotations

from ..hostbridge.errors import BridgeError


class ToolBridgeError(BridgeError):
    """One refused or failed tool operation with a stable code."""


# The package asked for something it never declared, or the host never bound.
TOOL_NOT_DECLARED = "tool_not_declared"
TOOL_NOT_BOUND = "tool_not_bound"
TOOL_NOT_APPROVED = "tool_not_approved"
TOOL_PERMISSION_DENIED = "tool_permission_denied"

# The binding exists but is not the one this authority was granted for.
TOOL_CONTRACT_MISMATCH = "tool_contract_mismatch"
TOOL_BINDING_STALE = "tool_binding_stale"
TOOL_BINDING_AMBIGUOUS = "tool_binding_ambiguous"

# The call itself.
TOOL_UNAVAILABLE = "tool_unavailable"
TOOL_TIMEOUT = "tool_timeout"
TOOL_CANCELLED = "tool_cancelled"
TOOL_REQUEST_INVALID = "tool_request_invalid"
TOOL_RESPONSE_INVALID = "tool_response_invalid"
TOOL_TRANSPORT_ERROR = "tool_transport_error"
TOOL_BROKER_UNAVAILABLE = "tool_broker_unavailable"

TOOL_ERROR_CODES = (
    TOOL_NOT_DECLARED,
    TOOL_NOT_BOUND,
    TOOL_NOT_APPROVED,
    TOOL_PERMISSION_DENIED,
    TOOL_CONTRACT_MISMATCH,
    TOOL_BINDING_STALE,
    TOOL_BINDING_AMBIGUOUS,
    TOOL_UNAVAILABLE,
    TOOL_TIMEOUT,
    TOOL_CANCELLED,
    TOOL_REQUEST_INVALID,
    TOOL_RESPONSE_INVALID,
    TOOL_TRANSPORT_ERROR,
    TOOL_BROKER_UNAVAILABLE,
)


def invalid(message: str, **detail) -> ToolBridgeError:
    return ToolBridgeError(TOOL_REQUEST_INVALID, message, detail=detail or None)


__all__ = [
    "TOOL_BINDING_AMBIGUOUS",
    "TOOL_BINDING_STALE",
    "TOOL_BROKER_UNAVAILABLE",
    "TOOL_CANCELLED",
    "TOOL_CONTRACT_MISMATCH",
    "TOOL_ERROR_CODES",
    "TOOL_NOT_APPROVED",
    "TOOL_NOT_BOUND",
    "TOOL_NOT_DECLARED",
    "TOOL_PERMISSION_DENIED",
    "TOOL_REQUEST_INVALID",
    "TOOL_RESPONSE_INVALID",
    "TOOL_TIMEOUT",
    "TOOL_TRANSPORT_ERROR",
    "TOOL_UNAVAILABLE",
    "ToolBridgeError",
    "invalid",
]
