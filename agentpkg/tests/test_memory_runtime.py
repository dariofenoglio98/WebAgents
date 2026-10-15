"""memory.v0 in the Python reference (agentpkg 0.4.0): the run, the egress scans, the proposals
check, the agent document, the declarations, and the negative cases of spec/memory-v0.md §10
(M-64) that a runtime refuses. The probe package (`memory_probe.py`) uses every permission."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

import memory_probe as probe
import pytest

from agentpkg.cli import main
from agentpkg.errors import ValidationError
from agentpkg.fixtures import FixtureRouter, fixture_adapters
from agentpkg.memory.host import cli_memory
from agentpkg.memory.model import agent_document_id
from agentpkg.package import load_package
from agentpkg.workflow import run_workflow

EXAMPLE_MEMORY = probe.EXAMPLE / "memory"


def build(tmp_path, change=None, name="probe"):
    return probe.write_probe(tmp_path / name, change)


def run_cli(tmp_path, source, *, grants=None, extra=(), name="out"):
    grants_path = tmp_path / f"{name}-grants.json"
    grants_path.write_text(json.dumps(grants or probe.grants()))
    out = tmp_path / name
    argv = [
        "run",
        str(source),
        "--mode",
        "fixture",
        "--grants",
        str(grants_path),
        *[arg for tool in probe.TOOLS for arg in ("--approve-tool", tool)],
        *extra,
        "--out",
        str(out),
    ]
    code = main(argv)
    result = (
        json.loads((out / "result.json").read_text()) if (out / "result.json").exists() else None
    )
    return code, out, result


def actions(result, prefix=""):
    return [event for event in result["audit"] if event["action"].startswith(prefix)]


def answer(files, *, proposals=None, notes=None):
    """Change the fixture's recorded model answer."""
    case = files["fixtures/workflow.json"]["models"]["remember"][0]
    if proposals is not None:
        case["output"]["proposals"] = proposals
    if notes is not None:
        case["output"]["notes"] = notes
        files["fixtures/workflow.json"]["tools"]["notes-write"][0] = {
            "input": {"body": notes},
            "output": {"staged": True, "bytes": len(notes.encode("utf-8"))},
        }


# -- the positive path --------------------------------------------------------------------------
def test_fixture_run_writes_the_checked_proposals_and_reports_them(tmp_path, capsys):
    code, out, result = run_cli(tmp_path, build(tmp_path))
    capsys.readouterr()
    assert code == 0
    written = json.loads((out / "proposals.json").read_text())
    assert written == {"schema": "memory.v0 proposals", "proposals": probe.proposals()}
    proposed = actions(result, "memory.proposed")
    assert len(proposed) == 1
    facts = {k: proposed[0][k] for k in ("count", "types", "offered", "reason")}
    assert facts == {
        "count": 2,
        "types": ["travel.preference", "travel.profile"],
        "offered": 2,
        "reason": None,
    }
    order = [e["action"] for e in result["audit"]][-3:]
    assert order == ["memory.proposed", "workflow.completed", "memory.cleared"]
    assert result["memory"]["proposals"]["count"] == 2
    assert result["memory"]["refused"] is None
    # Fixture mode replays the agent tools: nothing is staged or committed (M-62).
    assert result["memory"]["agent"] == {"committed": None, "discarded": None}


def test_a_denied_memory_write_still_checks_and_offers_nothing(tmp_path, capsys):
    code, out, result = run_cli(
        tmp_path, build(tmp_path), grants=probe.grants(**{"memory.remember": "deny"})
    )
    capsys.readouterr()
    assert code == 0
    proposed = actions(result, "memory.proposed")[0]
    assert (proposed["offered"], proposed["reason"]) == (0, "permission_denied")
    assert (out / "proposals.json").exists()


