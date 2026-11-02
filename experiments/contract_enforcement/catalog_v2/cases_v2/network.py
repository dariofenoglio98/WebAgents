"""Family N · Delegation bounds (D-300; spec/network-v0.md §7, R-1…R-28).

Guarantee: activations stay within the hop, edge and role caps; the model routes only inside the
route's enum; a role reads and writes only its view; the envelope (the worst case) is reserved
before the first activation and never exceeded.

Variants: the 42 negative and 4 control cases of `examples/network/cases/cases.json`, written by
`conformance/drivers/network_probe.py` (each probe's fixture generated from the mutated network
with the reference's route data). Boundaries, from the audit's `network.*` and `route.decided`
events and the model seam: an activation, hop or edge use beyond the caps or more model calls
than the recorded worst case (`beyond_envelope`); a route outside the enum (`route_outside`); a
role's patch to a key outside its view or its schema (`role_wrote`); a fixed route along an
undeclared edge (`route_taken`); a network started although its worst case did not fit what the
run had left (`envelope_overcommitted`); or the admission boundary.
"""

from __future__ import annotations

from .base import Case

FAMILY = "N"
CONTROL = "N.fixture-walk"
CONTROLS = {"fixture-walk", "two-lookups", "end-only", "answer-check-in-role"}
ROLES = ["Desk", "Lookup", "Writer", "done"]
HOST_OUTPUT_CEILING = 16000  # agentpkg DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL = the core's default


def _admission(code):
    return (
        {"stage": "validation", "code": code},
        {"class": "admission", "predicate": "executed"},
        "network declarations",
        "decl_validation",
    )


def _spec(case: dict):
    cid, stage, code = case["id"], case["stage"], case.get("code")
    reason = case.get("reason")
    table = {
        "write-outside-view": (
            {"stage": stage, "code": code},
            {"class": "effect", "predicate": "role_wrote", "role": "Lookup", "key": "draft"},
            "network declarations (state_write view)",
            "decl_validation",
        ),
        "edge-undeclared": (
            {"stage": stage, "code": code},
            {"class": "effect", "predicate": "route_taken", "role": "Lookup", "next": "Writer"},
            "network declarations (a fixed route along a declared edge)",
            "decl_validation",
        ),
        "end-not-allowed": (
            {"stage": stage, "code": code},
            {"class": "effect", "predicate": "route_taken", "role": "Lookup", "next": "done"},
            "network declarations (only an ending role ends)",
            "decl_validation",
        ),
        "bound-exceeds-budget": (
            # R-22 refuses publishing a network whose worst case exceeds its own budget; at run
            # time the worst case is computed under the budget and the budget still caps the
            # walk, so the refusal has no run-time effect of its own: admission.
            {"stage": stage, "code": code},
            {"class": "admission", "predicate": "executed"},
            "the worst case against the package's budget (R-24)",
            "envelope_reservation",
        ),
        "once-memory": (
            {"stage": stage, "code": code},
            {"class": "effect", "predicate": "activations_over", "count": 1},
            "once grant on a network (execution layer)",
            None,
        ),
        "once-model": (
            {"stage": stage, "code": code},
            {"class": "effect", "predicate": "model_calls_over", "count": 1},
            "once grant on a network (execution layer)",
            None,
        ),
        "route-cap-too-large": (
            {"stage": stage, "code": code},
            {"class": "effect", "predicate": "output_above", "tokens": HOST_OUTPUT_CEILING},
            "host's per-call output ceiling (execution layer)",
            None,
        ),
        "hops-exhausted": (
            {"stage": stage, "code": code, "reason": reason, "node": "delegate"},
            {"class": "effect", "predicate": "beyond_envelope"},
            "R-11 hop cap",
            "transition_check",
        ),
        "edge-exhausted": (
            {"stage": stage, "code": code, "reason": reason, "node": "delegate"},
            {"class": "effect", "predicate": "beyond_envelope"},
            "R-12 edge cap",
            "transition_check",
        ),
        "role-exhausted": (
            {"stage": stage, "code": code, "reason": reason, "node": "delegate"},
            {"class": "effect", "predicate": "beyond_envelope"},
            "R-13 role activation cap",
            "transition_check",
        ),
        "fixed-route-exhausted": (
            {"stage": stage, "code": code, "reason": reason, "node": "delegate"},
            {"class": "effect", "predicate": "beyond_envelope"},
            "R-12 edge cap on a fixed route",
            "transition_check",
        ),
        "target-not-in-enum": (
            {"stage": stage, "code": code, "node": "delegate"},
            {"class": "effect", "predicate": "route_outside", "targets": ROLES},
            "the route's enum",
            "transition_check",
        ),
        "message-invalid": (
            {"stage": stage, "code": code, "node": "delegate"},
            {"class": "effect", "predicate": "role_activations_over", "role": "Lookup", "count": 0},
            "the handoff message schema",
            None,
        ),
        "budget-overrun-in-role": (
            {"stage": stage, "code": code, "node": "delegate"},
            {"class": "effect", "predicate": "model_task_called", "task": "draft"},
            "a role's own token budget",
            None,
        ),
        "reservation-refused": (
            {"stage": stage, "code": code, "reason": reason, "node": "delegate"},
            {"class": "effect", "predicate": "envelope_overcommitted"},
            "R-17 reservation before the first activation",
            "envelope_reservation",
        ),
        "patch-outside-schema": (
            {"stage": stage, "code": code, "node": "delegate"},
            {"class": "effect", "predicate": "role_wrote", "role": "Writer", "key": "draft"},
            "the shared state's schema",
            None,
        ),
        "patch-outside-schema-chosen": (
            {"stage": stage, "code": code, "node": "delegate"},
            {"class": "effect", "predicate": "role_wrote", "role": "Desk", "key": "notes"},
            "the shared state's schema",
            None,
        ),
        "answer-check-refused-in-role": (
            {"stage": stage, "code": code, "node": "delegate"},
            {"class": "effect", "predicate": "role_wrote", "role": "Writer", "key": "draft"},
            "a role step's answer check",
            None,
        ),
    }
    if cid in table:
        expected, boundary, guard, ablation = table[cid]
    elif stage == "validation":
        expected, boundary, guard, ablation = _admission(code)
    else:
        raise KeyError(f"network case without a catalog row: {cid}")
    return {
        "expected": {k: v for k, v in expected.items() if v is not None},
        "boundary": boundary,
        "guard": guard,
        "primary_ablation": ablation,
        # The route's enum is the route answer's own output schema, which no profile removes.
        "ablation_removes_guard": cid != "target-not-in-enum",
    }


def cases() -> list[Case]:
    from harness_v2.packages import driver, probe

    module = probe("network")
    out: list[Case] = []
    for case in driver("network").CASES:
        control = case["id"] in CONTROLS
        spec = {} if control else _spec(case)
        out.append(
            Case(
                id=f"N.{case['id']}",
                family=FAMILY,
                kind="control" if control else "violation",
                title=case["title"],
                origin=f"examples/network/cases/cases.json#{case['id']}",
                source={"probe": "network", "case": case},
                mode="run",
                grants=module.grants(**case.get("grants", {})),
                approve=("lookup",),
                expected=spec.get("expected", {"stage": "run", "code": "completed"}),
                boundary=spec.get("boundary", {}),
                guard=spec.get("guard", "none (control)"),
                primary_ablation=spec.get("primary_ablation"),
                ablation_removes_guard=spec.get("ablation_removes_guard", True),
                matched_control=None if control else CONTROL,
            )
        )
    return out
