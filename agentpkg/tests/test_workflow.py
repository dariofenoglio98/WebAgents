"""Behavioral tests for one interpreter, independent of application orchestration."""

import asyncio
import copy
import importlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from agentpkg.errors import ValidationError
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, load_package
from agentpkg.runtime import digest
from agentpkg.workflow import Workflow, WorkflowError, run_workflow

ROOT = Path(__file__).resolve().parents[2]


def write(path, value):
    path.write_text(json.dumps(value))


def change(path, operation):
    value = json.loads(path.read_text())
    operation(value)
    write(path, value)


def source(tmp_path, name="meeting-agenda"):
    destination = tmp_path / name
    shutil.copytree(ROOT / "agents" / name, destination)
    return destination


def execute(package, **options):
    router, handlers, value = fixture_adapters(package)
    return asyncio.run(
        run_workflow(
            package,
            value,
            **{
                "router": router,
                "handlers": handlers,
                "grants": {p["id"]: "session" for p in package.policy["permissions"]},
                # Fixture replay exercises the same enforcement path as a live
                # run, so every declared tool needs its approval here too.
                "approved_tools": sorted(package.tools),
                **options,
            },
        )
    )


@pytest.mark.parametrize("name", ["literature-review", "meeting-agenda"])
def test_same_interpreter_from_built_artifacts(name, tmp_path):
    artifact = build_package(ROOT / "agents" / name, tmp_path / (name + ".agent.pkg"))
    package = load_package(artifact)
    result = execute(package)
    assert result["status"] == "completed"
    assert result["provenance"]["interpreter"] == "agentpkg.workflow.Workflow"
    assert result["usage"]["peak_parallel_workers"] == 3
    events = result["audit"]
    actions = {e["action"] for e in events}
    assert {
        "workflow.started",
        "workflow.completed",
        "node.started",
        "node.completed",
        "worker.spawned",
        "worker.completed",
        "model.called",
        "model.completed",
        "permission.checked",
        "delegation.checked",
        "budget.updated",
    } <= actions
    top_done = [e["node_id"] for e in events if e["action"] == "node.completed" and not e["worker"]]
    assert set(top_done) == {n["id"] for n in package.graph["nodes"]}
    if name == "literature-review":
        # 0.2.1's bounded review: three results per query, at most three
        # selected papers. Replay still exercises deduplication, a selected PDF,
        # an abstract-only paper and an ambiguous citation that stays unresolved.
        assert result["usage"]["tool_calls"]["scholarly-search"] == 3
        assert result["usage"]["tool_calls"]["citation-resolver"] == 3
        assert result["usage"]["tool_calls"]["paper-reader"] == 2
        assert len(result["state"]["raw_candidates"]) == 9
        assert len(result["state"]["candidate_papers"]) == 8
        assert len(result["state"]["citation_jobs"]) == 3
        assert len(result["output"]["bibliography"]) == 2
        assert len(result["output"]["evidence_table"]) == 7
        assert {c["status"] for c in result["state"]["citation_records"]} == {
            "resolved",
            "ambiguous",
        }
        assert [u["status"] for u in result["output"]["unresolved"]] == [
            "ambiguous",
            "screening_maybe",
        ]
        assert "SYNTHETIC DEMONSTRATION" in result["output"]["related_work"]
    else:
        assert sum(item["minutes"] for item in result["output"]["agenda"]) == 45
        assert result["usage"]["remote_calls"] == 0
    previous = None
    for event in events:
        assert event["previous_hash"] == previous
        assert digest({k: v for k, v in event.items() if k != "event_hash"}) == event["event_hash"]
        previous = event["event_hash"]


def test_package_and_node_identity_are_not_dispatch_keys(tmp_path):
    path = source(tmp_path)
    change(
        path / "MANIFEST.agent",
        lambda m: m.update(package_id="org.example.unknown", name="Unrelated title"),
    )

    def rename(g):
        ids = {n["id"]: f"n{i}" for i, n in enumerate(g["nodes"])}
        for n in g["nodes"]:
            n["id"] = ids[n["id"]]
            n["depends_on"] = [ids[x] for x in n["depends_on"]]
        g["nodes"].reverse()  # File order is not execution order.

    change(path / "graph.json", rename)
    result = execute(load_package(path))
    assert result["status"] == "completed"
    assert result["provenance"]["package_id"] == "org.example.unknown"


