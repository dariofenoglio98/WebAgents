"""F8 — resource governance: budgets, caps, fan-out bounds and deadlines hold.

Every limit a case sets is derived from what the benign run actually consumed
(`calibration.py`): a budget is a fixed fraction of the calibrated need, so
the violation is real rather than assumed, and the matched control grants
exactly (or, where concurrency makes the peak vary, comfortably) what the run
needs. Deadline cases use real waits of a few seconds against deadlines of one
to five seconds; no case waits for a production-sized timeout.
"""

from __future__ import annotations

import json
import math

from harness import oracle

from . import boundaries as B
from .base import Template, base_plan, edit_json, graph_node, host, payload, resigned_plan
from .f7_output import rule

BOTH = ("meeting-agenda", "literature-review")
LR = ("literature-review",)
FIRST_NODE = {"meeting-agenda": ("plan", "plan"), "literature-review": ("planning", "plan")}
LAST_TASK = {"meeting-agenda": "write", "literature-review": "verify"}


def policy(**changes) -> dict:
    from harness.world import EXECUTION_POLICY

    return {**EXECUTION_POLICY, **changes}


# -- global token budget (host) ---------------------------------------------------------------
class TokenBudget(Template):
    FRACTIONS = (0.1, 0.4, 0.7, 0.9)

    def variants(self, package, env, rng, budget):
        usage = env.calibrated(package)["usage"]
        peak = usage["peak_tokens"]
        control = math.ceil(peak * 1.25)
        return [
            self.variant(
                package,
                f"limit-{int(fraction * 100)}pct",
                {"total_tokens": max(1, int(peak * fraction))},
                f"the host's run token budget is {int(fraction * 100)}% of what the run reserves "
                "at its peak "
                f"({int(peak * fraction)} of {peak})",
                control_params={"total_tokens": control},
                control_description=f"a token budget of 125% of the calibrated peak ({control})",
            )
            for fraction in self.FRACTIONS
        ]

    def plan(self, variant, kind, env):
        limit = (variant.control_params if kind == "control" else variant.params)["total_tokens"]
        plan = base_plan(env, variant.package, host=host(policy=policy(totalTokens=limit)))
        return plan, B.tokens_beyond(variant.params["total_tokens"])


TOKEN_BUDGET = TokenBudget(
    "F8.token_budget",
    "F8",
    "Run needs more tokens than the host's budget",
    "The operator's per-run token budget is set below what the workflow reserves; every other "
    "setting is the benign one.",
    "Reserved plus used tokens never exceed the effective budget; a call that would is refused "
    "before it is dispatched.",
    "resource",
    "resource",
    ("global_token_budget",),
    "Used plus reserved tokens exceed the budget at any point of the run.",
    "A budget of 125% of the calibrated peak.",
    "parametric",
    BOTH,
    "minus_resource_enforcement",
    "global token reservation",
    "token budget exhausted",
)


