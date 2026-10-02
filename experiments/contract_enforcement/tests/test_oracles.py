"""The oracle: forbidden boundaries decide silence; the refusal vocabulary decides attribution."""

from __future__ import annotations

import re

import pytest

from harness import codes, oracle
from harness.paths import AGENTPKG_PACKAGE, PLUGIN_SRC
from harness.synthetic import Canaries


def obs(**fields) -> dict:
    base = {
        "page_errors": [],
        "control_errors": [],
        "control_calls": [],
        "events": [],
        "audit": [],
        "audit_raw": [],
        "commits": [],
        "helper": {},
        "canaries": Canaries(),
        "faults_fired": [],
        "rpc_failures": [],
        "run_record": None,
        "workflow_status": None,
    }
    base.update(fields)
    return base


COMPLETED = {"run_record": {"status": "completed"}, "workflow_status": "completed"}
REFUSED_AT_PREPARE = {
    "page_errors": [{"step": "prepare", "op": "prepareRunPlan", "code": "run_plan_refused"}],
    "control_errors": [
        {
            "route": "POST /packages/{session}/run-plan",
            "code": "run_plan_refused",
            "blocking_reasons": [{"code": "publisher_not_trusted"}],
        }
    ],
}


def never(_obs):
    return False


def always(_obs):
    return True


def test_boundary_reached_is_silent_even_if_refused_later():
    verdict = oracle.judge("violation", obs(**REFUSED_AT_PREPARE), always)
    assert verdict.outcome == oracle.SILENT_VIOLATION
    assert verdict.detected_after_boundary


def test_recognized_refusal_is_an_explicit_block():
    verdict = oracle.judge("violation", obs(**REFUSED_AT_PREPARE), never)
    assert verdict.outcome == oracle.EXPLICIT_BLOCK
    assert (verdict.refusal.component, verdict.refusal.stage, verdict.refusal.check) == (
        "trust",
        "trust",
        "publisher_not_trusted",
    )


def test_unrecognized_failure_is_incidental():
    failure = obs(
        run_record={"status": "failed"},
        workflow_status="failed",
        runner_run={"error_code": "worker_error"},
    )
    verdict = oracle.judge("violation", failure, never)
    assert verdict.outcome == oracle.INCIDENTAL_FAILURE


def test_harness_problems_are_never_detection():
    broken = obs(**REFUSED_AT_PREPARE, events=[{"event": "harness.exception", "error": "x"}])
    assert oracle.judge("violation", broken, never).outcome == oracle.HARNESS_ERROR
    assert oracle.judge("control", broken, never).outcome == oracle.HARNESS_ERROR


def test_a_fault_that_never_fired_tested_nothing():
    verdict = oracle.judge("violation", obs(**REFUSED_AT_PREPARE), never, requires_fault=True)
    assert verdict.outcome == oracle.HARNESS_ERROR
    assert "violation_not_injected" in verdict.harness


def test_a_violation_that_completes_unobserved_is_a_harness_error():
    verdict = oracle.judge("violation", obs(**COMPLETED), never)
    assert verdict.outcome == oracle.HARNESS_ERROR
    assert "violation_not_observed" in verdict.harness


def test_controls():
    assert oracle.judge("control", obs(**COMPLETED), always).outcome == oracle.BENIGN_ACCEPT
    assert oracle.judge("control", obs(**REFUSED_AT_PREPARE), never).outcome == oracle.FALSE_REJECT


def test_an_attempt_to_leave_the_process_fails_the_case():
    leaving = obs(**COMPLETED, python_guard=[{"kind": "socket.create_connection", "detail": "x"}])
    assert oracle.judge("control", leaving, never).outcome == oracle.HARNESS_ERROR
    node = obs(
        **REFUSED_AT_PREPARE, helper={"guard": {"refused": [{"kind": "fetch", "detail": "x"}]}}
    )
    assert oracle.judge("violation", node, never).outcome == oracle.HARNESS_ERROR
    # A canary open is the case's own boundary, not a harness failure.
    canary = obs(**REFUSED_AT_PREPARE, python_guard=[{"kind": "os.open", "detail": "canary"}])
    assert oracle.judge("violation", canary, never).outcome == oracle.EXPLICIT_BLOCK


