# Executing a portable agent package

The [previous milestone](model-router-bridge.md) ended with a person having
chosen a model, a hashed run plan recording that choice, and one host-owned
probe proving a `ModelRouter` could reach it. No package had run. This one runs
one.

```text
 ready run plan
        │
        ▼  re-verify every fact the plan asserts, and require consent to
        │  outlast the run
 execution preflight
        │
        ▼  the control plane copies its immutable snapshot, once
 execution lease
        │
        ▼  opened here as fd 3; a new private run directory as fd 4
 agentpkg execution runner
        │  re-verifies archive hash, digest, identity, signature and signer
        ▼
 Runtime  ──▶  Workflow  ──▶  the package's own graph
        │
        ▼  the exact model the plan bound
 OpenClaw api.runtime.llm.complete
        │
        ▼
 run record + artifacts on disk
        │
        ✕  STOP. There is still no Run button on the page.
```

Four artifacts appear in this document and they are **not the same object**:

| Artifact | Answers | Written by | Mutable |
|---|---|---|---|
| **Run Plan** | what may run, with whose authority, on which model | the control plane | never |
| **Run Invocation** | which plan, and what task input | the runner | never |
| **Run Record** | what a run did, and how it ended | the plugin's run manager | the only one that changes |
| **Workflow execution** | the actual interpretation of a graph | `agentpkg.workflow` | — |

A run plan is not authority. It is a prepared intent whose readiness is
recomputed every time it is read, and executing it does not edit it: the plan
still says `execution.performed: false` afterwards, because the plan never
performed anything. The evidence that a plan ran is a run record naming it.

## 1. A third namespace, and why

```text
agentpkg.browser       opens, verifies, authorizes, plans   — never executes
agentpkg.hostbridge    binds the planned model              — never executes
agentpkg.execution     composes the two with the interpreter
```

`agentpkg.browser` must stay structurally unable to run a package, because that
property is the reason a person can open an unknown one. `agentpkg.hostbridge`
may spend money but holds no interpreter. Composing them is a third job, so it
gets a third namespace, and the boundaries are asserted in both directions by
`tests/test_execution_boundary.py`:

| Rule | How it is proved |
|---|---|
| `browser` cannot import `execution` | AST scan of every browser module, at module level and inside functions |
| `hostbridge` cannot import `execution`, `workflow`, `runtime` or `tools` | the same scan over the bridge package |
| `execution` may import `package`, `runtime`, `workflow`, `hostbridge`, `validation` | an allowlist, and an assertion that it actually uses them |
| `execution` may **not** import `tools`, `models`, `network`, `fixtures`, `browser`, `cli`, `dev`, `openclaw` | the same allowlist, plus a fresh child's own `sys.modules` after a real run |
| `execution` is domain-neutral | no application word and no reference package's id, name or tool id occurs anywhere in it |
| `execution` spawns nothing | no `subprocess`, `os.fork`, `os.exec` or `multiprocessing` in the namespace |

The runner contains no orchestration. There is no `MeetingAgendaRunner`, no
branch on a package id, and nothing a graph could not express. What the Meeting
Agenda package does is what its graph says; an unrelated graph runs through
exactly the same code.

## 2. Execution requires a ready plan, not a package and a model

`execution.start` takes four things and nothing else:

```ts
{ sessionId, runPlanId, runPlanSha256, input }
```

There is no prompt, no system text, no model id, no skill text and no output
schema in that surface, and there is no code path that would accept one. Every
model-facing byte comes from the signed package and the run plan. This is
deliberately **not** a general completion endpoint wearing a different name.

Before a single package instruction reaches a model, `src/preflight.ts` re-runs
the whole check. It is the *same module the router probe uses* — the previous
milestone wrote it as a preflight rather than as a probe-shaped detour precisely
so a run could not end up behind a weaker gate than a probe.

