"""Literature Review live acceptance in the Chrome Agent Browser (T6, Demo 4): recompute the checks.

    agentpkg/.venv/bin/python scripts/verify_chrome_literature_live.py \\
        [--report examples/verification/chrome-literature-review-live.json]

`chrome-agent-browser/scripts/e2e-literature-live.mjs` ran the signed Literature Review (0.2.5 for T6, 0.2.6 since T10, 0.2.7 since T15) in a
real Chrome with the person's model against the real Crossref API and the hosted Citation Resolver,
and exported the run (run.json, run-plan.json, input.json, the artifacts), observations.json (every
outbound model and tool request body, test mode) and documents.json (each picked PDF's text from
the Chrome parser, `dist/cli.js pdf-text`). This script reads those files and recomputes:

* the run's own record and hash-chained audit (re-verified with agentpkg), the artifact hashes, the
  plan and the input it was bound to, the planned model on every call, every call observed;
* the host's bindings: Crossref through the Crossref adapter with exactly the reference's request
  shape (four host-named parameters, the fixed field selection and filter read from the
  reference's own answers, `mailto` only when the harness set a contact), never more than one
  Crossref request at a time and none within a second of the previous one's start, the resolver at
  the origin the package declares, picked files read only by opaque id;
* the long-run limits the run was held to and the usage within them;
* the grounding checks of the reference driver (`openclaw-agent-browser/scripts/run-literature-
  review.mjs::groundingChecks`), ported: every evidence quote occurs in a genuine source (the
  resolver's or Crossref's abstract for that paper, or the picked document's text), the evidence
  table equals the extracted items, every bibliography entry is the resolver's exact record, claims
  cite existing evidence and resolved papers, the related-work text names only bibliography
  papers. A run that found nothing grounded ("No sufficiently grounded literature found") is the
  honest-empty outcome: completed, with the checks recorded and vacuously true.

The report is rewritten in place with `checks`, `grounding`, `search` and `verification`;
`passed` is false if any check fails. When the run directory is missing (a clean checkout) and
the report is a committed one (under `examples/verification/`), the script refuses and writes
nothing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = ROOT / "examples/verification/chrome-literature-review-live.json"
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.execution.report import verify_audit_chain  # noqa: E402
from agentpkg.package import load_package  # noqa: E402
from agentpkg.signing import verify_package  # noqa: E402

# The signed archive the harness served, named in its report (0.2.5 for T6's, 0.2.6 since T10,
# 0.2.7 since T15);
# only a versioned Literature Review in dist/ is accepted.
ARCHIVE_NAME = re.compile(r"^dist/literature-review-0\.2\.[5-9]\.agent\.pkg$")
KEY = ROOT / "examples/keys/literature-review-publisher.pub.pem"
CROSSREF_REFERENCE = ROOT / "chrome-agent-browser/test/fixtures/crossref/reference-answers.json"
CROSSREF = "https://api.crossref.org"
RESOLVER = "https://webagents-citation-resolver-production.up.railway.app"
BINDINGS = {
    "scholarly-search": "chrome:crossref_works_search:scholarly-search:1",
    "citation-resolver": "chrome:json_http:citation-resolver:1",
    "paper-reader": "chrome:selected_pdf_text:paper-reader:1",
}
LONG_RUN_LIMITS = {
    "totalTokens": 180_000,
    "maxRemoteCalls": 45,
    "maxParallelWorkers": 3,
    "maxOutputTokensPerCall": 16_000,
    "runTimeoutSeconds": 4_500,
    "modelCallTimeoutSeconds": 1_200,
}
HONEST_EMPTY = "No sufficiently grounded literature found"
FILE_ID = re.compile(r"^file_[0-9a-f]{32}$")

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


def canonical(value) -> str:
    """The reference driver's `canonical`: sorted keys, JSON scalars."""
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(f"{json.dumps(key)}:{canonical(value[key])}" for key in sorted(value))
            + "}"
        )
    return json.dumps(value, ensure_ascii=False)


def contains(text, quote) -> bool:
    return (
        isinstance(text, str) and isinstance(quote, str) and quote.strip() != "" and quote in text
    )


