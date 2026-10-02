"""Templates, variants and the shared building blocks of every case.

A **template** is one kind of violation of one assumption, with its matched
benign control. It declares — before any run — the violated assumption, the
production component expected to catch it, the lifecycle stage, the refusal it
expects, the forbidden boundary and the control construction. It never
declares a result.

A **variant** is one concrete, structurally distinct instance of a template for
one package: plain JSON parameters, generated deterministically from the seed.
`Template.plan(variant, kind, env)` turns a variant into an executable
`CasePlan` plus the boundary predicate the oracle evaluates.
"""

from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
import random
from dataclasses import dataclass, field
from pathlib import Path

from harness import artifacts
from harness.paths import PACKAGES, ROOT
from harness.plan import CasePlan, Faults, Pin
from harness.world import HostSpec, experiment_key

FAMILIES = {
    "F1": "Package verification",
    "F2": "Publisher trust",
    "F3": "Authorization",
    "F4": "Requirements / compatibility",
    "F5": "Plan binding / TOCTOU revalidation",
    "F6": "Host mediation / capability confinement",
    "F7": "Output / state integrity",
    "F8": "Resource governance",
}
PUBLISHER_ID = "webagents-research"
PUBLISHER_NAME = "WebAgents Research Prototype"


@dataclass(frozen=True)
class Variant:
    template_id: str
    package: str
    variant_id: str
    params: dict
    description: str
    control_key: str
    control_params: dict
    control_description: str

    @property
    def case_id(self) -> str:
        return f"{self.template_id}/{self.package}/{self.variant_id}"

    @property
    def control_id(self) -> str:
        return f"{self.template_id}/{self.package}/control/{self.control_key}"


@dataclass
class Env:
    """What a plan builder needs: the seed, the shipped bytes, the host's bindings."""

    seed: int
    built_in_bindings: list[dict] | None = None
    _archives: dict = field(default_factory=dict)
    # The directory one case runs in (set by the worker just before planning):
    # attack strings that name a canary name the case's own canary file.
    case_dir: Path | None = None
    # The benign run's answers (`cases/calibration.py`), for templates that
    # corrupt one answer; None when only calibration-free templates are used.
    calibration: dict | None = None

    def at(self, case_dir) -> Env:
        """This environment for one case directory (shares the archive cache)."""
        return dataclasses.replace(self, case_dir=Path(case_dir))

    def calibrated(self, package: str) -> dict:
        if self.calibration is None:
            raise RuntimeError("this template needs the calibration run (cases/calibration.py)")
        return self.calibration["packages"][package]

    def canary(self) -> str:
        """The case's canary document (created by the pipeline; never readable)."""
        if self.case_dir is None:
            return "/nonexistent/contract-enforcement-canary/secret.pdf"
        return str(self.case_dir / "canary" / "secret.pdf")

    def archive(self, package: str) -> bytes:
        if package not in self._archives:
            self._archives[package] = Path(PACKAGES[package]["archive"]).read_bytes()
        return self._archives[package]

    def historical(self, name: str) -> bytes:
        return (ROOT / "dist" / name).read_bytes()

    def key(self, label: str):
        return experiment_key(self.seed, label)

    def publisher_pem(self, package: str) -> bytes:
        return Path(PACKAGES[package]["publisher_key"]).read_bytes()


@dataclass(frozen=True)
class Template:
    template_id: str
    family: str
    title: str
    description: str
    violated_assumption: str
    component: str
    expected_stage: str
    expected_codes: tuple[str, ...]
    boundary: str
    control: str
    kind: str  # finite | parametric
    packages: tuple[str, ...]
    ablation: str
    primary_guard: str
    perturbation: str
    requires_fault: bool = False
    # False when the primary guard is one no profile removes (container parsing,
    # static workflow validation, JSON parsing): the most relevant ablation then
    # removes only a backstop, and an explicit block under it is expected.
    ablation_removes_guard: bool = True

    def catalog_row(self) -> dict:
        return {
            "template_id": self.template_id,
            "family": self.family,
            "family_name": FAMILIES[self.family],
            "title": self.title,
            "description": self.description,
            "violated_assumption": self.violated_assumption,
            "expected_component": self.component,
            "expected_stage": self.expected_stage,
            "expected_codes": list(self.expected_codes),
            "forbidden_boundary": self.boundary,
            "matched_control": self.control,
            "template_kind": self.kind,
            "packages": list(self.packages),
            "most_relevant_ablation": self.ablation,
            "primary_guard": self.primary_guard,
            "perturbation": self.perturbation,
            "ablation_removes_guard": self.ablation_removes_guard,
        }

    # Subclasses implement these two.
    def variants(self, package: str, env: Env, rng: random.Random, budget: int) -> list[Variant]:
        raise NotImplementedError

    def plan(self, variant: Variant, kind: str, env: Env):
        """-> (CasePlan, boundary(obs) -> bool)"""
        raise NotImplementedError

    def variant(
        self,
        package,
        variant_id,
        params,
        description,
        control_params=None,
        control_description=None,
    ):
        control_params = dict(control_params if control_params is not None else {})
        key = "c-" + stable_hash(control_params)[:12] if control_params else "baseline"
        return Variant(
            self.template_id,
            package,
            variant_id,
            params,
            description,
            key,
            control_params,
            control_description or self.control,
        )


