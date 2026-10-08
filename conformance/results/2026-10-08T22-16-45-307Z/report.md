# Conformance report

Generated 2026-10-08T22:16:45.307Z at commit `83451bab704db903dfdcf0b2134953598e0a2004`.
agentpkg 0.2.2 (agent.pkg 0.1, workflow.v0); Python 3.13.5; chrome-agent-browser 0.1.0; Node v26.9.0; darwin-arm64.

**27 of 27 cases passed** (290 of 290 checks).

| Case | Kind | Result | Checks |
|---|---|---|---|
| `webair-0.4.0/fixture` | fixture parity | pass | 16/16 |
| `webair-0.4.0/scenario-hero` | fixture parity | pass | 16/16 |
| `webair-0.4.0/scenario-checked-bag` | fixture parity | pass | 16/16 |
| `webair-0.4.0/scenario-fare-rules` | fixture parity | pass | 16/16 |
| `webair-0.4.0/scenario-other-route` | fixture parity | pass | 16/16 |
| `webair-0.4.0/scenario-no-results` | fixture parity | pass | 16/16 |
| `webair-0.4.0/scenario-refused` | fixture parity | pass | 16/16 |
| `webair-0.4.0/scenario-unsupported` | fixture parity | pass | 16/16 |
| `webair-0.4.0/search-tools-only` | fixture parity | pass | 16/16 |
| `literature-review-0.2.5/fixture` | fixture parity | pass | 17/17 |
| `meeting-agenda-0.2.2/fixture` | fixture parity | pass | 13/13 |
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

## `webair-0.4.0/scenario-hero`

WebAir 0.4.0, scenario hero

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

## `webair-0.4.0/scenario-checked-bag`

WebAir 0.4.0, scenario checked-bag

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

## `webair-0.4.0/scenario-fare-rules`

WebAir 0.4.0, scenario fare-rules

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

## `webair-0.4.0/scenario-other-route`

WebAir 0.4.0, scenario other-route

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

## `webair-0.4.0/scenario-no-results`

WebAir 0.4.0, scenario no-results

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

## `webair-0.4.0/scenario-refused`

WebAir 0.4.0, scenario refused

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

## `webair-0.4.0/scenario-unsupported`

WebAir 0.4.0, scenario unsupported

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
