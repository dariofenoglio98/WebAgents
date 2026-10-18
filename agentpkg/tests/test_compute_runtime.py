"""compute.v0 in the reference runtime: the call path, its audit, the limits, determinism, the
permission, the preflight, the CLI and the execution host's bounds. The modules are the
hand-assembled ones of examples/compute/cases; nothing here needs a toolchain."""

import asyncio
import json
import time

import pytest
from compute_probe import REQUEST, case_module, compute_node, grants, write_probe
from compute_probe import builder as compute_probe_builder

from agentpkg.cli import main
from agentpkg.compute import engine as compute_engine
from agentpkg.compute.engine import EngineUnavailable
from agentpkg.compute.limits import DEFAULT_FUEL, DEFAULT_MEMORY_PAGES, DEFAULT_WALL_SECONDS
from agentpkg.errors import ValidationError
from agentpkg.execution.errors import (
    COMPUTE_LIMIT_EXCEEDED,
    COMPUTE_NOT_SUPPORTED,
    GRANT_UNSUPPORTED,
    ExecutionError,
)
from agentpkg.execution.policy import (
    HostExecutionLimits,
    check_capabilities,
    check_compute,
    normalize_grants,
)
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, load_package, unpack_package
from agentpkg.runtime import PolicyError, Runtime, digest
from agentpkg.workflow import Workflow, WorkflowError, run_workflow


def run(package, *, limits=None, decisions=None, approved=()):
    router, handlers, value = fixture_adapters(package)
    return asyncio.run(
        run_workflow(
            package,
            value,
            router=router,
            handlers=handlers,
            grants=grants(package, **(decisions or {})),
            approved_tools=list(approved),
            limits=limits,
        )
    )


def events(result, action):
    return [e for e in result["audit"] if e["action"] == action]


def test_the_echo_module_runs_for_real_in_fixture_mode(tmp_path):
    package = load_package(write_probe(tmp_path / "probe"))
    result = run(package)
    assert result["status"] == "completed"
    assert result["output"] == REQUEST
    assert result["usage"]["compute_calls"] == 1
    (called,) = events(result, "compute.called")
    (completed,) = events(result, "compute.completed")
    assert not events(result, "compute.failed")
    assert called["node_id"] == completed["node_id"] == "compute"
    assert called["module"] == "echo" and called["function"] == "run"
    assert called["module_sha256"] == package.graph["modules"][0]["sha256"]
    assert called["input_bytes"] == 17 and called["input_hash"] == digest(REQUEST)
    assert called["limits"] == {
        "memory_pages": DEFAULT_MEMORY_PAGES,
        "wall_seconds": DEFAULT_WALL_SECONDS,
        "fuel": DEFAULT_FUEL,
    }
    assert called["permissions"] == ["compute.modules"]
    assert completed["output_hash"] == digest(REQUEST) and completed["output_bytes"] == 17
    assert completed["memory_pages"] == 1
    assert completed["engine"]["id"].startswith("wasmtime-py/")
    assert completed["engine"]["fuel_consumed"] > 0
    assert isinstance(completed["engine"]["elapsed_ms"], int)
    # The permission was checked and consumed before the engine saw a byte.
    checked = [
        e for e in events(result, "permission.checked") if e["permission"] == "compute.modules"
    ]
    assert checked and all(e["allowed"] for e in checked)
    assert checked[0]["sequence"] < called["sequence"]
    # The chain holds.
    previous = None
    for event in result["audit"]:
        assert event["previous_hash"] == previous
        assert digest({k: v for k, v in event.items() if k != "event_hash"}) == event["event_hash"]
        previous = event["event_hash"]


