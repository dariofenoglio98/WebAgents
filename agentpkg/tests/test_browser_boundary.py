"""The control plane cannot execute a package, structurally.

Two independent proofs:

1. a static import scan of every browser module, at module level and inside
   functions, so no lazy import can reintroduce an execution dependency;
2. a fresh interpreter that performs a complete open/inspect/authorize cycle
   and then shows that no execution module was ever imported.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BROWSER = ROOT / "agentpkg/src/agentpkg/browser"
# Execution modules: the interpreter, the authority mediator that dispatches to
# handlers, the assertion evaluator it calls, and the provider transports.
# `workflow_validation` and `workflow_values` are deliberately NOT listed: they
# validate graph structure and declarative data constructors, depend only on
# errors/validation/package, and dispatch nothing. Package validation
# legitimately reaches them, and refusing them would mean refusing to check the
# graph a user is being asked to authorize.
FORBIDDEN = {
    "workflow",
    "workflow_assertions",
    "runtime",
    "tools",
    "models",
    "fixtures",
    "network",
    "dev",
    "openclaw",
}
VALIDATION_ONLY = {"workflow_validation", "workflow_values"}


def _imported_agentpkg_modules(tree: ast.AST, module_path: Path) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("agentpkg."):
                    found.add(alias.name.split(".")[1])
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.module:
                # Relative: level 1 is agentpkg.browser, level 2 is agentpkg.
                found.add(node.module.split(".")[0] if node.level >= 2 else "")
            elif node.module and node.module.startswith("agentpkg."):
                found.add(node.module.split(".")[1])
            elif node.level >= 2:
                found.update(alias.name for alias in node.names)
    return {name for name in found if name}


def test_no_browser_module_imports_an_execution_module():
    modules = sorted(BROWSER.glob("*.py"))
    assert len(modules) >= 8, "expected the browser package to be present"
    for module in modules:
        tree = ast.parse(module.read_text(), filename=str(module))
        imported = _imported_agentpkg_modules(tree, module)
        assert not imported & FORBIDDEN, f"{module.name} imports {sorted(imported & FORBIDDEN)}"


def test_browser_modules_contain_no_dynamic_execution_hooks():
    for module in sorted(BROWSER.glob("*.py")):
        source = module.read_text()
        for banned in ("__import__", "importlib", "eval(", "exec(", "subprocess"):
            assert banned not in source, f"{module.name} contains {banned}"


def test_a_full_cycle_imports_no_execution_module(tmp_path):
    """A fresh interpreter opens, inspects and authorizes both packages."""
    script = f"""
import json, sys
sys.path.insert(0, {str(ROOT / "agentpkg/src")!r})
from agentpkg.browser import ControlPlane, ControlPlaneConfig
from agentpkg.browser.trust import read_public_key_file

control = ControlPlane(
    ControlPlaneConfig(
        cache_dir={str(tmp_path / "cache")!r}, trust_store_path={str(tmp_path / "trust.json")!r}
    )
)
control.trust_add(
    read_public_key_file({str(ROOT / "examples/keys/workflow-publisher.pub.pem")!r}),
    display_name="development key",
    publisher_id="webagents-research",
)
runnable = []
for artifact in ({str(ROOT / "dist/literature-review.agent.pkg")!r},
                 {str(ROOT / "dist/meeting-agenda.agent.pkg")!r}):
    summary = control.open_file(artifact)
    session = summary["session"]["id"]
    request = control.permissions(session)
    receipt = control.authorize(
        session,
        package_digest=summary["package"]["digest"],
        decisions={{p["id"]: "session" for p in request["permissions"] if p["required"]}},
    )
    runnable.append(receipt["runnable"])
print(json.dumps({{
    "runnable": runnable,
    "loaded": sorted(m for m in sys.modules if m.startswith("agentpkg.")),
}}))
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=180, check=True
    )
    report = json.loads(result.stdout.strip().splitlines()[-1])
    assert report["runnable"] == [True, True]
    loaded = {name.split(".", 2)[1] for name in report["loaded"] if name.count(".") >= 1}
    assert not loaded & FORBIDDEN, f"execution modules were imported: {sorted(loaded & FORBIDDEN)}"
    # Graph validation is reached; the interpreter that would run that graph is not.
    assert VALIDATION_ONLY <= loaded
    assert "agentpkg.browser.control" in report["loaded"]


def test_the_control_plane_exposes_no_execution_entry_point():
    from agentpkg.browser import ControlPlane

    operations = {name for name in dir(ControlPlane) if not name.startswith("_")}
    assert not operations & {"run", "execute", "run_workflow", "dispatch", "start"}
    assert {"open_file", "open_url", "summary", "permissions", "authorize"} <= operations


def test_receipts_state_that_nothing_was_executed(tmp_path):
    from agentpkg.browser import ControlPlane, ControlPlaneConfig

    control = ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json")
    )
    summary = control.open_file(str(ROOT / "dist/meeting-agenda.agent.pkg"))
    receipt = control.authorize(
        summary["session"]["id"], package_digest=summary["package"]["digest"], decisions={}
    )
    assert receipt["execution"]["performed"] is False
    assert summary["execution"]["performed"] is False
    assert control.status()["capabilities"]["execute"] is False
