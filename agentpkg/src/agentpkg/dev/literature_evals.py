"""Deterministic reference evals, separate from subjective model judgments."""

from __future__ import annotations

import copy
from datetime import UTC, datetime

FIXTURE_GRANTS = {
    "network.scholarly": "session",
    "network.citations": "session",
    "files.pdfs": "session",
    "memory.session": "session",
    "model.reasoning": "deny",
}


def evaluate_review(result: dict, package=None) -> dict:
    state = result["state"]
    evidence = {e["evidence_id"]: e for e in state["evidence_items"]}
    records = {r["paper_id"]: r for r in state["citation_records"]}
    retained = [c for c in state["claims"] if c["verification_status"] == "supported"]
    verdicts = {v["claim_id"]: v for v in state["verification_results"]}
    checks = []

    def check(name, passed, detail):
        checks.append({"id": name, "passed": bool(passed), "detail": detail})

    check(
        "citation-validity",
        all(
            records.get(b["paper_id"], {}).get("status") == "resolved"
            and b["metadata"] == records[b["paper_id"]]["metadata"]
            for b in result["bibliography"]
        ),
        "Bibliography contains only exact metadata from resolved records.",
    )
    check(
        "claim-source-consistency",
        all(
            c["evidence_ids"]
            and set(c["paper_ids"])
            == {evidence[e]["paper_id"] for e in c["evidence_ids"] if e in evidence}
            and all(e in evidence for e in c["evidence_ids"])
            and all(records.get(pid, {}).get("status") == "resolved" for pid in c["paper_ids"])
            for c in retained
        ),
        "Retained claims have nonempty evidence, exact paper links, and resolved citations.",
    )
    check(
        "verification-coverage",
        len(verdicts) == len(state["claims"])
        and all(
            verdicts.get(c["claim_id"], {}).get("status") == c["verification_status"]
            for c in state["claims"]
        ),
        "Every drafted claim has a recorded final verdict.",
    )
    check(
        "abstract-full-text-distinction",
        all(
            (
                e["scope"] == "abstract"
                and e["location"]["page"] is None
                and e["location"]["section"] == "abstract"
            )
            or (
                e["scope"] == "full_text"
                and isinstance(e["location"]["page"], int)
                and e["location"]["page"] > 0
                and e["provenance"]["source"] == "user_pdf"
            )
            for e in evidence.values()
        ),
        "Abstracts carry no invented page numbers; supplied PDFs retain page provenance.",
    )
    check(
        "duplicate-handling",
        len({p["paper_id"] for p in state["candidate_papers"]}) == len(state["candidate_papers"])
        and len(evidence) == len(state["evidence_items"]),
        "Candidate and evidence identifiers are unique.",
    )
    unresolved_ids = {r["paper_id"] for r in state["citation_records"] if r["status"] != "resolved"}
    check(
        "ambiguity-preserved",
        not unresolved_ids.intersection(b["paper_id"] for b in result["bibliography"])
        and unresolved_ids <= {u["paper_id"] for u in result["unresolved"]},
        "Ambiguous and failed resolutions remain visible and outside bibliography.",
    )
    check(
        "extractive-claims-verbatim",
        all(
            c["support_type"] != "direct_quote"
            or (
                len(c["evidence_ids"]) == 1
                and evidence.get(c["evidence_ids"][0], {}).get("quote") == c["text"]
            )
            for c in retained
        ),
        "Extractive scientific text is exactly the supporting quote.",
    )
    usage = result["usage"]
    limits = usage["limits"]
    check(
        "budget-compliance",
        usage["tokens"] <= limits["hard_tokens"]
        and usage["remote_calls"] <= limits["max_remote_calls"]
        and usage["peak_parallel_workers"] <= limits["max_parallel_workers"]
        and all(
            n <= limits["max_calls_per_tool"].get(t, 0) for t, n in usage["tool_calls"].items()
        ),
        "Observed usage respects token, call, per-tool, and concurrency caps.",
    )
    starts = [e for e in result["audit"] if e["action"] == "worker.started"]
    check(
        "delegation-depth",
        all(e["depth"] == 1 and e["parent"] == "coordinator" for e in starts),
        "All execution workers were spawned directly by coordinator at depth one.",
    )
    if package is not None:
        roles = {r["id"]: r for r in package.graph["workers"]}
        check(
            "tool-permission-compliance",
            all(
                e["role"] in roles
                and e["tool"] in roles[e["role"]]["tools"]
                and set(e["permissions"]) == set(package.tools[e["tool"]]["permissions"])
                for e in result["audit"]
                if e["action"] == "tool.called"
            ),
            "Every tool call belongs to the declared role and permission set.",
        )
    rejected = sum(c["verification_status"] != "supported" for c in state["claims"])
    return {
        "kind": "deterministic",
        "passed": all(c["passed"] for c in checks),
        "checks": checks,
        "draft_rejected_claims": rejected,
        "draft_unsupported_claim_fraction": rejected / len(state["claims"])
        if state["claims"]
        else None,
        "semantic_quality": "not measured by deterministic checks",
        "notice": (
            "Structural checks do not establish scientific correctness, "
            "completeness, or independent certification."
        ),
    }