def test_a_package_without_modules_reports_no_compute_usage(tmp_path):
    """Every earlier package's usage is unchanged: the key exists only with modules."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    package = load_package(root / "agents" / "meeting-agenda")
    result = run(package)
    assert "compute_calls" not in result["usage"]
    assert not [e for e in result["audit"] if e["action"].startswith("compute.")]


def test_the_same_input_gives_identical_output_and_fuel_across_runs(tmp_path):
    package = load_package(
        write_probe(tmp_path / "probe", modules={"echo": case_module("with-start")})
    )
    seen = set()
    for _ in range(3):
        result = run(package)
        (completed,) = events(result, "compute.completed")
        seen.add(
            (
                completed["output_hash"],
                completed["engine"]["fuel_consumed"],
                json.dumps(result["output"], sort_keys=True),
            )
        )
    assert len(seen) == 1


def test_two_compute_nodes_share_a_wave_and_a_compute_step_runs_per_item(tmp_path):
    nodes = [
        compute_node("first", worker="Worker"),
        compute_node("second", worker="Worker", writes={"/second": {"from": "result", "path": ""}}),
        {
            "id": "each",
            "type": "map",
            "worker": "Worker",
            "depends_on": [],
            "input": {"from": "state", "path": "/request/items"},
            "item_schema": "schemas/compute-input.schema.json",
            "max_items": 8,
            "max_parallel": 2,
            "steps": [
                {
                    "id": "step",
                    "type": "compute",
                    "input": {"from": "item", "path": ""},
                    "input_schema": "schemas/compute-input.schema.json",
                    "output_schema": "schemas/compute-output.schema.json",
                    "timeout_seconds": 10,
                    "module": "echo",
                    "function": "run",
                }
            ],
            "yield": {"from": "steps", "path": "/step"},
            "output_schema": "schemas/output.schema.json",
            "timeout_seconds": 30,
            "writes": {"/mapped": {"from": "result", "path": ""}},
        },
    ]
    items = [{"n": 1}, {"n": 2}, {"n": 3}]
    package = load_package(
        write_probe(
            tmp_path / "probe",
            nodes=nodes,
            state_keys=("request", "result", "second", "mapped"),
            fixture_input={"items": items},
        )
    )
    result = run(package)
    assert result["status"] == "completed"
    assert result["state"]["mapped"] == items
    assert result["state"]["result"] == result["state"]["second"] == {"items": items}
    assert result["usage"]["compute_calls"] == 5
    assert result["usage"]["peak_parallel_workers"] == 2
    step_events = [e for e in events(result, "compute.completed") if e["node_id"] == "each/step"]
    assert len(step_events) == 3 and all(e["worker"].startswith("Worker:") for e in step_events)


def test_coordinator_compute_nodes_of_one_wave_each_name_their_own_node(tmp_path):
    """The coordinator's one context is shared by its nodes, which a wave runs concurrently: each
    compute call, and the permission checks before it, names its own node (C-7, C-44)."""
    keys = ("request", "result", "b", "c")
    nodes = [
        compute_node("a"),
        compute_node("b", writes={"/b": {"from": "result", "path": ""}}),
        compute_node("c", writes={"/c": {"from": "result", "path": ""}}),
    ]
    package = load_package(write_probe(tmp_path / "probe", nodes=nodes, state_keys=keys))
    result = run(package)
    assert result["status"] == "completed"
    assert result["state"]["result"] == result["state"]["b"] == result["state"]["c"] == REQUEST
    commits = [e["nodes"] for e in result["audit"] if e["action"] == "state.committed"]
    assert commits[0] == ["a", "b", "c"]
    for action in ("compute.called", "compute.completed"):
        assert sorted(e["node_id"] for e in events(result, action)) == ["a", "b", "c"]
        assert all(e["worker"] == "coordinator" for e in events(result, action))
    checks = [
        e["node_id"]
        for e in events(result, "permission.checked")
        if e["permission"] == "compute.modules"
    ]
    assert sorted(checks) == ["a", "a", "b", "b", "c", "c"]
    # Every event of a node lies between its own start and its completion.
    started = {e["node_id"]: e["sequence"] for e in events(result, "node.started")}
    completed = {e["node_id"]: e["sequence"] for e in events(result, "node.completed")}
    for event in result["audit"]:
        if event["action"].startswith("compute.") or event["action"] == "permission.checked":
            if event.get("permission", "compute.modules") != "compute.modules":
                continue
            node = event["node_id"]
            assert started[node] < event["sequence"] < completed[node]


def test_a_node_lowers_the_limits_and_never_raises_them(tmp_path):
    node = compute_node(limits={"memory_pages": 4096, "wall_seconds": 2, "fuel": 1000})
    package = load_package(write_probe(tmp_path / "probe", nodes=[node]))
    (called,) = events(run(package), "compute.called")
    assert called["limits"] == {
        "memory_pages": DEFAULT_MEMORY_PAGES,
        "wall_seconds": 2,
        "fuel": 1000,
    }
    (called,) = events(
        run(package, limits={"compute_wall_seconds": 1, "compute_memory_pages": 64}),
        "compute.called",
    )
    assert called["limits"] == {"memory_pages": 64, "wall_seconds": 1, "fuel": 1000}


@pytest.mark.parametrize(
    "limits,match",
    [
        ({"compute_fuel": 0}, "compute_fuel must be a positive integer"),
        ({"compute_memory_pages": 65537}, "exceeds the supported maximum"),
        ({"compute_wall_seconds": -1}, "compute_wall_seconds must be a positive number"),
        ({"compute_wall_seconds": True}, "compute_wall_seconds must be a positive number"),
        ({"compute_seconds": 1}, "Unsupported host limit"),
    ],
)
def test_host_compute_limits_are_validated(tmp_path, limits, match):
    package = load_package(write_probe(tmp_path / "probe"))
    with pytest.raises(PolicyError, match=match):
        Runtime(package, grants=grants(package), limits=limits)


def test_a_once_grant_is_spent_by_the_first_call(tmp_path):
    nodes = [
        compute_node("first"),
        compute_node(
            "second", depends_on=["first"], writes={"/second": {"from": "result", "path": ""}}
        ),
    ]
    package = load_package(
        write_probe(tmp_path / "probe", nodes=nodes, state_keys=("request", "result", "second"))
    )
    with pytest.raises(WorkflowError) as caught:
        run(package, decisions={"compute.modules": "once"})
    assert caught.value.code == "permission_denied" and caught.value.node_id == "second"
    report = caught.value.execution_report
    assert len(events(report, "compute.completed")) == 1


def test_a_module_above_the_host_memory_ceiling_is_refused_before_the_run(tmp_path):
    package = load_package(
        write_probe(tmp_path / "probe", modules={"echo": case_module("memory-over-host-cap")})
    )
    with pytest.raises(
        PolicyError, match="^compute_limit_exceeded: node compute runs module 'echo'"
    ) as caught:
        Runtime(package, grants=grants(package))
    assert caught.value.code == "compute_limit_exceeded"
    result = run(package, limits={"compute_memory_pages": 4096})
    assert result["status"] == "completed"
    assert events(result, "compute.called")[0]["limits"]["memory_pages"] == 4096


def test_the_engine_is_required_at_construction_and_by_the_execution_host(tmp_path, monkeypatch):
    package = load_package(write_probe(tmp_path / "probe"))

    def unavailable():
        raise EngineUnavailable("this host has no WebAssembly engine; install agentpkg[compute]")

    monkeypatch.setattr(compute_engine, "default_engine", unavailable)
    with pytest.raises(PolicyError, match="^compute_engine_unavailable: ") as caught:
        Workflow(package, grants=grants(package))
    assert caught.value.code == "compute_engine_unavailable"
    monkeypatch.setattr(compute_engine, "available", lambda: False)
    with pytest.raises(ExecutionError) as refused:
        check_compute(package, HostExecutionLimits())
    assert refused.value.code == COMPUTE_NOT_SUPPORTED


def test_a_module_the_engine_refuses_at_the_preflight_names_its_code_once(tmp_path, monkeypatch):
    """T22 review 1, nit 6: the refusal is `<code>: module '<id>': <reason>`, not the module
    error's own prefixed message after a second copy of the code (the Chrome core's words)."""
    from agentpkg.compute.module import ModuleError

    package = load_package(write_probe(tmp_path / "probe"))
    engine = compute_engine.WasmtimeEngine()

    def refusing(sha256, data):
        raise ModuleError("module_invalid", "the engine refused the module")

    monkeypatch.setattr(engine, "compile", refusing)
    monkeypatch.setattr(compute_engine, "default_engine", lambda: engine)
    try:
        with pytest.raises(PolicyError) as caught:
            Runtime(package, grants=grants(package))
    finally:
        engine.close()
    assert caught.value.code == "module_invalid"
    assert str(caught.value) == "module_invalid: module 'echo': the engine refused the module"


def test_a_skipped_compute_node_runs_nothing(tmp_path):
    node = compute_node(
        when={
            "when": {"left": {"literal": 1}, "op": "eq", "right": {"literal": 2}},
            "otherwise": {"literal": {"skipped": True}},
        }
    )
    result = run(load_package(write_probe(tmp_path / "probe", nodes=[node])))
    assert result["output"] == {"skipped": True}
    assert events(result, "node.skipped") and not events(result, "compute.called")
    assert result["usage"]["compute_calls"] == 0


def test_cancellation_interrupts_a_running_call(tmp_path):
    node = compute_node(limits={"wall_seconds": 3})
    package = load_package(
        write_probe(tmp_path / "probe", modules={"echo": case_module("loop-forever")}, nodes=[node])
    )

    async def scenario():
        router, handlers, value = fixture_adapters(package)
        workflow = Workflow(
            package, router=router, handlers=handlers, grants=grants(package), approved_tools=[]
        )
        task = asyncio.create_task(workflow.run(value))
        await asyncio.sleep(0.2)
        started = time.monotonic()
        workflow.cancel()
        with pytest.raises(asyncio.CancelledError) as caught:
            await task
        return time.monotonic() - started, caught.value.execution_report

    waited, report = asyncio.run(scenario())
    assert waited < 1.5
    assert report["status"] == "cancelled"
    (failed,) = events(report, "compute.failed")
    assert failed["error"] == "CancelledError"


def test_binary_members_round_trip_through_build_and_unpack(tmp_path):
    source = write_probe(tmp_path / "probe")
    archive = build_package(source, tmp_path / "probe.agent.pkg")
    package = load_package(archive)
    assert package.files["modules/echo.wasm"] == case_module("echo")
    assert package.is_archive
    unpacked = unpack_package(archive, tmp_path / "unpacked")
    assert (unpacked / "modules" / "echo.wasm").read_bytes() == case_module("echo")
    # The member rules: a module member must be a module, and must be declared.
    (source / "modules" / "echo.wasm").write_bytes(b"\x00asm\x02\x00\x00\x00")
    with pytest.raises(ValidationError, match="not a WebAssembly core module"):
        load_package(source)


def test_the_cli_runs_the_probe_and_inspects_its_modules(tmp_path, capsys):
    source = write_probe(tmp_path / "probe")
    package = load_package(source)
    grants_file = tmp_path / "grants.json"
    grants_file.write_text(json.dumps(grants(package)))
    limits = tmp_path / "limits.json"
    limits.write_text(json.dumps({"compute_wall_seconds": 2, "hard_tokens": 500}))
    out = tmp_path / "out"
    assert (
        main(
            [
                "run",
                str(source),
                "--mode",
                "fixture",
                "--grants",
                str(grants_file),
                "--limits",
                str(limits),
                "--out",
                str(out),
            ]
        )
        == 0
    )
    report = json.loads(capsys.readouterr().out)
    assert report["passed"] is True and report["usage"]["compute_calls"] == 1
    audit = json.loads((out / "audit.json").read_text())
    actions = [e["action"] for e in audit]
    assert "compute.called" in actions and "compute.completed" in actions
    called = next(e for e in audit if e["action"] == "compute.called")
    assert called["limits"]["wall_seconds"] == 2
    result = json.loads((out / "result.json").read_text())
    assert result["output"] == REQUEST and result["usage"]["limits"]["hard_tokens"] == 500
    assert main(["inspect", str(source)]) == 0
    inspected = json.loads(capsys.readouterr().out)
    assert inspected["modules"] == [
        {
            "id": "echo",
            "path": "modules/echo.wasm",
            "sha256": package.graph["modules"][0]["sha256"],
            "size": len(case_module("echo")),
            "memory_min_pages": 1,
            "memory_max_pages": 16,
            "functions": ["run"],
            "exports": ["memory", "alloc", "run"],
        }
    ]


def test_the_execution_host_carries_the_compute_bounds(tmp_path):
    limits = HostExecutionLimits.normalize({"compute_memory_pages": 64, "compute_fuel": 5000})
    assert limits.as_json()["compute_memory_pages"] == 64
    assert limits.as_json()["compute_wall_seconds"] == DEFAULT_WALL_SECONDS
    assert limits.runtime_limits()["compute_fuel"] == 5000
    assert HostExecutionLimits().as_json()["compute_fuel"] == DEFAULT_FUEL
    with pytest.raises(ExecutionError, match="compute_wall_seconds exceeds"):
        HostExecutionLimits.normalize({"compute_wall_seconds": 301})
    with pytest.raises(ExecutionError, match="compute_fuel must be a positive integer"):
        HostExecutionLimits.normalize({"compute_fuel": 0})
    package = load_package(write_probe(tmp_path / "probe"))
    capabilities = check_capabilities(package, limits)
    assert capabilities["compute"]["modules"][0]["id"] == "echo"
    assert capabilities["compute"]["operations"] == [
        {
            "node": "compute",
            "module": "echo",
            "memory_pages": 64,
            "wall_seconds": DEFAULT_WALL_SECONDS,
            "fuel": 5000,
        }
    ]
    assert capabilities["compute"]["host"]["memory_pages"] == 64
    # A module over the host's ceiling is refused, not lowered.
    over = load_package(
        write_probe(tmp_path / "over", modules={"echo": case_module("memory-over-host-cap")})
    )
    with pytest.raises(ExecutionError) as refused:
        check_capabilities(over, HostExecutionLimits())
    assert refused.value.code == COMPUTE_LIMIT_EXCEEDED
    assert refused.value.detail == {"node": "compute", "module": "echo", "memory_pages": 2048}
    # Packages without compute nodes keep their record unchanged.
    from pathlib import Path

    agenda = load_package(Path(__file__).resolve().parents[2] / "agents" / "meeting-agenda")
    assert "compute" not in check_capabilities(agenda, limits)
    # `once` counts every compute call: two nodes cannot run under it.
    two = load_package(
        write_probe(
            tmp_path / "two",
            nodes=[
                compute_node("a"),
                compute_node("b", writes={"/second": {"from": "result", "path": ""}}),
            ],
            state_keys=("request", "result", "second"),
        )
    )
    with pytest.raises(ExecutionError) as unsupported:
        normalize_grants(two, {"memory.session": "session", "compute.modules": "once"})
    assert unsupported.value.code == GRANT_UNSUPPORTED
    assert unsupported.value.detail["maximum_uses"] == 2
    assert normalize_grants(package, {"memory.session": "session", "compute.modules": "once"}) == {
        "compute.modules": "once",
        "memory.session": "session",
    }


def test_the_control_plane_says_what_code_runs_and_the_record_counts_the_calls(tmp_path):
    from agentpkg.browser.summary import warnings
    from agentpkg.execution.report import audit_summary

    package = load_package(write_probe(tmp_path / "probe"))
    publisher = {"signature_status": "absent", "trust_status": "unknown"}
    evaluation = {"runtime_status": "compatible"}
    found = {w["code"]: w for w in warnings(package, evaluation, publisher)}
    note = found["runs_code_that_can_only_compute"]
    assert note["severity"] == "info"
    assert "runs code that can only compute (compute.modules)" in note["message"]
    assert package.graph["modules"][0]["sha256"][:16] in note["message"]
    assert "no imports" in note["message"]
    result = run(package)
    assert audit_summary(result["audit"])["compute_calls"] == 1
    from pathlib import Path

    agenda = load_package(Path(__file__).resolve().parents[2] / "agents" / "meeting-agenda")
    assert "runs_code_that_can_only_compute" not in {
        w["code"] for w in warnings(agenda, evaluation, publisher)
    }
    assert "compute_calls" not in audit_summary(run(agenda)["audit"])


def test_an_instantiation_the_engine_refuses_is_recorded_by_its_reason_alone(tmp_path, monkeypatch):
    """C-41: the reason, never the engine's own words (another engine could not repeat them)."""
    import wasmtime

    words = "engine words that differ between engines"

    def refuse(*args, **kwargs):
        raise wasmtime.WasmtimeError(words)

    monkeypatch.setattr(wasmtime, "Instance", refuse)
    package = load_package(write_probe(tmp_path / "probe"))
    with pytest.raises(WorkflowError) as caught:
        run(package)
    assert caught.value.code == "compute_error" and caught.value.node_id == "compute"
    report = caught.value.execution_report
    (failed,) = events(report, "compute.failed")
    assert failed["reason"] == "instantiation_failed" and "detail" not in failed
    assert failed["engine"]["id"].startswith("wasmtime-py/")
    (node,) = [e for e in events(report, "node.failed") if e["node_id"] == "compute"]
    assert node["compute"] == {"reason": "instantiation_failed"}
    assert words not in json.dumps(report)


