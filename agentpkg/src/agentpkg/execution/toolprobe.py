"""The host-owned tool probe: one approved tool call, and nothing else.

The probe is not a run. It exists so the tool boundary can be shown to work
against a real implementation *before* any workflow depends on it, and it is
deliberately the smallest thing that can demonstrate that:

* a signed package declared the tool;
* the trusted host bound one exact implementation of it;
* the person granted the permissions it travels under **and** approved that
  implementation, as two separate decisions;
* `Runtime.call_tool` — not this module — checked all of that, validated the
  arguments against the package's own input schema, spent the budget, and
  validated the result against the package's own output schema;
* the host broker executed the one binding the plan named.

**No graph runs.** No `Workflow` is constructed, no node executes, no skill
text is read, no model request is built and no model is called. A test asserts
each of those against the run's own audit rather than against a claim here.

**One worker context, not zero.** `Runtime.call_tool` derives the role tool
allowlist, the per-worker remote-call budget and the audit identity from the
calling context, and only a worker role may hold a tool. A probe that forged a
context to avoid spawning one would be bypassing the mechanism it exists to
test, so it spawns exactly one worker of the one declared role that lists the
tool — or none at all, if the coordinator itself declares it. What the probe
proves is that **zero workflow workers** and **zero graph nodes** ran, which
the audit shows directly.

Nothing in this module names a package, a service, a domain or an application
word: the role, the permissions and the schemas all come out of the package,
and the arguments come from the trusted host that asked for the probe.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime

from ..errors import AgentPkgError
from ..package import canonical_json, sha256
from ..runtime import BudgetError, PolicyError, Runtime, digest
from ..toolbridge.errors import (
    TOOL_NOT_APPROVED,
    TOOL_NOT_BOUND,
    TOOL_NOT_DECLARED,
    TOOL_PERMISSION_DENIED,
    ToolBridgeError,
)
from .errors import ExecutionError
from .report import audit_summary

TOOL_PROBE_SCHEMA = "agentpkg-tool-probe-v0"
# A probe answer is evidence for an operator, so it carries the validated
# output. It is still bounded: the handler already refuses anything larger,
# and this is the second ceiling.
MAX_OUTPUT_BYTES = 128 * 1024
MAX_KEYS = 64


def _output_summary(value) -> dict:
    """A shape description that is safe to log even when the value is not."""
    if isinstance(value, dict):
        kind, keys, size = "object", sorted(value)[:MAX_KEYS], len(value)
    elif isinstance(value, list):
        kind, keys, size = "array", [], len(value)
    else:
        kind, keys, size = type(value).__name__, [], 0
    return {"kind": kind, "keys": keys, "size": size}


def _role_for(package, tool_id: str, requested: str | None = None) -> str:
    """The one declared role allowed to call this tool, or a refusal.

    The coordinator is preferred when it declares the tool, because then the
    probe needs no worker at all. Otherwise exactly one non-coordinator role
    must declare it: two roles would make "which authority was this attributed
    to" a choice this module is not entitled to make.

    When more than one does, the trusted host that asked for the probe names
    the role, and it must be one the package itself declares for this tool and
    approves for delegation. The choice is then the operator's and is recorded
    in the report, rather than being made here.
    """
    coordinator = package.graph["coordinator"]
    roles = [worker["id"] for worker in package.graph["workers"] if tool_id in worker["tools"]]
    approved = set(package.policy["delegation"]["approved_roles"])
    if requested is not None:
        if requested not in roles or (requested != coordinator and requested not in approved):
            raise ExecutionError(
                TOOL_PERMISSION_DENIED,
                f"Role {requested!r} does not declare {tool_id!r} with approved authority.",
                detail={"tool_id": tool_id, "roles": sorted(roles)},
            )
        return requested
    if coordinator in roles:
        return coordinator
    usable = sorted(role for role in roles if role in approved)
    if not usable:
        raise ExecutionError(
            TOOL_PERMISSION_DENIED,
            f"No approved worker role declares {tool_id!r}, so no authorized context could "
            "call it.",
            detail={"tool_id": tool_id, "roles": sorted(roles)},
        )
    if len(usable) > 1:
        raise ExecutionError(
            TOOL_PERMISSION_DENIED,
            f"More than one role declares {tool_id!r}; a probe must not choose which authority "
            "a call is attributed to, so the host must name one.",
            detail={"tool_id": tool_id, "roles": usable},
        )
    return usable[0]


async def run_tool_probe(
    *,
    package,
    plan: dict,
    handlers: dict,
    approved_tools,
    grants: dict,
    limits,
    tools: dict,
    tool_id: str,
    args,
    invocation: dict | None,
    role: str | None = None,
) -> dict:
    """Execute one mediated tool call and report exactly what happened."""
    started = datetime.now(UTC)
    if tool_id not in package.tools:
        raise ExecutionError(
            TOOL_NOT_DECLARED,
            f"This package does not declare a tool named {tool_id!r}.",
            detail={"tool_id": tool_id, "declared": sorted(package.tools)},
        )
    binding = next(
        (item for item in plan["tool_bindings"] if item["tool_id"] == tool_id),
        None,
    )
    if binding is None:
        raise ExecutionError(
            TOOL_NOT_BOUND,
            f"The run plan binds no implementation for {tool_id!r}.",
            detail={"tool_id": tool_id},
        )
    if tool_id not in set(approved_tools):
        raise ExecutionError(
            TOOL_NOT_APPROVED, f"Tool {tool_id!r} was not approved.", detail={"tool_id": tool_id}
        )
    declaration = package.tools[tool_id]
    requested_role = role
    role = _role_for(package, tool_id, requested_role)

    runtime = Runtime(
        package,
        grants=grants,
        handlers=handlers,
        # No router: a probe that could reach a model would not be a tool probe.
        router=None,
        limits=limits.runtime_limits(),
        approved_tools=list(approved_tools),
    )
    clock = time.monotonic()
    error: BaseException | None = None
    output = None
    try:
        if role == package.graph["coordinator"]:
            output = await runtime.call_tool(runtime.coordinator_context(), tool_id, args)
        else:

            async def call(context, _state):
                return await runtime.call_tool(context, tool_id, args)

            output = await runtime.run_worker(role, {}, call, return_value=True)
    except (
        PolicyError,
        BudgetError,
        ToolBridgeError,
        AgentPkgError,
        asyncio.CancelledError,
        # The declared tool timeout elapsing is an outcome of the probe, not a
        # fault of the runner: a slow service is reported as `timeout`.
        TimeoutError,
    ) as exc:
        error = exc
    finally:
        runtime.clear()
    duration = round((time.monotonic() - clock) * 1000, 3)

    audit = audit_summary(runtime.audit)
    usage = runtime.usage
    handler = handlers.get(declaration["binding"])
    calls = list(getattr(handler, "calls", ()) or ())
    encoded = canonical_json(output) if error is None else b""
    if error is None and len(encoded) > MAX_OUTPUT_BYTES:
        raise ExecutionError(
            "tool_response_invalid", "The tool result is too large to report", detail={}
        )
    completed = datetime.now(UTC)
    report = {
        "schema": TOOL_PROBE_SCHEMA,
        "status": "ok" if error is None else "failed",
        "error_code": None
        if error is None
        else "timeout"
        if isinstance(error, TimeoutError)
        else getattr(error, "code", type(error).__name__),
        "run_plan_id": plan["run_plan_id"],
        "run_plan_sha256": plan["run_plan_sha256"],
        "session_id": plan.get("session_id"),
        "run_id": (invocation or {}).get("run_id"),
        "package": dict(plan.get("package") or {}),
        "tool": {
            "id": declaration["id"],
            "version": declaration["version"],
            "binding": declaration["binding"],
            "execution": declaration["execution"],
            "remote": declaration["execution"] == "remote",
            "side_effects": declaration["side_effects"],
            "approval_required": declaration["approval_required"],
            "permissions": list(declaration["permissions"]),
            "domains": list(declaration["domains"]),
            "timeout_seconds": declaration["timeout_seconds"],
            "input_schema": declaration["input_schema"],
            "output_schema": declaration["output_schema"],
            "declared_endpoint": declaration.get("endpoint"),
        },
        "binding": {
            key: binding[key]
            for key in (
                "binding_id",
                "binding_sha256",
                "implementation_kind",
                "implementation_id",
                "implementation_version",
                "display_name",
                "remote",
                "endpoint_origin",
                "endpoint_path",
                "method",
                "contract_sha256",
                "credentials_required",
                "credentials_configured",
            )
        },
        "authority": {
            "role": role,
            "role_named_by_host": requested_role is not None,
            "worker_context": role != package.graph["coordinator"],
            "approved": True,
            "approval_source": binding.get("approval_source"),
            "grants": {pid: grants.get(pid, "deny") for pid in declaration["permissions"]},
            "permission_checks": audit["permission_checks"],
        },
        "request": {
            "args_sha256": sha256(canonical_json(args)),
            "args_bytes": len(canonical_json(args)),
            "validated_against": declaration["input_schema"],
            "note": (
                "The arguments are host-owned and were validated against the package's own "
                "declared input schema by Runtime.call_tool before anything left this host."
            ),
        },
        "result": {
            "validated_by_runtime": error is None,
            "validated_against": declaration["output_schema"],
            "output_sha256": digest(output) if error is None else None,
            "output_bytes": len(encoded),
            "summary": _output_summary(output) if error is None else None,
            "output": output if error is None else None,
        },
        "transport": {
            "calls": calls,
            "duration_ms": duration,
        },
        "usage": {
            "tool_calls": sum(usage["tool_calls"].values()),
            "tool_calls_by_id": dict(usage["tool_calls"]),
            "remote_calls": usage["remote_calls"],
            "tokens": usage["tokens"],
            "peak_parallel_workers": usage["peak_parallel_workers"],
            "limits": usage["limits"],
        },
        "audit": audit,
        "model_calls": audit["model_calls"],
        "package_execution": {
            "workflow_instantiated": False,
            "workflow_nodes_executed": audit["nodes_completed"],
            "workflow_workers_started": 0,
            "runtime_worker_contexts": audit["workers_spawned"],
            "model_calls": audit["model_calls"],
            "model_router_installed": False,
            "package_instructions_loaded": False,
            "exports_written": 0,
            "note": (
                "No graph ran. Runtime.call_tool requires a context that holds the tool, and "
                "only a worker role may, so a probe of a worker-held tool spawns exactly one "
                "worker context and no workflow worker. No model router is installed, so a "
                "model call is impossible rather than merely absent."
            ),
        },
        "tools": dict(tools),
        "timing": {
            "started_at": started.isoformat(),
            "completed_at": completed.isoformat(),
            "duration_ms": round((completed - started).total_seconds() * 1000, 3),
        },
    }
    if error is not None:
        raise ExecutionError(
            report["error_code"]
            if isinstance(report["error_code"], str)
            and (isinstance(error, TimeoutError) or isinstance(getattr(error, "code", None), str))
            else "tool_probe_failed",
            f"The tool probe failed: {type(error).__name__}",
            detail={"report": report},
        ) from error
    return report


__all__ = ["TOOL_PROBE_SCHEMA", "run_tool_probe"]
