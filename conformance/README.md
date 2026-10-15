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
refused `permission.checked` or `model.refused` (never a value). **Pending:** while the built Chrome
core still accepts packages only up to runtime 0.3.x (`SUPPORTED_RUNTIME_VERSION` in
`chrome-agent-browser/src/core/version.ts`), a memory case that does not pass is reported
`pending`, with that reason, and does not fail the suite, **only** when the Chrome CLI refused it by
version and the Python half passed on its own (a positive case: exit 0 with a report; a refusal: the
expected code); any other failure fails the suite, and a pending case still prints its failed checks
(D-234). Once the core accepts 0.4.0 the cases count like any other. `CONFORMANCE_CHROME=<path to a built chrome-agent-browser>` compares another
core, for example a task branch's worktree before it is merged; the run against T19's core at
`c6edfd4` is kept in
[`examples/verification/conformance-t20-against-t19-core/`](../examples/verification/conformance-t20-against-t19-core/report.md)
(63 of 68; the five differences are D-230's fixture grants and N6's timing).

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
