# Catalog v2: design

The design is T27's gate plan §1–§2 (approved 2026-10-28 as T30's design, D-320), with seven
deviations the T30 gate approved on 2026-11-01. This file says what changed from v1 and why, what
a case is, what each family checks, how the two runtimes are driven, what each profile removes,
what the oracle reads, and which expectations qualification corrected. D-300…D-304 record the
decisions.

## 1. What changed from v1, and why

v1 (`../DESIGN.md`) drives the frozen OpenClaw plugin and agentpkg through the plugin's backend
(D-029). That plugin runs packages up to WebAir 0.5.0 and knows nothing of memory, compute,
conversation or delegation, so v2 cannot be v1 with more templates. v2 keeps v1's **design**
(template → variant → matched control → oracle → ablation by exact source patch, outcomes and
metrics, a manifest before the first case, harness errors in every denominator) and replaces its
**driver**: both runtimes that run the new packages, in process, composed as their CLIs and
execution layers compose them, with observation-only seams.

| | v1 | v2 |
|---|---|---|
| Runtimes | the plugin + agentpkg's control plane and runner | agentpkg (Python reference) and the Chrome core (TypeScript), each separately |
| Families | F1…F8: verification, trust, authorization, compatibility, plan binding, mediation, output, resources | M memory confinement, C compute isolation, V consent integrity, N delegation bounds |
| Variants | templates over Meeting Agenda and Literature Review | the four conformance probes' named variants, two new cases, six parametric templates |
| Profiles | one per component (8) | one per **mechanism** (9), in both runtimes |
| Oracle | canaries and a state probe | four seams + the audit + the exports; boundary class `effect` or `admission` |
| Table | family × profile | family × profile × **runtime** |

Old and new series are never pooled (D-019): v2's numbers come only from its own result
directories at recorded commits.

## 2. What a case is

`cases_v2/base.py`. A case declares before anything runs: the probe and its change, how a host
runs it (mode `run`, `converse` or `execution_layer`; grants; approvals; host limits; transcript;
consent host; engine), what the full system is expected to do in each runtime (stage, code, the
reason when the case names one, a per-runtime override where D-091 records a difference of the
CLIs), the forbidden boundary (class and predicate), the primary guard, the profile that removes
it, whether that profile removes it at all, and the matched control. A **violation** has a matched
control in its family (many violations share one: the unmodified probe, or the family control it
varies); a **control** must complete.

**Boundary classes** (gate deviation 3). `effect`: the family's forbidden effect from T27's table
(a sealed value in a recorded model request or tool call; proposals offered for review; a module's
code executed though the gate, the permission or the host ceiling refuses it; a call past its
bound; out-of-contract output committed; a gated tool dispatched in a turn whose steps did not
accept each of its gated permissions; a second use of `once`; a turn started past the cap or the
budget; an activation, hop or edge use beyond the caps; a route outside the enum; a role's patch
outside its view; a network started without room for its worst case). `admission`: for a refusal
with no runtime effect of its own (a malformed fixture, a reserved id, a wrong minimum version),
the boundary is that the runtime executed a package the specification refuses (any seam call or
committed step). The table reports VDR and SVR over all violations and over `effect` violations
alone.

## 3. The families

| Family | Guarantee | Variants | Count (violations + controls) |
|---|---|---|---|
| **M** Memory confinement | a sealed value never leaves to a model or to a tool that does not link its permission; a proposal cannot name, link or update what the run was not granted; nothing is offered under a denied `memory.write` | the memory probe's 23 negative + 4 positive variants (`conformance/drivers/memory_probe.py`), N3 by its grants, the new denied-`memory.write` case | 25 + 4 |
| **C** Compute isolation | a module imports nothing, runs under the host's page, fuel and time bounds, and its output is used only through the node's contract | `examples/compute/cases/cases.json` (39 + 2; `engine-unavailable` kept: the drivers withhold the engine) | 39 + 2 |
| **V** Consent integrity | a gated tool runs only after an accepted step for each of its gated permissions in this turn; `once` is spent once per conversation; the turn cap and budgets hold; the card's facts are what the tool receives | `examples/conversation/cases/cases.json` (38 negative, 2 guards that work by denial, 3 controls; the silent and the invalid consent host included), the T24 sentence-vs-facts case | 41 + 3 |
| **N** Delegation bounds | activations stay within hop, edge and role caps; routes stay in the enum; a role writes only its view; the worst case is reserved before the first activation | `examples/network/cases/cases.json` | 42 + 4 |

**Parametric templates** (`cases_v2/parametric.py`, seeded, the same values on both runtimes):
compute pages (the host ceiling around echo's 16 declared pages), compute time (a node's wall bound
on a runaway module, with a conforming module under the same bound as control), conversation
tokens (around the 4,218 two turns need), conversation turns (around 3), network caps (hops,
an edge's uses, a role's activations, each around the fixture walk's need, the worst case
recomputed by the probe), the agent-write cap (around 32,768 characters). Values below the need are
violations, values at or above are controls; smoke draws one per template, qualification three,
the paper six (the turn domain 1–4 has four values).

