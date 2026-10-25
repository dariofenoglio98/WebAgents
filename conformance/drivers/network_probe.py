"""Write the network.v0 probe package for one enforcement case as a source tree (T26).

    python conformance/drivers/network_probe.py <out-dir> <case-id>
    python conformance/drivers/network_probe.py --all <out-dir>
    python conformance/drivers/network_probe.py --signed-archive <source> <out.agent.pkg> <key.pem>
    python conformance/drivers/network_probe.py --cases

The probe is agentpkg's own test package (`agentpkg/tests/network_probe.py`): a help desk where
`Desk` chooses between `Lookup` and `Writer` or ends, its fixture generated from the mutated
network and a scripted walk with the runtime's exact route data. Each case of
`examples/network/cases/cases.json` changes one thing, exactly as
`agentpkg/tests/test_network_cases.py` builds it, so that both runtimes face the same case of
spec/network-v0.md §7. Beside the source the driver writes the case's grants file. `--all` writes
every case under `<out-dir>/<case-id>` and prints the list (the Chrome unit suite reads it). The
runner builds and signs a tree with its throwaway key; nothing here runs a package.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))

import network_probe as probe  # noqa: E402


def _memory_driver():
    """The memory probe driver's `signed_archive`, loaded by path (as `compute_probe.py` does)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "conformance_memory_probe_driver",
        Path(__file__).resolve().parent / "memory_probe.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CASES = json.loads((probe.CASES / "cases.json").read_text())["cases"]


def write_case(out: Path, case: dict) -> dict:
    """`test_network_cases.py::_build`: the probe for one case, and its grants file beside it."""
    mutate = probe.VARIANTS[case["variant"]] if case.get("variant") else None

    def apply(members):
        members["MANIFEST.agent"]["package_id"] = f"org.webagents.conformance.network-{case['id']}"
        if mutate is not None:
            mutate(members)

    probe.write_probe(out, mutate=apply)
    grants = Path(f"{out}.grants.json")
    grants.write_text(json.dumps(probe.grants(**case.get("grants", {}))))
    return {"source": str(out), "grants": str(grants), "case": case}


def main(argv: list[str]) -> int:
    if argv[1] == "--cases":
        print(json.dumps(CASES))
        return 0
    if argv[1] == "--signed-archive":
        _memory_driver().signed_archive(Path(argv[2]), Path(argv[3]), Path(argv[4]))
        return 0
    if argv[1] == "--all":
        out = Path(argv[2])
        print(json.dumps([write_case(out / case["id"], case) for case in CASES]))
        return 0
    out, case_id = Path(argv[1]), argv[2]
    case = next(c for c in CASES if c["id"] == case_id)
    print(json.dumps(write_case(out, case)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
