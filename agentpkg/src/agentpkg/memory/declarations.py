"""What a package may declare about memory, checked at validation (§7: M-18, M-19, M-33, M-38,
M-48, M-67), before any host binds anything.

Refusals are `ValidationError`s whose text starts with the specification's code. The texts are the
Chrome core's (`src/core/memory/declarations.ts`) word for word, so that both CLIs refuse a package
with the same message (the conformance suite compares refusals byte for byte).
"""

from __future__ import annotations

from ..errors import ValidationError
from ..package import canonical_json
from .model import AGENT_TYPE, MAX_PROPOSALS, RESERVED_TYPES, SELF_TYPE, WELL_KNOWN_TYPE_ID
from .proposals import PROPOSALS_EXPORT_FORMAT, PROPOSALS_PATH
from .registry import MemoryTypeError, contract, custom_types_of, starter_types

MEMORY_MINIMUM_VERSION = "0.4.0"
MEMORY_READ_BINDING_PREFIX = "host.memory."
LEGACY_READ_BINDING_PREFIX = "host.resource."
AGENT_READ_BINDING = "host.memory.agent.read"
AGENT_WRITE_BINDING = "host.memory.agent.write"
AGENT_SCOPE = "agent-scoped"
AGENT_RESOURCE = "agent"


def _canonical(value) -> bytes:
    return canonical_json(value)


def agent_tool_schemas() -> dict:
    return {
        AGENT_READ_BINDING: (
            _canonical(contract("memory-empty-input.schema.json")),
            _canonical(contract("memory-agent-read.output.schema.json")),
        ),
        AGENT_WRITE_BINDING: (
            _canonical(contract("memory-agent-write.input.schema.json")),
            _canonical(contract("memory-agent-write.output.schema.json")),
        ),
    }


def _refuse(code: str, message: str) -> ValidationError:
    return ValidationError(f"{code}: {message}")


def _release(version: str) -> tuple[int, ...]:
    return tuple(int(x) for x in version.split("-")[0].split("."))


def is_agent_permission(permission: dict) -> bool:
    """The agent document's permission: kind `memory`, resources exactly `["agent"]` (M-48)."""
    return permission["kind"] == "memory" and permission["resources"] == [AGENT_RESOURCE]


