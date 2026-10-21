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
        ▲  since 3C, started by the Agent Browser page's Run button (or an
           operator script) through the same execution.start
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

**Version 0.2 (3B4) adds `attachments`**: the selected files a run was given,
as a closed, sorted list of `{file_id, sha256, bytes, media_type}` — the opaque
capability id and the exact bytes' identity, never a path or a display name.
Files are part of *what was asked*, so a run given a file is a different
invocation, with a different hash, from one that was not. The host decides
which files these are and enforces that nothing else is readable (see [the tool
broker](tool-broker.md#3b-selected-file-capabilities)); the runner validates
the list's shape and binds it.

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

Across runs, `once` means one run: the control plane spends a receipt that
grants anything `once` when it issues that receipt's first execution lease, so
the plan is stale (`authorization_once_spent`) until the person decides again.

**Host-owned resources travel by reference.** A plan that granted host
resources carries `resource_grants` — `{permission_id, resource_type,
resource_id, resource_digest}` per resource-bearing permission, never a value.
The plugin's preflight compares each with its live resource store (removed,
retyped or changed: `run_plan_stale`) and that the plan's grants equal the
receipt's, and the runner re-derives every grant from the verified package:
the permission is declared, of a resource kind, scoped to exactly that type, and
not denied (`execution_plan_invalid` / `execution_permission_denied`
otherwise). Its `host_resource` tool handlers accept an answer only when the
host attributes it to exactly one of those grants, and record the grant — not
the value — in the audit's `tool.settled` event.

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
| `execution.modelCallTimeoutSeconds` | 300 | how long one model completion may take, queueing at the model server included |
| `execution.maxOutputTokensPerCall` | 16,000 | an **upper bound**, checked before the run |
| `execution.requireVerifiedHostRuntime` | `true` | refuse an unverified OpenClaw release |
| `compute_memory_pages` (compute.v0, agentpkg 0.5.0) | 1,024 (64 MiB) | the page bound of one compute call; a module whose declared maximum is above it is **refused** before the run (`execution_compute_limit_exceeded`), never lowered |
| `compute_wall_seconds` | 10 | the wall bound of one compute call (an epoch deadline) |
| `compute_fuel` | 5 × 10¹⁰ | the instruction bound of one compute call on an engine that meters (wasmtime); a node's `limits` may only lower any of the three |

`maxOutputTokensPerCall` is different in kind from the others, which is why it is
not passed to `Runtime`. A node's `max_output_tokens` comes from the graph and
is part of what the package does; silently lowering it would change the
package's behaviour while reporting success. So the whole graph is scanned
before the run and a node above the ceiling is refused with
`execution_output_cap_too_large`. Meeting Agenda's nodes request 12,000, which
is why the default ceiling is 16,000.

`modelCallTimeoutSeconds` bounds one completion rather than lowering anything
the package declared: it is the runner's own wait for `model.complete`, after
which the runner cancels the call and the cancellation reaches the model
request. The host keeps a backstop timer 30 s later for a runner that did not.
Until 3B4 this was a constant 300 s in the runner. It is now an operator setting
because a local model server that decodes one request at a time (Ollama's
default `OLLAMA_NUM_PARALLEL=1`) answers the third of three concurrent workers
only after the other two have finished, so a call's wall-clock time includes the
queue in front of it. The package's own node timeouts still bound every call;
this only stops the host from cutting one off first. It appears in the run
record with the other host limits.

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
    handlers=tool_handlers(peer, plan.tool_bindings),   # one per bound tool
    router=HostBridgeModelRouter(peer, plan.model_binding),
    limits=host_limits,         # min() against the package's own
    approved_tools=[b.tool_id for b in plan.tool_bindings],
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

## 9a. The task, the run and its progress — the interaction model for workflow.v0

Under `workflow.v0` a person does not converse with a package. The model is:

```text
 structured task input        the package's own declared input schema, e.g. for
   (+ selected files)         Literature Review {question, seeds, documents, mode}
        │
        ▼
 one Run Invocation           plan + input + attachments, hashed, immutable
        │
        ▼
 one bounded run              the signed graph, start to finish, under the plan
        │                     (live progress while it runs)
        ▼
 one result + artifacts       exports, result, audit, usage, provenance, run record
```

For Literature Review the `question` field *is* the research prompt; `seeds`
and selected `documents` are optional. A follow-up question is a **new** Run
Invocation against the same (or a new) run plan — not a turn in a
conversation. Conversational agents are a different thing, and since agentpkg
0.6.0 a package may declare one: [conversation.v0](../spec/conversation-v0.md)
runs the same graph once per message over a declared persistent state, with
consent steps before consequential actions (§14c); this one-shot execution
host does not run them (`conversation_not_supported`).

Three backend additions make that model renderable by the run surface (3C)
without adding anything package-specific:

* **the task on the record.** The run record carries `task`: the input when it
  is at most 16 KiB and small in shape (512 JSON nodes; the person's own task,
  never package output), its size, and the attachments by id and hash;
* **live progress.** The runner watches its own hash-chained audit as events
  are appended and sends `execution.progress` — active and completed node ids,
  steps completed, workers spawned/active/peak, model and tool calls started
  and completed, tokens and remote calls so far. Identifiers and counts only;
  no prompt, input, model output, tool payload or error text. Sends are
  coalesced (at most one per second plus one per node transition), one at a
  time, and dropped on failure: observation never steers or delays the run. The
  parent accepts the method only when a sink is attached, exactly as `tool.call`
  exists only when a broker is attached, and never rewrites a terminal record
  with a late snapshot. `Runtime` gained a generic `observer` hook for this; it
  receives a copy of each chained event and its errors are discarded;
* **a detached start.** `execution.start` accepts `detach: true`: it answers as
  soon as the runner has bound the plan (so every refusal — stale plan, denied
  permission, unknown file — still comes back to the caller) with the record in
  `running`, and the run continues; `execution.get` then shows progress and,
  finally, the outcome. Without `detach` it waits, as before.

`usage.toolCalls` on the run record now sums every attempted dispatch across
tools; it previously counted distinct tools.

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

### Three clocks that are easy to confuse

A run that ends in `timeout` has hit exactly one of these, and the audit says
which. They are owned by different people and none of them can substitute for
another:

| | Lives in | Set by | Bounds | Changing it means |
|---|---|---|---|---|
| **package timing policy** | `graph.json`: each node's and map step's `timeout_seconds`, and `deadline_seconds` | the **publisher** | one node, one map step, or the whole graph | new bytes, new digest, new signature, new version, new trust and authorization |
| **host execution limits** | `agentpkg.execution.policy` and the plugin's `execution` config | the **operator** | wall clock, tokens, parallelism, one call's output cap, one call's wait for the model | a config edit; it can only ever *lower* what a package declared |
| **provider latency** | nowhere | **nobody** | how long a model actually takes | a different model, or different hardware |

The asymmetry is the point. A package declares what it believes its work needs;
an operator declares what this machine is willing to spend; and the run gets the
tighter of the two. A package cannot raise its own ceiling by asking, and an
operator cannot make a package's own step budget more generous than its
publisher signed for. Provider latency obeys neither, which is why the only
honest way to set a package's timing policy is to measure it — see the 0.2.1
[timing policy](package-execution-report.md#62-the-021-timing-policy-and-why-each-number),
where every declared value is recorded next to the slowest run that justified it.

A consequence worth stating: the per-node budgets along a critical path may sum
to more than the graph deadline, and in Meeting Agenda 0.2.1 they do. That is
not a contradiction. A node timeout exists to localize a stall, so the audit
names the node that hung; the deadline exists to bound the run as a whole.

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

The Agent Browser page reads these through `execution.artifact` (a view of at
most 48 KiB, parsed when it is small JSON) and `execution.artifact-chunk`
(48 KiB slices with the whole file's size and SHA-256, reassembled and verified
before a download is saved). Both name an artifact by one plain filename the run
wrote, never a path. Both sizes come from the host: `defineFeaturePlugin`
refuses any output over OpenClaw's plugin JSON limits (65,536 characters per
string, 4,096 nodes, 256 KiB), and 48 KiB is the largest slice whose base64
fits one string.

## 14. Audit and usage

`Runtime`'s existing hash-chained audit is authoritative; no second audit system
exists. A completed run contains `runtime.started`, `workflow.started`,
`node.started`, `worker.spawned`, `worker.started`, `permission.checked`,
`model.count.called`, `model.called`, `model.completed`, `budget.updated`,
`worker.completed`, `node.completed`, `state.committed`, `workflow.completed`
and `memory.cleared`.

A failed call says *which* failure it was. `model.failed`, `model.count.failed`
and `tool.failed` carry the failing adapter's stable code as `reason`
(`bridge_timeout`, `model_output_not_conforming`, `selected_model_unavailable`,
`tool_unavailable`, …) — only an identifier-shaped string, never a message a
provider or service wrote. A call refused before dispatch records
`model.refused` with the bound that refused it — `context_window`,
`worker_token_budget` or `global_token_budget` — and the numbers: the request's
input bound, its output cap, the reservation, what was already used and held,
and the limit. A run that ends in `budget_exhausted` can therefore be classified
from its own audit rather than guessed at.

A node that fails a declared check records which one as `failed_check`: for an
assertion, its index and kind, the failure (`fields_do_not_match`,
`missing_target_key`, …) and the JSON pointers it compared, all taken from the
package's own declaration; for a node output that fails its schema,
`output_schema` and the schema path. No value from the data is ever recorded, so
a failed run's state can still be cleared under the package's retention policy
while the audit says exactly what refused it.

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

## 14a. Memory: proposals, the agent document and the egress scans (memory.v0)

agentpkg 0.4.0 implements [memory.v0](../spec/memory-v0.md) in the same interpreter; nothing about
it is package-specific (D-009) and a package that uses none of it runs exactly as before (its
report has no `memory` section). What a run holds about memory is one object built before the run
(`agentpkg.memory.run.MemoryRun`): the scan set, the grants, the types and the agent document.

- **Model requests are scanned (M-37).** Before every model request, the token count included, the
  complete request as it will be sent is searched for the run's scan set; a hit records
  `model.refused` with `reason: "sealed_value_in_model_request"`, the record id and the pointer,
  and the node fails `permission_denied` before anything leaves. In fixture mode the scan set is
  the sealed values of the replayed memory reads (M-62), so a graph that routes a sealed value into
  a model step is refused there too (N11).
- **Proposals are checked before the run completes (M-40).** The `memory.proposal` export is
  constructed from the final output and checked in order: the proposals schema; for each proposal,
  in index order, a declared and proposable type, no sealed field, the type's schema, an `update`
  only of a record this run was granted, and links only to `self`, a granted record or another
  proposal; then no sealed value anywhere in the document. The first refusal fails the run with its
  code (`permission_denied` or `schema_validation`) and `workflow.failed` names the reason and the
  proposal index; the document is written to `proposals.json` only when every check passed, and
  `memory.proposed {count, types, proposals_sha256, offered, reason}` precedes `workflow.completed`.
  Nothing a run proposes is ever written to the memory by the run: the person reviews it afterwards.
- **The agent document is committed only on completion (M-50).** A staged body is committed after
  `workflow.completed` (`memory.agent.committed`, its size and hash) and discarded otherwise
  (`memory.agent.discarded`, with the reason), always before `memory.cleared`. The host writes the
  document before it records the commit; a write its store refuses is a discard with reason
  `store_failed`, and the run stays completed (D-234). The outcome is recorded once per run, even
  when something fails after it was recorded. The agent
  permission authorizes the two agent tools and nothing else, so denying it never stops the run's
  state access.
- **The report** (`result.json`) gains `memory: {proposals, refused, agent}` (D-231): the facts of
  `memory.proposed`, an M-40 refusal, and the agent document's fate. The Chrome core writes the
  same section.

Validation refuses, before anything runs, what a package may not declare about memory (M-18, M-19,
M-33, M-38, M-48, M-67): a `memory.read` naming more than one type, `memory.write` without the
`proposals.json` export (or the export without the permission), a reserved type (a `memory.read`
of any `agent.` type among them, D-235), an agent tool
outside `agent-scoped` or with other schemas, a custom type that shadows a sealed starter field or
whose schema is not closed, and any of it under a runtime minimum below 0.4.0. Each refusal's text
starts with the specification's code.

## 14b. Compute: modules, calls and their bounds (compute.v0)

agentpkg 0.5.0 implements [compute.v0](../spec/compute-v0.md) in the same interpreter: a package
may ship WebAssembly core modules and run them from `compute` nodes. Nothing about it is
package-specific (D-009): the runtime knows a module by its id and hash, a node by its module,
function and schemas, and a call by its bytes in and out.

- **Validation refuses before anything runs** what a package may not declare (C-2…C-19): a
  `.wasm` member the graph does not declare, a hash that is not the member's, a module no node
  runs, a module with an import, more than one memory or none with a declared maximum, a missing
  or wrongly typed export, a proposal outside the admitted instruction set (decoded body by body),
  a node's limits below the module's maximum, a graph without the one `compute` permission naming
  its modules, and any of it under a runtime minimum below 0.5.0. Each refusal's text starts with
  the specification's code.
- **The preflight refuses before the run** what this host cannot run: no engine
  (`compute_not_supported`; the `wasmtime` extra is not installed), or a module whose declared
  memory maximum is above the host's page bound as the node lowers it
  (`execution_compute_limit_exceeded`). `check_capabilities` records the modules, the operations
  and the effective bounds under `capabilities.compute`; the reference's `Runtime` makes the same
  checks at construction (`compute_engine_unavailable`, `compute_limit_exceeded`), so `agentpkg
  run` and the execution runner agree.
- **A call** (C-20…C-29): the permission is authorized and consumed (`permission.checked`); the
  constructed input is checked against the node's `input_schema`; a fresh instance of the module
  is given the input as canonical JSON through `alloc`; the function's i64 names the output; the
  output is read once, parsed as strict JSON and checked against `output_schema`; the node's
  `writes` carry the value into state. The call runs on a worker thread under its effective
  limits; the wave's other nodes proceed meanwhile.
- **Failures** (C-40…C-43): the module's own end (a trap, exhausted fuel, a passed deadline, an
  ABI violation, output that is not one JSON text) is `compute_error` with `reason` and, for a
  trap, `trap_code`; a schema miss is `schema_validation` with the adapter code
  (`compute_input_invalid`, `compute_output_invalid`); a denied permission `permission_denied`
  before the engine; a failure of the engine itself, which is the host's and not the module's,
  `worker_error` with the reason `engine_error`. Nothing the module wrote, and nothing the engine
  said, is ever in the audit: only the specification's words.
