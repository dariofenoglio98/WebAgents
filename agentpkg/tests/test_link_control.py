"""Agent Links in the control plane (link.v0 §3, L-10…L-17, L-20, L-22): each dependency is a
package session of its own, authorized through the ordinary path with its own receipt and inner
Run Plan; the caller's plan records the links and re-verification covers the inner plans. The
control plane prepares and never runs."""

import pytest
from link_probe import scenario, write
from tool_fakes import registry_for

from agentpkg.browser import ControlPlane, ControlPlaneConfig
from agentpkg.browser.errors import ControlPlaneError
from agentpkg.browser.trust import read_public_key_file
from agentpkg.package import build_package
from agentpkg.signing import sign_package

CATALOG = {
    "schema": "agentpkg-host-model-catalog-v0",
    "host": {"runtime": "test", "source": "test", "captured_at": "2026-11-15T12:00:00+00:00"},
    "models": [
        {
            "id": f"host/{name}",
            "provider_id": "host",
            "model_id": name,
            "display_name": name.title(),
            "available": True,
            "selectable": True,
            "capabilities": {
                "reasoning": {"value": True, "basis": "declared"},
                "structured_output": {"value": True, "basis": "declared"},
            },
            "limits": {"context_tokens": 200000},
            # Local: the probe's packages allow no remote call, and a remote route costs two per
            # model call (the count and the completion).
            "properties": {"local": True, "tags": []},
        }
        for name in ("alpha", "beta")
    ],
    "notes": [],
}


class Stack:
    """One control plane with a caller opened from the probe and the probe's keys pinned."""

    def __init__(self, tmp_path, keys, variant=None, *, trust=True, transport=None, name="one"):
        self.built = write(tmp_path / name, scenario(variant), keys)
        unsigned = build_package(self.built.caller, tmp_path / f"{name}-caller.unsigned.agent.pkg")
        self.archive = sign_package(
            unsigned, keys["default"][0], tmp_path / f"{name}-caller.agent.pkg"
        )
        self.control = ControlPlane(
            ControlPlaneConfig(
                cache_dir=str(tmp_path / f"{name}-cache"),
                trust_store_path=str(tmp_path / f"{name}-trust.json"),
            ),
            transport=transport,
        )
        if trust:
            for label, (_, public) in keys.items():
                self.control.trust_add(read_public_key_file(public), display_name=label)
        self.summary = self.control.open_file(str(self.archive))
        self.session = self.summary["session"]["id"]
        self.digest = self.summary["package"]["digest"]

    def resolve(self, **options):
        archives = {name: str(path) for name, path in self.built.archives.items()}
        return self.control.resolve_links(
            self.session, package_digest=self.digest, archives=archives, **options
        )

    def plan(self, session, digest, model="host/alpha"):
        """Authorize a session with everything it asks for and prepare its plan."""
        control = self.control
        request = control.permissions(session)
        receipt = control.authorize(
            session,
            package_digest=digest,
            decisions={p["id"]: "session" for p in request["permissions"]},
            tool_approvals={t["tool_id"]: True for t in request["tool_approvals"]},
        )
        package = control._session(session).package
        registry = registry_for(package) if package.tools else None
        return control.prepare_run_plan(
            session,
            package_digest=digest,
            receipt_id=receipt["receipt_id"],
            model_id=model,
            catalog=CATALOG,
            tool_registry=registry,
        )

    def plan_links(self, review, model="host/alpha", skip=()):
        return {
            link["dependency"]: self.plan(link["session_id"], link["package"]["digest"], model)
            for link in review["links"]
            if link["dependency"] not in skip
        }

    def plan_caller(self, model="host/alpha"):
        return self.plan(self.session, self.digest, model)


def refusal(call):
    with pytest.raises(ControlPlaneError) as failure:
        call()
    return failure.value


def blockers(error):
    assert error.code == "run_plan_refused"
    return [reason["code"] for reason in error.details["blocking_reasons"]]


