"""The one failure class a compute call adds to workflow.v0 (compute.v0 §6)."""

from __future__ import annotations

from ..errors import AgentPkgError


class ComputeError(AgentPkgError):
    """A call that the module itself ended: a trap, exhausted fuel, a passed deadline, an ABI
    violation, or output that is not one JSON text. The node fails `compute_error`; the audit
    names the reason and never carries what the module wrote."""

    code = "compute_error"

    def __init__(self, reason: str, *, trap_code: str | None = None, detail: str | None = None):
        self.reason = reason
        self.trap_code = trap_code
        self.detail = detail
        self.audit_facts = self.facts()
        text = reason + (f" ({trap_code})" if trap_code else "") + (f": {detail}" if detail else "")
        super().__init__(f"compute call failed: {text}")

    def facts(self) -> dict:
        facts = {"reason": self.reason}
        if self.trap_code:
            facts["trap_code"] = self.trap_code
        if self.detail:
            facts["detail"] = self.detail
        return facts


__all__ = ["ComputeError"]