- **The audit** (C-44…C-46): `compute.called` (module, hash, function, input hash and bytes, the
  effective limits, the permission), `compute.completed` (output hash and bytes, memory pages,
  `engine: {id, elapsed_ms, fuel_consumed}`) or `compute.failed` (the reason and its facts), each
  naming the node or map step that made the call, on the coordinator as on a worker. The run's
  `usage` carries `compute_calls` exactly when the graph declares modules.
- **Fixture mode runs modules for real** (C-50): the fixture document has no compute key; the
  same bytes give the same output in every mode and on every conforming engine (C-47).

## 14c. Conversations: turns, the persisted state and consent (conversation.v0)

agentpkg 0.6.0 implements [conversation.v0](../spec/conversation-v0.md) in the same interpreter:
a package may declare a `conversation` over its workflow.v0 graph, which then runs once per
message. Nothing about it is package-specific (D-009): the runtime knows the persistent keys from
a schema, a consent step from its node, a gated permission from the steps that name it.

- **A turn is a run** (V-4, V-5). `initial_state` is evaluated over the message and the persisted
  state (the `conversation` source); the graph runs under the plan's grants with every bound of a
  run; when it completes, the persistent keys of its final state are validated against the
  conversation's state schema and become the next persisted state. A failed turn persists
  nothing and the conversation stays open.
