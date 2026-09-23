"""Host model catalogs and package/model compatibility.

Every assertion here is about generic semantics. No test knows what "literature
review" or "meeting agenda" means, and none knows the name of a model provider:
the catalogs below are synthetic, and both shipped packages travel through the
same evaluator.
"""

from __future__ import annotations

import copy
import dataclasses
from pathlib import Path

import pytest
from shipped_keys import AGENDA_KEY, DIST, ORIGINAL_KEY

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.hostmodels import (
    evaluate_catalog,
    evaluate_model,
    normalize_catalog,
    requirement_set,
)
from agentpkg.browser.trust import read_public_key_file
from agentpkg.package import load_package

ROOT = Path(__file__).resolve().parents[2]


def plane(tmp_path, **overrides) -> ControlPlane:
    control = ControlPlane(
        ControlPlaneConfig(
            cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json", **overrides
        )
    )
    # One pin per shipped signer key; meeting-agenda's is scoped to its own id.
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
    """One descriptor that satisfies both reference packages by default."""
    descriptor = {
        "id": model_id,
        "provider_id": model_id.split("/")[0],
        "model_id": model_id.split("/")[1],
        "display_name": "Alpha",
        "available": True,
        "selectable": True,
        "capabilities": {
            "reasoning": {"value": True, "basis": "declared", "detail": "row declares it"},
            "structured_output": {"value": True, "basis": "derived", "detail": "tool gate"},
            "tool_use": {"value": True, "basis": "host_default", "detail": "no opt-out"},
        },
        "limits": {"context_tokens": 200000, "native_context_window": 400000},
        "properties": {"local": False, "tags": []},
    }
    descriptor.update(overrides)
    return descriptor


def catalog(*models, **host) -> dict:
    return {
        "schema": "agentpkg-host-model-catalog-v0",
        "host": {
            "runtime": "test-host",
            "runtime_version": "1.0.0",
            "source": "test",
            "captured_at": "2026-09-21T22:00:00+00:00",
            **host,
        },
        "models": list(models) or [model()],
        "notes": [],
    }


# -- discovery is the host's job, not this service's -------------------------
def test_the_control_plane_discovers_no_models_of_its_own(tmp_path):
    control = plane(tmp_path)
    status = control.status()
    assert status["host_model_catalog"]["source"] == "supplied_by_host"
    assert status["capabilities"]["evaluate_models"] is True
    assert status["capabilities"]["execute"] is False
    # There is no method that could reach a provider, a router or a model.
    operations = {name for name in dir(control) if not name.startswith("_")}
    assert not operations & {"complete", "invoke", "discover_models", "list_models"}


def test_an_empty_catalog_is_a_valid_answer(tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST["meeting-agenda"]))
    evaluation = control.evaluate_models(
        summary["session"]["id"],
        package_digest=summary["package"]["digest"],
        catalog={**catalog(), "models": []},
    )
    assert evaluation["models"] == []
    assert evaluation["counts"] == {
        "compatible": 0,
        "unverified": 0,
        "incompatible": 0,
        "total": 0,
        "available": 0,
        "selectable": 0,
    }


def test_host_notes_survive_so_a_ui_can_explain_a_thin_catalog(tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST["meeting-agenda"]))
    payload = catalog()
    payload["notes"] = [{"code": "provider_discovery_pending", "detail": "one provider"}]
    evaluation = control.evaluate_models(
        summary["session"]["id"],
        package_digest=summary["package"]["digest"],
        catalog=payload,
    )
    assert evaluation["notes"] == [{"code": "provider_discovery_pending", "detail": "one provider"}]


# -- refusing anything that is not a safe descriptor -------------------------
@pytest.mark.parametrize(
    "extra",
    [
        {"api_key": "sk-secret"},
        {"base_url": "https://provider.example/v1"},
        {"headers": {"authorization": "Bearer x"}},
        {"auth_profile": "openai:someone@example.com"},
        {"params": {"temperature": 0.2}},
    ],
)
def test_a_descriptor_carrying_anything_beyond_the_contract_is_refused(extra):
    payload = catalog(model(**extra))
    with pytest.raises(ControlPlaneError) as error:
        normalize_catalog(payload)
    assert error.value.code == "unknown_field"
    assert "unknown fields" in str(error.value).lower()


def _keys(value) -> set:
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in _keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in _keys(item)}
    return set()


def test_no_credential_shaped_field_can_reach_a_stored_catalog():
    """Every key at every depth, not just the top level, is on the contract."""
    stored = normalize_catalog(catalog())
    forbidden = ("key", "secret", "token", "credential", "auth", "header", "url", "endpoint")
    for name in _keys(stored):
        lowered = name.lower()
        # `context_tokens` and `max_output_tokens` are token *counts*.
        if lowered.endswith("_tokens"):
            continue
        assert not any(marker in lowered for marker in forbidden), name


