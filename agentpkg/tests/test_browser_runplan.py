"""Run plans: what they bind, what invalidates them, and what they still cannot do.

A run plan is the last artifact before execution. These tests hold two lines:
it must bind every input a later runner would need to re-verify, and it must
stop being usable the moment any of those inputs changes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from shipped_keys import AGENDA_KEY, DIST, ORIGINAL_KEY
from tool_fakes import registry_for

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.authorization import BrowserPolicy
from agentpkg.browser.runplan import RUN_PLAN_SCHEMA
from agentpkg.browser.trust import read_public_key_file
from agentpkg.package import canonical_json, sha256

ROOT = Path(__file__).resolve().parents[2]


def plane(tmp_path, *, trusted=True, **overrides) -> ControlPlane:
    control = ControlPlane(
        ControlPlaneConfig(
            cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json", **overrides
        )
    )
    if trusted:
        # The two shipped artifacts carry two different signer keys; a plane
        # that opens either one pins both, each as its own explicit decision.
        control.trust_add(
            read_public_key_file(ORIGINAL_KEY),
            display_name="WebAgents development key",
            publisher_id="webagents-research",
        )
        control.trust_add(
            read_public_key_file(AGENDA_KEY),
            display_name="WebAgents Meeting Agenda signing key",
            publisher_id="webagents-research",
            package_id_prefix="org.webagents.meeting-agenda",
        )
    return control


def model(model_id="host/alpha", **overrides) -> dict:
    descriptor = {
        "id": model_id,
        "provider_id": model_id.split("/")[0],
        "model_id": model_id.split("/")[1],
        "display_name": "Alpha",
        "available": True,
        "selectable": True,
        "capabilities": {
            "reasoning": {"value": True, "basis": "declared"},
            "structured_output": {"value": True, "basis": "declared"},
        },
        "limits": {"context_tokens": 200000},
        "properties": {"local": False, "tags": []},
    }
    descriptor.update(overrides)
    return descriptor


def catalog(*models) -> dict:
    return {
        "schema": "agentpkg-host-model-catalog-v0",
        "host": {
            "runtime": "test-host",
            "runtime_version": "1.0.0",
            "source": "test",
            "captured_at": "2026-09-21T22:00:00+00:00",
        },
        "models": list(models) or [model()],
        "notes": [],
    }


def opened(control, name="meeting-agenda"):
    summary = control.open_file(str(DIST[name]))
    return summary["session"]["id"], summary["package"]["digest"]


def authorize(control, session, digest, *, include_model=True, approve_tools=True, **extra):
    """Grant every required permission, the model permission, and every tool.

    Approving a tool is a decision of its own: the helper does both because
    most of these tests are about something else, and the tests that are about
    the distinction pass `approve_tools=False`.
    """
    request = control.permissions(session)
    decisions = {item["id"]: "session" for item in request["permissions"] if item["required"]}
    if include_model:
        decisions.update(
            {item["id"]: "session" for item in request["permissions"] if item["kind"] == "model"}
        )
    decisions.update(extra)
    approvals = {item["tool_id"]: bool(approve_tools) for item in request.get("tool_approvals", [])}
    return control.authorize(
        session, package_digest=digest, decisions=decisions, tool_approvals=approvals
    )


def tools_for(control, session, **kwargs):
    """A host registry that satisfies whatever this session's package declares."""
    package = control._session(session).package
    return registry_for(package, **kwargs) if package.tools else None


def prepared(
    control, session, digest, receipt, *, models=None, model_id="host/alpha", tool_registry=...
):
    if tool_registry is ...:
        tool_registry = tools_for(control, session)
    return control.prepare_run_plan(
        session,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id=model_id,
        catalog=catalog(*(models or [model()])),
        tool_registry=tool_registry,
    )