def test_no_application_imports_or_terms_in_generic_execution():
    modules = [
        "workflow",
        "workflow_values",
        "workflow_assertions",
        "workflow_validation",
        "runtime",
        "validation",
        "fixtures",
    ]
    for name in modules:
        text = Path(importlib.import_module("agentpkg." + name).__file__).read_text().lower()
        for forbidden in [
            "literature",
            "citation",
            "evidence",
            "related_work",
            "meeting",
            "agenda",
        ]:
            assert forbidden not in text, (name, forbidden)
    code = """
import asyncio, sys
from agentpkg.package import load_package
from agentpkg.workflow import run_workflow
from agentpkg.fixtures import fixture_adapters
for name in ('literature-review', 'meeting-agenda'):
 p=load_package('agents/'+name)
 r,h,i=fixture_adapters(p)
 asyncio.run(run_workflow(p,i,router=r,handlers=h,approved_tools=sorted(p.tools),
  grants={x['id']:'session' for x in p.policy['permissions']}))
assert not any('literature' in m or m.startswith('agentpkg.dev') for m in sys.modules)
"""
    subprocess.run([sys.executable, "-c", code], cwd=ROOT, check=True, timeout=30)


class Router:
    remote = False
    capabilities = {"reasoning", "structured_output"}
    context_window = 1000000
    router_id = model_id = "test"

    def __init__(self, wrapped):
        self.wrapped = wrapped
        self.active = 0
        self.peak = 0
        self.cancelled = 0
        self.calls = []

    async def count_tokens(self, request):
        return 10

    async def complete(self, request, *, max_output_tokens):
        self.calls.append(copy.deepcopy(request))
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(0.01)
            output = await self.wrapped.complete(request, max_output_tokens=max_output_tokens)
            return {**output, "input_tokens": 10, "output_tokens": 10}
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        finally:
            self.active -= 1


@pytest.mark.parametrize("limit", [1, 2, 3])
def test_map_parallel_limits_and_stable_order(limit):
    p = load_package(ROOT / "agents/meeting-agenda")
    fixture, _, _ = fixture_adapters(p)
    router = Router(fixture)
    result = execute(p, router=router, limits={"max_parallel_workers": limit})
    assert router.peak == result["usage"]["peak_parallel_workers"] == limit
    assert [x["role"] for x in result["state"]["perspectives"]] == [
        "Product",
        "Engineering",
        "Support",
    ]
    assert all(
        "requirements" in request
        and "budget_context" in request
        and "audit_context" in request
        and request["instructions"]
        for request in router.calls
    )


def test_role_instance_limit_bounds_workers(tmp_path):
    path = source(tmp_path)

    def cap(g):
        next(r for r in g["workers"] if r["id"] == "Perspective")["max_instances"] = 1
        g["nodes"][1]["max_parallel"] = 1

    change(path / "graph.json", cap)
    p = load_package(path)
    fixture, _, _ = fixture_adapters(p)
    router = Router(fixture)
    assert execute(p, router=router)["usage"]["peak_parallel_workers"] == 1


@pytest.mark.parametrize("permission", ["memory.session", "model.reasoning"])
def test_permission_denial_before_model_dispatch(permission):
    p = load_package(ROOT / "agents/meeting-agenda")
    router, _, _ = fixture_adapters(p)
    grants = {x["id"]: "session" for x in p.policy["permissions"]}
    grants[permission] = "deny"
    with pytest.raises(WorkflowError) as caught:
        execute(p, router=router, grants=grants)
    assert caught.value.code == "permission_denied"
    assert not router.calls
    assert caught.value.execution_report["status"] == "failed"


