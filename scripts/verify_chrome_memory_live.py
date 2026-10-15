"""Memory in the Chrome Agent Browser, live (T19, Demo 6): recompute the checks.

    agentpkg/.venv/bin/python scripts/verify_chrome_memory_live.py \\
        [--report examples/verification/chrome-webair-060-live.json]

`chrome-agent-browser/scripts/e2e-webair-live.mjs` with its `memory` phase (WebAir 0.6.0 and
later) ran a booking that proposed things to remember, accepted them through the review sheet,
exported the memory folder, and authorized again so the accepted record was recalled. This script
reads the harness's report, the exported run directory (run.json, audit.json, the artifacts,
observations.json) and the exported memory folder, and recomputes the portable checks of
`spec/memory-v0.md`:

* the run's hash-chained audit re-verifies with agentpkg; `memory.proposed` precedes
  `workflow.completed`; the memory reads are attributed by record id and digest (M-61);
* privacy (M-36, M-37): no model request body in `observations.json` holds a sealed value of the
  demo set (the passenger e-mail, the payment identifier) nor a record id; no artifact holds one;
* the proposals: `proposals.json` matches the Run Record's `memory.proposals` (count, SHA-256 of
  the canonical document), the review applied as many records as the harness accepted, each with
  `source.kind = package` naming this run (M-42), and the usage log carries `proposed` then
  `accepted` for them (M-29);
* the export (M-55…M-58): `index.md` present, one `.md` file per record, the accepted record's file
  present with the run's provenance in its frontmatter, sealed values omitted (`sealed:omitted`),
  no sealed value in clear anywhere in the folder;
* the recall (M-32, M-34): the second authorization's candidates include the accepted record.

The needle values come from `demo/webair/host-resources.json` (the fictional demo set); only class
names and counts reach the report. The report is rewritten in place with a `memory_verification`
section; `passed_memory` is false if any check fails. A report without a memory phase is refused.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.execution.report import verify_audit_chain

HOST_RESOURCES = ROOT / "demo/webair/host-resources.json"
RECORD_ID = re.compile(r"\bmem_[0-9a-f]{32}\b")
CHECKS: list[dict] = []


def check(identifier: str, passed: bool, detail=None) -> bool:
    CHECKS.append(
        {
            "id": identifier,
            "passed": bool(passed),
            **({"detail": detail} if detail is not None else {}),
        }
    )
    return bool(passed)


def canonical(value) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def sealed_needles() -> dict[str, list[str]]:
    document = json.loads(HOST_RESOURCES.read_text())
    classes: dict[str, list[str]] = {"passenger_email": [], "payment_method_id": []}
    for resource in document["resources"]:
        value = resource["value"]
        if resource["type"] == "personal.passenger_identity":
            classes["passenger_email"].append(value["contact_email"])
        if resource["type"] == "wallet.payment_method":
            classes["payment_method_id"].append(value["payment_method_id"])
    return classes


def hits(classes: dict[str, list[str]], text: str) -> dict[str, int]:
    lowered = text.lower()
    return {
        name: sum(lowered.count(value.lower()) for value in values)
        for name, values in classes.items()
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--report",
        default=str(ROOT / "examples/verification/chrome-webair-060-live.json"),
    )
    args = parser.parse_args()
    report_path = Path(args.report)
    document = json.loads(report_path.read_text())
    harness = document.get("harness") or document
    steps = harness.get("steps") or {}
    entry = (harness.get("runs") or {}).get("memory")
    if not entry:
        print(
            json.dumps(
                {
                    "report": str(report_path),
                    "error": "the report has no memory phase; run the harness with WebAir 0.6.0 or later",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2
    directory = ROOT / entry["directory"]
    run = json.loads((directory / "run.json").read_text())
    audit = json.loads((directory / "audit.json").read_text())
    classes = sealed_needles()

    # 1. The run and its audit.
    chain = verify_audit_chain(audit)
    check(
        "audit_chain_valid",
        chain.get("valid") is True,
        {k: v for k, v in chain.items() if k != "events"},
    )
    actions = [event.get("action") for event in audit]
    check(
        "memory_proposed_precedes_workflow_completed",
        "memory.proposed" in actions
        and "workflow.completed" in actions
        and actions.index("memory.proposed") < actions.index("workflow.completed"),
    )
    reads = [event for event in audit if event.get("action") == "memory.read"]
    check(
        "memory_reads_attributed_by_id_and_digest",
        bool(reads)
        and all(
            RECORD_ID.fullmatch(str(event.get("record_id", "")))
            and len(str(event.get("record_digest", ""))) == 64
            for event in reads
        ),
        len(reads),
    )
    memory = run.get("memory") or {}
    proposals_facts = memory.get("proposals") or {}
    check(
        "run_record_has_proposals",
        proposals_facts.get("count", 0) >= 1
        and proposals_facts.get("offered") == proposals_facts.get("count"),
        proposals_facts,
    )

    # 2. Privacy: model request bodies and artifacts.
    observations = json.loads((directory / "observations.json").read_text()).get(
        "observations", []
    )
    model_bodies = [
        item.get("body", "") for item in observations if item.get("kind") == "model"
    ]
    leaks = [hits(classes, body) for body in model_bodies]
    check(
        "no_sealed_value_in_any_model_request",
        all(all(count == 0 for count in item.values()) for item in leaks),
        {"model_requests": len(model_bodies)},
    )
    check(
        "no_record_id_in_any_model_request",
        all(not RECORD_ID.search(body) for body in model_bodies),
    )
    artifact_text = "\n".join(
        (directory / name).read_text(errors="replace")
        for name in ("run.json", "audit.json")
        if (directory / name).exists()
    )
    check(
        "no_sealed_value_in_run_record_or_audit",
        all(count == 0 for count in hits(classes, artifact_text).values()),
    )

    # 3. The proposals document and the review.
    proposals_path = directory / "proposals.json"
    check("proposals_artifact_present", proposals_path.exists())
    if proposals_path.exists():
        proposals = json.loads(proposals_path.read_text())
        check(
            "proposals_count_matches_record",
            len(proposals.get("proposals", [])) == proposals_facts.get("count"),
        )
        check(
            "proposals_sha256_matches_record",
            hashlib.sha256(canonical(proposals)).hexdigest()
            == proposals_facts.get("proposals_sha256"),
            proposals_facts.get("proposals_sha256"),
        )
        check(
            "no_sealed_value_in_proposals",
            all(
                count == 0
                for count in hits(classes, proposals_path.read_text()).values()
            ),
        )
    review = (steps.get("memoryReview") or {}).get("review") or {}
    decided = review.get("decided") or {}
    accepted = steps.get("memoryRecords") or []
    check(
        "review_applied_once",
        bool(decided)
        and decided.get("accepted") == len(accepted)
        and len(accepted) >= 1,
        decided,
    )
    check(
        "accepted_records_carry_run_provenance",
        all(item.get("id") and RECORD_ID.fullmatch(item["id"]) for item in accepted),
        accepted,
    )

    # 4. The export folder.
    export = steps.get("memoryExport") or {}
    folder = ROOT / export.get("directory", "<none>")
    check(
        "export_folder_present",
        folder.exists() and (folder / "index.md").exists(),
        export.get("directory"),
    )
    if folder.exists():
        files = sorted(path for path in folder.rglob("*.md"))
        text = "\n".join(path.read_text(errors="replace") for path in files)
        check(
            "export_omits_sealed_values",
            "sealed:omitted" in text
            and all(count == 0 for count in hits(classes, text).values()),
            {"files": len(files)},
        )
        accepted_titles = [item.get("title") for item in accepted]
        found = [
            title
            for title in accepted_titles
            if any(
                f"title: {title}" in path.read_text(errors="replace")
                or f'title: "{title}"' in path.read_text(errors="replace")
                for path in files
            )
        ]
        check(
            "accepted_records_exported",
            sorted(found) == sorted(accepted_titles),
            {"accepted": accepted_titles, "found": found},
        )
        provenance = [
            path
            for path in files
            if f"run_id: {run.get('runId', '')}" in path.read_text(errors="replace")
        ]
        check(
            "exported_records_name_the_run_in_their_provenance",
            len(provenance) >= len(accepted),
            len(provenance),
        )
        usage = folder / "memory-usage.json"
        if usage.exists():
            entries = json.loads(usage.read_text())
            ours = [item for item in entries if item.get("run_id") == run.get("runId")]
            check(
                "usage_log_has_proposed_then_accepted",
                any(item.get("use") == "proposed" for item in ours)
                and any(item.get("use") == "accepted" for item in ours),
                len(ours),
            )

    # 5. The recall.
    recall = steps.get("memoryRecall") or []
    accepted_ids = {item.get("id") for item in accepted}
    recalled = [
        candidate
        for card in recall
        for candidate in card.get("candidates", [])
        if candidate.get("id") in accepted_ids
    ]
    check(
        "accepted_record_recalled_next_time",
        len(recalled) >= 1,
        {"cards": len(recall), "recalled": [item.get("title") for item in recalled]},
    )

    document["memory_verification"] = {
        "profile": "chrome-memory-live-demo6-v0",
        "statement": "A WebAir booking in the Chrome Agent Browser proposed things to remember; the person accepted them in the review sheet; the memory folder exported with sealed values omitted; the next authorization recalled the accepted record. No model request carried a sealed value or a record id.",
        "run": {
            "runId": run.get("runId"),
            "directory": entry["directory"],
            "memory": memory,
        },
        "checks": CHECKS,
        "passed": all(item["passed"] for item in CHECKS),
    }
    document["passed_memory"] = document["memory_verification"]["passed"]
    report_path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    print(
        json.dumps(
            {
                "report": str(report_path.relative_to(ROOT))
                if report_path.is_relative_to(ROOT)
                else str(report_path),
                "checks": len(CHECKS),
                "failed": [c["id"] for c in CHECKS if not c["passed"]],
                "passed": document["passed_memory"],
            },
            indent=2,
        )
    )
    return 0 if document["passed_memory"] else 1


if __name__ == "__main__":
    sys.exit(main())