def test_a_package_without_memory_has_no_memory_section(tmp_path, capsys):
    root = Path(__file__).resolve().parents[2]
    grants = tmp_path / "g.json"
    grants.write_text(json.dumps({"model.reasoning": "session", "memory.session": "session"}))
    code = main(
        [
            "run",
            str(root / "agents/meeting-agenda"),
            "--grants",
            str(grants),
            "--out",
            str(tmp_path / "out"),
        ]
    )
    capsys.readouterr()
    assert code == 0
    result = json.loads((tmp_path / "out/result.json").read_text())
    assert "memory" not in result
    assert not actions(result, "memory.proposed")


# -- M-40 negative cases (N1, N2, N8, N9, N13, N14, N15, N19, N22) -------------------------------
def _refused(tmp_path, capsys, proposals, *, code, reason, index):
    source = build(tmp_path, lambda files: answer(files, proposals=proposals))
    status, out, result = run_cli(tmp_path, source)
    err = capsys.readouterr().err
    assert status == 2
    assert f"workflow.v0 {code}" in err
    assert not (out / "proposals.json").exists()
    assert result["memory"]["refused"] == {"code": code, "reason": reason, "index": index}
    failed = actions(result, "workflow.failed")[0]
    assert failed["error_code"] == code
    assert failed.get("reason") == reason
    assert failed.get("proposal_index") == index
    assert not actions(result, "memory.proposed")
    return result


def test_n1_a_proposal_of_an_undeclared_type(tmp_path, capsys):
    proposal = {**probe.proposals()[0], "type": "contact"}
    proposal["fields"] = {"given_name": "Sam", "family_name": "Traveler"}
    _refused(
        tmp_path,
        capsys,
        [proposal],
        code="permission_denied",
        reason="memory_proposal_type_undeclared",
        index=0,
    )


def test_n1_a_reserved_type_is_never_proposable(tmp_path, capsys):
    proposal = {**probe.proposals()[0], "type": "person.self", "fields": {"display_name": "X"}}
    _refused(
        tmp_path,
        capsys,
        [proposal],
        code="permission_denied",
        reason="memory_proposal_type_undeclared",
        index=0,
    )


def test_n2_a_proposal_carrying_a_sealed_field(tmp_path, capsys):
    def change(files):
        files["policy/policy.json"]["permissions"][4]["resources"].append("person.identity")
        proposal = {
            **probe.proposals()[0],
            "type": "person.identity",
            "title": "Alex",
            "fields": {"given_name": "Alex", "family_name": "T", "email": "someone@else.example"},
        }
        answer(files, proposals=[proposal])

    source = build(tmp_path, change)
    status, out, result = run_cli(tmp_path, source)
    capsys.readouterr()
    assert status == 2
    assert result["memory"]["refused"] == {
        "code": "schema_validation",
        "reason": "memory_proposal_sealed_field",
        "index": 0,
    }


def test_n8_an_update_of_a_record_the_run_was_not_granted(tmp_path, capsys):
    update = {**probe.proposals()[1], "target": "mem_" + "9" * 32}
    _refused(
        tmp_path,
        capsys,
        [update],
        code="permission_denied",
        reason="memory_proposal_target_not_granted",
        index=0,
    )


def test_n9_a_link_to_a_proposal_that_does_not_exist(tmp_path, capsys):
    first, second = probe.proposals()
    second = {**second, "links": [{"to": "#9", "rel": "prefers"}]}
    _refused(tmp_path, capsys, [first, second], code="schema_validation", reason=None, index=None)


def test_n13_a_sealed_value_copied_into_an_unsealed_field(tmp_path, capsys):
    proposal = {**probe.proposals()[0], "fields": {"kind": "other", "value": probe.EMAIL}}
    result = _refused(
        tmp_path,
        capsys,
        [proposal],
        code="permission_denied",
        reason="sealed_value_in_proposal",
        index=None,
    )
    assert probe.EMAIL not in json.dumps(result)


