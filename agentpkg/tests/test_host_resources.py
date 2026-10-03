"""Host-owned resources: requested by a package, held by the host, granted by the person.

Every test uses a synthetic package that asks for the person's work hours, so nothing here
depends on WebAir or any shipped package. The lines being held:

* a package can request a *type* of host resource; it can never name one;
* the person's pick is validated against the host's registry and frozen into the receipt
  and the run plan by opaque id and digest, never by value;
* a plan whose resource changed, disappeared or was never picked is not ready;
* `once` means one run;
* the runner re-checks every grant against the signed package, and refuses an answer the
  host attributes to any resource other than the one granted.
"""

from __future__ import annotations

import asyncio
import copy

import pytest
from resource_fakes import (
    HOURS,
    PERMISSION,
    RESOURCE_TYPE,
    hours_package,
    resource_binding,
    resource_registry,
    tool_registry,
)

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.hostresources import (
    AMBIGUOUS,
    EMPTY,
    KIND_MISMATCH,
    OFFERED,
    grant_staleness,
    normalize_resource_registry,
    normalize_resource_selections,
    resource_requests,
)
from agentpkg.browser.hosttools import (
    binding_digest,
    evaluate_registry,
    normalize_binding,
    normalize_registry,
    plan_tool_bindings,
)
from agentpkg.browser.server import BrowserAPI
from agentpkg.browser.trust import read_public_key_file
from agentpkg.execution.errors import ExecutionError
from agentpkg.execution.policy import check_resource_grants, normalize_resource_grants
from agentpkg.package import canonical_json, sha256
from agentpkg.toolbridge.errors import ToolBridgeError
from agentpkg.toolbridge.handler import tool_handlers

DECISIONS = {PERMISSION: "session", "memory.session": "session", "model.any": "session"}
CATALOG = {
    "schema": "agentpkg-host-model-catalog-v0",
    "host": {"runtime": "test-host", "source": "test", "captured_at": "2026-10-02T00:00:00Z"},
    "models": [
        {
            "id": "host/alpha",
            "provider_id": "host",
            "model_id": "alpha",
            "display_name": "Alpha",
            "available": True,
            "selectable": True,
            "capabilities": {"structured_output": {"value": True, "basis": "declared"}},
            "limits": {"context_tokens": 200000},
            "properties": {"local": True, "tags": []},
        }
    ],
    "notes": [],
}


@pytest.fixture
def hours(tmp_path):
    return hours_package(tmp_path)


@pytest.fixture
def session(tmp_path, hours):
    package, artifact, public = hours
    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    control.trust_add(read_public_key_file(public), display_name="Example test key")
    summary = control.open_file(str(artifact))
    return control, summary["session"]["id"], summary["package"]["digest"]


def authorize(control, session_id, digest, *, decisions=None, pick="hours_weekday", registry=None):
    return control.authorize(
        session_id,
        package_digest=digest,
        decisions=decisions or DECISIONS,
        tool_approvals={RESOURCE_TYPE: True},
        resource_registry=registry or resource_registry(),
        resource_selections={PERMISSION: pick} if pick else None,
    )


def prepare(control, session_id, digest, receipt, *, registry=None):
    return control.prepare_run_plan(
        session_id,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id="host/alpha",
        catalog=CATALOG,
        tool_registry=tool_registry(None),
        resource_registry=registry or resource_registry(),
    )


# -- the registry the host sends -------------------------------------------------------------
def test_a_registry_carries_ids_labels_and_digests_and_refuses_anything_else():
    registry = normalize_resource_registry(resource_registry())
    assert [item["id"] for item in registry["resources"]] == list(HOURS)
    assert len(registry["registry_sha256"]) == 64
    smuggled = resource_registry()
    smuggled["resources"][0]["value"] = HOURS["hours_weekday"]
    with pytest.raises(ControlPlaneError) as caught:
        normalize_resource_registry(smuggled)
    assert caught.value.code == "unknown_field"
    for mutate in (
        lambda r: r["resources"].append(copy.deepcopy(r["resources"][0])),
        lambda r: r["resources"][0].update(type="personal.unknown"),
        lambda r: r["resources"][0].update(digest="not-a-digest"),
        lambda r: r["resources"][0].update(label="line\nbreak"),
        lambda r: r["types"][0].update(permission_kind="network"),
    ):
        broken = resource_registry()
        mutate(broken)
        with pytest.raises(ControlPlaneError):
            normalize_resource_registry(broken)


