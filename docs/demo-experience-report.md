# Milestone 3C — the agent-native browser demo

A person can now open a signed third-party agent package in OpenClaw's Agent
Browser, verify its publisher, inspect what it asks for, grant authority,
choose their own model, type a task, press **Run**, watch the package's own
graph execute, and inspect the result, the artifacts and exactly which models
and tools were used — through the existing package, runtime, tool and model
security architecture, with no operator script on the path.

This report has two parts that were accepted separately: the Literature Review
package hardening (0.2.2), accepted on deterministic scenarios, and the Run
surface, accepted by driving the real Control UI in a real browser through a
complete Literature Review run. Evidence:
[`literature-review-022-acceptance.json`](../examples/verification/literature-review-022-acceptance.json),
[`ui-acceptance-3c.json`](../examples/verification/ui-acceptance-3c.json).

## 1. Host startup

| | |
|---|---|
| Host | OpenClaw 2026.9.5 (`ec9c1a1`), Gateway on loopback `127.0.0.1:18789` |
| Restart | `openclaw gateway restart` → *Restarted LaunchAgent: gui/501/ai.openclaw.gateway*; `openclaw gateway status` → *Runtime: running*, *Connectivity probe: ok*. Restarted after each plugin install; the backend re-started `agentpkg browser-serve` each time and re-read finished runs from disk. |
| Ollama | `qwen3:30b` (18 GB), `qwen3.6:35b`, `qwen3.8:27b`, `qwen3.5:9b`; none loaded by hand — the run's first model call loaded `qwen3:30b` |
| Models on the page | 9 reported by the host (4 Ollama, 5 OpenAI), all *Compatible*; `qwen3:30b` is the host default with a 65,536-token context. Nothing is preselected. |
| Plugin configuration | unchanged: `sessionTtlSeconds: 7200`, `execution.runTimeoutSeconds: 4500`, `modelCallTimeoutSeconds: 1200`, `llm.allowModelOverride: true`; custom plugin UI already enabled |

## 2. Package hardening — Literature Review 0.2.1 → 0.2.2

| | 0.2.1 (preserved) | 0.2.2 (current) |
|---|---|---|
| Artifact | `dist/literature-review-0.2.1.agent.pkg` | `dist/literature-review.agent.pkg` |
| Digest | `2199abb5868bcedd5c73e7a664f38d35aaaa047c2dcfdb07d91f3977bde41700` | `19de8c9e2fa2e96d85b029108f78519cbda5edbf4a872257ae51597cef08c634` |
| Archive SHA-256 | `0fb8b65bbff4578d4815ee70b29a0cb789b2cc95ce181d011d467b4be22c8e42` | `4804ea8f4c2ad40439641f8348c2d65b798f4d52802f6ad751b71114e4f27c04` |
| Signer | `sha256:c5ca9763…5232` | the same key, `sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232` |
| Graph | 17 nodes | 18 nodes (`check-evidence`) |

