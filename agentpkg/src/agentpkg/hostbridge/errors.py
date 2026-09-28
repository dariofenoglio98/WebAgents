"""Stable, machine-readable host-bridge failures.

Codes are the contract. A caller branches on `code`, never on prose, and no
message ever carries package payload content, model output, provider detail or
a credential.
"""

from __future__ import annotations

from ..errors import AgentPkgError


class BridgeError(AgentPkgError):
    """One refused or failed bridge operation with a stable code.

    `audit_facts` is for structural facts about *how* a call failed — counts,
    stop reasons, schema keywords and locations — that the runtime may copy into
    its audit (`agentpkg.runtime.failure_reason` filters them again). It must
    never hold anything the model, a provider or a document wrote.
    """

    def __init__(self, code: str, message: str, *, detail=None, audit_facts=None):
        self.code = code
        self.detail = detail if detail is not None else {}
        self.audit_facts = dict(audit_facts) if audit_facts else {}
        super().__init__(message)

    def as_json(self) -> dict:
        error = {"code": self.code, "message": str(self)}
        if self.detail:
            error["detail"] = self.detail
        return error


class ProtocolError(BridgeError):
    """A frame violated the wire contract. Always fatal: the session ends."""


__all__ = ["BridgeError", "ProtocolError"]
