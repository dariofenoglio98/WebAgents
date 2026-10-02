# Contract overhead

How much local latency does the WebAgents package-to-execution contract add before a workflow
starts? This experiment times the real production path from **signed package bytes in memory** to
**the interpreter about to dispatch its first workflow node**, for the two current signed packages,
with no model, tool, network or human involved.

It is a systems benchmark of the control plane and runner. It says nothing about model quality,
task accuracy, LLM latency or tool latency. The end-to-end case studies in the paper cover those.

## Research question

> What local latency does WebAgents' package-to-execution contract introduce before workflow
> execution?

## Metric

Wall-clock elapsed time, `time.perf_counter_ns()` (monotonic; `mach_absolute_time` on macOS),
read at eight boundaries `t0 … t7` in one Python process:

| Stage (`samples.csv` name) | Interval | Production operation |
|---|---|---|
| `package_open_verify` | t0–t1 | `ControlPlane._open_bytes`, the end of both `open_file` and `open_url`: hash; private 0600 snapshot, read back and rehashed; `evaluate_snapshot` (bounded ZIP container, payload integrity, schemas and cross-references, runtime profile); `signature_report` (Ed25519); `TrustStore.evaluate`; inspection summary |
| `authorization_receipt` | t1–t2 | `ControlPlane.authorize` with the pre-recorded decisions: normalization and the digest-bound, RFC 8785-hashed receipt |
| `compatibility_evaluation` | t2–t3 | `ControlPlane.evaluate_models` and `ControlPlane.evaluate_tools`, which the page calls for every package |
| `run_plan_preparation` | t3–t4 | `ControlPlane.prepare_run_plan`: re-normalized catalog and registry, blockers, the frozen hashed Run Plan, preflight |
| `host_revalidation_lease` | t4–t5 | what the plugin's run start (`execution.ts` `start`, `preflight.ts` `revalidate`) asks the control plane: `validate_input`, `run_plan` (recomputed preflight), `summary`, `authorization`, `evaluate_tools` when tools are bound, then `issue_execution_lease` (preflight again; snapshot copied to a 0400 lease and rehashed) |
| `runner_verification` | t5–t6 | the runner's `execution.begin` (`ExecutionSession`): read the inherited descriptor, `verify_execution_artifact` (archive hash, full package load, digest, identity, Ed25519 signature, signer), capability, permission, tool-binding and model checks, router and handlers, invocation, input-schema validation |
| `workflow_start` | t6–t7 | the runner's `execution.run` until `Workflow` hands its first ready wave to its scheduler: `Workflow(...)` (integrity re-check, payload re-validation, `Runtime` and its first audit event), then the `Workflow.run` prologue (input and initial-state validation, memory-permission authorization) |
| `total_pre_execution` | t0–t7 | the whole sequence, one direct interval |
| `local_file_read` | before t0 | secondary: `read_regular_bytes`, the read `open_file` performs; **not** in the total |

The paper table groups contiguous stages into four rows, each again one direct interval:
**Package verification** (t0–t1), **Authorization and binding** (t1–t3), **Run Plan preparation**
(t3–t4) and **Pre-execution revalidation** (t4–t7). The boundaries are the production operations
themselves. Parsing, integrity, signature and trust are one operation in production and are
reported as one stage. The optional component table below breaks them down by calling the same
production functions separately.

**Where the clock stops.** The benchmark replaces `Workflow._gather` with a stop, for its own
process only. That static method is the one `Workflow.run` hands the first wave of node coroutines
to. The stop reads the clock, records the wave, closes the coroutines and raises. No node has
started at that point, because `node.started` is emitted inside the node coroutine. Every line
before the stop is unmodified production code.

## What is excluded

- package acquisition (download or `open_url`); the local file read is reported separately;
- human decision time (decisions are a pre-recorded fixture, applied by one `authorize` call);
- model inference and every model call; tool calls; Crossref; the Citation Resolver; the PDF reader;
- the Agent Browser plugin's loopback HTTP calls to the control plane (JSON over `node:http`), the
  field comparisons `preflight.ts` makes on the answers, spawning the runner process, and the
  bridge framing of the inbound `execution.begin` request. All of them are Node-side or
  inter-process mechanics, so the benchmark measures them neither directly nor by substitute.

## Packages

The current signed release artifacts are used as-is. They are not rebuilt or re-signed.

