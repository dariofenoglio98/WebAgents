"""What a catalog v2 case is (D-300).

A case is one way of violating one guarantee of one family (M, C, V, N), or the matched control
that runs the same probe without the violation. It declares before anything runs: the probe and
the change (`source`, `extra`, `tamper`), how a host runs it (`mode`, grants, approvals, limits,
transcript, consent host, engine), what the full system is expected to do in each runtime
(`expected`), the forbidden boundary the oracle evaluates (`boundary`, class `effect` or
`admission`), the primary guard, the profile that removes it (`primary_ablation`) and whether that
profile removes it at all (`ablation_removes_guard`: false for container rules, which every profile
keeps), and the matched control. `property` is T28's property id, filled when T28 lands.

Cases are plain data; `to_json` is what the catalog records, and its hash is the catalog hash.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field

FAMILIES = {
    "M": "Memory confinement",
    "C": "Compute isolation",
    "V": "Consent integrity",
    "N": "Delegation bounds",
}
KINDS = ("violation", "control")
BOUNDARY_CLASSES = ("effect", "admission")
MODES = ("run", "converse", "execution_layer")


@dataclass(frozen=True)
class Case:
    id: str
    family: str
    kind: str
    title: str
    source: dict
    mode: str
    grants: dict
    approve: tuple[str, ...]
    expected: dict
    boundary: dict
    guard: str
    primary_ablation: str | None
    ablation_removes_guard: bool = True
    matched_control: str | None = None
    limits: dict | None = None
    transcript: dict | None = None
    consent_host: str | None = None
    engine: bool = True
    taints: tuple[str, ...] = ()
    tamper: str | None = None
    extra: Callable | None = field(default=None, compare=False)
    extra_name: str | None = None
    parametric: dict | None = None
    origin: str = ""
    property: str | None = None

    def __post_init__(self):
        if self.family not in FAMILIES:
            raise ValueError(f"{self.id}: unknown family {self.family!r}")
        if self.kind not in KINDS:
            raise ValueError(f"{self.id}: unknown kind {self.kind!r}")
        if self.mode not in MODES:
            raise ValueError(f"{self.id}: unknown mode {self.mode!r}")
        if self.kind == "violation":
            if self.boundary.get("class") not in BOUNDARY_CLASSES:
                raise ValueError(f"{self.id}: a violation names its boundary class")
            if not self.boundary.get("predicate"):
                raise ValueError(f"{self.id}: a violation names its boundary predicate")
        if (self.extra is None) != (self.extra_name is None):
            raise ValueError(f"{self.id}: an extra change is named")
        if not self.id.startswith(f"{self.family}."):
            raise ValueError(f"{self.id}: ids start with the family letter")

    @property
    def slug(self) -> str:
        return self.id.replace("/", "_")

    def expected_for(self, runtime: str) -> dict:
        """The full system's expected end in `runtime`: the shared fields, then the runtime's own
        (a recorded difference of the CLIs, D-091, is stated per runtime)."""
        value = {k: v for k, v in self.expected.items() if k not in ("py", "ts")}
        value.update(self.expected.get(runtime, {}))
        return value

    def to_json(self) -> dict:
        source = dict(self.source)
        if "case" in source:
            source = {**source, "case": source["case"]}
        return {
            "id": self.id,
            "family": self.family,
            "kind": self.kind,
            "title": self.title,
            "origin": self.origin,
            "source": source,
            "extra": self.extra_name,
            "tamper": self.tamper,
            "mode": self.mode,
            "grants": self.grants,
            "approve": list(self.approve),
            "limits": self.limits,
            "transcript": self.transcript,
            "consent_host": self.consent_host,
            "engine": self.engine,
            "taints": list(self.taints),
            "expected": self.expected,
            "boundary": self.boundary,
            "guard": self.guard,
            "primary_ablation": self.primary_ablation,
            "ablation_removes_guard": self.ablation_removes_guard,
            "matched_control": self.matched_control,
            "parametric": self.parametric,
            "property": self.property,
        }

    def driver_input(self, archive: str, trust_key: str) -> dict:
        """What a driver receives: no expectation, no boundary, nothing the oracle decides with."""
        return {
            "id": self.id,
            "archive": archive,
            "trust_key": trust_key,
            "mode": self.mode,
            "grants": self.grants,
            "approve": list(self.approve),
            "limits": self.limits,
            "transcript": self.transcript,
            "consent_host": self.consent_host,
            "engine": self.engine,
            "taints": list(self.taints),
        }


def catalog_hash(cases) -> str:
    text = json.dumps([case.to_json() for case in cases], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()
