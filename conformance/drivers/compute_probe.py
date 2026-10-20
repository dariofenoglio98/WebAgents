"""Write the compute.v0 probe package for one enforcement case as a source tree (T22, B-225, C-51).

    python conformance/drivers/compute_probe.py <out-dir> <case-id>
    python conformance/drivers/compute_probe.py --signed-archive <source> <out.agent.pkg> <key.pem>
    python conformance/drivers/compute_probe.py --cases

The probe is agentpkg's own test package (`agentpkg/tests/compute_probe.py`): a generic workflow.v0
package with one compute node over a hand-assembled module of `examples/compute/cases/modules/`.
Each case of `examples/compute/cases/cases.json` changes one thing (the module, the graph's
declaration of it, the node's limits, the permission, the schemas), exactly as
`agentpkg/tests/test_compute_cases.py` builds it, so that both runtimes face the same negative case
of spec/compute-v0.md §10. The runner builds and signs the tree with its throwaway key; nothing here
runs a package. `--cases` prints the case list with the grants file each case needs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))

import compute_probe as probe  # noqa: E402


def _memory_driver():
    """The memory probe driver's `signed_archive`, loaded by path (the drivers directory is not
    on sys.path, so the test package `memory_probe` it imports is agentpkg's own)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "conformance_memory_probe_driver",
        Path(__file__).resolve().parent / "memory_probe.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


signed_archive = _memory_driver().signed_archive

CASES = json.loads((probe.CASES / "cases.json").read_text())["cases"]


def module_bytes(case: dict) -> bytes:
    if case.get("generator") == "oversized":
        return probe.builder().oversized()
    if case.get("generator") == "not-wasm":
        return b"not a module"
    return probe.case_module(case["module"])


def write_case(out: Path, case: dict) -> None:
    """`test_compute_cases.py::_build`: the probe for one case, its module under the id `echo`
    unless a variant says otherwise."""
    data = module_bytes(case)
    options: dict = {}
    if case.get("output_schema"):
        options["output_schema"] = case["output_schema"]
    if case.get("input_schema"):
        options["input_schema"] = case["input_schema"]
    node = probe.compute_node(limits=case.get("node_limits"))
    variant = case.get("variant")
    modules = {"echo": data}
    if variant == "hash-mismatch":
        options["declared"] = [
            {"id": "echo", "path": "modules/echo.wasm", "sha256": "0" * 64}
        ]
    elif variant == "undeclared-member":
        options["extra_files"] = {"modules/other.wasm": probe.case_module("echo")}
    elif variant == "unknown-module":
        node["module"] = "other"
    elif variant == "unused-module":
        modules = {"echo": data, "spare": probe.case_module("with-start")}
    elif variant == "no-permission":
        options["permission"] = False
    elif variant == "wrong-resources":
        options["permission_resources"] = ["echo", "other"]
    elif variant == "minimum-0.4.0":
        options["minimum_version"] = "0.4.0"
    probe.write_probe(out, modules=modules, nodes=[node], **options)
    manifest_path = out / "MANIFEST.agent"
    manifest = json.loads(manifest_path.read_text())
    manifest["package_id"] = f"org.webagents.conformance.compute-{case['id']}"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def main(argv: list[str]) -> int:
    if argv[1] == "--signed-archive":
        signed_archive(Path(argv[2]), Path(argv[3]), Path(argv[4]))
        return 0
    if argv[1] == "--cases":
        print(json.dumps(CASES))
        return 0
    out, case_id = Path(argv[1]), argv[2]
    case = next(c for c in CASES if c["id"] == case_id)
    write_case(out, case)
    grants = Path(f"{out}.grants.json")
    decisions = {
        "memory.session": "session",
        "compute.modules": "session",
        **case.get("grants", {}),
    }
    if case.get("variant") == "no-permission":
        decisions.pop("compute.modules")
    grants.write_text(json.dumps(decisions))
    print(json.dumps({"source": str(out), "grants": str(grants), "case": case}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
