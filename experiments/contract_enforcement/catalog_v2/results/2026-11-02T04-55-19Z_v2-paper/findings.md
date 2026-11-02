# Findings: catalog v2, paper preset (`2026-11-02T04-55-19Z_v2-paper`)

Written by hand after the run (D-304). Every figure is in this directory's `table.md`,
`summary.json` and `unexpected.json`; this file names cases and codes, never a rate.

## Product defects

**None.** The full profile has no silent violation, no incidental failure and no false reject in
either runtime, and every explicit block carries the code (and reason) the catalog expected a priori
(`unexpected.json`: `full_*` lists empty; `summary.json`: `code_accuracy_full`). No BACKLOG defect
entry is needed (D-304).

## Each ablated profile exposes its family on both runtimes

`summary.json` → `exposure` lists, per profile and runtime, the cases whose primary guard the
profile removes, how many became silent, and which backstop blocked the others. Every profile has
silent cases in both runtimes. The cases a backstop still caught:

| Profile | Case(s) | Caught by (code) | Why |
|---|---|---|---|
| −Proposal check | `M.n19-lower-index-first` | `schema_validation` (both) | its second proposal fails the type's own field schema, which the profile keeps |
| −Module gate | `C.module-import` | `compute_error` (both) | the engine cannot instantiate a module whose import nothing satisfies |
| −Module gate | `C.module-two-memories`, `C.module-shared-memory`, `C.module-tail-call` | `module_invalid` (agentpkg only) | agentpkg's wasmtime configuration refuses multi-memory, threads and tail calls at compile; in the core, V8 compiles two memories and a tail call (silent there) and a shared memory fails with an unclassified error (a runtime difference, DESIGN_v2 §9) |
| −Compute limits | `C.output-zero-length`, `C.output-out-of-range` | `compute_error` (both) | both engines clamp the read; the output then fails as not JSON |
| −Consent gate | `V.transcript-accepts-denied` | the plan's denial (`consent.decided` by the plan; both) | the plan pre-decides the step of a denied permission and the graph's path avoids the tool |
| −Declaration validation | the `backstops` of `exposure.decl_validation` (per runtime) | their codes there | the runtime's own later checks: the consent gate (`permission_denied`, `consent_not_authorized`), the transcript check, the conversation's budget, schema validation, the execution layer's page ceiling, the CLI's profile check, the network runner's write view |

Not caught and not silent (`INCIDENTAL_FAILURE`, the `other` lists): with the declaration validators
removed, several malformed networks and modules make the runtime fail with an unclassified error
(listed per runtime; the core's module facts refuse two of agentpkg's with
`module_export_missing`); with the module gate removed, a module missing its memory export or its
allocator fails as an engine fault in both runtimes, a wrong run signature does in agentpkg (the
core runs it: silent there) and a shared memory does in the core. These show what the
validators prevent; B-258 proposes classified refusals at the point of use.

## Cases no profile removes by design

Kept guards (`ablation_removes_guard: false`, DESIGN_v2 §5): `memory_declarations` (N10, N16, N17,
N21, `agent-family-read`), SIMD and atomic instructions (`module-simd`, `module-threads`), the
route's enum (`target-not-in-enum`), the transcript's unknown step (`transcript-step-unknown`), the
container rules and integrity statement (`module-too-large`, `module-bad-magic`,
`tampered-archive`). Cases whose primary guard is a mechanism no profile targets (the permission
mediator, per-tool and per-role budgets, answer and state schemas, engine traps) are blocked under
every profile in both runtimes (their rows in `raw/`).

## Cross-profile exposure

One case is exposed by a profile other than its primary one: `C.module-hash-mismatch` under
−Declaration validation (both runtimes). The hash check sits in the compute declarations
validator, which that profile removes; −Module gate patches the same check.
