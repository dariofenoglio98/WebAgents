"""Stable failures of conversation.v0, each with a code the message starts with."""

from __future__ import annotations

from ..errors import AgentPkgError


class ConversationError(AgentPkgError):
    """A conversation refused before it starts, or a host-side failure of the runner."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


class ConsentError(AgentPkgError):
    """A host failed to decide a consent step (an answer outside the decision contract). The
    person's own `denied` is never an error: it is the step's result."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")