# -- what a package requests -----------------------------------------------------------------
def test_a_permission_requests_a_type_only_when_the_host_offers_it(tmp_path, hours):
    package, _, _ = hours
    registry = normalize_resource_registry(resource_registry())
    [request] = resource_requests(package, registry)
    assert request["permission_id"] == PERMISSION
    assert (request["status"], request["resource_type"]) == (OFFERED, RESOURCE_TYPE)
    assert [option["resource_id"] for option in request["options"]] == list(HOURS)
    assert request["linked_tools"] == [RESOURCE_TYPE]
    # A host that holds none of that type offers nothing to pick.
    assert (
        resource_requests(package, normalize_resource_registry(resource_registry({})))[0]["status"]
        == EMPTY
    )
    # A host that does not know the type: the scope is an ordinary symbolic scope.
    assert (
        resource_requests(
            package, normalize_resource_registry(resource_registry(types=[]) | {"resources": []})
        )
        == []
    )
    assert resource_requests(package, None) == []


def test_a_package_cannot_relabel_personal_data_or_request_two_types_at_once(tmp_path):
    relabelled, _, _ = hours_package(tmp_path / "a", kind="files.read")
    registry = normalize_resource_registry(resource_registry())
    assert resource_requests(relabelled, registry)[0]["status"] == KIND_MISMATCH
    two = resource_registry()
    two["types"].append({**two["types"][0], "id": "personal.calendar"})
    double, _, _ = hours_package(tmp_path / "b", scopes=[RESOURCE_TYPE, "personal.calendar"])
    request = resource_requests(double, normalize_resource_registry(two))[0]
    assert request["status"] == AMBIGUOUS and request["options"] == []


# -- the person's pick -----------------------------------------------------------------------
def test_a_pick_becomes_a_grant_by_id_and_digest_only(hours):
    package, _, _ = hours
    registry = normalize_resource_registry(resource_registry())
    [grant] = normalize_resource_selections(
        package, registry, DECISIONS, {PERMISSION: "hours_early"}
    )
    assert grant == {
        "permission_id": PERMISSION,
        "resource_type": RESOURCE_TYPE,
        "resource_id": "hours_early",
        "resource_digest": registry["resources"][1]["digest"],
    }
    assert "07:00" not in str(grant)


@pytest.mark.parametrize(
    ("decisions", "selections", "code"),
    [
        (DECISIONS, None, "resource_selection_required"),
        (
            {**DECISIONS, PERMISSION: "deny"},
            {PERMISSION: "hours_weekday"},
            "resource_selection_denied",
        ),
        (DECISIONS, {PERMISSION: "hours_guessed"}, "resource_unknown"),
        (
            DECISIONS,
            {"memory.session": "hours_weekday", PERMISSION: "hours_weekday"},
            "resource_not_requested",
        ),
        (DECISIONS, {"no.such": "hours_weekday"}, "unknown_permission"),
    ],
)
def test_every_bad_pick_is_refused_with_its_own_code(hours, decisions, selections, code):
    package, _, _ = hours
    registry = normalize_resource_registry(resource_registry())
    with pytest.raises(ControlPlaneError) as caught:
        normalize_resource_selections(package, registry, decisions, selections)
    assert caught.value.code == code


def test_a_pick_without_a_registry_is_refused(hours):
    package, _, _ = hours
    with pytest.raises(ControlPlaneError) as caught:
        normalize_resource_selections(package, None, DECISIONS, {PERMISSION: "hours_weekday"})
    assert caught.value.code == "resource_registry_missing"


