"""Failures of a link at run time (link.v0 L-27)."""

from __future__ import annotations

from ..errors import AgentPkgError


class LinkError(AgentPkgError):
    """An inner run that failed: the caller's step fails `link_error`, and the inner run's own
    code is named by `link.failed`, never by the caller's node."""

    def __init__(self, dependency: str, inner_code: str):
        super().__init__(f"link {dependency}: the inner run failed ({inner_code})")
        self.dependency = dependency
        self.inner_code = inner_code
