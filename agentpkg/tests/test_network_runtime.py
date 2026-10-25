"""network.v0 in the reference (spec/network-v0.md): the activations and their audit, the route
request the model sees, the reservation, the activation timeout, the per-tool cap across
activations, the transition check in depth, what `inspect`, the control plane and the plan say,
the CLI, the once rule, and a conversation whose turn runs a network with the consent gate
reaching a role's tool step."""

import asyncio
import json
from collections import Counter
from pathlib import Path

import pytest
from network_probe import grants, message, node, role, worker, write_probe
from shipped_keys import DIST  # noqa: F401 - the key fixtures module also sets sys.path

from agentpkg.cli import main
from agentpkg.delegation.analysis import worst_case
from agentpkg.delegation.runner import RouteRefusal, Walk, _check_transition
from agentpkg.errors import ValidationError
from agentpkg.execution.policy import HostExecutionLimits, _consumption_counts, check_capabilities
from agentpkg.execution.report import verify_audit_chain
from agentpkg.fixtures import FixtureRouter, fixture_adapters
from agentpkg.package import build_package, inspect_package, load_package
from agentpkg.runtime import BudgetError, PolicyError
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "spec" / "network-v0"


def _probe(tmp_path, **options):
    return load_package(write_probe(tmp_path / "probe", **options))


def _run(package, *, router=None, handlers=None, limits=None, decisions=None, **options):
    fixture_router, fixture_handlers, input_value = fixture_adapters(package)
    try:
        return asyncio.run(
            run_workflow(
                package,
                input_value,
                grants=decisions or grants(),
                handlers=handlers or fixture_handlers,
                router=router or fixture_router,
                approved_tools=["lookup"],
                limits=limits,
                **options,
            )
        )
    except Exception as exc:  # noqa: BLE001 - a classified failure carries its report
        report = getattr(exc, "execution_report", None)
        assert report is not None, exc
        report["exception"] = exc
        return report


def _events(audit, action):
    return [e for e in audit if e["action"] == action]


def test_the_schema_patch_is_applied_and_the_node_type_exists():
    live = json.loads(
        (ROOT / "agentpkg/src/agentpkg/schemas/workflow.schema.json").read_text(encoding="utf-8")
    )
    patch = json.loads((CONTRACTS / "workflow.schema.patch.json").read_text(encoding="utf-8"))
    assert {op["path"] for op in patch} >= {"/properties/network", "/$defs/role", "/$defs/route"}
    assert "network" in live["$defs"]["node"]["properties"]["type"]["enum"]
    assert "network" not in live["$defs"]["step"]["properties"]["type"]["enum"]
    assert "message" in live["$defs"]["value"]["oneOf"][1]["properties"]["from"]["enum"]
    assert live["properties"]["network"] == patch[0]["value"]