def test_n14_a_link_to_an_ungranted_record_in_links_or_in_the_body(tmp_path, capsys):
    stranger = "mem_" + "a" * 32
    in_links = {**probe.proposals()[0], "links": [{"to": stranger, "rel": "related"}]}
    _refused(
        tmp_path,
        capsys,
        [in_links],
        code="permission_denied",
        reason="memory_proposal_link_not_granted",
        index=0,
    )
    in_body = {**probe.proposals()[0], "body": f"See [[{stranger}|Trip]]."}
    shutil.rmtree(tmp_path / "out")
    shutil.rmtree(tmp_path / "probe")
    _refused(
        tmp_path,
        capsys,
        [in_body],
        code="permission_denied",
        reason="memory_proposal_link_not_granted",
        index=0,
    )


def test_n15_a_supersedes_link_fails_the_schema(tmp_path, capsys):
    proposal = {**probe.proposals()[0], "links": [{"to": "self", "rel": "supersedes"}]}
    _refused(tmp_path, capsys, [proposal], code="schema_validation", reason=None, index=None)


def test_n19_proposal_by_proposal_the_lower_index_reports_first(tmp_path, capsys):
    first = {**probe.proposals()[0], "links": [{"to": "mem_" + "b" * 32, "rel": "related"}]}
    second = {**probe.proposals()[0], "type": "contact"}
    _refused(
        tmp_path,
        capsys,
        [first, second],
        code="permission_denied",
        reason="memory_proposal_link_not_granted",
        index=0,
    )


def test_n22_the_mirror_marker_as_a_whole_line_fails_the_schema(tmp_path, capsys):
    proposal = {**probe.proposals()[0], "body": "Text\n<!-- memory.v0 links -->\n## Links"}
    _refused(tmp_path, capsys, [proposal], code="schema_validation", reason=None, index=None)


def test_n22_the_marker_inside_a_sentence_is_text(tmp_path, capsys):
    proposal = {**probe.proposals()[0], "body": "The export writes <!-- memory.v0 links --> there."}
    source = build(tmp_path, lambda files: answer(files, proposals=[proposal]))
    status, _, _ = run_cli(tmp_path, source)
    capsys.readouterr()
    assert status == 0


# -- M-36 and M-37: the egress scans (N11) -------------------------------------------------------
def test_n11_a_sealed_value_routed_into_a_model_step_is_refused_before_it_leaves(tmp_path, capsys):
    def change(files):
        remember = files["graph.json"]["nodes"][3]
        remember["input"]["object"]["email"] = probe.state("/identity/contact_email")
        case = files["fixtures/workflow.json"]["models"]["remember"][0]
        case["input"]["email"] = probe.EMAIL

    status, out, result = run_cli(tmp_path, build(tmp_path, change))
    err = capsys.readouterr().err
    assert status == 2
    assert "workflow.v0 permission_denied at node remember" in err
    refused = actions(result, "model.refused")
    assert len(refused) == 1
    assert refused[0]["reason"] == "sealed_value_in_model_request"
    assert refused[0]["pointer"] == "/contact_email"
    assert not actions(result, "model.count.called")
    assert probe.EMAIL not in json.dumps(result["audit"])


def test_m36_a_granted_sealed_value_goes_only_to_a_tool_that_links_its_permission(tmp_path, capsys):
    def change(files):
        files["policy/policy.json"]["permissions"].append(
            {
                "id": "probe.send",
                "kind": "files.write",
                "description": "Probe destination.",
                "required": False,
                "resources": ["probe"],
            }
        )
        files["tools/echo.tool.json"]["permissions"] = ["probe.send"]

    status, out, result = run_cli(
        tmp_path, build(tmp_path, change), grants=probe.grants(**{"probe.send": "session"})
    )
    err = capsys.readouterr().err
    assert status == 2
    assert "permission_denied at node echo" in err
    checked = [e for e in actions(result, "permission.checked") if e.get("reason")]
    assert checked[0]["reason"] == "sealed_value_egress"
    assert checked[0]["permission"] == "identity.read"
    assert not [e for e in actions(result, "tool.called") if e["tool"] == "echo"]