def test_token_budget_exhaustion_and_no_reservation_leak():
    p = load_package(ROOT / "agents/meeting-agenda")
    with pytest.raises(WorkflowError) as caught:
        execute(p, limits={"hard_tokens": 5})
    report = caught.value.execution_report
    assert report["error_code"] == "budget_exhausted"
    assert report["usage"]["tokens"] == report["usage"]["reserved_tokens"] == 0


def test_tool_remote_budget_exhaustion_before_call():
    p = load_package(ROOT / "agents/literature-review")
    with pytest.raises(WorkflowError) as caught:
        execute(p, limits={"max_remote_calls": 0})
    assert caught.value.code == "budget_exhausted"
    assert caught.value.execution_report["usage"]["remote_calls"] == 0


def test_model_schema_failure(tmp_path):
    p = load_package(source(tmp_path))
    fixture, _, _ = fixture_adapters(p)

    class Invalid(Router):
        async def complete(self, request, *, max_output_tokens):
            return {"output": {"wrong": True}, "input_tokens": 10, "output_tokens": 2}

    with pytest.raises(WorkflowError) as caught:
        execute(p, router=Invalid(fixture))
    assert caught.value.code == "schema_validation"
    assert caught.value.execution_report["usage"]["tokens"] == 12


def test_worker_failure_cancels_other_map_children(tmp_path):
    p = load_package(source(tmp_path))
    fixture, _, _ = fixture_adapters(p)

    class Failing(Router):
        async def complete(self, request, *, max_output_tokens):
            if request["task"] == "perspective":
                if request["data"]["participant"]["role"] == "Product":
                    await asyncio.sleep(0.01)
                    raise ValueError("private-provider-detail")
                try:
                    await asyncio.sleep(30)
                except asyncio.CancelledError:
                    self.cancelled += 1
                    raise
            return await super().complete(request, max_output_tokens=max_output_tokens)

    router = Failing(fixture)
    with pytest.raises(WorkflowError) as caught:
        execute(p, router=router)
    report = caught.value.execution_report
    assert report["error_code"] == "model_error"
    assert router.cancelled == 2
    assert report["usage"]["reserved_tokens"] == 0
    assert "private-provider-detail" not in json.dumps(report)
    assert not any(
        e["action"] == "state.committed" and "perspectives" in e["nodes"] for e in report["audit"]
    )


@pytest.mark.parametrize("scope", ["node", "workflow", "count"])
def test_timeouts_include_model_preflight_and_whole_workflow(tmp_path, scope):
    path = source(tmp_path)
    change(
        path / "graph.json",
        lambda g: (
            g.update(deadline_seconds=0.02)
            if scope == "workflow"
            else g["nodes"][0].update(timeout_seconds=0.02)
        ),
    )
    p = load_package(path)
    fixture, _, _ = fixture_adapters(p)

    class Slow(Router):
        async def count_tokens(self, request):
            if scope == "count":
                await asyncio.sleep(30)
            return 10

        async def complete(self, request, *, max_output_tokens):
            await asyncio.sleep(30)

    with pytest.raises(WorkflowError) as caught:
        execute(p, router=Slow(fixture))
    assert caught.value.code == "timeout"
    assert caught.value.execution_report["usage"]["reserved_tokens"] == 0


def test_cancellation_drains_workers_clears_state_and_retains_audit():
    async def check():
        p = load_package(ROOT / "agents/meeting-agenda")
        fixture, handlers, value = fixture_adapters(p)
        entered = asyncio.Event()

        class Slow(Router):
            async def complete(self, request, *, max_output_tokens):
                entered.set()
                try:
                    await asyncio.sleep(30)
                except asyncio.CancelledError:
                    self.cancelled += 1
                    raise

        router = Slow(fixture)
        workflow = Workflow(
            p,
            router=router,
            handlers=handlers,
            grants={x["id"]: "session" for x in p.policy["permissions"]},
        )
        task = asyncio.create_task(workflow.run(value))
        await entered.wait()
        workflow.cancel()
        with pytest.raises(asyncio.CancelledError) as caught:
            await task
        report = caught.value.execution_report
        assert report["status"] == "cancelled"
        assert report["usage"]["reserved_tokens"] == 0
        assert router.cancelled == 1
        assert workflow.runtime.state == {}
        assert any(e["action"] == "workflow.cancelled" for e in report["audit"])

    asyncio.run(check())


