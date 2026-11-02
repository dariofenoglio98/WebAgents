"""Repository locations catalog v2 depends on."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parent
EXPERIMENT = CATALOG.parent
ROOT = EXPERIMENT.parents[1]
RESULTS = CATALOG / "results"
CACHE = CATALOG / ".cache"

EXPERIMENT_NAME = "contract_enforcement/catalog_v2"
EXPERIMENT_VERSION = "2.0.0"

AGENTPKG_SRC = ROOT / "agentpkg" / "src"
AGENTPKG_PACKAGE = AGENTPKG_SRC / "agentpkg"
AGENTPKG_TESTS = ROOT / "agentpkg" / "tests"
CHROME = ROOT / "chrome-agent-browser"
CHROME_SRC = CHROME / "src"
CHROME_CORE = CHROME_SRC / "core"
CHROME_NODE_MODULES = CHROME / "node_modules"
TSC = CHROME_NODE_MODULES / "typescript" / "bin" / "tsc"
ESBUILD = CHROME_NODE_MODULES / "esbuild" / "lib" / "main.js"
CONFORMANCE_DRIVERS = ROOT / "conformance" / "drivers"
DRIVER_NODE = HERE / "driver_node"

RUNTIMES = ("py", "ts")


def ensure_v1_on_path() -> None:
    """v1's `harness` package (the exact-match patch machinery, the offline guard)."""
    if str(EXPERIMENT) not in sys.path:
        sys.path.insert(0, str(EXPERIMENT))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(root: Path, suffixes: tuple[str, ...]) -> str:
    """One hash over the relative names and bytes of every file under `root` with a suffix."""
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix in suffixes and "__pycache__" not in path.parts:
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()


def rel(path) -> str:
    """A repository-relative path for records; never an absolute local path."""
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return Path(path).name