**Evidence ids (A1).** In 0.2.1 every extraction worker numbered its own
paper's evidence `e1`, `e2`, … and `join-evidence` kept the first record per id,
so evidence from different papers silently collapsed. 0.2.2 makes the id
`<paper_id>:e<n>` (the evidence-extraction skill states the contract; the
package's schemas already carry `paper_id`), joins without deduplicating, and
adds `check-evidence`, a relation assertion of the evidence list against itself
that refuses the run on any duplicate id instead of dropping evidence. The
generic join semantics are unchanged; `unique_by` still exists for packages that
want it.

**Zero grounded evidence (A2).** 0.2.1 asked the writer and verifier for a
review even when nothing survived and relied on the final checks to refuse the
unsupported result. 0.2.2 gives `prepare-evidence`, `synthesis`, `writing` and
`verification` a `when … ne []` condition with an `otherwise` constant: when
there is nothing to work on, the node is skipped and its declared constant is
committed. The verification constant is the honest result — `related_work`
opens with *No sufficiently grounded literature found* and explains the bounded
search; bibliography, evidence table, claims and verification results are
empty; unresolved citations stay visible. `validate-output` and `outputs` are
unchanged and still run on that result.

**Signing and trust.** The Literature Review key's private half was available
(`~/.config/agentpkg/keys/`, mode 0600, outside the repository), so 0.2.2 is
signed by the same key and no rotation was needed. The host's existing pin
(*WebAgents Research Prototype*, scope `org.webagents.literature-review`,
2026-09-23) therefore covers 0.2.2 unchanged: the page shows *Trusted by this
OpenClaw host* with no new trust decision.

## 3. Package tests

`agentpkg/tests/test_literature_022.py` runs the signed bytes through the real
`Workflow` interpreter with `ScriptedReview` answering only the model's tasks
(`tests/literature_scenarios.py`); `scripts/verify_literature_022.py` records the
same facts.

| Case | 0.2.2 | 0.2.1 |
|---|---|---|
| 3 concurrent workers each returning `e1`, `e2` | completed; 6 distinct ids (`10.5555/scripted.1:e1` … `.3:e2`), 6 table rows, 6 claims, 3 papers, no deduplication | — |
| colliding worker-local ids | refused at `check-evidence`: `duplicate_target_key` on `/evidence_id`, before any synthesis | completed with 2 of 6 evidence items and 1 of 3 papers; only the audit said so |
| nothing included / nothing resolved / no evidence in sources / evidence supports no claim | completed; 0 claims, 0 bibliography, 0 evidence, 0 verification; 3 unresolved kept in the second; writer and verifier never called; final checks ran; output schema valid | asked `synthesize`, `write`, `verify` to review nothing |
| an ungrounded claim | still refused by `validate-output` (`missing_target_key`) | — |
| a re-signed package whose empty branch claims something | refused by `validate-output` | — |

## 4. UI architecture

* **Input schema rendering.** The control plane bundles the package's input
  schema (refs → `$defs`) and validates `agentpkg:presentation` hints against a
  closed vocabulary; the page generates the form (`src/ui/form.ts`) from both,
  with **Edit as JSON** for any shape it does not render. Nothing in the page or
  the generic backend names a package, a domain or a model (structural test).
* **Run feature operation.** `execution.start` with exactly `{sessionId,
  runPlanId, runPlanSha256, input, files, detach}`.
* **Detached execution.** `detach: true` returns once the runner has bound the
  plan, so every refusal still comes back to the click; the run continues in its
  own runner process.
* **Polling / progress.** `execution.get` every 2 s while a run is live;
  `execution.readiness` every 30 s while the form is shown; input validation
  debounced by 350 ms.
* **Cancellation.** `execution.cancel {runId}` → the bridge → the runner's
  AbortSignal.
* **Result rendering.** The package's primary export as Markdown built from DOM
  calls only; the declared summary exports as counts and rows.
* **Artifact access.** `execution.artifact` (48 KiB view) and
  `execution.artifact-chunk` (48 KiB slices + whole-file SHA-256); names only.
* **Output limits.** Every projection is fitted to OpenClaw's plugin JSON
  limits (§12).

## 5. Authority — what must hold before Run

The Run button is enabled only when the page's checklist holds — package
verified, publisher trusted, permissions authorized, every declared tool bound,
a model chosen, a run plan ready, the task valid by the package's own schema —
**and** `execution.readiness`, which runs the same preflight as a start, agrees.
The start then re-checks everything regardless:

* **Run Plan revalidation**: plan identity and hash, readiness, execution mode,
  package digest and archive hash, execution profile, validation, signature,
  signer fingerprint, publisher trust, the authorization receipt, that it has
  not expired **and outlasts the run deadline plus 60 s**, and model permission;
  then the runner re-verifies the snapshot it was handed (archive, container,
  integrity, schema, digest, identity, signature, signer, profile, one handler
  per bound tool) — 34 checks recorded on the run, 21 by the preflight and 13 by
  the runner.
* **Model binding**: the model the plan froze, still offered by the host, same
  identity, still compatible; every call recorded with the model that answered.
* **Tool binding**: each declared tool bound to the host implementation the plan
  froze, approved separately from its permission, digest unchanged.
* **Permissions**: the receipt's decisions carried unchanged; `once` is refused
  rather than widened.
* **Selected files**: only `file_<32 hex>` capabilities of this session, only
  those the task names, and only when `files.read` is granted.

## 6. Live progress

* **Source of truth**: the runner's own hash-chained audit, observed as events
  are appended, sent as `execution.progress` snapshots (ids and counts only) and
  stored on the run record; the final snapshot is kept.
* **Node states**: completed / active / failed / skipped node ids, mapped onto
  the package's validated stages.
* **Workers**: one row per spawned worker — role, node, state, model and tool
  calls, duration; each fan-out stage shows its workers.
* **Model counters**: calls started and completed. **Tool counters**: calls
  started and completed, and remote calls. **Usage**: tokens so far against
  the limit. **Elapsed**: from the run's start, ticking each second.

## 7. The real UI run

| | |
|---|---|
| Research question | *What defenses have been proposed against prompt injection attacks on LLM-integrated applications?* (`seeds: []`, `documents: {}`, `mode: live`) |
| Package | `org.webagents.literature-review` 0.2.2, digest `19de8c9e…c634` |
| Run Plan | `rp_15289a122ea34ef1ba145f5e4ad38b1a`, `sha256:523a094c204c776f435a434b7caad5ad3c274bf6cab32b14d1f205ee80c9e15b` |
| Run | `run_dbb6d0edf5104e6dad4beaa814e9d1d2`, started from the page's **Run Research** button at 22:50:11Z |
| Model | `ollama/qwen3:30b` — 17 calls, every one on the planned model |
| Status | **completed** — *✓ Research completed* |
| Duration | 27 min 10 s (22:50:11Z → 23:17:21Z) |
| Nodes | 56 node executions completed (18 graph nodes and their map items), 13 document steps skipped (no PDFs given) |
| Workers | 26 spawned; peak parallelism 3 (the package's and host's bound) |
| Tool calls | 9: 3 Crossref searches, 6 Citation Resolver calls (3 seed checks, 3 resolutions), 0 PDF reads |
| Tokens | 107,284 of 180,000; 9 remote calls of 45 |
| Cost | $0 (complete: 17 of 17 calls reported a cost) |
| Audit | 469 events, chain valid, final `sha256:b9eb31dd…0afd` |

Progress observed on the page, once a minute: Planning (with 3 citation
workers) → Scholarly search (3 search workers) → Screening (7 screening workers)
→ Citations (3) → Evidence extraction (3) → Synthesis → Writing → Verification.
The counters rose from zero to 16 model calls, 9 tool calls and 92,956 tokens
while Verification ran, and to 17 calls and 107,284 tokens at completion.

## 8. Final output

* **Included papers (2)**: Panterino & Fellington, *Dynamic Moving Target
  Defense for Mitigating Targeted LLM Prompt Injection* (2024,
  `10.36227/techrxiv.171822345.56781952/v1`); Dahiya & Shen, *A Hybrid Prompt
  Injection Defense Framework Using Rule-Based and Learned Detection with
  Policy-Driven Sanitization* (2026, `10.2139/ssrn.7366618`). Both resolved by
  the Citation Resolver against Crossref.
* **Evidence items**: 6 extracted from 3 papers; 5 cited and in the evidence
  table (`…/v1:e1`, `…/v1:e2`, `ssrn.7366618:e1`–`e3` — globally unique, the
  A1 contract visible in a live run). The sixth, from a paper on attack
  mechanisms rather than defenses, supported no claim; the package's contract
  puts only *cited* evidence in the table, and it stays in the run's state.
* **Claims**: 2, both verified *supported* against their evidence.
* **Unresolved**: 0.
* **Related Work**: two themed paragraphs — moving-target defenses (parameter
  perturbation, model re-initialization, dynamic context adjustment; lower
  attack success at modest overhead) and a hybrid rule-based + learned
  detection framework with policy-driven sanitization (100% benign allow, 0%
  false positives, 0% missed attacks on its evaluation).
* **Observation**: the prose omits the bibliography reference markers the
  writing skill asks for (the accepted 0.2.1 run had them). Claims, evidence
  and bibliography are linked in the structured outputs and checked there;
  prose is not machine-checked. Model behaviour, not a structural failure.

Coverage is thin for this topic because search is Crossref-only — see §15.

## 9. Artifacts

| File | Bytes | SHA-256 (prefix) |
|---|---|---|
| `related-work.md` | 623 | `285afccd9862a102` |
| `bibliography.json` | 6,092 | `da5e65e2ce24b8a2` |
| `evidence-table.json` | 4,610 | `10840d1c7f5e4db2` |
| `unresolved.json` | 3 | `37517e5f3dc66819` |
| `verification.json` | 603 | `6b65b9dbd3dfbde9` |
| `result.json` | 506,225 | `eae834c4dc40d534` |
| `audit.json` | 305,988 | `dfab195a12a55a0f` |
| `usage.json` | 3,631 | `2a106f25c433c892` |
| `provenance.json` | 239 | `547b026dd5fb34bc` |
| `run.json` | 19,256 | `55460c07d321d5ef` |

All ten are listed on the page with View and Download. `related-work.md`,
`run.json`, `audit.json` and `result.json` were downloaded through the page and
are byte-identical to the run directory; the page reported *SHA-256 verified*
for each. `audit.json` viewed as *Showing the first 48.0 KiB of 298.8 KiB.
Download has the whole file, verified.* An independent check of the run's own
files passed 28 of 28 (audit chain, model identity against the audit, output
schema, evidence id contract, cited-evidence and cited-paper tables, claim
links, citation provenance, tool counts, bounds, artifact hashes).

## 10. Cancel test

Real cancellation was exercised twice from the page, both on real runs of the
same plan shape. On the final build: `run_5d000b444f724b8491450238352a9696`
started 22:48:35Z; by 22:49:15Z Planning was done and Scholarly search was
running three workers (1 model call, 3 tool calls, 2,229 tokens); **Cancel** at
22:49:17Z; *Run cancelled* at 22:49:20Z, stopped at *Scholarly search (search) /
search-query*, with result, audit, usage and provenance written and no package
export. The runner process (a child of the Gateway, pid 80360) was gone
immediately afterwards (`ps -A`), and the interrupted stage shows *cancelled*,
not *failed*. An earlier exploratory run (`run_c666…`) was cancelled during a
model call; that call's 32,951-token reservation was settled as spent (the
runtime cannot know what a cancelled call consumed) and `reserved_tokens`
returned to 0.

