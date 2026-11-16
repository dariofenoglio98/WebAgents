"""What a run holds about its links, and the runner that starts an inner run (link.v0 §3, §5).

A host (the developer CLI, the execution session, a campaign driver) resolves the caller's
dependencies, takes the person's decision on each linked publisher, and hands the run one
`LinkHost`: per dependency a `LinkBinding` with the verified package, the decision, and what an
accepted package was granted: its own grants, tool approvals, handlers and limits. The mediator
(`Runtime.call_link`) reserves, starts, settles and records; the inner run is an ordinary run
of the linked package's own program, built here from its binding alone, so nothing of the
caller's authority can reach it.

Nothing here is package-specific, and nothing here decides: a binding is the person's decision,
written down by the host.
"""

from __future__ import annotations

import asyncio
import copy
from dataclasses import dataclass, field

from ..delegation.analysis import activation_bound, network_of
from ..package import Package, canonical_json, sha256
from .analysis import WORST_CASE_FIGURES, link_operations, package_worst_case
from .resolve import LinkRefusal, ResolvedLink, check_composition

LINK_PLAN_SCHEMA = "agentpkg-link-plan-v0"
RUN_LINKS_SCHEMA = "agentpkg-run-links-v0"
ACCEPTED = "accepted"
DENIED = "denied"


def worst_case_figures(worst_case: dict) -> dict:
    return {name: copy.deepcopy(worst_case[name]) for name in WORST_CASE_FIGURES}


def link_plan(caller: Package, link: ResolvedLink, *, grants, approved_tools, parent=None) -> dict:
    """The inner plan a host without a control plane writes for an accepted link (L-14): the
    linked package, its publisher as the person's store saw it, the decisions of its card, and
    the caller it belongs to. A control plane prepares a full Run Plan instead, with the same
    `parent`."""
    return {
        "schema": LINK_PLAN_SCHEMA,
        "parent": parent or {"package_digest": caller.digest, "dependency": link.dependency},
        "package": {
            key: link.facts()[key] for key in ("package_id", "version", "digest", "archive_sha256")
        },
        "publisher": {"signer_fingerprint": link.signer, "trust_status": link.trust},
        "decisions": dict(sorted(grants.items())),
        "tool_approvals": sorted(approved_tools),
        "worst_case": worst_case_figures(link.worst_case),
    }


def plan_hash(plan: dict) -> str:
    return sha256(canonical_json(plan))


@dataclass
class LinkBinding:
    """One linked package in a run: what was resolved, the person's decision on its publisher,
    and, when accepted, exactly what its inner runs hold. `router` None means the caller's model
    route (L-14); a fixture host supplies the linked package's own replay (L-29)."""

    link: ResolvedLink
    decision: str
    grants: dict = field(default_factory=dict)
    approved_tools: tuple = ()
    handlers: dict = field(default_factory=dict)
    router: object | None = None
    limits: dict | None = None
    plan: dict | None = None
    plan_hash: str | None = None

    def record(self) -> dict:
        return {
            "dependency": self.link.dependency,
            **self.link.facts(),
            "decision": self.decision,
            "worst_case": (
                worst_case_figures(self.link.worst_case) if self.link.worst_case else None
            ),
            "plan": copy.deepcopy(self.plan),
            "plan_hash": self.plan_hash,
        }


@dataclass(frozen=True)
class DeniedLink:
    """A link the person denied, as an execution host knows it from the caller's plan alone:
    no archive reaches a runner for it, so there is no package and no worst case."""

    dependency: str
    entry: dict
    worst_case: None = None

    @property
    def signer(self) -> str:
        return self.entry["signer"]

    def facts(self) -> dict:
        keys = ("package_id", "version", "digest", "archive_sha256", "signer", "trust")
        return {key: self.entry.get(key) for key in keys}


class InnerRun:
    """One inner run (L-25): the linked package's own program under its binding, with the token
    and remote-call limits the caller reserved for it. Built before it is recorded as started,
    so that the record names its run id."""

    def __init__(self, binding: LinkBinding, *, router, limits: dict, deadline_seconds):
        from ..workflow import Workflow

        self.binding = binding
        self.workflow = Workflow(
            binding.link.package,
            grants=dict(binding.grants),
            handlers=dict(binding.handlers),
            router=binding.router if binding.router is not None else router,
            limits={**(binding.limits or {}), **limits},
            approved_tools=list(binding.approved_tools),
            deadline_seconds=deadline_seconds,
        )
        self.run_id = self.workflow.runtime.run_id
        self.report = None

    async def run(self, input_value) -> dict:
        """The inner run's report, completed or failed; a cancellation passes through with its
        report kept here."""
        try:
            self.report = await self.workflow.run(copy.deepcopy(input_value))
        except asyncio.CancelledError as exc:
            self.report = getattr(exc, "execution_report", None)
            raise
        except Exception as exc:  # noqa: BLE001 - a classified failure carries its report
            self.report = getattr(exc, "execution_report", None)
            if self.report is None:
                raise
        return self.report

    def usage(self) -> dict:
        """What the inner run spent, from its own mediator: the figures the caller settles."""
        runtime = self.workflow.runtime
        usage = runtime.usage
        return {
            "tokens": usage["tokens"],
            "remote_calls": usage["remote_calls"],
            "model_calls": sum(1 for event in runtime.audit if event["action"] == "model.called"),
            "tool_calls": dict(usage["tool_calls"]),
            "compute_calls": usage.get("compute_calls", 0),
        }


