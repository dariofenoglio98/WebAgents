"""The domain-independent workflow.v0 interpreter."""

from __future__ import annotations

import asyncio
import copy

from .compute.errors import ComputeError
from .errors import AgentPkgError, ValidationError
from .runtime import BudgetError, PolicyError, Runtime, digest
from .validation import schema_validator, validate_instance, validate_payload
from .workflow_values import evaluate, select, tokens


class WorkflowError(AgentPkgError):
    """Stable classified failure; raw provider data is excluded from diagnostics."""

    def __init__(self, code, node_id=None):
        self.code = code
        self.node_id = node_id
        super().__init__(f"workflow.v0 {code}" + (f" at node {node_id}" if node_id else ""))


def failure_code(exc):
    if isinstance(exc, WorkflowError):
        return exc.code
    if isinstance(exc, asyncio.CancelledError):
        return "cancelled"
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, BudgetError):
        return "budget_exhausted"
    if isinstance(exc, ValidationError):
        return "schema_validation"
    if isinstance(exc, PolicyError):
        return "permission_denied"
    if isinstance(exc, ComputeError):
        return "compute_error"
    return "worker_error"


def _failed_check(exc):
    """Which declared check failed, when a validation says so, and how a compute call ended
    (compute.v0: the reason and the trap, by the specification's words); never data."""
    details = {}
    facts = getattr(exc, "failed_check", None)
    if isinstance(facts, dict):
        details["failed_check"] = facts
    compute = getattr(exc, "compute", None)
    if isinstance(compute, dict):
        details["compute"] = compute
    return details