# -- what a plan binds -------------------------------------------------------
@pytest.mark.parametrize("name", sorted(DIST))
def test_a_plan_binds_package_authorization_signer_and_model(name, tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control, name)
    receipt = authorize(control, session, digest)
    plan = prepared(control, session, digest, receipt)["run_plan"]

    assert plan["schema"] == RUN_PLAN_SCHEMA
    assert plan["run_plan_id"].startswith("rp_")
    assert plan["package"]["digest"] == digest
    assert (
        plan["package"]["archive_sha256"] == control.summary(session)["snapshot"]["archive_sha256"]
    )
    assert plan["publisher"]["signature_status"] == "valid"
    assert plan["publisher"]["trust_status"] == "trusted"
    assert plan["publisher"]["signer_fingerprint"].startswith("sha256:")
    assert plan["authorization"]["receipt_id"] == receipt["receipt_id"]
    assert plan["authorization"]["receipt_sha256"] == receipt["receipt_sha256"]
    assert plan["model_binding"]["host_model_id"] == "host/alpha"
    assert plan["model_binding"]["compatibility"]["status"] == "compatible"
    assert plan["execution"] == {
        **plan["execution"],
        "mode": "model",
        "binding_strategy": "single_model",
        "performed": False,
    }
    assert plan["readiness"]["ready"] is True