def test_state_isolation_from_model_mutation():
    p = load_package(ROOT / "agents/meeting-agenda")
    fixture, _, _ = fixture_adapters(p)

    class Mutating(Router):
        async def complete(self, request, *, max_output_tokens):
            saved = copy.deepcopy(request)
            if request["task"] == "perspective":
                request["data"]["request"]["goal"] = "malicious mutation"
            return await super().complete(saved, max_output_tokens=max_output_tokens)

    result = execute(p, router=Mutating(fixture))
    assert result["state"]["request"]["goal"] != "malicious mutation"
    assert result["output"]["goal"] == result["state"]["request"]["goal"]


def test_invalid_state_write_fails_atomically(tmp_path):
    path = source(tmp_path)
    # The result path is valid but its type cannot be assigned to this state slot.
    change(
        path / "graph.json",
        lambda g: g["nodes"][0]["writes"].update({"/plan": {"from": "result", "path": "/focus"}}),
    )
    p = load_package(path)
    with pytest.raises(WorkflowError) as caught:
        execute(p)
    assert caught.value.node_id == "plan"
    assert caught.value.code == "schema_validation"
    assert not any(e["action"] == "state.committed" for e in caught.value.execution_report["audit"])


def test_time_sum_is_a_package_declared_generic_constraint(tmp_path):
    path = source(tmp_path)
    change(
        path / "fixtures/workflow.json",
        lambda f: f["models"]["write"][0]["output"]["agenda"][0].update(minutes=99),
    )
    # Bypass constructive allocation to deliberately corrupt the final value.
    change(
        path / "graph.json",
        lambda g: next(n for n in g["nodes"] if n["id"] == "assemble")["input"]["object"].update(
            agenda={"from": "state", "path": "/draft/agenda"}
        ),
    )
    with pytest.raises(WorkflowError) as caught:
        execute(load_package(path))
    assert caught.value.node_id == "validate"
    assert caught.value.code == "schema_validation"


def test_source_quote_constraint_rejects_fabrication(tmp_path):
    path = source(tmp_path, "literature-review")

    def fabricate(f):
        f["models"]["extract"][0]["output"][0]["quote"] = "A fabricated quote not in the source."

    change(path / "fixtures/workflow.json", fabricate)
    with pytest.raises(WorkflowError) as caught:
        execute(load_package(path))
    assert caught.value.node_id == "evidence"
    assert caught.value.code == "schema_validation"
    # The audit names the declared check that refused it, and never the data.
    audit = caught.value.execution_report["audit"]
    (failed,) = [
        e
        for e in audit
        if e["action"] == "node.failed" and e.get("node_id") == "evidence/check-document"
    ] or [e for e in audit if e["action"] == "node.failed" and "failed_check" in e]
    check = failed["failed_check"]
    assert check["check"] == "assertion" and check["kind"] == "relation"
    assert check["failure"] == "fields_do_not_match"
    assert check["compare"]["op"] == "contained_in" and check["compare"]["left"] == "/quote"
    assert "fabricated" not in json.dumps(audit)


def test_a_verifier_cannot_supply_bibliographic_metadata(tmp_path):
    """Since 0.2.3 the verifier's rows are {reference, paper_id}; metadata is refused."""
    path = source(tmp_path, "literature-review")

    def alter(f):
        resolution = f["tools"]["citation-resolver"][0]["output"]["best_match"]
        f["models"]["verify"][0]["output"]["bibliography"][0]["metadata"] = resolution

    change(path / "fixtures/workflow.json", alter)
    with pytest.raises(WorkflowError) as caught:
        execute(load_package(path))
    assert caught.value.node_id == "verification"
    assert caught.value.code == "schema_validation"


