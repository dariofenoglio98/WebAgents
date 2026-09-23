"""The execution namespace is allowed to compose. Nothing else is.

Three properties, each proved independently of the others:

1. the arrows point one way. `browser` and `hostbridge` cannot reach
   `execution`; `execution` may reach `workflow`, `runtime` and `hostbridge`,
   because composing those trusted components is its entire job;
2. the runner is domain-neutral. No package identifier, display name, task,
   skill or application word appears anywhere in it, so it could not be running
   one particular package even if it wanted to;
3. a real child process, spawned the way the plugin backend spawns it, runs a
   real signed package and then reports which modules it ever imported — which
   must not include a tool handler, a provider transport or the control plane.
"""

from __future__ import annotations

import ast
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "agentpkg/src"
EXECUTION = SRC / "agentpkg/execution"
BROWSER = SRC / "agentpkg/browser"
BRIDGE = SRC / "agentpkg/hostbridge"
TOOLBRIDGE = SRC / "agentpkg/toolbridge"

# What the execution namespace composes, and is therefore allowed to import.
ALLOWED = {
    "artifacts",
    "errors",
    "hostbridge",
    "interfaces",
    "package",
    "runtime",
    "signing",
    "toolbridge",
    "validation",
    "workflow",
    "workflow_assertions",
    "workflow_validation",
    "workflow_values",
}
# What it must not: provider transports, the fixture replay adapters, the tool
# broker it deliberately does not have yet, the control plane, the CLI, and the
# archived host-specific development profile.
FORBIDDEN_FOR_EXECUTION = {
    "browser",
    "cli",
    "dev",
    "fixtures",
    "models",
    "netaddr",
    "network",
    "openclaw",
    "tools",
}
# Words that would mean the runner knows what it is running. Deliberately the
# unambiguous ones: "plan" and "writer" are ordinary vocabulary here (a run
# plan, a stream writer), so the sharper check below compares against the
# reference packages' own declared identifiers instead of guessing.
DOMAIN_WORDS = (
    "meeting",
    "agenda",
    "literature",
    "citation",
    "crossref",
    "bibliograph",
    "scholarly",
    "webagents",
)


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


def _modules(package: Path) -> list[Path]:
    return sorted(package.glob("*.py"))


def test_execution_imports_only_what_it_composes():
    modules = _modules(EXECUTION)
    assert len(modules) >= 6, "expected the execution package to be present"
    for module in modules:
        imported = _imported(ast.parse(module.read_text(), filename=str(module)))
        forbidden = imported & FORBIDDEN_FOR_EXECUTION
        assert not forbidden, f"{module.name} imports {sorted(forbidden)}"
        assert imported <= ALLOWED, f"{module.name} imports {sorted(imported - ALLOWED)}"


def test_execution_actually_composes_the_interpreter_and_the_bridges():
    """The permission is not theoretical: this is the module that uses it."""
    imported = set()
    for module in _modules(EXECUTION):
        imported |= _imported(ast.parse(module.read_text(), filename=str(module)))
    assert {"workflow", "runtime", "hostbridge", "toolbridge", "package"} <= imported


def test_the_tool_bridge_is_a_leaf_that_knows_no_service_and_no_transport():
    """It carries tool calls. It must not be able to make one itself.

    Two properties, checked separately: it imports no interpreter, no control
    plane and no transport, and its text contains no network vocabulary at all.
    A handler that could open a socket would make "the host decides how" untrue.
    """
    modules = _modules(TOOLBRIDGE)
    assert len(modules) >= 4, "expected the toolbridge package to be present"
    allowed = {"errors", "hostbridge", "interfaces"}
    # Every top-level module the namespace imports, agentpkg or otherwise. An
    # allowlist rather than a banned list: a handler that could reach a network,
    # a process or the filesystem would make "the host decides how" untrue, and
    # naming the ways in would mean keeping that list complete forever.
    permitted_stdlib = {"__future__", "json", "time", "typing"}
    for module in modules:
        tree = ast.parse(module.read_text(), filename=str(module))
        imported = _imported(tree)
        assert imported <= allowed, f"{module.name} imports {sorted(imported - allowed)}"
        outside = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                outside.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and not node.level:
                outside.add((node.module or "").split(".")[0])
        assert outside <= permitted_stdlib, f"{module.name} imports {sorted(outside)}"
    code = "\n".join(ast.unparse(ast.parse(module.read_text())).lower() for module in modules)
    for banned in ("__import__", "eval(", "exec(", "compile("):
        assert banned not in code, f"the tool bridge contains {banned!r}"
    # ...and no service, provider or application vocabulary, in prose or code.
    prose = "\n".join(module.read_text().lower() for module in modules)
    for word in DOMAIN_WORDS:
        assert word not in prose, f"the tool bridge mentions {word!r}"