After the post-run fixes, the same path was repeated on the final build:
`run_bd0ddd025b3d4a0db091aa581b78170e` started from the page at 02:56:54Z,
showed Scholarly search with three workers within a minute, and was cancelled
at 02:58:12Z — *Run cancelled* one second later, *Stopped at Deduplicate
candidates (normalize), in Screening*, no runner process left.

## 11. Reload test

At 22:53:43Z, 3 min 31 s into the full run, the page was reloaded. By 22:53:45Z
it had reconnected to the same run — same runner process, elapsed 03:34 and
counting, stages and counters intact — because `execution.status` returns the
active run in full and the page adopts it for its open session. After each
Gateway restart the finished runs came back under **Recent runs**, marked *From
a previous Gateway session* and read-only (no Run, no New run). On the final
build the reload was repeated during `run_bd0d…`: reloaded at 02:58:09Z
(elapsed 01:09), reconnected by 02:58:11Z to the same runner (elapsed 01:17).

## 12. Security

Probed through `plugins.sessionAction` — the Gateway method the page itself uses
— with payloads the page would never send: 39 while the run was in flight, 8
after it with a fresh authorized session, 6 on authorization and credentials,
and the 39 again on the final build. Every probe was refused at the intended
layer, no probe started a run, and the plan was byte-identical afterwards.

