import asyncio
import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

from agentpkg.dev.literature import deduplicate_papers, normalize_paper, run_review, verify_claims
from agentpkg.dev.literature_evals import FIXTURE_GRANTS, evaluate_review, run_evals
from agentpkg.errors import AgentPkgError
from agentpkg.package import load_package
from agentpkg.runtime import BudgetError, PolicyError

SOURCE = Path(__file__).resolve().parents[2] / "agents/literature-review-legacy"


@pytest.fixture
def package():
    return load_package(SOURCE)


def run(package, **kwargs):
    return asyncio.run(
        run_review(
            package,
            package.json("fixtures/review.json")["question"],
            **{"grants": FIXTURE_GRANTS, **kwargs},
        )
    )


def test_end_to_end_grounded_fixture(package):
    result = run(package)
    assert result["evals"]["passed"]
    assert "SYNTHETIC DEMONSTRATION" in result["related_work"]
    assert result["provenance"]["synthetic"] is True
    assert result["provenance"]["reasoning_mode"] == "extractive"
    assert len(result["bibliography"]) == 3
    assert result["usage"]["tokens"] == 0
    assert result["usage"]["tool_calls"]["scholarly-search"] == 3
    assert {r["status"] for r in result["state"]["citation_records"]} == {
        "resolved",
        "ambiguous",
        "not_found",
        "provider_error",
    }
    assert all(c["verification_status"] == "supported" for c in result["state"]["claims"])
    assert result["audit"][-1]["action"] == "memory.cleared"
    assert [e["stage"] for e in result["audit"] if e["action"] == "stage.completed"] == [
        s["id"] for s in package.graph["stages"]
    ]
    # Raw source pages never enter an audit record or the shared research state.
    serialized = json.dumps(result["audit"])
    assert "SYNTHETIC FULL TEXT" not in serialized
    assert "pages" not in result["state"]


def test_all_deterministic_evals_run(package):
    result = asyncio.run(run_evals(package))
    assert result["passed"], result
    assert result["counts"]["total"] >= 22
    assert result["provenance"]["independent_attestation"] is False
    assert result["semantic_evals"]["status"] == "not-run"


def test_ambiguity_score_one_does_not_resolve(package):
    result = run(package)
    unresolved = next(r for r in result["state"]["citation_records"] if r["status"] == "ambiguous")
    assert unresolved["metadata"] is None
    assert unresolved["alternatives"][0]["match_score"] == 1.0
    assert unresolved["paper_id"] not in {b["paper_id"] for b in result["bibliography"]}
    assert {u["status"] for u in result["unresolved"]} >= {
        "ambiguous",
        "not_found",
        "provider_error",
        "screening_maybe",
    }


def test_abstract_full_text_and_selected_pdf_relevance(package):
    result = run(package)
    evidence = result["evidence_table"]
    assert any(e["scope"] == "full_text" and e["location"]["page"] == 2 for e in evidence)
    assert any(e["scope"] == "abstract" and e["location"]["page"] is None for e in evidence)
    no_pdfs = run(package, pdfs={})
    assert all(e["scope"] == "abstract" for e in no_pdfs["evidence_table"])
    fixture = package.json("fixtures/review.json")
    fixture["papers"][0]["abstract"] = None
    fixture["resolutions"]["10.0000/synthetic-router"]["best_match"]["abstract"] = None
    with_pdf = run(package, fixtures=fixture)
    assert any(e["scope"] == "full_text" for e in with_pdf["evidence_table"])
    assert (
        next(
            p
            for p in with_pdf["state"]["screened_papers"]
            if p["doi"] == "10.0000/synthetic-router"
        )["screening_status"]
        == "include"
    )


def test_parallel_search_merge_preserves_query_provenance(package):
    result = run(package)
    assert len(result["state"]["candidate_papers"]) == 8
    for paper in result["state"]["candidate_papers"]:
        assert len({p["query"] for p in paper["provenance"] if p.get("query")}) == 3
    assert (
        len(
            [
                e
                for e in result["audit"]
                if e["action"] == "worker.started" and e["role"] == "SearchWorker"
            ]
        )
        == 3
    )


