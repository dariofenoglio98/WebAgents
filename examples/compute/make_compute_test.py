"""Stamp the built example modules into the compute-test package source and build its archive.

    agentpkg/.venv/bin/python examples/compute/make_compute_test.py [--force]

Copies `fares-as/dist/fares.wasm` and `bookkeeping-rs/dist/bookkeeping.wasm` into
`compute-test/modules/`, writes their SHA-256 into `compute-test/graph.json`, validates the source
and builds `compute-test.agent.pkg` (unsigned; `--force` replaces an existing archive). Signing is a
separate, deliberate step with the development key, never done here:

    agentpkg/.venv/bin/agentpkg sign examples/compute/compute-test.agent.pkg \\
        --private-key ~/.config/agentpkg/keys/webagents-compute-test.private.pem

A changed module means a changed package: a new version and a new signature (D-003).
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.package import build_package, load_package  # noqa: E402

MODULES = {
    "fares": HERE / "fares-as" / "dist" / "fares.wasm",
    "bookkeeping": HERE / "bookkeeping-rs" / "dist" / "bookkeeping.wasm",
}
SOURCE = HERE / "compute-test"
ARCHIVE = HERE / "compute-test.agent.pkg"


def main(argv) -> int:
    graph_path = SOURCE / "graph.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    for module in graph["modules"]:
        built = MODULES[module["id"]]
        if not built.exists():
            print(f"missing {built}: build it first", file=sys.stderr)
            return 1
        target = SOURCE / module["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(built, target)
        module["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
        print(f"{module['id']}: {module['sha256']} ({target.stat().st_size} bytes)")
    graph_path.write_text(json.dumps(graph, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    package = load_package(SOURCE)
    print("source validates:", package.manifest["package_id"], package.manifest["version"])
    if ARCHIVE.exists():
        if "--force" not in argv:
            print(f"{ARCHIVE} exists; pass --force to replace the unsigned archive", file=sys.stderr)
            return 1
        ARCHIVE.unlink()
    built = build_package(SOURCE, ARCHIVE)
    print("built:", built, "digest:", load_package(built).digest)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