| Requirement | Evidence |
|---|---|
| No arbitrary model | `model`/`modelBinding` in a start → Gateway `INVALID_REQUEST`; preparing a plan on `evil/not-offered` → `model_unknown` |
| No arbitrary tool binding | `toolId`/`bindings` in a start → `INVALID_REQUEST`; `tools.call`, `shell.run`, `execution.exec`, `http.request` → unknown operation |
| No arbitrary URL | `url` in a start → refused; `http://` and `file:` package URLs → `url_rejected` |
| No arbitrary local path | `path`/`executable`/`archivePath`/`command` → refused; a path as a file id → pattern; real `.pdf` and `.agent.pkg` files outside the roots, traversal to them, a relative path → `not_allowed`; a forged or unattached file capability → refused |
| No artifact traversal | `../run.json`, `/etc/passwd`, `..`, nested and percent-encoded names → pattern; an unlisted name or unknown run → `execution_unknown` |
| No skipped authorization | an unauthorized session is not ready; its start → `run_plan_absent`; a plan on a never-issued receipt → refused |
| No stale plan | re-authorizing discards the old plan; starting it → refused; a wrong hash or unknown plan → refused |
| No credential leak | the Gateway token and four other local secrets (browser relay secret, Mac control token, config journal key, the signing key) appear in none of 30 operation outputs nor on the page; no bearer or API-key pattern |
| Run Plan immutable | unchanged after every probe; `execution.performed` stays false; a run is its own record |
| One run at a time | a second start while one ran → `execution_active` |