def test_the_fixture_walk_is_audited_activation_by_activation(tmp_path):
    package = _probe(tmp_path)
    report = _run(package)
    assert report["status"] == "completed"
    assert report["output"]["reply"] == "all done"
    assert report["output"]["draft"] == "draft:write it up"
    audit = report["audit"]
    assert verify_audit_chain(audit)["valid"] is True
    # The reservation, then one activation per visit: a worker instance each, named by the node.
    started = _events(audit, "network.started")[0]
    assert started["node_id"] == "delegate" and started["entry"] == "Desk"
    assert started["tokens_left"] == 11000 and started["remote_calls_left"] == 0
    assert started["bound"]["tokens"] == 11000 and started["bound"]["activations"] == {
        "Desk": 4,
        "Lookup": 2,
        "Writer": 1,
    }
    activated = [
        (e["role"], e["hop"], e["activation"]) for e in _events(audit, "network.activated")
    ]
    assert activated == [
        ("Desk", 0, 1),
        ("Lookup", 1, 1),
        ("Desk", 2, 2),
        ("Writer", 3, 1),
        ("Desk", 4, 3),
    ]
    spawned = [e["worker"] for e in _events(audit, "worker.spawned")]
    assert spawned == ["Desk:1", "Lookup:2", "Desk:3", "Writer:4", "Desk:5"]
    assert all(e["node_id"] == "delegate" for e in _events(audit, "worker.spawned"))
    # A role's steps are named by the node, the role and the step.
    step_nodes = {e["node_id"] for e in _events(audit, "node.completed")}
    assert {"delegate/Desk/read", "delegate/Desk/notes", "delegate/Lookup/lookup"} <= step_nodes
    assert {"delegate/Writer/draft", "delegate", "output"} <= step_nodes
    # Every handoff decided, with the reason it was allowed, before the next activation.
    decided = _events(audit, "route.decided")
    assert [(e["role"], e["next"], e["chosen_by"], e["allowed"]) for e in decided] == [
        ("Desk", "Lookup", "model", True),
        ("Lookup", "Desk", "package", True),
        ("Desk", "Writer", "model", True),
        ("Writer", "Desk", "package", True),
        ("Desk", "done", "model", True),
    ]
    assert decided[0]["uses"] == 1 and decided[0]["max_uses"] == 2 and decided[0]["hops_left"] == 6
    committed = [(e["role"], e["state_keys"]) for e in _events(audit, "network.state.committed")]
    assert committed == [
        ("Desk", ["notes"]),
        ("Lookup", ["answers"]),
        ("Desk", ["notes"]),
        ("Writer", ["draft"]),
        ("Desk", ["notes"]),
    ]
    completed = _events(audit, "network.completed")[0]
    assert completed["hops"] == 4 and completed["activations"] == {
        "Desk": 3,
        "Lookup": 1,
        "Writer": 1,
    }
    sequence = [e["action"] for e in audit]
    assert sequence.index("network.started") < sequence.index("network.activated")
    assert sequence.index("network.completed") < sequence.index(
        "node.completed", sequence.index("network.completed")
    )
    # Nothing the model or a tool wrote is in the chain.
    text = json.dumps(audit)
    assert "draft:write it up" not in text and "hello is a greeting" not in text
    # Each activation was its own worker instance under the role's budget.
    workers = report["usage"]["workers"]
    assert workers["Desk:1"]["tokens"] > 0 and workers["Lookup:2"]["tool_calls"] == {"lookup": 1}
    assert report["usage"]["tool_calls"] == {"lookup": 1}


def test_the_route_request_carries_the_availability_under_a_runtime_built_schema(tmp_path):
    package = _probe(tmp_path)
    fixture_router, _, _ = fixture_adapters(package)
    seen = []

    class Watching(FixtureRouter):
        async def complete(self, request, *, max_output_tokens):
            if request["task"] == "route":
                seen.append(request)
            return await super().complete(request, max_output_tokens=max_output_tokens)

    router = Watching(fixture_router.cases)
    report = _run(package, router=router)
    assert report["status"] == "completed"
    assert len(seen) == 3
    first = seen[0]
    assert first["output_schema"]["properties"]["next"] == {"enum": ["Lookup", "Writer", "done"]}
    assert first["output_schema"]["required"] == ["next", "message"]
    assert first["output_schema"]["additionalProperties"] is False
    assert first["data"]["hops_left"] == 6 and first["data"]["may_end"] is True
    assert [(t["role"], t["uses_left"]) for t in first["data"]["targets"]] == [
        ("Lookup", 2),
        ("Writer", 1),
    ]
    assert first["data"]["input"] == {"text": "hello", "notes": ["greeting"]}
    assert all("description" in t for t in first["data"]["targets"])
    third = seen[2]
    assert [(t["role"], t["uses_left"]) for t in third["data"]["targets"]] == [
        ("Lookup", 1),
        ("Writer", 0),
    ]
    assert third["data"]["hops_left"] == 2
    # The role's skill is the instructions of its route call, as of any of its model calls.
    assert first["instructions"] == [package.files["skills/desk/SKILL.md"].decode()]


def test_an_activation_runs_under_the_role_timeout(tmp_path):
    def slow(m):
        role(m, "Lookup")["timeout_seconds"] = 0.05

    package = _probe(tmp_path, mutate=slow)
    _, handlers, _ = fixture_adapters(package)

    async def sleepy(ctx, payload):
        await asyncio.sleep(1)
        return {"query": payload["query"], "answer": "late"}

    report = _run(package, handlers={**handlers, "desk.lookup": sleepy})
    assert report["status"] == "failed" and report["error_code"] == "timeout"
    failed = _events(report["audit"], "node.failed")
    assert failed[-1]["node_id"] == "delegate" and failed[-1]["error_code"] == "timeout"
    assert _events(report["audit"], "network.failed")[0]["role"] == "Lookup"


