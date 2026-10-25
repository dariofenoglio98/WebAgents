"""The network loop (network.v0 §4): activations as worker instances over the interpreter, the
state views and patches, the route, the transition checks and the reservation.

Nothing here is package-specific: the roles, the edges, the caps and the schemas come from the
signed declaration; the model chooses within them and the mediator refuses the rest.
"""

from __future__ import annotations

import asyncio
import copy
from collections import Counter
from dataclasses import dataclass, field

from ..errors import AgentPkgError, ValidationError
from ..runtime import BudgetError, PolicyError, digest
from ..validation import validate_instance
from ..workflow_values import evaluate, tokens
from .analysis import DONE, route_data, worst_case


class RouteRefusal(AgentPkgError):
    """A chosen route that the transition check refused: a non-conforming answer (R-14), as a
    refused answer check is. `failed_check` names the reason and the declared target; never a
    value the model wrote outside the enum."""

    code = "model_output_not_conforming"

    def __init__(self, reason: str, target):
        super().__init__(f"route: {reason}")
        self.failed_check = {"check": "route", "failure": reason, "next": target}
        self.audit_facts = {"output_failure": "check"}


@dataclass
class Walk:
    """Where the network is: the hop count, the uses of each edge and the activations of each
    role, as the transition check reads them (R-14)."""

    hop: int = 0
    uses: Counter = field(default_factory=Counter)
    activations: Counter = field(default_factory=Counter)


async def run_network(workflow, node, message, ctx):
    """Run the graph's network inside the network node, on the coordinator's context; returns
    the network's result (validated by the node's `output_schema` as every node's is)."""
    package = workflow.package
    graph = workflow.graph
    network = graph["network"]
    rt = workflow.runtime
    files = package.files
    node_id = node["id"]
    try:
        validate_instance(
            files, network["message_schema"], message, f"node {node_id} network input"
        )
    except ValidationError as exc:
        exc.failed_check = {"check": "message_schema", "schema": network["message_schema"]}
        raise
    # The run's "at most" (R-21): the bound under the effective budget, the node's timeout and
    # the deadline as the host lowered it, the same figures the execution host recorded.
    bound = worst_case(
        graph,
        package.policy,
        budget=rt.budget,
        node_timeout=min(node["timeout_seconds"], workflow.deadline_seconds),
    )
    await rt.reserve_network(ctx, node_id, bound, entry=network["entry"])
    state = copy.deepcopy(evaluate(network["initial"], {}))
    walk = Walk()
    current = network["entry"]
    walk.activations[current] = 1
    # The shared state after the current activation's patch, once validated; the loop commits it,
    # so the activation returns only what crosses its boundary (the patch and the decision).
    pending = {}

    def patched(role_id, patch):
        """The shared state after a role's patch (R-9): only keys of its `state_write`, and the
        whole validated against `state_schema`, before the activation routes anything; a
        failure fails the activation and nothing is committed or routed."""
        if set(patch) - set(rt.roles[role_id]["state_write"]):
            raise PolicyError(f"role {role_id} state write exceeds its state_write view")
        next_state = copy.deepcopy(state)
        next_state.update(copy.deepcopy(patch))
        try:
            validate_instance(
                files, network["state_schema"], next_state, f"node {node_id} network state"
            )
        except ValidationError as exc:
            exc.failed_check = {"check": "network_state", "schema": network["state_schema"]}
            raise
        pending["state"] = next_state

    try:
        while True:
            role = network["roles"][current]
            worker = rt.roles[current]
            # Every key of the view is set by `initial` (R-6, checked at validation), so a
            # missing one is a runtime fault, never a silent narrower view.
            view = {k: copy.deepcopy(state[k]) for k in worker["state_read"]}
            rt.record(
                "network.activated",
                context=ctx,
                node_id=node_id,
                role=current,
                hop=walk.hop,
                activation=walk.activations[current],
                message_hash=digest(message),
            )
            pending.clear()
            outcome = await rt.run_worker(
                current,
                view,
                _activation(workflow, node_id, network, current, role, message, walk, patched),
                return_value=True,
                node_id=node_id,
            )
            patch = outcome["patch"]
            decision = outcome["decision"]
            state = pending.pop("state")
            rt.record(
                "network.state.committed",
                context=ctx,
                node_id=node_id,
                role=current,
                hop=walk.hop,
                state_keys=sorted(patch),
                state_hash=digest(state),
            )
            message = decision["message"]
            if decision["next"] == DONE:
                break
            walk.uses[(current, decision["next"])] += 1
            walk.hop += 1
            walk.activations[decision["next"]] += 1
            current = decision["next"]
        result = evaluate(network["result"], {"state": state, "message": message})
        rt.record(
            "network.completed",
            context=ctx,
            node_id=node_id,
            hops=walk.hop,
            activations=dict(walk.activations),
            result_hash=digest(result),
        )
        return result
    except BaseException as exc:
        from ..workflow import failure_code

        facts = dict(node_id=node_id, hop=walk.hop, role=current)
        if isinstance(exc, asyncio.CancelledError):
            # Cancelled from outside: by the node's own timeout (`timeout`), the graph's
            # deadline or the host (`cancelled`). The network cannot tell which from inside;
            # the node can, once the cancellation has passed its timeout, and records
            # `network.failed` with its own code before `node.failed`, so the two events name
            # one cause (R-15, R-18).
            exc.deferred_failure = ("network.failed", facts)
            raise
        rt.record("network.failed", context=ctx, error_code=failure_code(exc), **facts)
        raise


