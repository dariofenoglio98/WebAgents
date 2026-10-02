# Reference package walkthrough

Historical milestone-1 document. Current generic execution, reference packages and
verification results are documented in [workflow migration](workflow-migration.md),
[workflow.v0](../spec/workflow-v0.md), and the [new report](workflow-report.md).
The former host-specific execution path is now explicitly retained under `agentpkg.dev`.


Start with `agentpkg inspect dist/literature-review.agent.pkg`, then `agentpkg permissions ...`. Inspection exposes identity/version, skills, tool locations, permissions, worker graph, model requirements and budgets. It does not trust an embedded key. Verify using the separate demo public key or a publisher key obtained through your own trust process.

The archive's manifest points to one graph and one policy document. The graph binds nine ordered stages to eight execution roles plus the coordinator. Planning produces at most three topic queries; optional seeds use CitationWorker before discovery/screening and are not sent as numeric keyword searches. Three bounded search workers collect candidates and query/source provenance. The 20-candidate cap preserves seeds first, then query/provider ordering. Identifiers and identical discovery records support deduplication; title similarity alone does not establish work identity or relevance.

Screening examines abstracts or selected PDF text, producing include/maybe/exclude plus rationale. Included candidates without an earlier resolution call the existing resolver. Canonical bibliographic records are preserved whole. Ambiguous candidates, absent matches and provider failures remain visible; they are excluded from cited prose. Supplied exact arXiv/DOI identity must match the returned canonical work.

EvidenceWorkers produce typed evidence items with exact quotes, source hashes, source scope and page/section. Quote matching is checked against the supplied source even when a model proposes it. The coordinator shares selected state fields, not unrestricted mutable memory. Model instructions are the verified skill files for that worker; source text is supplied as untrusted data.

SynthesisWorker groups evidence and constructs linked claims. WritingWorker orders/refines claim objects. VerificationWorker checks every drafted claim's paper/evidence IDs and citation status. A direct quotation must match its evidence exactly. A synthesized assertion additionally requires a model entailment judgment; unsupported and overstated claims are removed from rendered prose. The final renderer cannot insert arbitrary model text outside this claim path.

The output directory contains:

| File | Purpose |
|---|---|
| `related-work.md` | Retained cited claims with explicit evidence/mode limitations |
| `bibliography.json`, `bibliography.bib` | Exact canonical resolver records and supplied BibTeX |
| `evidence-table.json` | Quotes, paper IDs, provenance, scope and locations |
| `unresolved.json` | Ambiguities, failures, missing evidence and uncertain screening |
| `result.json` | Complete structured state and all outputs |
| `provenance.json` | Package ID/version/digest, real versus synthetic data, reasoning mode |
| `audit.json` | Ordered worker/tool/model/permission/state events with hashes |
| `usage.json` | Global/per-worker token/call counters and peak parallelism |
| `evals.json` | Deterministic assertions, rejected-claim fraction and scope limits |

When a worker fails fatally, the CLI exports `result.json`, `audit.json`, `usage.json` and provenance with failed status. Permission and budget errors are not downgraded into provider uncertainty. Per-service transport failures can be represented as unresolved records; malformed data/authority errors fail closed.

`examples/demo-offline` exercises all four resolver resolution statuses, exact-quote grounding, abstract/full-text distinction, query deduplication, declared parallelism and zero model tokens using labelled synthetic data. The final bounded external run used two selected public ACL papers, after two discovery-only runs. Their raw outputs are not part of the published tree because they reproduced third-party text; their summaries are `examples/verification/live-fulltext-summary.json` and `live-*-run.txt`, and the download hashes/URLs are in `examples/verification/live-pdf-sources.json`. The fixture's full-text data are invented page records; they are not the real PDFs used by the live run.

The extractive output is deliberately modest. It does not prove literature coverage, compare methods semantically, or identify research gaps. The configured model path supports those reasoning stages and is tested with a scripted router; actual model quality must be measured with real LLM/human semantic evaluations. Metadata correctness and claim support remain different questions.
