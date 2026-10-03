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
from ..package import canonical_json, sha256
from .errors import (
    EXPORT_PATH_RESERVED,
    GRANT_UNSUPPORTED,
    MODEL_INCOMPATIBLE,
    OUTPUT_CAP_TOO_LARGE,
    PERMISSION_DENIED,
    TOOL_CONTRACT_MISMATCH,
    TOOL_NOT_APPROVED,
    TOOL_NOT_BOUND,
    TOOL_NOT_DECLARED,
    TOOL_PERMISSION_DENIED,
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
DEFAULT_MAX_CALLS_PER_TOOL = 32
# How long one model completion may take, queueing at the model server
# included. A local server that decodes one request at a time answers the third
# of three concurrent workers only after the other two, so an operator running
# one raises this; the package's own node timeouts still bound every call.
DEFAULT_MODEL_CALL_TIMEOUT_SECONDS = 300

MAX_TOTAL_TOKENS = 10_000_000
MAX_REMOTE_CALLS = 10_000
MAX_PARALLEL_WORKERS = 64
MAX_OUTPUT_TOKENS_PER_CALL = 200_000
MAX_RUN_TIMEOUT_SECONDS = 86_400
MAX_CALLS_PER_TOOL = 10_000
MAX_MODEL_CALL_TIMEOUT_SECONDS = 3_600


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
    max_calls_per_tool: int = DEFAULT_MAX_CALLS_PER_TOOL
    model_call_timeout_seconds: int = DEFAULT_MODEL_CALL_TIMEOUT_SECONDS

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
            "max_calls_per_tool",
            "model_call_timeout_seconds",
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
            max_calls_per_tool=_bounded(
                raw.get("max_calls_per_tool"),
                "max_calls_per_tool",
                default=DEFAULT_MAX_CALLS_PER_TOOL,
                maximum=MAX_CALLS_PER_TOOL,
            ),
            model_call_timeout_seconds=_bounded(
                raw.get("model_call_timeout_seconds"),
                "model_call_timeout_seconds",
                default=DEFAULT_MODEL_CALL_TIMEOUT_SECONDS,
                maximum=MAX_MODEL_CALL_TIMEOUT_SECONDS,
            ),
        )

    def runtime_limits(self) -> dict:
        """Exactly the keys `Runtime` accepts; it applies min() to each one."""
        return {
            "hard_tokens": self.total_tokens,
            "max_remote_calls": self.max_remote_calls,
            "max_parallel_workers": self.max_parallel_workers,
            "max_calls_per_tool": self.max_calls_per_tool,
        }

    def as_json(self) -> dict:
        return {
            "total_tokens": self.total_tokens,
            "max_remote_calls": self.max_remote_calls,
            "max_parallel_workers": self.max_parallel_workers,
            "max_output_tokens_per_call": self.max_output_tokens_per_call,
            "run_timeout_seconds": self.run_timeout_seconds,
            "max_calls_per_tool": self.max_calls_per_tool,
            "model_call_timeout_seconds": self.model_call_timeout_seconds,
        }


