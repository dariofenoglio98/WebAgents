"""Profile-scoped approvals in the Python runtime (D-022, D-090).

A publisher-declared profile presents authority and grants none. What choosing
one changes here is narrow: a declared tool *outside* the profile that the
person did not approve is denied rather than a blocker, so a plan may leave it
unbound, and the runtime refuses any call to it. Without a profile, and for
tools inside it, every declared tool still needs its own approval.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_tool_execution import ECHO_TOOL, ToolHarness, authorization
from tool_fakes import registry_for

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.profiles import PROFILES_EXTENSION, read_profiles
from agentpkg.browser.trust import read_public_key_file
from agentpkg.hostbridge.errors import BridgeError
from agentpkg.package import load_package

ROOT = Path(__file__).resolve().parents[2]
WEBAIR = ROOT / "dist/webair-0.4.0.agent.pkg"
WEBAIR_030 = ROOT / "dist/webair-0.3.0.agent.pkg"
KEY = ROOT / "examples/keys/webair-publisher.pub.pem"
SEARCH_TOOLS = ["get-fare-rules", "search-flights"]
SEARCH_PERMISSIONS = ["memory.session", "model.reasoning", "network.webair"]
CATALOG = {
    "schema": "agentpkg-host-model-catalog-v0",
    "host": {
        "runtime": "test-host",
        "runtime_version": "1.0.0",
        "source": "test",
        "captured_at": "2026-09-21T22:00:00+00:00",
    },
    "models": [
        {
            "id": "host/alpha",
            "provider_id": "host",
            "model_id": "alpha",
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
    ],
    "notes": [],
}


@pytest.fixture
def control(tmp_path):
    plane = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    plane.trust_add(read_public_key_file(KEY), display_name="WebAir", publisher_id="webair-demo")
    return plane


def opened(control, path=WEBAIR):
    summary = control.open_file(str(path))
    return summary["session"]["id"], summary["package"]["digest"]


def search_decisions(control, session) -> dict:
    request = control.permissions(session)
    return {
        item["id"]: ("session" if item["id"] in SEARCH_PERMISSIONS else "deny")
        for item in request["permissions"]
    }


def approvals(control, session, approved) -> dict:
    request = control.permissions(session)
    return {item["tool_id"]: item["tool_id"] in approved for item in request["tool_approvals"]}


def prepare(control, session, digest, receipt, *, only=SEARCH_TOOLS, probe=None):
    package = control._session(session).package
    return control.prepare_run_plan(
        session,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id=None if probe else "host/alpha",
        catalog=CATALOG,
        tool_registry=registry_for(package, only=only),
        **({"probe_tool_id": probe, "execution_mode": "tool_probe"} if probe else {}),
    )


# -- reading the extension ---------------------------------------------------
def test_webair_declares_three_valid_profiles_least_authority_first():
    report = read_profiles(load_package(WEBAIR))
    assert report["declared"] is True and report["notes"] == []
    assert [profile["id"] for profile in report["profiles"]] == ["search", "quote", "book"]
    assert sorted(report["profiles"][0]["tools"]) == SEARCH_TOOLS


def test_a_package_without_the_extension_has_no_profiles():
    assert read_profiles(load_package(WEBAIR_030)) == {
        "declared": False,
        "profiles": None,
        "notes": [],
    }


@pytest.mark.parametrize(
    "mutate, note",
    [
        (lambda p: p[0]["tools"].append("no-such-tool"), 'undeclared tool "no-such-tool"'),
        (lambda p: p[0]["permissions"].remove("model.reasoning"), "required permission"),
        (lambda p: p[1].update(id="search"), "duplicate id"),
        (lambda p: p[0]["tools"].append("prepare-booking"), "needs permission"),
        (lambda p: p.reverse(), "least authority first"),
        (lambda p: p[0].update(estimate={"tokens": 10**9}), "exceeds hard_tokens"),
        (lambda p: p[0].update(colour="red"), 'unknown field "colour"'),
    ],
)
def test_an_invalid_value_is_ignored_as_a_whole(mutate, note):
    import copy

    package = load_package(WEBAIR)
    manifest = copy.deepcopy(package.manifest)
    mutate(manifest["extensions"][PROFILES_EXTENSION]["profiles"])
    fake = SimpleNamespace(manifest=manifest, policy=package.policy, tools=package.tools)
    report = read_profiles(fake)
    assert report["declared"] is True and report["profiles"] is None
    assert note in report["notes"][0], report["notes"]


# -- the control plane -------------------------------------------------------
def test_a_profile_lets_tools_outside_it_stay_unapproved_and_unbound(control):
    session, digest = opened(control)
    receipt = control.authorize(
        session,
        package_digest=digest,
        decisions=search_decisions(control, session),
        tool_approvals=approvals(control, session, SEARCH_TOOLS),
        profile_id="search",
    )
    assert receipt["runnable"] is True
    assert receipt["profile"]["id"] == "search"
    assert receipt["profile"]["tool_ids"] == SEARCH_TOOLS
    denied = sorted(set(control._session(session).package.tools) - set(SEARCH_TOOLS))
    assert receipt["profile"]["denied_tool_ids"] == denied
    # A host that implements only the two search tools can run a search.
    prepared = prepare(control, session, digest, receipt)
    plan = prepared["run_plan"]
    assert prepared["preflight"]["ready"] is True, prepared["preflight"]
    assert plan["execution"]["denied_tool_ids"] == denied
    assert plan["execution"]["required_tool_ids"] == SEARCH_TOOLS
    assert sorted(binding["tool_id"] for binding in plan["tool_bindings"]) == SEARCH_TOOLS
    assert all(binding["approved"] for binding in plan["tool_bindings"])
    assert "denied_tool_ids" in plan["execution"]["note"]
    # The lease is issued against that plan like any other.
    lease = control.issue_execution_lease(
        session,
        package_digest=digest,
        run_plan_id=plan["run_plan_id"],
        run_plan_sha256=plan["run_plan_sha256"],
    )
    assert lease["preflight"]["ready"] is True


def test_without_a_profile_every_declared_tool_still_needs_an_approval(control):
    session, digest = opened(control)
    receipt = control.authorize(
        session,
        package_digest=digest,
        decisions=search_decisions(control, session),
        tool_approvals=approvals(control, session, SEARCH_TOOLS),
    )
    # The receipt keeps exactly its earlier shape.
    assert "profile" not in receipt
    with pytest.raises(ControlPlaneError) as refused:
        prepare(control, session, digest, receipt, only=None)
    codes = {reason["code"] for reason in refused.value.details["blocking_reasons"]}
    assert codes == {"tool_not_approved"}


def test_a_tool_inside_the_profile_still_needs_its_approval(control):
    session, digest = opened(control)
    receipt = control.authorize(
        session,
        package_digest=digest,
        decisions=search_decisions(control, session),
        tool_approvals=approvals(control, session, ["search-flights"]),
        profile_id="search",
    )
    assert "get-fare-rules" not in receipt["profile"]["denied_tool_ids"]
    with pytest.raises(ControlPlaneError) as refused:
        prepare(control, session, digest, receipt)
    reasons = refused.value.details["blocking_reasons"]
    assert [(reason["code"], reason["subject"]) for reason in reasons] == [
        ("tool_not_approved", "get-fare-rules")
    ]


def test_a_tool_outside_the_profile_the_person_approved_is_an_ordinary_tool(control):
    session, digest = opened(control)
    receipt = control.authorize(
        session,
        package_digest=digest,
        decisions=search_decisions(control, session),
        tool_approvals=approvals(control, session, [*SEARCH_TOOLS, "prepare-booking"]),
        profile_id="search",
    )
    assert "prepare-booking" not in receipt["profile"]["denied_tool_ids"]
    # Approved, so it needs an implementation and its permissions like any tool.
    with pytest.raises(ControlPlaneError) as refused:
        prepare(control, session, digest, receipt)
    codes = {reason["code"] for reason in refused.value.details["blocking_reasons"]}
    assert "tool_not_bound" in codes


def test_a_probe_of_a_denied_tool_is_refused(control):
    session, digest = opened(control)
    receipt = control.authorize(
        session,
        package_digest=digest,
        decisions=search_decisions(control, session),
        tool_approvals=approvals(control, session, SEARCH_TOOLS),
        profile_id="search",
    )
    with pytest.raises(ControlPlaneError) as refused:
        prepare(control, session, digest, receipt, only=None, probe="prepare-booking")
    codes = {reason["code"] for reason in refused.value.details["blocking_reasons"]}
    assert "tool_not_approved" in codes


def test_an_unknown_or_malformed_profile_is_refused(control):
    session, digest = opened(control)
    for profile_id, code in (("everything", "unknown_profile"), ("", "invalid_request")):
        with pytest.raises(ControlPlaneError) as refused:
            control.authorize(
                session,
                package_digest=digest,
                decisions=search_decisions(control, session),
                profile_id=profile_id,
            )
        assert refused.value.code == code
    # A package without the extension has no profile to choose.
    other, other_digest = opened(control, WEBAIR_030)
    with pytest.raises(ControlPlaneError) as refused:
        control.authorize(other, package_digest=other_digest, decisions={}, profile_id="search")
    assert refused.value.code == "unknown_profile"


# -- the runner ----------------------------------------------------------------
def denied_plan_overrides(**execution):
    return {"execution": {"required_tool_ids": [], "denied_tool_ids": [ECHO_TOOL], **execution}}


def test_the_runner_refuses_a_call_to_a_denied_tool(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            begin = await harness.begin(
                tool_bindings=[],
                authorization_record=authorization(approvals={ECHO_TOOL: False}),
                **denied_plan_overrides(),
            )
            result = await harness.call("execution.run", {})
            await harness.call("execution.end", {})
            return begin, result, harness.host.requests

    begin, result, requests = asyncio.run(main())
    assert begin["capabilities"]["denied_tools"] == [ECHO_TOOL]
    assert begin["capabilities"]["tool_bindings"] == 0
    assert result["status"] == "failed"
    assert result["error_code"] == "permission_denied", result
    # Nothing reached the host.
    assert requests == []


@pytest.mark.parametrize(
    "bindings, approvals, denied",
    [
        ("bound", {ECHO_TOOL: False}, [ECHO_TOOL]),  # denied and bound at once
        ([], {ECHO_TOOL: True}, [ECHO_TOOL]),  # the person approved it
        ([], {ECHO_TOOL: False}, ["no.such.tool"]),  # not declared at all
    ],
)
def test_the_runner_refuses_an_inconsistent_denied_list(tmp_path, bindings, approvals, denied):
    from test_tool_execution import bindings_for

    async def main():
        async with ToolHarness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.begin(
                    tool_bindings=bindings_for(harness.package) if bindings == "bound" else [],
                    authorization_record=authorization(approvals=approvals),
                    execution={"required_tool_ids": [], "denied_tool_ids": denied},
                )
            return error.value, harness.host.requests

    failure, requests = asyncio.run(main())
    assert failure.code == "tool_not_bound"
    assert requests == []
