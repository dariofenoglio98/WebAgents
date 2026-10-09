"""0.2.5: the exported evidence table is the extraction record, never the verifier's copy.

The verification skill asks the verifier to copy each cited evidence item
exactly. In 0.2.4 the export *was* that copy and the final relation compared
only five of its fields, so a live run completed with one row's `category`
re-labelled. These tests pin the fix: the graph attaches each cited item's own
record, the verifier still chooses which items and in what order, and the
final check now compares whole rows.
"""

import asyncio
import copy
import hashlib
import json
from pathlib import Path

import pytest
from literature_scenarios import Scenario, ScriptedReview, run_scenario
from shipped_keys import LITERATURE_FINGERPRINT, LITERATURE_KEY

from agentpkg.fixtures import fixture_adapters
from agentpkg.package import load_package
from agentpkg.signing import verify_package
from agentpkg.workflow import WorkflowError, run_workflow

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "dist/literature-review-0.2.5.agent.pkg"
PREVIOUS = ROOT / "dist/literature-review-0.2.4.agent.pkg"
PREVIOUS_SHA256 = "f513e68ea23e045ed3665d8d71e46531147f017f0da80f999fb343afc3e1fe24"


@pytest.fixture(scope="module")
def review():
    return load_package(ARCHIVE)


@pytest.fixture(scope="module")
def previous():
    return load_package(PREVIOUS)


class RewritesARow(ScriptedReview):
    """A verifier that cites the right item and alters its copy of one field."""

    field = "category"
    value = "setup"

    def verify(self, data):
        result = super().verify(data)
        result["evidence_table"][0][self.field] = copy.deepcopy(self.value)
        return result


REWRITES = [
    ("category", "setup"),  # what the live 0.2.4 run's verifier did
    ("text", "A paraphrase the extractor never wrote."),
    ("support_strength", "model_interpretation"),
    ("extraction_worker", "verifier"),
    ("quote", "A quote the source never contained."),
    ("location", {"page": 9, "section": "results"}),
]


def rewriting(field, value):
    return type("Rewrites", (RewritesARow,), {"field": field, "value": value})


@pytest.mark.parametrize(("field", "value"), REWRITES)
def test_an_exported_row_is_its_extraction_record_whatever_the_verifier_wrote(review, field, value):
    scenario = Scenario(rich_metadata=True)
    result = run_scenario(review, scenario, router=rewriting(field, value)(scenario))
    assert result["status"] == "completed"
    state, table = result["state"], result["output"]["evidence_table"]
    trusted = {item["evidence_id"]: item for item in state["evidence_items"]}
    assert state["review"]["evidence_table"][0][field] == value  # the verifier did rewrite it
    assert table and all(row == trusted[row["evidence_id"]] for row in table)
    assert result["state"]["final"]["evidence_table"] == table


def test_the_same_rewrite_was_accepted_by_0_2_4(previous):
    # The defect itself, on the preserved archive: a completed run whose
    # exported row is not its extraction record.
    scenario = Scenario(rich_metadata=True)
    result = run_scenario(previous, scenario, router=rewriting("category", "setup")(scenario))
    assert result["status"] == "completed"
    row = result["output"]["evidence_table"][0]
    items = result["state"]["evidence_items"]
    source = next(item for item in items if item["evidence_id"] == row["evidence_id"])
    assert row["category"] == "setup" != source["category"]


class ChoosesEvidence(ScriptedReview):
    """Cites a subset of the evidence, in reverse order."""

    def verify(self, data):
        result = super().verify(data)
        result["evidence_table"] = list(reversed(result["evidence_table"]))[:2]
        return result


def test_the_verifier_still_chooses_which_evidence_and_in_what_order(review):
    scenario = Scenario(rich_metadata=True)
    result = run_scenario(review, scenario, router=ChoosesEvidence(scenario))
    chosen = [row["evidence_id"] for row in result["state"]["review"]["evidence_table"]]
    assert len(chosen) == 2
    assert [row["evidence_id"] for row in result["output"]["evidence_table"]] == chosen


class CitesMissingEvidence(ScriptedReview):
    def verify(self, data):
        result = super().verify(data)
        result["evidence_table"][0] = {"evidence_id": "10.5555/nowhere:e9"}
        return result


def test_a_row_must_name_an_extracted_item(review):
    scenario = Scenario(rich_metadata=True)
    with pytest.raises(WorkflowError) as error:
        run_scenario(review, scenario, router=CitesMissingEvidence(scenario))
    assert error.value.code == "schema_validation"
    assert error.value.node_id == "materialize-evidence"


