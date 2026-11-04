"""The generic HTTPS JSON binding for `Py` (D-353; PROTOCOL.md §2.1, amended 2026-11-04).

agentpkg's CLI binds only Literature Review's tools (`agentpkg.tools.create_handlers`: Crossref, the
Citation Resolver, the PDF reader); the generic bindings WebAir 0.8.0 and the travel network declare
(`webair.search_flights`, `travel.flights`, …) are implemented by the host: the OpenClaw broker's
`openclaw.tool.json_http` adapter and the Chrome core's broker. On `Py` the campaign host supplies
the same adapter rule over agentpkg's own transport:

- the destination is the tool's declared endpoint, limited exactly as `create_handlers`' `remote`
  limits it (the tool's domains ∩ the policy's allowed domains ∩ the granted network permission's
  resources), and checked by `validate_https_url`;
- the call goes through `agentpkg.network.async_request_json`: the killable child, the DNS check and
  the address policy, the pinned TLS connection, no redirects, the bounded read (and, in a campaign,
  the host mapping's dial);
- the answer follows `json_http`: 200/400/404/422/502 bodies are data for the package's output
  schema to accept or refuse; 401/403 and any other 5xx are `tool_unavailable`, any other status a
  transport error. The runtime validates the answer against the tool's declared output schema.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from agentpkg.memory.model import is_memory_binding
from agentpkg.tools import ToolError, validate_https_url

DATA_STATUSES = {200, 400, 404, 422, 502}
LITERATURE_BINDINGS = {"scholarly.search", "citation.resolve", "paper.read"}


def _coded(code: str, message: str) -> ToolError:
    """A ToolError with the stable code the audit records as the reason (`failure_reason`)."""
    error = ToolError(message)
    error.code = code
    return error


def _domains(package, tool) -> set[str]:
    domains = set(tool["domains"]) & set(package.policy["network"]["allowed_domains"])
    permissions = {p["id"]: p for p in package.policy["permissions"]}
    granted = set()
    for permission_id in tool["permissions"]:
        permission = permissions[permission_id]
        if permission["kind"] == "network":
            granted.update(permission["resources"])
    return domains & granted


def json_http_handlers(package) -> dict:
    """One handler per remote generic binding the package declares, keyed by binding."""
    handlers = {}
    for tool in package.tools.values():
        binding = tool["binding"]
        if is_memory_binding(binding) or binding in LITERATURE_BINDINGS:
            continue
        if tool["execution"] != "remote" or tool["method"] != "POST":
            raise ToolError(f"campaign host: no implementation for binding {binding}")

        async def handle(ctx, payload, _tool=tool):
            from agentpkg.network import async_request_json

            url = _tool["endpoint"]
            domains = _domains(package, _tool)
            validate_https_url(url, domains)
            ctx.event(
                "network.requested",
                tool=_tool["id"],
                domain=urlsplit(url).hostname,
                method=_tool["method"],
            )
            status, body = await async_request_json(
                url,
                method="POST",
                payload=payload,
                timeout=_tool["timeout_seconds"],
                allowed_domains=domains,
            )
            if status in (401, 403) or (status >= 500 and status != 502):
                raise _coded("tool_unavailable", f"the tool host answered HTTP {status}")
            if status not in DATA_STATUSES:
                raise _coded("tool_transport_error", f"the tool host answered HTTP {status}")
            return body

        handlers[binding] = handle
    return handlers