def test_m36_the_tool_scan_is_the_store_s_when_a_folder_is_given(tmp_path, capsys):
    memory = tmp_path / "memory"
    shutil.copytree(EXAMPLE_MEMORY, memory)

    def change(files):
        # The echo now carries the demo card token, which this run was never granted.
        files["graph.json"]["nodes"][5]["input"] = {"literal": {"to": "demo-visa-4242"}}
        files["fixtures/workflow.json"]["tools"]["echo"][0]["input"] = {"to": "demo-visa-4242"}

    status, out, result = run_cli(
        tmp_path,
        build(tmp_path, change),
        extra=(
            "--memory-dir",
            str(memory),
            "--memory-grant",
            f"memory.profile={probe.PROFILE_ID}",
            "--memory-grant",
            f"identity.read={probe.IDENTITY_ID}",
        ),
    )
    capsys.readouterr()
    assert status == 2
    checked = [e for e in actions(result, "permission.checked") if e.get("reason")]
    assert checked[0]["reason"] == "sealed_value_not_granted"
    assert checked[0]["record_id"] == "mem_4e5f60718293a4b5c6d7e8f90a1b2c3d"
    assert checked[0]["pointer"] == "/payment_method_id"


# -- N3, N4, N7: the mediator and the agent tools ------------------------------------------------
def test_n3_a_memory_read_under_a_denied_permission_stops_at_the_mediator(tmp_path, capsys):
    status, out, result = run_cli(
        tmp_path, build(tmp_path), grants=probe.grants(**{"memory.profile": "deny"})
    )
    err = capsys.readouterr().err
    assert status == 2
    assert "permission_denied at node profile" in err
    assert not [e for e in actions(result, "tool.called") if e["tool"] == "profile"]


def test_the_agent_permission_denied_never_stops_state_access(tmp_path, capsys):
    def change(files):
        nodes = files["graph.json"]["nodes"]
        files["graph.json"]["nodes"] = [
            n for n in nodes if n["id"] not in ("notes-read", "notes-write")
        ]
        remember = files["graph.json"]["nodes"][2]
        remember["depends_on"] = ["profile", "identity"]
        remember["input"]["object"]["notes"] = {"literal": ""}
        assemble = files["graph.json"]["nodes"][4]
        assemble["depends_on"] = ["echo", "remember"]
        assemble["input"]["object"]["staged"] = {"literal": None}

    status, _, result = run_cli(
        tmp_path, build(tmp_path, change), grants=probe.grants(**{"memory.agent": "deny"})
    )
    capsys.readouterr()
    assert status == 0
    assert result["memory"]["agent"] is None


def test_n4_an_agent_write_over_the_cap_fails_the_tool_schema(tmp_path, capsys):
    def change(files):
        # Only the model's answer is over the cap: a fixture case for the oversize write could
        # not exist (validation checks fixture inputs against the tool's schema).
        case = files["fixtures/workflow.json"]["models"]["remember"][0]
        case["output"]["notes"] = "x" * 32769
        files["graph.json"]["nodes"][3]["max_output_tokens"] = 16000
        files["graph.json"]["workers"][2]["budget"]["tokens"] = 60000
        files["policy/policy.json"]["budget"]["hard_tokens"] = 120000

    status, out, result = run_cli(tmp_path, build(tmp_path, change))
    err = capsys.readouterr().err
    assert status == 2
    assert "workflow.v0 schema_validation at node notes-write" in err


