# Literature Review Agent — workflow.v0

Version 0.2.9 is a data-only package executed by the same generic interpreter as Meeting Agenda. `MANIFEST.agent` selects `workflow.v0`; **graph.json is the only authoritative execution graph**. The eight skills describe domain behavior; schemas and declared validation assertions enforce the structured contracts.

The graph performs planning, seed resolution, parallel search, join/normalization/deduplication, parallel screening, citation resolution, evidence preparation and parallel extraction, synthesis, writing, verification and declared exports. Citation Resolver remains a remote tool consumed through its existing contract. Conditional selected-PDF reads remain worker-local. Exact quote/page checks, record links and resolver metadata checks use generic validation nodes.

## 0.2.9: bookkeeping as code that can only compute

0.2.9 is 0.2.8 with its candidate deduplication moved into a WebAssembly module ([compute.v0](../../spec/compute-v0.md)); it needs a runtime that implements it (agentpkg 0.5.0, the Chrome Agent Browser's core 0.3.0). The module is `modules/bookkeeping.wasm` (Rust, `examples/compute/bookkeeping-rs/`, SHA-256 `5b9db688c2cf9c60c818ac7eaf748d98ee60b8ecc564d76c37199da68e13735e`, declared in the graph and covered by the signature). It imports nothing, so it can only compute over the records the graph gives it; it runs under the host's memory and time bounds, for real in every mode, fixture mode included. One required permission authorizes it (`compute.bookkeeping`, kind `compute`); the agent page says "runs code that can only compute" and shows the hash.

- **Deduplication by normalized identity** (`identity-rows`, then `dedup-candidates`, function `assign_ids`). 0.2.8 removed exact duplicates in `join-search` by DOI, then arXiv id. The module keys every found record by its DOI (lower-cased, a `https://doi.org/` or `doi:` prefix removed), else its arXiv id (a version suffix removed), else its URL (lower-cased, a trailing `/` removed), else its title (case-folded, whitespace collapsed), and keeps the first record per key. So `10.1234/ABC` and `https://doi.org/10.1234/abc` are one paper now, where 0.2.8 screened them as two. The records it drops are in its output, whose hash the audit's `compute.completed` carries; `join-search` no longer records `node.deduplicated`. `identify` reads the module's records; `join-found` and `join-found-refs` keep their paper-id guard. The module also exports `match_quotes`, which this graph does not call (an export a graph does not name is never called, C-16).

No model call changed: the fixture's replayed answers, the exports and the token count are 0.2.8's. The model task list, the tools, the budgets (180,000 tokens, 45 remote calls, 4,500 s) and the memory switches are unchanged.

## 0.2.8: the person's memory, with three switches that are off by default

0.2.8 is 0.2.7 with the person's memory ([memory.v0](../../spec/memory-v0.md)); it needs a runtime that implements it (agentpkg 0.4.0, the Chrome Agent Browser's core 0.2.0). The task gains three fields, all off by default; off, the run is 0.2.7's and proposes nothing:

- **Use my research profile** (`use_profile`): the planning step also receives the fields and note of the research profile the person chooses from their memory (`memory.read` of `research.profile`, optional permission `memory.research_profile`; a record view, never the store). Its interests and topics to avoid shape the queries; its seed papers are hints.
- **Keep agent notes** (`keep_notes`): the agent reads its own notes from earlier runs before planning and writes new ones at the end (`memory` with scope `agent-scoped`, permission `memory.agent`, the reserved tools `agent-notes.read` and `agent-notes.write`). The host commits the notes only when the run completes; the person reads and clears them in Settings.
- **Review date** (`reviewed_on`, YYYY-MM-DD, the person's): the run proposes to remember the review as one `research.review` (`memory.write`, permission `memory.remember`): the question and the date from the task, the titles of the cited papers from the bibliography, and a title, a short body and a rationale from a new `remember` step; linked `derived_from` the research profile when one was read. It is written to `proposals.json`; nothing is remembered until the person accepts it after the run.

The graph cannot see the person's grants, so each read happens only when its switch is on: a switch turned on with its permission denied stops the run (`permission_denied`). The new `remember` model step (`RememberWorker`, skill `review-memory` 0.1.0, 24,000 tokens) runs only when notes are kept or a review date is given; with two re-asks its worst case still fits the unchanged run total (180,000 tokens, 45 remote calls, 4,500 s). The planning skill (literature-search 0.1.4) says how to use the profile and the notes. Tools, budgets and every check of 0.2.7 are unchanged.

## 0.2.7: the models judge, the graph keeps the records, and every run lists the papers found

The user's runs of 2026-10-09 stopped or emptied 0.2.6 in steps where a model did bookkeeping. On `openai/gpt-5.6-luna` `normalize` gave two candidates the same `paper_id` (twice), so `check-screening-refs` stopped the run. On `qwen3:30b` `normalize` dropped all nine candidates, and `select-included`, given nothing, invented a paper. 0.2.7 keeps the workflow (planning, normalizing, screening, selecting, extracting, synthesizing, writing and verifying, with the same workers and tools) and moves the bookkeeping into the graph:

- **Ids from identifiers, before any model.** `join-search` removes exact duplicates by DOI, then arXiv id. `identify` names every paper by its DOI, else its arXiv id, else its URL, else its title, and `join-found` keeps the first paper per id. A resolved seed becomes a search-shaped record (`seed-discovery`) and is screened like any search result. At most 20 papers continue; a cut is audited (`node.truncated`).
- **normalize is asked only when it has something to judge.** With no selected document there is nothing to match, so every found paper goes to screening with `file_id: null`. With documents, `normalize` returns `{candidates: [{paper_id, file_id}]}`. Two answer checks require every candidate to be a found paper and every found paper to appear exactly once, so a duplicate or a missing paper is refused on the answer.
- **The model judges, the graph keeps the record.** Screening answers `{paper_id, screening_status, screening_rationale}` (`schemas/screen-verdict.schema.json`), and a check ties the answer's `paper_id` to the job's. The screened record is the found record with that verdict attached. The included papers are collected by verdict. `select-included` runs only when one is included and answers `{paper_ids}` (one to three), checked against the included list. The graph copies the chosen records.
- **After selection, papers are named P1, P2, P3.** `selection-slots` pads the chosen ids to three positions and `assign-handles` names them in order. `citation-jobs` copies each chosen paper's record under its handle. From then on the citation records, evidence (`P1:e1` … `P1:e4`, listed for the extraction model and checked), claims and bibliography rows name the handle, while the bibliography entry carries the resolver's record with the DOI. In a live run Luna garbled a digit-heavy DOI id in 6 of 8 synthesis answers, and in 0 of 12 with handles. The output's `unresolved` list is the graph's own (citations that did not resolve), not the verifier's copy.
- **Answer checks** (workflow.v0 `checks`; the package now requires agentpkg 0.3.0):
  - on `extract-one`: every item names the job's paper, ids are unique, and every quote is verbatim in the abstract (the resolver's, else the search's) or in a supplied page. The 0.2.6 `check-abstract` and `check-document` relations became these checks.
  - on `synthesis`, `writing` and `verification`: every cited evidence item exists, every cited paper is resolved, and a direct quote's paper is its evidence's paper.
  - on `verification` also: every evidence-table and bibliography row points at a real item or resolved paper.
  - A host that re-asks (the Chrome Agent Browser, up to twice) names the failed check in its correction. `validate-output` keeps every assertion it had, and adds two that tie `papers_found` to the found papers.
- **`papers-found.json`**, in every completed run: one entry per found paper (`paper_id`, `title`, `year`, `venue`, `doi`, `url`, `screening_status`, `screening_rationale`), built by the graph from the found records and the screening verdicts. The "No sufficiently grounded literature found" text points to it, and the result summary shows it first.
- **A selected document reaches the model as its first pages:** two for screening, three for extraction (`join.limit`, audited). A whole 16-page paper made one screening call's reservation 81,066 tokens, more than any worker budget and more than a local model's context. The quote check reads the same pages the model saw.
- **The citation fallback.** The citation-resolver tool and `network.citations` also name `api.crossref.org`, so a host may answer a DOI query from Crossref's DOI lookup when the Citation Resolver is unavailable.
- **Budgets for re-asks.** Each worker's tokens fit its largest step three times (two re-asks): twice the largest charge plus the largest reservation recorded in 0.2.6's and 0.2.7's live runs, with a 15% margin. EvidenceWorker is sized for three dense document pages.
  - PlanningWorker 84,000
  - ScreeningWorker 70,000
  - EvidenceWorker 76,000
  - SynthesisWorker 76,000
  - WritingWorker 43,000
  - VerificationWorker 94,000

  The run total (180,000 tokens, 45 remote calls, 4,500 s) is unchanged. Timeouts fit three of the slowest attempt seen on a local model with one model slot: normalize 1,200 s, screening 1,800 s, evidence 1,500 s (one extraction 1,200 s), synthesis 720 s.
- **Skills:**
  - literature-search 0.1.3: keep the supplied ids.
  - paper-screening 0.1.2: a verdict, ids for selection, the first two pages.
  - evidence-extraction 0.1.4: the paper's handle and its evidence ids, the first three pages.
  - claim-and-citation-verification 0.1.4: "SYNTHETIC DEMONSTRATION" only when `mode` is fixture. Every live 0.2.6 review on Luna carried that label.

The signed 0.2.6 and 0.2.5 archives are preserved separately.

## 0.2.6: screening jobs are built from the candidates; an abstract has no source hash

Two package faults found by running 0.2.5 on hosted OpenAI models in the Chrome Agent Browser (T10, 2026-10-09). Both let a run complete with less literature than the search found, without saying so.

- **Screening jobs no longer pass through a model.** In 0.2.5 `normalize` returned every candidate twice: once in `candidate_papers` and once inside each screening job. Nothing compared the two copies. One model wrote a single job for seven candidates, another blanked every abstract in the job copies, and screening then excluded papers it had no text for. Now `normalize` returns `screening_refs`, one `{paper_id, file_id}` per candidate (`schemas/screen-ref.schema.json`). `check-screening-refs` requires every reference to name exactly one candidate. The new `screening-jobs` map builds each job from the candidate's own record, taking its `file_id` from the references with `lookup`. Every candidate must have exactly one reference, or the run stops. `normalize` writes about half as much as before.
- **Abstract evidence states no source hash.** `evidence.provenance.source_sha256` is required, and only a supplied document's reader output carries a hash. For an abstract, nothing in the input supplies one. One model returned no evidence at all rather than invent a hash, and the review reported "no sufficiently grounded literature". The evidence-extraction skill (0.1.3) now says the hash is exactly `""` for abstract evidence. `check-abstract` asserts it, so a fabricated hash fails closed. The replay fixture's abstract evidence, which carried the SHA-256 of the abstract (a value no live model can compute), now carries `""`.

The literature-search skill is 0.1.2 (references instead of job copies). No permission, tool contract, budget, timing or other assertion changed. The package still requires agentpkg 0.2.1 or later. The signed 0.2.5 archive is preserved separately.

## 0.2.5: the exported evidence table is the extraction record

The verification skill has always asked the verifier to copy each cited evidence item exactly into `evidence_table`, but 0.2.4 exported the verifier's copy, and `validate-output` compared only its `paper_id`, `quote`, `scope`, `location` and `provenance`. A live 0.2.4 run on `ollama/qwen3:30b` completed with one exported row re-labelled `category: "method"` where its extraction record said `"setup"`; the same path admitted a rewritten `text`, `support_strength` or `extraction_worker`.

- A new `materialize-evidence` map reads only each verifier row's `evidence_id` (`schemas/evidence-ref.schema.json`) and attaches that evidence item's own extraction record with `lookup`: exactly one item must carry the id, or the run stops. Which evidence is cited, and in which order, remains the verifier's decision.
- `assemble-output` exports that materialized table instead of the verifier's copy.
- `validate-output` keeps every check it had and adds one: each exported row must equal its extraction record as a whole.

No workflow primitive, skill, prompt, permission, tool contract, budget or timing changed, and the replay fixture is unchanged. The package still requires agentpkg 0.2.1 or later. The signed 0.2.4 archive is preserved separately.

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

`fixtures/workflow.json` owns the exact-input model/tool replay scenarios: the default input (memory off) and, since 0.2.8, `examples/literature-review-0.2.8-memory-input.json` (profile, notes and a review date on: the fixture holds the spec's synthetic research profile, empty earlier notes and the `remember` answer, so `proposals.json` holds one review); in 0.2.2 its evidence ids follow the `<paper_id>:e<n>` contract, and in 0.2.3 its verifier bibliography rows carry no metadata. It is synthetic: three searches of three results each (nine records, eight found papers after exact deduplication by DOI), one selected document, so `normalize` is asked, eight screening decisions and eight `papers-found` entries, three selected papers, three citation resolutions (two resolved, one ambiguous), two bibliography entries and seven evidence items, four of them from a selected PDF. Replay does not infer answers to new questions or establish model quality. The original fixture dataset and application schemas remain available; old specialized eval definitions are historical data and are not claimed as the new generic eval harness.

```sh
# Run from repository root, with a new output directory.
agentpkg/.venv/bin/agentpkg run dist/literature-review-0.2.8.agent.pkg \
  --mode fixture --input examples/literature-review-0.2.8-memory-input.json \
  --grants examples/literature-review-0.2.8-grants.json \
  --approve-tool scholarly-search --approve-tool citation-resolver --approve-tool paper-reader \
  --approve-tool research.profile --approve-tool agent-notes.read --approve-tool agent-notes.write \
  --out examples/my-workflow-review
```

`result.json`, `audit.json`, `usage.json` and `provenance.json` identify `agentpkg.workflow.Workflow`. Graph-declared exports include Related Work Markdown, the papers found, bibliography, evidence table, unresolved records, verification results and, since 0.2.8, `proposals.json` (the memory proposals, checked by the runtime before the run completes).

The package's run state is session state as before (0.2.8's `agent-scoped` scope adds only the agent's notes); it keeps depth-one local workers, three concurrent workers, 180,000 synthetic/model token units, 45 remote dispatches and the existing per-tool limits. Actual authority comes from host grants and explicit tool approvals. Fixtures use the same enforcement path and consume declared remote dispatch capacity despite making no network requests.

The earlier extractive/real-provider runner is separately preserved with `agents/literature-review-legacy`, `dist/literature-review-legacy.agent.pkg`, and `agentpkg.dev`. It is not used by this graph. See [migration details](../../docs/workflow-migration.md) and the [execution specification](../../spec/workflow-v0.md).
