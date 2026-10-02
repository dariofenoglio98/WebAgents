"""One contract run, through the real production path, and what it left behind.

The sequence is the one a person follows on the Agent Browser page, issued as
the page's own operations against the real `AgentBrowserBackend`:

    openLocal  ->  [pinSessionPublisher]  ->  getPermissions  ->  authorize
    -> [selectFile]  ->  evaluateTools / evaluateModels  ->  prepareRunPlan
    -> (case hooks: the world changes between plan and run)  ->  validateInput
    -> startExecution

Everything after `startExecution` is production code end to end: the plugin's
start checks and `revalidate`, the control plane's lease, the runner's
`execution.begin` / `execution.run`, `Workflow`, `Runtime`, the model router
and tool handlers, the host bridge, `completeWithBoundModel` and the
`ToolBroker`. The case's synthetic model, services and faults answer only at
the seams the plugin exposes for its own tests.

The pipeline never decides an outcome. It records what happened; `oracle.py`
judges it.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import hashlib
import json
import os
import shutil
import stat
import time
from pathlib import Path
from urllib.parse import urlsplit

from .plan import CasePlan
from .synthetic import Canaries, Corpus, Provider, Services, SyntheticModel, pdf_bytes, pdf_text
from .world import experiment_definitions, task_input

STEPS = (
    "open",
    "pin",
    "permissions",
    "authorize",
    "select_file",
    "evaluate",
    "prepare",
    "hooks",
    "validate_input",
    "start",
)


def _short(value, limit=600):
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text[:limit]


class CaseContext:
    """Everything one case owns. Discarded with the case."""

    def __init__(self, plan: CasePlan, helper, workdir: Path, *, probe=None):
        from agentpkg.browser import BrowserPolicy, ControlPlane, ControlPlaneConfig
        from agentpkg.browser.server import BrowserAPI

        self.plan = plan
        self.helper = helper
        self.dir = Path(workdir)
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=False)
        for name in ("packages", "files", "state", "cache"):
            (self.dir / name).mkdir(mode=0o700)
        self.events: list[dict] = []
        self.control_errors: list[dict] = []
        self.control_crashes: list[dict] = []
        self.control_calls: list[tuple[str, str, int]] = []
        self.runner_results: dict[str, dict] = {}
        self.runner_session = None
        self.commits: list[dict] = []
        self.probe = probe
        self.trace: list[dict] = []
        self.page_errors: list[dict] = []
        self.session_id: str | None = None
        self.receipt_id: str | None = None
        self.plan_ref: dict | None = None
        self.file_ids: list[str] = []
        self.model_host = copy.deepcopy(plan.host.model_host)
        self.canaries = Canaries()
        self.control = ControlPlane(
            ControlPlaneConfig(
                cache_dir=self.dir / "cache",
                trust_store_path=self.dir / "trust.json",
                session_ttl_seconds=plan.host.session_ttl_seconds,
                policy=BrowserPolicy(**plan.host.browser_policy),
            )
        )
        self.api = BrowserAPI(self.control)
        self.pdf = pdf_bytes()
        self.services = Services(
            Corpus(),
            self.canaries,
            endpoints=[],
            faults=plan.faults,
            files={hashlib.sha256(self.pdf).hexdigest(): pdf_text()},
        )
        self.provider = Provider(
            plan.package,
            SyntheticModel(),
            self.canaries,
            host=lambda: self.model_host,
            faults=plan.faults,
        )
        self.provider.planned_model = plan.model_id
        self.provider.record_answers = plan.record_answers
        self.lease_rewrite: bytes | None = None
        self.artifacts: list[dict] = []
        self.run_dir: str | None = None

    # -- callbacks from the host ---------------------------------------------------------
    def record(self, event: str, **fields) -> None:
        self.events.append({"event": event, "t": time.perf_counter(), **fields})

    def control_ok(self, method, path, status) -> None:
        self.control_calls.append((method, _route(path), status))

    def control_error(self, method, path, exc) -> None:
        details = exc.details or {}
        reasons = []
        for key in ("blocking_reasons",):
            for item in details.get(key) or []:
                if isinstance(item, dict):
                    reasons.append({"code": item.get("code"), "subject": item.get("subject")})
        preflight = details.get("preflight") or {}
        stale = [
            {"code": item.get("code"), "subject": item.get("subject")}
            for item in preflight.get("stale_reasons") or []
            if isinstance(item, dict)
        ]
        validation = details.get("validation") or {}
        self.control_calls.append((method, _route(path), exc.status))
        self.control_errors.append(
            {
                "route": f"{method} {_route(path)}",
                "code": exc.code,
                "status": exc.status,
                "blocking_reasons": reasons,
                "stale_reasons": stale,
                "validation": {
                    key: validation.get(key)
                    for key in (
                        "container_status",
                        "integrity_status",
                        "schema_status",
                        "runtime_status",
                    )
                    if key in validation
                },
                "validation_errors": [
                    {"layer": item.get("layer"), "message": str(item.get("message", ""))[:300]}
                    for item in validation.get("errors") or []
                    if isinstance(item, dict)
                ],
                "message": str(exc)[:300],
            }
        )

    def control_crash(self, method, path, exc) -> None:
        self.control_calls.append((method, _route(path), 500))
        self.control_crashes.append(
            {"route": f"{method} {_route(path)}", "error": f"{type(exc).__name__}: {exc}"[:500]}
        )

    def runner_result(self, method: str, result: dict) -> None:
        self.runner_results[method] = result

    def before_runner_reads(self, lease_path: str) -> None:
        if self.lease_rewrite is not None:
            # An in-place rewrite of the leased file after the host opened it:
            # the descriptor sees the new bytes (same inode).
            os.chmod(lease_path, stat.S_IRUSR | stat.S_IWUSR)
            with open(lease_path, "r+b") as stream:
                stream.truncate(0)
                stream.write(self.lease_rewrite)
            os.chmod(lease_path, stat.S_IRUSR)
            self.record("lease.rewritten", bytes=len(self.lease_rewrite))

    # -- helpers the hooks use ---------------------------------------------------------------
    async def update_host(self, *, model_host=None, tools="unchanged", definitions=None) -> None:
        update: dict = {}
        if model_host is not None:
            self.model_host = model_host
            update["model_host"] = model_host
        if tools != "unchanged":
            update["tools"] = tools
        if definitions is not None:
            update["tool_definitions"] = definitions
        await self.helper.call("case.update", update)

    async def page(self, step: str, method: str, *args):
        started = time.perf_counter()
        result = await self.helper.backend(method, *args)
        entry = {"step": step, "op": method, "ms": round((time.perf_counter() - started) * 1000, 3)}
        if isinstance(result, dict) and result.get("ok") is False:
            error = result.get("error") or {}
            entry["error"] = {
                "code": error.get("code"),
                "title": error.get("title"),
                "detail": _short(error.get("detail", ""), 2000),
            }
            self.page_errors.append({"step": step, "op": method, **entry["error"]})
        else:
            entry["ok"] = True
        self.trace.append(entry)
        return result

    def cleanup(self) -> None:
        with contextlib.suppress(Exception):
            self.control.shutdown()
        shutil.rmtree(self.dir, ignore_errors=True)


def _route(path: str) -> str:
    parts = [part for part in str(path).split("/") if part]
    if len(parts) >= 3 and parts[1] == "packages" and parts[2] not in ("open-file", "open-url"):
        parts[2] = "{session}"
    if len(parts) >= 5 and parts[3] == "execution-lease":
        parts[4] = "{lease}"
    if len(parts) >= 3 and parts[1] == "trust":
        parts[2] = "{fingerprint}"
    return "/" + "/".join(parts)


def authorized_endpoints(package, decisions: dict) -> list[tuple[str, str, str]]:
    """(host, path, method) a run may legitimately reach: a declared remote tool
    whose host is a resource of a granted network permission it links to."""
    permissions = {item["id"]: item for item in package.policy["permissions"]}
    endpoints = []
    for tool in package.tools.values():
        if tool["execution"] != "remote" or not tool.get("endpoint"):
            continue
        parts = urlsplit(tool["endpoint"])
        granted = {
            resource
            for pid in tool["permissions"]
            if pid in permissions
            and permissions[pid]["kind"] == "network"
            and decisions.get(pid, "deny") != "deny"
            for resource in permissions[pid]["resources"]
        }
        if parts.hostname in granted:
            endpoints.append((parts.hostname, parts.path or "/", tool["method"]))
    return endpoints


async def run_case(plan: CasePlan, helper, workdir: Path, *, probe=None, guard=None) -> dict:
    """Execute one plan and return the raw observation."""
    started = time.perf_counter()
    ctx = CaseContext(plan, helper, workdir, probe=probe)
    observation: dict = {}
    helper.bind(ctx)
    ctx.map_refusals = []
    if probe is not None:
        probe.sink = ctx.commits
        probe.map_sink = ctx.map_refusals
    # Canary files this case's attack strings point at. Opening one is refused
    # and recorded, by this process and by the Node host alike.
    canary_dir = ctx.dir / "canary"
    canary_dir.mkdir(mode=0o700)
    (canary_dir / "secret.pdf").write_bytes(b"%PDF-1.4\n% canary: must never be read\n%%EOF\n")
    ctx.canary_dir = canary_dir
    sensitive = [str(canary_dir), *plan.sensitive]
    guard_mark = len(guard.refused) if guard is not None else 0
    if guard is not None:
        guard.sensitive_prefixes = list(sensitive)
    await helper.call(
        "helper.configure", {"sensitive_prefixes": sensitive, "sensitive_substrings": []}
    )
    failures_before = len(helper.rpc.handler_failures)
    try:
        try:
            async with asyncio.timeout(plan.timeout_seconds):
                await _drive(ctx)
        except TimeoutError:
            ctx.record("harness.case_timeout", seconds=plan.timeout_seconds)
        except Exception as exc:  # noqa: BLE001 - the harness's own failure, recorded
            ctx.record("harness.exception", error=f"{type(exc).__name__}: {exc}"[:500])
        observation = await _observe(ctx)
        observation["rpc_failures"] = helper.rpc.handler_failures[failures_before:]
        observation["python_sensitive"] = (
            [
                item
                for item in guard.refused[guard_mark:]
                if item["kind"] in ("open", "os.open", "io.open")
            ]
            if guard is not None
            else []
        )
        observation["python_guard"] = guard.refused[guard_mark:] if guard is not None else []
    finally:
        if probe is not None:
            probe.sink = None
            probe.map_sink = None
        if guard is not None:
            guard.sensitive_prefixes = []
        with contextlib.suppress(Exception):
            await helper.call("case.end", {}, timeout=60)
        if helper.runners is not None:
            await helper.runners.drain()
        helper.unbind()
        ctx.cleanup()
    observation["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 3)
    return observation


async def _hooks(ctx: CaseContext, point: str) -> None:
    for hook in ctx.plan.hooks.get(point, []):
        ctx.record("hook", point=point, name=getattr(hook, "__name__", "hook"))
        await hook(ctx)


async def _drive(ctx: CaseContext) -> None:
    plan = ctx.plan
    helper = ctx.helper
    for pin in plan.pins:
        from agentpkg.browser.trust import public_key_from_pem

        ctx.control.trust.add(
            public_key_from_pem(pin.public_pem),
            display_name=pin.display_name,
            publisher_id=pin.publisher_id,
            package_id_prefix=pin.package_id_prefix,
        )
    archive = ctx.dir / "packages" / f"{plan.package}.agent.pkg"
    archive.write_bytes(plan.archive)
    pdf = ctx.dir / "files" / "selected.pdf"
    pdf.write_bytes(ctx.pdf)
    definitions = plan.host.definitions or experiment_definitions(helper.hello["built_in_bindings"])
    await helper.call(
        "case.begin",
        {
            "case_ref": str(ctx.dir.name),
            "state_dir": str(ctx.dir / "state"),
            "config": {
                "agentpkgPath": "agentpkg-in-process-runner",
                "localPackages": {"roots": [str(ctx.dir / "packages")]},
                "localFiles": {"roots": [str(ctx.dir / "files")]},
                "sessionTtlSeconds": plan.host.session_ttl_seconds,
                "execution": dict(plan.host.policy),
                **({"tools": plan.host.tools} if plan.host.tools is not None else {}),
            },
            "model_host": ctx.model_host,
            "tool_definitions": definitions,
        },
    )
    await _hooks(ctx, "before_open")

    opened = await ctx.page("open", "openLocal", str(archive))
    if not opened.get("ok"):
        return
    ctx.session_id = opened["value"]["sessionId"]
    session = ctx.control._session(ctx.session_id)
    ctx.services.set_endpoints(authorized_endpoints(session.package, plan.decisions))
    await _hooks(ctx, "after_open")

    if plan.pin_session_signer:
        signer = ctx.control.summary(ctx.session_id)["publisher"]["signer_fingerprint"]
        pinned = await ctx.page(
            "pin", "pinSessionPublisher", ctx.session_id, signer or "", plan.pin_session_signer
        )
        if not pinned.get("ok"):
            return

    digest = ctx.control.summary(ctx.session_id)["package"]["digest"]
    ctx.digest = digest
    await ctx.page("permissions", "getPermissions", ctx.session_id)
    await _hooks(ctx, "before_authorize")
    decisions = [{"permissionId": key, "decision": value} for key, value in plan.decisions.items()]
    approvals = [{"toolId": key, "approved": value} for key, value in plan.approvals.items()]
    shown = getattr(ctx, "authorize_digest_override", None) or digest
    authorized = await ctx.page(
        "authorize", "authorize", ctx.session_id, shown, decisions, approvals
    )
    if not authorized.get("ok"):
        return
    ctx.receipt_id = ctx.control.authorization(ctx.session_id)["receipt_id"]
    await _hooks(ctx, "after_authorize")

    if plan.attach_pdf:
        selected = await ctx.page("select_file", "selectFile", ctx.session_id, str(pdf))
        if not selected.get("ok"):
            return
        ctx.file_ids.append(selected["value"]["fileId"])

    await ctx.page("evaluate", "evaluateTools", ctx.session_id)
    await ctx.page("evaluate", "evaluateModels", ctx.session_id)

    await _hooks(ctx, "before_prepare")
    receipt_shown = getattr(ctx, "prepare_receipt_override", None) or ctx.receipt_id
    prepared = await ctx.page(
        "prepare", "prepareRunPlan", ctx.session_id, digest, receipt_shown, plan.model_id
    )
    if not prepared.get("ok"):
        return
    state = ctx.control.run_plan(ctx.session_id)
    ctx.plan_ref = {
        "run_plan_id": state["run_plan"]["run_plan_id"],
        "run_plan_sha256": state["run_plan"]["run_plan_sha256"],
    }
    ctx.record("plan.prepared", ready=state["run_plan"]["readiness"]["ready"])
    await _hooks(ctx, "after_prepare")

    task = (
        copy.deepcopy(plan.input)
        if plan.input is not None
        else task_input(plan.package, ctx.file_ids[0] if ctx.file_ids else None)
    )
    if plan.input_patch is not None:
        task = plan.input_patch(task, ctx)
    await ctx.page("validate_input", "validateInput", ctx.session_id, task)
    start = {
        "session_id": ctx.session_id,
        "run_plan_id": ctx.plan_ref["run_plan_id"],
        "run_plan_sha256": ctx.plan_ref["run_plan_sha256"],
        "input": task,
        "files": list(ctx.file_ids),
    }
    if plan.start_override is not None:
        start = plan.start_override(start, ctx)
    await _hooks(ctx, "before_start")
    ctx.preflight_before_start = _preflight_codes(ctx)
    ctx.start_mark = len(ctx.control_errors)
    ctx.record("start.requested")
    result = await ctx.page(
        "start",
        "startExecution",
        start["session_id"],
        start["run_plan_id"],
        start["run_plan_sha256"],
        start["input"],
        start["files"],
    )
    if result.get("ok"):
        ctx.run_record = result["value"]


def _preflight_codes(ctx: CaseContext) -> dict | None:
    """The control plane's own verdict on the plan, read once before start (a read only)."""
    try:
        state = ctx.control.run_plan(ctx.session_id)
    except Exception as exc:  # noqa: BLE001 - the session or plan may be gone; that is the point
        return {"error": getattr(exc, "code", type(exc).__name__)}
    preflight = state.get("preflight") or {}
    return {
        "ready": preflight.get("ready"),
        "stale": preflight.get("stale"),
        "stale_reasons": [item.get("code") for item in preflight.get("stale_reasons") or []],
    }