def grounding(output: dict, state: dict, documents: dict[str, list[str]]) -> dict:
    """The reference driver's `groundingChecks`; a picked document's pages are one more source."""
    resolved_jobs = state.get("resolved_jobs") or []
    search_papers = [
        paper
        for batch in (state.get("search_batches") or [])
        for paper in (batch.get("papers") or [])
    ]
    by_paper = {(job.get("paper") or {}).get("paper_id"): job for job in resolved_jobs}

    def genuine_texts(paper_id):
        job = by_paper.get(paper_id) or {}
        texts = []
        best = (job.get("response") or {}).get("best_match") or {}
        if best.get("abstract"):
            texts.append(best["abstract"])
        doi = (job.get("paper") or {}).get("doi")
        for paper in search_papers:
            if doi and paper.get("doi") == doi and paper.get("abstract"):
                texts.append(paper["abstract"])
        if doi:
            pages = documents.get(doi.lower(), [])
            texts.extend(pages)
            if pages:
                texts.append("\n".join(pages))
        return texts

    evidence = state.get("evidence_items") or []
    evidence_by_id = {item.get("evidence_id"): item for item in evidence}
    quote_results = [
        {
            "evidence_id": item.get("evidence_id"),
            "paper_id": item.get("paper_id"),
            "scope": item.get("scope"),
            "quote_in_genuine_source": any(
                contains(text, item.get("quote")) for text in genuine_texts(item.get("paper_id"))
            ),
            "synthetic": (item.get("provenance") or {}).get("synthetic") is True,
        }
        for item in evidence
    ]
    bibliography = []
    for entry in output.get("bibliography") or []:
        job = by_paper.get(entry.get("paper_id")) or {}
        response = job.get("response") or {}
        bibliography.append(
            {
                "paper_id": entry.get("paper_id"),
                "resolved": response.get("status") == "resolved",
                "metadata_equals_resolver_record": canonical(entry.get("metadata"))
                == canonical(response.get("best_match")),
                "title": (entry.get("metadata") or {}).get("title"),
                "doi": (entry.get("metadata") or {}).get("doi"),
            }
        )
    claims = output.get("claims") or []
    results = output.get("verification_results") or []
    claim_ids = {claim.get("claim_id") for claim in claims}
    text = output.get("related_work") or ""
    # 0.2.6 and earlier named papers `paper-<hash>`; since 0.2.7 a paper's id is its DOI (or
    # arXiv id, URL, title), so any found paper's id that the text names counts as a mention.
    found_ids = {paper.get("paper_id") for paper in state.get("found_papers") or []}
    mentioned = sorted(
        set(re.findall(r"paper-[0-9a-f]{8,}", text))
        | {pid for pid in found_ids if isinstance(pid, str) and len(pid) > 6 and pid in text}
    )
    bib_ids = {entry["paper_id"] for entry in bibliography}
    table = output.get("evidence_table") or []
    return {
        "evidence_items": len(evidence),
        "evidence_quotes_in_genuine_sources": sum(
            1 for item in quote_results if item["quote_in_genuine_source"]
        ),
        "evidence_quote_results": quote_results,
        "evidence_table_rows": len(table),
        "evidence_table_rows_match_items": all(
            canonical(row) == canonical(evidence_by_id.get(row.get("evidence_id"))) for row in table
        ),
        "bibliography": bibliography,
        "bibliography_all_resolved_and_exact": all(
            entry["resolved"] and entry["metadata_equals_resolver_record"] for entry in bibliography
        ),
        "claims": len(claims),
        "claims_reference_existing_evidence": all(
            all(eid in evidence_by_id for eid in claim.get("evidence_ids") or [])
            for claim in claims
        ),
        "claims_cite_evidence_and_papers": all(
            claim.get("evidence_ids") and claim.get("paper_ids") for claim in claims
        ),
        "claims_reference_resolved_papers": all(
            all(
                ((by_paper.get(pid) or {}).get("response") or {}).get("status") == "resolved"
                for pid in claim.get("paper_ids") or []
            )
            for claim in claims
        ),
        "verification_results": len(results),
        "verification_results_match_claims": all(
            result.get("claim_id") in claim_ids for result in results
        ),
        "unsupported_or_overstated": sum(
            1 for result in results if result.get("status") != "supported"
        ),
        "related_work_chars": len(text),
        "related_work_paper_ids_mentioned": mentioned,
        "related_work_mentions_only_bibliography": all(pid in bib_ids for pid in mentioned),
        "unresolved": len(output.get("unresolved") or []),
        "honest_empty": HONEST_EMPTY in text and not claims,
    }