def test_a_final_bibliography_that_is_not_the_resolver_record_is_attributed(tmp_path):
    path = source(tmp_path, "literature-review")

    def alter(graph):
        (node,) = [n for n in graph["nodes"] if n["id"] == "bibliography"]
        fixture = json.loads((path / "fixtures/workflow.json").read_text())
        record = fixture["tools"]["citation-resolver"][0]["output"]["best_match"]
        record = dict(record, title=record["title"] + " (edited)")
        node["steps"][0]["input"]["object"]["metadata"] = {"literal": record}

    change(path / "graph.json", alter)
    with pytest.raises(WorkflowError) as caught:
        execute(load_package(path))
    assert caught.value.node_id == "validate-output"
    assert caught.value.code == "schema_validation"
    audit = caught.value.execution_report["audit"]
    (failed,) = [
        e for e in audit if e["action"] == "node.failed" and e.get("node_id") == "validate-output"
    ]
    assert failed["failed_check"] == {
        "check": "assertion",
        "index": 0,
        "kind": "relation",
        "failure": "fields_do_not_match",
        "compare": {"left": "/metadata", "right": "/response/best_match", "op": "eq"},
    }
    assert "(edited)" not in json.dumps(audit)


def _deduplicated(audit, node_id):
    return [e for e in audit if e["action"] == "node.deduplicated" and e.get("node_id") == node_id]


def test_join_deduplication_is_recorded_with_its_counts(tmp_path):
    """A join that drops records says so, with counts, whatever package declares it.

    (Literature Review 0.2.2 no longer deduplicates evidence at all — see
    test_literature_022.py — so this uses a package-neutral join.)
    """
    path = source(tmp_path)
    change(
        path / "graph.json",
        lambda g: next(n for n in g["nodes"] if n["id"] == "join").update(unique_by=["/role"]),
    )

    def collide(f):
        second = f["models"]["perspective"][1]["output"][0]
        second["role"] = f["models"]["perspective"][0]["output"][0]["role"]

    change(path / "fixtures/workflow.json", collide)
    with pytest.raises(WorkflowError) as caught:
        # The writer's recorded input no longer matches, so the run then stops.
        execute(load_package(path))
    (event,) = _deduplicated(caught.value.execution_report["audit"], "join")
    assert event["original_count"] == 3 and event["retained_count"] == 2
    assert event["conflicting_duplicates"] == 1 and event["identical_duplicates"] == 0
    assert event["unique_by"] == ["/role"]
    # Counts and declared pointers only; no record content reaches the audit.
    assert "priorities" not in json.dumps(event)


def test_tool_output_schema_and_tool_errors_are_distinct():
    p = load_package(ROOT / "agents/literature-review")
    _, handlers, _ = fixture_adapters(p)

    async def invalid(ctx, payload):
        return {"invalid": True}

    with pytest.raises(WorkflowError) as caught:
        execute(p, handlers=handlers | {"scholarly.search": invalid})
    assert caught.value.code == "schema_validation"

    async def failure(ctx, payload):
        raise ValueError("provider secret")

    with pytest.raises(WorkflowError) as caught:
        execute(p, handlers=handlers | {"scholarly.search": failure})
    assert caught.value.code == "tool_error"
    assert "provider secret" not in json.dumps(caught.value.execution_report)


def test_fixture_does_not_silently_answer_changed_input():
    p = load_package(ROOT / "agents/meeting-agenda")
    router, handlers, value = fixture_adapters(p)
    value["goal"] = "An unrelated question"
    with pytest.raises(WorkflowError):
        asyncio.run(
            run_workflow(
                p,
                value,
                router=router,
                handlers=handlers,
                grants={x["id"]: "session" for x in p.policy["permissions"]},
            )
        )


