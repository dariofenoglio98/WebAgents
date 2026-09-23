# Milestone report: the first execution of a portable agent package

Pinned host: **OpenClaw 2026.9.5 (ec9c1a1)**. Package: `meeting-agenda.agent.pkg`
**0.2.1**, digest `d7884667…`. Architecture and reasoning are in [package
execution](package-execution.md); this is what was built, what was measured, and
what it took to finish.

## Headline

**MILESTONE 3B2 LIVE ACCEPTANCE: PASSED.**

A signed portable package ran end to end through the generic `workflow.v0`
interpreter, under the person's own authorization, on the exact local model a
run plan bound, and left a verifiable audit chain and a package-declared export
behind. Run `run_4ded5c3ea9ec48c68cfdcb5a9ad14757`, model `ollama/qwen3.5:9b`,
335.4 s, 5 model calls, peak parallelism 3, 0 tool calls, $0, 89 audit events
with a valid chain, and an agenda whose minutes sum to exactly 45. The full
report is `examples/verification/meeting-agenda-live-run-local-v021.json`; §6.3
has the timeline.

Getting there needed three things, and it is worth separating them because they
failed for unrelated reasons:

1. **a package timing policy that a local model can meet.** 0.2.0's
   `one-perspective` step allowed 60 s and its graph deadline 300 s. Both are
   hosted-model assumptions. 0.2.1 raises four values from measurement; all four
   turned out to be load-bearing in the passing run (§6.2);
2. **a development signing key rotation.** Changing the graph changes the signed
   bytes, and the original publisher key's private half exists on no machine
   this project builds on. 0.2.1 therefore carries a new signer, is *not*
   automatically trusted, and needed an explicit narrow pin (§6.4);
3. **structured output that is actually constrained.** With 1 and 2 done the run
   stopped timing out and started failing at `model_error` instead. The cause
   was in this project's own code: `responseFormatFor` refused to carry a
   `$ref`-rooted schema, so **no package node had ever requested provider-native
   constrained decoding**, on any provider. Measured across all four installed
   local models, no model conformed reliably without it and every model
   conformed with it (§6.5).

Model availability, which blocked local runs entirely at the start of this work,
is fixed and documented in [model availability](model-availability.md).

## 1. Architecture implemented

```text
agentpkg.browser       opens, verifies, authorizes, plans   — never executes
agentpkg.hostbridge    binds the planned model              — never executes
agentpkg.execution     composes the two with the interpreter   <- new
```

The new namespace is the only place allowed to hold both an interpreter and a
way to spend money, which is why it is small, domain-neutral and almost entirely
made of refusals. It builds nothing of its own: a verified `Package`, the
person's exact grants, the host's limits and the planned model go into the
existing `Runtime`, and the existing `Workflow` interprets the package's own
graph.

## 2. Files

**New — `agentpkg`**

| File | Purpose |
|---|---|
| `src/agentpkg/execution/__init__.py` | the namespace and its boundary statement |
| `src/agentpkg/execution/protocol.py` | `agentpkg-execution/0.1`, the method set, fd 3 and fd 4 |
| `src/agentpkg/execution/artifact.py` | read and independently verify the handed-over archive |
| `src/agentpkg/execution/policy.py` | host limits, capability limits, grant handling, model check |
| `src/agentpkg/execution/invocation.py` | the Run Invocation |
| `src/agentpkg/execution/report.py` | audit-chain verification, summaries, cost, model evidence |
| `src/agentpkg/execution/session.py` | the runner: verify, construct, run, write artifacts |
| `src/agentpkg/execution/errors.py` | stable execution codes |
| `src/agentpkg/artifacts.py` | one artifact writer, shared by the CLI and the runner |
| `src/agentpkg/browser/lease.py` | one-time execution leases |
| `tests/execution_fakes.py`, `tests/test_execution_session.py`, `tests/test_execution_boundary.py`, `tests/test_execution_report.py`, `tests/test_browser_lease.py` | 74 new tests |

