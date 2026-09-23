"""The execution runner: verify, construct the generic runtime, run the graph.

This is the composition layer, and composing trusted components is all it does.
It holds no orchestration of its own:

    verified Package        <- agentpkg.package, agentpkg.signing
        |
        v
    Runtime                 <- agentpkg.runtime   (authority, budgets, audit)
        |
        v
    Workflow                <- agentpkg.workflow  (the generic interpreter)
        |
        v
    HostBridgeModelRouter   <- agentpkg.hostbridge (the exact planned model)

There is no runner for a particular package, no branch on a package id, name,
capability, task, skill or graph node, and no orchestration that a graph could
not express. What a package does is what its graph says, and an unrelated graph
would run through exactly this code path.

The one thing this module *adds* is refusal. Before a package instruction can
reach a model it re-verifies the artifact it was handed, refuses a package
whose declarations exceed this host's capabilities, carries the person's
decisions through unchanged, validates the input, and binds the exact model the
run plan named.
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
from datetime import UTC, datetime

from ..artifacts import artifact_records, write_artifacts_fd
from ..errors import AgentPkgError
from ..hostbridge import protocol as bridge_protocol
from ..hostbridge.errors import BridgeError
from ..hostbridge.peer import BridgePeer, stdio_streams
from ..hostbridge.router import HostBridgeModelRouter
from ..hostbridge.session import normalize_binding
from ..package import sha256
from ..runtime import digest
from ..validation import validate_instance
from ..workflow import Workflow
from . import protocol
from .artifact import read_execution_artifact, verify_execution_artifact
from .errors import (
    ALREADY_STARTED,
    ARTIFACTS_FAILED,
    INPUT_INVALID,
    NOT_BOUND,
    ExecutionError,
    invalid,
)
from .invocation import build_invocation
from .policy import (
    HostExecutionLimits,
    check_capabilities,
    check_model,
    effective_budget,
    effective_deadline_seconds,
    grant_report,
    normalize_grants,
)
from .report import audit_summary, cost_summary, model_evidence

EXECUTION_RESULT_SCHEMA = "agentpkg-execution-result-v0"
MAX_TEXT = 512
MAX_IDS = 64
DEFAULT_REQUEST_TIMEOUT_SECONDS = 300.0
MAX_ARTIFACTS = 64


def _fields(value, field: str, allowed: set[str], required: set[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        raise invalid(f"{field} must be an object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise invalid(f"Unknown fields in {field}: {unknown}")
    missing = sorted(required - set(value))
    if missing:
        raise invalid(f"Missing fields in {field}: {missing}")
    return value


def _text(value, field: str, *, limit: int = MAX_TEXT, allow_none: bool = False):
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not value or len(value) > limit:
        raise invalid(f"{field} must be a string of 1 to {limit} characters")
    return value


def normalize_execution_plan(raw) -> dict:
    """The bounded run-plan facts the runner is allowed to see, all required.

    Stricter than the probe's binding on purpose: a runner that will verify the
    artifact it received needs the complete identity to verify it against, so
    every field here is required rather than nullable.
    """
    record = _fields(
        raw,
        "run_plan",
        {
            "run_plan_id",
            "run_plan_sha256",
            "session_id",
            "package",
            "publisher",
            "execution",
            "model_binding",
        },
        {"run_plan_id", "run_plan_sha256", "package", "publisher", "execution", "model_binding"},
    )
    package = _fields(
        record["package"],
        "run_plan.package",
        {"package_id", "name", "version", "digest", "archive_sha256", "execution_profile"},
        {"package_id", "version", "digest", "archive_sha256"},
    )
    publisher = _fields(
        record["publisher"],
        "run_plan.publisher",
        {"signer_fingerprint", "signature_status", "trust_status"},
        {"signer_fingerprint"},
    )
    execution = _fields(
        record["execution"],
        "run_plan.execution",
        {"mode", "profile", "required_permission_ids"},
        {"mode"},
    )
    if execution["mode"] != "model":
        raise invalid("Only a model-backed run plan can be executed")
    permissions = execution.get("required_permission_ids") or []
    if not isinstance(permissions, list) or len(permissions) > MAX_IDS:
        raise invalid("run_plan.execution.required_permission_ids must be a bounded list")
    return {
        "run_plan_id": _text(record["run_plan_id"], "run_plan_id", limit=128),
        "run_plan_sha256": _text(record["run_plan_sha256"], "run_plan_sha256", limit=128),
        "session_id": _text(record.get("session_id"), "session_id", limit=128, allow_none=True),
        "package": {
            "package_id": _text(package["package_id"], "package.package_id", limit=200),
            "name": _text(package.get("name"), "package.name", allow_none=True),
            "version": _text(package["version"], "package.version", limit=64),
            "digest": _text(package["digest"], "package.digest", limit=128),
            "archive_sha256": _text(
                package["archive_sha256"], "package.archive_sha256", limit=128
            ),
            "execution_profile": _text(
                package.get("execution_profile"),
                "package.execution_profile",
                limit=64,
                allow_none=True,
            ),
        },
        "publisher": {
            "signer_fingerprint": _text(
                publisher["signer_fingerprint"], "publisher.signer_fingerprint", limit=128
            ),
            "signature_status": _text(
                publisher.get("signature_status"),
                "publisher.signature_status",
                limit=64,
                allow_none=True,
            ),
            "trust_status": _text(
                publisher.get("trust_status"), "publisher.trust_status", limit=64, allow_none=True
            ),
        },
        "execution": {
            "mode": "model",
            "profile": _text(
                execution.get("profile"), "execution.profile", limit=64, allow_none=True
            ),
            "required_permission_ids": [
                _text(item, "required_permission_ids[]", limit=200) for item in permissions
            ],
        },
        "model_binding": normalize_binding(record["model_binding"]),
    }


def normalize_authorization(raw) -> dict:
    """The consent record this run is carried out under, as the person left it."""
    record = _fields(
        raw,
        "authorization",
        {"receipt_id", "receipt_sha256", "issued_at", "expires_at", "decisions", "tool_approvals"},
        {"receipt_id", "receipt_sha256", "decisions"},
    )
    decisions = record["decisions"]
    if not isinstance(decisions, dict) or len(decisions) > MAX_IDS:
        raise invalid("authorization.decisions must be a bounded object")
    approvals = record.get("tool_approvals") or {}
    if not isinstance(approvals, dict) or len(approvals) > MAX_IDS:
        raise invalid("authorization.tool_approvals must be a bounded object")
    if any(value is True for value in approvals.values()):
        # This host runs no tools, so an approval for one would be recorded
        # consent that nothing could honour.
        raise invalid("This execution host approves no tools; tool_approvals must all be false")
    return {
        "receipt_id": _text(record["receipt_id"], "authorization.receipt_id", limit=128),
        "receipt_sha256": _text(
            record["receipt_sha256"], "authorization.receipt_sha256", limit=128
        ),
        "issued_at": _text(
            record.get("issued_at"), "authorization.issued_at", limit=64, allow_none=True
        ),
        "expires_at": _text(
            record.get("expires_at"), "authorization.expires_at", limit=64, allow_none=True
        ),
        "decisions": {
            _text(key, "authorization.decisions key", limit=200): _text(
                value, f"authorization.decisions[{key}]", limit=32
            )
            for key, value in sorted(decisions.items())
        },
        "tool_approvals": {},
    }


class ExecutionSession:
    """One run, from bound plan to written artifacts, and then nothing more."""

    def __init__(self, peer: BridgePeer, *, package_fd: int, artifacts_fd: int):
        self._peer = peer
        self._package_fd = package_fd
        self._artifacts_fd = artifacts_fd
        self.ended = asyncio.Event()
        # Bound in execution.begin.
        self.plan: dict | None = None
        self.package = None
        self.router: HostBridgeModelRouter | None = None
        self.invocation: dict | None = None
        self._grants: dict = {}
        self._limits = HostExecutionLimits()
        self._input = None
        self._evidence: dict = {}
        self._host: dict = {}
        # Run state.
        self._workflow: Workflow | None = None
        self._started = False
        self._finished = False
        self._cancel_requested = False
        self._timed_out = False
        self._outcome: dict | None = None

    async def __call__(self, method: str, params: dict) -> dict:
        if method == "execution.begin":
            return self._begin(params)
        if method == "execution.run":
            return await self._run(params)
        if method == "execution.cancel":
            return self._cancel(params)
        if method == "execution.end":
            return self._end(params)
        # Unreachable: the peer refuses anything outside its allowlist first.
        raise ExecutionError("unknown_method", f"Unsupported method {method[:64]!r}")

    # -- bind ----------------------------------------------------------------
    def _begin(self, params: dict) -> dict:
        record = _fields(
            params,
            "execution.begin",
            {"run_id", "run_plan", "authorization", "limits", "input", "host"},
            {"run_id", "run_plan", "authorization", "input"},
        )
        if self.plan is not None:
            raise ExecutionError(ALREADY_STARTED, "This execution session is already bound")
        run_id = _text(record["run_id"], "run_id", limit=128)
        plan = normalize_execution_plan(record["run_plan"])
        authorization = normalize_authorization(record["authorization"])
        limits = HostExecutionLimits.normalize(record.get("limits"))
        host = _fields(
            record.get("host") or {}, "host", {"runtime", "runtime_version", "verified_version"}
        )

        # 1. The bytes. Verified here, independently, against the plan's identity.
        data = read_execution_artifact(self._package_fd)
        package, evidence = verify_execution_artifact(
            data,
            {
                "archive_sha256": plan["package"]["archive_sha256"],
                "digest": plan["package"]["digest"],
                "package_id": plan["package"]["package_id"],
                "version": plan["package"]["version"],
                "signer_fingerprint": plan["publisher"]["signer_fingerprint"],
            },
        )

        # 2. What this host can and cannot run, from the graph's declarations.
        capabilities = check_capabilities(package, limits)

        # 3. The person's decisions, unchanged or refused.
        grants = normalize_grants(package, authorization["decisions"])
        for permission_id in plan["execution"]["required_permission_ids"]:
            if grants.get(permission_id, "deny") == "deny":
                raise ExecutionError(
                    "execution_permission_denied",
                    f"A model-backed run requires permission {permission_id!r}, which is denied.",
                    detail={"permission": permission_id},
                )

        # 4. The exact model, and whether it can satisfy the package at all.
        router = HostBridgeModelRouter(
            self._peer,
            plan["model_binding"],
            request_timeout_seconds=DEFAULT_REQUEST_TIMEOUT_SECONDS,
        )
        model = check_model(package, router)

        # 5. The task. Checked against the package's own input schema before a
        #    single instruction is rendered, so bad input costs nothing.
        invocation = build_invocation(run_id=run_id, plan=plan, input_value=record["input"])
        try:
            validate_instance(
                package.files, package.graph["input_schema"], record["input"], "workflow input"
            )
        except AgentPkgError as exc:
            raise ExecutionError(
                INPUT_INVALID,
                f"The workflow input does not satisfy the package input schema: {exc}",
            ) from exc

        self.plan = plan
        self.package = package
        self.router = router
        self.invocation = invocation
        self._grants = grants
        self._limits = limits
        self._input = record["input"]
        self._evidence = evidence
        self._host = {
            "runtime": host.get("runtime"),
            "runtime_version": host.get("runtime_version"),
            "verified_version": host.get("verified_version"),
        }
        return {
            "protocol": protocol.EXECUTION_PROTOCOL_VERSION,
            "run_id": run_id,
            "run_plan_id": plan["run_plan_id"],
            "run_plan_sha256": plan["run_plan_sha256"],
            "invocation": invocation,
            "package": evidence,
            "authorization": {
                "receipt_id": authorization["receipt_id"],
                "receipt_sha256": authorization["receipt_sha256"],
                **grant_report(package, grants),
            },
            "capabilities": capabilities,
            "model": model,
            "router": router.describe(),
            "limits": {
                "host": limits.as_json(),
                "budget": effective_budget(package, limits),
                "graph_deadline_seconds": package.graph["deadline_seconds"],
                "effective_deadline_seconds": effective_deadline_seconds(package, limits),
            },
            "execution": {
                "profile": package.graph.get("profile", package.manifest["entrypoint"]),
                "interpreter": "agentpkg.workflow.Workflow",
                "tool_handlers": 0,
                "note": (
                    "The generic interpreter runs the package's own graph. This runner "
                    "contains no package-specific orchestration and installs no tool handler."
                ),
            },
        }

    # -- run -----------------------------------------------------------------
    async def _run(self, params: dict) -> dict:
        _fields(params, "execution.run", set())
        if self.plan is None or self.package is None:
            raise ExecutionError(NOT_BOUND, "Begin an execution session before running it")
        if self._started:
            raise ExecutionError(
                ALREADY_STARTED, "One execution session runs one workflow; prepare another"
            )
        self._started = True
        started = datetime.now(UTC)
        try:
            workflow = Workflow(
                self.package,
                grants=self._grants,
                # No tool handler is installed. A package that declared a tool
                # was already refused in execution.begin, so this is not a hole
                # a run could fall through: it is the same fact stated twice.
                handlers={},
                router=self.router,
                limits=self._limits.runtime_limits(),
                approved_tools=[],
            )
        except AgentPkgError as exc:
            raise ExecutionError(
                "execution_runtime_refused", f"The runtime refused this package: {exc}"
            ) from exc
        self._workflow = workflow
        if self._cancel_requested:
            # A cancellation that arrived between `begin` and `run` is honoured
            # rather than merely recorded: the workflow is stopped before its
            # first node, and the run reports `cancelled` with an audit.
            workflow.cancel()
        deadline = effective_deadline_seconds(self.package, self._limits)
        watchdog = asyncio.create_task(self._watchdog(deadline, workflow))
        task = asyncio.create_task(self._execute(workflow))
        try:
            await task
        except asyncio.CancelledError:
            if not (self._cancel_requested or self._timed_out):
                # The parent cancelled this request itself: stop the workflow,
                # drain it, and let the peer answer `cancelled`.
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
                raise
        finally:
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watchdog
            self._finished = True
        return self._finish(started, datetime.now(UTC))

    async def _watchdog(self, seconds: int, workflow: Workflow) -> None:
        """The host's own run deadline, on top of the graph's."""
        await asyncio.sleep(seconds)
        self._timed_out = True
        workflow.cancel()

    async def _execute(self, workflow: Workflow) -> None:
        """Run the graph and record its classified outcome, however it ends."""
        try:
            self._outcome = await workflow.run(self._input)
        except asyncio.CancelledError as exc:
            self._outcome = getattr(exc, "execution_report", None) or {
                "status": "cancelled",
                "error_code": "cancelled",
                "audit": list(workflow.runtime.audit),
                "usage": workflow.runtime.usage,
            }
            raise
        except BaseException as exc:
            report = getattr(exc, "execution_report", None)
            if report is None:
                raise
            # A classified workflow failure is a reported outcome, not a
            # transport failure: the artifacts and audit still matter.
            self._outcome = report

    def _finish(self, started: datetime, ended: datetime) -> dict:
        outcome = self._outcome or {"status": "failed", "error_code": "worker_error"}
        status = outcome.get("status", "failed")
        error_code = outcome.get("error_code")
        if self._timed_out:
            # The host deadline stops a run by cancelling it; calling that
            # "cancelled" would hide who stopped it and why.
            status, error_code = "failed", "timeout"
        audit = outcome.get("audit") or []
        summary = audit_summary(audit)
        artifacts = self._write_artifacts(outcome)
        output = outcome.get("output")
        return {
            "schema": EXECUTION_RESULT_SCHEMA,
            "run_id": self.invocation["run_id"],
            "run_plan_id": self.plan["run_plan_id"],
            "run_plan_sha256": self.plan["run_plan_sha256"],
            "run_invocation_sha256": self.invocation["run_invocation_sha256"],
            "input_sha256": self.invocation["input_sha256"],
            "status": status,
            "error_code": error_code,
            "deadline_exceeded": self._timed_out,
            "cancel_requested": self._cancel_requested,
            "package": self._evidence,
            "grants": grant_report(self.package, self._grants),
            "limits": {
                "host": self._limits.as_json(),
                "budget": effective_budget(self.package, self._limits),
                "effective_deadline_seconds": effective_deadline_seconds(
                    self.package, self._limits
                ),
            },
            "model": model_evidence(self.router, self.plan["model_binding"]["host_model_id"]),
            "router": self.router.describe(),
            "usage": outcome.get("usage"),
            "cost": cost_summary(audit),
            "audit": summary,
            "output": {
                "present": output is not None,
                "sha256": digest(output) if output is not None else None,
            },
            "artifacts": artifacts,
            "provenance": outcome.get("provenance"),
            "host": dict(self._host),
            "timing": {
                "started_at": started.isoformat(),
                "ended_at": ended.isoformat(),
                "duration_ms": round((ended - started).total_seconds() * 1000, 3),
            },
            "package_execution": {
                "workflow_instantiated": True,
                "interpreter": "agentpkg.workflow.Workflow",
                "package_instructions_loaded": True,
                "tool_handlers_installed": 0,
                "tool_calls": summary["tool_calls"],
            },
        }

    def _write_artifacts(self, outcome: dict) -> list[dict]:
        """Write this run's files into the directory the parent opened for it."""
        try:
            records = artifact_records(outcome, self.package)
            if len(records) > MAX_ARTIFACTS:
                raise ExecutionError(ARTIFACTS_FAILED, "Too many run artifacts")
            write_artifacts_fd(self._artifacts_fd, records)
        except ExecutionError:
            raise
        except (AgentPkgError, OSError) as exc:
            raise ExecutionError(
                ARTIFACTS_FAILED, f"The run artifacts could not be written: {type(exc).__name__}"
            ) from exc
        return [
            {"name": name, "bytes": len(data), "sha256": sha256(data)} for name, data in records
        ]

    # -- control -------------------------------------------------------------
    def _cancel(self, params: dict) -> dict:
        _fields(params, "execution.cancel", set())
        self._cancel_requested = True
        if self._workflow is not None and not self._finished:
            self._workflow.cancel()
        return {
            "cancel_requested": True,
            "running": self._started and not self._finished,
        }

    def _end(self, params: dict) -> dict:
        _fields(params, "execution.end", set())
        self.ended.set()
        return {"ended": True, "ran": self._started, "status": (self._outcome or {}).get("status")}


