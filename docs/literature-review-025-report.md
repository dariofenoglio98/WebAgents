# Literature Review 0.2.5 report

0.2.5 closes the one correctness gap left open by the [0.2.4 report](literature-review-024-report.md):
the exported evidence table could differ from the evidence the package extracted. It is a
package-only change; no runtime, plugin, skill, prompt, permission, tool contract, budget or
timing changed.

Evidence: [offline acceptance](../examples/verification/literature-review-025-offline.json) and
[recorded runs](../examples/verification/literature-review-025-recorded-runs.json).

## The defect

The verification skill asks the verifier to copy each cited evidence item exactly into
`evidence_table`. 0.2.4 exported that copy, and `validate-output` compared only five of its
fields (`paper_id`, `quote`, `scope`, `location`, `provenance`). Run
`run_41b9200000d14aa2b7970c1a819213e7` (`ollama/qwen3:30b`) completed with row
`10.2139/ssrn.7502658:e2` exported as `category: "method"` while its extraction record says
`"setup"`; the acceptance driver's full-row check failed on it.

Reproduced deterministically on the signed 0.2.4 archive with a scripted verifier: rewriting a
cited row's `category`, `text`, `support_strength` or `extraction_worker` gives a completed run
whose export carries the model's value (`test_the_same_rewrite_was_accepted_by_0_2_4`).

## The fix

| Change | Where |
|---|---|
| New `materialize-evidence` map reads only each verifier row's `evidence_id` and attaches that item's own extraction record with `lookup`; exactly one item must carry the id, or the run stops | `graph.json`, `schemas/evidence-ref.schema.json` |
| `assemble-output` exports the materialized table, not the verifier's copy | `graph.json` |
| `validate-output` keeps every comparison it had and adds a whole-row equality | `graph.json` |
| Verification role may write, and the coordinator read, `evidence_table` | `graph.json`, `schemas/research-state.schema.json` |

Which evidence is cited, and in which order, remains the verifier's decision. The approach is the
one 0.2.3 used for bibliography metadata and 0.2.4 for direct quotes: trusted data is copied by the
graph, and the final validator checks the copy.

## Verification

- 15 new regression cases (`agentpkg/tests/test_literature_025.py`): six field rewrites, the same
  rewrite accepted by 0.2.4, verifier selection and order, a row naming no extracted item (refused
  at `materialize-evidence`), an empty table, the strengthened check refusing a rewritten row on its
  own, every 0.2.4 assertion kept and only strengthened, nothing else changed, signed artifact
  equals source and replays, and the 0.2.4 archive preserved byte for byte.
- Offline signed-package acceptance (`scripts/verify_literature_025.py`): passed.
- Replay on the failing run's recorded state: the new step turns its 9 cited rows into exact
  extraction records in the verifier's order. The 0.2.4 final check accepts the table that run
  exported; the 0.2.5 check refuses it (`fields_do_not_match` on the whole-row comparison) and
  accepts the materialized one.

## Live status

Three real 0.2.4 runs exist, all started from the Agent Browser page, on the current package
digest, every call on the planned model, every audit chain valid:

| Run | Model | Independent checks |
|---|---|---|
| `run_41b92000…` | `ollama/qwen3:30b` | all pass except the evidence-table row fixed here |
| `run_a71e5b0f…` | `openai/gpt-5.6-luna` | all pass (12 evidence items, 10 claims, 3 bibliography entries exact; $0.20 reported cost) |
| `run_322dca77…` | `ollama/qwen3:30b` | all pass |

The hosted run postdates the 0.2.4 report, which recorded none. Its record proves the model that
answered and the per-call cost; it does not record the transport route, so whether the provider
constrained decoding remains unobserved, as the 0.2.4 report noted. Package correctness does not
depend on it: every structured output is validated before it is accepted.

0.2.5 has not yet run live. Its change executes after the last model call and leaves every model
input unchanged, so the recorded runs exercise the same model behaviour; a fresh run is still the
remaining confirmation.

## Identity

| | |
|---|---|
| Package | `org.webagents.literature-review` 0.2.5, agentpkg ≥ 0.2.1 |
| Digest | `cef9ebd68df9db3b36c1ffeac9069d734b0e41a40d58445aaba1a60eaac155b5` |
| Archive SHA-256 | `1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571` |
| Signer | `sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232` (unchanged; no rotation) |

`dist/literature-review.agent.pkg` is identical to `dist/literature-review-0.2.5.agent.pkg`. The
0.2.4 archive is preserved byte for byte.