- **A consent step waits for the person** (V-18, V-29). `consent.requested` carries the hashes of
  the text and the facts; the host answers within the node's timeout; `consent.decided` records
  the answer and who gave it (`person`, `transcript`, `plan`, `host`, `preset`, `policy`). A step
  whose permission the plan denies, or whose `once` grant an earlier turn spent, is never asked:
  the decision is the plan's (V-12, V-13). The text and the facts are in the transcript, never in
  the chain.
- **The gate** (V-9, per permission). Before a tool call the mediator checks the turn's decisions
  for each gated permission the tool links; a missing or negative one is a denied permission
  check with `consent_required` or `consent_denied`, and the node fails `permission_denied`.
  Validation already refused a tool that does not depend on its consent step, and a write tool
  that no step gates.
- **The conversation's status** (V-30). `completed` when at least one turn completed and none
  failed or was cancelled, an end at the conversation's bound included (a refused turn beyond
  `max_turns` or the budget is the bound at work, `ended.reason` names it); `failed` otherwise.
  `agentpkg converse` exits 0 on a completed conversation and 1 on a failed one.
- **Budgets** (V-10, V-11, V-13). The turn's budgets are the package's, as for a run; the
  conversation's `max_turns`, tokens, remote calls and per-tool caps are reserved whole before
  each turn (`turn.refused` otherwise); a `once` grant is spent once per conversation, and the
  next turn starts with it spent.
