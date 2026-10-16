# Conformance report

Generated 2026-10-16T02:49:43.223Z at commit `2a4b0cd97dc277822d8c52eed0b05a8aba146d90`.
agentpkg 0.4.0 (agent.pkg 0.1, workflow.v0); Python 3.13.5; chrome-agent-browser 0.2.0 (runtime 0.4.0); Node v26.9.0; darwin-arm64.

**72 of 72 cases passed** (868 of 868 checks).

| Case | Kind | Result | Checks |
|---|---|---|---|
| `webair-0.4.0/fixture` | fixture parity | pass | 16/16 |
| `webair-0.5.0/fixture` | fixture parity | pass | 16/16 |
| `webair-0.5.0/scenario-hero` | fixture parity | pass | 16/16 |
| `webair-0.5.0/scenario-checked-bag` | fixture parity | pass | 16/16 |
| `webair-0.5.0/scenario-fare-rules` | fixture parity | pass | 16/16 |
| `webair-0.5.0/scenario-other-route` | fixture parity | pass | 16/16 |
| `webair-0.5.0/scenario-no-results` | fixture parity | pass | 16/16 |
| `webair-0.5.0/scenario-refused` | fixture parity | pass | 16/16 |
| `webair-0.5.0/scenario-unsupported` | fixture parity | pass | 16/16 |
| `webair-0.5.0/scenario-no-departure` | fixture parity | pass | 16/16 |
| `webair-0.4.0/search-tools-only` | fixture parity | pass | 16/16 |
| `literature-review-0.2.5/fixture` | fixture parity | pass | 17/17 |
| `literature-review-0.2.7/fixture` | fixture parity | pass | 18/18 |
| `literature-review-0.2.6/fixture` | fixture parity | pass | 17/17 |
| `meeting-agenda-0.2.2/fixture` | fixture parity | pass | 13/13 |
| `webair-0.6.0/fixture` | fixture parity | pass | 17/17 |
| `webair-0.6.0/scenario-hero` | fixture parity | pass | 17/17 |
| `webair-0.6.0/scenario-checked-bag` | fixture parity | pass | 17/17 |
| `webair-0.6.0/scenario-fare-rules` | fixture parity | pass | 17/17 |
| `webair-0.6.0/scenario-other-route` | fixture parity | pass | 17/17 |
| `webair-0.6.0/scenario-no-results` | fixture parity | pass | 17/17 |
| `webair-0.6.0/scenario-refused` | fixture parity | pass | 17/17 |
| `webair-0.6.0/scenario-unsupported` | fixture parity | pass | 17/17 |
| `webair-0.6.0/scenario-no-departure` | fixture parity | pass | 17/17 |
| `literature-review-0.2.8/fixture` | fixture parity | pass | 19/19 |
| `literature-review-0.2.8/memory` | fixture parity | pass | 19/19 |
| `memory-probe/granted-sealed-value` | fixture parity | pass | 13/13 |
| `memory-probe/custom-type-proposal` | fixture parity | pass | 13/13 |
| `memory-probe/custom-type-read` | fixture parity | pass | 13/13 |
| `memory-probe/fixture` | fixture parity | pass | 13/13 |
| `answer-checks/fixture` | fixture parity | pass | 13/13 |
| `tampered-bytes/crc` | refusal | pass | 8/8 |
| `tampered-bytes/content` | refusal | pass | 8/8 |
| `unpinned-key` | refusal | pass | 8/8 |
| `wrong-key` | refusal | pass | 8/8 |
| `missing-approval` | refusal | pass | 14/14 |
| `denied-permission/optional` | refusal | pass | 14/14 |
| `denied-permission/optional-in-a-map` | documented difference | pass | 9/9 |
| `denied-permission/required` | documented difference | pass | 4/4 |
| `schema-invalid-output` | refusal | pass | 14/14 |
| `budget-overrun` | refusal | pass | 14/14 |
| `answer-check-refused` | refusal | pass | 14/14 |
| `memory/n1-type-undeclared` | refusal | pass | 13/13 |
| `memory/n2-sealed-field` | refusal | pass | 13/13 |
| `memory/n4-agent-write-over-cap` | refusal | pass | 14/14 |
| `memory/n5-newer-runtime` | refusal | pass | 4/4 |
| `memory/n6-view-mismatch` | refusal | pass | 4/4 |
| `memory/n7-two-agent-writes` | refusal | pass | 14/14 |
| `memory/n8-update-not-granted` | refusal | pass | 13/13 |
| `memory/n9-link-to-no-proposal` | refusal | pass | 13/13 |
| `memory/n10-publisher-scoped` | refusal | pass | 4/4 |
| `memory/n11-sealed-value-to-a-model` | refusal | pass | 9/9 |
| `memory/n12-write-without-export` | refusal | pass | 4/4 |
| `memory/n13-sealed-value-in-a-proposal` | refusal | pass | 13/13 |
| `memory/n14-link-not-granted` | refusal | pass | 13/13 |
| `memory/n14-body-link-not-granted` | refusal | pass | 13/13 |
| `memory/n15-supersedes-link` | refusal | pass | 13/13 |
| `memory/n16-custom-type-shadows-sealed` | refusal | pass | 4/4 |
| `memory/n17-custom-type-reserved` | refusal | pass | 4/4 |
| `memory/agent-family-read` | refusal | pass | 4/4 |
| `memory/n19-lower-index-first` | refusal | pass | 13/13 |
| `memory/n21-custom-type-open` | refusal | pass | 4/4 |
| `memory/n22-marker-line` | refusal | pass | 13/13 |
| `memory/m36-sealed-value-to-a-tool` | refusal | pass | 14/14 |
| `memory/m36-two-sealed-values` | refusal | pass | 14/14 |
| `memory/n3-read-denied` | refusal | pass | 14/14 |
| `once-overused` | documented difference | pass | 4/4 |
| `control-plane/stale_trust_revoked` | refusal | pass | 2/2 |
| `control-plane/stale_tool_changed` | refusal | pass | 2/2 |
| `control-plane/once_replayed` | refusal | pass | 2/2 |
| `control-plane/profile_search` | control-plane parity | pass | 2/2 |
| `control-plane/partial_approvals_without_profile` | documented difference | pass | 3/3 |

