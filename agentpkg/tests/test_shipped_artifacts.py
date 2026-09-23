"""What the shipped reference artifacts must keep being true.

These are release-content assertions, not runtime behaviour: nothing here
teaches the interpreter anything about a package. They exist because
`meeting-agenda` was republished as **0.2.1** with a changed *timing policy* and
a **rotated signing key**, and both of those are the kind of change that is easy
to make quietly. The point of this module is that neither can happen again
without a test saying so.

Three things stay separable throughout, and the tests keep them separate:

* **package timing policy** — the numbers in `graph.json`, which travel inside
  the signed bytes;
* **host execution limits** — what `agentpkg.execution.policy` allows, which can
  only lower what a package declares;
* **provider latency** — what a model actually takes, which neither of the above
  controls.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from shipped_keys import AGENDA_FINGERPRINT, AGENDA_KEY, DIST, ORIGINAL_KEY, PACKAGE_ID

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.trust import read_public_key_file
from agentpkg.execution.policy import (
    DEFAULT_RUN_TIMEOUT_SECONDS,
    HostExecutionLimits,
    effective_deadline_seconds,
)
from agentpkg.package import build_package, load_package
from agentpkg.signing import verify_package

ROOT = Path(__file__).resolve().parents[2]
AGENDA = DIST["meeting-agenda"]
AGENDA_SOURCE = ROOT / "agents/meeting-agenda"
PREVIOUS = ROOT / "dist/meeting-agenda-0.2.0.agent.pkg"

CATALOG = {
    "schema": "agentpkg-host-model-catalog-v0",
    "host": {"runtime": "test", "source": "test", "captured_at": "2026-09-23T00:00:00+00:00"},
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

# The 0.2.1 timing policy, and the measurement each number answers to. Local
# figures are from `examples/verification/model-availability-latency.json` and
# `meeting-agenda-local-step-latency.json`, both taken on `ollama/qwen3.5:9b`.
TIMING_POLICY = {
    # node id (or "map/step"): (seconds, worst measured seconds)
    "plan": (120, 28.7),
    "perspectives": (360, 229.0),
    "perspectives/one-perspective": (300, 229.0),
    "join": (120, 0.0),
    "write": (300, 217.6),
    "validate": (120, 0.0),
    "output": (120, 0.0),
}
DEADLINE_SECONDS = 600


def graph_of(package):
    return {node["id"]: node for node in package.graph["nodes"]}


@pytest.fixture(scope="module")
def agenda():
    return load_package(AGENDA)


# -- the version bump --------------------------------------------------------
def test_the_shipped_agenda_artifact_is_the_republished_version(agenda):
    assert agenda.manifest["package_id"] == "org.webagents.meeting-agenda"
    assert agenda.manifest["version"] == "0.2.1"
    # The container format and the runtime contract did not move with it.
    assert agenda.manifest["runtime"]["minimum_version"] == "0.2.0"
    assert agenda.manifest["entrypoint"] == "workflow.v0"
    assert agenda.graph["profile"] == "workflow.v0"


def test_the_shipped_artifact_matches_its_source_tree(agenda, tmp_path):
    """No hand-edited artifact: the bytes come from `agents/meeting-agenda`."""
    rebuilt = load_package(build_package(AGENDA_SOURCE, tmp_path / "rebuilt.agent.pkg"))
    assert rebuilt.digest == agenda.digest
    assert rebuilt.manifest["version"] == agenda.manifest["version"]


def test_the_previous_version_is_preserved_unchanged():
    previous = load_package(PREVIOUS)
    assert previous.manifest["version"] == "0.2.0"
    assert previous.digest != load_package(AGENDA).digest
    # 0.2.0 still verifies under the key that actually signed it.
    assert verify_package(PREVIOUS, ORIGINAL_KEY)["valid"]
    assert previous.graph["deadline_seconds"] == 300


# -- what changed, and only that ---------------------------------------------
def test_only_the_timing_policy_changed_between_the_two_versions():
    """Every other member of the graph is byte-identical across the bump."""
    before, after = load_package(PREVIOUS).graph, load_package(AGENDA).graph

    def without_timing(graph):
        graph = json.loads(json.dumps(graph))
        graph.pop("deadline_seconds")
        for node in graph["nodes"]:
            node.pop("timeout_seconds")
            for step in node.get("steps", []):
                step.pop("timeout_seconds")
        return graph

    assert without_timing(before) == without_timing(after)


def test_the_declared_timing_policy_is_exactly_what_was_measured(agenda):
    nodes = graph_of(agenda)
    assert agenda.graph["deadline_seconds"] == DEADLINE_SECONDS
    for name, (declared, measured) in TIMING_POLICY.items():
        node_id, _, step_id = name.partition("/")
        node = nodes[node_id]
        operation = (
            next(step for step in node["steps"] if step["id"] == step_id) if step_id else node
        )
        assert operation["timeout_seconds"] == declared, name
        # Evidence-based, not arbitrary: above what was measured, not unbounded.
        assert declared > measured, name
        assert declared <= 4 * max(measured, 30.0) or measured == 0.0, name


def test_the_graph_deadline_does_not_exceed_this_host_s_own_run_timeout(agenda):
    """Package timing policy and host limits are separate; the host still wins.

    The package may declare any deadline it likes. What a run actually gets is
    the tighter of the two, so a package cannot buy itself more wall clock by
    asking for it.
    """
    limits = HostExecutionLimits()
    assert limits.run_timeout_seconds == DEFAULT_RUN_TIMEOUT_SECONDS
    assert effective_deadline_seconds(agenda, limits) == DEADLINE_SECONDS
    tighter = HostExecutionLimits.normalize({"run_timeout_seconds": 120})
    assert effective_deadline_seconds(agenda, tighter) == 120


# -- what must not have changed ----------------------------------------------
def test_the_worker_topology_is_unchanged(agenda):
    workers = {worker["id"]: worker for worker in agenda.graph["workers"]}
    assert sorted(workers) == ["Coordinator", "Perspective", "Planner", "Writer"]
    assert workers["Perspective"]["max_instances"] == 3
    assert all(worker["budget"]["tokens"] == 30000 for worker in workers.values())
    assert agenda.graph["coordinator"] == "Coordinator"
    assert [node["type"] for node in agenda.graph["nodes"]] == [
        "llm",
        "map",
        "join",
        "llm",
        "validate",
        "output",
    ]


def test_real_parallelism_is_preserved(agenda):
    """The map was not serialized to dodge the timeout."""
    perspectives = graph_of(agenda)["perspectives"]
    assert perspectives["max_parallel"] == 3
    assert perspectives["max_items"] == 12
    assert agenda.policy["budget"]["max_parallel_workers"] == 3


def test_budgets_permissions_and_assertions_are_unchanged(agenda):
    budget = agenda.policy["budget"]
    assert budget["hard_tokens"] == 180000
    assert budget["estimated_tokens"] == 12000
    assert budget["max_remote_calls"] == 32
    assert sorted(item["id"] for item in agenda.policy["permissions"]) == [
        "memory.session",
        "model.reasoning",
    ]
    assert [item["kind"] for item in graph_of(agenda)["validate"]["assertions"]] == [
        "equal",
        "equal",
        "sum",
    ]
    assert [task["id"] for task in agenda.manifest["model_requirements"]["tasks"]] == [
        "plan",
        "perspective",
        "write",
    ]
    assert agenda.manifest["model_requirements"]["fallback_policy"] == "deny"


def test_the_package_still_declares_no_tools(agenda):
    assert agenda.manifest["tools"] == []
    assert not any(node["type"] == "tool" for node in agenda.graph["nodes"])
    assert not any(worker["tools"] for worker in agenda.graph["workers"])


# -- the rotated signer ------------------------------------------------------
def test_the_new_bytes_verify_only_under_the_new_key(agenda):
    verified = verify_package(AGENDA, AGENDA_KEY)
    assert verified["valid"]
    assert verified["key_fingerprint"] == AGENDA_FINGERPRINT
    assert verified["version"] == "0.2.1"
    with pytest.raises(Exception):
        verify_package(AGENDA, ORIGINAL_KEY)


def test_the_new_signer_is_not_automatically_trusted(tmp_path):
    """A rotated key is a new key. A pin of the old one does not carry over."""
    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    unpinned = control.open_file(str(AGENDA))
    assert unpinned["publisher"]["signature_status"] == "valid"
    assert unpinned["publisher"]["trust_status"] == "unknown"
    control.close(unpinned["session"]["id"])

    # The old key, still pinned publisher-wide for the other shipped package.
    control.trust_add(
        read_public_key_file(ORIGINAL_KEY),
        display_name="WebAgents development key",
        publisher_id="webagents-research",
    )
    summary = control.open_file(str(AGENDA))
    session_id = summary["session"]["id"]
    # Not merely unknown: a second key claiming a pinned publisher is a signal.
    assert summary["publisher"]["trust_status"] == "mismatch"
    assert summary["publisher"]["trust_reason"] == "claimed_publisher_pinned_to_other_key"

    # Only an explicit decision on this exact key changes that, at the narrowest
    # scope the store offers.
    pinned = control.trust_session_publisher(
        session_id,
        signer_fingerprint=summary["publisher"]["signer_fingerprint"],
        scope="package",
    )
    assert pinned["added"]["fingerprint"] == AGENDA_FINGERPRINT
    assert pinned["added"]["package_id_prefix"] == PACKAGE_ID["meeting-agenda"]
    assert control.summary(session_id)["publisher"]["trust_status"] == "trusted"


# -- new bytes mean new authority --------------------------------------------
def _trusted_plane(tmp_path):
    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    for key, prefix in ((ORIGINAL_KEY, None), (AGENDA_KEY, PACKAGE_ID["meeting-agenda"])):
        control.trust_add(
            read_public_key_file(key),
            display_name="WebAgents development key",
            publisher_id="webagents-research",
            package_id_prefix=prefix,
        )
    return control


def _authorized_plan(control, artifact):
    summary = control.open_file(str(artifact))
    session_id = summary["session"]["id"]
    digest = summary["package"]["digest"]
    assert summary["publisher"]["trust_status"] == "trusted"
    receipt = control.authorize(
        session_id,
        package_digest=digest,
        decisions={"model.reasoning": "session", "memory.session": "session"},
    )
    state = control.prepare_run_plan(
        session_id,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id="host/alpha",
        catalog=CATALOG,
    )
    assert state["run_plan"]["readiness"]["ready"]
    return session_id, digest, receipt, state["run_plan"]


def test_a_run_plan_for_the_previous_version_cannot_reach_the_new_one(tmp_path):
    control = _trusted_plane(tmp_path)
    old_session, old_digest, _, old_plan = _authorized_plan(control, PREVIOUS)
    new_session, new_digest, _, new_plan = _authorized_plan(control, AGENDA)
    assert old_digest != new_digest
    assert old_plan["run_plan_id"] != new_plan["run_plan_id"]
    assert old_plan["run_plan_sha256"] != new_plan["run_plan_sha256"]

    # The old plan's identity, offered against the new package's session.
    with pytest.raises(ControlPlaneError) as wrong_plan:
        control.issue_execution_lease(
            new_session,
            package_digest=new_digest,
            run_plan_id=old_plan["run_plan_id"],
            run_plan_sha256=old_plan["run_plan_sha256"],
        )
    assert wrong_plan.value.code in {"run_plan_mismatch", "run_plan_absent"}

    # And the old package's digest cannot stand in for the new one either.
    with pytest.raises(ControlPlaneError) as wrong_digest:
        control.issue_execution_lease(
            new_session,
            package_digest=old_digest,
            run_plan_id=new_plan["run_plan_id"],
            run_plan_sha256=new_plan["run_plan_sha256"],
        )
    assert wrong_digest.value.code == "digest_mismatch"

    # The old session keeps working on the bytes it was opened for.
    lease = control.issue_execution_lease(
        old_session,
        package_digest=old_digest,
        run_plan_id=old_plan["run_plan_id"],
        run_plan_sha256=old_plan["run_plan_sha256"],
    )
    assert lease["lease"]["package_digest"] == old_digest


def test_an_authorization_receipt_does_not_cross_the_version_bump(tmp_path):
    control = _trusted_plane(tmp_path)
    _, old_digest, old_receipt, _ = _authorized_plan(control, PREVIOUS)
    new_summary = control.open_file(str(AGENDA))
    new_session = new_summary["session"]["id"]
    new_digest = new_summary["package"]["digest"]

    # Authorizing the new session against the old digest is refused outright.
    with pytest.raises(ControlPlaneError) as mismatch:
        control.authorize(
            new_session,
            package_digest=old_digest,
            decisions={"model.reasoning": "session", "memory.session": "session"},
        )
    assert mismatch.value.code == "digest_mismatch"

    # A fresh receipt is required, and the old receipt id is not one of this
    # session's.
    receipt = control.authorize(
        new_session,
        package_digest=new_digest,
        decisions={"model.reasoning": "session", "memory.session": "session"},
    )
    assert receipt["receipt_id"] != old_receipt["receipt_id"]
    assert receipt["package"]["digest"] == new_digest
    with pytest.raises(ControlPlaneError) as stale:
        control.prepare_run_plan(
            new_session,
            package_digest=new_digest,
            receipt_id=old_receipt["receipt_id"],
            model_id="host/alpha",
            catalog=CATALOG,
        )
    assert stale.value.code in {"receipt_mismatch", "authorization_absent"}


# -- the host's contract digests agree with the package's own schemas --------
def test_the_plugin_built_in_binding_matches_the_shipped_tool_contract():
    """The host pins a contract; the package declares one. They must agree.

    The plugin states the SHA-256 of the canonical JSON of the Citation
    Resolver's request and response contract as *its own* claim about the
    service it implements — deliberately not read from any package, because a
    binding that derived its contract from the package it is about to serve
    would confirm nothing. This asserts that the two independently written
    statements describe the same contract, which is what makes the shipped
    package's `citation-resolver` `bound` rather than `incompatible` here.
    """
    import re

    from agentpkg.package import canonical_json, load_package, sha256

    source = (ROOT / "openclaw-agent-browser/src/tool-registry.ts").read_text()
    block = source[source.index('toolId: "citation-resolver"') :]
    declared = {
        name: re.search(rf'{name}: "([0-9a-f]{{64}})"', block).group(1)
        for name in ("inputSchemaSha256", "outputSchemaSha256")
    }
    package = load_package(DIST["literature-review"])
    tool = package.tools["citation-resolver"]
    assert declared["inputSchemaSha256"] == sha256(
        canonical_json(package.json(tool["input_schema"]))
    )
    assert declared["outputSchemaSha256"] == sha256(
        canonical_json(package.json(tool["output_schema"]))
    )
    # ...and the endpoint the host is configured for is one the package itself
    # declares, so the binding constrains this host rather than widening it.
    assert 'origin: "https://webagents-citation-resolver-production.up.railway.app"' in block
    assert 'path: "/resolve"' in block
    assert tool["domains"] == ["webagents-citation-resolver-production.up.railway.app"]