def test_the_node_timeout_is_named_timeout_by_the_node_and_the_network(tmp_path):
    """Review 1, nit 6: the node's own `timeout_seconds` cancels the network from outside; the
    node records `timeout` once the cancellation reaches it, and `network.failed` names the
    same cause, not `cancelled`."""

    def slow_node(m):
        node(m, "delegate")["timeout_seconds"] = 0.05

    package = _probe(tmp_path, mutate=slow_node)
    _, handlers, _ = fixture_adapters(package)

    async def sleepy(ctx, payload):
        await asyncio.sleep(1)
        return {"query": payload["query"], "answer": "late"}

    report = _run(package, handlers={**handlers, "desk.lookup": sleepy})
    assert report["status"] == "failed" and report["error_code"] == "timeout"
    failed = [e for e in _events(report["audit"], "node.failed") if e["node_id"] == "delegate"]
    assert failed and failed[0]["error_code"] == "timeout"
    network_failed = _events(report["audit"], "network.failed")
    assert network_failed[0]["error_code"] == "timeout" and network_failed[0]["role"] == "Lookup"


def test_a_role_answer_check_reads_the_answer_as_result(tmp_path):
    """Review 1, finding 1 (R-8): a role's `llm` step may declare answer checks, which read the
    answer as `result` as a map step's do; a refused check is a non-conforming answer at
    `<node>/<role>/<step>`, charged and audited as everywhere."""
    from network_probe import VARIANTS

    passing = _probe(tmp_path / "ok", mutate=VARIANTS["answer-check-in-role"])
    assert passing.graph["network"]["roles"]["Writer"]["steps"][0]["checks"]
    report = _run(passing)
    assert report["status"] == "completed"
    assert report["output"]["draft"] == "draft:write it up"

    refused = _probe(tmp_path / "refused", mutate=VARIANTS["answer-check-refused-in-role"])
    report = _run(refused)
    assert report["status"] == "failed" and report["error_code"] == "model_error"
    failed_calls = _events(report["audit"], "model.failed")
    assert failed_calls[-1]["reason"] == "model_output_not_conforming"
    assert failed_calls[-1]["failed_check"]["check"] == "answer_check"
    assert failed_calls[-1]["failed_check"]["failure"] == "values_differ"
    step = [e for e in _events(report["audit"], "node.failed") if "Writer" in e["node_id"]]
    assert step[0]["node_id"] == "delegate/Writer/draft"
    assert step[0]["error_code"] == "model_error"
    assert step[0]["failed_check"]["check"] == "answer_check"
    # The answer was paid for, nothing after it ran: no route of the Writer, no commit of it.
    assert len(_events(report["audit"], "route.decided")) == 3
    assert len(_events(report["audit"], "network.state.committed")) == 3

    # A check may read only the answer beyond the role's three sources.
    def input_in_check(m):
        role(m, "Writer")["steps"][0]["checks"] = [
            {
                "kind": "equal",
                "left": {"from": "result", "path": "/draft"},
                "right": {"from": "input", "path": "/text"},
            }
        ]

    with pytest.raises(ValidationError, match="^network_source_scope: .*checks/0/right"):
        _probe(tmp_path / "scope", mutate=input_in_check)


def test_an_invalid_patch_is_refused_before_the_route_is_asked(tmp_path):
    """Review 1, finding 2 (R-9, R-15): the patch is validated over the shared state inside the
    activation, before its route, so that a failed patch costs no route call and records no
    handoff that never happens."""
    from network_probe import VARIANTS

    package = _probe(tmp_path, mutate=VARIANTS["patch-outside-schema-chosen"])
    report = _run(package)
    assert report["status"] == "failed" and report["error_code"] == "schema_validation"
    audit = report["audit"]
    assert _events(audit, "route.decided") == []
    assert len(_events(audit, "model.completed")) == 1  # the read step; no route call
    assert _events(audit, "network.state.committed") == []
    failed = [e for e in _events(audit, "node.failed") if e["node_id"] == "delegate"]
    assert failed[0]["failed_check"]["check"] == "network_state"
    assert _events(audit, "network.failed")[0]["error_code"] == "schema_validation"