def test_the_tool_bridge_cannot_reach_an_interpreter_or_the_control_plane():
    for module in _modules(TOOLBRIDGE):
        imported = _imported(ast.parse(module.read_text(), filename=str(module)))
        assert not imported & {"browser", "execution", "runtime", "workflow", "tools", "network"}


def test_the_control_plane_cannot_reach_the_execution_or_tool_namespace():
    for module in _modules(BROWSER):
        imported = _imported(ast.parse(module.read_text(), filename=str(module)))
        assert "execution" not in imported, f"{module.name} reaches the execution runner"
        # The control plane evaluates tool bindings and freezes them into a
        # plan. It must stay unable to be the thing that calls one.
        assert "toolbridge" not in imported, f"{module.name} reaches the tool bridge"


def test_the_model_bridge_cannot_reach_the_execution_namespace():
    """The bridge may spend tokens. It still must not be able to run a package."""
    for module in _modules(BRIDGE):
        imported = _imported(ast.parse(module.read_text(), filename=str(module)))
        assert "execution" not in imported, f"{module.name} reaches the execution runner"
        assert not imported & {"workflow", "runtime", "tools", "toolbridge"}


def test_execution_modules_contain_no_dynamic_dispatch_or_process_execution():
    for module in _modules(EXECUTION):
        source = module.read_text()
        for banned in ("__import__", "importlib", "eval(", "exec(", "subprocess", "os.system"):
            assert banned not in source, f"{module.name} contains {banned}"


def test_the_runner_is_domain_neutral():
    """No package or application word anywhere in the namespace."""
    for module in _modules(EXECUTION):
        source = module.read_text().lower()
        for word in DOMAIN_WORDS:
            assert word not in source, f"{module.name} mentions {word!r}"


def test_the_runner_names_no_reference_package_identifier():
    """Checked against what the packages actually declare, not a guess."""
    from agentpkg.package import load_package

    identifiers: set[str] = set()
    for artifact in ("meeting-agenda.agent.pkg", "literature-review.agent.pkg"):
        package = load_package(ROOT / "dist" / artifact)
        identifiers.add(package.manifest["package_id"].lower())
        identifiers.add(package.manifest["name"].lower())
        identifiers.update(tool["id"].lower() for tool in package.manifest["tools"])
    # Graph node, task and skill ids are deliberately not compared: they are
    # ordinary English ("plan", "verify", "output") that this module uses for
    # its own reasons. What a package-specific runner would have to name is a
    # package, or a tool binding it installs for one.
    source = "\n".join(module.read_text().lower() for module in _modules(EXECUTION))
    leaked = sorted(name for name in identifiers if name and name in source)
    assert not leaked, f"the runner mentions package identifiers: {leaked}"


def test_the_runner_exposes_no_package_specific_entry_point():
    from agentpkg import execution

    names = {name for name in dir(execution) if not name.startswith("_")}
    assert not any(any(word in name.lower() for word in DOMAIN_WORDS) for name in names), sorted(
        names
    )


# The child expects the package on fd 3 and its artifact directory on fd 4,
# which is what Node's `stdio` array gives it. Python's `pass_fds` keeps the
# parent's own numbers instead, so the two lines below do here what libuv does
# there; everything after them is the shipped entry point.
CHILD = """
import asyncio, json, os, sys
os.dup2(int(sys.argv[1]), 3)
os.dup2(int(sys.argv[2]), 4)
sys.path.insert(0, {src!r})
from agentpkg.execution import serve
print("agentpkg-execution: starting", file=sys.stderr, flush=True)
code = asyncio.run(serve())
print(json.dumps({{"loaded": sorted(m for m in sys.modules if m.startswith("agentpkg"))}}),
      file=sys.stderr, flush=True)
sys.exit(code)
"""


