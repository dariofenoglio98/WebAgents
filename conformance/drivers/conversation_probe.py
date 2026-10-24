"""Write the conversation.v0 probe package for one enforcement case as a source tree (T24, B-232).

    python conformance/drivers/conversation_probe.py <out-dir> <case-id>
    python conformance/drivers/conversation_probe.py --signed-archive <source> <out.agent.pkg> <key.pem>
    python conformance/drivers/conversation_probe.py --cases

The probe is agentpkg's own test package (`agentpkg/tests/conversation_probe.py`): the ticket desk
reduced to one model step, one consent step before one write tool and two joins that carry the
history and the orders across turns. Each case of `examples/conversation/cases/cases.json` changes
one thing (the conversation object, a consent step, the tool it gates, the persistent state, the
fixture transcript), exactly as `agentpkg/tests/test_conversation_cases.py` builds it, so that
both runtimes face the same case of spec/conversation-v0.md §10. Beside the source the driver
writes the case's grants file and, when the case supplies one, its input transcript. The runner
builds and signs the tree with its throwaway key; nothing here runs a package.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))

import conversation_probe as probe  # noqa: E402


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


signed_archive = _memory_driver().signed_archive

CASES = json.loads((probe.CASES / "cases.json").read_text())["cases"]


def transcript_of(case: dict) -> dict | None:
    """`test_conversation_cases.py::_transcript`: the case's input transcript, or None when the
    case replays the package's own fixture."""
    if "transcript_raw" in case:
        return case["transcript_raw"]
    if "transcript" not in case:
        return None
    turns = [tuple(t) if isinstance(t, list) else t for t in case["transcript"]]
    return probe.transcript(*turns)


def write_case(out: Path, case: dict) -> None:
    """`test_conversation_cases.py::_build`: the probe for one case."""
    options = {}
    if case.get("remote_tool"):
        options["remote_tool"] = True
    mutate = probe.VARIANTS[case["variant"]] if case.get("variant") else None

    def apply(members):
        members["MANIFEST.agent"]["package_id"] = f"org.webagents.conformance.conversation-{case['id']}"
        if mutate is not None:
            mutate(members)

    probe.write_probe(out, mutate=apply, **options)


def main(argv: list[str]) -> int:
    if argv[1] == "--cases":
        print(json.dumps(CASES))
        return 0
    if argv[1] == "--signed-archive":
        signed_archive(Path(argv[2]), Path(argv[3]), Path(argv[4]))
        return 0
    out, case_id = Path(argv[1]), argv[2]
    case = next(c for c in CASES if c["id"] == case_id)
    write_case(out, case)
    grants = Path(f"{out}.grants.json")
    grants.write_text(json.dumps(probe.grants(**case.get("grants", {}))))
    answer = {"source": str(out), "grants": str(grants), "case": case, "transcript": None, "limits": None}
    transcript = transcript_of(case)
    if transcript is not None:
        path = Path(f"{out}.transcript.json")
        path.write_text(json.dumps(transcript))
        answer["transcript"] = str(path)
    if case.get("limits"):
        path = Path(f"{out}.limits.json")
        path.write_text(json.dumps(case["limits"]))
        answer["limits"] = str(path)
    print(json.dumps(answer))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