def test_n7_a_second_agent_write_is_over_its_budget(tmp_path, capsys):
    def change(files):
        nodes = files["graph.json"]["nodes"]
        second = json.loads(json.dumps(nodes[4]))
        second["id"] = "notes-write-again"
        second["writes"] = {"/echoed": {"from": "result", "path": ""}}
        second["depends_on"] = ["notes-write"]
        nodes.insert(5, second)
        nodes[6]["depends_on"] = ["identity"]
        assemble = nodes[7]
        assemble["depends_on"] = ["notes-write-again", "echo"]
        # the echo now writes nothing that the second write also writes
        nodes[6]["writes"] = {}

    status, _, result = run_cli(tmp_path, build(tmp_path, change))
    err = capsys.readouterr().err
    assert status == 2
    assert "budget_exhausted at node notes-write-again" in err


# -- validation: N5, N6, N10, N12, N16, N17, N21, M-38, M-48 -------------------------------------
def _invalid(tmp_path, change, match):
    source = build(tmp_path, change)
    with pytest.raises(ValidationError, match=match):
        load_package(source)


def test_n5_a_newer_minimum_runtime_is_refused_by_version(tmp_path):
    def change(files):
        files["MANIFEST.agent"]["runtime"]["minimum_version"] = "0.5.0"

    _invalid(tmp_path, change, "minimum_version exceeds reference runtime 0.4.0")


def test_m67_memory_declarations_need_runtime_0_4_0(tmp_path):
    def change(files):
        files["MANIFEST.agent"]["runtime"]["minimum_version"] = "0.3.0"

    _invalid(tmp_path, change, "^memory_minimum_version: ")


def test_n6_a_memory_read_whose_output_is_not_the_view_is_not_bound(tmp_path, capsys):
    def change(files):
        files["schemas/travel.profile.view.schema.json"]["properties"]["body"]["maxLength"] = 99

    status, out, result = run_cli(tmp_path, build(tmp_path, change))
    err = capsys.readouterr().err
    assert status == 2
    assert "binding_schema_mismatch: tool profile" in err
    assert result is None


def test_n10_publisher_scoped_memory_stays_refused(tmp_path):
    def change(files):
        files["policy/policy.json"]["memory"]["scope"] = "publisher-scoped"

    _invalid(tmp_path, change, "^agent_memory_scope: a memory permission names the agent")


def test_n12_memory_write_without_the_export(tmp_path):
    def change(files):
        files["graph.json"]["exports"] = []

    _invalid(tmp_path, change, "^memory_proposal_undeclared: a package declaring memory.write")


def test_the_export_without_memory_write(tmp_path):
    def change(files):
        files["policy/policy.json"]["permissions"].pop(4)

    _invalid(tmp_path, change, "^memory_proposal_undeclared: the export format memory.proposal")


def test_m38_reserved_types(tmp_path):
    def write_self(files):
        files["policy/policy.json"]["permissions"][4]["resources"] = ["person.self"]

    _invalid(tmp_path, write_self, "^memory_type_reserved: memory.write permission")

    def read_agent(files):
        files["policy/policy.json"]["permissions"][2]["resources"] = ["agent.memory"]

    _invalid(tmp_path / "b", read_agent, "^memory_type_reserved: memory.read permission")


def test_m33_one_type_per_read(tmp_path):
    def change(files):
        files["policy/policy.json"]["permissions"][2]["resources"] = ["travel.profile", "contact"]

    _invalid(tmp_path, change, "^ambiguous: ")


def test_m48_agent_tools_need_exact_schemas_and_one_write(tmp_path):
    def schema(files):
        files["schemas/agent-write.input.schema.json"]["properties"]["body"]["maxLength"] = 10

    _invalid(tmp_path, schema, "^binding_schema_mismatch: tool notes-write")

    def cap(files):
        files["policy/policy.json"]["budget"]["max_calls_per_tool"]["notes-write"] = 2

    _invalid(tmp_path / "b", cap, "^agent_memory_write_cap: tool notes-write")

    def outside(files):
        files["policy/policy.json"]["memory"].update(scope="session", retention="session")

    _invalid(tmp_path / "c", outside, "^agent_memory_scope: ")