async def serve(
    *, package_fd: int = protocol.PACKAGE_FD, artifacts_fd: int = protocol.ARTIFACTS_FD
) -> int:
    """Run one execution session on this process's stdio until EOF or end."""
    reader, writer = await stdio_streams()
    session: ExecutionSession | None = None

    async def handler(method: str, params: dict) -> dict:
        return await session(method, params)

    peer = BridgePeer(
        reader,
        writer,
        outbound_methods=protocol.RUNNER_OUTBOUND_METHODS,
        inbound_methods=protocol.EXECUTION_METHODS,
        handler=handler,
        prefix="x",
        version=protocol.EXECUTION_PROTOCOL_VERSION,
    )
    session = ExecutionSession(peer, package_fd=package_fd, artifacts_fd=artifacts_fd)
    serving = asyncio.create_task(peer.serve())
    ended = asyncio.create_task(session.ended.wait())
    try:
        done, _ = await asyncio.wait({serving, ended}, return_when=asyncio.FIRST_COMPLETED)
        if serving in done:
            serving.result()  # Re-raise a protocol violation.
        return 0
    except bridge_protocol.ProtocolError as exc:
        print(f"agentpkg-execution: {exc}", file=sys.stderr, flush=True)
        return 3
    finally:
        ended.cancel()
        await peer.close(BridgeError("bridge_closed", "The execution session ended"))
        serving.cancel()
        try:
            await serving
        except (asyncio.CancelledError, Exception):  # noqa: B014 - shutdown is best effort
            pass


__all__ = [
    "EXECUTION_RESULT_SCHEMA",
    "ExecutionSession",
    "normalize_authorization",
    "normalize_execution_plan",
    "serve",
]
