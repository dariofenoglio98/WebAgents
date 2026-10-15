"""The host side of a run's memory in the Python CLI (§7, M-35, M-48…M-51, M-61, M-63): the
handlers of the `host.memory.<type>`, `host.resource.<legacy id>` and agent-document bindings over
a memory folder, the binding check of M-16 and M-48, and how `agentpkg run` builds a run's
`MemoryRun` from its flags.

A handler answers exactly the plan's grant for its tool's permission and nothing else; the package
id of the agent document is the run's, never an argument.
"""

from __future__ import annotations

import hashlib

from ..errors import ValidationError
from ..package import canonical_json
from ..validation import parse_json
from .declarations import (
    AGENT_READ_BINDING,
    AGENT_WRITE_BINDING,
    LEGACY_READ_BINDING_PREFIX,
    MEMORY_READ_BINDING_PREFIX,
)
from .model import MAX_AGENT_BODY_CHARS
from .registry import record_view_schema


class MemoryToolError(Exception):
    """A memory tool's refusal with the code M-35 names (`tool_request_invalid`,
    `tool_unavailable`), recorded by the mediator as the failed call's reason."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def check_memory_bindings(package, types) -> None:
    """M-16: a `memory.read` tool is bound only when its output schema canonicalizes to the
    view the host builds from its own type (`binding_schema_mismatch`); a type the host does not
    hold is `memory_type_unknown`. The agent tools' schemas are checked at validation (M-48)."""
    for tool_id, tool in package.tools.items():
        binding = tool["binding"] or ""
        if not binding.startswith(MEMORY_READ_BINDING_PREFIX) or binding in (
            AGENT_READ_BINDING,
            AGENT_WRITE_BINDING,
        ):
            continue
        type_id = binding[len(MEMORY_READ_BINDING_PREFIX) :]
        package_id = package.manifest["package_id"]
        type_def = types.get(type_id) or types.get(f"{package_id}:{type_id}")
        if type_def is None:
            raise ValidationError(
                f"memory_type_unknown: tool {tool_id} reads {type_id}, which this host does not "
                "hold"
            )
        output = parse_json(package.files[tool["output_schema"]], tool["output_schema"])
        if canonical_json(output) != canonical_json(record_view_schema(type_def)):
            raise ValidationError(
                f"binding_schema_mismatch: tool {tool_id}: the output schema is not the record "
                f"view of {type_id}"
            )


def memory_handlers(package, folder, memory_run) -> dict:
    """Handlers by binding for every memory tool the package declares, over `folder`."""
    grants = {grant["permission_id"]: grant for grant in memory_run.grants}
    granted_ids = set(memory_run.granted)
    handlers = {}

    def read_handler(tool):
        legacy = tool["binding"].startswith(LEGACY_READ_BINDING_PREFIX)
        permission_id = tool["permissions"][0]

        async def handle(ctx, payload):
            if payload != {}:
                raise MemoryToolError("tool_request_invalid", "a memory read takes no arguments")
            grant = grants.get(permission_id)
            if grant is None:
                raise MemoryToolError("tool_request_invalid", "this run was granted no record")
            record = folder.record(grant["resource_id"])
            if record is None or folder.digest(record) != grant["resource_digest"]:
                raise MemoryToolError("tool_unavailable", "the granted record changed or is gone")
            if legacy:
                output = folder.legacy_answer(grant["resource_id"], grant["resource_type"])
            else:
                output = folder.view(grant["resource_id"], granted_ids)
            ctx.event(
                "memory.read",
                permission_id=permission_id,
                resource_type=grant["resource_type"],
                record_id=grant["resource_id"],
                record_digest=grant["resource_digest"],
                bytes=len(canonical_json(output)),
            )
            return output

        return handle

    async def agent_read(ctx, payload):
        agent = memory_run.agent
        if agent is None:
            raise MemoryToolError("tool_unavailable", "this run holds no agent document")
        if payload != {}:
            raise MemoryToolError(
                "tool_request_invalid", "the agent document read takes no arguments"
            )
        stored = agent["stored"]
        body = stored["body"] if stored else ""
        data = body.encode("utf-8")
        ctx.event(
            "memory.agent.read",
            package_id=agent["package_id"],
            bytes=len(data),
            present=stored is not None,
            body_sha256=hashlib.sha256(data).hexdigest(),
        )
        return {"body": body, "updated": stored["updated"] if stored else None}

    async def agent_write(ctx, payload):
        agent = memory_run.agent
        if agent is None:
            raise MemoryToolError("tool_unavailable", "this run holds no agent document")
        if (
            not isinstance(payload, dict)
            or list(payload) != ["body"]
            or not isinstance(payload["body"], str)
        ):
            raise MemoryToolError(
                "tool_request_invalid", "the agent document write takes exactly one body"
            )
        if len(payload["body"]) > MAX_AGENT_BODY_CHARS:
            raise MemoryToolError(
                "tool_request_invalid",
                f"the agent document holds at most {MAX_AGENT_BODY_CHARS} characters",
            )
        data = payload["body"].encode("utf-8")
        agent["staged"] = {"body": payload["body"], "bytes": len(data)}
        ctx.event(
            "memory.agent.write",
            package_id=agent["package_id"],
            bytes=len(data),
            body_sha256=hashlib.sha256(data).hexdigest(),
        )
        return {"staged": True, "bytes": len(data)}

    for tool in package.tools.values():
        binding = tool["binding"] or ""
        if binding == AGENT_READ_BINDING:
            handlers[binding] = agent_read
        elif binding == AGENT_WRITE_BINDING:
            handlers[binding] = agent_write
        elif binding.startswith((MEMORY_READ_BINDING_PREFIX, LEGACY_READ_BINDING_PREFIX)):
            handlers[binding] = read_handler(tool)
    return handlers