def test_an_alloc_pointer_at_or_above_2_gib_is_a_valid_pointer(tmp_path):
    """The ABI's pointers are unsigned: with more than 32,768 pages, `alloc` may answer an
    address whose i32 is negative."""
    b = compute_probe_builder()
    data = b.module(
        types=b.ABI_TYPES,
        exports=b.ABI_EXPORTS,
        funcs=[(0, [], b.i32_const(-(2**31))), (1, [], b.ECHO)],
        memories=((32769, 32769),),
    )
    package = load_package(write_probe(tmp_path / "probe", modules={"echo": data}))
    result = run(package, limits={"compute_memory_pages": 32769})
    assert result["status"] == "completed" and result["output"] == REQUEST
    (completed,) = events(result, "compute.completed")
    assert completed["memory_pages"] == 32769


def test_an_engine_fault_is_the_hosts_worker_error_not_the_modules(tmp_path, monkeypatch):
    """C-40: a failure inside the engine that is not the module's own ends the node with
    `worker_error`; the audit names `engine_error` and nothing the engine said."""
    engine = compute_engine.default_engine()

    def broken(*args):
        raise RuntimeError("an engine failure with words in it")

    monkeypatch.setattr(engine, "_call", broken)
    package = load_package(write_probe(tmp_path / "probe"))
    with pytest.raises(WorkflowError) as caught:
        run(package)
    assert caught.value.code == "worker_error" and caught.value.node_id == "compute"
    report = caught.value.execution_report
    (failed,) = events(report, "compute.failed")
    assert failed["reason"] == "engine_error" and failed["error"] == "EngineFault"
    (node,) = [e for e in events(report, "node.failed") if e["node_id"] == "compute"]
    assert node["error_code"] == "worker_error" and "compute" not in node
    assert "words in it" not in json.dumps(report)