class LinkHost:
    """The links of one run: a binding per dependency, the denials, the composed costs, the
    inner runs made. A host builds it after resolution and the person's decisions; it refuses
    an undecided dependency (L-17) and a composition the caller's budget cannot hold (L-20)."""

    def __init__(self, caller: Package, bindings: dict, *, consent=None):
        declared = [record["id"] for record in caller.manifest["dependencies"]]
        missing = [name for name in declared if name not in bindings]
        if missing:
            raise LinkRefusal(
                "link_undecided",
                f"dependency {missing[0]!r} has no decision; every linked publisher is decided "
                "before the run",
            )
        self.caller = caller
        self.bindings = dict(bindings)
        # A denial is of the publisher's key for the run (L-13): every dependency it signed.
        self.denied_keys = {b.link.signer for b in self.bindings.values() if b.decision != ACCEPTED}
        for binding in self.bindings.values():
            if binding.link.signer in self.denied_keys:
                binding.decision = DENIED
            elif binding.plan is None:
                binding.plan = link_plan(
                    caller,
                    binding.link,
                    grants=binding.grants,
                    approved_tools=binding.approved_tools,
                )
            if binding.decision == ACCEPTED and binding.plan_hash is None:
                binding.plan_hash = plan_hash(binding.plan)
        check_composition(caller, self.worst_cases)
        self.consent = consent
        self.runs: list[dict] = []
        self.reports: dict[str, dict] = {}

    @property
    def worst_cases(self) -> dict:
        """`delegation.analysis.link_cost`'s map: each dependency's worst case, None when denied."""
        return {
            name: binding.link.worst_case if binding.decision == ACCEPTED else None
            for name, binding in self.bindings.items()
        }

    def binding(self, dependency: str) -> LinkBinding:
        return self.bindings[dependency]

    def reservation(self, binding: LinkBinding) -> dict:
        """L-24: the linked package's worst case under the effective limits, its own caps as the
        host lowered them, in the two figures a run reserves."""
        package = binding.link.package
        caps = dict(package.policy["budget"])
        for key in ("hard_tokens", "max_remote_calls"):
            if binding.limits and key in binding.limits:
                caps[key] = min(caps[key], binding.limits[key])
        effective = package_worst_case(package.graph, package.policy, budget=caps)
        return {"tokens": effective["tokens"], "remote_calls": effective["remote_calls"]}

    def start(self, binding: LinkBinding, *, router, limits: dict, deadline_seconds) -> InnerRun:
        return InnerRun(
            binding,
            router=router,
            limits={"hard_tokens": limits["tokens"], "max_remote_calls": limits["remote_calls"]},
            deadline_seconds=deadline_seconds,
        )

    def finished(self, inner: InnerRun, *, name: str, node_id: str, status: str, error_code):
        """Keep an inner run's record beside the caller's (L-30)."""
        self.runs.append(
            {
                "inner_run_id": inner.run_id,
                "dependency": name,
                "node_id": node_id,
                "status": status,
                "error_code": error_code,
            }
        )
        if inner.report is not None:
            self.reports[inner.run_id] = inner.report

    def record(self) -> dict:
        """The run record's `links` (L-30): each link with its publisher, decision and inner
        plan, and the inner runs made."""
        return {
            "schema": RUN_LINKS_SCHEMA,
            "links": [self.bindings[name].record() for name in sorted(self.bindings)],
            "runs": copy.deepcopy(self.runs),
        }


def link_multiplicity(graph, dependency: str) -> int:
    """How often a run can reach a dependency at most: a node once, a map step per item, a role
    step per activation of its role (R-20)."""
    network = network_of(graph)
    total = 0
    nodes = {node["id"]: node for node in graph.get("nodes", [])}
    for label, step, where, role_id in link_operations(graph):
        if step.get("dependency") != dependency:
            continue
        if where == "node":
            total += 1
        elif where == "map":
            total += nodes[label.split("/")[0]]["max_items"]
        else:
            total += activation_bound(network, role_id)
    return total


def check_once(caller: Package, bindings: dict) -> None:
    """L-28 (network.v0 R-26 across a link): a `once` grant on a linked package's card is
    refused where the composition could consume that permission more than once."""
    from ..execution.errors import GRANT_UNSUPPORTED, ExecutionError
    from ..execution.policy import _consumption_counts

    for name, binding in bindings.items():
        if binding.decision != ACCEPTED:
            continue
        package = binding.link.package
        kinds = {p["id"]: p["kind"] for p in package.policy["permissions"]}
        counts = _consumption_counts(package)
        reached = link_multiplicity(caller.graph, name)
        for permission, scope in binding.grants.items():
            if scope == "once" and reached * counts.get(kinds.get(permission), 0) > 1:
                raise ExecutionError(
                    GRANT_UNSUPPORTED,
                    f"Permission {permission!r} of linked package {name!r} was granted 'once', "
                    "and the composition could consume it more than once.",
                    detail={"permission": permission, "dependency": name},
                )


__all__ = [
    "ACCEPTED",
    "DENIED",
    "DeniedLink",
    "InnerRun",
    "LINK_PLAN_SCHEMA",
    "LinkBinding",
    "LinkHost",
    "RUN_LINKS_SCHEMA",
    "check_once",
    "link_multiplicity",
    "link_plan",
    "plan_hash",
    "worst_case_figures",
]
