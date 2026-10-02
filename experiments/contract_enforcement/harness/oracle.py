"""Judging one observation: did the forbidden state cross its boundary, and who stopped it?

Two questions, answered separately and in this order:

1. **Was the forbidden boundary reached?** The case's own predicate, evaluated
   over what the canaries and the state probe recorded — never over a returned
   error code. A boundary that was reached makes a violation a
   SILENT_VIOLATION, whatever was refused afterwards.
2. **What stopped the run?** The earliest refusal the production code issued,
   looked up in the refusal vocabulary (`codes.py`). A refusal in the
   vocabulary is an explicit contract decision; anything else (a crash, an
   unexplained `worker_error`, a broken bridge) is incidental.

Outcomes:

    violation:  SILENT_VIOLATION | EXPLICIT_BLOCK | INCIDENTAL_FAILURE | HARNESS_ERROR
    control:    BENIGN_ACCEPT | FALSE_REJECT | HARNESS_ERROR

HARNESS_ERROR is reserved for the experiment's own failures (an RPC that broke,
a synthetic answer the harness could not produce, a violation that was never
injected). It never counts as detection.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass

from . import codes

EXPLICIT_BLOCK = "EXPLICIT_BLOCK"
INCIDENTAL_FAILURE = "INCIDENTAL_FAILURE"
SILENT_VIOLATION = "SILENT_VIOLATION"
BENIGN_ACCEPT = "BENIGN_ACCEPT"
FALSE_REJECT = "FALSE_REJECT"
HARNESS_ERROR = "HARNESS_ERROR"
VIOLATION_OUTCOMES = (EXPLICIT_BLOCK, INCIDENTAL_FAILURE, SILENT_VIOLATION, HARNESS_ERROR)
CONTROL_OUTCOMES = (BENIGN_ACCEPT, FALSE_REJECT, HARNESS_ERROR)


@dataclass
class Refusal:
    source: str  # page | control | start | revalidate | lease | runner | call | workflow
    code: str
    component: str | None
    stage: str | None
    check: str | None = None
    step: str | None = None
    detail: str = ""

    @property
    def recognized(self) -> bool:
        return self.component is not None

    def as_json(self) -> dict:
        return asdict(self)


# -- observation helpers (used by boundary predicates) ------------------------------------
def completed(obs: dict) -> bool:
    record = obs.get("run_record") or {}
    return record.get("status") == "completed" and obs.get("workflow_status") == "completed"


def workflow_started(obs: dict) -> bool:
    return any(event.get("action") == "workflow.started" for event in obs.get("audit") or [])


def runner_began(obs: dict) -> bool:
    return obs.get("runner_begin") is not None


def plan_prepared(obs: dict) -> bool:
    return bool(obs.get("plan_prepared"))


def lease_issued(obs: dict) -> bool:
    return any(
        method == "POST" and route.endswith("/execution-lease") and 200 <= status < 300
        for method, route, status in obs.get("control_calls") or []
    )


def committed_nodes(obs: dict) -> set[str]:
    nodes: set[str] = set()
    for commit in obs.get("commits") or []:
        nodes.update(commit.get("nodes") or [])
    return nodes


def node_committed(obs: dict, node_id: str) -> bool:
    return node_id in committed_nodes(obs)


def text_of(value) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(value)


def state_contains(obs: dict, token: str) -> bool:
    return any(token in text_of(commit.get("state")) for commit in obs.get("commits") or [])


def final_state(obs: dict) -> dict:
    """The run's final workflow state: the runner's report, else the last committed wave."""
    state = obs.get("final_state")
    if isinstance(state, dict):
        return state
    commits = obs.get("commits") or []
    return commits[-1]["state"] if commits else {}


def output_contains(obs: dict, token: str) -> bool:
    return completed(obs) and token in text_of(obs.get("final_output"))


def canaries(obs: dict):
    return obs.get("canaries")


def model_dispatches(obs: dict) -> list[dict]:
    return list(canaries(obs).model_calls) if canaries(obs) is not None else []


def transports(obs: dict) -> list[dict]:
    return list(canaries(obs).transports) if canaries(obs) is not None else []


def audit_actions(obs: dict, action: str) -> list[dict]:
    return [event for event in obs.get("audit") or [] if event.get("action") == action]


# -- what stopped the run -----------------------------------------------------------------
STEP_ROUTES = {
    "open": "/open-file",
    "pin": "/trust-publisher",
    "authorize": "/authorize",
    "prepare": "/run-plan",
}


def _control_refusal(
    error: dict, obs: dict, *, step: str | None, source: str = "control"
) -> Refusal:
    code = error.get("code") or ""
    if code == "package_rejected":
        validation = error.get("validation") or {}
        layer = next(
            (
                name
                for name in ("container", "integrity", "schema")
                if validation.get(f"{name}_status") == "invalid"
            ),
            None,
        )
        component, stage = codes.LAYER.get(layer, ("verification", "verify"))
        return Refusal(source, code, component, stage, check=f"{layer}_invalid", step=step)
    if code == "run_plan_refused":
        return _blocker_refusal(error.get("blocking_reasons") or [], obs, step=step, source=source)
    if code == "run_plan_stale":
        stale = [item.get("code") for item in error.get("stale_reasons") or []]
        first = next((c for c in stale if c in codes.STALE), None)
        return Refusal(source, code, "revalidation", "revalidate", check=first, step=step)
    if code in codes.CONTROL:
        component, stage = codes.CONTROL[code]
        return Refusal(source, code, component, stage, check=code, step=step)
    return Refusal(source, code, None, None, step=step, detail=str(error.get("message", ""))[:300])


def _blocker_refusal(blockers: list[dict], obs: dict, *, step, source="control") -> Refusal:
    found = []
    for blocker in blockers:
        code = blocker.get("code")
        if code == "authorization_not_runnable":
            for relayed in obs.get("receipt_blocking") or []:
                if relayed in codes.BLOCKERS:
                    found.append(relayed)
        elif code in codes.BLOCKERS:
            found.append(code)
    if not found:
        first = blockers[0].get("code") if blockers else "run_plan_refused"
        return Refusal(source, "run_plan_refused", None, None, check=first, step=step)
    found.sort(key=lambda c: codes.PRECEDENCE.index(codes.BLOCKERS[c][0]))
    component, stage = codes.BLOCKERS[found[0]]
    return Refusal(source, "run_plan_refused", component, stage, check=found[0], step=step)


def _runner_refusal(obs: dict) -> Refusal | None:
    for event in obs.get("events") or []:
        if event.get("event") == "runner.refused":
            code = str(event.get("code") or "")
            component, stage = codes.RUNNER.get(code, (None, None))
            return Refusal("runner", code, component, stage, check=code, step="start")
    return None


def _start_refusal(error: dict, obs: dict) -> Refusal:
    code = str(error.get("code") or "")
    # The plugin's fixed refusal sentence is the error's title; the detail explains it.
    detail = f"{error.get('title') or ''}\n{error.get('detail') or ''}"
    runner = _runner_refusal(obs)
    if runner is not None:
        return runner
    during = obs.get("start_control_errors") or []
    if during:
        return _control_refusal(during[0], obs, step="start", source="lease")
    if code in (
        "run_plan_stale",
        "probe_refused",
        "selected_model_unavailable",
        "authorization_expiring",
    ):
        found = codes.revalidate_check(detail)
        component = found[1] if found else "revalidation"
        check = found[0] if found else code
        if code == "authorization_expiring":
            check = "receipt_outlasts_run_deadline"
        return Refusal(
            "revalidate",
            code,
            component,
            "revalidate",
            check=check,
            step="start",
            detail=detail[:300],
        )
    found = codes.start_check(detail)
    if found is not None:
        return Refusal(
            "start", code, found[1], "revalidate", check=found[0], step="start", detail=detail[:300]
        )
    if code == "execution_refused" and ":" in detail:
        inner = detail.split(":", 1)[0].strip()
        if inner in codes.RUNNER:
            component, stage = codes.RUNNER[inner]
            return Refusal("runner", inner, component, stage, check=inner, step="start")
    if code in codes.START_CODES:
        component, stage = codes.START_CODES[code]
        return Refusal(
            "start", code, component, stage, check=code, step="start", detail=detail[:300]
        )
    return Refusal("start", code, None, None, step="start", detail=detail[:300])


def _workflow_refusal(obs: dict) -> Refusal:
    run = obs.get("runner_run") or {}
    if obs.get("halted"):
        return Refusal(
            "call", "token_accounting_halt", "resource", "resource", check="router_accounting"
        )
    if run.get("deadline_exceeded") or run.get("error_code") == "timeout":
        return Refusal("workflow", "timeout", "resource", "resource", check="run_deadline")
    audit = obs.get("audit") or []
    denied = {
        event.get("permission")
        for event in audit
        if event.get("action") == "permission.checked" and event.get("allowed") is False
    }
    for event in audit:
        action = event.get("action")
        reason = event.get("reason")
        if action == "model.refused" and reason in codes.CALL_REASONS:
            component, stage = codes.CALL_REASONS[reason]
            return Refusal("call", reason, component, stage, check=reason)
        if action in ("model.failed", "model.count.failed", "tool.failed"):
            if reason in codes.CALL_REASONS:
                component, stage = codes.CALL_REASONS[reason]
                return Refusal("call", reason, component, stage, check=reason)
            if event.get("error") in ("PolicyError", "BudgetError"):
                if event.get("error") == "BudgetError":
                    return Refusal("call", "budget", "resource", "resource", check="call_budget")
                stage = "execute/tool" if action == "tool.failed" else "execute/model"
                if denied:
                    return Refusal(
                        "call", "permission_denied", "authorization", stage, check="grant"
                    )
                return Refusal("call", "policy_refused", "mediation", stage, check="confinement")
            if event.get("error") == "TimeoutError":
                return Refusal("call", "timeout", "resource", "resource", check="call_timeout")
        if action == "node.failed":
            failed = event.get("failed_check") or {}
            error_code = event.get("error_code")
            if failed.get("check") in ("assertion", "lookup", "output_schema"):
                return Refusal(
                    "workflow",
                    error_code or "schema_validation",
                    "validation",
                    "validate",
                    check=f"{failed.get('check')}:{failed.get('kind', failed.get('failure', ''))}",
                )
            if error_code == "schema_validation" and event.get("node_type") == "map":
                if any(
                    item.get("node") == event.get("node_id")
                    for item in obs.get("map_refusals") or []
                ):
                    return Refusal(
                        "workflow",
                        "schema_validation",
                        "resource",
                        "resource",
                        check="map_max_items",
                    )
                return Refusal(
                    "workflow", "schema_validation", "validation", "validate", check="map_items"
                )
            if error_code == "schema_validation":
                return Refusal(
                    "workflow", "schema_validation", "validation", "validate", check="schema"
                )
            if error_code == "budget_exhausted":
                return Refusal(
                    "workflow", "budget_exhausted", "resource", "resource", check="budget"
                )
            if error_code == "timeout":
                return Refusal("workflow", "timeout", "resource", "resource", check="node_timeout")
            if error_code == "permission_denied":
                if denied:
                    return Refusal(
                        "workflow",
                        "permission_denied",
                        "authorization",
                        "execute/tool",
                        check="grant",
                    )
                return Refusal(
                    "workflow",
                    "permission_denied",
                    "mediation",
                    "execute/tool",
                    check="confinement",
                )
        if action == "worker.denied":
            return Refusal(
                "workflow", "worker_denied", "mediation", "execute/tool", check="delegation"
            )
    code = run.get("error_code") or obs.get("workflow_error") or "unknown"
    if code in codes.WORKFLOW:
        component, stage = codes.WORKFLOW[code]
        return Refusal("workflow", code, component, stage, check=code)
    return Refusal("workflow", code, None, None)


def first_refusal(obs: dict) -> Refusal | None:
    for error in obs.get("page_errors") or []:
        step = error.get("step")
        if step == "start":
            return _start_refusal(error, obs)
        if step in ("evaluate", "permissions", "validate_input"):
            continue
        route = STEP_ROUTES.get(step)
        matches = [
            item
            for item in obs.get("control_errors") or []
            if route and item["route"].endswith(route)
        ]
        if matches:
            return _control_refusal(matches[-1], obs, step=step)
        code = str(error.get("code") or "")
        if code in codes.CONTROL:
            component, stage = codes.CONTROL[code]
            return Refusal("page", code, component, stage, check=code, step=step)
        return Refusal(
            "page", code, None, None, step=step, detail=str(error.get("detail", ""))[:300]
        )
    record = obs.get("run_record") or {}
    if record and record.get("status") in ("failed", "cancelled"):
        return _workflow_refusal(obs)
    return None


# -- harness health -----------------------------------------------------------------------------
# A refused attempt to leave the process: production reached a path the
# experiment's seams do not cover. The experiment must fail on it, whatever
# the case's outcome would otherwise be. (A canary-file open is not here: it is
# a forbidden boundary that the case itself judges.)
LEAVE_PROCESS = (
    "socket.",
    "subprocess.",
    "net.",
    "tls.",
    "http.",
    "https.",
    "fetch",
    "child_process.",
    "dns.",
)
SPAWN = {
    "os.fork",
    "os.forkpty",
    "os.posix_spawn",
    "os.posix_spawnp",
    "os.system",
    "os.execv",
    "os.execve",
}


def network_attempts(obs: dict) -> list[str]:
    python = [item["kind"] for item in obs.get("python_guard") or []]
    node = [
        item.get("kind", "")
        for item in ((obs.get("helper") or {}).get("guard") or {}).get("refused") or []
    ]
    return [kind for kind in python + node if kind.startswith(LEAVE_PROCESS) or kind in SPAWN]


def harness_problems(obs: dict) -> list[str]:
    problems = []
    if network_attempts(obs):
        problems.append("network_or_process_attempt")
    for event in obs.get("events") or []:
        if event.get("event") in (
            "runner.harness_failure",
            "harness.case_timeout",
            "harness.exception",
        ):
            problems.append(event.get("event"))
    if obs.get("rpc_failures"):
        problems.append("rpc_handler_failure")
    if canaries(obs) is not None and canaries(obs).anomalies:
        problems.append("synthetic_anomaly")
    return problems


@dataclass
class Verdict:
    outcome: str
    boundary_reached: bool
    refusal: Refusal | None
    harness: list[str]
    completed: bool
    detected_after_boundary: bool
    fault_fired: bool | None

    def as_json(self) -> dict:
        return {
            "outcome": self.outcome,
            "forbidden_boundary_reached": self.boundary_reached,
            "refusal": self.refusal.as_json() if self.refusal else None,
            "harness_problems": list(self.harness),
            "completed": self.completed,
            "detected_after_boundary": self.detected_after_boundary,
            "fault_fired": self.fault_fired,
        }


def judge(kind: str, obs: dict, boundary, *, requires_fault: bool = False) -> Verdict:
    """Classify one observation. `boundary(obs) -> bool` is the case's own predicate."""
    reached = bool(boundary(obs)) if kind == "violation" else False
    refusal = first_refusal(obs)
    harness = harness_problems(obs)
    done = completed(obs)
    fired = bool(obs.get("faults_fired")) if requires_fault else None
    if kind == "violation":
        if reached:
            outcome = SILENT_VIOLATION
        elif harness:
            outcome = HARNESS_ERROR
        elif requires_fault and not fired:
            # The violation was never injected (the run stopped earlier, or the
            # fault's match never occurred): this case tested nothing.
            harness = [*harness, "violation_not_injected"]
            outcome = HARNESS_ERROR
        elif refusal is not None and refusal.recognized:
            outcome = EXPLICIT_BLOCK
        elif refusal is None and done:
            # The run completed and no predicate fired: the case could not
            # observe its own violation. That is the harness's problem.
            harness = [*harness, "violation_not_observed"]
            outcome = HARNESS_ERROR
        else:
            outcome = INCIDENTAL_FAILURE
        return Verdict(
            outcome,
            reached,
            refusal,
            harness,
            done,
            bool(reached and refusal is not None and refusal.recognized),
            fired,
        )
    if harness:
        outcome = HARNESS_ERROR
    elif done and refusal is None:
        outcome = BENIGN_ACCEPT
    else:
        outcome = FALSE_REJECT
    return Verdict(outcome, False, refusal, harness, done, False, fired)
