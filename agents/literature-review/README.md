# Literature Review Agent — workflow.v0

Version 0.2.1 is a data-only package executed by the same generic interpreter as Meeting Agenda. `MANIFEST.agent` selects `workflow.v0`; **graph.json is the only authoritative execution graph**. The seven skills describe domain behavior; schemas and declared validation assertions enforce the structured contracts.

The graph performs planning, seed resolution, parallel search, join/normalization/deduplication, parallel screening, citation resolution, evidence preparation and parallel extraction, synthesis, writing, verification and declared exports. Citation Resolver remains a remote tool consumed through its existing contract. Conditional selected-PDF reads remain worker-local. Exact quote/page checks, record links and resolver metadata checks use generic validation nodes.

## 0.2.1: a bounded review, a measured timing policy, and an explicit output contract

0.2.0 carried a hosted-model assumption: ten search results per query, every included paper carried forward to citation and evidence work, and 60–120 s per model step. Measured on a local model, that breadth does not fit the package's own per-call output caps (normalization alone would re-emit up to thirty candidates twice), and its timeouts are several times shorter than local steps take. Measurement also showed that several instructions did not state what the package's own validation requires, so a model could follow them and still be refused. 0.2.1 changes exactly these things.

**Bounded work**

- **Search breadth.** At most three results per query, so three queries yield at most nine candidates. Normalization creates exactly one screening job per deduplicated candidate: every candidate inside the bound is screened, and relevance is decided by screening.
- **Selection.** At most three included papers continue to citation resolution and evidence extraction. When more are included, screening keeps the three whose source text most directly addresses the question; the others remain visible in the run's screened state.
- **Evidence.** At most four evidence items per paper — its most informative method, setup, finding or limitation statements.
- **Per-call output caps.** `normalize`, `prepare-evidence` and `verification` may emit up to 16,000 tokens (other model steps keep 12,000), because they reproduce records verbatim and a reasoning model's thinking counts as output.
- **Worker budgets.** Raised only for roles whose single call cannot be reserved within 30,000 under byte-bound token accounting. The package-wide budget is unchanged: 180,000 tokens, 45 remote dispatches, per-tool caps of 3 searches, 20 citation resolutions and 10 PDF reads, and three concurrent workers.
- **Timing.** Every model node and map-step timeout and the graph deadline come from measured local latency, with headroom for queueing at a single-slot model server.

**Output contract, stated where validation already required it**

- A citation record is its resolver answer copied exactly, with `metadata` the complete `best_match` (BibTeX included) when resolved and `null` otherwise; every resolved record becomes one evidence job.
- An evidence item always carries a verbatim quote, copied character for character; what a source does not state is left out rather than recorded as an item.
- A `direct_quote` claim cites exactly one evidence item and its text is that quote verbatim; any reworded or combined claim is `model_synthesis`.
- The final bibliography is `{reference, paper_id, metadata}` with metadata copied from the citation record, the evidence table copies evidence items exactly, and `related_work` is prose rendered from supported claims only.
- Paper `authors` and `provenance` entries admit only their declared fields, and every claim cites at least one evidence item and one paper.
- A document id — a `documents` value, or a job's `file_id` — is an opaque token of letters, digits, `_` and `-`, never a DOI; a job's `file_id` is null unless a document was supplied for that paper.

No assertion was removed or loosened: exact quote containment, record links, resolver metadata equality and the final output relations are the same checks as in 0.2.0, and the schema changes only add constraints.

## Replay fixture

`fixtures/workflow.json` owns the exact-input model/tool replay scenario. It is synthetic: three searches of three results each (nine raw candidates, eight after deduplication by DOI), eight screening decisions, three selected papers, three citation resolutions (two resolved, one ambiguous), two bibliography entries and seven evidence items, four of them from a selected PDF. Replay does not infer answers to new questions or establish model quality. The original fixture dataset and application schemas remain available; old specialized eval definitions are historical data and are not claimed as the new generic eval harness.

```sh
# Run from repository root, with a new output directory.
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode fixture --input examples/literature-review-input.json \
  --grants examples/literature-review-grants.json \
  --approve-tool scholarly-search --approve-tool citation-resolver --approve-tool paper-reader \
  --out examples/my-workflow-review
```

`result.json`, `audit.json`, `usage.json` and `provenance.json` identify `agentpkg.workflow.Workflow`. Graph-declared exports include Related Work Markdown, bibliography, evidence table, unresolved records and verification results.

The package retains session memory, depth-one local workers, three concurrent workers, 180,000 synthetic/model token units, 45 remote dispatches and the existing per-tool limits. Actual authority comes from host grants and explicit tool approvals. Fixtures use the same enforcement path and consume declared remote dispatch capacity despite making no network requests.

The earlier extractive/real-provider runner is separately preserved with `agents/literature-review-legacy`, `dist/literature-review-legacy.agent.pkg`, and `agentpkg.dev`. It is not used by this graph. See [migration details](../../docs/workflow-migration.md) and the [execution specification](../../spec/workflow-v0.md).
