"""The bridge can spend model tokens. It still cannot run a package.

Three independent proofs:

1. a static import scan of every bridge module, at module level and inside
   functions, so no lazy import can reintroduce the interpreter;
2. a real child process that completes a full bind → probe → end cycle and then
   reports which `agentpkg` modules it ever imported;
3. the same child's stdout, which the parent parses as protocol frames and
   nothing else, while the child deliberately writes logs to stderr.
"""

from __future__ import annotations

import ast
import asyncio
import json
import sys
from pathlib import Path

from hostbridge_fakes import PLAN, FakeHost

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "agentpkg/src"
BRIDGE = SRC / "agentpkg/hostbridge"

# Execution modules: the interpreter, the authority mediator, the assertion
# evaluator, the provider transports, and the control plane on the other side
# of the boundary. `interfaces` and `validation` are deliberately absent from
# this set: the first is the protocol this package implements, the second is
# offline schema checking with no dispatch of any kind.
FORBIDDEN = {
    "workflow",
    "workflow_assertions",
    "workflow_validation",
    "workflow_values",
    "runtime",
    "tools",
    "models",
    "fixtures",
    "network",
    "netaddr",
    "dev",
    "openclaw",
    "browser",
    "cli",
}


def _imported(tree: ast.AST) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("agentpkg."):
                    found.add(alias.name.split(".")[1])
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.module:
                found.add(node.module.split(".")[0] if node.level >= 2 else "")
            elif node.module and node.module.startswith("agentpkg."):
                found.add(node.module.split(".")[1])
            elif node.level >= 2:
                found.update(alias.name for alias in node.names)
    return {name for name in found if name}


def test_no_bridge_module_imports_an_execution_or_control_plane_module():
    modules = sorted(BRIDGE.glob("*.py"))
    assert len(modules) >= 6, "expected the bridge package to be present"
    for module in modules:
        imported = _imported(ast.parse(module.read_text(), filename=str(module)))
        assert not imported & FORBIDDEN, f"{module.name} imports {sorted(imported & FORBIDDEN)}"


def test_the_bridge_contains_no_dynamic_dispatch_or_process_execution():
    for module in sorted(BRIDGE.glob("*.py")):
        source = module.read_text()
        for banned in ("__import__", "importlib", "eval(", "exec(", "subprocess", "os.system"):
            assert banned not in source, f"{module.name} contains {banned}"


def test_the_control_plane_cannot_reach_the_bridge():
    """The browser opens and authorizes; it must not be able to spend tokens."""
    browser = SRC / "agentpkg/browser"
    for module in sorted(browser.glob("*.py")):
        imported = _imported(ast.parse(module.read_text(), filename=str(module)))
        assert "hostbridge" not in imported, f"{module.name} reaches the execution bridge"


def test_the_bridge_exposes_no_workflow_entry_point():
    from agentpkg import hostbridge
    from agentpkg.hostbridge.session import BridgeSession

    names = {name for name in dir(hostbridge) if not name.startswith("_")}
    assert not names & {"Workflow", "run_workflow", "Runtime", "create_handlers"}
    operations = {name for name in dir(BridgeSession) if not name.startswith("_")}
    assert not operations & {"run", "execute", "run_workflow", "dispatch", "tool"}


CHILD = f"""
import asyncio, json, sys
sys.path.insert(0, {str(SRC)!r})
from agentpkg.hostbridge import serve
# Deliberate noise: a real child logs, and logs must never reach the protocol.
print("host-bridge: starting", file=sys.stderr, flush=True)
code = asyncio.run(serve())
print(json.dumps({{
    "loaded": sorted(m for m in sys.modules if m.startswith("agentpkg")),
}}), file=sys.stderr, flush=True)
sys.exit(code)
"""


def test_a_real_child_probes_a_model_without_importing_an_execution_module():
    async def main():
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            CHILD,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        host = FakeHost(
            process.stdout, process.stdin, usage_report={"input_tokens": 800, "output_tokens": 12}
        )
        serving = asyncio.create_task(host.peer.serve())
        begin = await host.peer.call("session.begin", {"run_plan": PLAN}, timeout=30)
        report = await host.peer.call("probe.run", {}, timeout=60)
        ended = await host.peer.call("session.end", {}, timeout=30)
        stderr = (await process.stderr.read()).decode()
        await process.wait()
        await host.peer.close()
        await serving
        return begin, report, ended, process.returncode, stderr

    begin, report, ended, code, stderr = asyncio.run(main())

    assert code == 0 and ended == {"ended": True, "probes": 1}
    assert begin["router"]["model_id"] == "acme/big"
    assert report["status"] == "ok"
    assert report["probe"] == {"status": "ok", "echo": "router probe"}
    assert report["workflow_executed"] is False

    # Logs went to stderr; every stdout byte parsed as a protocol frame, or the
    # parent peer above would have raised a ProtocolError instead of answering.
    assert "host-bridge: starting" in stderr
    loaded = json.loads(stderr.strip().splitlines()[-1])["loaded"]
    reached = {name.split(".", 2)[1] for name in loaded if name.count(".") >= 1}
    assert not reached & FORBIDDEN, f"the child imported {sorted(reached & FORBIDDEN)}"
    assert "agentpkg.hostbridge.router" in loaded


def test_a_child_whose_parent_disappears_exits_cleanly():
    """No session.end: the child must treat a closed stdin as a normal end."""

    async def main():
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            CHILD,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        host = FakeHost(process.stdout, process.stdin)
        serving = asyncio.create_task(host.peer.serve())
        await host.peer.call("session.begin", {"run_plan": PLAN}, timeout=30)
        process.stdin.close()  # The parent goes away mid-session.
        await asyncio.wait_for(process.wait(), timeout=30)
        await host.peer.close()
        await serving
        return process.returncode

    assert asyncio.run(main()) == 0