def memory_declarations(manifest: dict, policy: dict, tools: dict, files: dict) -> dict:
    """Read and check a package's memory declarations; raises `ValidationError` on the first
    problem. Returns `{reads, write, agent, custom_types, uses_memory_v0}`."""
    from ..validation import parse_json

    package_id = manifest["package_id"]
    well_known = starter_types()
    try:
        custom = custom_types_of(package_id, policy, files, well_known)
    except MemoryTypeError as error:
        raise _refuse(error.code, str(error)) from None
    custom_by_local = {t["id"][len(package_id) + 1 :]: t["id"] for t in custom}
    known_ids = {t["id"] for t in well_known}
    legacy_ids = {alias["id"] for t in well_known for alias in t.get("legacy", [])}

    def resolve_type(resource: str):
        return resource if resource in known_ids else custom_by_local.get(resource)

    reads: dict[str, str] = {}
    write = None
    agent_permission = None
    uses = bool(custom)
    for permission in policy["permissions"]:
        pid, kind, resources = permission["id"], permission["kind"], permission["resources"]
        if kind == "memory.read":
            uses = True
            if len(resources) != 1:
                raise _refuse(
                    "ambiguous",
                    f"memory.read permission {pid} must name exactly one type in resources",
                )
            resource = resources[0]
            if resource in (AGENT_TYPE, SELF_TYPE):
                raise _refuse(
                    "memory_type_reserved",
                    f"memory.read permission {pid} names the reserved type {resource}",
                )
            if resolve_type(resource) is None and resource not in legacy_ids:
                if not WELL_KNOWN_TYPE_ID.match(resource):
                    raise _refuse(
                        "memory_type_unknown",
                        f"memory.read permission {pid} names {resource}, which is not a type id",
                    )
            reads[pid] = resource
        elif kind == "memory.write":
            uses = True
            if write is not None:
                raise _refuse(
                    "memory_proposal_undeclared",
                    "a package declares at most one memory.write permission",
                )
            if not resources or len(resources) > MAX_PROPOSALS:
                raise _refuse(
                    "memory_type_reserved",
                    f"memory.write permission {pid} must name 1 to {MAX_PROPOSALS} types",
                )
            types: list[str] = []
            for resource in resources:
                if resource in RESERVED_TYPES:
                    raise _refuse(
                        "memory_type_reserved",
                        f"memory.write permission {pid} names the reserved type {resource}",
                    )
                if not WELL_KNOWN_TYPE_ID.match(resource):
                    raise _refuse(
                        "memory_type_unknown",
                        f"memory.write permission {pid} names {resource}, which is not a type id",
                    )
                types.append(resolve_type(resource) or resource)
            write = {"permission_id": pid, "types": types}
        elif kind == "memory" and AGENT_RESOURCE in resources:
            uses = True
            if len(resources) != 1:
                raise _refuse(
                    "agent_memory_scope",
                    f"memory permission {pid} names the agent document beside other resources",
                )
            if agent_permission is not None:
                raise _refuse(
                    "agent_memory_scope", "a package declares at most one agent-document permission"
                )
            agent_permission = pid
    memory = policy["memory"]
    scope = memory["scope"]
    if scope == AGENT_SCOPE:
        uses = True
        if agent_permission is None:
            raise _refuse(
                "agent_memory_scope",
                "memory.scope agent-scoped needs one memory permission whose resources are "
                '["agent"]',
            )
        if (
            memory["retention"] != "user-managed"
            or memory["raw_documents"] is not False
            or memory["sharing"] != "explicit_views"
        ):
            raise _refuse(
                "agent_memory_scope",
                "memory.scope agent-scoped requires retention user-managed, raw_documents false "
                "and sharing explicit_views",
            )
    elif agent_permission is not None:
        raise _refuse(
            "agent_memory_scope",
            f"a memory permission names the agent document, but memory.scope is {scope}",
        )
    schemas = agent_tool_schemas()
    empty_input = _canonical(contract("memory-empty-input.schema.json"))
    read_tool = write_tool = None
    budget = policy["budget"].get("max_calls_per_tool") or {}

    def schema_bytes(path: str) -> bytes:
        return _canonical(parse_json(files[path], path))

    for tool_id, tool in tools.items():
        binding = tool["binding"] or ""
        linked = list(tool["permissions"])
        if binding in (AGENT_READ_BINDING, AGENT_WRITE_BINDING):
            uses = True
            if scope != AGENT_SCOPE or agent_permission is None:
                raise _refuse(
                    "agent_memory_scope",
                    f"tool {tool_id} binds {binding}, which only an agent-scoped package may "
                    "declare",
                )
            if (
                tool["execution"] != "local"
                or tool["approval_required"] is not True
                or len(tool["domains"]) != 0
            ):
                raise _refuse(
                    "agent_memory_scope",
                    f"tool {tool_id} must be local, approval_required and without domains",
                )
            if len(linked) != 1 or linked[0] != agent_permission:
                raise _refuse(
                    "agent_memory_scope",
                    f"tool {tool_id} must link the agent-document permission {agent_permission} "
                    "and nothing else",
                )
            expected_input, expected_output = schemas[binding]
            if (
                schema_bytes(tool["input_schema"]) != expected_input
                or schema_bytes(tool["output_schema"]) != expected_output
            ):
                raise _refuse(
                    "binding_schema_mismatch",
                    f"tool {tool_id}: the schemas of {binding} must be exactly the memory.v0 agent "
                    "tool schemas",
                )
            if binding == AGENT_WRITE_BINDING:
                if tool["side_effects"] != "write":
                    raise _refuse(
                        "agent_memory_scope", f"tool {tool_id} must declare side_effects write"
                    )
                if budget.get(tool_id) != 1:
                    raise _refuse(
                        "agent_memory_write_cap",
                        f"tool {tool_id}: max_calls_per_tool must be exactly 1 for {binding}",
                    )
                if write_tool is not None:
                    raise _refuse("agent_memory_scope", f"two tools bind {binding}")
                write_tool = tool_id
            else:
                if tool["side_effects"] != "read":
                    raise _refuse(
                        "agent_memory_scope", f"tool {tool_id} must declare side_effects read"
                    )
                if read_tool is not None:
                    raise _refuse("agent_memory_scope", f"two tools bind {binding}")
                read_tool = tool_id
            continue
        if binding.startswith(MEMORY_READ_BINDING_PREFIX):
            uses = True
            type_id = binding[len(MEMORY_READ_BINDING_PREFIX) :]
            permission_id = next((pid for pid in linked if reads.get(pid) == type_id), None)
            if permission_id is None or len(linked) != 1:
                raise _refuse(
                    "memory_type_unknown",
                    f"tool {tool_id} binds {binding} but links no memory.read permission for "
                    f"{type_id}",
                )
            if (
                tool["execution"] != "local"
                or tool["approval_required"] is not True
                or tool["side_effects"] != "read"
                or len(tool["domains"]) != 0
            ):
                raise _refuse(
                    "memory_type_unknown",
                    f"tool {tool_id} must be a local, read-only, approval-required tool without "
                    "domains",
                )
            if schema_bytes(tool["input_schema"]) != empty_input:
                raise _refuse(
                    "binding_schema_mismatch",
                    f"tool {tool_id}: a memory read takes the empty object",
                )
    agent = (
        None
        if agent_permission is None
        else {"permission_id": agent_permission, "read_tool": read_tool, "write_tool": write_tool}
    )
    return {
        "reads": reads,
        "write": write,
        "agent": agent,
        "custom_types": custom,
        "uses_memory_v0": uses,
    }