def test_a_view_key_that_initial_does_not_set_is_refused_statically(tmp_path):
    """Review 1, finding 3 (R-6): a patch sets keys and never removes one, so a key `initial`
    sets is present in every state and a key it does not set may be absent when a role or the
    result reads it; the view and the result are refused at validation, not after the
    reservation and the earlier steps' calls."""
    from network_probe import VARIANTS

    with pytest.raises(ValidationError, match="^network_state_read_uninitialized: role Desk"):
        _probe(tmp_path / "role", mutate=VARIANTS["read-uninitialized"])

    def result_reads_it(m):
        VARIANTS["read-uninitialized"](m)
        for role_id in ("Desk", "Writer"):
            worker(m, role_id)["state_read"] = [
                k for k in worker(m, role_id)["state_read"] if k != "draft"
            ]
        role(m, "Desk")["steps"][0]["input"] = {"object": {"text": message("/text")}}

    with pytest.raises(ValidationError, match="^network_state_read_uninitialized: network.result"):
        _probe(tmp_path / "result", mutate=result_reads_it)

    def written_only(m):
        # A key no view reads may be left to its writer: Writer sets `draft`, the result reads
        # the message instead.
        result_reads_it(m)
        m["graph.json"]["network"]["result"]["object"]["draft"] = {"literal": None}

    package = _probe(tmp_path / "ok", mutate=written_only)
    assert _run(package)["status"] == "completed"


def test_the_run_s_at_most_in_seconds_is_the_effective_deadline(tmp_path):
    """Review 1, nit 4 (R-21): `network.started` reports the bound under the deadline the host
    enforces, the figure the execution host recorded, not the graph's declared one."""
    package = _probe(tmp_path)
    started = _events(_run(package)["audit"], "network.started")[0]
    assert started["bound"]["seconds"] == 120  # the node's timeout under the graph's 300
    started = _events(_run(package, deadline_seconds=50)["audit"], "network.started")[0]
    assert started["bound"]["seconds"] == 50
    facts = check_capabilities(
        package,
        HostExecutionLimits(run_timeout_seconds=50),
        tool_bindings=[{"tool_id": "lookup"}],
    )
    assert facts["network"]["worst_case"]["seconds"] == started["bound"]["seconds"]
    # Each role's budget per activation and its activation bound (T26, D-291).
    workers = {w["id"]: w for w in package.graph["workers"]}
    assert facts["network"]["role_budgets"] == {
        role_id: {
            "tokens": workers[role_id]["budget"]["tokens"],
            "remote_calls": workers[role_id]["budget"]["remote_calls"],
            "activation_bound": started["bound"]["activations"][role_id],
        }
        for role_id in ("Desk", "Lookup", "Writer")
    }


def test_the_sentence_says_who_chooses(tmp_path):
    """Review 1, nit 7: a network whose routes are all fixed is valid, and the agent page does
    not say the model chooses in it. T25 review 2, nit 6: a mixed network (the probe: Desk
    chooses, Lookup and Writer return by a fixed route) says which roles are which, and a network
    whose every route is chosen says so."""
    from agentpkg.browser.summary import network_sentence
    from agentpkg.delegation.declarations import network_records

    mixed = network_records(_probe(tmp_path / "mixed"))
    sentence = network_sentence(mixed)
    assert sentence.startswith(
        "The package delegates between 3 roles (Desk, Lookup, Writer), the next role chosen by "
        "the model after Desk and fixed by the package after Lookup and Writer, within a "
        "declared envelope: at most 6 handoffs;"
    ), sentence
    assert "while it runs" not in sentence

    def all_chosen(m):
        desk = role(m, "Desk")["route"]
        for role_id in ("Lookup", "Writer"):
            role(m, role_id)["route"] = {
                "task": desk["task"],
                "max_output_tokens": desk["max_output_tokens"],
                "input": {"object": {"text": message("/text")}},
            }

    chosen = network_records(_probe(tmp_path / "chosen", mutate=all_chosen))
    assert all(r["route"]["kind"] == "chosen" for r in chosen["roles"])
    assert "roles chosen by the model while it runs (Desk, Lookup, Writer)" in network_sentence(
        chosen
    )

    def all_fixed(m):
        reply = {"object": {"text": message("/text")}}
        role(m, "Desk")["route"] = {"next": "done", "message": reply}
        m["_walk"] = []

    fixed = network_records(_probe(tmp_path / "fixed", mutate=all_fixed))
    assert all(r["route"]["kind"] == "fixed" for r in fixed["roles"])
    sentence = network_sentence(fixed)
    assert "along handoffs the package fixed" in sentence
    assert "chosen by the model" not in sentence