| Check | Refusal |
|---|---|
| the session's plan is the one the caller named, at the hash the caller read | `probe_refused` |
| the plan was ready, and its control-plane preflight is still ready and not stale | `run_plan_stale` |
| execution mode is `model` and `performed` is false | `run_plan_stale` |
| package digest, archive SHA-256 | `run_plan_stale` |
| container, integrity and schema layers valid; runtime profile compatible; profile is `workflow.v0` | `run_plan_stale` |
| signature status, publisher trust, signer fingerprint unchanged | `run_plan_stale` |
| receipt id and hash are the planned ones, and it is runnable | `run_plan_stale` |
| the receipt has not expired | `run_plan_stale` |
| **the receipt outlasts the whole run deadline plus a minute** | `authorization_expiring` |
| every run-mode permission id is granted | `run_plan_stale` |
| the model is still offered and selectable | `selected_model_unavailable` |
| the host's identity for that model is unchanged, and it is not incompatible | `run_plan_stale` |
| this OpenClaw release is the one the accounting was verified against | `execution_refused` |

The receipt-lifetime rule is new and is execution's own. A probe is one short
call, so a receipt valid now is valid for it. A run is not: starting one whose
consent expires halfway through would leave the run in a state nobody decided
about. So the run is refused up front and the person authorizes again. If a
browser session nevertheless expires *during* a run, the run continues to
completion under the consent it started with — the runner holds an open
descriptor and needs nothing further from the control plane — and the run record
keeps the receipt id it ran under. Nothing about that grants durable authority:
the next run needs a live receipt again.

## 3. How the immutable snapshot reaches the runner

The control plane captured the package's bytes once and never rewrites them.
The runner must execute *those* bytes. Reopening the original URL or `dist/`
path would reintroduce exactly the verify-then-reload race the snapshot exists
to prevent, so neither happens.

**A one-time execution lease.** `POST /v0/packages/{id}/execution-lease` copies
the session's snapshot into a fresh private directory, rehashes it, and returns a
bounded record. It is issued only when that session's run plan is ready right
now, at most one at a time, for a bounded lifetime that never outlives the
session, and it is deleted when the run ends, when consent changes, when the
plan is cleared or replaced, when the session closes, and on expiry.

| Property | Mechanism |
|---|---|
| immutable bytes only | copied from the snapshot, hash-compared before and after writing |
| the package cannot choose the path | a random directory name the control plane generates |
| no reopening of the network source | the source URL is metadata; only the snapshot is read |
| regular file, no symlink | `O_CREAT｜O_EXCL｜O_NOFOLLOW`, mode `0400`, in a `0700` directory |
| bounded lifetime | `min(lease TTL, session remaining)`, swept with expired sessions |
| one active execution | a second lease while one is outstanding is `execution_lease_active` |
| cleaned up | released on every exit path, including failure |

**Then descriptors, not paths.** The plugin backend opens the lease file
`O_RDONLY｜O_NOFOLLOW` and the run's new artifact directory
`O_RDONLY｜O_DIRECTORY｜O_NOFOLLOW`, passes them as the child's fd 3 and fd 4,
and closes its own copies the moment `spawn` returns.

That choice is what makes the guarantee checkable rather than argued: **the
execution protocol contains no path, no filename, no model identifier and no
OpenClaw method name.** The child cannot open the package from anywhere else
because it never learns where the package is, and it cannot write outside the
run directory because it never learns where that is either. Browser JavaScript
sees neither: the lease record stops in the Gateway process, and a test asserts
the run record contains no path, no `.agent.pkg`, no `lease`, and none of the
package's own output.

This is POSIX descriptor inheritance, as is the rest of this prototype's process
handling.

## 4. What the runner verifies for itself

The parent already checked everything. The runner checks the cryptographic half
again, because it is the process that will put package instructions in front of
a model and should not have to *believe* a claim about which bytes it received:

```text
fstat(fd 3) is a regular file, within the container limit
sha256(bytes)          == run plan archive_sha256
container / integrity / schema layers parse and verify
Package.digest         == run plan digest
package_id, version    == run plan
embedded signature verifies against its embedded key
fingerprint(key)       == run plan signer_fingerprint
entrypoint             == workflow.v0
```