def test_a_caller_cannot_be_planned_before_its_links_are_resolved_and_decided(tmp_path, keys):
    stack = Stack(tmp_path, keys)
    warning = next(w for w in stack.summary["warnings"] if w["code"] == "links_declared")
    assert warning["severity"] == "info" and "2 other package(s)" in warning["message"]
    assert blockers(refusal(stack.plan_caller)) == ["link_unresolved"]
    review = stack.resolve()
    assert review["resolved"] and [link["dependency"] for link in review["links"]] == [
        "index",
        "scribe",
    ]
    assert [link["decision"] for link in review["links"]] == ["undecided", "undecided"]
    assert blockers(refusal(stack.plan_caller)) == ["link_undecided", "link_undecided"]
    stack.plan_links(review, skip=("scribe",))
    assert blockers(refusal(stack.plan_caller)) == ["link_undecided"]


def test_the_review_shows_each_publisher_as_the_persons_own_store_sees_it(tmp_path, keys):
    stack = Stack(tmp_path, keys, trust=False)
    stack.control.trust_add(read_public_key_file(keys["default"][1]), display_name="caller")
    stack.control.trust_add(read_public_key_file(keys["index"][1]), display_name="index")
    review = stack.resolve()
    # The caller is trusted and so is index's key; scribe's key is not: a caller vouches for
    # nothing (L-12), and the two linked packages are two publishers.
    trust = {link["dependency"]: link["publisher"]["trust_status"] for link in review["links"]}
    assert trust == {"index": "trusted", "scribe": "unknown"}
    assert len(review["publishers"]) == 2
    assert all(link["publisher"]["signature_status"] == "valid" for link in review["links"])
    assert review["composed"]["resolved"] is True
    assert review["composed"]["worst_case"]["model_calls"] == 9
    assert review["links"][1]["worst_case"]["tokens"] == 1500
    # An untrusted linked publisher cannot be authorized into a runnable receipt.
    scribe = review["links"][1]
    error = refusal(lambda: stack.plan(scribe["session_id"], scribe["package"]["digest"]))
    assert "publisher_not_trusted" in blockers(error)


def test_each_link_has_its_own_receipt_and_inner_plan_and_the_callers_plan_binds_them(
    tmp_path, keys
):
    stack = Stack(tmp_path, keys)
    review = stack.resolve()
    inner = stack.plan_links(review)
    for name, state in inner.items():
        plan = state["run_plan"]
        assert plan["parent"] == {"package_digest": stack.digest, "dependency": name}
        assert plan["package"]["package_id"].endswith(name)
        assert plan["authorization"]["receipt_id"] != stack.control._session(stack.session).receipt
    state = stack.plan_caller()
    plan = state["run_plan"]
    assert state["preflight"]["ready"] and state["preflight"]["links"] == {
        "planned": 2,
        "current": True,
    }
    assert "parent" not in plan
    assert {name: entry["decision"] for name, entry in plan["links"].items()} == {
        "index": "accepted",
        "scribe": "accepted",
    }
    for name, entry in plan["links"].items():
        assert entry["plan_hash"] == inner[name]["run_plan"]["run_plan_sha256"]
        assert entry["digest"] == inner[name]["run_plan"]["package"]["digest"]
        assert entry["trust"] == "trusted"
    # The envelope the plan states is the composed one (L-22).
    assert plan["execution"]["network"]["worst_case"]["model_calls"] == 9
    assert plan["execution"]["network"]["worst_case"]["tool_calls"] == {"index:lookup": 2}
    # Desk four times, index twice, scribe once: below the caller's own cap of 11,000.
    assert plan["execution"]["links"]["worst_case"]["tokens"] == 4 * 2000 + 2 * 1 + 1500
    decisions = [link["decision"] for link in stack.control.links(stack.session)["links"]]
    assert decisions == ["accepted", "accepted"]


def test_an_inner_plan_on_another_model_does_not_count(tmp_path, keys):
    stack = Stack(tmp_path, keys)
    stack.plan_links(stack.resolve(), model="host/beta")
    assert blockers(refusal(stack.plan_caller)) == ["link_undecided", "link_undecided"]