**New — the plugin**

| File | Purpose |
|---|---|
| `src/bridge-core.ts` | the shared child-bridge transport, extracted from the router bridge |
| `src/execution-bridge.ts` | the execution child: its protocol version, its methods, its descriptors |
| `src/preflight.ts` | the shared preflight, moved out of `router-probe.ts` |
| `src/execution.ts` | orchestration: preflight, lease, descriptors, bridge, record, artifacts |
| `src/run-manager.ts` | ephemeral run records and lifecycle rules |
| `scripts/run-meeting-agenda.mjs` | the live acceptance driver |
| `test/execution.test.ts` | 23 tests over the real stack with a stubbed provider |

**Changed**

`cli.py` (a new `execution-run` command; `_write_result` now uses the shared
writer), `package.py` (byte-based archive loading, so a descriptor needs no
path), `hostbridge/protocol.py` and `peer.py` (a per-peer protocol version; a
cancelled request's late answer is no longer fatal), `hostbridge/router.py`
(per-call model evidence), `hostbridge/session.py` (accepts the shared binding's
publisher block), `browser/control.py` and `browser/server.py` (lease issue and
release), `contract.ts`, `backend.ts`, `index.ts`, `errors.ts`,
`control-plane.ts`, `router-bridge.ts`, `router-probe.ts`.

## 3. How the immutable snapshot reaches the runner

A **one-time execution lease**, then **inherited descriptors**.

The control plane copies its snapshot into a fresh `0700` directory as a `0400`
file with a random name, re-hashing before and after the write, and only when
that session's run plan is ready at that moment. At most one lease is
outstanding per session; it dies with the session, with a re-authorization, with
a cleared or replaced plan, on expiry, and when the run ends.

The plugin backend then opens the lease `O_RDONLY|O_NOFOLLOW` and the run's new
artifact directory `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`, passes them as fd 3 and
fd 4, and closes its own copies as soon as `spawn` returns.

The result is a property that can be checked rather than argued: **the execution
protocol contains no path, no filename, no model identifier and no OpenClaw
method name.** The child cannot open the package from anywhere else because it
never learns where it is, and cannot write outside the run directory for the
same reason. The original URL and `dist/` path are never reopened. Browser
JavaScript sees none of it — a test asserts the run record contains no path, no
`.agent.pkg`, no lease and none of the package's output.

Tested: a substitution of the path after the descriptor is open does not change
the run (`os.replace` of different bytes; the run still executes the planned
digest), while an in-place rewrite of the same inode is caught by the hash.

## 4. What the runner verifies for itself

`fstat` says a regular file within the container limit; then archive SHA-256,
container, integrity and schema layers, package digest, package id and version,
the embedded Ed25519 signature, the signer fingerprint against the one the plan
recorded, and `entrypoint == workflow.v0`. Any mismatch is
`execution_artifact_mismatch` and nothing runs. Publisher *trust* stays the
host's decision; what the runner establishes is that the identity it holds is the
identity that was trusted.

## 5. Schemas, grants, limits and lifecycle

**Run Invocation** — `{schema, run_invocation_version, run_id, run_plan_id,
run_plan_sha256, session_id, package{package_id,version,digest,archive_sha256},
input_sha256, input_bytes, created_at, run_invocation_sha256}`, hashed with RFC
8785, the same canonicalization the integrity statement, the receipt and the run
plan already use.

**Run Record** — run and plan identity, invocation and input hashes, status,
timestamps and duration, package identity, selected model, per-call model
evidence, grants, host and effective limits, usage, cost, audit summary, output
hash, artifact list with hashes, host runtime version and whether it is the
verified one, deadline and cancel flags, error code and detail, the list of
re-verified facts, and a `packageExecution` block. It carries no bearer token, no
path, no child pid and no package output.

**Grants** pass through unchanged. `deny` on a required permission refuses;
`always` refuses because no store exists; `once` refuses when the graph would
consume that permission kind more than once — Meeting Agenda's graph would use
each five times, so honouring `once` would mean denying mid-run and treating it
as `session` would be consent nobody gave.

**Limits** are `min(package, host)` for tokens, remote calls and parallel
workers. `maxOutputTokensPerCall` is an upper bound that *refuses* rather than
lowers, because lowering a node's declared cap would change what the package
does. Defaults: 120,000 tokens, 32 remote calls, 3 parallel workers, 16,000
output tokens per call, 600 s.

**Lifecycle** is `preparing → running → {completed, failed, cancelled}`, no exit
from a terminal state, one active run per plan and per session, records
ephemeral, and every run in flight cancelled when the plugin stops.

## 6. Tests and results

| Suite | Result |
|---|---|
| `agentpkg` pytest | **586 passed, 1 skipped** (`examples/verification/meeting-agenda-021-agentpkg-tests.xml`) |
| plugin vitest | **182 passed** (`examples/verification/meeting-agenda-021-plugin-tests.json`) |
| `npm run verify` | **passed** — built, validated, packed, installed into a throwaway OpenClaw (`examples/verification/meeting-agenda-021-plugin-verify.json`) |
| `scripts/verify_workflow.py` | **passed** — deterministic build/sign/unpack/rebuild and shipped-signature check for both packages |
| `scripts/verify_browser.py` | **passed** — both shipped artifacts, two pinned signer keys |
| ruff | clean |
| tsc | clean |

The 14 new `agentpkg` tests are `tests/test_shipped_artifacts.py`, which pins
what 0.2.1 must keep being true: the version and digest, that the *only*
difference from 0.2.0 is timing (a field-by-field comparison of the two graphs
with the timing keys removed), that each declared timeout exceeds what was
measured without being unbounded, that the graph deadline is still cut down by
the host's own run timeout, the worker topology, `max_parallel: 3`, zero tools,
the budgets/permissions/assertions, that the new bytes verify only under the new
key, that the new signer is **not** automatically trusted, and that neither the
0.2.0 run plan nor its receipt can reach 0.2.1. The 2 new plugin tests cover
`$ref`-root inlining and the array root.

The two execution suites both run the *real* stack. The Python one drives the
real runner over the real protocol with a scripted provider; the TypeScript one
adds the real `agentpkg browser-serve` control plane, real authorization, a real
lease, real descriptors and a real child process, stubbing only
`api.runtime.llm`.

Covered, among others: every artifact mismatch (digest, archive hash, package
id, version, signer); denied model and memory permissions; `once` and `always`
refusals; a model that cannot satisfy the package; input refused before any
token; oversized input; budget and remote-call exhaustion; the host deadline;
cancellation during a run and before it starts; double start; a provider
failure; a model answering as a different model; a broken package assertion; the
descriptor substitution cases; artifact modes, hashes and non-overwrite; the
tools refusal; a receipt that would expire before the run deadline; a runner
child that dies mid-session; a plugin stopped with a run in flight; and the
architectural boundaries in both directions.

### 6.1 The deterministic end-to-end run

`examples/execution-offline/` holds a complete artifact set from the real runner
with a scripted provider:

| Fact | Value |
|---|---|
| status | `completed` |
| model calls | 5 — `plan` ×1, `perspective` ×3, `write` ×1 |
| workers | `Planner:1`, `Perspective:2`, `Perspective:3`, `Perspective:4`, `Writer:5` |
| peak parallel workers | 3 |
| remote calls | 10 (a count and a completion per call) |
| tool calls | 0 |
| audit events | 99, chain verified |
| artifacts | `result.json`, `audit.json`, `usage.json`, `provenance.json`, `agenda.json` |
| agenda | goal preserved, duration 45, minutes sum exactly 45 |
| effective budget | `min(180,000 package, 120,000 host) = 120,000` tokens |

### 6.2 The 0.2.1 timing policy, and why each number

Three things are easy to confuse and the run separates them cleanly:

| | Where it lives | Who sets it | What it bounds |
|---|---|---|---|
| **package timing policy** | `graph.json`, inside the signed bytes | the publisher | one node, one map step, or the whole graph |
| **host execution limits** | `agentpkg.execution.policy` + plugin config | the operator | a run's wall clock, tokens, parallelism, output cap — and it can only *lower* what a package declared |
| **provider latency** | neither | nobody | how long a model actually takes |

0.2.0's numbers were a hosted-model assumption. 0.2.1 changes exactly four, from
measurement (`examples/verification/meeting-agenda-local-step-latency.json` and
`model-availability-latency.json`), and nothing else in the graph:

| Value | 0.2.0 | 0.2.1 | Worst measured | Actual, in the passing run |
|---|---|---|---|---|
| `one-perspective` step | 60 s | **300 s** | 229.0 s | 132.6 s |
| `perspectives` map node | 120 s | **360 s** | 229.0 s | 132.6 s |
| `write` node | 120 s | **300 s** | 217.6 s | 194.5 s |
| graph `deadline_seconds` | 300 s | **600 s** | — | 335.4 s |

`plan`, `join`, `validate` and `output` keep their 120 s, because 8.3 s is what
`plan` actually took and the other three make no model call. **All four changed
values were load-bearing**: at 0.2.0's limits this run would have failed at
`one-perspective` (132.6 > 60), at the map node (132.6 > 120), at `write`
(194.5 > 120) and at the deadline (335.4 > 300).

One thing this milestone deliberately did **not** do: document 0.2.1 inside
`agents/meeting-agenda/README.md`. That file is part of the signed payload, so
editing it changes the digest and invalidates the artifact that passed
acceptance — a test caught exactly that and the edit was reverted. Release notes
for a signed package belong in the repository's documentation, which can change
without re-signing anything.

The sum of the per-node budgets along the critical path (1,140 s) deliberately
exceeds the graph deadline. They answer different questions: a per-node timeout
localizes a stall to one node so the audit says which one, and the deadline
bounds the run as a whole. The deadline is also the last word a *package* gets —
the host's own `run_timeout_seconds` defaults to 600 s and `effective_deadline =
min(package, host)`, so 0.2.1 cannot buy itself more wall clock than the
operator allows, and a test asserts that.

Headroom is deliberate but finite: 2.3× on `one-perspective`, 1.5× on `write`,
1.8× on the deadline. Nothing here is effectively unlimited.

### 6.3 The passing live acceptance run

`examples/verification/meeting-agenda-live-run-local-v021.json`, run
`run_4ded5c3ea9ec48c68cfdcb5a9ad14757`:

| Fact | Value |
|---|---|
| package | `org.webagents.meeting-agenda` **0.2.1**, digest `d7884667…7a99`, archive `e4c499f0…0e35` |
| signer | `sha256:2bcc374a…c5c4`, signature valid, publisher trusted by explicit narrow pin |
| authorization | receipt `8ebb20c6…`, `memory.session` + `model.reasoning` both `session`, runnable |
| run plan | `rp_85cef26d…`, sha `fd42cd89…`, ready, bound to `ollama/qwen3.5:9b` |
| status | **`completed`**, no error code |
| model | planned `ollama/qwen3.5:9b`, invoked `ollama/qwen3.5:9b`, every one of 5 calls |
| tasks | `plan` ×1, `perspective` ×3, `write` ×1 |
| workers | `Planner:1`, `Perspective:2`, `Perspective:3`, `Perspective:4`, `Writer:5` |
| peak parallel workers | **3** |
| nodes completed | 9 (6 graph nodes + 3 map step instances) |
| tool calls | **0**, tool handlers installed **0** |
| audit | **89 events, chain valid** |
| usage | 12,885 tokens, 0 remote calls |
| cost | **$0** |
| total runtime | 335.4 s workflow, 337.3 s wall clock including the whole lifecycle |
| artifacts | `agenda.json`, `result.json`, `audit.json`, `usage.json`, `provenance.json`, plus the run record |
| run plan afterwards | byte-identical (`fd42cd89…`), `execution.performed: false` |
| page run action | still absent |

The audit timeline, which is what the timing policy had to fit:

```text
   0.0s  node.started     plan
   8.3s  model.completed  plan                          <- 120 s budget
   8.3s  worker.spawned   Perspective:2 / :3 / :4       <- real parallelism, peak 3
   8.3s  model.called     x3, concurrently
 135.5s  node.completed   perspectives/one-perspective  Perspective:2   (127.2 s)
 138.4s  node.completed   perspectives/one-perspective  Perspective:4   (130.1 s)
 140.9s  node.completed   perspectives/one-perspective  Perspective:3   (132.6 s)
 140.9s  node.completed   perspectives                  <- 360 s budget
 140.9s  node.completed   join
 335.4s  model.completed  write                         <- 194.5 s, 300 s budget
 335.4s  node.completed   validate                      <- goal, duration, minute sum
 335.4s  workflow.completed                             <- 600 s deadline
```

The agenda the package wrote, checked against the package's own assertions and
independently by the driver:

```text
goal      Decide whether to adopt agent.pkg for the next research prototype   (preserved)
duration  45                                                                  (preserved)
   5m  Dario   Introductions & Meeting Goal Review
  15m  Mira    Trust Model & Security Compliance Assessment
  10m  Tomas   Technical Compatibility & Integration Constraints
  10m  Dario   Budget Implications & Timeline Feasibility
   5m  Dario   Final Decision & Action Item Assignment
          sum  45                                                             (exact)
3 preparation items, 3 decisions, 5 open questions
```

Before the workflow, the trusted developer [router probe](model-router-bridge.md)
made one host-owned call on the same model and nothing else:
`examples/verification/meeting-agenda-021-router-probe.json` — planned equals
invoked, provider `ollama`, structured output validated, cost 0,
`workflowExecuted: false`, no package instructions loaded, no worker started.

### 6.4 The signing key rotation, and what the host made of it

The graph changed, so the signed bytes changed, so the artifact had to be
re-signed — and the original publisher key's private half exists on no machine
this project builds on. `examples/keys/` holds public keys only. Rather than
weaken verification or pretend the old key signed the new bytes, 0.2.1 is signed
by a **new Ed25519 development key**, generated with the project's own
`agentpkg keygen` and stored outside the repository at
`~/.config/agentpkg/keys/webagents-meeting-agenda.private.pem`, mode `0600`, in
a `0700` directory. Only its public half is recorded, as
`examples/keys/meeting-agenda-publisher.pub.pem`.

| | Signs | Fingerprint |
|---|---|---|
| original development key | `literature-review`, and 0.2.0 | `sha256:c7549e61…5a70` |
| rotated key | `meeting-agenda` 0.2.1 only | `sha256:2bcc374a…c5c4` |

The rotation is cryptographically clean in both directions: the old key does not
verify the new bytes and the new key does not verify the old artifact, which
`agentpkg verify` refuses with `publisher key is not the host-pinned trusted
key`. 0.2.0 is preserved as `dist/meeting-agenda-0.2.0.agent.pkg` and still
verifies under the key that signed it.

What the Agent Browser said when the new artifact was first opened, before any
decision — `examples/verification/meeting-agenda-021-untrusted-open.json`:

```text
Container   valid        Signature   valid (self_consistent_ed25519_signature)
Integrity   valid        Publisher   mismatch
Schema      valid        reason      claimed_publisher_pinned_to_other_key
Runtime     compatible   names       sha256:c7549e61…5a70
```

That is worth reading carefully. A rotated key is not merely *unknown* to the
trust store: because a **different** key is already pinned for the same claimed
publisher id, the store reports `mismatch`, which is exactly the signal it
exists to raise for impersonation. A key rotation and an impersonation attempt
are indistinguishable from the bytes alone, and the store is right to refuse to
guess. Only an explicit operator decision on that exact fingerprint resolves it.

The pin taken was the narrowest the store offers — `scope: "package"`, which
binds the new key to `package_id_prefix: org.webagents.meeting-agenda` and
nothing else in the publisher's namespace. The original key keeps its existing
publisher-wide pin, so Literature Review's trust state is untouched. Both
acceptance drivers now pin at `package` scope rather than `publisher`.

Because the bytes, digest, version and signer all changed, none of the previous
authority carried over: a new authorization receipt and a new run plan were
created, and `test_shipped_artifacts.py` asserts that the old ones cannot reach
the new package.

### 6.5 The blocker that was hiding behind the timeout

With the timing policy fixed the run stopped timing out — and failed 19 s in
with `model_error`. `plan` completed in 8.6 s; one `one-perspective` call came
back from the provider in 9.5 s and the router refused it.

The router was right to. `parse_structured` and the bundled-schema validator are
the only thing standing between a package's declared output contract and
whatever a model emits, and there is deliberately no repair loop. What the model
emitted did not satisfy the schema.

(That intermediate run's report was written to the same path the passing one
later took, so it is not preserved as a file. The reproduction below is the
durable evidence, and it is the stronger of the two.)

The cause was in this project's own code, in
`openclaw-agent-browser/src/host-llm.ts`:

```ts
if (schema.type !== "object") {
  // Provider JSON-schema response formats require an object root.
  return null;
}
```

Every node output schema reaches that function *bundled*:
`Workflow._model_schema` moves each package-relative `$ref` into one closed
`$defs` namespace and leaves the root as `{"$ref": "#/$defs/sN", "$defs": {…}}`.
That root has no `type` at all, so the guard rejected it — **for every node, of
every package, on every provider**. No package workflow node had ever requested
provider-native constrained decoding. The router probe had, which is why the
probe kept passing: its schema is a plain inline object.

The host was willing all along. In OpenClaw 2026.9.5,
`resolveOllamaResponseFormat` (`dist/stream.runtime-…`) maps
`{type: "json_schema", json_schema: {schema}}` straight onto Ollama's `format`
and Ollama constrains decoding against **any** root type, array included. (The
earlier note in `host-llm.ts` that non-OpenAI transports ignore `responseFormat`
was wrong for Ollama on this release.)

How much it mattered, measured — three samples per cell, the exact rendered
request per node, parsed and validated by the router's own code
(`examples/verification/meeting-agenda-structured-output-conformance.json`):

| model | `plan` | `one-perspective` | `write` |
|---|---|---|---|
| `qwen3.5:9b` | 3/3 | **1/3** | **1/3** |
| `qwen3.8:27b` | 3/3 | **0/3** | 3/3 |
| `qwen3.6:35b` | 3/3 | **1/3** | 3/3 |
| `qwen3:30b` | **0/3** | **0/3** | **0/3** |
| *any of them, grammar-constrained* | 3/3 | 3/3 | 3/3 |

So this was not a model-choice problem: **12/12 cells conformed with the
constraint and none of the four installed models was reliable without it.** The
failures were the shapes you would predict — a JSON array one closing bracket
short, and an agenda returned as `{"items": [...]}` instead of the declared
object.

The fix inlines a single local root `$ref` into the root, keeping `$defs` intact
so inner references still resolve, and carries an **array** root as well as an
object root, because a package is entitled to declare a list-valued node output
and `one-perspective` does. A provider whose response format insists on an
object root will now refuse that request outright; that is the better outcome,
because an unconstrained call against a schema the model cannot be held to does
not degrade gracefully — it spends the tokens and then fails validation anyway.

This is the one change in this milestone outside the package itself. It weakens
nothing: the router still parses and validates every response, still makes one
bounded attempt, and still fails closed.

## 7. Proof that package tools were never used

Five independent ways:

1. `agentpkg.execution` cannot import `agentpkg.tools` — an AST scan over the
   namespace, at module level and inside functions;
2. a real child process reports its own `sys.modules` after a complete run:
   `tools`, `models`, `network`, `fixtures`, `browser`, `cli`, `dev` and
   `openclaw` are absent;
3. `Workflow` is constructed with `handlers={}` and `approved_tools=[]`, and a
   test reads `runtime.handlers` back as `{}` after a run;
4. a package that declares a tool, or contains a `tool` node, is refused with
   `tools_not_supported` in `execution.begin` — Literature Review is refused
   this way, by declaration rather than by name, before any token;
5. the audit contains no `tool.called` event, and `tool_calls` is 0 in both the
   usage and the run record.

## 8. Proof that no package-specific execution logic exists

* no application word (`meeting`, `agenda`, `literature`, `citation`,
  `crossref`, `bibliograph`, `scholarly`, `webagents`) appears anywhere in the
  execution namespace;
* neither reference package's `package_id`, display name or tool id appears
  there, checked against what the packages actually declare;
* the namespace exports no package-specific entry point;
* the same code refuses Literature Review generically and would run any other
  tool-free `workflow.v0` graph unchanged;
* the five model calls, three parallel workers and their order come from
  `graph.json`, and the agenda's invariants are the package's own assertions.

## 9. Known limitations

* **No package-tool broker.** Tool-declaring packages are refused. This is the
  next milestone.
* **No Run button, no live audit UI.** Execution is operator-only.
* **Ephemeral runs.** No history, no resume; a Gateway restart ends a run.
* **One active run per session and per plan.**
* **Over-reservation persists** — the provable `utf8_bytes + framing` bound was
  2,452 against a real prompt, several times a real tokenizer's count. The trade
  is unchanged: over-reserving refuses a request, under-reserving corrupts the
  accounting.
* **`once` grants are refused** for multi-call workflows rather than supported.
* **The host-version pin defaults to refusing** an unverified OpenClaw release.
* **POSIX only**, like the rest of this prototype's process handling.
* **`llm.allowModelOverride` is plugin-wide.** `llm.allowedModels` is available
  as operator defence in depth but is not set, because it would break dynamic
  model selection.
* **Structured output now depends on the transport carrying the constraint.** A
  provider whose response format requires an object root will refuse a node
  whose declared output is a list, instead of answering unconstrained. Verified
  on this host's native Ollama transport; reasoned, not measured, for
  OpenAI-shaped transports, because no hosted credential on this machine is
  usable (§6.5).
* **The 0.2.1 timing policy is calibrated to one machine.** 300/360/300/600 s
  came from `ollama/qwen3.5:9b` on this laptop under GPU contention. A slower
  machine or a heavier model can still exceed them, and the honest fix then is
  another measured package version, not a larger round number.
* **One passing live run, not a distribution.** The conformance table is three
  samples per cell; the acceptance run itself is n=1.

## 10. Before the next milestone

1. **A generic `ToolHandler` host broker.** The bridge's method set grows a tool
   direction with the same discipline: a closed allowlist, bounded frames, no
   package-chosen binding, and mediation through `Runtime.call_tool` for
   permissions, domains, budgets and schemas. The binding names a host-installed
   capability; no package name selects a handler.
2. **Then Literature Review**, which needs `scholarly-search`,
   `citation-resolver` and `paper-reader` — the existing provider integrations in
   `tools.py`, reached from the runner rather than copied into it. Its network
   controls (HTTPS allowlist, DNS pinning, no redirects, killable child) must
   reach the runner intact.
3. **A run surface** — audit events, usage, exports and a cancel control are a
   new UI, not a variation of the current page. Only then does a Run button have
   somewhere to put its output.
4. **Streaming progress**, if the run surface needs it; today `execution.run` is
   one long request and the record arrives at the end.

See also: [package execution](package-execution.md), [the model-router
bridge](model-router-bridge.md), [model selection and run
plans](model-selection-and-run-plan.md), [threat model](threat-model.md), [the
execution profile](../spec/workflow-v0.md).