Publisher **trust** remains the host's decision — a trust store is operator
configuration, and bytes cannot establish it. What the runner confirms is that
the cryptographic identity it received is the identity that was trusted. Any
mismatch is `execution_artifact_mismatch` and nothing runs.

## 5. The Run Invocation

A run plan deliberately does not bind the task: the same authorized package and
model can be asked different things. The invocation is the missing half.

```json
{
  "schema": "agentpkg-run-invocation-v0",
  "run_invocation_version": "0.1",
  "run_id": "run_…",
  "run_plan_id": "rp_…",
  "run_plan_sha256": "…",
  "session_id": "…",
  "package": { "package_id": "…", "version": "…", "digest": "…", "archive_sha256": "…" },
  "input_sha256": "…",
  "input_bytes": 397,
  "created_at": "…",
  "run_invocation_sha256": "…"
}
```

Hashing is RFC 8785 canonical JSON — the same canonicalization a package's
integrity statement, an authorization receipt and a run plan already use, so one
comparison rule covers every artifact in this project.

The input is bounded at 256 KiB by the backend and again by the runner, and is
validated against the **package's own declared input schema** in
`execution.begin`, before `execution.run` exists and therefore before any
instruction is rendered. Malformed or oversized input costs nothing.

## 6. Consent travels unchanged, or the run is refused

The runner receives the receipt's decisions verbatim. It never reconstructs them
from package policy and never widens one.

* a `deny` on a required permission is `execution_permission_denied`;
* `always` is refused: this host has no persistent store, and recording a
  single-run grant as durable consent would be false;
* **`once` is refused for a permission the graph would consume more than once.**

The last one deserves its reasoning. `Runtime` consumes a `once` grant at first
use: a worker spawn consumes the memory permission, a model call consumes the
model permission. Meeting Agenda's graph performs five of each. Honouring `once`
would therefore mean denying halfway through a run that had already spent
tokens; the alternative, treating it as `session`, would be consent this host was
never given. So the run is refused with `execution_grant_unsupported` and the
person chooses `session` deliberately. The count is derived from the graph, not
from a package name.

Redesigning persistent authorization is not part of this milestone.

## 7. Host limits, and the one that refuses instead of lowering

The package declares its budgets. The trusted host may impose equal or tighter
ones, and `Runtime` applies `min()` to each, so a host limit can only ever lower:

| Operator setting | Default | Effect |
|---|---|---|
| `execution.totalTokens` | 120,000 | `min` with the package's `hard_tokens` |
| `execution.maxRemoteCalls` | 32 | `min` with the package's `max_remote_calls` |
| `execution.maxParallelWorkers` | 3 | `min` with the package's `max_parallel_workers` |
| `execution.runTimeoutSeconds` | 600 | `min` with the graph's `deadline_seconds` |
| `execution.maxOutputTokensPerCall` | 16,000 | an **upper bound**, checked before the run |
| `execution.requireVerifiedHostRuntime` | `true` | refuse an unverified OpenClaw release |

`maxOutputTokensPerCall` is different in kind from the others, which is why it is
not passed to `Runtime`. A node's `max_output_tokens` comes from the graph and
is part of what the package does; silently lowering it would change the
package's behaviour while reporting success. So the whole graph is scanned
before the run and a node above the ceiling is refused with
`execution_output_cap_too_large`. Meeting Agenda's nodes request 12,000, which
is why the default ceiling is 16,000.

No cost guess is introduced anywhere. The package's own budget policy stays
visible in the run record next to the host's, with the effective `min` of both.

## 8. The execution protocol

`agentpkg-execution/0.1`: one JSON object per line, both directions, over the
stdio of a child the plugin backend spawns. The framing, correlation, bounded
concurrency, cancellation and fail-closed termination are the router bridge's,
shared through `bridge-core.ts` and `agentpkg.hostbridge.peer` — the properties
that matter must not differ between proving a model works and running a package
on it.

