# Milestone 3B4 report: the Literature Review agent, executed for real

Pinned host: OpenClaw 2026.9.5 (ec9c1a1), Ollama 0.34.0, Apple M3 Max (36 GB).
Package: `org.webagents.literature-review` **0.2.1**, digest `2199abb5…1700`,
archive `0fb8b65b…8e42`, signer `sha256:c5ca9763…5232`.

## Headline

**The Literature Review agent has run for real and passed acceptance.** On the
fourth product-path attempt the signed 0.2.1 graph completed on a local
`ollama/qwen3:30b` against live Crossref and the live Citation Resolver: 16 model
calls, every one on the bound model; 3 searches and 3 resolutions; peak 3
concurrent workers; 120,242 tokens; $0; a valid 404-event audit chain; every
package assertion and all 28 independent acceptance checks passing; the run plan
byte-identical afterwards. The three earlier attempts were each refused by the
package's own checks and classified precisely (§10); every classification led to
a change in the package or the host, never to a weaker check. The owner's
question could not be grounded from Crossref within the bounded breadth, so the
accepted review answers a similarly focused, well-indexed question on
prompt-injection defenses (§10.1). One defect found in the accepted run — three
evidence items lost to an id collision in a join — is now visible in the audit
and is the first fix for the next version (§10.3).

## 1. What 3B4 had to finish

At the end of 3B3 the Literature Review package could not run anywhere: it
declares three tools — `scholarly-search`, `citation-resolver` and
`paper-reader` — and only the Citation Resolver had a host implementation, so a
model run plan was refused by name. 3B4 had to supply the other two as host code,
bind all three, and then run the signed graph end to end on a local model, with
nothing package-specific added to the host and nothing weakened in the runtime.

The shape did not change:

```text
signed package (data only)           host (trusted code)
  graph.json, skills, schemas   ─►   agentpkg.workflow.Workflow  (generic interpreter)
  tool declarations             ─►   OpenClaw Agent Browser tool broker
                                       scholarly.search  → Crossref adapter      (new)
                                       citation.resolve  → Citation Resolver     (3B3)
                                       paper.read        → selected-file reader  (new)
  model requirements            ─►   run plan's exact model, via api.runtime.llm
```

## 2. The two new host tools