def test_malformed_descriptors_are_refused_field_by_field():
    cases = [
        ({"available": "yes"}, "must be true, false or null"),
        ({"limits": {"context_tokens": -1}}, "nonnegative integer"),
        ({"display_name": "x" * 600}, "exceeds"),
        ({"capabilities": {"reasoning": {"value": "maybe"}}}, "true, false or null"),
        ({"capabilities": {"reasoning": {"value": None, "basis": "declared"}}}, "basis"),
    ]
    for overrides, fragment in cases:
        with pytest.raises(ControlPlaneError) as error:
            normalize_catalog(catalog(model(**overrides)))
        assert fragment in str(error.value), overrides


def test_duplicate_model_identifiers_are_refused():
    with pytest.raises(ControlPlaneError) as error:
        normalize_catalog(catalog(model("host/a"), model("host/a")))
    assert "duplicate" in str(error.value)


def test_a_catalog_binds_to_a_deterministic_hash():
    first = normalize_catalog(catalog(model("host/a"), model("host/b")))
    second = normalize_catalog(catalog(model("host/a"), model("host/b")))
    assert first["catalog_sha256"] == second["catalog_sha256"]
    changed = normalize_catalog(catalog(model("host/a"), model("host/b", available=False)))
    assert changed["catalog_sha256"] != first["catalog_sha256"]


# -- tri-state compatibility -------------------------------------------------
def requirements(name: str) -> dict:
    return requirement_set(load_package(DIST[name]))


def verdict(name: str, descriptor: dict) -> dict:
    return evaluate_model(requirements(name), normalize_catalog(catalog(descriptor))["models"][0])


@pytest.mark.parametrize("name", sorted(DIST))
def test_a_model_meeting_every_hard_requirement_is_compatible(name):
    result = verdict(name, model())
    assert result["status"] == "compatible"
    assert result["violated"] == []
    assert result["unknown"] == []
    assert result["selectable_for_run_plan"] is True


@pytest.mark.parametrize("name", sorted(DIST))
def test_an_insufficient_context_window_is_incompatible(name):
    result = verdict(name, model(limits={"context_tokens": 4096}))
    assert result["status"] == "incompatible"
    assert "context_tokens:minimum" in result["violated"]
    assert result["selectable_for_run_plan"] is False
    check = next(item for item in result["checks"] if item["id"] == "context_tokens:minimum")
    assert check["host_value"] == 4096
    assert check["value"] == 16000
    assert check["status"] == "violated"


def test_a_capability_the_host_refutes_is_incompatible():
    result = verdict(
        "meeting-agenda",
        model(
            capabilities={
                "reasoning": {"value": False, "basis": "declared"},
                "structured_output": {"value": True, "basis": "declared"},
            }
        ),
    )
    assert result["status"] == "incompatible"
    assert result["violated"] == ["capability:reasoning"]


def test_a_capability_the_host_cannot_answer_is_unverified_not_false():
    result = verdict(
        "meeting-agenda",
        model(capabilities={"structured_output": {"value": True, "basis": "declared"}}),
    )
    assert result["status"] == "unverified"
    assert result["unknown"] == ["capability:reasoning"]
    assert result["violated"] == []
    # Unverified is inspectable, and the honest verdict is neither yes nor no.
    check = next(item for item in result["checks"] if item["id"] == "capability:reasoning")
    assert check["host_value"] is None
    assert check["basis"] == "absent"


def test_an_absent_context_window_is_unverified_not_incompatible():
    result = verdict("meeting-agenda", model(limits={}))
    assert result["status"] == "unverified"
    assert result["unknown"] == ["context_tokens:minimum"]


def test_a_model_can_be_both_refuted_and_unknown_and_stays_incompatible():
    result = verdict(
        "meeting-agenda",
        model(capabilities={"reasoning": {"value": False, "basis": "declared"}}, limits={}),
    )
    assert result["status"] == "incompatible"
    assert result["violated"] == ["capability:reasoning"]
    assert result["unknown"] == ["capability:structured_output", "context_tokens:minimum"]


def test_the_evidence_basis_of_every_satisfied_requirement_is_reported():
    result = verdict("meeting-agenda", model())
    bases = {check["id"]: check["basis"] for check in result["checks"]}
    assert bases["capability:reasoning"] == "declared"
    assert bases["capability:structured_output"] == "derived"
    assert result["evidence_strength"] == "derived"
    strong = verdict(
        "meeting-agenda",
        model(
            capabilities={
                "reasoning": {"value": True, "basis": "declared"},
                "structured_output": {"value": True, "basis": "declared"},
            }
        ),
    )
    assert strong["evidence_strength"] == "declared"