async def run_evals(package) -> dict:
    """Run source-declared regression scenarios with bounded synthetic services."""
    from ..runtime import BudgetError, PolicyError, Runtime
    from .literature import deduplicate_papers, make_fixture_handlers, run_review, verify_claims

    fixture = package.json("fixtures/review.json")
    review = await run_review(package, fixture["question"], grants=FIXTURE_GRANTS)
    checks = list(review["evals"]["checks"])
    state = review["state"]

    def check(cid, passed, detail):
        checks.append({"id": cid, "passed": bool(passed), "detail": detail})

    statuses = {r["status"] for r in state["citation_records"]}
    check(
        "failure-fixtures-executed",
        {"resolved", "ambiguous", "not_found", "provider_error"} <= statuses,
        "The actual workflow consumed all four resolver status scenarios.",
    )
    ambiguities = [r for r in state["citation_records"] if r["status"] == "ambiguous"]
    check(
        "ambiguous-best-match-not-selected",
        bool(ambiguities) and all(r["metadata"] is None and r["alternatives"] for r in ambiguities),
        "Even the fixture best_match score of 1 was not accepted.",
    )
    check(
        "full-text-fixture-executed",
        any(e["scope"] == "full_text" for e in state["evidence_items"])
        and any(e["scope"] == "abstract" for e in state["evidence_items"]),
        "Both full-text and abstract extraction paths executed.",
    )
    check(
        "parallel-search-merge",
        sum(
            e["action"] == "worker.started" and e["role"] == "SearchWorker" for e in review["audit"]
        )
        == 3
        and all(
            len({p["query"] for p in paper["provenance"] if p.get("query")}) == 3
            for paper in state["candidate_papers"]
        ),
        "Three declared search workers merge duplicates while preserving all queries.",
    )
    check(
        "relevance-counterexample",
        any(
            p["screening_status"] == "exclude" and "Ceramic" in p["title"]
            for p in state["screened_papers"]
        ),
        "Shared terminology alone did not include an unrelated fixture.",
    )
    claim = copy.deepcopy(state["claims"][0])
    claim["text"] = "The method outperforms every prior system by 99 percent."
    verdict = verify_claims([claim], state["evidence_items"], state["citation_records"])[0]
    check(
        "unsupported-claim-rejected",
        verdict["status"] == "unsupported",
        "An invented quantitative assertion fails the verbatim evidence gate.",
    )
    claim["support_type"] = "model_synthesis"
    check(
        "unjudged-synthesis-rejected",
        verify_claims([claim], state["evidence_items"], state["citation_records"])[0]["status"]
        == "unsupported",
        "A synthesized assertion cannot pass by citing unrelated existing evidence.",
    )
    claim = copy.deepcopy(state["claims"][0])
    claim["paper_ids"] = ["fabricated-paper"]
    check(
        "hallucinated-reference-rejected",
        verify_claims([claim], state["evidence_items"], state["citation_records"])[0]["status"]
        == "unsupported",
        "An invented citation fails paper/evidence linkage.",
    )
    conflicting = copy.deepcopy(state["candidate_papers"][0])
    conflicting["doi"] = "10.0000/distinct-work"
    conflicting["paper_id"] = "distinct-paper"
    check(
        "distinct-dois-not-merged",
        len(deduplicate_papers([state["candidate_papers"][0], conflicting])) == 2,
        "Identical titles with different DOIs remain separate works.",
    )
    for cid, kwargs, expected in [
        ("remote-budget-denied", {"limits": {"max_remote_calls": 0}}, BudgetError),
        (
            "tool-permission-denied",
            {"grants": {**FIXTURE_GRANTS, "network.scholarly": "deny"}},
            PolicyError,
        ),
    ]:
        try:
            await run_review(package, fixture["question"], **{"grants": FIXTURE_GRANTS, **kwargs})
        except expected:
            check(cid, True, "The runtime denied dispatch before the forbidden tool action.")
        else:
            check(cid, False, "Forbidden action was not rejected.")
    runtime = Runtime(
        package,
        grants=FIXTURE_GRANTS,
        handlers=make_fixture_handlers(fixture),
        approved_tools=sorted(package.tools),
    )

    async def empty(ctx, inputs):
        return {"candidate_papers": []}

    try:
        await runtime.run_worker("SearchWorker", {"search_queries": ["test"]}, empty, depth=2)
    except PolicyError:
        check("delegation-depth-denied", True, "Attempted depth-two execution was denied.")
    else:
        check("delegation-depth-denied", False, "Depth-two execution was allowed.")
    return {
        "spec_version": "0.1",
        "kind": "deterministic",
        "passed": all(c["passed"] for c in checks),
        "checks": checks,
        "counts": {"passed": sum(c["passed"] for c in checks), "total": len(checks)},
        "provenance": {
            "package_id": package.manifest["package_id"],
            "package_digest": package.digest,
            "executed_at": datetime.now(UTC).isoformat(),
            "dataset": "fixtures/review.json",
            "synthetic": True,
            "runner": "agentpkg.literature_evals.run_evals",
            "independent_attestation": False,
        },
        "semantic_evals": {
            "status": "not-run",
            "reason": (
                "Scientific relevance, entailment, and thematic quality require "
                "configured host-router judgments and human review."
            ),
        },
    }
