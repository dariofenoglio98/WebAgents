"""Literature Review 0.2.7 live campaign (T15): recompute a verification record from run directories.

    agentpkg/.venv/bin/python scripts/summarize_literature_027_campaign.py \\
        --label "…" --out examples/verification/chrome-literature-review-027-<name>.json \\
        [--inputs DIR] RUN_DIR [RUN_DIR …]

Each RUN_DIR is a `node chrome-agent-browser/dist/cli.js run … --mode live --out RUN_DIR` output
directory, or an extension-harness export (git-ignored, under examples/my-*). Everything reported
is read from those files and re-verified with agentpkg: the run record, the hash-chained audit,
the package archive it ran (it must be the signed `dist/literature-review-0.2.7.agent.pkg`), the
workflow state and the exports. Nothing is typed in by hand.

Per run: the outcome (and, for a failed run, the node and the named check), the funnel (search
records → found → included → cited → evidence → claims), `papers-found.json`, the model's re-asks
(`model.called` attempts 2 and 3, with what they followed), skipped re-asks, tool retries and the
citation fallback, and the grounding checks: every evidence quote occurs verbatim in a genuine
source text (the resolver's or the search's abstract for that paper, or a picked document's pages);
the evidence table equals the extracted items; every bibliography entry is the resolver's exact
record; claims cite existing evidence and resolved papers; every cited paper is a found paper (no
invented paper); papers-found lists every found paper once with a verdict.

`passed` (T15 acceptance): every hosted run (`openai/*`) completed; every completed run exports a
papers-found list naming every found paper (non-empty when the search returned records) and passes
the grounding checks; every run's audit chain is valid; a failed run names its failed node. Local
runs may fail; their completion rate and failure points are reported. Refuses to overwrite --out.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.execution.report import verify_audit_chain
from agentpkg.package import load_package, write_new
from agentpkg.signing import verify_package

ARCHIVE = ROOT / "dist/literature-review-0.2.7.agent.pkg"
KEY = ROOT / "examples/keys/literature-review-publisher.pub.pem"


def shown(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def load(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def contains(text, quote) -> bool:
    return (
        isinstance(text, str)
        and isinstance(quote, str)
        and quote.strip() != ""
        and quote in text
    )


def grounding(output: dict, state: dict, documents: dict[str, list[str]]) -> dict:
    # After selection the review names a paper by its handle (P1-P3); its job holds the paper.
    jobs = {
        j.get("handle") or (j.get("paper") or {}).get("paper_id"): j
        for j in state.get("resolved_jobs") or []
    }
    found = {p["paper_id"]: p for p in state.get("found_papers") or []}

    def doi_of(handle):
        return ((jobs.get(handle) or {}).get("paper") or {}).get("paper_id")

    def sources(paper_id):
        texts = []
        best = ((jobs.get(paper_id) or {}).get("response") or {}).get(
            "best_match"
        ) or {}
        if best.get("abstract"):
            texts.append(best["abstract"])
        paper = found.get(doi_of(paper_id)) or {}
        if paper.get("abstract"):
            texts.append(paper["abstract"])
        doi = (paper.get("doi") or "").lower()
        texts.extend(documents.get(doi, []))
        return texts

    evidence = state.get("evidence_items") or []
    by_id = {item["evidence_id"]: item for item in evidence}
    quotes_ok = [
        any(contains(text, item.get("quote")) for text in sources(item.get("paper_id")))
        for item in evidence
    ]
    bibliography = output.get("bibliography") or []
    claims = output.get("claims") or []
    listed = output.get("papers_found") or []
    resolved = {
        pid
        for pid, job in jobs.items()
        if ((job.get("response") or {}).get("status")) == "resolved"
    }
    return {
        "evidence_items": len(evidence),
        "quotes_verbatim_in_sources": sum(quotes_ok),
        "evidence_table_is_the_items": all(
            row == by_id.get(row.get("evidence_id"))
            for row in output.get("evidence_table") or []
        ),
        "bibliography_is_the_resolver_record": all(
            entry.get("paper_id") in resolved
            and entry.get("metadata")
            == ((jobs[entry["paper_id"]].get("response") or {}).get("best_match"))
            for entry in bibliography
        ),
        "claims_cite_existing_evidence_and_resolved_papers": all(
            all(eid in by_id for eid in claim.get("evidence_ids") or [])
            and all(pid in resolved for pid in claim.get("paper_ids") or [])
            for claim in claims
        ),
        "no_invented_paper": all(
            doi_of(entry.get("paper_id")) in found for entry in bibliography
        )
        and all(pid in found for pid in state.get("citation_jobs") or []),
        "papers_found_lists_every_found_paper_once": sorted(
            r.get("paper_id") for r in listed
        )
        == sorted(found)
        and all(
            r.get("screening_status") in ("include", "maybe", "exclude") for r in listed
        ),
    }


def summarize(directory: Path, inputs: dict[str, str], archive_sha256: str) -> dict:
    record = load(directory / "run.json") or {}
    result = load(directory / "result.json") or {}
    audit = load(directory / "audit.json") or result.get("audit") or []
    state = result.get("state") or {}
    output = result.get("output") or {}
    documents_file = load(directory / "documents.json") or {"documents": []}
    documents = {
        item["doi"].lower(): [
            page["text"] for page in item["extraction"].get("pages", [])
        ]
        for item in documents_file.get("documents", [])
    }

    def events(action):
        return [e for e in audit if e.get("action") == action]

    failed = next(
        (
            {
                "node_id": e.get("node_id"),
                "error_code": e.get("error_code"),
                "failed_check": e.get("failed_check"),
            }
            for e in reversed(audit)
            if e.get("action") == "node.failed"
        ),
        None,
    )
    question = state.get("research_question") or inputs.get(
        record.get("inputSha256") or ""
    )
    completed = record.get("status") == "completed"
    searched = sum(
        len(b.get("papers") or []) for b in state.get("search_batches") or []
    )
    summary = {
        "directory": shown(directory),
        "run_id": record.get("runId"),
        "question": question,
        "model": (record.get("model") or {}).get("planned"),
        "models_invoked": (record.get("model") or {}).get("invoked"),
        "status": record.get("status"),
        "error_code": record.get("errorCode"),
        "failed": None if completed else failed,
        "duration_ms": record.get("durationMs"),
        "package": record.get("package"),
        "ran_the_signed_0_2_7": (record.get("package") or {}).get("archiveSha256")
        == archive_sha256,
        "usage": {
            k: (record.get("usage") or {}).get(k)
            for k in ("tokens", "remoteCalls", "toolCalls")
        },
        "funnel": {
            "search_records": searched,
            "found": len(state.get("found_papers") or []),
            "included": len(state.get("included_papers") or []),
            "cited": len(output.get("bibliography") or []),
            "evidence_items": len(state.get("evidence_items") or []),
            "claims": len(output.get("claims") or []),
        },
        "papers_found": None
        if not completed
        else {
            "listed": len(output.get("papers_found") or []),
            "verdicts": {
                s: sum(
                    1
                    for r in output.get("papers_found") or []
                    if r.get("screening_status") == s
                )
                for s in ("include", "maybe", "exclude")
            },
        },
        "normalize_asked": any(
            e.get("task") == "normalize" for e in events("model.called")
        ),
        "model_calls": len(events("model.called")),
        "reasks": [
            {
                "node_id": e.get("node_id"),
                "attempt": e.get("attempt"),
                "after": e.get("after"),
            }
            for e in events("model.called")
            if (e.get("attempt") or 1) > 1
        ],
        "reasks_skipped": [
            {
                "node_id": e.get("node_id"),
                "reason": e.get("reason"),
                "bound": e.get("bound"),
            }
            for e in events("model.retry_skipped")
        ],
        "tool_retries": [
            {
                "tool": e.get("tool"),
                "reason": e.get("reason"),
                "http_status": e.get("http_status"),
            }
            for e in events("tool.retried")
        ],
        "fallbacks": [
            {
                "tool": e.get("tool"),
                "reason": e.get("reason"),
                "http_status": e.get("http_status"),
            }
            for e in events("tool.fallback")
        ],
        "honest_empty": completed and not output.get("claims"),
        "audit_chain_valid": verify_audit_chain(audit)["valid"] if audit else False,
    }
    summary["grounding"] = grounding(output, state, documents) if completed else None
    g = summary["grounding"]
    summary["accepted"] = (
        summary["audit_chain_valid"]
        and summary["ran_the_signed_0_2_7"]
        and (
            (
                completed
                and g["quotes_verbatim_in_sources"] == g["evidence_items"]
                and all(v for k, v in g.items() if isinstance(v, bool))
                and (searched == 0 or summary["papers_found"]["listed"] > 0)
            )
            or (
                not completed
                and failed is not None
                and failed.get("node_id") is not None
            )
        )
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--inputs", default=str(ROOT / "examples/my-t15"))
    parser.add_argument("directories", nargs="+")
    args = parser.parse_args()
    verified = verify_package(ARCHIVE, KEY)
    archive_sha256 = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    package = load_package(ARCHIVE)
    inputs = {}
    for path in sorted(Path(args.inputs).glob("q-*.json")):
        inputs[hashlib.sha256(path.read_bytes()).hexdigest()] = json.loads(
            path.read_text()
        )["question"]
    runs = [
        summarize(Path(name).resolve(), inputs, archive_sha256)
        for name in args.directories
    ]
    by_model: dict[str, dict] = {}
    for run in runs:
        row = by_model.setdefault(
            run["model"] or "?",
            {
                "runs": 0,
                "completed": 0,
                "grounded": 0,
                "honest_empty": 0,
                "failed_at": [],
                "reasks": 0,
                "tool_retries": 0,
                "fallbacks": 0,
            },
        )
        row["runs"] += 1
        row["completed"] += run["status"] == "completed"
        row["grounded"] += run["status"] == "completed" and run["funnel"]["claims"] > 0
        row["honest_empty"] += bool(run["honest_empty"])
        row["reasks"] += len(run["reasks"])
        row["tool_retries"] += len(run["tool_retries"])
        row["fallbacks"] += len(run["fallbacks"])
        if run["status"] != "completed":
            row["failed_at"].append(run["failed"])
    hosted = [run for run in runs if (run["model"] or "").startswith("openai/")]
    document = {
        "profile": "literature-review-027-live-campaign-v0",
        "label": args.label,
        "package": {
            "path": shown(ARCHIVE),
            "version": package.manifest["version"],
            "digest": package.digest,
            "archive_sha256": archive_sha256,
            "signer": verified["key_fingerprint"],
        },
        "script": "scripts/summarize_literature_027_campaign.py",
        "by_model": by_model,
        "runs": runs,
        "hosted_all_completed": all(run["status"] == "completed" for run in hosted),
        "passed": all(run["accepted"] for run in runs)
        and all(run["status"] == "completed" for run in hosted),
    }
    write_new(
        args.out, (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode()
    )
    print(json.dumps({k: v for k, v in document.items() if k != "runs"}, indent=2))
    return 0 if document["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
