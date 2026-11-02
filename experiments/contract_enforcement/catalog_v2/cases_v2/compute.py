"""Family C · Compute isolation (D-300; spec/compute-v0.md §10, C-51).

Guarantee: a module imports nothing, runs under the host's memory, fuel and time bounds, and its
output is used only through the node's contract.

Variants: the 39 negative and 2 control cases of `examples/compute/cases/cases.json`, written by
`conformance/drivers/compute_probe.py` (`engine-unavailable` kept: both drivers withhold the engine
when a case says so). Boundaries: a module's code executed although the gate, the permission or
the host's ceiling refuses it (`module_ran`); a call past its time bound (`compute_overran`); a
call whose output broke the contract committed to state (`node_committed`); a refusal with no
effect of its own (`executed`).
"""

from __future__ import annotations

from .base import Case

FAMILY = "C"
CONTROL = "C.echo"
GRANTS = {"memory.session": "session", "compute.modules": "session"}

MODULE_GATE = {
    "module-import",
    "module-no-memory-maximum",
    "module-two-memories",
    "module-memory-not-exported",
    "module-missing-alloc",
    "module-bad-run-signature",
    "module-shared-memory",
    "module-simd",
    "module-tail-call",
    "module-threads",
    "module-hash-mismatch",
}
DECLARATION_EFFECT = {"permission-missing", "permission-resources"}
DECLARATION_ADMISSION = {
    "module-undeclared-member",
    "module-unknown-in-node",
    "module-unused",
    "minimum-version",
    "limits-below-module",
}
TRAPS = {
    "trap-unreachable",
    "stack-overflow",
    "indirect-call-null",
    "indirect-call-bad-signature",
    "output-not-json",
    "output-not-utf8",
    "alloc-returns-zero",
    "alloc-out-of-range",
    "output-schema-miss",
}
OUTPUT_BOUNDS = {"output-zero-length", "output-out-of-range"}
# A runaway call's bound in each runtime: wasmtime meters fuel; V8 has no fuel and reaches the
# host's wall bound (10 s) instead (D-244). Past these, the bound did not hold.
OVERRUN_MS = {"fuel-exhausted": 15000, "deadline": 5000}