def _custom(files, schema, local="loyalty.card"):
    files["policy/policy.json"]["memory_types"] = [
        {
            "id": local,
            "display_name": "Loyalty card",
            "description": "A loyalty programme membership.",
            "schema": "schemas/custom.schema.json",
        }
    ]
    files["MANIFEST.agent"]["schemas"].append(
        {"id": "custom", "path": "schemas/custom.schema.json"}
    )
    files["schemas/custom.schema.json"] = schema


CLOSED = {
    "type": "object",
    "properties": {"programme": {"type": "string"}, "member": {"type": "string"}},
    "required": ["programme"],
    "additionalProperties": False,
}


def test_a_closed_custom_type_is_accepted(tmp_path):
    load_package(build(tmp_path, lambda files: _custom(files, CLOSED)))


def test_n16_a_custom_type_shadowing_a_sealed_starter_field(tmp_path):
    nested = json.loads(json.dumps(CLOSED))
    nested["properties"]["holder"] = {
        "type": "object",
        "properties": {"email": {"type": "string"}},
        "additionalProperties": False,
    }
    _invalid(
        tmp_path,
        lambda files: _custom(files, nested),
        "^custom_type_shadows_sealed_type: custom type loyalty.card: a property named email",
    )


def test_n17_a_custom_type_with_a_well_known_id(tmp_path):
    _invalid(
        tmp_path,
        lambda files: _custom(files, CLOSED, local="contact"),
        '^custom_type_reserved: custom type id "contact" is a well-known id',
    )


@pytest.mark.parametrize(
    "schema,reason",
    [
        ({**CLOSED, "additionalProperties": True}, "additionalProperties is not false"),
        ({**CLOSED, "anyOf": [{}]}, "/: anyOf"),
        (
            {**CLOSED, "properties": {"labels": {"type": "array"}}, "required": []},
            "an array without items",
        ),
        ({**CLOSED, "properties": {"x": {}}, "required": []}, "/x: untyped"),
        ({**CLOSED, "properties": {"x": {"const": {"a": 1}}}, "required": []}, "const holds"),
    ],
)
def test_n21_a_custom_type_whose_schema_is_not_closed(tmp_path, schema, reason):
    _invalid(
        tmp_path,
        lambda files: _custom(files, schema),
        f"^custom_type_schema_open: custom type loyalty.card: the schema is not closed .*{reason}",
    )


def test_a_custom_type_declaring_sealed_fields_fails_the_policy_schema(tmp_path):
    def change(files):
        _custom(files, CLOSED)
        files["policy/policy.json"]["memory_types"][0]["sealed_fields"] = ["/member"]

    _invalid(tmp_path, change, "policy")


# -- the memory folder in a live run: reads, the agent document (N20) ----------------------------
def _live(tmp_path, source, memory, grants_flags, *, decisions=None):
    """A live-mode run over a memory folder with the fixture's models and non-memory tools,
    the way `agentpkg run --mode live` builds it (`cli_memory`)."""
    package = load_package(source)
    decisions = decisions or probe.grants()
    memory_run, folder, handlers = cli_memory(
        package, mode="live", decisions=decisions, memory_dir=memory, memory_grants=grants_flags
    )
    router, fixture_handlers, input_value = fixture_adapters(package)
    fixture_handlers.update(handlers)
    result = asyncio.run(
        run_workflow(
            package,
            input_value,
            grants=decisions,
            handlers=fixture_handlers,
            router=router,
            approved_tools=probe.TOOLS,
            memory=memory_run,
        )
    )
    return package, memory_run, folder, result