def test_parallel_search_really_overlaps_with_async_tools(package):
    fixture = package.json("fixtures/review.json")
    active = 0
    peak = 0

    async def search(ctx, payload):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return {
            "query": payload["query"],
            "source": "synthetic-fixture",
            "papers": fixture["papers"],
        }

    result = run(package, handlers={"scholarly.search": search})
    assert peak == 3
    assert result["usage"]["peak_parallel_workers"] == 3


def test_dedup_conservative_identity():
    a = normalize_paper(
        {"title": "A method", "doi": "https://doi.org/10.0000/A", "source": "crossref"}
    )
    b = normalize_paper({"title": "A method", "doi": "10.0000/a", "source": "openalex"})
    c = normalize_paper({"title": "A method", "doi": "10.0000/b", "source": "crossref"})
    assert len(deduplicate_papers([a, b, c])) == 2
    assert len(deduplicate_papers([a, b])[0]["provenance"]) == 2


def test_seeds_are_resolved_without_polluting_keyword_search(package):
    result = run(package, seeds=["10.0000/synthetic-router"])
    assert len(result["state"]["search_queries"]) == 3
    assert all("10.0000/" not in q for q in result["state"]["search_queries"])
    assert len(result["state"]["candidate_papers"]) == 8
    assert (
        sum(p["doi"] == "10.0000/synthetic-router" for p in result["state"]["candidate_papers"])
        == 1
    )


def test_candidate_cap_preserves_seeds_and_provider_rank(package):
    async def many_results(ctx, payload):
        return {
            "query": payload["query"],
            "source": "synthetic-fixture",
            "papers": [
                {
                    "title": f"Discovery {i}",
                    "doi": f"10.0000/discovery-{i}",
                    "source": "synthetic-fixture",
                }
                for i in range(10)
            ]
            if payload["query"].endswith("communication topology")
            else [
                {
                    "title": f"Earlier discovery {i}",
                    "doi": f"10.0000/earlier-{i}",
                    "source": "synthetic-fixture",
                }
                for i in range(10)
            ],
        }

    result = run(
        package, seeds=["10.0000/synthetic-router"], handlers={"scholarly.search": many_results}
    )
    candidates = result["state"]["candidate_papers"]
    assert len(candidates) == 20
    assert candidates[0]["doi"] == "10.0000/synthetic-router"
    assert [paper["doi"] for paper in candidates[1:11]] == [
        f"10.0000/earlier-{i}" for i in range(10)
    ]
    assert "10.0000/discovery-9" not in {p["doi"] for p in candidates}
    assert any(u["status"] == "candidate_limit" for u in result["unresolved"])
    assert len(result["bibliography"]) == 1


def test_unsupported_claim_and_missing_reference_rejected(package):
    result = run(package)
    state = result["state"]
    claim = copy.deepcopy(state["claims"][0])
    claim["text"] = "A made-up method proves universal superiority."
    verdict = verify_claims([claim], state["evidence_items"], state["citation_records"])[0]
    assert verdict["status"] == "unsupported"
    claim["support_type"] = "model_synthesis"
    assert (
        verify_claims([claim], state["evidence_items"], state["citation_records"])[0][
            "semantic_judgment"
        ]
        == "not_performed"
    )
    claim["paper_ids"] = ["invented"]
    assert (
        verify_claims(
            [claim],
            state["evidence_items"],
            state["citation_records"],
            {claim["claim_id"]: {"status": "supported", "reason": "mock"}},
        )[0]["status"]
        == "unsupported"
    )


def test_empty_search_is_honest(package):
    fixture = package.json("fixtures/review.json")
    fixture["papers"] = []
    result = run(package, fixtures=fixture)
    assert result["bibliography"] == []
    assert "No scientific claims passed" in result["related_work"]
    assert result["evals"]["draft_unsupported_claim_fraction"] is None


def test_missing_permissions_and_remote_budget_fail_before_dispatch(package):
    with pytest.raises(PolicyError, match="memory.session"):
        run(package, grants={})
    with pytest.raises(PolicyError, match="network.scholarly"):
        run(package, grants={**FIXTURE_GRANTS, "network.scholarly": "deny"})
    with pytest.raises(BudgetError):
        run(package, limits={"max_remote_calls": 0})
    with pytest.raises(PolicyError, match="files.pdfs"):
        run(package, grants={**FIXTURE_GRANTS, "files.pdfs": "deny"})