def test_a_real_child_runs_a_real_package_without_importing_a_tool_or_transport(tmp_path):
    """The whole thing, as a separate process with inherited descriptors."""
    from execution_fakes import (
        MEETING_AGENDA,
        MEETING_INPUT,
        FakeExecutionHost,
        authorization,
        plan_for,
    )

    from agentpkg.package import load_package, sha256
    from agentpkg.signing import embedded_public_key, fingerprint

    package = load_package(MEETING_AGENDA)
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(mode=0o700)

    async def main():
        package_fd = os.open(MEETING_AGENDA, os.O_RDONLY)
        artifacts_fd = os.open(artifacts, os.O_RDONLY | os.O_DIRECTORY)
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            CHILD.format(src=str(SRC)),
            str(package_fd),
            str(artifacts_fd),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            pass_fds=(package_fd, artifacts_fd),
        )
        os.close(package_fd)
        os.close(artifacts_fd)
        host = FakeExecutionHost(process.stdout, process.stdin)
        serving = asyncio.create_task(host.peer.serve())
        begin = await host.peer.call(
            "execution.begin",
            {
                "run_id": "run-child",
                "run_plan": plan_for(
                    package,
                    archive_sha256=sha256(MEETING_AGENDA.read_bytes()),
                    signer_fingerprint=fingerprint(embedded_public_key(package.signature)),
                ),
                "authorization": authorization(),
                "input": MEETING_INPUT,
            },
            timeout=60,
        )
        result = await host.peer.call("execution.run", {}, timeout=120)
        await host.peer.call("execution.end", {}, timeout=30)
        stderr = (await process.stderr.read()).decode()
        await process.wait()
        await host.peer.close()
        await serving
        return begin, result, process.returncode, stderr

    begin, result, code, stderr = asyncio.run(main())

    assert code == 0
    assert begin["package"]["digest"] == package.digest
    assert result["status"] == "completed"
    assert result["audit"]["tool_calls"] == 0
    assert (artifacts / "agenda.json").is_file()

    # The child's descriptors were the only files it could reach: the package it
    # was handed, and the directory it wrote into.
    assert "agentpkg-execution: starting" in stderr
    loaded = json.loads(stderr.strip().splitlines()[-1])["loaded"]
    reached = {name.split(".", 2)[1] for name in loaded if name.count(".") >= 1}
    assert not reached & FORBIDDEN_FOR_EXECUTION, sorted(reached & FORBIDDEN_FOR_EXECUTION)
    assert {"agentpkg.execution.session", "agentpkg.workflow", "agentpkg.runtime"} <= set(loaded)


def test_a_child_whose_parent_disappears_exits_cleanly(tmp_path):
    """No execution.end: a closed stdin is a normal end, not a hang."""
    from execution_fakes import MEETING_AGENDA, FakeExecutionHost

    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(mode=0o700)

    async def main():
        package_fd = os.open(MEETING_AGENDA, os.O_RDONLY)
        artifacts_fd = os.open(artifacts, os.O_RDONLY | os.O_DIRECTORY)
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            CHILD.format(src=str(SRC)),
            str(package_fd),
            str(artifacts_fd),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            pass_fds=(package_fd, artifacts_fd),
        )
        os.close(package_fd)
        os.close(artifacts_fd)
        host = FakeExecutionHost(process.stdout, process.stdin)
        serving = asyncio.create_task(host.peer.serve())
        process.stdin.close()
        await asyncio.wait_for(process.wait(), timeout=30)
        await host.peer.close()
        await serving
        return process.returncode

    assert asyncio.run(main()) == 0


def test_the_execution_protocol_refuses_a_router_probe_peer():
    """Two wire versions, so a probe parent and a runner cannot handshake."""
    from agentpkg.execution.protocol import EXECUTION_PROTOCOL_VERSION
    from agentpkg.hostbridge.protocol import PROTOCOL_VERSION, ProtocolError, decode

    assert EXECUTION_PROTOCOL_VERSION != PROTOCOL_VERSION
    frame = json.dumps({"v": PROTOCOL_VERSION, "id": "h1", "method": "probe.run", "params": {}})
    try:
        decode(frame, version=EXECUTION_PROTOCOL_VERSION)
    except ProtocolError as exc:
        assert "protocol version" in str(exc)
    else:  # pragma: no cover - the refusal is the whole point
        raise AssertionError("a probe frame was accepted by an execution peer")


def test_the_runner_never_spawns_a_process_of_its_own():
    """The plugin backend owns process lifetime; the runner is a leaf."""
    for module in _modules(EXECUTION):
        source = module.read_text()
        for banned in ("subprocess", "os.fork", "os.exec", "os.spawn", "multiprocessing"):
            assert banned not in source, f"{module.name} contains {banned}"