# -- preferences never decide compatibility ----------------------------------
def test_an_unmet_preference_leaves_a_model_compatible():
    result = verdict("meeting-agenda", model(properties={"local": False, "tags": []}))
    assert result["status"] == "compatible"
    tiers = [item for item in result["preferences"] if item["kind"] == "preferred_tier"]
    assert tiers and all(item["status"] != "violated" for item in tiers)
    met = verdict("meeting-agenda", model(properties={"local": False, "tags": ["reasoning"]}))
    assert met["status"] == "compatible"
    assert any(item["status"] == "met" for item in met["preferences"])


def test_a_local_only_package_makes_a_remote_model_incompatible(tmp_path):
    """`privacy: local-only` is a hard requirement; a tier preference is not."""
    loaded = load_package(DIST["meeting-agenda"])
    local_only = copy.deepcopy(loaded.manifest)
    local_only["model_requirements"]["privacy"] = "local-only"
    package = dataclasses.replace(loaded, manifest=local_only)
    remote = evaluate_model(
        requirement_set(package), normalize_catalog(catalog(model()))["models"][0]
    )
    assert remote["status"] == "incompatible"
    assert remote["violated"] == ["property:local"]
    on_device = evaluate_model(
        requirement_set(package),
        normalize_catalog(catalog(model(properties={"local": True, "tags": []})))["models"][0],
    )
    assert on_device["status"] == "compatible"


# -- availability is separate from compatibility -----------------------------
def test_an_unavailable_model_is_still_evaluated_but_not_selectable():
    result = verdict("meeting-agenda", model(available=False, availability_reason="missing-auth"))
    assert result["status"] == "compatible"
    assert result["available"] is False
    assert result["availability_reason"] == "missing-auth"
    assert result["selectable_for_run_plan"] is False


def test_a_model_the_host_will_not_offer_manually_is_not_selectable():
    result = verdict("meeting-agenda", model(selectable=False))
    assert result["status"] == "compatible"
    assert result["selectable_for_run_plan"] is False


# -- ordering and genericity -------------------------------------------------
def test_models_are_ordered_available_then_by_status_never_by_quality():
    package = load_package(DIST["meeting-agenda"])
    payload = normalize_catalog(
        catalog(
            model("host/zzz-compatible"),
            model("host/aaa-incompatible", limits={"context_tokens": 10}),
            model("host/mmm-unverified", capabilities={}),
            model("host/aaa-offline", available=False),
        )
    )
    evaluation = evaluate_catalog(package, payload)
    assert [item["model_id"] for item in evaluation["models"]] == [
        "host/zzz-compatible",
        "host/mmm-unverified",
        "host/aaa-incompatible",
        "host/aaa-offline",
    ]
    assert evaluation["counts"]["available"] == 3
    assert evaluation["counts"]["selectable"] == 2


@pytest.mark.parametrize("name", sorted(DIST))
def test_both_packages_use_the_same_evaluator_over_the_same_catalog(name, tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST[name]))
    evaluation = control.evaluate_models(
        summary["session"]["id"],
        package_digest=summary["package"]["digest"],
        catalog=catalog(model("host/a"), model("host/b", limits={"context_tokens": 100})),
    )
    assert evaluation["schema"] == "agentpkg-model-evaluation-v0"
    assert evaluation["package_id"] == summary["package"]["package_id"]
    assert [item["status"] for item in evaluation["models"]] == ["compatible", "incompatible"]
    assert evaluation["execution"]["performed"] is False
    # Requirements are read from the package, so the two differ in task count
    # while the machinery above is identical.
    assert evaluation["requirements"]["tasks"]


def test_the_two_packages_declare_different_requirement_sets():
    review = requirements("literature-review")
    agenda = requirements("meeting-agenda")
    assert len(review["tasks"]) != len(agenda["tasks"])
    ids = {item["id"] for item in review["hard_requirements"]}
    assert ids == {item["id"] for item in agenda["hard_requirements"]}
    for record in review["hard_requirements"]:
        if record["kind"] == "capability":
            assert len(record["tasks"]) == len(review["tasks"])


def test_evaluation_requires_the_caller_to_echo_the_package_digest(tmp_path):
    control = plane(tmp_path)
    summary = control.open_file(str(DIST["meeting-agenda"]))
    with pytest.raises(ControlPlaneError) as error:
        control.evaluate_models(
            summary["session"]["id"], package_digest="0" * 64, catalog=catalog()
        )
    assert error.value.code == "digest_mismatch"
