"""Vendor-neutral, host-configured model router contract.

The router must count the complete rendered request including schema/instructions,
apply the output cap, and report all billed input/output/reasoning tokens. A server
that cannot do so is incompatible with the hard-token-budget execution profile.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from .interfaces import ModelRouter as ModelRouter
from .runtime import PolicyError
from .tools import validate_https_url


class HTTPRouter:
    """Two-operation protocol over a public, host-selected HTTPS origin.

    POST /count: {request: ...} -> {input_tokens: N}
    POST /complete: {request: ..., max_output_tokens: N, model: ...}
       -> {output: object, input_tokens: N, output_tokens: N, cost_usd?: number}

    Count is a pure tokenization operation and must not invoke an LLM. Each HTTP
    operation is counted against global and worker remote-call caps. API keys stay
    in a named host environment variable; config and packages never contain keys.
    """

    remote = True

    def __init__(self, config, *, transport=None):
        required = {
            "spec_version",
            "url",
            "model_id",
            "router_id",
            "capabilities",
            "context_window",
            "enforces_output_cap",
            "counts_all_tokens",
        }
        allowed = required | {"api_key_env", "timeout_seconds"}
        if set(config) - allowed or required - set(config):
            raise PolicyError("Router config has missing or unknown fields")
        if config["spec_version"] != "0.1":
            raise PolicyError("Unsupported router contract version")
        if config["enforces_output_cap"] is not True or config["counts_all_tokens"] is not True:
            raise PolicyError("Router must enforce output caps and account for all model tokens")
        parts = urlsplit(config["url"])
        validate_https_url(config["url"], {parts.hostname})
        if parts.path not in {"", "/"} or parts.query:
            raise PolicyError("Router URL must be an HTTPS origin")
        self.url = config["url"].rstrip("/")
        self.model_id = config["model_id"]
        self.router_id = config["router_id"]
        self.capabilities = set(config["capabilities"])
        self.context_window = config["context_window"]
        if (
            isinstance(self.context_window, bool)
            or not isinstance(self.context_window, int)
            or self.context_window < 1
        ):
            raise PolicyError("Router context_window must be a positive integer")
        self.timeout = config.get("timeout_seconds", 40)
        if not isinstance(self.timeout, int) or not 1 <= self.timeout <= 120:
            raise PolicyError("Router timeout must be between 1 and 120 seconds")
        self._key_env = config.get("api_key_env")
        self._transport = transport
        self._domain = parts.hostname
        self.domains = (self._domain,)

    @classmethod
    def from_config(cls, path):
        return cls(json.loads(Path(path).read_text()))

    async def _post(self, operation, payload):
        headers = {}
        if self._key_env:
            key = os.environ.get(self._key_env)
            if not key:
                raise PolicyError(
                    f"Host router credential environment variable is unset: {self._key_env}"
                )
            if any(ord(c) < 32 for c in key):
                raise PolicyError("Invalid router credential")
            headers["Authorization"] = "Bearer " + key
        async with asyncio.timeout(self.timeout):
            options = dict(
                method="POST",
                payload=payload,
                timeout=self.timeout,
                allowed_domains={self._domain},
                headers=headers,
            )
            if self._transport is None:
                from .network import async_request_json

                status, body = await async_request_json(self.url + "/" + operation, **options)
            else:
                status, body = await asyncio.to_thread(
                    self._transport, self.url + "/" + operation, **options
                )
        if status != 200 or not isinstance(body, dict):
            raise PolicyError(f"Model router {operation} failed (HTTP {status})")
        return body

    async def count_tokens(self, request):
        response = await self._post("count", {"request": request, "model": self.model_id})
        return response.get("input_tokens")

    async def complete(self, request, *, max_output_tokens):
        return await self._post(
            "complete",
            {"request": request, "model": self.model_id, "max_output_tokens": max_output_tokens},
        )