def _receipt_blocking(ctx: CaseContext) -> list[str]:
    if ctx.session_id is None:
        return []
    try:
        receipt = ctx.control.authorization(ctx.session_id)
    except Exception:  # noqa: BLE001
        return []
    return [item.get("code") for item in receipt.get("blocking_reasons") or []]


async def _observe(ctx: CaseContext) -> dict:
    helper_view = None
    with contextlib.suppress(Exception):
        helper_view = await ctx.helper.call("case.observe", {}, timeout=60)
    session = ctx.runner_session
    outcome = getattr(session, "_outcome", None) if session is not None else None
    workflow = getattr(session, "_workflow", None) if session is not None else None
    audit = list(workflow.runtime.audit) if workflow is not None else []
    run = ctx.runner_results.get("execution.run")
    begin = ctx.runner_results.get("execution.begin")
    final_output = copy.deepcopy(outcome.get("output")) if isinstance(outcome, dict) else None
    final_state = copy.deepcopy(outcome.get("state")) if isinstance(outcome, dict) else None
    record = getattr(ctx, "run_record", None)
    artifacts = []
    if ctx.run_dir and os.path.isdir(ctx.run_dir):
        for name in sorted(os.listdir(ctx.run_dir)):
            path = os.path.join(ctx.run_dir, name)
            with contextlib.suppress(OSError):
                artifacts.append({"name": name, "bytes": os.path.getsize(path)})
    halted = getattr(workflow.runtime, "_halted", None) if workflow is not None else None
    start_mark = getattr(ctx, "start_mark", None)
    return {
        "trace": ctx.trace,
        "page_errors": ctx.page_errors,
        "receipt_blocking": _receipt_blocking(ctx),
        "start_control_errors": ctx.control_errors[start_mark:] if start_mark is not None else [],
        "preflight_before_start": getattr(ctx, "preflight_before_start", None),
        "halted": halted,
        "control_errors": ctx.control_errors,
        "control_crashes": ctx.control_crashes,
        "control_calls": ctx.control_calls,
        "events": [{k: v for k, v in event.items() if k != "t"} for event in ctx.events],
        "helper": helper_view or {},
        "plan_prepared": ctx.plan_ref is not None,
        "runner_begin": _compact_begin(begin),
        "runner_run": _compact_run(run),
        "run_record": _compact_record(record),
        "audit": [_compact_event(event) for event in audit],
        "audit_raw": audit,
        "commits": ctx.commits,
        "map_refusals": list(getattr(ctx, "map_refusals", [])),
        "final_output": final_output,
        "final_state": final_state,
        "workflow_status": outcome.get("status") if isinstance(outcome, dict) else None,
        "workflow_error": outcome.get("error_code") if isinstance(outcome, dict) else None,
        "canaries": ctx.canaries,
        "faults_fired": list(ctx.plan.faults.fired),
        "artifacts": artifacts,
    }


