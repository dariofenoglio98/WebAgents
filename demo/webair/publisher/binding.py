"""An in-process stand-in for a host's json_http binding of the package's tools.

A real host binds each declared tool to one implementation it chose; WebAgents' generic
`json_http` adapter POSTs the arguments as a JSON body to one exact origin, path and method
and hands 200/400/404/422/502 bodies to the package as data. This handler does the same
against the WebAir ASGI app in this process, through httpx's ASGI transport: no socket, no
DNS, no network. It is a test and build-time binding, not part of the package.

Each handler is keyed by the tool's binding name, as `agentpkg.runtime.Runtime` looks
handlers up, and is parameterized only by the tool's own declared method and path. Only the
package's remote tools get one: its host-resource tools are the person's host's, not WebAir's
(see `host.py`).
"""

from __future__ import annotations

import copy
from urllib.parse import urlsplit

import httpx

# The statuses the generic json_http adapter returns to a package as data.
DATA_STATUSES = frozenset({200, 400, 404, 422, 502})


class BindingError(Exception):
    """A transport-level failure, like json_http's tool_transport_error."""

    code = "tool_transport_error"


def json_http_handlers(package, app, *, record=None) -> dict:
    handlers = {}
    for tool_id, tool in package.tools.items():
        if tool["execution"] != "remote":
            continue
        endpoint = urlsplit(tool["endpoint"])
        handlers[tool["binding"]] = _handler(
            app,
            tool_id,
            origin=f"{endpoint.scheme}://{endpoint.hostname}",
            path=endpoint.path,
            method=tool["method"],
            record=record,
        )
    return handlers


def _handler(app, tool_id, *, origin, path, method, record):
    async def handle(context, payload):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=origin) as client:
            response = await client.request(method, path, json=payload)
        media_type = response.headers.get("content-type", "").split(";")[0].strip()
        if response.status_code not in DATA_STATUSES or media_type != "application/json":
            raise BindingError(f"{tool_id}: HTTP {response.status_code} is not data")
        result = response.json()
        if record is not None:
            record.append(
                {
                    "tool": tool_id,
                    "method": method,
                    "path": path,
                    "status": response.status_code,
                    "input": copy.deepcopy(payload),
                    "output": copy.deepcopy(result),
                }
            )
        return result

    return handle