def test_re_verification_covers_the_inner_plans(tmp_path, keys):
    stack = Stack(tmp_path, keys)
    review = stack.resolve()
    stack.plan_links(review)
    plan = stack.plan_caller()["run_plan"]
    index = review["links"][0]

    def stale():
        state = stack.control.run_plan(stack.session)["preflight"]
        return state["ready"], [reason["code"] for reason in state["stale_reasons"]]

    assert stale() == (True, [])
    stack.control.clear_run_plan(index["session_id"])
    assert stale() == (False, ["link_plan_cleared"])
    lease = refusal(
        lambda: stack.control.issue_execution_lease(
            stack.session,
            package_digest=stack.digest,
            run_plan_id=plan["run_plan_id"],
            run_plan_sha256=plan["run_plan_sha256"],
        )
    )
    assert lease.code == "run_plan_stale"
    # A new inner plan is another plan: the caller's names the one the person saw.
    stack.plan(index["session_id"], index["package"]["digest"])
    assert stale() == (False, ["link_plan_changed"])
    # A changed trust store reaches a linked publisher as it reaches any.
    fresh = Stack(tmp_path, keys, name="two")
    review = fresh.resolve()
    fresh.plan_links(review)
    fresh.plan_caller()
    scribe = review["links"][1]["publisher"]["signer_fingerprint"]
    fresh.control.trust_remove(scribe)
    state = fresh.control.run_plan(fresh.session)["preflight"]
    assert not state["ready"]
    assert "link_plan_stale" in [reason["code"] for reason in state["stale_reasons"]]


def test_an_inner_plan_prepared_for_another_caller_is_refused(tmp_path, keys):
    """N-34 in the control plane: a caller's plan whose link points at an inner plan with
    another parent is stale, whatever its hash."""
    stack = Stack(tmp_path, keys)
    review = stack.resolve()
    stack.plan_links(review)
    stack.plan_caller()
    other = Stack(tmp_path, keys, "planned-walk", name="two")
    assert other.digest != stack.digest
    foreign = write(tmp_path / "foreign", scenario("planned-walk"), keys)
    opened = stack.control.open_file(str(other.archive))
    twin, twin_digest = opened["session"]["id"], opened["package"]["digest"]
    twin_review = stack.control.resolve_links(
        twin,
        package_digest=twin_digest,
        archives={name: str(path) for name, path in foreign.archives.items()},
    )
    foreign_index = twin_review["links"][0]
    stack.plan(foreign_index["session_id"], foreign_index["package"]["digest"])
    caller = stack.control._session(stack.session)
    caller.links["index"] = foreign_index["session_id"]
    state = stack.control.run_plan(stack.session)["preflight"]
    assert not state["ready"]
    assert [reason["code"] for reason in state["stale_reasons"]] == ["link_plan_parent_mismatch"]


def test_a_denied_link_is_stated_in_the_plan_and_left_out_of_the_envelope(tmp_path, keys):
    stack = Stack(tmp_path, keys)
    review = stack.resolve()
    stack.plan_links(review, skip=("index",))
    denied = stack.control.decide_link(
        stack.session, package_digest=stack.digest, dependency="index", decision="denied"
    )
    assert [link["decision"] for link in denied["links"]] == ["denied", "accepted"]
    plan = stack.plan_caller()["run_plan"]
    assert plan["links"]["index"]["decision"] == "denied"
    assert plan["links"]["index"]["plan_hash"] is None
    assert plan["links"]["scribe"]["plan_hash"] is not None
    worst = plan["execution"]["network"]["worst_case"]
    assert worst["activations"]["Lookup"] == 0 and worst["tool_calls"] == {}
    # Withdrawing the denial clears the caller's plan: the decision changed.
    stack.control.decide_link(
        stack.session, package_digest=stack.digest, dependency="index", decision="undecided"
    )
    assert refusal(lambda: stack.control.run_plan(stack.session)).code == "run_plan_absent"
    assert blockers(refusal(stack.plan_caller)) == ["link_undecided"]


def test_denying_one_dependency_denies_its_publishers_key(tmp_path, keys):
    stack = Stack(tmp_path, {"default": keys["default"]})
    stack.resolve()
    review = stack.control.decide_link(
        stack.session, package_digest=stack.digest, dependency="index", decision="denied"
    )
    assert [link["decision"] for link in review["links"]] == ["denied", "denied"]
    assert len(review["publishers"]) == 1