def search_summary(state: dict) -> dict:
    return {
        "queries": state.get("search_queries") or [],
        "batches": [
            {
                "query": batch.get("query"),
                "source": batch.get("source"),
                "papers": len(batch.get("papers") or []),
                "with_abstract": sum(
                    1 for paper in batch.get("papers") or [] if paper.get("abstract")
                ),
            }
            for batch in state.get("search_batches") or []
        ],
        "candidate_papers": len(state.get("candidate_papers") or []),
        "found_papers": len(state.get("found_papers") or []),
        "screened_or_listed": len(state.get("papers_found") or []),
        "screened": [
            {
                "paper_id": paper.get("paper_id"),
                "status": paper.get("screening_status"),
                "doi": paper.get("doi"),
            }
            for paper in state.get("screened_papers") or []
        ],
        "resolver_statuses": [
            {
                "paper_id": (job.get("paper") or {}).get("paper_id"),
                "status": (job.get("response") or {}).get("status"),
            }
            for job in state.get("resolved_jobs") or []
        ],
    }


def when(stamp: str) -> float:
    return dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    options = parser.parse_args()
    report_path = Path(options.report).resolve()
    report = json.loads(report_path.read_text())
    directory = ROOT / report["outputDirectory"]
    required = ["run.json", "run-plan.json", "input.json", "audit.json", "observations.json"]
    if not all((directory / name).exists() for name in required):
        # A committed report (under examples/verification/) is never rewritten from a checkout
        # that does not hold its run directory.
        if report_path.parent == DEFAULT_REPORT.parent.resolve():
            print(
                f"verify_chrome_literature_live: the run directory {report['outputDirectory']} "
                "is missing; the committed report is left as it is",
                file=sys.stderr,
            )
            return 2
        check(
            "run_recorded",
            False,
            {
                "directory": report["outputDirectory"],
                "missing": [name for name in required if not (directory / name).exists()],
            },
        )
        return finish(report, report_path, {}, {}, {})

    record = json.loads((directory / "run.json").read_text())
    plan = json.loads((directory / "run-plan.json").read_text())
    task = json.loads((directory / "input.json").read_text())
    audit = json.loads((directory / "audit.json").read_text())
    observations = json.loads((directory / "observations.json").read_text()).get("observations", [])
    result = (
        json.loads((directory / "result.json").read_text())
        if (directory / "result.json").exists()
        else {}
    )
    documents_file = (
        json.loads((directory / "documents.json").read_text())
        if (directory / "documents.json").exists()
        else {"documents": []}
    )

    # The package the run was bound to: the signed archive in dist/, verified with its key.
    named = report["package"]["path"]
    if not ARCHIVE_NAME.match(named):
        raise SystemExit(f"verify_chrome_literature_live: unexpected package path {named!r}")
    ARCHIVE = ROOT / named
    package = load_package(ARCHIVE)
    verified = verify_package(ARCHIVE, KEY)
    archive_sha256 = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    check(
        "package_verifies_with_the_publisher_key",
        verified is not None and record["package"]["digest"] == package.digest,
        {"digest": package.digest},
    )
    check(
        "run_bound_to_the_shipped_archive",
        record["package"]["archiveSha256"] == archive_sha256 == report["package"]["archiveSha256"],
        {"record": record["package"]["archiveSha256"], "dist": archive_sha256},
    )
    check(
        "plan_names_the_package",
        plan["package"]["digest"] == package.digest
        and plan["run_plan_id"] == record["runPlanId"]
        and plan["run_plan_sha256"] == record["runPlanSha256"],
    )

    # The record, its audit chain and its files.
    chain = verify_audit_chain(audit)
    check("audit_chain_valid", chain.get("valid") is True, chain)
    check(
        "record_matches_audit",
        (record.get("audit") or {}).get("events") == len(audit)
        and (record.get("audit") or {}).get("chainValid") is True,
        record.get("audit"),
    )
    mismatched = []
    for artifact in record.get("artifacts") or []:
        path = directory / artifact["name"]
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != artifact["sha256"]:
            mismatched.append(artifact["name"])
    check(
        "every_artifact_matches_the_record",
        not mismatched and bool(record.get("artifacts")),
        mismatched or None,
    )
    check(
        "input_is_the_harness_input",
        canonical(task)
        == canonical(
            json.loads((ROOT / report["input"]).read_text())
            # The harness adds the picked files' ids under `documents`, and only then.
            | ({"documents": task["documents"]} if "documents" in task else {})
        ),
    )
    check(
        "run_completed",
        record["status"] == "completed",
        {
            "status": record["status"],
            "errorCode": record.get("errorCode"),
            "failure": record.get("failure"),
        },
    )

    # The model.
    model = record.get("model") or {}
    models = [line for line in observations if line["kind"] == "model"]
    called = [event for event in audit if event.get("action") == "model.called"]
    check(
        "used_the_selected_model_only",
        model.get("planned") == report["model"] and model.get("allCallsUsedPlannedModel") is True,
        model,
    )
    check(
        "every_model_call_observed",
        len(models) == model.get("calls", -1) == len(called),
        {"observed": len(models), "recorded": model.get("calls"), "called": len(called)},
    )

    # How each model request was shaped, read from the bodies test mode recorded (T10, D-121…D-123):
    # the reasoning effort sent, and the text format (strict, non-strict, wrapped array root, none).
    report["modelRequests"] = request_shapes(models)

    # The tools: bindings, Crossref's request shape and pacing, the resolver's origin, the reader.
    dispatched = [event for event in audit if event.get("action") == "tool.dispatched"]
    wrong = [
        (event.get("tool"), event.get("binding_id"))
        for event in dispatched
        if BINDINGS.get(event.get("tool")) != event.get("binding_id")
    ]
    check("every_tool_call_went_to_the_planned_binding", not wrong, wrong or None)
    planned = {binding["tool_id"]: binding["binding_id"] for binding in plan["tool_bindings"]}
    check("the_plan_binds_the_host_implementations", planned == BINDINGS, planned)
    tools = [line for line in observations if line["kind"] == "tool"]
    remote = [event for event in dispatched if event.get("remote")]
    # A dispatched call is recorded before it waits for its pacing slot, so a call cancelled while
    # waiting is dispatched and never sent: every answered call was observed, and none twice.
    answered = [
        event for event in audit if event.get("action") == "tool.settled" and event.get("remote")
    ]
    check(
        "every_remote_tool_call_observed",
        len(answered) <= len(tools) <= len(remote),
        {"observed": len(tools), "answered": len(answered), "dispatched": len(remote)},
    )
    reference = json.loads(CROSSREF_REFERENCE.read_text())
    # Crossref's search (`/works`) and, since T13, the citation fallback's DOI lookup
    # (`/works/{doi}`, D-153) share one origin and one pacing lane.
    everything_crossref = [line for line in tools if line["url"].startswith(f"{CROSSREF}/")]
    crossref = [
        line for line in everything_crossref if urllib.parse.urlsplit(line["url"]).path == "/works"
    ]
    lookups = [line for line in everything_crossref if line not in crossref]
    contact_set = report.get("crossrefContact") is not None
    shapes = []
    for line in crossref:
        parts = urllib.parse.urlsplit(line["url"])
        params = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        names = [name for name, _ in params]
        expected = ["query.bibliographic", "rows", "select", "filter"] + (
            ["mailto"] if contact_set else []
        )
        values = dict(params)
        shapes.append(
            parts.path == "/works"
            and names == expected
            and values.get("select") == reference["select"]
            and values.get("filter") == reference["filter"]
            and line["body"] == ""
        )
    check(
        "crossref_requests_have_the_reference_shape",
        all(shapes) and bool(crossref),
        {"requests": len(crossref), "ok": sum(shapes)},
    )
    searches = [
        event
        for event in audit
        if event.get("action") == "tool.called" and event.get("tool") == "scholarly-search"
    ]
    searched = [
        event
        for event in audit
        if event.get("action") == "tool.settled" and event.get("tool") == "scholarly-search"
    ]
    # One request per search call, plus the host's retries of a transient failure (D-152).
    retried = [
        event
        for event in audit
        if event.get("action") == "tool.retried" and event.get("tool") == "scholarly-search"
    ]
    check(
        "one_crossref_request_per_search_call_and_retry",
        len(searched) <= len(crossref) <= len(searches) + len(retried),
        {
            "requests": len(crossref),
            "answered": len(searched),
            "calls": len(searches),
            "retries": len(retried),
        },
    )
    starts = sorted(when(line["at"]) for line in everything_crossref)
    gaps = [round(later - earlier, 3) for earlier, later in zip(starts, starts[1:])]
    check("crossref_paced_one_per_second", all(gap >= 0.999 for gap in gaps), {"gaps_s": gaps})
    statuses = [
        event.get("transport_status")
        for event in audit
        if event.get("action") == "tool.settled" and event.get("tool") == "scholarly-search"
    ]
    failures = [
        event.get("failure_facts")
        for event in audit
        if event.get("action") == "tool.failed" and event.get("tool") == "scholarly-search"
    ]
    check(
        "crossref_answered_every_search",
        all(status == 200 for status in statuses) and not failures,
        {"statuses": statuses, "failures": failures},
    )
    resolver = [line for line in tools if line["url"].startswith(f"{RESOLVER}/")]
    check(
        "resolver_calls_went_to_the_declared_origin",
        all(urllib.parse.urlsplit(line["url"]).path == "/resolve" for line in resolver)
        and len(resolver) + len(everything_crossref) == len(tools),
        {
            "resolver": len(resolver),
            "crossref_search": len(crossref),
            "crossref_doi_lookup": len(lookups),
            "tools": len(tools),
        },
    )
    fallbacks = [event for event in audit if event.get("action") == "tool.fallback"]
    check(
        "a_doi_lookup_only_as_the_declared_fallback",
        len(lookups) <= len(fallbacks)
        + sum(1 for event in audit if event.get("action") == "tool.retried")
        and all(event.get("tool") == "citation-resolver" for event in fallbacks),
        {"lookups": len(lookups), "fallbacks": len(fallbacks)},
    )

    # Picked documents: read by opaque id only, the attachments are the harness's picks.
    attachments = (record.get("task") or {}).get("attachments") or []
    picked = documents_file.get("documents", [])
    check(
        "attachments_are_the_picked_documents",
        sorted((item["fileId"], item["sha256"]) for item in attachments)
        == sorted((item["file_id"], item["sha256"]) for item in picked),
        {
            "attachments": attachments,
            "picked": [(item["file_id"], item["sha256"]) for item in picked],
        },
    )
    check(
        "the_parser_text_describes_the_picked_bytes",
        all(item["extraction"].get("sha256") == item["sha256"] for item in picked),
    )
    reads = [
        event
        for event in audit
        if event.get("action") == "tool.settled" and event.get("tool") == "paper-reader"
    ]
    check(
        "documents_read_by_opaque_id_and_hash_only",
        all(
            FILE_ID.match(event.get("file_id", ""))
            and any(
                event.get("file_sha256") == item["sha256"]
                and event.get("file_id") == item["file_id"]
                for item in picked
            )
            for event in reads
        ),
        [(event.get("file_id"), event.get("file_sha256")) for event in reads],
    )
    names = [entry["file"] for entry in report.get("documents") or []]
    everything = "\n".join(
        path.read_text(errors="replace")
        for path in sorted(directory.iterdir())
        if path.is_file() and path.name != "documents.json"
    )
    check(
        "no_document_name_in_any_run_file",
        not any(name in everything for name in names),
        names or None,
    )

    # Limits.
    host = ((record.get("limits") or {}).get("host")) or {}
    check(
        "held_to_the_long_run_limits",
        all(host.get(key) == value for key, value in LONG_RUN_LIMITS.items()),
        host,
    )
    usage = record.get("usage") or {}
    check(
        "usage_within_the_limits",
        usage.get("tokens", 10**9) <= LONG_RUN_LIMITS["totalTokens"]
        and usage.get("remoteCalls", 10**9) <= LONG_RUN_LIMITS["maxRemoteCalls"],
        usage,
    )

    # Grounding (the reference driver's checks, ported).
    documents = {
        item["doi"].lower(): [page["text"] for page in item["extraction"].get("pages", [])]
        for item in picked
    }
    facts = grounding(result.get("output") or {}, result.get("state") or {}, documents)
    search = search_summary(result.get("state") or {})
    check(
        "evidence_quotes_occur_in_genuine_sources",
        facts["evidence_quotes_in_genuine_sources"] == facts["evidence_items"],
        {
            "items": facts["evidence_items"],
            "in_sources": facts["evidence_quotes_in_genuine_sources"],
        },
    )
    for name in (
        "evidence_table_rows_match_items",
        "bibliography_all_resolved_and_exact",
        "claims_reference_existing_evidence",
        "claims_cite_evidence_and_papers",
        "claims_reference_resolved_papers",
        "verification_results_match_claims",
        "related_work_mentions_only_bibliography",
    ):
        check(name, facts[name] is True)
    if tuple(int(x) for x in package.manifest["version"].split(".")) >= (0, 2, 7):
        state = result.get("state") or {}
        found = [paper.get("paper_id") for paper in state.get("found_papers") or []]
        listed_path = directory / "papers-found.json"
        listed = json.loads(listed_path.read_text()) if listed_path.exists() else None
        check(
            "papers_found_lists_every_found_paper_once",
            isinstance(listed, list)
            and sorted(row.get("paper_id") for row in listed) == sorted(found)
            and len(set(found)) == len(found),
            {"found": len(found), "listed": None if listed is None else len(listed)},
        )
        check(
            "every_listed_paper_has_a_verdict",
            isinstance(listed, list)
            and all(
                row.get("screening_status") in ("include", "maybe", "exclude") for row in listed
            ),
        )
        asked = sum(1 for event in called if event.get("task") == "normalize")
        check(
            "normalize_asked_only_with_documents",
            (asked > 0) == bool(picked and found),
            {"normalize_calls": asked, "documents": len(picked)},
        )
    check(
        "grounded_review_or_honest_empty",
        facts["claims"] > 0 or facts["honest_empty"],
        {"claims": facts["claims"], "honest_empty": facts["honest_empty"]},
    )
    return finish(
        report,
        report_path,
        facts,
        search,
        {
            "durationMs": record.get("durationMs"),
            "usage": usage,
            "cost": record.get("cost"),
            "model": model,
        },
    )