**Guards that work by denial.** Three cases end in a completed run when the system holds: a step
the transcript does not decide (the host denies it), a `once` spent in an earlier turn (the plan
denies the step), proposals under a denied `memory.write` (offered to nobody). Their explicit block
is the audit's denial event (`consent.decided` denied by the host or the plan; `memory.proposed`
with `offered: 0`), named in the case. The T24 case completes too: the person accepts a card whose
sentence (model-written) disagrees with its facts (the graph's), and the tool must receive the
facts; its evidence is the decision the audit records, its boundary that the tool's arguments
differ from the card's facts.

## 4. The drivers (D-302)

Both drivers run in the worker process, observation only, one case per stdin line:

* **Python** (`harness_v2/driver_py.py`). One-shot: load, the CLI's profile check, `verify_package`
  under the throwaway key, then the production runner's admission
  (`ExecutionSession._begin` steps 2–3: `check_capabilities` with the approved tools standing in
  for their fixture bindings and the others denied, `normalize_grants`, the required model
  permissions), then `agentpkg run --mode fixture`'s composition (`fixture_adapters`,
  `cli_memory`, `run_workflow`) under the host limits as the runner hands them to the
  interpreter (`HostExecutionLimits.runtime_limits()` and the effective deadline). agentpkg's
  `ExecutionSession` itself has no fixture mode and talks to a bridge over inherited descriptors
  (gate deviation 2). Conversation: `agentpkg converse`'s composition (`check_transcript`,
  `fixture_adapters`, `cli_memory` per turn, `Conversation`).
* **Node** (`harness_v2/driver_node/driver.ts`, bundled per profile with the core's esbuild over a
  private copy of `chrome-agent-browser/src`, type-checked with its own tsconfig). One-shot:
  `cli-run.ts`'s fixture branch (`verifyWithTrustedKey`, `localExecutionPlan`,
  `ExecutionSession.begin` + `run` with the fixture adapters and the Node compute engine).
  Conversation: `cli-converse.ts`'s (`checkTranscript`, `Conversation`).
* Host limits: the execution host's defaults (both runtimes' defaults are the same document)
  unless a case states its own.
* **Seams**: the fixture router (task, input, taints, answer), the fixture tool handlers (tool,
  payload, taints), the compute engine (limits, outcome: reason, pages, elapsed, output), the
  consent host (step, permissions, text, facts, answer); each records and then returns or raises
  exactly what the wrapped object did. A test runs every probe with and without the wrappers and
  compares the result, the audit and the exports (`tests/test_drivers.py`).
* **Offline**: v1's `PythonGuard` in the Python worker; a twin in the Node driver over `net`,
  `dns`, `child_process` and `fetch`. A refused attempt makes the case a harness error.
* A case that does not answer in 300 s (above the longest deadline a probe declares, 120 s) kills its worker (harness error); the next case starts a new
  one. A test checks that a case's record does not depend on what ran before it.

## 5. The profiles (D-301)

`harness_v2/ablations.py`; the diffs are in each run's `patches/`. Every site matches exactly once
in its file; each profile has sites in both runtimes.

