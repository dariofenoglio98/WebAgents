"""The demo host's personal resources, and what the WebAir package copies from them.

`demo/webair/host-resources.json` is what the person's OpenClaw host holds in this demo: two
travel profiles, two passenger identities and two payment methods, all fictional. It is
host configuration (`plugins.entries.agent-browser.config.hostResources.file`), never package
content: the signed package carries no name, email or payment record.

What the package does carry is each resource *type's* schema, because a package that requests
a type must declare exactly the host's schema for it (the host's binding pins its digest).
`host_schema_files` generates those copies, the same way `contract.py` generates WebAir's API
schemas from the origin, so the two cannot drift silently.

`host_resource_handlers` is an in-process stand-in for the host's `host_resource` bindings,
used only by this publisher to record which requests WebAir receives in the demo scenarios.
The Agent Browser's own generic implementation (`openclaw-agent-browser/src/host-resources.ts`)
is what the acceptance tests run.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

DEMO_ROOT = Path(__file__).resolve().parents[1]
HOST_RESOURCES = DEMO_ROOT / "host-resources.json"
HOST_SCHEMA_DIR = "schemas/host"

# The one input schema every host-resource tool declares: no argument, so no package or
# model can name a resource. The Agent Browser pins the same document.
EMPTY_INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}


def host_definitions() -> dict:
    return json.loads(HOST_RESOURCES.read_text())


def host_schema_files(definitions: dict | None = None) -> dict[str, dict]:
    """The package's copies of the host's resource type schemas, by package path."""
    definitions = host_definitions() if definitions is None else definitions
    files = {f"{HOST_SCHEMA_DIR}/empty-input.schema.json": copy.deepcopy(EMPTY_INPUT_SCHEMA)}
    for resource_type in definitions["types"]:
        files[f"{HOST_SCHEMA_DIR}/{resource_type['id']}.schema.json"] = copy.deepcopy(
            resource_type["schema"]
        )
    return files


def resource_value(resource_id: str, definitions: dict | None = None) -> dict:
    definitions = host_definitions() if definitions is None else definitions
    for resource in definitions["resources"]:
        if resource["id"] == resource_id:
            return copy.deepcopy(resource["value"])
    raise KeyError(resource_id)


def host_resource_handlers(package, selections: dict[str, str], definitions=None) -> dict:
    """Handlers for the package's host-resource tools, returning the selected resources.

    `selections` maps a permission id to the resource the person picked. Each tool returns
    the resource selected for the permission it links, or fails, as the real host does.
    """
    definitions = host_definitions() if definitions is None else definitions
    handlers = {}
    for tool in package.tools.values():
        if tool["execution"] != "local" or not tool["binding"].startswith("host.resource."):
            continue
        chosen = [selections[pid] for pid in tool["permissions"] if pid in selections]

        async def handle(context, payload, chosen=chosen, tool_id=tool["id"]):
            if payload != {} or len(chosen) != 1:
                raise RuntimeError(f"{tool_id}: no resource of this type was granted")
            return resource_value(chosen[0], definitions)

        handlers[tool["binding"]] = handle
    return handlers