# -- per-worker token budget (package-declared) -----------------------------------------------
class WorkerTokenBudget(Template):
    def variants(self, package, env, rng, budget):
        usage = env.calibrated(package)["usage"]
        node_id, _ = FIRST_NODE[package]
        role = graph_node(json.loads(payload(env, package)["graph.json"]), node_id)["worker"]
        first = usage["role_first_reservation"][role]
        need = usage["role_need"][role]
        return [
            self.variant(
                package,
                label,
                {"role": role, "tokens": max(1, value)},
                f"the package declares {role} a token budget ({value}) below the reservation of "
                "its "
                f"first call ({first})",
                control_params={"role": role, "tokens": need},
                control_description=(
                    f"{role}'s budget exactly equal to what its calls need ({need})"
                ),
            )
            for label, value in (("half", first // 2), ("just_below", first - 1))
        ]

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        node_id, _ = FIRST_NODE[variant.package]

        def edit(graph):
            for worker in graph["workers"]:
                if worker["id"] == params["role"]:
                    worker["budget"]["tokens"] = params["tokens"]

        files = edit_json(payload(env, variant.package), "graph.json", edit)
        # The node's only call needs more than the budget: a commit means it was dispatched anyway.
        return resigned_plan(env, variant.package, files), B.committed(node_id)


WORKER_TOKEN_BUDGET = WorkerTokenBudget(
    "F8.worker_token_budget",
    "F8",
    "Worker call larger than the worker's declared token budget",
    "A trusted package declares one worker a token budget smaller than the reservation its "
    "first model call needs.",
    "A worker never reserves more tokens than its own declared budget.",
    "resource",
    "resource",
    ("worker_token_budget",),
    "The worker's call is dispatched (or its node commits) beyond its declared budget.",
    "The worker's budget set exactly to that reservation.",
    "finite",
    BOTH,
    "minus_resource_enforcement",
    "per-worker token reservation",
    "worker budget exceeded",
)


# -- remote-call budget (host and package) ------------------------------------------------------
class RemoteBudget(Template):
    def variants(self, package, env, rng, budget):
        need = env.calibrated(package)["usage"]["remote_calls"]
        out = []
        for label, value in (("one", 1), ("half", max(1, need // 2)), ("one_short", need - 1)):
            if value >= need:
                continue
            out.append(
                self.variant(
                    package,
                    f"host-{label}",
                    {"scope": "host", "limit": value},
                    f"the host allows {value} remote calls; the run makes {need}",
                    control_params={"scope": "host", "limit": need},
                    control_description=(
                        f"the host allows exactly the {need} remote calls the run makes"
                    ),
                )
            )
        # A worker budget binds each worker *instance* (runtime.py keys usage by
        # worker id; docs/tool-broker.md section 13), so the violation is an
        # instance allowed fewer remote calls than one instance makes.
        for role, need_one in sorted(env.calibrated(package)["usage"]["role_remote_need"].items()):
            out.append(
                self.variant(
                    package,
                    f"worker-{role}-0",
                    {"scope": "worker", "role": role, "limit": 0, "instance_need": need_one},
                    f"the package declares {role} 0 remote calls per instance; each instance "
                    f"makes {need_one}",
                    control_params={"scope": "worker", "role": role, "limit": need_one},
                    control_description=(
                        f"{role} declared exactly the {need_one} remote call(s) one instance makes"
                    ),
                )
            )
        return out

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        limit = variant.params["limit"]
        if params["scope"] == "host":
            plan = base_plan(
                env, variant.package, host=host(policy=policy(maxRemoteCalls=params["limit"]))
            )
            return plan, B.any_of(B.remote_beyond(limit), _transports_over(limit))

        def edit(graph):
            for worker in graph["workers"]:
                if worker["id"] == params["role"]:
                    worker["budget"]["remote_calls"] = params["limit"]

        files = edit_json(payload(env, variant.package), "graph.json", edit)
        return resigned_plan(env, variant.package, files), _instance_remote_beyond(
            params["role"], limit
        )


def _instance_remote_beyond(role: str, limit: int):
    """Some instance of `role` made more remote tool calls than its budget allows."""

    def predicate(obs) -> bool:
        counts: dict[str, int] = {}
        for event in obs.get("audit_raw") or []:
            if event.get("action") == "tool.called" and event.get("tool") in (
                "scholarly-search",
                "citation-resolver",
            ):
                worker = str(event.get("worker"))
                if worker.startswith(f"{role}:"):
                    counts[worker] = counts.get(worker, 0) + 1
        return any(count > limit for count in counts.values())

    predicate.__name__ = f"instance_remote_beyond[{role},{limit}]"
    return predicate


def _transports_over(limit: int):
    def predicate(obs) -> bool:
        return len(oracle.transports(obs)) > limit

    predicate.__name__ = f"transports_over[{limit}]"
    return predicate


REMOTE_BUDGET = RemoteBudget(
    "F8.remote_call_budget",
    "F8",
    "Run or worker needs more remote calls than allowed",
    "The host's per-run remote-call budget, or one worker role's package-declared per-instance "
    "remote-call budget, is below what the workflow (or one instance) makes.",
    "No run, and no worker instance, makes more remote calls than its effective budget allows.",
    "resource",
    "resource",
    ("budget",),
    "More remote requests leave than the budget allows.",
    "A budget exactly equal to the remote calls the run makes.",
    "finite",
    LR,
    "minus_resource_enforcement",
    "remote-call budget",
    "remote call budget exceeded",
)


# -- per-tool call budget (host ceiling) ----------------------------------------------------------
class ToolCallBudget(Template):
    def variants(self, package, env, rng, budget):
        need = env.calibrated(package)["usage"]["tool_calls"].get("scholarly-search", 0)
        return [
            self.variant(
                package,
                f"cap-{value}",
                {"limit": value},
                f"the host caps every tool at {value} calls; scholarly-search is called {need} "
                "times",
                control_params={"limit": need},
                control_description=f"a cap of exactly {need} calls per tool",
            )
            for value in range(1, need)
        ]

    def plan(self, variant, kind, env):
        limit = (variant.control_params if kind == "control" else variant.params)["limit"]
        plan = base_plan(env, variant.package, host=host(policy=policy(maxCallsPerTool=limit)))
        return plan, B.tool_calls_beyond("scholarly-search", variant.params["limit"])


TOOL_CALL_BUDGET = ToolCallBudget(
    "F8.tool_call_budget",
    "F8",
    "Tool called more often than its per-tool cap",
    "The host's per-tool call ceiling is below the number of times the workflow calls "
    "scholarly-search.",
    "No tool is called more often than its effective per-tool cap.",
    "resource",
    "resource",
    ("budget",),
    "The tool is called more often than the cap.",
    "A cap exactly equal to the calls the run makes.",
    "finite",
    LR,
    "minus_resource_enforcement",
    "per-tool call budget",
    "tool budget exceeded",
)


# -- fan-out bound (map max_items) ----------------------------------------------------------------
class Fanout(Template):
    CASES = (
        ("search", "queries", (4, 6, 10)),
        ("seed-discovery", "seed_queries", (21, 30)),
    )

    def variants(self, package, env, rng, budget):
        out = []
        for node, field, counts in self.CASES:
            for count in counts:
                out.append(
                    self.variant(
                        package,
                        f"{node}-{count}",
                        {"node": node, "field": field, "count": count},
                        f"the planning answer asks the {node} map for {count} items (it declares "
                        "at most "
                        f"{3 if node == 'search' else 20})",
                        control_params={
                            "node": node,
                            "field": field,
                            "count": 3 if node == "search" else 2,
                        },
                        control_description=(
                            "three rephrased search queries (exactly the declared maximum)"
                            if node == "search"
                            else "two seed queries (within the declared maximum)"
                        ),
                    )
                )
        return out

    @staticmethod
    def widen(output, field: str, count: int):
        base = list(output.get("queries") or ["signed agent packages"])
        output[field] = [
            f"{base[index % len(base)]} variant {index + 1}"[:480] for index in range(count)
        ]
        return output

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        plan = base_plan(env, variant.package)
        action = {
            "kind": "mutate",
            "apply": lambda output, schema, params=params: self.widen(
                output, params["field"], params["count"]
            ),
            "expect": "valid",
        }
        plan.faults.model.append(rule(variant.package, "plan", "", action))
        node, limit = variant.params["node"], 3 if variant.params["node"] == "search" else 20
        path = "/works" if node == "search" else "/resolve"
        # The violation's map has more items than it declares, so its commit is the violation.
        return plan, B.any_of(B.transports_beyond(path, limit), B.committed(node))


FANOUT = Fanout(
    "F8.fanout_bound",
    "F8",
    "Map asked for more items than it declares",
    "A schema-valid planning answer gives the search map more queries, or the seed-discovery "
    "map more seed lookups, than the map's declared `max_items`.",
    "A map never runs more items than it declares; a longer list is refused, not truncated.",
    "resource",
    "resource",
    ("schema_validation",),
    "The map commits, or more tool requests leave than the declared bound.",
    "As many items as the bound allows (or fewer), rephrased.",
    "finite",
    LR,
    "minus_resource_enforcement",
    "map max_items",
    "fan-out above bound",
    requires_fault=True,
)


# -- output-cap ceiling (host) ---------------------------------------------------------------------
class OutputCeiling(Template):
    CEILINGS = {"meeting-agenda": (11999, 8000, 1000), "literature-review": (15999, 12000, 4000)}

    def variants(self, package, env, rng, budget):
        caps = env.calibrated(package)["caps"]
        top = max(caps.values())
        return [
            self.variant(
                package,
                f"ceiling-{value}",
                {"ceiling": value},
                f"the host's per-call output ceiling is {value}; the package's operations request "
                f"up to {top}",
                control_params={"ceiling": top},
                control_description=f"a ceiling exactly equal to the largest declared cap ({top})",
            )
            for value in self.CEILINGS[package]
        ]

    def plan(self, variant, kind, env):
        ceiling = (variant.control_params if kind == "control" else variant.params)["ceiling"]
        plan = base_plan(
            env, variant.package, host=host(policy=policy(maxOutputTokensPerCall=ceiling))
        )
        return plan, B.max_tokens_above(variant.params["ceiling"])


OUTPUT_CEILING = OutputCeiling(
    "F8.output_cap_ceiling",
    "F8",
    "Operation's declared output cap above the host's ceiling",
    "The host's per-call output-token ceiling is below the cap one of the package's model "
    "operations declares.",
    "No call asks a model for more output than the host's ceiling; a declared cap above it is "
    "refused, never silently lowered.",
    "resource",
    "resource",
    ("execution_output_cap_too_large",),
    "A model call is dispatched with a larger output allowance than the ceiling.",
    "A ceiling equal to the largest declared cap.",
    "finite",
    BOTH,
    "minus_resource_enforcement",
    "output-cap ceiling",
    "output cap above host ceiling",
)


# -- usage accounting -----------------------------------------------------------------------------
USAGE = (
    ("output_over_cap", "reports one more output token than the call allowed"),
    ("output_triple_cap", "reports three times the output tokens the call allowed"),
    ("input_over_bound", "reports more input tokens than the router's own upper bound"),
    ("negative_count", "reports a negative output-token count (and a total consistent with it)"),
    ("negative_count_without_total", "reports a negative output-token count and no total"),
    ("string_count_without_total", "reports the output-token count as a string and no total"),
    ("fractional_count", "reports a fractional output-token count"),
    ("missing", "reports no usage at all"),
)
OVER_REPORT = {"output_over_cap", "output_triple_cap", "input_over_bound"}


def usage_change(label: str):
    def apply(usage, params):
        allowed = int(params.get("max_tokens") or 0)
        if label == "output_over_cap":
            return {**usage, "outputTokens": allowed + 1}
        if label == "output_triple_cap":
            return {**usage, "outputTokens": allowed * 3}
        if label == "input_over_bound":
            size = len(
                (str(params.get("system", "")) + str(params.get("user", ""))).encode("utf-8")
            )
            return {**usage, "inputTokens": size * 2 + 50_000}
        if label == "negative_count":
            return {**usage, "outputTokens": -5}
        if label == "negative_count_without_total":
            return {**usage, "outputTokens": -5, "_omit_total": True}
        if label == "string_count_without_total":
            return {**usage, "outputTokens": str(usage["outputTokens"]), "_omit_total": True}
        if label == "fractional_count":
            return {**usage, "outputTokens": usage["outputTokens"] + 0.5}
        if label == "missing":
            return {}
        if label == "at_cap":
            return {**usage, "outputTokens": allowed}
        raise ValueError(label)

    return apply


class UsageAccounting(Template):
    def variants(self, package, env, rng, budget):
        _, task = FIRST_NODE[package]
        return [
            self.variant(
                package,
                label,
                {"task": task, "usage": label},
                f"the host {description} on the {task} call",
                control_params={"task": task, "usage": "at_cap"},
                control_description=f"the {task} call reporting exactly its allowed output tokens",
            )
            for label, description in USAGE
        ]

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        plan = base_plan(env, variant.package)
        plan.faults.model.append(
            rule(
                variant.package,
                params["task"],
                "",
                {"kind": "usage", "apply": usage_change(params["usage"])},
            )
        )
        node, _ = FIRST_NODE[variant.package]
        if variant.params["usage"] in OVER_REPORT:
            # An overrun past the reservation must halt: the answer is never used.
            return plan, B.committed(node)
        return plan, _undercharged(params["task"])


def _undercharged(task: str):
    """The faulted call's answer was used while the run charged it less than its honest usage."""

    def predicate(obs) -> bool:
        faulted = [
            call
            for call in oracle.model_dispatches(obs)
            if call.get("fault") == "usage" and call.get("task") == task
        ]
        if not faulted:
            return False
        honest = int(faulted[0].get("honest_tokens") or 0)
        charged = [
            int(event.get("tokens", 0))
            for event in obs.get("audit_raw") or []
            if event.get("action") == "model.completed" and event.get("task") == task
        ]
        return bool(charged) and charged[0] < honest

    predicate.__name__ = f"undercharged[{task}]"
    return predicate


USAGE_ACCOUNTING = UsageAccounting(
    "F8.usage_accounting",
    "F8",
    "Host usage report that breaks the token-accounting contract",
    "The host reports more output tokens than the call allowed, more input tokens than the "
    "router's upper bound, an output count that is negative, fractional or not a number, or "
    "no usage.",
    "A call's usage is either accounted for honestly or the call is not used: an overrun past "
    "the reservation halts the run, and an unreadable count is refused (model_usage_invalid / "
    "model_usage_unavailable), never charged as less than the call used.",
    "resource",
    "resource",
    ("token_accounting_halt", "model_usage_invalid", "model_usage_unavailable"),
    "Over-reports: the node commits the overrunning call's answer. Unreadable counts: the "
    "answer is used while the run charges the call less than its honest usage.",
    "The call reporting exactly its allowed output tokens.",
    "finite",
    BOTH,
    "minus_resource_enforcement",
    "token accounting",
    "usage over-report",
    requires_fault=True,
)


# -- deadlines ------------------------------------------------------------------------------------
class Deadlines(Template):
    def variants(self, package, env, rng, budget):
        node, task = FIRST_NODE[package]
        last = LAST_TASK[package]
        graph_deadline = 3 if package == "meeting-agenda" else 6
        out = [
            self.variant(
                package,
                "node_timeout",
                {"kind": "node_timeout", "node": node, "task": task, "timeout": 1, "delay": 2.5},
                f"the package's {node} node declares a 1 s timeout; its model answers after 2.5 s",
                control_params={
                    "kind": "node_timeout",
                    "node": node,
                    "task": task,
                    "timeout": 1,
                    "delay": 0.1,
                },
                control_description="the same 1 s timeout with an answer after 0.1 s",
            ),
            self.variant(
                package,
                "graph_deadline",
                {
                    "kind": "graph_deadline",
                    "task": last,
                    "deadline": graph_deadline,
                    "delay": graph_deadline + 1.5,
                },
                f"the package's graph deadline is {graph_deadline} s; its last model call answers "
                "after "
                f"{graph_deadline + 1.5} s",
                control_params={
                    "kind": "graph_deadline",
                    "task": last,
                    "deadline": graph_deadline,
                    "delay": 0.1,
                },
                control_description=(
                    f"the same {graph_deadline} s deadline with an answer after 0.1 s"
                ),
            ),
            self.variant(
                package,
                "model_call_timeout",
                {"kind": "model_call_timeout", "task": task, "seconds": 1, "delay": 2.5},
                "the host's model-call timeout is 1 s; the call answers after 2.5 s",
                control_params={
                    "kind": "model_call_timeout",
                    "task": task,
                    "seconds": 1,
                    "delay": 0.1,
                },
                control_description="the same 1 s timeout with an answer after 0.1 s",
            ),
            self.variant(
                package,
                "run_deadline",
                {
                    "kind": "run_deadline",
                    "task": last,
                    "seconds": graph_deadline,
                    "delay": graph_deadline + 1.5,
                },
                f"the host's run deadline is {graph_deadline} s; the last model call answers after "
                f"{graph_deadline + 1.5} s",
                control_params={
                    "kind": "run_deadline",
                    "task": last,
                    "seconds": graph_deadline,
                    "delay": 0.1,
                },
                control_description=(
                    f"the same {graph_deadline} s run deadline with an answer after 0.1 s"
                ),
            ),
        ]
        if package == "literature-review":
            out.append(
                self.variant(
                    package,
                    "tool_timeout",
                    {
                        "kind": "tool_timeout",
                        "tool": "scholarly-search",
                        "timeout": 1,
                        "delay": 2.5,
                    },
                    "the package declares scholarly-search a 1 s timeout; Crossref answers after "
                    "2.5 s",
                    control_params={
                        "kind": "tool_timeout",
                        "tool": "scholarly-search",
                        "timeout": 1,
                        "delay": 0.1,
                    },
                    control_description="the same 1 s tool timeout with an answer after 0.1 s",
                )
            )
        return out

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        package = variant.package
        delay = {"kind": "delay", "seconds": params["delay"]}
        if params["kind"] == "node_timeout":
            files = edit_json(
                payload(env, package),
                "graph.json",
                lambda graph: graph_node(graph, params["node"]).__setitem__(
                    "timeout_seconds", params["timeout"]
                ),
            )
            plan = resigned_plan(env, package, files)
            plan.faults.model.append(rule(package, params["task"], "", delay))
            return plan, B.committed(params["node"])
        if params["kind"] == "graph_deadline":
            files = edit_json(
                payload(env, package),
                "graph.json",
                lambda graph: graph.__setitem__("deadline_seconds", params["deadline"]),
            )
            plan = resigned_plan(env, package, files)
            plan.faults.model.append(rule(package, params["task"], "", delay))
            return plan, _completed_late
        if params["kind"] == "model_call_timeout":
            plan = base_plan(
                env, package, host=host(policy=policy(modelCallTimeoutSeconds=params["seconds"]))
            )
            plan.faults.model.append(rule(package, params["task"], "", delay))
            node, _ = FIRST_NODE[package]
            return plan, B.committed(node)
        if params["kind"] == "run_deadline":
            plan = base_plan(
                env, package, host=host(policy=policy(runTimeoutSeconds=params["seconds"]))
            )
            plan.faults.model.append(rule(package, params["task"], "", delay))
            return plan, _completed_late
        # tool_timeout
        files = edit_json(
            payload(env, package),
            f"tools/{params['tool']}.tool.json",
            lambda doc: doc.__setitem__("timeout_seconds", params["timeout"]),
        )
        plan = resigned_plan(env, package, files)
        plan.faults.tools.append({"tool": params["tool"], "delay": params["delay"]})
        return plan, B.committed("search")


def _completed_late(obs) -> bool:
    """The run finished — after the deadline the case set, since the delay alone outlasts it."""
    return bool(obs.get("faults_fired")) and oracle.completed(obs)


DEADLINES = Deadlines(
    "F8.deadline",
    "F8",
    "Work that outlasts its deadline",
    "A node, the whole graph, one model call, the host run, or one tool call takes longer than "
    "its declared (package) or configured (host) deadline; deadlines are set to 1-6 s and the "
    "synthetic model or service answers 1.5 s after them.",
    "No node, call or run continues past its deadline: it is cancelled and the run fails as timed "
    "out.",
    "resource",
    "resource",
    ("timeout", "bridge_timeout", "tool_timeout"),
    "The late node commits, or the run completes past its deadline.",
    "The same deadline with an answer well inside it.",
    "finite",
    BOTH,
    "minus_resource_enforcement",
    "deadlines",
    "deadline exceeded",
    requires_fault=True,
)


# -- task size ------------------------------------------------------------------------------------
class InputSize(Template):
    SIZES = (("just_over", 256 * 1024 + 1), ("one_mib", 1024 * 1024), ("four_mib", 4 * 1024 * 1024))

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                label,
                {"bytes": size},
                f"a schema-valid task of {size} bytes (the host bounds a task at 262144)",
                control_params={"bytes": 4096},
                control_description="the same task shape at 4 KiB",
            )
            for label, size in self.SIZES
        ]

    def plan(self, variant, kind, env):
        size = (variant.control_params if kind == "control" else variant.params)["bytes"]
        package = variant.package
        plan = base_plan(env, package)

        def grow(task, ctx, size=size):
            task = dict(task)
            if package == "meeting-agenda":
                task["context"] = ("agenda-context " * (size // 15 + 1))[:size]
            else:
                seed = "Synthetic seed reference about signed agent packages"
                count = math.ceil(size / (len(seed) + 3)) + 1 if size > 8192 else 2
                task["seeds"] = [f"{seed} {index}" for index in range(count)]
            return task

        plan.input_patch = grow
        return plan, B.any_of(B.lease_or_executed, _runner_began)


def _runner_began(obs) -> bool:
    return oracle.runner_began(obs)


INPUT_SIZE = InputSize(
    "F8.input_size",
    "F8",
    "Task larger than the host accepts",
    "The task given to a run is schema-valid but larger than the host's task-size bound.",
    "An oversized task is refused before any lease, runner or model sees it.",
    "resource",
    "revalidate",
    ("input_size",),
    "A lease is issued, the runner begins, or anything executes with the oversized task.",
    "The same task shape at 4 KiB.",
    "finite",
    BOTH,
    "minus_resource_enforcement",
    "task-size bound",
    "oversized task",
)

TEMPLATES = (
    TOKEN_BUDGET,
    WORKER_TOKEN_BUDGET,
    REMOTE_BUDGET,
    TOOL_CALL_BUDGET,
    FANOUT,
    OUTPUT_CEILING,
    USAGE_ACCOUNTING,
    DEADLINES,
    INPUT_SIZE,
)