def test_the_node_timeout_also_ends_the_engine_call(tmp_path, monkeypatch):
    """A node's `timeout_seconds` ends the node with `timeout`; the engine's deadline follows
    within a second, rather than running the abandoned call on to the wall bound (B-224)."""
    engine = compute_engine.default_engine()
    original = engine._call
    ended = []

    def timed(*args):
        try:
            return original(*args)
        finally:
            ended.append(time.monotonic())

    monkeypatch.setattr(engine, "_call", timed)
    node = compute_node()
    node["timeout_seconds"] = 1
    package = load_package(
        write_probe(tmp_path / "probe", modules={"echo": case_module("loop-forever")}, nodes=[node])
    )
    started = time.monotonic()
    with pytest.raises(WorkflowError) as caught:
        run(package)
    assert caught.value.code == "timeout"
    (called,) = events(caught.value.execution_report, "compute.called")
    assert called["limits"]["wall_seconds"] == DEFAULT_WALL_SECONDS
    while not ended and time.monotonic() - started < 8:
        time.sleep(0.05)
    assert ended and ended[0] - started < 4  # the wall bound alone: about 10 s


def test_a_module_is_decoded_once_per_process(tmp_path, monkeypatch):
    from agentpkg.compute import declarations

    decoded = []
    original = declarations.check_module

    def counting(data, *, functions):
        decoded.append(functions)
        return original(data, functions=functions)

    monkeypatch.setattr(declarations, "check_module", counting)
    monkeypatch.setattr(declarations, "_FACTS", {})
    package = load_package(write_probe(tmp_path / "probe"))
    run(package)
    check_capabilities(package, HostExecutionLimits())
    declarations.module_records(package)
    assert decoded == [["run"]]


