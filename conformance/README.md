# Cross-runtime conformance suite

Two independent implementations execute `agent.pkg` packages: the Python reference runtime
([`agentpkg`](../agentpkg/)) and the TypeScript core of the
[Chrome Agent Browser](../chrome-agent-browser/). This suite runs both on the same signed packages,
with the same grants, approvals and inputs, and reports where they agree and where they do not. It
needs no network, model, provider key or signing key of ours: every run is fixture mode, and the
control-plane scenarios execute nothing.

```sh
python3.13 -m venv agentpkg/.venv && agentpkg/.venv/bin/python -m pip install -e ./agentpkg
(cd chrome-agent-browser && npm ci && npm run build)
node conformance/run.mjs                 # all cases; writes conformance/results/<timestamp>/
node conformance/run.mjs --only webair   # a subset (by case id); --no-write prints only
```

The runner exits 0 when every case passed, 1 otherwise, and writes `report.json` and `report.md`
either way (`--out DIR` for another directory). `AGENTPKG_CLI` and `AGENTPKG_PYTHON` override the
venv paths. A run takes about 25 seconds.

## What is compared

**Fixture parity** (15 cases): WebAir 0.4.0 on its fixture input and with only its two search
tools approved; WebAir 0.5.0 on its fixture input and on the eight inputs of
[`examples/webair-scenarios.json`](../examples/webair-scenarios.json) (0.5.0 added `no-departure`,
which 0.4.0's fixture cannot replay); Literature Review 0.2.5 and 0.2.6; Meeting Agenda 0.2.2; and
Meeting Agenda rebuilt with answer checks that hold (a relation, a sum and an equality on its model
answers, one of them in a map step; runtime minimum 0.3.0, D-150). `agentpkg run --mode fixture` and
`node chrome-agent-browser/dist/cli.js run --mode fixture`, compared under the rules of D-063:

| Compared exactly | Normalized first |
|---|---|
| exit status and the success report | the report's `output_directory` |
| the set of files written | — |
| `result.json` without its audit | `provenance.interpreter` (names the runtime) |
| every export (JSON parsed, text as bytes) | — |
| `usage`, `usage.json`, `provenance.json` | worker rows folded by role (`Role:7` → `Role:*`: spawn order is the scheduler's) |
| the audit: length, ordered backbone, per-wave multiset | run ids, timestamps, sequence numbers and hashes are dropped; each runtime's own chain must be linked |

The audit's **backbone** is every `runtime.*` and `workflow.*` event, `state.committed` with its
sorted node list, and `memory.cleared`, in order. Between two backbone events (one wave), the
other events are compared as a sorted multiset of their facts (action, node, role, task / tool /
permission, the decision of `permission.checked`, the tokens of `model.completed`), because a
wave's concurrent nodes record their events in whichever order their asynchronous validation
settles (D-060).

One allowlisted value, printed in every report rather than hidden: Literature Review's synthetic
`tokens`. Its fixture holds integral JSON floats (`1.0`) that Python writes as `1.0` and
JavaScript cannot tell from `1`; the runtimes agree today (35,732 each), and the allowlist exists
so that the day a request carries one the report says so instead of failing on a unit that is not a
bill (D-063).

**Refusals** (13 cases), each with an expected refusal in both runtimes:

| Case | Expected in both |
|---|---|
| tampered bytes, CRC wrong | `verify` and `run`: `invalid ZIP artifact: Bad CRC-32 for file 'graph.json'`, nothing written |
| tampered bytes, CRC recomputed | `content integrity mismatch: … changed=['graph.json']` |
| unpinned key | `publisher key is not the host-pinned trusted key` |
| wrong key (a signature claiming the pinned key) | `invalid Ed25519 publisher signature` |
| missing approval | `workflow.v0 permission_denied at node search`; the artifacts compared as above |
| denied optional permission | `permission_denied at node passenger`; artifacts compared |
| schema-invalid model output (via the fixture) | `schema_validation at node plan`; artifacts compared |
| budget overrun | `budget_exhausted at node plan`; artifacts compared |
| an answer check refuses a recorded model answer (D-150) | `model_error at node write` (`model.failed` reason `model_output_not_conforming`); a replay router never re-asks; artifacts compared |
| stale plan: publisher key unpinned after preparation | lease refused, stale reasons `publisher_trust_changed`, `publisher_not_trusted` |
| stale plan: a bound tool's implementation changed | lease refused, stale reason `tool_binding_changed` |
| replayed `once` | second lease refused, reason `authorization_once_spent` |
| profile-scoped approvals (`search`) | plan ready, two tools bound, five denied, lease issued |

The schema, budget and answer-check cases run Meeting Agenda rebuilt with one change each and signed
with a key generated for that run; the tampered and wrong-key archives are the shipped bytes with one
member changed ([`lib/zip.mjs`](lib/zip.mjs) rewrites them exactly as `agentpkg` writes archives).
Messages are compared byte for byte after the CLI prefix (`agentpkg:` / `agent-browser:`).

The control-plane cases cannot be reached through a CLI, so two drivers ask the same questions of
each runtime's control plane: [`drivers/control_plane.py`](drivers/control_plane.py) drives
`agentpkg.browser.ControlPlane`, [`drivers/control-plane.ts`](drivers/control-plane.ts) the Chrome
core functions the extension's service worker calls, both over the WebAir world of the T3
authorization fixtures and the scenarios in [`drivers/scenarios.json`](drivers/scenarios.json).
Every step must agree. One normalization: a lease refusal is compared by its **reason**. Chrome's
lease names a spent `once` `authorization_once_spent`; the Python control plane refuses with
`run_plan_stale` carrying that same stale reason. The report prints both raw codes.

**memory.v0** (35 cases, T20, [`spec/memory-v0.md`](../spec/memory-v0.md) §10): WebAir 0.6.0 on
its fixture input and the eight search scenarios (each proposes nothing); Literature Review 0.2.8
with its memory switches off and on
([`examples/literature-review-0.2.8-memory-input.json`](../examples/literature-review-0.2.8-memory-input.json):
the replayed research profile shapes the plan and one review is proposed, derived from it); and the
**memory probe**, agentpkg's own test package
([`agentpkg/tests/memory_probe.py`](../agentpkg/tests/memory_probe.py)), which uses every memory.v0
permission and is written with one change per negative case by
[`drivers/memory_probe.py`](drivers/memory_probe.py) and signed with the run's throwaway key (a variant
`agentpkg build` refuses is signed by the driver without validating, so that both CLIs meet the
refusal when they load it). Expected in both:

| Case | Expected |
|---|---|
| N1, N8, N13, N14 (links and body links), N19 | the run fails `permission_denied` at the proposals check, with the M-40 reason and proposal index in `result.json`'s `memory.refused`; no `proposals.json` |
| N2, N9, N15, N22 | the run fails `schema_validation` at the proposals check |
| N3 | `permission_denied at node profile`: the denied `memory.read` stops at the mediator |
| N4 | `schema_validation at node notes-write`: the agent write is over its 32,768 characters |
| N5 | `manifest runtime.minimum_version exceeds reference runtime 0.4.0` |
| N6 | `binding_schema_mismatch: …`, before the run, nothing written |
| N7 | `budget_exhausted at node notes-write-again` |
| N10, N12, N16, N17, N21 | refused at validation with the spec's code (`agent_memory_scope`, `memory_proposal_undeclared`, `custom_type_shadows_sealed_type`, `custom_type_reserved`, `custom_type_schema_open`) |
| N11 | `permission_denied at node remember`, compared as a failure inside a concurrent wave (D-092) |
| M-36 | a granted sealed value sent to a tool that does not link its permission: `permission_denied at node echo` |
| M-36, every value | the echo carries a value granted under the permission it links and one granted under another: `permission_denied at node echo` (every value is checked, not the first; D-234) |

Two positive probe variants use a package's own custom type by its local id (D-228, D-234): a
proposal of it (`memory-probe/custom-type-proposal`), and a `memory.read` of it with an update of
the record it read (`memory-probe/custom-type-read`).

The audit backbone gains `memory.proposed`, `memory.agent.committed` and `memory.agent.discarded`
with their facts (M-61), and a wave's multiset carries the `reason`, record id and pointer of a
refused `permission.checked` or `model.refused` (never a value). Both CLIs derive a fixture run's
memory the same way (D-230: grants from the replayed views, a replayed legacy answer held as
`fixture:<binding>`), refuse N6 before the run, and check every sealed value in a tool's arguments
(D-234). **Pending** applies only to a core that accepts packages up to runtime 0.3.x (an older
`CONFORMANCE_CHROME`): a memory case it refuses by version, whose Python half passed on its own, is
reported `pending` and printed with its failed checks; any other failure fails the suite. The
Chrome core on `main` accepts 0.4.0 since T19, so every case counts. `CONFORMANCE_CHROME=<path to a
built chrome-agent-browser>` compares another core, for example a task branch's worktree before it
is merged; the run against T19's core at `c6edfd4`, before the two were merged, is kept in
[`examples/verification/conformance-t20-against-t19-core/`](../examples/verification/conformance-t20-against-t19-core/report.md)
(63 of 68; the five differences were D-230's fixture grants and N6's timing, now fixed in the
Chrome core).

**compute.v0** (41 cases, T22; and 11 fixture-parity cases of the packages that ship modules: WebAir 0.7.0 on its fixture input and the eight search scenarios, Literature Review 0.2.9 with memory off and on; [`spec/compute-v0.md`](../spec/compute-v0.md) §10, C-51): the test
package `org.webagents.compute-test` 0.1.0 (two example modules in one wave and in a map step, the
modules run for real in fixture mode on both engines), the two control cases of the enforcement list
(`echo`, `with-start`) and every negative case of
[`examples/compute/cases/cases.json`](../examples/compute/cases/cases.json) but `engine-unavailable`
(both CLIs have an engine here; each unit suite covers it). Each case is agentpkg's own test package
([`agentpkg/tests/compute_probe.py`](../agentpkg/tests/compute_probe.py)) with one change, written
by [`drivers/compute_probe.py`](drivers/compute_probe.py) exactly as `test_compute_cases.py` builds
it, and signed with the run's throwaway key (a case `agentpkg build` refuses is signed by the driver
without validating). Expected in both:

| Case | Expected |
|---|---|
| N-1…N-14 (the module's structure and gate, the graph's declarations, the permission, the version, a node's limits) | refused at validation with the spec's code, identical message |
| N-15, N-16 | refused by the container: the member rule's message (`a WebAssembly module is at most 4194304 bytes`, `not a WebAssembly core module`) and `content integrity mismatch: … changed=['modules/echo.wasm']` |
| N-17 | a recorded difference of the CLIs (D-091): `agentpkg run` refuses in the runtime's preflight (`compute_limit_exceeded: …`), the Chrome CLI in its execution layer; both execution layers refuse `execution_compute_limit_exceeded` with an identical message |
| N-19 | a recorded difference of the CLIs (D-091), as `denied-permission/required`: `permission_denied at node compute` against the execution layers' `execution_permission_denied` |
| N-20…N-27 | the run fails with the node's code at `compute`; `compute.failed` names the reason, the trap and the detail |

A wave's multiset carries a compute event's module, hash, function, bytes in and out, memory
pages, effective page and time bounds, reason, trap code and detail (C-46); `engine` and
`limits.fuel` are the engines' own and are dropped. Three engine differences are folded by the
normalizer: a runaway module is `fuel_exhausted` under wasmtime's fuel and `deadline` under V8's
wall bound (both compare as `bound_reached`, D-244); after either the memory size is the engine's
(a terminated Worker reports none, D-250); and V8 reports a `call_indirect` through a null slot as a
signature mismatch, so the trap codes `indirect_call_to_null` and `bad_signature` compare as
`indirect_call_failed` (C-42, D-254). Every compute case carries `requires: 0.5.0`, so against
an older `CONFORMANCE_CHROME` core it is pending rather than failed.

## Recorded differences

Each is checked against what its decision says each runtime does, so the case fails if either
side changes.

- **Partial approvals without a profile** (D-090). The Chrome runtime treats every unapproved tool
  as denied; the Python control plane does that only for tools outside a selected profile, and
  otherwise requires every declared tool approved before a plan exists.
- **Where a CLI refuses a denied required permission or an over-used `once`** (D-091). `agentpkg
  run` drives the interpreter directly and refuses at the first use (`permission_denied at node
  …`, artifacts written); the Chrome CLI always runs through its execution layer and refuses
  before anything runs, as agentpkg's own execution runner does. The case also asks both
  execution layers directly ([`drivers/execution_policy.py`](drivers/execution_policy.py),
  [`drivers/execution-policy.ts`](drivers/execution-policy.ts)): same code, same message.
- **A failure inside a concurrent wave** (D-092). With Literature Review's optional `files.pdfs`
  denied, the refusal happens inside the screening map; how far the sibling items got before the
  first failure cancelled them is each scheduler's choice, so their partial events and reserved
  tokens are not compared (the report prints both totals). Compared: file set, status, error
  code, provenance, the ordered backbone (including the failing node) and chain linkage.

## What the suite does not show

- **Live behaviour.** Fixture mode replays the package's own recorded answers. No model, provider,
  network adapter or host resource is exercised; live runs have their own evidence under
  [`examples/verification/`](../examples/verification/).
- **The extension shell.** The Chrome side is the core and its Node CLI; the service worker,
  offscreen host, views and Chrome's network stack are not run here (their tests are in
  `chrome-agent-browser/test/`).
- **Anything beyond the listed cases.** Agreement on these packages, inputs and refusals is not a
  proof of equivalence. The paper's enforcement experiments (`experiments/`) are a different
  study, with a different harness; nothing here is pooled or compared with them.
- **Security of either runtime.** Two implementations can agree and both be wrong; agreement shows
  that the Chrome port reproduces the reference, not that the reference is right.

## Results

The kept report of T7 is [`results/2026-10-08T19-22-58-250Z/`](results/2026-10-08T19-22-58-250Z/report.md)
(its case and check counts are in the report; commit, versions and platform in its header).

`results/<timestamp>/report.json` and `report.md`, one directory per run that someone chose to keep
(commit, versions, platform and the SHA-256 of each shipped package are in the report). CI runs the
suite on every push and keeps the report as a build artifact; it never writes into this directory.
