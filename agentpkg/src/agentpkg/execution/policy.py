"""What the trusted host adds on top of what the package already declares.

Three separate things live here, and none of them knows what a package is for:

* **host execution limits**, which can only lower package-declared budgets;
* **an upper bound on a single call's output cap**, which is a refusal rather
  than a silent reduction, because lowering a node's declared cap would change
  what the package does;
* **the capability limits of this execution host in this milestone**, which are
  checked against the graph's declarations rather than against a package name.

Everything is derived from the graph and the policy document. There is no
package identifier, display name, task name, skill name or application word
anywhere in this module, and a test asserts that.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..artifacts import HOST_RESULT_NAMES, RUN_RECORD_NAME
from .errors import (
    EXPORT_PATH_RESERVED,
    GRANT_UNSUPPORTED,
    MODEL_INCOMPATIBLE,
    OUTPUT_CAP_TOO_LARGE,
    PERMISSION_DENIED,
    TOOLS_NOT_SUPPORTED,
    ExecutionError,
    invalid,
)

DENY = "deny"
ONCE = "once"
SESSION = "session"
ALWAYS = "always"
SUPPORTED_DECISIONS = (DENY, ONCE, SESSION)

# Conservative defaults. An operator lowers them; nothing raises them above the
# package's own declarations, because `Runtime` applies min() to every one.
DEFAULT_TOTAL_TOKENS = 120_000
DEFAULT_MAX_REMOTE_CALLS = 32
DEFAULT_MAX_PARALLEL_WORKERS = 3
DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL = 16_000
DEFAULT_RUN_TIMEOUT_SECONDS = 600

MAX_TOTAL_TOKENS = 10_000_000
MAX_REMOTE_CALLS = 10_000
MAX_PARALLEL_WORKERS = 64
MAX_OUTPUT_TOKENS_PER_CALL = 200_000
MAX_RUN_TIMEOUT_SECONDS = 86_400


def _bounded(value, field: str, *, default: int, maximum: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise invalid(f"limits.{field} must be a positive integer")
    if value > maximum:
        raise invalid(f"limits.{field} exceeds the supported maximum of {maximum}")
    return value


@dataclass(frozen=True)
class HostExecutionLimits:
    """Trusted host bounds for one run."""

    total_tokens: int = DEFAULT_TOTAL_TOKENS
    max_remote_calls: int = DEFAULT_MAX_REMOTE_CALLS
    max_parallel_workers: int = DEFAULT_MAX_PARALLEL_WORKERS
    max_output_tokens_per_call: int = DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL
    run_timeout_seconds: int = DEFAULT_RUN_TIMEOUT_SECONDS

    @classmethod
    def normalize(cls, raw) -> HostExecutionLimits:
        if raw is None:
            return cls()
        if not isinstance(raw, dict):
            raise invalid("limits must be an object")
        allowed = {
            "total_tokens",
            "max_remote_calls",
            "max_parallel_workers",
            "max_output_tokens_per_call",
            "run_timeout_seconds",
        }
        unknown = sorted(set(raw) - allowed)
        if unknown:
            raise invalid(f"Unknown fields in limits: {unknown}")
        return cls(
            total_tokens=_bounded(
                raw.get("total_tokens"),
                "total_tokens",
                default=DEFAULT_TOTAL_TOKENS,
                maximum=MAX_TOTAL_TOKENS,
            ),
            max_remote_calls=_bounded(
                raw.get("max_remote_calls"),
                "max_remote_calls",
                default=DEFAULT_MAX_REMOTE_CALLS,
                maximum=MAX_REMOTE_CALLS,
            ),
            max_parallel_workers=_bounded(
                raw.get("max_parallel_workers"),
                "max_parallel_workers",
                default=DEFAULT_MAX_PARALLEL_WORKERS,
                maximum=MAX_PARALLEL_WORKERS,
            ),
            max_output_tokens_per_call=_bounded(
                raw.get("max_output_tokens_per_call"),
                "max_output_tokens_per_call",
                default=DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL,
                maximum=MAX_OUTPUT_TOKENS_PER_CALL,
            ),
            run_timeout_seconds=_bounded(
                raw.get("run_timeout_seconds"),
                "run_timeout_seconds",
                default=DEFAULT_RUN_TIMEOUT_SECONDS,
                maximum=MAX_RUN_TIMEOUT_SECONDS,
            ),
        )

    def runtime_limits(self) -> dict:
        """Exactly the keys `Runtime` accepts; it applies min() to each one."""
        return {
            "hard_tokens": self.total_tokens,
            "max_remote_calls": self.max_remote_calls,
            "max_parallel_workers": self.max_parallel_workers,
        }

    def as_json(self) -> dict:
        return {
            "total_tokens": self.total_tokens,
            "max_remote_calls": self.max_remote_calls,
            "max_parallel_workers": self.max_parallel_workers,
            "max_output_tokens_per_call": self.max_output_tokens_per_call,
            "run_timeout_seconds": self.run_timeout_seconds,
        }


def effective_budget(package, limits: HostExecutionLimits) -> dict:
    """What the package declared, what the host allowed, and the min of both."""
    declared = package.policy["budget"]
    host = limits.runtime_limits()
    return {
        "declared": {
            "hard_tokens": declared["hard_tokens"],
            "max_remote_calls": declared["max_remote_calls"],
            "max_parallel_workers": declared["max_parallel_workers"],
            "estimated_tokens": declared["estimated_tokens"],
            "approval_threshold_tokens": declared.get("approval_threshold_tokens"),
        },
        "host": host,
        "effective": {key: min(host[key], declared[key]) for key in host},
    }


def effective_deadline_seconds(package, limits: HostExecutionLimits) -> int:
    """The tighter of the graph's own deadline and the host run timeout."""
    return min(int(package.graph["deadline_seconds"]), limits.run_timeout_seconds)