def test_malformed_successful_resolution_fails_closed(package):
    fixture = package.json("fixtures/review.json")
    fixture["resolutions"]["10.0000/synthetic-router"]["best_match"] = None
    with pytest.raises(AgentPkgError, match="without best_match"):
        run(package, fixtures=fixture)


def test_resolver_contract_has_all_statuses_and_null_metadata(package):
    validator = Draft202012Validator(package.json("schemas/resolver-output.schema.json"))
    for response in package.json("fixtures/review.json")["resolutions"].values():
        validator.validate(response)
    invalid = copy.deepcopy(
        next(iter(package.json("fixtures/review.json")["resolutions"].values()))
    )
    invalid["status"] = "probably_resolved"
    with pytest.raises(ValidationError):
        validator.validate(invalid)
    assert package.tools["citation-resolver"]["binding"] == "citation.resolve"
    assert package.tools["citation-resolver"]["timeout_seconds"] >= 40


def test_policy_and_role_skills_are_distinct(package):
    assert len(package.manifest["skills"]) == 7
    assert len(package.graph["workers"]) == 9
    assert all(p["kind"] not in {"shell", "payment"} for p in package.policy["permissions"])
    assert package.policy["memory"]["scope"] == "session"
    assert package.policy["memory"]["raw_documents"] is False
    assert package.policy["delegation"]["max_depth"] == 1
    assert set(package.policy["network"]["allowed_domains"]) == {
        "api.crossref.org",
        "webagents-citation-resolver-production.up.railway.app",
    }


def test_evaluator_catches_mutated_outputs(package):
    result = run(package)
    result["bibliography"][0]["paper_id"] = "fabricated"
    assert not evaluate_review(result, package)["passed"]


class ReasoningRouter:
    """Behavioral seam for workflow tests, explicitly not an actual LLM."""

    remote = False
    capabilities = {"reasoning", "structured_output"}
    context_window = 100000
    model_id = "test-model"
    router_id = "test-router"

    def __init__(self, bad_quote=False):
        self.calls = []
        self.bad_quote = bad_quote

    async def count_tokens(self, request):
        return 100

    async def complete(self, request, *, max_output_tokens):
        task = request["task"]
        data = request["data"]
        self.calls.append(task)
        if task == "plan":
            output = {
                "queries": [
                    "dynamic agent selection",
                    "communication topology adaptation",
                    "joint selection topology",
                ],
                "rationale": "Test-only plan",
            }
        elif task == "screen":
            paper = data["candidate_papers"][0]
            output = {
                "decision": "exclude"
                if "Ceramic" in paper["title"]
                else "include"
                if paper["abstract"] or data.get("selected_full_text")
                else "maybe",
                "rationale": "Test router source check",
            }
        elif task == "extract":
            page = data["pages"][0]
            quote = page["text"].split(". ")[0] + ("." if ". " in page["text"] else "")
            output = {
                "items": [
                    {
                        "text": quote,
                        "quote": "Invented unmatched evidence" if self.bad_quote else quote,
                        "category": "method",
                        "page": page["page"],
                    }
                ]
            }
        elif task == "synthesize":
            evidence = data["evidence_items"]
            output = {
                "themes": [
                    {
                        "theme_id": "t1",
                        "label": "Unverified headline says perfect accuracy",
                        "evidence_ids": [e["evidence_id"] for e in evidence],
                        "method_comparison": "Test model comparison",
                        "limitations": ["Synthetic inputs"],
                        "inference_level": "model_synthesis",
                    }
                ],
                "claims": [],
            }
            if evidence:
                output["claims"] = [
                    {
                        "claim_id": "good",
                        "text": (
                            "The reviewed sources describe selecting agents "
                            "and communication structure."
                        ),
                        "paper_ids": sorted({e["paper_id"] for e in evidence}),
                        "evidence_ids": [e["evidence_id"] for e in evidence],
                        "support_type": "model_synthesis",
                        "strength": "tentative",
                        "verification_status": "supported",
                        "theme_id": "t1",
                    }
                ]
        elif task == "write":
            output = {"claims": copy.deepcopy(data["claims"])}
            if output["claims"]:
                bad = {
                    **copy.deepcopy(output["claims"][0]),
                    "claim_id": "bad",
                    "text": "Invented result shows a 99 percent improvement.",
                }
                output["claims"].append(bad)
        elif task == "verify":
            output = {
                "verdicts": [
                    {
                        "claim_id": c["claim_id"],
                        "status": "unsupported" if c["claim_id"] == "bad" else "supported",
                        "reason": "Unsupported numerical claim"
                        if c["claim_id"] == "bad"
                        else "Test-only entailment judgment",
                    }
                    for c in data["claims"]
                ]
            }
        else:
            raise AssertionError(task)
        return {"output": output, "input_tokens": 100, "output_tokens": 100}


