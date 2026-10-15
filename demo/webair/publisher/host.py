"""The demo host's personal resources, and what the WebAir package copies from them.

`demo/webair/host-resources.json` is what the person's OpenClaw host holds in this demo: two
travel profiles, two passenger identities and two payment methods, all fictional. It is
host configuration (`plugins.entries.agent-browser.config.hostResources.file`), never package
content: the signed package carries no name, email or payment record.

What the package does carry is each resource *type's* schema, because a package that requests
a type must declare exactly the host's schema for it (the host's binding pins its digest).
`host_schema_files` generates those copies, the same way `contract.py` generates WebAir's API
schemas from the origin, so the two cannot drift silently.

Since 0.6.0 the travel profile is read from the person's memory (memory.v0: a `memory.read`
permission for the type `travel.profile`, which answers for the legacy id
`personal.travel_profile`, spec/memory-v0.md M-17). The package then declares the type's
**record view** schema (M-16, built by agentpkg from the starter taxonomy) instead of the
host's legacy schema, and `host_schema_files` generates that instead.

`host_resource_handlers` is an in-process stand-in for the host's `host_resource` bindings
(and, since 0.6.0, its `host.memory.<type>` bindings, answering the picked resource as a record
view), used only by this publisher to record which requests WebAir receives in the demo
scenarios.
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


def _memory_reads(policy: dict | None) -> list[str]:
    """The memory types the package reads through `memory.read` (memory.v0)."""
    if policy is None:
        return []
    return [
        resource
        for permission in policy["permissions"]
        if permission["kind"] == "memory.read"
        for resource in permission["resources"]
    ]


def source_policy() -> dict:
    from .contract import PACKAGE_SOURCE

    return json.loads((PACKAGE_SOURCE / "policy" / "policy.json").read_text())


def host_schema_files(definitions: dict | None = None, policy: dict | None = None) -> dict:
    """The package's copies of the host's resource type schemas, by package path: the host's
    own schema for a type the package reads under `personal.read`, and the memory.v0 record
    view for a type it reads under `memory.read` (whose legacy alias it then no longer
    declares)."""
    from agentpkg.memory.registry import TypeRegistry, record_view_schema

    definitions = host_definitions() if definitions is None else definitions
    policy = source_policy() if policy is None else policy
    registry = TypeRegistry()
    memory_types = [registry.get(type_id) for type_id in _memory_reads(policy)]
    replaced = {alias["id"] for type_def in memory_types for alias in type_def.get("legacy", [])}
    files = {f"{HOST_SCHEMA_DIR}/empty-input.schema.json": copy.deepcopy(EMPTY_INPUT_SCHEMA)}
    for resource_type in definitions["types"]:
        if resource_type["id"] in replaced:
            continue
        files[f"{HOST_SCHEMA_DIR}/{resource_type['id']}.schema.json"] = copy.deepcopy(
            resource_type["schema"]
        )
    for type_def in memory_types:
        files[f"{HOST_SCHEMA_DIR}/{type_def['id']}.view.schema.json"] = record_view_schema(type_def)
    return files


def resource_label(resource_id: str, definitions: dict | None = None) -> str:
    definitions = host_definitions() if definitions is None else definitions
    for resource in definitions["resources"]:
        if resource["id"] == resource_id:
            return resource["label"]
    raise KeyError(resource_id)


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
        binding = tool["binding"] or ""
        memory = binding.startswith("host.memory.") and not binding.startswith("host.memory.agent.")
        if tool["execution"] != "local" or not (binding.startswith("host.resource.") or memory):
            continue
        chosen = [selections[pid] for pid in tool["permissions"] if pid in selections]

        async def handle(
            context, payload, chosen=chosen, tool_id=tool["id"], memory=memory, binding=binding
        ):
            if payload != {} or len(chosen) != 1:
                raise RuntimeError(f"{tool_id}: no resource of this type was granted")
            value = resource_value(chosen[0], definitions)
            if not memory:
                return value
            # The record view of M-15 for the picked resource, as a memory store answers it.
            return {
                "id": chosen[0],
                "type": binding[len("host.memory.") :],
                "title": resource_label(chosen[0], definitions),
                "fields": value,
                "body": "",
                "tags": [],
                "sealed": [],
            }

        handlers[binding] = handle
    return handlers
