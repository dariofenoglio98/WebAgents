"""Family M · Memory confinement (D-300; spec/memory-v0.md §10, M-36, M-40).

Guarantee: a sealed value never leaves to a model or to a tool that does not link its permission;
a proposal cannot name, link or update what the run was not granted, and nothing is offered for
review under a denied `memory.write`.

Variants: the memory probe's 23 negative and 4 positive variants (`conformance/drivers/
memory_probe.py`), N3 by its grants (a denied `memory.read`), and one new case: the probe under a
denied `memory.write` (T27 §1). Boundaries: the identity's sealed e-mail (or the card token) in a
recorded model request or tool call (`model_taint`, `tool_taint`); proposals offered for review
(`memory.proposed` with `offered` > 0, M-40/M-41); a tool reached that the case's change forbids;
for a refusal with no runtime effect of its own, the admission boundary (`executed`).
"""

from __future__ import annotations

from .base import Case

FAMILY = "M"
CONTROL = "M.fixture"


def _probe():
    from harness_v2.packages import probe

    return probe("memory")


def _admission(code, guard, ablation="decl_validation", removes=True):
    return {
        "expected": {"stage": "validation", "code": code},
        "boundary": {"class": "admission", "predicate": "executed"},
        "guard": guard,
        "primary_ablation": ablation,
        "ablation_removes_guard": removes,
    }


def _proposal(code, reason=None):
    expected = {"stage": "run", "code": code, "node": None}
    if reason:
        expected["reason"] = reason
    return {
        "expected": expected,
        "boundary": {"class": "effect", "predicate": "proposals_offered"},
        "guard": "M-40 proposals check",
        "primary_ablation": "proposal_check",
    }


# variant -> (title, spec of expectation/boundary/guard), in the probe driver's order.
VARIANTS = {
    "n1-type-undeclared": (
        "A proposal of a type no memory.write permission names",
        _proposal("permission_denied", "memory_proposal_type_undeclared"),
    ),
    "n2-sealed-field": (
        "A proposal of a sealed type carrying its sealed field",
        _proposal("schema_validation"),
    ),
    "n4-agent-write-over-cap": (
        "The agent document written over its 32,768 characters",
        {
            "expected": {"stage": "run", "code": "schema_validation", "node": "notes-write"},
            "boundary": {
                "class": "effect",
                "predicate": "tool_payload_longer",
                "tool": "notes-write",
                "field": "body",
                "length": 32768,
            },
            "guard": "agent write input bound (tool input schema)",
            "primary_ablation": None,
        },
    ),
    "n5-newer-runtime": (
        "A package that needs a newer runtime than this one",
        _admission("package_rejected", "minimum-version gate"),
    ),
    "n6-view-mismatch": (
        "A memory.read whose output schema is not the type's view",
        {
            "expected": {"stage": "start", "code": "binding_schema_mismatch"},
            "boundary": {"class": "effect", "predicate": "tool_called", "tool": "profile"},
            "guard": "memory binding check (M-16: a read's output is the type's view)",
            "primary_ablation": None,
        },
    ),
    "n7-two-agent-writes": (
        "The agent document written twice in one run",
        {
            "expected": {"stage": "run", "code": "budget_exhausted", "node": "notes-write-again"},
            "boundary": {
                "class": "effect",
                "predicate": "tool_called",
                "tool": "notes-write",
                "more_than": 1,
            },
            "guard": "per-tool call cap",
            "primary_ablation": None,
        },
    ),
    "n8-update-not-granted": (
        "An update of a record the run was not granted",
        _proposal("permission_denied", "memory_proposal_target_not_granted"),
    ),
    "n9-link-to-no-proposal": (
        "A link to a proposal index that does not exist",
        _proposal("schema_validation"),
    ),
    "n10-publisher-scoped": (
        "A publisher-scoped memory (only agent-scoped is defined)",
        _admission(
            "agent_memory_scope",
            "memory declarations (kept: re-run when a memory run opens)",
            removes=False,
        ),
    ),
    "n11-sealed-value-to-a-model": (
        "A granted sealed value placed in a model step's input",
        {
            "expected": {"stage": "run", "code": "permission_denied", "node": "remember"},
            "boundary": {"class": "effect", "predicate": "model_taint", "taint": "@EMAIL"},
            "guard": "M-36 egress scan (model request)",
            "primary_ablation": "egress_scan",
        },
    ),
    "n12-write-without-export": (
        "A memory.write permission with no memory.proposal export",
        _admission("memory_proposal_undeclared", "memory declarations"),
    ),
    "n13-sealed-value-in-a-proposal": (
        "A sealed value copied into an unsealed proposal field",
        _proposal("permission_denied", "sealed_value_in_proposal"),
    ),
    "n14-link-not-granted": (
        "A proposal linking a record the run was not granted",
        _proposal("permission_denied", "memory_proposal_link_not_granted"),
    ),
    "n14-body-link-not-granted": (
        "A proposal body wikilinking a record the run was not granted",
        _proposal("permission_denied", "memory_proposal_link_not_granted"),
    ),
    "n15-supersedes-link": (
        "A proposal declaring a supersedes link (reserved to the host)",
        _proposal("schema_validation"),
    ),
    "n16-custom-type-shadows-sealed": (
        "A custom type that shadows a sealed field of a host type",
        _admission(
            "custom_type_shadows_sealed_type",
            "memory declarations (kept: re-run when a memory run opens)",
            removes=False,
        ),
    ),
    "n17-custom-type-reserved": (
        "A custom type under a reserved id",
        _admission(
            "custom_type_reserved",
            "memory declarations (kept: re-run when a memory run opens)",
            removes=False,
        ),
    ),
    "n19-lower-index-first": (
        "Two refused proposals: the lower index is reported first",
        _proposal("permission_denied", "memory_proposal_link_not_granted"),
    ),
    "n21-custom-type-open": (
        "A custom type schema that admits undeclared properties",
        _admission(
            "custom_type_schema_open",
            "memory declarations (kept: re-run when a memory run opens)",
            removes=False,
        ),
    ),
    "n22-marker-line": (
        "A proposal body carrying the host's link-marker line",
        _proposal("schema_validation"),
    ),
    "m36-sealed-value-to-a-tool": (
        "A granted sealed value sent to a tool that does not link its permission",
        {
            "expected": {"stage": "run", "code": "permission_denied", "node": "echo"},
            "boundary": {
                "class": "effect",
                "predicate": "tool_taint",
                "taint": "@EMAIL",
                "tools": ["echo"],
            },
            "guard": "M-36 egress scan (tool arguments)",
            "primary_ablation": "egress_scan",
            "matched_control": "M.m36-granted-sealed-value",
        },
    ),
    "m36-two-sealed-values": (
        "Two sealed values to one tool, granted under two permissions it links one of",
        {
            "expected": {"stage": "run", "code": "permission_denied", "node": "echo"},
            "boundary": {
                "class": "effect",
                "predicate": "tool_taint",
                "taint": "@CARD",
                "tools": ["echo"],
            },
            "guard": "M-36 egress scan (every value)",
            "primary_ablation": "egress_scan",
            "matched_control": "M.m36-granted-sealed-value",
        },
    ),
    "agent-family-read": (
        "A memory.read of an agent. type (its binding would be a reserved agent tool)",
        _admission(
            "memory_type_reserved",
            "memory declarations (kept: re-run when a memory run opens)",
            removes=False,
        ),
    ),
}
CONTROLS = {
    "fixture": "Control: the memory probe (every memory.v0 permission) completes",
    "m36-granted-sealed-value": "Control: a sealed value sent to a tool that links its permission",
    "custom-type-proposal": "Control: a proposal of the package's own custom type",
    "custom-type-read": "Control: a read of the package's own custom type and an update of it",
}
EXTRA_GRANTS = {
    "m36-sealed-value-to-a-tool": {"probe.send": "session"},
    "m36-two-sealed-values": {"card.read": "session"},
    "custom-type-read": {"memory.card": "session"},
}
EXTRA_TOOLS = {"m36-two-sealed-values": ["wallet"], "custom-type-read": ["card"]}


