# Literature Review Agent — workflow.v0

Version 0.2.3 is a data-only package executed by the same generic interpreter as Meeting Agenda. `MANIFEST.agent` selects `workflow.v0`; **graph.json is the only authoritative execution graph**. The seven skills describe domain behavior; schemas and declared validation assertions enforce the structured contracts.

The graph performs planning, seed resolution, parallel search, join/normalization/deduplication, parallel screening, citation resolution, evidence preparation and parallel extraction, synthesis, writing, verification and declared exports. Citation Resolver remains a remote tool consumed through its existing contract. Conditional selected-PDF reads remain worker-local. Exact quote/page checks, record links and resolver metadata checks use generic validation nodes.

## 0.2.4: deterministic preparation and direct quotes

`prepare-evidence` is a structural map over resolver answers. It constructs one citation record per answer, one evidence job per resolved record, and an unresolved row for every other status. Three ordered joins retain these collections. Bidirectional relations check coverage, uniqueness and exact source data. Missing fields or a missing/duplicated screening-job reference fail closed. Each job carries the same opaque selected-file capability used for that paper's screening; no second model reconstructs that mapping.

Direct-quote model outputs select exactly one evidence ID and one paper ID with `text: null`. The `materialize-claims` map checks their relationship and copies the selected evidence's exact quote. Paraphrase text is unchanged. The final exact-quote, evidence and bibliography checks still run. Bibliography metadata continues to come directly from the resolver through `lookup`.

No workflow primitive, permission, tool contract or budget changed. Removing the `prepare` model task saves one completion (two remote accounting events for a remote tokenizer/completion path). The signed 0.2.3 archive is preserved separately. Live acceptance status is documented in the milestone report; fixture success alone is not cross-provider acceptance.

## 0.2.3: bibliographic metadata comes from the resolver, not the model

A live 0.2.2 run on `ollama/qwen3:30b` completed every stage and was refused by `validate-output` assertion 0 (`fields_do_not_match`, `/metadata` against `/response/best_match`): the verifier was asked to reproduce each cited paper's complete resolver record, and a model can return scientifically sound output while its transcription of that record differs from the original in a field such as a null value, an author object or the BibTeX string. The package required a model to regenerate trusted data that the package then demanded be identical. 0.2.3 stops asking:

- `verification` writes a draft review (`schemas/review-draft.schema.json`) whose bibliography rows are `{reference, paper_id}` only. Which papers are cited, and under which reference, remain the model's decisions; the row admits no other field (claim-and-citation-verification skill 0.1.2).
- A new `bibliography` map attaches, to each row, the Citation Resolver's own `best_match` for that `paper_id`, selected from `resolved_jobs` with workflow.v0's generic `lookup` constructor (agentpkg 0.2.1): exactly one resolved job must carry the id, or the run stops. The metadata never passes through a model.
- A new coordinator node, `assemble-output`, builds `final` from the draft and that bibliography. The verifier can no longer write `final` at all.
- `validate-output` is unchanged: every bibliography entry must still equal its resolved job's `best_match` exactly, for a job whose status is `resolved`, and every claim, evidence and paper relation is checked as before. The final bibliography schema now also requires `{reference, paper_id, metadata}`, with metadata shaped as a resolver `Paper`.

Nothing else changed: permissions, network policy, budgets, tool contracts, timing policy and every 0.2.2 assertion are byte-identical. The package requires agentpkg 0.2.1 or later, which adds `lookup`; an older runtime refuses the graph at load.

## 0.2.2: globally unique evidence ids, and an honest empty result

Two corrections found in the accepted 0.2.1 run. Nothing else changed: the permissions, network policy, budgets, tool contracts, timing policy and every 0.2.1 validation assertion are byte-identical, and each change below either adds a check or removes work that had nothing to work on.

**Evidence ids are unique across the whole run.** In 0.2.1 each extraction worker numbered its own paper's evidence (`e1`, `e2`, …) and `join-evidence` kept the first record per `evidence_id`, so two papers' `e1` collided and genuine evidence was dropped (three of ten items in the accepted run). In 0.2.2:

- an evidence id is its paper's `paper_id`, a colon, and `e1`–`e4` — for example `10.1234/abc:e2` — which is stable, meaningful and deterministic for a given paper and position (evidence-extraction skill 0.1.2; synthesis and writing skills 0.1.2 copy ids exactly);
- `join-evidence` concatenates every worker's evidence and removes nothing;
- a new `check-evidence` node relates the evidence list to itself, so a duplicated id refuses the run (`duplicate_target_key`) instead of one record silently replacing another.

**No evidence, no review.** When nothing survives screening, resolution or extraction, 0.2.1 still asked the writer and verifier for a review, and the final checks then refused the unsupported claims. In 0.2.2 the graph terminates honestly: `prepare-evidence` runs only when a paper was resolved, `synthesis` only when there is evidence, and `writing` and `verification` only when there are claims. Otherwise each node takes its declared empty value, and the result is a valid review with no claims, no bibliography, no evidence table and no verification results, whose `related_work` is the package's own fixed statement that no sufficiently grounded literature was found within this bounded search. Unresolved citations are still reported. The final `validate-output` assertions are unchanged and still run.

**Presentation metadata.** `graph.json` `extensions` carries `agentpkg:presentation`: human-readable node and stage labels, input widget hints and the result summary a browser may render. It is noncritical: it grants nothing, changes no execution, and a host that ignores it runs the package identically. The workflow input schema gained JSON Schema annotations (titles, descriptions, defaults, an example) with every validation keyword unchanged.

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
- The final bibliography is `{reference, paper_id, metadata}` (since 0.2.3 the metadata is attached by the workflow from the resolver record, not copied by a model), the evidence table copies evidence items exactly, and `related_work` is prose rendered from supported claims only.
- Paper `authors` and `provenance` entries admit only their declared fields, and every claim cites at least one evidence item and one paper.
- A document id — a `documents` value, or a job's `file_id` — is an opaque token of letters, digits, `_` and `-`, never a DOI; a job's `file_id` is null unless a document was supplied for that paper.

No assertion was removed or loosened: exact quote containment, record links, resolver metadata equality and the final output relations are the same checks as in 0.2.0, and the schema changes only add constraints.

## Replay fixture

`fixtures/workflow.json` owns the exact-input model/tool replay scenario; in 0.2.2 its evidence ids follow the `<paper_id>:e<n>` contract, and in 0.2.3 its verifier bibliography rows carry no metadata. It is synthetic: three searches of three results each (nine raw candidates, eight after deduplication by DOI), eight screening decisions, three selected papers, three citation resolutions (two resolved, one ambiguous), two bibliography entries and seven evidence items, four of them from a selected PDF. Replay does not infer answers to new questions or establish model quality. The original fixture dataset and application schemas remain available; old specialized eval definitions are historical data and are not claimed as the new generic eval harness.

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