def test_multiple_ready_nodes_join_and_sequential_dependency(tmp_path):
    path = source(tmp_path)
    participants = {"type": "array", "items": {"$ref": "participant.schema.json"}}
    write(path / "schemas/participants.schema.json", participants)
    change(
        path / "MANIFEST.agent",
        lambda m: m["schemas"].append(
            {"id": "participants", "path": "schemas/participants.schema.json"}
        ),
    )

    def state(s):
        for key in ["left", "right", "merged"]:
            s["properties"][key] = {"$ref": "participants.schema.json"}

    change(path / "schemas/state.schema.json", state)

    def graph(g):
        coord = g["workers"][0]
        coord["state_read"] += ["left", "right", "merged"]
        coord["state_write"] += ["left", "right", "merged"]
        for key in ["left", "right", "merged"]:
            g["initial_state"]["object"][key] = {"literal": []}

        def n(id, kind, input, depends, writes):
            return dict(
                id=id,
                type=kind,
                input=input,
                worker="Coordinator",
                depends_on=depends,
                writes=writes,
                output_schema="schemas/participants.schema.json",
                timeout_seconds=5,
            )

        def state(k):
            return {"from": "state", "path": "/" + k}

        result = {"from": "result", "path": ""}
        g["nodes"] = [
            n("left", "validate", state("request/participants"), [], {"/left": result}),
            n("right", "validate", state("request/participants"), [], {"/right": result}),
            n(
                "join",
                "join",
                {"array": [state("left"), state("right")]},
                ["left", "right"],
                {"/merged": result},
            ),
            n("output", "output", state("merged"), ["join"], {}),
        ]
        g["output_schema"] = "schemas/participants.schema.json"
        g["exports"] = []

    change(path / "graph.json", graph)
    p = load_package(path)
    result = execute(p)
    assert len(result["output"]) == 6
    commits = [e["nodes"] for e in result["audit"] if e["action"] == "state.committed"]
    assert commits == [["left", "right"], ["join"], ["output"]]
    assert result["usage"]["tokens"] == 0
    # Unordered writes to one field must fail during loading.
    change(
        path / "graph.json",
        lambda g: g["nodes"][1].update(writes={"/left": {"from": "result", "path": ""}}),
    )
    with pytest.raises(ValidationError, match="unordered state conflict"):
        load_package(path)


def test_map_max_items_before_child_dispatch(tmp_path):
    path = source(tmp_path)
    change(path / "graph.json", lambda g: g["nodes"][1].update(max_items=2))
    with pytest.raises(WorkflowError) as caught:
        execute(load_package(path))
    report = caught.value.execution_report
    assert caught.value.node_id == "perspectives"
    assert not any(
        e["action"] == "worker.spawned" and e["role"] == "Perspective" for e in report["audit"]
    )


def test_empty_map_and_join_are_well_defined(tmp_path):
    path = source(tmp_path)

    def empty(f):
        f["input"]["participants"] = []
        f["models"]["plan"][0]["input"]["participants"] = []
        f["models"]["write"][0]["input"]["request"]["participants"] = []
        f["models"]["write"][0]["input"]["perspectives"] = []

    change(path / "fixtures/workflow.json", empty)
    result = execute(load_package(path))
    assert result["state"]["batches"] == result["state"]["perspectives"] == []
    assert not any(
        e["action"] == "worker.spawned" and e["role"] == "Perspective" for e in result["audit"]
    )


def test_cancel_before_run_and_single_use():
    async def check():
        p = load_package(ROOT / "agents/meeting-agenda")
        router, handlers, value = fixture_adapters(p)
        workflow = Workflow(
            p,
            router=router,
            handlers=handlers,
            grants={x["id"]: "session" for x in p.policy["permissions"]},
        )
        workflow.cancel()
        with pytest.raises(asyncio.CancelledError):
            await workflow.run(value)
        assert router.calls == []
        from agentpkg.runtime import PolicyError

        with pytest.raises(PolicyError, match="single-use"):
            await workflow.run(value)

    asyncio.run(check())


