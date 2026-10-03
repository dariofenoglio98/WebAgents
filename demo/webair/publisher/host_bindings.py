"""The demo host's bindings of WebAir's four semantic tools: operator configuration.

A person's host decides which implementation runs each tool a package declares. In this demo
the Agent Browser runs WebAir's four tools with its service-neutral JSON adapter
(`openclaw.tool.json_http`: one JSON POST to one exact HTTPS origin and path), pointed at
WebAir's public origin. `demo/webair/host-bindings.json` is that statement, in the
`openclaw-host-tool-bindings-v0` format an operator names with
`plugins.entries.agent-browser.config.tools.bindingsFile`. Like `host-resources.json` it is
host configuration, never package content, and it is not part of the public origin.

The contract digests are the host's own statement of what WebAir's API speaks: they are
derived here from the contract the origin publishes (`GET /api/v1/schemas`), not read from the
package. The Agent Browser's control plane then compares them with the schemas the package
declares, and refuses to bind a package whose contract, endpoint, permission kinds or side
effects differ. A declared endpoint stays an upper bound, the binding stays authoritative.

`side_effects` and `permission_kinds` are the host's statement of what each operation does and
under which kinds of authority it may be called: a quote reads (and needs a passenger
identity), a simulated purchase writes (and needs payment authority as well).
"""

from __future__ import annotations

from agentpkg.package import canonical_json, sha256

from origin.api import API_PREFIX, MAX_JSON_BYTES, schemas_document

from .contract import (
    DECLARED_HOST,
    PACKAGE_TOOLS,
    binding_name,
    tool_input_schema,
    tool_output_schema,
)
from .host import DEMO_ROOT

HOST_BINDINGS = DEMO_ROOT / "host-bindings.json"
BINDINGS_SCHEMA = "openclaw-host-tool-bindings-v0"
JSON_ADAPTER = "openclaw.tool.json_http"

# operation -> (side effects, permission kinds the call travels under)
OPERATION_AUTHORITY = {
    "search_flights": ("read", ["network"]),
    "get_fare_rules": ("read", ["network"]),
    "prepare_booking": ("read", ["network", "personal.read"]),
    "simulate_purchase": ("write", ["network", "payment", "personal.read"]),
}
TIMEOUT_SECONDS = 20
MAX_RESPONSE_BYTES = 256 * 1024
MAX_CONCURRENT = 4


def digest(schema: dict) -> str:
    return sha256(canonical_json(schema))


def host_bindings_document(document: dict | None = None, host: str = DECLARED_HOST) -> dict:
    """The operator's bindings file, from the origin's published contract."""
    document = schemas_document() if document is None else document
    bindings = []
    for operation, tool_id in PACKAGE_TOOLS.items():
        side_effects, kinds = OPERATION_AUTHORITY[operation]
        published = document["operations"][operation]
        if (published["method"], published["path"]) != ("POST", f"{API_PREFIX}/{operation}"):
            raise ValueError(
                f"{operation}: the origin no longer publishes POST {published['path']}"
            )
        bindings.append(
            {
                "id": f"demo:{binding_name(operation)}:1",
                "tool_id": tool_id,
                "binding": binding_name(operation),
                "implementation_id": JSON_ADAPTER,
                "display_name": f"WebAir {operation} (demo binding)",
                "description": f"One JSON POST to {published['path']} on WebAir's public demo "
                "origin, and nothing else. WebAir is a fictional airline: no real booking or "
                "payment occurs.",
                "endpoint": {
                    "origin": f"https://{host}",
                    "path": published["path"],
                    "method": "POST",
                },
                "input_schema_sha256": digest(tool_input_schema(document, operation)),
                "output_schema_sha256": digest(tool_output_schema(document, operation)),
                "permission_kinds": kinds,
                "side_effects": side_effects,
                "timeout_seconds": TIMEOUT_SECONDS,
                "max_request_bytes": MAX_JSON_BYTES,
                "max_response_bytes": MAX_RESPONSE_BYTES,
                "max_concurrent": MAX_CONCURRENT,
            }
        )
    return {"schema": BINDINGS_SCHEMA, "bindings": bindings}
