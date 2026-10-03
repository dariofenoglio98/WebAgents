# Contract-overhead benchmark: design note

Internal note, written before the implementation. It records what the benchmark
times, where the stage boundaries come from, and why.

## Question

How much local, automated latency does the package-to-execution contract add
between "the package bytes are in memory" and "the interpreter is about to
dispatch the first workflow node"? No model, tool, network, package download or
human decision time is included.

## Production path, as implemented

The Agent Browser drives one Python control plane (`agentpkg.browser.control.ControlPlane`,
served over loopback HTTP by `agentpkg browser-serve`) and then a separate runner
process (`agentpkg.execution.session.ExecutionSession`, spoken to over the
execution bridge). The TypeScript plugin (`openclaw-agent-browser/src`) only
orchestrates the calls, compares the fields it receives, and spawns the runner.
In the order the plugin issues them on the run path:

| # | Production operation | What it does |
|---|---|---|
| 1 | `ControlPlane._open_bytes` (end of both `open_file` and `open_url`) | hash the bytes; write the private 0600 snapshot, read it back and rehash; `evaluate_snapshot` (bounded ZIP container, payload integrity, schemas and cross references, runtime profile); `signature_report` (Ed25519); `TrustStore.evaluate`; inspection summary |
| 2 | `ControlPlane.authorize` | normalize the recorded decisions and tool approvals; build the digest-bound receipt (reads the trust-store state; RFC 8785 hash) |
| 3 | `ControlPlane.evaluate_models`, `ControlPlane.evaluate_tools` | normalize the host model catalog and tool registry (closed field sets, content hashes); evaluate the package requirements and tool contracts against them. The page calls both for every package |
| 4 | `ControlPlane.prepare_run_plan` | re-normalize and re-evaluate catalog and registry; preparation blockers; `build_run_plan` (canonical hash); recomputed `preflight` |
| 5 | plugin run start (`execution.ts` `start` + `preflight.ts` `revalidate`) | `validate_input`; `run_plan` (recomputed preflight); `summary`; `authorization`; `evaluate_tools` when the plan binds tools; then `issue_execution_lease` (preflight again, copy the snapshot into a 0400 lease file, rehash both ends) |
| 6 | runner `execution.begin` (`ExecutionSession._begin`) | read the inherited descriptor; `verify_execution_artifact` (archive hash, full package load: container, integrity, schemas, digest, identity, Ed25519 signature, signer); capability, permission, tool-binding and model checks; router and tool-handler construction; invocation; input-schema validation |
| 7 | runner `execution.run` up to the first wave | `Workflow(...)` (integrity re-check, payload re-validation, `Runtime` construction with its first audit event); `Workflow.run` prologue (input re-validation, initial-state validation, memory-permission authorization, audit events) |

Natural boundaries are therefore the seven production operations above. Steps
1–5 each map to one control-plane API call or one fixed group of them; 6 and 7
are the two runner requests. Parsing, integrity, signature and trust happen
inside one production operation (1) and are reported as one stage rather than
re-implemented to obtain finer timers.

## Stage timers

One `time.perf_counter_ns()` read at each boundary, `t0 … t7`, so every stage is
a direct interval and `total_pre_execution = t7 - t0` is measured end to end
(it equals the per-observation sum of stages because the intervals are
contiguous; it is never computed from stage medians).

`t7` is read when the interpreter hands its first ready wave to
`Workflow._gather`. The benchmark replaces that one static method, for its own
process only, with a stop that records the time, records which nodes were in the
wave, closes the not-yet-started node coroutines, and raises. Everything before
that call runs unmodified. No node has started at that point (`node.started` is
emitted inside the node coroutine), so no model or tool can have been reached.

## What runs where

All seven operations run in one Python process, in-process, with the real
classes. The parts that are deliberately not in that process are named
exclusions, not omissions:

* loopback HTTP transport and JSON (de)serialization between plugin and control
  plane, and the plugin-side field comparisons in `preflight.ts`;
* spawning the runner process and the execution-bridge framing of the inbound
  `execution.begin` request (the runner's outbound progress frame *is* encoded,
  as in production, into an in-memory writer);
* the package download (`open_url`) and, in the primary metric, the local file
  read (`read_regular_bytes`), which is timed separately as a secondary metric.

The runner's projection of the run plan (`preflight.ts` builds the bounded
`run_plan` object the child receives) is mirrored in Python because the child
refuses unknown fields; a test checks that the mirror equals the output of the
real TypeScript `revalidate` on the same inputs.

## Fixtures

* Packages: `dist/meeting-agenda.agent.pkg` (0.2.2) and
  `dist/literature-review.agent.pkg` (0.2.5), the current signed releases, read
  as-is.
* Trust: a temporary trust store with the two shipped publisher keys pinned at
  package scope (the "Trust this publisher key" action), set up before timing.
* Host model catalog and tool registry: generated by the plugin's own
  `discoverHostModels` and `buildToolRegistry` (`fixtures/generate_fixtures.mjs`),
  for the documented `ollama/qwen3:30b` row and the built-in bindings.
* Decisions: the README demo decisions, pre-recorded (`fixtures/authorization.json`).
* Task inputs: the recorded live-run inputs.
* Host limits: the recorded-run execution policy; session TTL 7200 s.

The browser policy is the production default (valid signature, trusted
publisher, confirmed model compatibility, confirmed tool contracts).

## Guards

* The runner's bridge writer refuses any outbound frame that is not
  `execution.progress`, so a model or tool call fails immediately.
* Socket connects, DNS resolution and subprocess creation are refused and
  counted for the whole benchmark.
* Every observation asserts its own preconditions (valid, trusted, ready,
  verified, first wave reached) outside the timed region.

## Protocol

Same process, warmup 50 per package, 5 batches × 200 iterations per package.
Within an iteration index the two packages run back-to-back in a seeded random
order, so neither package is systematically measured first or later in a batch.
Garbage collection stays on. Every observation is kept; nothing is trimmed.

## Audit microbenchmark

`Runtime.record` is an isolated public method that builds one event, hash-links
it to the previous one and appends it. It is timed per event on a fresh
`Runtime` for each batch (no observer, and again with the runner's progress
observer), and reported separately from the pre-execution latency.

## Extension: a third package and host resources (benchmark 1.1.0, 2026-10-03)

WebAir 0.3.0 (`dist/webair-0.3.0.agent.pkg`) is the third package. It goes
through the same seven operations and the same timers; nothing in the
benchmark depends on which package is open. What changed is the host, and it
changed for every package at once, because production decides it per host:

* The host holds resources (the WebAir demo's host resources file). On such a
  host the plugin's backend sends the resource registry with every
  `authorize` (with the package's selections, empty when it requests no host
  resource) and every `prepare_run_plan`. So stage 2 now includes
  resource-grant validation and stage 4 grant staleness, for every package.
* The tool registry is the one that backend assembles for that host: built-in
  bindings, one `host_resource` binding per resource type, and the operator
  bindings file's WebAir entries (11 bindings instead of 4).
* The trust store holds three keys.
* The runner projection carries the plan's `resource_grants` exactly as
  `preflight.ts` does (only when there are any); the fidelity test runs the
  real `revalidate` with the same host's live resource store.

The WebAir decisions are those of the accepted live profile-assisted search:
the travel profile granted with the "Demo Traveler" profile selected, the
passenger, payment and simulated-purchase permissions denied, every tool
approved. The first wave is `interpret`, before any profile, tool or model
operation.

Consequence for comparisons: a 1.1.0 series measures a different
implementation commit and a different host configuration than the 1.0.0
series at `23eac90`. The two are reported side by side (`aggregate.py
--reference`), never pooled.