The acceptance also found and fixed **three outputs that outgrew OpenClaw's
plugin JSON limits** (4,096 nodes, 65,536-character strings, 256 KiB): the run
list after nine runs, the view of a 300 KiB audit, and 256 KiB download slices.
Each failed closed as `INVALID_OUTPUT`; none leaked. They are now fitted, and
`test/host-bounds.test.ts` checks every such output with the host's own check
as the oracle.

## 13. Tests

| Suite | Result |
|---|---|
| `agentpkg` pytest | **755 passed, 1 skipped** (opt-in installed-OpenClaw discovery), 1 intentional duplicate-zip warning |
| Plugin vitest | **391 passed**, 20 files |
| `citation-resolver` | 132 passed (unchanged) |
| `scripts/verify_workflow.py` | passed — both packages, deterministic build/sign/unpack, shipped signatures, legacy signature preserved |
| `scripts/verify_browser.py` | passed |
| `scripts/verify_literature_022.py` | passed |
| ruff check / format | clean (102 files) |
| TypeScript | `tsc` clean |
| `npm run verify` | passed — build, validate, pack, isolated install, 391 tests |

## 14. Demo procedure

Follow the [README's demo section](../README.md#demo-the-literature-review-agent-from-the-browser):
Gateway running → `ollama list` shows `qwen3:30b` → `openclaw dashboard` →
**Agent Browser** → open `dist/literature-review.agent.pkg` → permissions (4 ×
session, `files.pdfs` deny) and 3 tool approvals → **Authorize** → **qwen3:30b**
→ **Prepare run** → type the question → **Run Research** → watch the stages →
**Recent runs** / result / artifacts / **Technical details**. Budget ~30–40
minutes per run and start within ~44 minutes of opening the package; pre-start
one before presenting and show a completed real run for the results.

## 15. Post-demo work

* **Scholarly-search federation**: Crossref + arXiv + OpenAlex (optionally
  Semantic Scholar) as host implementations of the same abstract
  `scholarly-search` capability — recent-AI and arXiv-first coverage, better
  abstracts, source redundancy, no package change. This run's two papers show
  why.
* **Execution profiles**: `conversation.v0`, `service.v0`; today `workflow.v0` is
  one input → one run → one result.
* NANDA discovery and remote locators, Muse / Instinct, Maritime / sandboxed
  execution, persistent authorization (*Always*), richer evals and
  attestations, a package update UX, provider redundancy.
* Smaller: a machine check that Related Work cites its bibliography (§8); a
  fitted package view for packages near every list bound at once; streaming
  instead of polling.

## 16. Verdict

The core demo is fully functional through the real architecture: a complete
Literature Review run was started, observed, reloaded and inspected from the
Agent Browser page, cancellation works from the page, artifacts download
verified, and every authority boundary held under hostile probes.

MILESTONE 3C AGENT-NATIVE BROWSER DEMO: PASSED