def test_live_reads_answer_the_grant_from_the_folder_and_commit_the_agent_document(tmp_path):
    memory = tmp_path / "memory"
    shutil.copytree(EXAMPLE_MEMORY, memory)
    source = build(tmp_path)
    package, memory_run, folder, result = _live(
        tmp_path,
        source,
        memory,
        [f"memory.profile={probe.PROFILE_ID}", f"identity.read={probe.IDENTITY_ID}"],
    )
    assert result["status"] == "completed"
    reads = actions(result, "memory.read")
    assert [(e["permission_id"], e["record_id"]) for e in reads] == sorted(
        [("memory.profile", probe.PROFILE_ID), ("identity.read", probe.IDENTITY_ID)]
    ) or sorted((e["permission_id"], e["record_id"]) for e in reads) == sorted(
        [("memory.profile", probe.PROFILE_ID), ("identity.read", probe.IDENTITY_ID)]
    )
    assert all(len(e["record_digest"]) == 64 for e in reads)
    committed = actions(result, "memory.agent.committed")
    assert committed and committed[0]["bytes"] == len(probe.NOTES.encode())
    path = folder.commit_agent_document(
        package, result["audit"][0]["run_id"], memory_run.staged_body()
    )
    assert path.parent.name == "agent.memory"
    # N20: the next read returns exactly what was written; no title or id was resolved.
    again = cli_memory(
        package, mode="live", decisions=probe.grants(), memory_dir=memory, memory_grants=[]
    )[1]
    document = again.agent_document("org.example.memory-probe")
    assert document["body"] == probe.NOTES
    assert agent_document_id("org.example.memory-probe") in again.records


def test_live_a_changed_record_is_not_answered(tmp_path):
    memory = tmp_path / "memory"
    shutil.copytree(EXAMPLE_MEMORY, memory)
    package = load_package(build(tmp_path))
    memory_run, folder, handlers = cli_memory(
        package,
        mode="live",
        decisions=probe.grants(),
        memory_dir=memory,
        memory_grants=[f"memory.profile={probe.PROFILE_ID}"],
    )
    folder.records[probe.PROFILE_ID]["title"] = "Edited after the plan"

    class Ctx:
        def event(self, *args, **kwargs):
            raise AssertionError("no audit for a refused read")

    with pytest.raises(Exception) as caught:
        asyncio.run(handlers["host.memory.travel.profile"](Ctx(), {}))
    assert getattr(caught.value, "code", None) == "tool_unavailable"


def test_memory_grant_refusals(tmp_path):
    memory = tmp_path / "memory"
    shutil.copytree(EXAMPLE_MEMORY, memory)
    package = load_package(build(tmp_path))

    def grant(flag):
        return cli_memory(
            package,
            mode="live",
            decisions=probe.grants(),
            memory_dir=memory,
            memory_grants=[flag],
        )

    with pytest.raises(ValidationError, match="not a memory.read or personal.read"):
        grant("memory.remember=self")
    with pytest.raises(ValidationError, match="^resource_selection_required: "):
        grant(f"memory.profile={probe.IDENTITY_ID}")
    with pytest.raises(ValidationError, match="^resource_removed: "):
        grant("memory.profile=mem_" + "c" * 32)
    with pytest.raises(ValidationError, match="--memory-grant requires --memory-dir"):
        cli_memory(
            package,
            mode="live",
            decisions=probe.grants(),
            memory_dir=None,
            memory_grants=[f"memory.profile={probe.PROFILE_ID}"],
        )


def test_the_privacy_preset_discards_the_agent_document(tmp_path):
    from agentpkg.memory.run import MemoryRun

    package = load_package(build(tmp_path))
    run = MemoryRun(package, [], probe.grants(), agent_discard="preset")
    run.agent["staged"] = {"body": "x", "bytes": 1}
    assert run.agent_outcome("completed") == {"committed": None, "discarded": "preset"}
    assert run.agent_outcome("failed") == {"committed": None, "discarded": "run_failed"}
    assert run.agent_outcome("cancelled") == {"committed": None, "discarded": "cancelled"}


def test_fixture_router_is_unchanged_by_memory():
    assert FixtureRouter.synthetic is True