def test_the_per_tool_cap_counts_across_activations(tmp_path):
    def two(m):
        m["policy/policy.json"]["budget"]["max_calls_per_tool"] = {"lookup": 1}
        m["_walk"] = [("Lookup", "look up hello"), ("Lookup", "look up again"), ("done", "x")]

    package = _probe(tmp_path, mutate=two)
    assert inspect_package(package)["network"]["worst_case"]["tool_calls"] == {"lookup": 1}
    report = _run(package)
    assert report["status"] == "failed" and report["error_code"] == "budget_exhausted"
    failed = [
        e
        for e in _events(report["audit"], "node.failed")
        if e["node_id"] == "delegate/Lookup/lookup"
    ]
    assert failed and failed[0]["error_code"] == "budget_exhausted"
    assert len(_events(report["audit"], "tool.called")) == 1


def test_the_host_limits_lower_the_bound_and_the_reservation_reads_them(tmp_path):
    package = _probe(tmp_path)
    report = _run(package, limits={"hard_tokens": 9000})
    started = _events(report["audit"], "network.started")[0]
    assert started["bound"]["tokens"] == 9000 and started["tokens_left"] == 9000
    assert report["status"] == "completed"
    facts = check_capabilities(
        package, HostExecutionLimits(total_tokens=5000), tool_bindings=[{"tool_id": "lookup"}]
    )
    assert facts["network"]["worst_case"]["tokens"] == 5000
    assert facts["network"]["worst_case"]["relaxation"]["tokens"] == 11000
    assert facts["network"]["roles"] == ["Desk", "Lookup", "Writer"]
    assert facts["network"]["worst_case"]["seconds"] == 120
    assert (
        check_capabilities(
            package,
            HostExecutionLimits(run_timeout_seconds=50),
            tool_bindings=[{"tool_id": "lookup"}],
        )["network"]["worst_case"]["seconds"]
        == 50
    )
    assert facts["llm_operations"][-1] == {"node": "delegate/Desk/route", "max_output_tokens": 200}


def test_the_network_input_must_match_the_message_schema(tmp_path):
    def strict(m):
        m["schemas/short.schema.json"] = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {"text": {"type": "string", "maxLength": 3}},
            "required": ["text"],
            "additionalProperties": False,
        }
        m["MANIFEST.agent"]["schemas"].append({"id": "short", "path": "schemas/short.schema.json"})
        m["graph.json"]["network"]["message_schema"] = "schemas/short.schema.json"

    package = _probe(tmp_path, mutate=strict)
    report = _run(package)
    assert report["status"] == "failed" and report["error_code"] == "schema_validation"
    failed = _events(report["audit"], "node.failed")[0]
    assert failed["node_id"] == "delegate" and failed["failed_check"] == {
        "check": "message_schema",
        "schema": "schemas/short.schema.json",
    }
    assert not _events(report["audit"], "network.started")


class _Recorder:
    def __init__(self):
        self.events = []

    def record(self, action, *, context=None, **metadata):
        self.events.append({"action": action, **metadata})


