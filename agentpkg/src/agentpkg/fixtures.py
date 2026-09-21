"""Explicit deterministic replay adapters. All behavior is package-owned JSON data."""

from __future__ import annotations

import asyncio
import copy
import json

from .errors import AgentPkgError
from .runtime import PolicyError


def replay(cases, value, label):
    matches = [case for case in cases if case["input"] == value]
    if len(matches) != 1:
        raise AgentPkgError(
            f"Fixture {label}: expected exactly one matching input, found {len(matches)}"
        )
    return copy.deepcopy(matches[0]["output"])


class FixtureRouter:
    """No inference, network, domain dispatch, templates, or executable fixture code."""

    remote = False
    synthetic = True
    model_id = "fixture-replay-v0"
    router_id = "host-fixture-v0"
    capabilities = frozenset({"reasoning", "structured_output"})
    context_window = 1_000_000

    def __init__(self, cases):
        self.cases = copy.deepcopy(cases)
        self.calls = []

    async def count_tokens(self, request):
        # Synthetic accounting unit: four UTF-8 bytes (rounded up). Not a vendor tokenizer or bill.
        return (len(json.dumps(request, ensure_ascii=False, sort_keys=True).encode()) + 3) // 4

    async def complete(self, request, *, max_output_tokens):
        await asyncio.sleep(0)
        output = replay(self.cases.get(request["task"], []), request["data"], request["task"])
        used = (len(json.dumps(output, ensure_ascii=False, sort_keys=True).encode()) + 3) // 4
        if used > max_output_tokens:
            raise PolicyError("Fixture output exceeds declared output token allowance")
        self.calls.append(request["task"])
        return {
            "output": output,
            "input_tokens": await self.count_tokens(request),
            "output_tokens": used,
        }


def fixture_adapters(package):
    path = package.graph.get("fixture")
    if path is None:
        raise PolicyError("Package has no declared workflow fixture")
    fixture = package.json(path)
    handlers = {}
    for tool_id, cases in fixture["tools"].items():
        binding = package.tools[tool_id]["binding"]
        if binding in handlers:
            raise PolicyError("Fixture tool bindings must be unique")

        async def handle(ctx, payload, cases=copy.deepcopy(cases), tool_id=tool_id):
            await asyncio.sleep(0)
            return replay(cases, payload, tool_id)

        handlers[binding] = handle
    return FixtureRouter(fixture["models"]), handlers, copy.deepcopy(fixture["input"])
