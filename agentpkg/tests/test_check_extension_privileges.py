"""`scripts/check_extension_privileges.py` (T38, P-19): each check refuses a mutated copy."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check_extension_privileges.py"


def _load():
    spec = importlib.util.spec_from_file_location("check_extension_privileges", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


checker = _load()


@pytest.fixture
def copy(tmp_path):
    """The files the checker reads, copied under a fresh root."""
    for relative in (
        checker.MANIFEST,
        checker.OFFSCREEN_HOST,
        checker.EXECUTION_PAGE,
        checker.EXECUTION_WORKER,
    ):
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, target)
    return tmp_path


def _manifest(root: Path, change) -> None:
    path = root / checker.MANIFEST
    manifest = json.loads(path.read_text())
    change(manifest)
    path.write_text(json.dumps(manifest))


def _failed(root: Path) -> list[str]:
    return checker.check(root)["failed"]


def test_the_committed_extension_passes():
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True, check=False
    )
    report = json.loads(completed.stdout)
    assert completed.returncode == 0 and report["passed"] is True, report["failed"]
    assert report["property"] == "P-19" and len(report["manifest_sha256"]) == 64


def test_the_copy_passes(copy):
    assert _failed(copy) == []


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (lambda m: m["permissions"].append("tabs"), {"permissions", "never_requested"}),
        (lambda m: m["permissions"].remove("activeTab"), {"permissions"}),
        (lambda m: m["permissions"].append("https://*/*"), {"permissions", "never_requested"}),
        (
            lambda m: m.setdefault("optional_permissions", []).append("webRequest"),
            {"never_requested", "optional_permissions"},
        ),
        (lambda m: m["host_permissions"].append("https://example.org/*"), {"host_permissions"}),
        (
            lambda m: m.update(optional_host_permissions=["<all_urls>"]),
            {"optional_host_permissions"},
        ),
        (
            lambda m: m.update(
                content_scripts=[{"matches": ["https://*/*"], "js": ["content-script.js"]}]
            ),
            {"no_content_scripts"},
        ),
        (
            lambda m: m.update(externally_connectable={"matches": ["https://*/*"]}),
            {"no_externally_connectable"},
        ),
        (
            lambda m: m.update(
                web_accessible_resources=[
                    {"resources": ["browser.html"], "matches": ["<all_urls>"]}
                ]
            ),
            {"no_web_accessible_resources"},
        ),
        (
            lambda m: m["content_security_policy"].update(
                extension_pages="script-src 'self' 'unsafe-eval'; object-src 'self'"
            ),
            {"csp_script_src", "csp_no_unsafe"},
        ),
        (
            lambda m: m["content_security_policy"].update(
                extension_pages="script-src 'self' 'wasm-unsafe-eval' https://cdn.example; "
                "object-src 'self'"
            ),
            {"csp_script_src"},
        ),
        (
            lambda m: m["content_security_policy"].update(
                extension_pages="script-src 'self' 'wasm-unsafe-eval'; object-src *"
            ),
            {"csp_object_src"},
        ),
        (lambda m: m.update(manifest_version=2), {"manifest_version"}),
        (
            lambda m: m["content_security_policy"].update(
                sandbox="sandbox allow-scripts; script-src 'self' 'unsafe-eval' https://cdn.example"
            ),
            {"csp_extension_pages_only"},
        ),
        (
            lambda m: m.update(sandbox={"pages": ["sandbox.html"]}),
            {"no_sandbox"},
        ),
    ],
)
def test_each_manifest_change_is_refused(copy, change, expected):
    _manifest(copy, change)
    assert set(_failed(copy)) == expected


def test_an_external_message_listener_is_refused(copy):
    path = copy / checker.EXTENSION / "background" / "listener.ts"
    path.write_text("chrome.runtime.onMessageExternal.addListener(() => undefined);\n")
    assert _failed(copy) == ["no_external_message_listener"]


@pytest.mark.parametrize(
    ("name", "text"),
    [
        ("listener.js", "chrome.runtime.onConnectExternal.addListener(() => undefined);\n"),
        ("listener.mjs", "chrome.runtime.onMessageExternal.addListener(() => undefined);\n"),
        (
            "page.html",
            "<!doctype html><script>chrome.runtime.onMessageExternal.addListener(() => 0)"
            "</script>\n",
        ),
    ],
)
def test_a_listener_in_a_script_or_a_page_is_refused(copy, name, text):
    (copy / checker.EXTENSION / "ui").mkdir(parents=True, exist_ok=True)
    (copy / checker.EXTENSION / "ui" / name).write_text(text)
    assert _failed(copy) == ["no_external_message_listener"]


def test_the_worker_placement_is_checked(copy):
    offscreen = copy / checker.OFFSCREEN_HOST
    offscreen.write_text(
        offscreen.read_text().replace(
            "chrome.offscreen.Reason.WORKERS", "chrome.offscreen.Reason.DOM_PARSER"
        )
    )
    page = copy / checker.EXECUTION_PAGE
    page.write_text(
        page.read_text().replace('new Worker("execution-worker.js"', 'new Worker("other.js"')
    )
    worker = copy / checker.EXECUTION_WORKER
    worker.write_text(
        worker.read_text().replace(
            'COMPUTE_WORKER_SCRIPT = "compute-worker.js"', 'COMPUTE_WORKER_SCRIPT = "inline.js"'
        )
    )
    assert set(_failed(copy)) == {
        "offscreen_for_workers_only",
        "run_in_dedicated_worker",
        "compute_in_nested_worker",
    }