def parse_memory_grants(package, folder, values: list[str]) -> list[dict]:
    """`--memory-grant PERMISSION=RECORD`, repeatable: one record per `memory.read` (or
    `personal.read`) permission, resolved against the folder (M-12, M-63)."""
    permissions = {p["id"]: p for p in package.policy["permissions"]}
    grants: list[dict] = []
    for value in values:
        permission_id, separator, record_id = value.partition("=")
        if not separator or not permission_id or not record_id:
            raise ValidationError(f"--memory-grant {value!r}: expected PERMISSION=RECORD")
        permission = permissions.get(permission_id)
        if permission is None or permission["kind"] not in ("memory.read", "personal.read"):
            raise ValidationError(
                f"--memory-grant {permission_id}: not a memory.read or personal.read permission "
                "of this package"
            )
        if any(grant["permission_id"] == permission_id for grant in grants):
            raise ValidationError(f"--memory-grant {permission_id}: granted twice")
        if folder is None:
            raise ValidationError("--memory-grant requires --memory-dir")
        grants.append(folder.grant(permission, record_id))
    return grants


def cli_memory(package, *, mode: str, decisions: dict, memory_dir=None, memory_grants=()):
    """How `agentpkg run` builds a run's memory (M-62, M-63, D-230).

    With `--memory-dir`: the scan set is the folder's whole store and the grants are the
    `--memory-grant` flags. Without it, in fixture mode: the scan set and the grants come from the
    replayed `memory.read` views (M-62). Fixture mode replays every memory tool and touches no
    store; live mode answers from the folder and commits the agent document on completion.
    Returns `(memory_run, folder, handlers)`; `handlers` is empty in fixture mode.
    """
    from .folder import MemoryFolder
    from .run import MemoryRun, fixture_memory
    from .scan import scan_set_of

    probe = MemoryRun(package, [], decisions)
    types = probe.types
    check_memory_bindings(package, types)
    folder = MemoryFolder(memory_dir, types=types) if memory_dir else None
    grants = parse_memory_grants(package, folder, list(memory_grants))
    scan: list[dict] = []
    targets: dict = {}
    agent_document = None
    if folder is not None:
        scan = scan_set_of(folder.scan_records())
        for grant in grants:
            record = folder.records[grant["resource_id"]]
            targets[record["id"]] = {"sealed": record.get("sealed", []), "type": record["type"]}
        if mode == "live":
            agent_document = folder.agent_document(package.manifest["package_id"])
    elif mode == "fixture" and package.graph.get("fixture"):
        fixture = package.json(package.graph["fixture"])
        scan, derived = fixture_memory(package, fixture, decisions, types=types)
        grants = grants or derived
        for case_list in (fixture.get("tools") or {}).values():
            for case in case_list if isinstance(case_list, list) else []:
                output = case.get("output")
                if isinstance(output, dict) and any(
                    g["resource_id"] == output.get("id") for g in grants
                ):
                    targets[output["id"]] = {
                        "sealed": list(output.get("sealed") or []),
                        "type": output.get("type"),
                    }
    memory_run = MemoryRun(
        package,
        grants,
        decisions,
        scan=scan,
        targets=targets,
        agent_document=agent_document,
    )
    handlers = memory_handlers(package, folder, memory_run) if folder and mode == "live" else {}
    return memory_run, folder, handlers