def test_no_evidence_still_exports_an_empty_table(review):
    result = run_scenario(review, Scenario(extract_empty=True))
    assert result["status"] == "completed"
    assert result["output"]["evidence_table"] == []


def modified(tmp_path, package, edit):
    for name, data in package.files.items():
        p = tmp_path / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    graph = json.loads((tmp_path / "graph.json").read_text())
    edit({n["id"]: n for n in graph["nodes"]})
    (tmp_path / "graph.json").write_text(json.dumps(graph))
    return load_package(tmp_path)


def test_the_final_check_compares_whole_rows_on_its_own(review, tmp_path):
    # Wire the verifier's copy straight to the output again, as 0.2.4 did: the
    # strengthened final relation alone must now refuse the rewritten row.
    def edit(nodes):
        nodes["assemble-output"]["input"]["object"]["evidence_table"] = {
            "from": "state",
            "path": "/review/evidence_table",
        }

    package = modified(tmp_path, review, edit)
    scenario = Scenario(rich_metadata=True)
    with pytest.raises(WorkflowError) as error:
        run_scenario(package, scenario, router=rewriting("category", "setup")(scenario))
    assert error.value.node_id == "validate-output"
    failed = next(
        event
        for event in error.value.execution_report["audit"]
        if event["action"] == "node.failed"
        and event.get("node_id") == "validate-output"
        and "failed_check" in event
    )
    assert failed["failed_check"]["failure"] == "fields_do_not_match"
    assert failed["failed_check"]["compare"] == {"left": "", "right": "", "op": "eq"}


def test_every_0_2_4_assertion_is_kept_and_only_strengthened(review, previous):
    current = {n["id"]: n for n in review.graph["nodes"]}
    for node in previous.graph["nodes"]:
        before = node.get("assertions", [])
        after = current[node["id"]].get("assertions", [])
        assert len(after) >= len(before)
        for old, new in zip(before, after, strict=False):
            if old == new:
                continue
            # The one change: a relation gained a comparison after its own.
            assert {k: v for k, v in new.items() if k != "compare"} == {
                k: v for k, v in old.items() if k != "compare"
            }
            assert new["compare"][: len(old["compare"])] == old["compare"]


def test_nothing_else_changed_from_0_2_4(review, previous):
    assert review.policy == previous.policy
    assert review.tools == previous.tools
    assert review.manifest["runtime"] == previous.manifest["runtime"]
    assert review.graph["deadline_seconds"] == previous.graph["deadline_seconds"]
    old = {n["id"]: n for n in previous.graph["nodes"]}
    new = {n["id"]: n for n in review.graph["nodes"]}
    assert set(new) - set(old) == {"materialize-evidence"}
    unchanged = set(old) - {"assemble-output", "validate-output"}
    assert all(new[node_id] == old[node_id] for node_id in unchanged)
    for name, data in previous.files.items():
        if name.startswith(("skills/", "fixtures/", "tools/", "policy/")):
            assert review.files[name] == data, name

    # Roles gained only the access the new node needs; budgets and limits are as they were.
    def limits(worker):
        return {k: v for k, v in worker.items() if k not in ("state_read", "state_write")}

    workers = {w["id"]: w for w in review.graph["workers"]}
    for worker in previous.graph["workers"]:
        assert limits(workers[worker["id"]]) == limits(worker)


def test_signed_artifact_matches_source_and_replays(review, tmp_path):
    checked = verify_package(ARCHIVE, LITERATURE_KEY)
    assert checked["valid"] and checked["key_fingerprint"] == LITERATURE_FINGERPRINT
    assert checked["version"] == "0.2.5"
    # The source has moved on to 0.2.6 (test_literature_026); this archive is the preserved 0.2.5
    # release, checked as published, and the unversioned alias still names it (dist/README.md).
    assert checked["digest"] == review.digest
    assert (ROOT / "dist/literature-review.agent.pkg").read_bytes() == ARCHIVE.read_bytes()
    router, handlers, value = fixture_adapters(review)
    result = asyncio.run(
        run_workflow(
            review,
            value,
            router=router,
            handlers=handlers,
            grants={p["id"]: "session" for p in review.policy["permissions"]},
            approved_tools=sorted(review.tools),
        )
    )
    assert result["status"] == "completed"
    trusted = {item["evidence_id"]: item for item in result["state"]["evidence_items"]}
    table = result["output"]["evidence_table"]
    assert table and all(row == trusted[row["evidence_id"]] for row in table)


def test_the_0_2_4_archive_is_preserved_byte_for_byte():
    assert hashlib.sha256(PREVIOUS.read_bytes()).hexdigest() == PREVIOUS_SHA256
    assert verify_package(PREVIOUS, LITERATURE_KEY)["version"] == "0.2.4"