def _spec(case: dict) -> dict:
    cid, stage = case["id"], case["stage"]
    if cid in MODULE_GATE:
        return {
            "expected": {"stage": stage, "code": case["code"]},
            "boundary": {"class": "effect", "predicate": "module_ran"},
            "guard": "module gate (static module check)",
            "primary_ablation": "module_gate",
        }
    if cid in DECLARATION_EFFECT:
        return {
            "expected": {"stage": stage, "code": case["code"]},
            "boundary": {"class": "effect", "predicate": "module_ran"},
            "guard": "compute declarations (the permission naming the modules)",
            "primary_ablation": "decl_validation",
        }
    if cid in DECLARATION_ADMISSION:
        return {
            "expected": {"stage": stage, "code": case["code"]},
            "boundary": {"class": "admission", "predicate": "executed"},
            "guard": "compute declarations",
            "primary_ablation": "decl_validation",
        }
    if stage == "container":
        return {
            "expected": {"stage": stage, "code": "package_rejected"},
            "boundary": {"class": "admission", "predicate": "executed"},
            "guard": "container rules"
            if case.get("variant") != "tamper-archive"
            else "integrity statement",
            "primary_ablation": "module_gate" if case.get("variant") != "tamper-archive" else None,
            "ablation_removes_guard": False,
        }
    if cid == "memory-over-host-cap":
        # Both execution layers refuse it before the run (D-091's N-17: `agentpkg run` alone would
        # refuse in the runtime's preflight with `compute_limit_exceeded`).
        return {
            "expected": {"stage": "admission", "code": "execution_compute_limit_exceeded"},
            "boundary": {"class": "effect", "predicate": "module_ran"},
            "guard": "host page ceiling (refused, never lowered)",
            "primary_ablation": "compute_limits",
        }
    if cid == "engine-unavailable":
        # The Chrome execution layer refuses a package with compute nodes on a host with no
        # engine before the run; agentpkg's runtime refuses it in its preflight.
        return {
            "expected": {
                "stage": stage,
                "code": case["code"],
                "ts": {"stage": "admission", "code": "compute_not_supported"},
            },
            "boundary": {"class": "admission", "predicate": "executed"},
            "guard": "engine presence",
            "primary_ablation": None,
        }
    if cid == "permission-denied":
        # D-091's N-19: both execution layers refuse the denied required permission before the
        # run (`execution_permission_denied`); `agentpkg run` alone stops at the mediator.
        return {
            "expected": {"stage": "admission", "code": "execution_permission_denied"},
            "boundary": {"class": "effect", "predicate": "module_ran"},
            "guard": "permission mediator",
            "primary_ablation": None,
        }
    if cid in OVERRUN_MS:
        return {
            "expected": {"stage": stage, "code": case["code"], "node": "compute"},
            "boundary": {"class": "effect", "predicate": "compute_overran", "ms": OVERRUN_MS[cid]},
            "guard": "fuel and wall bounds of a call",
            "primary_ablation": "compute_limits",
        }
    if cid == "memory-growth-refused":
        return {
            "expected": {"stage": stage, "code": case["code"], "node": "compute"},
            "boundary": {"class": "effect", "predicate": "compute_pages_above", "pages": 64},
            "guard": "the module's declared memory maximum (engine)",
            "primary_ablation": None,
        }
    if cid in OUTPUT_BOUNDS:
        return {
            "expected": {"stage": stage, "code": case["code"], "node": "compute"},
            "boundary": {"class": "effect", "predicate": "node_committed", "node": "compute"},
            "guard": "output range bound of a call",
            "primary_ablation": "compute_limits",
        }
    if cid in TRAPS:
        return {
            "expected": {"stage": stage, "code": case["code"], "node": "compute"},
            "boundary": {"class": "effect", "predicate": "node_committed", "node": "compute"},
            "guard": "engine trap / ABI / output contract",
            "primary_ablation": None,
        }
    if cid == "input-schema-miss":
        return {
            "expected": {"stage": stage, "code": case["code"], "node": "compute"},
            "boundary": {"class": "effect", "predicate": "module_ran"},
            "guard": "compute input schema",
            "primary_ablation": None,
        }
    raise KeyError(f"compute case without a catalog row: {cid}")


def cases() -> list[Case]:
    from harness_v2.packages import driver

    out: list[Case] = []
    for case in driver("compute").CASES:
        control = case["code"] == "completed"
        grants = {**GRANTS, **case.get("grants", {})}
        if case.get("variant") == "no-permission":
            grants.pop("compute.modules")
        spec = {} if control else _spec(case)
        if spec.get("expected", {}).get("code") and case.get("reason"):
            spec["expected"]["reason"] = case["reason"]
            if case.get("non_metering_reason"):
                # V8 meters no fuel: a runaway module reaches the wall bound instead (D-244).
                spec["expected"]["ts"] = {"reason": case["non_metering_reason"]}
        out.append(
            Case(
                id=f"C.{case['id']}",
                family=FAMILY,
                kind="control" if control else "violation",
                title=case["title"],
                origin=f"examples/compute/cases/cases.json#{case['id']}",
                source={"probe": "compute", "case": case},
                mode="run",
                grants=grants,
                approve=(),
                expected=spec.get("expected", {"stage": "run", "code": "completed"}),
                boundary=spec.get("boundary", {}),
                guard=spec.get("guard", "none (control)"),
                primary_ablation=spec.get("primary_ablation"),
                ablation_removes_guard=spec.get("ablation_removes_guard", True),
                matched_control=None if control else CONTROL,
                engine=case.get("variant") != "no-engine",
                tamper="modules/echo.wasm" if case.get("variant") == "tamper-archive" else None,
            )
        )
    return out
