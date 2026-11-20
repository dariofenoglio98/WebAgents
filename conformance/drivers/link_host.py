"""The conformance suite's driver for the Python reference's link host (T66): the links an operator
binds (`links.operator.operator_links`) and the grant check an execution layer makes across them
(`links.host.check_once`, link.v0 L-28), for one `run` command line of the link family.

`agentpkg run` binds the links and runs the interpreter; it makes no `once` check across a link,
which the execution session makes before anything runs (L-28). The Chrome CLI always runs through
its execution layer (D-064), so the two CLIs differ there by design, and this driver asks the
reference's layer the question `drivers/link-host.ts` asks the Chrome core. Prints one JSON
document: the outcome, and the composed worst case of the bound links (L-18, L-19).

    agentpkg/.venv/bin/python conformance/drivers/link_host.py <argv.json>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.errors import AgentPkgError  # noqa: E402
from agentpkg.execution.errors import ExecutionError  # noqa: E402
from agentpkg.fixtures import fixture_adapters  # noqa: E402
from agentpkg.links.analysis import WORST_CASE_FIGURES, package_worst_case  # noqa: E402
from agentpkg.links.host import check_once  # noqa: E402
from agentpkg.links.operator import operator_links, split_tool_approvals  # noqa: E402
from agentpkg.package import load_package  # noqa: E402
from agentpkg.signing import _read_key, fingerprint  # noqa: E402


def options(argv: list[str]) -> dict:
    found: dict = {}
    for flag, value in zip(argv, argv[1:]):
        if flag.startswith("--"):
            found.setdefault(flag, []).append(value)
    return found


def main() -> None:
    argv = json.loads(Path(sys.argv[1]).read_text())
    given = options(argv)
    package = load_package(argv[1])
    router = fixture_adapters(package)[0]
    _, linked = split_tool_approvals(package, given.get("--approve-tool", []))
    decisions = {}
    for pair in given.get("--link-grants", []):
        name, _, path = pair.partition("=")
        decisions[name] = {
            "decision": "accepted",
            "grants": json.loads(Path(path).read_text()),
            "approved_tools": linked.get(name, []),
        }
    for name in given.get("--deny-link", []):
        decisions[name] = {"decision": "denied"}
    archives = dict(pair.partition("=")[::2] for pair in given.get("--link", []))
    try:
        host = operator_links(
            package,
            archives=archives,
            decisions=decisions,
            trusted={fingerprint(_read_key(path)) for path in given.get("--trust-key", [])},
            router=router,
            adapters=lambda linked_package: fixture_adapters(linked_package)[:2],
        )
        bound = package_worst_case(package.graph, package.policy, links=host.worst_cases)
        outcome = {"composed": {name: bound[name] for name in WORST_CASE_FIGURES}}
        check_once(package, host.bindings)
        outcome = {"outcome": "accepted", **outcome}
    except ExecutionError as error:
        outcome = {"outcome": "refused", "code": error.code, "message": str(error)}
    except AgentPkgError as error:
        outcome = {"outcome": "refused", "code": getattr(error, "code", None), "message": str(error)}
    print(json.dumps(outcome, indent=2))


if __name__ == "__main__":
    main()