def test_a_plan_binds_the_exact_catalog_its_verdict_came_from(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    payload = catalog(model("host/alpha"), model("host/beta"))
    plan = control.prepare_run_plan(
        session,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id="host/alpha",
        catalog=payload,
    )["run_plan"]
    binding = plan["model_binding"]["catalog"]
    assert binding["model_count"] == 2
    assert binding["available_model_count"] == 2
    assert len(binding["catalog_sha256"]) == 64
    # The same catalog hashes identically; a changed one does not.
    from agentpkg.browser.hostmodels import normalize_catalog

    assert normalize_catalog(payload)["catalog_sha256"] == binding["catalog_sha256"]
    assert (
        normalize_catalog(catalog(model("host/alpha")))["catalog_sha256"]
        != binding["catalog_sha256"]
    )


def test_the_plan_hash_is_deterministic_over_canonical_contents(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    plan = prepared(control, session, digest, receipt)["run_plan"]
    recomputed = {key: value for key, value in plan.items() if key != "run_plan_sha256"}
    assert sha256(canonical_json(recomputed)) == plan["run_plan_sha256"]
    # Any change to any bound field changes the hash.
    tampered = json.loads(json.dumps(recomputed))
    tampered["model_binding"]["host_model_id"] = "host/other"
    assert sha256(canonical_json(tampered)) != plan["run_plan_sha256"]


def test_a_plan_contains_no_secret_or_host_internal_field(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    plan = prepared(control, session, digest, receipt)["run_plan"]
    blob = json.dumps(plan).lower()
    for marker in ("bearer", "sk-", "api_key", "apikey", "private key", "authorization: "):
        assert marker not in blob
    # The snapshot path is session-internal and has no place in a plan.
    assert "package.agent.pkg" not in blob


# -- run-mode permissions ----------------------------------------------------
def test_model_execution_requires_the_model_permission_even_when_optional(tmp_path):
    """Literature Review marks `model.reasoning` optional; a model run needs it."""
    control = plane(tmp_path)
    session, digest = opened(control, "literature-review")
    request = control.permissions(session)
    optional = [
        item for item in request["permissions"] if item["kind"] == "model" and not item["required"]
    ]
    assert optional, "this test needs an optional model permission to be meaningful"

    receipt = authorize(control, session, digest, include_model=False)
    assert receipt["runnable"] is True  # The package itself is authorized.
    with pytest.raises(ControlPlaneError) as error:
        prepared(control, session, digest, receipt)
    assert error.value.code == "run_plan_refused"
    codes = [reason["code"] for reason in error.value.details["blocking_reasons"]]
    assert "execution_mode_permission_denied" in codes
    assert optional[0]["id"] in str(error.value)

    # The package manifest is untouched; the person changes the decision.
    granted = authorize(control, session, digest)
    plan = prepared(control, session, digest, granted)["run_plan"]
    assert plan["readiness"]["ready"] is True
    assert plan["execution"]["required_permission_ids"] == [optional[0]["id"]]


def test_a_denied_model_permission_still_allows_model_inspection(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control, "literature-review")
    authorize(control, session, digest, include_model=False)
    evaluation = control.evaluate_models(session, package_digest=digest, catalog=catalog())
    assert evaluation["models"][0]["status"] == "compatible"
    assert control.model_requirements(session)["mode_required_permission_ids"]["model"] == [
        "model.reasoning"
    ]


# -- model selection rules ---------------------------------------------------
def test_an_incompatible_model_cannot_be_bound(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    with pytest.raises(ControlPlaneError) as error:
        prepared(
            control,
            session,
            digest,
            receipt,
            models=[model("host/alpha", limits={"context_tokens": 10})],
        )
    assert error.value.code == "run_plan_refused"
    assert "model_incompatible" in [
        reason["code"] for reason in error.value.details["blocking_reasons"]
    ]


def test_an_unavailable_model_cannot_be_bound(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    with pytest.raises(ControlPlaneError) as error:
        prepared(control, session, digest, receipt, models=[model("host/alpha", available=False)])
    assert "model_unavailable" in [
        reason["code"] for reason in error.value.details["blocking_reasons"]
    ]


def test_a_model_missing_from_the_catalog_is_refused(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    with pytest.raises(ControlPlaneError) as error:
        prepared(control, session, digest, receipt, model_id="host/vanished")
    assert error.value.code == "model_unknown"


def test_an_unverified_model_is_refused_by_default_and_allowed_by_explicit_policy(tmp_path):
    """`unverified` is neither a yes nor a no, and the policy says which it is."""
    unknown = model("host/alpha", capabilities={})
    strict = plane(tmp_path / "strict")
    session, digest = opened(strict)
    receipt = authorize(strict, session, digest)
    with pytest.raises(ControlPlaneError) as error:
        prepared(strict, session, digest, receipt, models=[unknown])
    codes = [reason["code"] for reason in error.value.details["blocking_reasons"]]
    assert codes == ["model_compatibility_unverified"]

    relaxed = plane(
        tmp_path / "relaxed",
        policy=BrowserPolicy(require_confirmed_model_compatibility=False),
    )
    session, digest = opened(relaxed)
    receipt = authorize(relaxed, session, digest)
    plan = prepared(relaxed, session, digest, receipt, models=[unknown])["run_plan"]
    assert plan["readiness"]["ready"] is True
    # The relaxed policy is recorded, and the real status is not rewritten.
    assert plan["readiness"]["compatibility_status"] == "unverified"
    assert plan["browser_policy"]["require_confirmed_model_compatibility"] is False


def test_an_unsupported_execution_mode_or_binding_is_refused(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    for kwargs, code in (
        ({"execution_mode": "fixture"}, "unsupported_execution_mode"),
        ({"binding_strategy": "per_node"}, "unsupported_binding_strategy"),
    ):
        with pytest.raises(ControlPlaneError) as error:
            control.prepare_run_plan(
                session,
                package_digest=digest,
                receipt_id=receipt["receipt_id"],
                model_id="host/alpha",
                catalog=catalog(),
                **kwargs,
            )
        assert error.value.code == code


# -- authorization binding ---------------------------------------------------
def test_preparation_requires_an_authorization_and_the_exact_receipt_id(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    with pytest.raises(ControlPlaneError) as error:
        control.prepare_run_plan(
            session,
            package_digest=digest,
            receipt_id="rp-nothing",
            model_id="host/alpha",
            catalog=catalog(),
        )
    assert error.value.code == "authorization_absent"

    receipt = authorize(control, session, digest)
    with pytest.raises(ControlPlaneError) as stale:
        control.prepare_run_plan(
            session,
            package_digest=digest,
            receipt_id="some-other-receipt",
            model_id="host/alpha",
            catalog=catalog(),
        )
    assert stale.value.code == "receipt_mismatch"
    assert stale.value.details["session_receipt_id"] == receipt["receipt_id"]


def test_preparation_requires_the_echoed_package_digest(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    with pytest.raises(ControlPlaneError) as error:
        control.prepare_run_plan(
            session,
            package_digest="0" * 64,
            receipt_id=receipt["receipt_id"],
            model_id="host/alpha",
            catalog=catalog(),
        )
    assert error.value.code == "digest_mismatch"


def test_reauthorization_discards_the_previous_plan(tmp_path):
    """A changed consent decision must not leave an older ready plan usable."""
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    first = prepared(control, session, digest, receipt)["run_plan"]
    assert control.run_plan(session)["run_plan"]["run_plan_id"] == first["run_plan_id"]

    authorize(control, session, digest)
    with pytest.raises(ControlPlaneError) as error:
        control.run_plan(session)
    assert error.value.code == "run_plan_absent"
    assert control.summary(session)["run_plan"]["state"] == "absent"


def test_a_plan_can_be_discarded_explicitly(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    plan = prepared(control, session, digest, receipt)["run_plan"]
    cleared = control.clear_run_plan(session)
    assert cleared == {
        "session_id": session,
        "cleared": True,
        "run_plan_id": plan["run_plan_id"],
    }
    assert control.clear_run_plan(session)["cleared"] is False


def test_closing_the_package_takes_its_plan_with_it(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    prepared(control, session, digest, receipt)
    control.close(session)
    with pytest.raises(ControlPlaneError) as error:
        control.run_plan(session)
    assert error.value.code == "session_unknown"


# -- preflight: the world can change under a frozen plan ---------------------
def test_a_fresh_plan_reports_ready(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    state = prepared(control, session, digest, receipt)
    assert state["preflight"]["state"] == "ready"
    assert state["preflight"]["ready"] is True
    assert state["preflight"]["stale"] is False
    assert state["preflight"]["stale_reasons"] == []
    assert state["preflight"]["execution"]["performed"] is False


def test_removing_publisher_trust_makes_a_prepared_plan_stale(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    prepared(control, session, digest, receipt)
    fingerprint = control.summary(session)["publisher"]["signer_fingerprint"]

    control.trust_remove(fingerprint)
    state = control.run_plan(session)
    assert state["preflight"]["stale"] is True
    assert state["preflight"]["ready"] is False
    codes = [reason["code"] for reason in state["preflight"]["stale_reasons"]]
    assert "publisher_trust_changed" in codes
    assert "publisher_not_trusted" in codes
    # The plan itself is untouched: it records what was true when it was made.
    assert state["run_plan"]["publisher"]["trust_status"] == "trusted"
    assert state["preflight"]["trust_store_changed"] is True


def test_an_expired_receipt_makes_a_plan_stale(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    prepared(control, session, digest, receipt)
    # Ageing the receipt is the honest way to reach this state in a test; the
    # session TTL and the receipt expiry are the same clock in production.
    control._sessions[session].receipt["expires_at"] = "2020-01-01T00:00:00+00:00"
    state = control.run_plan(session)
    assert state["preflight"]["stale"] is True
    assert "authorization_expired" in [
        reason["code"] for reason in state["preflight"]["stale_reasons"]
    ]


def test_a_plan_prepared_without_trust_is_not_ready(tmp_path):
    control = plane(tmp_path, trusted=False)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    assert receipt["runnable"] is False
    with pytest.raises(ControlPlaneError) as error:
        prepared(control, session, digest, receipt)
    codes = [reason["code"] for reason in error.value.details["blocking_reasons"]]
    assert "publisher_not_trusted" in codes


# -- the boundary holds ------------------------------------------------------
def test_preparing_a_plan_executes_nothing(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    receipt = authorize(control, session, digest)
    state = prepared(control, session, digest, receipt)
    assert state["run_plan"]["execution"]["performed"] is False
    assert "never executes" in state["run_plan"]["execution"]["note"]
    assert control.summary(session)["execution"]["performed"] is False
    assert control.status()["capabilities"]["execute"] is False
    assert control.health()["execution"] == "disabled"


def test_the_session_list_reports_run_plan_state(tmp_path):
    control = plane(tmp_path)
    session, digest = opened(control)
    assert control.list_sessions()["sessions"][0]["run_plan"] == {
        "state": "absent",
        "run_plan_id": None,
        "ready": False,
    }
    receipt = authorize(control, session, digest)
    plan = prepared(control, session, digest, receipt)["run_plan"]
    row = control.list_sessions()["sessions"][0]["run_plan"]
    assert row == {"state": "prepared", "run_plan_id": plan["run_plan_id"], "ready": True}
