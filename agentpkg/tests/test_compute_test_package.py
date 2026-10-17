"""The compute-test package (examples/compute/compute-test.agent.pkg): the signed archive verifies
against its development key, is its committed source with the committed example modules, and runs
in fixture mode to the values the two modules compute; the same run twice gives the same bytes."""

import asyncio
import hashlib
import json
import shutil
from pathlib import Path

from agentpkg.cli import main
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, load_package
from agentpkg.signing import verify_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[2]
COMPUTE = ROOT / "examples" / "compute"
ARCHIVE = COMPUTE / "compute-test.agent.pkg"
SOURCE = COMPUTE / "compute-test"
KEY = ROOT / "examples" / "keys" / "compute-test-publisher.pub.pem"
GRANTS = COMPUTE / "compute-test-grants.json"
BUILT = {
    "fares": COMPUTE / "fares-as" / "dist" / "fares.wasm",
    "bookkeeping": COMPUTE / "bookkeeping-rs" / "dist" / "bookkeeping.wasm",
}


def test_the_signed_archive_is_the_source_with_the_committed_modules(tmp_path):
    verified = verify_package(ARCHIVE, trusted_key=KEY)
    assert verified["valid"] is True
    package = load_package(ARCHIVE)
    assert package.manifest["package_id"] == "org.webagents.compute-test"
    # The signed bytes, pinned: a changed module or graph is a new version and a new signature.
    assert package.digest == "3d174d573a8f7d36be2e4700e5319de280788bec101613816a301e6b2387decd"
    assert hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() == (
        "8bbbd42a9c50c27b339e00653990449781fac5d58694216c890585561a800ff4"
    )
    assert verified["key_fingerprint"] == (
        "sha256:ee5e23fdc551be212e9f24512c867479a7c71d5afb618c23a1dc76e03fe7f0a9"
    )
    assert package.manifest["runtime"]["minimum_version"] == "0.5.0"
    rebuilt = load_package(build_package(SOURCE, tmp_path / "rebuilt.agent.pkg"))
    assert rebuilt.digest == package.digest
    readme = (COMPUTE / "README.md").read_text(encoding="utf-8")
    for module in package.graph["modules"]:
        data = BUILT[module["id"]].read_bytes()
        assert package.files[module["path"]] == data
        assert hashlib.sha256(data).hexdigest() == module["sha256"]
        assert module["sha256"] in readme
    kinds = {p["kind"]: p for p in package.policy["permissions"]}
    assert kinds["compute"]["resources"] == ["bookkeeping", "fares"]


def _run(tmp_path, name, capsys):
    out = tmp_path / name
    status = main(
        [
            "run",
            str(ARCHIVE),
            "--mode",
            "fixture",
            "--grants",
            str(GRANTS),
            "--trust-key",
            str(KEY),
            "--out",
            str(out),
        ]
    )
    report = json.loads(capsys.readouterr().out)
    assert status == 0 and report["passed"] is True
    return report, json.loads((out / "result.json").read_text()), out


def test_the_package_runs_in_fixture_mode_to_the_values_the_modules_compute(tmp_path, capsys):
    report, result, out = _run(tmp_path, "first", capsys)
    assert report["usage"]["compute_calls"] == 5
    output = result["output"]
    assert output["totals"] == {
        "currency": "USD",
        "lines": [
            {
                "label": "WA101 Economy Standard",
                "amount_cents": 42900,
                "quantity": 2,
                "total_cents": 85800,
            },
            {"label": "Seat 12A", "amount_cents": 1500, "quantity": 1, "total_cents": 1500},
        ],
        "subtotal_cents": 87300,
        "tax_cents": 7421,
        "total_cents": 94721,
    }
    assert [
        (g["subtotal_cents"], g["tax_cents"], g["total_cents"]) for g in output["group_totals"]
    ] == [
        (3500, 0, 3500),
        (2400, 240, 2640),
    ]
    ids = output["ids"]
    assert [(r["id"], r["key"]) for r in ids["records"]] == [
        ("P1", "doi:10.1234/abc.1"),
        ("P2", "arxiv:2401.00001"),
        ("P3", "title:plain title"),
        ("P4", "url:https://example.org/paper"),
    ]
    assert ids["records"][0]["title"] == "A study" and ids["records"][3] == {
        "id": "P4",
        "key": "url:https://example.org/paper",
        "url": "https://example.org/paper/",
    }
    assert [(d["id"], d["record"]["title"]) for d in ids["duplicates"]] == [
        ("P1", "A study (again)"),
        ("P2", "B preprint, first version"),
        ("P3", "plain title"),
    ]
    assert output["quotes"] == {
        "matches": [{"quote": "q1", "source": "P1", "offset": 5}],
        "unmatched": ["q2"],
    }
    audit = json.loads((out / "audit.json").read_text())
    called = [e for e in audit if e["action"] == "compute.called"]
    assert sorted(e["module"] for e in called) == [
        "bookkeeping",
        "bookkeeping",
        "fares",
        "fares",
        "fares",
    ]
    assert {e["function"] for e in called} == {"run", "assign_ids", "match_quotes"}
    assert len([e for e in audit if e["action"] == "compute.completed"]) == 5
    assert not [e for e in audit if e["action"] == "compute.failed"]
    assert json.loads((out / "totals.json").read_text()) == output["totals"]
    # The same run again: identical output and identical fuel per call (C-47).
    _, second, out2 = _run(tmp_path, "second", capsys)
    assert second["output"] == output
    fuel = lambda path: sorted(  # noqa: E731
        (e["module"], e["function"], e["engine"]["fuel_consumed"])
        for e in json.loads((path / "audit.json").read_text())
        if e["action"] == "compute.completed"
    )
    assert fuel(out) == fuel(out2)


