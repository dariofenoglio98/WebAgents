#!/usr/bin/env python3
"""Reproduce finding CE-1: an invalid output-token count is charged as zero, not refused.

    cd experiments/contract_enforcement/findings/usage-count-coercion
    ../../../../agentpkg/.venv/bin/python reproduce.py

Runs each package's first model call on the unmodified full system (the plugin
compiled from its own sources, agentpkg from agentpkg/src), offline, with the
host's usage report replaced by one malformed variant at a time, and prints
what the run charged against the call's honest usage. Writes evidence.json
next to this script.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXPERIMENT = HERE.parents[1]
sys.path.insert(0, str(EXPERIMENT))

import agentpkg  # noqa: E402

from cases.base import Env, base_plan  # noqa: E402
from cases.f7_output import rule  # noqa: E402
from cases.f8_resources import usage_change  # noqa: E402
from harness import oracle  # noqa: E402
from harness.build import ts_build  # noqa: E402
from harness.guards import StateProbe  # noqa: E402
from harness.host import HostHelper  # noqa: E402
from harness.paths import AGENTPKG_SRC, rel  # noqa: E402
from harness.pipeline import run_case  # noqa: E402

VARIANTS = (
    "none",
    "negative_count",
    "negative_count_without_total",
    "string_count_without_total",
    "fractional_count",
    "missing",
    "at_cap",
)
CALLS = (("meeting-agenda", "plan"), ("literature-review", "plan"))


async def main() -> dict:
    source = Path(agentpkg.__file__).resolve()
    if not str(source).startswith(str(AGENTPKG_SRC.resolve())):
        raise SystemExit(f"not production agentpkg: {source}")
    work = Path(tempfile.mkdtemp(prefix="ce-finding-"))
    helper = HostHelper(ts_build("full", []), log_path=work / "helper.log")
    await helper.start()
    probe = StateProbe()
    probe.install()
    env = Env(20261002, built_in_bindings=helper.hello["built_in_bindings"])
    evidence = {
        "agentpkg": rel(source.parent),
        "plugin": "openclaw-agent-browser/src (compiled, unpatched)",
        "runs": {},
    }
    try:
        for package, task in CALLS:
            for label in VARIANTS:
                plan = base_plan(env, package)
                if label != "none":
                    plan.faults.model.append(
                        rule(package, task, "", {"kind": "usage", "apply": usage_change(label)})
                    )
                obs = await run_case(plan, helper, work / f"{package}-{label}", probe=probe)
                call = next(c for c in oracle.model_dispatches(obs) if c["task"] == task)
                completed = [
                    e
                    for e in obs["audit_raw"]
                    if e.get("action") == "model.completed" and e.get("task") == task
                ]
                failed = [
                    e
                    for e in obs["audit_raw"]
                    if e.get("action") == "model.failed" and e.get("task") == task
                ]
                charged = completed[0]["tokens"] if completed else None
                evidence["runs"][f"{package}/{task}/{label}"] = {
                    "host_usage_report": call.get("usage"),
                    "honest_tokens": call.get("honest_tokens"),
                    "charged_tokens": charged,
                    "undercharged_by": (call["honest_tokens"] - charged)
                    if charged is not None
                    else None,
                    "call_refused_with": failed[0].get("reason") if failed else None,
                    "run_status": (obs.get("run_record") or {}).get("status"),
                }
    finally:
        probe.uninstall()
        await helper.stop()
        shutil.rmtree(work, ignore_errors=True)
    return evidence


if __name__ == "__main__":
    result = asyncio.run(main())
    (HERE / "evidence.json").write_text(json.dumps(result, indent=1, sort_keys=True) + "\n")
    for key, run in result["runs"].items():
        print(
            f"{key:58s} charged {str(run['charged_tokens']):>6} of honest "
            f"{run['honest_tokens']:>5}  "
            f"refused: {run['call_refused_with'] or '-':24s} run: {run['run_status']}"
        )
