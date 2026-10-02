"""Private, content-addressed builds of the code under test, one per profile.

For every enforcement profile the experiment runs against its own copy of the
production sources:

* **TypeScript**: `openclaw-agent-browser/src` is copied, the profile's patches
  are applied, and the copy is compiled with the plugin's own `tsc` and
  `tsconfig.json` into `<build>/dist`. The `full` profile applies no patch, so
  its build is the plugin exactly as committed (a test checks it is
  byte-identical to a plain `npm run build`).
* **Python**: for an ablation profile, `agentpkg/src/agentpkg` is copied and
  patched, and the profile's worker process puts that copy first on
  `sys.path`. The `full` profile imports the production package itself.

A patch is an exact text substitution that must match exactly once, or the
build fails. Production files are never written; the builds live under
`experiments/contract_enforcement/.cache/builds/` and are keyed by the hash of
their inputs, so an unchanged tree is reused and a changed one is rebuilt.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .paths import AGENTPKG_PACKAGE, EXPERIMENT, PLUGIN, PLUGIN_NODE_MODULES, PLUGIN_SRC, TSC

CACHE = EXPERIMENT / ".cache" / "builds"


@dataclass(frozen=True)
class Patch:
    """One exact substitution in one production source file."""

    site: str  # stable identifier, recorded in metadata
    file: str  # path relative to the package/plugin src root
    find: str
    replace: str
    note: str = ""

    def as_json(self) -> dict:
        return {"site": self.site, "file": self.file, "note": self.note}


class PatchError(RuntimeError):
    pass


def _tree_digest(root: Path, suffixes: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix in suffixes and "__pycache__" not in path.parts:
            digest.update(str(path.relative_to(root)).encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()


def _patch_digest(patches: list[Patch]) -> str:
    return hashlib.sha256(
        json.dumps([(p.site, p.file, p.find, p.replace) for p in patches]).encode()
    ).hexdigest()


# Appended once to every patched TypeScript file that uses it: the always-false
# guard an ablated TypeScript condition is ANDed with (ablations.ts_if).
TS_NEVER = (
    "\n// contract_enforcement experiment ablation helper: always false.\n"
    "function ablatedNever(): boolean {\n  return false;\n}\n"
)


def apply_patches(root: Path, patches: list[Patch]) -> list[dict]:
    """Apply every patch under `root`; each must match its file exactly once."""
    applied = []
    for patch in patches:
        path = root / patch.file
        text = path.read_text(encoding="utf-8")
        count = text.count(patch.find)
        if count != 1:
            raise PatchError(
                f"patch {patch.site}: expected exactly one match in {patch.file}, found {count}"
            )
        text = text.replace(patch.find, patch.replace)
        if (
            path.suffix == ".ts"
            and "ablatedNever()" in text
            and "function ablatedNever" not in text
        ):
            text += TS_NEVER
        path.write_text(text, encoding="utf-8")
        applied.append(
            {
                "site": patch.site,
                "file": patch.file,
                "find_sha256": hashlib.sha256(patch.find.encode()).hexdigest(),
                "replace_sha256": hashlib.sha256(patch.replace.encode()).hexdigest(),
            }
        )
    return applied


def ts_build(profile: str, patches: list[Patch]) -> Path:
    """Compile the plugin, patched for `profile`, into a private directory."""
    tsc_version = json.loads((PLUGIN_NODE_MODULES / "typescript" / "package.json").read_text())[
        "version"
    ]
    key = hashlib.sha256(
        (
            _tree_digest(PLUGIN_SRC, (".ts",))
            + _patch_digest(patches)
            + (PLUGIN / "tsconfig.json").read_text()
            + tsc_version
        ).encode()
    ).hexdigest()[:20]
    target = CACHE / f"ts-{profile}-{key}"
    if (target / ".complete").is_file():
        return target
    staging = CACHE / f".staging-ts-{profile}-{key}-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    shutil.copytree(PLUGIN_SRC, staging / "src")
    applied = apply_patches(staging / "src", patches)
    shutil.copy2(PLUGIN / "tsconfig.json", staging / "tsconfig.json")
    shutil.copy2(PLUGIN / "package.json", staging / "package.json")
    os.symlink(PLUGIN_NODE_MODULES, staging / "node_modules")
    completed = subprocess.run(
        ["node", str(TSC), "-p", str(staging / "tsconfig.json")],
        cwd=staging,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if completed.returncode != 0:
        raise PatchError(
            f"tsc failed for profile {profile}:\n{completed.stdout}\n{completed.stderr}"
        )
    (staging / "build.json").write_text(
        json.dumps(
            {"profile": profile, "key": key, "tsc": tsc_version, "patches": applied}, indent=2
        )
    )
    (staging / ".complete").write_text("ok\n")
    if target.exists():
        shutil.rmtree(staging, ignore_errors=True)
    else:
        os.replace(staging, target)
    return target


def py_build(profile: str, patches: list[Patch]) -> Path | None:
    """A patched copy of agentpkg for `profile`, or None to use production as is."""
    if not patches:
        return None
    key = hashlib.sha256(
        (_tree_digest(AGENTPKG_PACKAGE, (".py", ".json")) + _patch_digest(patches)).encode()
    ).hexdigest()[:20]
    target = CACHE / f"py-{profile}-{key}"
    if (target / ".complete").is_file():
        return target / "src"
    staging = CACHE / f".staging-py-{profile}-{key}-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    (staging / "src").mkdir(parents=True)
    shutil.copytree(
        AGENTPKG_PACKAGE,
        staging / "src" / "agentpkg",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    applied = apply_patches(staging / "src" / "agentpkg", patches)
    (staging / "build.json").write_text(
        json.dumps({"profile": profile, "key": key, "patches": applied}, indent=2)
    )
    (staging / ".complete").write_text("ok\n")
    if target.exists():
        shutil.rmtree(staging, ignore_errors=True)
    else:
        os.replace(staging, target)
    return target / "src"


def build_diff(original_root: Path, patched_root: Path, files: list[str]) -> str:
    """A unified diff of exactly the files a profile patched, for the record."""
    import difflib

    chunks = []
    for name in sorted(set(files)):
        before = (original_root / name).read_text(encoding="utf-8").splitlines(keepends=True)
        after = (patched_root / name).read_text(encoding="utf-8").splitlines(keepends=True)
        chunks.extend(difflib.unified_diff(before, after, f"a/{name}", f"b/{name}", n=2))
    return "".join(chunks)