@pytest.mark.parametrize(
    "variant, code",
    [
        ("digest-mismatch", "link_digest_mismatch"),
        ("signer-mismatch", "link_signer_mismatch"),
        ("identity-mismatch", "link_identity_mismatch"),
        ("signature-absent", "link_signature_invalid"),
        ("target-conversational", "link_target_conversational"),
        ("nested", "link_nested"),
        ("nested-slot", "link_nested"),
    ],
)
def test_resolution_refuses_as_the_cases_say_and_leaves_no_session(tmp_path, keys, variant, code):
    stack = Stack(tmp_path, keys, variant)
    error = refusal(stack.resolve)
    assert error.code == code
    assert [s["session_id"] for s in stack.control.list_sessions()["sessions"]] == [stack.session]
    assert stack.control.links(stack.session)["links"] == []


def test_a_composition_the_callers_budget_cannot_hold_blocks_the_plan(tmp_path, keys):
    stack = Stack(tmp_path, keys, "bound-exceeds-budget")
    stack.plan_links(stack.resolve())
    assert blockers(refusal(stack.plan_caller)) == ["link_bound_exceeds_budget"]


def test_a_dependency_without_a_supplied_archive_is_fetched_from_its_locator(tmp_path, keys):
    asked = []
    built = write(tmp_path / "served", scenario(), keys)

    def transport(url, limits):
        asked.append(url)
        name = url.rsplit("/", 1)[1].split(".")[0]
        return built.archives[name].read_bytes()

    stack = Stack(tmp_path, keys, transport=transport)
    review = stack.control.resolve_links(stack.session, package_digest=stack.digest)
    assert asked == [
        "https://packages.example/index.agent.pkg",
        "https://packages.example/scribe.agent.pkg",
    ]
    assert review["resolved"] and len(review["links"]) == 2

    def refuses(url, limits):
        raise ControlPlaneError("download_failed", "no route", status=502)

    failing = Stack(tmp_path, keys, transport=refuses, name="two")
    error = refusal(
        lambda: failing.control.resolve_links(failing.session, package_digest=failing.digest)
    )
    assert error.code == "link_fetch_failed" and error.details["cause"] == "download_failed"
    # A local path is never reachable through a locator: the URL policy refuses it first.
    assert (
        refusal(
            lambda: stack.control.resolve_links(
                stack.session, package_digest=stack.digest, archives={"nobody": "/tmp/x"}
            )
        ).code
        == "link_dependency_unknown"
    )


def test_a_linked_session_dies_with_its_caller(tmp_path, keys):
    stack = Stack(tmp_path, keys)
    stack.resolve()
    assert len(stack.control.list_sessions()["sessions"]) == 3
    stack.control.close(stack.session)
    assert stack.control.list_sessions()["sessions"] == []


def test_the_loopback_api_resolves_reviews_and_denies(tmp_path, keys):
    from agentpkg.browser.server import API_VERSION, BrowserAPI

    built = write(tmp_path / "served", scenario(), keys)

    def transport(url, limits):
        return built.archives[url.rsplit("/", 1)[1].split(".")[0]].read_bytes()

    stack = Stack(tmp_path, keys, transport=transport)
    api = BrowserAPI(stack.control)
    base = f"/{API_VERSION}/packages/{stack.session}/links"
    assert api.dispatch("GET", base, None)[1]["links"] == []
    status, review = api.dispatch("POST", f"{base}/resolve", {"package_digest": stack.digest})
    assert status == 200 and len(review["links"]) == 2
    status, review = api.dispatch(
        "POST",
        f"{base}/decide",
        {"package_digest": stack.digest, "dependency": "scribe", "decision": "denied"},
    )
    assert [link["decision"] for link in review["links"]] == ["undecided", "denied"]
    # A local archive is never named over the API.
    with pytest.raises(ControlPlaneError) as error:
        api.dispatch(
            "POST", f"{base}/resolve", {"package_digest": stack.digest, "archives": {"index": "/x"}}
        )
    assert error.value.code == "unknown_field"