def stable_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def rng_for(seed: int, template_id: str, package: str) -> random.Random:
    return random.Random(f"{seed}\x00{template_id}\x00{package}")


# -- standard pins and plans -------------------------------------------------------------
def publisher_pin(env: Env, package: str) -> Pin:
    """The shipped publisher key, pinned at package scope (the page's narrow Trust action)."""
    return Pin(
        env.publisher_pem(package), PUBLISHER_NAME, PUBLISHER_ID, PACKAGES[package]["package_id"]
    )


def key_pin(key, package: str, *, publisher_id=PUBLISHER_ID, prefix="package") -> Pin:
    pkg_prefix = PACKAGES[package]["package_id"] if prefix == "package" else prefix
    return Pin(artifacts.public_pem(key), "Experiment publisher", publisher_id, pkg_prefix)


def trusted_key(env: Env):
    return env.key("trusted-publisher")


def base_plan(env: Env, package: str, **overrides) -> CasePlan:
    """The shipped artifact, its publisher pinned, the recorded host and decisions."""
    plan = CasePlan(
        package=package, archive=env.archive(package), pins=[publisher_pin(env, package)]
    )
    for name, value in overrides.items():
        setattr(plan, name, value)
    return plan


def resigned_plan(
    env: Env,
    package: str,
    files: dict[str, bytes] | None = None,
    *,
    normalize: bool = True,
    **overrides,
) -> CasePlan:
    """A payload (edited or not) rebuilt and signed by the trusted experiment key, which is pinned.

    `normalize=False` keeps member bytes exactly as given (a document that is
    deliberately not valid JSON cannot be canonicalized first).
    """
    payload = files if files is not None else artifacts.payload_of(env.archive(package))
    key = trusted_key(env)
    plan = CasePlan(
        package=package,
        archive=artifacts.build(payload, key, normalize=normalize),
        pins=[publisher_pin(env, package), key_pin(key, package)],
    )
    for name, value in overrides.items():
        setattr(plan, name, value)
    return plan


def payload(env: Env, package: str) -> dict[str, bytes]:
    return artifacts.payload_of(env.archive(package))


def edit_json(files: dict[str, bytes], name: str, edit) -> dict[str, bytes]:
    files = dict(files)
    document = json.loads(files[name])
    edit(document)
    files[name] = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
    return files


def graph_node(graph: dict, node_id: str) -> dict:
    for node in graph["nodes"]:
        if node["id"] == node_id:
            return node
    raise KeyError(node_id)


def map_step(graph: dict, node_id: str, step_id: str) -> dict:
    for step in graph_node(graph, node_id)["steps"]:
        if step["id"] == step_id:
            return step
    raise KeyError(f"{node_id}/{step_id}")


def host(**overrides) -> HostSpec:
    spec = HostSpec()
    for name, value in overrides.items():
        setattr(spec, name, value)
    return spec


def taint(*parts) -> str:
    """A unique marker for injected content, so its presence in state is observable."""
    return "TAINT-" + stable_hash(list(parts))[:16]


def clone(value):
    return copy.deepcopy(value)


__all__ = [
    "FAMILIES",
    "Env",
    "Faults",
    "Template",
    "Variant",
    "base_plan",
    "clone",
    "edit_json",
    "graph_node",
    "host",
    "key_pin",
    "map_step",
    "payload",
    "publisher_pin",
    "resigned_plan",
    "rng_for",
    "stable_hash",
    "taint",
    "trusted_key",
]