# -- T21 review 2 (fixed in T22) ------------------------------------------------------------------
def test_a_module_the_engine_refuses_is_compiled_once(monkeypatch):
    """The second `compile` of a refused module raises the kept refusal without compiling again
    (before, `precompile` swallowed the error and the preflight compiled it a second time)."""
    import wasmtime

    engine = compute_engine.WasmtimeEngine()
    constructed = []
    real = wasmtime.Module

    def refusing(engine_, data):
        constructed.append(len(data))
        raise wasmtime.WasmtimeError("refused for the test")

    monkeypatch.setattr(wasmtime, "Module", refusing)
    try:
        data = case_module("echo")
        for _ in range(2):
            with pytest.raises(ValueError, match="^module_invalid: ") as caught:
                engine.compile("a" * 64, data)
        assert caught.value.code == "module_invalid"
        assert constructed == [len(data)]  # once
        monkeypatch.setattr(wasmtime, "Module", real)
        # Another module is unaffected by the kept refusal.
        engine.compile("b" * 64, data)
    finally:
        engine.close()


def test_compiling_one_module_does_not_block_another_calls_lookup(monkeypatch):
    """`compile` holds the engine lock only to look up and to insert, never while compiling, so a
    slow compile on one thread does not stall a lookup of an already compiled module."""
    import threading

    import wasmtime

    engine = compute_engine.WasmtimeEngine()
    try:
        data = case_module("echo")
        engine.compile("cached" + "0" * 58, data)
        real = wasmtime.Module
        started = threading.Event()

        def slow(engine_, bytes_):
            started.set()
            time.sleep(0.6)
            return real(engine_, bytes_)

        monkeypatch.setattr(wasmtime, "Module", slow)
        worker = threading.Thread(
            target=engine.compile, args=("slow" + "0" * 60, case_module("with-start"))
        )
        worker.start()
        assert started.wait(2)
        begun = time.monotonic()
        engine.compile("cached" + "0" * 58, data)  # a lookup, under the lock
        assert time.monotonic() - begun < 0.3
        worker.join(5)
        assert "slow" + "0" * 60 in engine._modules
    finally:
        engine.close()