```text
  OpenClaw plugin backend (parent)                 agentpkg execution runner
  ────────────────────────────────                 ─────────────────────────
  execution.begin / run / cancel / end         ──▶  stdin      (fd 0)
  model.count_tokens / model.complete           ◀──  stdout     (fd 1)
  logs, diagnostics, tracebacks                 ◀──  stderr     (fd 2)
  the leased immutable archive, read-only       ──▶  fd 3
  the run's private artifact directory          ──▶  fd 4
```

| Method | Params | Answer |
|---|---|---|
| `execution.begin` | `run_id`, `run_plan`, `authorization`, `limits`, `input`, `host` | verified package facts, the invocation, effective limits, the router |
| `execution.run` | *(none)* | the execution result |
| `execution.cancel` | *(none)* | whether a workflow was running |
| `execution.end` | *(none)* | `{ended, ran, status}` |

**A different protocol version from the probe's.** A probe parent and an
execution child refuse each other's frames outright, so two components that can
both spend money cannot be mistaken for one another. Everything else is
inherited: 1 MiB frames, 16 outstanding requests per direction, unique
correlation ids, a closed method allowlist per direction, no dynamic dispatch,
`$/cancel` in both directions, and a session that ends on any malformed frame,
unknown id, wrong version or non-frame stdout byte.

One change was needed in the shared peer, and it is a real fix rather than a
relaxation: a peer that cancels a request must tolerate the *answer* to that
cancellation. `$/cancel` asks a peer to stop, and a peer that stops mid-operation
replies with a `cancelled` error frame. Treating that as desynchronization made
every cancellation kill the session — which is precisely the failure a run has to
survive. A late answer for an id this peer cancelled is now discarded; an answer
for an id it never sent is still fatal.

## 9. Runtime and Workflow construction

```python
Workflow(
    verified_package,
    grants=receipt_decisions,   # exactly what the person left
    handlers={},                # no tool broker exists yet
    router=HostBridgeModelRouter(peer, plan.model_binding),
    limits=host_limits,         # min() against the package's own
    approved_tools=[],
)
```

That is the whole construction. The graph provides the behaviour.

**Package skills reach the model for the first time in this milestone**, through
the mechanism that already existed: `Runtime.call_model` loads the verified
skill files for the worker's declared role and puts them in the request's
`instructions`. The OpenClaw plugin does not interpret a skill, does not build a
prompt, and does not see one — `HostBridgeModelRouter.render` turns the generic
request into system and user text inside Python, and the host transports it.

Parallelism is the interpreter's. Meeting Agenda's `perspectives` map declares
`max_parallel: 3` against a role with `max_instances: 3`; `Workflow._map`
allocates `min(max_parallel, item_count)` consumers and `Runtime` holds the
global and per-role semaphores. The plugin implements no scheduling.

## 10. Cancellation

`execution.cancel` → `Workflow.cancel()` → the run task is cancelled → workers
are cancelled and drained → pending `router.complete` calls are cancelled →
`$/cancel` crosses the bridge → the parent aborts the `AbortController` it passed
to `api.runtime.llm.complete` → the provider request is aborted where the
transport supports it.

The run then reports `cancelled`, not `failed`, and still writes its audit,
settled usage and artifacts. That is why cancellation is a request rather than a
kill: a killed child has none of those. The child is killed only if it fails to
stop.

Two windows are closed explicitly, because both were real:

* a cancel arriving **between `begin` and `run`** is honoured — the parent sends
  it as soon as the session is bound, and the runner stops the workflow before
  its first node;
* a cancel arriving **before the session is bound** is remembered rather than
  dropped.

`execution.cancel` is deterministic in the test suites on both sides. A live
long-running cancellation test is deliberately not part of the acceptance run;
it would spend provider tokens to demonstrate what the deterministic tests
already demonstrate.

## 11. Deadlines