| Profile | Removes, in both runtimes | Kept, and why |
|---|---|---|
| full | nothing | |
| −Declaration validation | the compute, conversation and network validators, the memory graph check (M-38, M-67), the runtime minimum-version gate | `memory_declarations` (its result is what the graph check and every memory run consume; a memory run calls it again when it opens), container rules, the base validator |
| −Egress scan | M-36's scans of tool arguments and of model requests | the shared scanner (M-40 step 7 uses it) |
| −Proposal check | M-40: the document's schema (marker line, supersedes, shape), declared type, sealed fields, update target, links and body links, `#n`, sealed values; the denied `memory.write`'s `offered: 0` | |
| −Module gate | imports, memory count, declared maximum, the memory/alloc/node-function exports and signatures, the declared SHA-256, the shared-memory flag, `return_call`, the v128 type | SIMD and atomic **instructions** (refused inside the decoder; no single-line site), agentpkg's wasmtime configuration (the engine's own refusal of those features) |
| −Compute limits | the host page ceiling (runtime preflight, both execution layers, agentpkg's store limit), fuel, a call's wall bound, the output range and size | the node's own timeout (agentpkg's engine then stops at the node timeout plus its grace, B-224; the core terminates the call's Worker) |
| −Consent gate | V-9's gate, V-13's once spent across turns, the transcript's `consent_not_authorized` | within a turn, `once` and a denied grant (the permission mediator); the transcript's unknown-step check (its removal crashes, it does not run) |
| −Conversation bounds | the turn cap, the conversation's token and remote budgets, the per-tool caps across turns | each turn's own budget and per-turn caps |
| −Transition check | the hop cap, an edge's `max_uses`, a role's `max_activations`, a patch's write view | the route's enum (the route answer's own output schema), the read view (structural) |
| −Envelope reservation | R-22 (worst case against the package's budget at validation) and R-17 (the reservation before the first activation) | `network.started` is still recorded |

Mechanisms no profile removes, by design: the permission mediator, per-tool and per-role budgets,
schema validation of answers and of state, engine traps, the container rules and the integrity
statement. A case whose primary guard is one of them names no primary ablation; its row shows that
every profile leaves it blocked.

## 6. The oracle (D-303)

`harness_v2/oracle.py`. Two questions, separately: was the boundary reached (the case's predicate
over the seams, the audit and the exports), and what stopped the run (the refusal's classified
code, never its message; a loader refusal with no code prefix counts by the runtime's own error
type as `package_rejected`). Outcomes as v1: a violation is `SILENT_VIOLATION` if the boundary was
reached, else `EXPLICIT_BLOCK` for a classified refusal or a completed run with the case's denial
event, `HARNESS_ERROR` for a driver failure, a guard refusal or a completed run with neither,
otherwise `INCIDENTAL_FAILURE` (an unclassified crash, or `worker_error` without the case's
reason). A control is `BENIGN_ACCEPT` or `FALSE_REJECT`. Each explicit block also records whether
its code (and reason) is the one the catalog expected a priori, or a backstop's.

Metrics (`analyze_v2.py`): VDR, SVR, IFR, BAR with 95 % Wilson intervals, per family × profile ×
runtime, the effect-only VDR and SVR, paired contract correctness, code accuracy in the full
profile, and per ablated profile the cases it targets: how many became silent, and which backstop
blocked the others.

## 7. Findings (D-304)

A silent violation in the full profile of either runtime is a product defect: reproduced, written
to the run's `findings.md`, entered in BACKLOG and STATE, and fixed in a task of its own with a
version bump — never patched around in the harness and never explained away.

## 8. Qualification corrections

Qualification exists to find cases whose a-priori expectation was wrong. Each correction below
changed the catalog, never an outcome rule, and every one was made before any paper-preset run; no
production file was modified.

*Full profile, first pass (both runtimes agreed on every one):*

* Codes the execution layers give: `memory-over-host-cap` is refused by both execution layers
  before the run (`execution_compute_limit_exceeded`, D-091's N-17), `permission-denied` (compute)
  likewise (`execution_permission_denied`, N-19); on a host with no engine the Chrome execution
  layer refuses `compute_not_supported` where agentpkg's runtime refuses
  `compute_engine_unavailable` (a recorded per-runtime expectation).
* A runaway module under a fuel bound ends `fuel_exhausted` on wasmtime and `deadline` on V8, which
  meters no fuel (D-244): a per-runtime reason.
* Names: N1's reason is `memory_proposal_type_undeclared`; `agent-family-read` is refused
  `memory_type_reserved`; the second sealed value of `m36-two-sealed-values` comes from the tool
  `wallet`.
* The page predicate first counted the host's page bound given to the call; the boundary is the
  memory the module grew to (`compute_pages_above` reads the engine's report only).

*Parametric, first pass:* a role cap on Desk is reached by a fixed return route and is refused
`budget_exhausted` (as the list's `fixed-route-exhausted`), the hop and edge caps by the model's
route (`model_error`); an over-cap agent write carries no replayed tool answer (the loader checks
a fixture's tool inputs against the tool's schema, as N4 leaves it).

*All profiles, first pass (`--preset qualification`, scratch directory):*

* `transcript-accepts-denied` under −Consent gate completed without the boundary: the plan still
  denies the step whose permission is denied (it is not asked) and the graph's own path avoids
  the tool. The case names that denial event (`consent.decided` by the plan) as its block.
* `bound-exceeds-budget` was declared an `effect` case (the envelope over-committed at run time);
  at run time the worst case is computed under the budget and the budget still caps the walk, so
  R-22's refusal has no run-time effect of its own: reclassified `admission`.
* `node-on-worker` under −Declaration validation runs until the graph's 120 s deadline, which was
  also the case time limit: the time limit is now 300 s, above every probe's deadline, so the run
  ends by the runtime's own refusal.
* The smoke preset's compute pick is `module-no-memory-maximum` (the gate alone holds it in both
  runtimes); `module-import` is also caught by the engine's instantiation.

*Guards a profile keeps by design* (marked `ablation_removes_guard: false` before qualification,
from the survey of the sites): `memory_declarations` (N10, N16, N17, N21, `agent-family-read`),
SIMD and atomic instructions (`module-simd`, `module-threads`), the route's enum
(`target-not-in-enum`), the transcript's unknown step (`transcript-step-unknown`).

## 9. Observations from qualification (not corrections)

* `module-hash-mismatch` is exposed by −Declaration validation as well as by −Module gate: the
  hash check sits in the compute declarations validator (both profiles patch it out there).
* With the declaration validators removed, several malformed networks and modules make the
  runtime fail with an unclassified error (`worker_error`, a `KeyError` in the execution layer):
  `INCIDENTAL_FAILURE`, the validators' value made visible; the two runtimes differ in a few of
  these (the core's module facts refuse `module_export_missing` where agentpkg's raise).
* −Module gate exposes two cases in agentpkg and five in the core: agentpkg's wasmtime
  configuration refuses threads, tail calls and multiple memories again at compile
  (`module_invalid`), V8 compiles them.
* −Compute limits leaves the zero-length and out-of-range output cases blocked: the engines clamp
  the read and the output then fails as not JSON.