def _operations(graph):
    """Every top-level node and every map step, with a qualified identity."""
    for node in graph["nodes"]:
        yield node["id"], node
        if node["type"] == "map":
            for step in node["steps"]:
                yield f"{node['id']}/{step['id']}", step


def check_capabilities(package, limits: HostExecutionLimits) -> dict:
    """Refuse a package this execution host cannot run, before anything starts.

    These are limits of the host, not of the package format. A package that
    declares tools is a valid package; this milestone simply has no generic
    tool broker to mediate one, and pretending otherwise would mean either
    failing halfway through a run or executing an unmediated call.
    """
    graph = package.graph
    declared_tools = [tool["id"] for tool in package.manifest["tools"]]
    tool_nodes = [name for name, op in _operations(graph) if op["type"] == "tool"]
    if declared_tools or tool_nodes:
        raise ExecutionError(
            TOOLS_NOT_SUPPORTED,
            "This execution host has no package-tool broker yet, so it runs only packages "
            "that declare no tools. This is a limit of the host, not of the package format.",
            detail={"declared_tools": declared_tools[:32], "tool_nodes": tool_nodes[:32]},
        )
    caps = []
    for name, op in _operations(graph):
        if op["type"] != "llm":
            continue
        requested = op["max_output_tokens"]
        if requested > limits.max_output_tokens_per_call:
            # Silently lowering it would change what the package does, so the
            # run is refused instead and the operator raises the host ceiling.
            raise ExecutionError(
                OUTPUT_CAP_TOO_LARGE,
                f"Node {name} requests an output cap of {requested} tokens, above this host's "
                f"per-call ceiling of {limits.max_output_tokens_per_call}. The host refuses "
                "rather than lowering a declared cap.",
                detail={"node": name, "requested": requested},
            )
        caps.append({"node": name, "max_output_tokens": requested})
    reserved = {name.lower() for name in HOST_RESULT_NAMES} | {RUN_RECORD_NAME}
    for export in graph.get("exports", []):
        if export["path"].lower() in reserved:
            raise ExecutionError(
                EXPORT_PATH_RESERVED,
                f"Export {export['path']!r} collides with a file this execution host writes",
                detail={"reserved": sorted(reserved)},
            )
    return {
        "tools_declared": 0,
        "tool_nodes": 0,
        "llm_operations": caps,
        "max_requested_output_tokens": max((c["max_output_tokens"] for c in caps), default=0),
        "host_max_output_tokens_per_call": limits.max_output_tokens_per_call,
    }


def check_model(package, router) -> dict:
    """Confirm the bound router can satisfy every declared task before starting.

    `Runtime.call_model` checks this again for each task, which is where the
    authority actually lives. Checking it once up front means an incompatible
    binding is refused before a package instruction is rendered at all, rather
    than after part of a graph has already run.
    """
    requirements = package.manifest["model_requirements"]
    capabilities = set(router.capabilities)
    required = sorted({c for task in requirements["tasks"] for c in task["capabilities"]})
    missing = sorted(set(required) - capabilities)
    if missing:
        raise ExecutionError(
            MODEL_INCOMPATIBLE,
            f"The selected model's router does not deliver {missing}, which this package "
            "requires.",
            detail={"missing": missing, "router_capabilities": sorted(capabilities)},
        )
    context = max((task["context_window"] for task in requirements["tasks"]), default=0)
    if router.context_window < context:
        raise ExecutionError(
            MODEL_INCOMPATIBLE,
            f"The selected model reports a {router.context_window}-token context window; this "
            f"package requires {context}.",
            detail={"required_context_window": context, "router": router.context_window},
        )
    if requirements.get("privacy") == "local-only" and router.remote:
        raise ExecutionError(
            MODEL_INCOMPATIBLE,
            "This package requires a local-only model router, and the selected model is remote.",
        )
    return {
        "required_capabilities": required,
        "router_capabilities": sorted(capabilities),
        "required_context_window": context,
        "router_context_window": router.context_window,
        "privacy": requirements.get("privacy"),
        "remote": bool(router.remote),
    }