class Workflow:
    """One execution per instance. All authority remains in the host mediator.

    Ready nodes use one snapshot per wave. Unordered state conflicts are rejected
    statically. A whole wave commits only after every result and state patch passes
    validation. Maps create at most max_parallel tasks, never one task per item.
    """

    def __init__(
        self,
        package,
        *,
        grants=None,
        handlers=None,
        router=None,
        limits=None,
        approved_tools=None,
        observer=None,
        memory=None,
    ):
        # Recheck the exact payload, not mutable manifest/graph aliases supplied by callers.
        from .package import integrity_statement

        if integrity_statement(package.files) != package.integrity:
            raise ValidationError("Package payload changed after integrity verification")
        manifest, graph, policy, tools = validate_payload(package.files)
        from dataclasses import replace

        self.package = replace(package, manifest=manifest, graph=graph, policy=policy, tools=tools)
        if manifest["entrypoint"] != "workflow.v0":
            raise ValidationError("Generic execution requires entrypoint workflow.v0")
        self.graph = graph
        if memory is None:
            # memory.v0 M-40 holds in every mode: a host that supplies no memory context still
            # gets the proposals check, over an empty scan set and no grant.
            from .memory.run import MemoryRun

            memory = MemoryRun(self.package, [], dict(grants or {}))
        self._memory_report = None
        self._agent_outcome_recorded = False
        self.runtime = Runtime(
            self.package,
            grants=grants,
            handlers=handlers,
            router=router,
            limits=limits,
            approved_tools=approved_tools,
            observer=observer,
            memory=memory,
        )
        self._used = False
        self._task = None
        self._cancel_requested = False
        self._output = None

    def cancel(self):
        """Host-side cancellation; cleanup completes before run() returns/raises."""
        self._cancel_requested = True
        if self._task is not None:
            self._task.cancel()

    def _event(self, action, node, ctx=None, **metadata):
        self.runtime.record(
            action,
            context=ctx,
            node_id=(
                f"{ctx.node_id}/{node['id']}"
                if ctx is not None and getattr(ctx, "node_id", None) and ctx.node_id != node["id"]
                else node["id"]
            ),
            node_type=node["type"],
            profile="workflow.v0",
            **metadata,
        )

    async def _operation(self, node, env, ctx):
        value = evaluate(node["input"], env)
        if "when" in node:
            condition = node["when"]
            equal = evaluate(condition["left"], env) == evaluate(condition["right"], env)
            if equal != (condition["op"] == "eq"):
                self._event("node.skipped", node, ctx, reason="condition_false")
                result = evaluate(node["otherwise"], env)
                validate_instance(
                    self.package.files,
                    node["output_schema"],
                    result,
                    f"node {node['id']} skipped output",
                )
                return result
        kind = node["type"]
        if kind == "llm":
            # The router receives a bundled, offline schema. The host is authoritative.
            validator = schema_validator(self.package.files, node["output_schema"])
            schema = self._model_schema(node["output_schema"])
            check = None
            if node.get("checks"):
                from .workflow_assertions import check_answer

                def check(answer):
                    # Evaluated by the runtime on the schema-valid answer, before it is accepted.
                    check_answer(node["checks"], env, answer)

            try:
                result = await ctx.model(
                    node["task"],
                    value,
                    schema,
                    max_output_tokens=node["max_output_tokens"],
                    check=check,
                )
            except (PolicyError, TimeoutError, asyncio.CancelledError):
                raise
            except Exception as exc:
                from jsonschema.exceptions import ValidationError as SchemaFailure

                code = (
                    "schema_validation"
                    if isinstance(exc, (SchemaFailure, ValidationError))
                    else "model_error"
                )
                error = WorkflowError(code, node["id"])
                if isinstance(getattr(exc, "failed_check", None), dict):
                    # A refused answer check names itself on node.failed too.
                    error.failed_check = exc.failed_check
                raise error from exc
            # Also use the closed package validator, including formats and local refs.
            if not validator.is_valid(result):
                raise WorkflowError("schema_validation", node["id"])
        elif kind == "tool":
            try:
                result = await ctx.tool(node["tool"], value)
            except (BudgetError, ValidationError, TimeoutError, asyncio.CancelledError):
                raise
            except PolicyError as exc:
                # Provider adapters may subclass PolicyError; transport failures stay distinct.
                if type(exc) is PolicyError:
                    raise
                raise WorkflowError("tool_error", node["id"]) from exc
            except Exception as exc:
                raise WorkflowError("tool_error", node["id"]) from exc
        elif kind == "compute":
            # compute.v0: a pure function of the constructed input, run by the host's engine
            # under the effective limits; its own failures are `compute_error`, an input or
            # output outside the node's schemas `schema_validation`, as for a tool. A failure
            # of the engine itself is the host's, not the module's: `worker_error` (C-40).
            try:
                result = await ctx.compute(node, value)
            except (BudgetError, ValidationError, TimeoutError, asyncio.CancelledError):
                raise
            except PolicyError:
                raise
            except ComputeError as exc:
                error = WorkflowError("compute_error", node["id"])
                error.compute = exc.facts()
                raise error from exc
            except Exception as exc:
                raise WorkflowError("worker_error", node["id"]) from exc
        elif kind == "join":
            if not isinstance(value, list):
                raise ValidationError(f"node {node['id']}: join input must be an array")
            result = []
            for part in value:
                selected = select(part, node.get("select", ""))
                if not isinstance(selected, list):
                    raise ValidationError(f"node {node['id']}: join members must select arrays")
                result.extend(selected)
            if "unique_by" in node:
                seen, unique = {}, []
                identical = conflicting = 0
                for item in result:
                    identity = None
                    for path in node["unique_by"]:
                        key = select(item, path)
                        if key is not None and key != "":
                            identity = [path, key]
                            break
                    key = digest(identity if identity is not None else item)
                    if key not in seen:
                        seen[key] = digest(item)
                        unique.append(item)
                    elif seen[key] == digest(item):
                        identical += 1
                    else:
                        # A different record claiming the same identity: the
                        # first still wins, but the loss is never silent.
                        conflicting += 1
                if identical or conflicting:
                    self._event(
                        "node.deduplicated",
                        node,
                        ctx,
                        original_count=len(result),
                        retained_count=len(unique),
                        identical_duplicates=identical,
                        conflicting_duplicates=conflicting,
                        unique_by=list(node["unique_by"]),
                    )
                result = unique
            if "limit" in node:
                if len(result) > node["limit"]:
                    self._event(
                        "node.truncated",
                        node,
                        ctx,
                        original_count=len(result),
                        retained_count=node["limit"],
                    )
                result = result[: node["limit"]]
        else:  # validate and output are checked projections.
            from .workflow_assertions import check_assertions

            check_assertions(node.get("assertions", []), env)
            result = value
        try:
            validate_instance(
                self.package.files, node["output_schema"], result, f"node {node['id']} output"
            )
        except ValidationError as exc:
            exc.failed_check = {"check": "output_schema", "schema": node["output_schema"]}
            raise
        return result

    def _model_schema(self, path):
        """Bundle package-relative references into one local $defs namespace."""
        from .validation import _schema_reference

        docs = {s["path"]: self.package.json(s["path"]) for s in self.package.manifest["schemas"]}
        names = {p: f"s{i}" for i, p in enumerate(sorted(docs))}

        def bundle(value, base):
            if isinstance(value, list):
                return [bundle(v, base) for v in value]
            if not isinstance(value, dict):
                return value
            out = {k: bundle(v, base) for k, v in value.items()}
            if "$ref" in value:
                target, fragment = _schema_reference(base, value["$ref"])
                out["$ref"] = "#/$defs/" + names[target] + fragment
            return out

        included = {}
        pending = [path]

        def discover(value, base):
            if isinstance(value, dict):
                if "$ref" in value:
                    target, _ = _schema_reference(base, value["$ref"])
                    if names[target] not in included and target not in pending:
                        pending.append(target)
                for child in value.values():
                    discover(child, base)
            elif isinstance(value, list):
                for child in value:
                    discover(child, base)

        while pending:
            current = pending.pop()
            included[names[current]] = bundle(docs[current], current)
            discover(docs[current], current)
        return {"$ref": "#/$defs/" + names[path], "$defs": included}

    async def _step(self, node, env, ctx):
        self._event("node.started", node, ctx)
        ctx.operation_id = f"{ctx.node_id}/{node['id']}"
        try:
            async with asyncio.timeout(node["timeout_seconds"]):
                result = await self._operation(node, env, ctx)
            self._event("node.completed", node, ctx, output_hash=digest(result))
            return result
        except BaseException as exc:
            self._event(
                "node.failed", node, ctx, error_code=failure_code(exc), **_failed_check(exc)
            )
            raise
        finally:
            del ctx.operation_id

    async def _map(self, node, view):
        env = {"state": view}
        items = evaluate(node["input"], env)
        if not isinstance(items, list) or len(items) > node["max_items"]:
            raise ValidationError(f"node {node['id']}: map input exceeds max_items or is not array")
        for item in items:
            validate_instance(
                self.package.files, node["item_schema"], item, f"node {node['id']} item"
            )
        results = [None] * len(items)
        cursor = 0

        async def consume():
            nonlocal cursor
            while cursor < len(items):
                index = cursor
                cursor += 1  # No await between allocation and increment.
                item = copy.deepcopy(items[index])

                async def work(ctx, data):
                    local = {"state": data, "item": item, "steps": {}}
                    for step in node["steps"]:
                        await asyncio.sleep(0)
                        local["steps"][step["id"]] = await self._step(step, local, ctx)
                    return evaluate(node["yield"], local)

                results[index] = await self.runtime.run_worker(
                    node["worker"], view, work, return_value=True, node_id=node["id"]
                )

        await self._gather([consume() for _ in range(min(node["max_parallel"], len(items)))])
        validate_instance(
            self.package.files, node["output_schema"], results, f"node {node['id']} map output"
        )
        return results

    @staticmethod
    async def _gather(coroutines):
        tasks = [asyncio.create_task(c) for c in coroutines]
        try:
            return await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            # Drain all children so no state/usage changes occur after failure is reported.
            cleanup = asyncio.gather(*tasks, return_exceptions=True)
            while not cleanup.done():
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    pass
            raise

    async def _node(self, node, snapshot):
        role = node["worker"]
        view = {
            k: copy.deepcopy(snapshot[k])
            for k in self.runtime.roles[role]["state_read"]
            if k in snapshot
        }
        self._event("node.started", node)
        try:
            async with asyncio.timeout(node["timeout_seconds"]):
                if node["type"] == "map":
                    result = await self._map(node, view)
                elif role == self.graph["coordinator"]:
                    # One context serves every coordinator node, and nodes of a wave run
                    # concurrently: nothing node-specific is stored on it (a compute call names
                    # its node from the operation itself).
                    result = await self._operation(
                        node, {"state": view}, self.runtime.coordinator_context()
                    )
                else:

                    async def work(ctx, data):
                        return await self._operation(node, {"state": data}, ctx)

                    result = await self.runtime.run_worker(
                        role, view, work, return_value=True, node_id=node["id"]
                    )
                patch = {
                    tokens(path)[0]: evaluate(value, {"result": result})
                    for path, value in node["writes"].items()
                }
                if set(patch) - set(self.runtime.roles[role]["state_write"]):
                    raise PolicyError("Node state write exceeds worker authorization")
            validate_instance(
                self.package.files,
                self.package.policy["memory"]["state_schema"],
                snapshot | patch,
                f"node {node['id']} state write",
            )
            self._event(
                "node.completed", node, output_hash=digest(result), state_keys=sorted(patch)
            )
            return result, patch
        except BaseException as exc:
            self._event("node.failed", node, error_code=failure_code(exc), **_failed_check(exc))
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise WorkflowError(failure_code(exc), node["id"]) from exc

    async def run(self, input_value):
        if self._used:
            raise PolicyError("Workflow instances are single-use")
        self._used = True
        self._task = asyncio.current_task()
        rt = self.runtime
        rt.record(
            "workflow.started",
            profile="workflow.v0",
            package_digest=self.package.digest,
            synthetic=bool(getattr(rt.router, "synthetic", False)),
        )
        try:
            if self._cancel_requested:
                raise asyncio.CancelledError
            validate_instance(
                self.package.files, self.graph["input_schema"], input_value, "workflow input"
            )
            state = evaluate(self.graph["initial_state"], {"input": input_value})
            validate_instance(
                self.package.files,
                self.package.policy["memory"]["state_schema"],
                state,
                "initial state",
            )
            # State access, including coordinator-only graphs, requires host authority.
            mem = rt.state_permissions()
            if not mem:
                raise PolicyError("Workflow state requires memory permission")
            rt._authorize(mem, context=rt.coordinator_context())
            rt.state = copy.deepcopy(state)
            pending = {n["id"]: n for n in self.graph["nodes"]}
            done = set()
            async with asyncio.timeout(self.graph["deadline_seconds"]):
                while pending:
                    ready = [n for n in pending.values() if set(n["depends_on"]) <= done]
                    if not ready:
                        raise ValidationError("Workflow has no runnable node")
                    snapshot = copy.deepcopy(state)
                    results = await self._gather([self._node(n, snapshot) for n in ready])
                    next_state = copy.deepcopy(state)
                    for node, (result, patch) in zip(ready, results):
                        next_state.update(patch)
                        if node["type"] == "output":
                            self._output = result
                    validate_instance(
                        self.package.files,
                        self.package.policy["memory"]["state_schema"],
                        next_state,
                        "state commit",
                    )
                    state = next_state
                    rt.state = copy.deepcopy(state)
                    for node in ready:
                        done.add(node["id"])
                        pending.pop(node["id"])
                    rt.record(
                        "state.committed",
                        profile="workflow.v0",
                        nodes=[n["id"] for n in ready],
                        state_hash=digest(state),
                    )
            validate_instance(
                self.package.files, self.graph["output_schema"], self._output, "workflow output"
            )
            from .memory.proposals import PROPOSALS_EXPORT_FORMAT, ProposalRefusal

            for export in self.graph.get("exports", []):
                value = evaluate(export["value"], {"result": self._output})
                if export["format"] == "text" and not isinstance(value, str):
                    raise ValidationError("Text exports must select strings")
                # memory.v0 M-40: the proposals document is checked here, after the output and
                # before `workflow.completed`; a refusal fails the run with the check's code, and
                # nothing is ever written to a memory by the run itself (M-41).
                if export["format"] == PROPOSALS_EXPORT_FORMAT and rt.memory is not None:
                    try:
                        facts = rt.memory.check_proposals(value)
                    except ProposalRefusal as refusal:
                        raise WorkflowError(refusal.code) from refusal
                    rt.record("memory.proposed", context=rt.coordinator_context(), **facts)
                    self._memory_report = {"proposals": facts, "refused": None, "agent": None}
            rt.record("workflow.completed", profile="workflow.v0", output_hash=digest(self._output))
            self._record_agent_outcome("completed")
            result = self._report("completed") | {
                "output": copy.deepcopy(self._output),
                "state": copy.deepcopy(state),
            }
            rt.clear()
            return result
        except BaseException as exc:
            from .memory.proposals import ProposalRefusal

            code = failure_code(exc)
            refusal = exc.__cause__ if isinstance(exc.__cause__, ProposalRefusal) else None
            refused = {}
            if refusal is not None:
                self._memory_report = {
                    "proposals": None,
                    "refused": {
                        "code": refusal.code,
                        "reason": refusal.reason,
                        "index": refusal.index,
                    },
                    "agent": None,
                }
                refused = {"reason": refusal.reason}
                if refusal.index is not None:
                    refused["proposal_index"] = refusal.index
            rt.record(
                "workflow.cancelled" if code == "cancelled" else "workflow.failed",
                profile="workflow.v0",
                error_code=code,
                node_id=getattr(exc, "node_id", None),
                **refused,
            )
            self._record_agent_outcome("cancelled" if code == "cancelled" else "failed")
            rt.clear()
            report = self._report("cancelled" if code == "cancelled" else "failed")
            report["error_code"] = code
            if isinstance(exc, asyncio.CancelledError):
                exc.execution_report = report
                raise
            error = exc if isinstance(exc, WorkflowError) else WorkflowError(code)
            error.execution_report = report
            raise error from (exc if error is not exc else None)
        finally:
            self._task = None
            rt.coordinator_context().closed = True

    def _record_agent_outcome(self, status):
        """memory.v0 M-50: a staged agent body is committed only after `workflow.completed`,
        else discarded with its reason; recorded before `memory.cleared`."""
        memory = self.runtime.memory
        if memory is None or self._agent_outcome_recorded:
            # Once per run: an exception after the completed path recorded its outcome (in
            # `_report` or `clear`) must not record a second, contradictory one.
            return
        self._agent_outcome_recorded = True
        agent = memory.agent_outcome(status, self.runtime.run_id)
        if agent is None:
            return
        context = self.runtime.coordinator_context()
        if agent["committed"] is not None:
            self.runtime.record("memory.agent.committed", context=context, **agent["committed"])
        elif agent["discarded"] is not None:
            self.runtime.record(
                "memory.agent.discarded",
                context=context,
                package_id=memory.agent["package_id"],
                reason=agent["discarded"],
            )
        previous = self._memory_report or {}
        self._memory_report = {
            "proposals": previous.get("proposals"),
            "refused": previous.get("refused"),
            "agent": agent,
        }

    def _report(self, status):
        return {
            "status": status,
            **({"memory": self._memory_report} if self._memory_report is not None else {}),
            "audit": self.runtime.audit,
            "usage": self.runtime.usage,
            "provenance": {
                "profile": "workflow.v0",
                "interpreter": "agentpkg.workflow.Workflow",
                "package_id": self.package.manifest["package_id"],
                "package_digest": self.package.digest,
                "synthetic": bool(getattr(self.runtime.router, "synthetic", False)),
            },
        }


async def run_workflow(package, input_value, **options):
    return await Workflow(package, **options).run(input_value)
