"""The conformance suite's driver for the Python execution layer's grant check.

`agentpkg run` drives the interpreter directly, so a denied required permission or an over-used
`once` grant is refused at the first use. The execution runner the browsers use
(`agentpkg.execution`) refuses both before anything runs, and so does the Chrome CLI, which
always runs through its execution layer (D-064). This driver asks that layer the same question
`drivers/execution-policy.ts` asks the Chrome core, and prints one JSON document:

    agentpkg/.venv/bin/python conformance/drivers/execution_policy.py <package> <grants.json>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.execution.errors import ExecutionError  # noqa: E402
from agentpkg.execution.policy import normalize_grants  # noqa: E402
from agentpkg.package import load_package  # noqa: E402

if __name__ == "__main__":
    package = load_package(sys.argv[1])
    grants = json.loads(Path(sys.argv[2]).read_text())
    try:
        outcome = {"outcome": "accepted", "grants": normalize_grants(package, grants)}
    except ExecutionError as error:
        outcome = {"outcome": "refused", "code": error.code, "message": str(error)}
    print(json.dumps(outcome, indent=2))