- **One chain** (V-17). Each turn's `Runtime` continues the conversation's audit chain:
  `sequence` counts on, the first event of a turn links to the hash before it, every event names
  `conversation_id` and `turn`, and `verify_audit_chain` reads the whole conversation as one
  record. `agentpkg converse` writes the chain as `audit.json` beside `transcript.json`,
  `state.json`, `usage.json` and `provenance.json`, and each turn's artifacts under `turn-NNN/`.
- **Memory per turn** (V-26). Each turn holds its own memory run over the same folder and grants;
  proposals are checked and written per turn, the agent document read and committed per turn.
- **This host refuses conversations** (V-28): `check_capabilities` answers
  `conversation_not_supported` before anything runs, because one invocation holds no persisted
  state, no consent host and no chain of earlier turns; the plugin is frozen (D-029). The Chrome
  Agent Browser ports the runner and adds the chat surface in T24.

## 15. Why Meeting Agenda was the first package

It declares `tools: []`. When this runner was written it had no generic
`ToolHandler` host broker, so it ran only packages that declare no tools —
checked against the graph's declarations, never against a package id.

A [host tool broker](tool-broker.md) now exists, and the construction above
installs one generic handler per tool the run plan bound. The refusal did not go
away, it became more precise: a package whose declared tools this host has no
implementation for is refused with `tool_not_bound` in `execution.begin`, before
a single token is spent, and `tools_not_supported` remains for a runner built
with no broker at all. Every declared tool must additionally be approved in the
receipt, and the runner re-derives each binding's facts from the verified
package before believing the plan.