| | Meeting Agenda | Literature Review |
|---|---|---|
| Artifact | `dist/meeting-agenda.agent.pkg` | `dist/literature-review.agent.pkg` |
| Version | 0.2.2 | 0.2.5 |
| Publisher key | `examples/keys/meeting-agenda-publisher.pub.pem` | `examples/keys/literature-review-publisher.pub.pem` |

Each result's `metadata.json` (`packages`) records, from the verified bytes: package id and
version, archive SHA-256, package digest, signer fingerprint, archive bytes and entries, payload
files, graph nodes and node types, root nodes, worker roles, declared tools, permissions and model
requirements. Meeting Agenda is the small, tool-free package. Literature Review is the larger one,
with three tools, five permissions and 25 nodes. Two packages are two data points and do not
establish a scaling law.

## Host fixtures

The benchmark is deterministic, offline, credential-free and API-free. Every fixture goes through
production validation under the **default** browser policy: valid signature, trusted publisher,
confirmed model compatibility and confirmed tool contracts.

| Fixture | What it is | Where it comes from |
|---|---|---|
| `fixtures/host-model-catalog.json` | one model, `ollama/qwen3:30b` | generated by the plugin's own `discoverHostModels` over the documented OpenClaw catalog row of the recorded local runs (`docs/getting-started.md`) |
| `fixtures/host-tool-registry.json` | the plugin's built-in bindings (Crossref search, Citation Resolver, selected-PDF reader, test echo) | generated by the plugin's own `buildToolRegistry` |
| `fixtures/host-execution-policy.json` | host run limits | the plugin's `resolvePolicy` over the recorded runs' `execution` settings |
| `fixtures/authorization.json` | pre-recorded decisions | the README demo walk-through: needed permissions "Allow for session", `files.pdfs` denied (no PDFs selected), every tool approved |
| `fixtures/*-input.json` | task inputs | the recorded live-run inputs (`examples/meeting-agenda-022-input.json`, `examples/literature-review-live-input.json`) |

The trust store is temporary and holds the two shipped publisher keys. They are pinned at package
scope through `ControlPlane.trust_session_publisher`, the page's "Trust this publisher key"
action, before timing starts. The session TTL is 7200 s, as configured for the recorded runs. To
regenerate the generated fixtures (`--check` verifies them instead):

```sh
node experiments/contract_overhead/fixtures/generate_fixtures.mjs
```

## Guards

- The runner's outbound stream is an in-memory writer that accepts only `execution.progress` and
  the bridge's `$/cancel`. Any `model.*` or `tool.call` frame is refused at the write, so a
  dispatch fails at once. A test removes the stop and checks that the first model request is
  refused this way.
- For the whole run, socket connects, DNS resolution, `subprocess.Popen` and `os.fork`/`spawn`
  are refused and counted. A non-zero count fails the run (`metadata.json` → `guards`).
- Every observation checks its own preconditions outside the timers: all layers valid; signature
  valid; publisher trusted; receipt runnable; model compatible; every tool bound; plan, preflight
  and lease ready; runner verification complete; first wave equal to the graph's root nodes; no
  `node.started`, model or tool event; zero model and tool calls. If any check fails, the run
  aborts. Nothing is dropped silently.
- Package files are hashed before and after the run.

## Protocol

| | Default |
|---|---|
| Warmup per package (discarded, kept in `warmup_samples.csv`) | 50 |
| Measured batches | 5 |
| Iterations per batch | 200 |
| Observations per package | 1000 |
| Seed (package order per iteration) | 20261001 |

Everything runs in one process, with one long-lived control plane, as `browser-serve` holds it.
For every iteration index both packages run once, in an order drawn from the seeded generator, so
neither package is systematically measured first. Each observation opens a fresh session and
tears it down afterwards, outside the timers. The garbage collector stays enabled, no observation
is removed, and every batch is kept.

The default protocol takes about 10–12 minutes on an Apple M3 Max. The two optional parts
below run after the main protocol:

- **Component decomposition**: 20 warmup and 5 × 100 iterations per package. It times the
  production functions inside package open separately: `read_archive_bytes`, `validate_payload`,
  `signature_report`, `TrustStore.evaluate` and `build_summary`. It is a diagnostic and is not
  part of the totals.