def test_the_transition_check_refuses_in_depth_what_the_enum_already_refuses(tmp_path):
    package = _probe(tmp_path)
    network = package.graph["network"]
    rt = _Recorder()
    walk = Walk(activations=Counter({"Desk": 1}))
    with pytest.raises(RouteRefusal) as refused:
        _check_transition(
            rt,
            None,
            "delegate",
            network,
            "Desk",
            network["roles"]["Desk"],
            walk,
            {"next": "Nobody", "message": {}},
            "model",
        )
    assert refused.value.failed_check == {
        "check": "route",
        "failure": "edge_undeclared",
        "next": None,
    }
    assert refused.value.code == "model_output_not_conforming"
    assert rt.events[-1]["allowed"] is False and rt.events[-1]["next"] is None
    with pytest.raises(PolicyError):
        _check_transition(
            rt,
            None,
            "delegate",
            network,
            "Lookup",
            network["roles"]["Lookup"],
            walk,
            {"next": "done", "message": {}},
            "package",
        )
    assert rt.events[-1]["reason"] == "end_not_allowed"
    walk.hop = 6
    with pytest.raises(BudgetError):
        _check_transition(
            rt,
            None,
            "delegate",
            network,
            "Lookup",
            network["roles"]["Lookup"],
            walk,
            {"next": "Desk", "message": {}},
            "package",
        )
    assert rt.events[-1]["reason"] == "hops_exhausted"


def test_inspect_records_the_envelope(tmp_path):
    package = _probe(tmp_path)
    records = inspect_package(package)["network"]
    assert records["entry"] == "Desk" and records["max_hops"] == 6 and records["node"] == "delegate"
    assert records["state_keys"] == ["notes", "answers", "draft"]
    desk = next(r for r in records["roles"] if r["id"] == "Desk")
    assert desk["activation_bound"] == 4 and desk["route"] == {"kind": "chosen", "task": "route"}
    assert desk["per_activation"]["model_calls"] == 2 and desk["edges"] == [
        {"to": "Lookup", "max_uses": 2},
        {"to": "Writer", "max_uses": 1},
    ]
    lookup = next(r for r in records["roles"] if r["id"] == "Lookup")
    assert lookup["route"] == {"kind": "fixed", "next": "Desk"} and lookup["tools"] == ["lookup"]
    assert records["worst_case"] == worst_case(package.graph, package.policy)
    assert records["worst_case"]["model_calls"] == 9 and records["worst_case"]["tool_calls"] == {
        "lookup": 2
    }