That is still a limit of **this execution host**, not of the package format.
Literature Review declares three tools and this host implements one, so it
remains a valid package this host cannot run; faking the other two or
special-casing it would have been worse than refusing it by name.

## 15a. Structured output, and who actually enforces it

Two separate mechanisms make a node's declared `output_schema` mean something,
and only one of them is a guarantee.

**The guarantee** is on the agentpkg side. `HostBridgeModelRouter` parses the
response and validates it against the bundled schema before returning, in one
bounded attempt, with no repair loop. A response that does not conform becomes
`model_output_not_conforming` and the node fails. This holds whatever the
provider did, and it is why a package's contract cannot be quietly broken.

**The help** is provider-native constrained decoding. The plugin asks for it via
OpenClaw's `responseFormat`, and `constrained` on each completion reports
whether it was requested — never whether it worked. A transport that cannot
carry the constraint leaves the model free to answer however it likes, and then
the guarantee above turns that into a failed node rather than bad output.

The help matters far more than it looks. `Workflow._model_schema` hands the
router a *bundled* document — every package-relative `$ref` moved into one
closed `$defs` namespace, with the root left as `{"$ref": "#/$defs/sN", "$defs":
{…}}`. For most of this project's life that root was silently unusable as a
response format, so no package node was ever constrained. Measured on four local
models, the difference was the milestone: every model conformed on every node
with the constraint, and none was reliable without it. `responseFormatFor` now
inlines the root reference and carries an array root as well as an object root,
because a node is entitled to declare a list-valued output. See
[the milestone report](package-execution-report.md#65-the-blocker-that-was-hiding-behind-the-timeout).

## 16. What still cannot happen

| | Status |
|---|---|
| a Run button on the Agent Browser page | **yes, since 3C** — it calls `execution.start` with six fields and nothing else; see [the Run surface](openclaw-agent-browser.md#5a-the-run-surface) |
| a package tool call | **yes, since 3B3/3B4** — only through a host binding the plan froze, under its permission and a separate approval ([the tool broker](tool-broker.md)) |
| Literature Review | **yes, since 3B4**, and from the page since 3C ([report](demo-experience-report.md)) |
| an agent-callable tool binding | no — the plugin still exposes none |
| a run plan mutated by execution | no — `execution.performed` stays false |
| persistent run history or resumable runs | no — finished records are re-read read-only from their run directories after a restart (newest 16); there is no history database and no resume |
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

The normal path is the Agent Browser page: prepare a run plan, fill the task
form, press Run ([the demo steps](../README.md#demo-the-literature-review-agent-from-the-browser)).
Every operation below is `operator.write` for actions and `operator.read` for
queries:

| Operation | Kind | Purpose | Page |
|---|---|---|---|
| `execution.readiness` | query | would a start pass right now, by the same checks | yes |
| `execution.validate-input` | query | the package schema's verdict on a task | yes |
| `execution.start` | action | re-verify a ready plan and run the package | yes (Run) |
| `execution.cancel` | action | stop a running workflow | yes (Cancel) |
| `execution.status` | query | run summaries, and the active run in full | yes |
| `execution.get` | query | read one run record | yes |
| `execution.artifact` | query | read one named artifact, bounded | yes (View) |
| `execution.artifact-chunk` | query | one verified slice of an artifact | yes (Download) |
| `execution.clear` | action | forget finished records | no |

The operator scripts walk the same sequence through the Gateway, for automation
and regression. The Meeting Agenda acceptance is one command:

```bash
node openclaw-agent-browser/scripts/run-meeting-agenda.mjs \
  --package /absolute/path/to/dist/meeting-agenda.agent.pkg \
  --input   /absolute/path/to/examples/meeting-agenda-acceptance-input.json \
  --model   ollama/qwen3.5:9b \
  --out     examples/verification/meeting-agenda-live-run-local-v021.json
```

`--model` names a model **this host actually offers**; the recorded run used the
local one above, which costs nothing. Run the
[router probe](model-router-bridge.md) against the same model first: it makes a
single host-owned call and executes no workflow, so a model that cannot be
reached is found before a run spends anything.

It walks the page's own sequence through the live Gateway — open, record what
the host thought of the signer *before* any decision, pin that exact key at
`package` scope if it is not already trusted, authorize, evaluate models,
choose, prepare — then starts the execution, waits
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
