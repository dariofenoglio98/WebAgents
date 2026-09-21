"""Host integration contracts. Implementations are installed by the host, never a package."""

from __future__ import annotations

from typing import Protocol


class ModelRouter(Protocol):
    remote: bool
    model_id: str
    router_id: str
    capabilities: set[str] | frozenset[str]
    context_window: int

    async def count_tokens(self, request: dict) -> int:
        """Bound all rendered input, including skills/schema; no generation here."""
        ...

    async def complete(self, request: dict, *, max_output_tokens: int) -> dict:
        """Return output/input_tokens/output_tokens, enforcing caps and cancellation."""
        ...


class ToolHandler(Protocol):
    async def __call__(self, context, payload):
        """Execute one declared contract. Bound I/O and propagate cancellation.

        context identifies the authorized worker and supplies audit emission. It
        does not grant arbitrary network/filesystem authority. Handlers must bind
        operations to the actual declared tool contract and approved host resources.
        """
        ...