def test_the_control_plane_says_at_most_and_the_plan_records_it(tmp_path):
    from tool_fakes import registry_for

    from agentpkg.browser import ControlPlane, ControlPlaneConfig
    from agentpkg.browser.trust import read_public_key_file
    from agentpkg.signing import keygen, sign_package

    source = write_probe(tmp_path / "probe")
    unsigned = build_package(source, tmp_path / "probe.agent.pkg")
    keygen(tmp_path / "dev.private.pem", tmp_path / "dev.pub.pem")
    archive = sign_package(
        unsigned, tmp_path / "dev.private.pem", tmp_path / "probe-signed.agent.pkg"
    )
    control = ControlPlane(
        ControlPlaneConfig(
            cache_dir=str(tmp_path / "cache"), trust_store_path=str(tmp_path / "trust.json")
        )
    )
    control.trust_add(
        read_public_key_file(tmp_path / "dev.pub.pem"), display_name="dev", publisher_id="example"
    )
    summary = control.open_file(str(archive))
    network = summary["workflow"]["network"]
    assert network["worst_case"]["tokens"] == 11000 and network["entry"] == "Desk"
    warning = next(w for w in summary["warnings"] if w["code"] == "delegation_network")
    assert warning["severity"] == "info"
    assert (
        "at most 6 handoffs" in warning["message"] and "Desk at most 4 times" in warning["message"]
    )
    assert (
        "at most 9 model calls, 2 tool calls (lookup 2), 0 remote calls and 11000 tokens"
        in warning["message"]
    )
    session = summary["session"]["id"]
    digest = summary["package"]["digest"]
    package = control._session(session).package
    request = control.permissions(session)
    decisions = {p["id"]: "session" for p in request["permissions"]}
    receipt = control.authorize(
        session,
        package_digest=digest,
        decisions=decisions,
        tool_approvals={t["tool_id"]: True for t in request["tool_approvals"]},
    )
    catalog = {
        "schema": "agentpkg-host-model-catalog-v0",
        "host": {"runtime": "test", "source": "test", "captured_at": "2026-10-24T12:00:00+00:00"},
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
    registry = registry_for(package)
    control.evaluate_tools(session, package_digest=digest, tool_registry=registry)
    control.evaluate_models(session, package_digest=digest, catalog=catalog)
    state = control.prepare_run_plan(
        session,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id="host/alpha",
        catalog=catalog,
        tool_registry=registry,
    )
    plan = state["run_plan"]
    assert plan["execution"]["network"]["worst_case"]["tokens"] == 11000
    assert plan["execution"]["network"]["roles"] == ["Desk", "Lookup", "Writer"]
    assert plan["execution"]["network"]["node"] == "delegate"


def test_the_cli_runs_a_network_package_in_fixture_mode(tmp_path, capsys):
    source = write_probe(tmp_path / "probe")
    (tmp_path / "grants.json").write_text(json.dumps(grants()))
    status = main(
        [
            "run",
            str(source),
            "--mode",
            "fixture",
            "--grants",
            str(tmp_path / "grants.json"),
            "--approve-tool",
            "lookup",
            "--out",
            str(tmp_path / "out"),
        ]
    )
    report = json.loads(capsys.readouterr().out)
    assert status == 0 and report["passed"] is True
    result = json.loads((tmp_path / "out" / "result.json").read_text())
    assert result["output"]["answers"][0]["answer"] == "hello is a greeting"
    audit = json.loads((tmp_path / "out" / "audit.json").read_text())
    assert verify_audit_chain(audit)["valid"] is True
    assert len(_events(audit, "route.decided")) == 5
    assert (tmp_path / "out" / "result-copy.json").exists()


def test_consumption_counts_take_the_activation_bounds(tmp_path):
    package = _probe(tmp_path)
    counts = _consumption_counts(package)
    # Four Desk, two Lookup and one Writer activations each spawn a worker (the memory
    # permission), Desk makes two model calls per activation and Writer one; the lookup tool's
    # permission is consumed at most twice (its per-activation count times the bound, under the
    # package's per-tool cap).
    assert counts["memory"] == 7 and counts["model"] == 9 and counts["files.read"] == 2


def _conversational(m):
    """The probe as a conversational package: the last reply persists, and a consent step before
    the network gates the lookup tool's permission (conversation.v0 V-9 reaches a role's step)."""
    graph = m["graph.json"]
    graph["conversation"] = {
        "state_schema": "schemas/conversation-state.schema.json",
        "initial": {"literal": {"last": None}},
        "budget": {"max_turns": 2, "hard_tokens": 22000, "max_remote_calls": 0},
    }
    m["schemas/conversation-state.schema.json"] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {"last": {"type": ["string", "null"]}},
        "required": ["last"],
        "additionalProperties": False,
    }
    m["schemas/consent-decision.schema.json"] = json.loads(
        (ROOT / "spec/conversation-v0/consent-decision.schema.json").read_text()
    )
    m["MANIFEST.agent"]["schemas"] += [
        {"id": "conversation-state", "path": "schemas/conversation-state.schema.json"},
        {"id": "consent-decision", "path": "schemas/consent-decision.schema.json"},
    ]
    state_schema = m["schemas/state.schema.json"]
    state_schema["properties"]["last"] = {"type": ["string", "null"]}
    state_schema["properties"]["decision"] = {
        "anyOf": [{"$ref": "consent-decision.schema.json"}, {"type": "null"}]
    }
    state_schema["required"] += ["last", "decision"]
    graph["initial_state"]["object"]["last"] = {"from": "conversation", "path": "/last"}
    graph["initial_state"]["object"]["decision"] = {"literal": None}
    coordinator = worker(m, "Coordinator")
    coordinator["state_read"] += ["last", "decision"]
    coordinator["state_write"] += ["last", "decision"]
    graph["nodes"].insert(
        0,
        {
            "id": "allow-lookup",
            "type": "consent",
            "worker": "Coordinator",
            "depends_on": [],
            "permissions": ["desk.read"],
            "text": {"literal": "May the desk look things up in its index for this message?"},
            "input": {"object": {"text": {"from": "state", "path": "/request/text"}}},
            "output_schema": "schemas/consent-decision.schema.json",
            "timeout_seconds": 10,
            "writes": {"/decision": {"from": "result", "path": ""}},
        },
    )
    delegate = node(m, "delegate")
    delegate["depends_on"] = ["allow-lookup"]
    delegate["writes"]["/last"] = {"from": "result", "path": "/reply"}