# -- receipts, plans and their readiness -----------------------------------------------------
def test_the_receipt_and_plan_freeze_the_pick_and_the_preflight_rechecks_it(session):
    control, session_id, digest = session
    view = control.evaluate_resources(
        session_id, package_digest=digest, resource_registry=resource_registry()
    )
    assert view["requests"][0]["selected_resource_id"] is None
    receipt = authorize(control, session_id, digest)
    assert receipt["resource_grants"][0]["resource_id"] == "hours_weekday"
    assert receipt["resource_registry"]["resource_count"] == 2
    other = authorize(control, session_id, digest, pick="hours_early")
    assert other["receipt_sha256"] != receipt["receipt_sha256"]
    state = prepare(control, session_id, digest, other)
    plan = state["run_plan"]
    assert plan["resource_grants"] == other["resource_grants"]
    assert plan["resource_registry"]["registry_sha256"]
    assert state["preflight"]["ready"] is True
    assert state["preflight"]["resource_grants"] == {
        "granted": 1,
        "current": True,
        "evaluated": True,
        "registry_sha256": plan["resource_registry"]["registry_sha256"],
    }
    [bound] = plan["tool_bindings"]
    assert bound["resource_type"] == RESOURCE_TYPE
    after = control.evaluate_resources(
        session_id, package_digest=digest, resource_registry=resource_registry()
    )
    assert after["requests"][0]["selected_resource_id"] == "hours_early"

    # The host's value changed: the same id is a different resource now.
    changed = copy.deepcopy(HOURS)
    changed["hours_early"]["end"] = "16:00"
    control.evaluate_resources(
        session_id, package_digest=digest, resource_registry=resource_registry(changed)
    )
    stale = control.run_plan(session_id)["preflight"]
    assert stale["stale"] is True
    assert [r["code"] for r in stale["stale_reasons"]] == ["resource_changed"]
    with pytest.raises(ControlPlaneError) as caught:
        control.issue_execution_lease(
            session_id,
            package_digest=digest,
            run_plan_id=plan["run_plan_id"],
            run_plan_sha256=plan["run_plan_sha256"],
        )
    assert caught.value.code == "run_plan_stale"
    # And removed altogether.
    control.evaluate_resources(
        session_id,
        package_digest=digest,
        resource_registry=resource_registry({"hours_weekday": HOURS["hours_weekday"]}),
    )
    assert [r["code"] for r in control.run_plan(session_id)["preflight"]["stale_reasons"]] == [
        "resource_removed"
    ]


def test_a_grant_with_no_pick_never_makes_a_ready_plan(session):
    control, session_id, digest = session
    # Authorized without a host registry, so nothing could be picked.
    receipt = control.authorize(
        session_id,
        package_digest=digest,
        decisions=DECISIONS,
        tool_approvals={RESOURCE_TYPE: True},
    )
    assert receipt["resource_grants"] == []
    with pytest.raises(ControlPlaneError) as caught:
        prepare(control, session_id, digest, receipt)
    reasons = caught.value.details["blocking_reasons"]
    assert [r["code"] for r in reasons] == ["resource_not_selected"]


def test_a_plan_is_not_prepared_against_a_resource_that_already_changed(session):
    control, session_id, digest = session
    receipt = authorize(control, session_id, digest)
    changed = copy.deepcopy(HOURS)
    changed["hours_weekday"]["timezone"] = "UTC"
    with pytest.raises(ControlPlaneError) as caught:
        prepare(control, session_id, digest, receipt, registry=resource_registry(changed))
    assert caught.value.details["blocking_reasons"][0]["code"] == "resource_changed"


