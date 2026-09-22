"""Stable, machine-readable control-plane failures.

Codes are part of the API contract: a future OpenClaw plugin branches on
`code`, never on prose. Messages never carry package payload content.
"""

from __future__ import annotations

from ..errors import AgentPkgError


class ControlPlaneError(AgentPkgError):
    """One refused control-plane operation with a stable code and HTTP status."""

    def __init__(self, code: str, message: str, *, status: int = 400, details=None):
        self.code = code
        self.status = status
        self.details = details if details is not None else {}
        super().__init__(message)

    def payload(self) -> dict:
        body = {"error": {"code": self.code, "message": str(self)}}
        if self.details:
            body["error"]["details"] = self.details
        return body