def test_one_helper_names_the_operation_an_event_belongs_to():
    """compute.v0 C-44: the three places that named an event's node use one rule."""
    from types import SimpleNamespace

    from agentpkg.runtime import operation_node_id

    worker = SimpleNamespace(node_id="search")
    assert operation_node_id(worker) == "search"
    assert operation_node_id(worker, {"id": "step"}) == "search"
    worker.operation_id = "search/step"
    assert operation_node_id(worker) == "search/step"
    coordinator = SimpleNamespace(node_id=None)
    assert operation_node_id(coordinator) is None
    assert operation_node_id(coordinator, {"id": "quotes"}) == "quotes"
    assert operation_node_id(None) is None


def test_a_request_cancelled_during_the_compile_leaves_no_run_reported(tmp_path, monkeypatch):
    """The precompile awaits inside the session's guarded region: a run request the parent cancels
    while the modules compile ends the session, and `execution.cancel` says so (`running: false`)
    instead of reporting a run that is not there."""
    import contextlib

    from execution_fakes import Harness, authorization, plan_for

    from agentpkg.package import sha256
    from agentpkg.signing import embedded_public_key, fingerprint, keygen, sign_package

    source = write_probe(tmp_path / "probe")
    artifact = build_package(source, tmp_path / "probe.agent.pkg")
    private, public = tmp_path / "k.private.pem", tmp_path / "k.pub.pem"
    keygen(private, public)
    sign_package(artifact, private)
    package = load_package(artifact)
    plan = plan_for(
        package,
        archive_sha256=sha256(artifact.read_bytes()),
        signer_fingerprint=fingerprint(embedded_public_key(package.signature)),
        execution={"required_permission_ids": ["memory.session", "compute.modules"]},
    )
    compiling = []

    def slow_precompile(package_):
        compiling.append(time.monotonic())
        time.sleep(1.5)

    monkeypatch.setattr(compute_engine, "precompile", slow_precompile)

    async def main():
        async with Harness(tmp_path, archive=artifact) as harness:
            await harness.call(
                "execution.begin",
                {
                    "run_id": "run-0001",
                    "run_plan": plan,
                    "authorization": authorization(
                        {"memory.session": "session", "compute.modules": "session"}
                    ),
                    "limits": {},
                    "input": REQUEST,
                    "host": {"runtime": "openclaw", "runtime_version": "2026.9.5"},
                },
            )
            running = asyncio.create_task(harness.call("execution.run", {}, timeout=30))
            while not compiling and not running.done():
                await asyncio.sleep(0.02)
            running.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await running
            await asyncio.sleep(0.1)
            return await harness.call("execution.cancel", {})

    stop = asyncio.run(main())
    assert compiling, "the compile was reached"
    assert stop["cancel_requested"] is True
    assert stop["running"] is False