def test_a_conversation_turn_may_run_a_network_and_the_gate_reaches_a_role_step(tmp_path):
    from agentpkg.conversation import Conversation

    package = _probe(tmp_path, mutate=_conversational)
    router, handlers, _ = fixture_adapters(package)
    transcript = {
        "schema": "conversation.transcript.v0",
        "turns": [
            {"message": {"text": "hello"}, "consents": {"allow-lookup": True}},
            {"message": {"text": "hello"}},
        ],
    }
    conversation = Conversation(
        package,
        grants=grants(),
        approved_tools=["lookup"],
        adapters=lambda turn: {"router": router, "handlers": handlers},
    )
    result = asyncio.run(conversation.run(transcript))
    turns = result["transcript"]["turns"]
    assert [t["status"] for t in turns] == ["completed", "failed"]
    assert turns[0]["reply"]["reply"] == "all done" and result["state"] == {"last": "all done"}
    # Turn 2: the transcript decides nothing, the host answers denied, so the lookup inside the
    # Lookup role is refused by the gate, the activation fails and the turn with it; the
    # persisted state is turn 1's.
    assert turns[1]["error_code"] == "permission_denied"
    audit = result["audit"]
    decided = [e for e in audit if e["action"] == "consent.decided"]
    assert [(e["turn"], e["decided_by"], e["accepted"]) for e in decided] == [
        (1, "transcript", True),
        (2, "host", False),
    ]
    refused = [
        e
        for e in audit
        if e["action"] == "permission.checked" and e.get("reason") == "consent_denied"
    ]
    assert refused and refused[0]["tool"] == "lookup" and refused[0]["turn"] == 2
    assert refused[0]["consent_steps"] == ["allow-lookup"]
    assert verify_audit_chain(audit)["valid"] is True
    networks = [e for e in audit if e["action"] == "network.started"]
    assert [e["turn"] for e in networks] == [1, 2]


def test_a_role_tool_step_behind_a_gate_must_depend_on_its_consent_step(tmp_path):
    def ungated(m):
        _conversational(m)
        node(m, "delegate")["depends_on"] = []
        node(m, "output")["depends_on"].append("allow-lookup")

    with pytest.raises(ValidationError, match="^consent_missing_before_tool: ") as refused:
        _probe(tmp_path, mutate=ungated)
    assert "delegate/Lookup/lookup" in str(refused.value)


def test_an_activation_returns_only_its_patch_and_decision(tmp_path):
    """T25 review 2, nit 4: the next shared state stays in the loop; what an activation's worker
    returns, and `worker.completed` hashes, is what crosses its boundary (the patch and the
    decision), never keys outside the role's view."""
    report = _run(_probe(tmp_path))
    assert report["status"] == "completed"
    roles = {
        e["worker"]: e["role"] for e in _events(report["audit"], "worker.spawned") if e["role"]
    }
    completed = [e for e in _events(report["audit"], "worker.completed") if e["worker"] in roles]
    assert completed and all(e["state_keys"] == ["decision", "patch"] for e in completed)


def test_a_deferred_failure_is_read_from_the_context_too():
    """T25 review 2, nit 3: the node finds the loop's deferred event on the exception, its cause,
    or its context (the `TimeoutError` `asyncio.timeout` raises from the cancellation)."""
    from agentpkg.workflow import _deferred_failure

    deferred = ("network.failed", {"node_id": "delegate", "hop": 1, "role": "Desk"})
    inner = asyncio.CancelledError()
    inner.deferred_failure = deferred
    try:
        try:
            raise inner
        except asyncio.CancelledError:
            raise TimeoutError  # noqa: B904 - the implicit context is the point of the test
    except TimeoutError as exc:
        assert exc.__cause__ is None and exc.__context__ is inner
        assert _deferred_failure(exc) == deferred
    assert _deferred_failure(TimeoutError()) is None