def _taints():
    probe = _probe()
    return {"@EMAIL": probe.EMAIL, "@CARD": probe.CARD_TOKEN}


def _resolve(boundary: dict) -> dict:
    taints = _taints()
    return {k: taints.get(v, v) if isinstance(v, str) else v for k, v in boundary.items()}


def cases() -> list[Case]:
    probe = _probe()
    taints = tuple(_taints().values())
    out: list[Case] = []

    def make(variant, kind, title, spec=None, grants=None, case_id=None, origin=None):
        spec = spec or {}
        tools = list(probe.TOOLS) + EXTRA_TOOLS.get(variant, [])
        grant = probe.grants(**EXTRA_GRANTS.get(variant, {}))
        grant.update(grants or {})
        boundary = _resolve(spec["boundary"]) if kind == "violation" else {}
        expected = dict(spec.get("expected") or {"stage": "run", "code": "completed"})
        return Case(
            id=case_id or f"M.{variant}",
            family=FAMILY,
            kind=kind,
            title=title,
            origin=origin or f"memory probe variant {variant} (spec/memory-v0.md §10)",
            source={"probe": "memory", "variant": variant},
            mode="run",
            grants=grant,
            approve=tuple(sorted(tools)),
            expected=expected,
            boundary=boundary,
            guard=spec.get("guard", "none (control)"),
            primary_ablation=spec.get("primary_ablation"),
            ablation_removes_guard=spec.get("ablation_removes_guard", True),
            matched_control=None if kind == "control" else spec.get("matched_control", CONTROL),
            taints=taints,
        )

    for variant, title in CONTROLS.items():
        out.append(make(variant, "control", title))
    for variant, (title, spec) in VARIANTS.items():
        out.append(make(variant, "violation", title, spec))
    out.append(
        make(
            "fixture",
            "violation",
            "N3: a memory.read tool called under a denied permission",
            {
                "expected": {"stage": "run", "code": "permission_denied", "node": "profile"},
                "boundary": {"class": "effect", "predicate": "tool_called", "tool": "profile"},
                "guard": "permission mediator",
                "primary_ablation": None,
            },
            grants={"memory.profile": "deny"},
            case_id="M.n3-read-denied",
            origin="memory probe N3 (conformance memory/n3-read-denied)",
        )
    )
    out.append(
        make(
            "fixture",
            "violation",
            "New (T27 §1): proposals under a denied memory.write are offered to nobody",
            {
                "expected": {
                    "stage": "run",
                    "code": "completed",
                    "block_event": {
                        "action": "memory.proposed",
                        "fields": {"offered": 0, "reason": "permission_denied"},
                    },
                },
                "boundary": {"class": "effect", "predicate": "proposals_offered"},
                "guard": "M-40 proposals check (denied memory.write)",
                "primary_ablation": "proposal_check",
            },
            grants={"memory.remember": "deny"},
            case_id="M.write-denied",
            origin="catalog v2 (T27 §1): spec/memory-v0.md M-40, last paragraph",
        )
    )
    return out
