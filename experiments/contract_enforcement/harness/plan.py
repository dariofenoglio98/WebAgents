"""What one case does, in executable form, and the faults it injects.

A case template (in `cases/`) turns a catalog variant into a `CasePlan`. The
pipeline executes the plan through the real production path; the oracle then
judges the observation with the plan's own boundary predicate.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .world import APPROVALS, DECISIONS, PLANNED_MODEL, HostSpec


@dataclass
class Pin:
    """One operator trust pin installed before the case opens anything."""

    public_pem: bytes
    display_name: str
    publisher_id: str | None
    package_id_prefix: str | None


Hook = Callable[[Any], Awaitable[None]]


@dataclass
class Faults:
    """Deterministic fault rules for the model, tools, DNS and PDF parser.

    Each rule matches calls and returns an action; `once` rules fire on their
    first match only. Rules are data plus small pure functions, so a variant's
    fault is fully described by its catalog parameters.
    """

    model: list[dict] = field(default_factory=list)
    tools: list[dict] = field(default_factory=list)
    dns: dict[str, list[str]] = field(default_factory=dict)
    pdf: Callable[[dict], dict] | None = None
    fired: list[dict] = field(default_factory=list)

    def model_action(self, task: str, data, index: int) -> dict | None:
        for rule in self.model:
            if rule.get("_spent"):
                continue
            if rule.get("task") not in (None, task):
                continue
            match = rule.get("match")
            if match is not None and not match(data):
                continue
            nth = rule.get("nth")
            if nth is not None:
                rule["_seen"] = rule.get("_seen", 0) + 1
                if rule["_seen"] != nth:
                    continue
            if rule.get("once", True):
                rule["_spent"] = True
            self.fired.append(
                {"where": "model", "task": task, "index": index, "kind": rule["action"]["kind"]}
            )
            return rule["action"]
        return None

    def tool_delay(self, tool, request) -> float:
        """Seconds the service waits before answering this call (deadline cases)."""
        for rule in self.tools:
            if rule.get("_delayed") or rule.get("tool") != tool or "delay" not in rule:
                continue
            match = rule.get("match")
            if match is not None and not match(request):
                continue
            if rule.get("once", True):
                rule["_delayed"] = True
            self.fired.append({"where": "tool_delay", "tool": tool})
            return float(rule["delay"])
        return 0.0

    def tool_answer(self, tool, request, status, content_type, answer):
        for rule in self.tools:
            if rule.get("_spent") or rule.get("tool") != tool or "apply" not in rule:
                continue
            match = rule.get("match")
            if match is not None and not match(request):
                continue
            if rule.get("once", True):
                rule["_spent"] = True
            self.fired.append({"where": "tool", "tool": tool})
            return rule["apply"](status, content_type, answer)
        return status, content_type, answer

    def dns_answer(self, hostname, addresses):
        if hostname in self.dns:
            self.fired.append({"where": "dns", "hostname": hostname})
            return list(self.dns[hostname])
        return addresses

    def pdf_answer(self, answer):
        if self.pdf is not None:
            self.fired.append({"where": "pdf"})
            return self.pdf(answer)
        return answer


@dataclass
class CasePlan:
    package: str
    archive: bytes
    pins: list[Pin] = field(default_factory=list)
    pin_session_signer: str | None = None  # "package" | "publisher": the page's Trust action
    host: HostSpec = field(default_factory=HostSpec)
    decisions: dict | None = None
    approvals: dict | None = None
    model_id: str = PLANNED_MODEL
    input: dict | None = None
    input_patch: Callable[[dict, Any], dict] | None = None
    attach_pdf: bool | None = None  # default: Literature Review attaches the synthetic PDF
    hooks: dict[str, list[Hook]] = field(default_factory=dict)
    faults: Faults = field(default_factory=Faults)
    start_override: Callable[[dict, Any], dict] | None = None
    # Extra sensitive paths this case's attack strings name (canaries).
    sensitive: list[str] = field(default_factory=list)
    # A wall-clock bound for the whole case, for deadline cases.
    timeout_seconds: float = 600.0
    # Calibration only: the provider keeps each well-behaved answer.
    record_answers: bool = False

    def __post_init__(self):
        if self.decisions is None:
            self.decisions = dict(DECISIONS[self.package])
        if self.approvals is None:
            self.approvals = dict(APPROVALS[self.package])
        if self.attach_pdf is None:
            self.attach_pdf = self.package == "literature-review"

    def hook(self, point: str, fn: Hook) -> CasePlan:
        self.hooks.setdefault(point, []).append(fn)
        return self