def effective_budget(package, limits: HostExecutionLimits) -> dict:
    """What the package declared, what the host allowed, and the min of both."""
    declared = package.policy["budget"]
    host = limits.runtime_limits()
    scalar = [key for key in host if key != "max_calls_per_tool"]
    return {
        "declared": {
            "hard_tokens": declared["hard_tokens"],
            "max_remote_calls": declared["max_remote_calls"],
            "max_parallel_workers": declared["max_parallel_workers"],
            "estimated_tokens": declared["estimated_tokens"],
            "approval_threshold_tokens": declared.get("approval_threshold_tokens"),
            "max_calls_per_tool": dict(declared["max_calls_per_tool"]),
        },
        "host": host,
        "effective": {
            **{key: min(host[key], declared[key]) for key in scalar},
            # One host ceiling, applied to every declared tool's own cap.
            "max_calls_per_tool": {
                tool_id: min(host["max_calls_per_tool"], cap)
                for tool_id, cap in declared["max_calls_per_tool"].items()
            },
        },
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


def check_capabilities(package, limits: HostExecutionLimits, *, tool_bindings=()) -> dict:
    """Refuse a package this execution host cannot run, before anything starts.

    These are limits of the host, not of the package format. A package that
    declares a tool the host has no binding for is a valid package; it simply
    cannot run *here*, and pretending otherwise would mean either failing
    halfway through a run or executing an unmediated call.

    `tool_bindings` are the bindings the run plan froze. Their *contents* are
    checked separately by `check_tools`, which compares each one against the
    signed declaration; this function only asks whether every declared tool and
    every `tool` operation in the graph has one at all.
    """
    graph = package.graph
    declared_tools = [tool["id"] for tool in package.manifest["tools"]]
    tool_nodes = [name for name, op in _operations(graph) if op["type"] == "tool"]
    bound = {binding["tool_id"] for binding in tool_bindings}
    if (declared_tools or tool_nodes) and not bound:
        raise ExecutionError(
            TOOLS_NOT_SUPPORTED,
            "This package declares tools and this run plan binds no host implementation for "
            "any of them, so nothing could mediate a call. This is a limit of the host, not "
            "of the package format.",
            detail={"declared_tools": declared_tools[:32], "tool_nodes": tool_nodes[:32]},
        )
    missing = sorted(set(declared_tools) - bound)
    if missing:
        raise ExecutionError(
            TOOL_NOT_BOUND,
            "Every tool a package declares needs a host implementation before any of its "
            "graph may run; a run that discovered an unbound tool halfway through would "
            "already have spent whatever came before it.",
            detail={"unbound_tools": missing[:32]},
        )
    used = sorted({op["tool"] for _, op in _operations(graph) if op["type"] == "tool"})
    undeclared = sorted(set(used) - set(declared_tools))
    if undeclared:
        raise ExecutionError(
            TOOL_NOT_DECLARED,
            "The graph calls a tool this package never declared.",
            detail={"tools": undeclared[:32]},
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
        "tools_declared": len(declared_tools),
        "tool_nodes": len(tool_nodes),
        "tool_bindings": len(bound),
        "llm_operations": caps,
        "max_requested_output_tokens": max((c["max_output_tokens"] for c in caps), default=0),
        "host_max_output_tokens_per_call": limits.max_output_tokens_per_call,
    }


def check_tools(package, bindings, grants: dict, approvals: dict) -> dict:
    """Re-derive every tool fact from the signed package, then compare.

    The control plane already decided all of this, and this checks it again
    from scratch, because a runner that trusts a plan's own summary of a
    package is trusting the wrong artifact. Everything on the left of each
    comparison is read out of the verified package here and now; everything on
    the right arrived in the plan.

    Nothing here knows what any tool is *for*. The comparisons are over
    declared structure: identity, the binding name, execution locality, schema
    digests, the permission class, and — for a remote binding — that the origin
    the host will contact is one the package itself declared, the linked
    network permission names, and the package's network policy allows.
    """
    permissions = {item["id"]: item for item in package.policy["permissions"]}
    declared = package.tools
    checked = []
    for binding in bindings:
        tool_id = binding["tool_id"]
        tool = declared.get(tool_id)
        if tool is None:
            raise ExecutionError(
                TOOL_NOT_DECLARED,
                f"The run plan binds {tool_id!r}, which this package does not declare.",
                detail={"tool_id": tool_id},
            )
        linked = [pid for pid in tool["permissions"] if pid in permissions]
        facts = {
            "binding_name": (tool["binding"], binding["binding_name"]),
            "remote": (tool["execution"] == "remote", binding["remote"]),
            "input_schema_sha256": (
                sha256(canonical_json(package.json(tool["input_schema"]))),
                binding["input_schema_sha256"],
            ),
            "output_schema_sha256": (
                sha256(canonical_json(package.json(tool["output_schema"]))),
                binding["output_schema_sha256"],
            ),
            "required_permission_ids": (sorted(linked), sorted(binding["required_permission_ids"])),
        }
        for name, (expected, actual) in facts.items():
            if expected != actual:
                raise ExecutionError(
                    TOOL_CONTRACT_MISMATCH,
                    f"The bound implementation of {tool_id!r} does not match the package's own "
                    f"declaration of {name}.",
                    detail={"tool_id": tool_id, "field": name},
                )
        if tool["execution"] == "remote":
            origin = binding["endpoint_origin"] or ""
            host_name = origin.split("://", 1)[-1] if "://" in origin else ""
            permitted = (
                set(tool["domains"])
                & set(package.policy["network"]["allowed_domains"])
                & {
                    resource
                    for pid in linked
                    if permissions[pid]["kind"] == "network"
                    for resource in permissions[pid]["resources"]
                }
            )
            if not origin.startswith("https://") or host_name not in permitted:
                raise ExecutionError(
                    TOOL_CONTRACT_MISMATCH,
                    f"The bound implementation of {tool_id!r} would contact a destination this "
                    "package does not declare.",
                    detail={"tool_id": tool_id, "permitted": sorted(permitted)},
                )
        if approvals.get(tool_id) is not True:
            raise ExecutionError(
                TOOL_NOT_APPROVED,
                f"Tool {tool_id!r} is bound but was not explicitly approved. A granted "
                "permission is not an approval of an implementation.",
                detail={"tool_id": tool_id},
            )
        if not linked:
            raise ExecutionError(
                TOOL_PERMISSION_DENIED,
                f"Tool {tool_id!r} links to no declared permission, so no authority could be "
                "checked before it ran.",
                detail={"tool_id": tool_id},
            )
        denied = sorted(pid for pid in linked if grants.get(pid, DENY) == DENY)
        required_denied = sorted(pid for pid in denied if permissions[pid]["required"])
        if required_denied:
            # A denied *optional* permission is an operating profile the package
            # declared it supports; its graph is responsible for not reaching
            # the tool, and `Runtime.call_tool` refuses the call if it does.
            raise ExecutionError(
                TOOL_PERMISSION_DENIED,
                f"Tool {tool_id!r} needs {required_denied}, which are denied.",
                detail={"tool_id": tool_id, "permissions": required_denied},
            )
        checked.append(
            {
                "tool_id": tool_id,
                "binding_id": binding["binding_id"],
                "binding_sha256": binding["binding_sha256"],
                "implementation_kind": binding["implementation_kind"],
                "implementation_version": binding["implementation_version"],
                "remote": binding["remote"],
                "endpoint_origin": binding["endpoint_origin"],
                "method": binding["method"],
                "required_permission_ids": sorted(linked),
                "denied_permission_ids": denied,
                "usable": not denied,
                "approved": True,
                "timeout_seconds": min(
                    tool["timeout_seconds"], binding["timeout_seconds"] or tool["timeout_seconds"]
                ),
                "max_calls": package.policy["budget"]["max_calls_per_tool"].get(tool_id, 0),
                "credentials_required": binding["credentials_required"],
                "credentials_configured": binding["credentials_configured"],
                "verified": sorted(facts),
            }
        )
    return {
        "declared": sorted(declared),
        "bound": [record["tool_id"] for record in checked],
        "bindings": checked,
        "note": (
            "Every field was re-derived from the verified package in this process and then "
            "compared with the plan, so a plan that described the package incorrectly is "
            "refused rather than believed."
        ),
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
            f"The selected model's router does not deliver {missing}, which this package requires.",
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
    permissions = {item["id"]: item for item in package.policy["permissions"]}
    counts = {"model": 0, "memory": 0}

    def tool_use(tool_id: str, times: int) -> None:
        tool = package.tools.get(tool_id)
        if tool is None:
            return
        # A tool consumes every permission it links to, once per call, so the
        # kinds those permissions belong to are consumed the same number of
        # times. Capping at the package's own per-tool budget keeps the bound
        # from exceeding what could actually be dispatched.
        allowed = package.policy["budget"]["max_calls_per_tool"].get(tool_id, 0)
        for pid in tool["permissions"]:
            kind = permissions.get(pid, {}).get("kind")
            if kind:
                counts[kind] = counts.get(kind, 0) + min(times, allowed)

    for node in graph["nodes"]:
        if node["type"] == "llm":
            counts["model"] += 1
        if node["type"] == "tool":
            tool_use(node["tool"], 1)
        if node["type"] == "map":
            # A map instantiates one worker per item; an empty input spawns
            # none, so its own minimum is one for counting purposes.
            children = max(1, node["max_items"])
            counts["memory"] += children
            for step in node["steps"]:
                if step["type"] == "llm":
                    counts["model"] += children
                if step["type"] == "tool":
                    tool_use(step["tool"], children)
        elif node["worker"] != coordinator:
            counts["memory"] += 1
    return counts


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


# Permission kinds whose scope names a type of host-owned resource. Mirrors
# `agentpkg.browser.hostresources.RESOURCE_PERMISSION_KINDS`; the runner does
# not import the control plane.
RESOURCE_PERMISSION_KINDS = ("personal.read",)
MAX_RESOURCE_GRANTS = 32
_GRANT_FIELDS = ("permission_id", "resource_type", "resource_id", "resource_digest")


def normalize_resource_grants(raw) -> list[dict]:
    """The host resources a plan granted, as a closed, bounded list of references.

    Opaque id, type and digest per resource-bearing permission, and nothing
    else: a runner compares these with what the host attributes an answer to;
    it never receives a value from here.
    """
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_RESOURCE_GRANTS:
        raise invalid(f"resource_grants must be a list of at most {MAX_RESOURCE_GRANTS}")
    grants = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or set(item) != set(_GRANT_FIELDS):
            raise invalid(f"resource_grants[{index}] must carry exactly {list(_GRANT_FIELDS)}")
        for name in _GRANT_FIELDS:
            value = item[name]
            if not isinstance(value, str) or not value or len(value) > 128:
                raise invalid(f"resource_grants[{index}].{name} must be a short string")
        grants.append({name: item[name] for name in _GRANT_FIELDS})
    permissions = [grant["permission_id"] for grant in grants]
    if len(set(permissions)) != len(permissions):
        raise invalid("resource_grants names one permission twice")
    return sorted(grants, key=lambda grant: grant["permission_id"])


def check_resource_grants(package, resource_grants: list[dict], grants: dict) -> dict:
    """Re-derive from the signed package that every frozen grant is one it could hold.

    The control plane validated these against the registry; this checks them
    again against the package itself: the permission is declared, it is a
    resource kind, its own scope names exactly the granted type, and the
    person did not deny it. A plan that says otherwise is refused, not
    believed.
    """
    declared = {permission["id"]: permission for permission in package.policy["permissions"]}
    checked = []
    for grant in resource_grants:
        permission = declared.get(grant["permission_id"])
        if (
            permission is None
            or permission["kind"] not in RESOURCE_PERMISSION_KINDS
            or grant["resource_type"] not in permission["resources"]
        ):
            raise invalid(
                "The run plan grants a host resource under a permission this package does not "
                "declare for that resource type",
                permission=grant["permission_id"],
            )
        if grants.get(grant["permission_id"], DENY) == DENY:
            raise ExecutionError(
                PERMISSION_DENIED,
                f"The run plan grants a host resource under {grant['permission_id']!r}, which "
                "is denied.",
                detail={"permission": grant["permission_id"]},
            )
        checked.append({**grant, "decision": grants[grant["permission_id"]]})
    return {
        "grants": checked,
        "note": (
            "Each grant names one host resource by opaque id and digest. The host resolves "
            "it only for the tool calls that link its permission; the runner never sees a "
            "value until a tool returns one, and checks that the host attributes the answer "
            "to exactly this grant."
        ),
    }


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
    "DEFAULT_MAX_CALLS_PER_TOOL",
    "DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL",
    "DEFAULT_MAX_PARALLEL_WORKERS",
    "DEFAULT_MAX_REMOTE_CALLS",
    "DEFAULT_RUN_TIMEOUT_SECONDS",
    "DEFAULT_TOTAL_TOKENS",
    "SUPPORTED_DECISIONS",
    "HostExecutionLimits",
    "check_capabilities",
    "check_resource_grants",
    "check_model",
    "check_tools",
    "effective_budget",
    "effective_deadline_seconds",
    "grant_report",
    "normalize_grants",
    "normalize_resource_grants",
]