def _activation(workflow, node_id, network, role_id, role, message, walk, patched):
    """One activation (R-15): the role's steps in order over its view, the message and its
    earlier steps; then the patch it writes, validated over the shared state before anything
    is routed; then its route. All inside the role's timeout, in the worker instance the
    runtime gave it. It returns the patch and the decision; the loop keeps the next state."""

    async def work(ctx, view):
        ctx.node_id = f"{node_id}/{role_id}"
        local = {"state": view, "message": copy.deepcopy(message), "steps": {}}
        async with asyncio.timeout(role["timeout_seconds"]):
            for step in role["steps"]:
                await asyncio.sleep(0)
                local["steps"][step["id"]] = await workflow._step(step, local, ctx)
            patch = {tokens(p)[0]: evaluate(v, local) for p, v in role["writes"].items()}
            patched(role_id, patch)
            decision = await _route(workflow, node_id, network, role_id, role, local, walk, ctx)
        return {"patch": patch, "decision": decision}

    return work


def _check_transition(rt, ctx, node_id, network, role_id, role, walk, answer, chosen_by):
    """The transition check (R-14): the target is a declared edge of this role (or `done` where
    the role may end), the edge has uses left, the hops are not exhausted, the target's
    activations are below its cap. Every decision is recorded with its reason."""
    target = answer["next"]
    declared = target == DONE or any(edge["to"] == target for edge in role["edges"])
    facts = dict(
        node_id=node_id,
        role=role_id,
        hop=walk.hop,
        activation=walk.activations[role_id],
        chosen_by=chosen_by,
        hops_left=network["max_hops"] - walk.hop,
        next=target if declared else None,
    )
    reason = None
    if target == DONE:
        if not role["may_end"]:
            reason = "end_not_allowed"
    elif not declared:
        reason = "edge_undeclared"
    elif walk.hop >= network["max_hops"]:
        reason = "hops_exhausted"
    else:
        edge = next(edge for edge in role["edges"] if edge["to"] == target)
        cap = network["roles"][target].get("max_activations")
        if walk.uses[(role_id, target)] >= edge["max_uses"]:
            reason = "edge_exhausted"
        elif cap is not None and walk.activations[target] >= cap:
            reason = "role_exhausted"
        else:
            facts["uses"] = walk.uses[(role_id, target)] + 1
            facts["max_uses"] = edge["max_uses"]
    rt.record("route.decided", context=ctx, allowed=reason is None, **facts, reason=reason)
    if reason is not None:
        if chosen_by == "model":
            raise RouteRefusal(reason, target if declared else None)
        if reason in ("edge_undeclared", "end_not_allowed"):
            raise PolicyError(f"role {role_id}: route to {target!r} is not declared ({reason})")
        raise BudgetError(f"role {role_id}: route to {target!r} refused ({reason})")


async def _route(workflow, node_id, network, role_id, role, local, walk, ctx):
    """The route decision (R-13, R-14): fixed, or one model call under the runtime-built closed
    schema (the enum of the declared targets plus `done` where allowed, the message under the
    network's message schema), with the availability in the request data and the transition
    check applied to the answer before it is accepted."""
    from ..workflow import WorkflowError

    rt = workflow.runtime
    route = role["route"]
    files = workflow.package.files
    message_schema = network["message_schema"]
    if "task" not in route:
        message = evaluate(route["message"], local)
        validate_instance(files, message_schema, message, f"role {role_id} route message")
        answer = {"next": route["next"], "message": message}
        _check_transition(rt, ctx, node_id, network, role_id, role, walk, answer, "package")
        return answer
    data = route_data(
        network,
        role_id,
        evaluate(route["input"], local),
        walk.uses,
        walk.activations,
        walk.hop,
    )
    targets = [edge["to"] for edge in role["edges"]] + ([DONE] if role["may_end"] else [])
    bundled = workflow._model_schema(message_schema)
    schema = {
        "type": "object",
        "properties": {"next": {"enum": targets}, "message": {"$ref": bundled["$ref"]}},
        "required": ["next", "message"],
        "additionalProperties": False,
        "$defs": bundled["$defs"],
    }

    def check(answer):
        # The package's own closed validator for the message (formats, local refs), then the
        # transition: both before the answer is accepted, so a refused one is charged and
        # audited as a non-conforming answer (R-14).
        validate_instance(files, message_schema, answer["message"], f"role {role_id} route message")
        _check_transition(rt, ctx, node_id, network, role_id, role, walk, answer, "model")

    # The route is the activation's last operation, named `<node>/<role>/route` in the audit as
    # the execution host names it (R-13).
    ctx.operation_id = f"{ctx.node_id}/route"
    try:
        answer = await ctx.model(
            route["task"],
            data,
            schema,
            max_output_tokens=route["max_output_tokens"],
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
        error = WorkflowError(code, f"{node_id}/{role_id}/route")
        if isinstance(getattr(exc, "failed_check", None), dict):
            error.failed_check = exc.failed_check
        raise error from exc
    finally:
        del ctx.operation_id
    return answer


__all__ = ["RouteRefusal", "Walk", "run_network"]
