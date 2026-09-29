"""Opt-in exact-schema probe through the real plugin/host; reports no model text.

Run with agentpkg/.venv/bin/python scripts/probe_literature_024.py --model PROVIDER/MODEL
--report /absolute/new-report.json. Temporary answers are private and removed.
"""

import argparse
import asyncio
import json
import subprocess
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg/tests"))
from agentpkg.hostbridge.errors import BridgeError
from agentpkg.hostbridge.router import HostBridgeModelRouter, render
from agentpkg.package import load_package, write_new
from agentpkg.workflow import Workflow
from test_live_structured_output import Replay, binding


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument(
        "--cases", default="trivial,screen,normalize,extract,synthesize,write,verify"
    )
    args = parser.parse_args()
    package = load_package(ROOT / "dist/literature-review-0.2.4.agent.pkg")
    fixture = package.json(package.graph["fixture"])
    roles = {w["id"]: w for w in package.graph["workers"]}
    skills = {s["id"]: s["path"] for s in package.manifest["skills"]}
    requests = {
        "trivial": (
            {
                "task": "trivial",
                "instructions": ['Return exactly {"ok":true}.'],
                "data": {},
                "output_schema": {
                    "type": "object",
                    "properties": {"ok": {"const": True}},
                    "required": ["ok"],
                    "additionalProperties": False,
                },
            },
            1024,
        )
    }
    for node in package.graph["nodes"]:
        for operation in [node, *node.get("steps", [])]:
            task = operation.get("task")
            if not task:
                continue
            requests[task] = (
                {
                    "task": task,
                    "instructions": [
                        package.files[skills[s]].decode()
                        for s in roles[node["worker"]]["skills"]
                    ],
                    "data": fixture["models"][task][0]["input"],
                    "output_schema": Workflow._model_schema(
                        types.SimpleNamespace(package=package),
                        operation["output_schema"],
                    ),
                },
                operation["max_output_tokens"],
            )
    report = {"model": args.model, "package_digest": package.digest, "cases": []}
    with tempfile.TemporaryDirectory(prefix="webagents-schema-probe-") as tmp:
        base = Path(tmp)
        for case in args.cases.split(","):
            request, cap = requests[case]
            rendered = render(request)
            request_path = base / "request.json"
            request_path.write_text(
                json.dumps(
                    {
                        case: {
                            "system": rendered["system"],
                            "user": rendered["user"],
                            "output_schema": rendered["output_schema"],
                            "max_output_tokens": cap,
                            "reasoning": "low",
                        }
                    }
                )
            )
            answers, facts = (
                base / (case + ".jsonl"),
                base / (case + "-transport.jsonl"),
            )
            completed = subprocess.run(
                [
                    "node",
                    str(
                        ROOT
                        / "openclaw-agent-browser/scripts/structured-output-probe.mjs"
                    ),
                    "--requests",
                    str(request_path),
                    "--case",
                    case,
                    "--model",
                    args.model,
                    "--out",
                    str(answers),
                    "--transport-facts",
                    str(facts),
                ],
                capture_output=True,
                check=False,
                timeout=700,
            )
            # Host logs stay private in memory, not in the report or console.
            outcome = (
                json.loads(answers.read_text().splitlines()[0])
                if answers.exists()
                else {"error": {"code": "probe_process_failed"}}
            )
            row = {
                "case": case,
                "schema_requested": True,
                "cap_requested": cap,
                "transport": [json.loads(x) for x in facts.read_text().splitlines()]
                if facts.exists()
                else [],
                "process_ok": completed.returncode == 0,
            }
            if "error" in outcome:
                row.update(conforming=False, error_code=outcome["error"]["code"])
            else:
                row.update(
                    actual_model=outcome["model_id"],
                    provider=outcome["provider_id"],
                    stop_reason=outcome["stop_reason"],
                    usage=outcome["usage"],
                )
                router = HostBridgeModelRouter(Replay([outcome]), binding(args.model))
                try:
                    asyncio.run(router.complete(request, max_output_tokens=cap))
                    row["conforming"] = True
                except BridgeError as error:
                    row.update(
                        conforming=False,
                        error_code=error.code,
                        failure_facts=error.audit_facts,
                    )
            report["cases"].append(row)
            print(json.dumps(row), flush=True)
    report["passed"] = all(r["conforming"] for r in report["cases"])
    write_new(args.report, (json.dumps(report, indent=2) + "\n").encode())
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