def _consumption_counts(package) -> dict[str, int]:
    """An upper bound on how often each permission kind would be consumed.

    `Runtime` consumes a `once` grant at first use. A worker spawn consumes the
    memory permission and a model call consumes the model permission, so a graph
    with more than one of either cannot be run under `once` without the host
    either denying mid-run or quietly treating the grant as something broader.

    A map's real child count depends on its runtime input, so its declared
    `max_items` is used. That makes this a bound rather than a count, which is
    all the decision needs: what matters is whether it can exceed one.
    """
    graph = package.graph
    coordinator = graph["coordinator"]
    model_calls = 0
    worker_spawns = 0
    for node in graph["nodes"]:
        if node["type"] == "llm":
            model_calls += 1
        if node["type"] == "map":
            # A map instantiates one worker per item; an empty input spawns
            # none, so its own minimum is one for counting purposes.
            worker_spawns += max(1, node["max_items"])
            for step in node["steps"]:
                if step["type"] == "llm":
                    model_calls += max(1, node["max_items"])
        elif node["worker"] != coordinator:
            worker_spawns += 1
    return {"model": model_calls, "memory": worker_spawns}


def normalize_grants(package, submitted) -> dict:
    """Carry the person's decisions through unchanged, or refuse the run.

    Nothing here upgrades a decision. `deny` stays `deny` and fails the run if
    the package requires that permission; `once` is refused outright when the
    graph would consume it more than once, because honouring it would mean
    denying halfway through a run that has already spent tokens, and the
    alternative — treating it as `session` — would be consent this host was
    never given.
    """
    if not isinstance(submitted, dict):
        raise invalid("grants must be an object of permission id to decision")
    declared = {permission["id"]: permission for permission in package.policy["permissions"]}
    unknown = sorted(set(submitted) - set(declared))
    if unknown:
        raise invalid(f"grants refer to undeclared permissions: {unknown}")
    missing = sorted(set(declared) - set(submitted))
    if missing:
        # The receipt carries a decision for every declared permission, so a
        # gap means the caller assembled grants from somewhere else.
        raise invalid(f"grants omit declared permissions: {missing}")
    counts = _consumption_counts(package)
    grants: dict[str, str] = {}
    for permission_id, decision in sorted(submitted.items()):
        permission = declared[permission_id]
        if decision == ALWAYS:
            raise ExecutionError(
                GRANT_UNSUPPORTED,
                f"Permission {permission_id!r} was granted 'always', which this host has no "
                "store for. A grant that lasts only one run must not be recorded as durable.",
                detail={"permission": permission_id},
            )
        if decision not in SUPPORTED_DECISIONS:
            raise invalid(
                f"Decision for {permission_id!r} must be one of {list(SUPPORTED_DECISIONS)}"
            )
        if decision == DENY and permission["required"]:
            raise ExecutionError(
                PERMISSION_DENIED,
                f"Required permission {permission_id!r} is denied, so this package cannot run.",
                detail={"permission": permission_id, "kind": permission["kind"]},
            )
        if decision == ONCE and counts.get(permission["kind"], 0) > 1:
            raise ExecutionError(
                GRANT_UNSUPPORTED,
                f"Permission {permission_id!r} was granted 'once', but this workflow would "
                f"use it up to {counts[permission['kind']]} times. The run is refused rather "
                "than silently widening the decision to a whole session.",
                detail={
                    "permission": permission_id,
                    "kind": permission["kind"],
                    "maximum_uses": counts[permission["kind"]],
                },
            )
        grants[permission_id] = decision
    return grants


def grant_report(package, grants: dict) -> dict:
    declared = {permission["id"]: permission for permission in package.policy["permissions"]}
    return {
        "decisions": dict(sorted(grants.items())),
        "granted_permission_ids": sorted(pid for pid, d in grants.items() if d != DENY),
        "denied_permission_ids": sorted(pid for pid, d in grants.items() if d == DENY),
        "by_kind": {
            kind: sorted(pid for pid in grants if declared[pid]["kind"] == kind)
            for kind in sorted({permission["kind"] for permission in declared.values()})
        },
        "source": "authorization_receipt",
        "note": "Decisions are passed through unchanged; no decision is widened by this host.",
    }


__all__ = [
    "DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL",
    "DEFAULT_MAX_PARALLEL_WORKERS",
    "DEFAULT_MAX_REMOTE_CALLS",
    "DEFAULT_RUN_TIMEOUT_SECONDS",
    "DEFAULT_TOTAL_TOKENS",
    "SUPPORTED_DECISIONS",
    "HostExecutionLimits",
    "check_capabilities",
    "check_model",
    "effective_budget",
    "effective_deadline_seconds",
    "grant_report",
    "normalize_grants",
]