def test_once_means_one_run(session):
    control, session_id, digest = session
    receipt = authorize(control, session_id, digest, decisions={**DECISIONS, PERMISSION: "once"})
    plan = prepare(control, session_id, digest, receipt)["run_plan"]
    first = control.issue_execution_lease(
        session_id,
        package_digest=digest,
        run_plan_id=plan["run_plan_id"],
        run_plan_sha256=plan["run_plan_sha256"],
    )
    control.release_execution_lease(session_id, first["lease"]["lease_id"])
    state = control.run_plan(session_id)["preflight"]
    assert [r["code"] for r in state["stale_reasons"]] == ["authorization_once_spent"]
    with pytest.raises(ControlPlaneError) as caught:
        control.issue_execution_lease(
            session_id,
            package_digest=digest,
            run_plan_id=plan["run_plan_id"],
            run_plan_sha256=plan["run_plan_sha256"],
        )
    assert caught.value.code == "run_plan_stale"
    # A new decision is a new receipt, and runs again.
    again = authorize(control, session_id, digest, decisions={**DECISIONS, PERMISSION: "once"})
    assert prepare(control, session_id, digest, again)["preflight"]["ready"] is True


def test_session_grants_are_not_spent_by_a_run(session):
    control, session_id, digest = session
    receipt = authorize(control, session_id, digest)
    plan = prepare(control, session_id, digest, receipt)["run_plan"]
    lease = control.issue_execution_lease(
        session_id,
        package_digest=digest,
        run_plan_id=plan["run_plan_id"],
        run_plan_sha256=plan["run_plan_sha256"],
    )
    control.release_execution_lease(session_id, lease["lease"]["lease_id"])
    assert control.run_plan(session_id)["preflight"]["ready"] is True


def test_the_http_api_routes_resource_evaluation_and_picks(session):
    control, session_id, digest = session
    api = BrowserAPI(control)
    status, body = api.dispatch(
        "POST",
        f"/v0/packages/{session_id}/resources/evaluate",
        {"package_digest": digest, "resource_registry": resource_registry()},
    )
    assert status == 200 and body["requests"][0]["status"] == OFFERED
    status, receipt = api.dispatch(
        "POST",
        f"/v0/packages/{session_id}/authorize",
        {
            "package_digest": digest,
            "decisions": DECISIONS,
            "tool_approvals": {RESOURCE_TYPE: True},
            "resource_registry": resource_registry(),
            "resource_selections": {PERMISSION: "hours_weekday"},
        },
    )
    assert status == 201 and receipt["resource_grants"][0]["resource_id"] == "hours_weekday"


def test_staleness_is_conservative_without_a_registry():
    grant = {
        "permission_id": PERMISSION,
        "resource_type": RESOURCE_TYPE,
        "resource_id": "hours_weekday",
        "resource_digest": "0" * 64,
    }
    assert [r["code"] for r in grant_staleness([grant], None)] == ["resource_registry_unknown"]
    assert grant_staleness([], None) == []


# -- the host_resource binding category ------------------------------------------------------
def test_a_host_resource_binding_names_its_type_and_nothing_else_may(hours):
    package, _, _ = hours
    binding = normalize_binding(resource_binding(package), index=0)
    assert binding["resource_type"] == RESOURCE_TYPE and binding["remote"] is False
    missing = resource_binding(package)
    del missing["resource_type"]
    with pytest.raises(ControlPlaneError):
        normalize_binding(missing, index=0)
    other = {**resource_binding(package), "implementation_kind": "local_builtin"}
    with pytest.raises(ControlPlaneError):
        normalize_binding(other, index=0)
    # Its type is part of what it would do.
    retyped = normalize_binding(
        {**resource_binding(package), "resource_type": "personal.other"}, index=0
    )
    assert retyped["binding_sha256"] != binding["binding_sha256"]


def test_existing_binding_digests_are_unchanged_by_the_new_category(hours):
    """A binding of any earlier category hashes exactly the subject it always did."""
    package, _, _ = hours
    record = {**resource_binding(package), "implementation_kind": "local_builtin"}
    del record["resource_type"]
    binding = normalize_binding(record, index=0)
    assert "resource_type" not in binding
    subject = {
        "schema": "agentpkg-tool-binding-digest-v0",
        "binding_id": binding["id"],
        "tool_id": binding["tool_id"],
        "binding": binding["binding"],
        "implementation_kind": binding["implementation_kind"],
        "implementation_id": binding["implementation_id"],
        "implementation_version": binding["implementation_version"],
        "remote": binding["remote"],
        "endpoint": binding["endpoint"],
        "contract": binding["contract"],
        "limits": binding["limits"],
        "credentials": binding["credentials"],
    }
    assert binding_digest(binding) == sha256(canonical_json(subject))
    evaluation = evaluate_registry(
        package,
        normalize_registry(tool_registry(package)),
        decisions=DECISIONS,
        tool_approvals={RESOURCE_TYPE: True},
    )
    [planned] = plan_tool_bindings(evaluation)
    assert planned["resource_type"] == RESOURCE_TYPE
    assert evaluation["tools"][0]["status"] == "bound"