def _compact_begin(begin):
    if not isinstance(begin, dict):
        return None
    return {
        "verified": list((begin.get("package") or {}).get("verified") or []),
        "signer": (begin.get("package") or {}).get("signer_fingerprint"),
        "model": begin.get("model"),
        "router_model": (begin.get("router") or {}).get("model_id"),
        "tools_bound": list((begin.get("tools") or {}).get("bound") or []),
        "effective_deadline_seconds": (begin.get("limits") or {}).get("effective_deadline_seconds"),
        "budget_effective": ((begin.get("limits") or {}).get("budget") or {}).get("effective"),
    }


def _compact_run(run):
    if not isinstance(run, dict):
        return None
    return {
        "status": run.get("status"),
        "error_code": run.get("error_code"),
        "deadline_exceeded": run.get("deadline_exceeded"),
        "cancel_requested": run.get("cancel_requested"),
        "failure": run.get("failure"),
        "model": run.get("model"),
        "usage": {
            key: (run.get("usage") or {}).get(key)
            for key in (
                "tokens",
                "reserved_tokens",
                "remote_calls",
                "tool_calls",
                "peak_parallel_workers",
            )
        },
        "audit": {
            key: (run.get("audit") or {}).get(key)
            for key in ("model_calls", "tool_calls", "nodes_completed", "workers_spawned")
        },
        "output": run.get("output"),
        "artifacts": [
            {"name": item.get("name"), "bytes": item.get("bytes")}
            for item in run.get("artifacts") or []
        ],
    }


def _compact_record(record):
    if not isinstance(record, dict):
        return None
    return {
        "status": record.get("status"),
        "errorCode": record.get("errorCode"),
        "errorDetail": _short(record.get("errorDetail") or "", 1000),
        "failure": record.get("failure"),
        "deadlineExceeded": record.get("deadlineExceeded"),
        "model": record.get("model"),
        "artifacts": [
            {"name": item.get("name"), "bytes": item.get("bytes")}
            for item in record.get("artifacts") or []
        ],
    }


AUDIT_KEEP = (
    "action",
    "node_id",
    "node_type",
    "error_code",
    "reason",
    "failed_check",
    "tool",
    "task",
    "model",
    "permission",
    "grant",
    "allowed",
    "nodes",
    "status",
    "binding_id",
    "endpoint_origin",
    "reserved_tokens",
    "tokens",
    "remote_calls",
    "tool_calls",
    "failure_facts",
    "error",
)


def _compact_event(event: dict) -> dict:
    return {key: event[key] for key in AUDIT_KEEP if key in event}