def test_the_wave_on_the_coordinator_computes_the_same_values(tmp_path):
    """C-7: compute nodes run on any role. With `totals` and `ids` moved onto the coordinator, wave
    0 holds three coordinator compute nodes and a map; the values are the signed package's, and
    every compute event names the node that made the call."""
    source = tmp_path / "compute-test"
    shutil.copytree(SOURCE, source)
    graph = json.loads((source / "graph.json").read_text())
    for node in graph["nodes"]:
        if node["id"] in ("totals", "ids"):
            node["worker"] = graph["coordinator"]
    (source / "graph.json").write_text(json.dumps(graph, indent=2))

    def execute(package):
        router, handlers, value = fixture_adapters(package)
        return asyncio.run(
            run_workflow(
                package,
                value,
                router=router,
                handlers=handlers,
                grants=json.loads(GRANTS.read_text()),
                approved_tools=[],
            )
        )

    moved = execute(load_package(source))
    assert moved["status"] == "completed"
    assert moved["output"] == execute(load_package(ARCHIVE))["output"]
    calls = sorted(
        (e["node_id"], e["worker"].split(":")[0], e["module"], e["function"])
        for e in moved["audit"]
        if e["action"] == "compute.completed"
    )
    assert calls == [
        ("groups/total", "Worker", "fares", "run"),
        ("groups/total", "Worker", "fares", "run"),
        ("ids", "coordinator", "bookkeeping", "assign_ids"),
        ("quotes", "coordinator", "bookkeeping", "match_quotes"),
        ("totals", "coordinator", "fares", "run"),
    ]


def test_the_execution_host_runs_the_package_and_compiles_off_its_loop(tmp_path, monkeypatch):
    """Through the execution session a live run uses: the five calls, and each module compiled
    first on a worker thread, so the session's loop keeps answering while it compiles."""
    import threading

    from execution_fakes import Harness, authorization, plan_for

    from agentpkg.compute.engine import default_engine
    from agentpkg.package import sha256
    from agentpkg.signing import embedded_public_key, fingerprint

    engine = default_engine()
    original = engine.compile
    compiled = []

    def watched(digest, data):
        compiled.append((digest, threading.current_thread() is threading.main_thread()))
        return original(digest, data)

    monkeypatch.setattr(engine, "compile", watched)
    package = load_package(ARCHIVE)
    plan = plan_for(
        package,
        archive_sha256=sha256(ARCHIVE.read_bytes()),
        signer_fingerprint=fingerprint(embedded_public_key(package.signature)),
        execution={"required_permission_ids": ["compute.modules", "memory.session"]},
    )

    async def scenario():
        async with Harness(tmp_path, archive=ARCHIVE) as harness:
            await harness.call(
                "execution.begin",
                {
                    "run_id": "run-0001",
                    "run_plan": plan,
                    "authorization": authorization(json.loads(GRANTS.read_text())),
                    "limits": {"total_tokens": 1000, "max_output_tokens_per_call": 100},
                    "input": package.json(package.graph["fixture"])["input"],
                    "host": {"runtime": "openclaw", "runtime_version": "2026.9.5"},
                },
            )
            return await harness.call("execution.run", {}, timeout=60)

    result = asyncio.run(scenario())
    assert result["status"] == "completed" and result["error_code"] is None
    assert result["audit"]["compute_calls"] == 5 and result["audit"]["chain"]["valid"] is True
    first = {}
    for digest, on_main in compiled:
        first.setdefault(digest, on_main)
    assert first == {module["sha256"]: False for module in package.graph["modules"]}
