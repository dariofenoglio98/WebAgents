#!/usr/bin/env python3
"""Check the Chrome extension's privileges at this commit (P-19's reviewable path; T38, E8, B-268).

    agentpkg/.venv/bin/python scripts/check_extension_privileges.py [--root PATH]

Reads the extension's source manifest (`chrome-agent-browser/src/extension/manifest.json`, the
one `npm run build` copies into the packed extension) and the execution host's sources, and
prints one JSON document with `"passed"`, every check with its finding, the commit and the
manifest's SHA-256. Exits 1 on failure; nothing is written. The checks, each stated by the
security and privacy model's P-19 (`docs/security-and-privacy-model.md`):

* **permissions**: exactly the decided list (D-182, D-190, D-194: `activeTab`, `alarms`,
  `contextMenus`, `offscreen`, `scripting`, `sidePanel`, `storage`, `unlimitedStorage`), and never
  `tabs`, `webRequest`, `debugger`, `<all_urls>` or a host pattern among them; the only optional
  permission is `nativeMessaging` (the keychain helper, T17);
* **host permissions**: exactly the two loopback names; every HTTPS origin optional
  (`optional_host_permissions` exactly `https://*/*`, granted one origin at a time by the person);
* **no static reach into pages**: no `content_scripts` (the content script is injected under
  `activeTab` + `scripting`), no `externally_connectable`, no `web_accessible_resources`, and no
  `onMessageExternal` / `onConnectExternal` listener in the extension's sources (pages cannot
  message the extension);
* **content security policy**: `script-src` admits exactly `'self'` and `'wasm-unsafe-eval'`
  (own scripts and WebAssembly compilation only), `object-src 'self'`, no `unsafe-eval`, no
  `unsafe-inline`, no remote script source;
* **Worker placement**: the service worker creates the offscreen document for `WORKERS` only;
  the offscreen page runs each run in a dedicated module Worker (`execution-worker.js`); that
  Worker gives every compute call its own nested Worker (`compute-worker.js`).

`npm run check-pack` checks the packed zip's members and the same permission list (T7); this script
needs no build and runs in CI's offline loop. The tests in
`agentpkg/tests/test_check_extension_privileges.py` feed it mutated copies.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "chrome-agent-browser/src/extension/manifest.json"
EXTENSION = "chrome-agent-browser/src/extension"
OFFSCREEN_HOST = "chrome-agent-browser/src/extension/background/offscreen-host.ts"
EXECUTION_PAGE = "chrome-agent-browser/src/extension/execution/execution-page.ts"
EXECUTION_WORKER = "chrome-agent-browser/src/extension/execution/execution-worker.ts"

PERMISSIONS = sorted(
    [
        "activeTab",
        "alarms",
        "contextMenus",
        "offscreen",
        "scripting",
        "sidePanel",
        "storage",
        "unlimitedStorage",
    ]
)
NEVER = (
    "tabs",
    "webRequest",
    "webRequestBlocking",
    "debugger",
    "<all_urls>",
    "history",
    "cookies",
    "management",
)
OPTIONAL_PERMISSIONS = ["nativeMessaging"]
LOOPBACK_HOSTS = ["http://127.0.0.1/*", "http://localhost/*"]
OPTIONAL_HOSTS = ["https://*/*"]
SCRIPT_SRC = ["'self'", "'wasm-unsafe-eval'"]


def _csp(policy: str) -> dict[str, list[str]]:
    directives: dict[str, list[str]] = {}
    for part in policy.split(";"):
        tokens = part.split()
        if tokens:
            directives[tokens[0]] = tokens[1:]
    return directives


def _check(name: str, ok: bool, found, expected=None) -> dict:
    record = {"check": name, "passed": bool(ok), "found": found}
    if expected is not None:
        record["expected"] = expected
    return record


def check(root: Path) -> dict:
    manifest_path = root / MANIFEST
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw)
    checks = []
    permissions = list(manifest.get("permissions") or [])
    checks.append(
        _check(
            "manifest_version",
            manifest.get("manifest_version") == 3,
            manifest.get("manifest_version"),
            3,
        )
    )
    checks.append(
        _check(
            "permissions",
            sorted(permissions) == PERMISSIONS,
            sorted(permissions),
            PERMISSIONS,
        )
    )
    requested = permissions + list(manifest.get("optional_permissions") or [])
    forbidden = sorted(p for p in requested if p in NEVER or "://" in p)
    checks.append(_check("never_requested", not forbidden, forbidden, []))
    optional = sorted(manifest.get("optional_permissions") or [])
    checks.append(
        _check(
            "optional_permissions",
            optional == OPTIONAL_PERMISSIONS,
            optional,
            OPTIONAL_PERMISSIONS,
        )
    )
    hosts = sorted(manifest.get("host_permissions") or [])
    checks.append(
        _check("host_permissions", hosts == LOOPBACK_HOSTS, hosts, LOOPBACK_HOSTS)
    )
    optional_hosts = sorted(manifest.get("optional_host_permissions") or [])
    checks.append(
        _check(
            "optional_host_permissions",
            optional_hosts == OPTIONAL_HOSTS,
            optional_hosts,
            OPTIONAL_HOSTS,
        )
    )
    for key in (
        "content_scripts",
        "externally_connectable",
        "web_accessible_resources",
    ):
        checks.append(_check(f"no_{key}", key not in manifest, key in manifest, False))
    listeners = []
    for path in sorted((root / EXTENSION).rglob("*.ts")):
        text = path.read_text(encoding="utf-8")
        for name in ("onMessageExternal", "onConnectExternal"):
            if re.search(rf"\b{name}\b", text):
                listeners.append(f"{path.relative_to(root)}: {name}")
    checks.append(_check("no_external_message_listener", not listeners, listeners, []))
    policy = (manifest.get("content_security_policy") or {}).get("extension_pages", "")
    directives = _csp(policy)
    script_src = sorted(directives.get("script-src", []))
    checks.append(
        _check(
            "csp_script_src",
            script_src == sorted(SCRIPT_SRC),
            script_src,
            sorted(SCRIPT_SRC),
        )
    )
    checks.append(
        _check(
            "csp_object_src",
            directives.get("object-src") == ["'self'"],
            directives.get("object-src"),
            ["'self'"],
        )
    )
    unsafe = sorted(
        {
            t
            for tokens in directives.values()
            for t in tokens
            if t in ("'unsafe-eval'", "'unsafe-inline'")
        }
    )
    checks.append(_check("csp_no_unsafe", not unsafe, unsafe, []))
    offscreen = (root / OFFSCREEN_HOST).read_text(encoding="utf-8")
    reasons = re.findall(r"reasons:\s*\[([^\]]*)\]", offscreen)
    checks.append(
        _check(
            "offscreen_for_workers_only",
            reasons == ["chrome.offscreen.Reason.WORKERS"],
            reasons,
            ["chrome.offscreen.Reason.WORKERS"],
        )
    )
    page = (root / EXECUTION_PAGE).read_text(encoding="utf-8")
    run_workers = re.findall(r'new Worker\("([^"]+)",\s*\{\s*type:\s*"module"', page)
    checks.append(
        _check(
            "run_in_dedicated_worker",
            run_workers == ["execution-worker.js"],
            run_workers,
            ["execution-worker.js"],
        )
    )
    worker = (root / EXECUTION_WORKER).read_text(encoding="utf-8")
    nested = bool(
        re.search(
            r"workerComputeEngine\(\(\)\s*=>\s*browserWorkerLike\(new Worker\(COMPUTE_WORKER_SCRIPT",
            worker,
        )
    )
    script = re.search(r'COMPUTE_WORKER_SCRIPT\s*=\s*"([^"]+)"', worker)
    checks.append(
        _check(
            "compute_in_nested_worker",
            nested and script is not None and script.group(1) == "compute-worker.js",
            {"nested": nested, "script": script.group(1) if script else None},
        )
    )
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    return {
        "script": "check_extension_privileges",
        "property": "P-19",
        "commit": commit or None,
        "manifest": MANIFEST,
        "manifest_sha256": hashlib.sha256(raw).hexdigest(),
        "extension_version": manifest.get("version"),
        "checks": checks,
        "failed": [c["check"] for c in checks if not c["passed"]],
        "passed": all(c["passed"] for c in checks),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="Repository root (tests pass a mutated copy)",
    )
    args = parser.parse_args(argv)
    report = check(args.root)
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