# -- the runner's own checks -----------------------------------------------------------------
GRANT = {
    "permission_id": PERMISSION,
    "resource_type": RESOURCE_TYPE,
    "resource_id": "hours_weekday",
    "resource_digest": "a" * 64,
}


def test_the_runner_rederives_every_grant_from_the_signed_package(hours):
    package, _, _ = hours
    assert normalize_resource_grants([GRANT]) == [GRANT]
    report = check_resource_grants(package, [GRANT], DECISIONS)
    assert report["grants"] == [{**GRANT, "decision": "session"}]
    for broken in (
        {**GRANT, "permission_id": "memory.session"},
        {**GRANT, "resource_type": "personal.other"},
        {**GRANT, "permission_id": "no.such"},
    ):
        with pytest.raises(ExecutionError):
            check_resource_grants(package, [broken], DECISIONS)
    with pytest.raises(ExecutionError) as caught:
        check_resource_grants(package, [GRANT], {**DECISIONS, PERMISSION: "deny"})
    assert caught.value.code == "execution_permission_denied"
    for malformed in ([{**GRANT, "value": "09:00"}], [GRANT, GRANT], "not a list"):
        with pytest.raises(ExecutionError):
            normalize_resource_grants(malformed)


class _Context:
    def __init__(self):
        self.events = []

    def event(self, action, **metadata):
        self.events.append({"action": action, **metadata})


class _Peer:
    def __init__(self, answer):
        self.answer = answer

    async def call(self, method, params, timeout):
        return {
            **self.answer,
            "tool_id": params["tool_id"],
            "binding_id": params["binding_id"],
            "binding_sha256": params["binding_sha256"],
        }


def _handler(hours, answer, grants=(GRANT,)):
    package, _, _ = hours
    evaluation = evaluate_registry(
        package,
        normalize_registry(tool_registry(package)),
        decisions=DECISIONS,
        tool_approvals={RESOURCE_TYPE: True},
    )
    bindings = plan_tool_bindings(evaluation)
    return tool_handlers(_Peer(answer), bindings, resource_grants=list(grants))[
        f"host.resource.{RESOURCE_TYPE}"
    ]


def test_the_runner_accepts_only_an_answer_attributed_to_the_granted_resource(hours):
    value = HOURS["hours_weekday"]
    ok = {"status": "ok", "output": value, "remote": False, "resource": dict(GRANT)}
    context = _Context()
    assert asyncio.run(_handler(hours, ok)(context, {})) == value
    settled = [e for e in context.events if e["action"] == "tool.settled"][0]
    assert (settled["resource_id"], settled["resource_digest"]) == ("hours_weekday", "a" * 64)
    assert "09:00" not in str(context.events)
    for resource in (
        {**GRANT, "resource_id": "hours_early"},
        {**GRANT, "resource_digest": "b" * 64},
        {**GRANT, "permission_id": "memory.session"},
    ):
        with pytest.raises(ToolBridgeError) as caught:
            asyncio.run(_handler(hours, {**ok, "resource": resource})(_Context(), {}))
        assert caught.value.code == "tool_binding_stale"
    with pytest.raises(ToolBridgeError):
        asyncio.run(
            _handler(hours, {k: v for k, v in ok.items() if k != "resource"})(_Context(), {})
        )
    # With no grant at all, nothing the host says can be accepted.
    with pytest.raises(ToolBridgeError):
        asyncio.run(_handler(hours, ok, grants=())(_Context(), {}))