The effective run deadline is `min(graph.deadline_seconds, host
runTimeoutSeconds)`. The graph's own deadline is enforced by `Workflow.run`; the
host's is a watchdog that cancels the workflow and relabels the outcome
`failed` / `timeout` with `deadline_exceeded: true`, because calling a host
deadline "cancelled" would hide who stopped the run and why. The bridge session
outlives the run deadline by two minutes so a run that hits its own deadline
reports a timeout rather than a killed bridge.

## 12. Run lifecycle

```text
preparing ──▶ running ──┬──▶ completed
                        ├──▶ failed
                        └──▶ cancelled
```

No transition leaves a terminal state, and at most one run is active per run
plan *and* per package session, so a double start — a double-clicked button
that does not exist yet, or a script that fires twice — is refused with
`execution_active` before anything is prepared.

Run records live in the Gateway process's memory and die with it. A Gateway
restart does not resume a run; it ends one, because the child doing the work is
gone. `stop()` cancels every run in flight and records why. There is no
persistent run history in this milestone.

## 13. Artifacts

Each run gets a new private directory under the plugin's own state directory,
mode `0700`, with owner-only files created exclusively and without following
symlinks. Nothing is ever overwritten.

| File | Written by | Contents |
|---|---|---|
| `result.json` | the runner | the full execution report: status, output, state, audit, usage, provenance |
| `audit.json` | the runner | the hash-chained audit |
| `usage.json` | the runner | settled token, call and worker accounting |
| `provenance.json` | the runner | profile, interpreter, package id and digest |
| `agenda.json` | the runner | the **package-declared export**, evaluated from the final result |
| `run.json` | the plugin backend | the run record |

The export logic is not duplicated: `agentpkg/artifacts.py` renders the records
once, and two thin writers use it — a path-based one for the CLI and a
descriptor-based one for the runner. `workflow_validation` already constrains an
export to one safe portable filename that cannot collide with `result.json`,
`audit.json`, `usage.json` or `provenance.json`; the execution host additionally
refuses an export named `run.json`, which is a host capability limit rather than
a format rule.

A failed or cancelled run still writes its evidence, and no package export,
because an export selects from a final output a failed run does not have.

The future browser UI will read these through the bounded `execution.artifact`
operation, which returns one named artifact's content and never a path.

## 14. Audit and usage

`Runtime`'s existing hash-chained audit is authoritative; no second audit system
exists. A completed run contains `runtime.started`, `workflow.started`,
`node.started`, `worker.spawned`, `worker.started`, `permission.checked`,
`model.count.called`, `model.called`, `model.completed`, `budget.updated`,
`worker.completed`, `node.completed`, `state.committed`, `workflow.completed`
and `memory.cleared`.

The run record's summary is *derived from that chain*, not kept alongside it: it
says five model calls happened because five `model.completed` events exist. It
also re-verifies the chain — every event hash recomputed, every `previous_hash`
link and every sequence number checked — and reports `chainValid`. That is an
integrity check on a local record, not an externally anchored tamper-proof log.

Usage is `Runtime`'s settled accounting: total tokens, remote calls, peak
parallel workers, per-worker tokens and calls, and the effective limits.

**Cost is only ever the sum of costs the host actually reported.** A missing
value is never estimated. The report says `complete`, `partial` or `unknown`,
and `total_usd` is `null` when nothing was reported.

Which model answered is recorded per call by the router adapter, so the record
can state `allCallsUsedPlannedModel` from evidence rather than assert it once.

## 15. Why Meeting Agenda is the first package

It declares `tools: []`. This milestone has no generic `ToolHandler` host
broker, so it runs only packages that declare no tools — checked against the
graph's declarations, never against a package id. A package that declares a tool
or contains a `tool` node is refused with `tools_not_supported` in
`execution.begin`, before a single token is spent.

That is a limit of **this execution host**, not of the package format. Literature
Review is a valid package that this host cannot yet run; faking its tools or
special-casing it would have been worse than refusing it.

## 16. What still cannot happen

