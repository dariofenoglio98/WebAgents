"""Host-controlled execution. Package data never supplies executable handlers."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from jsonschema import Draft202012Validator

from .errors import AgentPkgError, ValidationError
from .toolbridge.facts import schema_facts
from .validation import validate_document, validate_instance


class PolicyError(AgentPkgError):
    """A package request exceeds user authority or supported runtime behavior."""


class BudgetError(PolicyError):
    """A hard bound was reached before dispatch."""


_REASON = re.compile(r"[a-z][a-z0-9_]{0,63}")
# A fact value is a count, a flag, or a structural token such as a stop reason,
# a JSON Schema keyword or a schema location. No spaces and no quotes, so prose
# — a provider message, a model answer, a document excerpt — cannot pass.
_FACT_TEXT = re.compile(r"[A-Za-z0-9_$.:/#-]{1,200}")
MAX_FAILURE_FACTS = 12


def _safe_facts(facts) -> dict:
    safe = {}
    if not isinstance(facts, dict):
        return safe
    for key, value in facts.items():
        if len(safe) >= MAX_FAILURE_FACTS:
            break
        if not isinstance(key, str) or not _REASON.fullmatch(key):
            continue
        if isinstance(value, bool) or (isinstance(value, int) and 0 <= value < 2**53):
            safe[key] = value
        elif isinstance(value, str) and _FACT_TEXT.fullmatch(value):
            safe[key] = value
    return safe


def failure_reason(exc) -> dict:
    """A failed call's stable code, when the failing adapter gave one.

    Bridge and tool errors carry a fixed identifier (`bridge_timeout`,
    `model_output_not_conforming`, `tool_unavailable`, ...) that says *which*
    failure happened. Only an identifier-shaped string is recorded, never a
    message, so nothing a provider or service wrote reaches the audit.

    An adapter may also certify a few structural facts about the failure in
    `exc.audit_facts` — which schema keyword failed, where in the schema, the
    host's stop reason, the usage the host reported. They are copied only when
    each value is a count, a flag or a spaceless structural token, so they can
    say *how* a call failed without ever carrying what it said.
    """
    code = getattr(exc, "code", None)
    if not (isinstance(code, str) and _REASON.fullmatch(code)):
        return {}
    facts = _safe_facts(getattr(exc, "audit_facts", None))
    return {"reason": code, "failure_facts": facts} if facts else {"reason": code}


def digest(value: Any) -> str:
    data = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()
    return hashlib.sha256(data).hexdigest()


@dataclass
class WorkerUsage:
    tokens: int = 0
    reserved_tokens: int = 0
    remote_calls: int = 0
    tool_calls: Counter = field(default_factory=Counter)


class Context:
    """An unforgeable-by-package capability given only to trusted host handlers."""

    def __init__(self, runtime, role, worker_id, depth, parent):
        self._runtime = runtime
        self.role = role
        self.worker_id = worker_id
        self.depth = depth
        self.parent = parent
        self.closed = False

    async def tool(self, tool_id, payload):
        return await self._runtime.call_tool(self, tool_id, payload)

    async def model(self, task, payload, output_schema, max_output_tokens=2048, check=None):
        return await self._runtime.call_model(
            self, task, payload, output_schema, max_output_tokens=max_output_tokens, check=check
        )

    def event(self, action, **metadata):
        self._runtime._check_context(self)
        self._runtime.record(action, context=self, **metadata)


class Runtime:
    """Capability mediator for trusted workflow code interpreting an untrusted graph.

    This is not a Python sandbox. Only host-installed operations/handlers execute.
    No package module is imported and no generated text is executed as code.
    """

    def __init__(
        self,
        package,
        grants=None,
        handlers=None,
        router=None,
        limits=None,
        approved_tools=None,
        observer=None,
        memory=None,
    ):
        self.package = package
        # What the run holds about memory (memory.v0 §7): the scan set of the egress guards
        # (M-36, M-37), the grants, the proposals check and the agent document. None: no memory
        # at all, an empty scan set, nothing refused on that account.
        self.memory = memory
        # A host may watch the audit as it is written, to report progress. The
        # observer receives a copy of each event after it is chained, cannot
        # change it, and cannot fail the run: its errors are discarded.
        self._observer = observer
        self.policy = copy.deepcopy(package.policy)
        self.roles = {r["id"]: r for r in package.graph["workers"]}
        self.coordinator = package.graph["coordinator"]
        self.grants = dict(grants or {})
        self.handlers = dict(handlers or {})
        self.router = router
        self.approved_tools = set(approved_tools or [])
        if self.approved_tools - set(package.tools):
            # An approval for something the signed package never declared is a
            # host mistake, not a broader permission: it is refused rather than
            # ignored, so a stale approval cannot quietly follow a package that
            # dropped the tool.
            raise PolicyError("Tool approval refers to a tool this package does not declare")
        self.permissions = {p["id"]: p for p in self.policy["permissions"]}
        if set(self.grants) - set(self.permissions):
            raise PolicyError("Grant refers to an undeclared permission")
        if any(v not in {"once", "session", "always", "deny"} for v in self.grants.values()):
            raise PolicyError("Grant must be once, session, always, or deny")
        self.budget = copy.deepcopy(self.policy["budget"])
        for key, value in (limits or {}).items():
            if key not in {
                "hard_tokens",
                "max_remote_calls",
                "max_parallel_workers",
                "max_calls_per_tool",
            }:
                raise PolicyError(f"Unsupported host limit: {key}")
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise PolicyError(f"Host limit {key} must be a nonnegative integer")
            if key == "max_calls_per_tool":
                # One host ceiling applied to every declared tool. Like every
                # other host limit it can only lower a package's own cap.
                self.budget[key] = {
                    tool_id: min(value, cap) for tool_id, cap in self.budget[key].items()
                }
            else:
                self.budget[key] = min(value, self.budget[key])
        if self.budget["max_parallel_workers"] < 1:
            raise PolicyError("At least one worker slot is required")
        memory = self.policy["memory"]
        # `agent-scoped` (memory.v0 M-48) keeps the run's state semantics of `session`; the
        # package's own document is a pair of tools, never state. The other scopes stay refused.
        if memory["scope"] not in {"session", "ephemeral", "agent-scoped"}:
            raise PolicyError("This runtime only implements session/ephemeral/agent-scoped memory")
        if memory["scope"] == "agent-scoped" and memory["retention"] != "user-managed":
            raise PolicyError("agent-scoped memory requires user-managed retention")
        if memory["raw_documents"] or memory["sharing"] != "explicit_views":
            raise PolicyError("Raw document retention/shared mutable state is unsupported")
        if self.policy["delegation"]["allow_remote"]:
            raise PolicyError("Remote-agent delegation is not implemented")
        if any(r["kind"] != "packaged" for r in self.roles.values()):
            raise PolicyError("Only declared packaged worker roles can execute")
        if package.manifest.get("dependencies"):
            raise PolicyError("Dependency execution/loading is not implemented")
        self.run_id = str(uuid4())
        self.state = {}
        self.audit = []
        self._usage = {}
        self._contexts = {}
        self._sequence = 0
        self._worker_sequence = 0
        self._global = WorkerUsage()
        self._lock = asyncio.Lock()
        self._parallel = asyncio.Semaphore(self.budget["max_parallel_workers"])
        self._role_slots = {r: asyncio.Semaphore(v["max_instances"]) for r, v in self.roles.items()}
        self._active = 0
        self._peak = 0
        self._once_used = set()
        self._halted = None
        self._root = self._context(self.coordinator, "coordinator", 0, None)
        self.record(
            "runtime.started",
            context=self._root,
            package_id=package.manifest["package_id"],
            package_version=package.manifest["version"],
            package_digest=package.digest,
            grant_scopes=self.grants,
            note="always grants apply only to this Runtime; no persistent grant store",
        )

    def _context(self, role, worker_id, depth, parent):
        ctx = Context(self, role, worker_id, depth, parent)
        self._contexts[worker_id] = ctx
        self._usage[worker_id] = WorkerUsage()
        return ctx

    def coordinator_context(self):
        return self._root

    def _check_context(self, ctx):
        if self._halted:
            raise PolicyError(f"Runtime halted: {self._halted}")
        if ctx._runtime is not self or self._contexts.get(ctx.worker_id) is not ctx or ctx.closed:
            raise PolicyError("Unknown or expired execution context")

    def record(self, action, *, context=None, **metadata):
        self._sequence += 1
        event = {
            "schema_version": "audit.v0",
            "run_id": self.run_id,
            "sequence": self._sequence,
            "timestamp": datetime.now(UTC).isoformat(),
            "action": action,
            "worker": context.worker_id if context else None,
            "role": context.role if context else None,
            "parent": context.parent if context else None,
            "depth": context.depth if context else 0,
            "node_id": getattr(context, "operation_id", getattr(context, "node_id", None)),
            "previous_hash": self.audit[-1]["event_hash"] if self.audit else None,
            **metadata,
        }
        event["event_hash"] = digest(event)
        self.audit.append(event)
        if self._observer is not None:
            try:
                self._observer(copy.deepcopy(event))
            except Exception:  # noqa: BLE001 - observation must never affect a run
                pass

    def _authorize(self, permission_ids, *, consume=False, context=None):
        for pid in permission_ids:
            grant = self.grants.get(pid, "deny")
            self.record(
                "permission.checked",
                context=context,
                permission=pid,
                grant=grant,
                allowed=grant != "deny" and not (grant == "once" and pid in self._once_used),
            )
            if grant == "deny" or (grant == "once" and pid in self._once_used):
                raise PolicyError(f"Permission denied or consumed: {pid}")
        if consume:
            self._once_used.update(p for p in permission_ids if self.grants[p] == "once")

    def _permission_kind(self, kind):
        return [pid for pid, p in self.permissions.items() if p["kind"] == kind]

    def state_permissions(self):
        """The `memory` permissions that cover the run's own state: every one except the agent
        document's (`resources: ["agent"]`, memory.v0 M-48), which authorizes the two agent tools
        and nothing else, so denying it never stops the workflow's state access."""
        return [
            pid
            for pid in self._permission_kind("memory")
            if self.permissions[pid]["resources"] != ["agent"]
        ]

    async def run_worker(
        self, role, inputs, operation, parent=None, depth=1, *, return_value=False, node_id=None
    ):
        parent = self._root if parent is None else parent
        try:
            self._check_context(parent)
            if role == self.coordinator or role not in self.roles:
                raise PolicyError(f"Undeclared or invalid worker role: {role}")
            if role not in self.policy["delegation"]["approved_roles"]:
                raise PolicyError(f"Worker is not approved: {role}")
            if (
                parent is not self._root
                or depth != parent.depth + 1
                or depth > self.policy["delegation"]["max_depth"]
            ):
                raise PolicyError("Delegation depth exceeded; only coordinator may spawn workers")
            self.record(
                "delegation.checked",
                context=parent,
                requested_role=role,
                allowed=True,
                requested_depth=depth,
                node_id=node_id,
            )
            if not isinstance(inputs, dict) or set(inputs) - set(self.roles[role]["state_read"]):
                raise PolicyError(f"Worker {role} input exceeds declared state_read fields")
            mem = self.state_permissions()
            if not mem:
                raise PolicyError("Worker state access requires a memory permission")
            async with self._lock:
                self._authorize(mem, consume=True, context=parent)
        except PolicyError as exc:
            self.record("worker.denied", context=parent, requested_role=role, error=str(exc))
            raise
        # Acquire global slot after role slot so queued role instances do not starve others.
        async with self._role_slots[role], self._parallel:
            self._check_context(parent)
            self._worker_sequence += 1
            ctx = self._context(role, f"{role}:{self._worker_sequence}", depth, parent.worker_id)
            ctx.node_id = node_id
            self.record("worker.spawned", context=ctx)
            self._active += 1
            self._peak = max(self._peak, self._active)
            self.record(
                "worker.started",
                context=ctx,
                skills=self.roles[role]["skills"],
                state_keys=sorted(inputs),
                input_hash=digest(inputs),
                active=self._active,
            )
            try:
                patch = await operation(ctx, copy.deepcopy(inputs))
                if not return_value and not isinstance(patch, dict):
                    raise PolicyError(f"Worker {role} must return a structured state patch")
                if not return_value and set(patch) - set(self.roles[role]["state_write"]):
                    raise PolicyError(f"Worker {role} output exceeds declared state_write fields")
                # Ensure messages are finite serializable data, never host object capabilities.
                digest(patch)
                self.record(
                    "worker.completed",
                    context=ctx,
                    output_hash=digest(patch),
                    state_keys=sorted(patch) if isinstance(patch, dict) else [],
                    status="ok",
                )
                return copy.deepcopy(patch)
            except BaseException as exc:
                self.record("worker.failed", context=ctx, status="error", error=type(exc).__name__)
                raise
            finally:
                ctx.closed = True
                self._active -= 1

    async def map_workers(self, role, list_of_inputs, operation, parent=None):
        tasks = [
            asyncio.create_task(self.run_worker(role, item, operation, parent=parent))
            for item in list_of_inputs
        ]
        try:
            return await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

    def _remote(self, ctx, count=1):
        own = self._usage[ctx.worker_id]
        if self._global.remote_calls + count > self.budget["max_remote_calls"]:
            raise BudgetError("Global remote-call budget exhausted")
        if own.remote_calls + count > self.roles[ctx.role]["budget"]["remote_calls"]:
            raise BudgetError(f"Remote-call budget exhausted for {ctx.worker_id}")
        own.remote_calls += count
        self._global.remote_calls += count
        self.record("budget.updated", context=ctx, remote_calls=self._global.remote_calls)

    async def call_tool(self, ctx, tool_id, payload):
        self._check_context(ctx)
        tool = self.package.tools.get(tool_id)
        try:
            if tool is None or tool_id not in self.roles[ctx.role]["tools"]:
                raise PolicyError(f"Role {ctx.role} may not call tool {tool_id}")
            if tool["execution"] not in {"local", "remote"}:
                raise PolicyError("Agent tool bindings are not implemented")
            if tool["retries"] != 0:
                raise PolicyError("Automatic retries are unsupported")
            # A declared tool is a request; an approval is authority. A granted
            # permission is not an approval: `network.x = session` says the
            # person allowed a class of destination, not that they allowed this
            # implementation of this tool. Both are required, always, for every
            # tool — not only for the side-effecting ones.
            if tool_id not in self.approved_tools:
                raise PolicyError(f"Tool {tool_id} is declared but not explicitly approved")
            if tool["execution"] == "remote":
                from urllib.parse import urlsplit

                endpoint = urlsplit(tool["endpoint"])
                allowed = set(self.policy["network"]["allowed_domains"])
                linked = {
                    domain
                    for pid in tool["permissions"]
                    if self.permissions[pid]["kind"] == "network"
                    for domain in self.permissions[pid]["resources"]
                }
                if (
                    endpoint.scheme != "https"
                    or endpoint.hostname not in tool["domains"]
                    or set(tool["domains"]) - (allowed & linked)
                ):
                    raise PolicyError("Tool network contract exceeds declared permission/policy")
            handler = self.handlers.get(tool["binding"])
            if handler is None:
                raise PolicyError(f"No trusted host handler for {tool['binding']}")
            try:
                validate_instance(self.package.files, tool["input_schema"], payload, "tool input")
            except ValidationError as exc:
                exc.code = "tool_request_invalid"
                exc.audit_facts = schema_facts(exc, "input_schema")
                raise
            async with self._lock:
                self._authorize(tool["permissions"], context=ctx)
                self._scan_tool_arguments(ctx, tool_id, tool, payload)
                cap = self.budget["max_calls_per_tool"].get(tool_id, 0)
                if self._global.tool_calls[tool_id] >= cap:
                    raise BudgetError(f"Call budget exhausted for tool {tool_id}")
                if tool["execution"] == "remote":
                    self._remote(ctx)
                self._authorize(tool["permissions"], consume=True, context=ctx)
                self._global.tool_calls[tool_id] += 1
                self._usage[ctx.worker_id].tool_calls[tool_id] += 1
                self.record("budget.updated", context=ctx, tool_calls=dict(self._global.tool_calls))
            self.record(
                "tool.called",
                context=ctx,
                tool=tool_id,
                binding=tool["binding"],
                permissions=tool["permissions"],
                domains=tool["domains"],
                input_hash=digest(payload),
                remote_calls=self._global.remote_calls,
            )
            async with asyncio.timeout(tool["timeout_seconds"]):
                result = await handler(ctx, copy.deepcopy(payload))
            try:
                validate_instance(self.package.files, tool["output_schema"], result, "tool output")
            except ValidationError as exc:
                exc.code = "tool_response_invalid"
                exc.audit_facts = schema_facts(exc, "output_schema")
                raise
            self.record(
                "tool.completed",
                context=ctx,
                tool=tool_id,
                result_hash=digest(result),
                status="ok",
            )
            return copy.deepcopy(result)
        except BaseException as exc:
            if isinstance(exc, (TimeoutError, asyncio.CancelledError)):
                cancelled = isinstance(exc, asyncio.CancelledError)
                exc.code = "tool_cancelled" if cancelled else "tool_timeout"
                exc.audit_facts = {
                    "stage": "cancelled" if cancelled else "timeout",
                    "cancelled" if cancelled else "timeout": True,
                }
            self.record(
                "tool.failed",
                context=ctx,
                tool=tool_id,
                error=type(exc).__name__,
                status="error",
                **failure_reason(exc),
            )
            raise

    def _scan_tool_arguments(self, ctx, tool_id, tool, payload):
        """memory.v0 M-36: before every tool call except a memory read, the arguments are scanned
        for the run's scan set. A sealed value of a record this run was not granted goes nowhere;
        a granted one goes only to a tool that links the permission it was granted under. The
        refusal is a denied permission check naming the record and the pointer, never the value.
        """
        from .memory.scan import INCOMPLETE, find_all_sealed

        memory = self.memory
        if memory is None or not memory.scan:
            return
        binding = tool["binding"] or ""
        if (
            binding.startswith("host.memory.") and not binding.startswith("host.memory.agent.")
        ) or binding.startswith("host.resource."):
            return
        hits = find_all_sealed(payload, memory.scan)
        denied = dict(context=ctx, allowed=False, tool=tool_id)
        if hits == INCOMPLETE:
            self.record(
                "permission.checked",
                permission=None,
                grant="deny",
                reason="sealed_value_not_granted",
                incomplete=True,
                **denied,
            )
            raise PolicyError(
                f"Tool {tool_id}: the arguments hold more strings than the sealed-value scan "
                "reads, so they are refused unread"
            )
        # Every hit, in scan-set order: a value granted to this tool never lets another through.
        for hit in hits:
            # A record may be granted under more than one permission (two reads of one type): the
            # value may go to any tool that links one of them.
            grants = [g for g in memory.grants if g["resource_id"] == hit["record_id"]]
            if not grants:
                self.record(
                    "permission.checked",
                    permission=None,
                    grant="deny",
                    reason="sealed_value_not_granted",
                    record_id=hit["record_id"],
                    pointer=hit["pointer"],
                    **denied,
                )
                raise PolicyError(
                    f"Tool {tool_id}: the arguments carry a sealed value of a record this run "
                    f"was not granted ({hit['record_id']} {hit['pointer']})"
                )
            if not any(grant["permission_id"] in tool["permissions"] for grant in grants):
                permission_id = grants[0]["permission_id"]
                self.record(
                    "permission.checked",
                    permission=permission_id,
                    grant=self.grants.get(permission_id, "deny"),
                    reason="sealed_value_egress",
                    record_id=hit["record_id"],
                    pointer=hit["pointer"],
                    **denied,
                )
                linked = " or ".join(grant["permission_id"] for grant in grants)
                raise PolicyError(
                    f"Tool {tool_id}: the arguments carry a sealed value of {hit['record_id']} "
                    f"({hit['pointer']}) to a tool that does not link {linked}"
                )

    def _scan_model_request(self, ctx, task, request):
        """memory.v0 M-37: before every model request, the token count included, the complete
        request as it will be sent is scanned for the scan set; a hit refuses the call before
        anything leaves, naming the record id and the pointer, never the value. Every mode."""
        from .memory.scan import INCOMPLETE, find_sealed

        memory = self.memory
        if memory is None or not memory.scan:
            return
        hit = find_sealed(request, memory.scan)
        if hit is None:
            return
        facts = (
            {"incomplete": True}
            if hit == INCOMPLETE
            else {"record_id": hit["record_id"], "pointer": hit["pointer"]}
        )
        self.record(
            "model.refused",
            context=ctx,
            task=task,
            reason="sealed_value_in_model_request",
            **facts,
        )
        if hit == INCOMPLETE:
            raise PolicyError(
                "The model request holds more strings than the sealed-value scan reads, so it "
                "is refused unread"
            )
        raise PolicyError(
            f"The model request carries a sealed value of {hit['record_id']} ({hit['pointer']}), "
            "which may not reach a model"
        )

    async def call_model(self, ctx, task, payload, output_schema, *, max_output_tokens, check=None):
        """One model call: authorize, count, reserve, complete, account, validate.

        `check`, when given, is the node's answer checks (workflow.v0, agentpkg 0.3.0): it is
        called with a copy of the schema-valid answer and raises to refuse it, which fails the
        call as a non-conforming answer, charged what the router reported. This runtime asks
        no model twice; a host that re-asks does so within these same bounds (spec section 7).
        """
        self._check_context(ctx)
        router = self.router
        if router is None:
            raise PolicyError(
                "No model router configured; select fixture/extractive mode explicitly"
            )
        if (
            self.package.manifest["model_requirements"].get("privacy") == "local-only"
            and router.remote
        ):
            raise PolicyError("Package requires a local-only model router")
        declared = {t["id"]: t for t in self.package.manifest["model_requirements"]["tasks"]}
        if task not in declared:
            raise PolicyError(f"Undeclared model task {task}")
        if (
            isinstance(max_output_tokens, bool)
            or not isinstance(max_output_tokens, int)
            or max_output_tokens <= 0
        ):
            raise PolicyError("max_output_tokens must be positive")
        req = declared[task]
        capabilities = set(router.capabilities)
        if set(req["capabilities"]) - capabilities:
            raise PolicyError("Model router lacks package-required capabilities")
        if router.context_window < req["context_window"]:
            raise PolicyError("Model router context window is insufficient")
        # Skill instructions are loaded from the verified package, separately from data.
        skills = {s["id"]: s["path"] for s in self.package.manifest["skills"]}
        instructions = [
            self.package.files[skills[s]].decode("utf-8") for s in self.roles[ctx.role]["skills"]
        ]
        request = {
            "task": task,
            "instructions": instructions,
            "data": copy.deepcopy(payload),
            "output_schema": output_schema,
            "requirements": copy.deepcopy(req),
            "budget_context": {"max_output_tokens": max_output_tokens},
            "audit_context": {
                "worker": ctx.worker_id,
                "node_id": getattr(ctx, "operation_id", getattr(ctx, "node_id", None)),
            },
        }
        validate_document(request, "model-request", "model request")
        self._scan_model_request(ctx, task, request)
        permissions = self._permission_kind("model")
        if not permissions:
            raise PolicyError("Model use requires an explicit model permission")
        async with self._lock:
            self._authorize(permissions, context=ctx)
            if router.remote:
                self._remote(ctx)  # Token-count preflight is a separately budgeted call.
            # One logical model authorization covers both count and completion. Consume
            # it before sending any private context to a remote tokenizer.
            self._authorize(permissions, consume=True, context=ctx)
        self.record(
            "model.count.called",
            context=ctx,
            task=task,
            model=router.model_id,
            router=router.router_id,
            domains=list(getattr(router, "domains", ())),
            input_hash=digest(request),
            permissions=permissions,
        )
        try:
            input_bound = await router.count_tokens(request)
        except BaseException as exc:
            self.record(
                "model.count.failed",
                context=ctx,
                task=task,
                error=type(exc).__name__,
                **failure_reason(exc),
            )
            raise
        if isinstance(input_bound, bool) or not isinstance(input_bound, int) or input_bound < 0:
            raise PolicyError("Router returned an invalid input token count")
        reservation = input_bound + max_output_tokens

        def refuse(reason, message, **facts):
            # Which bound refused the call, in numbers, so a failed run can be
            # classified from its audit rather than guessed at.
            self.record(
                "model.refused",
                context=ctx,
                task=task,
                reason=reason,
                input_bound=input_bound,
                max_output_tokens=max_output_tokens,
                reserved_tokens=reservation,
                **facts,
            )
            raise BudgetError(message)

        if reservation > router.context_window:
            refuse(
                "context_window",
                "Model request exceeds configured context window",
                context_window=router.context_window,
            )
        own = self._usage[ctx.worker_id]
        async with self._lock:
            self._check_context(ctx)
            if (
                self._global.tokens + self._global.reserved_tokens + reservation
                > self.budget["hard_tokens"]
            ):
                refuse(
                    "global_token_budget",
                    "Global token budget exhausted before model dispatch",
                    used_tokens=self._global.tokens,
                    held_tokens=self._global.reserved_tokens,
                    limit=self.budget["hard_tokens"],
                )
            if (
                own.tokens + own.reserved_tokens + reservation
                > self.roles[ctx.role]["budget"]["tokens"]
            ):
                refuse(
                    "worker_token_budget",
                    f"Token budget exhausted for {ctx.worker_id}",
                    used_tokens=own.tokens,
                    held_tokens=own.reserved_tokens,
                    limit=self.roles[ctx.role]["budget"]["tokens"],
                )
            threshold = self.budget.get("approval_threshold_tokens")
            if (
                threshold is not None
                and self._global.tokens + self._global.reserved_tokens + reservation > threshold
            ):
                raise BudgetError("Token approval threshold exceeded; a new host grant is required")
            if router.remote:
                self._remote(ctx)
            own.reserved_tokens += reservation
            self._global.reserved_tokens += reservation
            self.record(
                "budget.updated",
                context=ctx,
                tokens=self._global.tokens,
                reserved_tokens=self._global.reserved_tokens,
            )
        self.record(
            "model.called",
            context=ctx,
            task=task,
            model=router.model_id,
            router=router.router_id,
            domains=list(getattr(router, "domains", ())),
            input_hash=digest(request),
            reserved_tokens=reservation,
            permissions=permissions,
        )
        used = reservation  # Unknown usage/errors consume reservation conservatively.
        try:
            result = await router.complete(request, max_output_tokens=max_output_tokens)
            inp, out = result["input_tokens"], result["output_tokens"]
            valid_counts = not any(
                isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in (inp, out)
            )
            if valid_counts:
                used = inp + out  # Report known overruns honestly, even above the cap.
            if not valid_counts or inp > input_bound or out > max_output_tokens:
                self._halted = "router violated token accounting contract"
                raise PolicyError("Router violated token accounting contract; execution halted")
            self._check_context(ctx)
            validate_document(result, "model-result", "model response")
            Draft202012Validator(output_schema).validate(result["output"])
            if check is not None:
                check(copy.deepcopy(result["output"]))
            self.record(
                "model.completed",
                context=ctx,
                task=task,
                model=router.model_id,
                tokens=used,
                cost_usd=result.get("cost_usd"),
                status="ok",
                result_hash=digest(result["output"]),
            )
            return copy.deepcopy(result["output"])
        except BaseException as exc:
            # Which answer check refused the answer, by the package's own pointers; never data.
            refused = getattr(exc, "failed_check", None)
            self.record(
                "model.failed",
                context=ctx,
                task=task,
                error=type(exc).__name__,
                tokens_charged=used,
                **failure_reason(exc),
                **({"failed_check": refused} if isinstance(refused, dict) else {}),
            )
            raise
        finally:
            async with self._lock:
                own.reserved_tokens -= reservation
                self._global.reserved_tokens -= reservation
                own.tokens += used
                self._global.tokens += used
                self.record(
                    "budget.updated",
                    context=ctx,
                    tokens=self._global.tokens,
                    reserved_tokens=self._global.reserved_tokens,
                )

    @property
    def usage(self):
        return {
            "tokens": self._global.tokens,
            "reserved_tokens": self._global.reserved_tokens,
            "remote_calls": self._global.remote_calls,
            "tool_calls": dict(self._global.tool_calls),
            "peak_parallel_workers": self._peak,
            "workers": {
                w: {
                    "tokens": u.tokens,
                    "remote_calls": u.remote_calls,
                    "tool_calls": dict(u.tool_calls),
                }
                for w, u in self._usage.items()
            },
            "limits": copy.deepcopy(self.budget),
        }

    def clear(self):
        self.state.clear()
        self.record("memory.cleared", context=self._root, scope=self.policy["memory"]["scope"])