- **Audit-event microbenchmark**: `Runtime.record` is an isolated public method, so it can be
  benchmarked without changing production code. The benchmark replays each package's recorded
  live-run audit stream (`examples/meeting-agenda-022-qwen/audit.json`,
  `examples/literature-review-live/audit.json`) event by event into a fresh production `Runtime`,
  5 times per batch for 5 batches. It reports µs per event and events per second, with no
  observer and with the runner's progress observer, separately from the totals.

## Running

From the repository root, with the agentpkg virtualenv (`pip install -e './agentpkg[dev]'`):

```sh
# smoke (seconds)
agentpkg/.venv/bin/python experiments/contract_overhead/benchmark.py \
  --warmup 2 --batches 1 --iterations 5 --component-warmup 2 --component-iterations 5 --label smoke

# canonical paper result: close other applications first, keep the machine on AC power
agentpkg/.venv/bin/python experiments/contract_overhead/benchmark.py --label paper

# re-analyze an existing result directory (does not re-measure)
agentpkg/.venv/bin/python experiments/contract_overhead/analyze.py \
  experiments/contract_overhead/results/<directory>

# the benchmark's own tests (about 15 s; includes a credential-free child-process smoke run)
agentpkg/.venv/bin/python -m pytest experiments/contract_overhead/tests
```

Options: `--warmup`, `--batches`, `--iterations`, `--seed`, `--no-components`,
`--component-warmup`, `--component-iterations`, `--no-audit`, `--audit-warmup`,
`--audit-batches`, `--audit-repeats`, `--results-dir`, `--label`, `--quiet`.

## Output

Every run creates a new directory, `results/<UTC timestamp>[_label]/`, and never overwrites an
existing one:

| File | Content |
|---|---|
| `metadata.json` | config, stage definitions, package identities, fixture hashes, evidence from the first observation, guard counts, batch orders, machine and software metadata (no username, home, hostname or serial) |
| `samples.csv` | every measured observation: `package_key, package_id, package_version, batch, iteration, position, kind, stage, elapsed_ns` (stages, groups, total and secondary per observation) |
| `timestamps.csv` | per observation, `t0 … t7` as offsets from `t0`, and the file-read time |
| `warmup_samples.csv` | the discarded warmup observations, for transparency |
| `component_samples.csv`, `audit_samples.csv` | the two optional microbenchmarks |
| `summary.csv`, `summary.json` | per package × stage: n, median, p95, mean, std (ddof 1), min, max and further percentiles, in ms (raw ns preserved) |
| `batch_summary.csv` | per package × stage × batch medians, for stability |
| `report.md` | tables, stability diagnostics, component and audit results, the paper-ready interpretation, environment, limitations |
| `paper_table.tex`, `paper_table_detailed.tex` | booktabs tables generated from the measured values: the four groups plus total, and all seven operations |
| `command.txt` | the exact command |

Percentiles use linear interpolation (Hyndman–Fan type 7, numpy's default). The paper should
quote the median and p95.

## Reproducing the paper result

1. Check out the commit recorded in `metadata.json` (`software.git_commit`) and install the
   agentpkg virtualenv.
2. Close other applications, wait for the load average to settle, and connect to AC power.
3. Run `agentpkg/.venv/bin/python experiments/contract_overhead/benchmark.py --label paper`.
4. Use `paper_table.tex`, and quote the totals from the "Paper-ready interpretation" section of
   `report.md`.

Absolute numbers depend on the machine. The relative structure, such as which stage dominates and
the share of schema validation, should carry over.

## Limitations

- **One process, no transport.** The loopback HTTP hops between plugin and control plane, the
  Node-side checks and the runner's process start are real costs of a browser-started run, and
  they are not included. The total is a lower bound on what a person waits for after pressing Run,
  excluding the model.
- **The runner's plan projection is mirrored.** `preflight.ts` builds the bounded run plan the
  runner receives. The benchmark reproduces that field selection in Python because the runner
  refuses unknown fields. `tests/test_fidelity.py` checks that the result equals the output of
  the real TypeScript `revalidate`.
- **The progress send is not awaited.** Before the first node, the runner encodes one
  `execution.progress` frame into the in-memory writer, as production does into a pipe. Its reply
  is never awaited, as in production.
- **Trust-store size matters.** The trust store is re-read and re-verified on every trust
  evaluation, and here it holds two keys. A larger store costs more.
- **Disk I/O is included.** Snapshot and lease files are real files, so file-system and
  endpoint-security software affect `package_open_verify` and `host_revalidation_lease`.
- **Two packages, one machine.** These are not a complexity model, and they are not results for
  other hardware.