Both are described in full in [the tool broker](tool-broker.md) (§3a, §3b, §7a)
and the [threat model](threat-model.md#scholarly-search-selected-files-and-pacing-3b4).
In short:

**`scholarly-search` → `openclaw.tool.crossref_works_search` 0.2.0.** One `GET
https://api.crossref.org/works` whose parameter names and fixed values are host
code: `query.bibliographic` and `rows` carry the package's two accepted values;
`select` (the field list) and `filter` (scholarly work types only — added in
0.2.0 after a live survey found supplementary files and peer reviews filling
small result pages) are constants. Any other argument name is refused before a
connection. All 3B3 network protections apply unchanged: HTTPS only, exact
origin/path/method, DNS resolution with private-address rejection, pinned
address, TLS hostname verification, no redirects, fixed headers, no cookies or
ambient credentials, bounded request and response, timeout and cancellation.
Crossref's public-pool limits (one request at a time, one per second) are
honoured by a process-wide pacer: calls wait their turn inside their deadline and
nothing is retried. Titles and abstracts are rendered exactly as the Citation
Resolver renders them (a CPython `HTMLParser` port checked against 141 vectors),
because a later package check requires evidence quotes to occur verbatim in the
resolver's copy of the same abstract.

**`paper-reader` → `openclaw.tool.selected_pdf_text` 0.1.0.** Reads only a PDF
the operator selected for this session, named by an opaque `file_<32 hex>`
capability. Selection checks a regular, non-symlink file inside a configured
root, opens it `O_NOFOLLOW`, bounds its size, requires `%PDF-` and copies it once
into a `0400` file; every read re-verifies size and SHA-256. Parsing happens in a
separate short-lived `agentpkg host-pdf-read` process with CPU, file-size and
memory limits, page and text bounds, no OCR, no scripts, no attachments and no
network. No path reaches a package, run plan, audit, model or result.

## 3. Host execution changes

All generic; none knows what Literature Review is.

| Change | Why |
|---|---|
| Per-binding pacing (`max_concurrent`, `min_interval_ms`) | Crossref's advertised limits; three concurrent search workers otherwise earn a 429 |
| `execution.modelCallTimeoutSeconds` (default 300, the previous constant) | A single-slot local model server answers the third of three concurrent workers only after the other two; the host must not cut a queued call off before the package's own node timeout does |
| `reason` on `model.failed` / `tool.failed`, and `model.refused` with the refusing bound and its numbers | A failed run must be classifiable from its own audit (Phase L) |
| Router probe revalidates tool bindings against the live registry | It refused every tool-declaring plan with `run_plan_stale` — a real 3B3 gap, now covered by a test that fails without the fix |
| Run record `revalidated` list holds up to 64 entries (was 32) | The list is the preflight checks plus the runner's own facts plus one entry per bound tool; a three-tool run overflowed the plugin's output schema and `execution.get` refused its own record mid-run |
| A tool that outlasts its declared timeout is a probe outcome (`timeout`) | It escaped the tool probe as an unclassified `internal_error`; a transient Crossref slowdown (> 25 s) surfaced it |
| A failed validation records which declared check refused it (`failed_check`: assertion index, kind, compared pointers — never data) | A run refused by its final assertions could not otherwise be classified once its state was cleared (§10.2) |
| A join that drops records records it (`node.deduplicated`: counts of identical and conflicting duplicates, the declared `unique_by`) | Distinct records sharing an identity were discarded silently; the accepted run lost three evidence items this way (§10.3) |
| Detached start, live progress, selected-file attachments in the Run Invocation | The data a 3C Run surface needs (§13) |

## 4. Why 0.2.0 could not run here

Everything below was measured, outside the product path, by replaying the exact
wire content the router renders for each node against the local model
(`examples/verification/literature-review-*-node-latency*.json`,
`…-copy-fidelity-*.json`, `…-copy-diffs-qwen3-30b.json`,
`…-normalize-degeneration-qwen3-30b.json`, `…-021-reservations.json`).

1. **Accounting.** OpenClaw exposes no tokenizer, so the router reserves the
   provable upper bound `utf8_bytes + 512` plus the node's output cap. With
   OpenClaw's 32,768-token cap on discovered local models, and 30,000-token
   worker budgets, `normalize`, `select-included`, `prepare-evidence`,
   `synthesis` and `verification` cannot even be admitted for realistic inputs
   (worst reservations 37,749–50,991).
2. **Breadth.** Ten results per query means up to thirty candidates, and
   `normalize` re-emits every candidate twice (candidate list and screening job).
   That exceeds a 12,000-token output cap for any model.
3. **Timing.** 0.2.0 allowed 60 s per model step and 120 s per node. Measured
   local steps take 25–590 s, a map's calls queue at a single-slot server, and
   OpenClaw's own heartbeat agent takes the same slot every 30 minutes.
4. **An under-specified contract.** The package validates by exact equality —
   resolver metadata, bibliography, evidence rows, verbatim quotes — but its
   instructions never said what those shapes are, some said the opposite (the
   extraction skill asked to "record unavailable evidence", which a model does
   by writing an item quoting "Not discussed"), and two permissive item schemas
   (`authors`, `provenance`, `additionalProperties: true`) let grammar-constrained
   decoding degenerate: the model began writing JSON punctuation inside key names
   (`"locator "`, `"query "`, even `abstract` nested in provenance) until the
   output collapsed. Four local models were tried on the unchanged contract;
   none met it reliably (§6).

## 5. Literature Review 0.2.1 — every change and its evidence

Preserved: `dist/literature-review-0.2.0.agent.pkg`, digest `b7bd37ca…b3eb`,
still verifying under the original key. `test_shipped_artifacts.py` asserts that
exactly the files below changed, that `policy/policy.json`, every tool contract
and every validation assertion are byte-identical, and that the schema changes
only add constraints.

**Bounded work** (explicit, versioned, and documented in the package README)

| Change | Evidence |
|---|---|
| `search-query` `limit` 10 → 3 (≤ 9 candidates) | normalize output ≈ 2 × candidates × record size; 30 candidates cannot fit any cap |
| exactly one screening job per deduplicated candidate (skill text) | qwen3.5:9b screened 1 of 9 candidates; the package's own fixture screens 8 of 8 |
| `selection` `maxItems: 3` + "keep the three most directly relevant" | worst-case `prepare`/`verification` reservations and the unchanged 180,000 global cap |
| new `paper-evidence` schema, `maxItems: 4`, for `extract-one` | bounds verification's verbatim evidence table; four = the four evidence categories |
| `normalize`, `prepare-evidence`, `verification` output cap 12,000 → 16,000 | measured thinking + verbatim content: 12,144 (normalize), 10,006 (prepare) tokens |
| worker budgets raised only where one call's reservation exceeds 30,000 | Planning 50,000 (42,393), Screening 45,000 (39,579), Citation 50,000 (42,907), Synthesis 45,000 (37,749), Verification 60,000 (50,991) |

**Timing** — worst measured on `ollama/qwen3:30b`, plus 300 s for one OpenClaw
heartbeat turn and a model reload at the shared single-slot server:

| Operation | 0.2.0 | 0.2.1 | Worst measured |
|---|---|---|---|
| `planning` | 120 | 360 | 44.4 |
| `normalize` | 120 | 900 | 586.7 |
| `screening` (map, ≤ 9 items) | 120 | 1200 | 353.5 |
| `screening/screen-one` | 60 | 600 | 155.1 (queue + heartbeat) |
| `select-included` | 120 | 480 | 118.2 |
| `prepare-evidence` | 120 | 720 | 378.2 |
| `evidence` (map, ≤ 3 items) | 120 | 1020 | 187.4 per call |
| `evidence/extract-one` | 60 | 900 | 187.4 |
| `synthesis` | 120 | 600 | 111.1 |
| `writing` | 120 | 360 | 43.2 |
| `verification` | 120 | 720 | 173.6 |
| graph deadline | 1800 | 4500 | critical path ≈ 2,400 |

Tool, join and validation operations keep 0.2.0's budgets.

**Output contract, stated where validation already required it** — every item
tied to a measured failure; no assertion was removed or relaxed:

| Change | Measured failure it answers |
|---|---|
| citation record = resolver answer copied exactly; `metadata` = complete `best_match` (BibTeX included) or `null`; every resolved record → one evidence job | resolver wrapper or `null` as metadata (qwen3.5:9b); BibTeX dropped in 3 of 3 records (qwen3:30b); 1 evidence job for 3 resolved records |
| evidence items always carry a verbatim quote, copied character for character; unstated categories are omitted | an item quoting "Not discussed"; engine attempt 2's non-verbatim quote (§10.2) |
| a `direct_quote` claim cites exactly one evidence item and its text is that quote verbatim; any reworded or combined claim is `model_synthesis` (synthesis, writing and verification skills) | engine attempt 3: `validate-output` assertion 4 (`/text` eq `/quote` for direct-quote claims) refused a final claim — the writing skill asks for "cautious language" and no skill said rewording changes the claim's kind |
| bibliography `{reference, paper_id, metadata}`, evidence rows copied exactly, `related_work` rendered as prose from supported claims | bibliography without `paper_id`, `null` metadata, 12–82-character reviews |
| paper `authors`/`provenance` items closed to their declared fields | key-name degeneration collapsing `normalize` |
| every claim cites ≥ 1 evidence item and ≥ 1 paper | with zero evidence, claims with empty `evidence_ids` passed as supported — a relation over an empty list is vacuously true |
| document ids (`documents` values, job `file_id`s) are opaque tokens of letters, digits, `_`, `-`; `file_id` is null unless a document was supplied — never the DOI | the first real run: `normalize` set every job's `file_id` to the paper's DOI with no documents supplied; `paper-reader` was then correctly denied (`files.pdfs` = deny) and the run failed closed (§10) |

The replay fixture was regenerated to satisfy the new bounds (three searches of
three results, a deliberate cross-query duplicate, three selected papers: a
resolved paper with a selected PDF, a resolved abstract-only paper and an
ambiguous citation). It still exercises deduplication, full-text and abstract
evidence paths, page and quote checks and an unresolved outcome;
`not_found`/`provider_error` are no longer reached in replay because only three
papers are selected.

## 6. Choosing the local model (Phase F)

The compatibility path offers four local models. The preferred
`ollama/qwen3.5:9b` is installed, callable and compatible, and was measured
first. Same requests, unchanged 0.2.0 contract, Ollama's own default sampling:

| Model | `prepare` metadata exact | `verification` bibliography + evidence exact | `prepare` time / output tokens |
|---|---|---|---|
| qwen3.5:9b | no (resolver wrapper) | no (no `paper_id`) | 580 s / 11,492 |
| qwen3.5:9b, presence_penalty 0 | no (`null`) | no (`null`, rows truncated) | 433 s / 9,022 |
| qwen3.6:35b | yes | no (`null`, rows truncated) | 415 s / 16,121 (over cap) |
| **qwen3:30b** | **yes** | **yes** | **181 s / 8,177** |

Lowering qwen3.5's temperature to 0.2 made it think in a loop until the cap
(12,000 tokens, no answer). qwen3:30b is a mixture-of-experts model decoding at
~45 tok/s here, versus ~20 for qwen3.5:9b, and it is already this OpenClaw's
configured default model. Per Phase F ("if another compatible local model is
clearly faster/currently appropriate, record the choice explicitly") the run
plan binds **`ollama/qwen3:30b`**, and every call uses it. There is no fallback.

**The route.** The router needs a 65,536-token context for the heaviest
reservations; OpenClaw caps discovered local models at 32,768. A custom
provider id with `api: "ollama"` is listed by OpenClaw but cannot be called (the
Ollama plugin supplies streams only for provider ids it owns: `No API provider
registered for api: ollama`). The working route is an explicit
`models.providers.ollama.models` list — which replaces discovery for that
provider, so it reproduces all four discovered models exactly (context 32,768,
max 8,192, zero cost, tools, JSON-schema output) and changes only qwen3:30b:
`contextTokens` 65,536 and `maxTokens` 16,384. Same weights, same transport as
the Meeting Agenda acceptance; `ollama/qwen3.5:9b` remains the default model of
OpenClaw's own agent. No sampling parameter is overridden. To return to
discovery: `openclaw config unset models.providers.ollama.models`.

## 7. Facts about this host that shape any local run

* **One model slot.** Ollama here runs `OLLAMA_NUM_PARALLEL=1`
  (`llama-server -np 1`): three concurrent workers are real workers, but their
  model calls are decoded one after another. Tool calls do overlap.
* **OpenClaw's heartbeat.** The `main` agent runs a turn on
  `ollama/qwen3.5:9b` every 30 minutes (hh:00:24 and hh:30:24) with a ~27k-token
  prompt. It queues behind the current call, evicts the 25 GB model and reloads
  it afterwards — measured at ~1.5 minutes of contention. It was left running;
  the timing policy budgets for it.
* **Thinking and structured output.** Ollama 0.34 decodes a thinking model's
  `format` request in two passes (free thinking, then grammar-constrained
  content) and applies `num_predict` to each pass, so total output can exceed
  the requested cap (16,121 against 12,000 was observed). agentpkg halts a run
  when reported output exceeds the declared cap, which is correct: the
  reservation assumed the cap. 0.2.1's caps sit above every measured total.

## 8. The signing key and the trust decision

The graph changed, so the bytes changed, so the artifact had to be re-signed;
the original key's private half exists on no machine here. A **new Ed25519 key**
was generated with `agentpkg keygen` at
`~/.config/agentpkg/keys/webagents-literature-review.private.pem` (`0600`, in a
`0700` directory, outside the repository, never printed); only
`examples/keys/literature-review-publisher.pub.pem` is recorded. Meeting
Agenda's key was not reused.

| Key | Signs | Fingerprint |
|---|---|---|
| original development key | both preserved 0.2.0 artifacts, the legacy package | `sha256:c7549e61…5a70` |
| Meeting Agenda key | `meeting-agenda` 0.2.1 | `sha256:2bcc374a…c5c4` |
| **Literature Review key** | **`literature-review` 0.2.1 only** | **`sha256:c5ca9763…5232`** |

The original key refuses 0.2.1 and the new key refuses 0.2.0. Opened through the
live Gateway before any decision
(`examples/verification/literature-review-021-untrusted-open.json`): container,
integrity and schema valid, runtime compatible, signature valid — and publisher
**`mismatch`**, `claimed_publisher_pinned_to_other_key`, listing the two keys
already pinned for `webagents-research`. The key was then pinned at the
narrowest scope, `package` (prefix `org.webagents.literature-review`); a new
authorization receipt and a new run plan followed, and a test proves a 0.2.0
receipt cannot authorize 0.2.1.

## 9. Probes before any workflow (Phase G)

On the final signed 0.2.1 bytes (`2199abb5…`), through the running Gateway, no
model and no workflow (`examples/verification/tool-broker-*.json`,
`literature-review-021-router-probe.json`):

| Probe | Result |
|---|---|
| `scholarly-search`, host fixture `topic` | pass: 1 tool call, 1 remote call, HTTP 200, implementation 0.2.0, 0 tokens, audit valid (on an earlier build a first attempt outlasted the tool's 25 s timeout at Crossref — see §3) |
| `citation-resolver`, host fixture `doi` | pass: 1 tool call, 1 remote call, HTTP 200, 0 tokens, audit valid |
| `paper-reader`, selected `paper-reader-probe.pdf`, role `ScreeningWorker` | pass: 1 tool call, 0 remote calls, opaque `file_…` id only, no host path anywhere in the report |
| router probe on `ollama/qwen3:30b` | pass: planned = invoked, provider `ollama`, direct transport, context 65,536, 231 in / 302 out tokens, $0, run plan unchanged |

## 10. The live runs

Every run below went through the product path: the installed plugin, the running
Gateway, a run plan bound to `ollama/qwen3:30b`, the signed graph instantiated as
`agentpkg.workflow.Workflow`, real Crossref, the real Citation Resolver on
Railway, and `examples/literature-review-live-input*.json` as the task. No run
used a fixture, and no output was edited.

### 10.1 The owner's question (Phase E1)

*"What methods have been proposed for dynamically selecting agents and adapting
communication topology in multi-agent LLM systems? …"* — tried first, as asked.

**Attempt 1** (`run_a5ee4dee…`, artifacts in
`examples/literature-review-live-owner-question-attempt1/`) failed after 8
minutes with `permission_denied` at `screening/read-source`. Classification:
**model structured-output fault, correctly contained.** `normalize` set every
screening job's `file_id` to the paper's DOI although no document had been
supplied; the graph's conditional PDF read therefore ran, and the runtime refused
it because `files.pdfs` was denied (`permission.checked … grant: deny, allowed:
false`), then failed the run closed. No file was read and no call reached the
host (3 tool calls — the searches — in a valid 118-event audit chain). The
package fix is the document-id contract in §5, confirmed before any further run:
the same `normalize` request on the fixed package returned `null` for all seven
jobs.

**Coverage.** Independently of that fault, two full-pipeline measurements on the
same question (`…-qwen3-30b-node-latency*.json`) screened 9 and 7 candidates and
included **none**, each exclusion with a defensible rationale: the retrieved
records are about structural topology optimization, wireless decision-making,
memory architectures and communication-flow correction — not agent selection or
topology adaptation. The representative methods for this topic are published on
arXiv and at venues whose Crossref records lack abstracts, so within three
results per query this question cannot be grounded from Crossref. Per Phase E1
the engine acceptance therefore used a similarly focused, well-indexed question;
a live survey of four candidates through the same request shape
(`examples/verification/literature-review-question-coverage-survey.txt`) found
*prompt injection defenses* the best indexed: 9 unique results, 7 with
abstracts, all on topic — and a topic this project's own threat model depends on.

**Attempt 2** (`run_208c91ce…`, final package, artifacts in
`examples/literature-review-live-owner-question-attempt2/`) confirmed the
coverage finding through the product path and showed what the agent does with
it. Four candidates were screened and none selected, so no citation was resolved
and no evidence extracted (11 model calls, 3 searches, 0 resolutions, 0 PDF
reads, $0, audit valid). Synthesis, writing and verification nevertheless
produced claims — citing evidence ids that do not exist — and `validate-output`
refused the run after 633 s: `failed_check` assertion 2, `missing_target_key`
from `/evidence_ids` to `/evidence_id`. With nothing to ground a review on, the
agent tried to write one anyway, and the package's checks stopped it; no
ungrounded review left the run. Answering such a question with an honest empty
review needs one more instruction ("no evidence, no claims"), which changes the
signed bytes and is left for the next version.

### 10.2 The engine acceptance question

*"What defenses have been proposed against prompt injection attacks on
LLM-integrated applications? Compare their detection or prevention mechanisms,
where in the application they are deployed, and their reported effectiveness,
focusing on representative methods."*

**Attempt 1** (`run_0cfddc77…`, `examples/literature-review-live-engine-attempt1/`)
ran every stage — planning, three concurrent searches, normalization, nine
screening calls through three workers, selection, three real Citation Resolver
lookups, `prepare-evidence` with **`check-records` passing** (resolver metadata
reproduced exactly), three concurrent extractions with **every verbatim-quote
check passing**, synthesis, writing and verification — and was refused by the
final `validate-output` after 1,945 s with `schema_validation`. Every stage was
inside its 0.2.1 budget (normalize 321 of 900 s, screening 274 of 1,200,
prepare 223 of 720, evidence 300 of 1,020, synthesis 236 of 600, verification
367 of 720 despite an OpenClaw heartbeat landing on it; deadline 4,500). 19 model
calls, all on `ollama/qwen3:30b`; 3 searches and 3 resolutions; peak 3
concurrent workers; 120,402 tokens; $0; audit chain valid. The run's state was
cleared on failure under the package's session retention, so which of the five
final assertions refused it could not be read — the gap that led to the
`failed_check` attribution in §3.

**Attempt 2** (`run_e695d834…`, `examples/literature-review-live-engine-attempt2/`),
with attribution in place, was refused earlier: at `evidence/check-abstract`
after 1,701 s, `failed_check` = assertion 2 (relation), `fields_do_not_match`
on `/quote` `contained_in` `/text` — one extracted quote was not verbatim in its
paper's abstract, and the sibling extraction was cancelled with it.
`check-records` had passed again. 98,869 tokens, peak 3 workers, 3 searches and
3 resolutions, $0, audit valid.

The two attempts together classify the remaining risk: **stochastic copy
fidelity of the local model**, caught every time by the package's own checks.

**Diagnosis: stochastic, not systematic.** To rule out a contract gap behind
attempt 1's final refusal, the same signed graph was replayed *outside the
product path* — the real `Workflow` class in-process, the same model and request
shape sent directly to Ollama, live Crossref and the real Citation Resolver —
keeping every node's output
(`examples/verification/literature-review-diagnostic-replay-qwen3-30b.json`).
It **completed with all five final assertions passing**: 7 of 8 screened
candidates included, 3 selected and resolved with exact metadata, 8 verbatim
evidence items, 6 direct-quote claims each citing one evidence item, all
verified as supported, and a 1,005-character related-work section citing [1]–[3].
So the contract *can* be met — but a satisfiable contract is not the same as a
fully stated one, as the next attempt showed.

**Attempt 3** (`run_808ce613…`, `examples/literature-review-live-engine-attempt3/`),
on the same package, passed `check-records` and every quote check and was
refused by `validate-output` after 2,344 s — this time attributed: assertion 4,
`fields_do_not_match` on `/text` eq `/quote` for claims whose `support_type` is
`direct_quote`. A final claim was labelled a direct quote but did not repeat its
quote verbatim. That is a contract gap, not only chance: the writing skill asks
for "cautious language" and no skill said that rewording turns a direct quote
into synthesis (the replay passed because its model happened not to reword). The
rule was added to the synthesis, writing and verification skills, the extraction
contract was made explicit about character-for-character copying (answering
attempt 2), the package was rebuilt and re-signed (`2199abb5…`), all probes were
repeated on the new bytes, and the acceptance run was repeated.

**Attempt 4 — accepted.** `run_33ad6e1e…`, artifacts in
`examples/literature-review-live/`, driver report
`examples/verification/literature-review-live-run.json`:

| Fact | Value |
|---|---|
| package | `org.webagents.literature-review` **0.2.1**, digest `2199abb5…1700`, signature valid, signer `sha256:c5ca9763…5232` trusted by the package-scope pin |
| authorization | receipt `2d0cdf7c…`: `network.scholarly`, `network.citations`, `memory.session`, `model.reasoning` = session; `files.pdfs` = **deny** (no documents); all three tools approved |
| run plan | `rp_b6675a64…`, sha `3864c26f…`, ready, `ollama/qwen3:30b` at 65,536 context; byte-identical afterwards, `execution.performed` false, bindings still current, no page Run action |
| status | **`completed`**, profile `workflow.v0`, interpreter `agentpkg.workflow.Workflow`, runner re-verified the package |
| model | 16 calls — plan 1, normalize 1, screen 6, select 1, prepare 1, extract 3, synthesize 1, write 1, verify 1 — **every one on `ollama/qwen3:30b`**, no fallback |
| tools | `scholarly-search` 3 (Crossref), `citation-resolver` 3 (Railway), `paper-reader` 0 — the read steps were skipped (`file_id` null) and never reached the denied permission |
| parallelism | 22 workers spawned, **peak 3 concurrent** (searches, screening, extraction) |
| budget | 120,242 of 180,000 tokens; 6 of 45 remote calls; cost **$0** (16 of 16 calls reported a cost) |
| audit | 404 events, **chain valid** |
| exports | `related-work.md`, `bibliography.json`, `evidence-table.json`, `unresolved.json`, `verification.json`, plus `result.json`, `audit.json`, `usage.json`, `provenance.json`, `run.json` |
| time | 2,440 s workflow (40.7 min), 2,461 s wall clock |
| acceptance | **28 of 28** independent criteria (below) |

Every stage stayed inside its 0.2.1 budget, with two OpenClaw heartbeats landing
during the run:

| Node | Took (s) | Budget (s) |
|---|---|---|
| planning | 31.1 | 360 |
| search (3 concurrent, paced) | 4.9 | 120 |
| normalize | 374.2 | 900 |
| screening (6 calls, 3 workers) | 220.4 | 1200 |
| select-included | 252.9 | 480 |
| citations (3 concurrent) | 1.3 | 120 |
| prepare-evidence → `check-records` passed | 422.0 | 720 |
| evidence (3 workers) → every quote check passed | 454.9 | 1020 |
| synthesis | 189.4 | 600 |
| writing | 58.1 | 360 |
| verification → `validate-output` passed | 430.2 | 720 |

**Independent acceptance checks** (the driver re-derives them from the run's own
artifacts, trusting none of the package's own claims): completed; `workflow.v0`;
signature valid; signer trusted; runner re-verified the package; one explicit
model on every call; $0; Crossref and the Citation Resolver called; `paper-reader`
use matching the (empty) documents; peak parallelism ≥ 2; audit chain valid; all
five exports and five host files written; related work non-empty; every
bibliography entry a resolved record whose metadata equals the resolver's
`best_match`; every evidence quote found verbatim in a genuine tool-returned
abstract; evidence table equal to the evidence items; every claim citing existing
evidence and resolved papers, none vacuously; verification results matching the
claims; related work citing only bibliography papers; no synthetic content; no
credential-shaped text; run plan unchanged; progress observed.

The first scoring flagged the bibliography check although the package's own
assertion had passed. The driver compared JSON *text*, and the model had written
the metadata keys in a different order — the values were identical. JSON objects
are unordered, so the driver now compares values, as the package does, for both
the bibliography and the evidence table; the run was re-scored from its preserved
artifacts (`--reevaluate`), keeping every observation made while it was live. The
report as first recorded is kept beside it
(`literature-review-live-run-as-recorded.json`).

### 10.3 What the agent wrote

`examples/literature-review-live/related-work.md`, verbatim and unedited:

> ## Network-layer detection using reverse proxy
> The guardrail-rs system (Myet et al. [1]) employs a reverse proxy that sits
> between an application and its LLM provider, inspecting every request and
> response before crossing the network boundary. It uses regex-based and
> ONNX-based semantic classifiers for prompt-injection detection, reports a
> component missing its documented latency target at larger payloads, and
> explicitly notes the absence of formal adversarial-robustness evaluation
> (identified as the most important future work).
>
> ## Model-layer dynamic defense
> Panterino and Fellington [2] describe dynamic defense techniques including
> random parameter perturbation, model re-initialization, and dynamic context
> adjustments, seamlessly integrated with the Mistral LLM. Their experimental
> results demonstrate a substantial reduction in attack success rate while
> maintaining high performance and managing computational overhead efficiently.

**Quality review (Phase K).** The planner covered terminology, methods and
evaluation. All six screened candidates were on topic and included; two distinct
DOIs sharing the title *Containment over Detection* were kept apart, correctly,
because deduplication is by identifier, never title. Three papers were selected
and all three resolved with metadata reproduced exactly. Every sentence of the
review is traceable to a verified claim, every claim is a verbatim quote of one
evidence item, and the prose keeps the sources' own hedges (a missed latency
target, no adversarial evaluation). It is a short, two-paper comparison — honest
about its reach, and too small to call a survey.

**One defect, found in review.** Extraction produced 4, 3 and 3 evidence items,
but `evidence_items` holds 7. The second and third papers' workers each named
their items `e1`–`e3`, and `join-evidence` deduplicates by `evidence_id` with
"first record wins", so the third paper's three verbatim quotes — the
*Containment over Detection* defense — were dropped, and the review covers two
papers instead of three. Nothing was fabricated and every check held; evidence
was lost. The runtime now records such a loss as `node.deduplicated`, separating
conflicting from identical duplicates (§3, `test_workflow.py`), so it can never
again pass silently. The package fix — evidence ids unique across papers, e.g.
prefixed with the paper id — changes the signed bytes after acceptance, so it is
the first item for the next version rather than a silent rebuild of the accepted
artifact.



## 11. Tests

`agentpkg`: **711** tests; `openclaw-agent-browser`: **299** tests; both suites
green, plus `ruff` on everything touched, `tsc --noEmit`, and both verification
scripts (`examples/verification/verify-workflow-3b4.json`,
`verify-browser-3b4.json`). What 3B4 added, beyond the tool tests described in
[the tool broker](tool-broker.md):

| Area | Tests |
|---|---|
| Literature Review 0.2.1 release content | `test_shipped_artifacts.py`: version and source-tree identity; 0.2.0 preserved and verifying under its own key; *only* the enumerated files changed; policy, tool contracts and every assertion byte-identical; graph differs only in timing, budgets, caps, breadth and one schema; bounded-work policy explicit; schema changes only add constraints; document ids can never be DOIs; timing equals the measured table; worker budgets cover their worst reservation and no more; new key only; mismatch until a package-scope pin; a 0.2.0 receipt cannot authorize 0.2.1 |
| Replay fixture | `test_workflow.py`: bounded replay (3 searches, 9 raw → 8 candidates, 3 selected, 2 PDF reads, 2 bibliography entries, 7 evidence rows, ambiguous preserved) |
| Failure classification | `test_runtime.py`: refused calls record the refusing bound; failed calls record only an identifier-shaped reason. `test_workflow.py`: a fabricated quote and an edited final bibliography are each attributed to the exact declared check, and a join that drops a conflicting record records `node.deduplicated` with its counts — with no data in the audit. `test_tool_execution.py`: a tool outlasting its timeout is a `timeout` probe outcome |
| Host limits | `test_execution_session.py` + `execution.test.ts`: the per-call model timeout defaults to 300 s, is capped at 3,600 s, bounds a slow completion and cancels it at the model |
| Router probe and run record | `router-probe.test.ts`: a tool-binding plan is probed with bindings revalidated (fails without the fix); `contract.test.ts`: the run record holds the largest revalidation list a host composes |

## 12. Security non-regression

Nothing in 3B4 widened what a package can reach. The properties below are each
held by tests that fail if they regress (TypeScript file / Python module named):

| Property | Where it is proved |
|---|---|
| No arbitrary HTTP: exact origin, path, method; fixed headers; redirects refused; private addresses refused before connecting | `tool-broker.test.ts`, `crossref.test.ts` ("sends exactly one GET to the binding's origin and path, with four host-named parameters", "refuses a redirect rather than following it", "refuses a host that resolves to a private destination, before connecting") |
| No package-controlled query parameters, endpoint or headers | `crossref.test.ts` ("refuses argument names it was not written for", "encodes unicode and punctuation as values, never as structure", "describes itself by implementation id and version, never by a template", "fingerprints the mapping, so it cannot change without a version bump") |
| No arbitrary file read: capability ids only; paths, traversal, `~`, `file://`, symlinks, swapped or grown files refused; no path leakage | `paper-reader.test.ts`, `test_hostfiles.py`, `tool-execution.test.ts` ("refuses every string that is not one of this run's capabilities, before any read", "refuses to read a copy whose bytes no longer match the selection") |
| No shell, no command adapter | there is no such adapter kind; the binding kind union is `local_builtin`, `json_http`, `selected_file` (`tool-registry.ts`) |
| Credentials stay host-side | `tool-broker.test.ts` ("attaches a configured credential as a header and never anywhere else", "describes its built-ins without a credential, a header or a request template") |
| One model, no fallback | `test_hostbridge_router.py` (a completion from any other model is refused as `selected_model_unavailable`); every live run and probe reports planned = invoked |
| Run plans are immutable and go stale | `tool-execution.test.ts` ("makes a plan stale when the implementation behind a binding changes", "… when an approval is withdrawn"); live: plan hash identical after every run and probe |
| Trust, permission and approval cannot be bypassed | `test_shipped_artifacts.py` (new signer is a `mismatch` until pinned at package scope; a 0.2.0 receipt cannot authorize 0.2.1), `tool-execution.test.ts` ("refuses a plan when a declared tool was not approved"), and the live owner-question run itself: a denied optional permission stopped a model-induced file read (§10) |
| Accounting stays honest | `test_runtime.py` (a refused call records its bound; a failed call records only an identifier-shaped reason, never a message) |

## 13. The workflow.v0 task model, and what 3C can render

Under `workflow.v0` a person's interaction is **structured task input → one
bounded run → result**. For Literature Review the `question` is the research
prompt; `seeds` and selected `documents` are optional. There is no
conversational loop, per-turn chat or persistent profile — those belong to a
future `conversation.v0`. A follow-up question is simply a new Run Invocation
against the same run plan (if still current) or a new one. See
[package execution §9a](package-execution.md#9a-the-task-the-run-and-its-progress--the-interaction-model-for-workflowv0).

The run record and its artifacts already carry what a 3C Run surface needs, with
no Literature-Review-specific API: package name and version, the task, the
selected model, permissions and tool bindings, status, live progress (active and
finished nodes, workers, model and tool calls, tokens, elapsed time), usage,
cancellation state, the exported related-work text and every artifact by name.
A run can be started detached and followed through `execution.get`.

## 14. Known limitations

* **Coverage.** Crossref indexes few abstracts for the fastest-moving LLM
  venues (arXiv, most ACL records), so some questions cannot be grounded within
  three results per query; the owner's question was one (§10).
* **Local capability.** Only one of four local models met the package's
  exact-copy contract. A run can still fail validation on a stochastic copy
  error; the package's checks refuse it rather than accept it.
* **Contention.** Ollama's single slot and OpenClaw's heartbeat make local run
  time variable; the timing policy absorbs one heartbeat per model step.
* **Provider accounting.** Ollama's per-pass `num_predict` means a thinking
  model can exceed a declared output cap; the runtime halts such a run instead
  of accepting it.
* **No evidence, no review.** On a question with no includable literature the
  models still wrote claims, citing evidence that does not exist; the final
  checks refuse the run (§10.1). An instruction that an empty evidence set means
  no claims would let the agent return an honest empty review instead.
* **Evidence ids.** Extraction workers choose evidence ids independently, and
  `join-evidence` keeps the first record per id, so colliding ids drop evidence
  (three items in the accepted run). The runtime now records it; the package fix
  (ids unique across papers) is for the next version.
* **Evidence provenance.** `source_sha256` in evidence rows is written by the
  model and is not recomputed by the host; the package grounds quotes by
  verbatim containment in resolver and search text instead.
* **Not built:** the user-facing Run action and run UI (3C), persistent run
  history, browser file upload, per-node model routing.