def check_memory_graph(manifest: dict, graph: dict, declarations: dict) -> None:
    """M-38: `memory.write` and exactly one `memory.proposal` export go together, at
    `proposals.json`; M-67: memory.v0 declarations need runtime.minimum_version 0.4.0."""
    exports = graph.get("exports") or []
    proposal_exports = [
        entry for entry in exports if entry.get("format") == PROPOSALS_EXPORT_FORMAT
    ]
    if declarations["write"] is not None and len(proposal_exports) != 1:
        raise _refuse(
            "memory_proposal_undeclared",
            f"a package declaring memory.write declares exactly one export of format "
            f"{PROPOSALS_EXPORT_FORMAT}",
        )
    if declarations["write"] is None and proposal_exports:
        raise _refuse(
            "memory_proposal_undeclared",
            f"the export format {PROPOSALS_EXPORT_FORMAT} belongs to a package declaring "
            "memory.write",
        )
    for entry in proposal_exports:
        if entry["path"] != PROPOSALS_PATH:
            raise _refuse(
                "memory_proposal_undeclared",
                f"the {PROPOSALS_EXPORT_FORMAT} export must be {PROPOSALS_PATH}",
            )
    uses = declarations["uses_memory_v0"] or bool(proposal_exports)
    minimum = manifest["runtime"]["minimum_version"]
    if uses and _release(minimum) < _release(MEMORY_MINIMUM_VERSION):
        raise _refuse(
            "memory_minimum_version",
            f"memory.v0 declarations require runtime.minimum_version {MEMORY_MINIMUM_VERSION} "
            "or later",
        )


def is_memory_binding(binding: str) -> bool:
    return binding.startswith(MEMORY_READ_BINDING_PREFIX) or binding.startswith(
        LEGACY_READ_BINDING_PREFIX
    )


__all__ = [
    "AGENT_READ_BINDING",
    "AGENT_RESOURCE",
    "AGENT_SCOPE",
    "AGENT_WRITE_BINDING",
    "LEGACY_READ_BINDING_PREFIX",
    "MEMORY_MINIMUM_VERSION",
    "MEMORY_READ_BINDING_PREFIX",
    "agent_tool_schemas",
    "check_memory_graph",
    "is_agent_permission",
    "is_memory_binding",
    "memory_declarations",
]