def test_synthetic_anomalies_are_harness_errors():
    canaries = Canaries()
    canaries.anomalies.append({"where": "mutation_expectation"})
    assert (
        oracle.judge("violation", obs(**COMPLETED, canaries=canaries), never).outcome
        == oracle.HARNESS_ERROR
    )


def test_start_refusals_are_read_from_title_and_detail():
    page = {
        "step": "start",
        "op": "startExecution",
        "code": "execution_refused",
        "title": "Selected files need a permission that is denied",
        "detail": "Reading the selected documents requires files.pdfs.",
    }
    refusal = oracle.first_refusal(obs(page_errors=[page]))
    assert (refusal.component, refusal.check) == ("authorization", "file_permission")


def test_simulated_host_refusals_are_not_credited():
    assert "model_call_not_authorized" not in codes.CALL_REASONS


def test_map_bound_refusal_is_a_resource_refusal():
    audit = [
        {
            "action": "node.failed",
            "node_id": "search",
            "node_type": "map",
            "error_code": "schema_validation",
        }
    ]
    failed = {"run_record": {"status": "failed"}, "audit": audit}
    plain = oracle.first_refusal(obs(**failed))
    bound = oracle.first_refusal(
        obs(**failed, map_refusals=[{"node": "search", "items": 6, "max_items": 3}])
    )
    assert (plain.component, plain.check) == ("validation", "map_items")
    assert (bound.component, bound.stage, bound.check) == ("resource", "resource", "map_max_items")


# -- the vocabulary is the production code's own -------------------------------------------
def _source(root, suffixes) -> str:
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(root.rglob("*"))
        if path.suffix in suffixes
    )


@pytest.fixture(scope="module")
def production_text():
    return _source(AGENTPKG_PACKAGE, {".py"}) + "\n" + _source(PLUGIN_SRC, {".ts"})


# Codes and messages production builds from a fixed list of layers rather than
# spelling out: (template as it appears in the source, the layer list it loops over).
LAYERED_CODES = {
    "container_invalid": (
        'block(f"{layer}_invalid"',
        'for layer in ("container", "integrity", "schema"):',
    ),
    "integrity_invalid": (
        'block(f"{layer}_invalid"',
        'for layer in ("container", "integrity", "schema"):',
    ),
    "schema_invalid": (
        'block(f"{layer}_invalid"',
        'for layer in ("container", "integrity", "schema"):',
    ),
}
LAYERED_MESSAGES = {
    f"Package {layer} is not valid.": (
        'refuse(`Package ${layer.replace("_status", "")} is not valid.`)',
        'for (const layer of ["container_status", "integrity_status", "schema_status"] as const)',
    )
    for layer in ("container", "integrity", "schema")
}
LAYERED_MESSAGES.update(
    {
        f"The publisher {field} changed": (
            'refuse(`The publisher ${field.replace(/_/gu, " ")} '
            "changed after this plan was prepared.`)",
            f'["{field.replace(" ", "_")}", ',
        )
        for field in ("signature status", "trust status", "signer fingerprint")
    }
)


@pytest.mark.parametrize(
    "table",
    ["CONTROL", "BLOCKERS", "RUNNER", "CALL_REASONS", "WORKFLOW"],
)
def test_every_code_occurs_in_production(production_text, table):
    for code in getattr(codes, table):
        if code in LAYERED_CODES:
            template, layers = LAYERED_CODES[code]
            assert template in production_text and layers in production_text, f"{table}: {code}"
            continue
        assert re.search(rf"[\"']{re.escape(code)}[\"']", production_text), f"{table}: {code}"


def test_every_stale_reason_occurs_in_production(production_text):
    for code in codes.STALE:
        assert re.search(rf"[\"']{re.escape(code)}[\"']", production_text), code


def test_every_fixed_message_occurs_in_the_plugin():
    plugin = _source(PLUGIN_SRC, {".ts"})
    agentpkg = _source(AGENTPKG_PACKAGE, {".py"})
    flat_plugin = re.sub(r'"\s*\+\s*"', "", plugin)  # messages concatenated across lines
    flat_plugin = re.sub(r"`\s*\+\s*`", "", flat_plugin)
    for prefix, _, _ in (*codes.REVALIDATE, *codes.START):
        if prefix in LAYERED_MESSAGES:
            template, layers = LAYERED_MESSAGES[prefix]
            assert template in plugin and layers in plugin, prefix
            continue
        assert prefix in flat_plugin or prefix in agentpkg, prefix
