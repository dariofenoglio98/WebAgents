"""Summarize consecutive live Chrome-CLI runs of one package into a verification record (T10).

    agentpkg/.venv/bin/python scripts/summarize_live_cli_runs.py \\
        --label "…" --out examples/verification/<new>.json RUN_DIR [RUN_DIR …]

Each RUN_DIR is a `node chrome-agent-browser/dist/cli.js run … --mode live --out RUN_DIR` output
directory (git-ignored, under examples/my-*). Everything reported is read from those files: the
run record (`run.json`), `result.json` and its hash-chained audit, re-verified with agentpkg. A run
counts as conforming when no model call in its audit failed (`model.failed`), was refused before
dispatch (`model.refused`) or skipped its retry (`model.retry_skipped`). Refuses to overwrite.
RUN_DIR and --out are read relative to the working directory, like any command-line path.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.execution.report import verify_audit_chain
from agentpkg.package import write_new

FUNNEL = (
    "raw_candidates",
    "screening_jobs",
    "screened_papers",
    "citation_jobs",
    "evidence_items",
    "claims",
)
CALL_FAILURES = ("model.failed", "model.refused", "model.retry_skipped")


def shown(path: Path) -> str:
    """A path as the record names it: relative to the repository when inside it, else absolute."""
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def summarize(directory: Path) -> dict:
    record = json.loads((directory / "run.json").read_text())
    result = json.loads((directory / "result.json").read_text())
    audit = result["audit"]
    state = result.get("state") or {}
    failures = [
        {
            k: event.get(k)
            for k in ("action", "node_id", "task", "reason", "bound", "attempt")
        }
        for event in audit
        if event.get("action") in CALL_FAILURES
    ]
    return {
        "directory": shown(directory),
        "run_id": record["runId"],
        "status": record["status"],
        "error_code": result.get("error_code"),
        "duration_ms": record["durationMs"],
        "package": {
            k: record["package"][k] for k in ("version", "digest", "archiveSha256")
        },
        "model": record["model"],
        "question": None,
        "usage": {
            k: result["usage"][k] for k in ("tokens", "remote_calls", "tool_calls")
        },
        "funnel": {key: len(state.get(key) or []) for key in FUNNEL},
        "model_calls": sum(
            1 for event in audit if event.get("action") == "model.called"
        ),
        "second_attempts": sum(
            1
            for event in audit
            if event.get("action") == "model.called" and event.get("attempt") == 2
        ),
        "call_failures": failures,
        "conforming": not failures,
        "audit_chain_valid": verify_audit_chain(audit)["valid"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("directories", nargs="+")
    args = parser.parse_args()
    runs = []
    for name in args.directories:
        directory = Path(name).resolve()
        summary = summarize(directory)
        question = directory.parent / f"{directory.name}.input.json"
        if question.exists():
            summary["question"] = json.loads(question.read_text()).get("question")
        runs.append(summary)
    document = {
        "profile": "chrome-cli-live-runs-v0",
        "label": args.label,
        "runs": runs,
        "consecutive_runs": len(runs),
        "conforming_runs": sum(1 for run in runs if run["conforming"]),
        "completed_runs": sum(1 for run in runs if run["status"] == "completed"),
        "grounded_runs": sum(1 for run in runs if run["funnel"]["evidence_items"] > 0),
        "passed": all(run["conforming"] and run["audit_chain_valid"] for run in runs),
    }
    encoded = (json.dumps(document, indent=2) + "\n").encode()
    write_new(args.out, encoded)
    print(json.dumps({k: v for k, v in document.items() if k != "runs"}, indent=2))
    return 0 if document["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
