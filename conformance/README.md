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

**Fixture parity** (13 cases): WebAir 0.4.0 on its fixture input and with only its two search
tools approved; WebAir 0.5.0 on its fixture input and on the eight inputs of
[`examples/webair-scenarios.json`](../examples/webair-scenarios.json) (0.5.0 added `no-departure`,
which 0.4.0's fixture cannot replay); Literature Review 0.2.5; Meeting Agenda 0.2.2. `agentpkg run --mode fixture` and
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

**Refusals** (12 cases), each with an expected refusal in both runtimes:

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
| stale plan: publisher key unpinned after preparation | lease refused, stale reasons `publisher_trust_changed`, `publisher_not_trusted` |
| stale plan: a bound tool's implementation changed | lease refused, stale reason `tool_binding_changed` |
| replayed `once` | second lease refused, reason `authorization_once_spent` |
| profile-scoped approvals (`search`) | plan ready, two tools bound, five denied, lease issued |

The two schema and budget cases run Meeting Agenda rebuilt with one change each and signed with a
key generated for that run; the tampered and wrong-key archives are the shipped bytes with one
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