def test_model_failure_charges_reservation_conservatively():
    p = load_package(ROOT / "agents/meeting-agenda")
    fixture, _, _ = fixture_adapters(p)

    class Failed(Router):
        async def complete(self, request, *, max_output_tokens):
            raise RuntimeError("unknown billable usage")

    with pytest.raises(WorkflowError) as caught:
        execute(p, router=Failed(fixture))
    assert caught.value.execution_report["usage"]["tokens"] == 12010
    assert caught.value.execution_report["usage"]["reserved_tokens"] == 0


def test_explicit_tool_permission_denial():
    p = load_package(ROOT / "agents/literature-review")
    grants = {x["id"]: "session" for x in p.policy["permissions"]}
    grants["network.citations"] = "deny"
    with pytest.raises(WorkflowError) as caught:
        execute(p, grants=grants)
    assert caught.value.code == "permission_denied"
    assert caught.value.execution_report["usage"]["tool_calls"].get("citation-resolver", 0) == 0


def test_tool_timeout(tmp_path):
    path = source(tmp_path, "literature-review")
    # Tool schema uses integral seconds; the enclosing node deadline is tighter.
    change(
        path / "graph.json",
        lambda g: next(n for n in g["nodes"] if n["id"] == "search").update(timeout_seconds=0.02),
    )
    p = load_package(path)
    _, handlers, _ = fixture_adapters(p)
    stopped = []

    async def slow(ctx, payload):
        try:
            await asyncio.sleep(30)
        finally:
            stopped.append(ctx.worker_id)

    with pytest.raises(WorkflowError) as caught:
        execute(p, handlers=handlers | {"scholarly.search": slow})
    assert caught.value.code == "timeout"
    assert len(stopped) == 3


def test_modified_payload_cannot_reuse_verified_integrity():
    p = load_package(ROOT / "agents/meeting-agenda")
    p.files["graph.json"] += b" "
    with pytest.raises(ValidationError, match="changed after integrity"):
        Workflow(p)


def test_fixture_duplicate_cases_rejected(tmp_path):
    path = source(tmp_path)
    change(
        path / "fixtures/workflow.json",
        lambda f: f["models"]["plan"].append(copy.deepcopy(f["models"]["plan"][0])),
    )
    with pytest.raises(ValidationError, match="duplicate input"):
        load_package(path)


def test_remote_model_usage_and_privacy_enforcement(tmp_path):
    path = source(tmp_path)

    def policy(p):
        p["budget"]["max_remote_calls"] = 20

    change(path / "policy/policy.json", policy)
    change(
        path / "graph.json", lambda g: [r["budget"].update(remote_calls=20) for r in g["workers"]]
    )
    p = load_package(path)
    fixture, _, _ = fixture_adapters(p)

    class Remote(Router):
        remote = True

    result = execute(p, router=Remote(fixture))
    assert result["usage"]["remote_calls"] == 10  # Five counts and five completions.
    change(path / "MANIFEST.agent", lambda m: m["model_requirements"].update(privacy="local-only"))
    p = load_package(path)
    router = Remote(fixture)
    with pytest.raises(WorkflowError, match="permission_denied"):
        execute(p, router=router)
    assert not router.calls


def test_invalid_text_export_fails_before_workflow_completion(tmp_path):
    path = source(tmp_path)
    change(path / "graph.json", lambda g: g["exports"][0].update(format="text"))
    with pytest.raises(WorkflowError) as caught:
        execute(load_package(path))
    assert caught.value.code == "schema_validation"
    assert not any(
        e["action"] == "workflow.completed" for e in caught.value.execution_report["audit"]
    )


def test_model_metadata_cannot_leak_raw_content_into_audit():
    p = load_package(ROOT / "agents/meeting-agenda")
    fixture, _, _ = fixture_adapters(p)

    class BadMetadata(Router):
        async def complete(self, request, *, max_output_tokens):
            result = await super().complete(request, max_output_tokens=max_output_tokens)
            return result | {"cost_usd": {"private": "raw secret metadata"}}

    with pytest.raises(WorkflowError) as caught:
        execute(p, router=BadMetadata(fixture))
    assert caught.value.code == "schema_validation"
    assert "raw secret metadata" not in json.dumps(caught.value.execution_report)
