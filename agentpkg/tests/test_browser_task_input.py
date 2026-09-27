"""The task surface of the control plane: input schema, input validation, presentation.

A Run surface needs three read-only facts from the authority that already owns
the package snapshot: the task input contract (to render a form), whether a
proposed task satisfies it (so invalid input never reaches a runner), and the
package's cosmetic hints. None of them executes anything, and presentation can
never become authority.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from shipped_keys import DIST
from test_browser_service import call, service  # noqa: F401 - pytest fixture

from agentpkg.browser import ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.presentation import (
    EXTENSION_KEY,
    input_form,
    presentation_hints,
    validate_task_input,
)
from agentpkg.package import build_package, load_package

ROOT = Path(__file__).resolve().parents[2]
TASK = {
    "question": "What defenses have been proposed against prompt injection attacks?",
    "seeds": [],
    "documents": {},
    "mode": "live",
}


def plane(tmp_path) -> ControlPlane:
    return ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )


def with_presentation(tmp_path, change):
    """A copy of the Literature Review source whose presentation block was edited."""
    source = tmp_path / "src"
    shutil.copytree(ROOT / "agents/literature-review", source)
    graph = json.loads((source / "graph.json").read_text())
    change(graph["extensions"][EXTENSION_KEY])
    (source / "graph.json").write_text(json.dumps(graph))
    return load_package(build_package(source, tmp_path / "copy.agent.pkg"))


# -- the input schema ------------------------------------------------------------
def test_the_summary_carries_each_package_s_own_input_contract(tmp_path):
    control = plane(tmp_path)
    review = control.open_file(str(DIST["literature-review"]))["workflow"]["input"]
    agenda = control.open_file(str(DIST["meeting-agenda"]))["workflow"]["input"]
    assert review["schema_path"] == "schemas/workflow-input.schema.json"
    assert set(review["document"]["properties"]) == {"question", "seeds", "documents", "mode"}
    assert review["document"]["properties"]["mode"]["default"] == "live"
    assert agenda["schema_path"] == "schemas/input.schema.json"
    assert set(agenda["document"]["properties"]) == {"goal", "participants", "context", "duration"}
    for form in (review, agenda):
        assert form["schema"] == "agentpkg-task-input-v0"
        assert len(form["schema_sha256"]) == 64 and form["bytes"] > 0


def test_referenced_schemas_are_bundled_into_one_offline_document(tmp_path):
    """A form renderer never has to resolve a package path."""
    source = tmp_path / "agenda"
    shutil.copytree(ROOT / "agents/meeting-agenda", source)
    schema = json.loads((source / "schemas/input.schema.json").read_text())
    schema["properties"]["participants"]["items"] = {"$ref": "participant.schema.json"}
    (source / "schemas/input.schema.json").write_text(json.dumps(schema))
    form = input_form(load_package(source))
    document = form["document"]
    assert document["$ref"].startswith("#/$defs/")
    text = json.dumps(document)
    assert "participant.schema.json" not in text and "$schema" not in text
    root = document["$defs"][document["$ref"].rsplit("/", 1)[1]]
    item_ref = root["properties"]["participants"]["items"]["$ref"]
    assert document["$defs"][item_ref.rsplit("/", 1)[1]]["required"] == ["name", "role"]


# -- validating a task -------------------------------------------------------------
def test_a_valid_task_is_valid_and_hashed():
    report = validate_task_input(load_package(DIST["literature-review"]), TASK)
    assert report["valid"] is True and report["errors"] == []
    assert len(report["input_sha256"]) == 64 and report["input_bytes"] > 0


def test_invalid_tasks_get_pointers_and_host_written_messages():
    package = load_package(DIST["literature-review"])
    secret = "a private research idea nobody else should read"
    report = validate_task_input(
        package,
        {
            "question": secret * 60,
            "seeds": [3],
            "documents": {"10.1/x": "/etc/passwd"},
            "mode": "ship-it",
            "model": "remote/gpt",
        },
    )
    assert report["valid"] is False
    pointers = {(item["pointer"], item["rule"]) for item in report["errors"]}
    assert pointers == {
        ("", "additionalProperties"),
        ("/question", "maxLength"),
        ("/seeds/0", "type"),
        ("/documents/10.1~1x", "pattern"),
        ("/mode", "enum"),
    }
    # The person's own text, and a path they typed, are never echoed back.
    text = json.dumps(report)
    assert secret not in text and "/etc/passwd" not in text


def test_every_missing_required_field_is_named():
    report = validate_task_input(load_package(DIST["literature-review"]), {})
    assert sorted(item["pointer"] for item in report["errors"]) == [
        "/documents",
        "/mode",
        "/question",
        "/seeds",
    ]


def test_an_oversized_or_non_json_task_is_refused_before_validation():
    package = load_package(DIST["literature-review"])
    huge = validate_task_input(package, {**TASK, "question": "x" * (300 * 1024)})
    assert huge["valid"] is False and huge["errors"][0]["rule"] == "size"
    nan = validate_task_input(package, {**TASK, "seeds": [float("nan")]})
    assert nan["valid"] is False and nan["errors"][0]["rule"] == "json"


def test_the_control_plane_validates_against_the_session_snapshot(tmp_path):
    control = plane(tmp_path)
    session = control.open_file(str(DIST["literature-review"]))["session"]["id"]
    assert control.validate_input(session, input_value=TASK)["valid"] is True
    refused = control.validate_input(session, input_value={**TASK, "mode": "x"})
    assert refused["valid"] is False
    with pytest.raises(ControlPlaneError) as unknown:
        control.validate_input("nope-nope-nope", input_value=TASK)
    assert unknown.value.code == "session_unknown"


def test_input_validation_over_http_is_strict(service):  # noqa: F811
    status, opened = call(
        service, "POST", "/v0/packages/open-file", {"path": str(DIST["literature-review"])}
    )
    assert status == 201
    route = f"/v0/packages/{opened['session']['id']}/input/validate"
    status, body = call(service, "POST", route, {"input": TASK})
    assert status == 200 and body["valid"] is True
    status, body = call(service, "POST", route, {"input": TASK, "model_id": "x"})
    assert status == 400 and body["error"]["code"] == "unknown_field"
    status, body = call(service, "GET", route)
    assert status == 405


# -- presentation ------------------------------------------------------------------
def test_0_2_2_presentation_hints_are_validated_and_complete():
    hints, notes = presentation_hints(load_package(DIST["literature-review"]))
    assert notes == []
    assert hints["noncritical"] is True
    assert hints["task"]["run_label"] == "Run Research"
    assert hints["input"]["question"]["widget"] == "multiline"
    assert hints["input"]["documents"]["widget"] == "selected_files"
    assert [stage["label"] for stage in hints["stages"]] == [
        "Planning",
        "Scholarly search",
        "Screening",
        "Citations",
        "Evidence extraction",
        "Synthesis",
        "Writing",
        "Verification",
    ]
    staged = [node for stage in hints["stages"] for node in stage["nodes"]]
    graph_nodes = [node["id"] for node in load_package(DIST["literature-review"]).graph["nodes"]]
    assert sorted(staged) == sorted(graph_nodes)
    assert hints["result"]["primary_export"] == "related-work.md"


def test_packages_without_hints_have_none():
    assert presentation_hints(load_package(DIST["meeting-agenda"])) == (None, [])


def test_a_run_label_must_say_run(tmp_path):
    package = with_presentation(tmp_path, lambda p: p["task"].update(run_label="Cancel"))
    hints, notes = presentation_hints(package)
    assert "run_label" not in hints["task"]
    assert any("run_label" in note for note in notes)


def test_hints_cannot_name_things_the_package_does_not_declare(tmp_path):
    def change(p):
        p["nodes"]["not-a-node"] = "Invented"
        p["stages"].append({"label": "Ghost", "nodes": ["not-a-node"]})
        p["input"]["model"] = {"widget": "multiline"}
        p["input"]["question"]["widget"] = "script"
        p["result"]["primary_export"] = "result.json"
        p["result"]["summary"].append({"label": "Audit", "export": "audit.json"})

    hints, notes = presentation_hints(with_presentation(tmp_path, change))
    assert "not-a-node" not in hints["nodes"]
    assert "Ghost" not in [stage["label"] for stage in hints["stages"]]
    assert "model" not in hints["input"]
    assert "widget" not in hints["input"]["question"]
    assert "primary_export" not in hints["result"]
    assert "audit.json" not in [item["export"] for item in hints["result"]["summary"]]
    assert len(notes) >= 5


def test_hint_text_is_plain_bounded_and_bidi_free(tmp_path):
    def change(p):
        p["task"]["prompt"] = "Look‮ here\x00" + "!" * 1000
        p["nodes"]["planning"] = "<b>Plan</b>\n\tning"

    hints, _ = presentation_hints(with_presentation(tmp_path, change))
    assert "‮" not in hints["task"]["prompt"] and "\x00" not in hints["task"]["prompt"]
    assert len(hints["task"]["prompt"]) <= 300
    # Markup stays text; the browser renders it with textContent.
    assert hints["nodes"]["planning"] == "<b>Plan</b> ning"


def test_a_malformed_block_is_ignored_with_a_warning(tmp_path):
    package = with_presentation(tmp_path, lambda p: p.update(schema="something-else"))
    hints, notes = presentation_hints(package)
    assert hints is None and notes
    control = plane(tmp_path)
    summary = control.open_file(str(tmp_path / "copy.agent.pkg"))
    assert summary["workflow"]["presentation"] is None
    assert "presentation_ignored" in {item["code"] for item in summary["warnings"]}
