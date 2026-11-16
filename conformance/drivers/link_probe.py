"""Write the link.v0 probe composition for one enforcement case (T65; T66 runs it on both CLIs).

    python conformance/drivers/link_probe.py <out-dir> <case-id>
    python conformance/drivers/link_probe.py --all <out-dir>
    python conformance/drivers/link_probe.py --signed-archive <source> <out.agent.pkg> <key.pem>
    python conformance/drivers/link_probe.py --cases

The probe is agentpkg's own test composition (`agentpkg/tests/link_probe.py`): a help desk whose
`Lookup` and `Writer` roles each hold one `link` step, to the linked packages `index` (one tool)
and `scribe` (one model step). Each case of `examples/link/cases/cases.json` changes one thing,
exactly as `agentpkg/tests/test_link_cases.py` builds it, so that both runtimes face the same
case of spec/link-v0.md §10.

Under `<out-dir>` the driver writes the caller's source (`caller/`), each linked package built
and signed with its own throwaway publisher key (`keys/`, made here: a denial is of a key, so
the linked packages need distinct ones), the caller's grants file, and the arguments a CLI's
`run` takes beside the package and `--out`: `--link`, `--link-grants`, `--deny-link`,
`--approve-tool <id>:<tool>` and, where the case lowers a host limit, `--limits`. A runner
builds and signs the caller with its own key (`--signed-archive` for a caller both CLIs must
refuse at validation); nothing here runs a package. `trust_keys` are the linked publishers'
public keys: a runner that pins keys passes its own caller key as the first `--trust-key`,
since the first pins the caller's publisher and only that one verifies the caller (link.v0
§12). The cases of the stage `host` are an execution host's (a plan handed to a runner), not
a CLI's.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

import link_probe as probe
from agentpkg.signing import keygen

CASES = json.loads((probe.CASES / "cases.json").read_text())["cases"]


def _memory_driver():
    """The memory probe driver's `signed_archive`, loaded by path (as `network_probe.py` does)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "conformance_memory_probe_driver",
        Path(__file__).resolve().parent / "memory_probe.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _keys(directory: Path) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    keys = {}
    for name in ("default", "index", "scribe", "helper"):
        keys[name] = (directory / f"{name}.private.pem", directory / f"{name}.pub.pem")
        if not keys[name][0].exists():
            keygen(*keys[name])
    return keys


def write_case(out: Path, case: dict) -> dict:
    """`test_link_cases.py::build`: the composition for one case, with its files beside it."""
    out = out.resolve()
    made = probe.scenario(case.get("variant"))
    made.caller["MANIFEST.agent"]["package_id"] = (
        f"org.webagents.conformance.link-{case['id']}"
    )
    built = probe.write(out, made, _keys(out / "keys"))
    grants = out / "caller.grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    return {
        "source": str(built.caller),
        "grants": str(grants),
        "argv": built.argv(out),
        "trust_keys": [str(key) for key in built.public_keys],
        "case": case,
    }


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
