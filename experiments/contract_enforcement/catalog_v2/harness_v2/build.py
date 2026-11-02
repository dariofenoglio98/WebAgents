"""Private, content-addressed builds of both runtimes, one per enforcement profile (D-301).

* **Python**: `agentpkg/src/agentpkg` is copied (for every profile, the full one included, so
  that every worker imports a private copy whose hash is recorded) and the profile's patches are
  applied; the worker process puts `<build>/src` first on `sys.path` and refuses to start if
  `agentpkg` resolves anywhere else.
* **Node**: all of `chrome-agent-browser/src` is copied, the profile's patches are applied to
  files under `src/core` only, the driver (`driver_node/driver.ts`) is placed beside it, the
  copy is type-checked with the core's own TypeScript, and the driver and the CLI's compute
  Worker entry are bundled with the core's own esbuild into `<build>/driver/`.

A patch is an exact substitution that must match exactly once (v1's `build.apply_patches`). The
production trees are only read. Builds live under `catalog_v2/.cache/builds/` (git-ignored),
keyed by the hash of their inputs, so an unchanged tree is reused.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from .paths import (
    AGENTPKG_PACKAGE,
    CACHE,
    CHROME,
    CHROME_NODE_MODULES,
    CHROME_SRC,
    DRIVER_NODE,
    ESBUILD,
    TSC,
    ensure_v1_on_path,
    tree_digest,
)

ensure_v1_on_path()

from harness.build import Patch, PatchError, apply_patches, build_diff  # noqa: E402

BUILDS = CACHE / "builds"

__all__ = ["Patch", "PatchError", "build_diff", "node_build", "py_build", "BUILDS"]


def _patch_digest(patches: list[Patch]) -> str:
    return hashlib.sha256(
        json.dumps([(p.site, p.file, p.find, p.replace) for p in patches]).encode()
    ).hexdigest()


def _finish(staging: Path, target: Path) -> Path:
    (staging / ".complete").write_text("ok\n")
    if target.exists():
        shutil.rmtree(staging, ignore_errors=True)
    else:
        os.replace(staging, target)
    return target


def py_key(patches: list[Patch]) -> str:
    return hashlib.sha256(
        (tree_digest(AGENTPKG_PACKAGE, (".py", ".json")) + _patch_digest(patches)).encode()
    ).hexdigest()[:20]


def py_build(profile: str, patches: list[Patch]) -> Path:
    """A private copy of agentpkg for `profile`; returns the build directory (`<build>/src`
    goes first on the worker's sys.path)."""
    key = py_key(patches)
    target = BUILDS / f"py-{profile}-{key}"
    if (target / ".complete").is_file():
        return target
    staging = BUILDS / f".staging-py-{profile}-{key}-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    (staging / "src").mkdir(parents=True)
    shutil.copytree(
        AGENTPKG_PACKAGE,
        staging / "src" / "agentpkg",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    applied = apply_patches(staging / "src" / "agentpkg", patches)
    (staging / "build.json").write_text(
        json.dumps(
            {
                "runtime": "py",
                "profile": profile,
                "key": key,
                "source_sha256": tree_digest(staging / "src" / "agentpkg", (".py", ".json")),
                "patches": applied,
            },
            indent=2,
        )
    )
    diff = build_diff(AGENTPKG_PACKAGE, staging / "src" / "agentpkg", [p.file for p in patches])
    (staging / "patch.diff").write_text(diff)
    return _finish(staging, target)


def _tool_versions() -> str:
    tsc = json.loads((CHROME_NODE_MODULES / "typescript" / "package.json").read_text())["version"]
    esbuild = json.loads((CHROME_NODE_MODULES / "esbuild" / "package.json").read_text())["version"]
    node = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    return f"tsc {tsc}; esbuild {esbuild}; node {node}"


def node_key(patches: list[Patch]) -> str:
    return hashlib.sha256(
        (
            tree_digest(CHROME_SRC, (".ts", ".json"))
            + tree_digest(DRIVER_NODE, (".ts", ".json"))
            + _patch_digest(patches)
            + (CHROME / "package-lock.json").read_text()
            + _tool_versions()
        ).encode()
    ).hexdigest()[:20]


BUNDLE = """
import {{ build }} from {esbuild};
const common = {{
  bundle: true, minify: false, sourcemap: false, legalComments: "inline", logLevel: "warning",
  format: "esm", platform: "node", target: ["node24"],
}};
await build({{ ...common, entryPoints: [{driver}], outfile: {driver_out} }});
await build({{ ...common, entryPoints: [{worker}], outfile: {worker_out} }});
"""


def node_build(profile: str, patches: list[Patch], *, typecheck: bool = True) -> Path:
    """The Node driver bundled over a private, patched copy of the Chrome core; returns the
    build directory (`<build>/driver/driver.js`)."""
    for patch in patches:
        if not patch.file.startswith("core/"):
            raise PatchError(f"patch {patch.site}: Node patches apply under src/core only")
    key = node_key(patches)
    target = BUILDS / f"ts-{profile}-{key}"
    if (target / ".complete").is_file():
        return target
    staging = BUILDS / f".staging-ts-{profile}-{key}-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    shutil.copytree(CHROME_SRC, staging / "src")
    applied = apply_patches(staging / "src", patches)
    (staging / "driver").mkdir()
    shutil.copy2(DRIVER_NODE / "driver.ts", staging / "driver" / "driver.ts")
    shutil.copy2(DRIVER_NODE / "tsconfig.json", staging / "driver" / "tsconfig.json")
    # The core is an ES module package (`"type": "module"`): its package.json decides how
    # NodeNext resolves and type-checks the copy.
    shutil.copy2(CHROME / "package.json", staging / "package.json")
    os.symlink(CHROME_NODE_MODULES, staging / "node_modules")
    if typecheck:
        checked = subprocess.run(
            ["node", str(TSC), "-p", str(staging / "driver" / "tsconfig.json")],
            cwd=staging,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if checked.returncode != 0:
            raise PatchError(
                f"tsc failed for profile {profile}:\n"
                f"{checked.stdout[-4000:]}\n{checked.stderr[-2000:]}"
            )
    script = BUNDLE.format(
        esbuild=json.dumps(ESBUILD.as_uri()),
        driver=json.dumps(str(staging / "driver" / "driver.ts")),
        driver_out=json.dumps(str(staging / "driver" / "driver.js")),
        worker=json.dumps(str(staging / "src" / "compute-worker-node.ts")),
        worker_out=json.dumps(str(staging / "driver" / "compute-worker.js")),
    )
    bundled = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=staging,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if bundled.returncode != 0:
        raise PatchError(f"esbuild failed for profile {profile}:\n{bundled.stderr[-4000:]}")
    (staging / "node_modules").unlink()
    diff = build_diff(CHROME_SRC, staging / "src", [p.file for p in patches])
    (staging / "patch.diff").write_text(diff)
    build = {
        "runtime": "ts",
        "profile": profile,
        "key": key,
        "tools": _tool_versions(),
        "typechecked": typecheck,
        "source_sha256": tree_digest(staging / "src", (".ts", ".json")),
        "driver_sha256": hashlib.sha256(
            (staging / "driver" / "driver.js").read_bytes()
        ).hexdigest(),
        "patches": applied,
    }
    (staging / "build.json").write_text(json.dumps(build, indent=2))
    (staging / "driver" / "build.json").write_text(json.dumps(build, indent=2))
    return _finish(staging, target)