## `webair-0.4.0/fixture`

WebAir 0.4.0, its fixture input, every tool approved

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/fixture`

WebAir 0.5.0, its fixture input, every tool approved

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/scenario-hero`

WebAir 0.5.0, scenario hero

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/scenario-checked-bag`

WebAir 0.5.0, scenario checked-bag

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/scenario-fare-rules`

WebAir 0.5.0, scenario fare-rules

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/scenario-other-route`

WebAir 0.5.0, scenario other-route

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/scenario-no-results`

WebAir 0.5.0, scenario no-results

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/scenario-refused`

WebAir 0.5.0, scenario refused

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/scenario-unsupported`

WebAir 0.5.0, scenario unsupported

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.5.0/scenario-no-departure`

WebAir 0.5.0, scenario no-departure

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.4.0/search-tools-only`

WebAir 0.4.0, only the two search tools approved (the 'search' profile's tools)

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `literature-review-0.2.5/fixture`

Literature Review 0.2.5, its fixture input

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export bibliography.json
- ✓ export evidence-table.json
- ✓ export related-work.md
- ✓ export unresolved.json
- ✓ export verification.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked
- Note: Allowlisted (D-063), printed: synthetic tokens python=35732 node=35732.

## `literature-review-0.2.7/fixture`

Literature Review 0.2.7 (ids before any model, verdict-only screening, answer checks, papers-found; T15), its fixture input

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export bibliography.json
- ✓ export evidence-table.json
- ✓ export papers-found.json
- ✓ export related-work.md
- ✓ export unresolved.json
- ✓ export verification.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked
- Note: Allowlisted (D-063), printed: synthetic tokens python=26410 node=26410.

## `literature-review-0.2.6/fixture`

Literature Review 0.2.6 (screening jobs built from the candidates, T10), its fixture input

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export bibliography.json
- ✓ export evidence-table.json
- ✓ export related-work.md
- ✓ export unresolved.json
- ✓ export verification.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked
- Note: Allowlisted (D-063), printed: synthetic tokens python=34116 node=34116.

## `meeting-agenda-0.2.2/fixture`

Meeting Agenda 0.2.2, its fixture input

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export agenda.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/fixture`

WebAir 0.6.0 (the travel profile from memory, a remember step after a quote; T20), its fixture input, the search tools approved: the empty proposals document

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/scenario-hero`

WebAir 0.6.0, scenario hero

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/scenario-checked-bag`

WebAir 0.6.0, scenario checked-bag

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/scenario-fare-rules`

WebAir 0.6.0, scenario fare-rules

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/scenario-other-route`

WebAir 0.6.0, scenario other-route

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/scenario-no-results`

WebAir 0.6.0, scenario no-results

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/scenario-refused`

WebAir 0.6.0, scenario refused

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/scenario-unsupported`

WebAir 0.6.0, scenario unsupported

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `webair-0.6.0/scenario-no-departure`

WebAir 0.6.0, scenario no-departure

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export answer.md
- ✓ export booking.json
- ✓ export fare-rules.json
- ✓ export proposals.json
- ✓ export search.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `literature-review-0.2.8/fixture`

Literature Review 0.2.8, its fixture input (memory off): 0.2.7's review and an empty proposals document

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export bibliography.json
- ✓ export evidence-table.json
- ✓ export papers-found.json
- ✓ export proposals.json
- ✓ export related-work.md
- ✓ export unresolved.json
- ✓ export verification.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked
- Note: Allowlisted (D-063), printed: synthetic tokens python=26676 node=26676.

## `literature-review-0.2.8/memory`

Literature Review 0.2.8 with its memory switches on: the replayed research profile shapes the plan, the notes are read and staged, one research.review is proposed derived from the profile (grants from the fixture's views, D-230)

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export bibliography.json
- ✓ export evidence-table.json
- ✓ export papers-found.json
- ✓ export proposals.json
- ✓ export related-work.md
- ✓ export unresolved.json
- ✓ export verification.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked
- Note: Allowlisted (D-063), printed: synthetic tokens python=28111 node=28111.

## `memory-probe/granted-sealed-value`

M-36 and D-230: the probe's replayed legacy identity e-mail sent to a tool that links the permission it was granted under (in fixture mode the replayed answer is held as granted under its tool's permission)

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export proposals.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `memory-probe/custom-type-proposal`

M-18 and D-228: the probe proposes its own custom type by its local id (the only form the proposals schema admits); the host resolves it through the package's aliases

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export proposals.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `memory-probe/custom-type-read`

M-12, M-18 and D-228: a memory.read of the probe's own custom type by its local id, granted from the replayed view, and an update of the record it read

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export proposals.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `memory-probe/fixture`

The memory probe (every memory.v0 permission: a record view, a legacy identity, the agent document, a create and an update proposal, a sealed value sent where its grant goes; throwaway key)

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export proposals.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `answer-checks/fixture`

Answer checks that hold (D-150): Meeting Agenda rebuilt with a relation, a sum and an equality on its model answers, runtime minimum 0.3.0 (throwaway key)

- ✓ exit status 0 in both
- ✓ success report (minus output directory and usage)
- ✓ file set
- ✓ interpreter names its runtime
- ✓ usage.json equals its own result section
- ✓ provenance.json equals its own result section
- ✓ usage (workers folded by role)
- ✓ result.json without the audit
- ✓ export agenda.json
- ✓ audit.json equals the result's audit
- ✓ audit length
- ✓ audit backbone and per-wave multisets
- ✓ each audit chain is linked

## `tampered-bytes/crc`

One byte of graph.json changed in transit; the archive's CRC no longer matches

- ✓ verify: refused with status 2 in both
- ✓ verify: refusal code archive_crc_mismatch
- ✓ verify: identical message
- ✓ verify: nothing written
- ✓ run: refused with status 2 in both
- ✓ run: refusal code archive_crc_mismatch
- ✓ run: identical message
- ✓ run: nothing written

## `tampered-bytes/content`

The same change with a recomputed CRC: the integrity statement no longer matches

- ✓ verify: refused with status 2 in both
- ✓ verify: refusal code integrity_mismatch
- ✓ verify: identical message
- ✓ verify: nothing written
- ✓ run: refused with status 2 in both
- ✓ run: refusal code integrity_mismatch
- ✓ run: identical message
- ✓ run: nothing written

## `unpinned-key`

A valid signature by a key the host did not pin (Literature Review checked against the Meeting Agenda key)

- ✓ verify: refused with status 2 in both
- ✓ verify: refusal code publisher_key_not_pinned
- ✓ verify: identical message
- ✓ verify: nothing written
- ✓ run: refused with status 2 in both
- ✓ run: refusal code publisher_key_not_pinned
- ✓ run: identical message
- ✓ run: nothing written

## `wrong-key`

A signature that claims the pinned Meeting Agenda key, which never made it

- ✓ verify: refused with status 2 in both
- ✓ verify: refusal code signature_invalid
- ✓ verify: identical message
- ✓ verify: nothing written
- ✓ run: refused with status 2 in both
- ✓ run: refusal code signature_invalid
- ✓ run: identical message
- ✓ run: nothing written

## `missing-approval`

Literature Review with every permission granted and no tool approved

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: at node search
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `denied-permission/optional`

WebAir 0.4.0 asked to quote, its personal tools approved and the optional passenger-identity permission denied

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: at node passenger
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `denied-permission/optional-in-a-map`

Literature Review with its optional files.pdfs permission denied and the paper reader approved: the refusal happens inside a concurrent map

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: at node screening
- ✓ run: identical message
- ✓ run: file set
- ✓ run: outcome (status, error_code)
- ✓ run: provenance
- ✓ run: audit backbone (runtime and workflow events, commits)
- ✓ run: each audit chain is linked
- Note: A failure inside a concurrent wave (D-092): siblings' partial progress is the scheduler's, so their events and reserved tokens are not compared; tokens python=32175 node=6350.

## `denied-permission/required`

WebAir 0.4.0 with its search tools approved and the required network permission they travel under denied

- ✓ agentpkg run: refused at the first use
- ✓ chrome CLI: refused before the run, nothing written
- ✓ execution layers: both refuse execution_permission_denied
- ✓ execution layers: identical message
- Note: A recorded difference of the CLIs (D-091), not of the runtimes: agentpkg run says "workflow.v0 permission_denied at node search"; the Chrome CLI and both execution layers say "Required permission 'network.webair' is denied, so this package cannot run.".

## `schema-invalid-output`

A recorded model answer that its node's output schema refuses (rebuilt Meeting Agenda, throwaway key)

- ✓ run: refused with status 2 in both
- ✓ run: refusal code schema_validation
- ✓ run: at node plan
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `budget-overrun`

A package token budget below what its own fixture run needs (rebuilt Meeting Agenda, throwaway key)

- ✓ run: refused with status 2 in both
- ✓ run: refusal code budget_exhausted
- ✓ run: at node plan
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `answer-check-refused`

A recorded model answer that its node's answer check refuses (D-150): a non-conforming answer, never re-asked by a replay router (rebuilt Meeting Agenda, throwaway key)

- ✓ run: refused with status 2 in both
- ✓ run: refusal code model_error
- ✓ run: at node write
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n1-type-undeclared`

N1: a proposal of a type outside memory.write's resources

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n2-sealed-field`

N2: a proposal carrying a sealed field

- ✓ run: refused with status 2 in both
- ✓ run: refusal code schema_validation
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n4-agent-write-over-cap`

N4: an agent write over 32,768 characters fails the tool's input schema

- ✓ run: refused with status 2 in both
- ✓ run: refusal code schema_validation
- ✓ run: at node notes-write
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n5-newer-runtime`

N5: a package whose runtime minimum is newer than the runtime is refused by version before anything runs

- ✓ run: refused with status 2 in both
- ✓ run: refusal code runtime_too_old
- ✓ run: identical message
- ✓ run: nothing written

## `memory/n6-view-mismatch`

N6: a memory.read tool whose output schema is not the type's record view is not bound

- ✓ run: refused with status 2 in both
- ✓ run: refusal code binding_schema_mismatch
- ✓ run: identical message
- ✓ run: nothing written

## `memory/n7-two-agent-writes`

N7: a second agent write in one run is over its max_calls_per_tool of 1

- ✓ run: refused with status 2 in both
- ✓ run: refusal code budget_exhausted
- ✓ run: at node notes-write-again
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n8-update-not-granted`

N8: an update whose target the run was not granted

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n9-link-to-no-proposal`

N9: a link #9 in a document of two proposals

- ✓ run: refused with status 2 in both
- ✓ run: refusal code schema_validation
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n10-publisher-scoped`

N10: memory.scope publisher-scoped stays refused

- ✓ run: refused with status 2 in both
- ✓ run: refusal code agent_memory_scope
- ✓ run: identical message
- ✓ run: nothing written

## `memory/n11-sealed-value-to-a-model`

N11: a graph that routes a sealed value into a model step: the model call is refused before anything leaves

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: at node remember
- ✓ run: identical message
- ✓ run: file set
- ✓ run: outcome (status, error_code)
- ✓ run: provenance
- ✓ run: audit backbone (runtime and workflow events, commits)
- ✓ run: each audit chain is linked
- Note: A failure inside a concurrent wave (D-092): siblings' partial progress is the scheduler's, so their events and reserved tokens are not compared; tokens python=0 node=0.

## `memory/n12-write-without-export`

N12: memory.write declared without the proposals.json export

- ✓ run: refused with status 2 in both
- ✓ run: refusal code memory_proposal_undeclared
- ✓ run: identical message
- ✓ run: nothing written

## `memory/n13-sealed-value-in-a-proposal`

N13: a proposal whose unsealed field holds a sealed value the run holds; no proposals.json is written

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n14-link-not-granted`

N14: a proposal link to a record id the run was not granted

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n14-body-link-not-granted`

N14 (body): the same as an id wikilink in the proposal's body

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n15-supersedes-link`

N15: a proposal link with rel supersedes fails the proposals schema

- ✓ run: refused with status 2 in both
- ✓ run: refusal code schema_validation
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n16-custom-type-shadows-sealed`

N16: a custom type with a nested property named like a sealed starter field

- ✓ run: refused with status 2 in both
- ✓ run: refusal code custom_type_shadows_sealed_type
- ✓ run: identical message
- ✓ run: nothing written

## `memory/n17-custom-type-reserved`

N17: a custom type whose local id is a well-known id

- ✓ run: refused with status 2 in both
- ✓ run: refusal code custom_type_reserved
- ✓ run: identical message
- ✓ run: nothing written

## `memory/agent-family-read`

M-38: a memory.read naming a type of the agent. family (its binding would be a reserved agent tool's name)

- ✓ run: refused with status 2 in both
- ✓ run: refusal code memory_type_reserved
- ✓ run: identical message
- ✓ run: nothing written

## `memory/n19-lower-index-first`

N19: two refusable proposals, index 0's link before index 1's type: proposal by proposal

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n21-custom-type-open`

N21: a custom type whose schema is not closed

- ✓ run: refused with status 2 in both
- ✓ run: refusal code custom_type_schema_open
- ✓ run: identical message
- ✓ run: nothing written

## `memory/n22-marker-line`

N22: a proposal body holding the mirror marker as a whole line fails the proposals schema

- ✓ run: refused with status 2 in both
- ✓ run: refusal code schema_validation
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/m36-sealed-value-to-a-tool`

M-36: a granted sealed value sent to a tool that does not link its permission

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: at node echo
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/m36-two-sealed-values`

M-36: the echo carries the e-mail granted under the permission it links (the first hit) and a card token granted under another: every value is checked, so the card refuses it

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: at node echo
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `memory/n3-read-denied`

N3: a memory.read tool called under a denied permission stops at the mediator, before the tool

- ✓ run: refused with status 2 in both
- ✓ run: refusal code permission_denied
- ✓ run: at node profile
- ✓ run: identical message
- ✓ run: file set
- ✓ run: interpreter names its runtime
- ✓ run: usage.json equals its own result section
- ✓ run: provenance.json equals its own result section
- ✓ run: usage (workers folded by role)
- ✓ run: result.json without the audit
- ✓ run: audit.json equals the result's audit
- ✓ run: audit length
- ✓ run: audit backbone and per-wave multisets
- ✓ run: each audit chain is linked

## `once-overused`

The model permission granted once, to a graph that calls the model more than once

- ✓ agentpkg run: refused at the first use
- ✓ chrome CLI: refused before the run, nothing written
- ✓ execution layers: both refuse execution_grant_unsupported
- ✓ execution layers: identical message
- Note: A recorded difference of the CLIs (D-091), not of the runtimes: agentpkg run says "workflow.v0 permission_denied at node perspectives"; the Chrome CLI and both execution layers say "Permission 'model.reasoning' was granted 'once', but this workflow would use it up to 14 times. The run is refused rather than silently widening the decision to a whole session.".

## `control-plane/stale_trust_revoked`

Stale plan: the publisher's key is unpinned after the plan was prepared

- ✓ both drivers completed
- ✓ every step agrees (lease refusals by reason)
- Note: Raw lease refusal codes: lease 4: python run_plan_stale, node run_plan_stale.

## `control-plane/stale_tool_changed`

Stale plan: the host's implementation of a bound tool changed after the plan was prepared

- ✓ both drivers completed
- ✓ every step agrees (lease refusals by reason)
- Note: Raw lease refusal codes: lease 4: python run_plan_stale, node run_plan_stale.

## `control-plane/once_replayed`

Replayed once: a receipt that grants the purchase once is used for a second lease

- ✓ both drivers completed
- ✓ every step agrees (lease refusals by reason)
- Note: Raw lease refusal codes: lease 3: python run_plan_stale, node authorization_once_spent.

## `control-plane/profile_search`

Profile-scoped approvals: the 'search' profile, its two tools approved, the other five left unapproved and unimplemented

- ✓ both drivers completed
- ✓ every step agrees (lease refusals by reason)

## `control-plane/partial_approvals_without_profile`

The same decisions without a profile, every tool implemented: Python requires every declared tool approved, Chrome denies the unapproved ones (D-090)

- ✓ both drivers completed
- ✓ agentpkg behaves as D-090 records
- ✓ chrome-agent-browser behaves as D-090 records
- Note: A recorded difference (D-090), not a failure: each runtime is checked against its own documented behaviour.

What these results do and do not show: see `conformance/README.md`.