| | Status |
|---|---|
| a Run button on the Agent Browser page | no — the page is unchanged and calls no `execution.*` operation, asserted by a test |
| a package tool call | no — `handlers={}`, and a package declaring one is refused first |
| Literature Review | no — it declares tools |
| an agent-callable tool binding | no — the plugin still exposes none |
| a run plan mutated by execution | no — `execution.performed` stays false |
| persistent run history or resumable runs | no — records are ephemeral |
| the control plane executing anything | no — `execution: "disabled"`, `capabilities.execute: false`, and it still cannot import an execution module |

## 17. Residual trust assumptions

**The Agent Browser plugin backend is trusted host code.** It holds the
control-plane bearer token, opens the lease descriptor, and owns the runner
process. Nothing in this design defends against a compromised Gateway.

**`llm.allowModelOverride` is broader than one run plan.** Binding an exact model
requires that operator opt-in, and it is a plugin-wide grant at the OpenClaw
layer. The per-run-plan discipline — live preflight, the plan's exact model, the
router's post-check against what answered — is entirely this project's.
OpenClaw 2026.9.5 also supports `llm.allowedModels` and
`llm.allowedCompletionModels`, which an operator can set as defence in depth;
this project does not set them, because doing so would require knowing the model
set in advance and would break the dynamic selection the previous milestone
exists to provide. Hard-coding one model solely to obtain that narrowing would
be a worse trade.

**The token-accounting proof is version-pinned.** The reservation invariant
depends on how this host answers `model.count_tokens` and reports usage, which
was verified against OpenClaw 2026.9.5. The runner records the live runtime
version in every run record and provenance, and by default refuses to run on a
different release rather than pretending the old proof still applies. An
operator who has re-verified sets
`execution.requireVerifiedHostRuntime: false`. The half of the proof that is
self-verifying — that the bound is `utf8_bytes + framing` because the host
answers "no tokenizer" — is re-derived on every call and recorded per call.

## 18. Running it

The page has no Run action. Execution is reachable only through operator-only
feature operations, all `operator.write` for actions and `operator.read` for
queries, none rendered by the Control UI:

| Operation | Kind | Purpose |
|---|---|---|
| `execution.start` | action | re-verify a ready plan and run the package |
| `execution.cancel` | action | stop a running workflow |
| `execution.clear` | action | forget finished records |
| `execution.status` | query | list a session's runs and the active one |
| `execution.get` | query | read one run record |
| `execution.artifact` | query | read one named artifact, bounded |

The manual acceptance test is one command:

```bash
node openclaw-agent-browser/scripts/run-meeting-agenda.mjs \
  --package /absolute/path/to/dist/meeting-agenda.agent.pkg \
  --input   /absolute/path/to/examples/meeting-agenda-acceptance-input.json \
  --model   openai/gpt-5.6-luna \
  --out     examples/verification/meeting-agenda-live-run.json
```

It walks the page's own sequence through the live Gateway — open, trust,
authorize, evaluate models, choose, prepare — then starts the execution, waits
for it, reads `agenda.json` and `provenance.json` back through the bounded
artifact API, and checks the package's own invariants itself: the goal is
preserved, the duration is preserved, and the agenda minutes sum exactly to the
requested duration. It exits non-zero unless every one of those holds, every
model call used the selected model, more than one call happened, peak worker
parallelism reached at least two, no tool was called, the audit chain verifies,
and the run plan is byte-identical afterwards with `performed` still false.

Prerequisites: the plugin installed and reloaded
(`npm run build && npm run pack && openclaw plugins install ./agent-browser.tgz --force`),
`plugins.entries.agent-browser.llm.allowModelOverride: true`, the package's
directory in `localPackages.roots`, and a provider credential that is actually
usable — see the [milestone report](package-execution-report.md) for what
happens when it is not.

See also: [model availability](model-availability.md), [the model-router
bridge](model-router-bridge.md), [model selection and run
plans](model-selection-and-run-plan.md), [the control
plane](browser-control-plane.md), [the Agent Browser
plugin](openclaw-agent-browser.md), [the execution
profile](../spec/workflow-v0.md), [threat model](threat-model.md).