def request_shapes(models: list) -> dict:
    """Counts of the reasoning effort and text format in the recorded model request bodies."""
    efforts: dict[str, int] = {}
    formats: dict[str, int] = {}
    for line in models:
        try:
            body = json.loads(line.get("body") or "{}")
        except ValueError:
            body = {}
        reasoning = body.get("reasoning") if isinstance(body.get("reasoning"), dict) else {}
        effort = str(reasoning.get("effort")) if reasoning else "none"
        efforts[effort] = efforts.get(effort, 0) + 1
        text = body.get("text") if isinstance(body.get("text"), dict) else {}
        form = text.get("format") if isinstance(text.get("format"), dict) else None
        if form is None:
            shape = "none" if "format" not in body else "ollama_format"
        else:
            wrapped = "items" in ((form.get("schema") or {}).get("properties") or {})
            shape = ("strict" if form.get("strict") else "non_strict") + ("_wrapped" if wrapped else "")
        formats[shape] = formats.get(shape, 0) + 1
    return {"requests": len(models), "reasoning_effort": efforts, "text_format": formats}


def finish(report: dict, report_path: Path, facts: dict, search: dict, run: dict) -> int:
    passed = all(item["passed"] for item in CHECKS) and report.get("failures") == []
    report["checks"] = CHECKS
    report["grounding"] = facts
    report["search"] = search
    report["verification"] = {
        "script": "scripts/verify_chrome_literature_live.py",
        "checks": len(CHECKS),
        "failed": [item["id"] for item in CHECKS if not item["passed"]],
        "run": run,
    }
    report["passed"] = passed
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(
        json.dumps(
            {"passed": passed, "checks": len(CHECKS), "failed": report["verification"]["failed"]},
            indent=2,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
