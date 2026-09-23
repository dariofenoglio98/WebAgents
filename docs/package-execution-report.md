# Milestone report: the first execution of a portable agent package

Pinned host: **OpenClaw 2026.9.5 (ec9c1a1)**. Package: `meeting-agenda.agent.pkg`
0.2.0, digest `5aa0ec94…`. Architecture and reasoning are in [package
execution](package-execution.md); this is what was built, what was measured, and
what did not happen.

## Headline

The whole execution path is built, tested and installed. A signed portable
package now runs through the generic `workflow.v0` interpreter, under the
person's own authorization, on the exact model a run plan bound, and leaves a
verifiable audit and a package-declared export behind.

**The live acceptance run has not completed.** Two attempts were made and both
are diagnosed precisely:

1. against a hosted model, refused by OpenClaw's provider auth layer — the
   account's weekly quota was exhausted (`Week 0% left`) and both profiles were
   in a four-day cooldown;
2. against local Ollama models, where the whole path works — exact model
   binding, real inference, three bounded parallel workers, a valid audit chain
   and zero cost — but the package's **60-second `one-perspective` step
   timeout** is shorter than any local model on this machine can answer in.

The remaining blocker is that single declared timeout, and it is measured rather
than inferred: see §6.3. Model availability, which blocked local runs entirely
at the start of this work, is fixed and documented in [model
availability](model-availability.md).

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
| `agentpkg` pytest | **572 passed, 1 skipped** (`examples/verification/model-availability-agentpkg-tests.xml`) |
| plugin vitest | **180 passed** (`examples/verification/model-availability-plugin-tests.json`) |
| `npm run verify` | **passed** — built, validated, packed, installed into a throwaway OpenClaw, 180 tests (`examples/verification/model-availability-plugin-verify.json`) |
| ruff | clean |
| tsc | clean |

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

### The deterministic end-to-end run

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

### The live acceptance attempt

Run through the installed plugin and the live Gateway with
`--model openai/gpt-5.6-luna`. The full report is
`examples/verification/meeting-agenda-live-run.json`; the host's own credential
state at that moment is `examples/verification/openclaw-model-auth-status.txt`.

What it **did** establish, on the real host, before the provider:

* the control plane opened, verified and trusted the real signed artifact;
* the person's `session` grants were recorded in a real receipt;
* the real host catalog was evaluated and `openai/gpt-5.6-luna` was chosen;
* a ready run plan was prepared and frozen;
* **18 host-side preflight checks passed**, including
  `receipt_outlasts_run_deadline`;
* an execution lease was issued, opened and inherited;
* the runner **independently re-verified all nine** artifact facts —
  `archive_sha256`, container, integrity, schema, package digest, package
  identity, publisher signature, signer fingerprint, execution profile;
* `Runtime` and `Workflow` were constructed with `tool_handlers: 0`;
* the `plan` node started, a `Planner` worker spawned, the model permission was
  checked and consumed, and `count_tokens` produced a bound of 2,452, reserving
  14,452 tokens against the 12,000-token node cap;
* `model.complete` reached OpenClaw and was refused with
  `Auth lookup failed for provider "openai": Auth profile … is temporarily
  unavailable for openai/gpt-5.6-luna`;
* the run was classified `model_error`, the audit chain verified, the lease was
  released, `result.json`, `audit.json`, `usage.json`, `provenance.json` and
  `run.json` were written, no lease directory and no runner process were left
  behind, and the run plan was byte-identical afterwards with
  `execution.performed: false`.

`openclaw models status` reports both OpenAI profiles in `cooldown (4d)`,
`Week 0% left ⏱3d 19h`, and `openai/gpt-5.6-luna requires subscription auth: No
usable subscription authentication is available`. Only one provider is
configured on this host.

### 6.3 The local acceptance attempt, and the one remaining blocker

With availability fixed, the same script was run against the lightest local
model the host offers. Everything worked except one declared timeout.

`examples/verification/meeting-agenda-live-run-local.json`, run
`run_8c52f1b74b454b7e82499ee5f8e9f653`, model `ollama/qwen3.5:9b`:

| Fact | Value |
|---|---|
| status | `failed`, `errorCode: timeout` |
| model binding | planned `ollama/qwen3.5:9b`, invoked `ollama/qwen3.5:9b`, every call |
| Planner | **completed** in 28.7 s |
| Perspective workers | 3 spawned, peak parallelism **3** |
| Perspective outcome | all three timed out at exactly 60.0 s after starting |
| tool calls | 0 |
| audit | 64 events, chain valid |
| cost | $0 (local) |
| run plan | byte-identical afterwards, `execution.performed: false` |
| artifacts | `result.json`, `audit.json`, `usage.json`, `provenance.json` |

The audit timeline is unambiguous — all three step timers fired together, 60.0 s
after the map node started:

```text
  0.0s  node.started     plan
 28.7s  model.completed  plan                      <- Planner fits easily
 28.7s  worker.spawned   Perspective:2/3/4         <- real parallelism, peak 3
 28.7s  model.called     x3 (concurrent)
 88.7s  node.failed      perspectives/one-perspective  timeout   (= 28.7 + 60.0)
```

**Why 60 s cannot be met locally.** Measured directly against the provider
(`examples/verification/model-availability-latency.json`), for the *lightest*
installed model:

| Measurement | Result |
|---|---|
| one warm perspective-shaped call, alone | **51.4 s** (1,084 generated tokens) |
| three concurrent calls, as the map node issues them | **202.9 / 214.3 / 229.0 s** |
| same request with provider-side thinking disabled | **5.0 s** (114 tokens) |

Ollama admits all three concurrently rather than serializing them, but GPU
contention makes each about four times slower than alone. Thinking tokens
dominate: `think: false` is 24× faster. That lever is not reachable from a
plugin completion — `reasoning: "off"` was tested through
`api.runtime.llm.complete` and changed neither output nor latency on 2026.9.5.

So a single worker *just* fits the 60 s budget with 8.6 s of margin, and three
concurrent workers need roughly 3.5× the budget. The package's declared
timeouts — `one-perspective` 60 s, nodes 120 s, graph deadline 300 s — are a
hosted-model assumption baked into a portable package.

**Why the package was not changed.** Raising those timeouts means editing
`agents/meeting-agenda/graph.json`, rebuilding and **re-signing** the artifact,
then re-authorizing and re-preparing a run plan for the new digest. No publisher
private key exists anywhere on this machine — `examples/keys/` holds only the two
public keys — so the package cannot be re-signed under its current publisher
identity. Signing with a freshly generated key would change the signer
fingerprint and publisher identity, which is a deliberate decision about the
reference package's provenance rather than a debugging step, so it was left to
the operator.

**To finish the live acceptance test**, with a usable credential:

```bash
node openclaw-agent-browser/scripts/run-meeting-agenda.mjs \
  --package /Users/dariofenoglio/Desktop/WebAgents/dist/meeting-agenda.agent.pkg \
  --input   /Users/dariofenoglio/Desktop/WebAgents/examples/meeting-agenda-acceptance-input.json \
  --model   openai/gpt-5.6-luna \
  --out     examples/verification/meeting-agenda-live-run.json
```

It exits non-zero unless the run completed, every call used the selected model,
more than one call happened, peak parallelism reached at least two, no tool was
called, the audit chain verified, tokens were spent, the agenda preserved the
goal and duration with minutes summing to 45, and the run plan was unchanged
with `performed` still false.

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
