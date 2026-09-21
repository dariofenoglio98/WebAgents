# Literature Review Agent — Agent Package v0 reference

This is the first application package for the **generic** Agent Package v0.1 format. It supplies a declarative graph, seven instruction skills, three tool contracts, application data schemas, requested permissions, budgets and evals. The host-installed `literature.review` workflow interprets these declarations; the archive contains no executable Python or JavaScript.

The package supports a research question, optional title/DOI/arXiv seeds, and selected PDFs linked to a paper. Its coordinator executes nine stages using eight worker roles plus the coordinator:

```text
PlanningWorker
  → CitationWorker [optional seed discovery]
  → SearchWorker [up to 3 concurrent queries]
  → merge/deduplicate
  → ScreeningWorker [bounded parallel candidates]
  → CitationWorker [unverified included candidates]
  → EvidenceWorker [bounded parallel papers]
  → SynthesisWorker
  → WritingWorker
  → VerificationWorker
```

Workers use skills; skills are not agents. CitationWorker is reused in two stages. Only the coordinator may spawn declared workers. Depth is one, total concurrent worker slots are three, and per-role caps may be lower. Inputs are copied views and outputs are checked state patches.

## Data and citation behavior

The research state records the question and query provenance, candidates, screening decisions/rationale, citation records, evidence, themes, claims, draft structure, verification results and unresolved items. Evidence preserves a source hash, source identity, abstract/full-text scope, available page/section, and extraction worker. Confidence/strength categories are descriptive; lexical overlap is never a probability.

`scholarly-search` uses bounded Crossref metadata queries. `citation-resolver` calls the existing remote service's `POST /resolve`; this package does not reimplement resolution, provider selection, title scoring or BibTeX generation. Its input/output schemas are snapshots of the actual service models, tested for drift. The remote-tool timeout is 45 seconds. Network endpoints and methods are explicit; returned URLs do not authorize fetching them.

Only `resolved` records enter the bibliography. `ambiguous` means the leading result is still a candidate, including score 1. `not_found`, `provider_error` and `invalid_request` remain distinct. Missing metadata stays missing. The resolver's exact BibTeX and whole canonical record are preserved; discovery metadata is not silently substituted into bibliographic fields.

Selected PDFs are read through opaque host-selected file IDs with an explicit file grant. The reader is bounded by bytes/pages/text and runs in a killable parser process. Raw full text is not kept in shared state or audit, although evidence excerpts appear in the explicit output export. Extracted quotes must match their supplied page or abstract. A verified citation is not proof of the underlying scientific result.

## Two reasoning modes

Without a configured model router, the workflow runs an **extractive baseline**: bounded query facets, lexical source-text screening, source quotations, cautious grouping, and deterministic claim/citation checks. It does not claim scientific method comparison, substantive synthesis, or gap discovery. Metadata-only candidates stay `maybe` unless supplied full text supports screening.

With a compatible host router, the six model tasks are planning, screening, extraction, synthesis, writing and verification. Structured schemas constrain each response; sources remain data, not instructions. Model-written claims need valid evidence/citation links and a separate semantic verification judgment. Unsupported/overstated claims are excluded from final prose. Thematic comparison fields remain inspectable structured state; arbitrary unverified headings cannot insert scientific claims into the final rendering. Model judgments are not calibrated probabilities or independent proof.

## Running and evaluating

From the repository root with `agentpkg` installed:

```sh
agentpkg validate agents/literature-review
agentpkg run dist/literature-review.agent.pkg --mode fixture \
  --question 'Dynamic agent selection and topology adaptation in multi-agent LLM systems' \
  --grants examples/fixture-grants.json --out examples/my-literature-demo
agentpkg eval dist/literature-review.agent.pkg
```

Bundled papers, identifiers, findings and full-text excerpts are **synthetic test fixtures**. Every fixture output identifies this fact. Fixture mode requires explicit grants and traverses the same runtime/worker/tool boundaries, but has zero real provider/model calls unless an external router is explicitly configured. Simulated remote attempts still exercise budgets.

For real metadata use `--mode live --trust-key examples/keys/publisher.pub.pem --grants examples/grants.session.json`. Optional `--seed` values are resolved before screening. The default live mode is still extractive unless `--router-config` is supplied and the model grant is enabled. Read the root tooling guide for PDF maps and endpoint configuration.

Results include Related Work, bibliography/BibTeX, an evidence table, complete structured state, uncertainty, provenance, usage and audit. Deterministic evals check citation/link validity, ambiguity, duplicated records, abstract/full-text distinction, unsupported claims, budgets, delegation and role/tool permissions. Scientific relevance, comparative synthesis quality and entailment need separately labelled model/human review.

## Authority and limitations

Requested access is read-only scholarly/citation networking, optional selected PDF reads, optional configured model use and session state. No shell, payment, GPU, repository-write or persistent-memory permission is requested. User-specified output export is a host operation. Network/model providers can see the authorized data sent to them; model prompts may contain selected evidence or PDF excerpts.

Defaults: estimated 24,000 tokens, hard cap 180,000, 45 runtime-visible remote calls, three search calls, 20 resolver calls, 10 PDF reads, and 30,000 tokens/15 remote calls per worker invocation. Resolver-internal upstream calls are outside the visible service-call counter. PDF screening and extraction are separate reads and both count. Host limits can only tighten package caps; change/rebuild/sign source to increase declarations.

This is a bounded review aid, not an exhaustive systematic review, independent scientific verification, production sandbox or native OpenClaw package standard. The OpenClaw adapter stages discoverable skills; enforcement occurs inside the separately installed reference runtime. No NANDA discovery or remote-worker execution occurs.