def test_router_pipeline_and_final_semantic_gate(package):
    router = ReasoningRouter()
    result = run(package, router=router, grants={**FIXTURE_GRANTS, "model.reasoning": "session"})
    assert set(router.calls) == {"plan", "screen", "extract", "synthesize", "write", "verify"}
    assert result["provenance"]["reasoning_mode"] == "model"
    assert result["usage"]["tokens"] > 0
    assert "99 percent" not in result["related_work"]
    assert "perfect accuracy" not in result["related_work"]
    assert (
        next(c for c in result["state"]["claims"] if c["claim_id"] == "bad")["verification_status"]
        == "unsupported"
    )
    assert result["evals"]["draft_rejected_claims"] == 1
    assert any(v["semantic_judgment"] == "model" for v in result["state"]["verification_results"])


def test_model_quote_fabrication_cannot_enter_evidence(package):
    result = run(
        package,
        router=ReasoningRouter(bad_quote=True),
        grants={**FIXTURE_GRANTS, "model.reasoning": "session"},
    )
    assert result["evidence_table"] == []
    assert result["bibliography"] == []
    assert any(u["status"] == "extraction_rejected" for u in result["unresolved"])


def test_model_token_budget_is_enforced(package):
    with pytest.raises(BudgetError, match="token budget"):
        run(
            package,
            router=ReasoningRouter(),
            grants={**FIXTURE_GRANTS, "model.reasoning": "session"},
            limits={"hard_tokens": 100},
        )


def test_seed_is_resolved_even_when_search_returns_nothing(package):
    async def no_results(ctx, payload):
        return {"query": payload["query"], "source": "test", "papers": []}

    result = run(
        package, seeds=["10.0000/synthetic-router"], handlers={"scholarly.search": no_results}
    )
    assert len(result["bibliography"]) == 1
    assert result["bibliography"][0]["metadata"]["doi"] == "10.0000/synthetic-router"
    assert result["usage"]["tool_calls"]["citation-resolver"] == 1
    assert any(e.get("stage") == "seed-discovery" for e in result["audit"])


def test_provider_transport_failure_is_visible_but_authority_denial_is_fatal(package):
    from agentpkg.tools import ToolError

    async def unavailable(ctx, payload):
        raise ToolError("upstream down")

    result = run(package, handlers={"scholarly.search": unavailable}, pdfs={})
    assert result["bibliography"] == []
    assert len([u for u in result["unresolved"] if u["status"] == "search_provider_error"]) == 3

    async def denied(ctx, payload):
        raise PolicyError("not authorized")

    with pytest.raises(PolicyError):
        run(package, handlers={"scholarly.search": denied})


def test_equal_titles_with_distinct_evidence_are_not_merged():
    first = normalize_paper(
        {"title": "Same title", "source": "crossref", "abstract": "First method", "year": 2024}
    )
    second = normalize_paper(
        {"title": "Same title", "source": "crossref", "abstract": "Different method", "year": 2025}
    )
    assert len(deduplicate_papers([first, second])) == 2


def test_failure_carries_privacy_preserving_audit(package):
    with pytest.raises(BudgetError) as caught:
        run(package, limits={"max_remote_calls": 0})
    report = caught.value.execution_report
    assert report["status"] == "failed"
    assert report["audit"][-1]["action"] == "memory.cleared"
    assert report["usage"]["remote_calls"] == 0
    assert "research_question" not in report
